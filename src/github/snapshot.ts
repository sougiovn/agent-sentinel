import type { Item } from "../core/types.ts";
import type { GhCheck, GhComment, PrActivity } from "./gh.ts";

function commentItem(kind: Item["kind"], prefix: string, c: GhComment): Item {
  return {
    id: `${prefix}:${c.id}`,
    kind,
    author: c.user?.login,
    authorType: c.user?.type,
    body: c.body ?? "",
    path: c.path,
    line: c.line ?? c.original_line ?? undefined,
    url: c.html_url,
    createdAt: c.created_at ?? c.submitted_at,
  };
}

const RUN_ID_RE = /\/actions\/runs\/(\d+)/;

function checkItem(c: GhCheck, headSha: string): Item | null {
  if (c.__typename === "CheckRun") {
    if (c.status && c.status !== "COMPLETED") return null;
    const name = c.workflowName ? `${c.workflowName} / ${c.name}` : (c.name ?? "check");
    return {
      id: `check:${name}:${c.detailsUrl ?? c.completedAt ?? headSha}`,
      kind: "check",
      checkName: name,
      conclusion: c.conclusion ?? undefined,
      url: c.detailsUrl,
      runId: c.detailsUrl ? RUN_ID_RE.exec(c.detailsUrl)?.[1] : undefined,
    };
  }
  const name = c.context ?? "status";
  return {
    id: `status:${name}:${headSha}`,
    kind: "check",
    checkName: name,
    conclusion: c.state ?? undefined,
    url: c.targetUrl,
  };
}

/** All items currently present on the PR, before filtering. */
export function normalize(activity: PrActivity): Item[] {
  const items: Item[] = [];
  for (const c of activity.inlineComments) items.push(commentItem("inline_comment", "inline", c));
  for (const c of activity.conversationComments) items.push(commentItem("conversation_comment", "issue", c));
  for (const r of activity.reviews) {
    if (r.state === "PENDING" || !r.body?.trim()) continue;
    items.push({ ...commentItem("review", "review", r), body: `[${r.state}] ${r.body}` });
  }
  for (const c of activity.view.statusCheckRollup ?? []) {
    const it = checkItem(c, activity.view.headRefOid);
    if (it) items.push(it);
  }
  return items;
}

export interface FilterOptions {
  ignoredAuthors: Set<string>;
  failingConclusions: Set<string>;
}

/** Whether an item could ever be worth evaluating (independent of whether it's been seen). */
export function isRelevant(item: Item, opts: FilterOptions): boolean {
  if (item.kind === "check") return !!item.conclusion && opts.failingConclusions.has(item.conclusion.toUpperCase());
  if (item.author && opts.ignoredAuthors.has(item.author.toLowerCase())) return false;
  return true;
}

export function newItems(all: Item[], seen: Set<string>, opts: FilterOptions): Item[] {
  return all.filter((i) => !seen.has(i.id) && isRelevant(i, opts));
}

export function isBot(item: Pick<Item, "author" | "authorType">): boolean {
  return item.authorType === "Bot" || !!item.author?.endsWith("[bot]");
}
