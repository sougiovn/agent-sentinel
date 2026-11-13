import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, type Config } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import type { EventRow } from "../core/types.ts";
import type { MyPr, NewWatchDefaults, PrListEntry, RpcMethod, RpcMethods, StatusInfo } from "../daemon/protocol.ts";
import { Client } from "../cli/client.ts";
import { startDaemon as startDaemonProcess } from "../cli/daemon-control.ts";
import { openUrl as defaultOpenUrl } from "../cli/open-url.ts";
import { ago, prGroup, prLine, sortByGroup } from "../cli/format.ts";
import { cycleField, displayField, FORM_FIELDS, initialForm, watchRequest, type NewWatchForm } from "./new-watch.ts";
import { filterPrs, filterWatched } from "./pr-filter.ts";
import { cycleEnum, displayValue, editText, FIELDS, filterFields, parseValue } from "./settings.ts";

type View = "list" | "history" | "settings" | "pick-pr" | "new-watch";

/** The daemon RPC surface the TUI uses; tests pass one backed by an in-process daemon. */
export interface RpcClient {
  call<M extends RpcMethod>(method: M, params: RpcMethods[M][0], timeoutMs?: number): Promise<RpcMethods[M][1]>;
}

const MODAL_BG = "#1e272e";

const STATUS_COLOR: Record<string, string> = {
  no_changes: "#7f8c8d",
  no_action: "#95a5a6",
  pending: "#7f8c8d",
  fix_spawned: "#3498db",
  fix_running: "#f1c40f",
  spawn_failed: "#e74c3c",
  error: "#e74c3c",
};

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
  const [history, setHistory] = createSignal<EventRow[]>([]);
  const [flash, setFlash] = createSignal<{ text: string; error: boolean } | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [config, setConfig] = createSignal<Config | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
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

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (text: string, error = false) => {
    setFlash({ text, error });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(null), 5000);
  };

  const refresh = async () => {
    try {
      const [st, list] = await Promise.all([client.call("status", {}, 3000), client.call("list", {}, 3000)]);
      setStatus(st);
      // Keep the same PR selected when the order changes.
      const selectedId = shownPrs()[sel()]?.id;
      setPrs(sortByGroup(list));
      setOnline(true);
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

  const reloadAll = async () => {
    readConfig();
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
      else notify(r.checked.length ? `Refreshed ${r.checked.length} PR${r.checked.length === 1 ? "" : "s"}` : "Refreshed (no PRs watched)");
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

  const openHistory = async () => {
    const pr = current();
    if (!pr) return;
    try {
      setHistory(await client.call("history", { pr: pr.id }));
      setView("history");
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
    if (v === "history") {
      if (key.name === "escape" || key.name === "q" || key.name === "backspace") setView("list");
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
    const fixed = { agent: 7, session: 10, checked: 10, status: 13 };
    const rest = Math.max(20, w - fixed.agent - fixed.session - fixed.checked - fixed.status - 5);
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

  const pickWidths = () => {
    const w = modalWidth() - 4;
    const repo = Math.min(36, Math.max(16, Math.floor(w * 0.3)));
    return { repo, title: Math.max(10, w - repo - 7 - 16) };
  };

  /** The slice of filtered PRs that fits on screen, scrolled so the selection stays visible. */
  const pickWindow = () => {
    const rows = Math.max(1, pickerHeight() - 4); // border, filter line, count line
    const all = filtered();
    const start = Math.max(0, Math.min(pickSel() - rows + 1, all.length - rows));
    return all.slice(start, start + rows);
  };

  const footer = () => {
    if (editing() !== null || formEditing() !== null) return "enter save · esc cancel";
    if (confirmDelete()) return `Unwatch ${current()?.id}? y to confirm, any key to cancel`;
    switch (view()) {
      case "history":
        return "esc back";
      case "settings":
        if (settingsFiltering()) return "type to filter settings · ↑↓ move · enter done · esc clear";
        return settingsQuery()
          ? "↑↓ move · enter edit/cycle · / change filter · esc clear filter"
          : "↑↓ move · enter edit/cycle · / filter · e edit template · r reload · esc back";
      case "pick-pr":
        return "type to filter (org, repo, #number, title) · ↑↓ move · enter pick · esc back";
      case "new-watch":
        return "↑↓ move · ←→/space change · e type a model or path · enter on [ Watch ] to start · esc back";
      default:
        if (listFiltering()) return "type to filter by repo or title · ↑↓ move · enter done · esc clear";
        if (listQuery())
          return "↑↓ move · enter history · o open · / change filter · esc clear filter · c check · r refresh · d unwatch · p pause";
        return online()
          ? "↑↓ move · / filter · enter history · o open · n watch a PR · c check now · r refresh all · d unwatch · p pause/resume · s settings · R reload · q quit"
          : "S start daemon · R reload config · q quit";
    }
  };

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1}>
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg="#2ecc71">
          <b>Agent Sentinel</b>
        </text>
        <text fg="#7f8c8d">
          {online() && status()
            ? `${status()!.multiplexer} · every ${status()!.pollIntervalSec}s · ${
                status()!.nextPollAt ? `next in ${Math.max(0, Math.round((status()!.nextPollAt! - Date.now()) / 1000))}s` : "polling…"
              }`
            : "daemon offline"}
        </text>
      </box>

      <Show when={!online()}>
        <box border borderColor="#e67e22" padding={1} marginTop={1}>
          <text fg="#e67e22">
            {starting() ? "Starting Sentinel daemon…" : "Sentinel daemon is not running. Press S (shift+s) to start it."}
          </text>
        </box>
      </Show>
      <Show when={status()?.configError || configError()}>
        <box border borderColor="#e74c3c" paddingLeft={1} marginTop={1}>
          <text fg="#e74c3c">Config error (last good config in use): {status()?.configError || configError()}</text>
        </box>
      </Show>

      <Switch>
        <Match when={view() === "list" || view() === "pick-pr" || view() === "new-watch" || view() === "settings"}>
          <box flexDirection="column" border title=" Watched PRs " marginTop={1} flexGrow={1} paddingLeft={1} paddingRight={1}>
            <text fg="#7f8c8d" flexShrink={0}>
              {pad("PR", widths().pr)} {pad("AGENT", widths().agent)} {pad("SESSION", widths().session)}{" "}
              {pad("CHECKED", widths().checked)} {pad("STATUS", widths().status)} REASON
            </text>
            <Show when={listFiltering() || listQuery() !== ""}>
              <box flexDirection="row" height={1} flexShrink={0}>
                <text fg="#2ecc71">/ </text>
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
              <text fg="#7f8c8d">No watched PRs match "{listQuery()}".</text>
            </Show>
            <Show when={prs().length > 0} fallback={<text fg="#7f8c8d">No PRs watched. Press n to pick one of your PRs, or hand off from an agent with `sentinel watch &lt;pr&gt;`.</text>}>
              <For each={shownPrs()}>
                {(pr, i) => (
                  <>
                    <Show when={i() === 0 || prGroup(shownPrs()[i() - 1]!.id) !== prGroup(pr.id)}>
                      <text fg="#3498db" flexShrink={0} marginTop={i() === 0 ? 0 : 1}>
                        <b>{prGroup(pr.id)}</b>
                      </text>
                    </Show>
                    <box flexDirection="row" flexShrink={0} backgroundColor={i() === sel() ? "#2c3e50" : undefined}>
                    <text>
                      {pad(`  ${prLine(pr)}`, widths().pr)} {pad(pr.agent, widths().agent)}{" "}
                      {pad(pr.session_id.slice(0, 8) + (pr.session?.paused ? " ⏸" : ""), widths().session)}{" "}
                      {pad(ago(pr.last_checked_at), widths().checked)}{" "}
                    </text>
                    <text fg={STATUS_COLOR[pr.last_status] ?? "#ecf0f1"}>{pad(pr.last_status, widths().status)} </text>
                    <text fg="#bdc3c7">{pad((pr.last_reason ?? "").replace(/\s+/g, " "), widths().reason)}</text>
                    </box>
                  </>
                )}
              </For>
            </Show>
          </box>
          <Show when={current()}>
            <box border title=" Details " paddingLeft={1} flexDirection="column">
              <text>
                {current()!.url} · session {current()!.session_id}
              </text>
              <text fg="#7f8c8d">
                cwd {current()!.cwd} · pane {current()!.session?.pane_id ?? "none"} · agent{" "}
                {current()!.session?.state ?? "?"}
                {current()!.session?.paused ? " (paused)" : ""}
              </text>
            </box>
          </Show>
        </Match>

        <Match when={view() === "history"}>
          <scrollbox border title={` History · ${current()?.id ?? ""} `} marginTop={1} flexGrow={1} paddingLeft={1}>
            <For each={history()} fallback={<text fg="#7f8c8d">No events yet.</text>}>
              {(ev) => (
                <box flexDirection="column" marginBottom={1}>
                  <text fg="#3498db">
                    {new Date(ev.ts).toLocaleString()} · {ev.kind}
                  </text>
                  <Show when={ev.detail}>
                    <text fg="#bdc3c7">{JSON.stringify(ev.detail).slice(0, 600)}</text>
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
              <box flexDirection="column" border borderColor="#2ecc71" title=" Watch a PR " backgroundColor={MODAL_BG} width={modalWidth()} height={pickerHeight()} paddingLeft={1} paddingRight={1}>
                <box flexDirection="row" height={1}>
                  <text fg="#2ecc71">filter › </text>
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
                    <text fg="#e74c3c">Could not list your PRs: {myPrsError()}</text>
                  </Match>
                  <Match when={myPrs() === null}>
                    <text fg="#7f8c8d">Loading your open PRs…</text>
                  </Match>
                  <Match when={filtered().length === 0}>
                    <text fg="#7f8c8d">{myPrs()!.length === 0 ? "You have no open PRs." : "No PRs match the filter."}</text>
                  </Match>
                  <Match when={true}>
                    <text fg="#7f8c8d">
                      {filtered().length} of {myPrs()!.length} open PRs
                    </text>
                    <For each={pickWindow()}>
                      {(pr) => (
                        <box flexDirection="row" backgroundColor={pr === filtered()[pickSel()] ? "#2c3e50" : undefined}>
                          <text>
                            {pad(`${pr.owner}/${pr.repo}`, pickWidths().repo)} {pad(`#${pr.number}`, 7)}{" "}
                          </text>
                          <text fg="#bdc3c7">{pad(pr.title, pickWidths().title)} </text>
                          <text fg="#7f8c8d">{pr.isDraft ? "draft " : ""}</text>
                          <text fg="#3498db">{pr.watched ? "watched" : ""}</text>
                        </box>
                      )}
                    </For>
                  </Match>
                </Switch>
              </box>
            </Match>
            <Match when={view() === "new-watch" && form()}>
              <box flexDirection="column" border borderColor="#2ecc71" title=" New watch " backgroundColor={MODAL_BG} width={modalWidth()} paddingLeft={1} paddingRight={1} paddingBottom={1}>
                <text>
                  {form()!.pr.owner}/{form()!.pr.repo} #{form()!.pr.number} · {form()!.pr.title}
                </text>
                <text fg="#7f8c8d" marginBottom={1}>
                  {form()!.pr.url} · Sentinel creates a new claude session for this PR
                </text>
                <For each={FORM_FIELDS}>
                  {(field, i) => (
                    <box flexDirection="row" backgroundColor={i() === formSel() ? "#2c3e50" : undefined}>
                      <text fg="#7f8c8d">{pad(field.label, 20)} </text>
                      <Show
                        when={formEditing() !== null && formEditing() === field.key}
                        fallback={
                          <text fg={field.kind === "submit" ? "#2ecc71" : field.kind === "fixed" ? "#7f8c8d" : undefined}>
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
                  <text fg={formMsg()!.error ? "#e74c3c" : "#f1c40f"} marginTop={1}>
                    {formMsg()!.text}
                  </text>
                </Show>
              </box>
            </Match>
            <Match when={view() === "settings"}>
              <box flexDirection="column" border borderColor="#2ecc71" title={` Settings · ${props.paths.config} `} backgroundColor={MODAL_BG} width={modalWidth()} height={settingsHeight()} paddingLeft={1} paddingRight={1}>
                <Show when={config()} fallback={<text fg="#e74c3c">Config could not be loaded: {configError()}</text>}>
                  <Show when={showSettingsFilter()}>
                    <box flexDirection="row" height={1}>
                      <text fg="#2ecc71">/ </text>
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
                    <text fg="#7f8c8d">No settings match "{settingsQuery()}".</text>
                  </Show>
                  <For each={settingsWindow()}>
                    {(field) => (
                      <box flexDirection="row" height={1} backgroundColor={field === selectedField() ? "#2c3e50" : undefined}>
                        <text fg="#7f8c8d">{pad(field.label, 38)} </text>
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

      <box height={1} marginTop={1}>
        <Show when={flash()} fallback={<text fg="#7f8c8d">{footer()}</text>}>
          <text fg={flash()!.error ? "#e74c3c" : "#2ecc71"}>{flash()!.text}</text>
        </Show>
      </box>
    </box>
  );
}

export async function runTui(paths: Paths) {
  await render(() => <App paths={paths} />, { exitOnCtrlC: false });
}
