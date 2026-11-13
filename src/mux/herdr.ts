import { exec as defaultExec, execOk, type Exec } from "../core/exec.ts";
import { findKey, MuxUnavailableError, parseJson, tabName, type CreatePaneOptions, type Multiplexer, type PaneRef } from "./mux.ts";

interface HerdrPane {
  pane_id: string;
  tab_id?: string;
}

function list<T>(out: unknown, key: string): T[] {
  const res = (out as { result?: Record<string, unknown> }).result ?? (out as Record<string, unknown>);
  const v = res?.[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

export class HerdrMux implements Multiplexer {
  readonly name = "herdr" as const;

  constructor(private run: Exec = defaultExec) {}

  private async herdr(args: string[]): Promise<unknown> {
    return parseJson(await execOk(this.run, ["herdr", ...args]), `herdr ${args[0]} ${args[1]}`);
  }

  async ensureAvailable() {
    const r = await this.run(["herdr", "workspace", "list"], { timeoutMs: 15_000 }).catch((e: Error) => ({
      code: 127,
      stdout: "",
      stderr: e.message,
    }));
    if (r.code !== 0) {
      throw new MuxUnavailableError(`Herdr server is not reachable (start herdr first): ${(r.stderr || r.stdout).trim()}`);
    }
  }

  async paneExists(paneId: string) {
    const r = await this.run(["herdr", "pane", "get", paneId]);
    return r.code === 0;
  }

  async createPane(opts: CreatePaneOptions): Promise<PaneRef> {
    const workspaces = list<{ workspace_id: string; label?: string }>(await this.herdr(["workspace", "list"]), "workspaces");
    const ws = workspaces.find((w) => w.workspace_id === opts.homeId) ?? workspaces.find((w) => w.label === opts.homeName);

    if (!ws) {
      const out = await this.herdr(["workspace", "create", "--cwd", opts.cwd, "--label", opts.homeName, "--no-focus"]);
      const homeId = findKey(out, "workspace_id");
      if (!homeId) throw new Error("herdr workspace create did not return a workspace id");
      const ref = await this.refFrom(out, opts.label, homeId);
      await this.run(["herdr", "tab", "rename", ref.tabId, tabName(opts, 0)]);
      return ref;
    }

    const panes = list<HerdrPane>(await this.herdr(["pane", "list", "--workspace", ws.workspace_id]), "panes");
    const byTab = new Map<string, HerdrPane[]>();
    for (const p of panes) {
      if (!p.tab_id) continue;
      byTab.set(p.tab_id, [...(byTab.get(p.tab_id) ?? []), p]);
    }

    if (opts.layout === "sentinel-tab") {
      for (const [tabId, ps] of byTab) {
        if (ps.length >= opts.maxPanesPerTab) continue;
        const anchor = ps[ps.length - 1]!;
        const out = await this.herdr([
          "pane",
          "split",
          anchor.pane_id,
          "--direction",
          ps.length % 2 === 1 ? "right" : "down",
          "--cwd",
          opts.cwd,
          "--no-focus",
        ]);
        const paneId = findKey(out, "pane_id");
        if (!paneId) throw new Error("herdr pane split did not return a pane id");
        await this.run(["herdr", "pane", "rename", paneId, opts.label]);
        return { paneId, tabId, homeId: ws.workspace_id };
      }
    }

    const out = await this.herdr([
      "tab",
      "create",
      "--workspace",
      ws.workspace_id,
      "--cwd",
      opts.cwd,
      "--label",
      tabName(opts, byTab.size),
      "--no-focus",
    ]);
    return this.refFrom(out, opts.label, ws.workspace_id);
  }

  private async refFrom(out: unknown, label: string, homeId: string): Promise<PaneRef> {
    const res = (out as { result?: Record<string, unknown> }).result ?? {};
    const paneId = findKey(res.root_pane, "pane_id") ?? findKey(res, "pane_id");
    const tabId = findKey(res.tab, "tab_id") ?? findKey(res, "tab_id");
    if (!paneId || !tabId) throw new Error("herdr did not return pane/tab ids");
    await this.run(["herdr", "pane", "rename", paneId, label]);
    return { paneId, tabId, homeId };
  }

  async sendLine(paneId: string, text: string) {
    await execOk(this.run, ["herdr", "pane", "send-text", paneId, text]);
    await execOk(this.run, ["herdr", "pane", "send-keys", paneId, "enter"]);
  }
}
