import { realpathSync } from "node:fs";
import { basename, sep } from "node:path";
import type { Exec } from "./exec.ts";
import { expandHome, findClones, originOf } from "./repo-locate.ts";

/** One entry of `git worktree list --porcelain`. */
export interface Worktree {
  path: string;
  head: string | null;
  /** Short branch name; null when detached. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** Its directory is gone; `git worktree prune` would remove it. */
  prunable: boolean;
}

export function parseWorktreeList(out: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: null, branch: null, bare: false, detached: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") cur.bare = true;
    else if (line === "detached") cur.detached = true;
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
  }
  return list;
}

/** A main checkout found under a repo root, with all of its worktrees (the main one first). */
export interface RepoInfo {
  path: string;
  /** The configured root it was found under, as written in the config. */
  root: string;
  /** `host/owner/repo` from `origin`, or null. */
  remote: string | null;
  worktrees: Worktree[];
  /** Why the worktrees could not be listed. */
  error?: string;
}

/** Main checkouts two levels deep under each root, sorted by path. Linked worktrees appear under their repo. */
export async function listRepos(run: Exec, roots: string[]): Promise<RepoInfo[]> {
  const seen = new Set<string>();
  const out: RepoInfo[] = [];
  for (const root of roots) {
    for (const dir of findClones(expandHome(root), 2, true)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const [remote, wt] = await Promise.all([
        originOf(run, dir),
        run(["git", "-C", dir, "worktree", "list", "--porcelain"], { timeoutMs: 5000 }),
      ]);
      const info: RepoInfo = { path: dir, root, remote, worktrees: [] };
      if (wt.code === 0) info.worktrees = parseWorktreeList(wt.stdout).filter((w) => !w.bare);
      else info.error = (wt.stderr || wt.stdout).trim() || "git worktree list failed";
      out.push(info);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The deepest worktree containing `dir`; a worktree nested inside the main checkout wins over it. */
function ownerOf(dir: string, worktrees: string[]): string | null {
  const d = real(dir);
  let best: string | null = null;
  for (const w of worktrees) {
    const r = real(w);
    if ((d === r || d.startsWith(r + sep)) && (!best || r.length > real(best).length)) best = w;
  }
  return best;
}

/** True when `key` (e.g. CP-123) appears in `name` as a whole token: `CP-123-fix`, `feat/cp-123`, not `CP-1234`. */
export function namesTicket(name: string, key: string): boolean {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${k}($|[^0-9])`, "i").test(name);
}

export interface WorktreeLinks {
  prs: string[];
  tickets: string[];
}

/**
 * Ties watched PRs and Jira tickets to worktrees.
 * A PR belongs to the worktree its session works in. A ticket belongs to the worktree of the PR it
 * handed off, to any worktree whose branch or directory names its key, or, failing both, to the
 * worktree its session works in.
 */
export function linkWorktrees(
  worktrees: Pick<Worktree, "path" | "branch">[],
  prs: { id: string; cwd: string }[],
  tickets: { key: string; cwd: string; pr_id: string | null }[],
): Map<string, WorktreeLinks> {
  const links = new Map<string, WorktreeLinks>(worktrees.map((w) => [w.path, { prs: [], tickets: [] }]));
  const paths = worktrees.map((w) => w.path);
  const prHome = new Map<string, string>();
  for (const pr of prs) {
    const w = ownerOf(pr.cwd, paths);
    if (!w) continue;
    prHome.set(pr.id, w);
    links.get(w)!.prs.push(pr.id);
  }
  for (const t of tickets) {
    const homes = new Set<string>();
    const viaPr = t.pr_id ? prHome.get(t.pr_id) : undefined;
    if (viaPr) homes.add(viaPr);
    for (const w of worktrees) {
      if ((w.branch && namesTicket(w.branch, t.key)) || namesTicket(basename(w.path), t.key)) homes.add(w.path);
    }
    if (homes.size === 0) {
      const w = ownerOf(t.cwd, paths);
      if (w) homes.add(w);
    }
    for (const w of homes) links.get(w)!.tickets.push(t.key);
  }
  return links;
}
