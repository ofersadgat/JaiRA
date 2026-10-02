/**
 * A card's origin line (decision 0010 §4, the rulings of 2026-09-25): a task the events task started
 * says so — "started by events · push_main · git.pushed a1b2c3d on main" — small, under its meta line,
 * and a click on it opens the events task AT the automation that started it, rather than selecting the
 * card. Two sources, one line: a CHILD carries it in its provenance (`origin.kind: "started"`), a task
 * started on its own in `startedBy`. What the line says is `originLineOf`'s, and that is held here;
 * the card that draws it is the universal tree's (its `card-origin` specimen).
 */
import { describe, expect, it } from "vitest";
import type { BoardCard, TaskOrigin } from "@jaira/shared/browser";
import { originLineOf } from "../src/renderer/boardModel";

const card = (patch: Partial<BoardCard> = {}): BoardCard => ({
  taskId: "t1",
  title: "Review",
  status: "running",
  workflow: "feature/review",
  activePath: [],
  hasSubBoard: false,
  updatedAt: 0,
  ...patch,
});

const STATE = "system/events/push_main";
/** Started on its own (`top_level: true`). */
const onItsOwn = card({
  startedBy: { by: "events", fromTask: "ev1", state: { key: "push_main", path: "push_main", stateId: STATE, occurrence: 0, call: 0 }, event: "git.pushed", summary: "git.pushed a1b2c3d on main" },
});
/** Started as the automation's child — the default. */
const child = card({
  origin: { kind: "started", taskId: "ev1", key: "push_main", index: 0, event: "git.pushed a1b2c3d on main", stateId: STATE, at: 0, boundary: 0, boundaryAt: 0, label: "started by events · push_main · git.pushed a1b2c3d on main" } satisfies TaskOrigin,
});

describe("the origin line", () => {
  it("is one line saying which automation started the task and why — for a child and for one on its own", () => {
    // Two sources, and the card cannot tell them apart: the same words from either.
    for (const c of [onItsOwn, child]) {
      expect(originLineOf(c)?.words).toBe("started by events · push_main · git.pushed a1b2c3d on main");
    }
  });

  it("is not there for a task a person started, nor for a fan-out's element", () => {
    expect(originLineOf(card())).toBeUndefined();
    expect(originLineOf(card({ origin: { kind: "task", taskId: "p", key: "work", index: 0, at: 0, boundary: 0, boundaryAt: 0, label: "element 1 of work" } }))).toBeUndefined();
  });

  it("says what it knows: no automation recorded (a task started before it was), no event handed", () => {
    expect(originLineOf(card({ startedBy: { by: "events", fromTask: "ev1", event: "", summary: "" } }))).toEqual({ words: "started by events", taskId: "ev1" });
    expect(originLineOf(card({ startedBy: { by: "events", fromTask: "ev1", event: "git.pushed", summary: "git.pushed a1b2c3d on main" } }))?.words).toBe("started by events · git.pushed a1b2c3d on main");
  });

  it("opens the events task AT the automation when clicked", () => {
    // Where the click goes is the line's own answer: the events task, and the automation's state in
    // it. That the card under the line is not selected on the way is the card's to hold.
    for (const c of [onItsOwn, child]) {
      const line = originLineOf(c);
      expect([line?.taskId, line?.stateId]).toEqual(["ev1", STATE]);
    }
  });
});
