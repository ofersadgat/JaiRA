/**
 * A set of choices on screen — the ONE control behind an authored gate and an agent's question
 * ([decision 0002](../../../../docs/engineering/decisions/0002-one-gate-vocabulary.md)).
 *
 * `choose_option` and `AskUserQuestion` were two components drawing the same picture. They differ in
 * where the answer goes and whether it is checked against a declared enum, and in nothing a person
 * can see — so they are one control now, with two callers normalizing into {@link Choice}.
 *
 * What the union cost each side: the gate gained option descriptions, several questions at once and
 * multi-select; the agent's questions gained `tone`. Neither side lost anything.
 */

import type { Choice } from "@jaira/shared/browser";
import { useState, type JSX } from "react";
import { Icon, PATHS } from "./icons";

/**
 * A glyph an AUTHOR named, drawn only if the renderer actually has it.
 *
 * A workflow file is content, and content naming a picture that does not exist should render
 * nothing rather than throw — the alternative is a state file able to crash the dialog it opens.
 */
function AuthoredIcon({ name, fallback }: { name?: string | undefined; fallback?: string | undefined }): JSX.Element | null {
  const wanted = name ?? fallback;
  if (wanted === undefined || !(wanted in PATHS)) return null;
  return <Icon name={wanted as keyof typeof PATHS} />;
}

/** What a person has said so far about one question. */
export interface Answer {
  picked: string[];
  text: string;
}

export const EMPTY_ANSWER: Answer = { picked: [], text: "" };

/**
 * What one question currently answers to, or `undefined` when it is unanswered.
 *
 * The free-text role decides the precedence, which is the whole reason the role exists: `instead`
 * text REPLACES the picked option (an agent's "Other"), `alongside` text accompanies it and cannot
 * answer on its own (a gate's `comments`).
 */
export function answerOf(choice: Choice, answer: Answer): string | string[] | undefined {
  const typed = answer.text.trim();
  if (choice.freeText?.role === "instead" && typed.length > 0) return typed;
  if (answer.picked.length === 0) return undefined;
  return choice.multiple === true ? answer.picked : answer.picked[0]!;
}

/**
 * True when clicking an option is the whole answer.
 *
 * One question, one pick, and nothing typed that would override it. This is what keeps the common
 * case one tap — the behaviour both callers already had, now stated once instead of twice.
 */
export function submitsOnClick(choices: readonly Choice[], answers: Record<string, Answer>): boolean {
  // Several questions are asked ONE AT A TIME (see `ChoiceSteps`), and a step that answered on the
  // click would skip past itself before the person had seen what they picked.
  if (choices.length !== 1) return false;
  const only = choices[0]!;
  if (only.multiple === true) return false;
  // The author asked for a confirm step: picking holds the choice rather than sending it.
  if (only.requireConfirm === true) return false;
  const typed = (answers[only.question] ?? EMPTY_ANSWER).text.trim();
  return !(only.freeText?.role === "instead" && typed.length > 0);
}

/**
 * Several questions, asked one at a time (2026-08-24 review).
 *
 * A column of every question at once is a form, and a form is the wrong shape for a set of
 * decisions that may depend on each other — you cannot see what the second question is going to be
 * until the first is answered, and a model that asked three at once wrote them expecting an order.
 *
 * So: one on screen, **Next** until the last, **Confirm** on it, and **Back** to change an earlier
 * answer. Confirming is implied rather than configured here — a step whose click sent the whole
 * batch would make the first question the only one anybody answered on purpose.
 */
export function ChoiceSteps({
  choices,
  answers,
  onAnswer,
  onSubmit,
  extra,
}: {
  choices: readonly Choice[];
  answers: Record<string, Answer>;
  onAnswer: (question: string, answer: Answer) => void;
  onSubmit: () => void;
  /** Anything the host wants beside the step buttons — a dismissal, usually. */
  extra?: JSX.Element | undefined;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const at = Math.min(step, choices.length - 1);
  const choice = choices[at]!;
  const last = at === choices.length - 1;
  const answered = answerOf(choice, answers[choice.question] ?? EMPTY_ANSWER) !== undefined;

  return (
    <>
      <p className="question-step">
        Question {at + 1} of {choices.length}
      </p>
      <ChoiceList choices={[choice]} answers={answers} onAnswer={onAnswer} />
      <div className="options">
        {at > 0 ? (
          <button className="ghost" onClick={() => setStep(at - 1)}>
            Back
          </button>
        ) : null}
        <button className="primary" disabled={!answered} onClick={() => (last ? onSubmit() : setStep(at + 1))}>
          {last ? "Confirm" : "Next"}
        </button>
        {extra}
      </div>
    </>
  );
}

/**
 * The free-text field beside a set of choices.
 *
 * A textarea for `alongside` and an input for `instead`: a comment is prose about a decision, an
 * "Other" is one more option said in words.
 */
function FreeText({
  choice,
  answer,
  onAnswer,
}: {
  choice: Choice;
  answer: Answer;
  onAnswer: (question: string, answer: Answer) => void;
}): JSX.Element | null {
  const field = choice.freeText;
  if (field === undefined) return null;
  const set = (text: string): void => onAnswer(choice.question, { ...answer, text });
  return (
    <label className="field">
      <small>{field.label}</small>
      {field.role === "alongside" ? (
        <textarea rows={3} value={answer.text} placeholder={field.placeholder ?? ""} onChange={(e) => set(e.target.value)} />
      ) : (
        <input value={answer.text} placeholder={field.placeholder ?? ""} onChange={(e) => set(e.target.value)} />
      )}
    </label>
  );
}

export function ChoiceList({
  choices,
  answers,
  onAnswer,
  onImmediate,
}: {
  choices: readonly Choice[];
  answers: Record<string, Answer>;
  onAnswer: (question: string, answer: Answer) => void;
  /** Called instead of recording a pick, when {@link submitsOnClick}. */
  onImmediate?: ((question: string, value: string) => void) | undefined;
}): JSX.Element {
  const immediate = submitsOnClick(choices, answers);

  const toggle = (choice: Choice, value: string): void => {
    if (immediate && onImmediate !== undefined) {
      onImmediate(choice.question, value);
      return;
    }
    const answer = answers[choice.question] ?? EMPTY_ANSWER;
    const had = answer.picked;
    const picked =
      choice.multiple === true
        ? had.includes(value)
          ? had.filter((v) => v !== value)
          : [...had, value]
        : [value];
    onAnswer(choice.question, { ...answer, picked });
  };

  return (
    <>
      {choices.map((choice) => {
        const answer = answers[choice.question] ?? EMPTY_ANSWER;
        // The first plain option of a bare row is the affirmative one, drawn as the action.
        const bare = choice.options.every((o) => o.description === undefined);
        return (
          <div key={choice.question} className="question-block">
            {/* The prompt is the dialog's heading when there is only one question, so repeating it
                here would print it twice. With several, each needs its own.

                No glyph on this row either: the question's icon belongs to the dialog TITLE, and
                drawing it here as well printed the same bubble twice on every agent question —
                which is what a caller-supplied default looks like when two places both apply it. */}
            {choices.length > 1 || choice.header !== undefined ? (
              <p className="question-text">
                {choice.header !== undefined ? <span className="chip">{choice.header}</span> : null}{" "}
                {choices.length > 1 ? choice.question : null}
              </p>
            ) : null}
            {/* An `alongside` free text is written BEFORE the decision — it is a note about the
                thing being decided, and a single-select answers on the click, so a comment box
                below the buttons is a box you can never reach in time. An `instead` one belongs
                with the options, because it is one of them said in words.

                This is also what makes `review_artifact` read like `review_artifacts`: comment,
                then the row of actions at the bottom. */}
            {choice.freeText?.first === true ? <FreeText choice={choice} answer={answer} onAnswer={onAnswer} /> : null}
            <div className="question-options">
              {choice.options.map((option, index) => (
                <button
                  key={option.value}
                  role={choice.multiple === true ? "checkbox" : undefined}
                  aria-checked={choice.multiple === true ? answer.picked.includes(option.value) : undefined}
                  className={[
                    "question-option",
                    choice.multiple === true ? "checkable" : "",
                    answer.picked.includes(option.value) ? "selected" : "",
                    option.tone === "danger" ? "danger" : "",
                    // The first plain option of a bare row is the affirmative one, drawn the way the
                    // reviewer's "Apply the review" is — so a decision looks like a decision rather
                    // than like a list you might also be able to leave alone.
                    index === 0 && option.tone !== "danger" && bare ? "primary" : "",
                  ]
                    .join(" ")
                    .trim()}
                  title={option.description ?? ""}
                  onClick={() => toggle(choice, option.value)}
                >
                  {/* A multi-select says so in its OPTIONS, not only in a hint somewhere.
                      Without a box on each row the control is a set of buttons that mysteriously
                      does not close the dialog, and the person learns it is multi-select by
                      clicking twice and being surprised. The box is on the right so the labels
                      still align on the left. */}
                  {choice.multiple === true ? (
                    <span
                      className={answer.picked.includes(option.value) ? "question-box on" : "question-box"}
                      aria-hidden
                    >
                      {answer.picked.includes(option.value) ? <Icon name="check" /> : null}
                    </span>
                  ) : null}
                  <span className="question-option-label">
                    <AuthoredIcon name={option.icon} /> {option.label ?? option.value}
                  </span>
                  {option.description !== undefined && option.description.length > 0 ? (
                    <small className="question-option-desc">{option.description}</small>
                  ) : null}
                </button>
              ))}
            </div>
            {choice.freeText !== undefined && choice.freeText.first !== true ? (
              <FreeText choice={choice} answer={answer} onAnswer={onAnswer} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
