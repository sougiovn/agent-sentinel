import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, renameSync, watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";

export const DEFAULT_FIX_TEMPLATE = `Sentinel detected new activity on {{prUrl}} that needs your attention.

Evaluator reasoning: {{reason}}

{{items}}

Instructions:
- Fix the items above in this repository, commit, and push to the PR branch.
- You may reply to comments written by bots (user.type "Bot" or login ending in "[bot]").
- Never reply to, react to, or resolve comments written by humans. If you change code because of a human comment, tell the user what changed and suggest a reply they can paste.
- If an item doesn't need a code change, explain why instead of changing code.`;

export const DEFAULT_INTRO_TEMPLATE = `Sentinel started this session to own the pull request {{prUrl}} ({{title}}).

Get familiar with it:
- This directory ({{cwd}}) is a clone of {{repo}}. Check out the PR branch (\`gh pr checkout {{number}}\`) if it isn't checked out already.
- Read the PR description and diff so you understand the change.

Then stop and wait. Sentinel will resume this session with review comments and failing checks that need fixing.
- Never reply to, react to, or resolve comments written by humans.`;

export const DEFAULT_TICKET_TEMPLATE = `Sentinel started this session to work on the Jira ticket {{key}}: {{summary}}
{{url}}

Ticket description:
{{description}}

Where to work:
- You are in {{cwd}}, which holds the user's local repositories. Work out from the ticket which repository it belongs to and work there.
- If you are not sure which repository to use, or it isn't available locally, stop and ask the user for instructions. Don't guess and don't clone without asking.

What to do:
{{modeInstructions}}

Rules:
- Never reply to, react to, or resolve comments written by humans.`;

/** "default" in model/effort settings means the flag is omitted and the agent decides. */
export const AGENT_DEFAULT = "default";

export const TICKET_MODES = ["pr-watch", "pr", "plan"] as const;
export type TicketMode = (typeof TICKET_MODES)[number];

export const ConfigSchema = z.object({
  multiplexer: z.enum(["rex", "herdr", "hc"]).default("rex"),
  pollIntervalSec: z.number().int().min(30).default(300),
  evaluator: z
    .object({
      model: z.string().min(1).default("sonnet"),
      /** USD cap per evaluation. 0 = no cap. */
      maxBudgetUsd: z.number().min(0).default(0),
      failedLogLines: z.number().int().min(0).default(150),
    })
    .prefault({}),
  /** Comment authors to ignore. "@me" = the authenticated gh user. */
  ignoredAuthors: z.array(z.string()).default(["@me"]),
  failingConclusions: z
    .array(z.string())
    .default(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]),
  agents: z
    .object({
      claude: z.object({ command: z.string().default("claude"), args: z.array(z.string()).default([]) }).prefault({}),
      codex: z.object({ command: z.string().default("codex"), args: z.array(z.string()).default([]) }).prefault({}),
    })
    .prefault({}),
  spawn: z
    .object({
      layout: z.enum(["sentinel-tab", "tab-per-session"]).default("sentinel-tab"),
      maxPanesPerTab: z.number().int().min(1).default(4),
      /** 0 = unlimited. */
      maxConcurrent: z.number().int().min(0).default(0),
      busyTimeoutMin: z.number().int().min(1).default(60),
      sessionName: z.string().min(1).default("sentinel"),
    })
    .prefault({}),
  fixPromptTemplate: z.string().min(1).default(DEFAULT_FIX_TEMPLATE),
  /** Defaults for watches started from the TUI, which get a new agent session. */
  newWatch: z
    .object({
      /** Only list PRs you authored. false = any open PR involving you. */
      onlyMine: z.boolean().default(true),
      /** Directories scanned (two levels deep) for local clones of a PR's repo. */
      repoRoots: z.array(z.string()).default(["~/work"]),
      model: z.string().min(1).default(AGENT_DEFAULT),
      effort: z.string().min(1).default(AGENT_DEFAULT),
      models: z.array(z.string().min(1)).default([AGENT_DEFAULT, "opus", "sonnet", "haiku"]),
      efforts: z.array(z.string().min(1)).default([AGENT_DEFAULT, "low", "medium", "high", "xhigh", "max"]),
      /** Launch the session right away (true) or wait for the first actionable feedback (false). */
      startNow: z.boolean().default(true),
      /** Act on comments and failing checks that already exist when the watch starts. */
      includeExisting: z.boolean().default(true),
    })
    .prefault({}),
  /** Jira tickets (read through the Atlassian CLI) that Sentinel starts new agent sessions for. */
  jira: z
    .object({
      enabled: z.boolean().default(false),
      command: z.string().min(1).default("acli"),
      pollIntervalSec: z.number().int().min(60).default(600),
      /** Tickets must carry this label to be picked up. */
      label: z.string().min(1).default("sentinel"),
      /** Ticket statuses that are picked up. */
      statuses: z.array(z.string().min(1)).min(1).default(["To Do", "In Progress"]),
      /** Directory the agent starts in; it works out the repository from the ticket. */
      cwd: z.string().min(1).default("~/work"),
      model: z.string().min(1).default(AGENT_DEFAULT),
      effort: z.string().min(1).default(AGENT_DEFAULT),
      /** pr-watch: implement, open a PR and hand it to Sentinel. pr: implement and open a PR. plan: plan and wait. */
      mode: z.enum(TICKET_MODES).default("pr-watch"),
      /** Status to move a ticket to once its agent has started. "" = don't transition. */
      transitionTo: z.string().default("In Progress"),
      /** Status to move a ticket to once its session hands off a PR (pr-watch mode). "" = don't transition. */
      reviewStatus: z.string().default("In Review"),
      promptTemplate: z.string().min(1).default(DEFAULT_TICKET_TEMPLATE),
    })
    .prefault({}),
  /** First prompt for a session started with "start now" when there is no feedback to fix yet. */
  introPromptTemplate: z.string().min(1).default(DEFAULT_INTRO_TEMPLATE),
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export type LoadResult = { ok: true; config: Config } | { ok: false; error: string };

export function parseConfig(text: string): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, config: parsed.data };
}

/** Loads config, creating the file with defaults if missing. */
export function loadConfig(path: string): LoadResult {
  if (!existsSync(path)) {
    const cfg = defaultConfig();
    saveConfig(path, cfg);
    return { ok: true, config: cfg };
  }
  return parseConfig(readFileSync(path, "utf8"));
}

export function saveConfig(path: string, config: Config): void {
  const validated = ConfigSchema.parse(config);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(validated, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Watches the config file (via its directory, so atomic renames are caught).
 * Calls onChange with each parse result, debounced.
 */
export function watchConfig(path: string, onChange: (r: LoadResult) => void): FSWatcher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const name = basename(path);
  return watch(dirname(path), (_event, file) => {
    if (file && file !== name) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!existsSync(path)) return;
      onChange(parseConfig(readFileSync(path, "utf8")));
    }, 200);
  });
}
