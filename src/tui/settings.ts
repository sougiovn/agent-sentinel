import { TICKET_MODES, type Config } from "../core/config.ts";

export type FieldKind = "enum" | "int" | "number" | "string" | "list" | "template";

export interface Field {
  key: string;
  /** The label inside its section and group, so it doesn't repeat them. */
  label: string;
  kind: FieldKind;
  /** Top-level heading the field is listed under. */
  section: string;
  /** Optional subheading inside the section. */
  group?: string;
  options?: string[];
  /** A string field that may be cleared. */
  allowEmpty?: boolean;
  get(c: Config): unknown;
  set(c: Config, v: unknown): void;
}

type Spec = Omit<Field, "section" | "group">;

const f = (
  key: string,
  label: string,
  kind: FieldKind,
  get: (c: Config) => unknown,
  set: (c: Config, v: never) => void,
  options?: string[],
): Spec => ({ key, label, kind, get, set: set as Field["set"], options });

/** A boolean shown as an on/off enum. */
const bool = (key: string, label: string, get: (c: Config) => boolean, set: (c: Config, v: boolean) => void): Spec =>
  f(key, label, "enum", (c) => (get(c) ? "on" : "off"), (c, v: string) => set(c, v === "on"), ["on", "off"]);

const under = (section: string, group: string | undefined, specs: Spec[]): Field[] => specs.map((s) => ({ ...s, section, group }));

export const FIELDS: Field[] = [
  ...under("General", undefined, [
    f("multiplexer", "Multiplexer", "enum", (c) => c.multiplexer, (c, v) => (c.multiplexer = v), ["rex", "herdr"]),
    f("pollIntervalSec", "Poll interval (s)", "int", (c) => c.pollIntervalSec, (c, v) => (c.pollIntervalSec = v)),
  ]),
  ...under("General", "Agents", [
    f("agents.claude.command", "Claude command", "string", (c) => c.agents.claude.command, (c, v) => (c.agents.claude.command = v)),
    f("agents.claude.args", "Claude extra args", "list", (c) => c.agents.claude.args, (c, v) => (c.agents.claude.args = v)),
    f("agents.codex.command", "Codex command", "string", (c) => c.agents.codex.command, (c, v) => (c.agents.codex.command = v)),
    f("agents.codex.args", "Codex extra args", "list", (c) => c.agents.codex.args, (c, v) => (c.agents.codex.args = v)),
  ]),
  ...under("General", "Spawning", [
    f("spawn.layout", "Layout", "enum", (c) => c.spawn.layout, (c, v) => (c.spawn.layout = v), ["sentinel-tab", "tab-per-session"]),
    f("spawn.maxPanesPerTab", "Max panes per tab", "int", (c) => c.spawn.maxPanesPerTab, (c, v) => (c.spawn.maxPanesPerTab = v)),
    f("spawn.maxConcurrent", "Max concurrent (0 = unlimited)", "int", (c) => c.spawn.maxConcurrent, (c, v) => (c.spawn.maxConcurrent = v)),
    f("spawn.startTimeoutSec", "Start timeout (s)", "int", (c) => c.spawn.startTimeoutSec, (c, v) => (c.spawn.startTimeoutSec = v)),
    f("spawn.busyTimeoutMin", "Busy timeout (min)", "int", (c) => c.spawn.busyTimeoutMin, (c, v) => (c.spawn.busyTimeoutMin = v)),
    f("spawn.sessionName", "Sentinel session name", "string", (c) => c.spawn.sessionName, (c, v) => (c.spawn.sessionName = v)),
  ]),
  ...under("Pull requests", "Feedback", [
    f("ignoredAuthors", "Ignored authors", "list", (c) => c.ignoredAuthors, (c, v) => (c.ignoredAuthors = v)),
    f("failingConclusions", "Failing conclusions", "list", (c) => c.failingConclusions, (c, v) => (c.failingConclusions = v)),
    f("fixPromptTemplate", "Fix prompt", "template", (c) => c.fixPromptTemplate, (c, v) => (c.fixPromptTemplate = v)),
  ]),
  ...under("Pull requests", "Evaluator", [
    f("evaluator.model", "Model", "string", (c) => c.evaluator.model, (c, v) => (c.evaluator.model = v)),
    f("evaluator.maxBudgetUsd", "Budget USD (0 = none)", "number", (c) => c.evaluator.maxBudgetUsd, (c, v) => (c.evaluator.maxBudgetUsd = v)),
    f("evaluator.failedLogLines", "Failed log lines", "int", (c) => c.evaluator.failedLogLines, (c, v) => (c.evaluator.failedLogLines = v)),
  ]),
  ...under("Pull requests", "New watch", [
    bool("newWatch.onlyMine", "Only my PRs", (c) => c.newWatch.onlyMine, (c, v) => (c.newWatch.onlyMine = v)),
    f("newWatch.repoRoots", "Repo roots", "list", (c) => c.newWatch.repoRoots, (c, v) => (c.newWatch.repoRoots = v)),
    f("newWatch.model", "Default model", "string", (c) => c.newWatch.model, (c, v) => (c.newWatch.model = v)),
    f("newWatch.models", "Model choices", "list", (c) => c.newWatch.models, (c, v) => (c.newWatch.models = v)),
    f("newWatch.effort", "Default effort", "string", (c) => c.newWatch.effort, (c, v) => (c.newWatch.effort = v)),
    f("newWatch.efforts", "Effort choices", "list", (c) => c.newWatch.efforts, (c, v) => (c.newWatch.efforts = v)),
    bool("newWatch.startNow", "Start session now", (c) => c.newWatch.startNow, (c, v) => (c.newWatch.startNow = v)),
    bool("newWatch.includeExisting", "Act on existing", (c) => c.newWatch.includeExisting, (c, v) => (c.newWatch.includeExisting = v)),
    f("introPromptTemplate", "Intro prompt", "template", (c) => c.introPromptTemplate, (c, v) => (c.introPromptTemplate = v)),
  ]),
  ...under("Tickets", "Agent", [
    f("jira.mode", "Mode", "enum", (c) => c.jira.mode, (c, v) => (c.jira.mode = v), [...TICKET_MODES]),
    f("jira.cwd", "Start directory", "string", (c) => c.jira.cwd, (c, v) => (c.jira.cwd = v)),
    f("jira.model", "Model", "string", (c) => c.jira.model, (c, v) => (c.jira.model = v)),
    f("jira.effort", "Effort", "string", (c) => c.jira.effort, (c, v) => (c.jira.effort = v)),
    f("jira.promptTemplate", "Ticket prompt", "template", (c) => c.jira.promptTemplate, (c, v) => (c.jira.promptTemplate = v)),
  ]),
  ...under("Tickets", "Jira", [
    bool("jira.enabled", "Pick up tickets", (c) => c.jira.enabled, (c, v) => (c.jira.enabled = v)),
    f("jira.label", "Required label", "string", (c) => c.jira.label, (c, v) => (c.jira.label = v)),
    f("jira.statuses", "Statuses picked up", "list", (c) => c.jira.statuses, (c, v) => (c.jira.statuses = v)),
    f("jira.pollIntervalSec", "Poll interval (s)", "int", (c) => c.jira.pollIntervalSec, (c, v) => (c.jira.pollIntervalSec = v)),
    f("jira.command", "acli command", "string", (c) => c.jira.command, (c, v) => (c.jira.command = v)),
    { ...f("jira.transitionTo", "Status on start (blank = never)", "string", (c) => c.jira.transitionTo, (c, v) => (c.jira.transitionTo = v)), allowEmpty: true },
    { ...f("jira.reviewStatus", "Status after PR handoff (blank = never)", "string", (c) => c.jira.reviewStatus, (c, v) => (c.jira.reviewStatus = v)), allowEmpty: true },
    { ...f("jira.mergedStatus", "Status after PR merge (blank = never)", "string", (c) => c.jira.mergedStatus, (c, v) => (c.jira.mergedStatus = v)), allowEmpty: true },
    { ...f("jira.closedStatus", "Status after PR closed unmerged (blank = never)", "string", (c) => c.jira.closedStatus, (c, v) => (c.jira.closedStatus = v)), allowEmpty: true },
  ]),
];

/** The field's label with its section and group, for messages shown outside the settings list. */
export function fullLabel(field: Field): string {
  return [field.section, field.group, field.label].filter(Boolean).join(" › ");
}

/** The settings dialog's tabs, in order. */
export const SECTIONS: string[] = [...new Set(FIELDS.map((f) => f.section))];

/** A line of a settings tab: a group subheading or a field. */
export type SettingsRow = { kind: "group"; title: string } | { kind: "field"; field: Field };

/** Lays out fields under their group subheadings, in order. */
export function settingsRows(fields: Field[]): SettingsRow[] {
  const rows: SettingsRow[] = [];
  let group: string | undefined;
  for (const field of fields) {
    if (field.group && field.group !== group) rows.push({ kind: "group", title: field.group });
    group = field.group;
    rows.push({ kind: "field", field });
  }
  return rows;
}

export function displayValue(field: Field, c: Config): string {
  const v = field.get(c);
  if (field.kind === "list") return (v as string[]).join(", ") || "(none)";
  if (field.kind === "template") {
    const first = String(v).split("\n")[0] ?? "";
    return `${first.slice(0, 40)}… (e: edit in $EDITOR)`;
  }
  return field.allowEmpty && v === "" ? "(none)" : String(v);
}

export function editText(field: Field, c: Config): string {
  const v = field.get(c);
  return field.kind === "list" ? (v as string[]).join(", ") : String(v);
}

/** Parses user text for a field; throws on invalid input. */
export function parseValue(field: Field, text: string): unknown {
  const t = text.trim();
  switch (field.kind) {
    case "int": {
      const n = Number(t);
      if (!Number.isInteger(n)) throw new Error("must be an integer");
      return n;
    }
    case "number": {
      const n = Number(t);
      if (!Number.isFinite(n)) throw new Error("must be a number");
      return n;
    }
    case "list":
      return t ? t.split(",").map((s) => s.trim()).filter(Boolean) : [];
    case "enum":
      if (!field.options?.includes(t)) throw new Error(`one of ${field.options?.join(", ")}`);
      return t;
    default:
      if (!t && field.allowEmpty) return "";
      if (!t) throw new Error("must not be empty");
      return text;
  }
}

/** The enum option next to the current one, wrapping around; `dir` -1 goes back. */
export function cycleEnum(field: Field, c: Config, dir: 1 | -1 = 1): string {
  const opts = field.options ?? [];
  const i = opts.indexOf(String(field.get(c)));
  if (i === -1) return opts[dir === 1 ? 0 : opts.length - 1]!;
  return opts[(i + dir + opts.length) % opts.length]!;
}

/** Fields whose section, group, label or config key contains every whitespace-separated word of the query (case-insensitive). */
export function filterFields(fields: Field[], query: string): Field[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return fields;
  return fields.filter((f) => {
    const h = `${fullLabel(f)} ${f.key}`.toLowerCase();
    return tokens.every((t) => h.includes(t));
  });
}
