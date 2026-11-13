import { exec as defaultExec, execOk, type Exec } from "../core/exec.ts";

/** An open Jira ticket as Sentinel needs it. */
export interface Ticket {
  key: string;
  summary: string;
  status: string;
  description: string;
  url: string;
}

export interface JiraClient {
  search(jql: string): Promise<Ticket[]>;
  transition(key: string, status: string): Promise<void>;
}

/** JQL string literal: double-quoted, with backslashes and quotes escaped. */
export function jqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Open tickets assigned to the current user that carry the label and are in one of the statuses. */
export function ticketJql(opts: { label: string; statuses: string[] }): string {
  return (
    [
      "assignee = currentUser()",
      `labels = ${jqlString(opts.label)}`,
      `status IN (${opts.statuses.map(jqlString).join(", ")})`,
    ].join(" AND ") + " ORDER BY created ASC"
  );
}

/** Plain text from a Jira description: a string (v2 API) or an Atlassian Document Format tree (v3 API). */
export function descriptionText(d: unknown): string {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (typeof d !== "object") return String(d);
  const node = d as {
    type?: string;
    text?: string;
    content?: unknown[];
    attrs?: { url?: string; text?: string; shortName?: string };
    marks?: { type?: string; attrs?: { href?: string } }[];
  };
  if (node.type === "text") {
    const text = node.text ?? "";
    const href = node.marks?.find((m) => m.type === "link")?.attrs?.href;
    return href && href !== text ? `${text} (${href})` : text;
  }
  if (node.type === "hardBreak") return "\n";
  if (node.type === "inlineCard" || node.type === "blockCard" || node.type === "embedCard") return node.attrs?.url ?? "";
  if (node.type === "mention") return node.attrs?.text ?? "";
  if (node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "";
  if (node.type === "rule") return "---\n";
  if (node.type === "listItem") return `- ${(node.content ?? []).map(descriptionText).join("").trimEnd()}\n`;
  const inner = (node.content ?? []).map(descriptionText).join("");
  const block = ["paragraph", "heading", "codeBlock", "blockquote"].includes(node.type ?? "");
  return block ? `${inner}\n` : inner;
}

/**
 * The ticket's browse URL on `site` (e.g. `acme.atlassian.net`). Without a site, falls back to the host of the
 * API `self` link, which on Jira Cloud can be an internal Atlassian host rather than the user's site.
 */
export function browseUrl(self: string | undefined, key: string, site?: string | null): string {
  if (site) return `https://${site.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/browse/${key}`;
  if (!self) return key;
  try {
    return `${new URL(self).origin}/browse/${key}`;
  } catch {
    return key;
  }
}

interface RawIssue {
  key?: string;
  self?: string;
  fields?: { summary?: string; status?: { name?: string } | string; description?: unknown };
}

/** Parses `acli jira workitem search --json`: an array of issues, or an object with `issues`. */
export function parseSearch(stdout: string, site?: string | null): Ticket[] {
  const text = stdout.trim();
  if (!text) return [];
  const data = JSON.parse(text) as RawIssue[] | { issues?: RawIssue[] };
  const issues = Array.isArray(data) ? data : (data.issues ?? []);
  return issues
    .filter((i): i is RawIssue & { key: string } => typeof i.key === "string")
    .map((i) => {
      const status = i.fields?.status;
      return {
        key: i.key,
        summary: i.fields?.summary ?? "",
        status: typeof status === "string" ? status : (status?.name ?? ""),
        description: descriptionText(i.fields?.description).trim(),
        url: browseUrl(i.self, i.key, site),
      };
    });
}

/** Jira through the Atlassian CLI (`acli`), which must already be authenticated (`acli jira auth login`). */
/** `Site: acme.atlassian.net` from `acli jira auth status`. */
export function parseAuthSite(stdout: string): string | null {
  return /^\s*Site:\s*(\S+)/m.exec(stdout)?.[1] ?? null;
}

export class AcliJira implements JiraClient {
  private site: string | null = null;

  constructor(
    private command: () => string,
    private run: Exec = defaultExec,
  ) {}

  /** The logged-in site, looked up once; ticket URLs use it. */
  private async siteName(): Promise<string | null> {
    if (this.site) return this.site;
    const r = await this.run([this.command(), "jira", "auth", "status"], { timeoutMs: 30_000 }).catch(() => null);
    this.site = r && r.code === 0 ? parseAuthSite(r.stdout) : null;
    return this.site;
  }

  async search(jql: string): Promise<Ticket[]> {
    const out = await execOk(
      this.run,
      [this.command(), "jira", "workitem", "search", "--jql", jql, "--fields", "key,summary,status,description", "--paginate", "--json"],
      { timeoutMs: 120_000 },
    );
    return parseSearch(out, await this.siteName());
  }

  async transition(key: string, status: string): Promise<void> {
    await execOk(this.run, [this.command(), "jira", "workitem", "transition", "--key", key, "--status", status, "--yes"], {
      timeoutMs: 60_000,
    });
  }
}
