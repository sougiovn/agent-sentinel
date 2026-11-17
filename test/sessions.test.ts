import { describe, expect, test } from "bun:test";
import type { PrListEntry, TicketListEntry } from "../src/daemon/protocol.ts";
import { buildSessionGroups, filterSessionGroups, MULTI_REPO_GROUP, NO_PR_GROUP, sessionLines, sessionState, sessionSummary } from "../src/tui/sessions.ts";

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
