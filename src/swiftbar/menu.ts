import { basename } from "node:path";
import { ago, prLine } from "../cli/format.ts";
import type { PrListEntry, RoutineListEntry, StatusInfo, TicketListEntry } from "../daemon/protocol.ts";
import { buildSessionGroups, sessionState, type SessionEntry } from "../tui/sessions.ts";
import { DEFAULT_STATUS_COLORS } from "../tui/theme.ts";

export interface MenuInput {
  /** Null when the daemon isn't answering. */
  status: StatusInfo | null;
  prs: PrListEntry[];
  tickets: TicketListEntry[];
  /** Missing (or empty) when the daemon predates routines. */
  routines?: RoutineListEntry[];
  /** The plugin script; menu actions run it again with the action as arguments. */
  plugin: string;
  now: number;
  /** Colours for PR and ticket statuses, keyed by `last_status`. */
  statusColors?: Record<string, string>;
}

const ATTENTION_STATUSES = new Set(["error", "spawn_failed", "transition_failed", "start_failed"]);
const TITLE_MAX = 60;

/**
 * Text from GitHub or Jira, made safe for a SwiftBar line: `|` starts the line's parameters and a newline
 * ends the line, so both are replaced.
 */
export function menuText(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\|/g, "¦").trim();
}

function truncate(s: string, max = TITLE_MAX): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A SwiftBar parameter value. Values can't escape `"`, so it is swapped for `'`. */
function param(v: string): string {
  return `"${v.replace(/"/g, "'")}"`;
}

/** Parameters that rerun the plugin with `args`, in the background, then refresh the menu. */
export function actionParams(plugin: string, args: string[]): string {
  return [`bash=${param(plugin)}`, ...args.map((a, i) => `param${i + 1}=${param(a)}`), "terminal=false", "refresh=true"].join(" ");
}

/** A menu line. `untrusted` text never has its `:emoji:` or `:sf.symbol:` codes rendered. */
function line(text: string, params: string[] = [], untrusted = false): string {
  const all = untrusted ? [...params, "emojize=false", "symbolize=false"] : params;
  return all.length ? `${text} | ${all.join(" ")}` : text;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function dot(status: string, colors: Record<string, string>): string[] {
  const color = colors[status] ?? DEFAULT_STATUS_COLORS[status];
  return ["sfimage=circle.fill", ...(color ? [`sfcolor=${color}`] : [])];
}

function prNeedsAttention(p: PrListEntry): boolean {
  return ATTENTION_STATUSES.has(p.last_status) || (p.humanOpen ?? 0) > 0;
}

/** Something the user should look at: a failed PR, ticket or routine run, unanswered human comments, an invalid routine, or a config/Jira error. */
export function needsAttention(i: Pick<MenuInput, "status" | "prs" | "tickets" | "routines">): boolean {
  if (!i.status) return false;
  return (
    !!i.status.configError ||
    !!i.status.jira?.error ||
    i.prs.some(prNeedsAttention) ||
    i.tickets.some((t) => ATTENTION_STATUSES.has(t.last_status)) ||
    (i.routines ?? []).some((r) => !r.valid || ATTENTION_STATUSES.has(r.row?.last_status ?? ""))
  );
}

function inSec(ts: number, now: number): string {
  const s = Math.max(0, Math.ceil((ts - now) / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function sessionLines(e: SessionEntry, i: MenuInput, colors: Record<string, string>): string[] {
  const s = e.session;
  const name = basename(s?.cwd ?? e.prs[0]?.cwd ?? e.tickets[0]?.cwd ?? "") || e.sessionId.slice(0, 8);
  const head = `${name} · ${e.agent} · ${sessionState(s)}`;
  const tooltip = `tooltip=${param(`${e.sessionId} · ${s?.cwd ?? ""}`)}`;
  const out = [
    s?.started
      ? line(head, ["sfimage=terminal", tooltip, actionParams(i.plugin, ["go", e.sessionId])], true)
      : line(`${head} · not started yet`, ["sfimage=terminal", "color=gray", tooltip], true),
  ];
  for (const p of e.prs) {
    const human = p.humanOpen ? ` · ${p.humanOpen} human comment${p.humanOpen === 1 ? "" : "s"}` : "";
    const title = menuText(prLine(p));
    const reason = p.last_reason ? ` — ${menuText(p.last_reason)}` : "";
    out.push(
      line(
        `    ${truncate(title)} · ${statusLabel(p.last_status)}${human}`,
        [`href=${param(p.url)}`, ...dot(p.last_status, colors), `tooltip=${param(`${title}${reason}`)}`, "trim=false"],
        true,
      ),
    );
  }
  for (const t of e.tickets) {
    const title = menuText(`${t.key} - ${t.summary ?? ""}`);
    const reason = t.last_reason ? ` — ${menuText(t.last_reason)}` : "";
    out.push(
      line(
        `    ${truncate(title)} · ${statusLabel(t.last_status)}`,
        [`href=${param(t.url)}`, ...dot(t.last_status, colors), `tooltip=${param(`${title}${reason}`)}`, "trim=false"],
        true,
      ),
    );
  }
  for (const r of e.routines) {
    const status = r.row?.last_status ?? "waiting";
    const title = menuText(`${r.id} - ${r.name}`);
    const reason = r.row?.last_reason ? ` — ${menuText(r.row.last_reason)}` : "";
    out.push(line(`    ${truncate(title)} · ${statusLabel(status)}`, [...dot(status, colors), `tooltip=${param(`${title}${reason}`)}`, "trim=false"], true));
  }
  return out;
}

function refreshLine(st: StatusInfo, i: MenuInput): string {
  if (st.pollInProgress) return line("Refresh — a poll is in progress", ["sfimage=arrow.clockwise", "color=gray"]);
  const readyAt = st.manualRefreshReadyAt ?? null;
  if (readyAt !== null && readyAt > i.now) {
    return line(`Refresh — available in ${inSec(readyAt, i.now)}`, ["sfimage=arrow.clockwise", "color=gray"]);
  }
  return line("Refresh now", ["sfimage=arrow.clockwise", actionParams(i.plugin, ["refresh"])]);
}

/** The whole SwiftBar menu: the menu bar title, then the dropdown. */
export function renderMenu(i: MenuInput): string {
  const colors = { ...DEFAULT_STATUS_COLORS, ...i.statusColors };
  const st = i.status;
  if (!st) {
    return [
      line("", ["sfimage=eye.slash"]),
      "---",
      line("Sentinel daemon is not running", ["color=gray"]),
      line("Start daemon", ["sfimage=play.fill", actionParams(i.plugin, ["start"])]),
      line("Open dashboard", ["sfimage=rectangle.on.rectangle", actionParams(i.plugin, ["dashboard"])]),
      line("Edit settings", ["sfimage=gearshape", actionParams(i.plugin, ["settings"])]),
    ].join("\n");
  }

  const groups = buildSessionGroups(i.prs, i.tickets, i.routines ?? []);
  const sessions = groups.reduce((n, g) => n + g.sessions.length, 0);
  const busy = groups.reduce((n, g) => n + g.sessions.filter((e) => e.session?.state === "busy").length, 0);
  const attention = needsAttention(i);
  const out = [
    line(busy ? `${busy}/${sessions}` : String(sessions), [`sfimage=${attention ? "exclamationmark.triangle" : "eye"}`]),
    "---",
  ];

  const summary = [`${sessions} session${sessions === 1 ? "" : "s"}`, busy ? `${busy} busy` : ""].filter(Boolean);
  if (st.nextPollAt) summary.push(`next poll in ${inSec(st.nextPollAt, i.now)}`);
  out.push(line(`Sentinel · ${summary.join(" · ")}`, ["size=12", "color=gray"]));
  if (st.configError) out.push(line(`Config error: ${truncate(menuText(st.configError))}`, ["color=red", `tooltip=${param(menuText(st.configError))}`], true));
  if (st.jira?.error) out.push(line(`Jira error: ${truncate(menuText(st.jira.error))}`, ["color=red", `tooltip=${param(menuText(st.jira.error))}`], true));
  for (const r of (i.routines ?? []).filter((x) => !x.valid)) {
    out.push(line(`Routine ${menuText(r.id)} is invalid`, ["color=red", `tooltip=${param(menuText(r.error ?? ""))}`], true));
  }

  if (groups.length === 0) out.push("---", line("No agent sessions yet", ["color=gray"]));
  for (const g of groups) {
    out.push("---", line(menuText(g.title), ["size=12", "color=gray"], true));
    for (const e of g.sessions) out.push(...sessionLines(e, i, colors));
  }

  out.push(
    "---",
    refreshLine(st, i),
    line("Open dashboard", ["sfimage=rectangle.on.rectangle", actionParams(i.plugin, ["dashboard"])]),
    line("Edit settings", ["sfimage=gearshape", actionParams(i.plugin, ["settings"])]),
    line(`Daemon started ${ago(st.startedAt, i.now)} · ${st.multiplexer}`, ["size=11", "color=gray"]),
  );
  return out.join("\n");
}
