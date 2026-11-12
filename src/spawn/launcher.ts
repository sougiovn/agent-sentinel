import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DEFAULT, type Config } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import type { AgentKind } from "../core/types.ts";

/** POSIX single-quote shell escaping. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export type HookSignal = "idle" | "busy" | "exit";

export function hookCommand(self: string[], signal: HookSignal): string {
  return [...self.map(sq), "hook", signal].join(" ");
}

/** Claude settings JSON that reports agent state back to Sentinel. */
export function claudeHookSettings(self: string[]) {
  const hook = (s: HookSignal) => [{ hooks: [{ type: "command", command: hookCommand(self, s), timeout: 10 }] }];
  return { hooks: { Stop: hook("idle"), UserPromptSubmit: hook("busy"), SessionEnd: hook("exit") } };
}

/** Codex `-c` overrides for the same hooks (TOML inline values). */
export function codexHookOverrides(self: string[]): string[] {
  const entry = (s: HookSignal) =>
    `[{hooks=[{type="command",command=${JSON.stringify(hookCommand(self, s))},timeout=10}]}]`;
  return ["-c", `hooks.Stop=${entry("idle")}`, "-c", `hooks.UserPromptSubmit=${entry("busy")}`];
}

export function writeClaudeHookSettings(paths: Paths, self: string[]): string {
  const file = join(paths.hooksDir, "claude-settings.json");
  mkdirSync(paths.hooksDir, { recursive: true });
  writeFileSync(file, JSON.stringify(claudeHookSettings(self), null, 2));
  return file;
}

export interface LaunchSpec {
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  promptFile: string;
  /** Start a session with this id instead of resuming one (claude only). */
  newSession?: boolean;
  model?: string | null;
  effort?: string | null;
}

/** Model/effort flags; null or "default" leaves the agent's own default in place. */
function modelArgs(spec: LaunchSpec): string[] {
  const set = (v: string | null | undefined): v is string => !!v && v !== AGENT_DEFAULT;
  const out: string[] = [];
  if (spec.agent === "claude") {
    if (set(spec.model)) out.push("--model", spec.model);
    if (set(spec.effort)) out.push("--effort", spec.effort);
  } else {
    if (set(spec.model)) out.push("-m", spec.model);
    if (set(spec.effort)) out.push("-c", `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
  }
  return out;
}

/** Shell command line that starts or resumes the agent session with the prompt file's contents. */
export function launchCommand(spec: LaunchSpec, config: Config, paths: Paths, self: string[]): string {
  const prompt = `"$(cat ${sq(spec.promptFile)})"`;
  if (spec.agent === "claude") {
    const settings = writeClaudeHookSettings(paths, self);
    const a = config.agents.claude;
    return [
      "cd",
      sq(spec.cwd),
      "&&",
      sq(a.command),
      spec.newSession ? "--session-id" : "--resume",
      sq(spec.sessionId),
      "--settings",
      sq(settings),
      "--add-dir",
      sq(paths.promptsDir),
      ...modelArgs(spec).map(sq),
      ...a.args.map(sq),
      prompt,
    ].join(" ");
  }
  if (spec.newSession) throw new Error("Sentinel can only start new sessions for claude");
  const a = config.agents.codex;
  return [
    "cd",
    sq(spec.cwd),
    "&&",
    sq(a.command),
    "resume",
    ...codexHookOverrides(self).map(sq),
    ...modelArgs(spec).map(sq),
    ...a.args.map(sq),
    sq(spec.sessionId),
    prompt,
  ].join(" ");
}

/** One-line message typed into an agent that is already running and idle. */
export function injectionLine(promptFile: string): string {
  return `Sentinel has new PR feedback for you. Read the file ${promptFile} and follow its instructions.`;
}

export function writePromptFile(paths: Paths, sessionId: string, text: string, now: number): string {
  const file = join(paths.promptsDir, `${sessionId}-${now}.md`);
  writeFileSync(file, text);
  return file;
}
