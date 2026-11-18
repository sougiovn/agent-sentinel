import { fromPrId } from "../core/pr-ref.ts";
import bashScript from "./completion.bash" with { type: "text" };

/** Top-level commands offered by completion. `hook`, `tui` and `__complete` are internal. */
export const COMMANDS = [
  "start",
  "watch",
  "unwatch",
  "list",
  "check",
  "comments",
  "draft",
  "tickets",
  "status",
  "reload",
  "stop",
  "restart",
  "skill",
  "notify",
  "completion",
  "daemon",
  "help",
] as const;

const SUBCOMMANDS: Record<string, readonly string[]> = {
  tickets: ["check", "dismiss"],
  skill: ["show", "install"],
  notify: ["test"],
  completion: ["bash"],
};

const OPTIONS: Record<string, readonly string[]> = {
  watch: ["--agent", "--session", "--cwd", "--include-existing"],
  list: ["--json"],
  comments: ["--json"],
  draft: ["--summary", "--change", "--reply"],
  status: ["--json"],
  tickets: ["--json"],
  daemon: ["--quiet"],
};

const AGENTS = ["claude", "codex"] as const;

/** Dynamic values the completion engine can offer. */
export interface CompletionSource {
  /** `host/owner/repo#n` ids of the PRs the daemon is watching. */
  watchedPrs: () => Promise<string[]>;
  /** Keys of the Jira tickets the daemon picked up. */
  ticketKeys: () => Promise<string[]>;
}

export interface CompletionResult {
  items: string[];
  /** Complete directories instead of items (`--cwd`). */
  dirs?: boolean;
}

/** The bash script printed by `sentinel completion bash`. */
export const bashCompletion = bashScript;

/**
 * Candidates for the word at the end of `words`, which are the arguments after
 * `sentinel` up to and including the one being completed (possibly empty).
 */
export async function complete(words: readonly string[], source: CompletionSource): Promise<CompletionResult> {
  const current = words.at(-1) ?? "";
  const consumed = words.slice(0, -1);
  const command = consumed[0];

  if (!command) {
    return { items: match(current.startsWith("-") ? ["--help"] : COMMANDS, current) };
  }

  const previous = consumed.at(-1)!;
  if (previous === "--agent") return { items: match(AGENTS, current) };
  if (previous === "--cwd") return { items: [], dirs: true };

  if (current.startsWith("-")) return { items: match(optionsFor(consumed), current) };

  switch (command) {
    case "watch":
      // Watched ids are also useful for re-registering a PR to this session.
      return { items: match([...optionsFor(consumed), ...(await watchedPrChoices(source))], current) };
    case "unwatch":
    case "check":
    case "comments":
    case "draft":
      return consumed.length === 1 ? { items: match(await watchedPrChoices(source), current) } : { items: [] };
    case "list":
    case "status":
    case "daemon":
      return { items: match(optionsFor(consumed), current) };
    case "tickets": {
      if (consumed.length === 1) {
        return { items: match([...SUBCOMMANDS.tickets!, ...OPTIONS.tickets!], current) };
      }
      if (consumed[1] === "dismiss" && consumed.length === 2) {
        return { items: match(await ticketKeyChoices(source), current) };
      }
      return { items: [] };
    }
    case "skill":
      return consumed.length === 1 ? { items: match(SUBCOMMANDS.skill!, current) } : { items: [] };
    case "notify":
      return consumed.length === 1 ? { items: match(SUBCOMMANDS.notify!, current) } : { items: [] };
    case "completion":
      return consumed.length === 1 ? { items: match(SUBCOMMANDS.completion!, current) } : { items: [] };
    default:
      return { items: [] };
  }
}

/** `--json` only applies to the ticket list, not to `check` or `dismiss`. */
function optionsFor(consumed: readonly string[]): readonly string[] {
  const command = consumed[0];
  if (command === "tickets" && consumed.length > 1) return [];
  return OPTIONS[command!] ?? [];
}

function match(items: readonly string[], prefix: string): string[] {
  return items.filter((item) => item.startsWith(prefix));
}

async function watchedPrChoices(source: CompletionSource): Promise<string[]> {
  try {
    const ids = await source.watchedPrs();
    const choices = new Set<string>();
    for (const id of ids) {
      try {
        const ref = fromPrId(id);
        // `owner/repo#n` is the shortest form users type; keep the host for GHE.
        choices.add(ref.host === "github.com" ? `${ref.owner}/${ref.repo}#${ref.number}` : id);
      } catch {
        choices.add(id);
      }
    }
    return [...choices];
  } catch {
    return [];
  }
}

async function ticketKeyChoices(source: CompletionSource): Promise<string[]> {
  try {
    return await source.ticketKeys();
  } catch {
    return [];
  }
}
