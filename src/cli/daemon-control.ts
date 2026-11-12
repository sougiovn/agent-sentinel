import { spawn } from "node:child_process";
import { ensureHome, selfCommand, type Paths } from "../core/paths.ts";
import type { Client } from "./client.ts";

/**
 * Starts the daemon as a detached background process if it isn't answering.
 * Returns true if it was started, false if it was already running.
 * Throws if it doesn't come up within ~5s.
 */
export async function startDaemon(paths: Paths, client: Client): Promise<boolean> {
  if (await client.alive()) return false;
  ensureHome(paths);
  const [cmd, ...args] = selfCommand();
  spawn(cmd!, [...args, "daemon", "--quiet"], { detached: true, stdio: "ignore", env: process.env }).unref();
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    if (await client.alive()) return true;
  }
  throw new Error(`daemon did not start; see ${paths.log}`);
}
