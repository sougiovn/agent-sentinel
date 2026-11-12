import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaths } from "../src/core/paths.ts";
import type { PrRef } from "../src/core/pr-ref.ts";
import { prId } from "../src/core/pr-ref.ts";
import { Daemon } from "../src/daemon/daemon.ts";
import type { EvalInput } from "../src/evaluator/prompt.ts";
import type { Evaluator, Verdict } from "../src/evaluator/evaluator.ts";
import type { GhClient, GhComment, GhCheck, GhPrView, PrActivity } from "../src/github/gh.ts";
import { MuxUnavailableError, type CreatePaneOptions, type Multiplexer, type PaneRef } from "../src/mux/mux.ts";

export class FakeGh implements GhClient {
  prs = new Map<string, PrActivity>();
  login = "me";
  failNext = false;

  add(ref: PrRef, patch: Partial<GhPrView> = {}) {
    this.prs.set(prId(ref), {
      view: { state: "OPEN", title: "Test PR", body: "body", headRefOid: "sha1", statusCheckRollup: [], ...patch },
      inlineComments: [],
      conversationComments: [],
      reviews: [],
    });
  }
  get(ref: PrRef): PrActivity {
    const a = this.prs.get(prId(ref));
    if (!a) throw new Error(`no such PR ${prId(ref)}`);
    return a;
  }
  comment(ref: PrRef, c: Partial<GhComment> & { id: number }, kind: "inline" | "issue" = "issue") {
    const full: GhComment = { user: { login: "reviewer", type: "User" }, body: "please fix", ...c };
    (kind === "inline" ? this.get(ref).inlineComments : this.get(ref).conversationComments).push(full);
  }
  check(ref: PrRef, c: Partial<GhCheck>) {
    this.get(ref).view.statusCheckRollup!.push({ __typename: "CheckRun", status: "COMPLETED", ...c } as GhCheck);
  }
  async fetchActivity(ref: PrRef) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("gh boom");
    }
    return structuredClone(this.get(ref));
  }
  async prState(ref: PrRef) {
    return this.get(ref).view.state;
  }
  async viewerLogin() {
    return this.login;
  }
  async failedLog() {
    return "line1\nline2\nError: test failed";
  }
}

export class FakeEvaluator implements Evaluator {
  calls: EvalInput[] = [];
  next: Verdict | Error | ((i: EvalInput) => Verdict) = (i) => ({
    shouldFix: true,
    reason: "needs fix",
    items: i.items.map((x) => x.id),
  });
  async evaluate(input: EvalInput) {
    this.calls.push(structuredClone(input));
    const n = this.next;
    if (n instanceof Error) throw n;
    return typeof n === "function" ? n(input) : n;
  }
}

export class FakeMux implements Multiplexer {
  readonly name = "rex" as const;
  available = true;
  panes = new Map<string, { tab: string; lines: string[]; opts: CreatePaneOptions }>();
  private n = 0;

  async ensureAvailable() {
    if (!this.available) throw new MuxUnavailableError("rex down");
  }
  async paneExists(id: string) {
    return this.panes.has(id);
  }
  async createPane(opts: CreatePaneOptions): Promise<PaneRef> {
    const id = `block:${++this.n}`;
    this.panes.set(id, { tab: "window:1", lines: [], opts });
    return { paneId: id, tabId: "window:1" };
  }
  async sendLine(id: string, text: string) {
    this.panes.get(id)!.lines.push(text);
  }
  allLines() {
    return [...this.panes.values()].flatMap((p) => p.lines);
  }
}

export function makeDaemon(opts: { now?: () => number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sentinel-test-"));
  const paths = getPaths(home);
  const gh = new FakeGh();
  const evaluator = new FakeEvaluator();
  const mux = new FakeMux();
  const daemon = new Daemon(paths, { gh, evaluator, muxFactory: () => mux, noTimer: true, quiet: true, now: opts.now });
  return { daemon, gh, evaluator, mux, paths, store: daemon.store };
}
