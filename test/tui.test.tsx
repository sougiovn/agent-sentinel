import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaths, ensureHome } from "../src/core/paths.ts";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config.ts";
import { parsePrRef } from "../src/core/pr-ref.ts";
import { App, type RpcClient } from "../src/tui/app.tsx";
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
