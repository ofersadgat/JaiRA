/**
 * `remote_handles` (decision 0004): one row per (task, key), and the three things that rest on it —
 * a loop's next pass gets the SAME request, only awaited rows are ever polled, and a quiet window is
 * a timestamp that a restart neither loses nor extends.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type JairaDb } from "../src/db";
import { RemoteHandleStore } from "../src/remoteHandles";

let db: JairaDb;
let now: number;
let store: RemoteHandleStore;
const identity = { taskId: "t-1", key: "review", provider: "gitlab" as const, host: "gitlab.com", project: "mistlabs/jaira", remote: "origin", branch: "jaira/t-1/review", target: "main" };

beforeEach(() => {
  db = openDb(":memory:");
  now = 1_000;
  store = new RemoteHandleStore(db, () => now);
});
afterEach(() => db.close());

describe("remote handles", () => {
  it("makes a row once: the second pass of a loop gets the first pass's request back, number and all", () => {
    store.ensure(identity);
    store.update("t-1", "review", { number: 41, url: "https://gitlab.com/mistlabs/jaira/-/merge_requests/41", pushedHead: "abc" });
    now = 2_000;
    // The same key again, even with a different idea of the branch: nothing is overwritten.
    const again = store.ensure({ ...identity, branch: "somewhere/else", target: "develop" });
    expect(again).toMatchObject({ number: 41, branch: "jaira/t-1/review", target: "main", pushedHead: "abc", createdAt: 1_000 });
  });

  it("keeps two keys of one task apart, and two tasks with one key apart", () => {
    store.ensure(identity);
    store.ensure({ ...identity, key: "review#feature/impl[1]", branch: "jaira/t-1/review-feature/impl-1" });
    store.ensure({ ...identity, taskId: "t-2", branch: "jaira/t-2/review" });
    expect(store.forTask("t-1").map((r) => r.key)).toEqual(["review", "review#feature/impl[1]"]);
    expect(store.forTask("t-2")).toHaveLength(1);
  });

  it("polls nothing while nothing is parked — and a pushed branch with no request is not something to watch", () => {
    store.ensure(identity);
    expect(store.awaiting()).toEqual([]);
    store.update("t-1", "review", { awaiting: true });
    expect(store.awaiting()).toEqual([]);
    store.update("t-1", "review", { number: 41, url: "u" });
    expect(store.awaiting().map((r) => r.number)).toEqual([41]);
    store.stopAwaiting("t-1");
    expect(store.awaiting()).toEqual([]);
  });

  it("stores the quiet window as a timestamp, so it reads the same from a process that was not there", () => {
    store.ensure(identity);
    store.update("t-1", "review", { number: 41, url: "u", settleAt: 601_000, settleAfterMs: 600_000, seen: ["n1", "n2"], cursor: { since: "2026-09-19T00:00:00.000Z" }, requestId: "ui-7", awaiting: true });
    const later = new RemoteHandleStore(db, () => 999_999);
    expect(later.get("t-1", "review")).toMatchObject({ settleAt: 601_000, settleAfterMs: 600_000, seen: ["n1", "n2"], cursor: { since: "2026-09-19T00:00:00.000Z" } });
    expect(later.byRequest("ui-7")?.key).toBe("review");
    // An explicit act clears the window: `null` and not merely "leave it".
    later.update("t-1", "review", { settleAt: null });
    expect(later.get("t-1", "review")!.settleAt).toBeUndefined();
  });

  it("survives a cursor that will not parse — losing it costs one read, not the request", () => {
    store.ensure(identity);
    db.prepare(`UPDATE remote_handles SET cursor_json = 'not json', seen_json = '{' WHERE task_id = 't-1'`).run();
    expect(store.get("t-1", "review")).toMatchObject({ cursor: {}, seen: [] });
  });
});
