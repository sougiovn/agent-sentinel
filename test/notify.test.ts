import { describe, expect, test } from "bun:test";
import { defaultConfig, saveConfig, type Config } from "../src/core/config.ts";
import type { Exec } from "../src/core/exec.ts";
import { parsePrRef } from "../src/core/pr-ref.ts";
import { MacNotifier, NOTIFY_EVENTS, oneLine } from "../src/notify/notifier.ts";
import { FIELDS } from "../src/tui/settings.ts";
import { makeDaemon } from "./fakes.ts";

const PR = "acme/web#1";
const ID = "github.com/acme/web#1";
const ref = parsePrRef(PR);
const BOT = { login: "ci[bot]", type: "Bot" };

function daemon(patch: (c: Config) => void = () => {}) {
  const t = makeDaemon();
  const cfg = defaultConfig();
  cfg.jira.enabled = true;
  patch(cfg);
  saveConfig(t.paths.config, cfg);
  expect(t.daemon.reload().ok).toBe(true);
  return t;
}

async function watched(patch?: (c: Config) => void) {
  const t = daemon(patch);
  t.gh.add(ref, { title: "Fix login" });
  await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "sess-1234567", cwd: "/r" });
  return t;
}

const events = (t: ReturnType<typeof makeDaemon>) => t.notifications.map((n) => n.event);

describe("PR notifications", () => {
  test("a newly watched PR, but not a reassigned one", async () => {
    const t = await watched();
    expect(t.notifications).toEqual([
      {
        event: "prWatched",
        title: "Watching a new PR",
        subtitle: "[acme/web/1] Fix login",
        body: "claude session sess-123 · /r",
        url: "https://github.com/acme/web/pull/1",
        group: `pr:${ID}`,
      },
    ]);
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "other", cwd: "/r" });
    expect(t.notifications).toHaveLength(1);
  });

  test("new human comments, once each; ones already there when the PR was watched don't count", async () => {
    const t = daemon();
    t.gh.add(ref, { title: "Fix login" });
    t.gh.comment(ref, { id: 1, body: "old" });
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: "/r" });
    t.notifications.length = 0;
    t.evaluator.next = { shouldFix: false, reason: "nothing", items: [] };

    t.gh.comment(ref, { id: 2, body: "please\nrename this", user: { login: "alice", type: "User" }, html_url: "https://c/2" } as never);
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications).toEqual([
      {
        event: "humanComments",
        title: "New comment from @alice",
        subtitle: "[acme/web/1] Fix login",
        body: "please rename this",
        url: expect.any(String),
        group: `human:${ID}`,
      },
    ]);

    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications).toHaveLength(1);

    t.gh.comment(ref, { id: 3, user: { login: "bob", type: "User" } });
    t.gh.comment(ref, { id: 4, user: { login: "carol", type: "User" } });
    t.gh.comment(ref, { id: 5, user: BOT });
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications.at(-1)).toMatchObject({ title: "2 new human comments", body: "From @bob, @carol" });
  });

  test("feedback the evaluator flags for the agent", async () => {
    const t = await watched();
    t.notifications.length = 0;
    t.gh.comment(ref, { id: 7, user: BOT, body: "lint failed" });
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications).toEqual([
      expect.objectContaining({ event: "fixNeeded", title: "Feedback for the agent: 1 item", body: "needs fix", url: "https://github.com/acme/web/pull/1" }),
    ]);
  });

  test("nothing when the evaluator finds nothing to fix", async () => {
    const t = await watched();
    t.notifications.length = 0;
    t.evaluator.next = { shouldFix: false, reason: "just a thank-you", items: [] };
    t.gh.comment(ref, { id: 8, user: BOT });
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications).toEqual([]);
  });

  test("a merge conflict", async () => {
    const t = await watched();
    t.notifications.length = 0;
    Object.assign(t.gh.get(ref).view, { mergeable: "CONFLICTING", baseRefName: "main" });
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications).toEqual([
      expect.objectContaining({ event: "mergeConflict", body: "Conflicts with main; queued for the agent to resolve" }),
    ]);
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications).toHaveLength(1);
  });
});

describe("ticket notifications", () => {
  async function started(patch?: (c: Config) => void) {
    const t = daemon(patch);
    t.jira.add("CP-1");
    await t.daemon.runTicketPoll();
    t.gh.add(ref);
    return { ...t, sid: t.store.getTicket("CP-1")!.session_id };
  }

  test("a new ticket and its move to In Progress", async () => {
    const t = await started();
    expect(t.notifications).toEqual([
      {
        event: "ticketFound",
        title: "New Jira ticket: CP-1",
        subtitle: "Summary of CP-1",
        body: "Starting an agent session for it",
        url: "https://acme.atlassian.net/browse/CP-1",
        group: "ticket:CP-1",
      },
      expect.objectContaining({ event: "ticketTransitioned", title: "CP-1 moved to In Progress" }),
    ]);
    await t.daemon.runTicketPoll();
    expect(t.notifications).toHaveLength(2);
  });

  test("no transition notification when the move fails or is switched off", async () => {
    const t = daemon();
    t.jira.failTransition = new Error("nope");
    t.jira.add("CP-1");
    await t.daemon.runTicketPoll();
    expect(events(t)).toEqual(["ticketFound"]);
    const u = daemon((c) => (c.jira.transitionTo = ""));
    u.jira.add("CP-2");
    await u.daemon.runTicketPoll();
    expect(events(u)).toEqual(["ticketFound"]);
  });

  test("the move to In Review when the ticket's session hands off a PR", async () => {
    const t = await started();
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: t.sid, cwd: "/r" });
    expect(t.notifications.filter((n) => n.event === "ticketTransitioned").at(-1)).toMatchObject({
      title: "CP-1 moved to In Review",
      body: "The agent opened https://github.com/acme/web/pull/1",
    });
  });

  test("a ticket found done or cancelled in Jira stops being tracked", async () => {
    const t = await started();
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: t.sid, cwd: "/r" });
    t.jira.tickets[0]!.status = "Canceled";
    await t.daemon.runTicketPoll();
    expect(t.notifications.at(-1)).toEqual({
      event: "ticketDone",
      title: "CP-1 is Canceled",
      subtitle: "Summary of CP-1",
      body: `No longer tracked; stopped watching ${ID}`,
      url: "https://acme.atlassian.net/browse/CP-1",
      group: "ticket:CP-1",
    });
  });

  test("a merged PR moves its ticket to Done; a closed one moves it back", async () => {
    const t = await started();
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: t.sid, cwd: "/r" });
    t.gh.get(ref).view.state = "MERGED";
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications.at(-1)).toMatchObject({ event: "ticketDone", title: "CP-1 moved to Done" });

    const u = await started();
    await u.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: u.sid, cwd: "/r" });
    u.gh.get(ref).view.state = "CLOSED";
    await u.daemon.sentinel.checkPr(ID);
    expect(u.notifications.at(-1)).toMatchObject({ event: "ticketTransitioned", title: "CP-1 moved to In Progress" });
  });
});

describe("notification settings", () => {
  test("all events are on by default and each can be switched off", async () => {
    expect(defaultConfig().notifications).toEqual({
      enabled: true,
      method: "auto",
      events: Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, true])) as never,
    });
    const t = await watched((c) => (c.notifications.events.prWatched = false));
    expect(t.notifications).toEqual([]);
    t.gh.comment(ref, { id: 9, user: BOT });
    await t.daemon.sentinel.checkPr(ID);
    expect(events(t)).toEqual(["fixNeeded"]);
  });

  test("the master switch turns them all off", async () => {
    const t = await watched((c) => (c.notifications.enabled = false));
    t.gh.comment(ref, { id: 9, user: BOT });
    await t.daemon.sentinel.checkPr(ID);
    expect(t.notifications).toEqual([]);
  });

  test("a failing notifier is logged and never breaks the poll", async () => {
    const t = makeDaemon({ failNotifications: true });
    const logged: string[] = [];
    t.daemon.log = (m) => void logged.push(m);
    t.gh.add(ref);
    const r = await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: "/r" });
    expect(r[0]!.error).toBeUndefined();
    await Bun.sleep(0);
    expect(logged).toContain("notification (prWatched) failed: notifier down");
  });

  test("the settings dialog lists the switch, the method and every event", () => {
    const keys = FIELDS.filter((f) => f.group === "Notifications").map((f) => f.key);
    expect(keys).toEqual(["notifications.enabled", "notifications.method", ...NOTIFY_EVENTS.map((e) => `notifications.events.${e}`)]);
  });
});

describe("mac notifier", () => {
  const recorder = (which: number) => {
    const calls: string[][] = [];
    const run: Exec = async (cmd) => {
      calls.push(cmd);
      return { code: cmd[0] === "which" ? which : 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  };
  const n = { title: "T", subtitle: "S", body: "-starts with a dash", url: "https://x", group: "g" };

  test("auto prefers terminal-notifier, with a click-through URL", async () => {
    const { calls, run } = recorder(0);
    const m = new MacNotifier(run, () => "auto");
    await m.send(n);
    await m.send(n);
    expect(calls.filter((c) => c[0] === "which")).toHaveLength(1);
    expect(calls[1]).toEqual(["terminal-notifier", "-title", "T", "-subtitle", "S", "-message", " -starts with a dash", "-open", "https://x", "-group", "g"]);
  });

  test("auto falls back to osascript, passing text as arguments rather than script", async () => {
    const { calls, run } = recorder(1);
    await new MacNotifier(run, () => "auto").send({ title: 'a "quoted" title', body: "b" });
    const cmd = calls[1]!;
    expect(cmd[0]).toBe("osascript");
    expect(cmd.slice(-3)).toEqual(["b", 'a "quoted" title', ""]);
    expect(cmd.slice(1, -3).join(" ")).not.toContain("quoted");
  });

  test("reports a notifier that fails", async () => {
    const run: Exec = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(new MacNotifier(run, () => "osascript").send(n)).rejects.toThrow("osascript exited 1: boom");
  });

  test("bodies are flattened and capped", () => {
    expect(oneLine("a\n\n b")).toBe("a b");
    expect(oneLine("x".repeat(300))).toHaveLength(240);
  });
});
