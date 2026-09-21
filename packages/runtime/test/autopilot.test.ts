/**
 * What a fast-forward asks the controlling conversation (runtime `autopilot.ts`, decision 0005 §4).
 *
 * The pure half: the one call's prompt, and reading its reply. The call is asked to answer AS THE
 * PERSON WOULD, from what they said, with the question exactly as they would have seen it — and it
 * returns a value and a confidence rather than calling `answer_question` itself, because the threshold is the
 * host's to apply, not the model's.
 */
import { describe, expect, it } from "vitest";
import { AUTOPILOT_OUTPUT_SCHEMA, autopilotAnswerOf, autopilotAnswersOf, autopilotOperation } from "../src/autopilot";

describe("autopilotOperation", () => {
  it("carries the conversation, the destination and the question as it was asked", () => {
    const op = autopilotOperation(
      { kind: "interaction", component: "choose_option", inputs: { prompt: "Go ahead?", options: ["go", "change"] } },
      { title: "Pause and stop", target: "feature/implementation", at: "ux → verify_plan", said: [{ role: "user", text: "ok, now implement it" }] },
    );
    const user = op.user ?? "";
    expect(user).toContain("Answer it AS THEY WOULD");
    expect(user).toContain("## The work: Pause and stop");
    expect(user).toContain("It is being fast-forwarded to `feature/implementation`, and stands at `ux → verify_plan`.");
    expect(user).toContain("**user**: ok, now implement it");
    expect(user).toContain('"prompt": "Go ahead?"');
    // The shape the component's result takes, so a valid answer is possible at all.
    expect(user).toContain('`{ "decision": "<one of the options\' values>"');
    expect(op.output).toMatchObject({ name: "autopilot", schema: AUTOPILOT_OUTPUT_SCHEMA });
  });

  it("asks an agent's questions by their TEXT, which is what the question hub answers by", () => {
    const op = autopilotOperation(
      { kind: "question", questions: [{ question: "Which way?", options: [{ label: "left" }, { label: "right" }] }] },
      { title: "t", target: "x", said: [] },
    );
    expect(op.user).toContain("Nothing has been said yet.");
    expect(op.user).toContain("An agent working on the task stopped to ask.");
    expect(op.user).toContain("`{ \"<the question's exact text>\": \"<the exact label of the option you pick>\" }`");
  });
});

describe("reading the reply", () => {
  it("takes an answer and a confidence, and clamps the confidence to 0–1", () => {
    expect(autopilotAnswerOf({ answer: { decision: "go" }, confidence: 0.86, reason: "they said so" })).toEqual({ answer: { decision: "go" }, confidence: 0.86, reason: "they said so" });
    expect(autopilotAnswerOf({ answer: { decision: "go" }, confidence: 7 })?.confidence).toBe(1);
    expect(autopilotAnswerOf({ answer: { decision: "go" }, confidence: -2 })?.confidence).toBe(0);
  });

  it("gives nothing — never a throw — for a reply with no usable answer, which leaves the question to the person", () => {
    expect(autopilotAnswerOf(undefined)).toBeUndefined();
    expect(autopilotAnswerOf("go")).toBeUndefined();
    expect(autopilotAnswerOf({ confidence: 0.9 })).toBeUndefined();
    expect(autopilotAnswerOf({ answer: { decision: "go" } })).toBeUndefined();
    expect(autopilotAnswerOf({ answer: { decision: "go" }, confidence: Number.NaN })).toBeUndefined();
  });

  it("keeps only text and lists of text for an agent's questions", () => {
    expect(autopilotAnswersOf({ "Which way?": "left", "Also?": ["a", "b"], "Bad?": 3 })).toEqual({ "Which way?": "left", "Also?": ["a", "b"] });
    expect(autopilotAnswersOf({ "Bad?": 3 })).toBeUndefined();
    expect(autopilotAnswersOf("left")).toBeUndefined();
  });
});
