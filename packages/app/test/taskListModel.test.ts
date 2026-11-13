/**
 * The project panel's Tasks tab as a list (boards 39, 44, 47): its tasks and not its conversations,
 * one word per status with the person's own waits first, and the column head's groups and sorts.
 */
import { describe, expect, it } from "vitest";
import type { BoardCard } from "@jaira/shared";
import { arrangeTasks, cardWhenOf, standingOf, tasksOf, type TaskSection } from "../src/renderer/taskListModel";

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
