import { loadConfig } from "../core/config.ts";
import { exec } from "../core/exec.ts";
import type { Paths } from "../core/paths.ts";
import { MacNotifier, type NotificationContent } from "./notifier.ts";

/**
 * A notifier for CLI commands (SwiftBar actions, `sentinel notify test`), using the configured method.
 * Never throws: when the notification can't be sent, it is written to stderr instead.
 */
export function cliNotifier(paths: Paths): (n: NotificationContent) => Promise<void> {
  const loaded = loadConfig(paths.config);
  const method = loaded.ok ? loaded.config.notifications.method : "auto";
  const notifier = new MacNotifier(exec, () => method);
  return async (n) => {
    try {
      await notifier.send(n);
    } catch (e) {
      process.stderr.write(`${n.title}: ${n.body} (notification failed: ${(e as Error).message})\n`);
    }
  };
}
