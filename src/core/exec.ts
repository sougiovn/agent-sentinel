export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export type Exec = (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = async (cmd, opts = {}) => {
  let env: Record<string, string> | undefined;
  if (opts.env) {
    env = {};
    for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v;
  }
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: env ?? process.env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export class ExecError extends Error {
  constructor(
    readonly cmd: string[],
    readonly result: ExecResult,
  ) {
    super(`${cmd[0]} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
}

export async function execOk(run: Exec, cmd: string[], opts?: ExecOptions): Promise<string> {
  const r = await run(cmd, opts);
  if (r.code !== 0) throw new ExecError(cmd, r);
  return r.stdout;
}
