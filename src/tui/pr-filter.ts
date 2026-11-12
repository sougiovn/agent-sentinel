import type { MyPr } from "../daemon/protocol.ts";

/** Text a PR is matched against: `owner/repo #n title`. */
function haystack(pr: MyPr): string {
  return `${pr.owner}/${pr.repo} #${pr.number} ${pr.title}`.toLowerCase();
}

/**
 * Keeps PRs matching every whitespace-separated token of the query (case-insensitive substring of
 * org, repo, `#number` or title). A bare number also matches the PR number exactly. Order is preserved.
 */
export function filterPrs(prs: MyPr[], query: string): MyPr[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return prs;
  return prs.filter((pr) => {
    const h = haystack(pr);
    return tokens.every((t) => h.includes(t) || (/^#?\d+$/.test(t) && String(pr.number) === t.replace("#", "")));
  });
}
