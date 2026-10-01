/**
 * A set of choices as an ANSWER — the one control behind an authored gate and an agent's question
 * ([decision 0002](../../../../docs/engineering/decisions/0002-one-gate-vocabulary.md)).
 *
 * `choose_option` and `AskUserQuestion` differ in where the answer goes and whether it is checked
 * against a declared enum, and in nothing a person can see, so both normalize into {@link Choice} and
 * are answered here: what is picked and typed, when that is settled, what a click submits, and the
 * answers read back out of what was stored. `Choices`
 * (`packages/universal/src/components/floats/Choices.tsx`) and the gates draw from it; nothing here draws.
 */
import { answerText, readAnswer, type Choice } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { useSchemaCheck } from "./schemaForm/check";
import type { Schema } from "./schemaForm/types";

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
  // A TYPED answer came back as the value it was read as: a pick by its words, anything else as what
  // was typed — a structure laid out the way a person would have written it.
  if (choice.schema !== undefined) {
    if (choice.multiple === true && Array.isArray(given)) return { picked: given.map((one) => answerText(one)), text: "" };
    const words = answerText(given);
    if (known.has(words)) return { picked: [words], text: "" };
    return { picked: [], text: given !== null && typeof given === "object" ? JSON.stringify(given, null, 2) : words, own: true };
  }
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
 * The text reads `User has answered your questions: "question"="answer", …. You can now continue
 * with the user's answers in mind.` and quotes NOTHING inside the halves — a question that itself
 * quotes the issue, or an answer with a comma in it, defeats any parse that goes by punctuation, and
 * one such question drew as never answered. So when the caller knows the questions (it always can:
 * they are the call's own arguments) each is looked up VERBATIM as `"question"=`, and its answer runs
 * to the next question's marker or to the closing sentence. A quoted-pair parse remains for text
 * with no known question in it. Anything else — a dismissal, a refusal — answers nothing.
 */
export function answersOfAnsweredText(text: string, questions: readonly string[] = []): Record<string, string> | undefined {
  const at = text.indexOf("User has answered your questions:");
  if (at < 0) return undefined;
  const anchored = answersAnchoredOn(text.slice(at), questions);
  if (anchored !== undefined) return anchored;
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

/** The sentence that closes the current spelling — what the last answer runs up to. */
const ANSWERED_CLOSE = ". You can now continue";

/**
 * Each known question's answer, cut between the question markers — see {@link answersOfAnsweredText}.
 * Nothing when no known question is in the text at all.
 */
function answersAnchoredOn(body: string, questions: readonly string[]): Record<string, string> | undefined {
  const marks = questions
    .map((question) => ({ question, at: body.indexOf(`"${question}"="`) }))
    .filter((mark) => mark.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (marks.length === 0) return undefined;
  const out: Record<string, string> = {};
  marks.forEach((mark, i) => {
    const from = mark.at + mark.question.length + 4; // past `"`, the question, and `"="`
    const next = marks[i + 1];
    let to: number;
    if (next !== undefined) {
      to = next.at - 2; // the `, ` between one answer's closing quote and the next question's opening one
    } else {
      const close = body.lastIndexOf(ANSWERED_CLOSE);
      to = close >= from ? close : body.length;
    }
    const answer = body.slice(from, Math.max(from, to)).trimEnd();
    out[mark.question] = answer.endsWith('"') ? answer.slice(0, -1) : answer;
  });
  return out;
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
 * Whether a TYPED step's answer ({@link Choice.schema}) can be sent, and why not.
 *
 * The answer is read as a value of the schema (`readAnswer`: text where it takes text, JSON
 * otherwise), and the value is put to main's `schema:check` — the run's own validator, the one the
 * schema form asks — so what the step accepts is what the run would. A step with no schema, or with
 * nothing answered yet, holds nothing.
 */
export function useTypedStep(choice: Choice, given: string | string[] | undefined): { holds: boolean; problem?: string } {
  const read = choice.schema !== undefined && given !== undefined ? readAnswer(choice.schema, given) : undefined;
  const check = useSchemaCheck(read?.ok === true ? [{ path: "", schema: choice.schema as Schema, value: read.value }] : []);
  if (read === undefined) return { holds: false };
  if (!read.ok) return { holds: true, problem: read.error };
  const first = check.errors[0];
  if (first !== undefined) return { holds: true, problem: first.path === "" ? first.message : `${first.path}: ${first.message}` };
  return { holds: check.pending };
}
