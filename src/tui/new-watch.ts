import { AGENT_DEFAULT } from "../core/config.ts";
import type { MyPr, NewWatchDefaults } from "../daemon/protocol.ts";
import type { WatchRequest } from "../daemon/sentinel.ts";

/** What the "watch a PR" form collects before Sentinel creates a new agent session. */
export interface NewWatchForm {
  pr: MyPr;
  model: string;
  effort: string;
  cwd: string;
  startNow: boolean;
  includeExisting: boolean;
}

export type FormFieldKey = "agent" | "model" | "effort" | "cwd" | "start" | "existing" | "submit";

export interface FormField {
  key: FormFieldKey;
  label: string;
  /** "enum" fields cycle, "text" fields open an input, "submit" starts the watch. */
  kind: "fixed" | "enum" | "text" | "submit";
}

export const FORM_FIELDS: FormField[] = [
  { key: "agent", label: "Agent", kind: "fixed" },
  { key: "model", label: "Model", kind: "enum" },
  { key: "effort", label: "Effort", kind: "enum" },
  { key: "cwd", label: "Directory", kind: "text" },
  { key: "start", label: "Start session", kind: "enum" },
  { key: "existing", label: "Existing feedback", kind: "enum" },
  { key: "submit", label: "", kind: "submit" },
];

export function initialForm(pr: MyPr, d: NewWatchDefaults): NewWatchForm {
  return { pr, model: d.model, effort: d.effort, cwd: "", startNow: d.startNow, includeExisting: d.includeExisting };
}

export function displayField(key: FormFieldKey, f: NewWatchForm): string {
  switch (key) {
    case "agent":
      return "claude   (codex can't start new sessions yet)";
    case "model":
      return f.model === AGENT_DEFAULT ? "default (agent decides)" : f.model;
    case "effort":
      return f.effort === AGENT_DEFAULT ? "default (agent decides)" : f.effort;
    case "cwd":
      return f.cwd || "(not found, press enter to type a path)";
    case "start":
      return f.startNow ? "now" : "on first feedback";
    case "existing":
      return f.includeExisting ? "act on existing comments and failing checks" : "ignore what's already there";
    case "submit":
      return "[ Watch ]";
  }
}

function step(options: string[], current: string, dir: 1 | -1): string {
  if (options.length === 0) return current;
  const i = options.indexOf(current);
  if (i === -1) return options[dir === 1 ? 0 : options.length - 1]!;
  return options[(i + dir + options.length) % options.length]!;
}

/** Returns the form with an enum field moved to its next (dir 1) or previous (dir -1) value. */
export function cycleField(key: FormFieldKey, f: NewWatchForm, d: NewWatchDefaults, dir: 1 | -1 = 1): NewWatchForm {
  switch (key) {
    case "model":
      return { ...f, model: step(d.models, f.model, dir) };
    case "effort":
      return { ...f, effort: step(d.efforts, f.effort, dir) };
    case "start":
      return { ...f, startNow: !f.startNow };
    case "existing":
      return { ...f, includeExisting: !f.includeExisting };
    default:
      return f;
  }
}

/** The daemon request for a submitted form; `cwd` must already be validated and absolute. */
export function watchRequest(f: NewWatchForm, cwd: string): WatchRequest {
  const opt = (v: string) => (v === AGENT_DEFAULT || !v.trim() ? undefined : v.trim());
  return {
    prs: [f.pr.id],
    agent: "claude",
    cwd,
    includeExisting: f.includeExisting,
    newSession: { model: opt(f.model), effort: opt(f.effort), startNow: f.startNow },
  };
}
