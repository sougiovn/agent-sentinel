# Agent Sentinel

A background daemon that watches GitHub PRs handed off by AI agent sessions (Claude Code, Codex), or picked from its dashboard. It polls for new review comments, failing checks and merge conflicts with the base branch, asks a cheap Claude model whether the comments and checks need work, and resumes the agent session in your multiplexer ([Rex](https://www.superlogical.com/rex/docs/automate/cli) or [Herdr](https://herdr.dev/)) to fix them. For PRs picked in the dashboard, Sentinel starts a new Claude session. It can also watch Jira: label a ticket assigned to you, and Sentinel starts a Claude session that works the ticket.

See [docs/features.md](docs/features.md) for a full description of what's implemented and how each part behaves.

## Install

```sh
mise trust && mise install   # bun and gh, pinned in mise.toml
bun install
bun run build            # → dist/sentinel (single binary)
ln -s "$PWD/dist/sentinel" ~/.local/bin/sentinel
sentinel skill install   # teaches Claude Code / Codex how to hand off PRs
```

Jira tickets also need the [Atlassian CLI](https://developer.atlassian.com/cloud/acli/) (`acli jira auth login`). Requires `gh` (authenticated), `claude`, and `rex` or `herdr` on `PATH`. `mise` installs `bun` and `gh`; install `claude`, `codex`, Rex and Herdr with their own installers. Herdr's server must already be running; Sentinel doesn't start it.

If you run Claude Code with its sandbox on, add `~/.config/sentinel/sentinel.sock` to `sandbox.network.allowUnixSockets` in `~/.claude/settings.json`, or `sentinel watch` from your own sessions can't reach the daemon. Sessions Sentinel launches get this allowance automatically.

Sentinel starts Claude with `--add-dir ~/.config/sentinel/prompts`. Until Claude Code trusts that folder, every session Sentinel starts stops at a trust question and waits. The first time you open the dashboard, it offers to fix this: press `y` and it opens Claude in that folder, where you answer yes once and quit with `/exit`. If you skip it, it's under Settings › General › Setup.

## Usage

```sh
sentinel                     # open the dashboard (starts the daemon if needed)
sentinel start               # start the daemon in the background, no dashboard
sentinel watch <pr>...       # from inside an agent session: hand off PRs
sentinel list | status | check [<pr>] | unwatch <pr> | reload | stop | restart
sentinel tickets [check | dismiss <key>]   # Jira tickets Sentinel picked up
sentinel routines [run <id> | check]       # scheduled routines
sentinel comments <pr>       # human comments on a PR and the agent's drafts
sentinel draft <pr> <item> --summary … --change … --reply …   # from inside an agent session
```

Or press `n` in the dashboard to watch one of your open PRs without an agent session. Pick a PR, choose the model, effort and local clone, and Sentinel starts a new Claude session for it, either right away or when the first feedback arrives.

### Jira tickets

Set `jira.enabled` (in `config.json`, or Tickets › Jira › Pick up tickets in settings), then assign yourself a ticket in To Do or In Progress and add the label `sentinel` (`jira.label`). On the next Jira poll (every `jira.pollIntervalSec`, 600s by default) Sentinel starts a new Claude session in `~/work` with the ticket. The agent works out the repository from the ticket and asks you if it isn't sure. Sentinel then moves the ticket to In Progress. Each ticket gets one session, ever. `jira.mode` sets how far the agent goes:
- `pr-watch` (default): implement, open a PR, and hand it to Sentinel with `sentinel watch`. Sentinel then moves the ticket to In Review (`jira.reviewStatus`). When that PR is merged, the ticket moves to Done (`jira.mergedStatus`); when it's closed without merging, back to In Progress (`jira.closedStatus`). A ticket you move to a final status yourself (`jira.finalStatuses`, Done or CANCELED by default) is marked done on the next Jira poll, and its PR is no longer watched.
- `pr`: implement and open a PR.
- `plan`: write a plan and wait.

`jira.promptTemplate` is the instruction text it starts with. `sentinel tickets` lists the picked-up tickets.

### Routines

Scheduled tasks, run in a new Claude session while the daemon is up. Each routine is a directory, `~/.config/sentinel/routines/<id>/` (the id is the directory name, lower kebab-case), with a `ROUTINE.md` and any scripts or files it uses:

```md
---
name: Morning digest
description: PRs waiting on me
schedule: "0 8 * * 1-5"   # cron, local time
model: sonnet             # optional; also effort, cwd, enabled
---
List the PRs where my review is requested and summarise each one.
```

A time missed while the computer was off still runs later that day, once; times from earlier days are skipped. `sentinel routines` lists them, `sentinel routines run <id>` (or `t`, then `x`, in the dashboard) runs one now, and settings has a Routines tab. See [Routines](docs/features.md#routines).

`watch` detects the agent from `$CLAUDE_CODE_SESSION_ID` or `$CODEX_THREAD_ID`, and uses the current directory as the place to resume in. Override with `--agent`, `--session` and `--cwd`. Activity that already exists when a PR is registered counts as seen; pass `--include-existing` to evaluate it.

### Bash completion

```sh
# Install it for future shells (requires the bash-completion package)
mkdir -p ~/.local/share/bash-completion/completions
sentinel completion bash > ~/.local/share/bash-completion/completions/sentinel

# Or load it in the current shell only
source <(sentinel completion bash)
```

Completion covers commands, options, the PRs Sentinel is already watching (`watch`, `unwatch`, `check`) and Jira ticket keys (`tickets dismiss`).

### Notifications

The daemon sends macOS notifications when an agent hands off a PR, a Jira ticket is picked up, moved or finished, and when a poll finds a merge conflict, feedback for the agent or new human comments. Install `terminal-notifier` (`brew install terminal-notifier`) so clicking one opens its PR or ticket. Without it, Sentinel uses `osascript`, whose notifications appear only once Script Editor is allowed in System Settings → Notifications. Check with `sentinel notify test`. Each event can be turned off under `notifications` in the config.

### SwiftBar menu bar plugin

```sh
sentinel swiftbar install ~/swiftbar-plugins   # writes ~/swiftbar-plugins/sentinel.30s.sh
```

The path is SwiftBar's plugin folder (the file is named `sentinel.30s.sh`, so the menu refreshes every 30s) or a `.sh` file. The menu lists agent sessions by repo with their PRs and Jira tickets. Click a session to go to its agent in Rex or herdr, a PR or ticket to open it in the browser. It also has Refresh now (with the dashboard's 30s cooldown), Open dashboard and Edit settings (`$EDITOR` on `config.json`, then a reload), which open in a new tab of Sentinel's Rex session or herdr workspace. The plugin keeps the `PATH` of the shell you installed it from. Rerun the command after moving Sentinel or changing `PATH`.

### TUI keys

The main view lists every agent session grouped by repo, with its PRs and tickets under it. `↑/↓` select a session, PR or ticket · `/` filter · `enter` expand the session's details (evaluator spend, PRs, tickets and history) · `h` a PR's full history and human comments · `o` open the PR or ticket in the browser · `n` watch one of your PRs · `g` repos and worktrees · `c` check a PR now · `r` refresh all PRs now · `d` unwatch a PR or dismiss a ticket · `p` pause/resume the session's deliveries · `A` go to the agent (focus its pane, or reopen it in a new tab) · `s` settings · `R` reload config and theme · `S` retry starting the daemon · `?` list every shortcut for the current screen (`/` filters it) · `q` quit. The footer shows as many shortcuts as fit and always ends with `? help`; `?` works everywhere, even while typing in a filter. A manual refresh resets the poll countdown; it is refused while another poll is running and for 30 seconds after the previous one. The daemon keeps running after you quit the dashboard; stop it with `sentinel stop`, or run `sentinel restart` after upgrading Sentinel.
In the repos view (`g`): every git repo found two levels under `newWatch.repoRoots`, with all of its worktrees. Under each worktree are the watched PRs whose session works in it and the Jira tickets tied to it: the ticket's handed-off PR, a branch or directory name containing the ticket key (`CP-123-fix`, `feat/CP-123`), or else the ticket session's directory. `↑/↓` select a worktree, `/` filters by repo, branch, path, PR or ticket (every word must match), `o` opens its PR (or ticket), `r` rescans, `esc` goes back. See [docs/features.md](docs/features.md#repos-view) for the details.
In PR details: the PR's human comments that need you. Agents never answer human comments. Instead they record what each comment asks, what they changed and a proposed reply (`sentinel draft`). `↑/↓` select a comment, `y` copies the reply, `e` edits it in `$EDITOR`, `x` marks the comment resolved (or reopens it), `o` opens it on GitHub. Inline review comments close when their thread is resolved on GitHub. Conversation comments and review bodies stay open until you mark them resolved. See [docs/features.md](docs/features.md#human-comments).
Settings are split into tabs: General, Pull requests and Tickets (Jira is the only ticket source for now). In settings: `tab`/`shift+tab` switch tabs, `/` filters the current tab by name, `enter` edits a field, `←`/`→` pick an enum option (every option is shown), and `e` opens a prompt template in `$EDITOR`.
In the PR picker: type to filter by org, repo, `#number` or title, `↑/↓` to move, `enter` to pick. In the form: `←/→` or `space` changes a value (the selected choice shows `‹ ›`), `e` types a custom model or path, and `enter` on `[ Watch ]` starts the watch.

### Theme

The dashboard's colours live in `theme.json`, created with the defaults when the dashboard first runs. Every key is optional, so you only need the colours you want to change.

```jsonc
{
  "text": "#ecf0f1",              // default text, and statuses with no colour
  "textSecondary": "#bdc3c7",     // PR titles, reasons, event details
  "textMuted": "#7f8c8d",         // hints, labels, table headers, footer
  "accent": "#2ecc71",            // title and focused borders
  "info": "#3498db",              // repo headings, timestamps
  "success": "#2ecc71",           // success messages
  "warning": "#e67e22",           // warnings, like the daemon being offline
  "error": "#e74c3c",             // errors and invalid config
  "pending": "#f1c40f",           // work-in-progress messages
  "selectionBackground": "#2c3e50",
  "modalBackground": "#1e272e",
  "statuses": {                   // per-status colours, keyed by last_status
    "no_changes": "#7f8c8d", "no_action": "#95a5a6", "pending": "#7f8c8d",
    "fix_spawned": "#3498db", "fix_running": "#f1c40f", "spawn_failed": "#e74c3c",
    "error": "#e74c3c", "queued": "#3498db", "started": "#f1c40f",
    "in_review": "#2ecc71", "done": "#27ae60", "transition_failed": "#e67e22"
  }
}
```

Colours are `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, a CSS colour name or `transparent`. The dashboard watches the file and applies edits immediately. Invalid JSON or colours show a banner and keep the last good theme; delete the file to go back to the defaults.

## How it works

1. **Poll** (every `pollIntervalSec`, PRs one at a time). Sentinel reads `gh pr view` for state, title, body, checks and mergeability (whether the PR conflicts with its base branch), `gh api` for inline comments, conversation comments and reviews, and `gh api graphql` for whether each review thread is resolved. It keeps `user.login` and `user.type` for every author, and updates the list of human comments that are still open (see [Human comments](docs/features.md#human-comments)).
2. **Diff** against `seen_items` in SQLite. New comments and reviews count, except from `ignoredAuthors` (by default `@me`, the authenticated `gh` user). Checks count only with a conclusion listed in `failingConclusions`. A merge conflict counts once per head commit; GitHub's `UNKNOWN` (still computing) is ignored (see [Detecting new activity](docs/features.md#detecting-new-activity)).
3. **Evaluate** the whole batch in one `claude -p --model <evaluator.model>` call with a JSON schema and no tools, run from `~/.config/sentinel/eval`. Failed checks include the tail of `gh run view --log-failed`. Merge conflicts skip the evaluator and are always queued.
   - On success, every item in the batch is marked seen.
   - On error, nothing is marked seen and the next poll retries.
4. **Queue**: flagged items queue per **agent session**, one fix at a time per session. Sessions run in parallel, limited by `spawn.maxConcurrent` (0 = unlimited).
5. **Deliver** into a pane Sentinel owns. With the default `spawn.layout: "sentinel-tab"`, there is one session/workspace named `spawn.sessionName`, holding one pane per agent session, with up to `maxPanesPerTab` panes before another tab opens.
   - New pane, or the agent has exited: Sentinel waits for the new pane's shell prompt, then types `claude --resume <id> --settings <hooks> … -- "<prompt>"` (or `codex resume <id> …`) into the pane. A session started from the dashboard uses `--session-id <id>` on its first launch, plus its `--model`/`--effort`.
   - Agent still running and idle: Sentinel types a one-line pointer to the prompt file.
6. **Track state**: agent hooks call `sentinel hook idle|busy|exit`, which marks the session busy or idle. `spawn.busyTimeoutMin` frees a session if no idle signal arrives. If no signal at all arrives within `spawn.startTimeoutSec` of a delivery, the agent never started: the PR shows `spawn_failed`, its items are rolled back, and the next delivery uses a new pane. If the agent was given human comments and tries to stop without recording a draft for each one (`sentinel draft`), the `Stop` hook sends it back once to record them.
7. **Clean up**: closed or merged PRs are deleted from the database and no longer watched.

If the multiplexer can't be reached, the PR shows `spawn_failed` and its items are un-marked, so the next poll re-evaluates them together with any newer activity.

## Files (`~/.config/sentinel`, override with `SENTINEL_HOME`)

| File | Purpose |
| --- | --- |
| `config.json` | Settings. Watched by the daemon; invalid edits are logged and the last good config is kept. |
| `theme.json` | Dashboard colours. Watched by the TUI; invalid edits keep the last good theme. |
| `sentinel.db` | SQLite: `prs`, `seen_items`, `pending_items`, `sessions`, `events` (last 50 per PR), `tickets`, `human_comments` |
| `sentinel.sock`, `sentinel.pid`, `sentinel.log` | Daemon socket, pidfile and log |
| `prompts/` | Fix prompts delivered to agents (pruned after 7 days) |
| `hooks/claude-settings.json` | Settings passed to Claude sessions Sentinel launches: state hooks, and the daemon socket in the sandbox allowlist |
| `eval/` | Evaluator working directory |
| `setup.json` | First-run answers, such as a dismissed prompts-folder trust alert |

## Config

```jsonc
{
  "multiplexer": "rex",                 // or "herdr"
  "pollIntervalSec": 300,
  "evaluator": { "model": "sonnet", "maxBudgetUsd": 0, "failedLogLines": 150 },  // budget 0 = no cap
  "ignoredAuthors": ["@me"],
  "failingConclusions": ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"],
  "agents": {
    "claude": { "command": "claude", "args": [] },   // e.g. ["--permission-mode", "acceptEdits"]
    "codex":  { "command": "codex",  "args": [] }    // e.g. ["-s", "workspace-write", "-a", "on-request"]
  },
  "spawn": { "layout": "sentinel-tab", "maxPanesPerTab": 4, "maxConcurrent": 0, "busyTimeoutMin": 60, "startTimeoutSec": 300, "sessionName": "sentinel" },
  "fixPromptTemplate": "… {{prUrl}} … {{reason}} … {{items}} …",
  "newWatch": {                          // defaults for PRs picked in the dashboard (n)
    "onlyMine": true,                    // false = any open PR involving you
    "repoRoots": ["~/work"],             // scanned two levels deep for local clones
    "model": "default", "models": ["default", "opus", "sonnet", "haiku"],
    "effort": "default", "efforts": ["default", "low", "medium", "high", "xhigh", "max"],
    "startNow": true, "includeExisting": true
  },
  "introPromptTemplate": "… {{prUrl}} … {{title}} … {{repo}} … {{number}} … {{cwd}} …",
  "jira": {                              // start agents for labelled Jira tickets (via acli)
    "enabled": false, "command": "acli", "pollIntervalSec": 600,
    "label": "sentinel", "statuses": ["To Do", "In Progress"],   // + assignee = currentUser()
    "cwd": "~/work", "model": "default", "effort": "default",
    "mode": "pr-watch",                  // "pr-watch" | "pr" | "plan"
    "transitionTo": "In Progress",       // when the agent starts; "" = don't
    "reviewStatus": "In Review",         // when the ticket's session hands off its PR; "" = don't
    "mergedStatus": "Done",              // when that PR is merged; "" = don't
    "closedStatus": "In Progress",       // when that PR is closed without merging; "" = don't
    "finalStatuses": ["Done", "CANCELED"],  // a tracked ticket in one of these is marked done
    "promptTemplate": "… {{key}} … {{url}} … {{summary}} … {{description}} … {{cwd}} … {{modeInstructions}} …"
  }
}
```

## Development

```sh
bun test              # unit + flow tests with fake gh/evaluator/multiplexer
bun run typecheck
bun run dev -- tui    # run from source
```
