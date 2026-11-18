// Tests never read the user's real Claude Code state. This one trusts every directory, so the TUI's
// first-run "trust the prompts folder" alert stays out of tests that aren't about it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
writeFileSync(join(dir, ".claude.json"), JSON.stringify({ projects: { "/": { hasTrustDialogAccepted: true } } }));
process.env.CLAUDE_CONFIG_DIR = dir;
