import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, type Config } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import type { EventRow, HumanCommentRow } from "../core/types.ts";
import { copyToClipboard } from "./clipboard.ts";
import type { MyPr, NewWatchDefaults, PrListEntry, RepoEntry, RepoView, RpcMethod, RpcMethods, StatusInfo, TicketListEntry, WorktreeEntry } from "../daemon/protocol.ts";
import { Client } from "../cli/client.ts";
import { startDaemon as startDaemonProcess } from "../cli/daemon-control.ts";
import { openUrl as defaultOpenUrl } from "../cli/open-url.ts";
import { ago, draftState, humanCommentLocation, mergeLabel, prGroup, prLine, sortByGroup, type DraftState } from "../cli/format.ts";
import { cycleField, displayField, FORM_FIELDS, initialForm, watchRequest, type NewWatchForm } from "./new-watch.ts";
import { filterPrs, filterWatched } from "./pr-filter.ts";
import type { ScrollBoxRenderable } from "@opentui/core";
import { filterRepos, repoLabel, tilde, worktreeLabel } from "./repo-labels.ts";
import { filterHints, fitHints, HELP_HINT, hintText, type Hint } from "./shortcuts.ts";
import { cycleEnum, displayValue, editText, FIELDS, filterFields, parseValue } from "./settings.ts";
import { DEFAULT_THEME, loadTheme, statusColor, watchTheme, type Theme } from "./theme.ts";

type View = "list" | "history" | "settings" | "pick-pr" | "new-watch" | "repos";

/** The daemon RPC surface the TUI uses; tests pass one backed by an in-process daemon. */
export interface RpcClient {
  call<M extends RpcMethod>(method: M, params: RpcMethods[M][0], timeoutMs?: number): Promise<RpcMethods[M][1]>;
}

/** Most Jira ticket rows shown before the list scrolls. */
const TICKET_ROWS = 6;

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
}

export function App(props: AppProps) {
  const client: RpcClient = props.client ?? new Client(props.paths.socket);
  const renderer = useRenderer();
  const dims = useTerminalDimensions();

  const [view, setView] = createSignal<View>("list");
  const [prs, setPrs] = createSignal<PrListEntry[]>([]);
  const [status, setStatus] = createSignal<StatusInfo | null>(null);
  const [online, setOnline] = createSignal(true);
  const [sel, setSel] = createSignal(0);
  const [listQuery, setListQuery] = createSignal("");
  /** The watched-PR filter input has focus. */
  const [listFiltering, setListFiltering] = createSignal(false);
  /** Watched PRs after the `/` filter; `sel` indexes this list. */
  const shownPrs = () => filterWatched(prs(), listQuery());
  const [tickets, setTickets] = createSignal<TicketListEntry[]>([]);
  /** The Jira tickets list has the selection instead of the PR list. */
  const [ticketFocus, setTicketFocus] = createSignal(false);
  const [ticketSel, setTicketSel] = createSignal(0);
  const [confirmDismiss, setConfirmDismiss] = createSignal(false);
  const currentTicket = () => (ticketFocus() ? tickets()[ticketSel()] : undefined);
  const showTickets = () => !!status()?.jira?.enabled || tickets().length > 0;
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
  const shownFields = () => filterFields(FIELDS, settingsQuery());
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

  const refresh = async () => {
    try {
      const [st, list] = await Promise.all([client.call("status", {}, 3000), client.call("list", {}, 3000)]);
      setStatus(st);
      // Keep the same PR selected when the order changes.
      const selectedId = shownPrs()[sel()]?.id;
      setPrs(sortByGroup(list));
      setOnline(true);
      // An older daemon has no ticket support; treat that as no tickets.
      const ts = await client.call("tickets", {}, 3000).catch(() => [] as TicketListEntry[]);
      const selectedKey = tickets()[ticketSel()]?.key;
      setTickets(ts);
      const keptTicket = selectedKey ? ts.findIndex((t) => t.key === selectedKey) : -1;
      if (keptTicket >= 0) setTicketSel(keptTicket);
      else if (ticketSel() >= ts.length) setTicketSel(Math.max(0, ts.length - 1));
      if (ts.length === 0) setTicketFocus(false);
      if (view() === "history" && selectedId) await loadDetails(selectedId).catch(() => {});
      const shown = shownPrs();
      const kept = selectedId ? shown.findIndex((p) => p.id === selectedId) : -1;
      if (kept >= 0) setSel(kept);
      else if (sel() >= shown.length) setSel(Math.max(0, shown.length - 1));
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
  });
  onCleanup(() => themeWatcher.close());
  void refresh();
  const interval = setInterval(refresh, 2000);
  onCleanup(() => clearInterval(interval));

  const current = () => shownPrs()[sel()];

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
      const i = shownPrs().findIndex((x) => x.id === r.id);
      if (i >= 0) setSel(i);
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
        const last = shownPrs().length - 1;
        if (key.name === "escape") {
          setListQuery("");
          setListFiltering(false);
          setSel(0);
        } else if (key.name === "return") setListFiltering(false);
        else if (key.name === "up") setSel((i) => Math.max(0, i - 1));
        else if (key.name === "down") setSel((i) => Math.min(last, i + 1));
        return; // everything else goes to the filter input
      }
      if (!confirmDelete() && (key.name === "/" || key.sequence === "/")) {
        await nextTick();
        setListFiltering(true);
        return;
      }
      if (!confirmDelete() && key.name === "escape" && listQuery()) {
        setListQuery("");
        setSel(0);
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
      if (key.name === "t" && !confirmDelete()) {
        if (tickets().length === 0) notify(showTickets() ? "No Jira tickets picked up yet" : "Jira tickets are off (jira.enabled in settings)", true);
        else setTicketFocus((f) => !f);
        return;
      }
      if (ticketFocus() && !confirmDelete()) {
        const t = currentTicket();
        switch (key.name) {
          case "escape":
            setTicketFocus(false);
            return;
          case "up":
          case "k":
            setTicketSel((i) => Math.max(0, i - 1));
            return;
          case "down":
          case "j":
            setTicketSel((i) => Math.min(tickets().length - 1, i + 1));
            return;
          case "return":
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
        case "up":
        case "k":
          setSel((i) => Math.max(0, i - 1));
          return;
        case "down":
        case "j":
          setSel((i) => Math.min(shownPrs().length - 1, i + 1));
          return;
        case "return":
          await openHistory();
          return;
        case "s":
          if (key.shift) {
            if (!online()) await startDaemon();
            return;
          }
          readConfig();
          setSettingsQuery("");
          setSettingsFiltering(false);
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
        case "return":
        case "space":
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
      notify(`${field.label}: ${(e as Error).message}`, true);
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

  /** The watch dialogs float over the PR list. */
  const modalWidth = () => Math.max(40, Math.min(100, dims().width - 12));
  const pickerHeight = () => Math.max(8, Math.min(18, dims().height - 10));

  const showSettingsFilter = () => settingsFiltering() || settingsQuery() !== "";
  const settingsHeight = () =>
    Math.max(6, Math.min(FIELDS.length + 2 + (showSettingsFilter() ? 1 : 0), dims().height - 8));

  /** The slice of settings that fits in the dialog, scrolled so the selection stays visible. */
  const settingsWindow = () => {
    const rows = settingsHeight() - 2 - (showSettingsFilter() ? 1 : 0);
    const all = shownFields();
    const start = Math.max(0, Math.min(fieldSel() - rows + 1, all.length - rows));
    return all.slice(start, start + rows);
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

  const ticketWindow = () => {
    const all = tickets();
    const start = Math.max(0, Math.min(ticketSel() - TICKET_ROWS + 1, all.length - TICKET_ROWS));
    return all.slice(start, start + TICKET_ROWS);
  };

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
      case "settings":
        if (settingsFiltering())
          return { title: "Settings · filter", hints: [hint("type", "to filter settings"), hint("↑↓", "move"), hint("enter", "done"), hint("esc", "clear")] };
        return {
          title: "Settings",
          hints: [
            hint("↑↓", "move"),
            hint("enter", "edit/cycle"),
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
      default:
        if (!online())
          return { title: "Watched PRs", hints: [hint("S", "start daemon"), hint("R", "reload config"), hint("s", "settings"), hint("q", "quit")] };
        if (listFiltering())
          return { title: "Watched PRs · filter", hints: [hint("type", "to filter by repo or title"), hint("↑↓", "move"), hint("enter", "done"), hint("esc", "clear")] };
        if (ticketFocus())
          return {
            title: "Jira tickets",
            hints: [
              hint("↑↓", "move"),
              hint("o", "open ticket"),
              hint("A", "go to agent"),
              hint("d", "dismiss"),
              hint("p", "pause/resume"),
              hint("t/esc", "back to PRs"),
              hint("r", "refresh all"),
              hint("q", "quit"),
            ],
          };
        return {
          title: "Watched PRs",
          hints: [
            hint("↑↓", "move"),
            ...(listQuery() ? [hint("/", "change filter"), hint("esc", "clear filter")] : [hint("/", "filter")]),
            hint("enter", "details & human comments"),
            hint("o", "open"),
            hint("A", "go to agent"),
            hint("n", "watch a PR"),
            hint("g", "repos"),
            hint("c", "check now"),
            hint("r", "refresh all"),
            hint("d", "unwatch"),
            hint("p", "pause/resume"),
            ...(showTickets() ? [hint("t", "tickets")] : []),
            hint("s", "settings"),
            hint("R", "reload config"),
            hint("q", "quit"),
          ],
        };
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
          <box flexDirection="column" border title={humanTotal() > 0 ? ` Watched PRs · ${humanTotal()} human comment(s) need you ` : " Watched PRs "} marginTop={1} flexGrow={1} paddingLeft={1} paddingRight={1}>
            <text fg={theme().textMuted} flexShrink={0}>
              {pad("PR", widths().pr)} {pad("AGENT", widths().agent)} {pad("SESSION", widths().session)}{" "}
              {pad("CHECKED", widths().checked)} {pad("HUMAN", widths().human)} {pad("MERGE", widths().merge)}{" "}
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
                    placeholder="filter by repo or title"
                    onInput={(v) => {
                      setListQuery(v);
                      setSel(0);
                    }}
                  />
                </Show>
              </box>
            </Show>
            <Show when={prs().length > 0 && shownPrs().length === 0}>
              <text fg={theme().textMuted}>No watched PRs match "{listQuery()}".</text>
            </Show>
            <Show when={prs().length > 0} fallback={<text fg={theme().textMuted}>No PRs watched. Press n to pick one of your PRs, or hand off from an agent with `sentinel watch &lt;pr&gt;`.</text>}>
              <For each={shownPrs()}>
                {(pr, i) => (
                  <>
                    <Show when={i() === 0 || prGroup(shownPrs()[i() - 1]!.id) !== prGroup(pr.id)}>
                      <text fg={theme().info} flexShrink={0} marginTop={i() === 0 ? 0 : 1}>
                        <b>{prGroup(pr.id)}</b>
                      </text>
                    </Show>
                    <box flexDirection="row" flexShrink={0} backgroundColor={i() === sel() && !ticketFocus() ? theme().selectionBackground : undefined}>
                    <text>
                      {pad(`  ${prLine(pr)}`, widths().pr)} {pad(pr.agent, widths().agent)}{" "}
                      {pad(pr.session_id.slice(0, 8) + (pr.session?.paused ? " ⏸" : ""), widths().session)}{" "}
                      {pad(ago(pr.last_checked_at), widths().checked)}{" "}
                    </text>
                    <text fg={(pr.humanOpen ?? 0) > 0 ? theme().warning : theme().textMuted}>
                      {pad((pr.humanOpen ?? 0) > 0 ? `${pr.humanOpen} open` : "-", widths().human)}{" "}
                    </text>
                    <text fg={pr.mergeable === "CONFLICTING" ? theme().error : theme().textMuted}>
                      {pad(mergeLabel(pr), widths().merge)}{" "}
                    </text>
                    <text fg={statusColor(theme(), pr.last_status)}>{pad(pr.last_status, widths().status)} </text>
                    <text fg={theme().textSecondary}>{pad((pr.last_reason ?? "").replace(/\s+/g, " "), widths().reason)}</text>
                    </box>
                  </>
                )}
              </For>
            </Show>
          </box>
          <Show when={showTickets()}>
            <box
              flexDirection="column"
              border
              borderColor={ticketFocus() ? theme().accent : undefined}
              title={` Jira tickets · label "${status()?.jira?.label ?? ""}" `}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
            >
              <Show when={status()?.jira?.error}>
                <text fg={theme().error}>Jira poll failed: {status()!.jira.error}</text>
              </Show>
              <Show
                when={tickets().length > 0}
                fallback={<text fg={theme().textMuted}>No tickets picked up yet. Assign yourself a ticket and add the label to start an agent on it.</text>}
              >
                <For each={ticketWindow()}>
                  {(t) => (
                    <box flexDirection="row" flexShrink={0} backgroundColor={ticketFocus() && t === currentTicket() ? theme().selectionBackground : undefined}>
                      <text>
                        {pad(`${t.key} - ${t.summary ?? ""}`, widths().pr)} {pad("claude", widths().agent)}{" "}
                        {pad(t.session_id.slice(0, 8) + (t.session?.paused ? " ⏸" : ""), widths().session)}{" "}
                        {pad(ago(t.picked_at), widths().checked)}{" "}
                        {pad("", widths().human)}{" "}
                      </text>
                      <text fg={statusColor(theme(), t.last_status)}>{pad(t.last_status, widths().status)} </text>
                      <text fg={theme().textSecondary}>{pad((t.last_reason ?? "").replace(/\s+/g, " "), widths().reason)}</text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          </Show>
          <Show when={currentTicket()}>
            <box border title=" Details " paddingLeft={1} flexDirection="column">
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
          <Show when={!ticketFocus() && current()}>
            <box border title=" Details " paddingLeft={1} flexDirection="column">
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
                No git repositories found two levels under {repoView()!.roots.join(", ")}. Change "New watch: repo roots" in settings (s).
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
                            {field.kind === "submit" && submitting() ? "[ Working… ]" : displayField(field.key, form()!)}
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
                  <Show when={showSettingsFilter()}>
                    <box flexDirection="row" height={1}>
                      <text fg={theme().accent}>/ </text>
                      <Show when={settingsFiltering()} fallback={<text>{settingsQuery()}</text>}>
                        <input
                          value={settingsQuery()}
                          focused
                          flexGrow={1}
                          placeholder="filter settings by name"
                          onInput={(v) => {
                            setSettingsQuery(v);
                            setFieldSel(0);
                          }}
                        />
                      </Show>
                    </box>
                  </Show>
                  <Show when={shownFields().length === 0}>
                    <text fg={theme().textMuted}>No settings match "{settingsQuery()}".</text>
                  </Show>
                  <For each={settingsWindow()}>
                    {(field) => (
                      <box flexDirection="row" height={1} backgroundColor={field === selectedField() ? theme().selectionBackground : undefined}>
                        <text fg={theme().textMuted}>{pad(field.label, 38)} </text>
                        <Show when={editing() !== null && field === selectedField()} fallback={<text>{pad(displayValue(field, config()!), modalWidth() - 44)}</text>}>
                          <input
                            value={editing()!}
                            focused
                            flexGrow={1}
                            onInput={(v) => (draft = v)}
                            onSubmit={(v) => void submitEdit(typeof v === "string" ? v : draft)}
                          />
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Match>
          </Switch>
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
