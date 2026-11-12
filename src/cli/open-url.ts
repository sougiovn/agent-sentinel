import { spawn } from "node:child_process";

/** Opens a URL in the default browser without waiting for it. */
export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // reported by the caller's fallback message, not as a crash
  child.unref();
}
