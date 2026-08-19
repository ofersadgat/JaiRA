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
  addCounts,
  layoutPills,
  minusCounts,
  pillFill,
  pillKindOf,
  pillTotal,
  projectCounts,
  tally,
  taskCounts,
  unseenRows,
  unseenTasks,
  type CountedProject,
  type CountedTask,
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
    // A warning, decided (SHELL.md §9.1): nothing is happening and nothing is being asked of you
    // until somebody goes and restarts it, which is neither half of what `active` means.
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
    expect(layoutPills({}, 200)).toEqual({ fit: [], rest: 0, worst: null });
  });

  it("colours the fold by the worst thing behind it, not by the commonest", () => {
    // §9.2, decided. Colourless, a folded error and a folded success were the same grey `+4` — the
    // fold hiding the one fact it exists to summarise.
    const wide = 1000;
    expect(layoutPills({ running: 1, error: 1, success: 9 }, wide).worst).toBeNull();
    // One error behind thirty successes still makes the fold red: severity, not volume.
    expect(layoutPills({ running: 1, error: 1, success: 30 }, 60).worst).toBe("error");
    expect(layoutPills({ running: 1, warning: 2, success: 30 }, 60).worst).toBe("warning");
    // And a fold that hides only good news says so rather than borrowing an alarm.
    expect(layoutPills({ running: 1, success: 30 }, 60).worst).toBe("success");
  });

  it("ranks the fold by alarm, which is not the order the pills claim room in", () => {
    // `running` heads PILL_ORDER because no width may hide a live run; it is near the BOTTOM of
    // severity because a run that is hidden will say so again by itself. The two orders disagree at
    // both ends, which is why there are two.
    expect(layoutPills({ waiting: 1, running: 1 }, 0).fit.map((f) => f.kind)).toEqual(["running"]);
    expect(layoutPills({ waiting: 1, running: 1 }, 0).worst).toBe("waiting");
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
    // whole difference between the two kinds, and the whole point of the pills (§9.3, decided):
    // knowing what is happening without opening the view. Clearing `▶2` on a glance would leave two
    // runs going and nothing on screen saying so.
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

/**
 * A view row counts one ROOM, not the project (SHELL.md §4.3).
 *
 * The fault these guard is a real one and it was invisible: both root rows were given the same
 * summed tally, so **All conversations** wore a `✓` for a workflow run that finished — a mark
 * pointing at a place that did not contain the thing it pointed at, with no row further down
 * repeating it, so there was nothing to follow the mark to.
 */
describe("taskCounts", () => {
  const row = (patch: Partial<CountedTask> & Pick<CountedTask, "taskId">): CountedTask => ({
    status: "completed",
    updatedAt: 10,
    ...patch,
  });

  it("counts a live run whether or not anybody has looked", () => {
    expect(taskCounts([row({ taskId: "a", status: "running" })], { a: 99 })).toEqual({ running: 1 });
  });

  it("counts a stopped run only until it has been read", () => {
    const rows = [row({ taskId: "a" }), row({ taskId: "b", status: "failed", updatedAt: 40 })];
    expect(taskCounts(rows)).toEqual({ success: 1, error: 1 });
    expect(taskCounts(rows, { a: 10 })).toEqual({ error: 1 });
    expect(taskCounts(rows, { a: 10, b: 40 })).toEqual({});
  });

  it("marks exactly the stopped rows, and never the live ones", () => {
    const rows = [row({ taskId: "a" }), row({ taskId: "b", status: "running" })];
    expect(unseenRows(rows)).toEqual([{ taskId: "a", at: 10 }]);
  });

  it("leaves a queued row out, which is what having no pill means", () => {
    expect(taskCounts([row({ taskId: "a", status: "queued" })])).toEqual({});
    expect(unseenRows([row({ taskId: "a", status: "queued" })])).toEqual([]);
  });
});

describe("splitting a project between its rooms", () => {
  it("gives Tasks what is left once the conversations are taken out", () => {
    const project: PillCounts = { running: 3, success: 4 };
    const chats: PillCounts = { running: 1, success: 1 };
    expect(minusCounts(project, chats)).toEqual({ running: 2, success: 3 });
  });

  it("floors at zero rather than propagating a disagreement", () => {
    // The two sides are counted from different places: `waiting` is broken out of `running` on a
    // summary and is not visible on a task row at all. A negative count is not worth carrying.
    expect(minusCounts({ running: 1 }, { running: 2, error: 1 })).toEqual({});
  });

  it("sums the projects for the row that stands over all of them", () => {
    expect(addCounts({ running: 1, success: 2 }, { success: 1, error: 3 })).toEqual({
      running: 1,
      success: 3,
      error: 3,
    });
  });
});
