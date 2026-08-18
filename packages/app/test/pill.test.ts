/**
 * The pill vocabulary and its fold (SHELL.md §4).
 *
 * Two properties carry the design and neither is obvious from reading the layout function:
 *
 *  - **A live run is never folded away.** `running` heads the priority order and the first pill goes
 *    in whatever the budget, so no width — down to a 46px rail — can turn "something is working"
 *    into a silent `+5`.
 *  - **`+N` counts items, not kinds.** It is the number that shrinks as a person works through the
 *    backlog, which "3 kinds hidden" is not.
 */
import { describe, expect, it } from "vitest";
import type { EndedTask, TaskStatus } from "@jaira/shared/browser";
import {
  PILL_ORDER,
  layoutPills,
  pillFill,
  pillKindOf,
  pillTotal,
  projectCounts,
  tally,
  unseenTasks,
  type CountedProject,
  type PillCounts,
} from "../src/renderer/pill";

const kinds = (counts: PillCounts, budget: number): string[] => layoutPills(counts, budget).fit.map((f) => `${f.kind}${f.n}`);

describe("pillKindOf", () => {
  it("folds a gate and a tool approval into one pill", () => {
    // Both are "it stopped, and it is on you". The APPROVALS STRIP still separates them, because
    // there the difference is real — an approval has an agent's tool loop parked behind it.
    expect(pillKindOf("waiting_for_user")).toBe("waiting");
    expect(pillKindOf("blocked")).toBe("waiting");
  });

  it("separates what the MODEL could not do from what merely stopped", () => {
    expect(pillKindOf("failed")).toBe("error");
    expect(pillKindOf("timeout")).toBe("error");
    expect(pillKindOf("canceled")).toBe("warning");
    // OPEN (SHELL.md §9.1): filed as a warning because the active set is exactly working and
    // waiting-on-you. If it becomes active, this expectation is the one that says so.
    expect(pillKindOf("interrupted")).toBe("warning");
  });

  it("gives queued no pill at all", () => {
    // Nothing is happening and nothing has happened, so a pill would put a mark against every task
    // somebody created and has not started.
    expect(pillKindOf("queued")).toBeNull();
    expect(pillKindOf(undefined)).toBeNull();
    expect(pillTotal(tally({}, "queued"))).toBe(0);
  });

  it("fills exactly the two kinds that are live facts", () => {
    const filled = PILL_ORDER.filter((kind) => pillFill(kind) === "active");
    expect(filled).toEqual(["running", "waiting"]);
  });
});

describe("layoutPills", () => {
  const busy: PillCounts = { running: 2, waiting: 3, error: 1, warning: 1, success: 4 };

  it("draws every pill when there is room, in priority order", () => {
    expect(kinds(busy, 1000)).toEqual(["running2", "waiting3", "error1", "warning1", "success4"]);
    expect(layoutPills(busy, 1000).rest).toBe(0);
  });

  it("keeps the running pill at any width, and folds the rest behind it", () => {
    // The property the order exists for: a sidebar squeezed to a rail still says something is
    // working. 0 is not a realistic budget — it is the proof that no realistic one is worse.
    for (const budget of [0, 10, 30, 46]) {
      const { fit, rest } = layoutPills(busy, budget);
      expect(fit.map((f) => f.kind)).toEqual(["running"]);
      expect(rest).toBe(9);
    }
  });

  it("folds to a bare +N when nothing is running", () => {
    const quiet: PillCounts = { error: 1, success: 4 };
    const { fit, rest } = layoutPills(quiet, 20);
    // The first kind present still goes in — the fold is what is BEHIND the first pill, not instead
    // of it. What differs from the busy case is that the pill it keeps is not a live run.
    expect(fit.map((f) => f.kind)).toEqual(["error"]);
    expect(rest).toBe(4);
  });

  it("counts items behind the fold, not kinds", () => {
    const { rest } = layoutPills({ running: 1, error: 7, success: 30 }, 60);
    // Two kinds hidden, thirty-seven items. The number that shrinks as they are worked through.
    expect(rest).toBe(37);
  });

  it("reserves room for +N before admitting the pill that would displace it", () => {
    // A budget wide enough for two pills but not for two pills AND the overflow keeps one, so the
    // fold always has somewhere to be drawn.
    const two = layoutPills(busy, 56);
    expect(two.fit).toHaveLength(1);
    expect(two.rest).toBe(9);
  });

  it("says nothing at all about an empty tally", () => {
    expect(layoutPills({}, 200)).toEqual({ fit: [], rest: 0 });
  });
});

describe("projectCounts", () => {
  const summary = (patch: Partial<CountedProject>): CountedProject => ({
    statuses: {},
    waiting: 0,
    ended: [],
    ...patch,
  });
  const ended = (status: TaskStatus, n: number, updatedAt = 10): EndedTask[] =>
    Array.from({ length: n }, (_, i) => ({ taskId: `${status}-${i}`, status, updatedAt }));

  it("takes the parked tasks OUT of the running count", () => {
    // `waiting` is a subset of `running` — a task at a gate is `running` in the runtime row and says
    // so nowhere else. Counting both from `running` would show the same task twice.
    expect(projectCounts(summary({ statuses: { running: 5 }, waiting: 3 }))).toEqual({ running: 2, waiting: 3 });
  });

  it("shows no running pill when every running task is parked", () => {
    expect(projectCounts(summary({ statuses: { running: 2 }, waiting: 2 }))).toEqual({ waiting: 2 });
  });

  it("merges the two ways a run stops without failing", () => {
    const project = summary({ ended: [...ended("interrupted", 1), ...ended("canceled", 2)] });
    expect(projectCounts(project)).toEqual({ warning: 3 });
  });

  it("counts a status pill only for what has changed since this person looked", () => {
    const project = summary({ ended: ended("completed", 3) });
    expect(projectCounts(project)).toEqual({ success: 3 });
    // Two of the three read. `✓3` was never "three that ever finished" — it is what moved while you
    // were somewhere else, and it is the number that shrinks as you work through it.
    expect(projectCounts(project, { "completed-0": 10, "completed-1": 99 })).toEqual({ success: 1 });
    expect(projectCounts(project, { "completed-0": 10, "completed-1": 10, "completed-2": 10 })).toEqual({});
  });

  it("leaves the ACTIVE pills alone however much has been read", () => {
    // A live fact is true whether or not anybody looked, so no watermark clears it — which is the
    // whole difference between the two kinds. (OPEN: SHELL.md §9.3 asks whether it should be.)
    const project = summary({ statuses: { running: 2 }, waiting: 1, ended: ended("completed", 1) });
    const allSeen = { "completed-0": 10 };
    expect(projectCounts(project, allSeen)).toEqual({ running: 1, waiting: 1 });
  });

  it("marks exactly the rows its pills were counting", () => {
    const project = summary({ ended: [...ended("completed", 2), ...ended("failed", 1, 40)] });
    expect(unseenTasks(project)).toEqual([
      { taskId: "completed-0", at: 10 },
      { taskId: "completed-1", at: 10 },
      { taskId: "failed-0", at: 40 },
    ]);
    // A mark moves to the TASK's own clock, not to "now": a turn landing in the same millisecond as
    // the click would otherwise be swallowed by it.
    expect(unseenTasks(project, { "completed-0": 10 })).toEqual([
      { taskId: "completed-1", at: 10 },
      { taskId: "failed-0", at: 40 },
    ]);
  });

  it("leaves queued tasks out entirely", () => {
    expect(projectCounts(summary({ statuses: { queued: 9 } }))).toEqual({});
  });
});
