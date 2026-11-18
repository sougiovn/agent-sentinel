import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Claude Code's global state file, where it records the directories the user trusted. */
export function claudeConfigFile(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * Whether Claude Code trusts `dir`. Trusting a directory covers everything below it, so any
 * trusted ancestor counts. An unreadable or missing file means not trusted.
 */
export function isDirTrusted(dir: string, file = claudeConfigFile()): boolean {
  let projects: Record<string, { hasTrustDialogAccepted?: unknown }>;
  try {
    projects = JSON.parse(readFileSync(file, "utf8")).projects ?? {};
  } catch {
    return false;
  }
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted === true) return true;
    if (dirname(d) === d) return false;
  }
}

interface SetupState {
  /** The user dismissed the first-run alert about trusting the prompts folder. */
  trustAlertDismissed?: boolean;
}

function readSetup(file: string): SetupState {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

export function trustAlertDismissed(file: string): boolean {
  return readSetup(file).trustAlertDismissed === true;
}

export function dismissTrustAlert(file: string): void {
  writeFileSync(file, JSON.stringify({ ...readSetup(file), trustAlertDismissed: true }, null, 2) + "\n");
}
