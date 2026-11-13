import { exec as defaultExec, execOk, type Exec } from "../core/exec.ts";
import { MuxUnavailableError, parseJson, type CreatePaneOptions, type Multiplexer, type PaneRef } from "./mux.ts";

/**
 * herdr-core (`hc`), the core behind Herdr.app. It has no workspaces, tabs or splits: every session gets
 * its own terminal, so `layout` and `maxPanesPerTab` don't apply. Terminals carry a `sentinel=<home>` label
 * so they can be found in Herdr.app and with `hc ls --label`.
 */
export class HcMux implements Multiplexer {
  readonly name = "hc" as const;

  constructor(private run: Exec = defaultExec) {}

  async ensureAvailable() {
    const r = await this.run(["hc", "server", "status", "--json"], { timeoutMs: 15_000 }).catch((e: Error) => ({
      code: 127,
      stdout: "",
      stderr: e.message,
    }));
    if (r.code !== 0) {
      throw new MuxUnavailableError(`herdr-core is not reachable (run \`hc server start\`): ${(r.stderr || r.stdout).trim()}`);
    }
  }

  async paneExists(paneId: string) {
    const r = await this.run(["hc", "get", paneId, "--json"]);
    if (r.code !== 0) return false;
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
    return { paneId: out.address, tabId: out.address, homeId: opts.homeName };
  }

  async sendLine(paneId: string, text: string) {
    await execOk(this.run, ["hc", "send", paneId, text, "--json"]);
  }
}
