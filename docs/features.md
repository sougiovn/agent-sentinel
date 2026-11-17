# Agent Sentinel features

This page describes what Sentinel does today and how each part behaves. The [README](../README.md) has install steps and a quick overview.

- [The flow end to end](#the-flow-end-to-end)
- [Handing off PRs](#handing-off-prs)
- [Jira tickets](#jira-tickets)
- [Polling](#polling)
- [Detecting new activity](#detecting-new-activity)
- [Human comments](#human-comments)
- [Evaluation](#evaluation)
- [Queueing and delivery](#queueing-and-delivery)
- [Agent state hooks](#agent-state-hooks)
- [PR statuses](#pr-statuses)
- [Closed and merged PRs](#closed-and-merged-prs)
- [The daemon](#the-daemon)
- [CLI reference](#cli-reference)
- [TUI](#tui)
- [Configuration](#configuration)
- [Data on disk](#data-on-disk)
- [Agent skill](#agent-skill)
- [Verification status and known limits](#verification-status-and-known-limits)

## The flow end to end

1. An agent runs `sentinel watch <pr>` from its working directory. Sentinel records the PR, the agent kind, the session ID and the directory, and treats everything already on the PR as seen. Alternatively, you pick one of your PRs in the dashboard and Sentinel creates a new Claude session for it (see [Watching a PR from the TUI](#watching-a-pr-from-the-tui-new-sessions)).
2. Every poll interval, the daemon fetches each PR's comments, reviews and checks with `gh`.
3. Anything new is batched per PR and sent to one `claude -p` call, which decides whether the agent needs to act.
4. Flagged items go into a per-session queue. When the session is free, Sentinel opens (or reuses) a pane in its own multiplexer session and resumes the agent with a prompt describing the work.
5. Hooks in the resumed agent tell Sentinel when it's busy, idle or has exited, so the next batch is delivered only once the agent is done.
   - For human comments, the agent records a draft reply with `sentinel draft` instead of answering on GitHub. The dashboard shows which human comments are still open (see [Human comments](#human-comments)).
6. When the PR is closed or merged, Sentinel deletes everything it stored about it.

Code map: `src/daemon/sentinel.ts` (steps 1–4), `src/spawn/dispatcher.ts` (steps 4–5), `src/github/` (step 2), `src/evaluator/` (step 3), `src/mux/` (panes).

## Handing off PRs

```sh
sentinel watch <pr> [<pr>...] [--agent claude|codex] [--session <id>] [--cwd <dir>] [--include-existing]
```

- **PR formats:** a PR URL (`https://github.com/owner/repo/pull/123`, trailing paths and query strings allowed), `owner/repo#123`, or `host/owner/repo#123` for GitHub Enterprise. Hosts are lowercased. Internally a PR is identified as `host/owner/repo#123`.
- **Agent detection** (`src/cli/detect.ts`):
  - `$CLAUDE_CODE_SESSION_ID` set → agent `claude` with that session.
  - Otherwise `$CODEX_THREAD_ID` set → agent `codex` with that session.
  - The current directory becomes the directory the agent is resumed in.
  - `--agent`, `--session` and `--cwd` override what was detected. If the agent or session can't be determined, `watch` exits with an error.
- **Baseline:** comments, reviews and checks that exist at registration are marked seen, so only later activity triggers anything. The PR's status starts as `no_changes` with the reason "Baseline recorded". With `--include-existing`, nothing is marked seen and the PR is checked immediately.
- **Re-registering** a PR that's already watched replaces its owner (agent, session, directory). Fixes already queued for it move to the new session. A session that no longer owns any PR is removed.
- **Rejected:** PRs that are closed or merged at registration time, and references that don't parse. Each PR in a multi-PR `watch` is reported separately (`✓` or `✗`), and the command exits non-zero if any failed.
- **Starts the daemon:** if it isn't running, `watch` starts it first.

### Watching a PR from the TUI (new sessions)

Press `n` in the dashboard to watch a PR that no agent session owns yet. Sentinel creates a new Claude session for it.

1. **Pick a PR.** Sentinel lists your open PRs with `gh search prs --author=@me --state=open` (up to 200, most recently updated first). Set `newWatch.onlyMine: false` to list any open PR involving you (`--involves=@me`). Type to filter: every space-separated word must match the org, repo, `#number` or title (case-insensitive). PRs Sentinel already watches are marked `watched`; picking one moves it to the new session.
2. **Fill the form.**
   - **Agent:** Claude only. Codex can't be given a session id up front, so it isn't offered yet.
   - **Model / Effort:** cycle through `newWatch.models` / `newWatch.efforts`, or press `e` to type any model. `default` omits the flag. The choice is stored on the session and passed (`--model`, `--effort`) on every launch, including resumes.
   - **Directory:** prefilled with a local clone. A watched PR in the same repo supplies its directory first. Otherwise Sentinel scans `newWatch.repoRoots` (default `~/work`, two levels deep) for a git clone whose `origin` is the PR's repo, preferring a directory named after the repo. `enter` edits it, and `~` is expanded. On submit the path must exist and be a git repo. If its `origin` is a different repo, Sentinel warns you and a second `enter` goes ahead anyway.
   - **Start session:** `now` (default `newWatch.startNow`) or `on first feedback`.
   - **Existing feedback:** act on comments and failing checks already on the PR (default `newWatch.includeExisting`: on), or baseline them like `sentinel watch` does. An existing merge conflict is delivered either way.
3. **Start.** Sentinel generates a session UUID and registers the PR with it.
   - The first launch runs `claude --session-id <uuid> …` instead of `--resume`, so the hook signals match from the start. Later launches resume it.
   - With **Existing feedback** on, existing items are evaluated right away, and if any need work they become the first prompt.
   - With **Start session: now** and nothing to fix, Sentinel launches the session with `introPromptTemplate`, which tells the agent to check out the PR branch, read the change and wait. The PR's history records `session_started`.
   - With **on first feedback**, nothing launches until a later poll finds something to fix.

## Jira tickets

Sentinel can also start work for you. Write a Jira ticket, assign it to yourself, add the configured label (`jira.label`, default `sentinel`), and on the next Jira poll Sentinel starts a new Claude session for it. This is off until you set `jira.enabled` (`src/daemon/tickets.ts`, `src/jira/acli.ts`).

- **Reading Jira:** through the Atlassian CLI, which must be logged in (`acli jira auth login`). Each poll runs `acli jira workitem search --json` with `assignee = currentUser() AND labels = "<label>" AND status IN (<jira.statuses>)`, by default `"To Do", "In Progress"`.
- **Own interval:** `jira.pollIntervalSec` (default 600s, minimum 60), separate from the PR poll. The first Jira poll runs about 5 seconds after the daemon starts. `r` in the dashboard and `sentinel tickets check` poll Jira now too. Jira polls share the PR poll's queue, so they never run at the same time.
- **One session per ticket:** a new ticket gets a row in `tickets` and a new Claude session that starts in `jira.cwd` (default `~/work`), with `jira.model` and `jira.effort`. That row means Sentinel never starts a second session for the ticket, even though an In Progress ticket still matches the query. Dismissing a ticket only hides it.
- **The prompt:** `jira.promptTemplate`, with placeholders `{{key}}`, `{{url}}`, `{{summary}}`, `{{description}}`, `{{cwd}}` and `{{modeInstructions}}`. The default tells the agent to work out the repository from the ticket and to ask you if it isn't sure or the repository isn't available locally.
- **Modes (`jira.mode`):** `{{modeInstructions}}` depends on the mode.
  - `pr-watch` (default): implement, open a PR, then run `sentinel watch <pr>` from the same session. The PR is attached to the ticket's session, whose directory becomes the repository, so review feedback resumes it there. Sentinel then moves the ticket to `jira.reviewStatus` (default `In Review`) and records the PR on the ticket's row. This happens once; a failure shows `transition_failed` and is retried the next time that session runs `sentinel watch`. The watch itself succeeds either way. Leave `jira.reviewStatus` empty to skip this transition.
  - `pr`: implement and open a PR, then stop.
  - `plan`: write a plan and wait for your approval.
- **Writing to Jira:** the only writes are status transitions. Once the agent has started, Sentinel moves the ticket to `jira.transitionTo` (default `In Progress`) with `acli jira workitem transition`. A ticket already in that status isn't moved. Leave the field empty to skip this transition. The second transition, to `jira.reviewStatus`, is described under `pr-watch` above. Sentinel transitions only after the session starts, so a ticket whose launch failed stays where it was.
- **Limits and retries:** a ticket waits as `queued` while `spawn.maxConcurrent` agents are busy. A failed launch shows `spawn_failed` and is retried on the next poll. A failed transition shows `transition_failed`, and the agent keeps working. A failed search is shown in the dashboard and in `sentinel status`.
- **Ticket statuses:** `queued`, `started`, `in_review` (PR handed off and the ticket moved to review), `spawn_failed`, `transition_failed`.

## Polling

- One global interval, `pollIntervalSec` (default 300, minimum 30). The first poll runs about 3 seconds after the daemon starts; each later one is scheduled after the previous pass finishes.
- **Manual refresh:** `r` in the dashboard runs a full pass over every watched PR immediately and restarts the countdown for the next scheduled poll. It is refused while a poll is already running and for 30 seconds after the previous accepted manual refresh, so repeated presses can't cause a poll storm. The TUI shows the remaining cooldown. The same behavior is available over the API as the `refresh` method.
- PRs are checked one at a time. Polls, `sentinel check`, the TUI's check-now key and registrations all go through one serial queue, so they never overlap.
- After every pass, Sentinel tries to deliver anything still queued (for example, sessions whose busy timeout has expired).
- Per PR, Sentinel fetches (`src/github/gh.ts`):
  - `gh pr view --json state,title,body,headRefOid,mergeable,baseRefName,statusCheckRollup`
  - `gh api repos/{owner}/{repo}/pulls/{n}/comments` (inline review comments)
  - `gh api repos/{owner}/{repo}/issues/{n}/comments` (conversation comments)
  - `gh api repos/{owner}/{repo}/pulls/{n}/reviews` (review summaries)
- The API calls are paginated, use `--hostname` for the PR's host, and keep each author's `user.login` and `user.type`.
- If any fetch fails, the PR's status becomes `error` with the message, and the next poll tries again.

## Detecting new activity

Everything fetched is turned into items with stable IDs (`src/github/snapshot.ts`), and new items are those whose ID isn't in the PR's seen set.

| Source | Item ID | Included when |
| --- | --- | --- |
| Inline review comment | `inline:<id>` | Always |
| Conversation comment | `issue:<id>` | Always |
| Review summary | `review:<id>` | The review has a non-empty body and isn't `PENDING`. The body is prefixed with the review state, e.g. `[CHANGES_REQUESTED]` |
| Check run | `check:<workflow> / <name>:<details URL>` | The run is completed and its conclusion is in `failingConclusions` |
| Commit status | `status:<context>:<head SHA>` | Its state is in `failingConclusions` |
| Merge conflict | `conflict:<head SHA>` | GitHub reports `mergeable: CONFLICTING` |

- **Ignored authors:** comments and reviews from anyone in `ignoredAuthors` are skipped (case-insensitive). `@me` is resolved to the authenticated `gh` user for the PR's host, so the agent's own replies don't trigger another round.
- **Checks:** passing, skipped and in-progress checks are never items. A re-run produces a new details URL and therefore a new item; a commit status is keyed by head SHA, so each new commit can fail again.
- **Merge conflicts:** a conflict with the base branch skips the evaluator, since it always needs the agent, and is queued with whatever else the evaluator flags. The fix prompt names the base branch and asks the agent to bring it into the PR branch, resolve the conflicts, run the tests and push. The item is keyed by head SHA, so it's delivered once per head commit. The base moving on under an unchanged head doesn't repeat it, and a push that doesn't resolve the conflict gets it again. A conflict that exists when a PR is first watched is not baselined, so it's delivered on the first poll. GitHub works out `mergeable` in the background and returns `UNKNOWN` until it has, so Sentinel ignores `UNKNOWN` and keeps the last known value in `prs.mergeable` (with `prs.base_ref`). The `MERGE` column in the dashboard and `sentinel list` shows `conflict`, `ok` or `-`, and the PR details show a banner while a conflict is open.
- **Edits are ignored:** an edited comment keeps its ID, so it's never re-evaluated.
- **Failed-run logs:** for failed check runs that have an Actions run ID, Sentinel attaches the last `evaluator.failedLogLines` lines (default 150) of `gh run view <run> --log-failed`, for at most 5 checks per batch. Set `failedLogLines` to 0 to skip this.

## Human comments

Agents never reply to, react to, or resolve comments written by humans; you do. Sentinel tracks those comments so you can see which ones still need you, and gets a draft answer for each one from the agent.

**Tracking** (`human_comments` table, updated on every poll and at registration):
- A human comment is an inline review comment, conversation comment or review body whose author isn't a bot (`user.type` `Bot` or a login ending in `[bot]`) and isn't in `ignoredAuthors`. An author that can't be identified counts as human.
- Tracking doesn't depend on the evaluator or on the seen set. Comments that were baselined, or that the evaluator found nothing to change for (a question for you, say), are tracked too.
- **Inline review comments** follow their GitHub review thread. Sentinel reads `reviewThreads { isResolved }` through `gh api graphql`, since REST has no resolved state, and the comment closes when its thread is resolved on GitHub.
- **Conversation comments and review bodies** have no resolved state on GitHub. They stay open until you mark them resolved in the dashboard (`x`), even after someone replies.
- Deleted comments are dropped. Edits update the stored body.

**Drafts from the agent:**
- The fix prompt tells the agent to run `sentinel draft <pr> <item-id> --summary … --change … --reply …` for every human comment it was given: what the comment asks, what it changed (or why nothing), and a reply you can post. Fields left out keep their previous value. Drafts are accepted only for tracked human comments.
- **Stop hook check:** when an agent session that was given human comments tries to stop without a draft for each one, `sentinel hook idle` answers the `Stop` hook with `{"decision":"block","reason":…}`. The reason lists the missing `sentinel draft` commands, so the agent keeps going and records them. The session stays busy meanwhile. Sentinel asks once per delivery, and never while the agent is already continuing because of a Stop hook (`stop_hook_active`). If the agent still stops without one, the comment shows `⚠ no draft`.
- Sentinel never posts anything to GitHub. Posting from the dashboard is tracked in [#6](https://github.com/sougiovn/agent-sentinel/issues/6).

**States** shown in the dashboard: `needs you` (open, never sent to the agent), `agent working` (sent, the agent is still busy), `draft ready`, `⚠ no draft` (sent, the agent stopped without one) and `✓ resolved`.

## Evaluation

All new items for one PR go to a single headless Claude call (`src/evaluator/evaluator.ts`):

```sh
claude -p --model <evaluator.model> --output-format json --json-schema <schema> \
  --tools "" --no-session-persistence --strict-mcp-config --disable-slash-commands \
  [--max-budget-usd <evaluator.maxBudgetUsd>]
```

- **Input:** the PR URL, title and description, plus each item's ID, type, author (`user.login`, `user.type`, bot or human), file and line, URL, body and log tail. The diff is not sent. Descriptions and bodies are cut at 4,000 characters. The prompt is passed on stdin.
- **Output:** `{ shouldFix, reason, items }`, read from the CLI's `structured_output` field. `items` lists the IDs that need action.
- **Isolation:** the call runs in `~/.config/sentinel/eval/`, so it doesn't load a project's `CLAUDE.md`. No tools, MCP servers or slash commands are loaded, and no session is saved. Variables that identify the agent session the daemon was started from (such as `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID`) are removed; authentication variables are kept.
- **Budget:** `evaluator.maxBudgetUsd` defaults to 0, which means no `--max-budget-usd` flag. Any positive value is passed through, and Claude stops the call at that limit.
- **Results:**
  - `shouldFix: false` → every item is marked seen and the status becomes `no_action` with the evaluator's reason.
  - `shouldFix: true` → every item is marked seen, and the flagged ones (all of them, if `items` is empty or matches none) are queued for the PR's session with the reason.
  - Error, timeout (3 minutes) or invalid output → nothing is marked seen, the status becomes `error`, and the same items are evaluated again next poll together with anything newer.

## Queueing and delivery

Queued items wait in SQLite (`pending_items`) until their session can take them (`src/spawn/dispatcher.ts`).

- **One fix at a time per agent session.** While a session is busy, new flagged items pile up and go out together in the next delivery, even if they come from different PRs owned by the same session.
- **Sessions run in parallel.** `spawn.maxConcurrent` caps how many can be busy at once; the default 0 means unlimited. When a session frees up, sessions waiting for a slot are tried right away.
- **Pause:** a paused session (TUI key `p`) keeps queueing but receives nothing until it's resumed. Resuming triggers a delivery attempt.
- **Prompt:** items are grouped by PR, and each group is rendered with `fixPromptTemplate`, which supports `{{prUrl}}`, `{{reason}}` and `{{items}}`. Groups are joined with `---`. The default template asks the agent to fix, commit and push, to reply only to bot comments, and never to reply to or resolve human comments. The rendered prompt is saved to `~/.config/sentinel/prompts/<session>-<timestamp>.md`.

### Going to the agent

`A` (agent) on a PR or a Jira ticket takes you to its agent session, so you can talk to the agent in the right worktree:

- If the agent is still running in its pane, Sentinel focuses that pane.
- If the pane is there but the agent has exited, Sentinel resumes the agent in it, without a prompt.
- If the pane is gone, Sentinel opens a new tab for it in its own session/workspace, named after the pane, resumes the agent there and focuses it.

Rex also gets asked to show Sentinel's session (`rex do session.select`). That is a client action, so it only works with Remote Control on and one Rex app open. When it fails, the pane is still focused inside Sentinel's session, and the TUI shows why. A session Sentinel hasn't started yet (its first prompt is still queued) can't be gone to yet.

### Panes

Sentinel runs agents only in a multiplexer session (Rex) or workspace (Herdr) that it owns, named `spawn.sessionName` (default `sentinel`). Each agent session gets one pane, named after the work it handles: the Jira ticket key (`CP-7713`), or the repo and number of each PR it watches (`web#42`, comma-separated if there are several). A session with neither falls back to `<agent>:<first 8 chars of session ID>`. The pane's ID is stored so it can be reused, and the name is set once, when the pane is created.

- `spawn.layout: "sentinel-tab"` (default): new panes go into an existing Sentinel tab that has fewer than `spawn.maxPanesPerTab` panes (default 4), alternating right and below splits. When every tab is full, Sentinel opens a new one.
- `spawn.layout: "tab-per-session"`: every new pane gets its own tab, named like the pane. Shared tabs (`sentinel-tab`) keep numbered names: `sentinel-1`, `sentinel-2`, and so on.
- Sentinel remembers its home session/workspace by id, so it keeps finding it after an agent inside renames it (Rex prompts Claude to label its session). It falls back to `spawn.sessionName` only when that id is gone.
- With Rex, every prompt Sentinel delivers ends with a note telling the agent not to rename the shared Rex session. It mustn't rename its tab either: with `sentinel-tab` other agents share it, and with `tab-per-session` Sentinel has already named it after the ticket or PR.
- Panes start as an interactive shell in the agent's directory, and Sentinel types commands into them. New panes and tabs don't take focus.
- If the stored pane no longer exists (closed by the user, or the Sentinel session was killed), Sentinel creates a new one, and recreates the session or workspace if needed.
- Changing `multiplexer` makes the next delivery open a new pane in the new multiplexer.

### What gets typed

- **New pane, or the agent has exited:** a launch command, e.g.

  ```sh
  cd '<cwd>' && 'claude' --resume '<session>' --settings '<hooks file>' \
    --add-dir '~/.config/sentinel/prompts' <claude args> -- "$(cat '<prompt file>')"
  ```

  The `--` matters: `--add-dir` takes any number of directories, so without it Claude would read the prompt as another directory and start with no prompt.

  A session created from the TUI or for a Jira ticket uses `--session-id '<session>'` on its first launch. Its model and effort are added as `--model`/`--effort` (Codex: `-m`, `-c model_reasoning_effort=…`).

  For Codex: `cd '<cwd>' && 'codex' resume -c hooks.Stop=… -c hooks.UserPromptSubmit=… <codex args> '<session>' "$(cat '<prompt file>')"`.
- **Agent still running and idle:** one line, `Sentinel has new PR feedback for you. Read the file <prompt file> and follow its instructions.`, followed by Enter. Typing a pointer instead of the whole prompt avoids pasting multi-line text into the agent's input.

After a successful delivery, the session is marked busy and its PRs' status becomes `fix_running`.

### When delivery fails

If the multiplexer can't be reached (Rex down, Herdr server not running) or a pane command fails:

- each affected PR's status becomes `spawn_failed` with the error;
- the queued items are dropped and un-marked as seen.

The next poll then sees them as new again and evaluates them together with anything newer, so nothing is lost and the agent gets one combined prompt. Sentinel never starts the Herdr server itself.

## Agent state hooks

Resumed agents report their state back through `sentinel hook <signal>`. The hook reads `session_id` from the payload the agent sends on stdin (falling back to environment variables) and tells the daemon. It always exits successfully, so it can't break the agent.

| Signal | Claude hook | Codex hook | Effect |
| --- | --- | --- | --- |
| `busy` | `UserPromptSubmit` | `UserPromptSubmit` | Session busy; nothing is delivered |
| `idle` | `Stop` | `Stop` | Session idle; queued items are delivered by typing the pointer line. If human comments it was given have no draft yet, the hook blocks the stop once instead (see [Human comments](#human-comments)) |
| `exit` | `SessionEnd` | none | Agent gone; the next delivery types the full launch command |

- Claude receives the hooks through `--settings ~/.config/sentinel/hooks/claude-settings.json`, which Sentinel writes before each launch. The same file adds the daemon socket to `sandbox.network.allowUnixSockets`, so a sandboxed agent can still run `sentinel watch` and the other CLI commands (for example a Jira ticket session handing off its PR). Without it the CLI can't reach the daemon, reports it as not running and tries to start another one. Sessions you start yourself need the socket in your own settings: add `~/.config/sentinel/sentinel.sock` to `sandbox.network.allowUnixSockets` in `~/.claude/settings.json`.
- Codex receives them as `-c` overrides.
- Because the `busy` hook fires whenever someone submits a prompt, a user typing to the agent in a Sentinel pane holds deliveries until the agent stops again.
- **Busy timeout:** a session that stays busy longer than `spawn.busyTimeoutMin` minutes (default 60) is treated as idle. This covers agents whose hooks don't fire.
- On `idle` or `exit`, PRs of that session in `fix_running` change to `fix_spawned` with the reason "Agent finished" or "Agent exited".

## PR statuses

Shown in `sentinel list` and the TUI.

| Status | Meaning |
| --- | --- |
| `pending` | Registered, not checked yet (only seen briefly with `--include-existing`) |
| `no_changes` | Last poll found nothing new, or the baseline was just recorded |
| `no_action` | New items were found and the evaluator said no work is needed |
| `fix_spawned` | A fix is queued waiting for the session, or was delivered and the agent has finished |
| `fix_running` | A fix was delivered and the agent is working on it |
| `spawn_failed` | Delivery failed; items will be re-evaluated on the next poll |
| `error` | The GitHub fetch or the evaluation failed; retried on the next poll |

A poll that finds nothing new keeps `fix_spawned` and `fix_running` as they are, instead of overwriting them with `no_changes`.

## Closed and merged PRs

When a poll finds a PR in `CLOSED` or `MERGED` state, Sentinel deletes the PR row and, through cascading deletes, its seen items, queued items, human comments and event history. The owning agent session is removed if it has no other PRs. The PR is no longer polled. Draft PRs keep being watched.

## The daemon

- `sentinel start` starts the daemon in the background as a detached `sentinel daemon --quiet` process, waits up to 5 seconds for it to answer, and prints its status. If it's already running, it just prints the status. `sentinel` (the dashboard) and `sentinel watch` start it the same way when it isn't running.
- The daemon is independent of the dashboard: quitting the TUI leaves it running.
- `sentinel daemon` runs it in the foreground and logs to stderr as well as `sentinel.log`. Startup failures are written to the log too.
- **Single instance:** a second daemon refuses to start while one is answering on the socket. A leftover socket file from a crashed daemon is removed on start.
- **API:** the CLI and TUI talk to the daemon over `~/.config/sentinel/sentinel.sock`, with JSON requests of the form `{ method, params }` (`src/daemon/protocol.ts`). Methods: `status`, `list`, `watch`, `unwatch`, `check`, `refresh`, `history`, `signal`, `pause`, `humanComments`, `draft`, `resolveComment`, `goToAgent`, `reload`, `stop`, `tickets`, `pollTickets`, `dismissTicket`, `myPrs`, `newWatchDefaults`, `suggestCwd`, `validateCwd`, `repos`. `repos` returns the [repos view](#repos-view): the configured roots and each repo's worktrees with the PR ids and ticket keys tied to them. `refresh` is the manual full poll described under [Polling](#polling). The daemon is the only process that writes to SQLite.
- **Stopping:** `sentinel stop` asks the daemon to exit; if it doesn't answer, Sentinel sends `SIGTERM` to the PID in `sentinel.pid`. `SIGINT` and `SIGTERM` shut it down cleanly, removing the socket and pidfile. It waits up to 5 seconds for the daemon to stop answering.
- **Restarting:** `sentinel restart` stops the daemon the same way, then starts a new one in the background (or just starts one if none was running). Use it after upgrading Sentinel, since a daemon started from the old build keeps running until it's stopped.
- Prompt files older than 7 days are deleted after each poll.

## CLI reference

| Command | Description |
| --- | --- |
| `sentinel` | Open the dashboard, starting the daemon if it isn't running (`sentinel tui` is an alias) |
| `sentinel start` | Start the daemon in the background without the dashboard, and print its status |
| `sentinel watch <pr>...` | Hand off PRs (see [Handing off PRs](#handing-off-prs)) |
| `sentinel unwatch <pr>` | Stop watching a PR and delete its data |
| `sentinel list [--json]` | Table of watched PRs: ID, agent, session, last check, open human comments, status, reason |
| `sentinel check [<pr>]` | Poll one PR, or all of them, now, then try to deliver queued fixes |
| `sentinel comments <pr> [--json]` | The PR's human comments: ID, author, location, state, and the draft if there is one |
| `sentinel draft <pr> <item-id> [--summary …] [--change …] [--reply …]` | Record a draft for a human comment. Run by agents; see [Human comments](#human-comments) |
| `sentinel tickets [--json]` | Table of Jira tickets Sentinel picked up: key, summary, session, pick-up time, status, reason |
| `sentinel tickets check` | Poll Jira now |
| `sentinel tickets dismiss <key>` | Hide a ticket from the list; it still won't be picked up again |
| `sentinel status [--json]` | PID, home directory, multiplexer, interval, time until next poll, number of PRs, config error |
| `sentinel reload` | Re-read `config.json` |
| `sentinel stop` | Stop the daemon |
| `sentinel restart` | Stop the daemon and start it again |
| `sentinel skill show` | Print the agent skill |
| `sentinel skill install` | Install the skill to `~/.claude/skills/sentinel/` and `~/.codex/skills/sentinel/` |
| `sentinel completion bash` | Print a bash completion script |
| `sentinel daemon [--quiet]` | Run the daemon in the foreground |
| `sentinel hook idle\|busy\|exit` | Used by agent hooks; not meant to be run by hand |

`unwatch`, `list`, `check`, `comments`, `draft`, `status` and `reload` need a running daemon and fail with "Sentinel daemon is not running" otherwise. `sentinel`, `sentinel start` and `watch` start it when needed.

## TUI

`sentinel` (`src/tui/app.tsx`) opens the dashboard. If the daemon isn't running, the TUI starts it on launch, then refreshes from it every 2 seconds.

**Main view:**
- **Header:** multiplexer, poll interval and countdown to the next poll.
- **Table:** PRs grouped under an `org/repo` heading (the host is added for GitHub Enterprise), groups sorted alphabetically and PRs by number. Each PR is one line, `#123 - title` (the title is refreshed on every poll), then agent, session (with ⏸ when paused), last checked, open human comments (`HUMAN`, highlighted when there are any), merge state (`MERGE`: `conflict` in the error colour, `ok`, or `-` until GitHub has reported it), status (colour-coded) and reason. The table title shows the total of open human comments across all PRs.
- **Details panel:** the selected PR's URL, full session ID, directory, pane ID and agent state.

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Select a PR |
| `/` | Filter watched PRs: every word must appear in the PR's `org/repo` or title. `Enter` keeps the filter and returns to the list, `Esc` clears it |
| `Enter` | PR details: human comments and event history |
| `n` / `w` | Watch one of your PRs with a new Claude session (see [Watching a PR from the TUI](#watching-a-pr-from-the-tui-new-sessions)) |
| `g` | Repos and worktrees (see [Repos view](#repos-view)) |
| `o` | Open the selected PR in the browser (`open`, or `xdg-open` on Linux) |
| `c` | Check the selected PR now |
| `r` | Refresh all watched PRs now and restart the poll countdown (single-flight, 30s cooldown) |
| `d`, then `y` | Unwatch the selected PR |
| `p` | Pause or resume deliveries to the PR's agent session |
| `A` | Go to the PR's agent session (see [Going to the agent](#going-to-the-agent)) |
| `t` | Move the selection between the PR list and the Jira tickets list. With a ticket selected: `↑/↓` move, `o` opens it in the browser, `A` goes to its agent, `d` dismisses it (asks first), `p` pauses or resumes its session, `t`/`Esc` go back to PRs |
| `s` | Settings |
| `R` | Reload config and theme in the TUI and the daemon |
| `S` | Retry starting the daemon (when it's offline) |
| `?` | Show or hide every shortcut for the current screen |
| `q` / `Ctrl+C` | Quit |

- **Footer and `?`:** the footer lists the current screen's shortcuts, most used first, and keeps as many whole ones as fit the terminal width; a `…` marks the ones left out. `? help` is always shown at the right. `?` opens a dialog listing all of the current screen's shortcuts, plus the two that work everywhere (`?` and `Ctrl+C`). It works on every screen, including while a filter input or a value being edited has focus, so `?` can't be typed into those inputs. While the dialog is open other keys are ignored; `Esc`, `?` or `Enter` close it, and `↑`/`↓` scroll it when it doesn't fit. `/` filters the list: every word must appear in a shortcut's key or action. While typing, `Enter` keeps the filter and `Esc` clears it; with a filter kept, `Esc` clears it first and a second `Esc` closes the dialog. A filter input open under the dialog keeps its text and focus. A pending unwatch or dismiss confirmation is cancelled when `?` is pressed. Messages such as "Saved" replace the footer hints for 5 seconds but leave `? help` in place.
- **Daemon offline:** while the daemon is starting, the TUI shows "Starting Sentinel daemon…". If it fails to start or stops later, the TUI shows the error and offers `S` to try again.
- **Config errors:** an invalid config file, or a daemon running on its last good config, is shown in a red banner.
- **PR details (`Enter`):**
  - **Human comments:** one line per comment, open ones first: state, author, file and line (or `conversation`/`review`), and the start of the comment. Below the list, the selected comment in full with the agent's draft: `About` (what it asks), `Change` (what the agent did) and the proposed reply. Keys: `↑`/`↓` select, `y` copies the reply to the clipboard (`pbcopy`, `wl-copy`, `xclip` or `xsel`), `e` edits the reply in `$EDITOR` (saved as your draft), `x` marks the comment resolved or reopens it, `o` opens the comment on GitHub, `Esc` goes back. A thread resolved on GitHub can only be reopened on GitHub.
  - **History:** the last 50 events per PR, newest first: `registered`, `reassigned`, `session_started`, `new_items`, `evaluated` (with verdict, reason and cost), `fix_delivered` (pane, items, prompt file), `agent_idle`, `agent_exit`, `spawn_failed`, `error`, `draft_recorded`, `comment_resolved`, `comment_reopened`.

### Repos view

`g` lists every git repo under `newWatch.repoRoots` with all of its worktrees, and shows which watched PRs and Jira tickets belong to each worktree.

- **Repos:** main checkouts found two levels deep under each root, sorted by path. A directory that is itself a linked worktree (its `.git` is a file) isn't listed as a repo; it appears under its repo instead. Worktrees are listed even when they live outside the roots (for example `~/.codex/worktrees/…` or `~/.gitbutler-worktrees/…`). The heading shows `owner/repo` from `origin` (with the host for GitHub Enterprise), or the directory name when there is no `origin`.
- **Worktrees:** from `git worktree list --porcelain`, main checkout first. Each line shows the branch (or `detached <sha>`), the path, and tags for the main checkout, a locked worktree, and one whose directory is gone (`missing (prunable)`). If git can't list a repo's worktrees, its error is shown under the heading.
- **PRs:** a watched PR is listed under the worktree that contains its directory. When worktrees are nested (a `.claude/worktrees/…` inside the main checkout), the deepest one wins.
- **Jira tickets:** a ticket is listed under the worktree of the PR its session handed off, and under every worktree whose branch or directory name contains the ticket key as a whole token (`CP-123-fix`, `feat/CP-123` and `giovane/cp-123/x` match `CP-123`; `CP-1234` doesn't). If neither applies, it goes under the worktree containing its session's directory. Dismissed tickets aren't shown.
- **Status:** PR and ticket lines show their current status and session, and update with the 2-second refresh. The worktree scan itself runs only when the view opens and on `r`, because it runs git once per repo.
- **Summary line:** repo and worktree counts, how many worktrees have a watched PR or ticket, and how many are shown while a filter is on.
- The list scrolls inside its box and keeps the selected worktree, its PRs and tickets, and (for a repo's first worktree) the repo heading in view.

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Select a worktree |
| `/` | Filter: every word must appear in the repo name or path, the branch, the worktree path, or a linked PR (`#number`, title, status) or ticket (key, summary, status). Only matching worktrees are shown, and repos with none are hidden. `Enter` keeps the filter and returns to the list, `Esc` clears it |
| `o` | Open the selected worktree's first PR in the browser, or its first ticket when it has no PR |
| `r` | Rescan the repo roots; the selection stays on the same worktree |
| `?` | Show or hide this view's shortcuts |
| `Esc`/`q` | Back to the main view (`Esc` clears an active filter first) |

**Settings** open in a dialog over the PR list. Every config field is listed with its current value, one line each (long values are cut short), and the list scrolls to keep the selection visible.

| Key | Action |
| --- | --- |
| `Enter`/`Space` | Edit a text or number field inline; cycle an enum (`multiplexer`, `spawn.layout`) |
| `Enter` (while editing) | Save |
| `Esc` (while editing) | Cancel |
| `/` | Filter settings by name: every word must appear in the label or config key. `Enter` keeps the filter and returns to the list, `Esc` clears it |
| `e` | Open the selected template (`fixPromptTemplate`, `introPromptTemplate`) in `$VISUAL` or `$EDITOR` (default `vi`) |
| `r` | Reload config and theme (inside settings; the main view uses `R` for this) |
| `?` | Show or hide the settings shortcuts (also while a value is being edited) |
| `Esc`/`q` | Back to the main view (`Esc` clears an active filter first) |

- Lists (ignored authors, failing conclusions, agent args) are edited as comma-separated text.
- Values are validated before saving; an invalid value shows an error and leaves the file unchanged.
- Every save writes `config.json` and tells the daemon to reload.

## Configuration

`~/.config/sentinel/config.json` is created with defaults on first run (`src/core/config.ts`). Missing fields take their defaults, so a partial file is valid.

| Field | Default | Notes |
| --- | --- | --- |
| `multiplexer` | `"rex"` | `"rex"` or `"herdr"` |
| `pollIntervalSec` | `300` | Minimum 30 |
| `evaluator.model` | `"sonnet"` | Any `claude --model` value |
| `evaluator.maxBudgetUsd` | `0` | 0 = no cap |
| `evaluator.failedLogLines` | `150` | 0 disables log tails |
| `ignoredAuthors` | `["@me"]` | Case-insensitive logins; `@me` = authenticated `gh` user |
| `failingConclusions` | `FAILURE`, `ERROR`, `TIMED_OUT`, `CANCELLED`, `ACTION_REQUIRED`, `STARTUP_FAILURE` | Check conclusions and status states that count as failures |
| `agents.claude.command` / `.args` | `"claude"` / `[]` | Extra arguments for every Claude launch, e.g. `["--permission-mode", "acceptEdits"]` |
| `agents.codex.command` / `.args` | `"codex"` / `[]` | Extra arguments for resumed Codex sessions, e.g. `["-s", "workspace-write"]` |
| `spawn.layout` | `"sentinel-tab"` | Or `"tab-per-session"` |
| `spawn.maxPanesPerTab` | `4` | |
| `spawn.maxConcurrent` | `0` | 0 = unlimited |
| `spawn.busyTimeoutMin` | `60` | |
| `spawn.sessionName` | `"sentinel"` | Name of Sentinel's Rex session or Herdr workspace |
| `fixPromptTemplate` | built-in | Placeholders `{{prUrl}}`, `{{reason}}`, `{{items}}` |
| `introPromptTemplate` | built-in | First prompt for a TUI-started session with nothing to fix. Placeholders `{{prUrl}}`, `{{title}}`, `{{repo}}`, `{{number}}`, `{{cwd}}` |
| `newWatch.onlyMine` | `true` | PR picker lists only PRs you authored; `false` = any open PR involving you |
| `newWatch.repoRoots` | `["~/work"]` | Scanned two levels deep for local clones, and listed in the [repos view](#repos-view) |
| `newWatch.model` / `.models` | `"default"` / `default, opus, sonnet, haiku` | Default and choices for the form; `default` omits `--model` |
| `newWatch.effort` / `.efforts` | `"default"` / `default, low, medium, high, xhigh, max` | Default and choices for the form; `default` omits `--effort` |
| `newWatch.startNow` | `true` | Form default for "Start session" |
| `newWatch.includeExisting` | `true` | Form default for "Existing feedback" |
| `jira.enabled` | `false` | Pick up Jira tickets (see [Jira tickets](#jira-tickets)) |
| `jira.command` | `"acli"` | Atlassian CLI binary |
| `jira.pollIntervalSec` | `600` | Minimum 60 |
| `jira.label` | `"sentinel"` | Label a ticket needs to be picked up |
| `jira.statuses` | `["To Do", "In Progress"]` | Ticket statuses picked up |
| `jira.cwd` | `"~/work"` | Directory the ticket agent starts in |
| `jira.model` / `jira.effort` | `"default"` / `"default"` | `default` omits `--model` / `--effort` |
| `jira.mode` | `"pr-watch"` | `pr-watch`, `pr` or `plan` |
| `jira.transitionTo` | `"In Progress"` | Status to move a ticket to once its agent starts; `""` = never |
| `jira.reviewStatus` | `"In Review"` | Status to move a ticket to once its session hands off a PR (`pr-watch`); `""` = never |
| `jira.promptTemplate` | built-in | Placeholders `{{key}}`, `{{url}}`, `{{summary}}`, `{{description}}`, `{{cwd}}`, `{{modeInstructions}}` |

**Reloading:**
- The daemon watches the file and reloads about 200 ms after a change, whether the change came from the TUI or another editor. `sentinel reload` and the TUI's `R` (or `r` inside settings) reload on demand.
- An invalid file (bad JSON or a value that fails validation) is logged, reported in `status` and the TUI, and the daemon keeps running on the last good config.
- A new poll interval takes effect immediately. Other settings apply from the next poll or delivery.

### Theme

The dashboard's colours live in a separate `~/.config/sentinel/theme.json` (`src/tui/theme.ts`), created with the defaults when the dashboard first runs. It holds colours only. Every key is optional, so a partial file is valid; missing keys keep their defaults, and `statuses` is merged with the default status colours.

| Key | Default | Used for |
| --- | --- | --- |
| `text` | `#ecf0f1` | Default text and statuses with no colour |
| `textSecondary` | `#bdc3c7` | PR titles, reasons and event details |
| `textMuted` | `#7f8c8d` | Hints, field labels, table headers and the footer |
| `accent` | `#2ecc71` | Title, focused borders and other highlights |
| `info` | `#3498db` | Repo group headings, timestamps and `watched` markers |
| `success` | `#2ecc71` | Success messages |
| `warning` | `#e67e22` | Warnings, like the daemon being offline |
| `error` | `#e74c3c` | Errors and invalid config |
| `pending` | `#f1c40f` | Work-in-progress messages |
| `selectionBackground` | `#2c3e50` | Background of the selected row |
| `modalBackground` | `#1e272e` | Background of the floating dialogs |
| `statuses.<status>` | see below | Colour of that status in the PR and ticket lists |

Statuses default to `no_changes` `#7f8c8d`, `no_action` `#95a5a6`, `pending` `#7f8c8d`, `fix_spawned` `#3498db`, `fix_running` `#f1c40f`, `spawn_failed` `#e74c3c`, `error` `#e74c3c`, `queued` `#3498db`, `started` `#f1c40f`, `in_review` `#2ecc71` and `transition_failed` `#e67e22`. An unknown status uses `text`.

- Colours are `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, a CSS colour name or `transparent`.
- The TUI watches the file and applies a change about 200 ms after it is saved. `R` (or `r` inside settings) reloads it on demand.
- Invalid JSON or a colour that fails validation shows a banner and keeps the last good theme. Unknown keys are rejected, so typos don't pass silently.
- Deleting the file resets the running TUI to the defaults; it is created again with the defaults on the next launch.

## Data on disk

Everything lives in `~/.config/sentinel/`, or in `$SENTINEL_HOME` if that's set.

| Path | Contents |
| --- | --- |
| `config.json` | Settings |
| `theme.json` | Dashboard colours (created with the defaults when the dashboard first runs) |
| `sentinel.db` | SQLite database (WAL mode) |
| `sentinel.sock` | Daemon socket |
| `sentinel.pid` | Daemon PID |
| `sentinel.log` | Daemon log |
| `prompts/` | Rendered fix prompts, kept 7 days |
| `hooks/claude-settings.json` | Settings passed to every Claude session Sentinel launches: the state hooks, and the daemon socket in the sandbox allowlist |
| `eval/` | Working directory for evaluator calls |
| `fixPromptTemplate.md`, `introPromptTemplate.md`, `jira.promptTemplate.md` | Scratch files used when editing a template from the TUI |
| `reply-<item>.md` | Scratch file used when editing a human comment's reply from the TUI (`e` in PR details) |

Database tables (`src/core/db.ts`, versioned migrations in `meta.schema_version`):

| Table | Holds |
| --- | --- |
| `prs` | One row per watched PR: URL, title (refreshed every poll), agent, session, directory, registration time, last check time, status, reason |
| `seen_items` | Item IDs already handled, per PR |
| `pending_items` | Flagged items waiting for delivery, with the evaluator's reason |
| `sessions` | Per agent session: agent, directory, model and effort, whether Sentinel has launched it yet (`started`, 0 only for TUI-started sessions before their first launch), multiplexer, pane and tab IDs, busy or idle, paused, agent running, busy-since and last-signal timestamps |
| `events` | Per-PR history, trimmed to the newest 50 |
| `tickets` | One row per Jira ticket picked up: URL, summary, session, directory, pick-up time, status, reason, dismissed, and the PR its session handed off |
| `human_comments` | Human comments per PR: author, body, location, URL, resolved on GitHub, resolved by you, when and to which session it was delivered, whether the Stop hook asked for its draft, and the draft (summary, change, reply, who wrote it, when) |

The database is open for inspection, for example `sqlite3 ~/.config/sentinel/sentinel.db 'select id, last_status from prs'`. Write to it only while the daemon is stopped.

## Agent skill

`skills/sentinel/SKILL.md` is built into the binary. It tells Claude Code and Codex agents when to hand off a PR, the `watch`, `unwatch`, `list`, `check`, `comments`, `draft` and `status` syntax, how their identity is detected, what to expect when Sentinel resumes them, and how to record a draft for each human comment. Install it with `sentinel skill install`, or print it with `sentinel skill show`.

## Verification status and known limits

Covered by `bun test`, with fake `gh`, evaluator and multiplexer: the poll → evaluate → queue → deliver flow, baseline and `--include-existing`, ignored authors, failing checks and log tails, retry after evaluator, GitHub and delivery failures, closed-PR cleanup, the per-session queue (busy, idle, exit, pause, busy timeout, recreating closed panes, batching across PRs, `maxConcurrent`), manual refresh (all PRs, single-flight, 30s cooldown, poll countdown reset), config parsing and reload, theme parsing (defaults, partial files, status merge, invalid colours and unknown keys), database migrations, the API, launch command quoting (including `--session-id`, `--model` and `--effort`), `gh search prs` argument building and parsing, finding local clones and validating directories, the repos view data (parsing `git worktree list --porcelain`, listing main checkouts but not linked worktrees, tying PRs to the deepest worktree and tickets by handed-off PR, key in the branch or directory name, then session directory, a repo whose worktrees can't be listed, roots that don't exist), new-session watches (start now, on first feedback, existing feedback, a failed first launch, Codex rejected), merge conflicts (skipping the evaluator, once per head, `UNKNOWN` keeping the last state, delivery with flagged comments, a PR already conflicting when watched), PR titles, and the stop logic behind `stop` and `restart`. TUI tests drive the settings dialog and its filter, the PR picker and new-watch form end to end (filtering, prefilled directory, validation and the remote-mismatch warning), the watched-PR filter, grouping, the `MERGE` column and the conflict banner in the PR details, opening a PR in the browser, the `r`/`R` keys and their cooldown feedback, a custom theme and its live reload (including an invalid edit keeping the last good theme), and starting the daemon.

Human comments are covered with the fake `gh`: tracking baselined comments while skipping bots and `@me`, inline comments following their review thread, deleted comments, conversation comments staying open after replies until you resolve them, reopening, drafts (partial updates, unknown items, unwatched PRs), the fix prompt's instructions, the Stop hook asking once for missing drafts (not for bot or resolved comments, not once drafts exist, not while `stop_hook_active`, and again only for the comments of a later delivery), and closed PRs dropping their human comments. Unit tests cover the `reviewThreads` GraphQL arguments and pagination, reading `stop_hook_active` from the hook payload, the comment states, the `sentinel comments` output, the `HUMAN` and `MERGE` columns in `sentinel list`, and completion for `comments` and `draft`. TUI tests drive the PR details: the counts in the table, the draft, copying the reply, opening the comment, marking it resolved, refusing to reopen a thread resolved on GitHub, and having no reply to copy. Not covered by automated tests: the `{"decision":"block"}` output of `sentinel hook idle` (tests go through the daemon API), and editing a reply in `$EDITOR`. The `reviewThreads` query was checked by hand against a real PR: its `databaseId`s match the REST comment ids.

TUI tests also cover the repos view: worktrees with their PR and ticket, opening them, the `/` filter, scrolling in a short terminal with the footer kept visible, `r` rescanning with the selection kept on the same worktree, the empty-roots message, and refusing to open while the daemon is offline.

The footer and `?` dialog are tested for: `? help` kept visible while the other hints are truncated with `…` in a narrow terminal; the dialog listing every shortcut, titled for the main view, settings, the repos view and a value being edited; its `/` filter, with keys like `q` typed as text and a PR filter underneath keeping its focus; other keys ignored while it's open; opening from a focused filter input or a value being edited without typing `?` into it; a pending unwatch cancelled by `?`; and `? help` staying next to a "Saved" message. The hint fitting and filtering functions have unit tests.

Checked against the real tools: the evaluator call and its output format, the Rex adapter (session and tab creation, pane labels, splits, tab overflow, typing into a pane), and Claude's `Stop`, `UserPromptSubmit` and `SessionEnd` hooks firing from `--settings` with `session_id` in the payload.

Jira tickets are covered with a fake Jira client and a fake `acli`: JQL building and quoting, the `acli` arguments, parsing its JSON (Atlassian Document Format descriptions with links, cards, mentions and lists), ticket URLs on the logged-in site, each mode's prompt, model and effort reaching the launch, one session per ticket, transition after start (skipped when already there or when `transitionTo` is blank), retry after a failed launch, a failed transition, a failed search, the move to review when the ticket's session hands off a PR (once, skipped for other sessions or a blank `reviewStatus`, retried after a failure), `maxConcurrent`, a paused session, summary updates, dismissing, the ticket session surviving session pruning and taking over the PR it hands off, `r` polling Jira, the CLI table and status line, and the Jira settings. A TUI test drives the tickets list and dismissing.

Checked against the real tools: `acli jira workitem search --json` and `acli jira auth status` output, and a full Jira run through the daemon and Rex: a labelled ticket was picked up, its Claude session started in `~/work` with the ticket prompt, and the ticket moved to In Progress.

Not verified yet:
- **Herdr:** the adapter is written from Herdr's help text; real JSON output hasn't been checked.
- **Codex hooks:** whether `-c hooks.*` overrides fire is unconfirmed. If they don't, Codex sessions rely on the busy timeout.
- **Resuming a real agent session from a PR comment** has not been done end to end.
- **TUI-started sessions:** `claude --session-id` with `--model`/`--effort` and `gh search prs` haven't been run end to end through the daemon.
- **`sentinel restart` and the TUI's `o`** are covered by unit tests only; restarting a real daemon and opening a real browser haven't been tried.

Known limits:
- **Jira:** the Jira timer only runs in a started daemon, so its scheduling (first poll after 5s, rescheduling when `jira.enabled` or the interval changes) isn't covered by tests. Tickets have no event history (`enter` does nothing on a ticket); look at `sentinel.log`. A ticket that leaves the query while it is still `queued` isn't started until it matches again. Deleting a ticket's row (with the daemon stopped) is the only way to have Sentinel pick it up a second time.
- **Repos view:** a watched PR is tied to a worktree by its session's directory, not by its branch, so a PR whose session works in the main checkout shows there even when its branch is checked out in another worktree. Worktree changes made while the view is open appear after `r`.
- The watched-PR table doesn't scroll; with more PRs than fit, the bottom ones are hidden (use `/` to filter).
- If a session's busy timeout expires after its agent exited without an `exit` signal (always the case for Codex, which has no `exit` hook), the pointer line is typed into a bare shell instead of the agent.
- Agent args that contain commas can't be edited in the TUI; edit `config.json` instead.
- Only the default `gh` account is used for each host.
- Edited comments, desktop notifications, webhooks, launch at login and Windows are not supported.
