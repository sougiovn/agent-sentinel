# Agent Sentinel

A background daemon that watches GitHub PRs handed off by AI agent sessions (Claude Code, Codex). It polls for new review comments and failing checks, asks a cheap Claude model whether they need work, and resumes the original agent session in your multiplexer ([Rex](https://www.superlogical.com/rex/docs/automate/cli) or [Herdr](https://herdr.dev/)) to fix them.

See [docs/features.md](docs/features.md) for a full description of what's implemented and how each part behaves.

## Install

```sh
mise trust && mise install   # bun and gh, pinned in mise.toml
bun install
bun run build            # → dist/sentinel (single binary)
ln -s "$PWD/dist/sentinel" ~/.local/bin/sentinel
sentinel skill install   # teaches Claude Code / Codex how to hand off PRs
```

Requires `gh` (authenticated), `claude`, and `rex` or `herdr` on `PATH`. `mise` installs `bun` and `gh`; install `claude`, `codex`, Rex and Herdr with their own installers. Herdr's server must already be running; Sentinel doesn't start it.

## Usage

```sh
sentinel                     # start the daemon (no-op if running)
sentinel tui                 # dashboard
sentinel watch <pr>...       # from inside an agent session: hand off PRs
sentinel list | status | check [<pr>] | unwatch <pr> | reload | stop
```

`watch` detects the agent from `$CLAUDE_CODE_SESSION_ID` or `$CODEX_THREAD_ID`, and uses the current directory as the place to resume in. Override with `--agent`, `--session` and `--cwd`. Activity that already exists when a PR is registered counts as seen; pass `--include-existing` to evaluate it.

### TUI keys

`↑/↓` select · `enter` event history · `c` check now · `d` unwatch · `p` pause/resume the session's deliveries · `s` settings · `r` reload config · `S` start daemon · `q` quit.
In settings: `enter` edits a field or cycles an enum, and `e` opens the fix prompt template in `$EDITOR`.

## How it works

1. **Poll** (every `pollIntervalSec`, PRs one at a time). Sentinel reads `gh pr view` for state, title, body and checks, and `gh api` for inline comments, conversation comments and reviews. It keeps `user.login` and `user.type` for every author.
2. **Diff** against `seen_items` in SQLite. New comments and reviews count, except from `ignoredAuthors` (by default `@me`, the authenticated `gh` user). Checks count only with a conclusion listed in `failingConclusions`.
3. **Evaluate** the whole batch in one `claude -p --model <evaluator.model>` call with a JSON schema and no tools, run from `~/.config/sentinel/eval`. Failed checks include the tail of `gh run view --log-failed`.
   - On success, every item in the batch is marked seen.
   - On error, nothing is marked seen and the next poll retries.
4. **Queue**: flagged items queue per **agent session**, one fix at a time per session. Sessions run in parallel, limited by `spawn.maxConcurrent` (0 = unlimited).
5. **Deliver** into a pane Sentinel owns. With the default `spawn.layout: "sentinel-tab"`, there is one session/workspace named `spawn.sessionName`, holding one pane per agent session, with up to `maxPanesPerTab` panes before another tab opens.
   - New pane, or the agent has exited: Sentinel types `claude --resume <id> --settings <hooks> "<prompt>"` (or `codex resume <id> …`) into the pane.
   - Agent still running and idle: Sentinel types a one-line pointer to the prompt file.
6. **Track state**: agent hooks call `sentinel hook idle|busy|exit`, which marks the session busy or idle. `spawn.busyTimeoutMin` frees a session if no idle signal arrives.
7. **Clean up**: closed or merged PRs are deleted from the database and no longer watched.

If the multiplexer can't be reached, the PR shows `spawn_failed` and its items are un-marked, so the next poll re-evaluates them together with any newer activity.

## Files (`~/.config/sentinel`, override with `SENTINEL_HOME`)

| File | Purpose |
| --- | --- |
| `config.json` | Settings. Watched by the daemon; invalid edits are logged and the last good config is kept. |
| `sentinel.db` | SQLite: `prs`, `seen_items`, `pending_items`, `sessions`, `events` (last 50 per PR) |
| `sentinel.sock`, `sentinel.pid`, `sentinel.log` | Daemon socket, pidfile and log |
| `prompts/` | Fix prompts delivered to agents (pruned after 7 days) |
| `hooks/claude-settings.json` | Hook settings passed to resumed Claude sessions |
| `eval/` | Evaluator working directory |

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
  "spawn": { "layout": "sentinel-tab", "maxPanesPerTab": 4, "maxConcurrent": 0, "busyTimeoutMin": 60, "sessionName": "sentinel" },
  "fixPromptTemplate": "… {{prUrl}} … {{reason}} … {{items}} …"
}
```

## Development

```sh
bun test              # unit + flow tests with fake gh/evaluator/multiplexer
bun run typecheck
bun run dev -- tui    # run from source
```
