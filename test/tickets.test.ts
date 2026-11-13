import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, saveConfig, type Config } from "../src/core/config.ts";
import { renderTicketPrompt } from "../src/evaluator/prompt.ts";
import { AcliJira, browseUrl, descriptionText, parseAuthSite, parseSearch, ticketJql } from "../src/jira/acli.ts";
import type { Exec } from "../src/core/exec.ts";
import { formatStatus, formatTickets } from "../src/cli/format.ts";
import { cycleEnum, displayValue, FIELDS, parseValue } from "../src/tui/settings.ts";
import { makeDaemon } from "./fakes.ts";

function withJira(patch: (c: Config) => void = () => {}) {
  const t = makeDaemon();
  const cfg = defaultConfig();
  cfg.jira.enabled = true;
  patch(cfg);
  saveConfig(t.paths.config, cfg);
  expect(t.daemon.reload().ok).toBe(true);
  return t;
}

function promptOf(line: string): string {
  return readFileSync(/\$\(cat '([^']+)'\)/.exec(line)![1]!, "utf8");
}

describe("jira helpers", () => {
  test("JQL filters on assignee, label and statuses, with quoting", () => {
    expect(ticketJql({ label: "sentinel", statuses: ["To Do", "In Progress"] })).toBe(
      'assignee = currentUser() AND labels = "sentinel" AND status IN ("To Do", "In Progress") ORDER BY created ASC',
    );
    expect(ticketJql({ label: 'a"b\\c', statuses: ["X"] })).toContain('labels = "a\\"b\\\\c"');
  });

  test("parses acli search JSON, with ADF descriptions", () => {
    const out = JSON.stringify([
      {
        key: "CP-1",
        self: "https://acme.atlassian.net/rest/api/3/issue/100",
        fields: {
          summary: "Add thing",
          status: { name: "To Do" },
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "First" }] },
              { type: "paragraph", content: [{ type: "text", text: "Second" }] },
            ],
          },
        },
      },
      { notAnIssue: true },
    ]);
    expect(parseSearch(out)).toEqual([
      { key: "CP-1", summary: "Add thing", status: "To Do", description: "First\nSecond", url: "https://acme.atlassian.net/browse/CP-1" },
    ]);
    expect(parseSearch(JSON.stringify({ issues: [{ key: "X-1", fields: { description: "plain" } }] }))[0]!.description).toBe("plain");
    expect(parseSearch("")).toEqual([]);
    expect(descriptionText(null)).toBe("");
    expect(browseUrl(undefined, "X-1")).toBe("X-1");
  });

  test("ticket URLs use the logged-in site, not the API host", () => {
    const out = JSON.stringify([{ key: "CP-70", self: "https://jira-prod-eu-77-1.prod.atl-paas.net/rest/api/3/issue/1", fields: {} }]);
    expect(parseSearch(out, "veeam-vdc.atlassian.net")[0]!.url).toBe("https://veeam-vdc.atlassian.net/browse/CP-70");
    expect(parseAuthSite("✓ Authenticated\n  Site: acme.atlassian.net\n  Email: x\n")).toBe("acme.atlassian.net");
    expect(parseAuthSite("✗ Error")).toBeNull();
  });

  test("descriptions keep links, cards, mentions and list items", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Uses " },
            { type: "inlineCard", attrs: { url: "https://module-federation.io/" } },
            { type: "text", text: " and " },
            { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://d.io" } }] },
            { type: "text", text: ", ask " },
            { type: "mention", attrs: { text: "@Ana" } },
          ],
        },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
      ],
    };
    expect(descriptionText(doc).trim()).toBe("Uses https://module-federation.io/ and docs (https://d.io), ask @Ana\n- one");
  });

  test("ticket prompt fills placeholders and the mode's instructions", () => {
    const base = { key: "CP-1", url: "u", summary: "S", description: "D", cwd: "/w" };
    const tpl = defaultConfig().jira.promptTemplate;
    const watch = renderTicketPrompt(tpl, { ...base, mode: "pr-watch" });
    expect(watch).toContain("CP-1: S");
    expect(watch).toContain("You are in /w");
    expect(watch).toContain("sentinel watch <pr-url>");
    expect(watch).toContain("ask the user");
    expect(watch).not.toContain("{{");
    expect(renderTicketPrompt(tpl, { ...base, mode: "pr" })).not.toContain("sentinel watch");
    expect(renderTicketPrompt(tpl, { ...base, mode: "plan" })).toContain("wait for the user to approve the plan");
  });

  test("jira is off by default", () => {
    const c = defaultConfig().jira;
    expect([c.enabled, c.label, c.mode, c.transitionTo, c.cwd]).toEqual([false, "sentinel", "pr-watch", "In Progress", "~/work"]);
    expect(c.statuses).toEqual(["To Do", "In Progress"]);
  });
});

describe("ticket polling", () => {
  test("disabled: never calls Jira", async () => {
    const t = makeDaemon();
    t.jira.add("CP-1");
    expect(await t.daemon.runTicketPoll()).toEqual([]);
    expect(t.jira.searches).toHaveLength(0);
  });

  test("a labelled ticket starts one new session in ~/work, then moves to In Progress", async () => {
    const t = withJira();
    t.jira.add("CP-1");
    expect(await t.daemon.runTicketPoll()).toEqual(["CP-1"]);
    expect(t.jira.searches[0]).toContain('labels = "sentinel"');

    const row = t.store.getTicket("CP-1")!;
    expect(row.last_status).toBe("started");
    expect(row.cwd).toBe(join(homedir(), "work"));
    const [line] = t.mux.allLines();
    expect(line).toStartWith(`cd '${join(homedir(), "work")}'`);
    expect(line).toContain(`--session-id '${row.session_id}'`);
    const prompt = promptOf(line!);
    expect(prompt).toContain("Do the CP-1 thing");
    expect(prompt).toContain("Never rename the Rex session");
    expect(t.jira.transitions).toEqual([{ key: "CP-1", status: "In Progress" }]);
    expect(t.store.getSession(row.session_id)!.state).toBe("busy");

    // Still matches the query (now In Progress), but never gets a second session.
    await t.daemon.runTicketPoll();
    expect(t.mux.allLines()).toHaveLength(1);
    expect(t.jira.transitions).toHaveLength(1);
  });

  test("already In Progress: no transition", async () => {
    const t = withJira();
    t.jira.add("CP-1", { status: "In Progress" });
    await t.daemon.runTicketPoll();
    expect(t.jira.transitions).toHaveLength(0);
    expect(t.store.getTicket("CP-1")!.last_status).toBe("started");
  });

  test("spawn failure doesn't transition, and the next poll retries", async () => {
    const t = withJira();
    t.jira.add("CP-1");
    t.mux.available = false;
    await t.daemon.runTicketPoll();
    expect(t.store.getTicket("CP-1")!.last_status).toBe("spawn_failed");
    expect(t.jira.transitions).toHaveLength(0);

    t.mux.available = true;
    await t.daemon.runTicketPoll();
    expect(t.store.getTicket("CP-1")!.last_status).toBe("started");
    expect(t.mux.allLines()).toHaveLength(1);
    expect(t.jira.transitions).toHaveLength(1);
  });

  test("transition failure keeps the agent running", async () => {
    const t = withJira();
    t.jira.add("CP-1");
    t.jira.failTransition = new Error("no such transition");
    await t.daemon.runTicketPoll();
    const row = t.store.getTicket("CP-1")!;
    expect(row.last_status).toBe("transition_failed");
    expect(row.last_reason).toContain("no such transition");
    expect(t.mux.allLines()).toHaveLength(1);
    await t.daemon.runTicketPoll();
    expect(t.mux.allLines()).toHaveLength(1);
  });

  test("blank transitionTo never writes to Jira", async () => {
    const t = withJira((c) => (c.jira.transitionTo = ""));
    t.jira.add("CP-1");
    await t.daemon.runTicketPoll();
    expect(t.jira.transitions).toHaveLength(0);
  });

  test("maxConcurrent keeps a ticket queued until a slot frees", async () => {
    const t = withJira((c) => (c.spawn.maxConcurrent = 1));
    t.jira.add("CP-1");
    t.jira.add("CP-2");
    await t.daemon.runTicketPoll();
    expect(t.store.getTicket("CP-1")!.last_status).toBe("started");
    expect(t.store.getTicket("CP-2")!.last_status).toBe("queued");

    await t.daemon.handle("signal", { sessionId: t.store.getTicket("CP-1")!.session_id, signal: "idle" });
    await t.daemon.runTicketPoll();
    expect(t.store.getTicket("CP-2")!.last_status).toBe("started");
  });

  test("search failure is reported in status", async () => {
    const t = withJira();
    t.jira.failSearch = new Error("unauthorized");
    await t.daemon.runTicketPoll();
    expect(t.daemon.status().jira.error).toBe("unauthorized");
    await expect(t.daemon.handle("pollTickets", {})).rejects.toThrow("unauthorized");
  });

  test("dismissed tickets are hidden and never picked up again", async () => {
    const t = withJira();
    t.mux.available = false;
    t.jira.add("CP-1");
    await t.daemon.runTicketPoll();
    expect((await t.daemon.handle("dismissTicket", { key: "cp-1" })).removed).toBe(true);
    expect(await t.daemon.handle("tickets", {})).toHaveLength(0);
    t.mux.available = true;
    await t.daemon.runTicketPoll();
    expect(t.mux.allLines()).toHaveLength(0);
  });

  test("the ticket session survives PR pruning and takes over the PR it hands off", async () => {
    const t = withJira();
    t.jira.add("CP-1");
    await t.daemon.runTicketPoll();
    const sid = t.store.getTicket("CP-1")!.session_id;

    // Another PR coming and going prunes sessions; the ticket's must stay.
    const { parsePrRef } = await import("../src/core/pr-ref.ts");
    const other = parsePrRef("acme/web#9");
    t.gh.add(other);
    await t.daemon.handle("watch", { prs: ["acme/web#9"], agent: "claude", sessionId: "x", cwd: "/r" });
    t.daemon.sentinel.unwatch("acme/web#9");
    expect(t.store.getSession(sid)).not.toBeNull();

    // `sentinel watch` from inside the ticket session (pr-watch mode).
    const ref = parsePrRef("acme/web#1");
    t.gh.add(ref);
    await t.daemon.handle("watch", { prs: ["acme/web#1"], agent: "claude", sessionId: sid, cwd: "/repo" });
    const s = t.store.getSession(sid)!;
    expect([s.cwd, s.started]).toEqual(["/repo", 1]);
    expect(t.store.getPr("github.com/acme/web#1")!.session_id).toBe(sid);
  });

  test("refresh also polls Jira", async () => {
    const t = withJira();
    t.jira.add("CP-1");
    const r = await t.daemon.handle("refresh", {});
    expect(r.tickets).toEqual(["CP-1"]);
  });
});

describe("AcliJira", () => {
  const issue = JSON.stringify([{ key: "CP-1", self: "https://internal.atl-paas.net/rest/api/3/issue/1", fields: { summary: "S" } }]);

  function fakeAcli(opts: { authOk?: boolean; searchCode?: number } = {}) {
    const calls: string[][] = [];
    const run: Exec = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("auth"))
        return opts.authOk === false
          ? { code: 1, stdout: "", stderr: "unauthorized" }
          : { code: 0, stdout: "✓ Authenticated\n  Site: acme.atlassian.net\n", stderr: "" };
      if (cmd.includes("search")) return { code: opts.searchCode ?? 0, stdout: issue, stderr: "boom" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, run };
  }

  test("search passes the JQL to acli and links tickets on the logged-in site, looked up once", async () => {
    const f = fakeAcli();
    const jira = new AcliJira(() => "my-acli", f.run);
    const [t] = await jira.search("labels = x");
    await jira.search("labels = x");
    expect(t!.url).toBe("https://acme.atlassian.net/browse/CP-1");
    expect(f.calls[1]).toEqual(["my-acli", "jira", "auth", "status"]);
    expect(f.calls[0]).toEqual(["my-acli", "jira", "workitem", "search", "--jql", "labels = x", "--fields", "key,summary,status,description", "--paginate", "--json"]);
    expect(f.calls.filter((c) => c.includes("auth"))).toHaveLength(1);
  });

  test("without a site, falls back to the API host; a failed search throws", async () => {
    const jira = new AcliJira(() => "acli", fakeAcli({ authOk: false }).run);
    expect((await jira.search("q"))[0]!.url).toBe("https://internal.atl-paas.net/browse/CP-1");
    await expect(new AcliJira(() => "acli", fakeAcli({ searchCode: 1 }).run).search("q")).rejects.toThrow("acli exited 1");
  });

  test("transition confirms without prompting", async () => {
    const f = fakeAcli();
    await new AcliJira(() => "acli", f.run).transition("CP-1", "In Progress");
    expect(f.calls[0]).toEqual(["acli", "jira", "workitem", "transition", "--key", "CP-1", "--status", "In Progress", "--yes"]);
  });
});

describe("ticket polling, more", () => {
  test("a paused session waits as queued, and starts once resumed", async () => {
    const t = withJira();
    t.jira.add("CP-1");
    t.mux.available = false;
    await t.daemon.runTicketPoll();
    const sid = t.store.getTicket("CP-1")!.session_id;
    await t.daemon.handle("pause", { sessionId: sid, paused: true });
    t.mux.available = true;
    await t.daemon.runTicketPoll();
    expect(t.store.getTicket("CP-1")!.last_status).toBe("queued");
    expect(t.store.getTicket("CP-1")!.last_reason).toBe("Session paused");
    expect(t.jira.transitions).toHaveLength(0);

    await t.daemon.handle("pause", { sessionId: sid, paused: false });
    await t.daemon.runTicketPoll();
    expect(t.store.getTicket("CP-1")!.last_status).toBe("started");
  });

  test("the summary follows edits to the ticket", async () => {
    const t = withJira();
    t.jira.add("CP-1", { summary: "Old" });
    await t.daemon.runTicketPoll();
    t.jira.tickets[0]!.summary = "New";
    await t.daemon.runTicketPoll();
    expect(t.store.getTicket("CP-1")!.summary).toBe("New");
  });

  test("model, effort and mode from config reach the launch and the prompt", async () => {
    const t = withJira((c) => {
      c.jira.model = "opus";
      c.jira.effort = "high";
      c.jira.mode = "plan";
    });
    t.jira.add("CP-1");
    await t.daemon.runTicketPoll();
    const [line] = t.mux.allLines();
    expect(line).toContain("'--model' 'opus' '--effort' 'high' -- \"$(cat");
    expect(promptOf(line!)).toContain("wait for the user to approve the plan");
  });

  test("pollTickets refuses while Jira is disabled", async () => {
    const t = makeDaemon();
    await expect(t.daemon.handle("pollTickets", {})).rejects.toThrow("disabled");
    expect(t.daemon.status().jira).toMatchObject({ enabled: false, tickets: 0, error: null });
  });
});

describe("ticket formatting and settings", () => {
  test("status and ticket table", async () => {
    const t = withJira();
    t.jira.add("CP-1", { summary: "Add audit log" });
    await t.daemon.runTicketPoll();
    expect(formatStatus(t.daemon.status())).toContain('jira: label "sentinel" · poll every 600s · 1 ticket(s) picked up');
    expect(formatStatus(makeDaemon().daemon.status())).toContain("jira: off");
    const table = formatTickets(await t.daemon.handle("tickets", {}));
    expect(table).toStartWith("TICKET");
    expect(table).toContain("CP-1    Add audit log");
    expect(formatTickets([])).toBe("No Jira tickets picked up.");
  });

  test("transitionTo can be cleared; mode cycles through the modes", () => {
    const cfg = defaultConfig();
    const tr = FIELDS.find((f) => f.key === "jira.transitionTo")!;
    tr.set(cfg, parseValue(tr, "  "));
    expect(cfg.jira.transitionTo).toBe("");
    expect(displayValue(tr, cfg)).toBe("(none)");
    expect(() => parseValue(FIELDS.find((f) => f.key === "jira.label")!, "")).toThrow("must not be empty");
    const mode = FIELDS.find((f) => f.key === "jira.mode")!;
    expect([cycleEnum(mode, cfg), (mode.set(cfg, "plan"), cycleEnum(mode, cfg))]).toEqual(["pr", "pr-watch"]);
  });
});
