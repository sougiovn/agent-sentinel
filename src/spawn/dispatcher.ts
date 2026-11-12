import type { Config } from "../core/config.ts";
import type { Store } from "../core/db.ts";
import type { Paths } from "../core/paths.ts";
import type { Item } from "../core/types.ts";
import { renderFixPrompt, type FixGroup } from "../evaluator/prompt.ts";
import type { Multiplexer } from "../mux/mux.ts";
import { injectionLine, launchCommand, writePromptFile, type HookSignal } from "./launcher.ts";

export interface DispatcherDeps {
  store: Store;
  config: () => Config;
  mux: () => Multiplexer;
  paths: Paths;
  self: string[];
  now: () => number;
  log: (msg: string) => void;
}

export type DispatchResult = "delivered" | "queued" | "paused" | "empty" | "failed";

/**
 * Delivers queued fix items to agent sessions, one fix at a time per session.
 * Busy/idle state comes from agent hooks (`sentinel hook ...`), with a timeout fallback.
 */
export class Dispatcher {
  private inFlight = new Set<string>();

  constructor(private d: DispatcherDeps) {}

  isBusy(sessionId: string): boolean {
    const s = this.d.store.getSession(sessionId);
    if (!s || s.state !== "busy") return false;
    const timeoutMs = this.d.config().spawn.busyTimeoutMin * 60_000;
    if (s.busy_since !== null && this.d.now() - s.busy_since > timeoutMs) {
      this.d.store.updateSession(sessionId, { state: "idle", busy_since: null });
      this.d.log(`session ${sessionId}: busy timeout elapsed, treating as idle`);
      return false;
    }
    return true;
  }

  private busyCount(): number {
    return this.d.store.listSessions().filter((s) => s.state === "busy" && this.isBusy(s.session_id)).length;
  }

  async dispatchAll(): Promise<void> {
    for (const sid of this.d.store.sessionsWithPending()) await this.dispatch(sid);
  }

  async dispatch(sessionId: string): Promise<DispatchResult> {
    if (this.inFlight.has(sessionId)) return "queued";
    this.inFlight.add(sessionId);
    try {
      return await this.dispatchInner(sessionId);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async dispatchInner(sessionId: string): Promise<DispatchResult> {
    const { store, config } = this.d;
    const session = store.getSession(sessionId);
    if (!session) return "empty";
    const pending = store.pendingForSession(sessionId);
    if (pending.length === 0) return "empty";
    if (session.paused) return "paused";
    if (this.isBusy(sessionId)) return "queued";
    const cfg = config();
    if (cfg.spawn.maxConcurrent > 0 && this.busyCount() >= cfg.spawn.maxConcurrent) return "queued";

    const groups = new Map<string, FixGroup>();
    for (const p of pending) {
      const pr = store.getPr(p.prId);
      if (!pr) continue;
      const g = groups.get(p.prId) ?? { prUrl: pr.url, reason: p.reason ?? "", items: [] as Item[] };
      g.items.push(p.item);
      groups.set(p.prId, g);
    }
    if (groups.size === 0) {
      store.clearPending(sessionId);
      return "empty";
    }

    const now = this.d.now();
    const text = renderFixPrompt(cfg.fixPromptTemplate, [...groups.values()]);
    const mux = this.d.mux();
    try {
      await mux.ensureAvailable();
      const promptFile = writePromptFile(this.d.paths, sessionId, text, now);
      let paneId = session.pane_id && session.mux === mux.name ? session.pane_id : null;
      if (paneId && !(await mux.paneExists(paneId))) paneId = null;

      const launch = () =>
        launchCommand({ agent: session.agent, sessionId, cwd: session.cwd, promptFile }, cfg, this.d.paths, this.d.self);

      if (!paneId) {
        const ref = await mux.createPane({
          homeName: cfg.spawn.sessionName,
          layout: cfg.spawn.layout,
          maxPanesPerTab: cfg.spawn.maxPanesPerTab,
          cwd: session.cwd,
          label: `${session.agent}:${sessionId.slice(0, 8)}`,
        });
        paneId = ref.paneId;
        store.updateSession(sessionId, { mux: mux.name, pane_id: ref.paneId, tab_id: ref.tabId });
        await mux.sendLine(paneId, launch());
      } else if (session.agent_running) {
        await mux.sendLine(paneId, injectionLine(promptFile));
      } else {
        await mux.sendLine(paneId, launch());
      }

      store.updateSession(sessionId, { state: "busy", busy_since: now, agent_running: 1, last_signal_at: now });
      store.clearPending(sessionId);
      for (const [prId, g] of groups) {
        store.setPrStatus(prId, "fix_running", g.reason);
        store.addEvent(prId, "fix_delivered", { pane: paneId, items: g.items.map((i) => i.id), promptFile }, now);
      }
      this.d.log(`session ${sessionId}: delivered ${pending.length} item(s) to pane ${paneId}`);
      return "delivered";
    } catch (e) {
      const msg = (e as Error).message;
      // Roll back so the next poll re-evaluates these items together with anything newer.
      for (const [prId, g] of groups) {
        store.unmarkSeen(prId, g.items.map((i) => i.id));
        store.setPrStatus(prId, "spawn_failed", msg);
        store.addEvent(prId, "spawn_failed", { error: msg }, now);
      }
      store.clearPending(sessionId);
      this.d.log(`session ${sessionId}: spawn failed: ${msg}`);
      return "failed";
    }
  }

  /** Handles an agent hook signal. */
  async signal(sessionId: string, signal: HookSignal): Promise<boolean> {
    const { store } = this.d;
    const s = store.getSession(sessionId);
    if (!s) return false;
    const now = this.d.now();
    if (signal === "busy") {
      store.updateSession(sessionId, { state: "busy", busy_since: now, agent_running: 1, last_signal_at: now });
      return true;
    }
    store.updateSession(sessionId, {
      state: "idle",
      busy_since: null,
      agent_running: signal === "exit" ? 0 : 1,
      last_signal_at: now,
    });
    for (const pr of store.prsForSession(sessionId)) {
      if (pr.last_status === "fix_running") {
        store.setPrStatus(pr.id, "fix_spawned", signal === "exit" ? "Agent exited" : "Agent finished");
        store.addEvent(pr.id, `agent_${signal}`, null, now);
      }
    }
    // This session's queue first, then any session that was waiting on a concurrency slot.
    await this.dispatch(sessionId);
    await this.dispatchAll();
    return true;
  }

  setPaused(sessionId: string, paused: boolean) {
    this.d.store.updateSession(sessionId, { paused: paused ? 1 : 0 });
  }
}
