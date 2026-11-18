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
import { bashCompletion, complete } from "./completion.ts";
import { startDaemon, stopDaemon } from "./daemon-control.ts";
import { detectAgent, hookSessionId, hookStopActive } from "./detect.ts";
import { formatHumanComments, formatList, formatStatus, formatTickets } from "./format.ts";

const HELP = `sentinel — watches PRs for AI agent sessions and resumes them to fix feedback, and starts agents for labelled Jira tickets

Usage:
  sentinel                      Open the dashboard (starts the daemon if needed)
  sentinel start                Start the background daemon without the dashboard
  sentinel watch <pr>...        Hand off PRs (agent/session/cwd auto-detected)
      --agent claude|codex  --session <id>  --cwd <dir>  --include-existing
  sentinel unwatch <pr>         Stop watching a PR
  sentinel list [--json]        List watched PRs
  sentinel check [<pr>]         Poll now
  sentinel comments <pr> [--json]  Human comments on a PR, with their drafts
  sentinel draft <pr> <item>    Record a draft for a human comment (from the agent)
      --summary <what it asks>  --change <what changed>  --reply <proposed reply>
  sentinel tickets [--json]     List Jira tickets Sentinel picked up
  sentinel tickets check        Poll Jira now
  sentinel tickets dismiss <key>  Hide a ticket (it is still never picked up again)
  sentinel status [--json]      Daemon status
  sentinel stop                 Stop the daemon
  sentinel restart              Restart the daemon (e.g. after upgrading Sentinel)
  sentinel reload               Reload config.json
  sentinel completion bash      Print a bash completion script
  sentinel skill show|install   Print or install the agent skill
  sentinel notify test           Send a test notification (checks they reach you)
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
    case "tickets": {
      if (rest[0] === "check") {
        const r = await client.call("pollTickets", {}, 600_000);
        console.log(r.tickets.length ? `Tickets picked up: ${r.tickets.join(", ")}` : "No tickets picked up");
        return;
      }
      if (rest[0] === "dismiss") {
        if (!rest[1]) die("tickets dismiss needs a ticket key");
        const r = await client.call("dismissTicket", { key: rest[1] });
        console.log(r.removed ? `Dismissed ${rest[1]}` : `Not tracking ${rest[1]}`);
        return;
      }
      const list = await client.call("tickets", {});
      console.log(rest.includes("--json") ? JSON.stringify(list, null, 2) : formatTickets(list));
      return;
    }
    case "comments": {
      if (!rest[0]) die("comments needs a PR");
      const list = await client.call("humanComments", { pr: rest[0] });
      console.log(rest.includes("--json") ? JSON.stringify(list, null, 2) : formatHumanComments(list));
      return;
    }
    case "draft": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { summary: { type: "string" }, change: { type: "string" }, reply: { type: "string" } },
      });
      const [pr, item] = positionals;
      if (!pr || !item) die("usage: sentinel draft <pr> <item-id> --summary … --change … --reply …");
      await client.call("draft", { pr, item, summary: values.summary, change: values.change, reply: values.reply });
      console.log(`✓ Draft recorded for ${item}. The user will review and post the reply.`);
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
        const r = await client.call("signal", { sessionId, signal, stopHookActive: hookStopActive(stdin) }, 5000).catch(() => null);
        // Stop hook JSON output: the agent keeps going with `reason` as its next instruction.
        if (r?.block) process.stdout.write(`${JSON.stringify({ decision: "block", reason: r.block })}\n`);
      }
      return;
    }
    case "completion": {
      if (rest[0] === "bash") {
        process.stdout.write(bashCompletion);
        return;
      }
      die("usage: sentinel completion bash");
    }
    case "__complete": {
      // Called by the bash script, not by hand. Never fail the shell prompt.
      const result = await complete(rest, {
        watchedPrs: () =>
          client
            .call("list", {}, 1500)
            .then((list) => list.map((pr) => pr.id))
            .catch(() => []),
        ticketKeys: () =>
          client
            .call("tickets", {}, 1500)
            .then((list) => list.map((ticket) => ticket.key))
            .catch(() => []),
      });
      const lines = result.dirs ? [...result.items, ":dir"] : result.items;
      if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
      return;
    }
    case "notify": {
      if (rest[0] !== "test") die("usage: sentinel notify test");
      const { loadConfig } = await import("../core/config.ts");
      const { MacNotifier } = await import("../notify/notifier.ts");
      const { exec } = await import("../core/exec.ts");
      const loaded = loadConfig(paths.config);
      const method = loaded.ok ? loaded.config.notifications.method : "auto";
      // Sent directly rather than through cliNotifier, so a failure is reported as an error.
      await new MacNotifier(exec, () => method).send({
        title: "Sentinel",
        subtitle: "Test notification",
        body: "Notifications from Sentinel reach you.",
      });
      console.log(`Sent a test notification (method: ${method}). If none showed up, see "Notifications" in docs/features.md.`);
      if (loaded.ok && !loaded.config.notifications.enabled) console.log("Note: notifications.enabled is false, so the daemon sends none.");
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
