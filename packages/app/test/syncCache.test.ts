/**
 * The window's store of engine data (decision 0018, `syncCache.ts`), against a fake engine that can
 * lose, delay, duplicate and reorder what it sends.
 */
import { describe, expect, it } from "vitest";
import type { ProjectTask, PushMessage, SyncPage } from "@jaira/shared";
import { SyncCache, type SyncIo } from "../src/renderer/syncCache";

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
    for (let i = 0; i < 20; i++) cache.push(changed(10 + i, page(11 + i, [task("t-a")])));
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
