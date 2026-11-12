import { fromPrId } from "../core/pr-ref.ts";
import type { PrListEntry, StatusInfo } from "../daemon/protocol.ts";

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
  if (st.configError) lines.push(`config error (using last good config): ${st.configError}`);
  return lines.join("\n");
}

export function formatList(list: PrListEntry[]): string {
  if (list.length === 0) return "No PRs watched.";
  const rows = list.map((p) => [
    prLabel(p).slice(0, 70),
    p.agent,
    p.session_id.slice(0, 8),
    ago(p.last_checked_at),
    p.last_status,
    (p.last_reason ?? "").replace(/\s+/g, " ").slice(0, 60),
  ]);
  const head = ["PR", "AGENT", "SESSION", "CHECKED", "STATUS", "REASON"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [fmt(head), ...rows.map(fmt)].join("\n");
}
