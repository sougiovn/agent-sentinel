import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, type Config } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import type { EventRow, HumanCommentRow } from "../core/types.ts";
import { copyToClipboard } from "./clipboard.ts";
import type {
  MyPr,
  NewWatchDefaults,
  PrListEntry,
  RepoEntry,
  RepoView,
  RoutineListEntry,
  RpcMethod,
  RpcMethods,
  StatusInfo,
  TicketListEntry,
  WorktreeEntry,
} from "../daemon/protocol.ts";
import { Client } from "../cli/client.ts";
import { startDaemon as startDaemonProcess } from "../cli/daemon-control.ts";
import { openUrl as defaultOpenUrl } from "../cli/open-url.ts";
import { ago, draftState, humanCommentLocation, mergeLabel, prGroup, prLine, routineStatus, sortByGroup, when, type DraftState } from "../cli/format.ts";
import {
  buildSessionGroups,
  eventSummary,
  filterSessionGroups,
  formatUsd,
  historyPrIds,
  mergeHistory,
  MULTI_REPO_GROUP,
  sessionEvalCost,
  sessionLines,
  sessionState,
  sessionSummary,
  type SessionLine,
} from "./sessions.ts";
import { cycleField, displayField, FORM_FIELDS, initialForm, watchRequest, type NewWatchForm } from "./new-watch.ts";
import { filterPrs } from "./pr-filter.ts";
import type { ScrollBoxRenderable } from "@opentui/core";
import { filterRepos, repoLabel, tilde, worktreeLabel } from "./repo-labels.ts";
import { filterHints, fitHints, HELP_HINT, hintText, type Hint } from "./shortcuts.ts";
import { cycleEnum, displayValue, editText, FIELDS, filterFields, fullLabel, parseValue, SECTIONS, settingsRows, type Field, type SettingsRow } from "./settings.ts";
import { DEFAULT_THEME, loadTheme, statusColor, watchTheme, type DirWatcher, type Theme } from "./theme.ts";
import { dismissTrustAlert, isDirTrusted, trustAlertDismissed } from "../core/claude-trust.ts";

type View = "list" | "history" | "settings" | "pick-pr" | "new-watch" | "repos" | "routines";

/** The daemon RPC surface the TUI uses; tests pass one backed by an in-process daemon. */
export interface RpcClient {
  call<M extends RpcMethod>(method: M, params: RpcMethods[M][0], timeoutMs?: number): Promise<RpcMethods[M][1]>;
}

/** Most Jira ticket rows shown before the list scrolls. */

/** Most human comment rows shown in the PR details before the list scrolls. */
const HUMAN_ROWS = 6;

const STATE_LABEL: Record<DraftState, string> = {
  "not sent": "needs you",
  waiting: "agent working",
  "no draft": "⚠ no draft",
  drafted: "draft ready",
  resolved: "✓ resolved",
};

const STATE_HINT: Record<DraftState, string> = {
  "not sent": "Not sent to the agent (the evaluator found nothing to change). Reply yourself, then x to mark it resolved.",
  waiting: "The agent is working on it and will record a draft.",
  "no draft": "The agent stopped without recording a draft. Check its pane, or e to write the reply yourself.",
  drafted: "",
  resolved: "Resolved. x reopens it.",
};

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Waits a tick. Call it before focusing an input from a key handler, or the key that
 * opened the input is delivered to it too (typed in, or submitting it right away).
 */
const nextTick = () => new Promise((r) => setTimeout(r, 0));

function pad(s: string, n: number) {
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s.padEnd(n);
}

export interface AppProps {
  paths: Paths;
  /** Start the daemon on launch if it isn't running (default true). */
  autoStart?: boolean;
  /** Override how the daemon is started (tests). Resolves true if it was started. */
  start?: () => Promise<boolean>;
  /** Override the daemon client (tests). */
  client?: RpcClient;
  /** Override how URLs are opened in the browser (tests). */
  openUrl?: (url: string) => void;
  /** Override how text is copied to the clipboard (tests). */
  copy?: (text: string) => void;
  /** Override the event source for theme file changes (tests). */
  watchThemeDir?: DirWatcher;
  /** Override Claude Code's state file, read to tell whether the prompts folder is trusted (tests). */
  claudeConfigFile?: string;
}

export function App(props: AppProps) {
  const client: RpcClient = props.client ?? new Client(props.paths.socket);
  const renderer = useRenderer();
  const dims = useTerminalDimensions();

  const [view, setView] = createSignal<View>("list");
  const [prs, setPrs] = createSignal<PrListEntry[]>([]);
  const [status, setStatus] = createSignal<StatusInfo | null>(null);
  const [online, setOnline] = createSignal(true);
  const [listQuery, setListQuery] = createSignal("");
  /** The sessions filter input has focus. */
  const [listFiltering, setListFiltering] = createSignal(false);
  const [tickets, setTickets] = createSignal<TicketListEntry[]>([]);
  const [confirmDismiss, setConfirmDismiss] = createSignal(false);
  /** Key of the selected line in the sessions view; kept across refreshes. */
  const [lineKey, setLineKey] = createSignal<string | null>(null);
  const [routines, setRoutines] = createSignal<RoutineListEntry[]>([]);
  /** Index into `routines()` in the routines view. */
  const [routineSel, setRoutineSel] = createSignal(0);
  const selectedRoutine = () => routines()[routineSel()];
  const shownGroups = () => filterSessionGroups(buildSessionGroups(prs(), tickets(), routines()), listQuery());
  /** Something is shown in the sessions view. */
  const hasSessions = () => prs().length > 0 || tickets().length > 0 || routines().some((r) => r.session);
  const lines = () => sessionLines(shownGroups());
  const lineIndex = () => Math.max(0, lines().findIndex((l) => l.key === lineKey()));
  const currentLine = (): SessionLine | undefined => lines()[lineIndex()];
  const moveLine = (d: number) => {
    const ls = lines();
    setLineKey(ls[Math.min(ls.length - 1, Math.max(0, lineIndex() + d))]?.key ?? null);
  };
  const currentTicket = () => {
    const l = currentLine();
    return l?.kind === "ticket" ? l.ticket : undefined;
  };
  const currentRoutine = () => {
    const l = currentLine();
    return l?.kind === "routine" ? l.routine : undefined;
  };
  /** The session whose own line is selected in the sessions view. */
  const selectedSession = () => {
    const l = currentLine();
    return l?.kind === "session" ? l.entry : undefined;
  };
  /** The sessions view's details pane is expanded to half the page (enter toggles it). */
  const [sessionDetails, setSessionDetails] = createSignal(false);
  /** Events of every PR of the session shown in the expanded details pane, by PR id. */
  const [sessionEvents, setSessionEvents] = createSignal<Record<string, EventRow[]>>({});
  const detailsOpen = () => sessionDetails() && !!currentLine();
  /** The PRs whose events the details pane loads; a string so moving inside one session doesn't reload. */
  const detailsPrKey = createMemo(() => (detailsOpen() ? currentLine()!.entry.prs.map((p) => p.id).join(" ") : ""));
  const loadSessionEvents = async (ids: string[]) => {
    const evs = await Promise.all(ids.map((id) => client.call("history", { pr: id }).catch(() => [] as EventRow[])));
    if (ids.join(" ") === detailsPrKey()) setSessionEvents(Object.fromEntries(ids.map((id, i) => [id, evs[i]!])));
  };
  createEffect(() => {
    const key = detailsPrKey();
    setSessionEvents({});
    if (key) void loadSessionEvents(key.split(" "));
  });
  /** The details pane's history: the selected PR's, a ticket's handed-off PR's, or the whole session's. */
  const detailsHistory = () => {
    const l = currentLine();
    if (!l) return [];
    const ids = new Set(historyPrIds(l));
    const all = sessionEvents();
    return mergeHistory(Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
  };
  /** A ticket has the selection, so the ticket keys apply. */
  const ticketActive = () => currentLine()?.kind === "ticket";
  const [history, setHistory] = createSignal<EventRow[]>([]);
  /** Human comments of the PR whose details are open; open ones first. */
  const [humans, setHumans] = createSignal<HumanCommentRow[]>([]);
  const [humanSel, setHumanSel] = createSignal(0);
  const selectedHuman = () => humans()[humanSel()];
  const humanTotal = () => prs().reduce((n, p) => n + (p.humanOpen ?? 0), 0);
  const [flash, setFlash] = createSignal<{ text: string; error: boolean } | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [config, setConfig] = createSignal<Config | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
  const [theme, setTheme] = createSignal<Theme>(DEFAULT_THEME);
  const [themeError, setThemeError] = createSignal<string | null>(null);
  const [fieldSel, setFieldSel] = createSignal(0);
  const [settingsQuery, setSettingsQuery] = createSignal("");
  /** The settings filter input has focus. */
  const [settingsFiltering, setSettingsFiltering] = createSignal(false);
  /** Index into SECTIONS of the settings tab being shown. */
  const [settingsTab, setSettingsTab] = createSignal(0);
  const shownFields = () => filterFields(FIELDS.filter((f) => f.section === SECTIONS[settingsTab()]), settingsQuery());
  const selectedField = () => shownFields()[fieldSel()];
  const [editing, setEditing] = createSignal<string | null>(null);

  // "watch a PR" picker and form
  const [myPrs, setMyPrs] = createSignal<MyPr[] | null>(null);
  const [myPrsError, setMyPrsError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [pickSel, setPickSel] = createSignal(0);
  const [defaults, setDefaults] = createSignal<NewWatchDefaults | null>(null);
  const [form, setForm] = createSignal<NewWatchForm | null>(null);
  const [formSel, setFormSel] = createSignal(0);
  const [formEditing, setFormEditing] = createSignal<"cwd" | "model" | null>(null);
  const [formMsg, setFormMsg] = createSignal<{ text: string; error: boolean } | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  /** Path whose remote-mismatch warning the user has already seen; a second enter goes ahead. */
  let warnedPath: string | null = null;
  let formDraft = "";
  const filtered = () => filterPrs(myPrs() ?? [], query());

  // repos view
  const [repoView, setRepoView] = createSignal<RepoView | null>(null);
  const [repoError, setRepoError] = createSignal<string | null>(null);
  const [repoLoading, setRepoLoading] = createSignal(false);
  /** Index into `allWorktrees()`, i.e. the n-th worktree shown. */
  const [repoSel, setRepoSel] = createSignal(0);
  const [repoQuery, setRepoQuery] = createSignal("");
  /** The repos filter input has focus. */
  const [repoFiltering, setRepoFiltering] = createSignal(false);
  /** Repos and worktrees after the `/` filter. */
  const shownRepos = () =>
    filterRepos(repoView()?.repos ?? [], repoQuery(), {
      pr: (id) => {
        const pr = prById(id);
        return pr ? `${prLine(pr)} ${pr.last_status}` : id;
      },
      ticket: (key) => {
        const t = ticketByKey(key);
        return t ? `${key} ${t.summary ?? ""} ${t.last_status}` : key;
      },
    });
  const allWorktrees = () => shownRepos().flatMap((r) => r.worktrees);
  const worktreeIndex = () => new Map(allWorktrees().map((w, i) => [w, i]));
  const selectedWorktree = () => allWorktrees()[repoSel()];
  let repoScroll: ScrollBoxRenderable | undefined;
  let sessionScroll: ScrollBoxRenderable | undefined;
  let detailsScroll: ScrollBoxRenderable | undefined;
  createEffect(() => {
    const i = lineIndex();
    if (view() === "list") sessionScroll?.scrollChildIntoView(`sess-line-${i}`, { align: "nearest" });
  });
  createEffect(() => {
    const i = repoSel();
    shownRepos();
    if (view() === "repos" && repoView()) repoScroll?.scrollChildIntoView(`repo-wt-${i}`, { align: "nearest" });
  });
  const prById = (id: string) => prs().find((p) => p.id === id);
  const ticketByKey = (key: string) => tickets().find((t) => t.key === key);

  /** The `?` shortcuts dialog is open. */
  const [helpOpen, setHelpOpen] = createSignal(false);
  /**
   * The dialog's `/` filter. Typed by the key handler rather than an `<input>`, so a filter input
   * focused under the dialog keeps its focus.
   */
  const [helpQuery, setHelpQuery] = createSignal("");
  const [helpFiltering, setHelpFiltering] = createSignal(false);
  let helpScroll: ScrollBoxRenderable | undefined;

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (text: string, error = false) => {
    setFlash({ text, error });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(null), 5000);
  };

  /** Opens the session in the multiplexer and focuses it, so the user can talk to the agent in its worktree. */
  const goToAgent = async (sessionId: string | undefined, what: string) => {
    if (!sessionId) {
      notify(`${what} has no agent session yet`, true);
      return;
    }
    try {
      const r = await client.call("goToAgent", { sessionId }, 30_000);
      const verb = r.how === "focused" ? "Went to" : r.how === "resumed" ? "Resumed" : "Reopened";
      notify(r.warning ? `${verb} ${what}'s agent, but ${r.warning}` : `${verb} ${what}'s agent`, !!r.warning);
    } catch (e) {
      notify(`Could not go to ${what}'s agent: ${(e as Error).message}`, true);
    }
    await refresh();
  };

  /** Starts a routine run now, outside its schedule. */
  const runRoutine = async (r: RoutineListEntry | undefined) => {
    if (!r) return;
    if (!r.valid) {
      notify(`${r.id} is invalid: ${r.error}`, true);
      return;
    }
    notify(`Starting routine ${r.id}…`);
    try {
      const out = await client.call("runRoutine", { id: r.id }, 120_000);
      notify(out.result === "delivered" ? `Started routine ${r.id}` : `${r.id}: ${out.message}`, out.result !== "delivered");
    } catch (e) {
      const msg = (e as Error).message;
      notify(msg.startsWith("Unknown method") ? "The running daemon is older than this dashboard. Run `sentinel restart`." : `Could not run ${r.id}: ${msg}`, true);
    }
    await refresh();
  };

  const refresh = async () => {
    try {
      const [st, list] = await Promise.all([client.call("status", {}, 3000), client.call("list", {}, 3000)]);
      setStatus(st);
      const detailsId = current()?.id;
      setPrs(sortByGroup(list));
      setOnline(true);
      // An older daemon has no ticket support; treat that as no tickets.
      const ts = await client.call("tickets", {}, 3000).catch(() => [] as TicketListEntry[]);
      setTickets(ts);
      // Likewise for routines.
      const rs = await client.call("routines", {}, 3000).catch(() => [] as RoutineListEntry[]);
      setRoutines(rs);
      setRoutineSel((i) => Math.max(0, Math.min(i, rs.length - 1)));
      if (view() === "history" && detailsId) await loadDetails(detailsId).catch(() => {});
      if (detailsPrKey()) await loadSessionEvents(detailsPrKey().split(" "));
    } catch {
      setOnline(false);
    }
  };

  const readConfig = () => {
    const r = loadConfig(props.paths.config);
    if (r.ok) {
      setConfig(r.config);
      setConfigError(null);
    } else setConfigError(r.error);
  };

  const readTheme = () => {
    const r = loadTheme(props.paths.theme);
    if (r.ok) {
      setTheme(r.theme);
      setThemeError(null);
    } else setThemeError(r.error);
  };

  const reloadAll = async () => {
    readConfig();
    readTheme();
    if (online()) {
      const r = await client.call("reload", {}).catch((e: Error) => ({ ok: false, error: e.message }));
      if (r.ok) notify("Config reloaded (TUI + daemon)");
      else notify(`Config invalid, daemon kept last good config: ${r.error}`, true);
    } else notify(configError() ? `Config invalid: ${configError()}` : "Config reloaded (daemon offline)", !!configError());
    await refresh();
  };

  /** Forces a full poll; the daemon enforces single-flight and the 30s cooldown. */
  const refreshAll = async () => {
    if (!online()) {
      notify("Start the daemon first (S)", true);
      return;
    }
    if (refreshing()) {
      notify("A refresh is already in progress", true);
      return;
    }
    setRefreshing(true);
    notify("Refreshing all PRs…");
    try {
      const r = await client.call("refresh", {}, 600_000);
      if (!r.accepted) notify(r.error ?? "Refresh refused", true);
      else {
        const prsMsg = r.checked.length ? `Refreshed ${r.checked.length} PR${r.checked.length === 1 ? "" : "s"}` : "Refreshed (no PRs watched)";
        const ticketsMsg = status()?.jira?.enabled ? ` · ${(r.tickets ?? []).length} Jira ticket(s) found` : "";
        notify(prsMsg + ticketsMsg);
      }
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setRefreshing(false);
      await refresh();
    }
  };

  const persist = async (mutate: (c: Config) => void) => {
    const current = config();
    if (!current) return;
    const next = structuredClone(current);
    mutate(next);
    try {
      saveConfig(props.paths.config, next);
      setConfig(next);
      if (online()) await client.call("reload", {});
      notify("Saved");
    } catch (e) {
      notify(`Invalid value: ${(e as Error).message}`, true);
    }
  };

  readConfig();
  readTheme();
  const themeWatcher = watchTheme(props.paths.theme, (r) => {
    if (r.ok) {
      setTheme(r.theme);
      setThemeError(null);
    } else setThemeError(r.error);
  }, props.watchThemeDir);
  onCleanup(() => themeWatcher.close());
  void refresh();
  const interval = setInterval(refresh, 2000);
  onCleanup(() => clearInterval(interval));

  /*
   * Sentinel starts Claude with `--add-dir <prompts folder>`. Until the user trusts that folder,
   * Claude Code asks about it at the start of every session and the session waits, so the
   * first run offers to open Claude there once.
   */
  const [promptsTrusted, setPromptsTrusted] = createSignal(false);
  const [trustAlert, setTrustAlert] = createSignal(false);
  const checkTrust = () => setPromptsTrusted(isDirTrusted(props.paths.promptsDir, props.claudeConfigFile));
  checkTrust();
  if (!promptsTrusted() && !trustAlertDismissed(props.paths.setup)) setTrustAlert(true);

  const openTrustSession = async () => {
    setTrustAlert(false);
    if (!online()) {
      notify("The daemon is not running. Start it (S), then run Settings › General › Setup again", true);
      return;
    }
    try {
      await client.call("openTool", { tool: "trust-prompts" }, 30_000);
      notify(`Opened Claude in ${tilde(props.paths.promptsDir)}: trust the folder, then quit it with /exit`);
    } catch (e) {
      notify(`Could not open Claude: ${(e as Error).message}`, true);
    }
  };

  const dismissTrust = () => {
    setTrustAlert(false);
    try {
      dismissTrustAlert(props.paths.setup);
    } catch {}
    if (!promptsTrusted()) notify("Set it up any time from Settings › General › Setup");
  };

  const current = () => {
    const l = currentLine();
    return l?.kind === "pr" ? l.pr : undefined;
  };

  const [starting, setStarting] = createSignal(false);
  const startDaemon = async () => {
    if (starting()) return;
    setStarting(true);
    try {
      const started = await (props.start ?? (() => startDaemonProcess(props.paths, new Client(props.paths.socket))))();
      if (started) notify("Daemon started");
    } catch (e) {
      notify(`Could not start daemon: ${(e as Error).message}`, true);
    } finally {
      setStarting(false);
      await refresh();
    }
  };
  if (props.autoStart !== false) void startDaemon();

  /** Loads the open PR's events and human comments, keeping the same comment selected. */
  const loadDetails = async (prId: string) => {
    const keep = selectedHuman()?.item_id;
    const [events, comments] = await Promise.all([
      client.call("history", { pr: prId }),
      // An older daemon has no human comment tracking.
      client.call("humanComments", { pr: prId }).catch(() => [] as HumanCommentRow[]),
    ]);
    const rank = (c: HumanCommentRow) => (draftState(c, false) === "resolved" ? 1 : 0);
    const sorted = [...comments].sort((a, b) => rank(a) - rank(b));
    setHistory(events);
    setHumans(sorted);
    const i = keep ? sorted.findIndex((c) => c.item_id === keep) : -1;
    setHumanSel(i >= 0 ? i : Math.min(humanSel(), Math.max(0, sorted.length - 1)));
  };

  const openHistory = async () => {
    const pr = current();
    if (!pr) return;
    try {
      setHumanSel(0);
      setHumans([]);
      await loadDetails(pr.id);
      setView("history");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const humanState = (c: HumanCommentRow): DraftState => {
    const pr = current();
    return draftState(c, pr?.session?.state === "busy" || pr?.last_status === "fix_running");
  };

  /** Opens the selected comment's reply in $EDITOR and saves it as the user's draft. */
  const editReply = async () => {
    const pr = current();
    const c = selectedHuman();
    if (!pr || !c) return;
    const before = c.draft_reply ?? "";
    const file = join(props.paths.home, `reply-${c.item_id.replace(/[^\w-]/g, "_")}.md`);
    writeFileSync(file, before);
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    await renderer.suspend();
    spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    await renderer.resume();
    const text = readFileSync(file, "utf8").trimEnd();
    if (text === before.trimEnd()) return;
    try {
      await client.call("draft", { pr: pr.id, item: c.item_id, reply: text, by: "user" });
      await loadDetails(pr.id);
      notify("Reply saved");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  /** Opens a file in $EDITOR, with the dashboard suspended until the editor exits. */
  const editExternally = async (file: string) => {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    await renderer.suspend();
    spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    await renderer.resume();
  };

  /** Opens the selected template field in $EDITOR. */
  const editTemplate = async () => {
    const cfg = config();
    const field = selectedField();
    if (!cfg || !field || field.kind !== "template") return;
    const before = String(field.get(cfg));
    const file = join(props.paths.home, `${field.key}.md`);
    writeFileSync(file, before);
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    await renderer.suspend();
    spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    await renderer.resume();
    const text = readFileSync(file, "utf8");
    if (text.trim() && text !== before) await persist((c) => field.set(c, text));
  };

  const openPicker = async () => {
    if (!online()) {
      notify("Start the daemon first (S)", true);
      return;
    }
    setQuery("");
    setPickSel(0);
    setMyPrs(null);
    setMyPrsError(null);
    await nextTick();
    setView("pick-pr");
    try {
      const [list, d] = await Promise.all([client.call("myPrs", {}, 90_000), client.call("newWatchDefaults", {})]);
      setMyPrs(list);
      setDefaults(d);
    } catch (e) {
      const msg = (e as Error).message;
      setMyPrsError(
        msg.startsWith("Unknown method")
          ? "the running daemon is older than this dashboard. Run `sentinel restart`."
          : msg,
      );
    }
  };

  const loadRepos = async () => {
    setRepoLoading(true);
    try {
      const keep = selectedWorktree()?.path;
      setRepoView(await client.call("repos", {}, 60_000));
      setRepoError(null);
      const i = allWorktrees().findIndex((w) => w.path === keep);
      setRepoSel(Math.max(0, Math.min(i >= 0 ? i : repoSel(), allWorktrees().length - 1)));
    } catch (e) {
      const msg = (e as Error).message;
      setRepoError(msg.startsWith("Unknown method") ? "the running daemon is older than this dashboard. Run `sentinel restart`." : msg);
    } finally {
      setRepoLoading(false);
    }
  };

  const openRepos = async () => {
    if (!online()) {
      notify("Start the daemon first (S)", true);
      return;
    }
    setRepoQuery("");
    setRepoFiltering(false);
    setView("repos");
    await loadRepos();
  };

  const pickPr = (pr: MyPr) => {
    const d = defaults();
    if (!d) return;
    const f = initialForm(pr, d);
    setForm(f);
    setFormSel(FORM_FIELDS.findIndex((x) => x.key === "model"));
    setFormMsg(pr.watched ? { text: "Already watched: submitting moves it to a new session.", error: false } : null);
    warnedPath = null;
    setView("new-watch");
    client
      .call("suggestCwd", { pr: pr.id }, 30_000)
      .then((r) => {
        const cur = form();
        if (cur && cur.pr.id === pr.id && !cur.cwd && r.path) setForm({ ...cur, cwd: r.path });
      })
      .catch(() => {});
  };

  const submitForm = async () => {
    const f = form();
    if (!f || submitting()) return;
    setSubmitting(true);
    try {
      const check = await client.call("validateCwd", { pr: f.pr.id, path: f.cwd }, 10_000);
      if (!check.ok) {
        setFormMsg({ text: check.error ?? "Invalid directory", error: true });
        return;
      }
      if (check.warning && warnedPath !== check.path) {
        warnedPath = check.path;
        setFormMsg({ text: `${check.warning}. Press enter again to watch anyway.`, error: true });
        return;
      }
      setFormMsg({ text: f.startNow ? "Registering and starting the session…" : "Registering…", error: false });
      const [r] = await client.call("watch", watchRequest(f, check.path), 600_000);
      if (!r || r.error) {
        setFormMsg({ text: r?.error ?? "Watch failed", error: true });
        return;
      }
      notify(`Watching ${r.id} (session ${r.sessionId?.slice(0, 8) ?? "?"})`);
      setForm(null);
      setView("list");
      await refresh();
      setListQuery("");
      setLineKey(`p:${r.id}`);
    } catch (e) {
      setFormMsg({ text: (e as Error).message, error: true });
    } finally {
      setSubmitting(false);
    }
  };

  const submitFormEdit = (text: string) => {
    const which = formEditing();
    const f = form();
    setFormEditing(null);
    if (!which || !f) return;
    warnedPath = null;
    if (which === "cwd") setForm({ ...f, cwd: text.trim() });
    else setForm({ ...f, model: text.trim() || f.model });
  };

  useKeyboard(async (key) => {
    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }
    if (trustAlert()) {
      key.preventDefault();
      if (key.name === "y") await openTrustSession();
      else if (key.name === "escape" || key.name === "n") dismissTrust();
      return;
    }
    // Handled before any focused input sees the key, so `?` works while typing a filter too.
    if (key.sequence === "?" && !key.ctrl && !key.meta) {
      key.preventDefault();
      setConfirmDelete(false);
      setConfirmDismiss(false);
      setHelpQuery("");
      setHelpFiltering(false);
      setHelpOpen((o) => !o);
      return;
    }
    if (helpOpen()) {
      key.preventDefault();
      if (helpFiltering()) {
        if (key.name === "escape") {
          setHelpQuery("");
          setHelpFiltering(false);
        } else if (key.name === "return") setHelpFiltering(false);
        else if (key.name === "backspace") setHelpQuery((q) => q.slice(0, -1));
        else if (key.name === "up") helpScroll?.scrollBy(-1);
        else if (key.name === "down") helpScroll?.scrollBy(1);
        else if (key.sequence && key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta)
          setHelpQuery((q) => q + key.sequence);
        return;
      }
      if (key.name === "/" || key.sequence === "/") setHelpFiltering(true);
      else if (key.name === "escape" && helpQuery()) setHelpQuery("");
      else if (key.name === "escape" || key.name === "q" || key.name === "return") setHelpOpen(false);
      else if (key.name === "up" || key.name === "k") helpScroll?.scrollBy(-1);
      else if (key.name === "down" || key.name === "j") helpScroll?.scrollBy(1);
      return;
    }
    if (editing() !== null || formEditing() !== null) {
      if (key.name === "escape") {
        setEditing(null);
        setFormEditing(null);
      }
      return; // input handles the rest
    }
    const v = view();
    if (v === "pick-pr") {
      const n = filtered().length;
      if (key.name === "escape") setView("list");
      else if (key.name === "up" || (key.ctrl && key.name === "p")) setPickSel((i) => Math.max(0, i - 1));
      else if (key.name === "down" || (key.ctrl && key.name === "n")) setPickSel((i) => Math.min(n - 1, i + 1));
      else if (key.name === "return") {
        const pr = filtered()[pickSel()];
        if (pr) pickPr(pr);
      }
      return; // everything else goes to the filter input
    }
    if (v === "new-watch") {
      const f = form();
      const d = defaults();
      if (!f || !d) return;
      const field = FORM_FIELDS[formSel()]!;
      switch (key.name) {
        case "escape":
        case "q":
          setView("pick-pr");
          return;
        case "up":
        case "k":
          setFormSel((i) => Math.max(0, i - 1));
          return;
        case "down":
        case "j":
        case "tab":
          setFormSel((i) => Math.min(FORM_FIELDS.length - 1, i + 1));
          return;
        case "left":
        case "h":
        case "right":
        case "l":
        case "space":
          if (field.kind === "enum") setForm(cycleField(field.key, f, d, key.name === "left" || key.name === "h" ? -1 : 1));
          return;
        case "e":
          if (field.key === "model" || field.key === "cwd") {
            formDraft = field.key === "model" ? f.model : f.cwd;
            await nextTick();
            setFormEditing(field.key);
          }
          return;
        case "return":
          if (field.kind === "submit") await submitForm();
          else if (field.kind === "enum") setForm(cycleField(field.key, f, d));
          else if (field.kind === "text") {
            formDraft = f.cwd;
            await nextTick();
            setFormEditing("cwd");
          }
          return;
      }
      return;
    }
    if (v === "list") {
      if (listFiltering()) {
        if (key.name === "escape") {
          setListQuery("");
          setListFiltering(false);
        } else if (key.name === "return") setListFiltering(false);
        else if (key.name === "up") moveLine(-1);
        else if (key.name === "down") moveLine(1);
        return; // everything else goes to the filter input
      }
      if (!confirmDelete() && (key.name === "/" || key.sequence === "/")) {
        await nextTick();
        setListFiltering(true);
        return;
      }
      if (!confirmDelete() && !confirmDismiss() && key.name === "escape" && detailsOpen()) {
        setSessionDetails(false);
        return;
      }
      if (!confirmDelete() && key.name === "escape" && listQuery()) {
        setListQuery("");
        return;
      }
      if (confirmDismiss()) {
        setConfirmDismiss(false);
        const t = currentTicket();
        if (key.name === "y" && t) {
          await client.call("dismissTicket", { key: t.key }).catch((e: Error) => notify(e.message, true));
          notify(`Dismissed ${t.key}`);
          await refresh();
        }
        return;
      }
      if (!confirmDelete()) {
        const l = currentLine();
        if (detailsOpen() && key.shift && (key.name === "j" || key.name === "k")) {
          detailsScroll?.scrollBy(key.name === "k" ? -1 : 1);
          return;
        }
        switch (key.name) {
          case "up":
          case "k":
            moveLine(-1);
            return;
          case "down":
          case "j":
            moveLine(1);
            return;
          case "return":
            if (l) setSessionDetails((o) => !o);
            return;
          case "pageup":
          case "pagedown":
            if (detailsOpen()) detailsScroll?.scrollBy((key.name === "pageup" ? -1 : 1) * 5);
            return;
          case "h": {
            if (!l) return;
            const ids = historyPrIds(l);
            if (ids.length !== 1) {
              notify(ids.length ? "Select one of the session's PRs for its full history" : "No PR yet, so no history", true);
              return;
            }
            setLineKey(`p:${ids[0]}`);
            await openHistory();
            return;
          }
        }
        if (l?.kind === "session") {
          const s = l.entry;
          switch (key.name) {
            case "a":
              if (key.shift) await goToAgent(s.session ? s.sessionId : undefined, `session ${s.sessionId.slice(0, 8)}`);
              return;
            case "p": {
              if (!s.session) return;
              const paused = !s.session.paused;
              await client.call("pause", { sessionId: s.sessionId, paused }).catch((e: Error) => notify(e.message, true));
              notify(`${paused ? "Paused" : "Resumed"} session ${s.sessionId.slice(0, 8)}`);
              await refresh();
              return;
            }
            case "o":
            case "c":
            case "d":
              notify("Select one of the session's PRs or tickets for that", true);
              return;
          }
        }
      }
      if (ticketActive() && !confirmDelete()) {
        const t = currentTicket();
        switch (key.name) {
          case "c":
            return;
          case "o":
            if (!t) return;
            try {
              (props.openUrl ?? defaultOpenUrl)(t.url);
              notify(`Opened ${t.url}`);
            } catch (e) {
              notify(`Could not open ${t.url}: ${(e as Error).message}`, true);
            }
            return;
          case "d":
            if (t) setConfirmDismiss(true);
            return;
          case "a":
            if (key.shift && t) await goToAgent(t.session?.session_id, t.key);
            return;
          case "p": {
            if (!t?.session) return;
            const paused = !t.session.paused;
            await client.call("pause", { sessionId: t.session_id, paused }).catch((e: Error) => notify(e.message, true));
            notify(`${paused ? "Paused" : "Resumed"} session ${t.session_id.slice(0, 8)}`);
            await refresh();
            return;
          }
        }
      }
      if (currentRoutine() && !confirmDelete()) {
        const r = currentRoutine()!;
        switch (key.name) {
          case "o":
          case "c":
          case "d":
            notify("Routines are managed in their folder; t opens the routines view", true);
            return;
          case "x":
            await runRoutine(r);
            return;
          case "a":
            if (key.shift) await goToAgent(r.row?.session_id ?? undefined, `routine ${r.id}`);
            return;
          case "p": {
            if (!r.session) return;
            const paused = !r.session.paused;
            await client.call("pause", { sessionId: r.session.session_id, paused }).catch((e: Error) => notify(e.message, true));
            notify(`${paused ? "Paused" : "Resumed"} session ${r.session.session_id.slice(0, 8)}`);
            await refresh();
            return;
          }
        }
      }
      if (confirmDelete()) {
        setConfirmDelete(false);
        if (key.name === "y" && current()) {
          const id = current()!.id;
          await client.call("unwatch", { pr: id }).catch((e: Error) => notify(e.message, true));
          notify(`Stopped watching ${id}`);
          await refresh();
        }
        return;
      }
      switch (key.name) {
        case "q":
          renderer.destroy();
          return;
        case "s":
          if (key.shift) {
            if (!online()) await startDaemon();
            return;
          }
          readConfig();
          checkTrust();
          setSettingsQuery("");
          setSettingsFiltering(false);
          setSettingsTab(0);
          setFieldSel(0);
          setView("settings");
          return;
        case "r":
          if (key.shift) await reloadAll();
          else await refreshAll();
          return;
        case "n":
        case "w":
          await openPicker();
          return;
        case "g":
          await openRepos();
          return;
        case "t":
          if (!online()) {
            notify("Start the daemon first (S)", true);
            return;
          }
          setView("routines");
          await refresh();
          return;
        case "o": {
          const pr = current();
          if (!pr) return;
          try {
            (props.openUrl ?? defaultOpenUrl)(pr.url);
            notify(`Opened ${pr.url}`);
          } catch (e) {
            notify(`Could not open ${pr.url}: ${(e as Error).message}`, true);
          }
          return;
        }
        case "c":
          if (!current()) return;
          notify(`Checking ${current()!.id}…`);
          client
            .call("check", { pr: current()!.id }, 600_000)
            .then(() => notify(`Checked ${current()?.id ?? ""}`))
            .catch((e: Error) => notify(e.message, true))
            .finally(refresh);
          return;
        case "d":
          if (current()) setConfirmDelete(true);
          return;
        case "a": {
          const pr = current();
          if (key.shift && pr) await goToAgent(pr.session?.session_id, pr.id);
          return;
        }
        case "p": {
          const pr = current();
          if (!pr?.session) return;
          const paused = !pr.session.paused;
          await client.call("pause", { sessionId: pr.session_id, paused }).catch((e: Error) => notify(e.message, true));
          notify(`${paused ? "Paused" : "Resumed"} session ${pr.session_id.slice(0, 8)}`);
          await refresh();
          return;
        }
      }
      return;
    }
    if (v === "repos") {
      if (repoFiltering()) {
        const last = allWorktrees().length - 1;
        if (key.name === "escape") {
          setRepoQuery("");
          setRepoFiltering(false);
          setRepoSel(0);
        } else if (key.name === "return") setRepoFiltering(false);
        else if (key.name === "up") setRepoSel((i) => Math.max(0, i - 1));
        else if (key.name === "down") setRepoSel((i) => Math.min(last, i + 1));
        return; // everything else goes to the filter input
      }
      if (key.name === "/" || key.sequence === "/") {
        await nextTick();
        setRepoFiltering(true);
        return;
      }
      if (key.name === "escape" && repoQuery()) {
        setRepoQuery("");
        setRepoSel(0);
        return;
      }
      switch (key.name) {
        case "escape":
        case "q":
        case "backspace":
          setView("list");
          return;
        case "up":
        case "k":
          setRepoSel((i) => Math.max(0, i - 1));
          return;
        case "down":
        case "j":
          setRepoSel((i) => Math.min(allWorktrees().length - 1, i + 1));
          return;
        case "r":
          await loadRepos();
          return;
        case "o": {
          const wt = selectedWorktree();
          const url = wt && (prById(wt.prs[0] ?? "")?.url ?? ticketByKey(wt.tickets[0] ?? "")?.url);
          if (!url) {
            notify("No watched PR or Jira ticket on this worktree", true);
            return;
          }
          try {
            (props.openUrl ?? defaultOpenUrl)(url);
            notify(`Opened ${url}`);
          } catch (e) {
            notify(`Could not open ${url}: ${(e as Error).message}`, true);
          }
          return;
        }
      }
      return;
    }
    if (v === "routines") {
      const r = selectedRoutine();
      switch (key.name) {
        case "escape":
        case "q":
        case "backspace":
          setView("list");
          return;
        case "up":
        case "k":
          setRoutineSel((i) => Math.max(0, i - 1));
          return;
        case "down":
        case "j":
          setRoutineSel((i) => Math.min(routines().length - 1, i + 1));
          return;
        case "x":
        case "return":
          await runRoutine(r);
          return;
        case "r":
          await refresh();
          notify("Rescanned the routines folder");
          return;
        case "a":
          if (key.shift && r) await goToAgent(r.row?.session_id ?? undefined, `routine ${r.id}`);
          return;
        case "e": {
          if (!r) return;
          const file = join(r.dir, "ROUTINE.md");
          await editExternally(file);
          await refresh();
          return;
        }
      }
      return;
    }
    if (v === "history") {
      const pr = current();
      const c = selectedHuman();
      if (key.name === "escape" || key.name === "q" || key.name === "backspace") setView("list");
      else if (key.name === "up" || key.name === "k") setHumanSel((i) => Math.max(0, i - 1));
      else if (key.name === "down" || key.name === "j") setHumanSel((i) => Math.min(Math.max(0, humans().length - 1), i + 1));
      else if (key.name === "o" && pr) {
        const url = c?.url ?? pr.url;
        try {
          (props.openUrl ?? defaultOpenUrl)(url);
          notify(`Opened ${url}`);
        } catch (e) {
          notify(`Could not open ${url}: ${(e as Error).message}`, true);
        }
      } else if (key.name === "y" && c) {
        if (!c.draft_reply) {
          notify("No reply drafted yet; e writes one", true);
          return;
        }
        try {
          (props.copy ?? copyToClipboard)(c.draft_reply);
          notify(`Copied the reply to @${c.author ?? "reviewer"}`);
        } catch (e) {
          notify(`Could not copy: ${(e as Error).message}`, true);
        }
      } else if (key.name === "e" && c) await editReply();
      else if (key.name === "x" && c && pr) {
        const resolved = humanState(c) !== "resolved";
        if (!resolved && c.gh_resolved) {
          notify("This thread is resolved on GitHub; unresolve it there", true);
          return;
        }
        try {
          await client.call("resolveComment", { pr: pr.id, item: c.item_id, resolved });
          await loadDetails(pr.id);
          await refresh();
          notify(resolved ? `Marked ${c.item_id} resolved` : `Reopened ${c.item_id}`);
        } catch (e) {
          notify((e as Error).message, true);
        }
      }
      return;
    }
    if (v === "settings") {
      const cfg = config();
      if (key.name === "tab") {
        const n = SECTIONS.length;
        setSettingsTab((t) => (t + (key.shift ? n - 1 : 1)) % n);
        setFieldSel(0);
        return;
      }
      const last = shownFields().length - 1;
      if (settingsFiltering()) {
        if (key.name === "escape") {
          setSettingsQuery("");
          setSettingsFiltering(false);
          setFieldSel(0);
        } else if (key.name === "return") setSettingsFiltering(false);
        else if (key.name === "up") setFieldSel((i) => Math.max(0, i - 1));
        else if (key.name === "down") setFieldSel((i) => Math.min(last, i + 1));
        return; // everything else goes to the filter input
      }
      if (key.name === "/" || key.sequence === "/") {
        await nextTick();
        setSettingsFiltering(true);
        return;
      }
      const field = selectedField();
      switch (key.name) {
        case "escape":
          if (settingsQuery()) {
            setSettingsQuery("");
            setFieldSel(0);
          } else setView("list");
          return;
        case "q":
          setView("list");
          return;
        case "up":
        case "k":
          setFieldSel((i) => Math.max(0, i - 1));
          return;
        case "down":
        case "j":
          setFieldSel((i) => Math.min(last, i + 1));
          return;
        case "r":
          await reloadAll();
          return;
        case "e":
          if (field?.kind === "template") await editTemplate();
          return;
        case "left":
        case "h":
        case "right":
        case "l":
          if (cfg && field?.kind === "enum") {
            const dir = key.name === "left" || key.name === "h" ? -1 : 1;
            await persist((c) => field.set(c, cycleEnum(field, c, dir)));
          }
          return;
        case "return":
        case "space":
          if (field?.kind === "action") {
            checkTrust();
            setTrustAlert(true);
            return;
          }
          if (!cfg || !field) return;
          if (field.kind === "enum") await persist((c) => field.set(c, cycleEnum(field, c)));
          else if (field.kind === "template") await editTemplate();
          else {
            draft = editText(field, cfg);
            await nextTick();
            setEditing(draft);
          }
          return;
      }
    }
  });

  let draft = "";
  const submitEdit = async (text: string) => {
    const field = selectedField();
    setEditing(null);
    if (!field) return;
    let value: unknown;
    try {
      value = parseValue(field, text);
    } catch (e) {
      notify(`${fullLabel(field)}: ${(e as Error).message}`, true);
      return;
    }
    await persist((c) => field.set(c, value));
  };

  const widths = () => {
    const w = dims().width - 4;
    const fixed = { agent: 7, session: 10, checked: 10, human: 6, merge: 8, status: 13 };
    const rest = Math.max(20, w - fixed.agent - fixed.session - fixed.checked - fixed.human - fixed.merge - fixed.status - 7);
    const pr = Math.min(Math.max(30, Math.floor(rest * 0.6)), 80);
    return { ...fixed, pr, reason: Math.max(10, rest - pr) };
  };

  const sessionDot = (e: { session: { state: string; paused: number; agent_running: number } | null }) => {
    const st = e.session;
    if (!st || !st.agent_running) return theme().textMuted;
    if (st.paused) return theme().warning;
    return st.state === "busy" ? theme().pending : theme().success;
  };
  /** Width of the first column, where a session line and its PR and ticket lines are named. */
  const nameWidth = () => widths().pr + widths().agent + widths().session + 2;

  const lineCells = (l: SessionLine) => {
    // The reason column gives up two columns: the scrollbox keeps one for its scrollbar.
    const reason = (r: string | null) => <text fg={theme().textSecondary}>{` ${pad((r ?? "").replace(/\s+/g, " "), widths().reason - 2)}`}</text>;
    if (l.kind === "session")
      return (
        <>
          <text fg={sessionDot(l.entry)}>{"  ●"}</text>
          <text>{` ${pad(`${l.entry.sessionId.slice(0, 8)}  ${l.entry.agent}${l.entry.session?.model ? ` · ${l.entry.session.model}` : ""}`, 30)}`}</text>
          <text fg={theme().textMuted}>{` ${sessionState(l.entry.session)} · ${sessionSummary(l.entry)}`}</text>
        </>
      );
    if (l.kind === "pr") {
      const pr = l.pr;
      const name = l.group.title === MULTI_REPO_GROUP ? `${prGroup(pr.id)} ${prLine(pr)}` : prLine(pr);
      return (
        <>
          <text>{`${pad(`      ${name}`, nameWidth())} ${pad(ago(pr.last_checked_at), widths().checked)}`}</text>
          <text fg={(pr.humanOpen ?? 0) > 0 ? theme().warning : theme().textMuted}>{` ${pad((pr.humanOpen ?? 0) > 0 ? `${pr.humanOpen} open` : "-", widths().human)}`}</text>
          <text fg={pr.mergeable === "CONFLICTING" ? theme().error : theme().textMuted}>{` ${pad(mergeLabel(pr), widths().merge)}`}</text>
          <text fg={statusColor(theme(), pr.last_status)}>{` ${pad(pr.last_status, widths().status)}`}</text>
          {reason(pr.last_reason)}
        </>
      );
    }
    if (l.kind === "routine") {
      const r = l.routine;
      const st = routineStatus(r);
      return (
        <>
          <text>{`${pad(`      ⏱ ${r.id} - ${r.name}`, nameWidth())} ${pad(ago(r.row?.last_run_at ?? null), widths().checked)}`}</text>
          <text fg={theme().textMuted}>{` ${pad("-", widths().human)} ${pad("-", widths().merge)}`}</text>
          <text fg={statusColor(theme(), st)}>{` ${pad(st, widths().status)}`}</text>
          {reason(r.error ?? r.row?.last_reason ?? null)}
        </>
      );
    }
    const t = l.ticket;
    return (
      <>
        <text>{`${pad(`      ${t.key} - ${t.summary ?? ""}`, nameWidth())} ${pad(ago(t.picked_at), widths().checked)}`}</text>
        <text fg={theme().textMuted}>{` ${pad("-", widths().human)} ${pad("-", widths().merge)}`}</text>
        <text fg={statusColor(theme(), t.last_status)}>{` ${pad(t.last_status, widths().status)}`}</text>
        {reason(t.last_reason)}
      </>
    );
  };

  const sessionsView = () => (
    <box
      flexDirection="column"
      border
      title={` Sessions · ${shownGroups().reduce((n, g) => n + g.sessions.length, 0)}${humanTotal() > 0 ? ` · ${humanTotal()} human comment(s) need you` : ""} `}
      marginTop={1}
      flexGrow={1}
      flexBasis={detailsOpen() ? 0 : undefined}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme().textMuted} flexShrink={0}>
        {pad("SESSION › PR / TICKET", nameWidth())} {pad("CHECKED", widths().checked)} {pad("HUMAN", widths().human)} {pad("MERGE", widths().merge)}{" "}
        {pad("STATUS", widths().status)} REASON
      </text>
      <Show when={listFiltering() || listQuery() !== ""}>
        <box flexDirection="row" height={1} flexShrink={0}>
          <text fg={theme().accent}>/ </text>
          <Show when={listFiltering()} fallback={<text>{listQuery()}</text>}>
            <input
              value={listQuery()}
              focused
              flexGrow={1}
              placeholder="filter by session, repo, PR, ticket or status"
              onInput={(v) => {
                setListQuery(v);
                setLineKey(null);
              }}
            />
          </Show>
        </box>
      </Show>
      <Show when={status()?.jira?.error}>
        <text fg={theme().error} flexShrink={0}>Jira poll failed: {status()!.jira.error}</text>
      </Show>
      <Show when={hasSessions() && lines().length === 0}>
        <text fg={theme().textMuted}>No sessions match "{listQuery()}".</text>
      </Show>
      <Show
        when={hasSessions()}
        fallback={
          <text fg={theme().textMuted}>
            No sessions yet. Press n to watch one of your PRs, hand off from an agent with `sentinel watch &lt;pr&gt;`, label a Jira ticket, or add a routine (t).
          </text>
        }
      >
        <scrollbox ref={(el: ScrollBoxRenderable) => (sessionScroll = el)} flexGrow={1} flexShrink={1} minHeight={0}>
          <For each={lines()}>
            {(l, i) => (
              <>
                <Show when={l.kind === "session" && l.group.sessions[0] === l.entry}>
                  <text fg={theme().info} flexShrink={0} marginTop={i() === 0 ? 0 : 1}>
                    <b>{l.group.title}</b>
                  </text>
                </Show>
                <box id={`sess-line-${i()}`} flexDirection="row" flexShrink={0} backgroundColor={i() === lineIndex() ? theme().selectionBackground : undefined}>
                  {lineCells(l)}
                </box>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  );

  /** The lower half of the sessions view: everything about the selected line's session. */
  const sessionDetailsView = () => {
    const l = () => currentLine()!;
    const e = () => l().entry;
    const w = () => Math.max(40, dims().width - 6);
    const nameW = () => Math.min(60, Math.floor(w() * 0.4));
    const marker = (selected: boolean) => (selected ? "▸ " : "  ");
    const cost = () => sessionEvalCost(e());
    const historyTitle = () => {
      const ids = historyPrIds(l());
      if (ids.length === 0) return "History";
      if (ids.length === 1) return `History · ${prLine(prById(ids[0]!) ?? { id: ids[0]! }).split(" - ")[0]}`;
      return `History · ${ids.length} PRs`;
    };
    return (
      <box
        flexDirection="column"
        border
        borderColor={theme().accent}
        title={` Session ${e().sessionId.slice(0, 8)} · ${sessionState(e().session)} `}
        flexGrow={1}
        flexBasis={0}
        paddingLeft={1}
        paddingRight={1}
      >
        <text flexShrink={0}>
          {e().sessionId} · {e().agent}
          {e().session?.model ? ` · model ${e().session!.model}` : ""}
          {e().session?.effort ? ` · effort ${e().session!.effort}` : ""} · pane {e().session?.pane_id ?? "none"}
        </text>
        <text fg={theme().textMuted} flexShrink={0}>
          {tilde(e().session?.cwd ?? e().prs[0]?.cwd ?? e().tickets[0]?.cwd ?? "?")}
        </text>
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme().textMuted}>Evaluator spend </text>
          <text fg={theme().accent}>
            <b>{formatUsd(cost().usd)}</b>
          </text>
          <text fg={theme().textMuted}>
            {" "}
            over {cost().runs} run{cost().runs === 1 ? "" : "s"}
          </text>
        </box>
        <text fg={theme().info} flexShrink={0} marginTop={1}>
          <b>PRs · {e().prs.length}</b>
        </text>
        <Show when={e().prs.length === 0}>
          <text fg={theme().textMuted} flexShrink={0}>  none yet</text>
        </Show>
        <For each={e().prs}>
          {(pr) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={l().kind === "pr" && l().key === `p:${pr.id}` ? theme().accent : undefined}>
                {pad(marker(l().key === `p:${pr.id}`) + (l().group.title === MULTI_REPO_GROUP ? `${prGroup(pr.id)} ` : "") + prLine(pr), nameW())}{" "}
              </text>
              <text fg={statusColor(theme(), pr.last_status)}>{pad(pr.last_status, widths().status)} </text>
              <text fg={(pr.humanOpen ?? 0) > 0 ? theme().warning : theme().textMuted}>{pad((pr.humanOpen ?? 0) > 0 ? `${pr.humanOpen} human` : "", 9)} </text>
              <text fg={theme().textMuted}>{pad(`eval ${formatUsd(pr.eval_cost_usd ?? 0)} · ${pr.eval_count ?? 0}×`, 18)} </text>
              <text fg={theme().textSecondary}>{pad((pr.last_reason ?? "").replace(/\s+/g, " "), Math.max(10, w() - nameW() - widths().status - 31))}</text>
            </box>
          )}
        </For>
        <text fg={theme().info} flexShrink={0} marginTop={1}>
          <b>Tickets · {e().tickets.length}</b>
        </text>
        <Show when={e().tickets.length === 0}>
          <text fg={theme().textMuted} flexShrink={0}>  none</text>
        </Show>
        <For each={e().tickets}>
          {(t) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={l().key === `t:${t.key}` ? theme().accent : undefined}>{pad(`${marker(l().key === `t:${t.key}`)}${t.key} - ${t.summary ?? ""}`, nameW())} </text>
              <text fg={statusColor(theme(), t.last_status)}>{pad(t.last_status, widths().status)} </text>
              <text fg={theme().textMuted}>{pad(t.pr_id ? `PR ${prLine({ id: t.pr_id }).split(" ")[0]}` : "", 9)} </text>
              <text fg={theme().textSecondary}>{pad((t.last_reason ?? "").replace(/\s+/g, " "), Math.max(10, w() - nameW() - widths().status - 12))}</text>
            </box>
          )}
        </For>
        <box flexDirection="row" flexShrink={0} marginTop={1}>
          <text fg={theme().info}>
            <b>{historyTitle()}</b>
          </text>
          <text fg={theme().textMuted}> · J/K scroll · h full page</text>
        </box>
        <scrollbox ref={(el: ScrollBoxRenderable) => (detailsScroll = el)} flexGrow={1} flexShrink={1} minHeight={3}>
          <For each={detailsHistory()} fallback={<text fg={theme().textMuted}>{historyPrIds(l()).length ? "No events yet." : "No PR yet, so no history."}</text>}>
            {(h) => (
              <box flexDirection="row" flexShrink={0}>
                <text fg={theme().info}>{pad(new Date(h.ev.ts).toLocaleString(), 22)} </text>
                <Show when={historyPrIds(l()).length > 1}>
                  <text fg={theme().textMuted}>{pad(prLine({ id: h.prId }).split(" ")[0]!, 6)} </text>
                </Show>
                <text>{pad(h.ev.kind, 16)} </text>
                <text fg={theme().textSecondary}>{eventSummary(h.ev).replace(/\s+/g, " ")}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
    );
  };

  /** The routines view's first column: wide enough for the longest `id - name`, within reason. */
  const routineNameWidth = () =>
    Math.min(Math.max(24, Math.floor(dims().width * 0.3)), Math.max(20, ...routines().map((r) => (r.valid ? `${r.id} - ${r.name}` : r.id).length)));

  /** The watch dialogs float over the sessions list. */
  const modalWidth = () => Math.max(40, Math.min(100, dims().width - 12));
  const pickerHeight = () => Math.max(8, Math.min(18, dims().height - 10));

  const showSettingsFilter = () => settingsFiltering() || settingsQuery() !== "";
  /** Wide enough for the longest indented label, so values line up across sections. */
  const SETTINGS_LABEL_WIDTH = Math.max(...FIELDS.map((f) => f.label.length + (f.group ? 2 : 0))) + 1;
  /** A group subheading takes two lines (a blank line above it) unless it opens the visible window. */
  const rowHeight = (r: SettingsRow, top: boolean) => (r.kind === "group" && !top ? 2 : 1);
  const rowsHeight = (rows: SettingsRow[]) => rows.reduce((n, r, i) => n + rowHeight(r, i === 0), 0);
  /** Sized for the tallest tab, so the dialog doesn't jump when switching tabs. */
  const tallestTab = Math.max(...SECTIONS.map((sec) => rowsHeight(settingsRows(FIELDS.filter((f) => f.section === sec)))));
  /** Borders, the tab bar and the blank line under it, and the filter line when shown. */
  const settingsChrome = () => 4 + (showSettingsFilter() ? 1 : 0);
  const settingsHeight = () => Math.max(10, Math.min(tallestTab + settingsChrome(), dims().height - 8));

  /** The subheadings and fields that fit in the dialog, scrolled so the selected field stays visible. */
  const settingsWindow = (): SettingsRow[] => {
    const space = settingsHeight() - settingsChrome();
    const rows = settingsRows(shownFields());
    const sel = Math.max(0, rows.findIndex((r) => r.kind === "field" && r.field === selectedField()));
    const heightOf = (from: number, to: number) => rowsHeight(rows.slice(from, to + 1));
    let start = 0;
    while (start < sel && heightOf(start, sel) > space) start++;
    let end = start;
    while (end + 1 < rows.length && heightOf(start, end + 1) <= space) end++;
    return rows.slice(start, end + 1);
  };

  const settingsFieldRow = (field: Field) => {
    const selected = () => field === selectedField();
    return (
      <box flexDirection="row" height={1} flexShrink={0} backgroundColor={selected() ? theme().selectionBackground : undefined}>
        <text fg={selected() ? undefined : theme().textMuted}>{pad((field.group ? "  " : "") + field.label, SETTINGS_LABEL_WIDTH)} </text>
        <Show
          when={editing() !== null && selected()}
          fallback={
            <Show
              when={field.kind === "enum"}
              fallback={
                <Show when={field.kind === "action"} fallback={<text>{pad(displayValue(field, config()!), modalWidth() - SETTINGS_LABEL_WIDTH - 5)}</text>}>
                  <text fg={promptsTrusted() ? theme().success : theme().warning}>{promptsTrusted() ? "trusted" : "not trusted"}</text>
                  <text fg={theme().textMuted}>{` · ${displayValue(field, config()!)}`}</text>
                </Show>
              }
            >
              <For each={field.options ?? []}>
                {(opt) => (
                  <text
                    fg={String(field.get(config()!)) === opt ? theme().modalBackground : theme().textMuted}
                    bg={String(field.get(config()!)) === opt ? theme().accent : undefined}
                    marginRight={1}
                  >
                    {` ${opt} `}
                  </text>
                )}
              </For>
              <Show when={selected()}>
                <text fg={theme().textMuted}> ←→</text>
              </Show>
            </Show>
          }
        >
          <input
            value={editing()!}
            focused
            flexGrow={1}
            onInput={(v) => (draft = v)}
            onSubmit={(v) => void submitEdit(typeof v === "string" ? v : draft)}
          />
        </Show>
      </box>
    );
  };

  /** Rows of the repos view that fit inside its box (title border, summary line, bottom border). */
  const repoWidths = () => {
    const w = dims().width - 6;
    const branch = Math.min(40, Math.max(16, Math.floor(w * 0.3)));
    const item = Math.max(24, w - 6 - 14 - 10);
    return { branch, item };
  };
  const repoSummary = () => {
    const v = repoView();
    if (!v) return repoLoading() ? "Scanning repo roots…" : "";
    const wts = v.repos.flatMap((r) => r.worktrees);
    const linked = wts.filter((w) => w.prs.length || w.tickets.length).length;
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
    const shown = repoQuery() ? ` · ${allWorktrees().length} shown` : "";
    return `${n(v.repos.length, "repo")} · ${n(wts.length, "worktree")} · ${linked} with a watched PR or ticket${shown}${repoLoading() ? " · rescanning…" : ""}`;
  };

  const repoHeading = (repo: RepoEntry) => (
    <>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme().info} flexShrink={0}>
          <b>{repoLabel(repo)}</b>
        </text>
        <text fg={theme().textMuted}> {tilde(repo.path)}</text>
      </box>
      <Show when={repo.error}>
        <text fg={theme().error}>  {repo.error}</text>
      </Show>
    </>
  );

  /** A worktree and the PRs and tickets tied to it; the repo heading rides with its first worktree so both scroll into view together. */
  const worktreeGroup = (repo: RepoEntry, wt: WorktreeEntry, firstOfRepo: boolean) => {
    const n = () => worktreeIndex().get(wt) ?? -1;
    return (
      <box id={`repo-wt-${n()}`} flexDirection="column" flexShrink={0}>
        <Show when={firstOfRepo}>{repoHeading(repo)}</Show>
        <box flexDirection="row" flexShrink={0} backgroundColor={n() === repoSel() ? theme().selectionBackground : undefined}>
          <text flexShrink={0}>{pad(`  ${worktreeLabel(wt)}`, repoWidths().branch)} </text>
          <text fg={theme().textMuted}>
            {tilde(wt.path)}
            {wt.main ? " · main checkout" : ""}
            {wt.locked ? " · locked" : ""}
          </text>
          <text fg={theme().warning} flexShrink={0}>{wt.prunable ? " · missing (prunable)" : ""}</text>
        </box>
        <For each={wt.prs}>
          {(id) => {
            const pr = () => prById(id);
            return (
              <box flexDirection="row" flexShrink={0}>
                <text fg={theme().textSecondary} flexShrink={0}>{pad(`      PR ${prLine(pr() ?? { id })}`, repoWidths().item)} </text>
                <text fg={statusColor(theme(), pr()?.last_status ?? "")} flexShrink={0}>{pad(pr()?.last_status ?? "", 14)}</text>
                <text fg={theme().textMuted}>{(pr()?.session_id ?? "").slice(0, 8)}</text>
              </box>
            );
          }}
        </For>
        <For each={wt.tickets}>
          {(key) => {
            const t = () => ticketByKey(key);
            return (
              <box flexDirection="row" flexShrink={0}>
                <text fg={theme().textSecondary} flexShrink={0}>{pad(`      ${key} - ${t()?.summary ?? ""}`, repoWidths().item)} </text>
                <text fg={statusColor(theme(), t()?.last_status ?? "")} flexShrink={0}>{pad(t()?.last_status ?? "", 14)}</text>
                <text fg={theme().textMuted}>{(t()?.session_id ?? "").slice(0, 8)}</text>
              </box>
            );
          }}
        </For>
      </box>
    );
  };

  const pickWidths = () => {
    const w = modalWidth() - 4;
    const repo = Math.min(36, Math.max(16, Math.floor(w * 0.3)));
    return { repo, title: Math.max(10, w - repo - 7 - 16) };
  };

  /** The Jira tickets that fit in their box, scrolled so the selection stays visible. */
  /** The slice of human comments shown in the details view, scrolled so the selection stays visible. */
  const humanWindow = () => {
    const all = humans();
    const start = Math.max(0, Math.min(humanSel() - HUMAN_ROWS + 1, all.length - HUMAN_ROWS));
    return all.slice(start, start + HUMAN_ROWS);
  };

  const stateColor = (s: DraftState) =>
    ({
      resolved: theme().textMuted,
      drafted: theme().success,
      waiting: theme().pending,
      "no draft": theme().error,
      "not sent": theme().warning,
    })[s];

  /** The slice of filtered PRs that fits on screen, scrolled so the selection stays visible. */
  const pickWindow = () => {
    const rows = Math.max(1, pickerHeight() - 4); // border, filter line, count line
    const all = filtered();
    const start = Math.max(0, Math.min(pickSel() - rows + 1, all.length - rows));
    return all.slice(start, start + rows);
  };

  const hint = (key: string, label: string): Hint => ({ key, label });

  /**
   * The shortcuts for what is on screen now, most used first: the footer shows as many as fit and the
   * `?` dialog lists them all. `prompt` replaces the footer hints while a confirmation is pending.
   */
  const shortcuts = (): { title: string; hints: Hint[]; prompt?: string } => {
    if (trustAlert())
      return { title: "Trust prompts folder", hints: [hint("y", "open Claude there"), hint("esc", "not now")] };
    if (editing() !== null || formEditing() !== null)
      return { title: "Editing a value", hints: [hint("enter", "save"), hint("esc", "cancel")] };
    if (confirmDelete())
      return { title: "Unwatch", prompt: `Unwatch ${current()?.id}? y to confirm, any key to cancel`, hints: [hint("y", "unwatch"), hint("any key", "cancel")] };
    if (confirmDismiss())
      return {
        title: "Dismiss ticket",
        prompt: `Dismiss ${currentTicket()?.key}? It won't be picked up again. y to confirm, any key to cancel`,
        hints: [hint("y", "dismiss"), hint("any key", "cancel")],
      };
    switch (view()) {
      case "history":
        return {
          title: "PR details",
          hints: humans().length
            ? [
                hint("↑↓", "select comment"),
                hint("y", "copy reply"),
                hint("e", "edit reply"),
                hint("x", "resolve/reopen"),
                hint("o", "open comment"),
                hint("esc", "back"),
              ]
            : [hint("o", "open PR"), hint("esc", "back")],
        };
      case "repos": {
        if (repoFiltering())
          return {
            title: "Repos · filter",
            hints: [hint("type", "to filter by repo, branch, path, PR or ticket"), hint("↑↓", "move"), hint("enter", "done"), hint("esc", "clear")],
          };
        const filter = repoQuery() ? [hint("/", "change filter"), hint("esc", "clear filter")] : [hint("/", "filter")];
        return {
          title: "Repos",
          hints: [hint("↑↓", "move"), ...filter, hint("o", "open PR or ticket"), hint("r", "rescan"), hint(repoQuery() ? "q" : "esc", "back")],
        };
      }
      case "routines":
        return {
          title: "Routines",
          hints: [
            hint("↑↓", "move"),
            hint("x/enter", "run now"),
            hint("A", "go to last run's agent"),
            hint("e", "edit ROUTINE.md"),
            hint("r", "rescan"),
            hint("esc", "back"),
          ],
        };
      case "settings":
        if (settingsFiltering())
          return {
            title: "Settings · filter",
            hints: [hint("type", `to filter ${SECTIONS[settingsTab()]}`), hint("↑↓", "move"), hint("tab", "next tab"), hint("enter", "done"), hint("esc", "clear")],
          };
        return {
          title: "Settings",
          hints: [
            hint("tab", "next tab"),
            hint("shift+tab", "previous tab"),
            hint("↑↓", "move"),
            hint("enter", "edit"),
            hint("←→", "change option"),
            ...(settingsQuery() ? [hint("/", "change filter"), hint("esc", "clear filter")] : [hint("/", "filter")]),
            hint("e", "edit template"),
            hint("r", "reload"),
            hint(settingsQuery() ? "q" : "esc", "back"),
          ],
        };
      case "pick-pr":
        return {
          title: "Watch a PR",
          hints: [hint("type", "to filter (org, repo, #number, title)"), hint("↑↓", "move"), hint("enter", "pick"), hint("esc", "back")],
        };
      case "new-watch":
        return {
          title: "New watch",
          hints: [
            hint("↑↓", "move"),
            hint("←→/space", "change"),
            hint("e", "type a model or path"),
            hint("enter", "on [ Watch ] to start"),
            hint("esc", "back"),
          ],
        };
      default: {
        if (!online())
          return { title: "Sessions", hints: [hint("S", "start daemon"), hint("R", "reload config"), hint("s", "settings"), hint("q", "quit")] };
        const l = currentLine();
        const filterHints = listQuery() ? [hint("/", "change filter"), hint("esc", "clear filter")] : [hint("/", "filter")];
        if (listFiltering())
          return { title: "Sessions · filter", hints: [hint("type", "to filter by session, repo, PR, ticket or status"), hint("↑↓", "move"), hint("enter", "done"), hint("esc", "clear")] };
        const detailHints = detailsOpen()
          ? [hint("enter/esc", "close details"), hint("J/K", "scroll history"), hint("h", "full history")]
          : [hint("enter", "session details")];
        const lineHints =
          l?.kind === "pr"
            ? [hint("o", "open PR"), hint("c", "check now"), hint("d", "unwatch")]
            : l?.kind === "ticket"
              ? [hint("o", "open ticket"), hint("d", "dismiss")]
              : l?.kind === "routine"
                ? [hint("x", "run routine now")]
                : [];
        return {
          title: "Sessions",
          hints: [
            hint("↑↓", "move"),
            ...detailHints,
            ...lineHints,
            hint("A", "go to agent"),
            hint("p", "pause/resume"),
            ...filterHints,
            hint("n", "watch a PR"),
            hint("g", "repos"),
            hint("t", "routines"),
            hint("r", "refresh all"),
            hint("s", "settings"),
            hint("R", "reload config"),
            hint("q", "quit"),
          ],
        };
      }
    }
  };

  /** Columns left of the always-shown `? help` (app padding on both sides, a two-space gap). */
  const footerWidth = () => Math.max(0, dims().width - 2 - hintText(HELP_HINT).length - 2);
  const footerLeft = () => {
    const sc = shortcuts();
    return sc.prompt ? pad(sc.prompt, footerWidth()) : fitHints(sc.hints, footerWidth());
  };
  /** The `?` dialog's rows: the current screen's shortcuts, then the two that work everywhere. */
  const helpRows = () =>
    filterHints(
      [
        ...shortcuts().hints.map((h) => ({ ...h, global: false })),
        { key: "?", label: "show or hide this list (works everywhere)", global: true },
        { key: "ctrl+c", label: "quit (works everywhere)", global: true },
      ],
      helpQuery(),
    );
  const showHelpFilter = () => helpFiltering() || helpQuery() !== "";
  const helpHeight = () => Math.max(6, Math.min(shortcuts().hints.length + 7, dims().height - 4));

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={theme().accent}>
          <b>Agent Sentinel</b>
        </text>
        <text fg={theme().textMuted}>
          {online() && status()
            ? `${status()!.multiplexer} · every ${status()!.pollIntervalSec}s · ${
                status()!.nextPollAt ? `next in ${Math.max(0, Math.round((status()!.nextPollAt! - Date.now()) / 1000))}s` : "polling…"
              }${
                status()!.jira?.enabled
                  ? ` · jira ${status()!.jira.nextPollAt ? `in ${Math.max(0, Math.round((status()!.jira.nextPollAt! - Date.now()) / 1000))}s` : "polling…"}`
                  : ""
              }`
            : "daemon offline"}
        </text>
      </box>

      <Show when={!online()}>
        <box border borderColor={theme().warning} padding={1} marginTop={1}>
          <text fg={theme().warning}>
            {starting() ? "Starting Sentinel daemon…" : "Sentinel daemon is not running. Press S (shift+s) to start it."}
          </text>
        </box>
      </Show>
      <Show when={status()?.configError || configError()}>
        <box border borderColor={theme().error} paddingLeft={1} marginTop={1}>
          <text fg={theme().error}>Config error (last good config in use): {status()?.configError || configError()}</text>
        </box>
      </Show>
      <Show when={themeError()}>
        <box border borderColor={theme().error} paddingLeft={1} marginTop={1}>
          <text fg={theme().error}>Theme error (last good theme in use): {themeError()}</text>
        </box>
      </Show>

      <Switch>
        <Match when={view() === "list" || view() === "pick-pr" || view() === "new-watch" || view() === "settings"}>
          {sessionsView()}
          <Show when={detailsOpen()}>{sessionDetailsView()}</Show>
          <Show when={selectedSession() && !detailsOpen()}>
            <box border title=" Details " paddingLeft={1} flexDirection="column" flexShrink={0}>
              <text>
                session {selectedSession()!.sessionId} · {selectedSession()!.agent}
                {selectedSession()!.session?.model ? ` · model ${selectedSession()!.session!.model}` : ""}
                {selectedSession()!.session?.effort ? ` · effort ${selectedSession()!.session!.effort}` : ""}
              </text>
              <text fg={theme().textMuted}>
                cwd {selectedSession()!.session?.cwd ?? selectedSession()!.prs[0]?.cwd ?? selectedSession()!.tickets[0]?.cwd ?? "?"} · pane{" "}
                {selectedSession()!.session?.pane_id ?? "none"} · {sessionState(selectedSession()!.session)}
              </text>
            </box>
          </Show>
          <Show when={currentRoutine() && !detailsOpen()}>
            <box border title=" Details " paddingLeft={1} flexDirection="column" flexShrink={0}>
              <text>
                routine {currentRoutine()!.id} · {currentRoutine()!.schedule} · next {when(currentRoutine()!.nextRunAt)} · session {currentRoutine()!.row?.session_id ?? "none"}
              </text>
              <text fg={theme().textMuted}>
                cwd {tilde(currentRoutine()!.session?.cwd ?? currentRoutine()!.cwd ?? "?")} · pane {currentRoutine()!.session?.pane_id ?? "none"} ·{" "}
                {sessionState(currentRoutine()!.session)}
              </text>
            </box>
          </Show>
          <Show when={currentTicket() && !detailsOpen()}>
            <box border title=" Details " paddingLeft={1} flexDirection="column" flexShrink={0}>
              <text>
                {currentTicket()!.url} · session {currentTicket()!.session_id}
              </text>
              <text fg={theme().textMuted}>
                cwd {currentTicket()!.session?.cwd ?? currentTicket()!.cwd} · pane {currentTicket()!.session?.pane_id ?? "none"} · agent{" "}
                {currentTicket()!.session?.state ?? "?"}
                {currentTicket()!.session?.paused ? " (paused)" : ""}
              </text>
            </box>
          </Show>
          <Show when={current() && !detailsOpen()}>
            <box border title=" Details " paddingLeft={1} flexDirection="column" flexShrink={0}>
              <text>
                {current()!.url} · session {current()!.session_id}
              </text>
              <text fg={theme().textMuted}>
                cwd {current()!.cwd} · pane {current()!.session?.pane_id ?? "none"} · agent{" "}
                {current()!.session?.state ?? "?"}
                {current()!.session?.paused ? " (paused)" : ""}
              </text>
            </box>
          </Show>
        </Match>

        <Match when={view() === "routines"}>
          <box
            flexDirection="column"
            border
            title={` Routines · ${routines().length} · ${tilde(status()?.routines?.dir ?? props.paths.routinesDir)}${status()?.routines && !status()!.routines!.enabled ? " · switched off in settings" : ""} `}
            marginTop={1}
            flexGrow={1}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={theme().textMuted} flexShrink={0}>
              {pad("ROUTINE", routineNameWidth())} {pad("SCHEDULE", 16)} {pad("NEXT", 16)} {pad("LAST RUN", 16)} {pad("STATUS", 13)} REASON
            </text>
            <Show when={routines().length === 0}>
              <text fg={theme().textMuted}>
                No routines yet. Create {tilde(props.paths.routinesDir)}/&lt;id&gt;/ROUTINE.md with name, description and schedule (cron) frontmatter, then
                write the instructions below it. The id is the directory name, lower kebab-case.
              </text>
            </Show>
            <scrollbox flexGrow={1} flexShrink={1} minHeight={0}>
              <For each={routines()}>
                {(r, i) => (
                  <box flexDirection="row" flexShrink={0} backgroundColor={i() === routineSel() ? theme().selectionBackground : undefined}>
                    <text fg={r.valid ? undefined : theme().error} flexShrink={0}>{pad(r.valid ? `${r.id} - ${r.name}` : r.id, routineNameWidth())} </text>
                    <text fg={theme().textSecondary} flexShrink={0}>{pad(r.schedule || "-", 16)} </text>
                    <text fg={theme().info} flexShrink={0}>{pad(when(r.nextRunAt), 16)} </text>
                    <text fg={theme().textMuted} flexShrink={0}>{pad(when(r.row?.last_run_at), 16)} </text>
                    <text fg={statusColor(theme(), routineStatus(r))} flexShrink={0}>{pad(routineStatus(r), 13)} </text>
                    <text fg={r.valid ? theme().textSecondary : theme().error}>
                      {pad((r.error ?? r.row?.last_reason ?? "").replace(/\s+/g, " "), Math.max(10, dims().width - routineNameWidth() - 72))}
                    </text>
                  </box>
                )}
              </For>
            </scrollbox>
          </box>
          <Show when={selectedRoutine()}>
            <box border title={` ${selectedRoutine()!.id} `} paddingLeft={1} flexDirection="column" flexShrink={0}>
              <Show when={selectedRoutine()!.valid} fallback={<text fg={theme().error}>{selectedRoutine()!.error}</text>}>
                <text>
                  {selectedRoutine()!.name}
                  {selectedRoutine()!.description ? ` · ${selectedRoutine()!.description}` : ""}
                </text>
                <text fg={theme().textMuted}>
                  cwd {tilde(selectedRoutine()!.cwd ?? "?")} · model {selectedRoutine()!.model ?? `${config()?.routines.model ?? "default"} (default)`} · effort{" "}
                  {selectedRoutine()!.effort ?? `${config()?.routines.effort ?? "default"} (default)`}
                  {selectedRoutine()!.enabled ? "" : " · disabled"}
                </text>
              </Show>
              <text fg={theme().textMuted}>{tilde(selectedRoutine()!.dir)}</text>
              <For each={selectedRoutine()!.runs}>
                {(run) => (
                  <box flexDirection="row" flexShrink={0}>
                    <text fg={theme().info}>{pad(when(run.started_at), 16)} </text>
                    <text fg={theme().textMuted}>{pad(run.manual ? "manual" : `for ${when(run.slot).slice(-5)}`, 10)} </text>
                    <text fg={statusColor(theme(), run.status)}>{pad(run.status, 13)} </text>
                    <text fg={theme().textMuted}>{pad((run.session_id ?? "").slice(0, 8), 9)}</text>
                    <text fg={theme().textSecondary}>{(run.reason ?? "").replace(/\s+/g, " ")}</text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </Match>

        <Match when={view() === "repos"}>
          <box
            flexDirection="column"
            border
            title={` Repos · ${(repoView()?.roots ?? config()?.newWatch.repoRoots ?? []).join(", ")} `}
            marginTop={1}
            flexGrow={1}
            paddingLeft={1}
            paddingRight={1}
          >
            <Show when={repoError()}>
              <text fg={theme().error}>Could not list repos: {repoError()}</text>
            </Show>
            <text fg={theme().textMuted} flexShrink={0}>
              {repoSummary()}
            </text>
            <Show when={repoFiltering() || repoQuery() !== ""}>
              <box flexDirection="row" height={1} flexShrink={0}>
                <text fg={theme().accent}>/ </text>
                <Show when={repoFiltering()} fallback={<text>{repoQuery()}</text>}>
                  <input
                    value={repoQuery()}
                    focused
                    flexGrow={1}
                    placeholder="filter by repo, branch, path, PR or ticket"
                    onInput={(v) => {
                      setRepoQuery(v);
                      setRepoSel(0);
                    }}
                  />
                </Show>
              </box>
            </Show>
            <Show when={repoQuery() !== "" && (repoView()?.repos.length ?? 0) > 0 && shownRepos().length === 0}>
              <text fg={theme().textMuted}>No repos or worktrees match "{repoQuery()}".</text>
            </Show>
            <Show when={repoView() && repoView()!.repos.length === 0}>
              <text fg={theme().textMuted}>
                No git repositories found two levels under {repoView()!.roots.join(", ")}. Change Pull requests › New watch › Repo roots in settings (s).
              </text>
            </Show>
            <scrollbox ref={(el: ScrollBoxRenderable) => (repoScroll = el)} flexGrow={1} flexShrink={1} minHeight={0}>
              <For each={shownRepos()}>
                {(repo, i) => (
                  <box flexDirection="column" flexShrink={0} marginTop={i() === 0 ? 0 : 1}>
                    <Show when={repo.worktrees.length > 0} fallback={repoHeading(repo)}>
                      <For each={repo.worktrees}>{(wt, j) => worktreeGroup(repo, wt, j() === 0)}</For>
                    </Show>
                  </box>
                )}
              </For>
            </scrollbox>
          </box>
        </Match>

        <Match when={view() === "history"}>
          <Show when={current()?.mergeable === "CONFLICTING"}>
            <text fg={theme().error} marginTop={1} flexShrink={0}>
              Merge conflict with {current()?.base_ref ? `\`${current()!.base_ref}\`` : "the base branch"}. Sentinel resumes the agent once per head commit to resolve it.
            </text>
          </Show>
          <Show when={humans().length > 0}>
            <box
              flexDirection="column"
              border
              borderColor={theme().accent}
              title={` Human comments · ${humans().filter((c) => humanState(c) !== "resolved").length} open · ${current()?.id ?? ""} `}
              marginTop={1}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <For each={humanWindow()}>
                {(c) => (
                  <box flexDirection="row" flexShrink={0} backgroundColor={c === selectedHuman() ? theme().selectionBackground : undefined}>
                    <text fg={stateColor(humanState(c))}>{pad(STATE_LABEL[humanState(c)], 14)} </text>
                    <text fg={theme().info}>{pad(`@${c.author ?? "unknown"}`, 18)} </text>
                    <text fg={theme().textMuted}>{pad(humanCommentLocation(c), 28)} </text>
                    <text fg={theme().textSecondary}>{pad(c.body.replace(/\s+/g, " "), Math.max(10, dims().width - 70))}</text>
                  </box>
                )}
              </For>
            </box>
            <Show when={selectedHuman()}>
              {(c: () => HumanCommentRow) => (
                <box flexDirection="column" border title={` ${c().item_id} `} flexShrink={0} paddingLeft={1} paddingRight={1}>
                  <text fg={theme().textSecondary}>{clip(c().body, 600)}</text>
                  <Show
                    when={c().draft_summary || c().draft_change || c().draft_reply}
                    fallback={<text fg={theme().textMuted}>{STATE_HINT[humanState(c())]}</text>}
                  >
                    <Show when={c().draft_summary}>
                      <text marginTop={1}>{`About:  ${c().draft_summary}`}</text>
                    </Show>
                    <Show when={c().draft_change}>
                      <text>{`Change: ${c().draft_change}`}</text>
                    </Show>
                    <Show when={c().draft_reply}>
                      <text marginTop={1} fg={theme().textMuted}>
                        Proposed reply{c().draft_by === "user" ? " (edited by you)" : ""} · y copy · e edit
                      </text>
                      <text fg={theme().success}>{clip(c().draft_reply!, 1200)}</text>
                    </Show>
                  </Show>
                </box>
              )}
            </Show>
          </Show>
          <scrollbox border title={` History · ${current()?.id ?? ""} `} marginTop={humans().length > 0 ? 0 : 1} flexGrow={1} paddingLeft={1}>
            <For each={history()} fallback={<text fg={theme().textMuted}>No events yet.</text>}>
              {(ev) => (
                <box flexDirection="column" marginBottom={1}>
                  <text fg={theme().info}>
                    {new Date(ev.ts).toLocaleString()} · {ev.kind}
                  </text>
                  <Show when={ev.detail}>
                    <text fg={theme().textSecondary}>{JSON.stringify(ev.detail).slice(0, 600)}</text>
                  </Show>
                </box>
              )}
            </For>
          </scrollbox>
        </Match>

      </Switch>

      <Show when={view() === "pick-pr" || view() === "settings" || (view() === "new-watch" && form())}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={10} alignItems="center" justifyContent="center">
          <Switch>
            <Match when={view() === "pick-pr"}>
              <box flexDirection="column" border borderColor={theme().accent} title=" Watch a PR " backgroundColor={theme().modalBackground} width={modalWidth()} height={pickerHeight()} paddingLeft={1} paddingRight={1}>
                <box flexDirection="row" height={1}>
                  <text fg={theme().accent}>filter › </text>
                  <input
                    value={query()}
                    focused
                    flexGrow={1}
                    placeholder="org, repo, #number or title"
                    onInput={(v) => {
                      setQuery(v);
                      setPickSel(0);
                    }}
                  />
                </box>
                <Switch>
                  <Match when={myPrsError()}>
                    <text fg={theme().error}>Could not list your PRs: {myPrsError()}</text>
                  </Match>
                  <Match when={myPrs() === null}>
                    <text fg={theme().textMuted}>Loading your open PRs…</text>
                  </Match>
                  <Match when={filtered().length === 0}>
                    <text fg={theme().textMuted}>{myPrs()!.length === 0 ? "You have no open PRs." : "No PRs match the filter."}</text>
                  </Match>
                  <Match when={true}>
                    <text fg={theme().textMuted}>
                      {filtered().length} of {myPrs()!.length} open PRs
                    </text>
                    <For each={pickWindow()}>
                      {(pr) => (
                        <box flexDirection="row" backgroundColor={pr === filtered()[pickSel()] ? theme().selectionBackground : undefined}>
                          <text>
                            {pad(`${pr.owner}/${pr.repo}`, pickWidths().repo)} {pad(`#${pr.number}`, 7)}{" "}
                          </text>
                          <text fg={theme().textSecondary}>{pad(pr.title, pickWidths().title)} </text>
                          <text fg={theme().textMuted}>{pr.isDraft ? "draft " : ""}</text>
                          <text fg={theme().info}>{pr.watched ? "watched" : ""}</text>
                        </box>
                      )}
                    </For>
                  </Match>
                </Switch>
              </box>
            </Match>
            <Match when={view() === "new-watch" && form()}>
              <box flexDirection="column" border borderColor={theme().accent} title=" New watch " backgroundColor={theme().modalBackground} width={modalWidth()} paddingLeft={1} paddingRight={1} paddingBottom={1}>
                <text>
                  {form()!.pr.owner}/{form()!.pr.repo} #{form()!.pr.number} · {form()!.pr.title}
                </text>
                <text fg={theme().textMuted} marginBottom={1}>
                  {form()!.pr.url} · Sentinel creates a new claude session for this PR
                </text>
                <For each={FORM_FIELDS}>
                  {(field, i) => (
                    <box flexDirection="row" backgroundColor={i() === formSel() ? theme().selectionBackground : undefined}>
                      <text fg={theme().textMuted}>{pad(field.label, 20)} </text>
                      <Show
                        when={formEditing() !== null && formEditing() === field.key}
                        fallback={
                          <text fg={field.kind === "submit" ? theme().accent : field.kind === "fixed" ? theme().textMuted : undefined}>
                            {field.kind === "submit" && submitting()
                              ? "[ Working… ]"
                              : field.kind === "enum" && i() === formSel()
                                ? `‹ ${displayField(field.key, form()!)} ›`
                                : displayField(field.key, form()!)}
                          </text>
                        }
                      >
                        <input
                          value={formDraft}
                          focused
                          flexGrow={1}
                          onInput={(v) => (formDraft = v)}
                          onSubmit={(v) => submitFormEdit(typeof v === "string" ? v : formDraft)}
                        />
                      </Show>
                    </box>
                  )}
                </For>
                <Show when={formMsg()}>
                  <text fg={formMsg()!.error ? theme().error : theme().pending} marginTop={1}>
                    {formMsg()!.text}
                  </text>
                </Show>
              </box>
            </Match>
            <Match when={view() === "settings"}>
              <box flexDirection="column" border borderColor={theme().accent} title={` Settings · ${props.paths.config} `} backgroundColor={theme().modalBackground} width={modalWidth()} height={settingsHeight()} paddingLeft={1} paddingRight={1}>
                <Show when={config()} fallback={<text fg={theme().error}>Config could not be loaded: {configError()}</text>}>
                  <box flexDirection="row" height={1} flexShrink={0} marginBottom={1}>
                    <For each={SECTIONS}>
                      {(sec, i) => (
                        <text
                          fg={i() === settingsTab() ? theme().modalBackground : theme().textMuted}
                          bg={i() === settingsTab() ? theme().accent : undefined}
                          marginRight={1}
                        >
                          {` ${sec} `}
                        </text>
                      )}
                    </For>
                    <text fg={theme().textMuted}> tab / shift+tab</text>
                  </box>
                  <Show when={showSettingsFilter()}>
                    <box flexDirection="row" height={1}>
                      <text fg={theme().accent}>/ </text>
                      <Show when={settingsFiltering()} fallback={<text>{settingsQuery()}</text>}>
                        <input
                          value={settingsQuery()}
                          focused
                          flexGrow={1}
                          placeholder={`filter ${SECTIONS[settingsTab()]} by name`}
                          onInput={(v) => {
                            setSettingsQuery(v);
                            setFieldSel(0);
                          }}
                        />
                      </Show>
                    </box>
                  </Show>
                  <Show when={shownFields().length === 0}>
                    <text fg={theme().textMuted}>No {SECTIONS[settingsTab()]} settings match "{settingsQuery()}".</text>
                  </Show>
                  <For each={settingsWindow()}>
                    {(row, i) =>
                      row.kind === "group" ? (
                        <box height={1} marginTop={i() === 0 ? 0 : 1} flexShrink={0}>
                          <text fg={theme().accent}>
                            <b>{row.title}</b>
                          </text>
                        </box>
                      ) : (
                        settingsFieldRow(row.field)
                      )
                    }
                  </For>
                </Show>
              </box>
            </Match>
          </Switch>
        </box>
      </Show>

      <Show when={trustAlert()}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={15} alignItems="center" justifyContent="center">
          <box flexDirection="column" border borderColor={theme().info} title=" Trust Sentinel's prompts folder " backgroundColor={theme().modalBackground} width={modalWidth()} paddingLeft={1} paddingRight={1}>
            <text>Sentinel gives the Claude sessions it starts access to its prompts folder, {tilde(props.paths.promptsDir)}, where it writes their instructions.</text>
            <text marginTop={1}>
              Until you trust that folder, Claude Code asks about it each time Sentinel starts a session, and the session waits there for your answer. Trust it once and Claude Code remembers.
            </text>
            <text marginTop={1} fg={promptsTrusted() ? theme().success : theme().warning}>
              {promptsTrusted() ? "Claude Code already trusts this folder." : "Claude Code doesn't trust this folder yet."}
            </text>
            <box flexDirection="column" marginTop={1}>
              <box flexDirection="row">
                <text fg={theme().accent}>{pad("y", 5)}</text>
                <text>Open Claude in the folder in a new tab. Answer yes to trust it, then quit with /exit.</text>
              </box>
              <box flexDirection="row">
                <text fg={theme().accent}>{pad("esc", 5)}</text>
                <text>Not now. You can do this later from Settings › General › Setup.</text>
              </box>
            </box>
          </box>
        </box>
      </Show>

      <Show when={helpOpen()}>
        <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={20} alignItems="center" justifyContent="center">
          <box
            flexDirection="column"
            border
            borderColor={theme().accent}
            title={` Shortcuts · ${shortcuts().title} `}
            backgroundColor={theme().modalBackground}
            width={Math.max(40, Math.min(70, dims().width - 8))}
            height={helpHeight()}
            paddingLeft={1}
            paddingRight={1}
          >
            <Show when={showHelpFilter()}>
              <box flexDirection="row" height={1} flexShrink={0}>
                <text fg={theme().accent}>/ </text>
                <text>{helpQuery()}</text>
                <text fg={theme().accent}>{helpFiltering() ? "▏" : ""}</text>
              </box>
            </Show>
            <scrollbox ref={(el: ScrollBoxRenderable) => (helpScroll = el)} flexGrow={1} minHeight={0}>
              <Show when={helpRows().length > 0} fallback={<text fg={theme().textMuted}>No shortcuts match "{helpQuery()}".</text>}>
                <For each={helpRows()}>
                  {(h, i) => (
                    <box flexDirection="row" flexShrink={0} marginTop={h.global && !helpRows()[i() - 1]?.global && i() > 0 ? 1 : 0}>
                      <text fg={theme().accent} flexShrink={0}>
                        {pad(h.key, 12)}{" "}
                      </text>
                      <text fg={h.global ? theme().textMuted : undefined}>{h.label}</text>
                    </box>
                  )}
                </For>
              </Show>
            </scrollbox>
            <text fg={theme().textMuted} flexShrink={0}>
              {helpFiltering()
                ? "type to filter by key or action · enter done · esc clear"
                : helpQuery()
                  ? "/ change filter · esc clear filter · ? or enter to close"
                  : "/ filter · esc, ? or enter to close"}
            </text>
          </box>
        </box>
      </Show>

      <box height={1} marginTop={1} flexDirection="row">
        <box flexGrow={1} flexShrink={1} minWidth={0} height={1}>
          <Show when={flash()} fallback={<text fg={theme().textMuted}>{footerLeft()}</text>}>
            <text fg={flash()!.error ? theme().error : theme().success}>{pad(flash()!.text, footerWidth())}</text>
          </Show>
        </box>
        <text fg={theme().textMuted} flexShrink={0}>
          {"  "}
          {hintText(HELP_HINT)}
        </text>
      </box>
    </box>
  );
}

export async function runTui(paths: Paths) {
  await render(() => <App paths={paths} />, { exitOnCtrlC: false });
}
