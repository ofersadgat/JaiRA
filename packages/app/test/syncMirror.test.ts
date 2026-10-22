/**
 * A phone's copy of its machines (decision 0018 §7): the cache following several engines, each by its
 * own clock, and a mirror on the device that is read before any of them answers and kept within a
 * limit — or none.
 */
import { describe, expect, it } from "vitest";
import type { JairaBridge, ProjectTask, PushMessage, SyncPage } from "@jaira/shared/browser";
import { fleetBridge, type FleetMember } from "../../client/bridges/fleetBridge";
import { SyncCache, type SyncIo, type SyncSources } from "../src/renderer/syncCache";
import { SyncMirror, mirrorName, type MirrorStore } from "../src/renderer/syncMirror";

const task = (taskId: string, title = taskId, updatedAt = 1): ProjectTask =>
  ({ taskId, title, status: "completed", workflow: "chat/session", createdAt: "", updatedAt, project: "/p" }) as ProjectTask;
const page = (at: number, tasks: ProjectTask[], extra: Partial<SyncPage> = {}): SyncPage => ({ at, horizon: 0, whole: false, tasks, gone: [], changes: [], ...extra });
const settle = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A device's storage in memory: what a phone's folder holds. */
function memoryStore(): MirrorStore & { files: Map<string, { text: string; at: number }> } {
  const files = new Map<string, { text: string; at: number }>();
  let clock = 0;
  return {
    files,
    list: async () => [...files].map(([name, f]) => ({ name, size: f.text.length, at: f.at })),
    read: async (name) => files.get(name)?.text ?? null,
    write: async (name, text) => void files.set(name, { text, at: ++clock }),
    remove: async (name) => void files.delete(name),
  };
}

/** Engines answering `sync:since` from a function each, and views from one table. */
function engines(pages: Record<string, (since: number) => SyncPage>, views: (channel: string, request: unknown) => unknown = () => null) {
  const asked: Array<{ source: string; since: number }> = [];
  let answering = Object.keys(pages);
  const changed = new Set<() => void>();
  let viewsDown = false;
  const sources: SyncSources = {
    ids: () => answering,
    onChange: (on) => {
      changed.add(on);
      return () => void changed.delete(on);
    },
    since: async (source, since) => {
      asked.push({ source, since });
      return pages[source]!(since);
    },
  };
  const io: SyncIo = {
    invoke: (async (channel: string, request: unknown) => {
      if (viewsDown) throw new Error("no machine is answering");
      return views(channel, request);
    }) as SyncIo["invoke"],
  };
  return {
    sources,
    io,
    asked,
    answer: (ids: string[]) => {
      answering = ids;
      changed.forEach((on) => on());
    },
    down: (is: boolean) => (viewsDown = is),
  };
}

describe("a cache following several engines", () => {
  it("keeps a cursor per engine, and a whole page of one drops only what that one put here", async () => {
    const e = engines({
      a: (since) => (since === 0 ? page(100, [task("t-a1"), task("t-a2")], { whole: true }) : page(100, [])),
      c: (since) => (since === 0 ? page(7, [task("t-c1")], { whole: true }) : page(7, [])),
    });
    const cache = new SyncCache(e.io, { sources: e.sources });
    await cache.start();
    expect(cache.cursorOf("a")).toBe(100);
    expect(cache.cursorOf("c")).toBe(7);
    expect(cache.tasks().map((t) => t.taskId).sort()).toEqual(["t-a1", "t-a2", "t-c1"]);
    // c's clock is far behind a's: its pages are applied against its own cursor, not a's.
    cache.push({ type: "sync:changed", prev: 7, page: page(9, [task("t-c2")]), source: "c" });
    expect(cache.cursorOf("c")).toBe(9);
    expect(cache.task("t-c2")).toBeDefined();
    // A whole page of a, without t-a2: gone — and c's tasks stand.
    cache.apply(page(120, [task("t-a1")], { whole: true }), "a");
    expect(cache.tasks().map((t) => t.taskId).sort()).toEqual(["t-a1", "t-c1", "t-c2"]);
  });

  it("reconciles only the engine whose push says one was missed", async () => {
    const e = engines({
      a: (since) => (since === 0 ? page(100, [], { whole: true }) : page(100, [])),
      c: (since) => (since === 0 ? page(7, [], { whole: true }) : page(12, [task("t-missed")])),
    });
    const cache = new SyncCache(e.io, { sources: e.sources });
    await cache.start();
    e.asked.length = 0;
    cache.push({ type: "sync:changed", prev: 10, page: page(12, [task("t-pushed")]), source: "c" });
    await settle();
    expect(e.asked).toEqual([{ source: "c", since: 7 }]);
    expect(cache.task("t-missed")).toBeDefined();
  });

  it("follows an engine that starts answering, and forgets one whose machine was forgotten", async () => {
    const e = engines({
      a: () => page(5, [task("t-a")], { whole: true }),
      c: () => page(5, [task("t-c")], { whole: true }),
    });
    e.answer(["a"]);
    const cache = new SyncCache(e.io, { sources: e.sources });
    await cache.start();
    expect(cache.tasks().map((t) => t.taskId)).toEqual(["t-a"]);
    e.answer(["a", "c"]);
    await settle();
    expect(cache.tasks().map((t) => t.taskId).sort()).toEqual(["t-a", "t-c"]);
    cache.forget("c");
    expect(cache.tasks().map((t) => t.taskId)).toEqual(["t-a"]);
  });

  it("starts again from nothing when an engine's clock is behind its cursor — another database", async () => {
    let db = 1;
    const e = engines({ a: (since) => (since === 0 ? page(db === 1 ? 50 : 20, [task(db === 1 ? "t-old" : "t-new")], { whole: true }) : page(db === 1 ? 50 : 20, [])) });
    const cache = new SyncCache(e.io, { sources: e.sources });
    await cache.start();
    db = 2;
    await cache.reconcile();
    expect(cache.tasks().map((t) => t.taskId)).toEqual(["t-new"]);
    expect(cache.cursorOf("a")).toBe(20);
  });
});

describe("the mirror", () => {
  it("is read before any engine answers, and asks each only what changed since its kept cursor", async () => {
    const store = memoryStore();
    const first = engines({ a: () => page(40, [task("t-a", "kept")], { whole: true }) });
    const cache = new SyncCache(first.io, { sources: first.sources, mirror: new SyncMirror(store, { index: 0, view: 0 }) });
    await cache.start();
    await settle(5);

    // The app started again; the machine does not answer yet.
    const later = engines({ a: () => new Promise<SyncPage>(() => undefined) as never });
    const again = new SyncCache(later.io, { sources: later.sources, mirror: new SyncMirror(store, { index: 0, view: 0 }) });
    void again.start();
    await settle(5);
    expect(again.task("t-a")?.title).toBe("kept");
    expect(later.asked).toEqual([{ source: "a", since: 40 }]);
  });

  it("shows a view it kept while no engine can answer, and the engine's answer once one does", async () => {
    const store = memoryStore();
    const e = engines({ a: () => page(1, [], { whole: true }) }, () => ({ said: "then" }));
    const cache = new SyncCache(e.io, { sources: e.sources, mirror: new SyncMirror(store, { index: 0, view: 0 }) });
    await cache.start();
    cache.hold("screen", [["task:detail", { taskId: "t-a" }]]);
    await settle(5);

    let said = "then";
    const offline = engines({ a: () => page(2, [task("t-a")]) }, () => ({ said }));
    offline.down(true);
    const again = new SyncCache(offline.io, { sources: offline.sources, mirror: new SyncMirror(store, { index: 0, view: 0 }) });
    await again.start();
    again.hold("screen", [["task:detail", { taskId: "t-a" }]]);
    await settle(5);
    expect(again.peek("task:detail", { taskId: "t-a" })).toMatchObject({ value: { said: "then" }, error: undefined });

    // Back: the next page has it read, and the engine's answer replaces the kept one.
    offline.down(false);
    said = "now";
    again.apply(page(3, []), "a");
    await settle(5);
    expect(again.peek("task:detail", { taskId: "t-a" }).value).toEqual({ said: "now" });
  });

  it("drops the views read longest ago past its limit, never an index, and keeps everything with none", async () => {
    const store = memoryStore();
    const mirror = new SyncMirror(store, { index: 0, view: 0 });
    mirror.keepIndex("a", () => ({ cursor: 1, tasks: [[task("t-a"), 1]] }));
    await settle(5);
    for (const n of [1, 2, 3, 4]) {
      mirror.keepView(`view ${n}`, "x".repeat(1000));
      await settle(5);
    }
    await mirror.view("view 1");
    await mirror.setLimit(2500);
    // The index and the two read or written last are kept: view 1 (just read) and view 4.
    expect(await mirror.view("view 2")).toBeUndefined();
    expect(await mirror.view("view 3")).toBeUndefined();
    expect(await mirror.view("view 1")).toBe("x".repeat(1000));
    expect(await mirror.view("view 4")).toBe("x".repeat(1000));
    expect((await mirror.indexes()).get("a")?.cursor).toBe(1);

    await mirror.setLimit(null);
    for (const n of [5, 6, 7]) {
      mirror.keepView(`view ${n}`, "x".repeat(1000));
      await settle(5);
    }
    expect(mirror.usage().bytes).toBeGreaterThan(4000);
    // The limit is the device's: a mirror opened later has it.
    const reopened = new SyncMirror(store);
    await reopened.indexes();
    expect(reopened.usage().limit).toBeNull();
  });

  it("names a file by its key's hash, and tells a collision by the key kept inside", async () => {
    const store = memoryStore();
    const mirror = new SyncMirror(store, { index: 0, view: 0 });
    mirror.keepView("one", 1);
    await settle(5);
    store.files.set(mirrorName("view-", "two"), { text: JSON.stringify({ key: "not two", value: 2 }), at: 99 });
    const reopened = new SyncMirror(store);
    expect(await reopened.view("one")).toBe(1);
    expect(await reopened.view("two")).toBeUndefined();
  });
});

describe("the fleet bridge's engines", () => {
  function engine(pages: (since: number) => SyncPage): JairaBridge & { push: (m: PushMessage) => void } {
    const listeners = new Set<(m: PushMessage) => void>();
    return {
      invoke: (async (channel: string, request: unknown) => {
        if (channel === "sync:since") return pages((request as { since: number }).since);
        throw new Error(`${channel}: not here`);
      }) as JairaBridge["invoke"],
      subscribe: (on) => {
        listeners.add(on);
        return () => void listeners.delete(on);
      },
      push: (m) => listeners.forEach((on) => on(m)),
    };
  }
  const member = (id: string, bridge: JairaBridge, fleet: string[]): FleetMember => ({ id, bridge, connected: true, fleet: new Set(fleet) });

  it("are each fleet's answering machine: asked by id, and their pushes say which sent them", async () => {
    const a = engine(() => page(100, [task("t-a")], { whole: true }));
    const c = engine(() => page(7, [task("t-c")], { whole: true }));
    const f = fleetBridge();
    const heard: PushMessage[] = [];
    f.bridge.subscribe((m) => heard.push(m));
    let told = 0;
    f.sources.onChange(() => (told += 1));
    f.setMembers([member("a", a, ["a"]), member("c", c, ["c"])]);
    expect(told).toBe(1);
    expect(f.sources.ids()).toEqual(["a", "c"]);
    expect((await f.sources.since("c", 0)).tasks.map((t) => t.taskId)).toEqual(["t-c"]);
    c.push({ type: "sync:changed", prev: 7, page: page(8, []) });
    expect(heard.at(-1)).toMatchObject({ type: "sync:changed", source: "c" });
    await expect(f.sources.since("gone", 0)).rejects.toThrow(/not answering/);
  });
});
