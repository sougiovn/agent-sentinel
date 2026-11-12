import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Exec } from "./exec.ts";

/** Expands a leading `~` and resolves to an absolute path. */
export function expandHome(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return join(homedir(), t.slice(2));
  return resolve(t);
}

/**
 * Normalizes a git remote URL to `host/owner/repo` (lowercase), or null if it isn't recognizable.
 * Handles https://host/owner/repo(.git), ssh://git@host/owner/repo and git@host:owner/repo.
 */
export function normalizeRemote(url: string): string | null {
  const u = url.trim();
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  return `${m[1]}/${m[2]}/${m[3]}`.toLowerCase();
}

export interface RepoKey {
  host: string;
  owner: string;
  repo: string;
}

function keyOf(r: RepoKey): string {
  return `${r.host}/${r.owner}/${r.repo}`.toLowerCase();
}

async function originOf(run: Exec, dir: string): Promise<string | null> {
  const r = await run(["git", "-C", dir, "remote", "get-url", "origin"], { timeoutMs: 5000 });
  return r.code === 0 ? normalizeRemote(r.stdout) : null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Git working trees at depth 0..maxDepth under root (a clone isn't descended into). */
function findClones(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, ".git"))) {
      out.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const p = join(dir, n);
      if (isDir(p)) walk(p, depth + 1);
    }
  };
  if (isDir(root)) walk(root, 0);
  return out;
}

/** Finds local clones of GitHub repos under configured roots by their `origin` remote. */
export class RepoLocator {
  private index: Map<string, string[]> | null = null;
  private indexKey = "";

  constructor(private run: Exec) {}

  private async build(roots: string[]): Promise<Map<string, string[]>> {
    const key = roots.join("\n");
    if (this.index && this.indexKey === key) return this.index;
    const index = new Map<string, string[]>();
    for (const root of roots) {
      for (const dir of findClones(expandHome(root), 2)) {
        const origin = await originOf(this.run, dir);
        if (!origin) continue;
        index.set(origin, [...(index.get(origin) ?? []), dir]);
      }
    }
    this.index = index;
    this.indexKey = key;
    return index;
  }

  /** Forgets the scanned clones so the next lookup rescans the roots. */
  invalidate() {
    this.index = null;
  }

  /** Best local clone for a repo: shortest matching path, preferring a directory named after the repo. */
  async suggest(repo: RepoKey, roots: string[]): Promise<string | null> {
    const cached = this.index !== null && this.indexKey === roots.join("\n");
    let dirs = (await this.build(roots)).get(keyOf(repo));
    if (!dirs?.length && cached) {
      // A clone made since the last scan.
      this.invalidate();
      dirs = (await this.build(roots)).get(keyOf(repo));
    }
    if (!dirs?.length) return null;
    const named = dirs.filter((d) => d.toLowerCase().endsWith(`/${repo.repo.toLowerCase()}`));
    return [...(named.length ? named : dirs)].sort((a, b) => a.length - b.length)[0]!;
  }

  /** Checks that `path` exists and is a git clone; a remote that isn't the PR's repo is only a warning. */
  async validate(path: string, repo: RepoKey): Promise<{ ok: boolean; path: string; error?: string; warning?: string }> {
    if (!path.trim()) return { ok: false, path, error: "Directory is required" };
    const abs = expandHome(path);
    if (!isDir(abs)) return { ok: false, path: abs, error: `${abs} is not a directory` };
    const inside = await this.run(["git", "-C", abs, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 5000 });
    if (inside.code !== 0 || inside.stdout.trim() !== "true") return { ok: false, path: abs, error: `${abs} is not a git repository` };
    const origin = await originOf(this.run, abs);
    if (origin !== keyOf(repo)) {
      return {
        ok: true,
        path: abs,
        warning: `origin is ${origin ?? "not set"}, not ${repo.owner}/${repo.repo}`,
      };
    }
    return { ok: true, path: abs };
  }
}
