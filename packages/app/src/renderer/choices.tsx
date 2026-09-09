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
import type { JsonValue } from "@declarative-ai/json";
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
  /**
   * The "own answer" block is the one selected (an `instead` free text only).
   *
   * A switch rather than a reading of `text`: the block must be selectable BEFORE anything is typed
   * in it, and an option must be pickable again afterwards without the words being thrown away —
   * so which of the two is the answer has to be said, not inferred. Typing flips it on; picking an
   * option flips it off.
   */
  own?: boolean;
}

export const EMPTY_ANSWER: Answer = { picked: [], text: "" };

/**
 * Where a set of questions starts: each one's authored `default` already picked, and nothing typed.
 *
 * A pre-picked option is the reading the author took, so answering is confirming or overruling
 * rather than composing from nothing — which is what makes a question a person has no view on
 * passable without a "no view" option in the list.
 */
export function initialAnswers(choices: readonly Choice[]): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const choice of choices) {
    if (choice.default !== undefined) answers[choice.question] = { picked: [choice.default], text: "" };
  }
  return answers;
}

/** Whether a question can be moved past: answered, or declared passable. */
export function settled(choice: Choice, answer: Answer): boolean {
  return choice.optional === true || answerOf(choice, answer) !== undefined;
}

/**
 * The answers a RECORDED value spells, so a settled question can be drawn again as it was answered.
 *
 * The inverse of {@link answerOf} over the shapes the callers submit: `{ decision, comments }` for
 * one authored question, `{ answers: { key: value } }` for a stepped set and for an agent's batch
 * (keyed by the question's `name` where it has one, its text otherwise). A value that names none of
 * the options is the own-answer block's words — which is how an `instead` free text came back, and
 * the only way it could have. A multi-select that came back as one string of labels joined with
 * commas (the agent's wire spelling) is read back into its picks when every part is an option.
 *
 * Anything unrecognised answers nothing, which draws the question as never answered rather than
 * throwing over a record written by an older build.
 */
export function answersOfValue(choices: readonly Choice[], value: JsonValue | undefined): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return out;
  const record = value as Record<string, JsonValue>;
  const answers = record["answers"];
  if (answers !== undefined && answers !== null && typeof answers === "object" && !Array.isArray(answers)) {
    const byKey = answers as Record<string, JsonValue>;
    for (const choice of choices) {
      const given = byKey[choice.name ?? choice.question];
      if (given !== undefined) out[choice.question] = answerFrom(choice, given, undefined);
    }
    return out;
  }
  const only = choices[0];
  if (only === undefined || record["decision"] === undefined) return out;
  const comments = typeof record["comments"] === "string" ? record["comments"] : undefined;
  out[only.question] = answerFrom(only, record["decision"], comments);
  return out;
}

/** One question's recorded answer as the control's state — see {@link answersOfValue}. */
function answerFrom(choice: Choice, given: JsonValue, comments: string | undefined): Answer {
  const known = new Set(choice.options.map((o) => o.value));
  const alongside = choice.freeText?.role === "alongside" && comments !== undefined ? comments : "";
  if (Array.isArray(given)) {
    return { picked: given.filter((v): v is string => typeof v === "string"), text: alongside };
  }
  if (typeof given !== "string") return { picked: [], text: alongside };
  if (known.has(given)) return { picked: [given], text: alongside };
  if (choice.multiple === true) {
    const parts = given.split(", ");
    if (parts.length > 1 && parts.every((part) => known.has(part))) return { picked: parts, text: alongside };
  }
  // Not one of the options: it was said in the own-answer block, whichever role the field has —
  // an `alongside` field cannot answer on its own, so words here can only be an `instead`.
  return { picked: [], text: given, own: true };
}

/**
 * The answers out of the text an agent's question tool RETURNED, when no richer record was kept.
 *
 * The wire result reads `The user answered: "question"="answer", "question"="answer"` with each
 * half JSON-quoted, which is what makes it parseable at all: the quotes are balanced and escaped,
 * so a question containing a comma or a quote does not split the list. Anything else — a dismissal,
 * a refusal, an older spelling — answers nothing.
 */
export function answersOfAnsweredText(text: string): Record<string, string> | undefined {
  const at = text.indexOf("The user answered:");
  if (at < 0) return undefined;
  const out: Record<string, string> = {};
  const pair = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  for (const match of text.slice(at).matchAll(pair)) {
    try {
      out[JSON.parse(`"${match[1]!}"`) as string] = JSON.parse(`"${match[2]!}"`) as string;
    } catch {
      // A pair that does not decode is left out rather than guessed at.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * What one question currently answers to, or `undefined` when it is unanswered.
 *
 * The free-text role decides the precedence, which is the whole reason the role exists: `instead`
 * text REPLACES the picked option (an agent's "Other"), `alongside` text accompanies it and cannot
 * answer on its own (a gate's `comments`).
 */
export function answerOf(choice: Choice, answer: Answer): string | string[] | undefined {
  if (choice.freeText?.role === "instead" && answer.own === true) {
    const typed = answer.text.trim();
    return typed.length > 0 ? typed : undefined;
  }
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
  // Words in the own-answer box hold the question in confirm mode — whichever block is selected.
  // Selected and written in, they are the answer and need the button. Deselected by a pick, they
  // are still there, and the pick is a change of mind worth a look before it goes; a Confirm that
  // vanished on that click would also leave the new pick with nothing to send it. The box merely
  // CHOSEN and empty holds nothing: a tap on an option from there is still one tap.
  const answer = answers[only.question] ?? EMPTY_ANSWER;
  return !(only.freeText?.role === "instead" && answer.text.trim().length > 0);
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
  readOnly,
}: {
  choices: readonly Choice[];
  answers: Record<string, Answer>;
  onAnswer: (question: string, answer: Answer) => void;
  onSubmit: () => void;
  /** Anything the host wants beside the step buttons — a dismissal, usually. */
  extra?: JSX.Element | undefined;
  /**
   * The questions as they WERE answered: nothing can be changed and nothing confirms, but Back and
   * Next still turn the pages, because a set of questions read one at a time is still read one at
   * a time afterwards.
   */
  readOnly?: boolean | undefined;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const at = Math.min(step, choices.length - 1);
  const choice = choices[at]!;
  const last = at === choices.length - 1;
  const answer = answers[choice.question] ?? EMPTY_ANSWER;
  const answered = answerOf(choice, answer) !== undefined;
  // An optional question can be passed unanswered; the button says so rather than pretending an
  // empty step was confirmed.
  const passing = !answered && choice.optional === true;

  return (
    <>
      <p className="question-step">
        Question {at + 1} of {choices.length}
        {choice.optional === true ? <span className="sub"> · optional</span> : null}
      </p>
      <ChoiceList choices={[choice]} answers={answers} onAnswer={onAnswer} {...(readOnly === true ? { readOnly } : {})} />
      <div className="options">
        {at > 0 ? (
          <button className="ghost" onClick={() => setStep(at - 1)}>
            Back
          </button>
        ) : null}
        {readOnly === true ? (
          last ? null : (
            <button className="ghost" onClick={() => setStep(at + 1)}>
              Next
            </button>
          )
        ) : (
          <button
            className={passing ? "ghost" : "primary"}
            disabled={!settled(choice, answer)}
            onClick={() => (last ? onSubmit() : setStep(at + 1))}
          >
            {last ? (passing ? "Skip and confirm" : "Confirm") : passing ? "Skip" : "Next"}
          </button>
        )}
        {readOnly === true ? null : extra}
      </div>
    </>
  );
}

/**
 * The `alongside` free text beside a set of choices: a comment, which is prose about a decision.
 */
function FreeText({
  choice,
  answer,
  onAnswer,
  readOnly,
}: {
  choice: Choice;
  answer: Answer;
  onAnswer: (question: string, answer: Answer) => void;
  readOnly?: boolean | undefined;
}): JSX.Element | null {
  const field = choice.freeText;
  if (field === undefined) return null;
  return (
    <label className="field">
      <small>{field.label}</small>
      <textarea
        rows={3}
        value={answer.text}
        placeholder={readOnly === true ? "" : (field.placeholder ?? "")}
        readOnly={readOnly === true}
        tabIndex={readOnly === true ? -1 : undefined}
        onChange={(e) => onAnswer(choice.question, { ...answer, text: e.target.value })}
      />
    </label>
  );
}

/**
 * The `instead` free text: one more option, said in words — so it is drawn as one of the options,
 * in the option list, selected the way one is.
 *
 * It was a plain field under the list, which made two things wrong at once: typing in it left the
 * picked option lit while the words silently outranked it, and there was no way to choose the block
 * itself. Now clicking it (or focusing its box) selects it, typing selects it, and picking an
 * option deselects it — the words stay, so coming back is a click, not a retype.
 */
function OwnAnswer({
  choice,
  answer,
  onAnswer,
  readOnly,
}: {
  choice: Choice;
  answer: Answer;
  onAnswer: (question: string, answer: Answer) => void;
  readOnly?: boolean | undefined;
}): JSX.Element | null {
  const field = choice.freeText;
  if (field === undefined) return null;
  const selected = answer.own === true;
  const select = (): void => {
    if (readOnly !== true && !selected) onAnswer(choice.question, { ...answer, own: true });
  };
  return (
    // A div rather than a button: a button cannot hold an input. The role says what it is.
    <div
      role="radio"
      aria-checked={selected}
      className={selected ? "question-option own selected" : "question-option own"}
      onClick={(e) => {
        select();
        // The click lands in the box: choosing the block is choosing to write in it.
        e.currentTarget.querySelector("textarea")?.focus();
      }}
    >
      <span className="question-option-label">{field.label}</span>
      {/* One row that grows with the words (`field-sizing: content`): an answer of your own is
          however long it is, and a box that scrolled it out of sight hid what was about to be sent. */}
      <textarea
        rows={1}
        value={answer.text}
        // No invitation to type in a record of what was typed: the empty block reads as unused.
        placeholder={readOnly === true ? "" : (field.placeholder ?? "")}
        readOnly={readOnly === true}
        tabIndex={readOnly === true ? -1 : undefined}
        onFocus={select}
        onChange={(e) => onAnswer(choice.question, { ...answer, text: e.target.value, own: true })}
      />
    </div>
  );
}

export function ChoiceList({
  choices,
  answers,
  onAnswer,
  onImmediate,
  readOnly,
}: {
  choices: readonly Choice[];
  answers: Record<string, Answer>;
  onAnswer: (question: string, answer: Answer) => void;
  /** Called instead of recording a pick, when {@link submitsOnClick}. */
  onImmediate?: ((question: string, value: string) => void) | undefined;
  /**
   * The question as it WAS answered — the same picture, with nothing in it that can be pressed.
   *
   * What the conversation shows once a gate has settled: the pick lit, the words as typed, and the
   * options that were not taken still there, because which options there were is part of what
   * was asked. Drawn with the controls disabled rather than with a different component, so a
   * settled question looks like the question and not like a summary of it.
   */
  readOnly?: boolean | undefined;
}): JSX.Element {
  const immediate = submitsOnClick(choices, answers);

  const toggle = (choice: Choice, value: string): void => {
    if (readOnly === true) return;
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
    // Picking an option is un-picking the own-answer block; its words are kept (see `OwnAnswer`).
    onAnswer(choice.question, { ...answer, picked, own: false });
  };

  return (
    <>
      {choices.map((choice) => {
        const answer = answers[choice.question] ?? EMPTY_ANSWER;
        // What is lit: the picks, unless the own-answer block is the selected one.
        const lit = (value: string): boolean => answer.own !== true && answer.picked.includes(value);
        // The first plain option of a bare row is the affirmative one, drawn as the action.
        const bare = choice.options.every((o) => o.description === undefined);
        const own =
          choice.freeText?.role === "instead" ? (
            <OwnAnswer choice={choice} answer={answer} onAnswer={onAnswer} {...(readOnly === true ? { readOnly } : {})} />
          ) : null;
        const comment =
          choice.freeText?.role === "alongside" ? (
            <FreeText choice={choice} answer={answer} onAnswer={onAnswer} {...(readOnly === true ? { readOnly } : {})} />
          ) : null;
        return (
          <div key={choice.question} className={readOnly === true ? "question-block readonly" : "question-block"}>
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
            {/* Why it is asked, or what each answer would change. Under the question rather than in
                a tooltip: a question a person cannot answer without reading the spec is a question
                that has not been finished, and this line is where it gets finished. */}
            {choice.description !== undefined ? <p className="question-desc">{choice.description}</p> : null}
            {/* An `alongside` free text is written BEFORE the decision — it is a note about the
                thing being decided, and a single-select answers on the click, so a comment box
                below the buttons is a box you can never reach in time. An `instead` one belongs
                with the options, because it is one of them said in words.

                This is also what makes `review_artifact` read like `review_artifacts`: comment,
                then the row of actions at the bottom. */}
            {choice.freeText?.first === true ? comment : null}
            <div className="question-options">
              {choice.freeText?.first === true ? own : null}
              {choice.options.map((option, index) => (
                <button
                  key={option.value}
                  role={choice.multiple === true ? "checkbox" : undefined}
                  aria-checked={choice.multiple === true ? lit(option.value) : undefined}
                  className={[
                    "question-option",
                    choice.multiple === true ? "checkable" : "",
                    lit(option.value) ? "selected" : "",
                    option.tone === "danger" ? "danger" : "",
                    // The first plain option of a bare row is the affirmative one, drawn the way the
                    // reviewer's "Apply the review" is — so a decision looks like a decision rather
                    // than like a list you might also be able to leave alone.
                    index === 0 && option.tone !== "danger" && bare ? "primary" : "",
                  ]
                    .join(" ")
                    .trim()}
                  title={option.description ?? ""}
                  disabled={readOnly === true}
                  tabIndex={readOnly === true ? -1 : undefined}
                  onClick={() => toggle(choice, option.value)}
                >
                  {/* A multi-select says so in its OPTIONS, not only in a hint somewhere.
                      Without a box on each row the control is a set of buttons that mysteriously
                      does not close the dialog, and the person learns it is multi-select by
                      clicking twice and being surprised. The box is on the right so the labels
                      still align on the left. */}
                  {choice.multiple === true ? (
                    <span
                      className={lit(option.value) ? "question-box on" : "question-box"}
                      aria-hidden
                    >
                      {lit(option.value) ? <Icon name="check" /> : null}
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
              {choice.freeText?.first === true ? null : own}
            </div>
            {choice.freeText?.first === true ? null : comment}
          </div>
        );
      })}
    </>
  );
}
