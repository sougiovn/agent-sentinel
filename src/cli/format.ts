import type { PrListEntry, StatusInfo } from "../daemon/protocol.ts";

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
    p.id,
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
