/**
 * Which columns of a RUN's board a drag can land on — `runDragOffersOf` (WORKFLOWS.md §7.4).
 *
 * The Tasks board reads the waits through `dragOffersOf`, keyed by task; the board a double-click on
 * a run lands on draws that run's children as columns and has one task in view, so its question is
 * narrower: of this task's waits, which name a column here? Both ends still have to be on screen —
 * a wait aimed at a `terminate.*` rule has no column and offers nothing, and a wait of another task
 * is not this board's business however well its target matches.
 */
import { describe, expect, it } from "vitest";
import type { PendingUserEvent } from "@jaira/shared/browser";
import { runDragOffersOf } from "../src/renderer/runViews";

const wait = (over: Partial<PendingUserEvent> = {}): PendingUserEvent => ({
  requestId: "event-1",
  event: "task_drag",
  options: { to_state: "ux" },
  taskId: "t1",
  at: 0,
  project: "/p",
  ...over,
});

const COLUMNS = [{ key: "product" }, { key: "ux" }, { key: "ui" }];

describe("runDragOffersOf", () => {
  it("offers the column a wait of this task names", () => {
    const offers = runDragOffersOf("t1", COLUMNS, [wait()]);
    expect([...offers]).toEqual([["ux", "event-1"]]);
  });

  it("offers nothing for another task's wait, or with no task in view", () => {
    expect(runDragOffersOf("t1", COLUMNS, [wait({ taskId: "t2" })]).size).toBe(0);
    expect(runDragOffersOf(undefined, COLUMNS, [wait()]).size).toBe(0);
  });

  it("ignores a wait whose target is not a column here, and a wait that is not a drag", () => {
    expect(runDragOffersOf("t1", COLUMNS, [wait({ options: { to_state: "deploy" } })]).size).toBe(0);
    expect(runDragOffersOf("t1", COLUMNS, [wait({ options: {} })]).size).toBe(0);
    expect(runDragOffersOf("t1", COLUMNS, [wait({ event: "approve" })]).size).toBe(0);
  });

  it("keeps the FIRST wait where two rules offer the same move, matching the engine's order", () => {
    const offers = runDragOffersOf("t1", COLUMNS, [wait({ requestId: "first" }), wait({ requestId: "second" })]);
    expect(offers.get("ux")).toBe("first");
  });
});
