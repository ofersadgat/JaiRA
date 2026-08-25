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

export const COMPONENT_NAMES = [
  "choose_option",
  "review_artifact",
  "edit_artifact",
  "fill_form",
  "confirm_action",
  // N artifacts, each decided — the changeset gate is its N-artifact case (CHANGESETS.md §4.1,
  // decision 0002). Its implementation is still changeset-shaped; the generalization is staged.
  "review_artifacts",
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
  /** A short chip beside it, e.g. `Library`. */
  header?: string;
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
}

/** The one question an authored `choose_option` state asks. */
export function choicesOfConfig(config: ChooseOptionConfig | ReviewArtifactConfig): Choice[] {
  const choice: Choice = { question: config.prompt, options: config.options };
  if (config.icon !== undefined) choice.icon = config.icon;
  if (config.component === "choose_option" && config.multiple === true) choice.multiple = true;
  if (config.component === "choose_option" && config.requireConfirm === true) choice.requireConfirm = true;
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
}

export interface ChooseOptionConfig {
  component: "choose_option";
  prompt: string;
  options: ComponentOption[];
  /** Offer a free-text comment alongside the choice. */
  comments?: boolean;
  /** Several options may be chosen; `decision` is then an array (decision 0002). */
  multiple?: boolean;
  /** Hold the pick until a confirm button is pressed — see {@link Choice.requireConfirm}. */
  requireConfirm?: boolean;
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
}

export type ComponentConfig =
  | ChooseOptionConfig
  | ReviewArtifactConfig
  | EditArtifactConfig
  | FillFormConfig
  | ConfirmActionConfig
  | ReviewArtifactsConfig;

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
    return field;
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
      const parsed: ChooseOptionConfig = {
        component,
        prompt,
        options: options(config["options"], "choose_option.options"),
      };
      if (config["comments"] === true) parsed.comments = true;
      if (config["multiple"] === true) parsed.multiple = true;
      if (config["require_confirm"] === true) parsed.requireConfirm = true;
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
      return parsed;
    }
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
      const named = config.options.map((o) => o.value);
      const decision = result["decision"];
      // A multi-select answers with a LIST, and the list is checked the same way one value is:
      // every member declared, nothing repeated, and not empty — "none of these" is a decision the
      // state did not offer, and an empty array is how it would arrive by accident.
      if (config.component === "choose_option" && config.multiple === true) {
        if (!Array.isArray(decision)) return bad("result.decision must be an array on a multi-select");
        if (decision.length === 0) return bad("result.decision must name at least one option");
        const seen = new Set<string>();
        for (const value of decision) {
          if (typeof value !== "string" || !named.includes(value)) {
            return bad(`result.decision '${String(value)}' is not one of: ${named.join(", ")}`);
          }
          if (seen.has(value)) return bad(`result.decision names '${value}' twice`);
          seen.add(value);
        }
      } else {
        if (typeof decision !== "string") return bad("result.decision must be a string");
        if (!named.includes(decision)) {
          return bad(`result.decision '${decision}' is not one of: ${named.join(", ")}`);
        }
      }
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
    case "confirm_action":
      return typeof result["confirmed"] === "boolean" ? { ok: true } : bad("result.confirmed must be a boolean");
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
            if (typeof raw !== "string" || !(field.enum ?? []).includes(raw)) {
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

/** One thing wrong with a component operation's authored `args`. */
export interface ComponentConfigIssue {
  stateId: string;
  /** Where in the state file — always `operation.args`, which is what `config` is authored as. */
  path: string;
  message: string;
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
    try {
      parseComponentConfig(name, op.args);
    } catch (e) {
      issues.push({ stateId, path: "operation.args", message: (e as Error).message });
    }
  }
  return issues;
}
