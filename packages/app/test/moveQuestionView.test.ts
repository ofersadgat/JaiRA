/**
 * The move's INPUT QUESTION as the conversation draws it (decision 0005, the rulings of 2026-09-22, 2:
 * "the input question, it should look like the question UI" / "it should use the question UI").
 *
 * It is the question UI — the multi-part `choose_option` a gate and an agent's batch of questions are
 * drawn with — and nothing around it: no row saying what the move is, no sentence under the heading.
 * One step per input, the chip its name and the question its description; a typed answer the input's
 * schema cannot read is refused IN PLACE, the step held, the question still on screen. Answered, it is
 * the question as it was answered, the way a settled `choose_option` is drawn.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { choicesOfConfig, moveQuestionConfig, parseComponentConfig, type ChooseOptionConfig, type ConnectMissingInput, type PendingInteraction } from "@jaira/shared/browser";
import { GateSurface } from "../src/renderer/components";
import { ChoiceSteps } from "../src/renderer/choices";
import { notesOf } from "../src/renderer/sessionBands";
import { NoteRow } from "../src/renderer/sessionPanels";

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
const noop = (): void => undefined;

describe("the move's input question, drawn", () => {
  it("is the question UI's stepped chooser: the heading, one step per input, the chip its name and the question its description", () => {
    const html = renderToStaticMarkup(h(GateSurface, { pending: pending(), onSubmit: noop }));
    expect(html).toContain("Moving &#x27;Forge event sources&#x27; to explore needs 3 inputs.");
    expect(html).toContain('<p class="question-step">Question 1 of 3</p>');
    expect(html).toContain('<p class="question-text"><span class="chip">question</span> What to find out, in a sentence.</p>');
    // A string input is answered in the question UI's own-answer box — not a form field.
    expect(html).toContain('class="question-option own"');
    expect(html).not.toContain("cfg-field");
  });

  it("offers an enum's values as the step's options", () => {
    const choices = choicesOfConfig(parseComponentConfig("choose_option", moveQuestionConfig("T", "x", [MODE])) as ChooseOptionConfig);
    const html = renderToStaticMarkup(h(ChoiceSteps, { choices, answers: {}, onAnswer: noop, onSubmit: noop }));
    expect(html).toContain('<span class="question-option-label"> fast</span>');
    expect(html).toContain('<span class="question-option-label"> thorough</span>');
    expect(html).not.toContain("question-option own");
  });

  it("refuses an own answer its schema cannot read IN PLACE: the reason under the step, the step held", () => {
    const choices = choicesOfConfig(parseComponentConfig("choose_option", moveQuestionConfig("T", "x", [DEPTH, MODE])) as ChooseOptionConfig);
    const typed = (text: string) =>
      renderToStaticMarkup(h(ChoiceSteps, { choices, answers: { [choices[0]!.question]: { picked: [], text, own: true } }, onAnswer: noop, onSubmit: noop }));
    const bad = typed("three");
    expect(bad).toContain('<p class="reason question-problem">expects a number</p>');
    expect(bad).toMatch(/<button class="primary" disabled="">Next<\/button>/);
    // The box invites a number, and a number is not refused before the schema has been asked.
    expect(bad).toContain('placeholder="Type a number…"');
    expect(typed("3")).not.toContain("question-problem");
  });

  it("is the whole row in the conversation — no 'asked for the move to' line around it", () => {
    const [note] = notesOf([{ seq: 1, at: 0, kind: "asked", path: "", text: "move:1", asked: { requestId: "move:1", target: "explore", missing: [QUESTION, DEPTH, MODE] } }]);
    const html = renderToStaticMarkup(
      h(NoteRow, { note: note!, root: "", moveQuestion: () => h("div", { className: "inline-gate" }, h(GateSurface, { pending: pending(), onSubmit: noop })) }),
    );
    expect(html.startsWith('<div class="sb-move-question" data-asked="move:1"><div class="inline-gate"><h3>')).toBe(true);
    expect(html).not.toContain("for the move to");
    expect(html).not.toContain("sb-note");
  });

  it("answered, is the question as it was answered — typed values drawn back as what was picked and typed", () => {
    const html = renderToStaticMarkup(
      h(GateSurface, { pending: pending(), onSubmit: noop, settled: { value: { answers: { question: "Which forge events can we poll?", depth: 2, mode: "fast" } } } }),
    );
    expect(html).toContain('<div class="gate-settled">');
    expect(html).toContain("Which forge events can we poll?</textarea>");
    // Read-only: Next pages through it, and nothing confirms.
    expect(html).toContain(">Next</button>");
    expect(html).not.toContain(">Confirm</button>");
  });

  it("refused when it came to be taken, says so in the question's own error line", () => {
    const html = renderToStaticMarkup(
      h(GateSurface, { pending: pending(), onSubmit: noop, settled: { value: { answers: { question: "q", depth: 2, mode: "fast" } } }, error: "The move could not be taken: it moved on" }),
    );
    expect(html).toContain('<p class="reason">The move could not be taken: it moved on</p>');
  });
});
