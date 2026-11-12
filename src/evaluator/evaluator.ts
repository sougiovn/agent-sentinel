import { exec as defaultExec, type Exec } from "../core/exec.ts";
import { buildEvalPrompt, EVAL_SCHEMA, type EvalInput } from "./prompt.ts";

export interface Verdict {
  shouldFix: boolean;
  reason: string;
  items: string[];
  costUsd?: number;
}

export interface Evaluator {
  evaluate(input: EvalInput): Promise<Verdict>;
}

export interface ClaudeEvaluatorOptions {
  model: string;
  maxBudgetUsd: number;
  cwd: string;
  command?: string;
}

export function evaluatorArgs(opts: ClaudeEvaluatorOptions): string[] {
  const args = [
    opts.command ?? "claude",
    "-p",
    "--model",
    opts.model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(EVAL_SCHEMA),
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (opts.maxBudgetUsd > 0) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  return args;
}

/** Unsets agent-session env vars the daemon may have inherited, so the evaluator runs as a fresh session. */
export function scrubbedAgentEnv(env: Record<string, string | undefined> = process.env): Record<string, undefined> {
  const out: Record<string, undefined> = {};
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_(SESSION_ID|ENTRYPOINT|CHILD_SESSION)|CLAUDE_PID|CODEX_THREAD_ID|CODEX_TOOL_CALL_ID)$/.test(k)) {
      out[k] = undefined;
    }
  }
  return out;
}

export class ClaudeEvaluator implements Evaluator {
  constructor(
    private opts: () => ClaudeEvaluatorOptions,
    private run: Exec = defaultExec,
  ) {}

  async evaluate(input: EvalInput): Promise<Verdict> {
    const opts = this.opts();
    // Prompt goes through stdin to avoid argv length limits.
    const r = await this.run(evaluatorArgs(opts), {
      cwd: opts.cwd,
      stdin: buildEvalPrompt(input),
      timeoutMs: 180_000,
      env: scrubbedAgentEnv(),
    });
    let out: {
      is_error?: boolean;
      subtype?: string;
      result?: string;
      structured_output?: Partial<Verdict>;
      total_cost_usd?: number;
    };
    try {
      out = JSON.parse(r.stdout);
    } catch {
      throw new Error(`Evaluator returned non-JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
    if (out.is_error || !out.structured_output) {
      throw new Error(`Evaluator failed (${out.subtype ?? "error"}): ${String(out.result ?? r.stderr).slice(0, 300)}`);
    }
    const v = out.structured_output;
    if (typeof v.shouldFix !== "boolean") throw new Error("Evaluator output missing shouldFix");
    return {
      shouldFix: v.shouldFix,
      reason: String(v.reason ?? ""),
      items: Array.isArray(v.items) ? v.items.map(String) : [],
      costUsd: out.total_cost_usd,
    };
  }
}
