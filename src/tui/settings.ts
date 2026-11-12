import type { Config } from "../core/config.ts";

export type FieldKind = "enum" | "int" | "number" | "string" | "list" | "template";

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  get(c: Config): unknown;
  set(c: Config, v: unknown): void;
}

const f = (
  key: string,
  label: string,
  kind: FieldKind,
  get: (c: Config) => unknown,
  set: (c: Config, v: never) => void,
  options?: string[],
): Field => ({ key, label, kind, get, set: set as Field["set"], options });

/** A boolean shown as an on/off enum. */
const bool = (key: string, label: string, get: (c: Config) => boolean, set: (c: Config, v: boolean) => void): Field =>
  f(key, label, "enum", (c) => (get(c) ? "on" : "off"), (c, v: string) => set(c, v === "on"), ["on", "off"]);

export const FIELDS: Field[] = [
  f("multiplexer", "Multiplexer", "enum", (c) => c.multiplexer, (c, v) => (c.multiplexer = v), ["rex", "herdr"]),
  f("pollIntervalSec", "Poll interval (s)", "int", (c) => c.pollIntervalSec, (c, v) => (c.pollIntervalSec = v)),
  f("evaluator.model", "Evaluator model", "string", (c) => c.evaluator.model, (c, v) => (c.evaluator.model = v)),
  f("evaluator.maxBudgetUsd", "Evaluator budget USD (0 = none)", "number", (c) => c.evaluator.maxBudgetUsd, (c, v) => (c.evaluator.maxBudgetUsd = v)),
  f("evaluator.failedLogLines", "Failed log lines", "int", (c) => c.evaluator.failedLogLines, (c, v) => (c.evaluator.failedLogLines = v)),
  f("ignoredAuthors", "Ignored authors", "list", (c) => c.ignoredAuthors, (c, v) => (c.ignoredAuthors = v)),
  f("failingConclusions", "Failing conclusions", "list", (c) => c.failingConclusions, (c, v) => (c.failingConclusions = v)),
  f("agents.claude.command", "Claude command", "string", (c) => c.agents.claude.command, (c, v) => (c.agents.claude.command = v)),
  f("agents.claude.args", "Claude extra args", "list", (c) => c.agents.claude.args, (c, v) => (c.agents.claude.args = v)),
  f("agents.codex.command", "Codex command", "string", (c) => c.agents.codex.command, (c, v) => (c.agents.codex.command = v)),
  f("agents.codex.args", "Codex extra args", "list", (c) => c.agents.codex.args, (c, v) => (c.agents.codex.args = v)),
  f("spawn.layout", "Spawn layout", "enum", (c) => c.spawn.layout, (c, v) => (c.spawn.layout = v), ["sentinel-tab", "tab-per-session"]),
  f("spawn.maxPanesPerTab", "Max panes per tab", "int", (c) => c.spawn.maxPanesPerTab, (c, v) => (c.spawn.maxPanesPerTab = v)),
  f("spawn.maxConcurrent", "Max concurrent agents (0 = unlimited)", "int", (c) => c.spawn.maxConcurrent, (c, v) => (c.spawn.maxConcurrent = v)),
  f("spawn.busyTimeoutMin", "Busy timeout (min)", "int", (c) => c.spawn.busyTimeoutMin, (c, v) => (c.spawn.busyTimeoutMin = v)),
  f("spawn.sessionName", "Sentinel session name", "string", (c) => c.spawn.sessionName, (c, v) => (c.spawn.sessionName = v)),
  f("fixPromptTemplate", "Fix prompt template", "template", (c) => c.fixPromptTemplate, (c, v) => (c.fixPromptTemplate = v)),
  bool("newWatch.onlyMine", "New watch: only my PRs", (c) => c.newWatch.onlyMine, (c, v) => (c.newWatch.onlyMine = v)),
  f("newWatch.repoRoots", "New watch: repo roots", "list", (c) => c.newWatch.repoRoots, (c, v) => (c.newWatch.repoRoots = v)),
  f("newWatch.model", "New watch: default model", "string", (c) => c.newWatch.model, (c, v) => (c.newWatch.model = v)),
  f("newWatch.models", "New watch: model choices", "list", (c) => c.newWatch.models, (c, v) => (c.newWatch.models = v)),
  f("newWatch.effort", "New watch: default effort", "string", (c) => c.newWatch.effort, (c, v) => (c.newWatch.effort = v)),
  f("newWatch.efforts", "New watch: effort choices", "list", (c) => c.newWatch.efforts, (c, v) => (c.newWatch.efforts = v)),
  bool("newWatch.startNow", "New watch: start session now", (c) => c.newWatch.startNow, (c, v) => (c.newWatch.startNow = v)),
  bool("newWatch.includeExisting", "New watch: act on existing", (c) => c.newWatch.includeExisting, (c, v) => (c.newWatch.includeExisting = v)),
  f("introPromptTemplate", "New session intro prompt", "template", (c) => c.introPromptTemplate, (c, v) => (c.introPromptTemplate = v)),
];

export function displayValue(field: Field, c: Config): string {
  const v = field.get(c);
  if (field.kind === "list") return (v as string[]).join(", ") || "(none)";
  if (field.kind === "template") {
    const first = String(v).split("\n")[0] ?? "";
    return `${first.slice(0, 40)}… (e: edit in $EDITOR)`;
  }
  return String(v);
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
      if (!t) throw new Error("must not be empty");
      return text;
  }
}

export function cycleEnum(field: Field, c: Config): string {
  const opts = field.options ?? [];
  const i = opts.indexOf(String(field.get(c)));
  return opts[(i + 1) % opts.length]!;
}
