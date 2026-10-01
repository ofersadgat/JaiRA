/**
 * The move's INPUT QUESTION as the conversation draws it (decision 0005, the rulings of 2026-09-22, 2:
 * "the input question, it should look like the question UI" / "it should use the question UI").
 *
 * It is the question UI — the multi-part `choose_option` a gate and an agent's batch of questions are
 * drawn with — and nothing around it: no row saying what the move is, no sentence under the heading.
 * One step per input, the chip its name and the question its description; a typed answer the input's
 * schema cannot read is refused IN PLACE, the step held, the question still on screen. Answered, it is
 * the question as it was answered, the way a settled `choose_option` is drawn.
 *
 * This file rendered the DOM's `GateSurface`, `ChoiceSteps` and `NoteRow`, which went with the DOM
 * renderer. What it holds now is what those drew FROM, which the universal gate
 * (`packages/universal/src/components/panel/Gate.tsx`, `floats/Choices.tsx`, `panel/SessionBands.tsx`)
 * still draws from: the request's heading and its steps as choices (`@jaira/shared`), what a typed
 * answer reads as, the note the conversation places the question by (`sessionBands.ts`), and the
 * recorded answers read back into the control (`choicesModel.ts`).
 */
import { describe, expect, it } from "vitest";
import { choicesOfConfig, moveQuestionConfig, parseComponentConfig, readAnswer, type ChooseOptionConfig, type ConnectMissingInput, type PendingInteraction } from "@jaira/shared/browser";
import { answerOf, answersOfValue } from "../src/renderer/choicesModel";
import { notesOf } from "../src/renderer/sessionBands";

const QUESTION: ConnectMissingInput = { state: "explore", name: "question", schema: { type: "string", minLength: 1 }, description: "What to find out, in a sentence.", reason: "nothing fits" };
const DEPTH: ConnectMissingInput = { state: "explore", name: "depth", schema: { type: "integer", minimum: 1, maximum: 5 }, description: "How many rounds of looking before a verdict.", reason: "nothing fits" };
const MODE: ConnectMissingInput = { state: "explore", name: "mode", schema: { type: "string", enum: ["fast", "thorough"] }, description: "How hard to look.", reason: "nothing fits" };

const inputs = moveQuestionConfig("Forge event sources", "explore", [QUESTION, DEPTH, MODE]);
const pending = (requestId = "move:1"): PendingInteraction => ({
  requestId,
  taskId: "t-c",
  project: "",
  component: "choose_option",
  inputs,
  config: parseComponentConfig("choose_option", inputs),
  moves: true,
});
/** The steps the gate draws, as the control takes them. */
const stepsOf = (request: PendingInteraction) => choicesOfConfig(request.config as ChooseOptionConfig);

describe("the move's input question, drawn", () => {
  it("is the question UI's stepped chooser: the heading, one step per input, the chip its name and the question its description", () => {
    // The gate's heading is the request's prompt.
    expect(pending().config!.prompt).toBe("Moving 'Forge event sources' to explore needs 3 inputs.");
    const steps = stepsOf(pending());
    // "Question 1 of 3".
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ header: "question", question: "What to find out, in a sentence." });
    // A string input is answered in the question UI's own-answer box — not a form field.
    expect(steps[0]!.options).toEqual([]);
    expect(steps[0]!.freeText).toMatchObject({ role: "instead" });
  });

  it("offers an enum's values as the step's options", () => {
    const [mode] = choicesOfConfig(parseComponentConfig("choose_option", moveQuestionConfig("T", "x", [MODE])) as ChooseOptionConfig);
    expect(mode!.options).toEqual([{ value: "fast" }, { value: "thorough" }]);
    // And no own-answer box beside them.
    expect(mode!.freeText).toBeUndefined();
  });

  it("refuses an own answer its schema cannot read IN PLACE: the reason under the step", () => {
    const [depth] = choicesOfConfig(parseComponentConfig("choose_option", moveQuestionConfig("T", "x", [DEPTH, MODE])) as ChooseOptionConfig);
    const typed = (text: string) => readAnswer(depth!.schema!, answerOf(depth!, { picked: [], text, own: true })!);
    // The reason the step says, and holds on, before main's validator is ever asked.
    expect(typed("three")).toEqual({ ok: false, error: "expects a number" });
    // The box invites a number, and a number is not refused before the schema has been asked.
    expect(depth!.freeText!.placeholder).toBe("Type a number…");
    expect(typed("3")).toEqual({ ok: true, value: 3 });
  });

  it("is the whole row in the conversation — no 'asked for the move to' line around it", () => {
    const asked = { requestId: "move:1", target: "explore", missing: [QUESTION, DEPTH, MODE] };
    const notes = notesOf([{ seq: 1, at: 0, kind: "asked", path: "", text: "move:1", asked }]);
    // One note, at the root, carrying the question and no words of its own: the row is the question.
    expect(notes).toEqual([{ seq: 1, at: 0, kind: "asked", path: "", text: "", asked }]);
  });

  it("answered, is the question as it was answered — typed values drawn back as what was picked and typed", () => {
    const steps = stepsOf(pending());
    const answers = answersOfValue(steps, { answers: { question: "Which forge events can we poll?", depth: 2, mode: "fast" } });
    // Keyed by each step's question, as the control holds them.
    expect(answers).toEqual({
      "What to find out, in a sentence.": { picked: [], text: "Which forge events can we poll?", own: true },
      // A number comes back as the words that were typed for it.
      "How many rounds of looking before a verdict.": { picked: [], text: "2", own: true },
      "How hard to look.": { picked: ["fast"], text: "" },
    });
  });
});
