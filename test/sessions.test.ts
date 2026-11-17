import { describe, expect, test } from "bun:test";
import type { PrListEntry, TicketListEntry } from "../src/daemon/protocol.ts";
import type { EventRow, SessionRow } from "../src/core/types.ts";
import {
  buildSessionGroups,
  eventSummary,
  filterSessionGroups,
  formatUsd,
  historyPrIds,
  mergeHistory,
  MULTI_REPO_GROUP,
  NO_PR_GROUP,
  sessionEvalCost,
  sessionLines,
  sessionState,
  sessionSummary,
} from "../src/tui/sessions.ts";

const pr = (id: string, session_id: string, registered_at = 1, title = "t"): PrListEntry =>
  ({ id, session_id, registered_at, title, agent: "claude", session: null, humanOpen: 0, last_status: "no_action" }) as unknown as PrListEntry;
const ticket = (key: string, session_id: string, picked_at = 1, pr_id: string | null = null): TicketListEntry =>
  ({ key, session_id, picked_at, pr_id, summary: `summary of ${key}`, session: null, last_status: "started" }) as unknown as TicketListEntry;

describe("session groups", () => {
  const groups = buildSessionGroups(
    [
      pr("github.com/zeta/tools#3", "s3"),
      pr("github.com/acme/web#12", "s1", 5),
      pr("github.com/acme/web#14", "s2"),
      pr("github.com/acme/api#88", "s2"),
      pr("github.com/acme/web#20", "s4", 2),
    ],
    [ticket("CP-7", "s1", 1, "github.com/acme/web#12"), ticket("CP-9", "s5")],
  );

  test("groups sessions by their PRs' repo, then multi-repo sessions, then sessions without a PR", () => {
    expect(groups.map((g) => [g.title, g.sessions.map((s) => s.sessionId)])).toEqual([
      ["acme/web", ["s1", "s4"]], // s1's oldest item (its ticket, at 1) is older than s4's PR
      ["zeta/tools", ["s3"]],
      [MULTI_REPO_GROUP, ["s2"]],
      [NO_PR_GROUP, ["s5"]],
    ]);
  });

  test("a session lists its PRs, then its tickets", () => {
    expect(sessionLines(groups).map((l) => l.key)).toEqual([
      "s:s1", "p:github.com/acme/web#12", "t:CP-7",
      "s:s4", "p:github.com/acme/web#20",
      "s:s3", "p:github.com/zeta/tools#3",
      "s:s2", "p:github.com/acme/web#14", "p:github.com/acme/api#88",
      "s:s5", "t:CP-9",
    ]);
    expect(sessionSummary(groups[0]!.sessions[0]!)).toBe("1 PR · 1 ticket");
    expect(sessionSummary(groups[2]!.sessions[0]!)).toBe("2 PRs");
  });

  test("the filter keeps whole sessions matching every word", () => {
    const keys = (q: string) => sessionLines(filterSessionGroups(groups, q)).map((l) => l.key);
    expect(keys("cp-7")).toEqual(["s:s1", "p:github.com/acme/web#12", "t:CP-7"]);
    expect(keys("acme/api")).toEqual(["s:s2", "p:github.com/acme/web#14", "p:github.com/acme/api#88"]);
    expect(keys("multiple")).toEqual(["s:s2", "p:github.com/acme/web#14", "p:github.com/acme/api#88"]);
    expect(keys("s5 started")).toEqual(["s:s5", "t:CP-9"]);
    expect(keys("nothing")).toEqual([]);
  });

  test("session state", () => {
    const row = (o: object) => ({ state: "idle", paused: 0, agent_running: 1, ...o }) as never;
    expect(sessionState(null)).toBe("unknown");
    expect(sessionState(row({ state: "busy" }))).toBe("busy");
    expect(sessionState(row({ paused: 1 }))).toBe("paused");
    expect(sessionState(row({ agent_running: 0 }))).toBe("idle · not running");
  });
});

describe("session details", () => {
  const groups = buildSessionGroups(
    [pr("github.com/acme/web#12", "s1"), pr("github.com/acme/web#14", "s1")],
    [ticket("CP-7", "s1", 1, "github.com/acme/web#14"), ticket("CP-8", "s1")],
  );
  const lines = sessionLines(groups);
  const line = (key: string) => lines.find((l) => l.key === key)!;

  test("history covers the selected PR, a ticket's handed-off PR, or the whole session", () => {
    expect(historyPrIds(line("s:s1"))).toEqual(["github.com/acme/web#12", "github.com/acme/web#14"]);
    expect(historyPrIds(line("p:github.com/acme/web#12"))).toEqual(["github.com/acme/web#12"]);
    expect(historyPrIds(line("t:CP-7"))).toEqual(["github.com/acme/web#14"]);
    expect(historyPrIds(line("t:CP-8"))).toEqual(["github.com/acme/web#12", "github.com/acme/web#14"]);
  });

  test("merges PR histories newest first", () => {
    const ev = (id: number, ts: number): EventRow => ({ id, ts, pr_id: "", kind: "k", detail: null });
    const merged = mergeHistory({ a: [ev(3, 30), ev(1, 10)], b: [ev(2, 20)] });
    expect(merged.map((m) => [m.prId, m.ev.id])).toEqual([["a", 3], ["b", 2], ["a", 1]]);
  });

  test("evaluator spend comes from the session's running total, or its PRs without a session row", () => {
    const e = groups[0]!.sessions[0]!;
    expect(sessionEvalCost({ ...e, session: { eval_cost_usd: 0.5, eval_count: 7 } as SessionRow })).toEqual({ usd: 0.5, runs: 7 });
    const prs = e.prs.map((p, i) => ({ ...p, eval_cost_usd: 0.01 * (i + 1), eval_count: 1 }));
    const c = sessionEvalCost({ ...e, session: null, prs });
    expect([c.usd.toFixed(2), c.runs]).toEqual(["0.03", 2]);
  });

  test("formats costs with cents precision for small amounts", () => {
    expect([formatUsd(0), formatUsd(0.0123), formatUsd(0.5), formatUsd(12.345)]).toEqual(["$0.00", "$0.0123", "$0.5000", "$12.35"]);
  });

  test("summarizes events in one line", () => {
    const ev = (kind: string, detail: unknown): EventRow => ({ id: 1, ts: 1, pr_id: "", kind, detail });
    expect(eventSummary(ev("evaluated", { shouldFix: true, reason: "bug", items: ["a", "b"], costUsd: 0.02 }))).toBe("fix 2 items: bug · $0.0200");
    expect(eventSummary(ev("evaluated", { shouldFix: false, reason: "LGTM", items: [] }))).toBe("no action: LGTM");
    expect(eventSummary(ev("new_items", { items: ["a"] }))).toBe("1 new item");
    expect(eventSummary(ev("error", { error: "boom" }))).toBe("boom");
    expect(eventSummary(ev("agent_stop", null))).toBe("");
  });
});
