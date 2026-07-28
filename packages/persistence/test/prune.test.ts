/**
 * History pruning (SPEC §13, DESIGN §12). The property under test is the safety
 * rule, not the deletion: "a task cannot prune data required to resume its current
 * active state". Since the `events` journal *is* JaiRA's resume and projection
 * source, that means a non-terminal task is untouchable at any age.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { historySize, pruneHistory } from "../src/prune";
import { latestRun } from "../src/views";

let dir: string;
let project: Project;

const HOUR = 3_600_000;
const now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-prune-"));
  initProject(dir);
  project = openProject(dir);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const entered = (id: number, stateId: string): EngineEvent => ({
  type: "instance.entered",
  instanceId: id,
  stateId,
  inputs: {},
});

/** A task with `runs` finished attempts, at `endedAt` offsets from `now`. */
function seedTask(taskId: string, status: "completed" | "failed" | "canceled" | "running" | "interrupted", ages: number[]): number[] {
  project.runtime.insert(taskId, now - 10 * HOUR);
  const ids: number[] = [];
  for (const age of ages) {
    const runId = project.runtime.beginRun(taskId, "hash", now - age - HOUR);
    const recorder = project.events.recorder(taskId, runId);
    recorder.record(entered(1, "wf"), now - age - HOUR);
    recorder.record({ type: "instance.terminated", instanceId: 1, stateId: "wf", outcome: "success" }, now - age);
    project.commands.record({ taskId, runId, tool: "bash", command: "git status", decision: "allowed", decidedBy: "policy" });
    // A `running`/`interrupted` task keeps its last run open, like a real crash.
    const open = status === "running" || status === "interrupted";
    if (!open || age !== ages[ages.length - 1]) {
      project.runtime.endRun(runId, "success", now - age);
    }
    ids.push(runId);
  }
  project.runtime.setStatus(taskId, status, now);
  return ids;
}

describe("the §13 safety rule", () => {
  it("never prunes a running or interrupted task, however old", () => {
    seedTask("t-running", "running", [50 * HOUR]);
    seedTask("t-interrupted", "interrupted", [50 * HOUR]);
    const before = historySize(project);

    const result = pruneHistory(project, { before: now, keepRunsPerTask: 0 });

    expect(result.runs).toEqual([]);
    expect(historySize(project)).toEqual(before);
    expect(result.skippedTasks.map((s) => s.taskId).sort()).toEqual(["t-interrupted", "t-running"]);
    // An interrupted task is resumable — precisely the case §13 protects.
    expect(result.skippedTasks.find((s) => s.taskId === "t-interrupted")!.reason).toMatch(/required to resume/);
  });

  it("keeps a queued task's rows too — it has not run yet", () => {
    project.runtime.insert("t-queued", now - HOUR);
    const result = pruneHistory(project, { before: now, keepRunsPerTask: 0 });
    expect(result.skippedTasks.map((s) => s.taskId)).toEqual(["t-queued"]);
  });

  it("leaves a completed task's projection intact, because the latest run is kept", () => {
    seedTask("t-done", "completed", [40 * HOUR, 2 * HOUR]);
    pruneHistory(project, { before: now });

    // The detail view still has a tree to draw — the point of keeping one run.
    const run = latestRun(project, "t-done");
    expect(run.instances).toHaveLength(1);
    expect(project.runtime.listRuns("t-done")).toHaveLength(1);
  });
});

describe("what pruning deletes", () => {
  it("drops older finished runs of a terminal task, with their events and command log", () => {
    const [oldRun, newRun] = seedTask("t-done", "completed", [40 * HOUR, 2 * HOUR]);
    expect(historySize(project)).toMatchObject({ runs: 2, events: 4, commands: 2 });

    const result = pruneHistory(project, { before: now });

    expect(result.runs.map((r) => r.runId)).toEqual([oldRun!]);
    expect(result.events).toBe(2);
    expect(result.commands).toBe(1);
    expect(historySize(project)).toMatchObject({ runs: 1, events: 2, commands: 1 });
    expect(project.runtime.listRuns("t-done").map((r) => r.id)).toEqual([newRun!]);
  });

  it("respects the age cutoff", () => {
    seedTask("t-done", "completed", [40 * HOUR, 30 * HOUR, 2 * HOUR]);
    // Only runs that ended more than 24h ago.
    const result = pruneHistory(project, { before: now - 24 * HOUR });
    expect(result.runs).toHaveLength(2);
    expect(project.runtime.listRuns("t-done")).toHaveLength(1);
  });

  it("honours keepRunsPerTask", () => {
    seedTask("t-done", "completed", [40 * HOUR, 30 * HOUR, 20 * HOUR]);
    pruneHistory(project, { before: now, keepRunsPerTask: 2 });
    expect(project.runtime.listRuns("t-done")).toHaveLength(2);
  });

  it("never deletes a run that is still open, even on a terminal task", () => {
    // A terminal task with an unfinished run row is a crash residue; deleting it
    // would hide that rather than resolve it.
    project.runtime.insert("t-odd", now - 10 * HOUR);
    const open = project.runtime.beginRun("t-odd", "hash", now - 5 * HOUR);
    project.runtime.setStatus("t-odd", "failed", now);
    const result = pruneHistory(project, { before: now, keepRunsPerTask: 0 });
    expect(result.runs).toEqual([]);
    expect(project.runtime.listRuns("t-odd").map((r) => r.id)).toEqual([open]);
  });
});

describe("dryRun", () => {
  it("reports the plan without deleting anything", () => {
    seedTask("t-done", "completed", [40 * HOUR, 2 * HOUR]);
    const before = historySize(project);

    const plan = pruneHistory(project, { before: now, dryRun: true });

    expect(plan.dryRun).toBe(true);
    expect(plan.runs).toHaveLength(1);
    expect(plan.events).toBe(2);
    // Pruning history is not undoable, so a UI must be able to show the cost first.
    expect(historySize(project)).toEqual(before);
  });
});

describe("integrity", () => {
  it("leaves no orphaned rows and passes SQLite's own FK check", () => {
    seedTask("t-a", "completed", [40 * HOUR, 2 * HOUR]);
    seedTask("t-b", "failed", [50 * HOUR]);
    seedTask("t-c", "running", [50 * HOUR]);

    pruneHistory(project, { before: now });

    const orphanEvents = (
      project.db
        .prepare(`SELECT COUNT(*) n FROM events WHERE run_id NOT IN (SELECT id FROM runs)`)
        .get() as { n: number }
    ).n;
    const orphanCommands = (
      project.db
        .prepare(`SELECT COUNT(*) n FROM command_log WHERE run_id NOT IN (SELECT id FROM runs)`)
        .get() as { n: number }
    ).n;
    expect({ orphanEvents, orphanCommands }).toEqual({ orphanEvents: 0, orphanCommands: 0 });
    expect(project.db.pragma("foreign_key_check")).toEqual([]);
  });
});
