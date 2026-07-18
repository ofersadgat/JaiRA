import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@ai-exec/hw";
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

  it("tracks runs per task", () => {
    const store = new RuntimeStore(db);
    store.insert("t-1", 1000);
    const run1 = store.beginRun("t-1", "hash1", 1100);
    store.endRun(run1, "success", 1200, { outputsJson: '{"x":1}' });
    const run2 = store.beginRun("t-1", "hash1", 1300);
    const runs = store.listRuns("t-1");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ id: run1, outcome: "success", outputsJson: '{"x":1}', endedAt: 1200 });
    expect(runs[1]).toMatchObject({ id: run2, outcome: undefined, endedAt: undefined });
  });

  it("recovery marks running tasks interrupted and closes their dangling runs", () => {
    const store = new RuntimeStore(db);
    store.insert("t-running", 1000);
    store.setStatus("t-running", "running", 1001);
    store.beginRun("t-running", "h", 1001);
    store.insert("t-queued", 1000);
    store.insert("t-done", 1000);
    store.setStatus("t-done", "completed", 1002);

    const recovered = store.recoverInterrupted(2000);
    expect(recovered).toEqual(["t-running"]);
    expect(store.get("t-running")?.status).toBe("interrupted");
    expect(store.listRuns("t-running")[0]).toMatchObject({ outcome: "interrupted", endedAt: 2000 });
    expect(store.get("t-queued")?.status).toBe("queued");
    expect(store.get("t-done")?.status).toBe("completed");
  });
});

describe("SqliteEventLog", () => {
  it("records EngineEvents through the Persistence port and lists them back", () => {
    const runtime = new RuntimeStore(db);
    runtime.insert("t-1", 1000);
    const run1 = runtime.beginRun("t-1", "h", 1000);
    const run2 = runtime.beginRun("t-1", "h", 2000);
    const log = new SqliteEventLog(db);

    const entered: EngineEvent = { type: "instance.entered", instanceId: 1, stateId: "wf", inputs: { x: 1 } };
    const terminated: EngineEvent = { type: "instance.terminated", instanceId: 1, stateId: "wf", outcome: "success" };
    log.recorder("t-1", run1).record(entered, 1500);
    log.recorder("t-1", run2).record(terminated, 2500);

    const all = log.list("t-1");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ runId: run1, type: "instance.entered", instanceId: 1, createdAt: 1500 });
    expect(all[0]?.event).toEqual(entered);
    expect(log.list("t-1", { runId: run2 })).toHaveLength(1);
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
