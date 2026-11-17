import { prGroup, prLine } from "../cli/format.ts";
import type { SessionRow } from "../core/types.ts";
import type { PrListEntry, TicketListEntry } from "../daemon/protocol.ts";

export const MULTI_REPO_GROUP = "Multiple repositories";
export const NO_PR_GROUP = "No PR yet";

/** An agent session with the PRs and tickets it works on. */
export interface SessionEntry {
  sessionId: string;
  /** Null when the daemon has no row for the session yet. */
  session: SessionRow | null;
  agent: string;
  prs: PrListEntry[];
  tickets: TicketListEntry[];
}

export interface SessionGroup {
  /** `owner/repo`, {@link MULTI_REPO_GROUP} or {@link NO_PR_GROUP}. */
  title: string;
  sessions: SessionEntry[];
}

/** A selectable line of the sessions view. */
export type SessionLine =
  | { kind: "session"; key: string; entry: SessionEntry; group: SessionGroup }
  | { kind: "pr"; key: string; pr: PrListEntry; entry: SessionEntry; group: SessionGroup }
  | { kind: "ticket"; key: string; ticket: TicketListEntry; entry: SessionEntry; group: SessionGroup };

/** The repo a session belongs under: its PRs' repo, or a special group when they span repos or there are none. */
export function sessionGroup(entry: SessionEntry): string {
  const repos = new Set(entry.prs.map((p) => prGroup(p.id)));
  if (repos.size === 0) return NO_PR_GROUP;
  return repos.size === 1 ? [...repos][0]! : MULTI_REPO_GROUP;
}

/** When the session first showed up: its oldest PR or ticket. */
function since(e: SessionEntry): number {
  return Math.min(...e.prs.map((p) => p.registered_at), ...e.tickets.map((t) => t.picked_at));
}

/**
 * Groups watched PRs and picked-up tickets by the session that works on them, then the sessions by repo.
 * Repos come first (alphabetical), then multi-repo sessions, then sessions with no PR yet.
 * Inside a group, sessions are ordered oldest first.
 */
export function buildSessionGroups(prs: PrListEntry[], tickets: TicketListEntry[]): SessionGroup[] {
  const byId = new Map<string, SessionEntry>();
  const entry = (id: string, session: SessionRow | null, agent: string) => {
    let e = byId.get(id);
    if (!e) byId.set(id, (e = { sessionId: id, session, agent, prs: [], tickets: [] }));
    e.session ??= session;
    return e;
  };
  for (const p of prs) entry(p.session_id, p.session, p.agent).prs.push(p);
  for (const t of tickets) entry(t.session_id, t.session, t.session?.agent ?? "claude").tickets.push(t);

  const groups = new Map<string, SessionGroup>();
  for (const e of byId.values()) {
    const title = sessionGroup(e);
    if (!groups.has(title)) groups.set(title, { title, sessions: [] });
    groups.get(title)!.sessions.push(e);
  }
  const rank = (t: string) => (t === NO_PR_GROUP ? 2 : t === MULTI_REPO_GROUP ? 1 : 0);
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
  return [e.prs.length ? n(e.prs.length, "PR") : "", e.tickets.length ? n(e.tickets.length, "ticket") : ""].filter(Boolean).join(" · ");
}

