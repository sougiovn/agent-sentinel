import { exec as defaultExec, execOk, type Exec } from "../core/exec.ts";
import type { PrRef } from "../core/pr-ref.ts";

export interface GhUser {
  login: string;
  type: string;
}

export interface GhComment {
  id: number;
  user: GhUser | null;
  body: string | null;
  html_url?: string;
  created_at?: string;
  submitted_at?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  state?: string;
}

export interface GhCheck {
  __typename: "CheckRun" | "StatusContext";
  name?: string;
  context?: string;
  conclusion?: string | null;
  state?: string | null;
  status?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
  completedAt?: string;
}

export interface GhPrView {
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  body: string;
  headRefOid: string;
  statusCheckRollup: GhCheck[] | null;
}

export interface PrActivity {
  view: GhPrView;
  inlineComments: GhComment[];
  conversationComments: GhComment[];
  reviews: GhComment[];
}

export interface GhClient {
  fetchActivity(ref: PrRef): Promise<PrActivity>;
  prState(ref: PrRef): Promise<GhPrView["state"]>;
  viewerLogin(host: string): Promise<string>;
  failedLog(ref: PrRef, runId: string): Promise<string>;
}

function repoArg(ref: PrRef): string {
  return ref.host === "github.com" ? `${ref.owner}/${ref.repo}` : `${ref.host}/${ref.owner}/${ref.repo}`;
}

export class GhCli implements GhClient {
  private logins = new Map<string, string>();

  constructor(private run: Exec = defaultExec) {}

  private async api<T>(ref: PrRef, path: string): Promise<T[]> {
    const out = await execOk(this.run, [
      "gh",
      "api",
      "--hostname",
      ref.host,
      "--paginate",
      "--slurp",
      `repos/${ref.owner}/${ref.repo}/${path}?per_page=100`,
    ]);
    const pages = JSON.parse(out) as T[][];
    return pages.flat();
  }

  async prView(ref: PrRef, fields: string): Promise<GhPrView> {
    const out = await execOk(this.run, ["gh", "pr", "view", String(ref.number), "-R", repoArg(ref), "--json", fields]);
    return JSON.parse(out) as GhPrView;
  }

  async prState(ref: PrRef) {
    return (await this.prView(ref, "state")).state;
  }

  async fetchActivity(ref: PrRef): Promise<PrActivity> {
    const [view, inlineComments, conversationComments, reviews] = await Promise.all([
      this.prView(ref, "state,title,body,headRefOid,statusCheckRollup"),
      this.api<GhComment>(ref, `pulls/${ref.number}/comments`),
      this.api<GhComment>(ref, `issues/${ref.number}/comments`),
      this.api<GhComment>(ref, `pulls/${ref.number}/reviews`),
    ]);
    return { view, inlineComments, conversationComments, reviews };
  }

  async viewerLogin(host: string): Promise<string> {
    const cached = this.logins.get(host);
    if (cached) return cached;
    const login = (await execOk(this.run, ["gh", "api", "--hostname", host, "user", "--jq", ".login"])).trim();
    this.logins.set(host, login);
    return login;
  }

  async failedLog(ref: PrRef, runId: string): Promise<string> {
    const r = await this.run(["gh", "run", "view", runId, "-R", repoArg(ref), "--log-failed"], { timeoutMs: 60_000 });
    return r.code === 0 ? r.stdout : "";
  }
}
