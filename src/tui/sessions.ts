import { prGroup, prLine } from "../cli/format.ts";
import type { EventRow, SessionRow } from "../core/types.ts";
import type { PrListEntry, RoutineListEntry, TicketListEntry } from "../daemon/protocol.ts";

export const MULTI_REPO_GROUP = "Multiple repositories";
export const NO_PR_GROUP = "No PR yet";
export const ROUTINES_GROUP = "Routines";

/** An agent session with the PRs, tickets and routines it works on. */
export interface SessionEntry {
  sessionId: string;
  /** Null when the daemon has no row for the session yet. */
  session: SessionRow | null;
  agent: string;
  prs: PrListEntry[];
  tickets: TicketListEntry[];
  /** Routines whose latest run is this session. */
  routines: RoutineListEntry[];
}

export interface SessionGroup {
  /** `owner/repo`, {@link MULTI_REPO_GROUP}, {@link NO_PR_GROUP} or {@link ROUTINES_GROUP}. */
  title: string;
  sessions: SessionEntry[];
}

/** A selectable line of the sessions view. */
export type SessionLine =
  | { kind: "session"; key: string; entry: SessionEntry; group: SessionGroup }
  | { kind: "pr"; key: string; pr: PrListEntry; entry: SessionEntry; group: SessionGroup }
  | { kind: "ticket"; key: string; ticket: TicketListEntry; entry: SessionEntry; group: SessionGroup }
  | { kind: "routine"; key: string; routine: RoutineListEntry; entry: SessionEntry; group: SessionGroup };

/**
 * The repo a session belongs under: its PRs' repo, or a special group when they span repos, when it only
 * runs routines, or when it has no PR yet.
 */
export function sessionGroup(entry: SessionEntry): string {
  const repos = new Set(entry.prs.map((p) => prGroup(p.id)));
  if (repos.size === 0) return entry.routines.length && !entry.tickets.length ? ROUTINES_GROUP : NO_PR_GROUP;
  return repos.size === 1 ? [...repos][0]! : MULTI_REPO_GROUP;
}

/** When the session first showed up: its oldest PR, ticket or routine run. */
function since(e: SessionEntry): number {
  return Math.min(
    ...e.prs.map((p) => p.registered_at),
    ...e.tickets.map((t) => t.picked_at),
    ...e.routines.map((r) => r.row?.last_run_at ?? Infinity),
  );
}

/**
 * Groups watched PRs and picked-up tickets by the session that works on them, then the sessions by repo.
 * Repos come first (alphabetical), then multi-repo sessions, then sessions with no PR yet.
 * Inside a group, sessions are ordered oldest first.
 */
export function buildSessionGroups(prs: PrListEntry[], tickets: TicketListEntry[], routines: RoutineListEntry[] = []): SessionGroup[] {
  const byId = new Map<string, SessionEntry>();
  const entry = (id: string, session: SessionRow | null, agent: string) => {
    let e = byId.get(id);
    if (!e) byId.set(id, (e = { sessionId: id, session, agent, prs: [], tickets: [], routines: [] }));
    e.session ??= session;
    return e;
  };
  for (const p of prs) entry(p.session_id, p.session, p.agent).prs.push(p);
  for (const t of tickets) entry(t.session_id, t.session, t.session?.agent ?? "claude").tickets.push(t);
  for (const r of routines) {
    if (r.row?.session_id && r.session) entry(r.row.session_id, r.session, r.session.agent).routines.push(r);
  }

  const groups = new Map<string, SessionGroup>();
  for (const e of byId.values()) {
    const title = sessionGroup(e);
    if (!groups.has(title)) groups.set(title, { title, sessions: [] });
    groups.get(title)!.sessions.push(e);
  }
  const rank = (t: string) => (t === ROUTINES_GROUP ? 3 : t === NO_PR_GROUP ? 2 : t === MULTI_REPO_GROUP ? 1 : 0);
  const sorted = [...groups.values()].sort((a, b) => rank(a.title) - rank(b.title) || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  for (const g of sorted) g.sessions.sort((a, b) => since(a) - since(b) || a.sessionId.localeCompare(b.sessionId));
  return sorted;
}

/** Text a session is matched against: its id, agent, group, and every PR and ticket it has. */
function haystack(g: SessionGroup, e: SessionEntry): string {
  return [
    g.title,
    e.sessionId,
    e.agent,
    ...e.prs.map((p) => `${prGroup(p.id)} ${prLine(p)} ${p.last_status}`),
    ...e.tickets.map((t) => `${t.key} ${t.summary ?? ""} ${t.last_status}`),
    ...e.routines.map((r) => `${r.id} ${r.name} ${r.row?.last_status ?? ""}`),
  ]
    .join(" ")
    .toLowerCase();
}

/** Keeps whole sessions whose id, repo, PRs or tickets contain every whitespace-separated word of the query. */
export function filterSessionGroups(groups: SessionGroup[], query: string): SessionGroup[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return groups;
  return groups
    .map((g) => ({ ...g, sessions: g.sessions.filter((e) => tokens.every((t) => haystack(g, e).includes(t))) }))
    .filter((g) => g.sessions.length > 0);
}

/** Every selectable line, in display order: each session followed by its PRs, then its tickets. */
export function sessionLines(groups: SessionGroup[]): SessionLine[] {
  return groups.flatMap((group) =>
    group.sessions.flatMap((entry): SessionLine[] => [
      { kind: "session", key: `s:${entry.sessionId}`, entry, group },
      ...entry.prs.map((pr): SessionLine => ({ kind: "pr", key: `p:${pr.id}`, pr, entry, group })),
      ...entry.tickets.map((ticket): SessionLine => ({ kind: "ticket", key: `t:${ticket.key}`, ticket, entry, group })),
      ...entry.routines.map((routine): SessionLine => ({ kind: "routine", key: `r:${routine.id}`, routine, entry, group })),
    ]),
  );
}

/** `busy`, `idle`, `paused`, plus a note when the agent isn't running in its pane. */
export function sessionState(s: SessionRow | null): string {
  if (!s) return "unknown";
  const parts = [s.paused ? "paused" : s.state];
  if (!s.agent_running) parts.push("not running");
  return parts.join(" · ");
}

/** `2 PRs · 1 ticket` */
export function sessionSummary(e: SessionEntry): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  return [
    e.prs.length ? n(e.prs.length, "PR") : "",
    e.tickets.length ? n(e.tickets.length, "ticket") : "",
    e.routines.length ? n(e.routines.length, "routine") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `$0.0123` under a dollar, since a single evaluator run costs cents; `$1.23` from a dollar up. */
export function formatUsd(n: number): string {
  return `$${n === 0 ? "0.00" : n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** What the evaluator has cost the session: its own running total, which outlives merged PRs. */
export function sessionEvalCost(e: SessionEntry): { usd: number; runs: number } {
  if (e.session) return { usd: e.session.eval_cost_usd ?? 0, runs: e.session.eval_count ?? 0 };
  return {
    usd: e.prs.reduce((n, p) => n + (p.eval_cost_usd ?? 0), 0),
    runs: e.prs.reduce((n, p) => n + (p.eval_count ?? 0), 0),
  };
}

/** The PRs whose history the details pane shows: the selected PR, a ticket's handed-off PR, or every PR of the session. */
export function historyPrIds(l: SessionLine): string[] {
  if (l.kind === "pr") return [l.pr.id];
  if (l.kind === "ticket" && l.ticket.pr_id && l.entry.prs.some((p) => p.id === l.ticket.pr_id)) return [l.ticket.pr_id];
  return l.entry.prs.map((p) => p.id);
}

export interface SessionEvent {
  prId: string;
  ev: EventRow;
}

/** Events of several PRs, newest first. */
export function mergeHistory(byPr: Record<string, EventRow[]>): SessionEvent[] {
  return Object.entries(byPr)
    .flatMap(([prId, evs]) => evs.map((ev) => ({ prId, ev })))
    .sort((a, b) => b.ev.ts - a.ev.ts || b.ev.id - a.ev.id);
}

const count = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

/** One readable line for an event's detail. */
export function eventSummary(ev: EventRow): string {
  const d = (ev.detail ?? {}) as Record<string, unknown>;
  const items = Array.isArray(d.items) ? d.items.length : 0;
  switch (ev.kind) {
    case "evaluated": {
      const cost = typeof d.costUsd === "number" ? ` · ${formatUsd(d.costUsd)}` : "";
      const verdict = d.shouldFix ? `fix ${count(items, "item")}` : "no action";
      return `${verdict}: ${String(d.reason ?? "")}${cost}`;
    }
    case "new_items":
      return count(items, "new item");
    case "fix_delivered":
      return `delivered ${count(items, "item")} to pane ${String(d.pane ?? "?")}`;
    case "merge_conflict":
      return "merge conflict with the base branch";
    case "registered":
    case "reassigned":
      return `session ${String(d.session ?? "").slice(0, 8)} · ${String(d.cwd ?? "")}`;
    case "error":
    case "spawn_failed":
      return String(d.error ?? "");
    case "comment_resolved":
    case "comment_reopened":
    case "draft_recorded":
      return String(d.item ?? "");
    default:
      return ev.detail == null ? "" : JSON.stringify(ev.detail);
  }
}
