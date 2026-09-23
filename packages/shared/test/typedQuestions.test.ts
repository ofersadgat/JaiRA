/**
 * TYPED questions — a multi-part `choose_option` step whose answer is a value of a schema — and the
 * move's input question built from them (decision 0005, the rulings of 2026-09-22, 2: "it should use
 * the question ui"): one step per input, the chip its name, the question its description, an enum's
 * members and a boolean's two answers as options, anything else in the own-answer box.
 */
import { describe, expect, it } from "vitest";
import { answerText, choicesOfConfig, parseComponentConfig, readAnswer, validateComponentResult, type ChooseOptionConfig } from "../src/components";
import { moveQuestionConfig } from "../src/move";
import type { ConnectMissingInput } from "../src/connect";

const input = (name: string, schema: ConnectMissingInput["schema"], description?: string): ConnectMissingInput => ({
  state: "explore",
  name,
  ...(schema !== undefined ? { schema } : {}),
  ...(description !== undefined ? { description } : {}),
  reason: "nothing the task produced fits it",
});

describe("reading an answer as a value of its schema", () => {
  it("takes text as written where the schema takes text, and JSON where it does not", () => {
    expect(readAnswer({ type: "string" }, "3")).toEqual({ ok: true, value: "3" });
    expect(readAnswer({ type: "integer" }, "3")).toEqual({ ok: true, value: 3 });
    expect(readAnswer({ type: "boolean" }, "false")).toEqual({ ok: true, value: false });
    expect(readAnswer({ type: "object" }, '{"a": [1, 2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(readAnswer({ type: "array", items: { type: "string" } }, '["x", "y"]')).toEqual({ ok: true, value: ["x", "y"] });
    // Anything goes: JSON when it parses, the words when they do not.
    expect(readAnswer(true, "7")).toEqual({ ok: true, value: 7 });
    expect(readAnswer(true, "seven")).toEqual({ ok: true, value: "seven" });
    // Text or a number: a number when it reads as one, the words otherwise.
    expect(readAnswer({ type: ["string", "number"] }, "7")).toEqual({ ok: true, value: 7 });
    expect(readAnswer({ type: ["string", "number"] }, "[1]")).toEqual({ ok: true, value: "[1]" });
  });

  it("says what was expected when the words are not a value of that kind", () => {
    expect(readAnswer({ type: "integer" }, "three")).toEqual({ ok: false, error: "expects a number" });
    expect(readAnswer({ type: "object" }, "a: 1")).toEqual({ ok: false, error: 'expects a JSON object, like {"key": "value"}' });
    expect(readAnswer({ type: "array" }, "x, y")).toEqual({ ok: false, error: 'expects a JSON list, like ["one", "two"]' });
    expect(readAnswer({ type: "boolean" }, "yes")).toEqual({ ok: false, error: "expects true or false" });
  });

  it("reads a pick by its enum member, and a multi-select's picks against the items", () => {
    expect(readAnswer({ enum: [1, 2, 3] }, "2")).toEqual({ ok: true, value: 2 });
    expect(readAnswer({ enum: ["1", 1] }, "1")).toEqual({ ok: true, value: "1" });
    expect(readAnswer({ type: "array", items: { enum: [1, 2] } }, ["1", "2"])).toEqual({ ok: true, value: [1, 2] });
    expect(answerText(3)).toBe("3");
    expect(answerText("three")).toBe("three");
    expect(answerText({ a: 1 })).toBe('{"a":1}');
  });
});

describe("a typed step in a multi-part choose_option", () => {
  const config = parseComponentConfig("choose_option", {
    prompt: "Some values.",
    questions: [
      { name: "depth", question: "How deep?", options: ["1", "2"], schema: { type: "integer", enum: [1, 2] } },
      { name: "shape", question: "What shape?", custom: true, schema: { type: "object" } },
    ],
  }) as ChooseOptionConfig;

  it("parses a schema, and a custom question with no options at all", () => {
    expect(config.questions![0]!.schema).toEqual({ type: "integer", enum: [1, 2] });
    expect(config.questions![1]).toMatchObject({ custom: true, options: [], schema: { type: "object" } });
    expect(() => parseComponentConfig("choose_option", { questions: [{ name: "a", question: "A?" }] })).toThrow(/options must be a non-empty array/);
    expect(() => parseComponentConfig("choose_option", { questions: [{ name: "a", question: "A?", custom: true, schema: "string" }] })).toThrow(/schema must be a JSON Schema/);
  });

  it("carries the schema to the control, with an own-answer box that says what to type", () => {
    const choices = choicesOfConfig(config);
    expect(choices[0]!.schema).toEqual({ type: "integer", enum: [1, 2] });
    expect(choices[1]!.freeText).toMatchObject({ role: "instead", placeholder: 'Type a JSON object, like {"key": "value"}…' });
  });

  it("takes typed values: a pick by its words, an own answer as any value (its schema is main's to check)", () => {
    expect(validateComponentResult(config, { answers: { depth: 2, shape: { a: 1 } } }).ok).toBe(true);
    expect(validateComponentResult(config, { answers: { depth: 3, shape: { a: 1 } } })).toMatchObject({ ok: false });
    expect(validateComponentResult(config, { answers: { depth: 1 } })).toMatchObject({ ok: false });
  });
});

describe("the move's input question", () => {
  const QUESTION = input("question", { type: "string", minLength: 1 }, "What to find out, in a sentence.");
  const DEPTH = input("depth", { type: "integer", enum: [1, 2, 3], default: 2 }, "How many rounds of looking.");
  const DRY = input("dry", { type: "boolean" }, "Whether to write nothing.");
  const LENSES = input("lenses", { type: "array", items: { enum: ["product", "ux"] } }, "Which lenses to apply.");
  const SHAPE = input("shape", { type: "object", description: "Declared on the schema." });

  const config = parseComponentConfig("choose_option", moveQuestionConfig("Forge event sources", "explore", [QUESTION, DEPTH, DRY, LENSES], [SHAPE])) as ChooseOptionConfig;

  it("is one step per input — the required ones, then the optional — under a heading that says what the move is", () => {
    expect(config.prompt).toBe("Moving 'Forge event sources' to explore needs 4 inputs.");
    expect(config.questions!.map((q) => [q.name, q.header, q.question, q.optional === true])).toEqual([
      ["question", "question", "What to find out, in a sentence.", false],
      ["depth", "depth", "How many rounds of looking.", false],
      ["dry", "dry", "Whether to write nothing.", false],
      ["lenses", "lenses", "Which lenses to apply.", false],
      ["shape", "shape", "Declared on the schema.", true],
    ]);
    expect(parseComponentConfig("choose_option", moveQuestionConfig("T", "x", [QUESTION])).prompt).toBe("Moving 'T' to x needs an input.");
  });

  it("offers an enum's members and a boolean's two answers as options; anything else is the own-answer box", () => {
    const [question, depth, dry, lenses, shape] = config.questions!;
    expect(question).toMatchObject({ custom: true, options: [] });
    expect(depth).toMatchObject({ options: [{ value: "1" }, { value: "2" }, { value: "3" }], default: "2" });
    expect(depth!.custom).toBeUndefined();
    expect(dry).toMatchObject({ options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] });
    expect(lenses).toMatchObject({ multiple: true, options: [{ value: "product" }, { value: "ux" }] });
    expect(shape).toMatchObject({ custom: true, options: [] });
    for (const step of config.questions!) expect(step.schema).toBeDefined();
  });

  it("answers typed values under each input's own name", () => {
    const answers = { question: "Which events poll?", depth: 3, dry: false, lenses: ["ux"], shape: { a: 1 } };
    expect(validateComponentResult(config, { answers }).ok).toBe(true);
    // The optional input may be left out; a required one may not.
    expect(validateComponentResult(config, { answers: { ...answers, shape: undefined } }).ok).toBe(true);
    expect(validateComponentResult(config, { answers: { ...answers, dry: undefined } })).toMatchObject({ ok: false });
    expect(validateComponentResult(config, { answers: { ...answers, lenses: ["design"] } })).toMatchObject({ ok: false });
  });
});
