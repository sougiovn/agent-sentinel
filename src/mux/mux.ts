export type Layout = "sentinel-tab" | "tab-per-session";

export interface PaneRef {
  paneId: string;
  tabId: string;
  /** Id of the home session/workspace the pane lives in. */
  homeId: string;
}

export interface CreatePaneOptions {
  /** Name of the Sentinel-owned session/workspace. */
  homeName: string;
  /**
   * Id of the home session/workspace from an earlier createPane. Preferred over `homeName`, since agents
   * running inside it may rename it (Rex tells Claude to label its session).
   */
  homeId?: string;
  layout: Layout;
  maxPanesPerTab: number;
  cwd: string;
  /** Names the pane, and the tab too when the tab is the session's own (`tab-per-session` or `ownTab`). */
  label: string;
  /** Always open a new tab for the pane, whatever the layout. */
  ownTab?: boolean;
  /** Make the new pane's tab the active one. Defaults to false so background work doesn't steal focus. */
  focus?: boolean;
}

/** Name for a new tab: the session's label when it gets its own tab, else `<home>-<n>` for a shared one. */
export function tabName(opts: CreatePaneOptions, existingTabs: number): string {
  return opts.layout === "tab-per-session" || opts.ownTab ? opts.label : `${opts.homeName}-${existingTabs + 1}`;
}

export class MuxUnavailableError extends Error {}

/** A terminal multiplexer Sentinel can open shell panes in. */
export interface Multiplexer {
  readonly name: "rex" | "herdr";
  /** Throws MuxUnavailableError when the multiplexer can't be reached. */
  ensureAvailable(): Promise<void>;
  paneExists(paneId: string): Promise<boolean>;
  /** Creates an interactive shell pane inside Sentinel's home session/workspace. */
  createPane(opts: CreatePaneOptions): Promise<PaneRef>;
  /** The pane's current screen as plain text. */
  readScreen(paneId: string): Promise<string>;
  /** Types a line into the pane and presses Enter. */
  sendLine(paneId: string, text: string): Promise<void>;
  /**
   * Brings the pane to the front: its session/workspace, tab and pane. Returns a warning when only part
   * of that worked (e.g. the app refused to switch sessions), so the caller can still report success.
   */
  focusPane(ref: PaneRef): Promise<string | undefined>;
}

export interface WaitForShellOptions {
  /** Screen reads before giving up. */
  maxReads?: number;
  pollMs?: number;
  /** Unchanged reads needed while the screen still shows only its first text (a login banner, say). */
  quietReads?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits until a new pane's shell has drawn its prompt. Input typed while the shell is still starting can
 * lose its first characters, and a launch line missing an opening quote leaves the shell waiting for more
 * input. A login shell often prints a banner ("Last login: …") well before the prompt, so a screen that
 * still shows only its first text has to stay unchanged for `quietReads` reads (1.5s); once something new
 * is drawn after it, two identical reads in a row are enough. Returns false after `maxReads` reads (10s).
 */
export async function waitForShell(mux: Multiplexer, paneId: string, opts: WaitForShellOptions = {}): Promise<boolean> {
  const { maxReads = 40, pollMs = 250, quietReads = 6, sleep = Bun.sleep } = opts;
  let first: string | null = null;
  let last: string | null = null;
  let unchanged = 0;
  for (let i = 0; i < maxReads; i++) {
    const screen = (await mux.readScreen(paneId).catch(() => "")).trimEnd();
    if (screen) {
      first ??= screen;
      unchanged = screen === last ? unchanged + 1 : 0;
      if (unchanged >= (screen === first ? quietReads : 1)) return true;
    }
    last = screen || null;
    await sleep(pollMs);
  }
  return false;
}

/** Recursively finds the first string value stored under `key`. */
export function findKey(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const f = findKey(v, key);
      if (f) return f;
    }
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec[key] === "string") return rec[key] as string;
  for (const v of Object.values(rec)) {
    const f = findKey(v, key);
    if (f) return f;
  }
  return undefined;
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected ${what} output: ${text.slice(0, 200)}`);
  }
}
