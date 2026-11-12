import { exec as defaultExec, execOk, type Exec } from "../core/exec.ts";
import { findKey, MuxUnavailableError, parseJson, type CreatePaneOptions, type Multiplexer, type PaneRef } from "./mux.ts";

interface RexBlock {
  block_id: string;
  window_id?: string;
  label?: string;
}

/**
 * Rex scopes block lookups to $REX_SESSION when it's set (e.g. the daemon was started from a Rex pane),
 * which makes global block ids "not found". Always run rex without the caller's location.
 */
const REX_ENV = { REX_SESSION: undefined, REX_BLOCK: undefined, REX_WINDOW: undefined };

export class RexMux implements Multiplexer {
  readonly name = "rex" as const;
  private run: Exec;

  constructor(run: Exec = defaultExec) {
    this.run = (cmd, opts) => run(cmd, { ...opts, env: { ...REX_ENV, ...opts?.env } });
  }

  private async rex(args: string[]): Promise<string> {
    return execOk(this.run, ["rex", ...args]);
  }

  async ensureAvailable() {
    const r = await this.run(["rex", "ls", "--json"], { timeoutMs: 15_000 }).catch((e: Error) => ({
      code: 127,
      stdout: "",
      stderr: e.message,
    }));
    if (r.code !== 0) throw new MuxUnavailableError(`Rex is not reachable: ${(r.stderr || r.stdout).trim()}`);
  }

  async paneExists(paneId: string) {
    const r = await this.run(["rex", "block", "inspect", paneId, "--json"]);
    return r.code === 0;
  }

  private async findSession(label: string): Promise<string | undefined> {
    const out = parseJson(await this.rex(["ls", "--json"]), "rex ls") as {
      sessions?: { session_id: string; label?: string }[];
    };
    return out.sessions?.find((s) => s.label === label)?.session_id;
  }

  private async blocks(sessionId: string): Promise<RexBlock[]> {
    const out = parseJson(await this.rex(["block", "ls", "-s", sessionId, "--json"]), "rex block ls") as {
      blocks?: RexBlock[];
    };
    return out.blocks ?? [];
  }

  async createPane(opts: CreatePaneOptions): Promise<PaneRef> {
    const sessionId = await this.findSession(opts.homeName);
    if (!sessionId) {
      const out = parseJson(
        await this.rex(["new", opts.homeName, "--window", `${opts.homeName}-1`, "-c", opts.cwd, "--json"]),
        "rex new",
      );
      const paneId = findKey(out, "block_id") ?? (out as { initial_windows?: { block_ids?: string[] }[] }).initial_windows?.[0]?.block_ids?.[0];
      const tabId = findKey(out, "window_id");
      if (!paneId || !tabId) throw new Error("rex new did not return block/window ids");
      await this.label(paneId, opts.label);
      return { paneId, tabId };
    }

    const blocks = await this.blocks(sessionId);
    const byWindow = new Map<string, RexBlock[]>();
    for (const b of blocks) {
      if (!b.window_id) continue;
      byWindow.set(b.window_id, [...(byWindow.get(b.window_id) ?? []), b]);
    }

    if (opts.layout === "sentinel-tab") {
      for (const [windowId, ws] of byWindow) {
        if (ws.length >= opts.maxPanesPerTab) continue;
        const anchor = ws[ws.length - 1]!;
        const out = parseJson(
          await this.rex([
            "split",
            "-s",
            sessionId,
            "-b",
            anchor.block_id,
            "--split",
            ws.length % 2 === 1 ? "right" : "below",
            "-c",
            opts.cwd,
            "--label",
            opts.label,
            "--focus=false",
            "--json",
          ]),
          "rex split",
        );
        const paneId = findKey(out, "block_id") ?? (out as { block_ids?: string[] }).block_ids?.[0];
        if (!paneId) throw new Error("rex split did not return a block id");
        return { paneId, tabId: windowId };
      }
    }

    const out = parseJson(
      await this.rex([
        "window",
        "new",
        "-s",
        sessionId,
        `${opts.homeName}-${byWindow.size + 1}`,
        "-c",
        opts.cwd,
        "--focus=false",
        "--json",
      ]),
      "rex window new",
    );
    const paneId = findKey(out, "block_id") ?? (out as { block_ids?: string[] }).block_ids?.[0];
    const tabId = findKey(out, "window_id");
    if (!paneId || !tabId) throw new Error("rex window new did not return block/window ids");
    await this.label(paneId, opts.label);
    return { paneId, tabId };
  }

  private async label(paneId: string, label: string) {
    await this.run(["rex", "block", "rename", paneId, label]);
  }

  async sendLine(paneId: string, text: string) {
    await this.rex(["send", "-b", paneId, text]);
    await this.rex(["send-key", "-b", paneId, "enter"]);
  }
}
