/**
 * `jaira prune` — the headless surface for SPEC §13. The two things worth testing
 * at this level are the ones a user can get wrong: the default must not delete
 * anything, and a task that is still resumable must be refused *visibly*.
 */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { runCli, type CliIo } from "../src/cli";
import { happyRules, HUMAN_REVIEW_FUNCTION, makePlanningProject } from "./fixtures";

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
  const code = await runCli(["--home", testHome(), ...args], io);
  return { code, out, err };
}

interface PruneOut {
  dryRun?: boolean;
  tasksPruned: number;
  events: number;
  tasks: Array<{ taskId: string }>;
  skipped: Array<{ taskId: string; status: string; reason: string }>;
  remaining: { tasks: number; events: number; commands: number };
}

async function prune(args: string[] = []): Promise<PruneOut> {
  const res = await cli(["prune", ...args]);
  expect(res.code).toBe(0);
  return JSON.parse(res.out) as PruneOut;
}

/** A task run to completion — history worth pruning, and a card worth keeping. */
async function completedTask(): Promise<string> {
  const created = await cli([
    "task", "create", "--title", "Plan the feature", "--workflow", "feature/plan",
    "--inputs", '{"issue":"the issue"}',
  ]);
  const taskId = (JSON.parse(created.out) as { taskId: string }).taskId;
  const gate = JSON.stringify({ [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] });
  await cli(["task", "start", taskId, "--fake", JSON.stringify(happyRules()), "--interactions", gate]);
  return taskId;
}

describe("jaira prune", () => {
  it("is a dry run by default and says so", async () => {
    await completedTask();
    const before = (await prune()).remaining;

    const plan = await prune();
    expect(plan.dryRun).toBe(true);
    expect(plan.tasksPruned).toBe(1);
    expect(plan.events).toBeGreaterThan(0);
    // Nothing moved: the same numbers are still there.
    expect(plan.remaining).toEqual(before);

    const res = await cli(["prune"]);
    expect(res.err).toMatch(/re-run with --apply/);
  });

  it("deletes the history only once --apply is given, keeping the task itself", async () => {
    const taskId = await completedTask();
    const applied = await prune(["--apply"]);
    expect(applied.dryRun).toBeUndefined();
    expect(applied.tasksPruned).toBe(1);
    expect(applied.remaining.events).toBe(0);

    // The task's card still says what happened — the point of pruning the how and not the what.
    const status = await cli(["task", "status", taskId]);
    const parsed = JSON.parse(status.out) as { status: string; runs: Array<{ outcome: string }> };
    expect(parsed.status).toBe("completed");
    expect(parsed.runs[0]?.outcome).toBe("success");

    // A second prune has nothing left to do.
    expect((await prune(["--apply"])).tasksPruned).toBe(0);
  });

  it("--older-than protects recent history", async () => {
    await completedTask();
    // Everything just ran, so a one-day cutoff spares all of it.
    const plan = await prune(["--older-than", "1"]);
    expect(plan.tasksPruned).toBe(0);
  });

  it("refuses a queued task and reports why", async () => {
    const created = await cli([
      "task", "create", "--title", "Untouched", "--workflow", "feature/plan",
      "--inputs", '{"issue":"x"}',
    ]);
    const taskId = (JSON.parse(created.out) as { taskId: string }).taskId;
    const plan = await prune();
    expect(plan.skipped.map((s) => s.taskId)).toContain(taskId);
    expect(plan.skipped[0]!.reason).toMatch(/required to resume/);
  });

  it("rejects nonsense options rather than guessing", async () => {
    // `=` form, because bare `-3` is consumed by parseArgs as an option.
    expect((await cli(["prune", "--older-than=-3"])).code).toBe(2);
    expect((await cli(["prune", "--older-than", "later"])).code).toBe(2);
  });
});
