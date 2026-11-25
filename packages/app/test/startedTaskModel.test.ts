/**
 * A started task's line, and how it opens (the mockups of 2026-11-24, `child-asks-ways-in.html`). The
 * person: "1. if you click on the arrow or start task, it should open just that task inline by default
 * 2. if you click on "waiting for ...." it should open all tasks to reveal the dialog in question inline
 * … 4. if you mouse over the row there should be the same … but which only opens a single level."
 */
import { describe, expect, it } from "vitest";
import { asksBelow, nestAfterAsks, SHUT, toggledDeep, toggledOne } from "../src/renderer/startedTaskModel";

const tasks = [
  { taskId: "talk", title: "Vercel build failure debugging" },
  { taskId: "review", title: "Review a conversation for lessons", origin: { kind: "started", taskId: "talk" } },
  { taskId: "lesson", title: "Lesson: check before asking", origin: { kind: "started", taskId: "review" } },
  { taskId: "other", title: "Another review", origin: { kind: "started", taskId: "talk" } },
  { taskId: "fork", title: "A fork", origin: { kind: "fork", taskId: "review" } },
];
const none = { pending: [], questions: [], approvals: [] };

describe("what is asked under a started task", () => {
  it("is every ask at any depth, with the titles down to the task that asks", () => {
    const asks = { ...none, pending: [{ taskId: "lesson", component: "choose_option" }] };
    expect(asksBelow("review", tasks, asks)).toEqual([{ taskId: "lesson", path: ["Lesson: check before asking"], step: "choose option" }]);
    expect(asksBelow("talk", tasks, asks)).toEqual([{ taskId: "lesson", path: ["Review a conversation for lessons", "Lesson: check before asking"], step: "choose option" }]);
    // Not a sibling's, and not a fork's — a fork is a copy, not a child.
    expect(asksBelow("other", tasks, asks)).toEqual([]);
    expect(asksBelow("fork", tasks, { ...none, pending: [{ taskId: "review", component: "choose_option" }] })).toEqual([]);
  });

  it("counts its own ask with no path, an agent's question and approval, and the oldest first", () => {
    const asks = {
      pending: [{ taskId: "review", component: "review_artifact" }],
      questions: [{ taskId: "lesson", at: 20 }],
      approvals: [{ taskId: "lesson", at: 10, tool: "Bash", command: "git push origin main" }],
    };
    expect(asksBelow("review", tasks, asks).map((a) => [a.taskId, a.path.length, a.step])).toEqual([
      ["lesson", 1, "approve git push"],
      ["lesson", 1, "answer"],
      ["review", 0, "review artifact"],
    ]);
  });

  it("is never a conversation waiting for its next message, nor a move's question", () => {
    const asks = { ...none, pending: [{ taskId: "lesson", component: "input" }, { taskId: "lesson", component: "choose_option", moves: true }] };
    expect(asksBelow("review", tasks, asks)).toEqual([]);
  });
});

describe("opening a started task", () => {
  it("opens one level from the line, and down to the question from its wait — a second press shuts", () => {
    expect(toggledOne(SHUT)).toEqual({ mode: "one", by: "you" });
    expect(toggledOne({ mode: "deep", by: "ask" })).toEqual(SHUT);
    expect(toggledDeep(SHUT)).toEqual({ mode: "deep", by: "you" });
    expect(toggledDeep({ mode: "one", by: "you" })).toEqual({ mode: "deep", by: "you" });
    expect(toggledDeep({ mode: "deep", by: "you" })).toEqual(SHUT);
  });

  it("opens down to a new question by itself while shown nowhere else, and shuts what a question opened once answered", () => {
    expect(nestAfterAsks(SHUT, 0, 1, false)).toEqual({ mode: "deep", by: "ask" });
    // Shown beside or in the panel: the question is drawn there.
    expect(nestAfterAsks(SHUT, 0, 1, true)).toEqual(SHUT);
    // Answered: a nest the question opened shuts; one the person opened stays.
    expect(nestAfterAsks({ mode: "deep", by: "ask" }, 1, 0, false)).toEqual(SHUT);
    expect(nestAfterAsks({ mode: "one", by: "you" }, 1, 0, false)).toEqual({ mode: "one", by: "you" });
    // Open already: a second question leaves it as it is.
    expect(nestAfterAsks({ mode: "one", by: "you" }, 1, 2, false)).toEqual({ mode: "one", by: "you" });
  });
});
