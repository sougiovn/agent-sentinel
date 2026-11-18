import type { Config } from "../core/config.ts";
import type { Store } from "../core/db.ts";
import type { RoutineRow, RoutineRunRow, SessionRow } from "../core/types.ts";
import type { Notification } from "../notify/notifier.ts";
import { lastFireToday, nextFire, sameDay } from "../routines/cron.ts";
import { scanRoutines, type RoutineDef, type RoutineScan } from "../routines/routine.ts";
import type { Dispatcher } from "../spawn/dispatcher.ts";

/** A failed launch of a scheduled run is retried after this long (same day only). */
export const ROUTINE_RETRY_MS = 5 * 60_000;

export interface RoutineWatcherDeps {
  store: Store;
  dispatcher: Dispatcher;
  config: () => Config;
  routinesDir: string;
  now: () => number;
  log: (msg: string) => void;
  notify?: (n: Notification) => void;
}

/** A routine as the dashboard and CLI see it: its definition (or why it can't be used) and its state. */
export interface RoutineListEntry {
  id: string;
  dir: string;
  /** False when the directory name or ROUTINE.md is invalid; `error` says why. */
  valid: boolean;
  error: string | null;
  name: string;
  description: string;
  schedule: string;
  model: string | null;
  effort: string | null;
  cwd: string | null;
  enabled: boolean;
  /** The next scheduled time; null when invalid, disabled, or routines are switched off. */
  nextRunAt: number | null;
  /** Null until the routine first parses. */
  row: RoutineRow | null;
  /** Newest first. */
  runs: RoutineRunRow[];
  /** The latest run's session. */
  session: SessionRow | null;
}

export interface RunOutcome {
  /** delivered: the agent got its prompt. queued: waiting for a slot or the previous run. */
  result: "delivered" | "queued" | "skipped" | "failed";
  sessionId: string | null;
  message: string;
}

/** Local `YYYY-MM-DD HH:mm`. */
export function formatSlot(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderRoutinePrompt(template: string, def: RoutineDef, run: { slot: number; manual: boolean; cwd: string }): string {
  const when = run.manual ? `a manual run requested at ${formatSlot(run.slot)}` : formatSlot(run.slot);
  return template
    .replaceAll("{{id}}", def.id)
    .replaceAll("{{name}}", def.name)
    .replaceAll("{{description}}", def.description)
    .replaceAll("{{schedule}}", def.schedule)
    .replaceAll("{{slot}}", when)
    .replaceAll("{{dir}}", def.dir)
    .replaceAll("{{cwd}}", run.cwd)
    .replaceAll("{{instructions}}", def.body);
}

/**
 * Runs the routines in Sentinel's `routines/` folder on their cron schedules, while the daemon is up.
 * A scheduled time missed while the daemon was down (or the Mac asleep) still runs later the same day, once;
 * times from earlier days are never run.
 */
export class RoutineWatcher {
  private scans: RoutineScan[] = [];
  /** Last invalid-routine error notified per id, so each problem is reported once. */
  private reported = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private d: RoutineWatcherDeps) {}

  /** Runs `fn` after every earlier tick or manual run has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Rereads the routines folder and brings the `routines` table in line with it. */
  scan(): RoutineScan[] {
    const { store, log } = this.d;
    const now = this.d.now();
    this.scans = scanRoutines(this.d.routinesDir);
    const present = new Set(this.scans.map((s) => (s.ok ? s.def.id : s.id)));
    for (const s of this.scans) {
      if (!s.ok) {
        if (this.reported.get(s.id) !== s.error) {
          this.reported.set(s.id, s.error);
          log(`routine ${s.id} is invalid: ${s.error}`);
          this.d.notify?.({ event: "routineInvalid", title: `Routine ${s.id} can't run`, body: s.error, group: `routine:${s.id}` });
        }
        continue;
      }
      if (this.reported.delete(s.def.id)) log(`routine ${s.def.id} is valid again`);
      const row = store.getRoutine(s.def.id);
      if (!row) {
        store.insertRoutine({ id: s.def.id, dir: s.def.dir, name: s.def.name, now });
        log(`registered routine ${s.def.id} (${s.def.schedule})`);
      } else if (row.name !== s.def.name || row.dir !== s.def.dir) store.updateRoutine(s.def.id, { name: s.def.name, dir: s.def.dir });
    }
    for (const row of store.listRoutines()) {
      if (present.has(row.id)) continue;
      store.deleteRoutine(row.id);
      this.reported.delete(row.id);
      log(`routine ${row.id} was removed`);
    }
    return this.scans;
  }

  /** Rescans the folder and starts every run that is due. Returns the ids of routines whose run started. */
  tick(): Promise<string[]> {
    return this.serial(async () => {
      this.scan();
      if (!this.d.config().routines.enabled) return [];
      const started: string[] = [];
      for (const s of this.scans) {
        if (s.ok && (await this.consider(s.def))) started.push(s.def.id);
      }
      return started;
    });
  }

  /** Starts a run now, outside the schedule. Throws when it can't start right away. */
  runNow(id: string): Promise<RunOutcome> {
    return this.serial(async () => {
      this.scan();
      const s = this.scans.find((x) => (x.ok ? x.def.id : x.id) === id);
      if (!s) throw new Error(`No routine "${id}" in ${this.d.routinesDir}`);
      if (!s.ok) throw new Error(`Routine ${id} is invalid: ${s.error}`);
      const out = await this.launch(s.def, this.d.now(), true);
      if (out.result === "failed") throw new Error(out.message);
      return out;
    });
  }

  /** Decides whether a scheduled run is due now, and starts it. */
  private async consider(def: RoutineDef): Promise<boolean> {
    const { store } = this.d;
    const now = this.d.now();
    const row = store.getRoutine(def.id);
    if (!row) return false;
    let pending = row.pending_slot;
    if (pending !== null && !sameDay(pending, now)) {
      // A run that waited all day for a slot or for the previous run is dropped at midnight.
      const reason = `The ${formatSlot(pending)} run never got to start that day`;
      store.addRoutineRun({ routineId: def.id, slot: pending, manual: false, sessionId: null, now, status: "missed", reason });
      store.updateRoutine(def.id, { pending_slot: null, last_slot_run: pending, last_status: "missed", last_reason: reason });
      pending = null;
    }
    const slot = lastFireToday(def.cron, now);
    const fresh = slot !== null && slot > (row.last_slot_run ?? -Infinity) && slot > row.first_seen_at ? slot : null;
    if (!def.enabled) {
      // A disabled routine lets its times pass, so enabling it later doesn't run one from earlier today.
      if (fresh !== null || pending !== null) store.updateRoutine(def.id, { last_slot_run: fresh ?? pending, pending_slot: null, last_status: "waiting", last_reason: "Disabled" });
      return false;
    }
    const due = fresh !== null && (pending === null || fresh > pending) ? fresh : pending;
    if (due === null) return false;
    const retrying = due === pending && row.last_status === "spawn_failed" && row.last_attempt_at !== null;
    if (retrying && now - row.last_attempt_at! < ROUTINE_RETRY_MS) return false;
    return (await this.launch(def, due, false)).result === "delivered";
  }

  private async launch(def: RoutineDef, slot: number, manual: boolean): Promise<RunOutcome> {
    const { store, dispatcher, log } = this.d;
    const cfg = this.d.config().routines;
    const now = this.d.now();
    const row = store.getRoutine(def.id)!;
    const prev = row.session_id;
    /** For scheduled runs: this time counts as handled. Manual runs leave the schedule alone. */
    const handled = manual ? {} : { last_slot_run: slot, pending_slot: null };

    if (prev && dispatcher.isRunning(prev)) {
      const msg = `The previous run (session ${prev.slice(0, 8)}) is still running`;
      if (manual) return { result: "failed", sessionId: prev, message: msg };
      if (cfg.overlap === "queue") {
        if (row.pending_slot !== slot || row.last_status !== "queued") {
          store.updateRoutine(def.id, { pending_slot: slot, last_status: "queued", last_reason: `${msg}; the ${formatSlot(slot)} run waits for it` });
          log(`routine ${def.id}: ${formatSlot(slot)} run queued behind the previous run`);
        }
        return { result: "queued", sessionId: null, message: msg };
      }
      const reason = `${msg}; skipped the ${formatSlot(slot)} run`;
      store.addRoutineRun({ routineId: def.id, slot, manual, sessionId: null, now, status: "skipped", reason });
      store.updateRoutine(def.id, { ...handled, last_status: "skipped", last_reason: reason });
      log(`routine ${def.id}: ${reason}`);
      this.d.notify?.({ event: "routineSkipped", title: `Skipped routine ${def.name}`, body: reason, group: `routine:${def.id}` });
      return { result: "skipped", sessionId: null, message: reason };
    }

    if (dispatcher.atCapacity()) {
      const msg = "Waiting for a free agent slot (spawn.maxConcurrent)";
      if (manual) return { result: "failed", sessionId: null, message: "Every agent slot is busy (spawn.maxConcurrent); try again later" };
      if (row.pending_slot !== slot || row.last_status !== "queued") store.updateRoutine(def.id, { pending_slot: slot, last_status: "queued", last_reason: msg });
      return { result: "queued", sessionId: null, message: msg };
    }

    const model = def.model ?? cfg.model;
    const effort = def.effort ?? cfg.effort;
    let sessionId: string;
    if (cfg.session === "reuse" && prev && store.getSession(prev)) {
      sessionId = prev;
      store.updateSession(sessionId, { cwd: def.cwd, model, effort });
    } else {
      sessionId = crypto.randomUUID();
      store.ensureSession(sessionId, "claude", def.cwd, { model, effort, started: false });
    }
    const runId = store.addRoutineRun({ routineId: def.id, slot, manual, sessionId, now, status: "starting", reason: null });
    store.updateRoutine(def.id, { ...handled, session_id: sessionId, last_run_at: now, last_attempt_at: now, last_status: "starting", last_reason: null });

    let failure: string | null = null;
    const result = await dispatcher.runPrompt(
      sessionId,
      (session) => renderRoutinePrompt(cfg.promptTemplate, def, { slot, manual, cwd: session.cwd }),
      {
        onDelivered: () => {
          store.setRoutineRunStatus(runId, "started", "Agent started");
          store.updateRoutine(def.id, { last_status: "started", last_reason: "Agent started" });
        },
        onFailed: (msg) => {
          failure = msg;
        },
      },
    );
    if (result === "delivered") {
      log(`routine ${def.id}: started ${manual ? "a manual run" : `the ${formatSlot(slot)} run`} in session ${sessionId}`);
      this.d.notify?.({
        event: "routineStarted",
        title: `Routine started: ${def.name}`,
        subtitle: def.description || undefined,
        body: manual ? "Manual run" : `Scheduled for ${formatSlot(slot)}`,
        group: `routine:${def.id}`,
      });
      return { result: "delivered", sessionId, message: "Agent started" };
    }

    const msg = failure ?? `Session ${result}`;
    const retry = manual ? "" : `; retrying in ${ROUTINE_RETRY_MS / 60_000} min`;
    store.setRoutineRunStatus(runId, "spawn_failed", msg);
    store.updateRoutine(def.id, { ...(manual ? {} : { pending_slot: slot }), last_status: "spawn_failed", last_reason: `${msg}${retry}` });
    log(`routine ${def.id}: launch failed: ${msg}`);
    this.d.notify?.({ event: "routineFailed", title: `Routine ${def.name} didn't start`, body: `${msg}${retry}`, group: `routine:${def.id}` });
    return { result: "failed", sessionId, message: msg };
  }

  /** Every routine directory, valid or not, with its state. Uses the last scan. */
  list(): RoutineListEntry[] {
    const { store } = this.d;
    const now = this.d.now();
    const on = this.d.config().routines.enabled;
    return this.scans.map((s): RoutineListEntry => {
      const id = s.ok ? s.def.id : s.id;
      const row = store.getRoutine(id);
      const session = row?.session_id ? store.getSession(row.session_id) : null;
      const base = { id, dir: s.ok ? s.def.dir : s.dir, row, runs: row ? store.routineRuns(id, 5) : [], session };
      if (!s.ok)
        return { ...base, valid: false, error: s.error, name: id, description: "", schedule: "", model: null, effort: null, cwd: null, enabled: false, nextRunAt: null };
      const def = s.def;
      return {
        ...base,
        valid: true,
        error: null,
        name: def.name,
        description: def.description,
        schedule: def.schedule,
        model: def.model,
        effort: def.effort,
        cwd: def.cwd,
        enabled: def.enabled,
        nextRunAt: on && def.enabled ? nextFire(def.cron, now) : null,
      };
    });
  }

  /** The earliest next run over every routine. */
  nextRunAt(): number | null {
    const times = this.list()
      .map((r) => r.nextRunAt)
      .filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }
}
