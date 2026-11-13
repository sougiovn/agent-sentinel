export type AgentKind = "claude" | "codex";

export type PrStatus =
  | "pending"
  | "no_changes"
  | "no_action"
  | "fix_spawned"
  | "fix_running"
  | "spawn_failed"
  | "error";

export type SessionState = "idle" | "busy";

export type ItemKind = "inline_comment" | "conversation_comment" | "review" | "check";

/** A normalized unit of PR activity Sentinel may act on. */
export interface Item {
  id: string;
  kind: ItemKind;
  author?: string;
  authorType?: string;
  body?: string;
  path?: string;
  line?: number;
  url?: string;
  createdAt?: string;
  /** checks only */
  checkName?: string;
  conclusion?: string;
  runId?: string;
  logTail?: string;
}

export interface PrRow {
  id: string;
  url: string;
  agent: AgentKind;
  session_id: string;
  cwd: string;
  registered_at: number;
  last_checked_at: number | null;
  last_status: PrStatus;
  last_reason: string | null;
  /** PR title as of the last poll; null until the first fetch after an upgrade. */
  title: string | null;
}

export interface SessionRow {
  session_id: string;
  agent: AgentKind;
  cwd: string;
  mux: string | null;
  pane_id: string | null;
  tab_id: string | null;
  state: SessionState;
  paused: number;
  /** 1 while the agent process is believed to be running in the pane. */
  agent_running: number;
  busy_since: number | null;
  last_signal_at: number | null;
  /** Model passed to the agent on every launch; null = agent default. */
  model: string | null;
  /** Effort level passed to the agent on every launch; null = agent default. */
  effort: string | null;
  /** 0 until Sentinel has launched a session it created itself (first launch uses --session-id). */
  started: number;
}

/** Options for a session Sentinel creates itself rather than one handed off by an agent. */
export interface SessionOptions {
  model?: string | null;
  effort?: string | null;
  started?: boolean;
}

export interface EventRow {
  id: number;
  pr_id: string;
  ts: number;
  kind: string;
  detail: unknown;
}

export type TicketStatus = "queued" | "started" | "spawn_failed" | "transition_failed";

/** A Jira ticket Sentinel picked up. The row stays so a ticket never gets a second session. */
export interface TicketRow {
  key: string;
  url: string;
  summary: string | null;
  session_id: string;
  cwd: string;
  picked_at: number;
  last_status: TicketStatus;
  last_reason: string | null;
  /** 1 once hidden from the dashboard. */
  dismissed: number;
}
