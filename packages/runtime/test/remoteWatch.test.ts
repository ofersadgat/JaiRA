/**
 * Watching merge requests (decision 0004, "Watching").
 *
 * A manual clock and a scripted provider: what is pinned here is WHEN the forge is asked and how
 * much, which is the whole budget argument of the design, and that the quiet window is a fact on the
 * row rather than a timer in a process.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ForgeProvider, Probe, ProbeCursor, RemoteHandle, RemoteState } from "@jaira/shared";
import { ForgeError } from "../src/forge";
import {
  BACKSTOP_MS,
  FAST_MS,
  PollingSource,
  RemoteWatcher,
  SLOW_MS,
  connectionKeyOf,
  handleKeyOf,
  nextProbeDelay,
  type RemoteEventSource,
  type RemoteHint,
  type RemoteSettled,
  type WatchClock,
  type WatchTarget,
} from "../src/remoteWatch";
import { MemoryHandles } from "./remoteRig";

const T0 = Date.parse("2026-09-19T10:00:00Z");
const MIN = 60_000;

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
  /** Move time forward, firing what falls due, in order — and letting each firing's promises land. */
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
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const open = (extra: Partial<RemoteState> = {}): RemoteState => ({ state: "open", draft: false, head: "abc", updatedAt: new Date(T0).toISOString(), reviews: [], threads: [], comments: [], ...extra });

class ScriptedForge implements ForgeProvider {
  readonly kind = "gitlab" as const;
  probes: Array<{ handles: string[]; cursor: ProbeCursor }> = [];
  reads: string[] = [];
  moved: string[] = [];
  states = new Map<string, RemoteState>();
  floor?: number;
  failWith?: Error;
  constructor(readonly host: string) {}
  async whoami() {
    return { login: "jaira-bot" };
  }
  async open(): Promise<RemoteHandle> {
    throw new Error("not scripted");
  }
  async probe(handles: RemoteHandle[], cursor: ProbeCursor): Promise<Probe> {
    this.probes.push({ handles: handles.map((h) => h.id), cursor });
    if (this.failWith !== undefined) throw this.failWith;
    const moved = this.moved;
    this.moved = [];
    return { moved, cursor: { since: `probe-${this.probes.length}` }, ...(this.floor !== undefined ? { pollAfterSeconds: this.floor } : {}) };
  }
  async read(handle: RemoteHandle): Promise<RemoteState> {
    this.reads.push(handle.id);
    return this.states.get(handle.id) ?? open();
  }
  async comment(): Promise<void> {}
  async reply(): Promise<void> {}
  async merge(): Promise<void> {}
  async close(): Promise<void> {}
}

let clock: ManualClock;
let handles: MemoryHandles;
let forges: Map<string, ScriptedForge>;
let settled: RemoteSettled[];

const target = (): WatchTarget => ({
  key: "project",
  handles,
  settleAfter: "10m",
  provider: (host) => {
    let forge = forges.get(host);
    if (forge === undefined) forges.set(host, (forge = new ScriptedForge(host)));
    return forge;
  },
});

/** A request somebody is waiting on. */
function awaited(taskId: string, number: number, host = "gitlab.com"): string {
  handles.ensure({ taskId, key: "review", provider: "gitlab", host, project: "team/app", remote: "origin", branch: `jaira/${taskId}/review`, target: "main" });
  handles.update(taskId, "review", { number, url: `https://${host}/team/app/-/merge_requests/${number}`, pushedHead: "abc", awaiting: true, cursor: { since: "earlier" } });
  return `${host}/team/app!${number}`;
}

function watching(sources?: RemoteEventSource[]) {
  const source = new PollingSource({ targets: () => [target()], clock });
  const watcher = new RemoteWatcher({ targets: () => [target()], sources: sources ?? [source], clock, onSettled: (event) => void settled.push(event) });
  const running = watcher.start();
  return { source, watcher, running };
}

beforeEach(() => {
  clock = new ManualClock();
  handles = new MemoryHandles();
  forges = new Map();
  settled = [];
});

describe("the cadence, as a table", () => {
  it("is 60 s while something has attention, and doubles to 15 min while nothing moves", () => {
    expect(nextProbeDelay({ attention: true, quiet: 9, failures: 0 })).toBe(FAST_MS);
    expect([0, 1, 2, 3, 4, 5].map((quiet) => nextProbeDelay({ attention: false, quiet, failures: 0 }) / MIN)).toEqual([1, 2, 4, 8, 15, 15]);
    expect(SLOW_MS).toBe(15 * MIN);
  });

  it("lets the forge's own floor win, always", () => {
    expect(nextProbeDelay({ attention: true, quiet: 0, failures: 0, floorSeconds: 300 })).toBe(5 * MIN);
    expect(nextProbeDelay({ attention: false, quiet: 5, failures: 0, floorSeconds: 60 })).toBe(15 * MIN);
  });

  it("backs a failing host off on its own", () => {
    expect([1, 2, 3, 9].map((failures) => nextProbeDelay({ attention: true, quiet: 0, failures }) / MIN)).toEqual([2, 4, 8, 15]);
  });
});

describe("the polling source", () => {
  it("polls nothing while nothing is parked — no probe, and no timer at all", async () => {
    watching();
    await clock.advance(60 * MIN);
    expect(forges.size).toBe(0);
    expect(clock.timers.size).toBe(0);
  });

  it("makes ONE probe per connection per tick, however many requests are open", async () => {
    awaited("t-1", 41);
    awaited("t-2", 42);
    awaited("t-3", 43);
    watching();
    await settle();
    const forge = forges.get("gitlab.com")!;
    expect(forge.probes).toHaveLength(1);
    expect(forge.probes[0]!.handles).toHaveLength(3);
  });

  it("reads in full only what the probe says moved", async () => {
    awaited("t-1", 41);
    const moving = awaited("t-2", 42);
    const { source } = watching();
    await settle();
    const forge = forges.get("gitlab.com")!;
    expect(forge.reads).toEqual([]);
    forge.moved = [moving];
    source.kick();
    await settle();
    expect(forge.reads).toEqual([moving]);
  });

  it("slows while nothing moves, and comes back to 60 s on any change", async () => {
    const id = awaited("t-1", 41);
    watching();
    await settle();
    const forge = forges.get("gitlab.com")!;
    const probesAt = (): number => forge.probes.length;
    // quiet 1 → 2 min, quiet 2 → 4 min.
    await clock.advance(2 * MIN - 1);
    expect(probesAt()).toBe(1);
    await clock.advance(1);
    expect(probesAt()).toBe(2);
    await clock.advance(4 * MIN);
    expect(probesAt()).toBe(3);
    forge.moved = [id];
    await clock.advance(8 * MIN);
    expect(probesAt()).toBe(4);
    // It moved: the next one is a minute away, not sixteen.
    await clock.advance(1 * MIN);
    expect(probesAt()).toBe(5);
  });

  it("stays on the fast cadence while a quiet window is open", async () => {
    awaited("t-1", 41);
    handles.update("t-1", "review", { settleAt: T0 + 9 * MIN });
    watching();
    await settle();
    // The window is a timestamp on the row; nothing here settles it because nothing is said yet.
    await clock.advance(3 * MIN);
    expect(forges.get("gitlab.com")!.probes.length).toBeGreaterThanOrEqual(4);
  });

  it("obeys the forge's floor over its own cadence", async () => {
    awaited("t-1", 41);
    handles.update("t-1", "review", { settleAt: T0 + 60 * MIN });
    watching();
    await settle();
    const forge = forges.get("gitlab.com")!;
    forge.floor = 600;
    await clock.advance(1 * MIN);
    expect(forge.probes).toHaveLength(2);
    await clock.advance(9 * MIN);
    expect(forge.probes).toHaveLength(2);
    await clock.advance(1 * MIN);
    expect(forge.probes).toHaveLength(3);
  });

  it("backs a failing host off without touching the others, and obeys its Retry-After", async () => {
    awaited("t-1", 41, "gitlab.com");
    awaited("t-2", 7, "git.example.org");
    // Attention on both, so only the failure separates them.
    handles.update("t-1", "review", { settleAt: T0 + 600 * MIN });
    handles.update("t-2", "review", { settleAt: T0 + 600 * MIN });
    watching();
    await settle();
    forges.get("gitlab.com")!.failWith = new ForgeError("429", 429, 900);
    await clock.advance(10 * MIN);
    // The broken host was asked once more and then left alone for its fifteen minutes…
    expect(forges.get("gitlab.com")!.probes).toHaveLength(2);
    // …while the healthy one kept its minute.
    expect(forges.get("git.example.org")!.probes.length).toBeGreaterThanOrEqual(10);
  });

  it("drops a connection's timer once nothing on it is awaited", async () => {
    awaited("t-1", 41);
    const { source } = watching();
    await settle();
    expect(clock.timers.size).toBe(1);
    handles.stopAwaiting("t-1");
    source.kick();
    await settle();
    expect(clock.timers.size).toBe(0);
  });

  it("reads EVERYTHING awaited every 30 minutes, whatever the probe says", async () => {
    const a = awaited("t-1", 41);
    const b = awaited("t-2", 42);
    watching();
    await settle();
    const forge = forges.get("gitlab.com")!;
    await clock.advance(BACKSTOP_MS + SLOW_MS);
    expect(forge.reads.sort()).toEqual([a, b]);
  });

  it("keeps the cursor on the row, so a process that was not there starts from where the last one stopped", async () => {
    awaited("t-1", 41);
    const first = watching();
    await settle();
    first.running.dispose();
    expect(handles.get("t-1", "review")!.cursor).toEqual({ since: "probe-1" });

    forges = new Map();
    watching();
    await settle();
    expect(forges.get("gitlab.com")!.probes[0]!.cursor.since).toBe("probe-1");
  });
});

describe("the watcher", () => {
  const remark = (minute: number) => ({ id: `n-${minute}`, who: "mara", body: "What about Windows?", at: new Date(T0 + minute * MIN).toISOString(), canWrite: true, own: false });

  it("settles from a read, takes the row off the awaited list first, and says who did what", async () => {
    const id = awaited("t-1", 41);
    const { source } = watching();
    await settle();
    const forge = forges.get("gitlab.com")!;
    forge.states.set(id, open({ state: "merged", mergeCommit: "f00d", closedBy: "mara" }));
    forge.moved = [id];
    source.kick();
    await settle();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ target: "project", handle: { id, head: "f00d" }, settlement: { settledBy: { act: "merged", who: "mara" }, effect: "adopt" } });
    expect(handles.get("t-1", "review")).toMatchObject({ awaiting: false });
    // A duplicated hint finds nothing left to settle.
    forge.moved = [id];
    source.kick();
    await settle();
    expect(settled).toHaveLength(1);
  });

  it("starts the window on a comment, writes the DEADLINE on the row, and settles from a read at that time", async () => {
    const id = awaited("t-1", 41);
    const { source } = watching();
    await settle();
    const forge = forges.get("gitlab.com")!;
    clock.at = T0 + 1 * MIN;
    forge.states.set(id, open({ comments: [remark(1)] }));
    forge.moved = [id];
    source.kick();
    await settle();
    expect(handles.get("t-1", "review")).toMatchObject({ settleAt: T0 + 11 * MIN, seen: ["n-1"], awaiting: true });
    expect(settled).toEqual([]);

    const before = forge.reads.length;
    await clock.advance(10 * MIN);
    // What fired at the deadline was a READ — a comment made in the last minute has to be in it.
    expect(forge.reads.length).toBeGreaterThan(before);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.settlement.settledBy).toMatchObject({ act: "quiet", who: "mara" });
  });

  it("closed for a weekend: a window that ran out while nobody was running settles on the first read", async () => {
    const id = awaited("t-1", 41);
    handles.update("t-1", "review", { settleAt: T0 - 48 * 60 * MIN, seen: ["n-0"] });
    forges.set("gitlab.com", new ScriptedForge("gitlab.com"));
    forges.get("gitlab.com")!.states.set(id, open({ comments: [{ ...remark(0), id: "n-0" }] }));
    watching();
    await clock.advance(1);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.settlement.settledBy.act).toBe("quiet");
  });

  it("reports a forge it cannot reach on the row, and keeps waiting", async () => {
    const id = awaited("t-1", 41);
    const { watcher } = watching();
    await settle();
    forges.get("gitlab.com")!.read = async () => {
      throw new ForgeError("reading: the forge answered 502", 502);
    };
    await watcher.check(target(), handles.get("t-1", "review")!);
    expect(handles.get("t-1", "review")).toMatchObject({ awaiting: true, lastError: "reading: the forge answered 502" });
    expect(settled).toEqual([]);
    expect(id).toBeTruthy();
  });

  it("takes hints from ANY source — a relay can replace the poller and nothing downstream changes", async () => {
    const id = awaited("t-1", 41);
    let hint: RemoteHint | undefined;
    const relay: RemoteEventSource = { start: (onHint) => ((hint = onHint), { dispose: () => (hint = undefined) }) };
    watching([relay]);
    forges.set("gitlab.com", new ScriptedForge("gitlab.com"));
    const forge = forges.get("gitlab.com")!;
    forge.states.set(id, open({ state: "closed", closedBy: "lee" }));
    hint!(connectionKeyOf("project", "gitlab.com"), handleKeyOf("project", { taskId: "t-1", key: "review" }));
    await settle();
    expect(forge.probes).toEqual([]); // no polling happened at all
    expect(settled[0]!.settlement.settledBy).toMatchObject({ act: "closed", who: "lee" });
    // A hint about something nobody waits on is harmless.
    hint!(connectionKeyOf("project", "gitlab.com"), handleKeyOf("project", { taskId: "t-9", key: "review" }));
    await settle();
    expect(settled).toHaveLength(1);
  });
});

describe("shutting down while the forge is answering", () => {
  /** The store as the app has it: closed with its project, after which every call throws. */
  class ClosableHandles extends MemoryHandles {
    closed = false;
    after: string[] = [];
    private guard(call: string): void {
      if (this.closed) {
        this.after.push(call);
        throw new TypeError("The database connection is not open");
      }
    }
    override get(taskId: string, key: string) {
      this.guard("get");
      return super.get(taskId, key);
    }
    override forTask(taskId: string) {
      this.guard("forTask");
      return super.forTask(taskId);
    }
    override awaiting() {
      this.guard("awaiting");
      return super.awaiting();
    }
    override update(...args: Parameters<MemoryHandles["update"]>) {
      this.guard("update");
      return super.update(...args);
    }
  }

  let store: ClosableHandles;
  let open_: boolean;
  const project = (): WatchTarget => ({ ...target(), handles: store });
  /** The open projects: none once the project is closed, as `AppService.watchTargets` has it. */
  const targets = (): WatchTarget[] => (open_ ? [project()] : []);
  /** The forge's answer, held until the test lets it through. */
  function hold<T>(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    return { wait, release };
  }

  beforeEach(() => {
    store = new ClosableHandles();
    handles = store;
    open_ = true;
  });

  for (const how of ["the watcher is disposed, then the store closes", "the project closes and the watcher stays up"] as const) {
    it(`a read in flight when ${how} touches nothing afterwards and throws nothing`, async () => {
      const id = awaited("t-1", 41);
      let hint: RemoteHint | undefined;
      const relay: RemoteEventSource = { start: (onHint) => ((hint = onHint), { dispose: () => (hint = undefined) }) };
      const watcher = new RemoteWatcher({ targets, sources: [relay], clock, onSettled: (event) => void settled.push(event) });
      const running = watcher.start();
      const forge = new ScriptedForge("gitlab.com");
      forges.set("gitlab.com", forge);
      forge.states.set(id, open({ state: "merged", mergeCommit: "f00d", closedBy: "mara" }));
      const gate = hold();
      const read = forge.read.bind(forge);
      const asked: string[] = [];
      forge.read = async (handle) => (asked.push(handle.id), await gate.wait, read(handle));

      // One read started by a hint and one by "Check now", both out on the forge.
      hint!(connectionKeyOf("project", "gitlab.com"), handleKeyOf("project", { taskId: "t-1", key: "review" }));
      const checked = watcher.check(project(), store.get("t-1", "review")!);
      await settle();
      expect(asked).toEqual([id]); // one read: "Check now" joined the hint's

      if (how === "the watcher is disposed, then the store closes") running.dispose();
      open_ = false;
      store.closed = true;
      gate.release();

      await expect(checked).resolves.toBeUndefined();
      await settle();
      expect(store.after).toEqual([]);
      expect(settled).toEqual([]);
      running.dispose();
    });
  }

  it("a hint that arrives after the watcher is disposed reads nothing", async () => {
    awaited("t-1", 41);
    let hint: RemoteHint | undefined;
    const relay: RemoteEventSource = { start: (onHint) => ((hint = onHint), { dispose: () => undefined }) };
    const watcher = new RemoteWatcher({ targets, sources: [relay], clock, onSettled: (event) => void settled.push(event) });
    watcher.start().dispose();
    store.closed = true;
    hint!(connectionKeyOf("project", "gitlab.com"));
    await settle();
    expect(store.after).toEqual([]);
    expect(forges.get("gitlab.com")?.reads ?? []).toEqual([]);
  });

  it("a probe in flight when the store closes writes no cursor, hints nothing and schedules nothing", async () => {
    awaited("t-1", 41);
    const forge = new ScriptedForge("gitlab.com");
    forges.set("gitlab.com", forge);
    const gate = hold();
    const probe = forge.probe.bind(forge);
    let asked = 0;
    forge.probe = async (h, c) => (asked++, await gate.wait, probe(h, c));
    const hints: string[] = [];
    const errors: Error[] = [];
    const source = new PollingSource({ targets, clock, onError: (_, error) => void errors.push(error) });
    const running = source.start((connection) => void hints.push(connection));
    await settle();
    expect(asked).toBe(1);

    running.dispose();
    open_ = false;
    store.closed = true;
    gate.release();
    await settle();
    expect(store.after).toEqual([]);
    expect(hints).toEqual([]);
    expect(errors).toEqual([]);
    expect(clock.timers.size).toBe(0);
  });
});
