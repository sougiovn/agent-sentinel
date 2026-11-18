import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { defaultConfig, saveConfig, type Config } from "../src/core/config.ts";
import { lastFireToday, matches, nextFire, parseCron } from "../src/routines/cron.ts";
import { parseRoutine, scanRoutines } from "../src/routines/routine.ts";
import { formatRoutines } from "../src/cli/format.ts";
import { makeDaemon } from "./fakes.ts";

/** Local time on 2026-11-<day> (the 18th is a Wednesday). */
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

function routineMd(fm: Record<string, string | boolean>, body = "Summarise my open PRs.") {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

function withRoutines(patch: (c: Config) => void = () => {}) {
  let now = at(18, 7);
  const t = makeDaemon({ now: () => now });
  const cfg = defaultConfig();
  patch(cfg);
  saveConfig(t.paths.config, cfg);
  expect(t.daemon.reload().ok).toBe(true);
  const write = (id: string, fm: Record<string, string | boolean>, body?: string) => {
    mkdirSync(join(t.paths.routinesDir, id), { recursive: true });
    writeFileSync(join(t.paths.routinesDir, id, "ROUTINE.md"), routineMd({ name: id, ...fm }, body));
  };
  return {
    ...t,
    write,
    setNow: (n: number) => (now = n),
    tick: () => t.daemon.runRoutineTick(),
    runs: (id: string) => t.store.routineRuns(id),
    row: (id: string) => t.store.getRoutine(id)!,
    /** The agent reports in, then finishes. */
    finish: async (sessionId: string) => {
      await t.daemon.handle("signal", { sessionId, signal: "busy" });
      await t.daemon.handle("signal", { sessionId, signal: "idle" });
    },
  };
}

function promptOf(line: string): string {
  return readFileSync(/\$\(cat '([^']+)'\)/.exec(line)![1]!, "utf8");
}

describe("cron", () => {
  test("parses values, ranges, steps, lists and names", () => {
    const c = parseCron("*/15 8-10,14 * jan,Mar mon-fri");
    expect(c.minutes).toEqual([0, 15, 30, 45]);
    expect(c.hours).toEqual([8, 9, 10, 14]);
    expect([...c.months]).toEqual([1, 3]);
    expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
    expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]);
    expect(parseCron("@daily").minutes).toEqual([0]);
  });

  test("rejects bad expressions with a reason", () => {
    expect(() => parseCron("0 8 * *")).toThrow("expected 5 fields");
    expect(() => parseCron("60 * * * *")).toThrow("minute: 60 is outside 0-59");
    expect(() => parseCron("0 8 * * funday")).toThrow('day of week: "funday" is not a number');
    expect(() => parseCron("*/0 * * * *")).toThrow("step");
    expect(() => parseCron("0 10-8 * * *")).toThrow("backwards");
    expect(() => parseCron("@sometimes")).toThrow("unknown macro");
  });

  test("day of month and day of week combine with OR when both are set", () => {
    const c = parseCron("0 8 1 * fri");
    expect(matches(c, new Date(2026, 10, 1, 8))).toBe(true); // a Sunday, but the 1st
    expect(matches(c, new Date(2026, 10, 20, 8))).toBe(true); // a Friday
    expect(matches(c, new Date(2026, 10, 19, 8))).toBe(false);
    expect(matches(parseCron("0 8 * * fri"), new Date(2026, 10, 1, 8))).toBe(false);
  });

  test("lastFireToday only looks at today", () => {
    const c = parseCron("0 8,17 * * *");
    expect(lastFireToday(c, at(18, 7, 59))).toBeNull();
    expect(lastFireToday(c, at(18, 8))).toBe(at(18, 8));
    expect(lastFireToday(c, at(18, 16))).toBe(at(18, 8));
    expect(lastFireToday(c, at(18, 23))).toBe(at(18, 17));
    // Thursday-only: nothing on Wednesday, however late.
    expect(lastFireToday(parseCron("0 10 * * thu"), at(18, 23))).toBeNull();
  });

  test("nextFire finds the next time, or null when there is none", () => {
    expect(nextFire(parseCron("0 8 * * *"), at(18, 8))).toBe(at(19, 8));
    expect(nextFire(parseCron("30 9 * * mon"), at(18, 12))).toBe(at(23, 9, 30));
    expect(nextFire(parseCron("0 0 29 2 *"), at(18, 0))).toBe(new Date(2028, 1, 29).getTime());
    expect(nextFire(parseCron("0 0 31 2 *"), at(18, 0))).toBeNull();
  });
});

describe("routine files", () => {
  test("ROUTINE.md frontmatter, defaults and body", () => {
    const def = parseRoutine("digest", "/r/digest", routineMd({ name: "Digest", schedule: "0 8 * * *", model: "sonnet", cwd: "sub" }, "Do it."));
    expect(def).toMatchObject({ id: "digest", name: "Digest", description: "", model: "sonnet", effort: null, enabled: true, cwd: "/r/digest/sub", body: "Do it." });
    expect(parseRoutine("d", "/r/d", routineMd({ name: "D", schedule: "@hourly" })).cwd).toBe("/r/d");
    expect(parseRoutine("d", "/r/d", routineMd({ name: "D", schedule: "@hourly", cwd: "/abs" })).cwd).toBe("/abs");
  });

  test("each problem is reported per directory", () => {
    const root = mkdtempSync(join(tmpdir(), "routines-"));
    const put = (dir: string, text?: string) => {
      mkdirSync(join(root, dir), { recursive: true });
      if (text !== undefined) writeFileSync(join(root, dir, "ROUTINE.md"), text);
    };
    put("good", routineMd({ name: "Good", schedule: "0 8 * * *" }));
    put("Bad_Name", routineMd({ name: "X", schedule: "0 8 * * *" }));
    put("empty");
    put("no-frontmatter", "just text");
    put("bad-cron", routineMd({ name: "X", schedule: "0 25 * * *" }));
    put("no-name", routineMd({ schedule: "0 8 * * *" }));
    put(".hidden", "ignored");
    writeFileSync(join(root, "stray.md"), "not a directory");
    const scans = scanRoutines(root);
    const byId = Object.fromEntries(scans.map((s) => [s.ok ? s.def.id : s.id, s.ok ? "ok" : s.error]));
    expect(Object.keys(byId).sort()).toEqual(["Bad_Name", "bad-cron", "empty", "good", "no-frontmatter", "no-name"]);
    expect(byId.good).toBe("ok");
    expect(byId.Bad_Name).toContain("lower kebab-case");
    expect(byId.empty).toContain("no ROUTINE.md");
    expect(byId["no-frontmatter"]).toContain("frontmatter");
    expect(byId["bad-cron"]).toContain("hour: 25 is outside 0-23");
    expect(byId["no-name"]).toContain("name");
  });
});

describe("routine scheduling", () => {
  test("runs on time, once, in a new Claude session started in the routine's directory", async () => {
    const t = withRoutines();
    t.write("digest", { schedule: "0 8 * * *", description: "PRs waiting on me", model: "sonnet" }, "List my PRs.");
    await t.tick();
    expect(t.runs("digest")).toHaveLength(0);

    t.setNow(at(18, 8, 0) + 20_000);
    expect(await t.tick()).toEqual(["digest"]);
    const row = t.row("digest");
    expect(row.last_status).toBe("started");
    expect(row.last_slot_run).toBe(at(18, 8));
    const [line] = t.mux.allLines();
    expect(line).toStartWith(`cd '${join(t.paths.routinesDir, "digest")}'`);
    expect(line).toContain(`--session-id '${row.session_id}'`);
    expect(line).toContain("'--model' 'sonnet'");
    const prompt = promptOf(line!);
    expect(prompt).toContain('run the routine "digest" (digest)');
    expect(prompt).toContain("This is the run for 2026-11-18 08:00");
    expect(prompt).toContain("PRs waiting on me");
    expect(prompt).toContain("List my PRs.");
    expect([...t.mux.panes.values()][0]!.opts.label).toBe("digest");
    expect(t.notifications.map((n) => n.title)).toContain("Routine started: digest");

    await t.tick();
    expect(t.mux.allLines()).toHaveLength(1);

    await t.finish(row.session_id!);
    expect(t.runs("digest")[0]!.status).toBe("finished");
    expect(t.row("digest").last_status).toBe("finished");
  });

  test("a time missed while the daemon was down runs later the same day, once", async () => {
    const t = withRoutines();
    t.write("digest", { schedule: "0 8 * * *" });
    await t.tick(); // seen on the 18th at 07:00

    t.setNow(at(19, 9, 12)); // computer turned on at 09:12 the next day
    expect(await t.tick()).toEqual(["digest"]);
    expect(t.runs("digest")[0]!.slot).toBe(at(19, 8));
    await t.tick();
    expect(t.runs("digest")).toHaveLength(1);
  });

  test("times from earlier days are never run (a week off)", async () => {
    const t = withRoutines();
    t.write("weekly", { schedule: "0 10 * * thu,fri" });
    await t.tick(); // Wednesday the 18th
    t.setNow(at(23, 9)); // back on Monday the 23rd
    expect(await t.tick()).toEqual([]);
    t.setNow(at(23, 18));
    expect(await t.tick()).toEqual([]);
    expect(t.runs("weekly")).toHaveLength(0);
  });

  test("many missed times run once, for the latest", async () => {
    const t = withRoutines();
    t.write("hourly", { schedule: "0 * * * *" });
    await t.tick();
    t.setNow(at(19, 13, 30));
    await t.tick();
    expect(t.runs("hourly").map((r) => r.slot)).toEqual([at(19, 13)]);
  });

  test("a routine added after today's time waits for the next one; a manual run starts it now", async () => {
    const t = withRoutines();
    t.setNow(at(18, 9));
    t.write("digest", { schedule: "0 8 * * *" });
    expect(await t.tick()).toEqual([]);

    const out = await t.daemon.handle("runRoutine", { id: "digest" });
    expect(out.result).toBe("delivered");
    expect(promptOf(t.mux.allLines()[0]!)).toContain("a manual run requested at 2026-11-18 09:00");
    const run = t.runs("digest")[0]!;
    expect(run.manual).toBe(1);
    // A manual run leaves the schedule alone.
    expect(t.row("digest").last_slot_run).toBeNull();

    // Manual runs are refused while the previous run is going.
    await expect(t.daemon.handle("runRoutine", { id: "digest" })).rejects.toThrow("still running");
    await expect(t.daemon.handle("runRoutine", { id: "nope" })).rejects.toThrow('No routine "nope"');

    await t.finish(run.session_id!);
    t.setNow(at(19, 8));
    expect(await t.tick()).toEqual(["digest"]);
  });

  test("overlap skip (default): a time that comes up while the previous run is busy is skipped", async () => {
    const t = withRoutines();
    t.write("often", { schedule: "0,30 8 * * *" });
    await t.tick();
    t.setNow(at(18, 8));
    await t.tick();
    t.setNow(at(18, 8, 30));
    expect(await t.tick()).toEqual([]);
    const [skipped] = t.runs("often");
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.session_id).toBeNull();
    expect(t.row("often").last_status).toBe("skipped");
    expect(t.notifications.map((n) => n.event)).toContain("routineSkipped");
    expect(t.mux.allLines()).toHaveLength(1);
  });

  test("overlap queue: the time waits for the previous run, same day only", async () => {
    const t = withRoutines((c) => (c.routines.overlap = "queue"));
    t.write("often", { schedule: "0,30 8 * * *" });
    await t.tick();
    t.setNow(at(18, 8));
    await t.tick();
    const first = t.row("often").session_id!;
    t.setNow(at(18, 8, 30));
    await t.tick();
    expect(t.row("often")).toMatchObject({ last_status: "queued", pending_slot: at(18, 8, 30) });

    await t.finish(first);
    t.setNow(at(18, 8, 45));
    expect(await t.tick()).toEqual(["often"]);
    expect(t.runs("often")[0]!.slot).toBe(at(18, 8, 30));
    expect(t.row("often").session_id).not.toBe(first);

    // Still busy at midnight: the queued time is dropped as missed.
    t.setNow(at(19, 8));
    await t.tick(); // 08:00 of the 19th: queued behind the 08:30 run, which is still busy
    expect(t.row("often").pending_slot).toBe(at(19, 8));
    t.setNow(at(20, 7));
    await t.tick();
    expect(t.runs("often")[0]).toMatchObject({ status: "missed", slot: at(19, 8) });
    expect(t.row("often").pending_slot).toBeNull();
  });

  test("session reuse: every run resumes the routine's one session", async () => {
    const t = withRoutines((c) => (c.routines.session = "reuse"));
    t.write("digest", { schedule: "0 8 * * *" });
    await t.tick();
    t.setNow(at(18, 8));
    await t.tick();
    const sid = t.row("digest").session_id!;
    await t.finish(sid);
    t.setNow(at(19, 8));
    await t.tick();
    expect(t.row("digest").session_id).toBe(sid);
    const lines = t.mux.allLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith("Sentinel has a routine to run for you.");
  });

  test("a failed launch is retried after a pause, the same day", async () => {
    const t = withRoutines();
    t.write("digest", { schedule: "0 8 * * *" });
    await t.tick();
    t.mux.available = false;
    t.setNow(at(18, 8));
    await t.tick();
    expect(t.row("digest").last_status).toBe("spawn_failed");
    expect(t.runs("digest")[0]!.status).toBe("spawn_failed");
    expect(t.notifications.map((n) => n.event)).toContain("routineFailed");

    t.mux.available = true;
    t.setNow(at(18, 8, 2));
    expect(await t.tick()).toEqual([]);
    t.setNow(at(18, 8, 6));
    expect(await t.tick()).toEqual(["digest"]);
    expect(t.runs("digest").map((r) => r.status)).toEqual(["started", "spawn_failed"]);
  });

  test("disabled routines let their times pass; routines.enabled=false stops the scheduler", async () => {
    const t = withRoutines();
    t.write("digest", { schedule: "0 8 * * *", enabled: false });
    await t.tick();
    t.setNow(at(18, 9));
    await t.tick();
    t.write("digest", { schedule: "0 8 * * *", enabled: true });
    expect(await t.tick()).toEqual([]);

    const cfg = defaultConfig();
    cfg.routines.enabled = false;
    saveConfig(t.paths.config, cfg);
    t.daemon.reload();
    t.setNow(at(19, 9));
    expect(await t.tick()).toEqual([]);
  });

  test("invalid and removed routines", async () => {
    const t = withRoutines();
    t.write("digest", { schedule: "0 8 * * *" });
    mkdirSync(join(t.paths.routinesDir, "Not_Kebab"));
    await t.tick();
    let list = await t.daemon.handle("routines", {});
    expect(list.map((r) => [r.id, r.valid])).toEqual([
      ["Not_Kebab", false],
      ["digest", true],
    ]);
    expect(list[1]!.nextRunAt).toBe(at(18, 8));
    expect(t.notifications.filter((n) => n.event === "routineInvalid")).toHaveLength(1);
    await t.tick();
    expect(t.notifications.filter((n) => n.event === "routineInvalid")).toHaveLength(1); // reported once

    const st = t.daemon.status().routines!;
    expect(st).toMatchObject({ enabled: true, total: 2, invalid: 1, nextRunAt: at(18, 8) });
    expect(formatRoutines(list)).toContain("invalid");

    rmSync(join(t.paths.routinesDir, "digest"), { recursive: true });
    await t.tick();
    expect(t.store.getRoutine("digest")).toBeNull();
    list = await t.daemon.handle("routines", {});
    expect(list.map((r) => r.id)).toEqual(["Not_Kebab"]);
  });

  test("an agent that never starts marks the run start_failed", async () => {
    const t = withRoutines();
    t.write("digest", { schedule: "0 8 * * *" });
    await t.tick();
    t.setNow(at(18, 8));
    await t.tick();
    t.setNow(at(18, 8, 6));
    await t.daemon.sentinel.tick();
    expect(t.runs("digest")[0]!.status).toBe("start_failed");
    expect(t.row("digest").last_status).toBe("start_failed");
  });
});
