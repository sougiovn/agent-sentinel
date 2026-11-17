import { describe, expect, test } from "bun:test";
import bashCompletion from "../src/cli/completion.bash" with { type: "text" };
import { COMMANDS, complete, type CompletionSource } from "../src/cli/completion.ts";

const source: CompletionSource = {
  watchedPrs: async () => ["github.com/acme/web#42", "ghe.corp.io/acme/api#7"],
  ticketKeys: async () => ["CP-1", "CP-2"],
};

describe("completion", () => {
  test("top-level commands", async () => {
    expect((await complete([""], source)).items).toEqual([...COMMANDS]);
    expect((await complete(["un"], source)).items).toEqual(["unwatch"]);
    expect((await complete(["--"], source)).items).toEqual(["--help"]);
  });

  test("command options", async () => {
    expect((await complete(["watch", "--"], source)).items).toEqual([
      "--agent",
      "--session",
      "--cwd",
      "--include-existing",
    ]);
    expect((await complete(["list", ""], source)).items).toEqual(["--json"]);
    expect((await complete(["status", "--j"], source)).items).toEqual(["--json"]);
    expect((await complete(["daemon", ""], source)).items).toEqual(["--quiet"]);
  });

  test("option values", async () => {
    expect((await complete(["watch", "--agent", ""], source)).items).toEqual(["claude", "codex"]);
    expect((await complete(["watch", "--agent", "cl"], source)).items).toEqual(["claude"]);
    expect(await complete(["watch", "--cwd", ""], source)).toEqual({ items: [], dirs: true });
  });

  test("subcommands", async () => {
    expect((await complete(["tickets", ""], source)).items).toEqual(["check", "dismiss", "--json"]);
    expect((await complete(["tickets", "d"], source)).items).toEqual(["dismiss"]);
    expect((await complete(["tickets", "check", "--j"], source)).items).toEqual([]);
    expect((await complete(["skill", ""], source)).items).toEqual(["show", "install"]);
    expect((await complete(["completion", ""], source)).items).toEqual(["bash"]);
  });

  test("watched PRs and ticket keys", async () => {
    expect((await complete(["unwatch", ""], source)).items).toEqual([
      "acme/web#42",
      "ghe.corp.io/acme/api#7",
    ]);
    expect((await complete(["unwatch", "acme"], source)).items).toEqual(["acme/web#42"]);
    expect((await complete(["unwatch", "acme/web#42", ""], source)).items).toEqual([]);
    expect((await complete(["check", ""], source)).items).toEqual(["acme/web#42", "ghe.corp.io/acme/api#7"]);
    expect((await complete(["comments", "acme"], source)).items).toEqual(["acme/web#42"]);
    expect((await complete(["draft", ""], source)).items).toEqual(["acme/web#42", "ghe.corp.io/acme/api#7"]);
    expect((await complete(["draft", "acme/web#42", ""], source)).items).toEqual([]);
    expect((await complete(["draft", "acme/web#42", "issue:1", "--"], source)).items).toEqual(["--summary", "--change", "--reply"]);
    expect((await complete(["comments", "--"], source)).items).toEqual(["--json"]);
    expect((await complete(["tickets", "dismiss", ""], source)).items).toEqual(["CP-1", "CP-2"]);
  });

  test("a failing source yields no dynamic candidates", async () => {
    const failing: CompletionSource = {
      watchedPrs: async () => {
        throw new Error("daemon down");
      },
      ticketKeys: async () => {
        throw new Error("daemon down");
      },
    };
    expect((await complete(["unwatch", ""], failing)).items).toEqual([]);
    expect((await complete(["tickets", "dismiss", ""], failing)).items).toEqual([]);
  });

  test("bash script wires the completion function", () => {
    expect(bashCompletion).toContain("sentinel __complete");
    expect(bashCompletion).toContain("complete -F _sentinel_complete sentinel");
  });
});
