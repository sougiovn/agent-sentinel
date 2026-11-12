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
import { ago } from "../cli/format.ts";
import { cycleField, displayField, FORM_FIELDS, initialForm, watchRequest, type NewWatchForm } from "./new-watch.ts";
import { filterPrs } from "./pr-filter.ts";
import { cycleEnum, displayValue, editText, FIELDS, parseValue } from "./settings.ts";

type View = "list" | "history" | "settings" | "pick-pr" | "new-watch";

/** The daemon RPC surface the TUI uses; tests pass one backed by an in-process daemon. */
export interface RpcClient {
  call<M extends RpcMethod>(method: M, params: RpcMethods[M][0], timeoutMs?: number): Promise<RpcMethods[M][1]>;
}

const STATUS_COLOR: Record<string, string> = {
  no_changes: "#7f8c8d",
  no_action: "#95a5a6",
  pending: "#7f8c8d",
  fix_spawned: "#3498db",
  fix_running: "#f1c40f",
  spawn_failed: "#e74c3c",
  error: "#e74c3c",
};

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
  const [history, setHistory] = createSignal<EventRow[]>([]);
  const [flash, setFlash] = createSignal<{ text: string; error: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [config, setConfig] = createSignal<Config | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
  const [fieldSel, setFieldSel] = createSignal(0);
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
      setPrs(list);
      setOnline(true);
      if (sel() >= list.length) setSel(Math.max(0, list.length - 1));
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

  const current = () => prs()[sel()];

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
    const field = FIELDS[fieldSel()]!;
    if (!cfg || field.kind !== "template") return;
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
    // Next tick, so the key that opened the picker isn't typed into its filter input.
    await new Promise((r) => setTimeout(r, 0));
    setView("pick-pr");
    try {
      const [list, d] = await Promise.all([client.call("myPrs", {}, 90_000), client.call("newWatchDefaults", {})]);
      setMyPrs(list);
      setDefaults(d);
    } catch (e) {
      const msg = (e as Error).message;
      setMyPrsError(
        msg.startsWith("Unknown method")
          ? "the running daemon is older than this dashboard. Run `sentinel stop`, then open `sentinel` again."
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
      const i = prs().findIndex((x) => x.id === r.id);
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
            setFormEditing(field.key);
          }
          return;
        case "return":
          if (field.kind === "submit") await submitForm();
          else if (field.kind === "enum") setForm(cycleField(field.key, f, d));
          else if (field.kind === "text") {
            formDraft = f.cwd;
            setFormEditing("cwd");
          }
          return;
      }
      return;
    }
    if (v === "list") {
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
          setSel((i) => Math.min(prs().length - 1, i + 1));
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
          setView("settings");
          return;
        case "r":
          await reloadAll();
          return;
        case "n":
        case "w":
          await openPicker();
          return;
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
      const field = FIELDS[fieldSel()]!;
      switch (key.name) {
        case "escape":
        case "q":
          setView("list");
          return;
        case "up":
        case "k":
          setFieldSel((i) => Math.max(0, i - 1));
          return;
        case "down":
        case "j":
          setFieldSel((i) => Math.min(FIELDS.length - 1, i + 1));
          return;
        case "r":
          await reloadAll();
          return;
        case "e":
          if (field.kind === "template") await editTemplate();
          return;
        case "return":
        case "space":
          if (!cfg) return;
          if (field.kind === "enum") await persist((c) => field.set(c, cycleEnum(field, c)));
          else if (field.kind === "template") await editTemplate();
          else {
            draft = editText(field, cfg);
            setEditing(draft);
          }
          return;
      }
    }
  });

  let draft = "";
  const submitEdit = async (text: string) => {
    const field = FIELDS[fieldSel()]!;
    setEditing(null);
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
    const pr = Math.min(Math.max(24, Math.floor(rest * 0.45)), 48);
    return { ...fixed, pr, reason: Math.max(10, rest - pr) };
  };

  const pickWidths = () => {
    const w = dims().width - 6;
    const repo = Math.min(36, Math.max(16, Math.floor(w * 0.3)));
    return { repo, title: Math.max(10, w - repo - 7 - 16) };
  };

  /** The slice of filtered PRs that fits on screen, scrolled so the selection stays visible. */
  const pickWindow = () => {
    const rows = Math.max(3, dims().height - 12);
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
        return "↑↓ move · enter edit/cycle · e edit template · r reload · esc back";
      case "pick-pr":
        return "type to filter (org, repo, #number, title) · ↑↓ move · enter pick · esc back";
      case "new-watch":
        return "↑↓ move · ←→/space change · e type a model or path · enter on [ Watch ] to start · esc back";
      default:
        return online()
          ? "↑↓ move · enter history · n watch a PR · c check now · d unwatch · p pause/resume · s settings · r reload · q quit"
          : "S start daemon · r reload config · q quit";
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
        <Match when={view() === "list"}>
          <box flexDirection="column" border title=" Watched PRs " marginTop={1} flexGrow={1} paddingLeft={1} paddingRight={1}>
            <text fg="#7f8c8d">
              {pad("PR", widths().pr)} {pad("AGENT", widths().agent)} {pad("SESSION", widths().session)}{" "}
              {pad("CHECKED", widths().checked)} {pad("STATUS", widths().status)} REASON
            </text>
            <Show when={prs().length > 0} fallback={<text fg="#7f8c8d">No PRs watched. Press n to pick one of your PRs, or hand off from an agent with `sentinel watch &lt;pr&gt;`.</text>}>
              <For each={prs()}>
                {(pr, i) => (
                  <box flexDirection="row" backgroundColor={i() === sel() ? "#2c3e50" : undefined}>
                    <text>
                      {pad(pr.id, widths().pr)} {pad(pr.agent, widths().agent)}{" "}
                      {pad(pr.session_id.slice(0, 8) + (pr.session?.paused ? " ⏸" : ""), widths().session)}{" "}
                      {pad(ago(pr.last_checked_at), widths().checked)}{" "}
                    </text>
                    <text fg={STATUS_COLOR[pr.last_status] ?? "#ecf0f1"}>{pad(pr.last_status, widths().status)} </text>
                    <text fg="#bdc3c7">{pad((pr.last_reason ?? "").replace(/\s+/g, " "), widths().reason)}</text>
                  </box>
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

        <Match when={view() === "pick-pr"}>
          <box flexDirection="column" border title=" Watch a PR " marginTop={1} flexGrow={1} paddingLeft={1} paddingRight={1}>
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
          <box flexDirection="column" border title=" New watch " marginTop={1} flexGrow={1} paddingLeft={1} paddingRight={1}>
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
          <box flexDirection="column" border title={` Settings · ${props.paths.config} `} marginTop={1} flexGrow={1} paddingLeft={1}>
            <Show when={config()} fallback={<text fg="#e74c3c">Config could not be loaded: {configError()}</text>}>
              <For each={FIELDS}>
                {(field, i) => (
                  <box flexDirection="row" backgroundColor={i() === fieldSel() ? "#2c3e50" : undefined}>
                    <text fg="#7f8c8d">{pad(field.label, 38)} </text>
                    <Show when={editing() !== null && i() === fieldSel()} fallback={<text>{displayValue(field, config()!)}</text>}>
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
