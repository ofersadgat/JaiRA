/**
 * The built-in UI components (SPEC §8.1, DESIGN §7.1).
 *
 * A UI state is a `FunctionOp` whose function names one of these components; the
 * state's authored surface arrives as the op's `config` input. This module is the
 * contract both sides agree on:
 *
 * ## Where a config comes from, which has two answers
 *
 * A component's authored surface IS `operation.args`, flat — there is no `config` key wrapping it,
 * and a reader that looked for one got `undefined` for every component ever parked. At RUN time it
 * is parsed from what the function actually received, which is those args merged with the state's
 * resolved inputs into one namespace. That merge is why a config field may never NAME another
 * input: the name and the value collide. See {@link changesetInputOf}.
 *
 *  - {@link parseComponentConfig} reads what the *author* wrote, so a malformed
 *    state file fails with a clear message instead of rendering an empty dialog.
 *  - {@link validateComponentResult} checks what the *user* submitted before it
 *    can enter the engine. That check is the reason this lives in `shared` rather
 *    than in the renderer: the renderer is the untrusted half of the boundary, so
 *    the main process re-validates every answer (DESIGN §7.1). The engine then
 *    separately validates against the state's declared output schema.
 *
 * Result shapes are chosen to land directly on a state's declared outputs — e.g.
 * `choose_option` returns `{ decision, comments? }`, which is exactly what SPEC
 * §8.2's human-review state declares.
 */
import type { JsonValue } from "@declarative-ai/json";
import { changesetOf, checkDecisions, DECISION_KINDS, type Changeset } from "./changeset";
import { checkNotes } from "./reviewNotes";
import { parseDuration } from "./forge";

export const COMPONENT_NAMES = [
  "choose_option",
  "review_artifact",
  "edit_artifact",
  "fill_form",
  "confirm_action",
  // N artifacts, each decided — the changeset gate is its N-artifact case (CHANGESETS.md §4.1,
  // decision 0002). Its implementation is still changeset-shaped; the generalization is staged.
  "review_artifacts",
  // The APPROVAL PROMPT as a function (decision 0007, amended 2026-09-22): what a permission function
  // calls to put a tool call to the person. Its answer is `allow` or `deny`. An approval, never a
  // question — so a fast-forward's conversation is never offered it (decision 0005 §4).
  "approve_tool_call",
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

export function isComponentName(name: string): name is ComponentName {
  return (COMPONENT_NAMES as readonly string[]).includes(name);
}

/** One selectable choice. Authors may write a bare string or a labelled option. */
export interface ComponentOption {
  value: string;
  label?: string;
  /** What choosing it means — a line under the label. Was agent-side only until decision 0002. */
  description?: string;
  /**
   * A glyph beside the label — one of the renderer's icon names.
   *
   * A NAME rather than any markup: a component config is authored content, and letting it carry a
   * path or an SVG would put drawing instructions from a workflow file into a privileged renderer.
   * An unknown name draws nothing, which is the safe failure.
   */
  icon?: string;
  /** Rendered as a destructive/secondary action (e.g. `block`). */
  tone?: "default" | "danger";
}

/**
 * The free-text field beside a set of choices, and the two ROLES it plays.
 *
 * This is the distinction that kept `choose_option` and `AskUserQuestion` looking like two
 * components. Both draw a text box next to some buttons; they mean opposite things by it. A gate's
 * `comments` is said IN ADDITION to the choice, so clicking a button while there is text in the box
 * is a complete answer. An agent's "Other" is said INSTEAD of the choice, so text in the box
 * overrides whatever was picked and the answer is not complete until it is confirmed.
 *
 * Naming the role is what lets one control serve both — and what decides whether clicking an option
 * submits on the spot.
 */
export interface ChoiceFreeText {
  /** What the field is called on screen. */
  label: string;
  placeholder?: string;
  role: "alongside" | "instead";
  /**
   * Draw the field ABOVE the options rather than below them.
   *
   * Declared rather than inferred from the role, because the two components that use `alongside`
   * want opposite orders and both are right. In `choose_option` the options ARE the content and a
   * comment is an aside, so it follows them. In `review_artifact` the content is the artifact above
   * and the options are a decision row at the very bottom — putting the comment under them would
   * mean typing it after the click that already submitted.
   */
  first?: boolean;
}

/**
 * One question on screen, whoever asked it (decision 0002).
 *
 * The normalized form both callers reduce to: an authored gate state via {@link choicesOfConfig},
 * and a running agent's `AskUserQuestion` via `choicesOfQuestions` (in `ipc.ts`, which is the side
 * that knows the wire shape). The renderer draws this and nothing else, which is the whole point —
 * the two callers differ in where the answer goes, and a person cannot see that.
 */
export interface Choice {
  /** The complete question. Also the key an agent's answers are returned under. */
  question: string;
  /**
   * The key an AUTHORED answer lands on, when the state named one (a multi-part `choose_option`'s
   * `questions[].name`). Absent ⇒ the question text is the key, which is the agent caller's rule.
   */
  name?: string;
  /** A short chip beside it, e.g. `Library`. */
  header?: string;
  /** Why it is being asked, or what each answer would change — a line under the question. */
  description?: string;
  options: ComponentOption[];
  /** Several may be chosen; the answer is then a list. */
  multiple?: boolean;
  freeText?: ChoiceFreeText;
  /** A glyph beside the question. Absent ⇒ the caller's default. */
  icon?: string;
  /**
   * Picking is not answering: the choice is held until a confirm button is pressed.
   *
   * The default is the opposite — a single-select answers on the click, which is what makes the
   * common case one tap. This is for the decisions where a mis-click is expensive, and it is the
   * author's call rather than a rule about how many options there are.
   */
  requireConfirm?: boolean;
  /**
   * Leaving it unanswered is allowed — the step can be passed and the answer is simply absent.
   *
   * The product-questions case: a person with no view must be able to move on, and "no view" spelt
   * as one more option would be an answer the state then has to know to ignore.
   */
  optional?: boolean;
  /** The option pre-picked when the question first appears — the reading the author took. */
  default?: string;
  /**
   * The answer is a VALUE of this JSON Schema, not a word (a multi-part `choose_option`'s
   * `questions[].schema`): a pick and an own answer are both read as one ({@link readAnswer}), and
   * the control holds a step whose answer the schema refuses, saying why, until it is changed.
   */
  schema?: JsonValue;
}

/** The "own answer" field an authored state offers when it says `custom: true`. */
const OWN_ANSWER: ChoiceFreeText = { label: "Your own answer", placeholder: "Type your own answer…", role: "instead" };

// ---------------------------------------------------------------------------------------------------
// typed answers
// ---------------------------------------------------------------------------------------------------

/** The JSON types a schema admits at its top — `undefined` when it names none (anything goes). */
function typesOf(schema: JsonValue): Set<string> | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const type = (schema as Record<string, JsonValue>)["type"];
  if (typeof type === "string") return new Set([type]);
  if (Array.isArray(type)) return new Set(type.filter((t): t is string => typeof t === "string"));
  return undefined;
}

/** The JSON type of a parsed value, in schema words (`integer` is a `number` too — see {@link admits}). */
function jsonTypeOf(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const admits = (types: Set<string>, value: JsonValue): boolean => {
  const type = jsonTypeOf(value);
  return types.has(type) || (type === "number" && types.has("integer") && Number.isInteger(value));
};

/**
 * The words a value is offered and typed as: a string is itself, anything else is its JSON — which
 * is how an enum member becomes an option's `value` and how a recorded typed answer is drawn again.
 */
export function answerText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** What an own answer is written as, for a schema whose values are not text. */
function expecting(types: Set<string> | undefined): string {
  if (types?.has("object") === true) return 'a JSON object, like {"key": "value"}';
  if (types?.has("array") === true) return 'a JSON list, like ["one", "two"]';
  if (types?.has("number") === true || types?.has("integer") === true) return "a number";
  if (types?.has("boolean") === true) return "true or false";
  return "JSON";
}

/** How the own-answer box invites a value of `schema` — words for text, the shape otherwise. */
export function placeholderFor(schema: JsonValue): string {
  const types = typesOf(schema);
  if (types === undefined || types.has("string")) return OWN_ANSWER.placeholder!;
  return `Type ${expecting(types)}…`;
}

/** One answer's words as a value of `schema` — see {@link readAnswer}. */
function readOne(schema: JsonValue, text: string): { ok: true; value: JsonValue } | { ok: false; error: string } {
  // A declared member reads as itself: an enum of numbers offered as "3" answers 3.
  const members = schema !== null && typeof schema === "object" && !Array.isArray(schema) ? (schema as Record<string, JsonValue>)["enum"] : undefined;
  if (Array.isArray(members)) {
    const hit = members.find((member) => answerText(member) === text);
    if (hit !== undefined) return { ok: true, value: hit };
  }
  const types = typesOf(schema);
  const text_ = types === undefined || types.has("string");
  if (types !== undefined && types.size === 1 && text_) return { ok: true, value: text };
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return text_ ? { ok: true, value: text } : { ok: false, error: `expects ${expecting(types)}` };
  }
  // Words that happen to parse are still words where the schema takes text and not that JSON type.
  if (types !== undefined && text_ && !admits(types, parsed)) return { ok: true, value: text };
  return { ok: true, value: parsed };
}

/**
 * An answer read as a VALUE of its question's schema ({@link Choice.schema}): a picked option by its
 * value, an own answer by what was typed. Text is taken as written where the schema takes text, and
 * as JSON otherwise — so `3` answers an integer, `true` a boolean and `{"a": 1}` an object. A
 * multi-select's picks are each read against the schema's `items`.
 *
 * Only the reading: whether the value then FITS the schema is the run's validator's to say (main's
 * `schema:check`), which the control asks before a step can be confirmed and main asks again on submit.
 */
export function readAnswer(schema: JsonValue, answer: string | readonly string[]): { ok: true; value: JsonValue } | { ok: false; error: string } {
  if (typeof answer === "string") return readOne(schema, answer);
  const items = schema !== null && typeof schema === "object" && !Array.isArray(schema) ? ((schema as Record<string, JsonValue>)["items"] ?? true) : true;
  const out: JsonValue[] = [];
  for (const one of answer) {
    const read = readOne(items, one);
    if (!read.ok) return read;
    out.push(read.value);
  }
  return { ok: true, value: out };
}

/**
 * What an authored `choose_option` (or a review's decision row) asks, as the renderer draws it.
 *
 * One question for the ordinary gate; several for a state that declared `questions` — each of which
 * is its own {@link Choice}, keyed by its `name`, and asked one at a time by the same stepper an
 * agent's batch of questions uses. `custom` on either becomes the same INSTEAD free text an agent's
 * "Other" is, because that is what it is: one more option, said in words.
 */
export function choicesOfConfig(config: ChooseOptionConfig | ReviewArtifactConfig): Choice[] {
  if (config.component === "choose_option" && config.questions !== undefined) {
    return config.questions.map((q) => {
      const choice: Choice = { question: q.question, name: q.name, options: q.options };
      if (q.header !== undefined) choice.header = q.header;
      if (q.description !== undefined) choice.description = q.description;
      if (q.multiple === true) choice.multiple = true;
      if (q.optional === true) choice.optional = true;
      if (q.default !== undefined) choice.default = q.default;
      if (q.custom === true) choice.freeText = q.schema === undefined ? OWN_ANSWER : { ...OWN_ANSWER, placeholder: placeholderFor(q.schema) };
      if (q.schema !== undefined) choice.schema = q.schema;
      return choice;
    });
  }
  const choice: Choice = { question: config.prompt, options: config.options };
  if (config.icon !== undefined) choice.icon = config.icon;
  if (config.component === "choose_option" && config.multiple === true) choice.multiple = true;
  if (config.component === "choose_option" && config.requireConfirm === true) choice.requireConfirm = true;
  if (config.component === "choose_option" && config.custom === true) choice.freeText = OWN_ANSWER;
  if (config.comments === true) {
    choice.freeText = {
      label: "Comments (optional)",
      role: "alongside",
      // Only the review: see {@link ChoiceFreeText.first}.
      ...(config.component === "review_artifact" ? { first: true } : {}),
    };
  }
  return [choice];
}

/**
 * The option a review WITH COMMENTS submits — the author's send-back word.
 *
 * A comment on a review means the round is not final: what was reviewed goes back to whoever made
 * it, with the words. That is the rule the plural derives from gestures (a commented change is a
 * `comment`, and any comment anywhere means nothing is applied). The singular has no per-artifact
 * layer to derive from and no status step after it — a gate's transitions read `decision` as the
 * author wrote it — so the decision itself has to carry the send-back. Submitting the affirmative
 * beside a comment routed a commented review as an approval (2026-09-08).
 *
 * The author's options are read in the order they were written: the first non-destructive one is
 * the affirmative (the same convention that draws it as the primary action), and the NEXT
 * non-destructive one is the send-back — `approve` / `revise` / `cut` names it `revise`. A
 * vocabulary with no second non-destructive option (`merged` / `reverted`) has no word for "go
 * back", so this returns `undefined` and the row of options stays for the person to choose from.
 */
export function sendBackOption(options: readonly ComponentOption[]): ComponentOption | undefined {
  const routable = options.filter((o) => o.tone !== "danger");
  return routable[1];
}

/** A field of a `fill_form` schema — the JSON-Schema subset DESIGN §7.1 allows. */
export interface FormField {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  label?: string;
  description?: string;
  enum?: string[];
  optional?: boolean;
  default?: JsonValue;
  /** `string` fields only: render a textarea. */
  multiline?: boolean;
  /**
   * `enum` fields only: the declared values are the common answers rather than the only ones — the
   * box suggests them and takes any other text — and the contract accepts any non-empty string on the
   * field.
   */
  custom?: boolean;
}

/**
 * A `fill_form`'s fields as the JSON Schema the app's one form renderer draws, and checks, them with.
 *
 * The conversion is the contract in {@link validateComponentResult}, restated in schema keywords so
 * the form refuses exactly what the gate would:
 *
 *  - a field that is not `optional` is `required`, and a required text answer is `minLength: 1`
 *    because the contract reads `""` as not answered;
 *  - `enum` is `enum`; with `custom` it is `examples` — suggested, not insisted on — plus the same
 *    non-empty rule;
 *  - `multiline` asks for room to write (`contentMediaType: "text/plain"`), and `label` is `title`.
 */
export function fillFormSchema(fields: readonly FormField[]): Record<string, JsonValue> {
  const properties: Record<string, JsonValue> = {};
  for (const field of fields) {
    const schema: Record<string, JsonValue> = {};
    switch (field.type) {
      case "number":
        schema["type"] = "number";
        break;
      case "boolean":
        schema["type"] = "boolean";
        break;
      case "enum":
        schema["type"] = "string";
        if (field.custom === true) schema["examples"] = [...(field.enum ?? [])];
        else schema["enum"] = [...(field.enum ?? [])];
        if (field.optional !== true) schema["minLength"] = 1;
        break;
      case "string":
      default:
        schema["type"] = "string";
        if (field.multiline === true) schema["contentMediaType"] = "text/plain";
        if (field.optional !== true) schema["minLength"] = 1;
        break;
    }
    if (field.label !== undefined) schema["title"] = field.label;
    if (field.description !== undefined) schema["description"] = field.description;
    if (field.default !== undefined) schema["default"] = field.default;
    properties[field.name] = schema;
  }
  return {
    type: "object",
    properties,
    required: fields.filter((field) => field.optional !== true).map((field) => field.name),
  };
}

/**
 * One part of a multi-part `choose_option` — a question of its own, with its own options.
 *
 * Each answers under its `name`, which is what makes the result a record rather than a decision:
 * `{ answers: { [name]: value } }`. The per-question knobs are the single question's knobs, moved
 * down a level, because there is no longer one question for them to be about.
 */
export interface ChoiceQuestion {
  /** The key the answer lands on. Unique within the state. */
  name: string;
  /** The question, as the person reads it. */
  question: string;
  header?: string;
  description?: string;
  /** The choices. Absent (empty) only with `custom`: the question is answered in the person's own words. */
  options: ComponentOption[];
  multiple?: boolean;
  /** Offer an "own answer" text box — any non-empty string is then accepted. */
  custom?: boolean;
  /** May be left unanswered; the key is then absent from `answers`. */
  optional?: boolean;
  /** Pre-picked when the question appears. Must be one of the options. */
  default?: string;
  /**
   * The answer is a VALUE of this JSON Schema rather than a word: the pick or own answer is read as
   * one ({@link readAnswer}) and must satisfy it — the control holds the step until it does, and main
   * checks it again with the run's validator. An option's `value` is then the value's words
   * ({@link answerText}), so an enum member `3` is offered as `"3"` and answers `3`.
   */
  schema?: JsonValue;
}

export interface ChooseOptionConfig {
  component: "choose_option";
  prompt: string;
  /** The choices. EMPTY when `questions` carries them instead — the two spellings are exclusive. */
  options: ComponentOption[];
  /** Offer a free-text comment alongside the choice. */
  comments?: boolean;
  /** Several options may be chosen; `decision` is then an array (decision 0002). */
  multiple?: boolean;
  /** Hold the pick until a confirm button is pressed — see {@link Choice.requireConfirm}. */
  requireConfirm?: boolean;
  /**
   * Offer an "own answer" box beside the options — the agent caller's "Other", on a gate.
   *
   * Exclusive with `comments`: there is one free-text field, and the two roles it can play are
   * opposites (see {@link ChoiceFreeText}). `decision` is then any non-empty string.
   */
  custom?: boolean;
  /**
   * Several questions in one gate, asked one at a time; the answer is `{ answers }` keyed by name.
   *
   * Present ⇒ `options` is empty and the single-question knobs (`comments`, `multiple`, `custom`,
   * `require_confirm`) are refused at the top level: each question carries its own.
   */
  questions?: ChoiceQuestion[];
  /**
   * The model may ask follow-up questions (`follow_up` when authored) — the STATE's decision.
   *
   * Only with `questions`. Each round of answers makes the host hold the call, ask a model what the
   * answers opened, and park this same gate again with those questions (runtime `followUp.ts`),
   * until the model has nothing to ask. The person is never asked whether to allow it and the
   * answer carries nothing about it; the state sees one `{ answers }` with every round's keys.
   */
  followUp?: boolean;
  /** A glyph beside the question. Absent ⇒ a message bubble. */
  icon?: string;
}

export interface ReviewArtifactConfig {
  component: "review_artifact";
  prompt: string;
  /** Which of the state's inputs holds the artifact to show. */
  artifact: string;
  /** Decision buttons, supplied by the state config (DESIGN §7.1). */
  options: ComponentOption[];
  comments?: boolean;
  /** A glyph beside the question. Absent ⇒ the component's own. */
  icon?: string;
  /**
   * Let the reviewer change the artifact, not only judge it.
   *
   * The edited text rides back as `content`. Not a duplicate of `edit_artifact`: "approve this, but
   * with that word fixed" is one gesture in a review and two round trips without it.
   */
  editable?: boolean;
}

export interface EditArtifactConfig {
  component: "edit_artifact";
  prompt: string;
  /** Input name whose content seeds the editor. */
  source?: string;
}

export interface FillFormConfig {
  component: "fill_form";
  prompt: string;
  fields: FormField[];
}

export interface ConfirmActionConfig {
  component: "confirm_action";
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
  /**
   * What EXACTLY is being confirmed, as label/value rows under the prompt.
   *
   * For an action whose consequences are not in its name. "Push this review to GitLab?" is a
   * question nobody can answer without knowing where to, as which branch, and under whose name —
   * and a sentence carrying five such facts is a sentence nobody reads.
   */
  details?: Array<{ label: string; value: string }>;
  /**
   * Other ways of saying YES, each a button between confirm and cancel — "always for this
   * project" beside "push and open". Choosing one answers `confirmed: true` with `choice` set to
   * its value; the confirm button itself leaves `choice` out.
   */
  options?: ComponentOption[];
}

/**
 * The changeset gate (CHANGESETS.md §4.1): takes a changeset, returns every change it was given,
 * each with a decision. Unlike the other components its result is validated against its INPUT — a
 * decision anchors to a change id, and the set must be complete — which is why
 * {@link validateComponentResult} takes the resolved inputs for this component alone.
 */
export interface ReviewArtifactsConfig {
  component: "review_artifacts";
  prompt: string;
  /**
   * What the tree currently holds — `proposal` for a worktree an agent already edited, `base` for a
   * sync whose edits exist only as data. Decides which decisions are no-ops when applied (§4.1's
   * files column), and how the UI phrases them.
   */
  tree: "base" | "proposal";
  /**
   * The REVIEW-LEVEL vocabulary, on the plural exactly as on the singular (decision 0002).
   *
   * Absent ⇒ one Submit, and the per-change decisions carry the whole answer. Present ⇒ the
   * reviewer also answers a routing question, which lands as `decision` beside `decisions` — the
   * `approve` / `revise` / `cut` shape the authored `review_artifact` states already use, where
   * `cut` is not a disposition on any file but a direction for the run.
   *
   * Deliberately NOT special-cased for changesets: `merged`/`reverted` is what a state that names
   * no options gets, and that is a default rather than a different component.
   */
  options?: ComponentOption[];
  /**
   * The gate's SECOND DOOR (decision 0004 §3): also open this review as a merge request, and let
   * whichever side settles first answer the state.
   *
   * An ordinary object parameter — its default comes from `environment.functions.review_artifacts
   * .args.remote`, its identity across loop rounds from a scoped name (NAMES.md). Absent or `null`
   * is the gate as it always was. Once the gate has parked, the same object also carries where the
   * request lives (`number`, `url`, …), which is what the remote strip draws.
   */
  remote?: ReviewRemote;
}

/** `review_artifacts.remote` — every field optional; see the table in decision 0004. */
export interface ReviewRemote {
  /** Which git remote to push to. Default: the project's only one. */
  to?: string;
  /** The branch the request asks to merge into. Default: the task's base branch. */
  target?: string;
  /** The quiet window after a comment, as a duration. Default: `functions.review_artifacts.settleAfter` (Settings → Tools). */
  settle_after?: string;
  draft?: boolean;
  title?: string;
  description?: string;
  workspace?: string;
  /** Where the request lives, once it does — filled in by the host when the gate parks. */
  provider?: string;
  host?: string;
  project?: string;
  branch?: string;
  number?: number;
  url?: string;
  id?: string;
  key?: string;
}

/**
 * The approval prompt, called as a function — `approve_tool_call(request)`.
 *
 * What it shows is its `request` INPUT (the same object a permission function is handed: the tool,
 * the subject, the part of a shell line with its arguments and working directory, the state and the
 * task), not anything authored here: the config is only the sentence over it. The person's answer is
 * `{ decision: "allow" | "deny" }`, and the function returns the word alone.
 */
export interface ApproveToolCallConfig {
  component: "approve_tool_call";
  prompt: string;
}

export type ComponentConfig =
  | ChooseOptionConfig
  | ReviewArtifactConfig
  | EditArtifactConfig
  | FillFormConfig
  | ConfirmActionConfig
  | ReviewArtifactsConfig
  | ApproveToolCallConfig;

// --- parsing the authored config ---------------------------------------------

class ConfigError extends Error {}

function asRecord(raw: unknown, where: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function str(raw: unknown, where: string, fallback?: string): string {
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${where} is required`);
  }
  if (typeof raw !== "string" || raw.length === 0) throw new ConfigError(`${where} must be a non-empty string`);
  return raw;
}

const REMOTE_TEXT = ["to", "target", "settle_after", "title", "description", "workspace", "provider", "host", "project", "branch", "url", "id", "key"] as const;

function reviewRemote(raw: unknown): ReviewRemote {
  const spec = asRecord(raw, "review_artifacts.remote");
  const out: ReviewRemote = {};
  for (const key of REMOTE_TEXT) {
    const held = spec[key];
    if (held === undefined) continue;
    if (typeof held !== "string" || held.length === 0) throw new ConfigError(`review_artifacts.remote.${key} must be a non-empty string`);
    out[key] = held;
  }
  if (out.settle_after !== undefined && parseDuration(out.settle_after) === undefined) {
    throw new ConfigError(`review_artifacts.remote.settle_after must be a duration like "10m", "2h" or "0"`);
  }
  if (spec["draft"] !== undefined) {
    if (typeof spec["draft"] !== "boolean") throw new ConfigError("review_artifacts.remote.draft must be true or false");
    out.draft = spec["draft"];
  }
  if (typeof spec["number"] === "number") out.number = spec["number"];
  // The engine's `$key` beside a scoped name's configuration: which request, per instance.
  if (out.key === undefined && typeof spec["$key"] === "string") out.key = spec["$key"];
  return out;
}

function confirmDetails(raw: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(raw)) throw new ConfigError("confirm_action.details must be an array of { label, value }");
  return raw.map((entry, i) => {
    const row = asRecord(entry, `confirm_action.details[${i}]`);
    return { label: str(row["label"], `confirm_action.details[${i}].label`), value: str(row["value"], `confirm_action.details[${i}].value`) };
  });
}

function options(raw: unknown, where: string): ComponentOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${where} must be a non-empty array of options`);
  }
  return raw.map((entry, i) => {
    if (typeof entry === "string") {
      if (entry.length === 0) throw new ConfigError(`${where}[${i}] must be a non-empty string`);
      return { value: entry };
    }
    const record = asRecord(entry, `${where}[${i}]`);
    const option: ComponentOption = { value: str(record["value"], `${where}[${i}].value`) };
    if (record["label"] !== undefined) option.label = str(record["label"], `${where}[${i}].label`);
    if (record["description"] !== undefined) {
      option.description = str(record["description"], `${where}[${i}].description`);
    }
    if (record["icon"] !== undefined) option.icon = str(record["icon"], `${where}[${i}].icon`);
    if (record["tone"] !== undefined) {
      const tone = record["tone"];
      if (tone !== "default" && tone !== "danger") {
        throw new ConfigError(`${where}[${i}].tone must be "default" or "danger"`);
      }
      option.tone = tone;
    }
    return option;
  });
}

const FIELD_TYPES = new Set(["string", "number", "boolean", "enum"]);

function fields(raw: unknown, where: string): FormField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${where} must be a non-empty array of fields`);
  }
  return raw.map((entry, i) => {
    const record = asRecord(entry, `${where}[${i}]`);
    const name = str(record["name"], `${where}[${i}].name`);
    const type = record["type"] ?? "string";
    if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
      throw new ConfigError(`${where}[${i}].type must be one of string, number, boolean, enum`);
    }
    const field: FormField = { name, type: type as FormField["type"] };
    if (record["label"] !== undefined) field.label = str(record["label"], `${where}[${i}].label`);
    if (record["description"] !== undefined) {
      field.description = str(record["description"], `${where}[${i}].description`);
    }
    if (field.type === "enum") {
      const values = record["enum"];
      if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string")) {
        throw new ConfigError(`${where}[${i}].enum must be a non-empty array of strings`);
      }
      field.enum = values as string[];
    }
    if (record["optional"] === true) field.optional = true;
    if (record["default"] !== undefined) field.default = record["default"] as JsonValue;
    if (record["multiline"] === true) field.multiline = true;
    if (record["custom"] === true) {
      // A text box under a text box is not a "custom" anything: the escape hatch only means
      // something where the declared values would otherwise be the only answers.
      if (field.type !== "enum") throw new ConfigError(`${where}[${i}].custom is only meaningful on an enum field`);
      field.custom = true;
    }
    return field;
  });
}

/** The parts of a multi-part `choose_option` — see {@link ChoiceQuestion}. */
function questions(raw: unknown, where: string): ChoiceQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${where} must be a non-empty array of questions`);
  }
  const names = new Set<string>();
  return raw.map((entry, i) => {
    const record = asRecord(entry, `${where}[${i}]`);
    const name = str(record["name"], `${where}[${i}].name`);
    if (names.has(name)) throw new ConfigError(`${where}[${i}].name '${name}' is used twice — answers are keyed by it`);
    names.add(name);
    // A question answered only in the person's own words has nothing to offer but the box.
    const ownOnly = record["options"] === undefined && record["custom"] === true;
    const question: ChoiceQuestion = {
      name,
      question: str(record["question"], `${where}[${i}].question`),
      options: ownOnly ? [] : options(record["options"], `${where}[${i}].options`),
    };
    if (record["schema"] !== undefined) {
      const schema = record["schema"];
      if (typeof schema !== "boolean" && (schema === null || typeof schema !== "object" || Array.isArray(schema))) {
        throw new ConfigError(`${where}[${i}].schema must be a JSON Schema (an object or a boolean)`);
      }
      question.schema = schema as JsonValue;
    }
    if (record["header"] !== undefined) question.header = str(record["header"], `${where}[${i}].header`);
    if (record["description"] !== undefined) {
      question.description = str(record["description"], `${where}[${i}].description`);
    }
    if (record["multiple"] === true) question.multiple = true;
    if (record["custom"] === true) question.custom = true;
    if (record["optional"] === true) question.optional = true;
    if (record["default"] !== undefined) {
      const preset = str(record["default"], `${where}[${i}].default`);
      // A default that is not on offer would pre-pick nothing and pass validation for no reason.
      if (!question.options.some((o) => o.value === preset)) {
        throw new ConfigError(`${where}[${i}].default '${preset}' is not one of its options`);
      }
      question.default = preset;
    }
    return question;
  });
}

/**
 * Normalize a component's authored config. `raw` is the op's `config` input.
 * Throws with a path-shaped message on anything malformed.
 */
export function parseComponentConfig(component: ComponentName, raw: unknown): ComponentConfig {
  const config = raw === undefined ? {} : asRecord(raw, `${component} config`);
  const prompt = str(config["prompt"], `${component}.prompt`, defaultPrompt(component));
  switch (component) {
    case "choose_option": {
      if (config["questions"] !== undefined) {
        // The multi-part spelling. The single question's knobs have nothing to be about here, so
        // they are refused rather than silently ignored — an author who wrote `comments: true`
        // beside `questions` expected a box somewhere, and no box is the wrong way to say no.
        if (config["options"] !== undefined) {
          throw new ConfigError("choose_option takes options or questions, not both");
        }
        for (const knob of ["comments", "multiple", "custom", "require_confirm"]) {
          if (config[knob] !== undefined) {
            throw new ConfigError(`choose_option.${knob} is per question when questions is set`);
          }
        }
        const parsed: ChooseOptionConfig = {
          component,
          prompt,
          options: [],
          questions: questions(config["questions"], "choose_option.questions"),
        };
        if (config["follow_up"] === true) parsed.followUp = true;
        if (config["icon"] !== undefined) parsed.icon = str(config["icon"], "choose_option.icon");
        return parsed;
      }
      if (config["follow_up"] !== undefined) {
        throw new ConfigError("choose_option.follow_up needs questions: a single decision has no turn to ask more");
      }
      const parsed: ChooseOptionConfig = {
        component,
        prompt,
        options: options(config["options"], "choose_option.options"),
      };
      if (config["comments"] === true) parsed.comments = true;
      if (config["multiple"] === true) parsed.multiple = true;
      if (config["require_confirm"] === true) parsed.requireConfirm = true;
      if (config["custom"] === true) {
        // One free-text field, and the two roles it can play are opposites (see `ChoiceFreeText`).
        if (parsed.comments === true) throw new ConfigError("choose_option.custom and comments are exclusive — one free-text field");
        parsed.custom = true;
      }
      if (config["icon"] !== undefined) parsed.icon = str(config["icon"], "choose_option.icon");
      return parsed;
    }
    case "review_artifact": {
      const parsed: ReviewArtifactConfig = {
        component,
        prompt,
        artifact: str(config["artifact"], "review_artifact.artifact", "artifact"),
        // Decisions are the state's to name; `decisions` is accepted as an alias
        // because it reads better in a review state.
        options: options(config["options"] ?? config["decisions"], "review_artifact.options"),
      };
      if (config["comments"] === true) parsed.comments = true;
      if (config["icon"] !== undefined) parsed.icon = str(config["icon"], "review_artifact.icon");
      if (config["editable"] === true) parsed.editable = true;
      return parsed;
    }
    case "edit_artifact": {
      const parsed: EditArtifactConfig = { component, prompt };
      if (config["source"] !== undefined) parsed.source = str(config["source"], "edit_artifact.source");
      return parsed;
    }
    case "fill_form":
      return { component, prompt, fields: fields(config["fields"], "fill_form.fields") };
    case "confirm_action":
      return {
        component,
        prompt,
        confirmLabel: str(config["confirmLabel"], "confirm_action.confirmLabel", "Confirm"),
        cancelLabel: str(config["cancelLabel"], "confirm_action.cancelLabel", "Cancel"),
        ...(config["details"] !== undefined ? { details: confirmDetails(config["details"]) } : {}),
        ...(config["options"] !== undefined ? { options: options(config["options"], "confirm_action.options") } : {}),
      };
    case "review_artifacts": {
      const tree = config["tree"] ?? "proposal";
      if (tree !== "base" && tree !== "proposal") {
        throw new ConfigError(`review_artifacts.tree must be "base" or "proposal"`);
      }
      const parsed: ReviewArtifactsConfig = { component, prompt, tree };
      // `decisions` is the same alias `review_artifact` takes — it reads better in a review state,
      // and a reviewer should not have to remember which of the two spells it which way.
      const named = config["options"] ?? config["decisions"];
      if (named !== undefined) parsed.options = options(named, "review_artifacts.options");
      // `null` is how a state opts OUT of a remote its environment would otherwise give it.
      if (config["remote"] !== undefined && config["remote"] !== null) parsed.remote = reviewRemote(config["remote"]);
      return parsed;
    }
    case "approve_tool_call":
      return { component, prompt };
  }
}

function defaultPrompt(component: ComponentName): string {
  switch (component) {
    case "choose_option":
      return "Choose an option";
    case "review_artifact":
      return "Review";
    case "edit_artifact":
      return "Edit";
    case "fill_form":
      return "Fill in the form";
    case "confirm_action":
      return "Confirm this action";
    case "review_artifacts":
      return "Review the proposed changes";
    case "approve_tool_call":
      return "Allow this tool call?";
  }
}

// --- validating a submitted result -------------------------------------------

export type ResultCheck = { ok: true } | { ok: false; errors: string };

const bad = (errors: string): ResultCheck => ({ ok: false, errors });

/**
 * Check a submitted answer against its component contract. Called in the main
 * process, so a renderer bug — or anything else reaching the IPC channel — cannot
 * push an out-of-contract value (an undeclared decision, a missing field) into a
 * workflow's outputs.
 *
 * `inputs` is consulted by `review_artifacts` alone: its contract is not a fixed shape but
 * "every change you were shown, decided" — which only the changeset the state resolved can judge.
 * Without inputs the check degrades to shape-only, which a caller that has them should not accept.
 */
/**
 * Which of a state's inputs IS the changeset — decided by SHAPE, never by a configured name.
 *
 * The name approach is what this replaced, and it could not work: a component's config is parsed
 * from `operation.args`, and a function receives those args merged with the state's resolved inputs
 * into one namespace — so a field naming an input collided with the input it named. Authoring
 * `changeset: "changeset"` to point at the changeset slot overwrote the changeset with the string
 * `"changeset"`, which cost CHANGESETS.md §5.3's pin and made every decision validate against a
 * word. Two different patches to that collision were tried before the answer turned out to be that
 * the question was wrong.
 *
 * A changeset is recognisable: {@link changesetOf} demands a resolvable `source` and a `changes`
 * array whose every entry carries a unique id, a path and a known action. A prompt, a tree name or
 * a plan document does not accidentally satisfy that, so the input that parses IS the one — and a
 * state is free to call its slot whatever it likes.
 *
 * Two of them parsing is refused rather than resolved by picking: a review that silently judged the
 * wrong changeset is the failure this whole path exists to prevent.
 */
export function changesetInputOf(inputs: Record<string, unknown>): { changeset?: Changeset; error?: string } {
  const found: Array<{ name: string; changeset: Changeset }> = [];
  let lastError: string | undefined;
  for (const [name, value] of Object.entries(inputs)) {
    // Only an object can be one, and asking `changesetOf` about a string produces a message about
    // the string rather than about the input that was actually missing.
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    try {
      found.push({ name, changeset: changesetOf(value) });
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  if (found.length === 1) return { changeset: found[0]!.changeset };
  if (found.length > 1) {
    return { error: `several inputs hold a changeset (${found.map((f) => f.name).join(", ")}) — one state, one review` };
  }
  return { error: `no input holds a changeset${lastError === undefined ? "" : `: ${lastError}`}` };
}

/**
 * One pick against the options that offered it — the check a `decision` and every multi-part
 * answer share. Returns the complaint, or `undefined` for a pick the state could have produced.
 *
 * A multi-select answers with a LIST, and the list is checked the same way one value is: every
 * member declared, nothing repeated, and not empty — "none of these" is a decision the state did
 * not offer, and an empty array is how it would arrive by accident. `custom` widens "declared" to
 * "any non-empty string", which is exactly what a text box beside the options can produce.
 */
function checkPick(
  at: string,
  value: unknown,
  options: readonly ComponentOption[],
  rules: { multiple?: boolean | undefined; custom?: boolean | undefined },
): string | undefined {
  const named = options.map((o) => o.value);
  const allowed = (one: unknown): one is string =>
    typeof one === "string" && (named.includes(one) || (rules.custom === true && one.trim().length > 0));
  const complaint = (one: unknown): string =>
    rules.custom === true
      ? `${at} '${String(one)}' must be one of: ${named.join(", ")} — or a non-empty answer of your own`
      : `${at} '${String(one)}' is not one of: ${named.join(", ")}`;
  if (rules.multiple === true) {
    if (!Array.isArray(value)) return `${at} must be an array on a multi-select`;
    if (value.length === 0) return `${at} must name at least one option`;
    const seen = new Set<string>();
    for (const one of value) {
      if (!allowed(one)) return complaint(one);
      if (seen.has(one)) return `${at} names '${one}' twice`;
      seen.add(one);
    }
    return undefined;
  }
  if (typeof value !== "string") return `${at} must be a string`;
  return allowed(value) ? undefined : complaint(value);
}

export function validateComponentResult(
  config: ComponentConfig,
  value: unknown,
  inputs?: Record<string, unknown>,
): ResultCheck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return bad(`${config.component} result must be an object`);
  }
  const result = value as Record<string, unknown>;
  switch (config.component) {
    case "review_artifacts": {
      // The review-level pair, checked the same way `review_artifact`'s is — and only against a
      // vocabulary the state actually named, so a config with no `options` refuses a decision
      // rather than accepting an arbitrary word.
      const level = result["decision"];
      if (level !== undefined) {
        if (config.options === undefined) {
          return bad("result.decision is set, but this state names no options for the review to answer");
        }
        if (typeof level !== "string" || !config.options.some((o) => o.value === level)) {
          return bad(`result.decision '${String(level)}' is not one of: ${config.options.map((o) => o.value).join(", ")}`);
        }
      } else if (config.options !== undefined) {
        return bad(`result.decision is required: this state offers ${config.options.map((o) => o.value).join(", ")}`);
      }
      if (result["comments"] !== undefined && typeof result["comments"] !== "string") {
        return bad("result.comments must be a string when present");
      }
      if (inputs !== undefined) {
        const found = changesetInputOf(inputs);
        if (found.changeset === undefined) return bad(found.error ?? "no input holds a changeset");
        const checked = checkDecisions(found.changeset, value);
        return checked.ok ? { ok: true } : bad(checked.errors);
      }
      // Shape-only, for a caller with no inputs in hand.
      const raw = result["decisions"];
      if (!Array.isArray(raw)) return bad("result.decisions must be an array");
      for (let i = 0; i < raw.length; i++) {
        const row = raw[i] as Record<string, unknown> | null;
        if (row === null || typeof row !== "object") return bad(`decisions[${i}] must be an object`);
        if (typeof row["id"] !== "string") return bad(`decisions[${i}].id must be a string`);
        if (typeof row["decision"] !== "string" || !(DECISION_KINDS as readonly string[]).includes(row["decision"])) {
          return bad(`decisions[${i}].decision must be one of: ${DECISION_KINDS.join(", ")}`);
        }
      }
      return { ok: true };
    }
    case "choose_option":
    case "review_artifact": {
      if (config.component === "choose_option" && config.questions !== undefined) {
        // The multi-part shape: `{ answers }`, one key per question, each checked the way a single
        // decision is. A key naming no question is refused — nothing on screen could have made it.
        const answers = result["answers"];
        if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
          return bad("result.answers must be an object keyed by question name");
        }
        const record = answers as Record<string, unknown>;
        const known = new Set(config.questions.map((q) => q.name));
        for (const key of Object.keys(record)) {
          if (!known.has(key)) return bad(`result.answers.${key} names no question of this state`);
        }
        for (const question of config.questions) {
          const value = record[question.name];
          if (value === undefined || value === null || value === "") {
            if (question.optional === true) continue;
            return bad(`result.answers.${question.name} is required`);
          }
          if (question.schema !== undefined) {
            // A typed answer: a pick is one of the options by its words, and an own answer is any
            // value — whether it fits the schema is the run's validator's to say, which main asks.
            if (question.custom === true) continue;
            const words = question.multiple === true && Array.isArray(value) ? value.map((one) => answerText(one as JsonValue)) : answerText(value as JsonValue);
            const picked = checkPick(`result.answers.${question.name}`, words, question.options, { multiple: question.multiple });
            if (picked !== undefined) return bad(picked);
            continue;
          }
          const checked = checkPick(`result.answers.${question.name}`, value, question.options, question);
          if (checked !== undefined) return bad(checked);
        }
        return { ok: true };
      }
      const decision = result["decision"];
      const single = config.component === "choose_option" ? config : { multiple: false, custom: false };
      const checked = checkPick("result.decision", decision, config.options, single);
      if (checked !== undefined) return bad(checked);
      if (result["comments"] !== undefined && typeof result["comments"] !== "string") {
        return bad("result.comments must be a string when present");
      }
      // The reviewer's own edit, and only from a state that offered it: a `content` on a read-only
      // review is a value nothing on screen could have produced.
      if (result["content"] !== undefined) {
        if (config.component !== "review_artifact" || config.editable !== true) {
          return bad("result.content is set, but this state's artifact is not editable");
        }
        if (typeof result["content"] !== "string") return bad("result.content must be a string");
      }
      // Anchored notes ride alongside the review-level comment rather than replacing it: one is
      // about a passage, the other about the whole thing, and a reviewer routinely has both.
      // `choose_option` is in this branch for its decision only — it shows no artifact, so it has
      // nothing to anchor to, and a note on it is refused rather than silently carried.
      if (config.component === "choose_option") {
        if (result["notes"] !== undefined) return bad("choose_option shows no artifact, so it takes no notes");
        return { ok: true };
      }
      const notes = checkNotes(result["notes"]);
      return notes.ok ? { ok: true } : bad(notes.errors);
    }
    case "edit_artifact":
      return typeof result["content"] === "string" ? { ok: true } : bad("result.content must be a string");
    case "approve_tool_call":
      // The two answers an approval has. What it remembers, if anything, is the calling function's
      // business — the prompt itself answers this call and no other.
      return result["decision"] === "allow" || result["decision"] === "deny" ? { ok: true } : bad("result.decision must be allow or deny");
    case "confirm_action": {
      if (typeof result["confirmed"] !== "boolean") return bad("result.confirmed must be a boolean");
      const choice = result["choice"];
      if (choice === undefined) return { ok: true };
      // A choice is another way of saying yes, so it cannot ride a no — and it has to be one offered.
      if (result["confirmed"] !== true) return bad("result.choice is a way of confirming, so it needs confirmed: true");
      return (config.options ?? []).some((option) => option.value === choice) ? { ok: true } : bad(`result.choice '${String(choice)}' is not one of the options offered`);
    }
    case "fill_form": {
      const problems: string[] = [];
      for (const field of config.fields) {
        const present = Object.prototype.hasOwnProperty.call(result, field.name);
        const raw = result[field.name];
        if (!present || raw === undefined || raw === null || raw === "") {
          if (!field.optional) problems.push(`result.${field.name} is required`);
          continue;
        }
        switch (field.type) {
          case "string":
            if (typeof raw !== "string") problems.push(`result.${field.name} must be a string`);
            break;
          case "number":
            if (typeof raw !== "number" || Number.isNaN(raw)) problems.push(`result.${field.name} must be a number`);
            break;
          case "boolean":
            if (typeof raw !== "boolean") problems.push(`result.${field.name} must be a boolean`);
            break;
          case "enum":
            // `custom` widens the field to any non-empty string — the typed answer is the answer.
            // (An empty one already read as "not answered" above.)
            if (typeof raw !== "string") {
              problems.push(`result.${field.name} must be a string`);
            } else if (field.custom !== true && !(field.enum ?? []).includes(raw)) {
              problems.push(`result.${field.name} must be one of: ${(field.enum ?? []).join(", ")}`);
            }
            break;
        }
      }
      return problems.length === 0 ? { ok: true } : bad(problems.join("; "));
    }
  }
}

// --- artifact display --------------------------------------------------------

/**
 * Text to display for an input value. An artifact-typed input arrives as an
 * `{ artifact: true, content }` record for llm-backed states, but may also be a
 * plain string (or a path, once process units exist) — so a component renders
 * whatever it can rather than assuming one shape.
 */
export function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["content"] === "string") return record["content"];
    if (typeof record["path"] === "string") return String(record["path"]);
  }
  return JSON.stringify(value, null, 2);
}

// --- lint: does the state pass the component what it needs? ------------------

/**
 * What an input-supplied config key stands in as, so the rest of the config still parses.
 *
 * Only the keys whose shape is not a plain string need an entry; a non-empty string satisfies every
 * other one, and `str` refuses an empty one. None of these values is ever shown or used — they exist
 * so a missing key does not mask the authoring mistakes that ARE in the file.
 */
const CONFIG_KEY_PLACEHOLDERS: Record<string, unknown> = {
  options: ["supplied-by-an-input"],
  decisions: ["supplied-by-an-input"],
  fields: [{ name: "supplied-by-an-input" }],
  // The multi-part gate's questions are the case that made this table necessary in the first
  // place: a state whose `questions` are what an earlier state raised cannot author them.
  questions: [{ name: "supplied-by-an-input", question: "supplied-by-an-input", options: ["supplied-by-an-input"] }],
  tree: "proposal",
  comments: true,
  multiple: false,
  require_confirm: false,
  custom: false,
  editable: false,
};

/** One thing wrong with a component operation's authored state. */
export interface ComponentConfigIssue {
  stateId: string;
  /**
   * Where in the state file — `operation.args` (what `config` is authored as) for a config the
   * component cannot read, `outputs` for a result field the state would drop.
   */
  path: string;
  message: string;
  /** Absent ⇒ error: the component cannot show. A warning is a gate that shows but loses something. */
  severity?: "warning";
}

/**
 * Check every state that calls a built-in component against that component's contract.
 *
 * The engine already asks "does this operation pass what its function expects?" — but only where the
 * registered function declares a `signature`, and JaiRA registers its components without one
 * (`InteractionHub.register`). It cannot usefully declare one either: the contract is not a fixed
 * parameter list but a shape inside `config`, which is exactly what {@link parseComponentConfig}
 * already knows how to read.
 *
 * So the check is made HERE, from the same function the renderer and the main process both use to
 * interpret a component's config. That is the property worth having: a state whose `choose_option`
 * declares no options is reported by the linter using the same words the dialog would have failed
 * with, rather than running and producing an empty gate nobody can answer.
 *
 * Read off the AUTHORED document rather than the loaded bundle. `args` is what an author writes and
 * what they will fix, and a message about `operation.args` should name the thing in the file.
 *
 * One thing `args` alone cannot tell us: a function receives its args MERGED WITH the state's
 * resolved inputs into one namespace (see {@link changesetInputOf}), and main parses the component's
 * config off that merge rather than off `args`. So a config key can legitimately arrive from an
 * input — a `fill_form` whose `fields` are the questions an earlier state produced is the case that
 * found this, and it cannot be authored any other way, because the questions are not known until the
 * run makes them. Judging such a state from `args` alone reports a missing key against a state that
 * supplies it. An input of the same name is therefore treated as satisfying the key, and what it
 * actually resolves to is checked where it can be: at run time, by the same parse, before the dialog
 * is shown.
 */
export function componentConfigIssues(states: Record<string, unknown>): ComponentConfigIssue[] {
  const issues: ComponentConfigIssue[] = [];
  for (const [stateId, def] of Object.entries(states)) {
    if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
    const operation = (def as { operation?: unknown }).operation;
    if (operation === null || typeof operation !== "object" || Array.isArray(operation)) continue;
    const op = operation as { kind?: unknown; function?: unknown; functionRef?: unknown; args?: unknown };
    // A transcluded or inherited operation is not this file's to judge: the block it resolves to may
    // supply the args, and reporting the state that mounts it would name the wrong file.
    if (op.kind !== "function") continue;
    const name = typeof op.function === "string" ? op.function : typeof op.functionRef === "string" ? op.functionRef : undefined;
    if (name === undefined || !isComponentName(name)) continue;
    // A referenced `args` block resolves to something this pass cannot see. Judging it from here
    // would report a missing option against a file that never claimed to declare one.
    if (op.args !== undefined && (typeof op.args !== "object" || op.args === null || Array.isArray(op.args))) continue;
    // Stand in for the keys the state declares as inputs: at run time the merge supplies them, so
    // their absence from `args` is not a defect. A placeholder that PARSES is what is wanted here —
    // the point is to get past "this key is missing" and still check everything the author did write.
    const declared = (def as { inputs?: unknown }).inputs;
    const fromInputs: Record<string, unknown> = {};
    if (declared !== null && typeof declared === "object" && !Array.isArray(declared)) {
      for (const key of Object.keys(declared)) {
        if (op.args !== undefined && Object.prototype.hasOwnProperty.call(op.args, key)) continue;
        fromInputs[key] = CONFIG_KEY_PLACEHOLDERS[key] ?? "supplied-by-an-input";
      }
    }
    try {
      parseComponentConfig(name, { ...fromInputs, ...(op.args as Record<string, unknown> | undefined) });
    } catch (e) {
      issues.push({ stateId, path: "operation.args", message: (e as Error).message });
      continue;
    }
    // The engine resolves a state's DECLARED outputs and nothing else, so a result field the state
    // does not name is dropped without a word. `review_artifact` returns anchored `notes` beside
    // `comments`, and a state declaring only the latter loses every comment a reviewer pinned to a
    // passage — which read, the first time, as a send-back that said nothing. A warning rather than
    // an error: the gate shows and answers, it just forgets.
    if (name === "review_artifact") {
      const outputs = (def as { outputs?: unknown }).outputs;
      const declaresNotes =
        outputs !== null && typeof outputs === "object" && !Array.isArray(outputs) && Object.prototype.hasOwnProperty.call(outputs, "notes");
      if (!declaresNotes) {
        issues.push({
          stateId,
          path: "outputs",
          message: "review_artifact returns anchored `notes` beside `comments`; declare a `notes` output or comments pinned to a passage are dropped",
          severity: "warning",
        });
      }
    }
  }
  return issues;
}
