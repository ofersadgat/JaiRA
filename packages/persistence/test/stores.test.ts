import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { openDb, type JairaDb } from "../src/db";
import { SqliteEventLog } from "../src/eventLog";
import { RuntimeStore } from "../src/runtime";
import { TaskFileStore } from "../src/taskStore";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-store-"));
  db = openDb(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("RuntimeStore", () => {
  it("inserts queued rows and updates status/snapshot", () => {
    const store = new RuntimeStore(db);
    store.insert("t-1", 1000);
    expect(store.get("t-1")).toMatchObject({ taskId: "t-1", status: "queued", createdAt: 1000 });
    store.setStatus("t-1", "running", 2000);
    store.setSnapshot("t-1", "abc123", 2000);
    expect(store.get("t-1")).toMatchObject({ status: "running", snapshotHash: "abc123", updatedAt: 2000 });
    expect(store.get("t-none")).toBeUndefined();
    expect(() => store.setStatus("t-none", "running", 1)).toThrow(/no task_runtime row/);
  });

  it("tracks the machine's one execution on the task row", () => {
    const store = new RuntimeStore(db);
    store.insert("t-1", 1000);
    store.beginTask("t-1", "hash1", 1100);
    store.endTask("t-1", "success", 1200, { outputsJson: '{"x":1}' });
    expect(store.get("t-1")).toMatchObject({ outcome: "success", outputsJson: '{"x":1}', startedAt: 1100, endedAt: 1200 });
    // A resume re-stamps the same row: how the LAST stretch ended is cleared while it runs.
    store.beginTask("t-1", "hash1", 1300);
    expect(store.get("t-1")).toMatchObject({ startedAt: 1300, outcome: undefined, endedAt: undefined, outputsJson: undefined });
  });

  it("recovery marks running tasks interrupted and closes their dangling runs", () => {
    const store = new RuntimeStore(db);
    store.insert("t-running", 1000);
    store.setStatus("t-running", "running", 1001);
    store.beginTask("t-running", "h", 1001);
    store.insert("t-queued", 1000);
    store.insert("t-done", 1000);
    store.setStatus("t-done", "completed", 1002);

    const recovered = store.recoverInterrupted(2000);
    expect(recovered).toEqual(["t-running"]);
    expect(store.get("t-running")?.status).toBe("interrupted");
    expect(store.get("t-running")).toMatchObject({ outcome: "interrupted", endedAt: 2000 });
    expect(store.get("t-queued")?.status).toBe("queued");
    expect(store.get("t-done")?.status).toBe("completed");
  });

  it("recovery settles the crashed task's open records, keeping their streamed partials", () => {
    // 'open' means "a live process is streaming into this row" — the state signal the record readers
    // key on — and after a crash no such process exists. The partial result_json survives the flip:
    // those turns really were exchanged before the process died.
    const store = new RuntimeStore(db);
    store.insert("t-crash", 1000);
    store.setStatus("t-crash", "running", 1001);
    store.beginTask("t-crash", "h", 1001);
    store.insert("t-live", 1000);
    store.setStatus("t-live", "running", 1001);
    db.prepare(
      `INSERT INTO operation_records (id, task_id, status, result_json, started_at)
       VALUES ('s:0#crash', 't-crash', 'open', '{"value":{"messages":[{"role":"assistant","content":"partial"}]}}', 1001)`,
    ).run();
    db.prepare(
      `INSERT INTO operation_records (id, task_id, status, started_at)
       VALUES ('s:0#live', 't-live', 'open', 1001)`,
    ).run();

    store.recoverInterrupted(2000, (taskId) => taskId === "t-live");

    expect(db.prepare(`SELECT status, ended_at, result_json, error_json FROM operation_records WHERE task_id = 't-crash'`).get()).toEqual({
      status: "interrupted",
      ended_at: 2000,
      result_json: '{"value":{"messages":[{"role":"assistant","content":"partial"}]}}',
      error_json: JSON.stringify({ reason: "interrupted: the process ended before this call settled" }),
    });
    // A task another process still drives is left alone — records included.
    expect(db.prepare(`SELECT status FROM operation_records WHERE task_id = 't-live'`).get()).toEqual({ status: "open" });
  });
});

describe("SqliteEventLog", () => {
  it("records EngineEvents through the Persistence port and lists them back", () => {
    const runtime = new RuntimeStore(db);
    runtime.insert("t-1", 1000);
    const log = new SqliteEventLog(db);

    const entered: EngineEvent = { type: "instance.entered", instanceId: "1", stateId: "wf", inputs: { x: 1 } };
    const terminated: EngineEvent = { type: "instance.terminated", instanceId: "1", stateId: "wf", outcome: "success" };
    log.recorder("t-1").record(entered, 1500);
    log.recorder("t-1").record(terminated, 2500);

    const all = log.list("t-1");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ type: "instance.entered", instanceId: "1", createdAt: 1500 });
    expect(all[0]?.event).toEqual(entered);
    expect(log.list("t-1", { afterSeq: all[0]!.seq })).toHaveLength(1);
    expect(log.list("t-other")).toHaveLength(0);
  });
});

describe("TaskFileStore", () => {
  it("writes and reads task metadata JSON files", () => {
    const store = new TaskFileStore(join(dir, "tasks"));
    const meta = {
      id: "t-abcdefghij",
      title: "Do the thing",
      workflow: "feature/plan",
      inputs: { issue: "text" },
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    store.write(meta);
    expect(store.read("t-abcdefghij")).toEqual(meta);
    expect(store.tryRead("t-missing")).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(() => store.read("t-missing")).toThrow(/no task file/);
  });
});
