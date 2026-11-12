import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, parseConfig, saveConfig } from "../src/core/config.ts";
import { parsePrRef, prId } from "../src/core/pr-ref.ts";
import { detectAgent, hookSessionId } from "../src/cli/detect.ts";
import { prGroup, prLabel, prLine, sortByGroup } from "../src/cli/format.ts";
import { DaemonUnavailableError, type Client } from "../src/cli/client.ts";
import { stopDaemon } from "../src/cli/daemon-control.ts";
import { evaluatorArgs, scrubbedAgentEnv } from "../src/evaluator/evaluator.ts";
import { renderFixPrompt, rexNamingNote } from "../src/evaluator/prompt.ts";
import { newItems, normalize } from "../src/github/snapshot.ts";
import { claudeHookSettings, launchCommand, sq } from "../src/spawn/launcher.ts";
import { getPaths } from "../src/core/paths.ts";
import { cycleEnum, FIELDS, filterFields, parseValue } from "../src/tui/settings.ts";
import { fakeGit } from "./fakes.ts";
import type { Exec } from "../src/core/exec.ts";
import { Store } from "../src/core/db.ts";
import { RexMux } from "../src/mux/rex.ts";
import type { CreatePaneOptions } from "../src/mux/mux.ts";
import { GhCli } from "../src/github/gh.ts";
import { normalizeRemote, RepoLocator } from "../src/core/repo-locate.ts";
import type { MyPr } from "../src/daemon/protocol.ts";
import { filterPrs, filterWatched } from "../src/tui/pr-filter.ts";

describe("pr-ref", () => {
  test("parses URLs and short forms", () => {
    expect(prId(parsePrRef("https://github.com/acme/web/pull/42"))).toBe("github.com/acme/web#42");
    expect(prId(parsePrRef("https://github.com/acme/web/pull/42/files?x=1"))).toBe("github.com/acme/web#42");
    expect(prId(parsePrRef("acme/web#7"))).toBe("github.com/acme/web#7");
    expect(prId(parsePrRef("ghe.corp.io/acme/web#7"))).toBe("ghe.corp.io/acme/web#7");
    expect(prId(parsePrRef("https://GHE.corp.io/a/b/pull/1"))).toBe("ghe.corp.io/a/b#1");
  });
  test("rejects garbage", () => {
    expect(() => parsePrRef("not a pr")).toThrow();
    expect(() => parsePrRef("acme/web/42")).toThrow();
  });
});

describe("config", () => {
  test("defaults", () => {
    const c = defaultConfig();
    expect(c.multiplexer).toBe("rex");
    expect(c.pollIntervalSec).toBe(300);
    expect(c.evaluator.model).toBe("sonnet");
    expect(c.evaluator.maxBudgetUsd).toBe(0);
    expect(c.spawn.layout).toBe("sentinel-tab");
    expect(c.spawn.maxPanesPerTab).toBe(4);
    expect(c.spawn.maxConcurrent).toBe(0);
    expect(c.spawn.busyTimeoutMin).toBe(60);
    expect(c.agents.claude.args).toEqual([]);
  });
  test("partial config is filled with defaults", () => {
    const r = parseConfig(JSON.stringify({ multiplexer: "herdr", spawn: { maxPanesPerTab: 2 } }));
    expect(r.ok && r.config.multiplexer).toBe("herdr");
    expect(r.ok && r.config.spawn.maxPanesPerTab).toBe(2);
    expect(r.ok && r.config.spawn.busyTimeoutMin).toBe(60);
  });
  test("invalid JSON and invalid values are reported", () => {
    expect(parseConfig("{nope").ok).toBe(false);
    expect(parseConfig(JSON.stringify({ multiplexer: "tmux" })).ok).toBe(false);
  });
  test("load creates file; save round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    expect(loadConfig(p).ok).toBe(true);
    const c = defaultConfig();
    c.pollIntervalSec = 60;
    saveConfig(p, c);
    const r = loadConfig(p);
    expect(r.ok && r.config.pollIntervalSec).toBe(60);
    writeFileSync(p, "{bad");
    expect(loadConfig(p).ok).toBe(false);
  });
});

describe("snapshot", () => {
  const activity = {
    view: {
      state: "OPEN" as const,
      title: "t",
      body: "b",
      headRefOid: "abc",
      statusCheckRollup: [
        { __typename: "CheckRun" as const, name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/a/b/actions/runs/99/job/1" },
        { __typename: "CheckRun" as const, name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u2" },
        { __typename: "CheckRun" as const, name: "slow", status: "IN_PROGRESS", conclusion: null },
        { __typename: "StatusContext" as const, context: "ci/legacy", state: "ERROR", targetUrl: "u3" },
      ],
    },
    inlineComments: [{ id: 1, user: { login: "coderabbitai[bot]", type: "Bot" }, body: "fix", path: "a.ts", line: 3 }],
    conversationComments: [{ id: 2, user: { login: "Me", type: "User" }, body: "self" }],
    reviews: [
      { id: 3, user: { login: "bob", type: "User" }, body: "", state: "COMMENTED" },
      { id: 4, user: { login: "bob", type: "User" }, body: "changes pls", state: "CHANGES_REQUESTED" },
    ],
  };
  const opts = { ignoredAuthors: new Set(["me"]), failingConclusions: new Set(["FAILURE", "ERROR"]) };

  test("normalizes and filters", () => {
    const items = normalize(activity);
    const fresh = newItems(items, new Set(), opts);
    const ids = fresh.map((i) => i.id);
    expect(ids).toContain("inline:1");
    expect(ids).toContain("review:4");
    expect(ids).not.toContain("review:3"); // empty body
    expect(ids).not.toContain("issue:2"); // ignored author, case-insensitive
    expect(ids).toContain("check:CI / test:https://github.com/a/b/actions/runs/99/job/1");
    expect(ids).toContain("status:ci/legacy:abc");
    expect(ids.some((i) => i.includes("lint") || i.includes("slow"))).toBe(false);
    expect(fresh.find((i) => i.kind === "check" && i.checkName === "CI / test")?.runId).toBe("99");
  });
  test("seen items are excluded", () => {
    const items = normalize(activity);
    expect(newItems(items, new Set(items.map((i) => i.id)), opts)).toEqual([]);
  });
});

describe("launcher", () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "launch-")));
  test("shell quoting", () => {
    expect(sq("it's")).toBe(`'it'\\''s'`);
  });
  test("claude launch command", () => {
    const cfg = defaultConfig();
    cfg.agents.claude.args = ["--permission-mode", "acceptEdits"];
    const cmd = launchCommand({ agent: "claude", sessionId: "s-1", cwd: "/w/my repo", promptFile: "/p/f.md" }, cfg, paths, ["/bin/sentinel"]);
    expect(cmd).toStartWith(`cd '/w/my repo' && 'claude' --resume 's-1' --settings `);
    expect(cmd).toContain(`'--permission-mode' 'acceptEdits'`);
    expect(cmd).toEndWith(`"$(cat '/p/f.md')"`);
  });
  test("codex launch command", () => {
    const cmd = launchCommand({ agent: "codex", sessionId: "t-1", cwd: "/w", promptFile: "/p/f.md" }, defaultConfig(), paths, ["/bin/sentinel"]);
    expect(cmd).toStartWith(`cd '/w' && 'codex' resume '-c' `);
    expect(cmd).toContain(`'t-1' "$(cat '/p/f.md')"`);
  });
  test("claude hook settings", () => {
    const s = claudeHookSettings(["/bin/sentinel"]);
    expect(s.hooks.Stop[0]!.hooks[0]!.command).toBe("'/bin/sentinel' hook idle");
    expect(s.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe("'/bin/sentinel' hook busy");
    expect(s.hooks.SessionEnd[0]!.hooks[0]!.command).toBe("'/bin/sentinel' hook exit");
  });
});

describe("evaluator args", () => {
  test("budget flag only when > 0", () => {
    expect(evaluatorArgs({ model: "sonnet", maxBudgetUsd: 0, cwd: "/" })).not.toContain("--max-budget-usd");
    const a = evaluatorArgs({ model: "sonnet", maxBudgetUsd: 0.1, cwd: "/" });
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.1");
    expect(a).toContain("--no-session-persistence");
  });
  test("scrubs inherited agent env but keeps auth", () => {
    const out = scrubbedAgentEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/bin" });
    expect(Object.keys(out).sort()).toEqual(["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"]);
  });
});

describe("prompt", () => {
  test("fix template renders per PR", () => {
    const text = renderFixPrompt("PR {{prUrl}} because {{reason}}\n{{items}}", [
      { prUrl: "https://x/1", reason: "r1", items: [{ id: "issue:1", kind: "conversation_comment", author: "bot[bot]", authorType: "Bot", body: "hello" }] },
      { prUrl: "https://x/2", reason: "r2", items: [{ id: "check:a", kind: "check", checkName: "a", conclusion: "FAILURE" }] },
    ]);
    expect(text).toContain("PR https://x/1 because r1");
    expect(text).toContain("user.login=bot[bot] user.type=Bot (bot)");
    expect(text).toContain("PR https://x/2 because r2");
    expect(text).toContain("Failed check: a (FAILURE)");
  });
});

describe("detect", () => {
  test("claude / codex / none", () => {
    expect(detectAgent({ CLAUDE_CODE_SESSION_ID: "c1" }, "/w")).toEqual({ agent: "claude", sessionId: "c1", cwd: "/w" });
    expect(detectAgent({ CODEX_THREAD_ID: "x1" }, "/w")).toEqual({ agent: "codex", sessionId: "x1", cwd: "/w" });
    expect(detectAgent({}, "/w")).toEqual({ cwd: "/w" });
  });
  test("hook session id", () => {
    expect(hookSessionId('{"session_id":"abc"}', {})).toBe("abc");
    expect(hookSessionId("", { CODEX_THREAD_ID: "t" })).toBe("t");
  });
});

describe("tui settings", () => {
  test("parse and cycle", () => {
    const interval = FIELDS.find((f) => f.key === "pollIntervalSec")!;
    expect(parseValue(interval, "60")).toBe(60);
    expect(() => parseValue(interval, "1.5")).toThrow();
    const authors = FIELDS.find((f) => f.key === "ignoredAuthors")!;
    expect(parseValue(authors, "@me, bot ,")).toEqual(["@me", "bot"]);
    const mux = FIELDS.find((f) => f.key === "multiplexer")!;
    expect(cycleEnum(mux, defaultConfig())).toBe("herdr");
  });
});

describe("new sessions", () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), "launch-")));
  const self = ["/bin/sentinel"];
  test("claude starts a new session with --session-id and passes model/effort", () => {
    const cmd = launchCommand(
      { agent: "claude", sessionId: "u-1", cwd: "/w", promptFile: "/p/f.md", newSession: true, model: "opus", effort: "high" },
      defaultConfig(),
      paths,
      self,
    );
    expect(cmd).toContain(`--session-id 'u-1'`);
    expect(cmd).not.toContain("--resume");
    expect(cmd).toContain(`'--model' 'opus' '--effort' 'high'`);
  });
  test("resume keeps model/effort; default omits the flags", () => {
    const base = { agent: "claude" as const, sessionId: "u-1", cwd: "/w", promptFile: "/p/f.md" };
    expect(launchCommand({ ...base, model: "sonnet", effort: "low" }, defaultConfig(), paths, self)).toContain(
      `--resume 'u-1' --settings`,
    );
    const dflt = launchCommand({ ...base, model: "default", effort: null }, defaultConfig(), paths, self);
    expect(dflt).not.toContain("--model");
    expect(dflt).not.toContain("--effort");
  });
  test("codex maps model/effort and refuses new sessions", () => {
    const base = { agent: "codex" as const, sessionId: "t-1", cwd: "/w", promptFile: "/p/f.md" };
    expect(launchCommand({ ...base, model: "gpt-5", effort: "high" }, defaultConfig(), paths, self)).toContain(
      `'-m' 'gpt-5' '-c' 'model_reasoning_effort="high"'`,
    );
    expect(() => launchCommand({ ...base, newSession: true }, defaultConfig(), paths, self)).toThrow("only start new sessions for claude");
  });
});

describe("repo-locate", () => {
  test("normalizes ssh and https remotes", () => {
    expect(normalizeRemote("git@github.com:Acme/Web.git\n")).toBe("github.com/acme/web");
    expect(normalizeRemote("https://github.com/acme/web")).toBe("github.com/acme/web");
    expect(normalizeRemote("https://github.com/acme/web.git/")).toBe("github.com/acme/web");
    expect(normalizeRemote("ssh://git@ghe.corp.io:22/acme/web.git")).toBe("ghe.corp.io/acme/web");
    expect(normalizeRemote("not a url")).toBeNull();
  });

  test("finds a clone two levels deep and prefers one named after the repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "roots-"));
    for (const d of ["org/web", "web-fork", "other"]) mkdirSync(join(root, d, ".git"), { recursive: true });
    const loc = new RepoLocator(
      fakeGit({
        [join(root, "org/web")]: "git@github.com:acme/web.git",
        [join(root, "web-fork")]: "https://github.com/acme/web",
        [join(root, "other")]: "https://github.com/acme/other",
      }),
    );
    const repo = { host: "github.com", owner: "acme", repo: "web" };
    expect(await loc.suggest(repo, [root])).toBe(join(root, "org/web"));
    expect(await loc.suggest({ ...repo, repo: "missing" }, [root])).toBeNull();

    expect((await loc.validate(join(root, "org/web"), repo)).warning).toBeUndefined();
    expect((await loc.validate(join(root, "other"), repo)).warning).toContain("not acme/web");
    expect((await loc.validate(join(root, "nope"), repo)).error).toContain("not a directory");
    mkdirSync(join(root, "plain"));
    expect((await loc.validate(join(root, "plain"), repo)).error).toContain("not a git repository");
  });
});

describe("pr filter", () => {
  const pr = (owner: string, repo: string, number: number, title: string): MyPr => ({
    id: `github.com/${owner}/${repo}#${number}`,
    host: "github.com",
    owner,
    repo,
    number,
    title,
    url: "",
    isDraft: false,
    updatedAt: "",
    watched: false,
  });
  const prs = [pr("acme", "web", 12, "Fix login redirect"), pr("acme", "api", 345, "Add rate limits"), pr("other", "web", 7, "Bump deps")];
  const ids = (q: string) => filterPrs(prs, q).map((p) => p.number);
  test("matches org, repo, number and title tokens", () => {
    expect(ids("")).toEqual([12, 345, 7]);
    expect(ids("acme")).toEqual([12, 345]);
    expect(ids("WEB")).toEqual([12, 7]);
    expect(ids("#345")).toEqual([345]);
    expect(ids("7")).toEqual([7]);
    expect(ids("acme login")).toEqual([12]);
    expect(ids("acme/api")).toEqual([345]);
    expect(ids("nothing")).toEqual([]);
  });
});

describe("settings filter", () => {
  const labels = (q: string) => filterFields(FIELDS, q).map((f) => f.label);
  test("matches label and key words, case-insensitive", () => {
    expect(labels("")).toHaveLength(FIELDS.length);
    expect(labels("busy")).toEqual(["Busy timeout (min)"]);
    expect(labels("NEW WATCH effort")).toEqual(["New watch: default effort", "New watch: effort choices"]);
    expect(labels("spawn.layout")).toEqual(["Spawn layout"]);
    expect(labels("zzz")).toEqual([]);
  });
});

describe("pr label", () => {
  test("[org/repo/n] title, host only for enterprise", () => {
    expect(prLabel({ id: "github.com/acme/web#12", title: "Fix login" })).toBe("[acme/web/12] Fix login");
    expect(prLabel({ id: "github.com/acme/web#12", title: null })).toBe("[acme/web/12]");
    expect(prLabel({ id: "ghe.corp.io/acme/web#3", title: "X" })).toBe("[ghe.corp.io/acme/web/3] X");
  });
});

describe("stopDaemon", () => {
  const fakeClient = (opts: { up: boolean; aliveChecks?: number }) => {
    let left = opts.aliveChecks ?? 0;
    const calls: string[] = [];
    const c = {
      calls,
      async call(method: string) {
        calls.push(method);
        if (!opts.up) throw new DaemonUnavailableError();
        return { ok: true };
      },
      async alive() {
        return left-- > 0;
      },
    };
    return c as unknown as Client & { calls: string[] };
  };
  const home = () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "stop-")));
    mkdirSync(paths.home, { recursive: true });
    return paths;
  };

  test("asks the daemon to stop and waits until it stops answering", async () => {
    const c = fakeClient({ up: true, aliveChecks: 2 });
    expect(await stopDaemon(home(), c)).toBe("stopped");
    expect(c.calls).toEqual(["stop"]);
  });
  test("not running without a pidfile", async () => {
    expect(await stopDaemon(home(), fakeClient({ up: false }))).toBe("not-running");
  });
  test("removes a stale pidfile", async () => {
    const paths = home();
    writeFileSync(paths.pid, "999999");
    expect(await stopDaemon(paths, fakeClient({ up: false }))).toBe("not-running");
    expect(existsSync(paths.pid)).toBe(false);
  });
});

describe("pr grouping", () => {
  test("group heading and line", () => {
    expect(prGroup("github.com/acme/web#12")).toBe("acme/web");
    expect(prGroup("ghe.corp.io/acme/web#12")).toBe("ghe.corp.io/acme/web");
    expect(prLine({ id: "github.com/acme/web#12", title: "Fix login" })).toBe("#12 - Fix login");
  });
  test("groups sort alphabetically (case-insensitive), PRs by number", () => {
    const ids = ["github.com/zeta/web#9", "github.com/acme/api#120", "github.com/Acme/billing#3", "github.com/acme/api#7"];
    expect(sortByGroup(ids.map((id) => ({ id }))).map((p) => p.id)).toEqual([
      "github.com/acme/api#7",
      "github.com/acme/api#120",
      "github.com/Acme/billing#3",
      "github.com/zeta/web#9",
    ]);
  });
});

describe("watched PR filter", () => {
  const prs = [
    { id: "github.com/acme/web#1", title: "Fix login" },
    { id: "github.com/acme/api#2", title: "Rate limits" },
    { id: "github.com/zeta/tools#3", title: null },
  ];
  const ids = (q: string) => filterWatched(prs, q).map((p) => p.id.split("#")[1]);
  test("matches org/repo and title, not the number", () => {
    expect(ids("")).toEqual(["1", "2", "3"]);
    expect(ids("ACME")).toEqual(["1", "2"]);
    expect(ids("acme/api")).toEqual(["2"]);
    expect(ids("acme login")).toEqual(["1"]);
    expect(ids("tools")).toEqual(["3"]);
    expect(ids("3")).toEqual([]);
  });
});

describe("gh listMyPrs", () => {
  test("searches authored (or involved) open PRs and parses the result", async () => {
    const calls: string[][] = [];
    const run: Exec = async (cmd) => {
      calls.push(cmd);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            number: 5,
            title: "Fix",
            url: "https://GHE.corp.io/acme/web/pull/5",
            isDraft: true,
            updatedAt: "2026-01-01T00:00:00Z",
            repository: { name: "web", nameWithOwner: "acme/web" },
          },
        ]),
      };
    };
    const gh = new GhCli(run);
    const [pr] = await gh.listMyPrs({ onlyMine: true });
    expect(pr).toEqual({
      ref: { host: "ghe.corp.io", owner: "acme", repo: "web", number: 5 },
      title: "Fix",
      url: "https://GHE.corp.io/acme/web/pull/5",
      isDraft: true,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(calls[0]!.slice(0, 5)).toEqual(["gh", "search", "prs", "--author=@me", "--state=open"]);
    await gh.listMyPrs({ onlyMine: false });
    expect(calls[1]).toContain("--involves=@me");
  });
});

describe("store migrations", () => {
  test("a database from before new-session watches upgrades in place", () => {
    const file = join(mkdtempSync(join(tmpdir(), "db-")), "sentinel.db");
    const old = new Store(file);
    old.db.exec(`
      ALTER TABLE prs DROP COLUMN title;
      ALTER TABLE sessions DROP COLUMN model;
      ALTER TABLE sessions DROP COLUMN effort;
      ALTER TABLE sessions DROP COLUMN started;
      UPDATE meta SET value = '1' WHERE key = 'schema_version';
      INSERT INTO prs (id, url, agent, session_id, cwd, registered_at) VALUES ('github.com/a/b#1', 'u', 'claude', 's', '/r', 1);
      INSERT INTO sessions (session_id, agent, cwd) VALUES ('s', 'claude', '/r');
    `);
    old.close();
    const store = new Store(file);
    expect(store.getPr("github.com/a/b#1")!.title).toBeNull();
    const s = store.getSession("s")!;
    expect([s.model, s.effort, s.started]).toEqual([null, null, 1]);
    store.close();
  });
});

describe("settings booleans", () => {
  test("shown and cycled as on/off", () => {
    const field = FIELDS.find((f) => f.key === "newWatch.startNow")!;
    const cfg = defaultConfig();
    expect(field.get(cfg)).toBe("on");
    field.set(cfg, cycleEnum(field, cfg));
    expect(cfg.newWatch.startNow).toBe(false);
  });
});

describe("rex mux", () => {
  /** Minimal rex stand-in: sessions hold windows hold blocks; `rename` mimics an agent relabeling its session. */
  function fakeRex() {
    const sessions: { session_id: string; label: string; windows: { window_id: string; blocks: string[] }[] }[] = [];
    let n = 0;
    const calls: string[][] = [];
    const ok = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      const a = cmd.slice(1);
      const arg = (f: string) => a[a.indexOf(f) + 1]!;
      if (a[0] === "ls") return ok({ sessions: sessions.map(({ session_id, label }) => ({ session_id, label })) });
      if (a[0] === "new") {
        const s = { session_id: `session:${++n}`, label: a[1]!, windows: [{ window_id: `window:${++n}`, blocks: [`block:${++n}`] }] };
        sessions.push(s);
        return ok({ session_id: s.session_id, initial_windows: [{ window_id: s.windows[0]!.window_id, block_ids: s.windows[0]!.blocks }] });
      }
      const sess = () => sessions.find((s) => s.session_id === arg("-s"))!;
      if (a[0] === "block" && a[1] === "ls")
        return ok({ blocks: sess().windows.flatMap((w) => w.blocks.map((block_id) => ({ block_id, window_id: w.window_id }))) });
      if (a[0] === "split") {
        const w = sess().windows.find((w) => w.blocks.includes(arg("-b")))!;
        const id = `block:${++n}`;
        w.blocks.push(id);
        return ok({ block_ids: [id, arg("-b")] });
      }
      if (a[0] === "window" && a[1] === "new") {
        const w = { window_id: `window:${++n}`, blocks: [`block:${++n}`] };
        sess().windows.push(w);
        return ok({ window_id: w.window_id, block_ids: w.blocks });
      }
      return ok({});
    };
    return { sessions, calls, exec };
  }

  const opts = (o: Partial<CreatePaneOptions> = {}): CreatePaneOptions => ({
    homeName: "sentinel",
    layout: "sentinel-tab",
    maxPanesPerTab: 4,
    cwd: "/tmp",
    label: "claude:x",
    ...o,
  });

  test("keeps using the home session after an agent renames it", async () => {
    const rex = fakeRex();
    const mux = new RexMux(rex.exec);
    const first = await mux.createPane(opts());
    rex.sessions[0]!.label = "kubb5-msw3-pr";
    const second = await mux.createPane(opts({ homeId: first.homeId }));
    expect(rex.sessions).toHaveLength(1);
    expect(second.homeId).toBe(first.homeId);
    expect(second.tabId).toBe(first.tabId);
  });

  test("falls back to the label when the stored session is gone", async () => {
    const rex = fakeRex();
    const mux = new RexMux(rex.exec);
    const first = await mux.createPane(opts());
    const again = await mux.createPane(opts({ homeId: "session:gone" }));
    expect(rex.sessions).toHaveLength(1);
    expect(again.homeId).toBe(first.homeId);
  });
});

describe("rex naming note", () => {
  test("sentinel-tab forbids renaming the tab; tab-per-session allows it", () => {
    expect(rexNamingNote("sentinel-tab")).toContain("don't rename it either");
    expect(rexNamingNote("sentinel-tab")).not.toContain("rename only your tab");
    expect(rexNamingNote("tab-per-session")).toContain("rename only your tab");
  });
});
