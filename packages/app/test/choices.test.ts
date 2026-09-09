/**
 * The answer rules behind the one choice control (decision 0002), for the case that was wrong on
 * screen: the "own answer" block of an `instead` free text.
 *
 * The block is one of the options said in words, so it must be selectable like one — before
 * anything is typed, and again after an option was picked — and typing in it must select it. That
 * needs a switch on the answer (`own`) rather than a reading of the text, and these are the four
 * rules the switch has to keep.
 */
import { describe, expect, it } from "vitest";
import type { Choice } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { answerOf, answersOfAnsweredText, answersOfValue, settled, submitsOnClick, EMPTY_ANSWER } from "../src/renderer/choices";

const asked: Choice = {
  question: "Which?",
  options: [{ value: "a" }, { value: "b" }],
  freeText: { label: "Your own answer", role: "instead" },
};

const commented: Choice = {
  question: "Approve?",
  options: [{ value: "approve" }, { value: "reject" }],
  freeText: { label: "Comments", role: "alongside" },
};

describe("the own-answer block", () => {
  it("is the answer only while it is selected — a pick is not outranked by words left behind", () => {
    // Typed, then an option picked: the words stay, the option answers.
    expect(answerOf(asked, { picked: ["a"], text: "something else", own: false })).toBe("a");
    // Selected again: the words answer, the pick is dark.
    expect(answerOf(asked, { picked: ["a"], text: "something else", own: true })).toBe("something else");
  });

  it("selected but empty is unanswered, not the option that was showing", () => {
    expect(answerOf(asked, { picked: ["a"], text: "", own: true })).toBeUndefined();
    expect(answerOf(asked, { picked: ["a"], text: "   ", own: true })).toBeUndefined();
    expect(settled(asked, { picked: ["a"], text: "", own: true })).toBe(false);
  });

  it("holds the question in confirm mode while there are words in it, whichever block is selected", () => {
    expect(submitsOnClick([asked], {})).toBe(true);
    // Chosen and empty holds nothing: an option tapped from here is still one tap.
    expect(submitsOnClick([asked], { [asked.question]: { ...EMPTY_ANSWER, own: true } })).toBe(true);
    expect(submitsOnClick([asked], { [asked.question]: { picked: [], text: "words", own: true } })).toBe(false);
    // Deselected by a pick, words kept: still confirm mode — the Confirm button must not vanish
    // under the click that recorded the pick.
    expect(submitsOnClick([asked], { [asked.question]: { picked: ["a"], text: "words", own: false } })).toBe(false);
  });

  it("is not what an alongside comment is — a comment never answers and never holds the click", () => {
    expect(answerOf(commented, { picked: [], text: "a note", own: true })).toBeUndefined();
    expect(answerOf(commented, { picked: ["approve"], text: "a note" })).toBe("approve");
    expect(submitsOnClick([commented], { [commented.question]: { picked: [], text: "a note" } })).toBe(true);
  });
});

/**
 * A settled question is drawn from what its record holds — the inverse of the shapes the callers
 * submit, so the conversation can show the question as it was answered rather than the JSON.
 */
describe("answers read back from a recorded value", () => {
  const stepped: Choice[] = [
    { question: "Which?", name: "which", options: [{ value: "a" }, { value: "b" }], freeText: { label: "Own", role: "instead" } },
    { question: "How many?", name: "count", options: [{ value: "1" }, { value: "2" }], multiple: true },
  ];

  it("reads one authored decision, with its alongside comment", () => {
    const got = answersOfValue([commented], { decision: "reject", comments: "not yet" });
    expect(got[commented.question]).toEqual({ picked: ["reject"], text: "not yet" });
    expect(answerOf(commented, got[commented.question]!)).toBe("reject");
  });

  it("reads a decision that names no option as the own-answer block's words", () => {
    const got = answersOfValue([asked], { decision: "something else" });
    expect(got[asked.question]).toEqual({ picked: [], text: "something else", own: true });
    expect(answerOf(asked, got[asked.question]!)).toBe("something else");
  });

  it("reads a stepped set by each question's name, lists included", () => {
    const got = answersOfValue(stepped, { answers: { which: "b", count: ["1", "2"] } });
    expect(got["Which?"]).toEqual({ picked: ["b"], text: "" });
    expect(got["How many?"]).toEqual({ picked: ["1", "2"], text: "" });
  });

  it("reads an agent's batch by question text, and a joined multi-select back into its picks", () => {
    const agent: Choice[] = [
      { question: "Which?", options: [{ value: "A" }, { value: "B" }], freeText: { label: "Other", role: "instead" } },
      { question: "Which several?", options: [{ value: "x" }, { value: "y" }], multiple: true },
    ];
    const got = answersOfValue(agent, { answers: { "Which?": "A", "Which several?": "x, y" } });
    expect(got["Which?"]).toEqual({ picked: ["A"], text: "" });
    expect(got["Which several?"]).toEqual({ picked: ["x", "y"], text: "" });
  });

  it("answers nothing for a shape it does not know, rather than throwing over an old record", () => {
    expect(answersOfValue([asked], undefined)).toEqual({});
    expect(answersOfValue([asked], "nope")).toEqual({});
    expect(answersOfValue([asked], { decisions: [] })).toEqual({});
    expect(answersOfValue([asked], { answers: {} })).toEqual({});
  });
});

describe("the agent's answer text", () => {
  it("parses the wire spelling, quotes and commas inside the halves included", () => {
    const text =
      'The user answered: "Which, then?"="A \\"quoted\\" one", "Second"="plain"';
    expect(answersOfAnsweredText(text)).toEqual({ "Which, then?": 'A "quoted" one', Second: "plain" });
  });

  it("answers nothing for a dismissal or another tool's result", () => {
    expect(answersOfAnsweredText("The user declined to answer; use your judgment.")).toBeUndefined();
    expect(answersOfAnsweredText("file written")).toBeUndefined();
  });
});

/**
 * The agent's question, read off its tool call — the shapes Claude Code actually writes: the
 * questions as the call's input, the answers as the native `toolUseResult` map, or, when that was
 * not captured, spelt out in the wire result's text.
 */
describe("an agent's question read off its call", () => {
  const args: JsonValue = {
    questions: [
      {
        question: "Where should the logger live?",
        header: "Logger home",
        multiSelect: false,
        options: [
          { label: "New package (recommended)", description: "its own package" },
          { label: "Keep it where it is" },
        ],
      },
    ],
  };

  it("takes the answers from the native record when there is one", async () => {
    const { askedOf } = await import("../src/renderer/transcriptView");
    const asked = askedOf({
      kind: "tool",
      name: "AskUserQuestion",
      summary: "",
      args,
      result: "The user answered: \"Where should the logger live?\"=\"New package (recommended)\"",
      detail: { questions: (args as { questions: JsonValue }).questions, answers: { "Where should the logger live?": "Keep it where it is" } },
    });
    expect(asked?.questions[0]?.options.map((o) => o.label)).toEqual(["New package (recommended)", "Keep it where it is"]);
    expect(asked?.answers).toEqual({ "Where should the logger live?": "Keep it where it is" });
  });

  it("falls back to the wire text, and reads a typed answer as the own-answer block", async () => {
    const { askedOf } = await import("../src/renderer/transcriptView");
    const { choicesOfQuestions } = await import("@jaira/shared/browser");
    const asked = askedOf({
      kind: "tool",
      name: "AskUserQuestion",
      summary: "",
      args,
      result: [{ type: "text", text: "The user answered: \"Where should the logger live?\"=\"neither, inline it\"" }],
    });
    expect(asked?.answers).toEqual({ "Where should the logger live?": "neither, inline it" });
    const choices = choicesOfQuestions(asked!.questions);
    const got = answersOfValue(choices, { answers: asked!.answers! });
    expect(got["Where should the logger live?"]).toEqual({ picked: [], text: "neither, inline it", own: true });
  });

  it("is nothing for any other call, and unanswered while the call is in flight", async () => {
    const { askedOf } = await import("../src/renderer/transcriptView");
    expect(askedOf({ kind: "tool", name: "Read", summary: "a.ts", args: { file_path: "a.ts" } })).toBeUndefined();
    const asked = askedOf({ kind: "tool", name: "AskUserQuestion", summary: "", args });
    expect(asked?.questions).toHaveLength(1);
    expect(asked?.answers).toBeUndefined();
  });
});
