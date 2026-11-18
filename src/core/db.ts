import { Database } from "bun:sqlite";
import type { AgentKind, EventRow, HumanCommentRow, Item, PrRow, PrStatus, SessionOptions, SessionRow, TicketRow, TicketStatus } from "./types.ts";

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
  `
  CREATE TABLE tickets (
    key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    summary TEXT,
    session_id TEXT NOT NULL,
    cwd TEXT NOT NULL,
    picked_at INTEGER NOT NULL,
    last_status TEXT NOT NULL,
    last_reason TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  ALTER TABLE tickets ADD COLUMN pr_id TEXT;
  `,
  `
  CREATE TABLE human_comments (
    pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    author TEXT,
    body TEXT NOT NULL,
    url TEXT,
    path TEXT,
    line INTEGER,
    created_at TEXT,
    first_seen_at INTEGER NOT NULL,
    gh_resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at INTEGER,
    delivered_at INTEGER,
    delivered_session TEXT,
    draft_requested_at INTEGER,
    draft_summary TEXT,
    draft_change TEXT,
    draft_reply TEXT,
    draft_at INTEGER,
    draft_by TEXT,
    PRIMARY KEY (pr_id, item_id)
  );
  `,
  `
  ALTER TABLE prs ADD COLUMN mergeable TEXT;
  ALTER TABLE prs ADD COLUMN base_ref TEXT;
  `,
  `
  ALTER TABLE sessions ADD COLUMN awaiting_ack_since INTEGER;
  ALTER TABLE sessions ADD COLUMN awaiting_ack TEXT;
  `,
  `
  ALTER TABLE prs ADD COLUMN eval_cost_usd REAL NOT NULL DEFAULT 0;
  ALTER TABLE prs ADD COLUMN eval_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN eval_cost_usd REAL NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN eval_count INTEGER NOT NULL DEFAULT 0;
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

  setPrMerge(id: string, mergeable: string, baseRef: string | null) {
    this.db.query("UPDATE prs SET mergeable = $m, base_ref = $b WHERE id = $id").run({ id, m: mergeable, b: baseRef });
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

  /**
   * Adds one evaluator run's cost to the PR and to the session that owned the PR at the time.
   * The session keeps its total even after the PR is merged or unwatched.
   */
  recordEvalCost(prId: string, sessionId: string, costUsd: number) {
    const c = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
    this.db.query("UPDATE prs SET eval_cost_usd = eval_cost_usd + $c, eval_count = eval_count + 1 WHERE id = $id").run({ c, id: prId });
    this.db
      .query("UPDATE sessions SET eval_cost_usd = eval_cost_usd + $c, eval_count = eval_count + 1 WHERE session_id = $s")
      .run({ c, s: sessionId });
  }

  private pruneSessions() {
    this.db.exec(
      "DELETE FROM sessions WHERE session_id NOT IN (SELECT session_id FROM prs UNION SELECT session_id FROM tickets)",
    );
  }

  // ---- Jira tickets ----

  getTicket(key: string): TicketRow | null {
    return this.db.query<TicketRow, { k: string }>("SELECT * FROM tickets WHERE key = $k").get({ k: key });
  }

  /** Records a picked-up ticket and creates the new session that will work it. */
  insertTicket(t: { key: string; url: string; summary: string; sessionId: string; cwd: string; now: number; session: SessionOptions }) {
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO tickets (key, url, summary, session_id, cwd, picked_at, last_status)
           VALUES ($k, $u, $s, $sid, $c, $t, 'queued')`,
        )
        .run({ k: t.key, u: t.url, s: t.summary, sid: t.sessionId, c: t.cwd, t: t.now });
      this.ensureSession(t.sessionId, "claude", t.cwd, t.session);
    })();
  }

  listTickets(opts: { includeDismissed?: boolean } = {}): TicketRow[] {
    const where = opts.includeDismissed ? "" : "WHERE dismissed = 0";
    return this.db.query<TicketRow, []>(`SELECT * FROM tickets ${where} ORDER BY picked_at`).all();
  }

  setTicketStatus(key: string, status: TicketStatus, reason: string | null) {
    this.db.query("UPDATE tickets SET last_status = $st, last_reason = $r WHERE key = $k").run({ k: key, st: status, r: reason });
  }

  ticketForSession(sessionId: string): TicketRow | null {
    return this.db.query<TicketRow, { s: string }>("SELECT * FROM tickets WHERE session_id = $s").get({ s: sessionId });
  }

  ticketForPr(prId: string): TicketRow | null {
    return this.db.query<TicketRow, { p: string }>("SELECT * FROM tickets WHERE pr_id = $p").get({ p: prId });
  }

  setTicketPr(key: string, prId: string) {
    this.db.query("UPDATE tickets SET pr_id = $p WHERE key = $k").run({ k: key, p: prId });
  }

  setTicketSummary(key: string, summary: string) {
    this.db.query("UPDATE tickets SET summary = $s WHERE key = $k").run({ k: key, s: summary });
  }

  /** Hides a ticket from the dashboard. The row stays, so Sentinel still won't pick the ticket up again. */
  dismissTicket(key: string): boolean {
    return this.db.query("UPDATE tickets SET dismissed = 1 WHERE key = $k").run({ k: key }).changes > 0;
  }

  // ---- human comments ----

  /**
   * Makes the PR's human comments match GitHub: adds new ones, refreshes body and thread resolution,
   * and drops deleted ones. Local state (drafts, the user's resolution) is kept.
   */
  /** Stores the PR's current human comments and drops deleted ones. Returns the comments it hadn't seen before. */
  syncHumanComments(prId: string, items: Item[], resolvedIds: Set<string>, now: number): Item[] {
    const upsert = this.db.query(
      `INSERT INTO human_comments (pr_id, item_id, kind, author, body, url, path, line, created_at, first_seen_at, gh_resolved)
       VALUES ($p, $i, $k, $a, $b, $u, $path, $line, $c, $now, $r)
       ON CONFLICT(pr_id, item_id) DO UPDATE SET body = $b, url = $u, path = $path, line = $line, gh_resolved = $r`,
    );
    const remove = this.db.query("DELETE FROM human_comments WHERE pr_id = $p AND item_id = $i");
    const keep = new Set(items.map((i) => i.id));
    const known = new Set(this.humanComments(prId).map((c) => c.item_id));
    const added = items.filter((i) => i.kind !== "check" && i.kind !== "merge_conflict" && !known.has(i.id));
    this.db.transaction(() => {
      for (const it of items) {
        if (it.kind === "check" || it.kind === "merge_conflict") continue;
        upsert.run({
          p: prId,
          i: it.id,
          k: it.kind,
          a: it.author ?? null,
          b: it.body ?? "",
          u: it.url ?? null,
          path: it.path ?? null,
          line: it.line ?? null,
          c: it.createdAt ?? null,
          now,
          r: resolvedIds.has(it.id) ? 1 : 0,
        });
      }
      for (const row of this.humanComments(prId)) if (!keep.has(row.item_id)) remove.run({ p: prId, i: row.item_id });
    })();
    return added;
  }

  humanComments(prId: string): HumanCommentRow[] {
    return this.db
      .query<HumanCommentRow, { p: string }>(
        "SELECT * FROM human_comments WHERE pr_id = $p ORDER BY created_at, first_seen_at, item_id",
      )
      .all({ p: prId });
  }

  getHumanComment(prId: string, itemId: string): HumanCommentRow | null {
    return this.db
      .query<HumanCommentRow, { p: string; i: string }>("SELECT * FROM human_comments WHERE pr_id = $p AND item_id = $i")
      .get({ p: prId, i: itemId });
  }

  /** Number of open human comments per PR id; PRs with none are absent. */
  openHumanCounts(): Map<string, number> {
    const rows = this.db
      .query<{ pr_id: string; n: number }, []>(
        "SELECT pr_id, COUNT(*) AS n FROM human_comments WHERE gh_resolved = 0 AND resolved_at IS NULL GROUP BY pr_id",
      )
      .all();
    return new Map(rows.map((r) => [r.pr_id, r.n]));
  }

  /** Records that these items reached a session, which now owes a draft for each human comment among them. */
  markHumanDelivered(prId: string, itemIds: string[], sessionId: string, now: number) {
    const q = this.db.query(
      `UPDATE human_comments SET delivered_at = $t, delivered_session = $s, draft_requested_at = NULL
       WHERE pr_id = $p AND item_id = $i`,
    );
    this.db.transaction(() => {
      for (const i of itemIds) q.run({ p: prId, i, s: sessionId, t: now });
    })();
  }

  setHumanDraft(
    prId: string,
    itemId: string,
    d: { summary: string | null; change: string | null; reply: string | null; by: "agent" | "user" },
    now: number,
  ): boolean {
    return (
      this.db
        .query(
          `UPDATE human_comments SET draft_summary = $s, draft_change = $c, draft_reply = $r, draft_at = $t, draft_by = $by
           WHERE pr_id = $p AND item_id = $i`,
        )
        .run({ p: prId, i: itemId, s: d.summary, c: d.change, r: d.reply, t: now, by: d.by }).changes > 0
    );
  }

  setHumanResolved(prId: string, itemId: string, resolved: boolean, now: number): boolean {
    return (
      this.db
        .query("UPDATE human_comments SET resolved_at = $t WHERE pr_id = $p AND item_id = $i")
        .run({ p: prId, i: itemId, t: resolved ? now : null }).changes > 0
    );
  }

  /**
   * Open human comments delivered to the session with no draft since that delivery,
   * that the agent hasn't been asked about yet.
   */
  missingDrafts(sessionId: string): HumanCommentRow[] {
    return this.db
      .query<HumanCommentRow, { s: string }>(
        `SELECT * FROM human_comments
         WHERE delivered_session = $s AND delivered_at IS NOT NULL
           AND (draft_at IS NULL OR draft_at < delivered_at)
           AND draft_requested_at IS NULL
           AND gh_resolved = 0 AND resolved_at IS NULL
         ORDER BY pr_id, item_id`,
      )
      .all({ s: sessionId });
  }

  markDraftRequested(rows: Pick<HumanCommentRow, "pr_id" | "item_id">[], now: number) {
    const q = this.db.query("UPDATE human_comments SET draft_requested_at = $t WHERE pr_id = $p AND item_id = $i");
    this.db.transaction(() => {
      for (const r of rows) q.run({ p: r.pr_id, i: r.item_id, t: now });
    })();
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
