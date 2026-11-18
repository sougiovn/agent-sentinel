import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { expandHome } from "../core/repo-locate.ts";
import { parseCron, type Cron } from "./cron.ts";

export const ROUTINE_FILE = "ROUTINE.md";

/** A routine's id is its directory name, which must be lower kebab-case. */
export const ROUTINE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const Frontmatter = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  /** Cron expression, local time. */
  schedule: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  /** Where the agent starts; defaults to the routine's own directory. Relative paths are relative to it. */
  cwd: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true),
});

export interface RoutineDef {
  id: string;
  /** The routine's directory. */
  dir: string;
  name: string;
  description: string;
  schedule: string;
  cron: Cron;
  model: string | null;
  effort: string | null;
  /** Expanded, absolute. */
  cwd: string;
  enabled: boolean;
  /** ROUTINE.md without its frontmatter: the instructions for the agent. */
  body: string;
}

/** What scanning one directory under the routines folder found. */
export type RoutineScan = { ok: true; def: RoutineDef } | { ok: false; id: string; dir: string; error: string };

/** Splits `---`-fenced YAML frontmatter from the body. */
export function splitFrontmatter(text: string): { data: unknown; body: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error(`${ROUTINE_FILE} must start with a "---" frontmatter block`);
  let data: unknown;
  try {
    data = Bun.YAML.parse(m[1]!);
  } catch (e) {
    throw new Error(`invalid frontmatter YAML: ${(e as Error).message}`);
  }
  return { data, body: text.slice(m[0].length).trim() };
}

export function parseRoutine(id: string, dir: string, text: string): RoutineDef {
  const { data, body } = splitFrontmatter(text);
  const parsed = Frontmatter.safeParse(data ?? {});
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error).replace(/\n/g, "; "));
  const fm = parsed.data;
  let cron: Cron;
  try {
    cron = parseCron(fm.schedule);
  } catch (e) {
    throw new Error(`schedule "${fm.schedule}": ${(e as Error).message}`);
  }
  if (!body) throw new Error(`${ROUTINE_FILE} has no instructions after its frontmatter`);
  return {
    id,
    dir,
    name: fm.name,
    description: fm.description.trim(),
    schedule: fm.schedule,
    cron,
    model: fm.model ?? null,
    effort: fm.effort ?? null,
    cwd: !fm.cwd ? dir : fm.cwd.startsWith("~") || isAbsolute(fm.cwd) ? expandHome(fm.cwd) : resolve(dir, fm.cwd),
    enabled: fm.enabled,
    body,
  };
}

/** Every directory under `root` (hidden ones skipped), each parsed or with the reason it can't be used. */
export function scanRoutines(root: string): RoutineScan[] {
  if (!existsSync(root)) return [];
  const out: RoutineScan[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!ROUTINE_ID.test(name)) {
      out.push({ ok: false, id: name, dir, error: `directory name "${name}" must be lower kebab-case (like "morning-digest"); it is the routine's id` });
      continue;
    }
    const file = join(dir, ROUTINE_FILE);
    if (!existsSync(file)) {
      out.push({ ok: false, id: name, dir, error: `no ${ROUTINE_FILE} in ${dir}` });
      continue;
    }
    try {
      out.push({ ok: true, def: parseRoutine(name, dir, readFileSync(file, "utf8")) });
    } catch (e) {
      out.push({ ok: false, id: name, dir, error: (e as Error).message });
    }
  }
  return out;
}
