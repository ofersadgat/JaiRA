/**
 * Board/detail projection (DESIGN §11, §12). These tests pin the properties the
 * board's correctness rests on: status is derived from the journal, a sequence
 * reset supersedes rather than deletes, the blocked sentinel never becomes a
 * node, and a card lands in the column its active path enters.
 */
import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import {
  activePathOf,
  breadcrumbOf,
  flattenInstances,
  projectBoard,
  projectRun,
  type TaskProjection,
  type WorkflowShape,
} from "../src/projection";

const SHAPE: WorkflowShape = {
  "feature/plan": {
    label: "Planning",
    children: [
      { key: "goals", stateId: "feature/plan/goals", label: "Goals" },
      { key: "context", stateId: "feature/plan/context", label: "Context" },
      { key: "critique", stateId: "feature/plan/critique", label: "Critique" },
    ],
  },
  "feature/plan/goals": { children: [] },
  "feature/plan/context": { children: [] },
  "feature/plan/critique": {
    children: [{ key: "human_review", stateId: "feature/plan/critique/human_review" }],
  },
  "feature/plan/critique/human_review": { children: [], interactive: true },
};

const entered = (id: number, stateId: string, parent?: number, childKey?: string): EngineEvent => ({
  type: "instance.entered",
  instanceId: id,
  stateId,
  ...(parent !== undefined ? { parentInstanceId: parent } : {}),
  ...(childKey !== undefined ? { childKey } : {}),
  inputs: {},
});
const terminated = (id: number, stateId: string, outcome: "success" | "error" | "canceled" | "timeout"): EngineEvent => ({
  type: "instance.terminated",
  instanceId: id,
  stateId,
  outcome,
});
const opStarted = (id: number, stateId: string, op: "prompt" | "function"): EngineEvent => ({
  type: "operation.started",
  instanceId: id,
  stateId,
  op,
});

describe("projectRun", () => {
  it("builds the instance tree and the active path from the journal", () => {
    const events: EngineEvent[] = [
      entered(1, "feature/plan"),
      entered(2, "feature/plan/goals", 1, "goals"),
      opStarted(2, "feature/plan/goals", "prompt"),
      { type: "operation.completed", instanceId: 2, stateId: "feature/plan/goals", op: "prompt", metrics: { durationMs: 1, costUsd: 0.02, costSource: "table" } },
      terminated(2, "feature/plan/goals", "success"),
      entered(3, "feature/plan/context", 1, "context"),
      opStarted(3, "feature/plan/context", "prompt"),
    ];
    const run = projectRun(events, SHAPE, events.map((_, i) => 1000 + i));

    expect(run.instances).toHaveLength(1);
    const root = run.instances[0]!;
    expect(root.stateId).toBe("feature/plan");
    expect(root.children.map((c) => c.childKey)).toEqual(["goals", "context"]);

    const goals = root.children[0]!;
    expect(goals.status).toBe("completed");
    expect(goals.operation).toMatchObject({ kind: "prompt", status: "completed", costUsd: 0.02 });
    expect(goals.endedAt).toBe(1004);

    // Active path stops at the deepest live instance.
    expect(run.activePath.map((s) => s.stateId)).toEqual(["feature/plan", "feature/plan/context"]);
    expect(run.blocked).toEqual([]);
  });

  it("reports waiting_for_user while an interactive function runs", () => {
    const events: EngineEvent[] = [
      entered(1, "feature/plan/critique"),
      entered(2, "feature/plan/critique/human_review", 1, "human_review"),
      opStarted(2, "feature/plan/critique/human_review", "function"),
    ];
    const run = projectRun(events, SHAPE);
    const gate = run.instances[0]!.children[0]!;
    expect(gate.status).toBe("waiting_for_user");

    // Answering it returns the instance to plain running.
    const answered = projectRun(
      [...events, { type: "operation.completed", instanceId: 2, stateId: "feature/plan/critique/human_review", op: "function" }],
      SHAPE,
    );
    expect(answered.instances[0]!.children[0]!.status).toBe("running");
  });

  it("a non-interactive function state is not waiting_for_user", () => {
    const events: EngineEvent[] = [entered(1, "feature/plan/goals"), opStarted(1, "feature/plan/goals", "function")];
    expect(projectRun(events, SHAPE).instances[0]!.status).toBe("running");
  });

  it("supersedes cleared sequence members instead of dropping their history", () => {
    const events: EngineEvent[] = [
      entered(1, "feature/plan"),
      entered(2, "feature/plan/goals", 1, "goals"),
      terminated(2, "feature/plan/goals", "success"),
      { type: "transition.taken", instanceId: 1, stateId: "feature/plan", to: "goals", iteration: 1 },
      { type: "child.superseded", instanceId: 1, stateId: "feature/plan", childKey: "goals" },
      entered(4, "feature/plan/goals", 1, "goals"),
    ];
    const run = projectRun(events, SHAPE);
    const root = run.instances[0]!;
    expect(root.iteration).toBe(1);
    // Both instances are kept (history preserved, DESIGN §4.2).
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ instanceId: 2, superseded: true });
    expect(root.children[1]).toMatchObject({ instanceId: 4, superseded: false });
    // The live instance is the one on the active path.
    expect(run.activePath.map((s) => s.instanceId)).toEqual([1, 4]);
  });

  it("re-entering a child key supersedes the previous instance even without a reset event", () => {
    const run = projectRun([
      entered(1, "feature/plan"),
      entered(2, "feature/plan/goals", 1, "goals"),
      terminated(2, "feature/plan/goals", "success"),
      entered(3, "feature/plan/goals", 1, "goals"),
    ]);
    const kids = run.instances[0]!.children;
    expect(kids.map((k) => k.superseded)).toEqual([true, false]);
  });

  it("records a blocked child without inventing an instance for the -1 sentinel", () => {
    const run = projectRun([
      entered(1, "feature/plan"),
      { type: "instance.blocked", instanceId: -1, stateId: "feature/plan/context", reason: "input 'goals' is undefined" },
    ]);
    expect(flattenInstances(run.instances).map((n) => n.instanceId)).toEqual([1]);
    expect(run.blocked).toEqual([{ stateId: "feature/plan/context", reason: "input 'goals' is undefined" }]);
  });

  it("maps termination outcomes to statuses and empties the active path", () => {
    for (const [outcome, status] of [
      ["success", "completed"],
      ["error", "failed"],
      ["canceled", "canceled"],
      ["timeout", "timeout"],
    ] as const) {
      const run = projectRun([entered(1, "wf"), terminated(1, "wf", outcome)]);
      expect(run.instances[0]!.status).toBe(status);
      expect(run.activePath).toEqual([]);
    }
  });

  it("carries a terminating failure onto the operation view", () => {
    const run = projectRun([
      entered(1, "wf"),
      opStarted(1, "wf", "prompt"),
      { type: "operation.failed", instanceId: 1, stateId: "wf", op: "prompt", failure: { classification: "permanent", reason: "boom" } },
      { type: "instance.terminated", instanceId: 1, stateId: "wf", outcome: "error", failure: { classification: "permanent", reason: "boom" } },
    ]);
    expect(run.instances[0]!.status).toBe("failed");
    expect(run.instances[0]!.operation).toMatchObject({ status: "failed", reason: "boom" });
  });

  it("ignores events for unknown instances rather than throwing", () => {
    const run = projectRun([opStarted(99, "ghost", "prompt"), terminated(99, "ghost", "success")]);
    expect(run.instances).toEqual([]);
    expect(run.activePath).toEqual([]);
  });
});

describe("activePathOf", () => {
  it("prefers the most recently entered live sibling", () => {
    const run = projectRun([
      entered(1, "feature/plan"),
      entered(2, "feature/plan/goals", 1, "goals"),
      entered(3, "feature/plan/context", 1, "context"),
    ]);
    expect(activePathOf(run.instances).map((s) => s.childKey)).toEqual([undefined, "context"]);
  });
});

// --- board -------------------------------------------------------------------

function task(id: string, over: Partial<TaskProjection> = {}): TaskProjection {
  return {
    taskId: id,
    title: `task ${id}`,
    status: "running",
    workflow: "feature/plan",
    updatedAt: 1,
    run: { instances: [], activePath: [], blocked: [] },
    ...over,
  };
}

function runningAt(events: EngineEvent[]): TaskProjection["run"] {
  return projectRun(events, SHAPE);
}

describe("projectBoard", () => {
  it("places each task in the column its active path enters", () => {
    const inGoals = task("t-1", { run: runningAt([entered(1, "feature/plan"), entered(2, "feature/plan/goals", 1, "goals")]) });
    const inCritique = task("t-2", {
      run: runningAt([entered(1, "feature/plan"), entered(2, "feature/plan/critique", 1, "critique")]),
    });
    const board = projectBoard(SHAPE, "feature/plan", [inGoals, inCritique]);

    expect(board.label).toBe("Planning");
    expect(board.columns.map((c) => c.key)).toEqual(["goals", "context", "critique"]);
    expect(board.columns[0]!.cards.map((c) => c.taskId)).toEqual(["t-1"]);
    expect(board.columns[2]!.cards.map((c) => c.taskId)).toEqual(["t-2"]);
    expect(board.columns[1]!.cards).toEqual([]);
    expect(board.columns[0]!.label).toBe("Goals");
  });

  it("puts a task running the level's own operation in atLevel, not a column", () => {
    const board = projectBoard(SHAPE, "feature/plan", [task("t-1", { run: runningAt([entered(1, "feature/plan")]) })]);
    expect(board.atLevel.map((c) => c.taskId)).toEqual(["t-1"]);
    expect(board.columns.every((c) => c.cards.length === 0)).toBe(true);
  });

  it("flags a card that drills down and reports the deepest active state", () => {
    const deep = task("t-1", {
      run: runningAt([
        entered(1, "feature/plan"),
        entered(2, "feature/plan/critique", 1, "critique"),
        entered(3, "feature/plan/critique/human_review", 2, "human_review"),
        opStarted(3, "feature/plan/critique/human_review", "function"),
      ]),
    });
    const root = projectBoard(SHAPE, "feature/plan", [deep]);
    const card = root.columns[2]!.cards[0]!;
    expect(card.hasSubBoard).toBe(true);
    expect(card.activeStateId).toBe("feature/plan/critique/human_review");

    // The badge reflects the deepest live instance — a human gate is waiting.
    expect(card.activeStatus).toBe("waiting_for_user");

    // The sub-board places the same task in its own column.
    const sub = projectBoard(SHAPE, "feature/plan/critique", [deep]);
    expect(sub.columns[0]!.cards.map((c) => c.taskId)).toEqual(["t-1"]);
    expect(sub.columns[0]!.cards[0]!.hasSubBoard).toBe(false);
  });

  it("collects terminal tasks in finished and skips paths that miss the level", () => {
    const done = task("t-done", { status: "completed", run: runningAt([entered(1, "feature/plan"), terminated(1, "feature/plan", "success")]) });
    const elsewhere = task("t-other", { workflow: "other", run: runningAt([entered(1, "other")]) });
    const board = projectBoard(SHAPE, "feature/plan", [done, elsewhere]);
    expect(board.finished.map((c) => c.taskId)).toEqual(["t-done"]);
    expect(board.columns.flatMap((c) => c.cards)).toEqual([]);
    expect(board.atLevel).toEqual([]);
  });

  it("a queued task with no events counts as finished-or-not-started, never a column", () => {
    const board = projectBoard(SHAPE, "feature/plan", [task("t-q", { status: "queued" })]);
    expect(board.columns.flatMap((c) => c.cards)).toEqual([]);
    expect(board.finished.map((c) => c.taskId)).toEqual(["t-q"]);
  });
});

describe("breadcrumbOf", () => {
  it("walks from the root down to the level", () => {
    expect(breadcrumbOf(SHAPE, "feature/plan", "feature/plan")).toEqual(["feature/plan"]);
    expect(breadcrumbOf(SHAPE, "feature/plan", "feature/plan/critique/human_review")).toEqual([
      "feature/plan",
      "feature/plan/critique",
      "feature/plan/critique/human_review",
    ]);
    expect(breadcrumbOf(SHAPE, "feature/plan", "nope")).toEqual(["nope"]);
  });

  it("terminates on a cyclic shape", () => {
    const cyclic: WorkflowShape = {
      a: { children: [{ key: "b", stateId: "b" }] },
      b: { children: [{ key: "a", stateId: "a" }] },
    };
    expect(breadcrumbOf(cyclic, "a", "b")).toEqual(["a", "b"]);
    expect(breadcrumbOf(cyclic, "a", "zzz")).toEqual(["zzz"]);
  });
});
