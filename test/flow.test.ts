import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { parsePrRef } from "../src/core/pr-ref.ts";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/core/config.ts";
import { fakeGit, makeDaemon } from "./fakes.ts";
import { EvaluatorError } from "../src/evaluator/evaluator.ts";

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

  test("evaluator cost adds up on the PR and its session, failed runs included", async () => {
    const t = await setup();
    t.evaluator.next = { shouldFix: false, reason: "LGTM", items: [], costUsd: 0.02 };
    t.gh.comment(ref, { id: 101, body: "LGTM" });
    await t.daemon.sentinel.tick();
    t.evaluator.next = new EvaluatorError("Evaluator failed (error_max_budget_usd)", 0.05);
    t.gh.comment(ref, { id: 102, body: "nit" });
    await t.daemon.sentinel.tick();
    const pr = t.store.getPr(ID)!;
    expect([pr.eval_count, pr.eval_cost_usd.toFixed(2)]).toEqual([2, "0.07"]);
    const s = t.store.getSession(pr.session_id)!;
    expect([s.eval_count, s.eval_cost_usd.toFixed(2)]).toEqual([2, "0.07"]);
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

/** Bot comments: delivering them doesn't make the Stop hook ask for drafts, so idle signals go straight through. */
const BOT = { login: "ci[bot]", type: "Bot" };

describe("per-session queue", () => {
  test("busy session queues, idle signal delivers into the same pane", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, user: BOT });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()).toHaveLength(1);

    t.gh.comment(ref, { id: 102, user: BOT });
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
    t.gh.comment(ref, { id: 101, user: BOT });
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
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "busy" }); // started, then no idle signal
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

    t.gh.comment(ref, { id: 101, user: BOT });
    t.gh.comment(ref2, { id: 201, user: BOT });
    await t.daemon.sentinel.tick();
    expect(t.mux.panes.size).toBe(1);
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    expect(t.mux.panes.size).toBe(2);
  });
});

describe("go to agent", () => {
  test("opens a handed-off session in its own focused tab, then focuses it, and resumes it after the agent exits", async () => {
    const d = makeDaemon();
    d.gh.add(parsePrRef("acme/web#1"));
    await d.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });

    const opened = await d.daemon.handle("goToAgent", { sessionId: "s1" });
    expect(opened.how).toBe("opened");
    const pane = d.mux.panes.get(opened.paneId)!;
    expect(pane.opts).toMatchObject({ ownTab: true, focus: true, cwd: "/r", label: "web#1" });
    expect(pane.lines).toHaveLength(1);
    expect(pane.lines[0]).toStartWith(`cd '/r' && 'claude' --resume 's1' `);
    expect(pane.lines[0]).not.toContain("$(cat");
    expect(d.mux.focused.map((r) => r.paneId)).toEqual([opened.paneId]);
    expect(d.store.getSession("s1")).toMatchObject({ pane_id: opened.paneId, agent_running: 1, state: "idle" });

    const again = await d.daemon.handle("goToAgent", { sessionId: "s1" });
    expect(again).toMatchObject({ how: "focused", paneId: opened.paneId });
    expect(pane.lines).toHaveLength(1);
    expect(d.mux.panes.size).toBe(1);

    await d.daemon.handle("signal", { sessionId: "s1", signal: "exit" });
    const resumed = await d.daemon.handle("goToAgent", { sessionId: "s1" });
    expect(resumed).toMatchObject({ how: "resumed", paneId: opened.paneId });
    expect(pane.lines).toHaveLength(2);
    expect(d.mux.focused).toHaveLength(3);
  });

  test("reports a partial focus as a warning", async () => {
    const d = makeDaemon();
    d.gh.add(parsePrRef("acme/web#1"));
    await d.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });
    d.mux.focusWarning = "Rex app did not switch to the session";
    expect((await d.daemon.handle("goToAgent", { sessionId: "s1" })).warning).toBe("Rex app did not switch to the session");
  });

  test("refuses unknown sessions, sessions not started yet, and an unreachable multiplexer", async () => {
    const d = makeDaemon();
    await expect(d.daemon.handle("goToAgent", { sessionId: "nope" })).rejects.toThrow("Unknown session");
    d.store.ensureSession("s2", "claude", "/r", { started: false });
    await expect(d.daemon.handle("goToAgent", { sessionId: "s2" })).rejects.toThrow("hasn't started yet");
    d.gh.add(parsePrRef("acme/web#1"));
    await d.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });
    d.mux.available = false;
    await expect(d.daemon.handle("goToAgent", { sessionId: "s1" })).rejects.toThrow("rex down");
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

describe("repos view", () => {
  test("lists repos under the roots with their worktrees, watched PRs and tickets", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "roots-")));
    const web = join(root, "web");
    const wt = join(web, ".claude", "worktrees", "CP-7-fix");
    mkdirSync(join(web, ".git"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    const porcelain = `worktree ${web}\nHEAD aaaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbbb\nbranch refs/heads/CP-7-fix\n\n`;
    const t = makeDaemon({ exec: fakeGit({ [web]: "git@github.com:acme/web.git" }, { [web]: porcelain }) });
    const cfg = defaultConfig();
    cfg.newWatch.repoRoots = [root];
    saveConfig(t.paths.config, cfg);
    t.daemon.reload();
    t.gh.add(ref);
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: wt });
    t.store.insertTicket({ key: "CP-7", url: "u", summary: "Fix", sessionId: "t", cwd: root, now: 1, session: {} });

    const view = await t.daemon.handle("repos", {});
    expect(view.roots).toEqual([root]);
    expect(view.repos.map((r) => [r.path, r.remote])).toEqual([[web, "github.com/acme/web"]]);
    expect(view.repos[0]!.worktrees.map((w) => [w.path, w.main, w.prs, w.tickets])).toEqual([
      [web, true, [], []],
      [wt, false, [ID], ["CP-7"]],
    ]);
  });
});

describe("repos view errors", () => {
  test("a repo whose worktrees can't be listed is kept with the git error", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "roots-")));
    mkdirSync(join(root, "odd", ".git"), { recursive: true });
    const t = makeDaemon({ exec: fakeGit() });
    const cfg = defaultConfig();
    cfg.newWatch.repoRoots = [root];
    saveConfig(t.paths.config, cfg);
    t.daemon.reload();
    const view = await t.daemon.handle("repos", {});
    expect(view.repos.map((r) => [r.path, r.remote, r.worktrees, r.error])).toEqual([[join(root, "odd"), null, [], "not a git repository"]]);
  });

  test("no roots that exist means no repos", async () => {
    const t = makeDaemon();
    const cfg = defaultConfig();
    cfg.newWatch.repoRoots = [join(t.paths.home, "missing")];
    saveConfig(t.paths.config, cfg);
    t.daemon.reload();
    expect((await t.daemon.handle("repos", {})).repos).toEqual([]);
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

describe("human comments", () => {
  const open = async (t: Awaited<ReturnType<typeof setup>>) => (await t.daemon.handle("list", {}))[0]!.humanOpen;

  test("existing human comments are tracked even when baselined; bots and @me are not", async () => {
    const t = makeDaemon();
    t.gh.add(ref);
    t.gh.comment(ref, { id: 100, body: "why this?" });
    t.gh.comment(ref, { id: 101, user: { login: "coderabbitai[bot]", type: "Bot" }, body: "nit" });
    t.gh.comment(ref, { id: 102, user: { login: "me", type: "User" }, body: "mine" });
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: "/r" });
    const rows = await t.daemon.handle("humanComments", { pr: PR });
    expect(rows.map((r) => r.item_id)).toEqual(["issue:100"]);
    expect((await t.daemon.handle("list", {}))[0]!.humanOpen).toBe(1);
  });

  test("inline comments follow their GitHub thread; deleted comments disappear", async () => {
    const t = await setup();
    t.evaluator.next = { shouldFix: false, reason: "question", items: [] };
    t.gh.comment(ref, { id: 200, body: "rename", path: "a.ts", line: 3 }, "inline");
    await t.daemon.sentinel.tick();
    expect(await open(t)).toBe(2);
    t.gh.thread(ref, [200], true);
    await t.daemon.sentinel.tick();
    expect(await open(t)).toBe(1);
    t.gh.get(ref).conversationComments = [];
    await t.daemon.sentinel.tick();
    expect(await open(t)).toBe(0);
    expect((await t.daemon.handle("humanComments", { pr: PR })).map((r) => r.item_id)).toEqual(["inline:200"]);
  });

  test("conversation comments stay open until the user resolves them, even after replies", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, user: { login: "me", type: "User" }, body: "done" });
    await t.daemon.sentinel.tick();
    expect(await open(t)).toBe(1);
    await t.daemon.handle("resolveComment", { pr: PR, item: "issue:100", resolved: true });
    expect(await open(t)).toBe(0);
    await t.daemon.sentinel.tick();
    expect(await open(t)).toBe(0);
    await t.daemon.handle("resolveComment", { pr: PR, item: "issue:100", resolved: false });
    expect(await open(t)).toBe(1);
    expect(t.store.events(ID).map((e) => e.kind)).toContain("comment_resolved");
  });

  test("agent drafts are stored; partial updates keep the other fields", async () => {
    const t = await setup();
    await t.daemon.handle("draft", { pr: PR, item: "issue:100", summary: "asks why", change: "nothing", reply: "Because." });
    await t.daemon.handle("draft", { pr: PR, item: "issue:100", reply: "Because X.", by: "user" });
    const [c] = await t.daemon.handle("humanComments", { pr: PR });
    expect([c!.draft_summary, c!.draft_change, c!.draft_reply, c!.draft_by]).toEqual(["asks why", "nothing", "Because X.", "user"]);
    await expect(t.daemon.handle("draft", { pr: PR, item: "issue:999", reply: "x" })).rejects.toThrow("not a human comment");
    await expect(t.daemon.handle("draft", { pr: PR, item: "issue:100" })).rejects.toThrow("at least one");
    await expect(t.daemon.handle("draft", { pr: "acme/web#9", item: "issue:100", reply: "x" })).rejects.toThrow("Not watching");
  });

  test("Stop hook asks once for missing drafts, then lets the agent stop", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, body: "please rename" });
    await t.daemon.sentinel.tick();
    expect(t.store.getHumanComment(ID, "issue:101")!.delivered_session).toBe("sess-1");

    const first = await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    expect(first.block).toContain(`sentinel draft ${ID} issue:101`);
    expect(first.block).not.toContain("issue:100"); // never delivered
    expect(t.store.getSession("sess-1")!.state).toBe("busy");

    const second = await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle", stopHookActive: true });
    expect(second.block).toBeUndefined();
    expect(t.store.getSession("sess-1")!.state).toBe("idle");

    // Already asked: a later stop doesn't nag again.
    const third = await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    expect(third.block).toBeUndefined();
  });

  test("a later delivery of the same session asks again for its new comments only", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, body: "please rename" });
    await t.daemon.sentinel.tick();
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" }); // asks for issue:101
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle", stopHookActive: true }); // lets it stop

    t.gh.comment(ref, { id: 102, body: "add a test" });
    await t.daemon.sentinel.tick();
    const r = await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" });
    expect(r.block).toContain("issue:102");
    expect(r.block).not.toContain("issue:101");
  });

  test("resolved comments are never asked for", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, body: "please rename" });
    await t.daemon.sentinel.tick();
    await t.daemon.handle("resolveComment", { pr: PR, item: "issue:101", resolved: true });
    expect((await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" })).block).toBeUndefined();
  });

  test("unknown PRs and comments are rejected", async () => {
    const t = await setup();
    await expect(t.daemon.handle("humanComments", { pr: "acme/web#9" })).rejects.toThrow("Not watching");
    await expect(t.daemon.handle("resolveComment", { pr: PR, item: "issue:999", resolved: true })).rejects.toThrow("No human comment");
  });

  test("closing the PR wipes its human comments", async () => {
    const t = await setup();
    expect(t.store.humanComments(ID)).toHaveLength(1);
    t.gh.get(ref).view.state = "MERGED";
    await t.daemon.sentinel.tick();
    expect(t.store.humanComments(ID)).toHaveLength(0);
  });

  test("no nudge when drafts were recorded, or for bot comments", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101, body: "please rename" });
    t.gh.comment(ref, { id: 102, user: { login: "ci[bot]", type: "Bot" }, body: "lint" });
    await t.daemon.sentinel.tick();
    await t.daemon.handle("draft", { pr: PR, item: "issue:101", reply: "Renamed." });
    expect((await t.daemon.handle("signal", { sessionId: "sess-1", signal: "idle" })).block).toBeUndefined();
  });

  test("fix prompt tells the agent to record drafts", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    const promptFile = /\$\(cat '([^']+)'\)/.exec(t.mux.allLines()[0]!)![1]!;
    expect(readFileSync(promptFile, "utf8")).toContain("sentinel draft https://github.com/acme/web/pull/1 <item-id>");
  });
});

describe("merge conflicts", () => {
  const view = (t: ReturnType<typeof makeDaemon>) => t.gh.get(ref).view;

  test("a conflict skips the evaluator, is delivered once per head, and UNKNOWN keeps the last state", async () => {
    const t = await setup();
    Object.assign(view(t), { mergeable: "CONFLICTING", baseRefName: "main" });
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(0);
    expect(t.store.getPr(ID)!.mergeable).toBe("CONFLICTING");
    expect(t.store.getPr(ID)!.base_ref).toBe("main");
    const delivered = t.store.events(ID).find((e) => e.kind === "fix_delivered")!;
    expect((delivered.detail as { items: string[] }).items).toEqual(["conflict:sha1"]);
    const prompt = readFileSync(/\$\(cat '([^']+)'\)/.exec(t.mux.allLines()[0]!)![1]!, "utf8");
    expect(prompt).toContain("Merge conflict with `main`");

    // Base moves on, head unchanged: no repeat. UNKNOWN while GitHub recomputes keeps the last state.
    Object.assign(view(t), { mergeable: "UNKNOWN" });
    await t.daemon.sentinel.tick();
    Object.assign(view(t), { mergeable: "CONFLICTING" });
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)!.mergeable).toBe("CONFLICTING");
    expect(t.store.events(ID).filter((e) => e.kind === "merge_conflict")).toHaveLength(1);

    // A push that doesn't resolve it gets it again; one that does clears it.
    Object.assign(view(t), { headRefOid: "sha2" });
    await t.daemon.sentinel.tick();
    expect(t.store.events(ID).filter((e) => e.kind === "merge_conflict")).toHaveLength(2);
    Object.assign(view(t), { headRefOid: "sha3", mergeable: "MERGEABLE" });
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)!.mergeable).toBe("MERGEABLE");
  });

  test("a conflict alongside comments goes with what the evaluator flags", async () => {
    const t = await setup();
    t.evaluator.next = { shouldFix: true, reason: "bug", items: ["issue:101"] };
    Object.assign(view(t), { mergeable: "CONFLICTING", baseRefName: "main" });
    t.gh.comment(ref, { id: 101, body: "bug here" });
    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls[0]!.items.map((i) => i.id)).toEqual(["issue:101"]);
    const delivered = t.store.events(ID).find((e) => e.kind === "fix_delivered")!;
    expect((delivered.detail as { items: string[] }).items.sort()).toEqual(["conflict:sha1", "issue:101"]);
  });

  test("a PR already conflicting when watched isn't baselined away", async () => {
    const t = makeDaemon();
    t.gh.add(ref, { mergeable: "CONFLICTING", baseRefName: "main" });
    await t.daemon.handle("watch", { prs: [PR], agent: "claude", sessionId: "s", cwd: "/r" });
    expect(t.store.getPr(ID)!.mergeable).toBe("CONFLICTING");
    await t.daemon.sentinel.tick();
    expect(t.store.events(ID).some((e) => e.kind === "merge_conflict")).toBe(true);
    expect(t.store.humanComments(ID)).toEqual([]);
  });
});

describe("launch reliability", () => {
  test("a new pane's shell prompt is waited for before typing", async () => {
    const t = await setup();
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    const [pane] = [...t.mux.panes.keys()];
    expect(t.mux.reads.get(pane!)).toBe(7); // the screen never changes after its first text, so it must stay quiet for 6 more reads
    expect(t.mux.allLines()).toHaveLength(1);
  });

  test("a shell that never shows a prompt still gets the line after the wait gives up", async () => {
    const t = await setup();
    t.mux.slowShell = true;
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    const [pane] = [...t.mux.panes.keys()];
    expect(t.mux.reads.get(pane!)).toBe(40);
    expect(t.mux.allLines()).toHaveLength(1);
  });

  test("an agent that never signals is reported, rolled back and retried in a new pane", async () => {
    let now = 1_000_000;
    const t = await setup({ now: () => now });
    t.gh.comment(ref, { id: 101, body: "fix" });
    await t.daemon.sentinel.tick();
    const [first] = [...t.mux.panes.keys()];
    expect(t.store.getSession("sess-1")!.awaiting_ack_since).toBe(now);

    now += 299_000; // within spawn.startTimeoutSec (300)
    await t.daemon.sentinel.tick();
    expect(t.store.getPr(ID)!.last_status).toBe("fix_running");

    now += 2_000;
    await t.daemon.sentinel.tick();
    // The rollback happens after this pass's poll, so the next poll picks the item up again.
    const pr = t.store.getPr(ID)!;
    expect(pr.last_status).toBe("spawn_failed");
    expect(pr.last_reason).toContain(`didn't start within 300s in pane ${first}`);
    const failed = t.store.events(ID).find((e) => e.kind === "start_failed")!;
    expect(failed.detail).toEqual({ pane: first, items: ["issue:101"] });
    const s = t.store.getSession("sess-1")!;
    expect([s.state, s.agent_running, s.pane_id, s.awaiting_ack_since]).toEqual(["idle", 0, null, null]);
    expect(t.mux.panes.has(first!)).toBe(true); // left for the user to look at

    await t.daemon.sentinel.tick();
    expect(t.evaluator.calls).toHaveLength(2);
    expect(t.mux.panes.size).toBe(2);
    const second = [...t.mux.panes.keys()].find((k) => k !== first)!;
    expect(t.mux.panes.get(second)!.lines[0]).toContain("--resume 'sess-1'");
  });

  test("any hook signal confirms the delivery", async () => {
    let now = 1_000_000;
    const t = await setup({ now: () => now });
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    await t.daemon.handle("signal", { sessionId: "sess-1", signal: "busy" });
    expect(t.store.getSession("sess-1")!.awaiting_ack).toBeNull();
    now += 10 * 60_000;
    await t.daemon.sentinel.tick();
    expect(t.store.events(ID).some((e) => e.kind === "start_failed")).toBe(false);
    expect(t.store.getPr(ID)!.last_status).toBe("fix_running");
  });

  test("a new session that never starts launches with --session-id again", async () => {
    let now = 1_000_000;
    const t = makeDaemon({ now: () => now });
    t.gh.add(ref);
    const [r] = await t.daemon.handle("watch", { prs: [PR], agent: "claude", cwd: "/repo", newSession: { startNow: true } });
    const sid = r!.sessionId!;
    expect(t.mux.allLines()[0]).toContain(`--session-id '${sid}'`);
    now += 301_000;
    await t.daemon.sentinel.tick();
    expect(t.store.getSession(sid)!.started).toBe(0);
    expect(t.store.getPr(ID)!.last_status).toBe("spawn_failed");
    t.gh.comment(ref, { id: 101 });
    await t.daemon.sentinel.tick();
    expect(t.mux.allLines()[1]).toContain(`--session-id '${sid}'`);
  });
});
