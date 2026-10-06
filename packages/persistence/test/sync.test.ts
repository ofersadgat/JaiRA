/**
 * The change log every reader syncs from (decision 0018 §3–§5, `sync.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type JairaDb } from "../src/db";
import { changesSince, pruneTombstones, syncHorizon, syncNow, touch } from "../src/sync";
import { shadowTable } from "../src/shadow";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-sync-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const runtime = (taskId: string, status = "queued"): void =>
  void db
    .prepare(`INSERT INTO task_runtime (task_id, status, snapshot_hash, created_at, updated_at) VALUES (?, ?, 'h', 1, 1)`)
    .run(taskId, status);
const event = (taskId: string): number =>
  Number(db.prepare(`INSERT INTO state_machine_events (task_id, type, payload_json, created_at) VALUES (?, 'x', '{}', 1)`).run(taskId).lastInsertRowid);

describe("the change log", () => {
  it("is written by every insert, update and delete of a table a reader reads, by the database itself", () => {
    runtime("t-a");
    const seq = event("t-a");
    db.prepare(`UPDATE task_runtime SET status = 'running' WHERE task_id = 't-a'`).run();
    db.prepare(`DELETE FROM state_machine_events WHERE seq = ?`).run(seq);
    const log = changesSince(db, 0);
    expect(log.map((c) => [c.collection, c.id, c.taskId, c.deleted])).toEqual([
      ["task", "t-a", "t-a", false],
      ["event", String(seq), "t-a", true],
    ]);
  });

  it("keeps one entry per row, at the time it last changed", () => {
    runtime("t-a");
    const first = changesSince(db, 0)[0]!.at;
    db.prepare(`UPDATE task_runtime SET status = 'running' WHERE task_id = 't-a'`).run();
    const log = changesSince(db, 0);
    expect(log).toHaveLength(1);
    expect(log[0]!.at).toBeGreaterThanOrEqual(first);
  });

  it("is read from a cursor inclusively, so rows at the cursor's time come again", () => {
    runtime("t-a");
    const at = syncNow(db);
    expect(changesSince(db, at).map((c) => c.id)).toEqual(["t-a"]);
    expect(changesSince(db, at + 1)).toEqual([]);
  });

  it("never stamps behind the newest entry, whatever the wall clock says", () => {
    // A clock stepped back: an entry from "the future" is already in the log.
    const future = Date.now() + 60 * 60 * 1000;
    db.prepare(`INSERT INTO sync_changes (collection, id, task_id, at, deleted) VALUES ('task', 't-old', 't-old', ?, 0)`).run(future);
    runtime("t-a");
    expect(changesSince(db, future).map((c) => c.id).sort()).toEqual(["t-a", "t-old"]);
  });

  it("ignores a job's heartbeat, and records its end", () => {
    const id = Number(
      db.prepare(`INSERT INTO jobs (kind, task_id, owner_token, started_at, heartbeat_at) VALUES ('process', 't-a', 'o', 1, 1)`).run().lastInsertRowid,
    );
    const at = syncNow(db);
    db.prepare(`DELETE FROM sync_changes`).run();
    db.prepare(`UPDATE jobs SET heartbeat_at = 2 WHERE id = ?`).run(id);
    expect(changesSince(db, 0)).toEqual([]);
    db.prepare(`UPDATE jobs SET ended_at = 3, outcome = 'ok' WHERE id = ?`).run(id);
    expect(changesSince(db, at).map((c) => [c.collection, c.id])).toEqual([["job", String(id)]]);
  });

  it("is read for one task, or for some collections", () => {
    runtime("t-a");
    runtime("t-b");
    event("t-b");
    expect(changesSince(db, 0, { taskId: "t-b" }).map((c) => c.collection).sort()).toEqual(["event", "task"]);
    expect(changesSince(db, 0, { collections: ["event"] }).map((c) => c.taskId)).toEqual(["t-b"]);
  });

  it("takes what the database does not hold from the code, on the same clock", () => {
    runtime("t-a");
    const before = syncNow(db);
    touch(db, "approval", "ap-1", "t-a");
    touch(db, "approval", "ap-1", "t-a", true);
    const entry = changesSince(db, before, { collections: ["approval"] });
    expect(entry).toEqual([{ collection: "approval", id: "ap-1", taskId: "t-a", at: expect.any(Number), deleted: true }]);
    expect(entry[0]!.at).toBeGreaterThanOrEqual(before);
  });

  it("leaves a tombstone for a row an INSERT OR REPLACE removes", () => {
    // An artifact replayed under a new id over the same (task, path): the old id is gone, and says so.
    const put = (id: number): void =>
      void db
        .prepare(`INSERT OR REPLACE INTO artifacts (id, task_id, logical_path, hash, bytes, created_at) VALUES (?, 't-a', 'out.md', 'h', 1, 1)`)
        .run(id);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS test_artifact_path ON artifacts(task_id, logical_path)`);
    put(1);
    put(2);
    expect(changesSince(db, 0, { collections: ["artifact"] }).map((c) => [c.id, c.deleted])).toEqual([
      ["1", true],
      ["2", false],
    ]);
  });

  it("sees writes to a table standing behind a file-backed concern's TEMP copy", () => {
    expect(shadowTable(db, "state_machine_events")).toBe(true);
    event("t-a");
    expect(changesSince(db, 0, { collections: ["event"] }).map((c) => c.taskId)).toEqual(["t-a"]);
  });

  it("drops old tombstones and raises the horizon past them, keeping every live row's entry", () => {
    runtime("t-a");
    runtime("t-b");
    db.prepare(`DELETE FROM task_runtime WHERE task_id = 't-b'`).run();
    expect(syncHorizon(db)).toBe(0);
    const deletedAt = changesSince(db, 0).find((c) => c.id === "t-b")!.at;
    expect(pruneTombstones(db, 0, deletedAt + 1)).toBe(1);
    expect(syncHorizon(db)).toBe(deletedAt);
    expect(changesSince(db, 0).map((c) => c.id)).toEqual(["t-a"]);
  });
});
