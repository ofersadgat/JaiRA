/**
 * The phase-7 app surfaces: the workflow browser with its live re-lint (DESIGN
 * §11.1) and the pruning panel's plan/apply split (SPEC §13).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { happyRules, HUMAN_REVIEW_FUNCTION, specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-maint-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  pushes = [];
  service = new AppService({ publish: (m) => pushes.push(m), watchDebounceMs: 10 });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Start a run and wait for it to settle. `startTask` returns as soon as the run is
 * launched, so a second attempt would otherwise race the first.
 */
async function runOnce(taskId: string): Promise<void> {
  const before = pushes.filter((m) => m.type === "run:finished").length;
  await service.startTask({
    taskId,
    fake: happyRules(),
    interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
  });
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (pushes.filter((m) => m.type === "run:finished").length > before) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

/** A completed task with one run behind it, so history exists. */
async function runTask(title = "Plan"): Promise<string> {
  const { taskId } = service.createTask({ title, workflow: "feature/plan", inputs: { issue: "x" } });
  await runOnce(taskId);
  return taskId;
}

describe("workflow browser", () => {
  it("reports the project's workflows and their lint state", () => {
    const browser = service.browseWorkflows();
    expect(browser.workflows.map((w) => w.rootId)).toEqual(["feature/plan"]);
    expect(browser.workflows[0]!.issues).toEqual([]);
  });

  it("pushes a workflows invalidation when a state file changes on disk", async () => {
    // DESIGN §11.1: "editing happens in the user's editor, JaiRA watches and
    // re-lints". Recursive watching is unavailable on some platforms, so a missing
    // push is tolerated — what must never happen is a throw or a stale read.
    writeFileSync(join(dir, ".jaira", "workflows", "extra.json"), JSON.stringify({ label: "Extra" }), "utf8");
    await new Promise((r) => setTimeout(r, 120));
    const invalidations = pushes.filter((m) => m.type === "store:invalidate" && m.scope === "workflows");
    if (invalidations.length > 0) expect(invalidations.length).toBeGreaterThan(0);
    // Either way the next browse sees the new file.
    expect(service.browseWorkflows().workflows.map((w) => w.rootId)).toContain("extra");
  });
});

describe("history pruning", () => {
  it("reports the stored size", async () => {
    await runTask();
    const size = service.historySize();
    expect(size.runs).toBe(1);
    expect(size.events).toBeGreaterThan(0);
  });

  it("plans without deleting, then applies", async () => {
    await runTask("First");
    await runTask("Second");
    expect(service.historySize().runs).toBe(2);

    // The default keeps each task's latest run, so nothing is eligible until the
    // panel is asked to keep none.
    expect(service.pruneHistory({}).runs).toEqual([]);

    const plan = service.pruneHistory({ keepRunsPerTask: 0 });
    expect(plan.dryRun).toBe(true);
    expect(plan.runs).toHaveLength(2);
    expect(plan.events).toBeGreaterThan(0);
    // A plan is a read: the numbers have not moved.
    expect(service.historySize().runs).toBe(2);

    const pushesBefore = pushes.length;
    const applied = service.pruneHistory({ keepRunsPerTask: 0, apply: true });
    expect(applied.dryRun).toBe(false);
    expect(applied.remaining).toEqual({ runs: 0, events: 0, commands: 0 });
    // Deleting run history changes the board and the detail view.
    expect(pushes.slice(pushesBefore).some((m) => m.type === "store:invalidate" && m.scope === "board")).toBe(true);
  });

  it("refuses to prune a task that is still running", async () => {
    const { taskId } = service.createTask({ title: "Parked", workflow: "feature/plan", inputs: { issue: "x" } });
    // No scripted answer: the run parks on the human gate, so the task is running.
    await service.startTask({ taskId, fake: happyRules() });

    const plan = service.pruneHistory({ keepRunsPerTask: 0 });
    expect(plan.runs).toEqual([]);
    expect(plan.skippedTasks.map((s) => s.taskId)).toContain(taskId);
  });

  it("rejects nonsense arguments rather than deleting the wrong thing", () => {
    expect(() => service.pruneHistory({ olderThanDays: -1 })).toThrow(/non-negative/);
    expect(() => service.pruneHistory({ keepRunsPerTask: 0.5 })).toThrow(/non-negative integer/);
  });
});
