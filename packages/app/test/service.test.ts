/**
 * The app surface, driven headlessly (no Electron): create → start → board →
 * detail, the live human gate through the interaction hub, and cancellation.
 *
 * This is the phase-3 milestone as a test — a task moving across board columns —
 * plus the phase-4 seam (a run parking on a human decision that only the UI
 * channel can answer).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { blockedRules, happyRules, HUMAN_REVIEW_FUNCTION, specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-app-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  pushes = [];
  let n = 0;
  service = new AppService({ publish: (m) => pushes.push(m), nextInteractionId: () => `ui-${++n}` });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

function newTask(title = "Plan the feature"): string {
  return service.createTask({ title, workflow: "feature/plan", inputs: { issue: "the issue" } }).taskId;
}

/** Wait until `predicate` holds, driving the microtask/timer queue. */
async function until(predicate: () => boolean, label: string, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const finished = (taskId: string): boolean =>
  pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);

describe("AppService reads", () => {
  it("opens a project and lists created tasks", () => {
    expect(service.current()).toEqual({ dir });
    const taskId = newTask();
    expect(service.listTasks()).toHaveLength(1);
    expect(service.listTasks()[0]).toMatchObject({ taskId, status: "queued", workflow: "feature/plan" });
    expect(pushes).toContainEqual({ type: "store:invalidate", scope: "tasks" });
  });

  it("projects the root board from the live workflow before any run", () => {
    newTask();
    const board = service.board();
    expect(board.level).toBe("feature/plan");
    expect(board.label).toBe("Planning");
    expect(board.columns.map((c) => c.key)).toEqual(["goals", "context", "critique"]);
    // A queued task has no active path yet.
    expect(board.finished).toHaveLength(1);
    expect(board.columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it("throws for an unknown task and when no project is open", () => {
    expect(() => service.taskDetail("nope")).toThrow(/unknown task/);
    const closed = new AppService();
    expect(() => closed.listTasks()).toThrow(/no project is open/);
  });
});

describe("AppService.startTask (scripted)", () => {
  it("runs to completion, streams events, and records the run", async () => {
    const taskId = newTask();
    const { runId } = await service.startTask({
      taskId,
      fake: happyRules(),
      interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
    });
    expect(runId).toBe(1);
    await until(() => finished(taskId), "the run to finish");

    expect(pushes).toContainEqual({ type: "run:finished", taskId, runId, status: "completed" });
    // The journal streamed live, in order, as engine events.
    const streamed = pushes.filter((m) => m.type === "engine:event");
    expect(streamed.length).toBeGreaterThan(5);
    expect(streamed.map((m) => (m as { seq: number }).seq)).toEqual(streamed.map((_, i) => i + 1));

    const detail = service.taskDetail(taskId);
    expect(detail.status).toBe("completed");
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]).toMatchObject({ runId, outcome: "success" });
    expect(JSON.stringify(detail.runs[0]!.outputs)).toContain("# The Plan");
    // The instance tree is projected from the journal, not tracked separately.
    expect(detail.instances).toHaveLength(1);
    expect(detail.instances[0]!.stateId).toBe("feature/plan");
    expect(detail.instances[0]!.children.map((c) => c.childKey)).toEqual(["goals", "context", "critique"]);
    expect(detail.activePath).toEqual([]);
    expect(detail.timeline.length).toBeGreaterThan(5);

    // Board: a completed task leaves the columns and lands in finished.
    const board = service.board();
    expect(board.finished.map((c) => c.taskId)).toEqual([taskId]);
    expect(board.columns.flatMap((c) => c.cards)).toEqual([]);
  });

  it("refuses to start the same task twice concurrently", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: happyRules(), interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] } });
    await expect(service.startTask({ taskId })).rejects.toThrow(/already running/);
    await until(() => finished(taskId), "the run to finish");
  });

  it("records a failed run and leaves the task retryable", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: [{ error: "provider exploded" }] });
    await until(() => finished(taskId), "the failing run to finish");
    expect(service.taskDetail(taskId).status).toBe("failed");

    // A retry is a fresh run against the pinned snapshot.
    await service.startTask({ taskId, fake: happyRules(), interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] } });
    await until(() => pushes.filter((m) => m.type === "run:finished").length === 2, "the retry to finish");
    const detail = service.taskDetail(taskId);
    expect(detail.status).toBe("completed");
    expect(detail.runs.map((r) => r.outcome)).toEqual(["error", "success"]);
  });
});

describe("AppService live human gate", () => {
  it("parks on the gate, shows it as pending, and completes once the UI answers", async () => {
    const taskId = newTask();
    // No scripted interactions: the gate must come to the UI.
    await service.startTask({ taskId, fake: blockedRules() });

    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    const pending = service.pendingInteractions()[0]!;
    expect(pending.component).toBe(HUMAN_REVIEW_FUNCTION);
    expect(pending.taskId).toBe(taskId);
    // The authored `config` surface reaches the UI, so it can render the choices.
    expect(JSON.stringify(pending.inputs)).toContain("Review the critique result.");
    expect(pushes).toContainEqual({ type: "interaction:requested", pending });

    // While parked, the board shows the task waiting on a human.
    const board = service.board();
    const card = board.columns.find((c) => c.key === "critique")!.cards[0]!;
    expect(card.taskId).toBe(taskId);
    expect(card.activeStatus).toBe("waiting_for_user");
    expect(card.activeStateId).toBe("feature/plan/critique/human_review");
    expect(card.hasSubBoard).toBe(true);
    // …and the sub-board places it in the human_review column.
    const sub = service.board("feature/plan/critique");
    expect(sub.breadcrumb).toEqual(["feature/plan", "feature/plan/critique"]);
    expect(sub.columns.find((c) => c.key === "human_review")!.cards.map((c) => c.taskId)).toEqual([taskId]);

    service.submitInteraction(pending.requestId, { decision: "block" });
    await until(() => finished(taskId), "the run to finish after answering");

    expect(pushes).toContainEqual({ type: "interaction:resolved", requestId: pending.requestId });
    expect(service.pendingInteractions()).toEqual([]);
    const detail = service.taskDetail(taskId);
    expect(detail.status).toBe("completed");
    expect(JSON.stringify(detail.runs[0]!.outputs)).toContain("\"human_decision\":\"block\"");
  });

  it("rejects an unknown interaction id", () => {
    expect(() => service.submitInteraction("nope", { decision: "approve" })).toThrow(/no pending interaction/);
  });

  it("refuses an out-of-contract answer, and the gate stays open for a valid one", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    const pending = service.pendingInteractions()[0]!;

    // The renderer is the untrusted half of the boundary: an undeclared decision
    // must not reach the engine (DESIGN §7.1).
    expect(() => service.submitInteraction(pending.requestId, { decision: "ship-it" })).toThrow(
      /invalid choose_option response.*not one of/,
    );
    expect(() => service.submitInteraction(pending.requestId, "approve")).toThrow(/must be an object/);
    // Still parked, so a rejected answer loses nothing.
    expect(service.pendingInteractions()).toHaveLength(1);

    service.submitInteraction(pending.requestId, { decision: "approve" });
    await until(() => finished(taskId), "the run to finish after a valid answer");
    expect(service.pendingInteractions()).toEqual([]);
  });

  it("hands the renderer a parsed component contract", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    const pending = service.pendingInteractions()[0]!;
    // Normalized in main, so the renderer never re-derives the contract.
    expect(pending.config).toMatchObject({
      component: "choose_option",
      prompt: "Review the critique result.",
      options: [{ value: "approve" }, { value: "request_changes" }, { value: "block" }],
    });
    expect(pending.configError).toBeUndefined();
    service.submitInteraction(pending.requestId, { decision: "block" });
    await until(() => finished(taskId), "the run to finish");
  });

  it("canceling a parked run fails the gate rather than hanging", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");

    service.cancelTask(taskId);
    await until(() => finished(taskId), "the canceled run to finish");
    expect(service.pendingInteractions()).toEqual([]);
    // The gate failing is a state-level failure, so the run ends non-completed.
    expect(service.taskDetail(taskId).status).not.toBe("completed");
  });

  it("closing the project releases parked gates", async () => {
    const taskId = newTask();
    await service.startTask({ taskId, fake: blockedRules() });
    await until(() => service.pendingInteractions().length === 1, "the gate to park");
    await service.close();
    // The hub rejected it, so nothing is left waiting on a human.
    expect(service.pendingInteractions()).toEqual([]);
  });
});

describe("AppService.cancelTask (not running here)", () => {
  it("records a terminal canceled status for a queued task", () => {
    const taskId = newTask();
    service.cancelTask(taskId);
    expect(service.taskDetail(taskId).status).toBe("canceled");
  });
});
