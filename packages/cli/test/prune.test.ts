/**
 * `jaira prune` — the headless surface for SPEC §13. The two things worth testing
 * at this level are the ones a user can get wrong: the default must not delete
 * anything, and a task that is still resumable must be refused *visibly*.
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

interface PruneOut {
  dryRun?: boolean;
  runsPruned: number;
  events: number;
  runs: Array<{ taskId: string; runId: number }>;
  skipped: Array<{ taskId: string; status: string; reason: string }>;
  remaining: { runs: number; events: number; commands: number };
}

async function prune(args: string[] = []): Promise<PruneOut> {
  const res = await cli(["prune", ...args]);
  expect(res.code).toBe(0);
  return JSON.parse(res.out) as PruneOut;
}

/** A completed task with two runs behind it. */
async function taskWithTwoRuns(): Promise<string> {
  const created = await cli([
    "task", "create", "--title", "Plan the feature", "--workflow", "feature/plan",
    "--inputs", '{"issue":"the issue"}',
  ]);
  const taskId = (JSON.parse(created.out) as { taskId: string }).taskId;
  const gate = JSON.stringify({ [HUMAN_REVIEW_FUNCTION]: [{ decision: "block" }] });
  // First attempt fails (no scripted gate answer), second succeeds — two runs.
  await cli(["task", "start", taskId, "--fake", JSON.stringify(blockedRules())]);
  await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules()), "--interactions", gate]);
  return taskId;
}

describe("jaira prune", () => {
  it("is a dry run by default and says so", async () => {
    await taskWithTwoRuns();
    const before = (await prune()).remaining;

    const plan = await prune();
    expect(plan.dryRun).toBe(true);
    expect(plan.runsPruned).toBe(1);
    expect(plan.events).toBeGreaterThan(0);
    // Nothing moved: the same numbers are still there.
    expect(plan.remaining).toEqual(before);

    const res = await cli(["prune"]);
    expect(res.err).toMatch(/re-run with --apply/);
  });

  it("deletes the older run only once --apply is given, keeping the latest", async () => {
    const taskId = await taskWithTwoRuns();
    const applied = await prune(["--apply"]);
    expect(applied.dryRun).toBeUndefined();
    expect(applied.runsPruned).toBe(1);
    expect(applied.remaining.runs).toBe(1);

    // The task's history still renders — the point of keeping the latest run.
    const status = await cli(["task", "status", taskId]);
    const parsed = JSON.parse(status.out) as { runs: Array<{ runId: number }> };
    expect(parsed.runs).toHaveLength(1);

    // A second prune has nothing left to do.
    expect((await prune(["--apply"])).runsPruned).toBe(0);
  });

  it("--older-than protects recent runs", async () => {
    await taskWithTwoRuns();
    // Everything just ran, so a one-day cutoff spares all of it.
    const plan = await prune(["--older-than", "1", "--keep-runs", "0"]);
    expect(plan.runsPruned).toBe(0);
  });

  it("refuses a queued task and reports why", async () => {
    const created = await cli([
      "task", "create", "--title", "Untouched", "--workflow", "feature/plan",
      "--inputs", '{"issue":"x"}',
    ]);
    const taskId = (JSON.parse(created.out) as { taskId: string }).taskId;
    const plan = await prune(["--keep-runs", "0"]);
    expect(plan.skipped.map((s) => s.taskId)).toContain(taskId);
    expect(plan.skipped[0]!.reason).toMatch(/required to resume/);
  });

  it("rejects nonsense options rather than guessing", async () => {
    // `=` form, because bare `-3` is consumed by parseArgs as an option.
    expect((await cli(["prune", "--older-than=-3"])).code).toBe(2);
    expect((await cli(["prune", "--keep-runs", "1.5"])).code).toBe(2);
    expect((await cli(["prune", "--older-than", "later"])).code).toBe(2);
  });
});
