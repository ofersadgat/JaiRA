/**
 * The window's store of engine data (decision 0018, `syncCache.ts`), against a fake engine that can
 * lose, delay, duplicate and reorder what it sends.
 */
import { describe, expect, it } from "vitest";
import type { ProjectTask, PushMessage, SyncPage } from "@jaira/shared";
import { SyncCache, sharedWith, type SyncIo } from "../src/renderer/syncCache";

const task = (taskId: string, title = taskId, updatedAt = 1): ProjectTask =>
  ({ taskId, title, status: "completed", workflow: "chat/session", createdAt: "", updatedAt, project: "/p" }) as ProjectTask;
const page = (at: number, tasks: ProjectTask[], extra: Partial<SyncPage> = {}): SyncPage => ({ at, horizon: 0, whole: false, tasks, gone: [], changes: [], ...extra });
const changed = (prev: number, p: SyncPage): PushMessage => ({ type: "sync:changed", prev, page: p });

/** An engine answering from a list of pages, and views by a function; each call can be held back. */
function engine(views: (channel: string, request: unknown) => unknown = () => null) {
  const asked: Array<{ channel: string; request: unknown }> = [];
  let sinceAnswer: (since: number) => SyncPage = () => page(0, [], { whole: true });
  const gates: Array<() => void> = [];
  let holding = false;
  const io: SyncIo = {
    invoke: (async (channel: string, request: unknown) => {
      asked.push({ channel, request });
      if (holding) await new Promise<void>((r) => gates.push(r));
      if (channel === "sync:since") return sinceAnswer((request as { since: number }).since);
      const v = views(channel, request);
      if (v instanceof Error) throw v;
      return v;
    }) as SyncIo["invoke"],
  };
  return {
    io,
    asked,
    answerSince: (f: (since: number) => SyncPage) => (sinceAnswer = f),
    hold: () => (holding = true),
    release: () => {
      holding = false;
      for (const g of gates.splice(0)) g();
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("the index", () => {
  it("loads whole, then applies pages by upserting and dropping", async () => {
    const e = engine();
    e.answerSince(() => page(10, [task("t-a"), task("t-b")], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    expect(cache.tasks().map((t) => t.taskId).sort()).toEqual(["t-a", "t-b"]);
    cache.push(changed(10, page(12, [task("t-a", "renamed", 12)], { gone: ["t-b"] })));
    expect(cache.tasks().map((t) => [t.taskId, t.title])).toEqual([["t-a", "renamed"]]);
    expect(cache.cursor).toBe(12);
  });

  it("asks from its cursor when a push says one was missed, instead of applying it", async () => {
    const e = engine();
    e.answerSince((since) => (since === 0 ? page(10, [task("t-a")], { whole: true }) : page(20, [task("t-b", "made while away")])));
    const cache = new SyncCache(e.io);
    await cache.start();
    // A push whose prev (15) is past the cursor (10): the page from 10 to 15 never arrived.
    cache.push(changed(15, page(20, [task("t-c")])));
    await settle();
    expect(e.asked.filter((a) => a.channel === "sync:since").map((a) => (a.request as { since: number }).since)).toEqual([0, 10]);
    expect(cache.tasks().map((t) => t.taskId).sort()).toEqual(["t-a", "t-b"]);
    expect(cache.cursor).toBe(20);
  });

  it("is the same after duplicated and reordered pages", async () => {
    const e = engine();
    e.answerSince(() => page(10, [task("t-a")], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    const second = page(14, [task("t-a", "second", 14)]);
    const first = page(12, [task("t-a", "first", 12)]);
    cache.push(changed(12, second));
    cache.push(changed(10, first));
    cache.push(changed(12, second));
    expect(cache.cursor).toBe(14);
    // The page each summary came from decides: the newer one stands whatever order they came in.
    expect(cache.task("t-a")?.title).toBe("second");
  });

  it("recovers by reconciling alone, with nothing pushed at all", async () => {
    const e = engine();
    e.answerSince((since) => (since === 0 ? page(10, [], { whole: true }) : page(30, [task("t-late")])));
    const cache = new SyncCache(e.io);
    await cache.start();
    await cache.reconcile();
    expect(cache.tasks().map((t) => t.taskId)).toEqual(["t-late"]);
  });
});

describe("views", () => {
  it("are read when held, and read again when a page names their task — only theirs", async () => {
    let n = 0;
    const e = engine((channel, request) => ({ channel, taskId: (request as { taskId: string }).taskId, n: ++n }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [
      ["task:detail", { taskId: "t-a" }],
      ["task:detail", { taskId: "t-b" }],
    ]);
    await settle();
    const before = e.asked.length;
    cache.push(changed(10, page(11, [], { changes: [{ collection: "record", id: "r1", taskId: "t-a", at: 11, deleted: false }] })));
    await settle();
    expect(e.asked.slice(before).map((a) => (a.request as { taskId: string }).taskId)).toEqual(["t-a"]);
  });

  it("land under their own key: a late answer for one task never shows as another's", async () => {
    const e = engine((_, request) => ({ taskId: (request as { taskId: string }).taskId }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    e.hold();
    cache.hold("store", [["task:detail", { taskId: "t-a" }]]);
    cache.hold("store", [["task:detail", { taskId: "t-b" }]]);
    e.release();
    await settle();
    expect(cache.peek("task:detail", { taskId: "t-b" }).value).toEqual({ taskId: "t-b" });
    expect(cache.peek("task:detail", { taskId: "t-a" }).value).toEqual({ taskId: "t-a" });
  });

  it("are the same view whatever project a request names", async () => {
    const e = engine(() => ({ ok: true }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [["task:detail", { taskId: "t-a", project: "/wrong" }]]);
    await settle();
    expect(cache.peek("task:detail", { taskId: "t-a", project: "/right" }).value).toEqual({ ok: true });
  });

  it("read again after a change that arrived while they were being read", async () => {
    let n = 0;
    const e = engine(() => ({ n: ++n }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    e.hold();
    cache.hold("store", [["task:detail", { taskId: "t-a" }]]);
    cache.push(changed(10, page(11, [task("t-a")])));
    e.release();
    await settle();
    await settle();
    expect(cache.peek("task:detail", { taskId: "t-a" }).value).toEqual({ n: 2 });
  });

  it("are read ONCE when refreshed before anything has read them", async () => {
    // Opening a conversation refreshes its records and transcript as it first holds them: the read
    // that starts is the fresh one asked for, and reading again after it fetched 6.4 MB twice.
    const e = engine(() => ({ ok: true }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    const before = e.asked.length;
    await cache.refresh("run:records", { taskId: "t-a" });
    cache.hold("store", [["run:records", { taskId: "t-a" }]]);
    await settle();
    expect(e.asked.slice(before).map((a) => a.channel)).toEqual(["run:records"]);
    expect(cache.peek("run:records", { taskId: "t-a" }).value).toEqual({ ok: true });
  });

  it("are read again when refreshed during a read already under way, which may predate the change", async () => {
    let n = 0;
    const e = engine(() => ({ n: ++n }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    e.hold();
    cache.hold("store", [["task:detail", { taskId: "t-a" }]]);
    const refreshed = cache.refresh("task:detail", { taskId: "t-a" });
    e.release();
    await refreshed;
    expect(cache.peek("task:detail", { taskId: "t-a" }).value).toEqual({ n: 2 });
  });

  it("keep the error of a read that failed, instead of looking empty", async () => {
    const e = engine(() => new Error("unknown task 't-x'"));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [["task:detail", { taskId: "t-x" }]]);
    await settle();
    expect(cache.peek("task:detail", { taskId: "t-x" })).toEqual({ value: undefined, error: "unknown task 't-x'", loading: false });
  });

  it("are not read again once nothing holds them", async () => {
    const e = engine(() => ({}));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    const release = cache.acquire("task:detail", { taskId: "t-a" });
    await settle();
    release();
    const before = e.asked.length;
    cache.push(changed(10, page(11, [task("t-a")])));
    await settle();
    expect(e.asked.length).toBe(before);
  });
});

describe("views held still", () => {
  it("are read once, left alone while their task changes, and read when held live again", async () => {
    let n = 0;
    const e = engine(() => ({ n: ++n }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [], [["session:view", { taskId: "t-a" }]]);
    await settle();
    expect(cache.peek("session:view", { taskId: "t-a" }).value).toEqual({ n: 1 });
    cache.push(changed(10, page(11, [task("t-a")])));
    await settle();
    expect(cache.peek("session:view", { taskId: "t-a" }).value).toEqual({ n: 1 });
    cache.hold("store", [["session:view", { taskId: "t-a" }]]);
    await settle();
    expect(cache.peek("session:view", { taskId: "t-a" }).value).toEqual({ n: 2 });
  });
});

describe("a busy task", () => {
  it("has its views read at most twice a second while it changes, and once more after the last change", async () => {
    const e = engine(() => ({}));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [["task:detail", { taskId: "t-a" }]]);
    await settle();
    const reads = (): number => e.asked.filter((a) => a.channel === "task:detail").length;
    const before = reads();
    // Each page a new change to one of its records, as a streaming turn makes them.
    for (let i = 0; i < 20; i++) cache.push(changed(10 + i, page(11 + i, [task("t-a")], { changes: [{ collection: "record", id: "r-1", taskId: "t-a", at: 11 + i, deleted: false }] })));
    await settle();
    expect(reads() - before).toBe(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(reads() - before).toBe(2);
  });
});

describe("views about no one task", () => {
  it("are read again for the kinds of change they show, and a project's only for its own tasks", async () => {
    const e = engine(() => ({}));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [
      ["approval:pending", undefined],
      ["board:roots", { project: "/a" }],
    ]);
    await settle();
    const reads = (channel: string): number => e.asked.filter((a) => a.channel === channel).length;
    const before = { approvals: reads("approval:pending"), board: reads("board:roots") };
    // A record streamed in /b: neither moves.
    cache.push(changed(10, page(11, [{ ...task("t-b"), project: "/b" }], { changes: [{ collection: "record", id: "r", taskId: "t-b", at: 11, deleted: false }] })));
    await settle();
    expect(reads("approval:pending")).toBe(before.approvals);
    expect(reads("board:roots")).toBe(before.board);
    // A task of /a moved, and an approval was asked: both do.
    await new Promise((r) => setTimeout(r, 600));
    cache.push(
      changed(
        11,
        page(12, [{ ...task("t-a"), project: "/a" }], {
          changes: [
            { collection: "task", id: "t-a", taskId: "t-a", at: 12, deleted: false },
            { collection: "approval", id: "ap", taskId: "t-a", at: 12, deleted: false },
          ],
        }),
      ),
    );
    await settle();
    expect(reads("approval:pending")).toBe(before.approvals + 1);
    expect(reads("board:roots")).toBe(before.board + 1);
  });

  it("are read again when the workflow files change — every board held, and nothing else", async () => {
    const e = engine(() => ({}));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [
      ["board:roots", { project: "/a" }],
      ["board:view", { level: "feature", project: "/b" }],
      ["approval:pending", undefined],
    ]);
    await settle();
    const reads = (channel: string): number => e.asked.filter((a) => a.channel === channel).length;
    const before = { roots: reads("board:roots"), view: reads("board:view"), approvals: reads("approval:pending") };
    // A workflow switched off writes a file, and no page says so: its columns are read from the files.
    await new Promise((r) => setTimeout(r, 600));
    cache.filesChanged();
    await settle();
    expect(reads("board:roots")).toBe(before.roots + 1);
    expect(reads("board:view")).toBe(before.view + 1);
    expect(reads("approval:pending")).toBe(before.approvals);
  });

  it("include the settings pages', each read again only for its own kind of change (group 7)", async () => {
    const e = engine(() => ({}));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("settings", [
      ["limits:read", undefined],
      ["machines:view", undefined],
      ["forge:signIns", undefined],
      ["cli:status", undefined],
    ]);
    await settle();
    const reads = (channel: string): number => e.asked.filter((a) => a.channel === channel).length;
    const before = { limits: reads("limits:read"), machines: reads("machines:view"), forge: reads("forge:signIns"), cli: reads("cli:status") };
    // The engine logged a limits change: the limits are read again, and nothing else is.
    cache.push(changed(10, page(11, [], { changes: [{ collection: "limits", id: "limits", taskId: null, at: 11, deleted: false }] })));
    await settle();
    expect(reads("limits:read")).toBe(before.limits + 1);
    expect(reads("machines:view")).toBe(before.machines);
    expect(reads("forge:signIns")).toBe(before.forge);
    // A configuration change moves the sign-ins, and the command's status is read by nothing a page brings.
    cache.push(changed(11, page(12, [], { changes: [{ collection: "config", id: "config", taskId: null, at: 12, deleted: false }] })));
    await settle();
    expect(reads("forge:signIns")).toBe(before.forge + 1);
    expect(reads("cli:status")).toBe(before.cli);
  });
});

describe("reading again now", () => {
  it("answers only once the view is current, when a read was already under way", async () => {
    let n = 0;
    const e = engine(() => ({ n: ++n }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    e.hold();
    cache.hold("store", [["task:detail", { taskId: "t-a" }]]);
    const now = cache.refresh("task:detail", { taskId: "t-a" });
    let answered = false;
    void now.then(() => (answered = true));
    await settle();
    expect(answered).toBe(false);
    e.release();
    await now;
    expect(cache.peek("task:detail", { taskId: "t-a" }).value).toEqual({ n: 2 });
  });
});

describe("keys", () => {
  it("leave a task's guessed project out, and keep the project of a view about a project", async () => {
    const e = engine((channel, request) => ({ channel, project: (request as { project?: string }).project }));
    e.answerSince(() => page(10, [], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [
      ["board:roots", { project: "/a" }],
      ["board:roots", { project: "/b" }],
    ]);
    await settle();
    expect(cache.peek("board:roots", { project: "/a" }).value).toEqual({ channel: "board:roots", project: "/a" });
    expect(cache.peek("board:roots", { project: "/b" }).value).toEqual({ channel: "board:roots", project: "/b" });
  });
});

describe("a view read again", () => {
  it("keeps its object when the engine answers the same, and each part that did not move when it answers otherwise", async () => {
    let answer: unknown = { title: "a", turns: [{ id: 1, text: "hello" }, { id: 2, text: "there" }], meta: { n: 1 } };
    const e = engine(() => structuredClone(answer));
    const cache = new SyncCache(e.io);
    cache.acquire("task:detail", { taskId: "t-a" });
    await settle();
    const first = cache.peek("task:detail", { taskId: "t-a" }).value as unknown as { turns: unknown[]; meta: unknown };
    expect(first).toEqual(answer);

    await cache.refresh("task:detail", { taskId: "t-a" });
    expect(cache.peek("task:detail", { taskId: "t-a" }).value).toBe(first);

    answer = { title: "a", turns: [{ id: 1, text: "hello" }, { id: 2, text: "there!" }], meta: { n: 1 } };
    await cache.refresh("task:detail", { taskId: "t-a" });
    const second = cache.peek("task:detail", { taskId: "t-a" }).value as unknown as { turns: unknown[]; meta: unknown };
    expect(second).not.toBe(first);
    expect(second).toEqual(answer);
    expect(second.turns[0]).toBe(first.turns[0]);
    expect(second.turns[1]).not.toBe(first.turns[1]);
    expect(second.meta).toBe(first.meta);
  });
});

describe("sharedWith", () => {
  it("answers the old value when equal, the new one where it differs, and old parts where they match", () => {
    const was = { a: [1, { b: 2 }], c: "x" };
    expect(sharedWith(was, { a: [1, { b: 2 }], c: "x" })).toBe(was);
    const grown = sharedWith(was, { a: [1, { b: 2 }, 3], c: "x" }) as typeof was;
    expect(grown).toEqual({ a: [1, { b: 2 }, 3], c: "x" });
    expect(grown.a[1]).toBe(was.a[1]);
    const fewer = sharedWith(was, { a: [1, { b: 2 }] }) as Record<string, unknown>;
    expect(fewer).toEqual({ a: [1, { b: 2 }] });
    expect(fewer["a"]).toBe(was.a);
    expect(sharedWith([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(sharedWith(null, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("telling the readers", () => {
  it("tells them once for the changes that land together, a moment after, with peek current at once", async () => {
    const e = engine();
    e.answerSince(() => page(10, [task("t-a")], { whole: true }));
    const cache = new SyncCache(e.io);
    await cache.start();
    await new Promise((r) => setTimeout(r, 30));
    let told = 0;
    cache.subscribe(() => (told += 1));
    cache.push(changed(10, page(11, [task("t-a", "one", 11)])));
    cache.push(changed(11, page(12, [task("t-a", "two", 12)])));
    expect(cache.task("t-a")?.title).toBe("two");
    expect(told).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(told).toBe(1);
  });
});

describe("the rows at the cursor, brought again", () => {
  it("read nothing again — a new change does", async () => {
    const e = engine(() => ({ n: 1 }));
    const rec = (at: number) => ({ collection: "record", id: "r-1", taskId: "t-a", at, deleted: false });
    let next = page(10, [task("t-a")], { whole: true });
    e.answerSince(() => next);
    const cache = new SyncCache(e.io);
    await cache.start();
    cache.hold("store", [["task:detail", { taskId: "t-a" }]]);
    await settle();
    const reads = (): number => e.asked.filter((a) => a.channel === "task:detail").length;
    const before = reads();
    // A change at 12: read. Asked again from 12, the same change comes again: nothing is read.
    next = page(12, [task("t-a")], { changes: [rec(12)] });
    await cache.reconcile();
    await new Promise((r) => setTimeout(r, 600));
    expect(reads() - before).toBe(1);
    await cache.reconcile();
    await cache.reconcile();
    await new Promise((r) => setTimeout(r, 600));
    expect(reads() - before).toBe(1);
    // The same row changed again, at a new stamp: read.
    next = page(15, [task("t-a")], { changes: [rec(15)] });
    await cache.reconcile();
    await new Promise((r) => setTimeout(r, 600));
    expect(reads() - before).toBe(2);
  });

  it("keep a task's summary its object when it is the same", async () => {
    const e = engine();
    let next = page(10, [task("t-a", "one")], { whole: true });
    e.answerSince(() => next);
    const cache = new SyncCache(e.io);
    await cache.start();
    const was = cache.task("t-a");
    next = page(11, [task("t-a", "one")], { changes: [{ collection: "event", id: "1", taskId: "t-a", at: 11, deleted: false }] });
    await cache.reconcile();
    expect(cache.task("t-a")).toBe(was);
    next = page(12, [task("t-a", "two")], { changes: [{ collection: "event", id: "2", taskId: "t-a", at: 12, deleted: false }] });
    await cache.reconcile();
    expect(cache.task("t-a")?.title).toBe("two");
  });
});

describe("views held together for the first time", () => {
  it("are shown together, when the slowest has answered", async () => {
    const e = engine((channel, request) => ({ board: (request as { project: string }).project }));
    const cache = new SyncCache(e.io);
    await cache.start();
    e.hold();
    cache.hold("place", [
      ["board:roots", { project: "/a" }],
      ["board:roots", { project: "/b" }],
    ]);
    await settle();
    expect(cache.peek("board:roots", { project: "/a" }).value).toBeUndefined();
    e.release();
    await settle();
    expect(cache.peek("board:roots", { project: "/a" }).value).toEqual({ board: "/a" });
    expect(cache.peek("board:roots", { project: "/b" }).value).toEqual({ board: "/b" });
  });

  it("show what they have after a while, and a refresh of one answers once its group is shown", async () => {
    let slow: (() => void) | undefined;
    const io: SyncIo = {
      invoke: (async (channel: string, request: unknown) => {
        if (channel === "sync:since") return page(1, [], { whole: true });
        if ((request as { project: string }).project === "/slow") await new Promise<void>((r) => (slow = r));
        return { board: (request as { project: string }).project };
      }) as SyncIo["invoke"],
    };
    const cache = new SyncCache(io);
    await cache.start();
    cache.hold("place", [
      ["board:roots", { project: "/a" }],
      ["board:roots", { project: "/slow" }],
    ]);
    let refreshed = false;
    void cache.refresh("board:roots", { project: "/a" }).then(() => (refreshed = true));
    await settle();
    expect(cache.peek("board:roots", { project: "/a" }).value).toBeUndefined();
    expect(refreshed).toBe(false);
    await new Promise((r) => setTimeout(r, 450));
    expect(cache.peek("board:roots", { project: "/a" }).value).toEqual({ board: "/a" });
    expect(refreshed).toBe(true);
    slow?.();
    await settle();
    expect(cache.peek("board:roots", { project: "/slow" }).value).toEqual({ board: "/slow" });
  });
});

describe("a page asked before a view was", () => {
  it("reads nothing again of that view: its answer is as of the page or later", async () => {
    const e = engine(() => ({ n: 1 }));
    e.answerSince(() => page(10, [task("t-a")], { whole: true }));
    const cache = new SyncCache(e.io);
    e.hold();
    const started = cache.start();
    await settle();
    // The views the window holds are asked while the first whole page is still out.
    cache.hold("place", [["project:list", undefined]]);
    e.release();
    await started;
    await new Promise((r) => setTimeout(r, 50));
    expect(e.asked.filter((a) => a.channel === "project:list")).toHaveLength(1);
  });
});
