import type { EventRow, PrRow, SessionRow, TicketRow } from "../core/types.ts";
import type { WatchRequest, WatchResult } from "./sentinel.ts";
import type { HookSignal } from "../spawn/launcher.ts";

export interface StatusInfo {
  pid: number;
  startedAt: number;
  home: string;
  multiplexer: string;
  pollIntervalSec: number;
  nextPollAt: number | null;
  prs: number;
  configError: string | null;
  jira: {
    enabled: boolean;
    label: string;
    pollIntervalSec: number;
    nextPollAt: number | null;
    /** Picked-up tickets that aren't dismissed. */
    tickets: number;
    /** Error from the last Jira poll, if it failed. */
    error: string | null;
  };
}

export interface TicketListEntry extends TicketRow {
  session: SessionRow | null;
}

export interface PrListEntry extends PrRow {
  session: SessionRow | null;
}

/** An open GitHub PR offered by the TUI's "watch a PR" picker. */
export interface MyPr {
  /** `host/owner/repo#n`, the same id used for watched PRs. */
  id: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  /** Already watched by Sentinel. */
  watched: boolean;
}

export interface NewWatchDefaults {
  model: string;
  effort: string;
  models: string[];
  efforts: string[];
  startNow: boolean;
  includeExisting: boolean;
}

export interface CwdCheck {
  ok: boolean;
  /** The expanded absolute path. */
  path: string;
  error?: string;
  warning?: string;
}

/** Result of a manual, full poll triggered from the TUI. */
export interface RefreshResult {
  /** False when a poll was already running or the manual-refresh cooldown is active. */
  accepted: boolean;
  /** Human-readable reason when the request was refused. */
  error?: string;
  /** Whole seconds until another manual refresh is allowed (cooldown refusals only). */
  retryAfterSec?: number;
  /** PRs included in the pass; empty when refused. */
  checked: string[];
  /** Jira tickets the search returned; empty when refused or Jira is disabled. */
  tickets: string[];
  /** When the next scheduled poll is due, once the pass has finished. */
  nextPollAt: number | null;
}

/** method name → [params, result] */
export interface RpcMethods {
  status: [Record<string, never>, StatusInfo];
  list: [Record<string, never>, PrListEntry[]];
  watch: [WatchRequest, WatchResult[]];
  myPrs: [Record<string, never>, MyPr[]];
  newWatchDefaults: [Record<string, never>, NewWatchDefaults];
  suggestCwd: [{ pr: string }, { path: string | null }];
  validateCwd: [{ pr: string; path: string }, CwdCheck];
  unwatch: [{ pr: string }, { removed: boolean }];
  check: [{ pr?: string }, { checked: string[] }];
  refresh: [Record<string, never>, RefreshResult];
  tickets: [Record<string, never>, TicketListEntry[]];
  dismissTicket: [{ key: string }, { removed: boolean }];
  pollTickets: [Record<string, never>, { tickets: string[] }];
  history: [{ pr: string }, EventRow[]];
  signal: [{ sessionId: string; signal: HookSignal }, { known: boolean }];
  pause: [{ sessionId: string; paused: boolean }, { ok: true }];
  reload: [Record<string, never>, { ok: boolean; error: string | null }];
  stop: [Record<string, never>, { ok: true }];
}

export type RpcMethod = keyof RpcMethods;

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  method: M;
  params: RpcMethods[M][0];
}

export type RpcResponse<M extends RpcMethod = RpcMethod> =
  | { ok: true; result: RpcMethods[M][1] }
  | { ok: false; error: string };
