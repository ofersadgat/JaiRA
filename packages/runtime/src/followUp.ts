/**
 * Follow-up questions, inside the component — the loop `choose_option`'s `follow_up: true` runs.
 *
 * The state says `follow_up: true` and the person answers a round of questions. The gate does not
 * settle: the host asks a model whether the answers opened anything ELSE only a person can settle,
 * and either parks the same call again with the new questions or settles it with every round's
 * answers merged. The flag is the STATE's: the person is never asked whether to allow the round,
 * and the answer carries nothing about it. The engine sees one function call and one result —
 * `{ answers }` keyed by every question asked across the rounds — which is the contract the person
 * asked for: the extra questions and their answers come back in the same result as the ones that
 * were passed in.
 *
 * The model is asked ONCE per round, with the gate's prompt, every question so far with its answer,
 * and the rest of the state's inputs as context: a `choose_option` state's inputs are one flat
 * namespace (config beside whatever the author wired in), so the context a follow-up needs — the
 * issue, the draft — is whatever the author gave the state beyond the config. This module builds
 * the prompt and reads the reply; the executor that answers it is the host's, because that is where
 * the routing, the secrets and the scripted runs live.
 */
import { promptOp, type ExecServices, type InlineFamily, type PromptOp } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import { SchemaValidator } from "@declarative-ai/validate";
import { parseComponentConfig, type ChoiceQuestion, type ChooseOptionConfig } from "@jaira/shared";

/** How many rounds one gate may run. A model that keeps finding more to ask is asked this many times. */
export const MAX_FOLLOW_UP_ROUNDS = 5;

/**
 * The loop's own inputs, carried on the reparked request so a round knows what came before it.
 *
 * On the request's INPUTS rather than in memory, because the request is what survives: the durable
 * row holds it, the renderer's contract parse reads it, and a later round's validation goes by the
 * questions it carries. A key here is never a config key, so `parseComponentConfig` ignores it.
 */
export const PRIOR_ANSWERS = "prior_answers";
export const PRIOR_QUESTIONS = "prior_questions";
export const FOLLOW_UP_ROUND = "follow_up_round";

/** The config keys and the loop's own, which are not context for the model. */
const NOT_CONTEXT = new Set([
  "prompt",
  "questions",
  "options",
  "comments",
  "multiple",
  "custom",
  "require_confirm",
  "follow_up",
  "icon",
  PRIOR_ANSWERS,
  PRIOR_QUESTIONS,
  FOLLOW_UP_ROUND,
]);

/** One follow-up question, as the model writes it — the multi-part gate's own shape. */
const QUESTION_SCHEMA: JsonValue = {
  type: "object",
  required: ["name", "question", "options"],
  properties: {
    name: { type: "string", description: "The key the answer lands on. Never one already used." },
    question: { type: "string" },
    header: { type: "string", description: "A short chip beside the question, e.g. Scope." },
    description: { type: "string", description: "Why it is asked, or what each answer would change." },
    options: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" }, description: { type: "string" } },
      },
    },
    default: { type: "string", description: "The reading you would take; one of the options." },
    custom: { type: "boolean" },
    optional: { type: "boolean" },
  },
};

/** What the model returns: the follow-up questions, or none. */
export const FOLLOW_UP_OUTPUT_SCHEMA: JsonValue = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: { type: "array", items: QUESTION_SCHEMA, description: "Empty when the answers opened nothing." },
  },
};

/** The answers of every round so far, the latest on top. */
export function mergedAnswers(inputs: Record<string, JsonValue>, value: JsonValue): Record<string, JsonValue> {
  const prior = recordOf(inputs[PRIOR_ANSWERS]);
  const now = value !== null && typeof value === "object" && !Array.isArray(value) ? recordOf((value as Record<string, JsonValue>)["answers"]) : {};
  return { ...prior, ...now };
}

/** Every question asked so far: the rounds before this one, then this one's. */
export function askedSoFar(config: ChooseOptionConfig, inputs: Record<string, JsonValue>): ChoiceQuestion[] {
  const prior = Array.isArray(inputs[PRIOR_QUESTIONS]) ? (inputs[PRIOR_QUESTIONS] as JsonValue[]) : [];
  const before = prior.filter(isChoiceQuestionLike) as unknown as ChoiceQuestion[];
  return [...before, ...(config.questions ?? [])];
}

/** Which round this request is — 1 for the one the state parked. */
export function roundOf(inputs: Record<string, JsonValue>): number {
  const round = inputs[FOLLOW_UP_ROUND];
  return typeof round === "number" && Number.isInteger(round) && round >= 1 ? round : 1;
}

/** Whether a round of answers to this gate is followed by the model's check: the state said so. */
export function wantsFollowUp(config: ChooseOptionConfig): boolean {
  return config.followUp === true && config.questions !== undefined;
}

/**
 * The question to the model: has this round of answers opened anything else?
 *
 * Only what the ANSWERS opened, never what could have been asked the first time — a model given a
 * standing invitation to ask more will ask more, and the state asked to hear the questions the
 * answers raised, not to have the person interviewed. Names already used are ruled out so a follow-up
 * cannot overwrite an answer in the merge.
 */
export function followUpOperation(
  config: ChooseOptionConfig,
  inputs: Record<string, JsonValue>,
  answers: Record<string, JsonValue>,
): PromptOp<InlineFamily> {
  const asked = askedSoFar(config, inputs);
  const context = Object.fromEntries(Object.entries(inputs).filter(([key]) => !NOT_CONTEXT.has(key)));
  const rounds = `${roundOf(inputs)} of ${MAX_FOLLOW_UP_ROUNDS}`;
  const user = [
    "You put questions to a person and they answered. Decide whether their answers open anything ELSE that only a person can settle, and ask it as follow-up questions.",
    "",
    "Ask only what the answers opened, never what you could have asked the first time. Nothing open means an empty list, and an empty list is the usual answer. Never reuse a name already used. Each question takes the same shape as the ones asked: a name, the question, options with a description each, the reading you would take as `default`, `custom: true` so the person can say it their own way, and `optional: true` so they can pass.",
    "",
    `This is follow-up round ${rounds}.`,
    "",
    "## The question put to them",
    "",
    config.prompt,
    "",
    "## The questions and their answers",
    "",
    "A question with no answer was passed: the default stood.",
    "",
    "```json",
    JSON.stringify(asked.map((q) => ({ ...q, answer: answers[q.name] ?? null })), null, 2),
    "```",
    "",
    "## The context the questions came from",
    "",
    Object.keys(context).length === 0 ? "None beyond the questions themselves." : "```json\n" + JSON.stringify(context, null, 2) + "\n```",
    "",
    "## What to produce",
    "",
    "`questions`: the follow-up questions, or an empty list.",
  ].join("\n");
  return promptOp({ user, output: { name: "follow_up", schema: FOLLOW_UP_OUTPUT_SCHEMA as never } });
}

/**
 * The follow-up questions out of the model's reply, parsed the way an authored round is — so a
 * malformed one is refused here rather than drawn as a gate nobody can answer. Names already asked
 * are dropped: a repeat would overwrite an answer. Empty when the model had nothing to ask.
 */
export function followUpQuestionsOf(reply: JsonValue | undefined, asked: readonly ChoiceQuestion[]): ChoiceQuestion[] {
  const record = reply !== undefined ? recordOf(reply) : {};
  const raw = Array.isArray(record["questions"]) ? (record["questions"] as JsonValue[]) : [];
  const used = new Set(asked.map((q) => q.name));
  const fresh = raw.filter((q) => isChoiceQuestionLike(q) && !used.has((q as Record<string, JsonValue>)["name"] as string));
  if (fresh.length === 0) return [];
  const parsed = parseComponentConfig("choose_option", { prompt: "follow-up", questions: fresh }) as ChooseOptionConfig;
  return parsed.questions ?? [];
}

/**
 * The inputs of the NEXT round: the same state, asking the new questions, remembering the rest.
 *
 * `questions` is replaced rather than appended — the stepper asks this round's questions and the
 * validation checks this round's answers — and the questions and answers so far move to the prior
 * slots, where the merge and the model's next prompt read them.
 */
export function nextRoundInputs(
  config: ChooseOptionConfig,
  inputs: Record<string, JsonValue>,
  answers: Record<string, JsonValue>,
  questions: readonly ChoiceQuestion[],
): Record<string, JsonValue> {
  return {
    ...inputs,
    questions: questions as unknown as JsonValue,
    [PRIOR_QUESTIONS]: askedSoFar(config, inputs) as unknown as JsonValue,
    [PRIOR_ANSWERS]: answers,
    [FOLLOW_UP_ROUND]: roundOf(inputs) + 1,
  };
}

/** What a bare follow-up call runs under: a validator and nothing else — no session, no tools, no gate. */
export function followUpServices(): ExecServices {
  return { validator: new SchemaValidator() };
}

/** The result the engine gets once the rounds are over: every answer, and nothing about the loop. */
export function settledFollowUp(answers: Record<string, JsonValue>): JsonValue {
  return { answers };
}

function recordOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

function isChoiceQuestionLike(value: JsonValue): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return typeof record["name"] === "string" && typeof record["question"] === "string" && Array.isArray(record["options"]);
}
