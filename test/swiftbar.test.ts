import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "../src/cli/completion.ts";
import type { SessionRow } from "../src/core/types.ts";
import type { PrListEntry, StatusInfo, TicketListEntry } from "../src/daemon/protocol.ts";
import { actionParams, menuText, needsAttention, renderMenu } from "../src/swiftbar/menu.ts";
import { DEFAULT_PLUGIN_NAME, installPlugin, pluginScript, resolvePluginPath } from "../src/swiftbar/plugin.ts";
import { parsePrRef } from "../src/core/pr-ref.ts";
import { makeDaemon } from "./fakes.ts";
import { Client } from "../src/cli/client.ts";
import { getPaths } from "../src/core/paths.ts";
import { runSwiftbar } from "../src/swiftbar/cli.ts";

const NOW = 10_000_000;
const PLUGIN = "/Users/me/swiftbar-plugins/sentinel.30s.sh";

const status = (over: Partial<StatusInfo> = {}): StatusInfo => ({
  pid: 1,
  startedAt: NOW - 3_600_000,
  home: "/h",
  multiplexer: "rex",
  pollIntervalSec: 300,
  nextPollAt: NOW + 120_000,
  pollInProgress: false,
  manualRefreshReadyAt: null,
  prs: 1,
  configError: null,
  jira: { enabled: true, label: "agent", pollIntervalSec: 300, nextPollAt: null, tickets: 1, error: null },
  ...over,
});

const session = (over: Partial<SessionRow> = {}): SessionRow =>
  ({ session_id: "s1", agent: "claude", cwd: "/w/web-fix", state: "busy", paused: 0, agent_running: 1, started: 1, ...over }) as SessionRow;

const pr = (over: Partial<PrListEntry> = {}): PrListEntry =>
  ({
    id: "github.com/acme/web#12",
    url: "https://github.com/acme/web/pull/12",
    title: "Fix login",
    session_id: "s1",
    agent: "claude",
    cwd: "/w/web-fix",
    registered_at: 1,
    last_status: "fix_running",
    last_reason: null,
    humanOpen: 0,
    session: session(),
    ...over,
  }) as PrListEntry;

const ticket = (over: Partial<TicketListEntry> = {}): TicketListEntry =>
  ({
    key: "CP-7",
    url: "https://jira.example/browse/CP-7",
    summary: "Login is slow",
    session_id: "s1",
    cwd: "/w/web-fix",
    picked_at: 1,
    last_status: "in_review",
    last_reason: null,
    session: session(),
    ...over,
  }) as TicketListEntry;

const render = (over: Partial<Parameters<typeof renderMenu>[0]> = {}) =>
  renderMenu({ status: status(), prs: [pr()], tickets: [ticket()], plugin: PLUGIN, now: NOW, ...over }).split("\n");

describe("swiftbar menu", () => {
  test("lists each session under its repo with clickable PR and ticket links", () => {
    const lines = render();
    expect(lines[0]).toBe("1/1 | sfimage=eye");
    expect(lines).toContain("Sentinel · 1 session · 1 busy · next poll in 2m | size=12 color=gray");
    const repo = lines.indexOf("acme/web | size=12 color=gray emojize=false symbolize=false");
    expect(repo).toBeGreaterThan(0);
    expect(lines[repo + 1]).toStartWith(`web-fix · claude · busy | sfimage=terminal tooltip="s1 · /w/web-fix" ${actionParams(PLUGIN, ["go", "s1"])}`);
    expect(lines[repo + 2]).toStartWith('    #12 - Fix login · fix running | href="https://github.com/acme/web/pull/12" sfimage=circle.fill sfcolor=#f1c40f');
    expect(lines[repo + 3]).toStartWith('    CP-7 - Login is slow · in review | href="https://jira.example/browse/CP-7"');
    expect(lines[repo + 2]).toContain("trim=false");
  });

  test("menu actions rerun the plugin in the background and refresh the menu", () => {
    expect(actionParams(PLUGIN, ["go", "s1"])).toBe(`bash="${PLUGIN}" param1="go" param2="s1" terminal=false refresh=true`);
    const lines = render();
    expect(lines).toContain(`Refresh now | sfimage=arrow.clockwise ${actionParams(PLUGIN, ["refresh"])}`);
    expect(lines).toContain(`Open dashboard | sfimage=rectangle.on.rectangle ${actionParams(PLUGIN, ["dashboard"])}`);
    expect(lines).toContain(`Edit settings | sfimage=gearshape ${actionParams(PLUGIN, ["settings"])}`);
  });

  test("shows the refresh cooldown and a running poll as disabled items", () => {
    expect(render({ status: status({ manualRefreshReadyAt: NOW + 12_400 }) })).toContain("Refresh — available in 13s | sfimage=arrow.clockwise color=gray");
    expect(render({ status: status({ manualRefreshReadyAt: NOW - 1 }) }).some((l) => l.startsWith("Refresh now"))).toBe(true);
    expect(render({ status: status({ pollInProgress: true }) })).toContain("Refresh — a poll is in progress | sfimage=arrow.clockwise color=gray");
  });

  test("a session that hasn't started can't be opened", () => {
    const s = session({ started: 0, state: "idle" });
    const line = render({ prs: [pr({ session: s })], tickets: [] }).find((l) => l.startsWith("web-fix"))!;
    expect(line).toContain("not started yet");
    expect(line).not.toContain("bash=");
  });

  test("keeps untrusted titles from breaking the line or rendering emoji", () => {
    expect(menuText("a | b\nc")).toBe("a ¦ b c");
    const lines = render({ prs: [pr({ title: 'Ship :rocket: | "now"', last_reason: "x\ny" })], tickets: [] });
    const line = lines.find((l) => l.includes("#12"))!;
    expect(line).toStartWith("    #12 - Ship :rocket: ¦ \"now\" · fix running | ");
    expect(line).toContain(`tooltip="#12 - Ship :rocket: ¦ 'now' — x y"`);
    expect(line).toEndWith("emojize=false symbolize=false");
    expect(line.split(" | ")).toHaveLength(2);
  });

  test("flags failures, open human comments and config errors in the menu bar", () => {
    expect(needsAttention({ status: status(), prs: [pr()], tickets: [ticket()] })).toBe(false);
    expect(needsAttention({ status: status(), prs: [pr({ last_status: "spawn_failed" })], tickets: [] })).toBe(true);
    expect(needsAttention({ status: status(), prs: [pr({ humanOpen: 2 })], tickets: [] })).toBe(true);
    expect(needsAttention({ status: status(), prs: [], tickets: [ticket({ last_status: "transition_failed" })] })).toBe(true);
    expect(needsAttention({ status: status({ configError: "bad" }), prs: [], tickets: [] })).toBe(true);
    const lines = render({ status: status({ configError: "bad | json" }), prs: [pr({ humanOpen: 1 })] });
    expect(lines[0]).toBe("1/1 | sfimage=exclamationmark.triangle");
    expect(lines.some((l) => l.startsWith("Config error: bad ¦ json | color=red"))).toBe(true);
    expect(lines.some((l) => l.includes("· fix running · 1 human comment |"))).toBe(true);
  });

  test("offers to start the daemon when it isn't running", () => {
    const lines = render({ status: null, prs: [], tickets: [] });
    expect(lines[0]).toBe(" | sfimage=eye.slash");
    expect(lines).toContain(`Start daemon | sfimage=play.fill ${actionParams(PLUGIN, ["start"])}`);
  });

  test("says when there are no sessions", () => {
    const lines = render({ prs: [], tickets: [] });
    expect(lines[0]).toBe("0 | sfimage=eye");
    expect(lines).toContain("No agent sessions yet | color=gray");
  });
});

describe("swiftbar plugin install", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "swiftbar-test-"));
  const opts = { self: ["/opt/bun", "/src/it's/main.ts"], path: "/usr/bin:/opt/bin" };

  test("the script prints the menu with no arguments and passes actions to `sentinel swiftbar`", () => {
    const s = pluginScript({ ...opts, sentinelHome: "/h" });
    expect(s).toStartWith("#!/bin/bash\n");
    expect(s).toContain("export PATH='/usr/bin:/opt/bin'");
    expect(s).toContain("export SENTINEL_HOME='/h'");
    expect(s).toContain(`SENTINEL=('/opt/bun' '/src/it'\\''s/main.ts')`);
    expect(s).toContain('exec "${SENTINEL[@]}" swiftbar "$@"');
    expect(s).toContain('exec "${SENTINEL[@]}" swiftbar menu --plugin "$0"');
    expect(pluginScript(opts)).not.toContain("SENTINEL_HOME");
  });

  test("a directory gets sentinel.30s.sh; a file must be a .sh in an existing directory", () => {
    const d = dir();
    expect(resolvePluginPath(d)).toBe(join(d, DEFAULT_PLUGIN_NAME));
    expect(resolvePluginPath("x.1m.sh", d)).toBe(join(d, "x.1m.sh"));
    expect(() => resolvePluginPath(join(d, "plugin.txt"))).toThrow("not a directory or a .sh file");
    expect(() => resolvePluginPath(join(d, "missing", "p.sh"))).toThrow("does not exist");
  });

  test("writes an executable plugin, updates its own file, and refuses someone else's without --force", () => {
    const d = dir();
    const file = join(d, DEFAULT_PLUGIN_NAME);
    expect(installPlugin(file, opts)).toBe("installed");
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(installPlugin(file, opts)).toBe("updated");

    const other = join(d, "other.sh");
    writeFileSync(other, "#!/bin/bash\necho hi\n");
    expect(() => installPlugin(other, opts)).toThrow("wasn't written by Sentinel");
    expect(readFileSync(other, "utf8")).toBe("#!/bin/bash\necho hi\n");
    expect(installPlugin(other, { ...opts, force: true })).toBe("updated");

    mkdirSync(join(d, 'a"b'));
    expect(() => installPlugin(join(d, 'a"b', "p.sh"), opts)).toThrow("double quote");
    expect(existsSync(join(d, 'a"b', "p.sh"))).toBe(false);
  });

  test("completes the install subcommand and directories", async () => {
    const source = { watchedPrs: async () => [], ticketKeys: async () => [] };
    expect((await complete(["swiftbar", ""], source)).items).toEqual(["install"]);
    expect(await complete(["swiftbar", "install", ""], source)).toEqual({ items: [], dirs: true });
    expect((await complete(["swiftbar", "install", "--f"], source)).items).toEqual(["--force"]);
    expect((await complete(["swiftbar", "--f"], source)).items).toEqual([]);
    expect((await complete(["notify", ""], source)).items).toEqual(["test"]);
  });

  test("`swiftbar menu` shows the offline menu when the daemon isn't answering", async () => {
    const paths = getPaths(dir());
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    try {
      await runSwiftbar(["menu", "--plugin", PLUGIN], paths, new Client(join(paths.home, "missing.sock")));
    } finally {
      console.log = log;
    }
    expect(out.join("\n")).toContain(`Start daemon | sfimage=play.fill ${actionParams(PLUGIN, ["start"])}`);
  });
});

describe("open tool", () => {
  test("opens the dashboard in a new focused tab of the home session", async () => {
    const d = makeDaemon();
    const r = await d.daemon.handle("openTool", { tool: "dashboard" });
    const pane = d.mux.panes.get(r.paneId)!;
    expect(pane.opts).toMatchObject({ ownTab: true, focus: true, label: "sentinel-dashboard", homeName: "sentinel" });
    expect(pane.lines).toHaveLength(1);
    expect(pane.lines[0]).toStartWith(`SENTINEL_HOME='${d.paths.home}' `);
    expect(pane.lines[0]).toEndWith(" tui");
    expect(d.mux.focused.map((f) => f.paneId)).toEqual([r.paneId]);
  });

  test("opens config.json in the user's editor, then reloads it", async () => {
    const d = makeDaemon();
    const r = await d.daemon.handle("openTool", { tool: "settings" });
    const line = d.mux.panes.get(r.paneId)!.lines[0]!;
    expect(line).toStartWith(`"\${VISUAL:-\${EDITOR:-vi}}" '${d.paths.config}' && SENTINEL_HOME='${d.paths.home}' `);
    expect(line).toEndWith(" reload");
  });

  test("reuses the home session and reports an unreachable multiplexer", async () => {
    const d = makeDaemon();
    d.gh.add(parsePrRef("acme/web#1"));
    await d.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: "s1", cwd: "/r" });
    await d.daemon.handle("goToAgent", { sessionId: "s1" });
    const r = await d.daemon.handle("openTool", { tool: "dashboard" });
    expect(d.mux.panes.get(r.paneId)!.opts.homeId).toBe("session:home");
    d.mux.available = false;
    await expect(d.daemon.handle("openTool", { tool: "settings" })).rejects.toThrow("rex down");
  });
});
