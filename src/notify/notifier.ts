import type { Exec } from "../core/exec.ts";

/** Things Sentinel tells the user about while it works in the background. Keys of `notifications.events`. */
export const NOTIFY_EVENTS = [
  "prWatched",
  "ticketFound",
  "ticketTransitioned",
  "ticketDone",
  "mergeConflict",
  "fixNeeded",
  "humanComments",
  "routineStarted",
  "routineSkipped",
  "routineFailed",
  "routineInvalid",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** How each event is named in the settings dialog. */
export const NOTIFY_EVENT_LABELS: Record<NotifyEvent, string> = {
  prWatched: "PR handed off to watch",
  ticketFound: "New Jira ticket picked up",
  ticketTransitioned: "Ticket moved to a new status",
  ticketDone: "Ticket done or cancelled",
  mergeConflict: "PR has a merge conflict",
  fixNeeded: "Feedback sent to the agent",
  humanComments: "New human comments",
  routineStarted: "Routine run started",
  routineSkipped: "Routine run skipped (previous run still going)",
  routineFailed: "Routine run failed to start",
  routineInvalid: "Routine file is invalid",
};

export const NOTIFY_METHODS = ["auto", "terminal-notifier", "osascript"] as const;
export type NotifyMethod = (typeof NOTIFY_METHODS)[number];

/** What a notification shows. */
export interface NotificationContent {
  title: string;
  /** Shown under the title, e.g. the PR or ticket it is about. */
  subtitle?: string;
  body: string;
  /** Opened when the notification is clicked (terminal-notifier only). */
  url?: string;
  /** Notifications with the same group replace each other (terminal-notifier only). */
  group?: string;
}

/** A notification about one of the daemon's {@link NotifyEvent}s, which can each be switched off. */
export interface Notification extends NotificationContent {
  event: NotifyEvent;
}

/** Sends one notification. Throws when the notifier couldn't be run. */
export type SendNotification = (n: NotificationContent) => Promise<void>;

const TIMEOUT_MS = 10_000;
const MAX_BODY = 240;

/** Notification text can't hold newlines nicely, and long bodies are cut by macOS anyway. */
export function oneLine(s: string, max = MAX_BODY): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * macOS notifications. `terminal-notifier` (Homebrew) is preferred: it is its own app, so macOS asks once
 * for permission, and clicking a notification opens its PR or ticket. `osascript` needs no install, but its
 * notifications belong to Script Editor, which must be allowed in System Settings → Notifications.
 */
export class MacNotifier {
  private resolved: Promise<"terminal-notifier" | "osascript"> | null = null;

  constructor(
    private run: Exec,
    private method: () => NotifyMethod,
  ) {}

  private backend(): Promise<"terminal-notifier" | "osascript"> {
    const m = this.method();
    if (m !== "auto") return Promise.resolve(m);
    this.resolved ??= this.run(["which", "terminal-notifier"], { timeoutMs: TIMEOUT_MS })
      .then((r) => (r.code === 0 ? ("terminal-notifier" as const) : ("osascript" as const)))
      .catch(() => "osascript" as const);
    return this.resolved;
  }

  send: SendNotification = async (n) => {
    const backend = await this.backend();
    const body = oneLine(n.body);
    const cmd =
      backend === "terminal-notifier"
        ? [
            "terminal-notifier",
            "-title",
            n.title,
            ...(n.subtitle ? ["-subtitle", oneLine(n.subtitle, 120)] : []),
            "-message",
            // terminal-notifier reads a message starting with these as an option or as stdin.
            /^[-\[]/.test(body) ? ` ${body}` : body,
            ...(n.url ? ["-open", n.url] : []),
            ...(n.group ? ["-group", n.group] : []),
          ]
        : [
            "osascript",
            "-e",
            "on run argv",
            "-e",
            "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
            "-e",
            "end run",
            body,
            n.title,
            oneLine(n.subtitle ?? "", 120),
          ];
    const r = await this.run(cmd, { timeoutMs: TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`${backend} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  };
}
