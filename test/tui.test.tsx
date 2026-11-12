import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaths, ensureHome } from "../src/core/paths.ts";
import { loadConfig } from "../src/core/config.ts";
import { App } from "../src/tui/app.tsx";

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
