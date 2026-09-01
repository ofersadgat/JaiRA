/**
 * History pruning (SPEC §13, DESIGN §12). The property under test is the safety
 * rule, not the deletion: "a task cannot prune data required to resume its current
 * active state". Since the `events` journal *is* JaiRA's load and projection
 * source, that means a non-terminal task is untouchable at any age.
 *
 * A task is one machine since the runs collapse, so the unit of pruning is the
 * task's history — its journal and audit — while the task itself (its row, its
 * outcome) stays for the board to say what happened.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import type { EngineEvent } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { historySize, pruneHistory } from "../src/prune";

let dir: string;
let project: Project;

const HOUR = 3_600_000;
const now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-prune-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const entered = (id: string, stateId: string): EngineEvent => ({
  type: "instance.entered",
  instanceId: id,
  stateId,
  inputs: {},
});

/** A task whose machine ran once and ended `age` ago (or is still open, for running/interrupted). */
function seedTask(taskId: string, status: "completed" | "failed" | "canceled" | "running" | "interrupted", age: number): void {
  project.runtime.insert(taskId, now - 10 * HOUR);
  project.runtime.beginTask(taskId, "hash", now - age - HOUR);
  const recorder = project.events.recorder(taskId);
  recorder.record(entered("i-1", "wf"), now - age - HOUR);
  recorder.record({ type: "instance.terminated", instanceId: "i-1", stateId: "wf", outcome: "success" }, now - age);
  project.commands.record({ taskId, tool: "bash", command: "git status", decision: "allowed", decidedBy: "policy" });
  // A `running`/`interrupted` task keeps its machine open, like a real crash.
  const open = status === "running" || status === "interrupted";
  if (!open) project.runtime.endTask(taskId, "success", now - age);
  project.runtime.setStatus(taskId, status, now);
}

describe("the §13 safety rule", () => {
  it("never prunes a running or interrupted task, however old", () => {
    seedTask("t-running", "running", 50 * HOUR);
    seedTask("t-interrupted", "interrupted", 50 * HOUR);
    const before = historySize(project);

    const result = pruneHistory(project, { before: now });

    expect(result.tasks).toEqual([]);
    expect(historySize(project)).toEqual(before);
    expect(result.skippedTasks.map((s) => s.taskId).sort()).toEqual(["t-interrupted", "t-running"]);
    // An interrupted task is resumable — precisely the case §13 protects.
    expect(result.skippedTasks.find((s) => s.taskId === "t-interrupted")!.reason).toMatch(/required to resume/);
  });

  it("keeps a queued task's rows too — it has not run yet", () => {
    project.runtime.insert("t-queued", now - HOUR);
    const result = pruneHistory(project, { before: now });
    expect(result.skippedTasks.map((s) => s.taskId)).toEqual(["t-queued"]);
  });
});

describe("what pruning deletes", () => {
  it("drops a terminal task's journal and command log, and keeps the task itself", () => {
    seedTask("t-done", "completed", 40 * HOUR);
    expect(historySize(project)).toMatchObject({ tasks: 1, events: 2, commands: 1 });

    const result = pruneHistory(project, { before: now });

    expect(result.tasks.map((t) => t.taskId)).toEqual(["t-done"]);
    expect(result.events).toBe(2);
    expect(result.commands).toBe(1);
    // The how is gone; the what remains — the row still says the machine succeeded.
    expect(historySize(project)).toMatchObject({ tasks: 1, events: 0, commands: 0 });
    expect(project.runtime.get("t-done")?.outcome).toBe("success");
  });

  it("respects the age cutoff", () => {
    seedTask("t-old", "completed", 40 * HOUR);
    seedTask("t-fresh", "completed", 2 * HOUR);
    // Only tasks whose machine ended more than 24h ago.
    const result = pruneHistory(project, { before: now - 24 * HOUR });
    expect(result.tasks.map((t) => t.taskId)).toEqual(["t-old"]);
    expect(historySize(project)).toMatchObject({ events: 2, commands: 1 });
  });
});

describe("dryRun", () => {
  it("reports the plan without deleting anything", () => {
    seedTask("t-done", "completed", 40 * HOUR);
    const before = historySize(project);

    const plan = pruneHistory(project, { before: now, dryRun: true });

    expect(plan.dryRun).toBe(true);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.events).toBe(2);
    // Pruning history is not undoable, so a UI must be able to show the cost first.
    expect(historySize(project)).toEqual(before);
  });
});

describe("integrity", () => {
  it("leaves no orphaned rows and passes SQLite's own FK check", () => {
    seedTask("t-a", "completed", 40 * HOUR);
    seedTask("t-b", "failed", 50 * HOUR);
    seedTask("t-c", "running", 50 * HOUR);

    pruneHistory(project, { before: now });

    const orphanOutput = (
      project.db
        .prepare(`SELECT COUNT(*) n FROM job_output WHERE job_id NOT IN (SELECT id FROM jobs)`)
        .get() as { n: number }
    ).n;
    expect(orphanOutput).toBe(0);
    expect(project.db.pragma("foreign_key_check")).toEqual([]);
  });
});
