/**
 * Phase-2 end-to-end: the durable task lifecycle against a temp project —
 * create → start (snapshot + EngineEvent journal in SQLite) → status/list,
 * workflow-level crash recovery, and cancel (DESIGN §14.2).
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginTaskRun, openProject } from "@jaira/persistence";
import { runCli, type CliIo } from "../src/cli";
import { blockedRules, happyRules, HUMAN_REVIEW_FUNCTION, makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(() => {
  dir = makePlanningProject();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Capture extends CliIo {
  out: () => string;
  err: () => string;
}

function io(): Capture {
  let out = "";
  let err = "";
  return { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t), out: () => out, err: () => err };
}

async function cli(args: string[]): Promise<{ code: number; out: string; err: string; json: () => unknown }> {
  const capture = io();
  const code = await runCli(args, capture);
  return { code, out: capture.out(), err: capture.err(), json: () => JSON.parse(capture.out()) as unknown };
}

async function createPlanningTask(): Promise<string> {
  const created = await cli([
    "task",
    "create",
    "--title",
    "Plan the feature",
    "--workflow",
    "feature/plan",
    "--inputs",
    '{"issue":"the issue"}',
  ]);
  expect(created.code).toBe(0);
  return (created.json() as { taskId: string }).taskId;
}

describe("jaira task lifecycle (e2e, temp project)", () => {
  it("create → start → completed, with snapshot and EngineEvent journal", async () => {
    const taskId = await createPlanningTask();
    expect(existsSync(join(dir, ".jaira", "tasks", `${taskId}.json`))).toBe(true);

    const started = await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules())]);
    expect(started.code).toBe(0);
    const report = started.json() as Record<string, unknown>;
    expect(report["status"]).toBe("completed");
    expect((report["outputs"] as Record<string, unknown>)["outcome"]).toBe("complete");

    // Durable record: runtime row, pinned snapshot on disk, journal in SQLite.
    const project = openProject(dir);
    try {
      const runtime = project.runtime.get(taskId);
      expect(runtime?.status).toBe("completed");
      expect(runtime?.snapshotHash).toBeDefined();
      expect(existsSync(join(dir, ".jaira", "snapshots", runtime!.snapshotHash!, "feature", "plan.json"))).toBe(
        true,
      );
      const runs = project.runtime.listRuns(taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "success", snapshotHash: runtime!.snapshotHash });
      expect(JSON.parse(runs[0]!.outputsJson!)).toMatchObject({ outcome: "complete" });

      const events = project.events.list(taskId);
      const types = new Set(events.map((e) => e.type));
      expect(types).toContain("instance.entered");
      expect(types).toContain("operation.completed");
      expect(types).toContain("transition.taken");
      expect(types).toContain("instance.terminated");
      expect(events.every((e) => e.runId === runs[0]!.id)).toBe(true);
    } finally {
      project.close();
    }

    // Status + list surfaces.
    const status = await cli(["task", "status", taskId, "--events", "5"]);
    expect(status.code).toBe(0);
    const statusReport = status.json() as Record<string, unknown>;
    expect(statusReport["status"]).toBe("completed");
    expect((statusReport["events"] as unknown[]).length).toBe(5);

    const list = await cli(["task", "list"]);
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it("interactive path: scripted interactions recorded through to completion", async () => {
    const taskId = await createPlanningTask();
    const started = await cli([
      "task",
      "start",
      taskId,
      "--fake",
      JSON.stringify(blockedRules()),
      "--interactions",
      JSON.stringify({ [HUMAN_REVIEW_FUNCTION]: [{ decision: "block" }] }),
    ]);
    expect(started.code).toBe(0);
    const outputs = (started.json() as Record<string, unknown>)["outputs"] as Record<string, unknown>;
    expect(outputs["outcome"]).toBe("blocked");
  });

  it("crash recovery: a running task is marked interrupted and re-runs from the pinned snapshot", async () => {
    const taskId = await createPlanningTask();

    // Simulate a crash: begin a run (status=running, open run row) and never finish it.
    {
      const project = openProject(dir);
      beginTaskRun(project, taskId);
      project.close();
    }

    // Any CLI command re-opening the project performs recovery.
    const status = await cli(["task", "status", taskId]);
    expect(status.err).toMatch(new RegExp(`recovered 1 interrupted task\\(s\\): ${taskId}`));
    const statusReport = status.json() as Record<string, unknown>;
    expect(statusReport["status"]).toBe("interrupted");
    const runs = statusReport["runs"] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!["outcome"]).toBe("interrupted");

    // Re-run: same pinned snapshot, fresh run from the workflow start.
    const rerun = await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules())]);
    expect(rerun.code).toBe(0);
    expect(rerun.err).toMatch(/\(pinned\)/);
    expect((rerun.json() as Record<string, unknown>)["status"]).toBe("completed");

    const after = await cli(["task", "status", taskId]);
    const afterReport = after.json() as Record<string, unknown>;
    expect(afterReport["status"]).toBe("completed");
    const afterRuns = afterReport["runs"] as Array<Record<string, unknown>>;
    expect(afterRuns).toHaveLength(2);
    expect(afterRuns.map((r) => r["outcome"])).toEqual(["interrupted", "success"]);
  });

  it("reports the root cause of a failure, not just the parent's summary", async () => {
    const taskId = await createPlanningTask();
    const failing = await cli(["task", "start", taskId, "--fake", JSON.stringify([{ error: "provider exploded" }])]);
    expect(failing.code).toBe(1);
    const report = failing.json() as Record<string, unknown>;
    // The composite failure names the child; on its own that hides what broke.
    expect(JSON.stringify(report["failure"])).toMatch(/child 'goals' terminated/);
    // `causes` comes from the journal's operation-level failures.
    const causes = report["causes"] as Array<Record<string, string>>;
    expect(causes[0]).toMatchObject({ stateId: "feature/plan/goals", reason: "provider exploded" });
  });

  it("failed runs record the failure and allow retry", async () => {
    const taskId = await createPlanningTask();
    const failing = await cli([
      "task",
      "start",
      taskId,
      "--fake",
      JSON.stringify([{ error: "provider exploded" }]),
    ]);
    expect(failing.code).toBe(1);
    expect((failing.json() as Record<string, unknown>)["status"]).toBe("failed");

    const retry = await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules())]);
    expect(retry.code).toBe(0);
    expect((retry.json() as Record<string, unknown>)["status"]).toBe("completed");
  });

  it("cancel is terminal", async () => {
    const taskId = await createPlanningTask();
    const canceled = await cli(["task", "cancel", taskId]);
    expect(canceled.code).toBe(0);
    expect((canceled.json() as Record<string, unknown>)["status"]).toBe("canceled");
    const start = await cli(["task", "start", taskId, "--fake", "[]"]);
    expect(start.code).toBe(1);
    expect(start.err).toMatch(/canceled/);
  });
});
