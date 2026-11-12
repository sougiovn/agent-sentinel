import type { Item } from "../core/types.ts";
import { isBot } from "../github/snapshot.ts";

const MAX_BODY = 4000;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s;
}

export function describeItem(item: Item): string {
  const lines: string[] = [];
  if (item.kind === "check") {
    lines.push(`### [${item.id}] Failed check: ${item.checkName} (${item.conclusion})`);
    if (item.url) lines.push(`Run: ${item.url}`);
    if (item.logTail) lines.push("Failed log tail:", "```", item.logTail.trimEnd(), "```");
    return lines.join("\n");
  }
  const kindLabel =
    item.kind === "inline_comment" ? "Inline review comment" : item.kind === "review" ? "Review" : "PR comment";
  lines.push(`### [${item.id}] ${kindLabel}`);
  lines.push(`Author: user.login=${item.author ?? "unknown"} user.type=${item.authorType ?? "unknown"} (${isBot(item) ? "bot" : "human"})`);
  if (item.path) lines.push(`Location: ${item.path}${item.line ? `:${item.line}` : ""}`);
  if (item.url) lines.push(`URL: ${item.url}`);
  lines.push("", truncate(item.body ?? "", MAX_BODY));
  return lines.join("\n");
}

export interface EvalInput {
  prUrl: string;
  title: string;
  body: string;
  items: Item[];
}

export function buildEvalPrompt(input: EvalInput): string {
  return `You triage new activity on a GitHub pull request for an AI coding agent that owns the PR.
Decide which of the new items below require the agent to take action (change code, fix a failing check, or answer a bot's question).

Items that need action: change requests, bug reports, failing tests/builds/lints, requested changes in reviews, questions from bots that the agent must address.
Items that do NOT need action: approvals, praise, "LGTM", acknowledgements, purely informational bot summaries with no requested change, comments that only talk to other humans, flaky/infra failures that clearly aren't caused by the PR's code.

Set shouldFix=true if at least one item needs action, and list exactly those item ids (the bracketed ids) in "items". Give a one or two sentence "reason".

PR: ${input.prUrl}
Title: ${input.title}

Description:
${truncate(input.body || "(empty)", MAX_BODY)}

## New items
${input.items.map(describeItem).join("\n\n")}
`;
}

export const EVAL_SCHEMA = {
  type: "object",
  properties: {
    shouldFix: { type: "boolean" },
    reason: { type: "string" },
    items: { type: "array", items: { type: "string" } },
  },
  required: ["shouldFix", "reason", "items"],
  additionalProperties: false,
} as const;

export interface FixGroup {
  prUrl: string;
  reason: string;
  items: Item[];
}

/** Renders the user's fix template once per PR group and joins them. */
export function renderFixPrompt(template: string, groups: FixGroup[]): string {
  return groups
    .map((g) =>
      template
        .replaceAll("{{prUrl}}", g.prUrl)
        .replaceAll("{{reason}}", g.reason)
        .replaceAll("{{items}}", g.items.map(describeItem).join("\n\n")),
    )
    .join("\n\n---\n\n");
}
