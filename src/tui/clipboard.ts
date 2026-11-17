import { spawnSync } from "node:child_process";

const COMMANDS: string[][] = [["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];

/** Copies text with the first clipboard tool that works. Throws if none does. */
export function copyToClipboard(text: string): void {
  for (const [cmd, ...args] of COMMANDS) {
    const r = spawnSync(cmd!, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return;
  }
  throw new Error("no clipboard tool found (pbcopy, wl-copy, xclip or xsel)");
}
