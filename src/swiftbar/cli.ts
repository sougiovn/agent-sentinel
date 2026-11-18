import { parseArgs } from "node:util";
import { Client, DaemonUnavailableError } from "../cli/client.ts";
import { startDaemon } from "../cli/daemon-control.ts";
import { selfCommand, type Paths } from "../core/paths.ts";
import type { OpenTool, PrListEntry, StatusInfo, TicketListEntry } from "../daemon/protocol.ts";
import { loadTheme } from "../tui/theme.ts";
import { renderMenu } from "./menu.ts";
import { cliNotifier } from "../notify/cli.ts";
import { installPlugin, resolvePluginPath } from "./plugin.ts";

export const SWIFTBAR_USAGE = `usage: sentinel swiftbar install <path> [--force]
  <path> is a directory (writes sentinel.30s.sh there) or a .sh file.`;

/** Fetches what the menu shows; a null status means the daemon isn't answering. */
async function menuData(client: Client): Promise<{ status: StatusInfo | null; prs: PrListEntry[]; tickets: TicketListEntry[] }> {
  try {
    const [status, prs] = await Promise.all([client.call("status", {}, 5000), client.call("list", {}, 5000)]);
    const tickets = await client.call("tickets", {}, 5000).catch(() => [] as TicketListEntry[]);
    return { status, prs, tickets };
  } catch (e) {
    if (e instanceof DaemonUnavailableError || (e as Error).name === "TimeoutError") return { status: null, prs: [], tickets: [] };
    throw e;
  }
}

async function openTool(paths: Paths, client: Client, tool: OpenTool, notify: (msg: string) => Promise<void>) {
  await startDaemon(paths, client);
  const r = await client.call("openTool", { tool }, 30_000);
  if (r.warning) await notify(r.warning);
}

/**
 * `sentinel swiftbar <cmd>`: `install` is run by the user; the rest are run by the plugin script, either to
 * print the menu or as a menu action. Actions run in the background, so they report through notifications.
 */
export async function runSwiftbar(args: string[], paths: Paths, client: Client): Promise<void> {
  const [cmd, ...rest] = args;
  const send = cliNotifier(paths);
  const notify = (body: string) => send({ title: "Sentinel", body });
  switch (cmd) {
    case "install": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { force: { type: "boolean" } } });
      if (!positionals[0]) throw new Error(SWIFTBAR_USAGE);
      const file = resolvePluginPath(positionals[0]);
      const r = installPlugin(file, {
        self: selfCommand(),
        path: process.env.PATH,
        sentinelHome: process.env.SENTINEL_HOME,
        force: values.force,
      });
      console.log(`${r === "installed" ? "Installed" : "Updated"} the SwiftBar plugin at ${file}`);
      console.log("SwiftBar loads it if that directory is its plugin folder (SwiftBar → Settings → Plugin Folder).");
      return;
    }
    case "menu": {
      const { values } = parseArgs({ args: rest, options: { plugin: { type: "string" } } });
      if (!values.plugin) throw new Error("usage: sentinel swiftbar menu --plugin <plugin script>");
      const theme = loadTheme(paths.theme);
      const data = await menuData(client);
      console.log(renderMenu({ ...data, plugin: values.plugin, now: Date.now(), statusColors: theme.ok ? theme.theme.statuses : undefined }));
      return;
    }
    case "go": {
      if (!rest[0]) throw new Error("usage: sentinel swiftbar go <session-id>");
      try {
        const r = await client.call("goToAgent", { sessionId: rest[0] }, 30_000);
        if (r.warning) await notify(r.warning);
      } catch (e) {
        await notify(`Could not go to the agent: ${(e as Error).message}`);
      }
      return;
    }
    case "refresh": {
      try {
        const r = await client.call("refresh", {}, 600_000);
        if (!r.accepted) await notify(r.error ?? "Refresh refused");
        else await notify(`Refreshed ${r.checked.length} PR${r.checked.length === 1 ? "" : "s"}${r.tickets.length ? ` · ${r.tickets.length} Jira ticket(s) found` : ""}`);
      } catch (e) {
        await notify(`Refresh failed: ${(e as Error).message}`);
      }
      return;
    }
    case "dashboard":
    case "settings": {
      try {
        await openTool(paths, client, cmd, notify);
      } catch (e) {
        await notify(`Could not open the ${cmd}: ${(e as Error).message}`);
      }
      return;
    }
    case "start": {
      try {
        await startDaemon(paths, client);
      } catch (e) {
        await notify(`Could not start the daemon: ${(e as Error).message}`);
      }
      return;
    }
    default:
      throw new Error(SWIFTBAR_USAGE);
  }
}
