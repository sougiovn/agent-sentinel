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
  const t = await testRender(() => <App paths={paths} />, { width: 120, height: 30 });
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
