/**
 * Which cards the board offers to move, and where — `dragOffersOf` (WORKFLOWS.md §7.4).
 *
 * The rule being tested is that BOTH ENDS have to be on screen. A wait names a task and a child key;
 * the board draws some tasks and some columns; and a drag is offered exactly where the two meet. Get
 * that wrong in either direction and the board either refuses a move a workflow is waiting for, or
 * offers one that would land nowhere.
 */
import { describe, expect, it } from "vitest";
import type { BoardCard, BoardView, PendingUserEvent } from "@jaira/shared/browser";
import { canDrag, dragOffersOf, requestFor } from "../src/renderer/taskDrag";

const card = (taskId: string): BoardCard => ({
  taskId,
  title: taskId,
  status: "running",
  workflow: "review",
  activePath: [],
  hasSubBoard: false,
  updatedAt: 0,
});

const board = (columns: Record<string, string[]>, atLevel: string[] = []): BoardView => ({
  level: "review",
  breadcrumb: [],
  columns: Object.entries(columns).map(([key, tasks]) => ({ key, stateId: `review/${key}`, cards: tasks.map(card) })),
  atLevel: atLevel.map(card),
  finished: [],
});

const wait = (over: Partial<PendingUserEvent> = {}): PendingUserEvent => ({
  requestId: "event-1",
  event: "task_drag",
  options: { to_state: "deploy" },
  taskId: "t1",
  at: 0,
  project: "/p",
  ...over,
});

describe("a wait becomes a drag offer", () => {
  const view = board({ triage: ["t1"], deploy: [] });

  it("offers the card the column its rule names", () => {
    const offers = dragOffersOf(view, [wait()]);
    expect(canDrag(offers, "t1")).toBe(true);
    expect(requestFor(offers, "t1", "deploy")).toBe("event-1");
  });

  it("offers nothing on a column the rule does not name", () => {
    const offers = dragOffersOf(view, [wait()]);
    expect(requestFor(offers, "t1", "triage")).toBeUndefined();
  });

  it("offers nothing for a task with no wait", () => {
    const offers = dragOffersOf(board({ triage: ["t1", "t2"], deploy: [] }), [wait()]);
    expect(canDrag(offers, "t2")).toBe(false);
  });
});

describe("both ends have to be on this board", () => {
  /**
   * `to_state` is a child key of the state whose transition is waiting — one level down from THIS
   * board. A wait belonging to a deeper state names a key no column here has, and dropping a card on
   * a column the rule never meant would be a move the board invented.
   */
  it("ignores a wait whose destination is not a column here", () => {
    const offers = dragOffersOf(board({ triage: ["t1"] }), [wait({ options: { to_state: "somewhere_else" } })]);
    expect(canDrag(offers, "t1")).toBe(false);
  });

  /** Every project's waits arrive on one list, so a card that is not drawn here must not light up. */
  it("ignores a wait for a task this board is not showing", () => {
    const offers = dragOffersOf(board({ triage: ["t2"], deploy: [] }), [wait({ taskId: "t1" })]);
    expect(canDrag(offers, "t1")).toBe(false);
  });

  it("counts a card sitting at this level, not in any column", () => {
    const offers = dragOffersOf(board({ deploy: [] }, ["t1"]), [wait()]);
    expect(requestFor(offers, "t1", "deploy")).toBe("event-1");
  });

  /** A wait with no destination at all — a rule whose `to` terminates the run. Nothing to drop on. */
  it("ignores a wait with no destination", () => {
    const offers = dragOffersOf(board({ triage: ["t1"] }), [wait({ options: {} })]);
    expect(canDrag(offers, "t1")).toBe(false);
  });

  it("ignores an event that is not a drag", () => {
    const offers = dragOffersOf(board({ triage: ["t1"], deploy: [] }), [wait({ event: "something_else" })]);
    expect(canDrag(offers, "t1")).toBe(false);
  });
});

describe("more than one offer", () => {
  const view = board({ triage: ["t1"], deploy: [], park: [] });

  it("gives one card a target per rule", () => {
    const offers = dragOffersOf(view, [
      wait(),
      wait({ requestId: "event-2", options: { to_state: "park" } }),
    ]);
    expect(requestFor(offers, "t1", "deploy")).toBe("event-1");
    expect(requestFor(offers, "t1", "park")).toBe("event-2");
  });

  /**
   * Two rules offering the same move: the engine evaluates transitions in declared order and takes
   * the first match, so the drop answers the earlier one. Answering the later one would fire a rule
   * the run would never have reached.
   */
  it("keeps the first wait when two name the same column", () => {
    const offers = dragOffersOf(view, [wait(), wait({ requestId: "event-2" })]);
    expect(requestFor(offers, "t1", "deploy")).toBe("event-1");
  });
});
