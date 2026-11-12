import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
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
}

/** Shell command line that resumes the agent session with the prompt file's contents. */
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
      "--resume",
      sq(spec.sessionId),
      "--settings",
      sq(settings),
      "--add-dir",
      sq(paths.promptsDir),
      ...a.args.map(sq),
      prompt,
    ].join(" ");
  }
  const a = config.agents.codex;
  return [
    "cd",
    sq(spec.cwd),
    "&&",
    sq(a.command),
    "resume",
    ...codexHookOverrides(self).map(sq),
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
