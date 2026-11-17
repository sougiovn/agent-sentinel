import { homedir } from "node:os";
import { basename } from "node:path";
import type { RepoEntry, WorktreeEntry } from "../daemon/protocol.ts";

/** `owner/repo` (host only for GitHub Enterprise), or the directory name when there is no origin. */
export function repoLabel(repo: RepoEntry): string {
  if (!repo.remote) return basename(repo.path);
  return repo.remote.startsWith("github.com/") ? repo.remote.slice("github.com/".length) : repo.remote;
}

export function worktreeLabel(wt: WorktreeEntry): string {
  return wt.branch ?? `detached ${wt.head?.slice(0, 7) ?? "?"}`;
}

export function tilde(p: string, home = homedir()): string {
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Text shown for a linked PR or ticket, used when filtering; empty when unknown. */
export interface LinkText {
  pr(id: string): string;
  ticket(key: string): string;
}

/**
 * Keeps worktrees matching every whitespace-separated word of the query (case-insensitive) in their
 * repo name or path, branch, worktree path, or a linked PR (`#n title`, status) or ticket (key, summary, status).
 * Repos with no match are dropped; a repo without worktrees is matched on its own name and path.
 */
export function filterRepos(repos: RepoEntry[], query: string, links: LinkText): RepoEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return repos;
  const matches = (h: string) => tokens.every((t) => h.includes(t));
  const out: RepoEntry[] = [];
  for (const repo of repos) {
    const repoText = `${repoLabel(repo)} ${tilde(repo.path)}`;
    if (repo.worktrees.length === 0) {
      if (matches(repoText.toLowerCase())) out.push(repo);
      continue;
    }
    const worktrees = repo.worktrees.filter((wt) =>
      matches(
        [repoText, worktreeLabel(wt), tilde(wt.path), ...wt.prs.map((id) => links.pr(id)), ...wt.tickets.map((k) => links.ticket(k))]
          .join(" ")
          .toLowerCase(),
      ),
    );
    if (worktrees.length) out.push({ ...repo, worktrees });
  }
  return out;
}
