import { appendFileSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, defaultConfig, watchConfig, type Config } from "../core/config.ts";
import { Store } from "../core/db.ts";
import { ensureHome, selfCommand, type Paths } from "../core/paths.ts";
import { ClaudeEvaluator, type Evaluator } from "../evaluator/evaluator.ts";
import { GhCli, type GhClient } from "../github/gh.ts";
import { HerdrMux } from "../mux/herdr.ts";
import type { Multiplexer } from "../mux/mux.ts";
import { RexMux } from "../mux/rex.ts";
import { Dispatcher } from "../spawn/dispatcher.ts";
import type { RpcMethod, RpcMethods, RpcRequest, RpcResponse, StatusInfo } from "./protocol.ts";
import { Sentinel } from "./sentinel.ts";

const PROMPT_RETENTION_MS = 7 * 24 * 3600_000;

export interface DaemonOverrides {
  gh?: GhClient;
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
  private config: Config;
  private configError: string | null = null;
  private server?: ReturnType<typeof Bun.serve>;
  private timer?: ReturnType<typeof setTimeout>;
  private nextPollAt: number | null = null;
  private watcher?: { close(): void };
  private startedAt = Date.now();
  private muxCache = new Map<string, Multiplexer>();
  private stopping = false;

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
    const now = o.now ?? Date.now;
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
    this.sentinel = new Sentinel({
      store: this.store,
      gh: o.gh ?? new GhCli(),
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
    this.config = r.config;
    this.configError = null;
    this.log("config reloaded");
    if (intervalChanged && this.timer) this.schedule(this.config.pollIntervalSec * 1000);
    return { ok: true, error: null };
  }

  private schedule(delayMs: number) {
    if (this.o.noTimer || this.stopping) return;
    clearTimeout(this.timer);
    this.nextPollAt = Date.now() + delayMs;
    this.timer = setTimeout(async () => {
      this.nextPollAt = null;
      try {
        await this.sentinel.tick();
        this.prunePrompts();
      } catch (e) {
        this.log(`poll failed: ${(e as Error).message}`);
      }
      this.schedule(this.config.pollIntervalSec * 1000);
    }, delayMs);
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
    this.log(`daemon started (pid ${process.pid}, home ${this.paths.home})`);
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.timer);
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
