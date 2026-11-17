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
  /** Inline review threads: whether each is resolved, and the REST ids of its comments. */
  reviewThreads: GhReviewThread[];
}

export interface GhReviewThread {
  isResolved: boolean;
  commentIds: number[];
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}`;

interface ReviewThreadsPage {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { isResolved: boolean; comments: { nodes: { databaseId: number | null }[] } }[];
        };
      } | null;
    } | null;
  };
}

/** An open PR found by searching GitHub. */
export interface PrSummary {
  ref: PrRef;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
}

export interface ListPrsOptions {
  /** true = PRs you authored; false = any open PR involving you. */
  onlyMine: boolean;
}

export interface GhClient {
  fetchActivity(ref: PrRef): Promise<PrActivity>;
  listMyPrs(opts: ListPrsOptions): Promise<PrSummary[]>;
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
    const [view, inlineComments, conversationComments, reviews, reviewThreads] = await Promise.all([
      this.prView(ref, "state,title,body,headRefOid,statusCheckRollup"),
      this.api<GhComment>(ref, `pulls/${ref.number}/comments`),
      this.api<GhComment>(ref, `issues/${ref.number}/comments`),
      this.api<GhComment>(ref, `pulls/${ref.number}/reviews`),
      this.reviewThreads(ref),
    ]);
    return { view, inlineComments, conversationComments, reviews, reviewThreads };
  }

  /** Review threads come only from GraphQL; REST has no resolved state. Reads up to 100 comments per thread. */
  async reviewThreads(ref: PrRef): Promise<GhReviewThread[]> {
    const threads: GhReviewThread[] = [];
    let cursor: string | null = null;
    do {
      const args = [
        "gh",
        "api",
        "graphql",
        "--hostname",
        ref.host,
        "-F",
        `owner=${ref.owner}`,
        "-F",
        `repo=${ref.repo}`,
        "-F",
        `number=${ref.number}`,
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
      ];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const page = JSON.parse(await execOk(this.run, args)) as ReviewThreadsPage;
      const conn = page.data.repository?.pullRequest?.reviewThreads;
      if (!conn) break;
      for (const n of conn.nodes) {
        threads.push({
          isResolved: n.isResolved,
          commentIds: n.comments.nodes.map((c) => c.databaseId).filter((id): id is number => id !== null),
        });
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
    return threads;
  }

  async listMyPrs(opts: ListPrsOptions): Promise<PrSummary[]> {
    const out = await execOk(
      this.run,
      [
        "gh",
        "search",
        "prs",
        opts.onlyMine ? "--author=@me" : "--involves=@me",
        "--state=open",
        "--limit=200",
        "--json",
        "number,title,url,isDraft,updatedAt,repository",
      ],
      { timeoutMs: 60_000 },
    );
    const rows = JSON.parse(out) as {
      number: number;
      title: string;
      url: string;
      isDraft: boolean;
      updatedAt: string;
      repository: { nameWithOwner: string };
    }[];
    return rows.map((r) => {
      const host = new URL(r.url).host.toLowerCase();
      const [owner, repo] = r.repository.nameWithOwner.split("/") as [string, string];
      return { ref: { host, owner, repo, number: r.number }, title: r.title, url: r.url, isDraft: r.isDraft, updatedAt: r.updatedAt };
    });
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
