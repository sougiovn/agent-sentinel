#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import skillText from "../../skills/sentinel/SKILL.md" with { type: "text" };
import { ensureHome, getPaths } from "../core/paths.ts";
import type { AgentKind } from "../core/types.ts";
import type { HookSignal } from "../spawn/launcher.ts";
import { Client, DaemonUnavailableError } from "./client.ts";
import { startDaemon, stopDaemon } from "./daemon-control.ts";
import { detectAgent, hookSessionId } from "./detect.ts";
import { formatList, formatStatus } from "./format.ts";

const HELP = `sentinel — watches PRs for AI agent sessions and resumes them to fix feedback

Usage:
  sentinel                      Open the dashboard (starts the daemon if needed)
  sentinel start                Start the background daemon without the dashboard
  sentinel watch <pr>...        Hand off PRs (agent/session/cwd auto-detected)
      --agent claude|codex  --session <id>  --cwd <dir>  --include-existing
  sentinel unwatch <pr>         Stop watching a PR
  sentinel list [--json]        List watched PRs
  sentinel check [<pr>]         Poll now
  sentinel status [--json]      Daemon status
  sentinel stop                 Stop the daemon
  sentinel restart              Restart the daemon (e.g. after upgrading Sentinel)
  sentinel reload               Reload config.json
  sentinel skill show|install   Print or install the agent skill
  sentinel daemon               Run the daemon in the foreground

PRs: URL or owner/repo#123. Data lives in ~/.config/sentinel (override with SENTINEL_HOME).`;

function die(msg: string, code = 1): never {
  process.stderr.write(`sentinel: ${msg}\n`);
  process.exit(code);
}

async function main(argv: string[]) {
  const paths = getPaths();
  const client = new Client(paths.socket);
  const [cmd, ...rest] = argv;

  switch (cmd) {
    case undefined:
    case "tui": {
      const { runTui } = await import("../tui/app.tsx");
      await runTui(paths);
      return;
    }
    case "start": {
      const started = await startDaemon(paths, client);
      const st = await client.call("status", {});
      console.log(started ? "Sentinel daemon started." : "Sentinel daemon already running.");
      console.log(formatStatus(st));
      return;
    }
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    case "daemon": {
      const { Daemon } = await import("../daemon/daemon.ts");
      const quiet = rest.includes("--quiet");
      if (await client.alive()) die("daemon already running");
      ensureHome(paths);
      let d: InstanceType<typeof Daemon>;
      try {
        d = new Daemon(paths, { quiet });
        d.start();
      } catch (e) {
        appendFileSync(paths.log, `${new Date().toISOString()} daemon failed to start: ${(e as Error).message}\n`);
        throw e;
      }
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => d.stop());
      return;
    }
    case "watch": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          agent: { type: "string" },
          session: { type: "string" },
          cwd: { type: "string" },
          "include-existing": { type: "boolean" },
        },
      });
      if (positionals.length === 0) die("watch needs at least one PR");
      const det = detectAgent();
      const agent = (values.agent ?? det.agent) as AgentKind | undefined;
      const sessionId = values.session ?? det.sessionId;
      if (agent !== "claude" && agent !== "codex") die("could not detect agent; pass --agent claude|codex");
      if (!sessionId) die("could not detect session id; pass --session <id>");
      await startDaemon(paths, client);
      const results = await client.call("watch", {
        prs: positionals,
        agent,
        sessionId,
        cwd: values.cwd ?? det.cwd,
        includeExisting: values["include-existing"],
      });
      let failed = false;
      for (const r of results) {
        if (r.error) {
          failed = true;
          console.log(`✗ ${r.id}: ${r.error}`);
        } else console.log(`✓ ${r.id} ${r.created ? "watching" : "reassigned"} (${agent} ${sessionId})`);
      }
      if (failed) process.exit(1);
      return;
    }
    case "unwatch": {
      if (!rest[0]) die("unwatch needs a PR");
      const r = await client.call("unwatch", { pr: rest[0] });
      console.log(r.removed ? `Stopped watching ${rest[0]}` : `Not watching ${rest[0]}`);
      return;
    }
    case "list": {
      const list = await client.call("list", {});
      console.log(rest.includes("--json") ? JSON.stringify(list, null, 2) : formatList(list));
      return;
    }
    case "check": {
      const r = await client.call("check", { pr: rest[0] }, 600_000);
      console.log(r.checked.length ? `Checked ${r.checked.join(", ")}` : "Nothing to check");
      return;
    }
    case "status": {
      const st = await client.call("status", {});
      console.log(rest.includes("--json") ? JSON.stringify(st, null, 2) : formatStatus(st));
      return;
    }
    case "stop": {
      const r = await stopDaemon(paths, client);
      console.log(r === "not-running" ? "Daemon not running." : "Sentinel daemon stopped.");
      return;
    }
    case "restart": {
      const r = await stopDaemon(paths, client);
      await startDaemon(paths, client);
      const st = await client.call("status", {});
      console.log(r === "not-running" ? "Daemon wasn't running; started it." : "Sentinel daemon restarted.");
      console.log(formatStatus(st));
      return;
    }
    case "reload": {
      const r = await client.call("reload", {});
      console.log(r.ok ? "Config reloaded." : `Config invalid, kept last good config:\n${r.error}`);
      return;
    }
    case "hook": {
      // Called by agent hooks. Must be fast and never fail the agent.
      const signal = rest[0] as HookSignal;
      const stdin = process.stdin.isTTY ? "" : await Bun.stdin.text();
      const sessionId = hookSessionId(stdin);
      if (sessionId && ["idle", "busy", "exit"].includes(signal)) {
        await client.call("signal", { sessionId, signal }, 5000).catch(() => {});
      }
      return;
    }
    case "skill": {
      if (rest[0] === "show") {
        process.stdout.write(skillText);
        return;
      }
      if (rest[0] === "install") {
        for (const base of [join(homedir(), ".claude", "skills"), join(homedir(), ".codex", "skills")]) {
          const dir = join(base, "sentinel");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "SKILL.md"), skillText);
          console.log(`Installed ${join(dir, "SKILL.md")}`);
        }
        return;
      }
      die("usage: sentinel skill show|install");
    }
    default:
      die(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof DaemonUnavailableError) die(e.message);
  die((e as Error).message);
});
