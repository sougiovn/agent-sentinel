import type { EventRow, PrRow, SessionRow } from "../core/types.ts";
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
}

export interface PrListEntry extends PrRow {
  session: SessionRow | null;
}

/** method name → [params, result] */
export interface RpcMethods {
  status: [Record<string, never>, StatusInfo];
  list: [Record<string, never>, PrListEntry[]];
  watch: [WatchRequest, WatchResult[]];
  unwatch: [{ pr: string }, { removed: boolean }];
  check: [{ pr?: string }, { checked: string[] }];
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
