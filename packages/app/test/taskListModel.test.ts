/**
 * The project panel's Tasks tab as a list (boards 39, 44, 47): its tasks and not its conversations,
 * one word per status with the person's own waits first, and the column head's groups and sorts.
 */
import { describe, expect, it } from "vitest";
import type { BoardCard } from "@jaira/shared";
import { arrangeTasks, cardWhenOf, standingOf, tasksOf, unseenKindOf, type TaskSection } from "../src/renderer/taskListModel";
import { shownClockOf } from "../src/renderer/pillModel";
import { windowClockOf } from "../src/renderer/boardModel";

const card = (taskId: string, title: string, status: BoardCard["status"], updatedAt: number, extra: Partial<BoardCard> = {}): BoardCard =>
  ({ taskId, title, status, workflow: "feature", activePath: [], hasSubBoard: false, updatedAt, ...extra }) as BoardCard;

const cards = [
  card("t1", "Sidebar grouping", "running", 50, { asking: "gate" }),
  card("t2", "Nightly build", "running", 40, { workflow: "ci", project: "/b" }),
  card("t3", "Licenses check", "failed", 30, { workflow: "ci" }),
  card("t4", "Tool-error audit", "completed", 20),
];
const facts = { placeOf: (c: BoardCard) => (c.project === "/b" ? "build-box" : undefined), home: "JaiRA" };
const shape = (sections: TaskSection[]): Array<[string, string[]]> => sections.map((s) => [s.label, s.rows.map((r) => r.taskId)]);

describe("the Tasks tab's rows", () => {
  it("are the project's tasks once each, its conversations left to the Chat tab", () => {
    const chat = card("c1", "Plan the rota", "completed", 60, { workflow: "chat/session" });
    const dynamic = card("c2", "Moved", "running", 60, { startedBy: { by: "chat" } as BoardCard["startedBy"] });
    expect(tasksOf([...cards, cards[0]!, chat, dynamic]).map((c) => c.taskId)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("say where each stands, a wait on the person before anything else", () => {
    expect(cards.map((c) => standingOf(c).word)).toEqual(["Asks you", "Running", "Failed", "Done"]);
    expect(standingOf(card("t", "x", "archived", 0, { asking: "gate" })).word).toBe("Archived");
  });
});

describe("the column head", () => {
  it("sorts by state, most urgent first, turned round on a second press", () => {
    expect(shape(arrangeTasks(cards, { group: "none", sort: "state-asc" }, facts))).toEqual([["", ["t1", "t2", "t3", "t4"]]]);
    expect(shape(arrangeTasks(cards, { group: "none", sort: "state-desc" }, facts))).toEqual([["", ["t4", "t3", "t2", "t1"]]]);
    expect(shape(arrangeTasks(cards, { group: "none", sort: "name-asc" }, facts))).toEqual([["", ["t3", "t2", "t1", "t4"]]]);
  });

  it("says and sorts When by the last activity by default, or by when each was made", () => {
    // Made in the opposite order to their last activity; t4 says nothing of its making.
    const made = cards.map((c, i) => (i < 3 ? { ...c, createdAt: 10 + i } : c));
    expect(cardWhenOf(made[0]!, "activity")).toBe(50);
    expect(cardWhenOf(made[0]!, "created")).toBe(10);
    expect(cardWhenOf(made[3]!, "created")).toBe(20);
    expect(shape(arrangeTasks(made, { group: "none", sort: "when-desc" }, facts))).toEqual([["", ["t1", "t2", "t3", "t4"]]]);
    expect(shape(arrangeTasks(made, { group: "none", sort: "when-desc", when: "created" }, facts))).toEqual([["", ["t4", "t3", "t2", "t1"]]]);
  });

  it("groups by status in that order, the person's waits and failures marked", () => {
    const sections = arrangeTasks(cards, { group: "status", sort: "when-desc" }, facts);
    expect(shape(sections)).toEqual([
      ["Asks you", ["t1"]],
      ["Running", ["t2"]],
      ["Failed", ["t3"]],
      ["Done", ["t4"]],
    ]);
    expect(sections.map((s) => s.tone)).toEqual(["warn", undefined, "bad", undefined]);
  });

  it("groups by workflow by name, and by workspace the project's own first", () => {
    expect(shape(arrangeTasks(cards, { group: "workflow", sort: "when-desc" }, facts))).toEqual([
      ["ci", ["t2", "t3"]],
      ["feature", ["t1", "t4"]],
    ]);
    expect(shape(arrangeTasks(cards, { group: "workspace", sort: "when-desc" }, facts))).toEqual([
      ["JaiRA", ["t1", "t3", "t4"]],
      ["build-box", ["t2"]],
    ]);
  });
});

describe("an unseen task's dot (the unseen-tasks mockups, design 1)", () => {
  it("is lit until the task is read as far as its own clock, and comes back when it moves on", () => {
    const done = card("t4", "Tool-error audit", "completed", 20);
    expect(unseenKindOf(done, {})).toBe("success");
    expect(unseenKindOf(done, { t4: 19 })).toBe("success");
    expect(unseenKindOf(done, { t4: 20 })).toBeNull();
    expect(unseenKindOf({ ...done, updatedAt: 25 }, { t4: 20 })).toBe("success");
  });

  // The person, 2026-11-23: "if a child task updates, it should also mark the parent as unseen as well (recursively)".
  it("comes back when a task under it moves, and goes once it is read that far", () => {
    const parent = { ...card("t4", "Tool-error audit", "completed", 20), childAt: 30 };
    expect(unseenKindOf(parent, { t4: 20 })).toBe("success");
    expect(unseenKindOf(parent, { t4: 30 })).toBeNull();
  });

  // The person, 2026-11-24: "it isnt really unseen, its unseen or active … The main case where seeing the
  // item causes it to disappear is if it has terminated".
  it("stays lit while the task works or waits, read or not — only how it ended goes out once read", () => {
    expect(unseenKindOf(card("b", "x", "running", 10), { b: 99 })).toBe("running");
    expect(unseenKindOf(card("a", "x", "running", 10, { asking: "child" }), { a: 99 })).toBe("waiting");
    expect(unseenKindOf(card("c", "x", "failed", 10), { c: 99 })).toBeNull();
  });

  it("is the Chat ring's colour for it — a paused or canceled task yellow, though its square is grey", () => {
    expect(unseenKindOf(card("a", "x", "running", 1, { asking: "gate" }), {})).toBe("waiting");
    expect(unseenKindOf(card("b", "x", "running", 1), {})).toBe("running");
    expect(unseenKindOf(card("c", "x", "failed", 1), {})).toBe("error");
    expect(unseenKindOf(card("d", "x", "interrupted", 1), {})).toBe("warning");
    expect(unseenKindOf(card("e", "x", "canceled", 1), {})).toBe("warning");
    expect(standingOf(card("d", "x", "interrupted", 1)).tone).toBe("dim");
  });

  it("is not worn by an archived task, a queued one, or a process", () => {
    expect(unseenKindOf(card("a", "x", "archived", 1, { archived: { at: 1, from: "completed" } } as Partial<BoardCard>), {})).toBeNull();
    expect(unseenKindOf(card("q", "x", "queued", 1), {})).toBeNull();
    expect(unseenKindOf(card("p", "x", "running", 1, { type: "process" } as Partial<BoardCard>), {})).toBeNull();
  });
});

describe("how far opening a task marks it read", () => {
  it("is the newest clock any list holds for it, so no indicator stays lit on the task being read", () => {
    const conversation = { taskId: "t1", updatedAt: 10, lastMessageAt: 40 };
    const ended = { taskId: "t1", updatedAt: 30 };
    expect(shownClockOf("t1", [[conversation], [ended], [{ taskId: "t2", updatedAt: 99 }]])).toBe(40);
    expect(shownClockOf("t9", [[conversation]])).toBe(0);
  });

  it("reads the boards' cards too — the clock the Tasks list and the board compare against", () => {
    const done = card("t2", "Nightly build", "completed", 70);
    const board = { level: "", breadcrumb: [], columns: [{ key: "build", label: "build", cards: [done] }], atLevel: [] } as never;
    const lists = { tasks: [{ taskId: "t2", updatedAt: 50 }], allConversations: [], projects: [{ ended: [] }], boards: { "/a": board, "/b": null } };
    expect(windowClockOf("t2", lists)).toBe(70);
    expect(unseenKindOf(done, { t2: windowClockOf("t2", lists) })).toBeNull();
  });
});
