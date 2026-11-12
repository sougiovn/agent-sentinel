import { Database } from "bun:sqlite";
import type { AgentKind, EventRow, Item, PrRow, PrStatus, SessionOptions, SessionRow } from "./types.ts";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE prs (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    last_status TEXT NOT NULL DEFAULT 'pending',
    last_reason TEXT
  );
  CREATE TABLE seen_items (
    pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (pr_id, item_id)
  );
  CREATE TABLE pending_items (
    pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pr_id, item_id)
  );
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    cwd TEXT NOT NULL,
    mux TEXT,
    pane_id TEXT,
    tab_id TEXT,
    state TEXT NOT NULL DEFAULT 'idle',
    paused INTEGER NOT NULL DEFAULT 0,
    agent_running INTEGER NOT NULL DEFAULT 0,
    busy_since INTEGER,
    last_signal_at INTEGER
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX events_pr ON events(pr_id, id);
  `,
  `
  ALTER TABLE sessions ADD COLUMN model TEXT;
  ALTER TABLE sessions ADD COLUMN effort TEXT;
  ALTER TABLE sessions ADD COLUMN started INTEGER NOT NULL DEFAULT 1;
  `,
  `
  ALTER TABLE prs ADD COLUMN title TEXT;
  `,
];

export const EVENTS_PER_PR = 50;

export interface PendingItem {
  prId: string;
  item: Item;
  reason: string | null;
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    let version = row ? Number(row.value) : 0;
    while (version < MIGRATIONS.length) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        version++;
        this.db
          .query("INSERT INTO meta (key, value) VALUES ('schema_version', $v) ON CONFLICT(key) DO UPDATE SET value = $v")
          .run({ v: String(version) });
      })();
    }
  }

  close() {
    this.db.close();
  }

  getMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db
      .query("INSERT INTO meta (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v")
      .run({ k: key, v: value });
  }

  // ---- PRs ----

  /** Inserts or replaces the owner of a PR. Returns true if the PR is new. */
  upsertPr(p: {
    id: string;
    url: string;
    agent: AgentKind;
    sessionId: string;
    cwd: string;
    now: number;
    session?: SessionOptions;
  }): boolean {
    const existing = this.getPr(p.id);
    if (existing) {
      this.db
        .query("UPDATE prs SET agent = $agent, session_id = $sid, cwd = $cwd WHERE id = $id")
        .run({ id: p.id, agent: p.agent, sid: p.sessionId, cwd: p.cwd });
      this.db.query("UPDATE pending_items SET session_id = $sid WHERE pr_id = $id").run({ id: p.id, sid: p.sessionId });
    } else {
      this.db
        .query(
          "INSERT INTO prs (id, url, agent, session_id, cwd, registered_at) VALUES ($id, $url, $agent, $sid, $cwd, $now)",
        )
        .run({ id: p.id, url: p.url, agent: p.agent, sid: p.sessionId, cwd: p.cwd, now: p.now });
    }
    this.ensureSession(p.sessionId, p.agent, p.cwd, p.session);
    this.pruneSessions();
    return !existing;
  }

  getPr(id: string): PrRow | null {
    return this.db.query<PrRow, { id: string }>("SELECT * FROM prs WHERE id = $id").get({ id });
  }

  listPrs(): PrRow[] {
    return this.db.query<PrRow, []>("SELECT * FROM prs ORDER BY registered_at").all();
  }

  prsForSession(sessionId: string): PrRow[] {
    return this.db.query<PrRow, { s: string }>("SELECT * FROM prs WHERE session_id = $s").all({ s: sessionId });
  }

  setPrTitle(id: string, title: string) {
    this.db.query("UPDATE prs SET title = $t WHERE id = $id").run({ id, t: title });
  }

  setPrStatus(id: string, status: PrStatus, reason: string | null, checkedAt?: number) {
    if (checkedAt !== undefined) {
      this.db
        .query("UPDATE prs SET last_status = $st, last_reason = $r, last_checked_at = $t WHERE id = $id")
        .run({ id, st: status, r: reason, t: checkedAt });
    } else {
      this.db.query("UPDATE prs SET last_status = $st, last_reason = $r WHERE id = $id").run({ id, st: status, r: reason });
    }
  }

  deletePr(id: string) {
    this.db.query("DELETE FROM prs WHERE id = $id").run({ id });
    this.pruneSessions();
  }

  // ---- seen items ----

  seenIds(prId: string): Set<string> {
    const rows = this.db.query<{ item_id: string }, { p: string }>("SELECT item_id FROM seen_items WHERE pr_id = $p").all({ p: prId });
    return new Set(rows.map((r) => r.item_id));
  }

  markSeen(prId: string, items: Pick<Item, "id" | "kind">[]) {
    const q = this.db.query("INSERT OR IGNORE INTO seen_items (pr_id, item_id, kind) VALUES ($p, $i, $k)");
    this.db.transaction(() => {
      for (const it of items) q.run({ p: prId, i: it.id, k: it.kind });
    })();
  }

  unmarkSeen(prId: string, itemIds: string[]) {
    const q = this.db.query("DELETE FROM seen_items WHERE pr_id = $p AND item_id = $i");
    this.db.transaction(() => {
      for (const id of itemIds) q.run({ p: prId, i: id });
    })();
  }

  // ---- pending (queued for delivery) ----

  addPending(prId: string, sessionId: string, items: Item[], reason: string | null, now: number) {
    const q = this.db.query(
      "INSERT OR REPLACE INTO pending_items (pr_id, item_id, session_id, payload, reason, created_at) VALUES ($p, $i, $s, $pl, $r, $t)",
    );
    this.db.transaction(() => {
      for (const it of items) q.run({ p: prId, i: it.id, s: sessionId, pl: JSON.stringify(it), r: reason, t: now });
    })();
  }

  pendingForSession(sessionId: string): PendingItem[] {
    return this.db
      .query<{ pr_id: string; payload: string; reason: string | null }, { s: string }>(
        "SELECT pr_id, payload, reason FROM pending_items WHERE session_id = $s ORDER BY created_at, pr_id",
      )
      .all({ s: sessionId })
      .map((r) => ({ prId: r.pr_id, item: JSON.parse(r.payload) as Item, reason: r.reason }));
  }

  sessionsWithPending(): string[] {
    return this.db
      .query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM pending_items")
      .all()
      .map((r) => r.session_id);
  }

  clearPending(sessionId: string) {
    this.db.query("DELETE FROM pending_items WHERE session_id = $s").run({ s: sessionId });
  }

  // ---- sessions ----

  /** Creates or updates a session. Model and effort are only touched when `opts` is given. */
  ensureSession(sessionId: string, agent: AgentKind, cwd: string, opts?: SessionOptions) {
    this.db
      .query(
        `INSERT INTO sessions (session_id, agent, cwd, started) VALUES ($s, $a, $c, $st)
         ON CONFLICT(session_id) DO UPDATE SET agent = $a, cwd = $c`,
      )
      .run({ s: sessionId, a: agent, c: cwd, st: opts?.started === false ? 0 : 1 });
    if (opts) this.updateSession(sessionId, { model: opts.model ?? null, effort: opts.effort ?? null });
  }

  getSession(sessionId: string): SessionRow | null {
    return this.db.query<SessionRow, { s: string }>("SELECT * FROM sessions WHERE session_id = $s").get({ s: sessionId });
  }

  listSessions(): SessionRow[] {
    return this.db.query<SessionRow, []>("SELECT * FROM sessions").all();
  }

  updateSession(sessionId: string, patch: Partial<Omit<SessionRow, "session_id">>) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = $${k}`).join(", ");
    this.db.query(`UPDATE sessions SET ${sets} WHERE session_id = $session_id`).run({ ...patch, session_id: sessionId } as never);
  }

  private pruneSessions() {
    this.db.exec("DELETE FROM sessions WHERE session_id NOT IN (SELECT session_id FROM prs)");
  }

  // ---- events ----

  addEvent(prId: string, kind: string, detail: unknown, now: number) {
    this.db.query("INSERT INTO events (pr_id, ts, kind, detail) VALUES ($p, $t, $k, $d)").run({
      p: prId,
      t: now,
      k: kind,
      d: detail === undefined ? null : JSON.stringify(detail),
    });
    this.db
      .query(
        `DELETE FROM events WHERE pr_id = $p AND id NOT IN (
           SELECT id FROM events WHERE pr_id = $p ORDER BY id DESC LIMIT ${EVENTS_PER_PR})`,
      )
      .run({ p: prId });
  }

  events(prId: string): EventRow[] {
    return this.db
      .query<{ id: number; pr_id: string; ts: number; kind: string; detail: string | null }, { p: string }>(
        "SELECT * FROM events WHERE pr_id = $p ORDER BY id DESC",
      )
      .all({ p: prId })
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
}
