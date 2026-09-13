/**
 * The lanes inside a board column: what the cards in one place are DOING.
 *
 * A column says WHERE a task is and a lane says whether anything is happening to it there, and the
 * whole value of the second question is that it is answered from TWO statuses. The task row knows
 * whether a task has started and whether it has ended; only the active instance knows that a running
 * task is parked on a question. Read from either one alone, the lane is wrong for a whole category
 * of card — which is what these guard.
 */
import { describe, expect, it } from "vitest";
import type { BoardCard } from "@jaira/shared/browser";
import { LANES, endedLabel, laneOf, lanesOf, waitingKindOf } from "../src/renderer/board";

const card = (patch: Partial<BoardCard> & Pick<BoardCard, "taskId">): BoardCard => ({
  title: patch.taskId,
  status: "running",
  workflow: "review",
  activePath: [],
  hasSubBoard: false,
  updatedAt: 0,
  ...patch,
});

describe("laneOf", () => {
  it("puts a task that has never run under not-started", () => {
    expect(laneOf(card({ taskId: "t1", status: "queued" }))).toBe("not-started");
  });

  it("treats every ending as finished, however it ended", () => {
    for (const status of ["completed", "failed", "canceled"] as const) {
      expect(laneOf(card({ taskId: "t1", status }))).toBe("finished");
    }
  });

  it("runs a task whose active instance is running", () => {
    expect(laneOf(card({ taskId: "t1", status: "running", activeStatus: "running" }))).toBe("running");
  });

  /**
   * The case the task row cannot answer. A task waiting on a person is `running` at the task level
   * and says so nowhere else — read from that status alone it sits in the running lane, which is the
   * one place a pause must never hide.
   */
  it("pauses a running task that is waiting on a person, or blocked on its inputs", () => {
    expect(laneOf(card({ taskId: "t1", status: "running", activeStatus: "waiting_for_user" }))).toBe("paused");
    expect(laneOf(card({ taskId: "t2", status: "running", activeStatus: "blocked" }))).toBe("paused");
  });

  /**
   * Holding for a dependency (decision 0003) is waiting on something other than itself, whatever
   * else the task is doing: a queued copy, or the task that split, running and parked at the mount
   * until the task its element requires completes. Finished is finished either way.
   */
  it("pauses a task that holds for another, queued or running, and never a finished one", () => {
    const holding = [{ taskId: "t9", title: "Beta", status: "queued" as const }];
    expect(laneOf(card({ taskId: "t1", status: "queued", waitingFor: holding }))).toBe("paused");
    expect(laneOf(card({ taskId: "t2", status: "running", activeStatus: "running", waitingFor: holding }))).toBe("paused");
    expect(laneOf(card({ taskId: "t3", status: "completed", waitingFor: holding }))).toBe("finished");
    expect(laneOf(card({ taskId: "t4", status: "queued", waitingFor: [] }))).toBe("not-started");
  });

  /** Stopped part-way and resumable — a pause somebody has to end, not an ending. */
  it("pauses an interrupted task rather than finishing it", () => {
    expect(laneOf(card({ taskId: "t1", status: "interrupted" }))).toBe("paused");
  });

  /** A card the board placed but whose instance status never arrived is still on the board. */
  it("runs a started task with no active instance status", () => {
    expect(laneOf(card({ taskId: "t1", status: "running" }))).toBe("running");
  });
});

describe("lanesOf", () => {
  const cards = [
    card({ taskId: "done", status: "completed" }),
    card({ taskId: "asking", status: "running", activeStatus: "waiting_for_user" }),
    card({ taskId: "new", status: "queued" }),
    card({ taskId: "live", status: "running", activeStatus: "running" }),
  ];

  it("orders the lanes the way work moves through them, not the way the cards arrived", () => {
    expect(lanesOf(cards).map((l) => l.lane)).toEqual([...LANES]);
  });

  it("keeps the board's own order inside a lane", () => {
    const more = [...cards, card({ taskId: "live2", status: "running", activeStatus: "running" })];
    const running = lanesOf(more).find((l) => l.lane === "running");
    expect(running?.cards.map((c) => c.taskId)).toEqual(["live", "live2"]);
  });

  /** An empty lane is not a heading over nothing — it is absent. */
  it("drops the lanes nothing is in", () => {
    expect(lanesOf([card({ taskId: "live" })]).map((l) => l.lane)).toEqual(["running"]);
  });

  it("says nothing at all about an empty column", () => {
    expect(lanesOf([])).toEqual([]);
  });

  /**
   * The one lane with an order of its own. Everywhere else the board's order is the projection's and
   * means something; a pile of ended runs has no such order, and the only question asked of one is
   * "what happened last".
   */
  it("puts the newest ending first, and leaves every other lane in board order", () => {
    const ended = [
      card({ taskId: "old", status: "completed", endedAt: 100 }),
      card({ taskId: "newest", status: "failed", endedAt: 300 }),
      card({ taskId: "mid", status: "canceled", endedAt: 200 }),
      card({ taskId: "b", status: "queued" }),
      card({ taskId: "a", status: "queued" }),
    ];
    const lanes = lanesOf(ended);
    expect(lanes.find((l) => l.lane === "finished")?.cards.map((c) => c.taskId)).toEqual(["newest", "mid", "old"]);
    expect(lanes.find((l) => l.lane === "not-started")?.cards.map((c) => c.taskId)).toEqual(["b", "a"]);
  });

  /** The task row's clock is the fallback, for a card the journal could not date. */
  it("falls back to updatedAt when a finished run recorded no ending", () => {
    const ended = [
      card({ taskId: "dated", status: "completed", endedAt: 100 }),
      card({ taskId: "undated", status: "completed", updatedAt: 500 }),
    ];
    expect(lanesOf(ended)[0]!.cards.map((c) => c.taskId)).toEqual(["undated", "dated"]);
  });

  /**
   * A column that is ALL finished is the commonest case there is — a workflow nobody is running —
   * and it takes the no-headings path, which used to hand back the unsorted input.
   */
  it("sorts a column that is nothing but finished cards, headings or not", () => {
    const ended = [
      card({ taskId: "old", status: "completed", endedAt: 100 }),
      card({ taskId: "new", status: "completed", endedAt: 300 }),
    ];
    const lanes = lanesOf(ended);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.cards.map((c) => c.taskId)).toEqual(["new", "old"]);
  });
});

/**
 * Which kind of waiting, for the card's second line (SHELL.md §5.3).
 *
 * The PILL merges the two, because `⏸5` is the number a person wants. The card keeps the difference,
 * because a gate is a state the author put there and `blocked` is the engine saying this run cannot
 * proceed on the inputs it was given — different problems, and different people's to fix.
 */
describe("waitingKindOf", () => {
  it("tells a gate from a run that cannot proceed", () => {
    expect(waitingKindOf(card({ taskId: "a", activeStatus: "waiting_for_user" }))).toBe("gate");
    expect(waitingKindOf(card({ taskId: "b", activeStatus: "blocked" }))).toBe("blocked");
  });

  it("says nothing at all about a card that is not parked", () => {
    // The trailing pill has already said what it is; a second word would be the duplication the
    // pill replaced.
    expect(waitingKindOf(card({ taskId: "c", activeStatus: "running" }))).toBeUndefined();
    expect(waitingKindOf(card({ taskId: "d", status: "completed" }))).toBeUndefined();
  });
});

/**
 * How long ago, to one unit. The question a finished card is actually asked is how stale it is, and
 * a clock reading makes you do that subtraction yourself.
 */
describe("endedLabel", () => {
  const now = new Date("2026-08-11T15:30:00").getTime();
  const ago = (ms: number): string => endedLabel(now - ms, now);

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("counts in the largest unit that fits, and only that one", () => {
    expect(ago(3 * SECOND)).toBe("3 seconds ago");
    expect(ago(3 * MINUTE)).toBe("3 minutes ago");
    expect(ago(3 * HOUR)).toBe("3 hours ago");
    expect(ago(3 * DAY)).toBe("3 days ago");
    // The remainder is dropped rather than spelled out: a card's footer has room for a fact.
    expect(ago(3 * HOUR + 59 * MINUTE)).toBe("3 hours ago");
  });

  it("says one of a unit in the singular", () => {
    expect(ago(1 * SECOND)).toBe("1 second ago");
    expect(ago(1 * MINUTE)).toBe("1 minute ago");
    expect(ago(1 * HOUR)).toBe("1 hour ago");
    expect(ago(1 * DAY)).toBe("1 day ago");
  });

  it("has something to say about an ending too recent to count", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(400)).toBe("just now");
  });

  /** A clock that has drifted, or a record written a moment ahead of the render. Not an error. */
  it("does not count backwards from a future timestamp", () => {
    expect(ago(-5 * MINUTE)).toBe("just now");
  });

  it("turns into a date once it is past a week", () => {
    const week = endedLabel(now - 7 * DAY, now);
    expect(week).not.toMatch(/ago/);
    expect(week).toMatch(/4/); // 4 August
    // Right up to the boundary it is still relative.
    expect(endedLabel(now - (7 * DAY - 1), now)).toBe("6 days ago");
  });

  it("keeps the year off a date from this year, and on one from another", () => {
    expect(endedLabel(new Date("2026-03-02T09:05:00").getTime(), now)).not.toMatch(/2026/);
    expect(endedLabel(new Date("2024-03-02T09:05:00").getTime(), now)).toMatch(/2024/);
  });
});
