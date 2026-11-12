export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

const URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const SHORT_RE = /^(?:([^/\s]+)\/)?([^/\s#]+)\/([^/\s#]+)#(\d+)$/;

/** Parses a PR URL, `owner/repo#n`, or `host/owner/repo#n`. */
export function parsePrRef(input: string, defaultHost = "github.com"): PrRef {
  const s = input.trim();
  const url = URL_RE.exec(s);
  if (url) {
    return { host: url[1]!.toLowerCase(), owner: url[2]!, repo: url[3]!, number: Number(url[4]) };
  }
  const short = SHORT_RE.exec(s);
  if (short) {
    return {
      host: (short[1] ?? defaultHost).toLowerCase(),
      owner: short[2]!,
      repo: short[3]!,
      number: Number(short[4]),
    };
  }
  throw new Error(`Invalid PR reference "${input}". Use a PR URL or owner/repo#123.`);
}

export function prId(ref: PrRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`;
}

export function prUrl(ref: PrRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

export function fromPrId(id: string): PrRef {
  return parsePrRef(id);
}
