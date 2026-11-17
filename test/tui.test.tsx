import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { rgbToHex, type CapturedFrame } from "@opentui/core";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaths, ensureHome } from "../src/core/paths.ts";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config.ts";
import { parsePrRef } from "../src/core/pr-ref.ts";
import { App, type RpcClient } from "../src/tui/app.tsx";
import { DEFAULT_THEME, saveTheme } from "../src/tui/theme.ts";
import { fakeGit, makeDaemon } from "./fakes.ts";

test("TUI renders offline state and settings view, and saves an enum toggle", async () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "tui-")));
  ensureHome(paths);
  const t = await testRender(() => <App paths={paths} autoStart={false} />, { width: 120, height: 30 });
  await Bun.sleep(300);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Agent Sentinel");
  expect(frame).toContain("daemon is not running");

  t.mockInput.pressKey("s");
  await Bun.sleep(50);
  await t.renderOnce();
  const settings = t.captureCharFrame();
  expect(settings).toContain("Multiplexer");
  expect(settings).toContain("Busy timeout (min)");

  t.mockInput.pressEnter(); // cycle multiplexer rex → herdr
  await Bun.sleep(100);
  const r = loadConfig(paths.config);
  expect(r.ok && r.config.multiplexer).toBe("herdr");

  t.mockInput.pressEnter(); // cycle multiplexer herdr → hc
  await Bun.sleep(100);
  const r2 = loadConfig(paths.config);
  expect(r2.ok && r2.config.multiplexer).toBe("hc");
  t.renderer.destroy();
});

test("TUI applies a custom theme and reloads it when the file changes", async () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "tui-theme-")));
  ensureHome(paths);
  writeFileSync(paths.theme, JSON.stringify({ accent: "#ff00ff" }));

  const fgOf = (frame: CapturedFrame, text: string): string | undefined => {
    for (const line of frame.lines) for (const span of line.spans) if (span.text.includes(text)) return rgbToHex(span.fg);
  };
  const t = await testRender(() => <App paths={paths} autoStart={false} />, { width: 120, height: 24 });
  const frame = async (ms = 100) => {
    await Bun.sleep(ms);
    await t.renderOnce();
    return t.captureSpans();
  };
  expect(fgOf(await frame(), "Agent Sentinel")).toBe("#ff00ff");

  saveTheme(paths.theme, { ...DEFAULT_THEME, accent: "#00ff00" }); // atomic save, via rename
  expect(fgOf(await frame(500), "Agent Sentinel")).toBe("#00ff00");

  writeFileSync(paths.theme, JSON.stringify({ accent: "#12345" })); // 5 hex digits is invalid
  expect(fgOf(await frame(500), "Agent Sentinel")).toBe("#00ff00");
  expect(t.captureCharFrame()).toContain("Theme error (last good theme in use)");
  t.renderer.destroy();
});

test("TUI starts the daemon on launch", async () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "tui-")));
  ensureHome(paths);
  let starts = 0;
  const start = async () => {
    starts++;
    return true;
  };
  const t = await testRender(() => <App paths={paths} start={start} />, { width: 120, height: 30 });
  await Bun.sleep(100);
  expect(starts).toBe(1);
  t.renderer.destroy();
});

test("TUI reports a failed daemon start", async () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "tui-")));
  ensureHome(paths);
  const start = async (): Promise<boolean> => {
    throw new Error("boom");
  };
  const t = await testRender(() => <App paths={paths} start={start} />, { width: 120, height: 30 });
  await Bun.sleep(300);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Could not start daemon: boom");
  t.renderer.destroy();
});

test("TUI picks one of my PRs, fills the form and starts a new-session watch", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "clone-"));
  mkdirSync(join(repoDir, "web", ".git"), { recursive: true });
  const clone = join(repoDir, "web");
  const t0 = makeDaemon({ exec: fakeGit({ [clone]: "git@github.com:acme/web.git" }) });
  const cfg = defaultConfig();
  cfg.newWatch.repoRoots = [repoDir];
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  t0.gh.addSearchable(parsePrRef("acme/web#1"), "Fix login redirect", { updatedAt: "2026-02-01T00:00:00Z" });
  t0.gh.addSearchable(parsePrRef("acme/api#2"), "Add rate limits");
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };

  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 140, height: 30 });
  const frame = async () => {
    await Bun.sleep(80);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey("n");
  let f = await frame();
  expect(f).toContain("Fix login redirect");
  expect(f).toContain("Add rate limits");

  await t.mockInput.typeText("api");
  f = await frame();
  expect(f).toContain("Add rate limits");
  expect(f).not.toContain("Fix login redirect");

  for (let i = 0; i < 3; i++) t.mockInput.pressBackspace();
  await t.mockInput.typeText("web");
  f = await frame();
  expect(f).not.toContain("Add rate limits");
  t.mockInput.pressEnter();
  f = await frame();
  expect(f).toContain("New watch");
  expect(f).toContain(clone);

  t.mockInput.pressArrow("right"); // model: default → opus
  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("right"); // effort: default → low
  for (let i = 0; i < 4; i++) t.mockInput.pressArrow("down"); // to [ Watch ]
  f = await frame();
  expect(f).toContain("opus");
  t.mockInput.pressEnter();
  await Bun.sleep(300);
  f = await frame();
  expect(f).toContain("Watched PRs");
  expect(f).toMatch(/acme\/web[^\n]*\n[^\n]*#1 - Fix login redirect/);

  const pr = t0.store.getPr("github.com/acme/web#1")!;
  expect(pr.cwd).toBe(clone);
  const s = t0.store.getSession(pr.session_id)!;
  expect([s.model, s.effort, s.started]).toEqual(["opus", "low", 1]);
  expect(t0.mux.allLines()[0]).toContain(`--session-id '${pr.session_id}'`);
  t.renderer.destroy();
});

test("TUI settings dialog filters fields with /", async () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "tui-")));
  ensureHome(paths);
  const t = await testRender(() => <App paths={paths} autoStart={false} />, { width: 120, height: 30 });
  const frame = async () => {
    await Bun.sleep(80);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey("s");
  await frame();
  t.mockInput.pressKey("/");
  await frame();
  await t.mockInput.typeText("busy");
  let f = await frame();
  expect(f).toContain("Busy timeout (min)");
  expect(f).not.toContain("Multiplexer");
  expect(f).not.toContain("/ /busy");

  t.mockInput.pressEnter(); // leave the filter input, keep the filter
  await frame();
  t.mockInput.pressEnter(); // edit the only match
  f = await frame();
  expect(f).toContain("enter save");

  t.mockInput.pressEscape(); // cancel edit
  await frame();
  t.mockInput.pressEscape(); // clear filter
  f = await frame();
  expect(f).toContain("Multiplexer");
  expect(f).toContain("Settings");
  t.renderer.destroy();
});

test("TUI filters watched PRs by repo or title with /", async () => {
  const d = makeDaemon();
  for (const [r, title] of [["acme/web#1", "Fix login redirect"], ["acme/api#2", "Add rate limits"], ["zeta/tools#3", "Bump deps"]] as const) {
    d.gh.add(parsePrRef(r), { title });
    await d.daemon.handle("watch", { prs: [r], agent: "claude", sessionId: "s1", cwd: "/r" });
  }
  const client: RpcClient = { call: (m, p) => d.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={d.paths} autoStart={false} client={client} />, { width: 120, height: 24 });
  const frame = async () => {
    await Bun.sleep(80);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey("/");
  await frame();
  await t.mockInput.typeText("acme rate");
  let f = await frame();
  expect(f).toContain("#2 - Add rate limits");
  expect(f).not.toContain("Fix login redirect");
  expect(f).not.toContain("zeta/tools");

  for (let i = 0; i < 9; i++) t.mockInput.pressBackspace();
  await t.mockInput.typeText("zeta");
  t.mockInput.pressEnter(); // keep the filter, back to the list
  f = await frame();
  expect(f).toContain("#3 - Bump deps");
  expect(f).not.toContain("acme/api");
  expect(f).toContain("https://github.com/zeta/tools/pull/3"); // details follow the filtered selection

  t.mockInput.pressEscape(); // clear the filter
  f = await frame();
  expect(f).toContain("Fix login redirect");
  expect(f).toContain("Bump deps");
  t.renderer.destroy();
});

test("TUI refreshes all PRs with r, backs off, and reloads config with R", async () => {
  const d = makeDaemon();
  d.gh.add(parsePrRef("acme/web#1"), { title: "Fix login redirect" });
  await d.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });
  d.gh.comment(parsePrRef("acme/web#1"), { id: 101 });
  const client: RpcClient = { call: (m, p) => d.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={d.paths} autoStart={false} client={client} />, { width: 140, height: 24 });
  const frame = async () => {
    await Bun.sleep(150);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();

  t.mockInput.pressKey("r");
  let f = await frame();
  expect(f).toContain("Refreshed 1 PR");
  expect(d.evaluator.calls).toHaveLength(1);

  t.mockInput.pressKey("r");
  f = await frame();
  expect(f).toContain("cooling down");
  expect(d.evaluator.calls).toHaveLength(1);

  t.mockInput.pressKey("r", { shift: true });
  f = await frame();
  expect(f).toContain("Config reloaded (TUI + daemon)");
  t.renderer.destroy();
});

test("TUI opens the selected PR in the browser with o", async () => {
  const d = makeDaemon();
  for (const r of ["acme/web#1", "acme/web#2"]) {
    d.gh.add(parsePrRef(r));
    await d.daemon.handle("watch", { prs: [r], agent: "claude", sessionId: "s1", cwd: "/r" });
  }
  const opened: string[] = [];
  const client: RpcClient = { call: (m, p) => d.daemon.handle(m, p) };
  const t = await testRender(
    () => <App paths={d.paths} autoStart={false} client={client} openUrl={(u) => opened.push(u)} />,
    { width: 120, height: 24 },
  );
  await Bun.sleep(100);
  t.mockInput.pressArrow("down");
  t.mockInput.pressKey("o");
  await Bun.sleep(50);
  expect(opened).toEqual(["https://github.com/acme/web/pull/2"]);
  t.renderer.destroy();
});

test("TUI new-watch form: typed directory is validated, a remote mismatch needs a second enter", async () => {
  const root = mkdtempSync(join(tmpdir(), "clone-"));
  const other = join(root, "other");
  mkdirSync(join(other, ".git"), { recursive: true });
  const d = makeDaemon({ exec: fakeGit({ [other]: "git@github.com:acme/other.git" }) });
  const cfg = defaultConfig();
  cfg.newWatch.repoRoots = [join(root, "empty")];
  saveConfig(d.paths.config, cfg);
  d.daemon.reload();
  d.gh.addSearchable(parsePrRef("acme/web#1"), "Fix login redirect");
  const client: RpcClient = { call: (m, p) => d.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={d.paths} autoStart={false} client={client} />, { width: 140, height: 30 });
  const frame = async (ms = 80) => {
    await Bun.sleep(ms);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey("n");
  await frame();
  t.mockInput.pressEnter();
  let f = await frame();
  expect(f).toContain("not found, press enter to type a path");

  t.mockInput.pressArrow("down");
  t.mockInput.pressArrow("down"); // Directory
  t.mockInput.pressEnter();
  await frame();
  await t.mockInput.typeText(join(root, "missing"));
  t.mockInput.pressEnter();
  for (let i = 0; i < 3; i++) t.mockInput.pressArrow("down"); // [ Watch ]
  t.mockInput.pressEnter();
  f = await frame(200);
  expect(f).toContain("is not a directory");

  for (let i = 0; i < 3; i++) t.mockInput.pressArrow("up"); // Directory
  t.mockInput.pressEnter();
  await frame();
  for (let i = 0; i < join(root, "missing").length; i++) t.mockInput.pressBackspace();
  await t.mockInput.typeText(other);
  t.mockInput.pressEnter();
  for (let i = 0; i < 3; i++) t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  f = await frame(200);
  expect(f).toContain("not acme/web");
  expect(d.store.listPrs()).toHaveLength(0);

  t.mockInput.pressEnter(); // second enter goes ahead
  await frame(300);
  expect(d.store.getPr("github.com/acme/web#1")!.cwd).toBe(other);
  t.renderer.destroy();
});

test("TUI asks to start the daemon before opening the PR picker", async () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "tui-")));
  ensureHome(paths);
  const t = await testRender(() => <App paths={paths} autoStart={false} />, { width: 120, height: 30 });
  await Bun.sleep(300);
  t.mockInput.pressKey("n");
  await Bun.sleep(50);
  await t.renderOnce();
  const f = t.captureCharFrame();
  expect(f).toContain("Start the daemon first");
  expect(f).not.toContain("Watch a PR");
  t.renderer.destroy();
});

test("TUI goes to the selected PR's or ticket's agent with A", async () => {
  const t0 = makeDaemon();
  const cfg = defaultConfig();
  cfg.jira.enabled = true;
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  t0.gh.add(parsePrRef("acme/web#1"));
  await t0.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });
  t0.jira.add("CP-7", { summary: "Add audit log" });
  await t0.daemon.runTicketPoll();
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 160, height: 30 });
  const frame = async () => {
    await Bun.sleep(150);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  expect(await frame()).toContain("A go to agent");

  t.mockInput.pressKey("a"); // lowercase does nothing
  await frame();
  expect(t0.mux.focused).toHaveLength(0);

  t.mockInput.pressKey("a", { shift: true });
  expect(await frame()).toContain("Reopened github.com/acme/web#1's agent");
  expect(t0.mux.focused.at(-1)!.paneId).toBe(t0.store.getSession("s1")!.pane_id!);

  t.mockInput.pressKey("t");
  await frame();
  t.mockInput.pressKey("a", { shift: true });
  expect(await frame()).toContain("Went to CP-7's agent");
  const ticketSession = t0.store.getTicket("CP-7")!.session_id;
  expect(t0.mux.focused.at(-1)!.paneId).toBe(t0.store.getSession(ticketSession)!.pane_id!);
  t.renderer.destroy();
});

test("TUI shows picked-up Jira tickets and dismisses one", async () => {
  const t0 = makeDaemon();
  const cfg = defaultConfig();
  cfg.jira.enabled = true;
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  t0.jira.add("CP-7", { summary: "Add audit log" });
  await t0.daemon.runTicketPoll();
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };

  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 140, height: 30 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  let f = await frame();
  expect(f).toContain('Jira tickets · label "sentinel"');
  expect(f).toContain("CP-7 - Add audit log");
  expect(f).toContain("started");

  t.mockInput.pressKey("t");
  f = await frame();
  expect(f).toContain("o open ticket");
  expect(f).toContain("https://acme.atlassian.net/browse/CP-7");

  t.mockInput.pressKey("d");
  f = await frame();
  expect(f).toContain("Dismiss CP-7?");
  t.mockInput.pressKey("y");
  f = await frame();
  expect(t0.store.getTicket("CP-7")!.dismissed).toBe(1);
  expect(f).not.toContain("CP-7 - Add audit log");
  t.renderer.destroy();
});

test("TUI repos view lists worktrees with their watched PR and Jira ticket", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roots-")));
  const web = join(root, "web");
  const wt = join(root, "wt", "CP-7-fix");
  mkdirSync(join(web, ".git"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  const porcelain = `worktree ${web}\nHEAD aaaa\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD bbbb\nbranch refs/heads/CP-7-fix\n\n`;
  const t0 = makeDaemon({ exec: fakeGit({ [web]: "git@github.com:acme/web.git" }, { [web]: porcelain }) });
  const cfg = defaultConfig();
  cfg.newWatch.repoRoots = [root];
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  t0.gh.add(parsePrRef("acme/web#1"), { title: "Fix login redirect" });
  await t0.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s", cwd: wt });
  t0.store.insertTicket({ key: "CP-7", url: "https://acme.atlassian.net/browse/CP-7", summary: "Login loops", sessionId: "t", cwd: root, now: 1, session: {} });
  const opened: string[] = [];
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };

  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} openUrl={(u) => opened.push(u)} />, { width: 140, height: 30 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey("g");
  const f = await frame();
  expect(f).toContain("1 repo · 2 worktrees · 1 with a watched PR or ticket");
  expect(f).toContain("acme/web");
  expect(f).toContain("main checkout");
  expect(f).toContain("CP-7-fix");
  expect(f).toContain("PR #1 - Fix login redirect");
  expect(f).toContain("CP-7 - Login loops");

  t.mockInput.pressKey("o"); // the main checkout has nothing to open
  await frame();
  expect(opened).toEqual([]);
  t.mockInput.pressArrow("down");
  await frame();
  t.mockInput.pressKey("o");
  await frame();
  expect(opened).toEqual(["https://github.com/acme/web/pull/1"]);

  t.mockInput.pressKey("/");
  await frame();
  await t.mockInput.typeText("login");
  let ff = await frame();
  expect(ff).toContain("1 shown");
  expect(ff).toContain("PR #1 - Fix login redirect");
  expect(ff).not.toContain("main checkout");
  t.mockInput.pressEnter(); // leave the input; the filter stays
  await frame();
  t.mockInput.pressKey("o");
  await frame();
  expect(opened).toEqual(["https://github.com/acme/web/pull/1", "https://github.com/acme/web/pull/1"]);
  t.mockInput.pressEscape(); // clears the filter
  ff = await frame();
  expect(ff).toContain("main checkout");

  t.mockInput.pressEscape();
  expect(await frame()).toContain("Watched PRs");
  t.renderer.destroy();
});

test("TUI repos view scrolls inside its box and keeps the footer visible", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roots-")));
  const origins: Record<string, string> = {};
  for (let i = 0; i < 30; i++) {
    const dir = join(root, `repo-${String(i).padStart(2, "0")}`);
    mkdirSync(join(dir, ".git"), { recursive: true });
    origins[dir] = `git@github.com:acme/repo-${String(i).padStart(2, "0")}.git`;
  }
  const t0 = makeDaemon({ exec: fakeGit(origins) });
  const cfg = defaultConfig();
  cfg.newWatch.repoRoots = [root];
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };

  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 120, height: 24 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey("g");
  let f = await frame();
  const lines = f.split("\n");
  expect(lines.findIndex((l) => l.includes("esc back"))).toBeGreaterThan(lines.findIndex((l) => l.includes("acme/repo-00")));
  expect(f).toContain("o open PR or ticket");
  expect(f).not.toContain("acme/repo-29");

  for (let i = 0; i < 29; i++) t.mockInput.pressArrow("down");
  f = await frame();
  expect(f).toContain("acme/repo-29");
  expect(f).not.toContain("acme/repo-00");
  expect(f).toContain("o open PR or ticket");
  t.renderer.destroy();
});

test("TUI repos view rescans with r, keeps the selection, and explains empty roots", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "roots-")));
  const web = join(root, "web");
  mkdirSync(join(web, ".git"), { recursive: true });
  const main = `worktree ${web}\nHEAD aaaa\nbranch refs/heads/main\n\n`;
  const worktrees: Record<string, string> = { [web]: `${main}worktree ${root}/wt-b\nHEAD bbbb\nbranch refs/heads/b\n\n` };
  const t0 = makeDaemon({ exec: fakeGit({ [web]: "git@github.com:acme/web.git" }, worktrees) });
  const cfg = defaultConfig();
  cfg.newWatch.repoRoots = [root];
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };

  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 140, height: 30 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  const selectedLine = () => {
    const spans = t.captureSpans();
    return spans.lines.findIndex((l) => l.spans.some((sp) => sp.bg && rgbToHex(sp.bg) === DEFAULT_THEME.selectionBackground.toLowerCase()));
  };
  await frame();
  t.mockInput.pressKey("g");
  await frame();
  t.mockInput.pressArrow("down"); // select worktree b
  let f = await frame();
  expect(f).toContain("2 worktrees");
  const lineOfB = f.split("\n").findIndex((l) => l.includes("wt-b"));
  expect(lineOfB).toBeGreaterThan(0);
  expect(selectedLine()).toBe(lineOfB);

  // A worktree created before b in git's order; the selection follows b, not the index.
  worktrees[web] = `${main}worktree ${root}/wt-a\nHEAD cccc\nbranch refs/heads/a\n\nworktree ${root}/wt-b\nHEAD bbbb\nbranch refs/heads/b\n\n`;
  t.mockInput.pressKey("r");
  f = await frame();
  expect(f).toContain("3 worktrees");
  expect(selectedLine()).toBe(f.split("\n").findIndex((l) => l.includes("wt-b")));
  expect(f.split("\n").findIndex((l) => l.includes("wt-b"))).toBeGreaterThan(lineOfB);

  cfg.newWatch.repoRoots = [join(root, "missing")];
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  t.mockInput.pressKey("r");
  expect(await frame()).toContain("No git repositories found two levels under");
  t.renderer.destroy();
});

test("TUI repos view needs the daemon", async () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "tui-")));
  ensureHome(paths);
  const t = await testRender(() => <App paths={paths} autoStart={false} />, { width: 120, height: 30 });
  await Bun.sleep(300);
  t.mockInput.pressKey("g");
  await Bun.sleep(50);
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("Start the daemon first (S)");
  t.renderer.destroy();
});

test("TUI footer keeps ? help visible, truncates the rest, and ? lists every shortcut", async () => {
  const t0 = makeDaemon();
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 80, height: 30 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  const footer = (f: string) => f.split("\n").filter((l) => l.trim()).at(-1)!;
  let f = await frame();
  expect(footer(f)).toMatch(/…\s+\? help\s*$/);
  expect(footer(f)).not.toContain("q quit");

  t.mockInput.pressKey("?");
  f = await frame();
  expect(f).toContain("Shortcuts · Watched PRs");
  expect(f).toContain("watch a PR");
  expect(f).toContain("reload config");
  expect(f).toContain("quit (works everywhere)");
  t.mockInput.pressKey("s"); // ignored while the dialog is open
  f = await frame();
  expect(f).toContain("Shortcuts · Watched PRs");
  t.mockInput.pressEscape();
  f = await frame();
  expect(f).not.toContain("Shortcuts ·");
  expect(f).not.toContain("Settings ·");

  // `?` opens help while the filter input has focus, and isn't typed into it.
  t.mockInput.pressKey("/");
  await frame();
  await t.mockInput.typeText("?");
  f = await frame();
  expect(f).toContain("Shortcuts · Watched PRs · filter");
  expect(f).toContain("to filter by repo or title");
  t.mockInput.pressKey("?");
  f = await frame();
  expect(f).not.toContain("Shortcuts ·");
  expect(f).not.toMatch(/^\s*\/ \?/m);
  t.renderer.destroy();
});

test("TUI shortcuts dialog filters with / and leaves a filter underneath focused", async () => {
  const t0 = makeDaemon();
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 120, height: 30 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  await frame();
  t.mockInput.pressKey("?");
  await frame();
  t.mockInput.pressKey("/");
  await frame();
  await t.mockInput.typeText("watch");
  let f = await frame();
  expect(f).toContain("/ watch");
  expect(f).toContain("watch a PR");
  expect(f).not.toContain("reload config");
  expect(f).not.toContain("quit (works everywhere)");

  t.mockInput.pressBackspace();
  await t.mockInput.typeText("x"); // "watcx" matches nothing; q and s are typed, not acted on
  f = await frame();
  expect(f).toContain('No shortcuts match "watcx"');
  t.mockInput.pressEnter(); // stop typing, keep the filter
  await frame();
  t.mockInput.pressEscape(); // clear the filter
  f = await frame();
  expect(f).toContain("Shortcuts · Watched PRs");
  expect(f).toContain("reload config");
  t.mockInput.pressEscape(); // close
  f = await frame();
  expect(f).not.toContain("Shortcuts ·");

  // Open help over the PR filter input, filter in the dialog, close it: typing still reaches the PR filter.
  t.mockInput.pressKey("/");
  await frame();
  await t.mockInput.typeText("ab");
  t.mockInput.pressKey("?");
  await frame();
  t.mockInput.pressKey("/");
  await t.mockInput.typeText("zz");
  expect(await frame()).toContain("/ zz");
  t.mockInput.pressEscape(); // clear the dialog filter
  await frame();
  t.mockInput.pressEscape(); // close the dialog
  await frame();
  await t.mockInput.typeText("c");
  f = await frame();
  expect(f).not.toContain("Shortcuts ·");
  expect(f).toMatch(/\/ abc/);
  t.renderer.destroy();
});

test("TUI ? works on every screen: settings, a value being edited, a pending confirmation, and next to a message", async () => {
  const t0 = makeDaemon();
  t0.gh.add(parsePrRef("acme/web#1"), { title: "Fix login redirect" });
  await t0.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s", cwd: t0.paths.home });
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 120, height: 30 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  const footer = (f: string) => f.split("\n").filter((l) => l.trim()).at(-1)!;
  await frame();

  // A pending unwatch is cancelled by ?, and the PR stays watched.
  t.mockInput.pressKey("d");
  expect(footer(await frame())).toMatch(/Unwatch github\.com\/acme\/web#1\?.*\? help\s*$/);
  t.mockInput.pressKey("?");
  expect(await frame()).toContain("Shortcuts · Watched PRs");
  t.mockInput.pressEscape();
  let f = await frame();
  expect(footer(f)).not.toContain("Unwatch");
  expect(t0.store.getPr("github.com/acme/web#1")).not.toBeNull();

  // Settings has its own list.
  t.mockInput.pressKey("s");
  await frame();
  t.mockInput.pressKey("?");
  f = await frame();
  expect(f).toContain("Shortcuts · Settings");
  expect(f).toContain("edit template");
  t.mockInput.pressEscape();
  await frame();

  // Saving shows "Saved" with ? help still at the right.
  t.mockInput.pressEnter(); // cycles the multiplexer
  expect(footer(await frame())).toMatch(/Saved\s+\? help\s*$/);

  // While a value is being edited, ? opens help instead of being typed.
  t.mockInput.pressKey("/");
  await frame();
  await t.mockInput.typeText("session name");
  t.mockInput.pressEnter();
  await frame();
  t.mockInput.pressEnter(); // edit the value
  await frame();
  t.mockInput.pressKey("?");
  f = await frame();
  expect(f).toContain("Shortcuts · Editing a value");
  t.mockInput.pressEscape(); // close help
  await frame();
  t.mockInput.pressEnter(); // save the untouched value
  await frame();
  const r = loadConfig(t0.paths.config);
  expect(r.ok && r.config.spawn.sessionName).toBe("sentinel");
  t.renderer.destroy();
});

test("TUI shortcuts dialog is titled for the repos view", async () => {
  const t0 = makeDaemon();
  const cfg = defaultConfig();
  cfg.newWatch.repoRoots = [join(t0.paths.home, "missing")];
  saveConfig(t0.paths.config, cfg);
  t0.daemon.reload();
  const client: RpcClient = { call: (m, p) => t0.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={t0.paths} autoStart={false} client={client} />, { width: 120, height: 30 });
  await Bun.sleep(100);
  t.mockInput.pressKey("g");
  await Bun.sleep(100);
  t.mockInput.pressKey("?");
  await Bun.sleep(100);
  await t.renderOnce();
  const f = t.captureCharFrame();
  expect(f).toContain("Shortcuts · Repos");
  expect(f).toContain("open PR or ticket");
  expect(f).toContain("rescan");
  t.renderer.destroy();
});

test("TUI shows open human comments, their drafts, copies the reply and marks one resolved", async () => {
  const d = makeDaemon();
  const ref = parsePrRef("acme/web#1");
  d.gh.add(ref);
  d.gh.comment(ref, { id: 100, user: { login: "alice", type: "User" }, body: "Why not reuse the helper?", html_url: "https://github.com/acme/web/pull/1#issuecomment-100" });
  d.gh.comment(ref, { id: 101, user: { login: "bob", type: "User" }, body: "Typo in the name" });
  await d.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });
  await d.daemon.handle("draft", { pr: "acme/web#1", item: "issue:100", summary: "Reuse the helper", change: "Switched to it in abc123", reply: "Good call, done in abc123." });

  const copied: string[] = [];
  const opened: string[] = [];
  const client: RpcClient = { call: (m, p) => d.daemon.handle(m, p) };
  const t = await testRender(
    () => <App paths={d.paths} autoStart={false} client={client} copy={(s) => copied.push(s)} openUrl={(u) => opened.push(u)} />,
    { width: 140, height: 40 },
  );
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  let f = await frame();
  expect(f).toContain("2 human comment(s) need you");
  expect(f).toContain("2 open");

  t.mockInput.pressEnter();
  f = await frame();
  expect(f).toContain("Human comments · 2 open");
  expect(f).toContain("draft ready");
  expect(f).toContain("needs you");
  expect(f).toContain("About:  Reuse the helper");
  expect(f).toContain("Good call, done in abc123.");

  t.mockInput.pressKey("y");
  t.mockInput.pressKey("o");
  await frame();
  expect(copied).toEqual(["Good call, done in abc123."]);
  expect(opened).toEqual(["https://github.com/acme/web/pull/1#issuecomment-100"]);

  t.mockInput.pressKey("x");
  f = await frame();
  expect(f).toContain("Human comments · 1 open");
  expect(f).toContain("✓ resolved");
  expect(d.store.getHumanComment("github.com/acme/web#1", "issue:100")!.resolved_at).not.toBeNull();

  t.mockInput.pressEscape();
  f = await frame();
  expect(f).toContain("1 human comment(s) need you");
  t.renderer.destroy();
});

test("TUI won't reopen a thread resolved on GitHub, and says when there's no reply to copy", async () => {
  const d = makeDaemon();
  const ref = parsePrRef("acme/web#1");
  d.gh.add(ref);
  d.gh.comment(ref, { id: 200, user: { login: "bob", type: "User" }, body: "rename", path: "a.ts", line: 3 }, "inline");
  d.gh.thread(ref, [200], true);
  await d.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });

  const copied: string[] = [];
  const client: RpcClient = { call: (m, p) => d.daemon.handle(m, p) };
  const t = await testRender(() => <App paths={d.paths} autoStart={false} client={client} copy={(s) => copied.push(s)} />, { width: 140, height: 40 });
  const frame = async () => {
    await Bun.sleep(100);
    await t.renderOnce();
    return t.captureCharFrame();
  };
  expect(await frame()).not.toContain("need you");
  t.mockInput.pressEnter();
  let f = await frame();
  expect(f).toContain("Human comments · 0 open");
  expect(f).toContain("✓ resolved");
  expect(f).toContain("a.ts:3");

  t.mockInput.pressKey("x");
  f = await frame();
  expect(f).toContain("resolved on GitHub; unresolve it there");
  expect(d.store.getHumanComment("github.com/acme/web#1", "inline:200")!.resolved_at).toBeNull();

  t.mockInput.pressKey("y");
  f = await frame();
  expect(f).toContain("No reply drafted yet");
  expect(copied).toEqual([]);
  t.renderer.destroy();
});
