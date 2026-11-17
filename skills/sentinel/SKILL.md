---
name: sentinel
description: Hand off GitHub pull requests to Agent Sentinel so it watches them for new review comments, failing checks and merge conflicts, and resumes this agent session to fix them. Use after opening or pushing a PR when you want follow-up review feedback handled automatically, or when the user says "watch this PR", "hand off to sentinel", "monitor my PRs", or asks what Sentinel is watching.
---

# Agent Sentinel

Sentinel is a background daemon that polls PRs, uses a cheap Claude model to decide whether new comments or failing checks need work, and then resumes **this** agent session in a terminal multiplexer pane (Rex or Herdr) with the details. A merge conflict with the base branch always resumes the session, once per head commit: bring the base into the PR branch, resolve the conflicts, run the tests and push.

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
Existing comments and checks are treated as already seen; pass `--include-existing` to evaluate them now. An existing merge conflict is not: it's delivered on the first poll.

If the daemon isn't running, `sentinel watch` starts it.

## Other commands

| Command | What it does |
| --- | --- |
| `sentinel list` | PRs being watched, their agent/session, last check, open human comments, merge state and status |
| `sentinel unwatch <pr>` | Stop watching a PR |
| `sentinel check [<pr>]` | Poll now instead of waiting for the interval |
| `sentinel comments <pr>` | Human comments on the PR, whether they're resolved, and their drafts |
| `sentinel draft <pr> <item-id> --summary … --change … --reply …` | Record a draft for a human comment (see below) |
| `sentinel status` | Daemon status |
| `sentinel` | Interactive dashboard (for the user; don't run it from an agent) |
| `sentinel start` | Start the daemon in the background |

If Sentinel started you for a Jira ticket and the prompt says to hand off your PR, run `sentinel watch <pr-url>` from this same session once the PR is open.

## When Sentinel resumes you

You'll receive a prompt (or a one-line pointer to a prompt file under `~/.config/sentinel/prompts/`) listing the PR items that need work: comment author (`user.login`, `user.type`), body, file/line, or failing check with a log tail. Follow its instructions: fix, commit, push. Only reply to bot comments. Never reply to, react to or resolve human comments; the user answers them.

## Human comments: record a draft

For every human comment in the prompt (`(human)` after the author), once you've dealt with it, tell Sentinel what happened so the user can review it in the dashboard and post the reply themselves:

```sh
sentinel draft <pr> <item-id> \
  --summary "<what the comment asks>" \
  --change "<what you changed, with the commit, or why you changed nothing>" \
  --reply "<a reply the user can post as is>"
```

- `<item-id>` is the bracketed id from the prompt, like `inline:123`, `issue:456` or `review:789`.
- Write the reply as the user, addressed to the reviewer. Keep it short.
- Run it again to replace a draft. Bot comments don't need one.
- If you stop without recording drafts, Sentinel's Stop hook asks you once to record them.

Merged or closed PRs are dropped automatically.
