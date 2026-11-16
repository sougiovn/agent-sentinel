import type { Config } from "../core/config.ts";
import type { Store } from "../core/db.ts";
import type { Paths } from "../core/paths.ts";
import { fromPrId } from "../core/pr-ref.ts";
import type { Item, SessionRow } from "../core/types.ts";
import { renderFixPrompt, rexNamingNote, type FixGroup } from "../evaluator/prompt.ts";
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

export interface GoToAgentResult {
  paneId: string;
  tabId: string;
  /** `focused`: the agent was already running in its pane; `resumed`: relaunched in its existing pane; `opened`: in a new tab. */
  how: "focused" | "resumed" | "opened";
  /** Set when the pane is ready but couldn't be fully brought to the front. */
  warning?: string;
}

export interface DeliverHooks {
  onDelivered: (paneId: string, promptFile: string, now: number) => void;
  onFailed: (msg: string, now: number) => void;
}

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
    if (this.atCapacity()) return "queued";

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

    const text = renderFixPrompt(cfg.fixPromptTemplate, [...groups.values()]);
    return this.deliver(session, text, {
      onDelivered: (paneId, promptFile, now) => {
        store.clearPending(sessionId);
        for (const [prId, g] of groups) {
          store.setPrStatus(prId, "fix_running", g.reason);
          store.addEvent(prId, "fix_delivered", { pane: paneId, items: g.items.map((i) => i.id), promptFile }, now);
        }
        this.d.log(`session ${sessionId}: delivered ${pending.length} item(s) to pane ${paneId}`);
      },
      onFailed: (msg, now) => {
        // Roll back so the next poll re-evaluates these items together with anything newer.
        for (const [prId, g] of groups) {
          store.unmarkSeen(prId, g.items.map((i) => i.id));
          store.setPrStatus(prId, "spawn_failed", msg);
          store.addEvent(prId, "spawn_failed", { error: msg }, now);
        }
        store.clearPending(sessionId);
      },
    });
  }

  /**
   * Launches a session Sentinel created itself with an intro prompt, so the agent is ready before any feedback.
   * Does nothing if the session has already been launched.
   */
  kickoff(sessionId: string, pr: { id: string; url: string; title: string }): Promise<DispatchResult> {
    const { store } = this.d;
    const ref = fromPrId(pr.id);
    return this.startSession(
      sessionId,
      (session) =>
        this.d
          .config()
          .introPromptTemplate.replaceAll("{{prUrl}}", pr.url)
          .replaceAll("{{title}}", pr.title)
          .replaceAll("{{cwd}}", session.cwd)
          .replaceAll("{{repo}}", `${ref.owner}/${ref.repo}`)
          .replaceAll("{{number}}", String(ref.number)),
      {
        onDelivered: (paneId, promptFile, now) => {
          store.setPrStatus(pr.id, "fix_running", "Session started");
          store.addEvent(pr.id, "session_started", { pane: paneId, promptFile }, now);
        },
        onFailed: (msg, now) => {
          store.setPrStatus(pr.id, "spawn_failed", msg);
          store.addEvent(pr.id, "spawn_failed", { error: msg }, now);
        },
      },
    );
  }

  /** True when `spawn.maxConcurrent` agents are already busy. */
  atCapacity(): boolean {
    const max = this.d.config().spawn.maxConcurrent;
    return max > 0 && this.busyCount() >= max;
  }

  /**
   * Launches a session Sentinel created itself with its first prompt.
   * Does nothing if the session has already been launched.
   */
  async startSession(
    sessionId: string,
    text: (session: SessionRow) => string,
    hooks: DeliverHooks,
  ): Promise<DispatchResult> {
    if (this.inFlight.has(sessionId)) return "queued";
    this.inFlight.add(sessionId);
    try {
      const session = this.d.store.getSession(sessionId);
      if (!session) return "empty";
      if (session.started) return "empty";
      if (session.paused) return "paused";
      return await this.deliver(session, text(session), {
        onDelivered: (paneId, promptFile, now) => {
          hooks.onDelivered(paneId, promptFile, now);
          this.d.log(`session ${sessionId}: started in pane ${paneId}`);
        },
        onFailed: hooks.onFailed,
      });
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /** Names a session's pane (and tab) after its Jira ticket or PRs, e.g. `CP-7713` or `repo#42`. */
  private paneLabel(session: SessionRow): string {
    const ticket = this.d.store.ticketForSession(session.session_id);
    if (ticket) return ticket.key;
    const prs = this.d.store.prsForSession(session.session_id).map((pr) => {
      const ref = fromPrId(pr.id);
      return `${ref.repo}#${ref.number}`;
    });
    return prs.length ? prs.join(",") : `${session.agent}:${session.session_id.slice(0, 8)}`;
  }

  /** Types the prompt into the session's pane, creating the pane and launching the agent as needed. */
  private async deliver(
    session: SessionRow,
    text: string,
    hooks: DeliverHooks,
  ): Promise<DispatchResult> {
    const { store } = this.d;
    const sessionId = session.session_id;
    const cfg = this.d.config();
    const now = this.d.now();
    const mux = this.d.mux();
    try {
      await mux.ensureAvailable();
      const prompt = mux.name === "rex" ? `${text}\n\n${rexNamingNote(cfg.spawn.layout)}` : text;
      const promptFile = writePromptFile(this.d.paths, sessionId, prompt, now);
      let paneId = session.pane_id && session.mux === mux.name ? session.pane_id : null;
      if (paneId && !(await mux.paneExists(paneId))) paneId = null;

      const launch = () =>
        launchCommand(
          {
            agent: session.agent,
            sessionId,
            cwd: session.cwd,
            promptFile,
            newSession: !session.started,
            model: session.model,
            effort: session.effort,
          },
          cfg,
          this.d.paths,
          this.d.self,
        );

      if (!paneId) {
        paneId = (await this.openPane(mux, session)).paneId;
        await mux.sendLine(paneId, launch());
      } else if (session.agent_running && session.started) {
        await mux.sendLine(paneId, injectionLine(promptFile));
      } else {
        await mux.sendLine(paneId, launch());
      }

      store.updateSession(sessionId, { state: "busy", busy_since: now, agent_running: 1, last_signal_at: now, started: 1 });
      hooks.onDelivered(paneId, promptFile, now);
      return "delivered";
    } catch (e) {
      const msg = (e as Error).message;
      hooks.onFailed(msg, now);
      this.d.log(`session ${sessionId}: spawn failed: ${msg}`);
      return "failed";
    }
  }

  /** Creates a pane for the session in Sentinel's home session/workspace and records it on the session. */
  private async openPane(mux: Multiplexer, session: SessionRow, extra: { ownTab?: boolean; focus?: boolean } = {}) {
    const { store } = this.d;
    const cfg = this.d.config();
    const homeKey = `mux_home:${mux.name}:${cfg.spawn.sessionName}`;
    const ref = await mux.createPane({
      homeName: cfg.spawn.sessionName,
      homeId: store.getMeta(homeKey) ?? undefined,
      layout: cfg.spawn.layout,
      maxPanesPerTab: cfg.spawn.maxPanesPerTab,
      cwd: session.cwd,
      label: this.paneLabel(session),
      ...extra,
    });
    store.setMeta(homeKey, ref.homeId);
    store.updateSession(session.session_id, { mux: mux.name, pane_id: ref.paneId, tab_id: ref.tabId });
    return ref;
  }

  /**
   * Brings a session to the front so the user can talk to the agent in its worktree. Focuses the agent's
   * pane when it's still running there; otherwise resumes the agent (without a prompt) in its old pane,
   * or in a new tab when that pane is gone.
   */
  async goToAgent(sessionId: string): Promise<GoToAgentResult> {
    const { store } = this.d;
    const session = store.getSession(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    if (!session.started) throw new Error("The session hasn't started yet; Sentinel launches it with its first prompt");
    if (this.inFlight.has(sessionId)) throw new Error("Sentinel is delivering to this session right now; try again in a moment");
    this.inFlight.add(sessionId);
    try {
      const mux = this.d.mux();
      await mux.ensureAvailable();
      const home = store.getMeta(`mux_home:${mux.name}:${this.d.config().spawn.sessionName}`);
      let ref =
        session.pane_id && session.tab_id && session.mux === mux.name && home && (await mux.paneExists(session.pane_id))
          ? { paneId: session.pane_id, tabId: session.tab_id, homeId: home }
          : null;
      let how: GoToAgentResult["how"] = "focused";
      if (!ref) {
        ref = await this.openPane(mux, session, { ownTab: true, focus: true });
        how = "opened";
      } else if (!session.agent_running) {
        how = "resumed";
      }
      if (how !== "focused") {
        const line = launchCommand(
          { agent: session.agent, sessionId, cwd: session.cwd, model: session.model, effort: session.effort },
          this.d.config(),
          this.d.paths,
          this.d.self,
        );
        await mux.sendLine(ref.paneId, line);
        store.updateSession(sessionId, { state: "idle", busy_since: null, agent_running: 1, last_signal_at: this.d.now() });
      }
      const warning = await mux.focusPane(ref);
      this.d.log(`session ${sessionId}: went to agent (${how}) in pane ${ref.paneId}`);
      return { paneId: ref.paneId, tabId: ref.tabId, how, ...(warning ? { warning } : {}) };
    } finally {
      this.inFlight.delete(sessionId);
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
