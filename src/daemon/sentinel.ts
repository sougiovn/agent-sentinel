import type { Config } from "../core/config.ts";
import type { Store } from "../core/db.ts";
import { parsePrRef, prId, prUrl, type PrRef } from "../core/pr-ref.ts";
import type { AgentKind, Item, PrRow } from "../core/types.ts";
import type { Evaluator } from "../evaluator/evaluator.ts";
import type { GhClient } from "../github/gh.ts";
import { newItems, normalize, type FilterOptions } from "../github/snapshot.ts";
import type { Dispatcher } from "../spawn/dispatcher.ts";

export interface SentinelDeps {
  store: Store;
  gh: GhClient;
  evaluator: Evaluator;
  dispatcher: Dispatcher;
  config: () => Config;
  now: () => number;
  log: (msg: string) => void;
}

export interface WatchRequest {
  prs: string[];
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  includeExisting?: boolean;
}

export interface WatchResult {
  id: string;
  created: boolean;
  error?: string;
}

const MAX_LOG_TAILS = 5;

/** Serializes async work so polls, ad-hoc checks and registrations never overlap. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export class Sentinel {
  private queue = new SerialQueue();

  constructor(private d: SentinelDeps) {}

  private async filterOptions(ref: PrRef): Promise<FilterOptions> {
    const cfg = this.d.config();
    const ignored = new Set<string>();
    for (const a of cfg.ignoredAuthors) {
      if (a === "@me") {
        try {
          ignored.add((await this.d.gh.viewerLogin(ref.host)).toLowerCase());
        } catch (e) {
          this.d.log(`could not resolve @me for ${ref.host}: ${(e as Error).message}`);
        }
      } else ignored.add(a.toLowerCase());
    }
    return { ignoredAuthors: ignored, failingConclusions: new Set(cfg.failingConclusions.map((c) => c.toUpperCase())) };
  }

  watch(req: WatchRequest): Promise<WatchResult[]> {
    return this.queue.run(async () => {
      const results: WatchResult[] = [];
      for (const raw of req.prs) {
        let ref: PrRef;
        try {
          ref = parsePrRef(raw);
        } catch (e) {
          results.push({ id: raw, created: false, error: (e as Error).message });
          continue;
        }
        const id = prId(ref);
        try {
          const activity = await this.d.gh.fetchActivity(ref);
          if (activity.view.state !== "OPEN") {
            results.push({ id, created: false, error: `PR is ${activity.view.state.toLowerCase()}` });
            continue;
          }
          const now = this.d.now();
          const created = this.d.store.upsertPr({ id, url: prUrl(ref), agent: req.agent, sessionId: req.sessionId, cwd: req.cwd, now });
          if (created && !req.includeExisting) this.d.store.markSeen(id, normalize(activity));
          this.d.store.addEvent(id, created ? "registered" : "reassigned", { agent: req.agent, session: req.sessionId, cwd: req.cwd }, now);
          if (created && !req.includeExisting) this.d.store.setPrStatus(id, "no_changes", "Baseline recorded", now);
          results.push({ id, created });
        } catch (e) {
          results.push({ id, created: false, error: (e as Error).message });
        }
      }
      if (req.includeExisting) {
        for (const r of results) if (!r.error) await this.checkPrInner(r.id);
      }
      return results;
    });
  }

  unwatch(raw: string): boolean {
    const id = this.resolveId(raw);
    if (!id) return false;
    this.d.store.deletePr(id);
    this.d.log(`unwatched ${id}`);
    return true;
  }

  resolveId(raw: string): string | null {
    try {
      const id = prId(parsePrRef(raw));
      return this.d.store.getPr(id) ? id : null;
    } catch {
      return this.d.store.getPr(raw) ? raw : null;
    }
  }

  checkPr(id: string): Promise<void> {
    return this.queue.run(() => this.checkPrInner(id));
  }

  /** One full polling pass over all PRs, then a dispatch pass for queued fixes. */
  tick(): Promise<void> {
    return this.queue.run(async () => {
      for (const pr of this.d.store.listPrs()) await this.checkPrInner(pr.id);
      await this.d.dispatcher.dispatchAll();
    });
  }

  private async checkPrInner(id: string): Promise<void> {
    const { store, gh, evaluator, dispatcher, log } = this.d;
    const pr = store.getPr(id);
    if (!pr) return;
    const ref = parsePrRef(pr.id);
    const now = this.d.now();

    let activity;
    try {
      activity = await gh.fetchActivity(ref);
    } catch (e) {
      this.fail(pr, `GitHub fetch failed: ${(e as Error).message}`, now);
      return;
    }

    if (activity.view.state !== "OPEN") {
      store.deletePr(id);
      log(`${id} is ${activity.view.state.toLowerCase()}; stopped monitoring and wiped its data`);
      return;
    }

    const fresh = newItems(normalize(activity), store.seenIds(id), await this.filterOptions(ref));
    if (fresh.length === 0) {
      const keep = pr.last_status === "fix_running" || pr.last_status === "fix_spawned";
      store.setPrStatus(id, keep ? pr.last_status : "no_changes", keep ? pr.last_reason : null, now);
      return;
    }

    await this.attachLogTails(ref, fresh);
    store.addEvent(id, "new_items", { items: fresh.map((i) => i.id) }, now);

    let verdict;
    try {
      verdict = await evaluator.evaluate({ prUrl: pr.url, title: activity.view.title, body: activity.view.body, items: fresh });
    } catch (e) {
      this.fail(pr, `Evaluation failed: ${(e as Error).message}`, now);
      return;
    }

    store.markSeen(id, fresh);
    store.addEvent(id, "evaluated", verdict, now);
    if (!verdict.shouldFix) {
      store.setPrStatus(id, "no_action", verdict.reason, now);
      return;
    }

    const wanted = new Set(verdict.items);
    const flagged = wanted.size ? fresh.filter((i) => wanted.has(i.id)) : fresh;
    store.addPending(id, pr.session_id, flagged.length ? flagged : fresh, verdict.reason, now);
    store.setPrStatus(id, "fix_spawned", `Queued: ${verdict.reason}`, now);
    await dispatcher.dispatch(pr.session_id);
  }

  private async attachLogTails(ref: PrRef, items: Item[]) {
    const lines = this.d.config().evaluator.failedLogLines;
    if (lines === 0) return;
    const runCache = new Map<string, string>();
    for (const it of items.filter((i) => i.kind === "check" && i.runId).slice(0, MAX_LOG_TAILS)) {
      const runId = it.runId!;
      if (!runCache.has(runId)) {
        const log = await this.d.gh.failedLog(ref, runId).catch(() => "");
        runCache.set(runId, log.split("\n").slice(-lines).join("\n"));
      }
      it.logTail = runCache.get(runId) || undefined;
    }
  }

  private fail(pr: PrRow, msg: string, now: number) {
    this.d.store.setPrStatus(pr.id, "error", msg, now);
    this.d.store.addEvent(pr.id, "error", { error: msg }, now);
    this.d.log(`${pr.id}: ${msg}`);
  }
}
