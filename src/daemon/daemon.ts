import { appendFileSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, defaultConfig, watchConfig, type Config } from "../core/config.ts";
import { Store } from "../core/db.ts";
import { ensureHome, selfCommand, type Paths } from "../core/paths.ts";
import { ClaudeEvaluator, type Evaluator } from "../evaluator/evaluator.ts";
import { exec as defaultExec, type Exec } from "../core/exec.ts";
import { parsePrRef, prId } from "../core/pr-ref.ts";
import { RepoLocator } from "../core/repo-locate.ts";
import { GhCli, type GhClient } from "../github/gh.ts";
import { HerdrMux } from "../mux/herdr.ts";
import type { Multiplexer } from "../mux/mux.ts";
import { RexMux } from "../mux/rex.ts";
import { Dispatcher } from "../spawn/dispatcher.ts";
import type { RefreshResult, RpcMethod, RpcMethods, RpcRequest, RpcResponse, StatusInfo } from "./protocol.ts";
import { Sentinel } from "./sentinel.ts";
import { TicketWatcher } from "./tickets.ts";
import { AcliJira, type JiraClient } from "../jira/acli.ts";

const PROMPT_RETENTION_MS = 7 * 24 * 3600_000;

/** Manual full polls are refused for this long after the previous accepted one. */
export const MANUAL_REFRESH_COOLDOWN_MS = 30_000;

export interface DaemonOverrides {
  gh?: GhClient;
  jira?: JiraClient;
  /** Runs git for locating local clones. */
  exec?: Exec;
  evaluator?: Evaluator;
  muxFactory?: (name: Config["multiplexer"]) => Multiplexer;
  now?: () => number;
  /** Disable the polling timer (tests drive ticks manually). */
  noTimer?: boolean;
  quiet?: boolean;
}

export class Daemon {
  readonly store: Store;
  readonly sentinel: Sentinel;
  readonly dispatcher: Dispatcher;
  readonly tickets: TicketWatcher;
  private readonly gh: GhClient;
  private readonly repos: RepoLocator;
  private config: Config;
  private configError: string | null = null;
  private server?: ReturnType<typeof Bun.serve>;
  private timer?: ReturnType<typeof setTimeout>;
  private nextPollAt: number | null = null;
  private ticketTimer?: ReturnType<typeof setTimeout>;
  private nextTicketPollAt: number | null = null;
  private ticketPollInProgress = false;
  private ticketError: string | null = null;
  private watcher?: { close(): void };
  private startedAt = Date.now();
  private muxCache = new Map<string, Multiplexer>();
  private stopping = false;
  private readonly now: () => number;
  /** A full poll (scheduled or manual) is currently running. */
  private pollInProgress = false;
  private lastManualRefreshAt: number | null = null;

  constructor(
    readonly paths: Paths,
    private o: DaemonOverrides = {},
  ) {
    ensureHome(paths);
    const loaded = loadConfig(paths.config);
    if (loaded.ok) this.config = loaded.config;
    else {
      this.config = defaultConfig();
      this.configError = loaded.error;
      this.log(`config error, using defaults: ${loaded.error}`);
    }
    this.store = new Store(paths.db);
    const now = (this.now = o.now ?? Date.now);
    const log = (m: string) => this.log(m);
    this.dispatcher = new Dispatcher({
      store: this.store,
      config: () => this.config,
      mux: () => this.mux(),
      paths,
      self: selfCommand(),
      now,
      log,
    });
    this.gh = o.gh ?? new GhCli();
    this.repos = new RepoLocator(o.exec ?? defaultExec);
    this.sentinel = new Sentinel({
      store: this.store,
      gh: this.gh,
      evaluator:
        o.evaluator ??
        new ClaudeEvaluator(() => ({
          model: this.config.evaluator.model,
          maxBudgetUsd: this.config.evaluator.maxBudgetUsd,
          cwd: paths.evalDir,
          command: this.config.agents.claude.command,
        })),
      dispatcher: this.dispatcher,
      config: () => this.config,
      now,
      log,
    });
    this.tickets = new TicketWatcher({
      store: this.store,
      jira: o.jira ?? new AcliJira(() => this.config.jira.command),
      dispatcher: this.dispatcher,
      config: () => this.config,
      now,
      log,
    });
  }

  log(msg: string) {
    const line = `${new Date().toISOString()} ${msg}\n`;
    if (!this.o.quiet) process.stderr.write(line);
    try {
      appendFileSync(this.paths.log, line);
    } catch {}
  }

  private mux(): Multiplexer {
    const name = this.config.multiplexer;
    let m = this.muxCache.get(name);
    if (!m) {
      m = this.o.muxFactory ? this.o.muxFactory(name) : name === "rex" ? new RexMux() : new HerdrMux();
      this.muxCache.set(name, m);
    }
    return m;
  }

  reload(): { ok: boolean; error: string | null } {
    const r = loadConfig(this.paths.config);
    if (!r.ok) {
      this.configError = r.error;
      this.log(`config reload failed, keeping last good config: ${r.error}`);
      return { ok: false, error: r.error };
    }
    const intervalChanged = r.config.pollIntervalSec !== this.config.pollIntervalSec;
    const jiraChanged =
      r.config.jira.enabled !== this.config.jira.enabled || r.config.jira.pollIntervalSec !== this.config.jira.pollIntervalSec;
    this.config = r.config;
    this.configError = null;
    this.log("config reloaded");
    if (intervalChanged && this.timer) this.schedule(this.config.pollIntervalSec * 1000);
    if (jiraChanged && this.server) this.scheduleTickets(this.config.jira.enabled ? 5000 : null);
    return { ok: true, error: null };
  }

  private schedule(delayMs: number) {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.nextPollAt = this.stopping ? null : this.now() + delayMs;
    if (this.o.noTimer || this.stopping) return;
    this.timer = setTimeout(() => void this.runPoll(), delayMs);
  }

  /** Schedules the next Jira poll; null stops polling Jira. */
  private scheduleTickets(delayMs: number | null) {
    clearTimeout(this.ticketTimer);
    this.ticketTimer = undefined;
    this.nextTicketPollAt = this.stopping || delayMs === null ? null : this.now() + delayMs;
    if (this.o.noTimer || this.stopping || delayMs === null) return;
    this.ticketTimer = setTimeout(() => void this.runTicketPoll(), delayMs);
  }

  /** One Jira poll; the timer for the next one starts once it finishes. */
  async runTicketPoll(): Promise<string[]> {
    if (this.ticketPollInProgress || !this.config.jira.enabled) return [];
    this.ticketPollInProgress = true;
    clearTimeout(this.ticketTimer);
    this.ticketTimer = undefined;
    this.nextTicketPollAt = null;
    try {
      const r = await this.sentinel.exclusive(() => this.tickets.poll());
      this.ticketError = null;
      return r.found;
    } catch (e) {
      this.ticketError = (e as Error).message;
      this.log(`Jira poll failed: ${this.ticketError}`);
      return [];
    } finally {
      this.ticketPollInProgress = false;
      this.scheduleTickets(this.config.jira.enabled ? this.config.jira.pollIntervalSec * 1000 : null);
    }
  }

  /** One full polling pass; the timer for the next pass starts once it finishes. */
  private async runPoll(): Promise<string[]> {
    if (this.pollInProgress) return [];
    this.pollInProgress = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.nextPollAt = null;
    const ids = this.store.listPrs().map((pr) => pr.id);
    try {
      await this.sentinel.tick();
      this.prunePrompts();
    } catch (e) {
      this.log(`poll failed: ${(e as Error).message}`);
    } finally {
      this.pollInProgress = false;
      this.schedule(this.config.pollIntervalSec * 1000);
    }
    return ids;
  }

  /**
   * Polls all watched PRs now and restarts the countdown for the next poll.
   * Refused while another poll is running, and for 30s after the previous
   * accepted manual refresh, so repeated key presses can't cause a poll storm.
   */
  async refresh(): Promise<RefreshResult> {
    const now = this.now();
    if (this.pollInProgress) {
      return {
        accepted: false,
        error: "A poll is already in progress",
        checked: [],
        tickets: [],
        nextPollAt: this.nextPollAt,
      };
    }
    const elapsed = this.lastManualRefreshAt === null ? Infinity : now - this.lastManualRefreshAt;
    if (elapsed < MANUAL_REFRESH_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - elapsed) / 1000);
      return {
        accepted: false,
        error: `Manual refresh cooling down; try again in ${retryAfterSec}s`,
        retryAfterSec,
        checked: [],
        tickets: [],
        nextPollAt: this.nextPollAt,
      };
    }
    this.lastManualRefreshAt = now;
    const checked = await this.runPoll();
    const tickets = await this.runTicketPoll();
    return { accepted: true, checked, tickets, nextPollAt: this.nextPollAt };
  }

  private prunePrompts() {
    const cutoff = Date.now() - PROMPT_RETENTION_MS;
    for (const f of readdirSync(this.paths.promptsDir)) {
      const p = join(this.paths.promptsDir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {}
    }
  }

  status(): StatusInfo {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      home: this.paths.home,
      multiplexer: this.config.multiplexer,
      pollIntervalSec: this.config.pollIntervalSec,
      nextPollAt: this.nextPollAt,
      prs: this.store.listPrs().length,
      configError: this.configError,
      jira: {
        enabled: this.config.jira.enabled,
        label: this.config.jira.label,
        pollIntervalSec: this.config.jira.pollIntervalSec,
        nextPollAt: this.nextTicketPollAt,
        tickets: this.store.listTickets().length,
        error: this.ticketError,
      },
    };
  }

  async handle<M extends RpcMethod>(method: M, params: RpcMethods[M][0]): Promise<RpcMethods[M][1]> {
    const p = params as never;
    type R = RpcMethods[M][1];
    switch (method) {
      case "status":
        return this.status() as R;
      case "list":
        return this.store.listPrs().map((pr) => ({ ...pr, session: this.store.getSession(pr.session_id) })) as R;
      case "watch":
        return (await this.sentinel.watch(p)) as R;
      case "myPrs":
        return (await this.myPrs()) as R;
      case "newWatchDefaults": {
        const { model, effort, models, efforts, startNow, includeExisting } = this.config.newWatch;
        return { model, effort, models, efforts, startNow, includeExisting } as R;
      }
      case "suggestCwd":
        return { path: await this.suggestCwd((p as { pr: string }).pr) } as R;
      case "validateCwd": {
        const { pr, path } = p as RpcMethods["validateCwd"][0];
        return (await this.repos.validate(path, parsePrRef(pr))) as R;
      }
      case "unwatch":
        return { removed: this.sentinel.unwatch((p as { pr: string }).pr) } as R;
      case "check": {
        const { pr } = p as { pr?: string };
        const ids = pr ? [this.sentinel.resolveId(pr)].filter((x): x is string => !!x) : this.store.listPrs().map((r) => r.id);
        if (pr && ids.length === 0) throw new Error(`Not watching ${pr}`);
        for (const id of ids) await this.sentinel.checkPr(id);
        await this.dispatcher.dispatchAll();
        return { checked: ids } as R;
      }
      case "tickets":
        return this.store.listTickets().map((t) => ({ ...t, session: this.store.getSession(t.session_id) })) as R;
      case "dismissTicket":
        return { removed: this.store.dismissTicket((p as { key: string }).key.toUpperCase()) } as R;
      case "pollTickets": {
        if (!this.config.jira.enabled) throw new Error("Jira tickets are disabled (set jira.enabled in config.json)");
        if (this.ticketPollInProgress) throw new Error("A Jira poll is already in progress");
        await this.runTicketPoll();
        if (this.ticketError) throw new Error(this.ticketError);
        return { tickets: this.store.listTickets().map((t) => t.key) } as R;
      }
      case "refresh":
        return (await this.refresh()) as R;
      case "history": {
        const id = this.sentinel.resolveId((p as { pr: string }).pr);
        if (!id) throw new Error(`Not watching ${(p as { pr: string }).pr}`);
        return this.store.events(id) as R;
      }
      case "signal": {
        const { sessionId, signal } = p as RpcMethods["signal"][0];
        return { known: await this.dispatcher.signal(sessionId, signal) } as R;
      }
      case "pause": {
        const { sessionId, paused } = p as RpcMethods["pause"][0];
        this.dispatcher.setPaused(sessionId, paused);
        if (!paused) await this.dispatcher.dispatch(sessionId);
        return { ok: true } as R;
      }
      case "reload":
        return this.reload() as R;
      case "stop":
        setTimeout(() => this.stop(), 50);
        return { ok: true } as R;
      default:
        throw new Error(`Unknown method ${String(method)}`);
    }
  }

  private async myPrs() {
    const prs = await this.gh.listMyPrs({ onlyMine: this.config.newWatch.onlyMine });
    return prs
      .map((pr) => {
        const id = prId(pr.ref);
        return { id, ...pr.ref, title: pr.title, url: pr.url, isDraft: pr.isDraft, updatedAt: pr.updatedAt, watched: !!this.store.getPr(id) };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** A watched PR's cwd for the same repo wins over scanning the configured roots. */
  private async suggestCwd(pr: string): Promise<string | null> {
    const ref = parsePrRef(pr);
    const prefix = `${ref.host}/${ref.owner}/${ref.repo}#`.toLowerCase();
    const known = this.store.listPrs().find((row) => row.id.toLowerCase().startsWith(prefix));
    if (known && existsSync(known.cwd)) return known.cwd;
    return this.repos.suggest(ref, this.config.newWatch.repoRoots);
  }

  start() {
    if (existsSync(this.paths.socket)) unlinkSync(this.paths.socket);
    this.server = Bun.serve({
      unix: this.paths.socket,
      fetch: async (req) => {
        let body: RpcRequest;
        try {
          body = (await req.json()) as RpcRequest;
        } catch {
          return Response.json({ ok: false, error: "invalid request" } satisfies RpcResponse, { status: 400 });
        }
        try {
          const result = await this.handle(body.method, body.params ?? ({} as never));
          return Response.json({ ok: true, result } satisfies RpcResponse);
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message } satisfies RpcResponse);
        }
      },
    });
    writeFileSync(this.paths.pid, String(process.pid));
    this.watcher = watchConfig(this.paths.config, (r) => {
      if (r.ok) this.reload();
      else {
        this.configError = r.error;
        this.log(`config file invalid, keeping last good config: ${r.error}`);
      }
    });
    this.schedule(3000);
    if (this.config.jira.enabled) this.scheduleTickets(5000);
    this.log(`daemon started (pid ${process.pid}, home ${this.paths.home})`);
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.timer);
    clearTimeout(this.ticketTimer);
    this.watcher?.close();
    this.server?.stop(true);
    try {
      unlinkSync(this.paths.socket);
    } catch {}
    try {
      unlinkSync(this.paths.pid);
    } catch {}
    this.store.close();
    this.log("daemon stopped");
    if (!this.o.noTimer) process.exit(0);
  }
}
