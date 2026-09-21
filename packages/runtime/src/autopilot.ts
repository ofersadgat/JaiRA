/**
 * What a fast-forward ASKS THE CONVERSATION (decision 0005 §4, step 7) — the pure half.
 *
 * A task is being run forward to a state somebody named, and a question comes up on the way. The
 * conversation steering the work is what answers it, "with the whole conversation behind it, which
 * is the reason it is the one to do it": so the call carries what has been said, what the work is
 * being taken towards, and the question exactly as the person would have seen it.
 *
 * This module builds that one call and reads its reply. It decides nothing:
 *
 *  - **which questions are even offered** is the host's, and it is the approval exclusion
 *    ([workflowHost](../../app/src/main/workflowHost.ts)): the two pending lists this reaches are
 *    filtered to `ANSWERABLE_COMPONENTS`, and an approval hub is not a dependency of either half.
 *    Nothing here could reach an approval if it wanted to;
 *  - **whether the answer stands** is `autopilot.askBelow`, applied by the host to the confidence
 *    that comes back. A model saying it is sure is not the same as being allowed to act on it;
 *  - **settling it** is the `answer` tool's host operation, which journals `jaira.answered` and
 *    makes the whole thing a rewind point.
 *
 * ## Why a structured answer and not the tool
 *
 * The model could be handed `answer` and left to call it — it holds the tool in every other turn.
 * It is asked for a VALUE instead, and the host calls `answer` itself, for one reason: the
 * threshold. A conversation that decides for itself whether it is confident enough has been handed
 * the setting, and `askBelow` exists precisely because that is not its decision to make.
 */
import { promptOp, type ExecServices, type InlineFamily, type PromptOp } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import { SchemaValidator } from "@declarative-ai/validate";
import type { ComponentConfig } from "@jaira/shared";

/** The question, as the person would have been shown it. One of the two channels a gate parks on. */
export type AutopilotAsk =
  | {
      kind: "interaction";
      /** The component's registered name — `choose_option`, `fill_form`, `review_artifact`, `edit_artifact`. */
      component: string;
      /** The parsed config, when it parsed. Absent ⇒ the raw inputs are all there is to go on. */
      config?: ComponentConfig;
      inputs: Record<string, JsonValue>;
    }
  | {
      kind: "question";
      /** An agent's `AskUserQuestion`, as it asked it. */
      questions: JsonValue;
    };

/** Everything the call is told about WHY it is being asked. */
export interface AutopilotContext {
  /** The task being run forward, by title. */
  title: string;
  /** Where it is being taken — the target state id. */
  target: string;
  /** Where it stands right now, as child keys. */
  at?: string;
  /** The conversation so far, oldest first — what was said, by whom. */
  said: Array<{ role: string; text: string }>;
}

/**
 * What the model returns.
 *
 * `answer` is free-form on purpose: it is the component's own result shape, and the platform names
 * none of a workflow's slots (§0). It is checked by `validateComponentResult` in main before it
 * settles anything, exactly as a person's answer is — an answer that does not fit the contract is
 * refused and the question goes back to the person.
 */
export const AUTOPILOT_OUTPUT_SCHEMA: JsonValue = {
  type: "object",
  required: ["answer", "confidence"],
  properties: {
    answer: {
      type: "object",
      description: "The answer, in exactly the shape this question's result takes. Nothing else.",
      additionalProperties: true,
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "How sure you are that this is what the person would have said, given what they have told you. Be honest and be stingy: below the project's threshold the question is left to them, which is the right outcome whenever you are guessing.",
    },
    reason: { type: "string", description: "One sentence: what in the conversation decided it." },
  },
};

/** The result shape each answerable component takes back, in the words the model is given. */
const SHAPES: Record<string, string> = {
  choose_option:
    "`{ \"decision\": \"<one of the options' values>\", \"comments\": \"<optional>\" }` — or, when the config carries `questions`, `{ \"answers\": { \"<question name>\": \"<that question's option value>\" } }` with one key per question that is not optional.",
  review_artifact: "`{ \"decision\": \"<one of the options' values>\", \"comments\": \"<optional>\" }`.",
  edit_artifact: "`{ \"content\": \"<the whole document, as it should now read>\" }`.",
  fill_form: "`{ \"<field name>\": <value of that field's type> }`, one key per field that is not optional.",
};

/**
 * The one call: here is the conversation, here is the question, answer it as they would.
 *
 * Deliberately NOT "do what seems best". The conversation is answering ON SOMEBODY'S BEHALF and the
 * standard it is held to is what THEY would have said — which is also the standard that makes a low
 * confidence the right answer when the conversation has not been told.
 */
export function autopilotOperation(ask: AutopilotAsk, context: AutopilotContext): PromptOp<InlineFamily> {
  const said =
    context.said.length === 0
      ? "Nothing has been said yet."
      : context.said.map((turn) => `**${turn.role}**: ${turn.text}`).join("\n\n");
  const question =
    ask.kind === "question"
      ? [
          "An agent working on the task stopped to ask. Its questions, as it asked them:",
          "",
          "```json",
          JSON.stringify(ask.questions, null, 2),
          "```",
          "",
          "Answer shape: `{ \"<the question's exact text>\": \"<the exact label of the option you pick>\" }`, one key per question.",
        ]
      : [
          `A \`${ask.component}\` gate is waiting. What it is showing:`,
          "",
          "```json",
          JSON.stringify(ask.config ?? ask.inputs, null, 2),
          "```",
          "",
          `Answer shape: ${SHAPES[ask.component] ?? "the object this component's result takes."}`,
        ];
  const user = [
    "You are the conversation steering a piece of work, and the person who asked for it has sent it ahead to a later state. It is running, and it has stopped to ask something.",
    "",
    "Answer it AS THEY WOULD, from what they have told you — not as you would prefer, and not as seems generally sensible. If what they said does not decide it, say so with a low confidence and it goes back to them, which costs nothing.",
    "",
    `## The work: ${context.title}`,
    "",
    `It is being fast-forwarded to \`${context.target}\`${context.at !== undefined ? `, and stands at \`${context.at}\`` : ""}.`,
    "",
    "## What has been said",
    "",
    said,
    "",
    "## What it is asking",
    "",
    ...question,
    "",
    "## What to produce",
    "",
    "`answer` in exactly that shape, `confidence` between 0 and 1, and `reason` in one sentence.",
  ].join("\n");
  return promptOp({ user, output: { name: "autopilot", schema: AUTOPILOT_OUTPUT_SCHEMA as never } });
}

/** What the reply carried, or nothing when it carried no usable answer. */
export interface AutopilotAnswer {
  answer: JsonValue;
  confidence: number;
  reason?: string;
}

/**
 * Read the reply. A missing or unusable answer is `undefined`, never a throw: a fast-forward that
 * cannot get an answer leaves the question to the person, which is what it does anyway below the
 * threshold.
 */
export function autopilotAnswerOf(reply: JsonValue | undefined): AutopilotAnswer | undefined {
  if (reply === undefined || reply === null || typeof reply !== "object" || Array.isArray(reply)) return undefined;
  const record = reply as Record<string, JsonValue>;
  const answer = record["answer"];
  const confidence = record["confidence"];
  if (answer === undefined || answer === null) return undefined;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  return {
    answer,
    confidence: Math.min(1, Math.max(0, confidence)),
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
  };
}

/**
 * An agent's questions are answered by TEXT → label, and a model writes JSON. Anything that is not
 * a string or a list of strings is dropped rather than sent: the question hub takes those two.
 */
export function autopilotAnswersOf(answer: JsonValue): Record<string, string | string[]> | undefined {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(answer as Record<string, JsonValue>)) {
    if (typeof value === "string") out[name] = value;
    else if (Array.isArray(value) && value.every((one) => typeof one === "string")) out[name] = value as string[];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** What the call runs under: a validator and nothing else — as a follow-up round does. */
export function autopilotServices(): ExecServices {
  return { validator: new SchemaValidator() };
}
