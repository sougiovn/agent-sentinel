import { exec as defaultExec, execOk, type Exec } from "../core/exec.ts";
import { MuxUnavailableError, parseJson, type CreatePaneOptions, type Multiplexer, type PaneRef } from "./mux.ts";

/**
 * herdr-core (`hc`), the core behind Herdr.app. It has no workspaces, tabs or splits: every session gets
 * its own terminal, so `layout` and `maxPanesPerTab` don't apply. Terminals carry a `sentinel=<home>` label
 * so they can be found in Herdr.app and with `hc ls --label`.
 *
 * On macOS/Linux the `hc` calls made here start the core if it isn't running, so a stopped core is not a failure
 * here: only a missing `hc` or a core that fails to start is.
 */
/** `hc` exit codes (herdr-core `RpcError::exit_code`) that mean the terminal is gone, not that hc failed. */
const GONE_CODES = new Set([3 /* not_found */, 11 /* finished */]);
const UNAVAILABLE_CODE = 5;

/**
 * `hc send` waits for a person's unfinished draft, up to `draft_wait` (60 s by default) after their last key,
 * so it can block while someone keeps typing. Killing the client makes the core drop a send it hasn't typed yet.
 */
export const HC_SEND_TIMEOUT_MS = 90_000;

export class HcMux implements Multiplexer {
  readonly name = "hc" as const;

  constructor(
    private run: Exec = defaultExec,
    private sendTimeoutMs = HC_SEND_TIMEOUT_MS,
  ) {}

  async ensureAvailable() {
    const r = await this.run(["hc", "server", "status", "--json"], { timeoutMs: 15_000 }).catch((e: Error) => ({
      code: 127,
      stdout: "",
      stderr: e.message,
    }));
    if (r.code !== 0) {
      throw new MuxUnavailableError(`herdr-core is not available (is \`hc\` installed, and can its core start?): ${(r.stderr || r.stdout).trim()}`);
    }
  }

  async paneExists(paneId: string) {
    const r = await this.run(["hc", "get", paneId, "--json"]);
    if (GONE_CODES.has(r.code)) return false;
    // Any other failure says nothing about the terminal. Reporting it as gone would open a second terminal
    // for an agent that may still be running in the first.
    const why = (r.stderr || r.stdout).trim();
    if (r.code === UNAVAILABLE_CODE) throw new MuxUnavailableError(`herdr-core is not available: ${why}`);
    if (r.code !== 0) throw new Error(`hc get ${paneId} exited ${r.code}: ${why}`);
    try {
      return (JSON.parse(r.stdout) as { state?: string }).state === "live";
    } catch {
      return false;
    }
  }

  async createPane(opts: CreatePaneOptions): Promise<PaneRef> {
    // --no-parent: if the daemon was started from an hc terminal, hc would otherwise make that terminal the
    // parent, and the agent would end when the parent's program does.
    const out = parseJson(
      await execOk(this.run, [
        "hc",
        "run",
        "--bg",
        "--json",
        "--no-parent",
        "--no-notify",
        "--cwd",
        opts.cwd,
        "--label",
        `sentinel=${opts.homeName}`,
        "--label",
        `pane=${opts.label}`,
      ]),
      "hc run",
    ) as { address?: unknown };
    if (typeof out.address !== "string" || !out.address) throw new Error("hc run did not return a terminal address");
    // hc has no tabs or home object. Only paneId is used to reach the terminal; the address and the
    // `sentinel=` label value fill tabId and homeId so the stored session and home records stay non-empty.
    return { paneId: out.address, tabId: out.address, homeId: opts.homeName };
  }

  /**
   * hc can't bring a terminal to the front: `hc attach` shows one only by taking over the terminal it runs in,
   * which the daemon doesn't have. The terminal is ready, so this reports how to reach it instead of failing.
   * `ownTab` and `focus` in createPane are ignored for the same reason.
   */
  async focusPane(ref: PaneRef) {
    return `hc can't bring a terminal to the front; open it in Herdr.app or run \`hc attach ${ref.paneId}\``;
  }

  async sendLine(paneId: string, text: string) {
    const started = Date.now();
    try {
      await execOk(this.run, ["hc", "send", paneId, text, "--json"], { timeoutMs: this.sendTimeoutMs });
    } catch (e) {
      if (Date.now() - started < this.sendTimeoutMs) throw e;
      throw new Error(`hc send to ${paneId} timed out after ${this.sendTimeoutMs / 1000}s; someone may be typing in that terminal`);
    }
  }
}
