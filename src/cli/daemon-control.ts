import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { ensureHome, selfCommand, type Paths } from "../core/paths.ts";
import { DaemonUnavailableError, type Client } from "./client.ts";

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

export type StopResult = "stopped" | "signalled" | "not-running";

/**
 * Stops the daemon and waits for its socket to stop answering.
 * Falls back to SIGTERM via the pidfile when the socket doesn't answer.
 */
export async function stopDaemon(paths: Paths, client: Client): Promise<StopResult> {
  let result: StopResult;
  try {
    await client.call("stop", {});
    result = "stopped";
  } catch (e) {
    if (!(e instanceof DaemonUnavailableError)) throw e;
    if (!existsSync(paths.pid)) return "not-running";
    const pid = Number(readFileSync(paths.pid, "utf8"));
    try {
      process.kill(pid, "SIGTERM");
      result = "signalled";
    } catch {
      unlinkSync(paths.pid);
      return "not-running";
    }
  }
  for (let i = 0; i < 50; i++) {
    if (!(await client.alive())) return result;
    await Bun.sleep(100);
  }
  throw new Error(`daemon did not stop; see ${paths.log}`);
}
