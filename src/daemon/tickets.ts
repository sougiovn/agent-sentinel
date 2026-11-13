import type { Config } from "../core/config.ts";
import type { Store } from "../core/db.ts";
import { expandHome } from "../core/repo-locate.ts";
import { renderTicketPrompt } from "../evaluator/prompt.ts";
import { ticketJql, type JiraClient, type Ticket } from "../jira/acli.ts";
import type { Dispatcher } from "../spawn/dispatcher.ts";

export interface TicketWatcherDeps {
  store: Store;
  jira: JiraClient;
  dispatcher: Dispatcher;
  config: () => Config;
  now: () => number;
  log: (msg: string) => void;
}

export interface TicketPollResult {
  /** Ticket keys the search returned. */
  found: string[];
  /** Ticket keys whose agent session started during this poll. */
  started: string[];
}

/**
 * Picks up open Jira tickets assigned to the user that carry the configured label, and starts one new
 * agent session per ticket. A ticket gets a session once; its row in `tickets` remembers that.
 */
export class TicketWatcher {
  constructor(private d: TicketWatcherDeps) {}

  async poll(): Promise<TicketPollResult> {
    const cfg = this.d.config().jira;
    if (!cfg.enabled) return { found: [], started: [] };
    const tickets = await this.d.jira.search(ticketJql(cfg));
    const started: string[] = [];
    for (const t of tickets) {
      if (await this.pickUp(t)) started.push(t.key);
    }
    return { found: tickets.map((t) => t.key), started };
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
    } catch (e) {
      const msg = `PR ${url} handed off, but moving the ticket to ${cfg.reviewStatus} failed: ${(e as Error).message}`;
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
      } catch (e) {
        const msg = `Agent started, but moving the ticket to ${cfg.transitionTo} failed: ${(e as Error).message}`;
        store.setTicketStatus(t.key, "transition_failed", msg);
        log(`${t.key}: ${msg}`);
      }
    }
    return true;
  }
}
