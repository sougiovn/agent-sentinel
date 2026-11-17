import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";

/**
 * A colour OpenTUI can render: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * a CSS colour name, or `transparent`.
 */
const ColorSchema = z
  .string()
  .regex(
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]+)$/,
    "must be a hex colour (#rgb, #rrggbb or #rrggbbaa), a CSS colour name or transparent",
  );

/** Colours for the daemon's PR and ticket statuses, keyed by `last_status`. */
export const DEFAULT_STATUS_COLORS: Record<string, string> = {
  no_changes: "#7f8c8d",
  no_action: "#95a5a6",
  pending: "#7f8c8d",
  fix_spawned: "#3498db",
  fix_running: "#f1c40f",
  spawn_failed: "#e74c3c",
  error: "#e74c3c",
  queued: "#3498db",
  started: "#f1c40f",
  in_review: "#2ecc71",
  transition_failed: "#e67e22",
};

/**
 * The TUI palette. Every key is optional in `theme.json`; missing keys (and
 * missing statuses) fall back to the defaults, so partial themes are valid.
 */
export const ThemeSchema = z
  .object({
    /** Default text colour, also used for a status with no colour of its own. */
    text: ColorSchema.default("#ecf0f1"),
    /** PR titles, reasons and event details. */
    textSecondary: ColorSchema.default("#bdc3c7"),
    /** Hints, labels, table headers and the footer. */
    textMuted: ColorSchema.default("#7f8c8d"),
    /** Title, focused borders and other highlights. */
    accent: ColorSchema.default("#2ecc71"),
    /** Repo group headings, timestamps and "watched" markers. */
    info: ColorSchema.default("#3498db"),
    /** Success messages. */
    success: ColorSchema.default("#2ecc71"),
    /** Warnings, like the daemon being offline. */
    warning: ColorSchema.default("#e67e22"),
    /** Errors and invalid config. */
    error: ColorSchema.default("#e74c3c"),
    /** Work in progress messages. */
    pending: ColorSchema.default("#f1c40f"),
    /** Background of the selected row. */
    selectionBackground: ColorSchema.default("#2c3e50"),
    /** Background of the floating dialogs. */
    modalBackground: ColorSchema.default("#1e272e"),
    statuses: z.record(z.string(), ColorSchema).default({}),
  })
  .strict();

export type Theme = z.infer<typeof ThemeSchema>;

export const DEFAULT_THEME: Theme = {
  ...ThemeSchema.parse({}),
  statuses: { ...DEFAULT_STATUS_COLORS },
};

export type ThemeResult = { ok: true; theme: Theme } | { ok: false; error: string };

/** The colour for a status, falling back to the theme's text colour. */
export function statusColor(theme: Theme, status: string): string {
  return theme.statuses[status] ?? theme.text;
}

export function parseTheme(text: string): ThemeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const parsed = ThemeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, theme: { ...parsed.data, statuses: { ...DEFAULT_STATUS_COLORS, ...parsed.data.statuses } } };
}

/** Loads the theme, creating the file with defaults if missing. */
export function loadTheme(path: string): ThemeResult {
  if (!existsSync(path)) {
    saveTheme(path, DEFAULT_THEME);
    return { ok: true, theme: DEFAULT_THEME };
  }
  return parseTheme(readFileSync(path, "utf8"));
}

export function saveTheme(path: string, theme: Theme): void {
  const validated = ThemeSchema.parse(theme);
  const full: Theme = { ...validated, statuses: { ...DEFAULT_STATUS_COLORS, ...validated.statuses } };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Watches the theme file's directory and calls onChange with each parse result,
 * debounced. Any directory event is checked against the file's contents, because
 * atomic saves rename a temporary file over the target and Bun's fs.watch reports
 * only the temporary name. Deleting the file resets the theme to the defaults
 * without recreating it.
 */
export function watchTheme(path: string, onChange: (r: ThemeResult) => void): FSWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastText: string | null = existsSync(path) ? readFileSync(path, "utf8") : null;
  return watch(dirname(path), () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const text = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (text === lastText) return;
      lastText = text;
      onChange(text === null ? { ok: true, theme: DEFAULT_THEME } : parseTheme(text));
    }, 200);
  });
}
