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

export type ItemKind = "inline_comment" | "conversation_comment" | "review" | "check" | "merge_conflict";

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
  /** merge_conflict only: the base branch the PR conflicts with. */
  baseRef?: string;
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
  /** GitHub's last known `mergeable` value (MERGEABLE or CONFLICTING); UNKNOWN reads never overwrite it. */
  mergeable: string | null;
  /** The PR's base branch as of the last poll. */
  base_ref: string | null;
  /** What the evaluator has cost on this PR so far, in USD. */
  eval_cost_usd: number;
  /** How many times the evaluator ran on this PR. */
  eval_count: number;
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
  /** When Sentinel last typed a prompt into the pane and is still waiting for the agent's first hook signal. */
  awaiting_ack_since: number | null;
  /** JSON {@link AwaitingAck}: what that delivery carried, rolled back if the agent never starts. */
  awaiting_ack: string | null;
  /** What the evaluator has cost on this session's PRs so far, in USD, including PRs no longer watched. */
  eval_cost_usd: number;
  /** How many times the evaluator ran on this session's PRs. */
  eval_count: number;
}

/** A delivery the agent hasn't confirmed with a hook signal yet. */
export interface AwaitingAck {
  paneId: string;
  /** The session's `started` before the delivery, restored if the agent never starts. */
  wasStarted: number;
  /** Item ids delivered per PR; an empty list for a session start with no items. */
  prs: Record<string, string[]>;
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

export type TicketStatus = "queued" | "started" | "in_review" | "done" | "spawn_failed" | "transition_failed";

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
  /** The PR the ticket's session handed off to Sentinel, once it has. */
  pr_id: string | null;
}

/**
 * A comment written by a human (not a bot, not an ignored author) on a watched PR, tracked until resolved.
 * Inline review comments follow their GitHub thread's resolution; every other kind is resolved only
 * when the user marks it resolved in the dashboard.
 */
export interface HumanCommentRow {
  pr_id: string;
  /** Same id the agent sees in fix prompts, e.g. `inline:123`, `issue:456`, `review:789`. */
  item_id: string;
  kind: Exclude<ItemKind, "check" | "merge_conflict">;
  author: string | null;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  created_at: string | null;
  first_seen_at: number;
  /** 1 when the inline comment's review thread is resolved on GitHub. */
  gh_resolved: number;
  /** When the user marked it resolved in the dashboard. */
  resolved_at: number | null;
  /** When Sentinel last delivered it to an agent session, and which one. */
  delivered_at: number | null;
  delivered_session: string | null;
  /** Set once the Stop hook has asked the agent for a missing draft, so it asks only once per delivery. */
  draft_requested_at: number | null;
  /** What the comment asks for, in the agent's words. */
  draft_summary: string | null;
  /** What the agent changed because of it, or why nothing changed. */
  draft_change: string | null;
  /** Proposed reply for the user to post. */
  draft_reply: string | null;
  draft_at: number | null;
  /** "agent", or "user" once edited in the dashboard. */
  draft_by: string | null;
}

/** Open = not resolved on GitHub and not marked resolved by the user. */
export function isOpenHumanComment(c: Pick<HumanCommentRow, "gh_resolved" | "resolved_at">): boolean {
  return !c.gh_resolved && c.resolved_at === null;
}
