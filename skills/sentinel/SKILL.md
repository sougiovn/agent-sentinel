---
name: sentinel
description: Hand off GitHub pull requests to Agent Sentinel so it watches them for new review comments and failing checks, and resumes this agent session to fix them. Use after opening or pushing a PR when you want follow-up review feedback handled automatically, or when the user says "watch this PR", "hand off to sentinel", "monitor my PRs", or asks what Sentinel is watching.
---

# Agent Sentinel

Sentinel is a background daemon that polls PRs, uses a cheap Claude model to decide whether new comments or failing checks need work, and then resumes **this** agent session in a terminal multiplexer pane (Rex or Herdr) with the details.

## Hand off PRs

Run from the repository directory the PR belongs to:

```sh
sentinel watch <pr> [<pr>...]
```

`<pr>` is a PR URL (`https://github.com/owner/repo/pull/123`) or `owner/repo#123`.

Sentinel detects who you are from your environment:

- Claude Code: `$CLAUDE_CODE_SESSION_ID` → agent `claude`
- Codex: `$CODEX_THREAD_ID` → agent `codex`
- Working directory: the current directory (the session is resumed there)

Override when needed: `--agent claude|codex`, `--session <id>`, `--cwd <dir>`.
Existing comments and checks are treated as already seen; pass `--include-existing` to evaluate them now.

If the daemon isn't running, `sentinel watch` starts it.

## Other commands

| Command | What it does |
| --- | --- |
| `sentinel list` | PRs being watched, their agent/session, last check and status |
| `sentinel unwatch <pr>` | Stop watching a PR |
| `sentinel check [<pr>]` | Poll now instead of waiting for the interval |
| `sentinel status` | Daemon status |
| `sentinel tui` | Interactive dashboard (for the user) |

## When Sentinel resumes you

You'll receive a prompt (or a one-line pointer to a prompt file under `~/.config/sentinel/prompts/`) listing the PR items that need work: comment author (`user.login`, `user.type`), body, file/line, or failing check with a log tail. Follow its instructions: fix, commit, push. Only reply to bot comments; never reply to or resolve human comments — tell the user what you changed and suggest a reply instead.

Merged or closed PRs are dropped automatically.
