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
  /** Names the pane, and the tab too when the tab is the session's own (`tab-per-session`). */
  label: string;
}

/** Name for a new tab: the session's label when it gets its own tab, else `<home>-<n>` for a shared one. */
export function tabName(opts: CreatePaneOptions, existingTabs: number): string {
  return opts.layout === "tab-per-session" ? opts.label : `${opts.homeName}-${existingTabs + 1}`;
}

export class MuxUnavailableError extends Error {}

/** A terminal multiplexer Sentinel can open shell panes in. */
export interface Multiplexer {
  readonly name: "rex" | "herdr" | "hc";
  /** Throws MuxUnavailableError when the multiplexer can't be reached. */
  ensureAvailable(): Promise<void>;
  paneExists(paneId: string): Promise<boolean>;
  /** Creates an interactive shell pane inside Sentinel's home session/workspace. */
  createPane(opts: CreatePaneOptions): Promise<PaneRef>;
  /** Types a line into the pane and presses Enter. */
  sendLine(paneId: string, text: string): Promise<void>;
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
