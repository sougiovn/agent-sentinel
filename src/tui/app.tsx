import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, type Config } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import type { EventRow } from "../core/types.ts";
import type { PrListEntry, StatusInfo } from "../daemon/protocol.ts";
import { Client } from "../cli/client.ts";
import { startDaemon as startDaemonProcess } from "../cli/daemon-control.ts";
import { ago } from "../cli/format.ts";
import { cycleEnum, displayValue, editText, FIELDS, parseValue } from "./settings.ts";

type View = "list" | "history" | "settings";

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
}

export function App(props: AppProps) {
  const client = new Client(props.paths.socket);
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
      const started = await (props.start ?? (() => startDaemonProcess(props.paths, client)))();
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

  const editTemplate = async () => {
    const cfg = config();
    if (!cfg) return;
    const file = join(props.paths.home, "fix-prompt-template.md");
    writeFileSync(file, cfg.fixPromptTemplate);
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    await renderer.suspend();
    spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    await renderer.resume();
    const text = readFileSync(file, "utf8");
    if (text.trim() && text !== cfg.fixPromptTemplate) await persist((c) => (c.fixPromptTemplate = text));
  };

  useKeyboard(async (key) => {
    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }
    if (editing() !== null) {
      if (key.name === "escape") setEditing(null);
      return; // input handles the rest
    }
    const v = view();
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

  const footer = () => {
    if (editing() !== null) return "enter save · esc cancel";
    if (confirmDelete()) return `Unwatch ${current()?.id}? y to confirm, any key to cancel`;
    switch (view()) {
      case "history":
        return "esc back";
      case "settings":
        return "↑↓ move · enter edit/cycle · e edit template · r reload · esc back";
      default:
        return online()
          ? "↑↓ move · enter history · c check now · d unwatch · p pause/resume · s settings · r reload config · q quit"
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
            <Show when={prs().length > 0} fallback={<text fg="#7f8c8d">No PRs watched. Agents hand off with `sentinel watch &lt;pr&gt;`.</text>}>
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
