import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface Paths {
  home: string;
  config: string;
  theme: string;
  db: string;
  socket: string;
  pid: string;
  log: string;
  evalDir: string;
  promptsDir: string;
  hooksDir: string;
}

export function sentinelHome(env: Record<string, string | undefined> = process.env): string {
  return env.SENTINEL_HOME ?? join(homedir(), ".config", "sentinel");
}

export function getPaths(home = sentinelHome()): Paths {
  return {
    home,
    config: join(home, "config.json"),
    theme: join(home, "theme.json"),
    db: join(home, "sentinel.db"),
    socket: join(home, "sentinel.sock"),
    pid: join(home, "sentinel.pid"),
    log: join(home, "sentinel.log"),
    evalDir: join(home, "eval"),
    promptsDir: join(home, "prompts"),
    hooksDir: join(home, "hooks"),
  };
}

export function ensureHome(paths: Paths): void {
  for (const dir of [paths.home, paths.evalDir, paths.promptsDir, paths.hooksDir]) mkdirSync(dir, { recursive: true });
}

/** argv prefix that re-invokes this Sentinel binary (compiled or `bun src/cli/main.ts`). */
export function selfCommand(): string[] {
  const script = process.argv[1];
  const compiled = !script || script.startsWith("/$bunfs/") || script.startsWith("B:/~BUN/");
  return compiled ? [process.execPath] : [process.execPath, script];
}
