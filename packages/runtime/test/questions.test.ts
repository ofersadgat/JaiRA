/**
 * The mid-run question hub — `AskUserQuestion`'s parking lot.
 *
 * The properties that matter: a question parks until ANSWERED (the agent's loop is blocked on it),
 * a dismissal is a real answer (`undefined` — "decide yourself"), an unattended hub answers that
 * immediately rather than parking forever, and cancel/close reaches every parked question so an
 * agent is never left waiting on a person who is gone.
 */
import { describe, expect, it } from "vitest";
import { QuestionHub } from "../src/questions";

const QUESTIONS = [
  {
    question: "Which library?",
    header: "Library",
    options: [
      { label: "date-fns", description: "small" },
      { label: "luxon", description: "batteries" },
    ],
  },
];

describe("QuestionHub", () => {
  it("parks a question and resolves it with the human's answers", async () => {
    const requests: string[] = [];
    const hub = new QuestionHub({ onRequest: (r) => requests.push(r.requestId) });
    const asked = hub.asker({ taskId: "t1" })({ questions: QUESTIONS, sessionId: "s1" });
    expect(requests).toEqual(["question-1"]);
    expect(hub.list()).toMatchObject([{ requestId: "question-1", taskId: "t1", sessionId: "s1" }]);
    expect(hub.answer("question-1", { "Which library?": "luxon" })).toBe(true);
    await expect(asked).resolves.toEqual({ "Which library?": "luxon" });
    expect(hub.list()).toEqual([]);
  });

  it("resolves a dismissal as undefined — 'decide yourself', not an error", async () => {
    const hub = new QuestionHub({ onRequest: () => {} });
    const asked = hub.asker()({ questions: QUESTIONS, sessionId: "s1" });
    expect(hub.answer("question-1", undefined)).toBe(true);
    await expect(asked).resolves.toBeUndefined();
  });

  it("answers immediately when nobody is listening — an unattended run must not park", async () => {
    const hub = new QuestionHub();
    await expect(hub.asker()({ questions: QUESTIONS, sessionId: "s1" })).resolves.toBeUndefined();
    expect(hub.list()).toEqual([]);
  });

  it("returns false for an unknown or already-answered id", () => {
    const hub = new QuestionHub({ onRequest: () => {} });
    void hub.asker()({ questions: QUESTIONS, sessionId: "s1" });
    expect(hub.answer("question-9", {})).toBe(false);
    expect(hub.answer("question-1", {})).toBe(true);
    expect(hub.answer("question-1", {})).toBe(false);
  });

  it("dismisses per task on cancel, and everything on close", async () => {
    const resolved: Array<[string, unknown]> = [];
    const hub = new QuestionHub({ onRequest: () => {}, onResolved: (id, answers) => resolved.push([id, answers]) });
    const a = hub.asker({ taskId: "a" })({ questions: QUESTIONS, sessionId: "s1" });
    const b = hub.asker({ taskId: "b" })({ questions: QUESTIONS, sessionId: "s2" });
    hub.dismissFor("a");
    await expect(a).resolves.toBeUndefined();
    expect(hub.list()).toHaveLength(1);
    hub.dismissAll();
    await expect(b).resolves.toBeUndefined();
    expect(resolved).toEqual([
      ["question-1", undefined],
      ["question-2", undefined],
    ]);
  });
});
