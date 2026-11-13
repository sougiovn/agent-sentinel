import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parsePrRef } from "../src/core/pr-ref.ts";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/core/config.ts";
import { makeDaemon } from "./fakes.ts";

const PR = "acme/web#1";
const ID = "github.com/acme/web#1";
const ref = parsePrRef(PR);

async function setup(opts: { now?: () => number } = {}) {
  const t = makeDaemon(opts);
  t.gh.add(ref);
  t.gh.comment(ref, { id: 100, body: "old comment" });
  const res = await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "sess-1", cwd: "/repo" });
  expect(res[0]!.error).toBeUndefined();
  return t;
}

describe("watch", () => {
  test("baselines existing activity", async () => {
    const t = await setup();
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(0);
    expect(t.store.getPr(ID)!.last_status).toBe("no_changes");
  });

  test("--include-existing evaluates existing activity", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    t.gh.comment(ref, { id: 100 });
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: "/r", includeExisting: true });
    expect(t.evaluator.calls).toHaveLength(1);
  });

  test("rejects closed PRs and bad refs", async () => {
    const t = makeDaemon();
    t.gh.add(ref, { state: "MERGED" });
    const res = await t.daemon.handle("watch", { prs: [PR, "garbage"], agent: "claude", sessionId: "s", cwd: "/r" });
    expect(res[0]!.error).toContain("merged");
    expect(res[1]!.error).toContain("Invalid PR");
  });

  test("re-registering replaces the owning session", async () => {
    const t = await setup();
    await t.daemon.handle("watch", { prs: [PR], agent: "codex", sessionId: "sess-2", cwd: "/repo2" });
    const pr = t.store.getPr(ID)!;
    expect([pr.agent, pr.session_id, pr.cwd]).toEqual(["codex", "sess-2", "/repo2"]);
    expect(t.store.getSession("sess-1")).toBeNull();
  });
});

describe("poll → evaluate → spawn", () => {
  test("new comments are batched into one evaluation and spawned in a pane", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, body: "rename this" });
    t.gh.comment(ref, { id: 102, body: "add test" }, "inline");
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(1);
    expect(t.evaluator.calls[0]!.items.map((i) => i.id).sort()).toEqual(["inline:102", "issue:101"]);

    expect(t.mux.panes.size).toBe(1);
    const [line] = t.mux.allLines();
    expect(line).toContain("--resume 'sess-1'");
    expect(line).toStartWith("cd '/repo'");
    const promptFile = /\$\(cat '([^']+)'\)/.exec(line!)![1]!;
    const prompt = readFileSync(promptFile, "utf8");
    expect(prompt).toContain("Never rename the Rex session");
    expect(prompt).toContain("don't rename it either"); // default sentinel-tab layout shares the tab
    const s = t.store.getSession("sess-1")!;
    expect(s.state).toBe("busy");
    expect(t.store.getPr(ID)!.last_status).toBe("fix_running");

    // Nothing new → no re-evaluation, status kept.
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(1);
    expect(t.store.getPr(ID)!.last_status).toBe("fix_running");
  });

  test("evaluator says no → items seen, no spawn", async () => {
    const t = await setup();
    t.evaluator.next = { shouldFix: false, reason: "just an LGTM", items: [] };
    t.gh.comment(ref, { id: 101, body: "LGTM" });
    await t.daemon.sentinel.tick();
    expect(t.mux.panes.size).toBe(0);
    expect(t.store.getPr(ID)!.last_status).toBe("no_action");
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(1);
  });

  test("only flagged items are delivered", async () => {
    const t = await setup();
    t.evaluator.next = { shouldFix: true, reason: "one", items: ["issue:102"] };
    t.gh.comment(ref, { id: 101, body: "thanks" });
    t.gh.comment(ref, { id: 102, body: "bug here" });
    await t.daemon.sentinel.tick();
    const events = t.store.events(ID).find((e) => e.kind === "fix_delivered")!;
    expect((events.detail as { items: string[] }).items).toEqual(["issue:102"]);
  });

  test("own comments are ignored (@me)", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, user: { login: "me", type: "User" }, body: "done" });
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(0);
  });

  test("failing checks include a log tail; passing checks ignored", async () => {
    const t = await setup();
    t.gh.check(ref, { name: "lint", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/web/actions/runs/5/job/1" });
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(0);
    t.gh.check(ref, { name: "test", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/web/actions/runs/6/job/2" });
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(1);
    expect(t.evaluator.calls[0]!.items[0]!.logTail).toContain("Error: test failed");
  });

  test("evaluator failure leaves items unseen for retry", async () => {
    const t = await setup();
    t.evaluator.next = new Error("rate limited");
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)!.last_status).toBe("error");
    t.evaluator.next = { shouldFix: false, reason: "ok", items: [] };
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(2);
    expect(t.evaluator.calls[1]!.items.map((i) => i.id)).toEqual(["issue:101"]);
  });

  test("gh failure marks error", async () => {
    const t = await setup();
    t.gh.failNext = true;
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)!.last_status).toBe("error");
  });

  test("multiplexer down → spawn_failed, items re-evaluated with newer ones later", async () => {
    const t = await setup();
    t.mux.available = false;
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)!.last_status).toBe("spawn_failed");
    expect(t.store.pendingForSession("sess-1")).toHaveLength(0);

    t.mux.available = true;
    t.gh.comment(ref, { id: 102 });
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls[1]!.items.map((i) => i.id).sort()).toEqual(["issue:101", "issue:102"]);
    expect(t.store.getPr(ID)!.last_status).toBe("fix_running");
  });

  test("closed PR is wiped", async () => {
    const t = await setup();
    t.gh.get(ref).view.state = "CLOSED";
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)).toBeNull();
    expect(t.store.listSessions()).toHaveLength(0);
    expect(t.store.db.query("SELECT COUNT(*) AS n FROM seen_items").get()).toEqual({ n: 0 });
  });
});

describe("per-session queue", () => {
  test("busy session queues, idle signal delivers into the same pane", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()).toHaveLength(1);

    t.gh.comment(ref, { id: 102 });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()).toHaveLength(1); // queued
    expect(t.store.pendingForSession("sess-1")).toHaveLength(1);
    expect(t.store.getPr(ID)!.last_status).toBe("fix_spawned");

    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    expect(t.mux.panes.size).toBe(1);
    const lines = t.mux.allLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith("Sentinel has new PR feedback");
    expect(t.store.pendingForSession("sess-1")).toHaveLength(0);
  });

  test("busy hook after idle blocks delivery (user typing in pane)", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "busy" });
    t.gh.comment(ref, { id: 102 });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()).toHaveLength(1);
  });

  test("agent exit → next fix relaunches with --resume in the same pane", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "exit" });
    t.gh.comment(ref, { id: 102 });
    await t.daemon.sentinel.tick();
    const lines = t.mux.allLines();
    expect(t.mux.panes.size).toBe(1);
    expect(lines[1]).toContain("--resume 'sess-1'");
  });

  test("closed pane is recreated", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    t.mux.panes.clear();
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    t.gh.comment(ref, { id: 102 });
    await t.daemon.sentinel.tick();
    expect(t.mux.panes.size).toBe(1);
    const [pane] = [...t.mux.panes.values()];
    expect(pane!.lines[0]).toContain("--resume");
    expect(pane!.opts.homeId).toBe("session:home"); // reuses the stored home session, not its (renameable) label
    expect(pane!.opts.label).toBe("web#1"); // named after the PR it fixes
  });

  test("paused session holds fixes until resumed", async () => {
    const t = await setup();
    await t.daemon.handle("pause", { sessionId: "sess-1", paused: true });
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()).toHaveLength(0);
    await t.daemon.handle("pause", { sessionId: "sess-1", paused: false });
    expect(t.mux.allLines()).toHaveLength(1);
  });

  test("busy timeout frees the session", async () => {
    let now = 1_000_000;
    const t = await setup({ now: () => now });
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    t.gh.comment(ref, { id: 102 });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()).toHaveLength(1);
    now += 61 * 60_000;
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()).toHaveLength(2);
  });

  test("two PRs from one session share one pane and batch together", async () => {
    const t = await setup();
    const ref2 = parsePrRef("acme/api#2");
    t.gh.add(ref2);
    await t.daemon.handle("watch", { prs: ["acme/api#2"], agent: "claude", sessionId: "sess-1", cwd: "/repo" });
    await t.daemon.handle("pause", { sessionId: "sess-1", paused: true });
    t.gh.comment(ref, { id: 101 });
    t.gh.comment(ref2, { id: 201 });
    await t.daemon.sentinel.tick();
    await t.daemon.handle("pause", { sessionId: "sess-1", paused: false });
    expect(t.mux.panes.size).toBe(1);
    expect(t.mux.allLines()).toHaveLength(1);
    const delivered = t.store.events("github.com/acme/api#2").find((e) => e.kind === "fix_delivered");
    expect(delivered).toBeDefined();
  });

  test("maxConcurrent limits parallel sessions", async () => {
    const t = await setup();
    const ref2 = parsePrRef("acme/api#2");
    t.gh.add(ref2);
    await t.daemon.handle("watch", { prs: ["acme/api#2"], agent: "claude", sessionId: "sess-2", cwd: "/api" });
    // write config with maxConcurrent = 1 and reload
    const { loadConfig, saveConfig } = await import("../src/core/config.ts");
    const r = loadConfig(t.paths.config);
    if (!r.ok) throw new Error(r.error);
    r.config.spawn.maxConcurrent = 1;
    saveConfig(t.paths.config, r.config);
    expect(t.daemon.reload().ok).toBe(true);

    t.gh.comment(ref, { id: 101 });
    t.gh.comment(ref2, { id: 201 });
    await t.daemon.sentinel.tick();
    expect(t.mux.panes.size).toBe(1);
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    expect(t.mux.panes.size).toBe(2);
  });
});

describe("rpc", () => {
  test("list, history, unwatch, check", async () => {
    const t = await setup();
    const list = await t.daemon.handle("list", {});
    expect(list[0]!.session?.session_id).toBe("sess-1");
    expect((await t.daemon.handle("history", { pr: PR }))[0]!.kind).toBe("registered");
    t.gh.comment(ref, { id: 101 });
    expect((await t.daemon.handle("check", { pr: PR })).checked).toEqual([ID]);
    expect(t.evaluator.calls).toHaveLength(1);
    expect((await t.daemon.handle("unwatch", { pr: `https://github.com/acme/web/pull/1` })).removed).toBe(true);
    expect(await t.daemon.handle("list", {})).toHaveLength(0);
  });

  test("invalid config on reload keeps last good", async () => {
    const t = await setup();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(t.paths.config, "{broken");
    const r = t.daemon.reload();
    expect(r.ok).toBe(false);
    expect(t.daemon.status().configError).toContain("Invalid JSON");
    expect(t.daemon.status().multiplexer).toBe("rex");
  });
});

describe("manual refresh", () => {
  test("polls every watched PR and restarts the countdown for the next poll", async () => {
    let clock = 1_000_000;
    const t = makeDaemon({ now: () => clock });
    const api = parsePrRef("acme/api#2");
    t.gh.add(ref);
    t.gh.add(api);
    await t.daemon.handle("watch", { prs: [PR, "acme/api#2"], agent: "claude", sessionId: "s", cwd: "/r" });
    t.gh.comment(ref, { id: 101 });
    t.gh.comment(api, { id: 201 });

    const r = await t.daemon.handle("refresh", {});
    expect(r.accepted).toBe(true);
    expect([...r.checked].sort()).toEqual(["github.com/acme/api#2", ID]);
    expect(t.evaluator.calls.map((c) => c.items[0]!.id).sort()).toEqual(["issue:101", "issue:201"]);
    // The next scheduled poll is a full interval away, measured from the finished pass.
    expect(r.nextPollAt).toBe(clock + 300_000);
    expect(t.daemon.status().nextPollAt).toBe(r.nextPollAt);
  });

  test("refuses refreshes during the 30s cooldown after an accepted one", async () => {
    let clock = 1_000_000;
    const t = makeDaemon({ now: () => clock });
    t.gh.add(ref);
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: "/r" });
    expect((await t.daemon.handle("refresh", {})).accepted).toBe(true);

    t.gh.comment(ref, { id: 101 });
    clock += 29_000;
    const refused = await t.daemon.handle("refresh", {});
    expect(refused.accepted).toBe(false);
    expect(refused.retryAfterSec).toBe(1);
    expect(refused.checked).toEqual([]);
    expect(t.evaluator.calls).toHaveLength(0);

    clock += 1_000;
    const accepted = await t.daemon.handle("refresh", {});
    expect(accepted.accepted).toBe(true);
    expect(t.evaluator.calls).toHaveLength(1);
  });

  test("refuses a refresh while a full poll is already running", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: "/r" });

    const fetchActivity = t.gh.fetchActivity.bind(t.gh);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let gated = false;
    t.gh.fetchActivity = async (r) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return fetchActivity(r);
    };

    const first = t.daemon.handle("refresh", {});
    await Bun.sleep(0);
    const second = await t.daemon.handle("refresh", {});
    expect(second.accepted).toBe(false);
    expect(second.error).toContain("in progress");
    expect(second.checked).toEqual([]);

    release();
    const done = await first;
    expect(done.accepted).toBe(true);
    expect(done.checked).toEqual([ID]);
  });
});

describe("new-session watches (TUI)", () => {
  const fresh = (startNow: boolean, includeExisting = false, extra: { model?: string; effort?: string } = {}) => ({
    prs: [PR],
    agent: "claude" as const,
    cwd: "/repo",
    includeExisting,
    newSession: { startNow, ...extra },
  });

  test("start now launches a new session with an intro prompt, later feedback resumes it", async () => {
    const t = makeDaemon();
    t.gh.add(ref, { title: "Fix login" });
    t.gh.comment(ref, { id: 100, body: "old comment" });
    const [r] = await t.daemon.handle("watch", fresh(true, false, { model: "opus", effort: "high" }));
    expect(r!.error).toBeUndefined();
    const sid = r!.sessionId!;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);

    const s = t.store.getSession(sid)!;
    expect([s.model, s.effort, s.started]).toEqual(["opus", "high", 1]);
    const [launch] = t.mux.allLines();
    expect(launch).toContain(`--session-id '${sid}'`);
    expect(launch).toContain(`'--model' 'opus' '--effort' 'high'`);
    expect(t.evaluator.calls).toHaveLength(0);
    expect(t.store.events(ID).map((e) => e.kind)).toContain("session_started");

    await t.daemon.handle("signal", { sessionId: sid, signal: "exit" });
    t.gh.comment(ref, { id: 101, body: "rename this" });
    await t.daemon.sentinel.tick();
    const lines = t.mux.allLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`--resume '${sid}'`);
    expect(lines[1]).toContain(`'--model' 'opus'`);
  });

  test("on first feedback waits, then the first launch creates the session", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    const [r] = await t.daemon.handle("watch", fresh(false));
    expect(t.mux.allLines()).toHaveLength(0);
    expect(t.store.getSession(r!.sessionId!)!.started).toBe(0);

    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    const lines = t.mux.allLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`--session-id '${r!.sessionId}'`);
    expect(t.store.getSession(r!.sessionId!)!.started).toBe(1);
  });

  test("include existing delivers existing feedback as the first prompt instead of the intro", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    t.gh.comment(ref, { id: 100, body: "please fix" });
    const [r] = await t.daemon.handle("watch", fresh(true, true));
    expect(t.evaluator.calls).toHaveLength(1);
    const lines = t.mux.allLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`--session-id '${r!.sessionId}'`);
    expect(t.store.events(ID).map((e) => e.kind)).not.toContain("session_started");
  });

  test("codex can't get a new session; a handoff still needs a session id", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    const [r] = await t.daemon.handle("watch", { ...fresh(true), agent: "codex" });
    expect(r!.error).toContain("only start new sessions for claude");
    const [r2] = await t.daemon.handle("watch", { prs: [PR], agent: "claude", cwd: "/r" });
    expect(r2!.error).toContain("session id is required");
    expect(t.store.getPr(ID)).toBeNull();
  });

  test("handed-off sessions count as started", async () => {
    const t = await setup();
    expect(t.store.getSession("sess-1")!.started).toBe(1);
  });

  test("myPrs lists only authored PRs by default and flags watched ones", async () => {
    const t = await setup();
    t.gh.addSearchable(ref, "Test PR", { updatedAt: "2026-01-01T00:00:00Z" });
    t.gh.addSearchable(parsePrRef("acme/api#2"), "Newer", { updatedAt: "2026-02-01T00:00:00Z" });
    t.gh.addSearchable(parsePrRef("acme/api#3"), "Not mine", { mine: false });
    const list = await t.daemon.handle("myPrs", {});
    expect(list.map((p) => [p.id, p.watched])).toEqual([
      ["github.com/acme/api#2", false],
      [ID, true],
    ]);
    expect(t.gh.listCalls).toEqual([{ onlyMine: true }]);
  });

  test("suggestCwd prefers the cwd of a watched PR in the same repo", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: t.paths.home });
    expect((await t.daemon.handle("suggestCwd", { pr: "acme/web#9" })).path).toBe(t.paths.home);
  });
});

describe("titles", () => {
  test("stored on watch and refreshed on poll", async () => {
    const t = await setup();
    expect(t.store.getPr(ID)!.title).toBe("Test PR");
    t.gh.get(ref).view.title = "Renamed";
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)!.title).toBe("Renamed");
  });
});

describe("new-session RPCs and failures", () => {
  test("newWatchDefaults and myPrs follow the config", async () => {
    const t = makeDaemon();
    const cfg = defaultConfig();
    cfg.newWatch.onlyMine = false;
    cfg.newWatch.model = "opus";
    saveConfig(t.paths.config, cfg);
    t.daemon.reload();
    const d = await t.daemon.handle("newWatchDefaults", {});
    expect([d.model, d.startNow, d.includeExisting]).toEqual(["opus", true, true]);
    await t.daemon.handle("myPrs", {});
    expect(t.gh.listCalls).toEqual([{ onlyMine: false }]);
  });

  test("validateCwd rejects a missing directory", async () => {
    const t = makeDaemon();
    const r = await t.daemon.handle("validateCwd", { pr: PR, path: join(t.paths.home, "nope") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a directory");
  });

  test("a failed kickoff leaves the session unstarted so the next launch still creates it", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    t.mux.available = false;
    const [r] = await t.daemon.handle("watch", {
      prs: [PR],
      agent: "claude",
      cwd: "/repo",
      newSession: { startNow: true },
    });
    expect(r!.error).toBeUndefined();
    expect(t.store.getPr(ID)!.last_status).toBe("spawn_failed");
    expect(t.store.getSession(r!.sessionId!)!.started).toBe(0);

    t.mux.available = true;
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()[0]).toContain(`--session-id '${r!.sessionId}'`);
  });
});
