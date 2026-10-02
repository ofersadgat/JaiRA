/**
 * The repository watcher's memory (decision 0010 §2) and the event hub's durable wait starts (§3):
 * one cursor per (remote, repository), one last-seen row per (kind, key), both surviving a reopen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type JairaDb } from "../src/db";
import { EventWaitStore, RepoWatchStore } from "../src/repoWatch";

let db: JairaDb;
let now: number;
let store: RepoWatchStore;
const origin = { remote: "origin", repository: "github.com/acme/app" };

beforeEach(() => {
  db = openDb(":memory:");
  now = 1_000;
  store = new RepoWatchStore(db, "w", () => now);
});
afterEach(() => db.close());

describe("repository watcher memory", () => {
  it("has no cursor for a remote never looked at — which is what makes the first look a baseline", () => {
    expect(store.cursor(origin)).toBeUndefined();
    expect(store.seenAll(origin, "branch").size).toBe(0);
  });

  it("keeps one cursor per remote and repository, replaced whole", () => {
    store.setCursor(origin, { mergeRequests: { since: "2026-09-25T10:00:00Z" }, branches: true });
    store.setCursor({ ...origin, repository: "github.com/acme/other" }, { pipelines: true });
    store.setCursor(origin, { mergeRequests: { since: "2026-09-25T11:00:00Z" }, branches: true, etags: { "/pulls": 'W/"1"' } });
    expect(store.cursor(origin)).toEqual({ mergeRequests: { since: "2026-09-25T11:00:00Z" }, branches: true, etags: { "/pulls": 'W/"1"' } });
    expect(store.cursor({ ...origin, repository: "github.com/acme/other" })).toEqual({ pipelines: true });
    // Same repository under another remote name is another remote.
    expect(store.cursor({ ...origin, remote: "upstream" })).toBeUndefined();
  });

  it("records a poll's error, keeps it until cleared, and leaves it alone when a write says nothing of it", () => {
    store.setCursor(origin, { branches: true }, "the forge answered 502");
    expect(store.lastError(origin)).toBe("the forge answered 502");
    store.setCursor(origin, { branches: true });
    expect(store.lastError(origin)).toBe("the forge answered 502");
    store.setCursor(origin, { branches: true }, null);
    expect(store.lastError(origin)).toBeUndefined();
  });

  it("keeps the last seen state per kind and key, and forgets one", () => {
    store.see(origin, "branch", "main", { head: "a1" });
    store.see(origin, "branch", "release/2.0", { head: "b1" });
    store.see(origin, "pipelines", "main", { sha: "a1", done: false, since: 5 });
    store.see(origin, "merge_request", "12", { state: "open", head: "c1", title: "Fix", description: "d", updatedAt: "t", commentsAt: "t" });
    store.see(origin, "branch", "main", { head: "a2" });
    expect(store.seen(origin, "branch", "main")).toEqual({ head: "a2" });
    expect([...store.seenAll(origin, "branch").entries()]).toEqual([
      ["main", { head: "a2" }],
      ["release/2.0", { head: "b1" }],
    ]);
    expect(store.seen(origin, "pipelines", "main")).toEqual({ sha: "a1", done: false, since: 5 });
    expect(store.seen(origin, "merge_request", "12")?.state).toBe("open");
    store.forget(origin, "branch", "release/2.0");
    expect(store.seen(origin, "branch", "release/2.0")).toBeUndefined();
    // Kinds do not collide on a key.
    expect(store.seen(origin, "pipelines", "main")).toBeDefined();
  });

  it("reads the same from a process that was not there", () => {
    store.setCursor(origin, { branches: true });
    store.see(origin, "branch", "main", { head: "a1" });
    const later = new RepoWatchStore(db, "w", () => 99);
    expect(later.cursor(origin)).toEqual({ branches: true });
    expect(later.seen(origin, "branch", "main")).toEqual({ head: "a1" });
  });

  it("refuses a kind that is not one", () => {
    expect(() => store.see(origin, "tag" as never, "v1", { head: "x" } as never)).toThrow();
  });
});

describe("event waits", () => {
  it("keeps the FIRST wait's start per task and name, and ends a task's all at once", () => {
    const waits = new EventWaitStore(db);
    expect(waits.since("t-1", "git.pushed")).toBeUndefined();
    waits.open("t-1", "git.pushed", 100);
    waits.open("t-1", "git.pushed", 200);
    waits.open("t-1", "task.finished", 300);
    waits.open("t-2", "git.pushed", 400);
    expect(waits.since("t-1", "git.pushed")).toBe(100);
    expect(waits.since("t-1", "task.finished")).toBe(300);
    waits.closeTask("t-1");
    expect(waits.since("t-1", "git.pushed")).toBeUndefined();
    expect(waits.since("t-2", "git.pushed")).toBe(400);
  });
});
