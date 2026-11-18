import type { Config } from "../core/config.ts";
import type { Store } from "../core/db.ts";
import { expandHome } from "../core/repo-locate.ts";
import { renderTicketPrompt } from "../evaluator/prompt.ts";
import { keysJql, ticketJql, type JiraClient, type Ticket } from "../jira/acli.ts";
import type { Dispatcher } from "../spawn/dispatcher.ts";
import type { Notification } from "../notify/notifier.ts";
import type { TicketRow } from "../core/types.ts";

export interface TicketWatcherDeps {
  store: Store;
  jira: JiraClient;
  dispatcher: Dispatcher;
  config: () => Config;
  now: () => number;
  log: (msg: string) => void;
  /** Tells the user about something that happened; never throws. */
  notify?: (n: Notification) => void;
}

export interface TicketPollResult {
  /** Ticket keys the search returned. */
  found: string[];
  /** Ticket keys whose agent session started during this poll. */
  started: string[];
  /** Tracked ticket keys found in one of `jira.finalStatuses` during this poll, now marked done. */
  finished: string[];
}

/**
 * Picks up open Jira tickets assigned to the user that carry the configured label, and starts one new
 * agent session per ticket. A ticket gets a session once; its row in `tickets` remembers that.
 */
export class TicketWatcher {
  constructor(private d: TicketWatcherDeps) {}

  private notifyMoved(t: Pick<TicketRow, "key" | "url" | "summary">, status: string, why: string) {
    this.d.notify?.({
      event: "ticketTransitioned",
      title: `${t.key} moved to ${status}`,
      subtitle: t.summary ?? undefined,
      body: why,
      url: t.url,
      group: `ticket:${t.key}`,
    });
  }

  async poll(): Promise<TicketPollResult> {
    const cfg = this.d.config().jira;
    if (!cfg.enabled) return { found: [], started: [], finished: [] };
    const tickets = await this.d.jira.search(ticketJql(cfg));
    const started: string[] = [];
    for (const t of tickets) {
      if (await this.pickUp(t)) started.push(t.key);
    }
    const found = tickets.map((t) => t.key);
    const finished = await this.syncFinished(new Set(found));
    return { found, started, finished };
  }

  /**
   * Tracked tickets that dropped out of the search may have reached a final status in Jira (moved there by
   * hand, or by Jira automation). Marks those done and stops watching the PR they handed off.
   */
  private async syncFinished(found: Set<string>): Promise<string[]> {
    const { store, log } = this.d;
    const final = new Set(this.d.config().jira.finalStatuses.map((s) => s.toLowerCase()));
    const open = store.listTickets().filter((t) => t.last_status !== "done" && !found.has(t.key));
    if (!open.length || !final.size) return [];
    const current = await this.d.jira.search(keysJql(open.map((t) => t.key)));
    const finished: string[] = [];
    for (const t of current) {
      const row = open.find((r) => r.key === t.key);
      if (!row || !final.has(t.status.toLowerCase())) continue;
      store.setTicketStatus(t.key, "done", `Ticket is ${t.status} in Jira`);
      const watched = !!row.pr_id && !!store.getPr(row.pr_id);
      if (watched) {
        store.deletePr(row.pr_id!);
        log(`${t.key} is ${t.status}; stopped watching ${row.pr_id}`);
      } else log(`${t.key} is ${t.status}; marked done`);
      this.d.notify?.({
        event: "ticketDone",
        title: `${t.key} is ${t.status}`,
        subtitle: row.summary ?? undefined,
        body: watched ? `No longer tracked; stopped watching ${row.pr_id}` : "No longer tracked",
        url: row.url,
        group: `ticket:${t.key}`,
      });
      finished.push(t.key);
    }
    return finished;
  }

  /**
   * A ticket's session handed off a PR (`sentinel watch` in pr-watch mode): remember the PR and move the
   * ticket to `jira.reviewStatus`, once. Sessions that don't belong to a ticket are ignored.
   */
  async prHandedOff(sessionId: string, prIds: string[]): Promise<void> {
    const { store, log } = this.d;
    const cfg = this.d.config().jira;
    const ticket = store.ticketForSession(sessionId);
    const prId = prIds[0];
    if (!cfg.enabled || !ticket || !prId) return;
    const url = store.getPr(prId)?.url ?? prId;
    if (ticket.pr_id !== prId) store.setTicketPr(ticket.key, prId);
    if (ticket.last_status === "in_review") return;
    if (!cfg.reviewStatus) {
      store.setTicketStatus(ticket.key, "started", `PR handed off: ${url}`);
      return;
    }
    try {
      await this.d.jira.transition(ticket.key, cfg.reviewStatus);
      store.setTicketStatus(ticket.key, "in_review", `PR ${url} handed off; moved to ${cfg.reviewStatus}`);
      log(`${ticket.key}: PR ${prId} handed off, moved to ${cfg.reviewStatus}`);
      this.notifyMoved(ticket, cfg.reviewStatus, `The agent opened ${url}`);
    } catch (e) {
      const msg = `PR ${url} handed off, but moving the ticket to ${cfg.reviewStatus} failed: ${(e as Error).message}`;
      store.setTicketStatus(ticket.key, "transition_failed", msg);
      log(`${ticket.key}: ${msg}`);
    }
  }

  /**
   * The PR a ticket's session handed off was merged (move the ticket to `jira.mergedStatus`) or closed without
   * merging (move it back to `jira.closedStatus`). PRs that don't belong to a ticket are ignored.
   */
  async prClosed(prId: string, state: "MERGED" | "CLOSED"): Promise<void> {
    const { store, log } = this.d;
    const cfg = this.d.config().jira;
    const ticket = store.ticketForPr(prId);
    if (!cfg.enabled || !ticket) return;
    const url = store.getPr(prId)?.url ?? prId;
    const merged = state === "MERGED";
    const target = merged ? cfg.mergedStatus : cfg.closedStatus;
    const what = merged ? `PR ${url} merged` : `PR ${url} closed without merging`;
    const next = merged ? "done" : "started";
    if (!target) {
      store.setTicketStatus(ticket.key, next, what);
      return;
    }
    try {
      await this.d.jira.transition(ticket.key, target);
      store.setTicketStatus(ticket.key, next, `${what}; moved to ${target}`);
      log(`${ticket.key}: ${what}, moved to ${target}`);
      if (merged) {
        this.d.notify?.({
          event: "ticketDone",
          title: `${ticket.key} moved to ${target}`,
          subtitle: ticket.summary ?? undefined,
          body: `${what}; no longer tracked`,
          url: ticket.url,
          group: `ticket:${ticket.key}`,
        });
      } else this.notifyMoved(ticket, target, what);
    } catch (e) {
      const msg = `${what}, but moving the ticket to ${target} failed: ${(e as Error).message}`;
      store.setTicketStatus(ticket.key, "transition_failed", msg);
      log(`${ticket.key}: ${msg}`);
    }
  }

  /** Records a new ticket and starts its session; retries tickets whose session never started. */
  private async pickUp(t: Ticket): Promise<boolean> {
    const { store, dispatcher, log } = this.d;
    const cfg = this.d.config().jira;
    let row = store.getTicket(t.key);
    if (!row) {
      store.insertTicket({
        key: t.key,
        url: t.url,
        summary: t.summary,
        sessionId: crypto.randomUUID(),
        cwd: expandHome(cfg.cwd),
        now: this.d.now(),
        session: { model: cfg.model, effort: cfg.effort, started: false },
      });
      log(`picked up Jira ticket ${t.key}`);
      row = store.getTicket(t.key)!;
      this.d.notify?.({
        event: "ticketFound",
        title: `New Jira ticket: ${t.key}`,
        subtitle: t.summary,
        body: dispatcher.atCapacity() ? "Waiting for a free agent slot" : "Starting an agent session for it",
        url: t.url,
        group: `ticket:${t.key}`,
      });
    } else if (row.summary !== t.summary) store.setTicketSummary(t.key, t.summary);

    if (row.dismissed) return false;
    if (row.last_status !== "queued" && row.last_status !== "spawn_failed") return false;
    if (dispatcher.atCapacity()) {
      store.setTicketStatus(t.key, "queued", "Waiting for a free agent slot (spawn.maxConcurrent)");
      return false;
    }

    let delivered = false;
    const result = await dispatcher.startSession(
      row.session_id,
      {},
      (session) =>
        renderTicketPrompt(cfg.promptTemplate, {
          key: t.key,
          url: t.url,
          summary: t.summary,
          description: t.description,
          cwd: session.cwd,
          mode: cfg.mode,
        }),
      {
        onDelivered: () => {
          delivered = true;
          store.setTicketStatus(t.key, "started", "Agent started");
        },
        onFailed: (msg) => store.setTicketStatus(t.key, "spawn_failed", msg),
      },
    );
    if (result === "paused") store.setTicketStatus(t.key, "queued", "Session paused");
    if (!delivered) return false;

    if (cfg.transitionTo && t.status.toLowerCase() !== cfg.transitionTo.toLowerCase()) {
      try {
        await this.d.jira.transition(t.key, cfg.transitionTo);
        store.setTicketStatus(t.key, "started", `Agent started; moved to ${cfg.transitionTo}`);
        this.notifyMoved(t, cfg.transitionTo, "An agent session started working on it");
      } catch (e) {
        const msg = `Agent started, but moving the ticket to ${cfg.transitionTo} failed: ${(e as Error).message}`;
        store.setTicketStatus(t.key, "transition_failed", msg);
        log(`${t.key}: ${msg}`);
      }
    }
    return true;
  }
}
