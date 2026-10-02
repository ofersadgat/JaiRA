/**
 * The repository watcher (decision 0010 §2): a scripted forge, a manual clock, and an in-memory store.
 *
 * What is pinned is the latest-state rule — one event per merge request or branch per difference,
 * never a replay — the baseline (a first look emits nothing), the cadence, and a restart that catches
 * up with the latest state only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  NEW_BRANCH_SHA,
  signComment,
  type ForgeJob,
  type ForgePipeline,
  type PipelineDetail,
  type PipelineList,
  type PipelineQuery,
  type PipelineStatus,
  type EnabledEvent,
  type EventDelivery,
  type EventName,
  type ForgeBranch,
  type ForgeCommit,
  type ForgeNote,
  type ForgeProvider,
  type MergeRequestQuery,
  type MergeRequestSummary,
  type RemoteHandle,
  type RepoWatchCursor,
  type RepoWatchKind,
  type RepoWatchPort,
  type RepoWatchScope,
  type RepoWatchSeen,
} from "@jaira/shared";
import { ForgeError } from "../src/forge";
import { PIPELINES_GIVE_UP_MS, RepositoryWatcher, repoWatchKeyOf, type RepoWatchTarget } from "../src/repoWatch";
import type { WatchClock } from "../src/remoteWatch";

const T0 = Date.parse("2026-09-25T10:00:00Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

class ManualClock implements WatchClock {
  at = T0;
  private seq = 0;
  readonly timers = new Map<number, { due: number; run: () => void }>();
  now(): number {
    return this.at;
  }
  setTimeout(run: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { due: this.at + ms, run });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** The due times of the timers set, relative to now. */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.due - this.at).sort((a, b) => a - b);
  }
  async advance(ms: number): Promise<void> {
    const end = this.at + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.at = Math.max(this.at, next[1].due);
      next[1].run();
      await settle();
    }
    this.at = end;
    await settle();
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

class MemoryRepoWatch implements RepoWatchPort {
  readonly cursors = new Map<string, { cursor: RepoWatchCursor; error?: string }>();
  readonly rows = new Map<string, unknown>();
  private key = (scope: RepoWatchScope): string => JSON.stringify([scope.remote, scope.repository]);
  cursor(scope: RepoWatchScope): RepoWatchCursor | undefined {
    const held = this.cursors.get(this.key(scope));
    return held === undefined ? undefined : structuredClone(held.cursor);
  }
  setCursor(scope: RepoWatchScope, cursor: RepoWatchCursor, error?: string | null): void {
    const held = this.cursors.get(this.key(scope));
    const kept = error === undefined ? held?.error : (error ?? undefined);
    this.cursors.set(this.key(scope), { cursor: structuredClone(cursor), ...(kept !== undefined ? { error: kept } : {}) });
  }
  seen<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K, key: string): RepoWatchSeen[K] | undefined {
    const row = this.rows.get(JSON.stringify([this.key(scope), kind, key]));
    return row === undefined ? undefined : (structuredClone(row) as RepoWatchSeen[K]);
  }
  seenAll<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K): Map<string, RepoWatchSeen[K]> {
    const out = new Map<string, RepoWatchSeen[K]>();
    for (const [id, row] of this.rows) {
      const [s, k, key] = JSON.parse(id) as [string, string, string];
      if (s === this.key(scope) && k === kind) out.set(key, structuredClone(row) as RepoWatchSeen[K]);
    }
    return out;
  }
  see<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K, key: string, state: RepoWatchSeen[K]): void {
    this.rows.set(JSON.stringify([this.key(scope), kind, key]), structuredClone(state));
  }
  forget(scope: RepoWatchScope, kind: RepoWatchKind, key: string): void {
    this.rows.delete(JSON.stringify([this.key(scope), kind, key]));
  }
}

/** A forge whose state the test sets, and which records what it was asked. */
class ScriptedForge implements ForgeProvider {
  job(): never {
    throw new Error("not scripted");
  }
  artifact(): never {
    throw new Error("not scripted");
  }
  readonly kind = "github" as const;
  readonly host = "github.com";
  calls: string[] = [];
  mrs = new Map<number, MergeRequestSummary>();
  heads: ForgeBranch[] = [];
  notes = new Map<number, ForgeNote[]>();
  /** The pipelines of a commit, by sha; a failed pipeline's failed jobs, by its id. */
  runs = new Map<string, ForgePipeline[]>();
  failedJobs = new Map<number, ForgeJob[]>();
  commitsOf = new Map<string, ForgeCommit[]>();
  failWith?: Error;
  constructor(private readonly clock: ManualClock) {}

  /** Open, update or close a request "now" on the forge's clock. */
  request(number: number, patch: Partial<MergeRequestSummary>): void {
    const prev = this.mrs.get(number);
    this.mrs.set(number, {
      number,
      title: `Request ${number}`,
      state: "open",
      draft: false,
      author: "mara",
      sourceBranch: `feature/${number}`,
      targetBranch: "main",
      head: `h${number}-1`,
      url: `https://github.com/acme/app/pull/${number}`,
      ...prev,
      ...patch,
      updatedAt: iso(this.clock.now()),
    });
  }
  say(number: number, note: Omit<ForgeNote, "at" | "own"> & { own?: boolean }): void {
    this.notes.set(number, [...(this.notes.get(number) ?? []), { own: false, ...note, at: iso(this.clock.now()) }]);
    this.request(number, {});
  }
  push(name: string, head: string): void {
    this.heads = [...this.heads.filter((b) => b.name !== name), { name, head }];
  }

  private fail(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }
  async whoami() {
    return { login: "jaira-bot" };
  }
  async open(): Promise<RemoteHandle> {
    throw new Error("not scripted");
  }
  async probe(): Promise<never> {
    throw new Error("not scripted");
  }
  async read(): Promise<never> {
    throw new Error("not scripted");
  }
  async comment(): Promise<void> {}
  async reply(): Promise<void> {}
  async merge(): Promise<void> {}
  async close(): Promise<void> {}
  async listMergeRequests(_project: string, query: MergeRequestQuery = {}): Promise<MergeRequestSummary[]> {
    this.calls.push(`list ${query.state ?? "open"}${query.updatedSince !== undefined ? ` since ${query.updatedSince}` : ""}`);
    this.fail();
    return [...this.mrs.values()]
      .filter((m) => (query.state ?? "open") === "all" || m.state === (query.state ?? "open"))
      .filter((m) => query.updatedSince === undefined || m.updatedAt > query.updatedSince)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async mergeRequest(): Promise<never> {
    throw new Error("not scripted");
  }
  async pipelines(_project: string, query: PipelineQuery): Promise<PipelineList> {
    this.calls.push(`pipelines ${query.sha ?? query.ref ?? query.mergeRequest}`);
    this.fail();
    return { pipelines: this.runs.get(query.sha ?? "") ?? [], statuses: [] };
  }
  async pipeline(_project: string, id: number): Promise<PipelineDetail> {
    this.calls.push(`pipeline ${id}`);
    const found = [...this.runs.values()].flat().find((one) => one.id === id)!;
    return { ...found, jobs: this.failedJobs.get(id) ?? [], artifacts: [] };
  }
  async branches(): Promise<ForgeBranch[]> {
    this.calls.push("branches");
    this.fail();
    return [...this.heads];
  }
  async comments(handle: RemoteHandle, options: { since?: string } = {}): Promise<ForgeNote[]> {
    this.calls.push(`comments ${handle.number}`);
    return (this.notes.get(handle.number) ?? []).filter((n) => options.since === undefined || n.at > options.since);
  }
  async compare(_project: string, base: string | undefined, head: string): Promise<ForgeCommit[]> {
    this.calls.push(`compare ${base ?? "-"}..${head}`);
    return this.commitsOf.get(`${base ?? "-"}..${head}`) ?? [{ sha: head, message: `commit ${head}`, author: "mara" }];
  }
}

let clock: ManualClock;
let forge: ScriptedForge;
let store: MemoryRepoWatch;
let events: EventDelivery[];
let errors: string[];
let enabled: EnabledEvent[];

const target = (): RepoWatchTarget => ({
  project: "p1",
  remote: "origin",
  host: "github.com",
  repository: "acme/app",
  connection: "github",
  events: enabled,
  store,
  provider: () => forge,
});

const watcher = (targets: () => RepoWatchTarget[] = () => [target()]): RepositoryWatcher =>
  new RepositoryWatcher({ targets, clock, onEvent: (_project, event) => void events.push(event), onError: (_t, e) => void errors.push(e.message) });

const on = (...names: EventName[]): EnabledEvent[] => names.map((name) => ({ name }));
const names = (): string[] => events.map((e) => `${e.name}${"merge_request" in e.payload ? ` !${(e.payload as { merge_request: { number: number } }).merge_request.number}` : ""}${"branch" in e.payload ? ` ${(e.payload as { branch: string }).branch}` : ""}`);

beforeEach(() => {
  clock = new ManualClock();
  forge = new ScriptedForge(clock);
  store = new MemoryRepoWatch();
  events = [];
  errors = [];
  enabled = on("git.pushed", "merge_request.opened", "merge_request.updated", "merge_request.commented", "merge_request.merged", "merge_request.closed");
});

describe("what is watched", () => {
  it("polls nothing when nothing is switched on — no timer, no call", async () => {
    enabled = [];
    const w = watcher();
    await w.kick();
    expect(w.watching()).toEqual([]);
    expect(forge.calls).toEqual([]);
    expect(clock.timers.size).toBe(0);
  });

  it("reads only what the enabled events need: merge requests alone for merged, branches alone for push", async () => {
    enabled = on("merge_request.merged");
    await watcher().kick();
    expect(forge.calls).toEqual(["list open"]);
    forge.calls = [];
    enabled = on("git.pushed");
    store = new MemoryRepoWatch();
    await watcher().kick();
    expect(forge.calls).toEqual(["branches"]);
  });

  it("a refresh re-reads the targets and looks only at a new one — a wait beginning is not a reason to ask the forge", async () => {
    let second = false;
    const w = watcher(() => (second ? [target(), { ...target(), remote: "upstream" }] : [target()]));
    await w.kick();
    expect(forge.calls).toEqual(["list open", "branches"]);
    forge.calls = [];
    await w.refresh();
    expect(forge.calls).toEqual([]);
    second = true;
    await w.refresh();
    expect(forge.calls).toEqual(["list open", "branches"]);
    expect(w.watching()).toHaveLength(2);
  });

  it("drops a target whose events were all switched off, timer and all", async () => {
    const w = watcher();
    await w.kick();
    expect(clock.timers.size).toBe(1);
    enabled = [];
    await w.kick();
    expect(w.watching()).toEqual([]);
    expect(clock.timers.size).toBe(0);
  });
});

describe("the baseline", () => {
  it("stores what is there on the first look and emits nothing — a repository's branches are not pushes", async () => {
    forge.request(1, {});
    forge.push("main", "m1");
    forge.push("release/2.0", "r1");
    await watcher().kick();
    expect(events).toEqual([]);
    expect(store.seen({ remote: "origin", repository: "github.com/acme/app" }, "branch", "main")).toEqual({ head: "m1" });
    expect(store.seen({ remote: "origin", repository: "github.com/acme/app" }, "merge_request", "1")?.state).toBe("open");
    expect(store.cursor({ remote: "origin", repository: "github.com/acme/app" })).toMatchObject({ branches: true, mergeRequests: { since: expect.any(String) } });
  });

  it("takes a kind's baseline when it is first needed, not a flood of what happened before", async () => {
    enabled = on("merge_request.opened");
    forge.push("main", "m1");
    await watcher().kick();
    clock.at += 5 * MIN;
    forge.push("main", "m2");
    enabled = on("merge_request.opened", "git.pushed");
    await watcher().kick();
    expect(events).toEqual([]);
    forge.push("main", "m3");
    clock.at += MIN;
    await watcher().kick();
    expect(names()).toEqual(["git.pushed main"]);
  });
});

describe("merge requests — the latest-state rule", () => {
  const look = async (w: RepositoryWatcher): Promise<void> => {
    clock.at += MIN;
    await w.kick();
  };

  it("opened, updated, merged and closed — one event each, only for what changed", async () => {
    const w = watcher();
    await w.kick();
    clock.at += 10_000;
    forge.request(7, {});
    await look(w);
    expect(names()).toEqual(["merge_request.opened !7"]);
    // Nothing moved: nothing is said, however many looks.
    await look(w);
    await look(w);
    expect(events).toHaveLength(1);
    forge.request(7, { head: "h7-2" });
    await look(w);
    forge.request(7, { title: "Renamed" });
    await look(w);
    forge.request(7, { state: "merged" });
    forge.request(8, {});
    await look(w);
    const mergedSeen = clock.at;
    clock.at += 10_000;
    forge.request(8, { state: "closed" });
    await look(w);
    expect(names()).toEqual([
      "merge_request.opened !7",
      "merge_request.updated !7",
      "merge_request.updated !7",
      "merge_request.merged !7",
      "merge_request.opened !8",
      "merge_request.closed !8",
    ]);
    const merged = events[3]!;
    expect(merged.payload).toMatchObject({ remote: "origin", connection: "github", host: "github.com", repository: "acme/app", merge_request: { number: 7, state: "merged", target_branch: "main" } });
    // When JaiRA SAW it — the look that found it.
    expect(merged.at).toBe(iso(mergedSeen));
  });

  it("says nothing of a request opened and closed between two looks", async () => {
    const w = watcher();
    await w.kick();
    clock.at += 10_000;
    forge.request(9, {});
    clock.at += 10_000;
    forge.request(9, { state: "closed" });
    await look(w);
    expect(events).toEqual([]);
  });

  it("opened again when a closed request reopens", async () => {
    const w = watcher();
    forge.request(4, {});
    await w.kick();
    clock.at += 10_000;
    forge.request(4, { state: "closed" });
    await look(w);
    clock.at += 10_000;
    forge.request(4, { state: "open" });
    await look(w);
    expect(names()).toEqual(["merge_request.closed !4", "merge_request.opened !4"]);
  });

  it("says only the events switched on, and only for a target branch its globs take", async () => {
    enabled = [{ name: "merge_request.opened", branches: ["release/*"] }];
    const w = watcher();
    await w.kick();
    clock.at += 10_000;
    forge.request(1, { targetBranch: "main" });
    forge.request(2, { targetBranch: "release/2.0" });
    forge.request(2, { head: "moved" });
    await look(w);
    expect(names()).toEqual(["merge_request.opened !2"]);
  });

  it("new comments are ONE event carrying all of them — and what JaiRA signed is not news, whoever's account posted it", async () => {
    const w = watcher();
    forge.request(3, {});
    await w.kick();
    clock.at += 10_000;
    forge.say(3, { id: "c1", who: "sam", body: "why?", threadId: "t1", anchor: { path: "a.ts", line: 4, side: "after" } });
    clock.at += 1_000;
    // JaiRA's reply carries its marker. The rule is the MARKER: even a note the provider does not call
    // `own` is left out when it carries one.
    forge.say(3, { id: "c2", who: "jaira-bot", body: signComment("because", { model: "claude-opus-5-5", taskId: "t1" }) });
    clock.at += 1_000;
    // The connection's own account, unsigned: the person, writing on the forge themselves — news.
    forge.say(3, { id: "c3", who: "jaira-bot", body: "ok, merging after lunch", own: true });
    await look(w);
    expect(names()).toEqual(["merge_request.commented !3"]);
    const comments = (events[0]!.payload as unknown as { comments: Array<Record<string, unknown>> }).comments;
    expect(comments.map((c) => c["id"])).toEqual(["c1", "c3"]);
    expect(comments[0]).toEqual({ id: "c1", author: "sam", body: "why?", created_at: iso(T0 + 10_000), thread_id: "t1", anchor: { path: "a.ts", line: 4, side: "after" } });
    // Heard once.
    await look(w);
    expect(events).toHaveLength(1);
    forge.say(3, { id: "c4", who: "sam", body: "thanks" });
    await look(w);
    expect(events.map((e) => (e.payload as { comments?: Array<{ id: string }> }).comments?.map((c) => c.id))).toEqual([["c1", "c3"], ["c4"]]);
  });

  it("does not read comments on a request the list says did not change", async () => {
    const w = watcher();
    forge.request(3, {});
    await w.kick();
    await look(w);
    expect(forge.calls.filter((c) => c.startsWith("comments"))).toEqual([]);
  });
});

describe("pushes", () => {
  it("a moved head is ONE push old..new with its commits; a new branch comes from nothing; a deletion is silent", async () => {
    forge.push("main", "m1");
    forge.push("old", "o1");
    const w = watcher();
    await w.kick();
    forge.push("main", "m2");
    forge.push("main", "m3");
    forge.commitsOf.set("m1..m3", [
      { sha: "m2", message: "two", author: "mara" },
      { sha: "m3", message: "three", author: "sam" },
    ]);
    forge.push("feature/x", "f1");
    forge.heads = forge.heads.filter((b) => b.name !== "old");
    clock.at += MIN;
    await w.kick();
    expect(events.map((e) => e.payload)).toEqual([
      { remote: "origin", connection: "github", host: "github.com", repository: "acme/app", branch: "main", before: "m1", after: "m3", commits: [{ sha: "m2", message: "two", author: "mara" }, { sha: "m3", message: "three", author: "sam" }] },
      { remote: "origin", connection: "github", host: "github.com", repository: "acme/app", branch: "feature/x", before: NEW_BRANCH_SHA, after: "f1", commits: [{ sha: "f1", message: "commit f1", author: "mara" }] },
    ]);
    expect(forge.calls).toContain("compare -..f1");
    // The deleted branch is forgotten: pushed again, it is new.
    forge.push("old", "o2");
    clock.at += MIN;
    await w.kick();
    expect(events.at(-1)!.payload).toMatchObject({ branch: "old", before: NEW_BRANCH_SHA, after: "o2" });
  });

  it("only for branches the event's globs take — but every head is remembered", async () => {
    enabled = [{ name: "git.pushed", branches: ["release/**"] }];
    forge.push("main", "m1");
    forge.push("release/2.0", "r1");
    const w = watcher();
    await w.kick();
    forge.push("main", "m2");
    forge.push("release/2.0", "r2");
    clock.at += MIN;
    await w.kick();
    expect(names()).toEqual(["git.pushed release/2.0"]);
    expect(store.seen({ remote: "origin", repository: "github.com/acme/app" }, "branch", "main")).toEqual({ head: "m2" });
  });

  it("a push with no compare on the provider carries no commits", async () => {
    (forge as { compare?: unknown }).compare = undefined;
    forge.push("main", "m1");
    const w = watcher();
    await w.kick();
    forge.push("main", "m2");
    clock.at += MIN;
    await w.kick();
    expect(events[0]!.payload).toMatchObject({ before: "m1", after: "m2", commits: [] });
  });
});

describe("pipelines", () => {
  beforeEach(() => {
    enabled = [{ name: "pipeline.failed", branches: ["main"] }];
  });

  const suite = (id: number, sha: string, status: PipelineStatus, name = `suite ${id}`): ForgePipeline => ({
    id,
    sha,
    ref: "main",
    source: "push",
    sourceName: "push",
    status,
    name,
    createdAt: "2026-09-28T10:00:00Z",
    url: `https://github.com/acme/app/actions/runs/${id}`,
  });

  it("a head's pipeline that fails is reported once, with only its failed jobs; heads at the baseline are not", async () => {
    forge.push("main", "m1");
    forge.runs.set("m1", [suite(1, "m1", "failed")]);
    const w = watcher();
    await w.kick();
    await clock.advance(MIN);
    expect(events).toEqual([]);
    expect(forge.calls.filter((c) => c.startsWith("pipelines"))).toEqual([]);

    forge.push("main", "m2");
    forge.push("other", "o1");
    forge.runs.set("m2", [suite(2, "m2", "running")]);
    await clock.advance(MIN);
    expect(events).toEqual([]);
    forge.runs.set("m2", [suite(2, "m2", "failed", "CI")]);
    forge.failedJobs.set(2, [
      { id: 21, name: "test", stage: "test", status: "failed", failureReason: "script_failure", url: "https://ci/21" },
      { id: 22, name: "lint", status: "failed", url: "https://ci/22" },
    ]);
    await clock.advance(MIN);
    await clock.advance(MIN);
    expect(events.map((e) => [e.name, e.payload])).toEqual([
      [
        "pipeline.failed",
        {
          remote: "origin",
          connection: "github",
          host: "github.com",
          repository: "acme/app",
          ref: "main",
          sha: "m2",
          pipeline_id: 2,
          name: "CI",
          source: "push",
          url: "https://github.com/acme/app/actions/runs/2",
          failed_jobs: [
            { job_id: 21, name: "test", stage: "test", failure_reason: "script_failure", url: "https://ci/21" },
            { job_id: 22, name: "lint", url: "https://ci/22" },
          ],
        },
      ],
    ]);
    // `other` is not a branch the event takes: its pipelines are never asked.
    expect(forge.calls.filter((c) => c === "pipelines o1")).toEqual([]);
    // Finished: not asked again.
    expect(forge.calls.filter((c) => c === "pipelines m2")).toHaveLength(2);
  });

  it("reports every suite of a GitHub head by its own outcome, and nothing for a skipped one", async () => {
    enabled = [{ name: "pipeline.failed" }, { name: "pipeline.succeeded" }, { name: "pipeline.canceled" }];
    forge.push("main", "m1");
    const w = watcher();
    await w.kick();
    forge.push("main", "m2");
    forge.runs.set("m2", [suite(1, "m2", "success"), suite(2, "m2", "canceled"), suite(3, "m2", "skipped"), suite(4, "m2", "failed")]);
    await clock.advance(MIN);
    expect(events.map((e) => [e.name, (e.payload as { pipeline_id: number }).pipeline_id])).toEqual([
      ["pipeline.succeeded", 1],
      ["pipeline.canceled", 2],
      ["pipeline.failed", 4],
    ]);
    // Only a failed pipeline is read for its jobs.
    expect(forge.calls.filter((c) => c.startsWith("pipeline "))).toEqual(["pipeline 4"]);
  });

  it("a head where no pipeline ever runs is given up on", async () => {
    forge.push("main", "m1");
    const w = watcher();
    await w.kick();
    forge.push("main", "m2");
    await clock.advance(MIN);
    await clock.advance(MIN);
    const asked = forge.calls.filter((c) => c === "pipelines m2").length;
    await clock.advance(PIPELINES_GIVE_UP_MS);
    const after = forge.calls.filter((c) => c === "pipelines m2").length;
    await clock.advance(5 * MIN);
    expect(forge.calls.filter((c) => c === "pipelines m2").length).toBe(after);
    expect(after).toBeGreaterThan(asked);
    expect(events).toEqual([]);
  });
});

describe("one occurrence, two names (decision 0016 §4)", () => {
  it("a merge is git.merged and merge_request.merged", async () => {
    enabled = on("git.merged", "merge_request.merged");
    forge.request(1, {});
    const w = watcher();
    await w.kick();
    clock.at += MIN;
    forge.request(1, { state: "merged" });
    await w.kick();
    expect(events.map((e) => e.name)).toEqual(["git.merged", "merge_request.merged"]);
  });

  it("new commits on an open request are merge_request.updated and merge_request.pushed, with what was pushed", async () => {
    enabled = on("merge_request.updated", "merge_request.pushed");
    forge.request(7, { head: "a1" });
    const w = watcher();
    await w.kick();
    clock.at += MIN;
    forge.request(7, { head: "a2" });
    await w.kick();
    expect(events.map((e) => e.name)).toEqual(["merge_request.updated", "merge_request.pushed"]);
    expect(events[1]!.payload).toMatchObject({ before: "a1", after: "a2", commits: [{ sha: "a2" }], merge_request: { number: 7, head_sha: "a2" } });
    // A title change alone is an update, and no push.
    clock.at += MIN;
    forge.request(7, { title: "Renamed" });
    await w.kick();
    expect(events.map((e) => e.name)).toEqual(["merge_request.updated", "merge_request.pushed", "merge_request.updated"]);
  });
});

describe("cadence", () => {
  it("looks every minute while something is switched on", async () => {
    await watcher().kick();
    expect(clock.pending()).toEqual([MIN]);
    await clock.advance(MIN);
    await clock.advance(MIN);
    expect(forge.calls.filter((c) => c === "branches")).toHaveLength(3);
  });

  it("backs off while the forge fails, keeps the error on the cursor, and honours its Retry-After", async () => {
    const w = watcher();
    await w.kick();
    forge.failWith = new Error("the forge answered 502");
    await clock.advance(MIN);
    expect(errors).toEqual(["the forge answered 502"]);
    expect(store.cursors.get(JSON.stringify(["origin", "github.com/acme/app"]))?.error).toBe("the forge answered 502");
    expect(clock.pending()).toEqual([2 * MIN]);
    await clock.advance(2 * MIN);
    expect(clock.pending()).toEqual([4 * MIN]);
    forge.failWith = new ForgeError("rate limited", 429, 900);
    await clock.advance(4 * MIN);
    expect(clock.pending()).toEqual([15 * MIN]);
    forge.failWith = undefined;
    await clock.advance(15 * MIN);
    expect(clock.pending()).toEqual([MIN]);
    expect(store.cursors.get(JSON.stringify(["origin", "github.com/acme/app"]))?.error).toBeUndefined();
  });

  it("stops at dispose, and a look that comes back to a closed project writes nothing", async () => {
    let open = true;
    const w = new RepositoryWatcher({ targets: () => [target()], clock, onEvent: (_p, e) => void events.push(e), live: () => open });
    await w.kick();
    forge.push("main", "m1");
    open = false;
    await clock.advance(MIN);
    expect(clock.timers.size).toBe(0);
    w.dispose();
    expect(store.seen({ remote: "origin", repository: "github.com/acme/app" }, "branch", "main")).toBeUndefined();
  });

  it("waits, at dispose, for a read of the targets under way — the git run in each project", async () => {
    let finish: (targets: RepoWatchTarget[]) => void = () => undefined;
    const w = new RepositoryWatcher({ targets: () => new Promise<RepoWatchTarget[]>((resolve) => (finish = resolve)), clock, onEvent: () => undefined });
    void w.kick();
    await Promise.resolve();
    let done = false;
    const disposed = w.dispose().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    finish([target()]);
    await disposed;
    expect(done).toBe(true);
    expect(clock.timers.size).toBe(0);
  });

  it("keys a target by project, remote and repository", () => {
    expect(repoWatchKeyOf(target())).toBe(JSON.stringify(["p1", "origin", "github.com", "acme/app"]));
  });
});

describe("a restart", () => {
  it("catches up with the LATEST state only — one event per request and branch, whatever happened while closed", async () => {
    forge.request(1, {});
    forge.request(2, {});
    forge.push("main", "m1");
    const first = watcher();
    await first.kick();
    first.dispose();

    // A weekend with the app closed.
    clock.at += 2 * 24 * 60 * MIN;
    forge.request(1, { head: "h1-2" });
    forge.request(1, { head: "h1-3" });
    forge.request(1, { state: "merged" }); // updated twice, then merged: only merged
    forge.request(2, { head: "h2-2" }); // updated twice: one update
    forge.request(2, { head: "h2-3" });
    forge.request(5, {}); // opened then updated: only opened
    forge.request(5, { head: "h5-2" });
    forge.request(6, {}); // opened and closed: nothing
    forge.request(6, { state: "closed" });
    forge.push("main", "m2");
    forge.push("main", "m3"); // two pushes: one m1..m3

    const second = watcher();
    await second.kick();
    expect(names().sort()).toEqual(["merge_request.merged !1", "merge_request.opened !5", "merge_request.updated !2", "git.pushed main"].sort());
    expect(events.find((e) => e.name === "git.pushed")!.payload).toMatchObject({ before: "m1", after: "m3" });
    second.dispose();
  });
});

describe("status, for Settings → Events", () => {
  it("says whether a remote is watched, when it was last looked at, and what the last look failed with", async () => {
    const w = watcher();
    expect(w.status("p1", "origin")).toEqual({ watching: false });
    await w.kick();
    expect(w.status("p1", "origin")).toEqual({ watching: true, checkedAt: T0 });
    expect(w.status("p1", "upstream")).toEqual({ watching: false });
    forge.failWith = new Error("the forge answered 502");
    await clock.advance(MIN);
    expect(w.status("p1", "origin")).toEqual({ watching: true, checkedAt: T0 + MIN, error: "the forge answered 502" });
    forge.failWith = undefined;
    await clock.advance(2 * MIN);
    expect(w.status("p1", "origin")).toEqual({ watching: true, checkedAt: T0 + 3 * MIN });
  });
});
