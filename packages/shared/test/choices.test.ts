/**
 * The one control behind an authored gate and an agent's question (decision 0002).
 *
 * What is worth testing is the NORMALIZATION — that two callers with different wire shapes reduce
 * to the same thing — and the free-text role, which is the only real difference between them and
 * the reason one control can serve both.
 */
import { describe, expect, it } from "vitest";
import { choicesOfConfig, parseComponentConfig, validateComponentResult, type ChooseOptionConfig } from "../src/components";
import { choicesOfQuestions } from "../src/ipc";

const choose = (args: unknown): ChooseOptionConfig => parseComponentConfig("choose_option", args) as ChooseOptionConfig;

describe("choicesOfConfig — the authored caller", () => {
  it("reduces a gate to one question carrying the state's options", () => {
    const [only] = choicesOfConfig(choose({ prompt: "Pick one.", options: ["approve", "reject"] }));
    expect(only).toEqual({ question: "Pick one.", options: [{ value: "approve" }, { value: "reject" }] });
  });

  it("offers `comments` as ALONGSIDE free text — it accompanies the choice, never replaces it", () => {
    const [only] = choicesOfConfig(choose({ prompt: "Pick.", options: ["a"], comments: true }));
    expect(only!.freeText).toEqual({ label: "Comments (optional)", role: "alongside" });
  });

  it("carries multi-select through", () => {
    expect(choicesOfConfig(choose({ prompt: "Which?", options: ["a", "b"], multiple: true }))[0]!.multiple).toBe(true);
  });

  it("carries option descriptions, which used to be agent-side only", () => {
    const config = choose({ prompt: "Pick.", options: [{ value: "a", description: "what it means" }] });
    expect(choicesOfConfig(config)[0]!.options[0]!.description).toBe("what it means");
  });

  it("reduces a review_artifact to the same shape — the contract's 'a viewer plus a choose_option'", () => {
    const review = parseComponentConfig("review_artifact", {
      prompt: "Review it.",
      artifact: "doc",
      options: ["approve"],
      comments: true,
    });
    const [only] = choicesOfConfig(review as never);
    expect(only!.question).toBe("Review it.");
    expect(only!.freeText?.role).toBe("alongside");
  });
});

describe("choicesOfQuestions — the agent caller", () => {
  const questions = [
    {
      question: "Which cache interval?",
      header: "Interval",
      options: [{ label: "30 seconds", description: "fresh" }, { label: "5 minutes" }],
    },
  ];

  it("reduces an agent's question to the same shape a gate reduces to", () => {
    const [only] = choicesOfQuestions(questions);
    expect(only!.question).toBe("Which cache interval?");
    expect(only!.header).toBe("Interval");
    // The LABEL is the value: an agent's options are its own words and there is no enum behind them.
    expect(only!.options).toEqual([{ value: "30 seconds", description: "fresh" }, { value: "5 minutes" }]);
  });

  it("offers 'Other' as INSTEAD free text — typing overrides the pick", () => {
    expect(choicesOfQuestions(questions)[0]!.freeText).toEqual({
      label: "Other",
      placeholder: "Type your own answer…",
      role: "instead",
    });
  });

  it("keeps several questions as several", () => {
    expect(choicesOfQuestions([...questions, { question: "And?", options: [{ label: "yes" }] }])).toHaveLength(2);
  });

  it("drops an empty header rather than rendering a blank chip", () => {
    expect(choicesOfQuestions([{ question: "q", header: "", options: [{ label: "a" }] }])[0]!.header).toBeUndefined();
  });
});

describe("a multi-select answers with a list", () => {
  const config = choose({ prompt: "Which?", options: ["a", "b", "c"], multiple: true });

  it("accepts a list of declared values", () => {
    expect(validateComponentResult(config, { decision: ["a", "c"] })).toEqual({ ok: true });
  });

  it("refuses a bare string where a list is expected", () => {
    expect(validateComponentResult(config, { decision: "a" })).toMatchObject({ ok: false });
  });

  it("refuses an empty list — 'none of these' was not offered", () => {
    expect(validateComponentResult(config, { decision: [] })).toMatchObject({ ok: false });
  });

  it("refuses a repeat and an undeclared value", () => {
    expect(validateComponentResult(config, { decision: ["a", "a"] })).toMatchObject({ ok: false });
    expect(validateComponentResult(config, { decision: ["a", "z"] })).toMatchObject({ ok: false });
  });

  it("still refuses a list on a single-select", () => {
    const single = choose({ prompt: "Which?", options: ["a", "b"] });
    expect(validateComponentResult(single, { decision: ["a"] })).toMatchObject({ ok: false });
  });
});

/**
 * The two things an author can now say about how a choice behaves (2026-08-24 review).
 */
describe("option icons and require_confirm", () => {
  it("carries a per-option icon and a title icon through to the Choice", () => {
    const config = choose({
      prompt: "Pick.",
      icon: "shield",
      options: [{ value: "a", icon: "check" }, "b"],
    });
    const [only] = choicesOfConfig(config);
    expect(only!.icon).toBe("shield");
    expect(only!.options[0]!.icon).toBe("check");
    expect(only!.options[1]!.icon).toBeUndefined();
  });

  it("reads require_confirm off the authored snake_case spelling", () => {
    expect(choicesOfConfig(choose({ prompt: "p", options: ["a"], require_confirm: true }))[0]!.requireConfirm).toBe(true);
    expect(choicesOfConfig(choose({ prompt: "p", options: ["a"] }))[0]!.requireConfirm).toBeUndefined();
  });

  it("refuses a non-string icon rather than passing junk to the renderer", () => {
    expect(() => choose({ prompt: "p", options: [{ value: "a", icon: 7 }] })).toThrow(/icon/);
  });
});

describe("an editable review carries the reviewer's own text back", () => {
  const editable = parseComponentConfig("review_artifact", {
    prompt: "Review it.",
    artifact: "doc",
    options: ["approve"],
    editable: true,
  });
  const readOnly = parseComponentConfig("review_artifact", { prompt: "Review it.", artifact: "doc", options: ["approve"] });

  it("accepts content from a state that offered editing", () => {
    expect(validateComponentResult(editable, { decision: "approve", content: "my version" })).toEqual({ ok: true });
  });

  it("refuses content from one that did not — nothing on screen could have produced it", () => {
    expect(validateComponentResult(readOnly, { decision: "approve", content: "my version" })).toMatchObject({ ok: false });
  });

  it("still accepts a review with no edit at all", () => {
    expect(validateComponentResult(editable, { decision: "approve" })).toEqual({ ok: true });
  });
});

/**
 * Where the free-text field sits, and what the affirmative option says (2026-08-24 review).
 *
 * Both are DECLARED rather than inferred, because the two components that share this control want
 * opposite answers and both are right.
 */
describe("free-text placement and the affirmative label", () => {
  it("puts a review's comment box FIRST — its options are a decision row at the bottom", () => {
    const review = parseComponentConfig("review_artifact", {
      prompt: "Review it.",
      artifact: "doc",
      options: ["approve"],
      comments: true,
    });
    expect(choicesOfConfig(review as never)[0]!.freeText).toMatchObject({ role: "alongside", first: true });
  });

  it("leaves choose_option's comment box after the options, where the options are the content", () => {
    const only = choicesOfConfig(choose({ prompt: "Pick.", options: ["a"], comments: true }))[0]!;
    expect(only.freeText?.role).toBe("alongside");
    expect(only.freeText?.first).toBeUndefined();
  });

  it("leaves an agent's Other after the options too — it is one of them said in words", () => {
    expect(choicesOfQuestions([{ question: "q", options: [{ label: "a" }] }])[0]!.freeText?.first).toBeUndefined();
  });
});

describe("an own answer on a gate (custom)", () => {
  it("offers the same INSTEAD free text an agent's Other is", () => {
    const [choice] = choicesOfConfig(choose({ options: ["a", "b"], custom: true }));
    expect(choice!.freeText).toMatchObject({ role: "instead", label: "Your own answer" });
    // Typing overrides the pick, exactly as it does for the agent caller.
    expect(validateComponentResult(choose({ options: ["a", "b"], custom: true }), { decision: "c, actually" })).toEqual({ ok: true });
  });
});

describe("a multi-part gate reduces to several Choices", () => {
  const config = choose({
    prompt: "The product questions.",
    questions: [
      {
        name: "sort",
        question: "Where does a stopped conversation sort?",
        header: "Sort",
        description: "One predicate member either way.",
        options: ["above", "below"],
        default: "below",
        custom: true,
        optional: true,
      },
      { name: "rows", question: "Do rows carry counts?", options: ["counts", "name only"], multiple: true },
    ],
  });

  it("keeps each part's name, header, description, default and knobs", () => {
    const choices = choicesOfConfig(config);
    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      name: "sort",
      question: "Where does a stopped conversation sort?",
      header: "Sort",
      description: "One predicate member either way.",
      default: "below",
      optional: true,
      freeText: { role: "instead" },
    });
    expect(choices[1]).toMatchObject({ name: "rows", multiple: true });
    expect(choices[1]!.freeText).toBeUndefined();
    expect(choices[1]!.optional).toBeUndefined();
  });

  it("is the same shape an agent's batch of questions reduces to, so one stepper draws both", () => {
    const agent = choicesOfQuestions([
      { question: "Where does a stopped conversation sort?", header: "Sort", options: [{ label: "above" }, { label: "below" }] },
    ]);
    const gate = choicesOfConfig(config);
    expect(Object.keys(agent[0]!).sort()).toEqual(expect.arrayContaining(["question", "header", "options", "freeText"]));
    expect(gate[0]!.options.map((o) => o.value)).toEqual(agent[0]!.options.map((o) => o.value));
  });
});
