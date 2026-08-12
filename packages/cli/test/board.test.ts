/**
 * `jaira board` — the phase-3 milestone on the headless surface: a task visibly
 * sitting in the board column its active path runs through, and moving to
 * "finished" once the run completes.
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardView } from "@jaira/shared";
import { runCli, type CliIo } from "../src/cli";
import { blockedRules, happyRules, HUMAN_REVIEW_FUNCTION, makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(() => {
  dir = makePlanningProject();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) };
  const code = await runCli(args, io);
  return { code, out, err };
}

async function board(args: string[] = []): Promise<BoardView> {
  const res = await cli(["board", "--json", ...args]);
  expect(res.code).toBe(0);
  return JSON.parse(res.out) as BoardView;
}

async function createTask(): Promise<string> {
  const res = await cli(["task", "create", "--title", "Plan the feature", "--workflow", "feature/plan", "--inputs", '{"issue":"the issue"}']);
  return (JSON.parse(res.out) as { taskId: string }).taskId;
}

describe("jaira board", () => {
  it("renders the root board's columns from the workflow", async () => {
    const taskId = await createTask();
    const view = await board();
    expect(view.level).toBe("feature/plan");
    expect(view.breadcrumb.map((c) => c.stateId)).toEqual(["feature/plan"]);
    expect(view.columns.map((c) => c.key)).toEqual(["goals", "context", "critique"]);
    // Not started yet, so it has entered no child — but it is AT the level it will begin at, which
    // is this one. It used to be filed under "finished / not started", a tray named for a status.
    expect(view.atLevel.map((c) => c.taskId)).toEqual([taskId]);
    expect(view.finished).toEqual([]);
  });

  it("shows a task parked on the human gate, then moved to finished", async () => {
    const taskId = await createTask();

    // A blocked critique routes to the human gate. With no scripted answer the
    // gate is unregistered, so that state fails — but the journal still records
    // the path through `critique`, which is what the board draws.
    await cli(["task", "start", taskId, "--fake", JSON.stringify(blockedRules())]);
    const failed = await board();
    expect(failed.finished.map((c) => c.taskId)).toEqual([taskId]);

    // Re-run with the gate answered: the task completes.
    const done = await cli([
      "task",
      "start",
      taskId,
      "--fake",
      JSON.stringify(blockedRules()),
      "--interactions",
      JSON.stringify({ [HUMAN_REVIEW_FUNCTION]: [{ decision: "block" }] }),
    ]);
    expect(done.code).toBe(0);
    const after = await board();
    const card = after.finished.find((c) => c.taskId === taskId)!;
    expect(card.status).toBe("completed");
  });

  it("drills into a sub-board level", async () => {
    const taskId = await createTask();
    await cli([
      "task",
      "start",
      taskId,
      "--fake",
      JSON.stringify(happyRules()),
      "--interactions",
      JSON.stringify({ [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] }),
    ]);
    const sub = await board(["--level", "feature/plan/critique"]);
    expect(sub.level).toBe("feature/plan/critique");
    expect(sub.breadcrumb.map((c) => c.stateId)).toEqual(["feature/plan", "feature/plan/critique"]);
    expect(sub.columns.map((c) => c.key)).toEqual(["address_weaknesses", "human_review"]);
  });

  it("renders a human-readable board by default", async () => {
    await createTask();
    const res = await cli(["board"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^board: feature\/plan {2}\(Planning\)/m);
    expect(res.out).toMatch(/\[goals\] Goals/);
    expect(res.out).toMatch(/\(at this level\)/);
    expect(res.out).toMatch(/Plan the feature/);
    // The ended runs are in their columns now, so printing the census as well would list half the
    // board twice — see `BoardView.finished`.
    expect(res.out).not.toMatch(/finished \/ not started/);
  });

  it("reports an empty board for a project with no tasks", async () => {
    const view = await board();
    expect(view.columns).toEqual([]);
    expect(view.finished).toEqual([]);
  });
});
