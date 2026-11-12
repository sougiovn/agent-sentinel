# Agent Sentinel features

This page describes what Sentinel does today and how each part behaves. The [README](../README.md) has install steps and a quick overview.

- [The flow end to end](#the-flow-end-to-end)
- [Handing off PRs](#handing-off-prs)
- [Polling](#polling)
- [Detecting new activity](#detecting-new-activity)
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

1. An agent runs `sentinel watch <pr>` from its working directory. Sentinel records the PR, the agent kind, the session ID and the directory, and treats everything already on the PR as seen.
2. Every poll interval, the daemon fetches each PR's comments, reviews and checks with `gh`.
3. Anything new is batched per PR and sent to one `claude -p` call, which decides whether the agent needs to act.
4. Flagged items go into a per-session queue. When the session is free, Sentinel opens (or reuses) a pane in its own multiplexer session and resumes the agent with a prompt describing the work.
5. Hooks in the resumed agent tell Sentinel when it's busy, idle or has exited, so the next batch is delivered only once the agent is done.
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
   - **Existing feedback:** act on comments and failing checks already on the PR (default `newWatch.includeExisting`: on), or baseline them like `sentinel watch` does.
3. **Start.** Sentinel generates a session UUID and registers the PR with it.
   - The first launch runs `claude --session-id <uuid> …` instead of `--resume`, so the hook signals match from the start. Later launches resume it.
   - With **Existing feedback** on, existing items are evaluated right away, and if any need work they become the first prompt.
   - With **Start session: now** and nothing to fix, Sentinel launches the session with `introPromptTemplate`, which tells the agent to check out the PR branch, read the change and wait. The PR's history records `session_started`.
   - With **on first feedback**, nothing launches until a later poll finds something to fix.

## Polling

- One global interval, `pollIntervalSec` (default 300, minimum 30). The first poll runs about 3 seconds after the daemon starts; each later one is scheduled after the previous pass finishes.
- PRs are checked one at a time. Polls, `sentinel check`, the TUI's check-now key and registrations all go through one serial queue, so they never overlap.
- After every pass, Sentinel tries to deliver anything still queued (for example, sessions whose busy timeout has expired).
- Per PR, Sentinel fetches (`src/github/gh.ts`):
  - `gh pr view --json state,title,body,headRefOid,statusCheckRollup`
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

- **Ignored authors:** comments and reviews from anyone in `ignoredAuthors` are skipped (case-insensitive). `@me` is resolved to the authenticated `gh` user for the PR's host, so the agent's own replies don't trigger another round.
- **Checks:** passing, skipped and in-progress checks are never items. A re-run produces a new details URL and therefore a new item; a commit status is keyed by head SHA, so each new commit can fail again.
- **Edits are ignored:** an edited comment keeps its ID, so it's never re-evaluated.
- **Failed-run logs:** for failed check runs that have an Actions run ID, Sentinel attaches the last `evaluator.failedLogLines` lines (default 150) of `gh run view <run> --log-failed`, for at most 5 checks per batch. Set `failedLogLines` to 0 to skip this.

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

### Panes

Sentinel runs agents only in a multiplexer session (Rex) or workspace (Herdr) that it owns, named `spawn.sessionName` (default `sentinel`). Each agent session gets one pane, labelled `<agent>:<first 8 chars of session ID>`, and the pane's ID is stored so it can be reused.

- `spawn.layout: "sentinel-tab"` (default): new panes go into an existing Sentinel tab that has fewer than `spawn.maxPanesPerTab` panes (default 4), alternating right and below splits. When every tab is full, Sentinel opens a new one.
- `spawn.layout: "tab-per-session"`: every new pane gets its own tab.
- Panes start as an interactive shell in the agent's directory, and Sentinel types commands into them. New panes and tabs don't take focus.
- If the stored pane no longer exists (closed by the user, or the Sentinel session was killed), Sentinel creates a new one, and recreates the session or workspace if needed.
- Changing `multiplexer` makes the next delivery open a new pane in the new multiplexer.

### What gets typed

- **New pane, or the agent has exited:** a launch command, e.g.

  ```sh
  cd '<cwd>' && 'claude' --resume '<session>' --settings '<hooks file>' \
    --add-dir '~/.config/sentinel/prompts' <claude args> "$(cat '<prompt file>')"
  ```

  A session created from the TUI uses `--session-id '<session>'` on its first launch. Its model and effort are added as `--model`/`--effort` (Codex: `-m`, `-c model_reasoning_effort=…`).

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
| `idle` | `Stop` | `Stop` | Session idle; queued items are delivered by typing the pointer line |
| `exit` | `SessionEnd` | none | Agent gone; the next delivery types the full launch command |

- Claude receives the hooks through `--settings ~/.config/sentinel/hooks/claude-settings.json`, which Sentinel writes before each launch.
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

When a poll finds a PR in `CLOSED` or `MERGED` state, Sentinel deletes the PR row and, through cascading deletes, its seen items, queued items and event history. The owning agent session is removed if it has no other PRs. The PR is no longer polled. Draft PRs keep being watched.

## The daemon

- `sentinel start` starts the daemon in the background as a detached `sentinel daemon --quiet` process, waits up to 5 seconds for it to answer, and prints its status. If it's already running, it just prints the status. `sentinel` (the dashboard) and `sentinel watch` start it the same way when it isn't running.
- The daemon is independent of the dashboard: quitting the TUI leaves it running.
- `sentinel daemon` runs it in the foreground and logs to stderr as well as `sentinel.log`. Startup failures are written to the log too.
- **Single instance:** a second daemon refuses to start while one is answering on the socket. A leftover socket file from a crashed daemon is removed on start.
- **API:** the CLI and TUI talk to the daemon over `~/.config/sentinel/sentinel.sock`, with JSON requests of the form `{ method, params }` (`src/daemon/protocol.ts`). Methods: `status`, `list`, `watch`, `unwatch`, `check`, `history`, `signal`, `pause`, `reload`, `stop`. The daemon is the only process that writes to SQLite.
- **Stopping:** `sentinel stop` asks the daemon to exit; if it doesn't answer, Sentinel sends `SIGTERM` to the PID in `sentinel.pid`. `SIGINT` and `SIGTERM` shut it down cleanly, removing the socket and pidfile.
- Prompt files older than 7 days are deleted after each poll.

## CLI reference

| Command | Description |
| --- | --- |
| `sentinel` | Open the dashboard, starting the daemon if it isn't running (`sentinel tui` is an alias) |
| `sentinel start` | Start the daemon in the background without the dashboard, and print its status |
| `sentinel watch <pr>...` | Hand off PRs (see [Handing off PRs](#handing-off-prs)) |
| `sentinel unwatch <pr>` | Stop watching a PR and delete its data |
| `sentinel list [--json]` | Table of watched PRs: ID, agent, session, last check, status, reason |
| `sentinel check [<pr>]` | Poll one PR, or all of them, now, then try to deliver queued fixes |
| `sentinel status [--json]` | PID, home directory, multiplexer, interval, time until next poll, number of PRs, config error |
| `sentinel reload` | Re-read `config.json` |
| `sentinel stop` | Stop the daemon |
| `sentinel skill show` | Print the agent skill |
| `sentinel skill install` | Install the skill to `~/.claude/skills/sentinel/` and `~/.codex/skills/sentinel/` |
| `sentinel daemon [--quiet]` | Run the daemon in the foreground |
| `sentinel hook idle\|busy\|exit` | Used by agent hooks; not meant to be run by hand |

`unwatch`, `list`, `check`, `status` and `reload` need a running daemon and fail with "Sentinel daemon is not running" otherwise. `sentinel`, `sentinel start` and `watch` start it when needed.

## TUI

`sentinel` (`src/tui/app.tsx`) opens the dashboard. If the daemon isn't running, the TUI starts it on launch, then refreshes from it every 2 seconds.

**Main view:**
- **Header:** multiplexer, poll interval and countdown to the next poll.
- **Table:** PR, agent, session (with ⏸ when paused), last checked, status (colour-coded) and reason.
- **Details panel:** the selected PR's URL, full session ID, directory, pane ID and agent state.

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Select a PR |
| `Enter` | Event history for the PR |
| `n` / `w` | Watch one of your PRs with a new Claude session (see [Watching a PR from the TUI](#watching-a-pr-from-the-tui-new-sessions)) |
| `c` | Check the selected PR now |
| `d`, then `y` | Unwatch the selected PR |
| `p` | Pause or resume deliveries to the PR's agent session |
| `s` | Settings |
| `r` | Reload config in the TUI and the daemon |
| `S` | Retry starting the daemon (when it's offline) |
| `q` / `Ctrl+C` | Quit |

- **Daemon offline:** while the daemon is starting, the TUI shows "Starting Sentinel daemon…". If it fails to start or stops later, the TUI shows the error and offers `S` to try again.
- **Config errors:** an invalid config file, or a daemon running on its last good config, is shown in a red banner.
- **History:** the last 50 events per PR, newest first: `registered`, `reassigned`, `session_started`, `new_items`, `evaluated` (with verdict, reason and cost), `fix_delivered` (pane, items, prompt file), `agent_idle`, `agent_exit`, `spawn_failed`, `error`.

**Settings:** every config field is listed with its current value.

| Key | Action |
| --- | --- |
| `Enter`/`Space` | Edit a text or number field inline; cycle an enum (`multiplexer`, `spawn.layout`) |
| `Enter` (while editing) | Save |
| `Esc` (while editing) | Cancel |
| `e` | Open the selected template (`fixPromptTemplate`, `introPromptTemplate`) in `$VISUAL` or `$EDITOR` (default `vi`) |
| `r` | Reload config |
| `Esc`/`q` | Back to the main view |

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
| `agents.claude.command` / `.args` | `"claude"` / `[]` | Extra arguments for resumed Claude sessions, e.g. `["--permission-mode", "acceptEdits"]` |
| `agents.codex.command` / `.args` | `"codex"` / `[]` | Extra arguments for resumed Codex sessions, e.g. `["-s", "workspace-write"]` |
| `spawn.layout` | `"sentinel-tab"` | Or `"tab-per-session"` |
| `spawn.maxPanesPerTab` | `4` | |
| `spawn.maxConcurrent` | `0` | 0 = unlimited |
| `spawn.busyTimeoutMin` | `60` | |
| `spawn.sessionName` | `"sentinel"` | Name of Sentinel's Rex session or Herdr workspace |
| `fixPromptTemplate` | built-in | Placeholders `{{prUrl}}`, `{{reason}}`, `{{items}}` |
| `introPromptTemplate` | built-in | First prompt for a TUI-started session with nothing to fix. Placeholders `{{prUrl}}`, `{{title}}`, `{{repo}}`, `{{number}}`, `{{cwd}}` |
| `newWatch.onlyMine` | `true` | PR picker lists only PRs you authored; `false` = any open PR involving you |
| `newWatch.repoRoots` | `["~/work"]` | Scanned two levels deep for local clones |
| `newWatch.model` / `.models` | `"default"` / `default, opus, sonnet, haiku` | Default and choices for the form; `default` omits `--model` |
| `newWatch.effort` / `.efforts` | `"default"` / `default, low, medium, high, xhigh, max` | Default and choices for the form; `default` omits `--effort` |
| `newWatch.startNow` | `true` | Form default for "Start session" |
| `newWatch.includeExisting` | `true` | Form default for "Existing feedback" |

**Reloading:**
- The daemon watches the file and reloads about 200 ms after a change, whether the change came from the TUI or another editor. `sentinel reload` and the TUI's `r` reload on demand.
- An invalid file (bad JSON or a value that fails validation) is logged, reported in `status` and the TUI, and the daemon keeps running on the last good config.
- A new poll interval takes effect immediately. Other settings apply from the next poll or delivery.

## Data on disk

Everything lives in `~/.config/sentinel/`, or in `$SENTINEL_HOME` if that's set.

| Path | Contents |
| --- | --- |
| `config.json` | Settings |
| `sentinel.db` | SQLite database (WAL mode) |
| `sentinel.sock` | Daemon socket |
| `sentinel.pid` | Daemon PID |
| `sentinel.log` | Daemon log |
| `prompts/` | Rendered fix prompts, kept 7 days |
| `hooks/claude-settings.json` | Hook settings passed to resumed Claude sessions |
| `eval/` | Working directory for evaluator calls |
| `fix-prompt-template.md` | Scratch file used when editing the template from the TUI |

Database tables (`src/core/db.ts`, versioned migrations in `meta.schema_version`):

| Table | Holds |
| --- | --- |
| `prs` | One row per watched PR: URL, agent, session, directory, registration time, last check time, status, reason |
| `seen_items` | Item IDs already handled, per PR |
| `pending_items` | Flagged items waiting for delivery, with the evaluator's reason |
| `sessions` | Per agent session: agent, directory, multiplexer, pane and tab IDs, busy or idle, paused, agent running, busy-since and last-signal timestamps |
| `events` | Per-PR history, trimmed to the newest 50 |

The database is open for inspection, for example `sqlite3 ~/.config/sentinel/sentinel.db 'select id, last_status from prs'`. Write to it only while the daemon is stopped.

## Agent skill

`skills/sentinel/SKILL.md` is built into the binary. It tells Claude Code and Codex agents when to hand off a PR, the `watch`, `unwatch`, `list`, `check` and `status` syntax, how their identity is detected, and what to expect when Sentinel resumes them. Install it with `sentinel skill install`, or print it with `sentinel skill show`.

## Verification status and known limits

Covered by `bun test`, with fake `gh`, evaluator and multiplexer: the poll → evaluate → queue → deliver flow, baseline and `--include-existing`, ignored authors, failing checks and log tails, retry after evaluator, GitHub and delivery failures, closed-PR cleanup, the per-session queue (busy, idle, exit, pause, busy timeout, recreating closed panes, batching across PRs, `maxConcurrent`), config parsing and reload, the API, launch command quoting, and a TUI render-and-save test.

Checked against the real tools: the evaluator call and its output format, the Rex adapter (session and tab creation, pane labels, splits, tab overflow, typing into a pane), and Claude's `Stop`, `UserPromptSubmit` and `SessionEnd` hooks firing from `--settings` with `session_id` in the payload.

Not verified yet:
- **Daemon:** it has not been run end to end, because the development sandbox blocks its socket.
- **Herdr:** the adapter is written from Herdr's help text; real JSON output hasn't been checked.
- **Codex hooks:** whether `-c hooks.*` overrides fire is unconfirmed. If they don't, Codex sessions rely on the busy timeout.
- **Resuming a real agent session from a PR comment** has not been done end to end.
- **TUI-started sessions:** `claude --session-id` with `--model`/`--effort` and `gh search prs` haven't been run end to end through the daemon.

Known limits:
- If a session's busy timeout expires after its agent exited without an `exit` signal (always the case for Codex, which has no `exit` hook), the pointer line is typed into a bare shell instead of the agent.
- Agent args that contain commas can't be edited in the TUI; edit `config.json` instead.
- Only the default `gh` account is used for each host.
- Edited comments, desktop notifications, webhooks, launch at login and Windows are not supported.
