import { fromPrId } from "../core/pr-ref.ts";
import { isOpenHumanComment, type HumanCommentRow } from "../core/types.ts";
import type { PrListEntry, RoutineListEntry, StatusInfo, TicketListEntry } from "../daemon/protocol.ts";

/** `[org/repo/123]`; the host is shown only for GitHub Enterprise PRs. */
export function prTag(id: string): string {
  const ref = fromPrId(id);
  const host = ref.host === "github.com" ? "" : `${ref.host}/`;
  return `[${host}${ref.owner}/${ref.repo}/${ref.number}]`;
}

/** `org/repo` heading a group of PRs; the host is shown only for GitHub Enterprise PRs. */
export function prGroup(id: string): string {
  const ref = fromPrId(id);
  return `${ref.host === "github.com" ? "" : `${ref.host}/`}${ref.owner}/${ref.repo}`;
}

/** `#123 - title` */
export function prLine(pr: { id: string; title?: string | null }): string {
  return `#${fromPrId(pr.id).number} - ${pr.title ?? "(title loads on the next poll)"}`;
}

/** Orders PRs by group (case-insensitive, alphabetical), then by PR number. */
export function sortByGroup<T extends { id: string }>(prs: T[]): T[] {
  const key = (p: T) => prGroup(p.id).toLowerCase();
  return [...prs].sort((a, b) => key(a).localeCompare(key(b)) || fromPrId(a.id).number - fromPrId(b.id).number);
}

/** `[org/repo/123] title` */
export function prLabel(pr: { id: string; title?: string | null }): string {
  const tag = prTag(pr.id);
  return pr.title ? `${tag} ${pr.title}` : tag;
}

export function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function formatStatus(st: StatusInfo): string {
  const lines = [
    `pid ${st.pid} · home ${st.home}`,
    `multiplexer ${st.multiplexer} · poll every ${st.pollIntervalSec}s · ${st.prs} PR(s) watched`,
  ];
  if (st.nextPollAt) lines.push(`next poll in ${Math.max(0, Math.round((st.nextPollAt - Date.now()) / 1000))}s`);
  // `jira` is missing when talking to a daemon from before Jira support.
  if (st.jira?.enabled) {
    const next = st.jira.nextPollAt ? ` · next in ${Math.max(0, Math.round((st.jira.nextPollAt - Date.now()) / 1000))}s` : "";
    lines.push(`jira: label "${st.jira.label}" · poll every ${st.jira.pollIntervalSec}s · ${st.jira.tickets} ticket(s) picked up${next}`);
    if (st.jira.error) lines.push(`jira error: ${st.jira.error}`);
  } else if (st.jira) lines.push("jira: off");
  if (st.routines?.enabled) {
    const next = st.routines.nextRunAt ? ` · next run ${new Date(st.routines.nextRunAt).toLocaleString()}` : "";
    const bad = st.routines.invalid ? ` (${st.routines.invalid} invalid)` : "";
    lines.push(`routines: ${st.routines.total} in ${st.routines.dir}${bad}${next}`);
  } else if (st.routines) lines.push("routines: off");
  if (st.configError) lines.push(`config error (using last good config): ${st.configError}`);
  return lines.join("\n");
}

/** "conflict" when GitHub last reported the PR conflicting with its base, "ok" when mergeable, "-" when not known yet. */
export function mergeLabel(p: { mergeable?: string | null }): string {
  return p.mergeable === "CONFLICTING" ? "conflict" : p.mergeable === "MERGEABLE" ? "ok" : "-";
}

export function formatList(list: PrListEntry[]): string {
  if (list.length === 0) return "No PRs watched.";
  const rows = list.map((p) => [
    prLabel(p).slice(0, 70),
    p.agent,
    p.session_id.slice(0, 8),
    ago(p.last_checked_at),
    String(p.humanOpen ?? 0),
    mergeLabel(p),
    p.last_status,
    (p.last_reason ?? "").replace(/\s+/g, " ").slice(0, 60),
  ]);
  const head = ["PR", "AGENT", "SESSION", "CHECKED", "HUMAN", "MERGE", "STATUS", "REASON"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

function table(head: string[], rows: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

export type DraftState = "resolved" | "drafted" | "waiting" | "no draft" | "not sent";

/**
 * Where a human comment stands: resolved, drafted by the agent, delivered and the agent is still
 * working (`waiting`), delivered but the agent stopped without a draft, or never sent to an agent.
 */
export function draftState(c: HumanCommentRow, agentBusy: boolean): DraftState {
  if (!isOpenHumanComment(c)) return "resolved";
  if (c.draft_at !== null && (c.draft_reply || c.draft_summary || c.draft_change)) return "drafted";
  if (c.delivered_at !== null) return agentBusy ? "waiting" : "no draft";
  return "not sent";
}

export function humanCommentLocation(c: HumanCommentRow): string {
  if (c.path) return `${c.path}${c.line ? `:${c.line}` : ""}`;
  return c.kind === "review" ? "review" : "conversation";
}

export function formatHumanComments(list: HumanCommentRow[]): string {
  if (list.length === 0) return "No human comments.";
  return list
    .map((c) => {
      const lines = [`[${c.item_id}] @${c.author ?? "unknown"} · ${humanCommentLocation(c)} · ${draftState(c, false)}`];
      if (c.url) lines.push(`  ${c.url}`);
      lines.push(`  ${c.body.replace(/\s+/g, " ").slice(0, 200)}`);
      if (c.draft_summary) lines.push(`  About: ${c.draft_summary}`);
      if (c.draft_change) lines.push(`  Change: ${c.draft_change}`);
      if (c.draft_reply) lines.push(`  Reply: ${c.draft_reply}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Local `Mon 18 Nov 08:00`; null as "-". */
export function when(ts: number | null | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }).replace(",", "");
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** What a routine's STATUS column shows. */
export function routineStatus(r: RoutineListEntry): string {
  if (!r.valid) return "invalid";
  if (!r.enabled) return "disabled";
  return r.row?.last_status ?? "waiting";
}

export function formatRoutines(list: RoutineListEntry[], dir?: string): string {
  if (list.length === 0) return `No routines. Add a directory with a ROUTINE.md to ${dir ?? "the routines folder"}.`;
  const rows = list.map((r) => [
    r.id,
    r.name.slice(0, 40),
    r.schedule,
    when(r.nextRunAt),
    when(r.row?.last_run_at),
    routineStatus(r),
    (r.error ?? r.row?.last_reason ?? "").replace(/\s+/g, " ").slice(0, 70),
  ]);
  return table(["ROUTINE", "NAME", "SCHEDULE", "NEXT", "LAST RUN", "STATUS", "REASON"], rows);
}

export function formatTickets(list: TicketListEntry[]): string {
  if (list.length === 0) return "No Jira tickets picked up.";
  const rows = list.map((t) => [
    t.key,
    (t.summary ?? "").slice(0, 50),
    t.session_id.slice(0, 8),
    ago(t.picked_at),
    t.last_status,
    (t.last_reason ?? "").replace(/\s+/g, " ").slice(0, 60),
  ]);
  return table(["TICKET", "SUMMARY", "SESSION", "PICKED", "STATUS", "REASON"], rows);
}
