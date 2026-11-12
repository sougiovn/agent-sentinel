import type { AgentKind } from "../core/types.ts";

export interface DetectedAgent {
  agent?: AgentKind;
  sessionId?: string;
  cwd: string;
}

/** Infers the calling agent's identity from its environment. */
export function detectAgent(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): DetectedAgent {
  if (env.CLAUDE_CODE_SESSION_ID) return { agent: "claude", sessionId: env.CLAUDE_CODE_SESSION_ID, cwd };
  if (env.CODEX_THREAD_ID) return { agent: "codex", sessionId: env.CODEX_THREAD_ID, cwd };
  return { cwd };
}

/** Extracts a session id from a hook's stdin JSON payload, falling back to env. */
export function hookSessionId(stdin: string, env: Record<string, string | undefined> = process.env): string | undefined {
  try {
    const j = JSON.parse(stdin) as { session_id?: string; thread_id?: string };
    if (j.session_id) return j.session_id;
    if (j.thread_id) return j.thread_id;
  } catch {}
  return env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID;
}
