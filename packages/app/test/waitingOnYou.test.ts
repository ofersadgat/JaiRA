/**
 * A task waiting on the person reads as waiting everywhere it is drawn — the board's card and lane, the
 * panel's head and its verbs, the strip — whatever its status says (the person, 2026-10-21: "a close and
 * reopen of the client should be transparent as possible"). A task the app closed under while its agent
 * asked ended `canceled`, and is still waiting for the same answer; one whose agent asks right now is
 * `running`, and its card used to say so.
 */
import { describe, expect, it } from "vitest";
import type { BoardCard, BoardView, InstanceNode, TaskDetail } from "@jaira/shared/browser";
import { laneOf, waitingKindOf } from "../src/renderer/boardModel";
import { askingTasksOf, markAsking } from "../src/renderer/workspaceGroups";
import { taskTabs, taskVerbsOf } from "../src/renderer/panelFaceModel";
import { activityOf, startedAtOf } from "../src/renderer/runActivityModel";

const card = (patch: Partial<BoardCard> & Pick<BoardCard, "taskId">): BoardCard => ({
  title: patch.taskId,
  status: "running",
  workflow: "review",
  activePath: [],
  hasSubBoard: false,
  updatedAt: 0,
  ...patch,
});

describe("a card whose task waits on you", () => {
  it("is marked from the inbox — the agent's question over its approval over a gate — and a move's question is not one", () => {
    const asking = askingTasksOf(
      [{ taskId: "t-gate" }, { about: "t-about", taskId: "parent" }, { taskId: "t-move", moves: true }, { taskId: "t-both" }],
      [{ taskId: "t-approval" }, { taskId: "t-both" }],
      [{ taskId: "t-question" }],
    );
    expect(Object.fromEntries(asking)).toEqual({ "t-gate": "gate", "t-about": "gate", "t-both": "approval", "t-approval": "approval", "t-question": "question", parent: "gate" });
    const board = { columns: [{ stateId: "s", cards: [card({ taskId: "t-approval", status: "canceled" })] }], atLevel: [], finished: [card({ taskId: "t-gate", status: "canceled", archived: { from: "canceled", at: 1 } })] } as unknown as BoardView;
    const marked = markAsking(board, asking)!;
    expect(marked.columns[0]!.cards[0]!.asking).toBe("approval");
    // An archived task waits on nobody.
    expect(marked.finished[0]!.asking).toBeUndefined();
  });

  it("stands in the paused lane, named for what it waits on — though its run says canceled, or running", () => {
    expect(laneOf(card({ taskId: "t", status: "canceled", asking: "approval" }))).toBe("paused");
    expect(laneOf(card({ taskId: "t", status: "running", activeStatus: "running", asking: "question" }))).toBe("paused");
    expect(waitingKindOf(card({ taskId: "t", status: "canceled", asking: "approval" }))).toBe("approval");
    expect(laneOf(card({ taskId: "t", status: "canceled" }))).toBe("finished");
  });
});

const node = (patch: Partial<InstanceNode>): InstanceNode => ({ instanceId: "i", stateId: "s", status: "canceled", children: [], ...patch }) as InstanceNode;

/** A run the app closed under while the agent in `feature/plan/write` asked. */
const closedUnder = {
  taskId: "t-1",
  title: "t-1",
  workflow: "feature",
  status: "canceled",
  createdAt: "2026-10-21T00:00:00Z",
  activePath: [],
  instances: [node({ instanceId: "root", stateId: "feature", children: [node({ instanceId: "w", stateId: "feature/plan/write" })] })],
  timeline: [],
  runs: [
    { runId: "r1", startedAt: 1_000, outcome: "canceled" },
    { runId: "r2", startedAt: 5_000, outcome: "canceled" },
  ],
} as unknown as TaskDetail;

describe("the panel of a task waiting on you", () => {
  const host = { startAgain: () => undefined, cancel: () => undefined, onStack: () => undefined, adoptTask: () => undefined };

  it("offers Cancel, never Start again or Resume, which would ask over the question it waits on", () => {
    const verbs = taskVerbsOf(host, closedUnder, undefined, false, true).map((v) => v.label);
    expect(verbs).toContain("Cancel");
    expect(verbs.some((label) => /Resume|Start again|Re-run/.test(label))).toBe(false);
    expect(taskVerbsOf(host, closedUnder, undefined, false).some((v) => v.primary === true)).toBe(true);
  });

  it("marks its conversation tab as waiting", () => {
    expect(taskTabs(undefined, closedUnder, true, true)[0]).toMatchObject({ id: "conversation", count: "!", tone: "amber" });
  });
});

describe("the strip of a run the app closed under while its agent asked", () => {
  it("says it is waiting for you where it was asking, counting from the run's start", () => {
    expect(activityOf(closedUnder, true, { rerun: true, resume: true }, "w")).toEqual({ kind: "going", waiting: true, where: "write" });
    expect(startedAtOf(closedUnder, true)).toBe(5_000);
    expect(startedAtOf(closedUnder)).toBeUndefined();
  });
});
