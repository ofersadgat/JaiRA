/**
 * Starting a run from the file you are looking at — everything about it that is not React.
 *
 * The Files view could open, lint and edit a state without ever offering to run one, so the loop
 * "change it, try it, read what happened" went through the Tasks view and a state id typed from
 * memory. This module is the half of closing that loop which can be tested: what a state declares it
 * needs, what the form holds, what that becomes as `task:create` inputs, and why a run is refused.
 *
 * Three rules shape the whole thing.
 *
 * **The saved file is what runs.** Fields are read from `doc.text`, never from a draft. A run pins a
 * snapshot of what is on disk (DESIGN §5.3), so a form built from unsaved typing would be a form
 * describing inputs the run will not have. The panel says so when the two differ rather than quietly
 * offering the wrong boxes.
 *
 * **The form is the schema form.** A state's inputs become one object schema — a member per slot —
 * drawn by `SchemaForm`, the same renderer Settings and a `fill_form` gate use. The form holds JSON
 * VALUES, not text: `significant` in an enum slot is the string, `0.8` in a number slot is the number,
 * and nothing here parses a box. That is what this module used to do, and it drew a JSON box for any
 * schema richer than a bare type and then refused `significant` for not being valid JSON.
 *
 * **Not set is an answer.** A slot that is optional, or has a default, starts NOT SET — the switch
 * before its name is off, and the run gets the default. A required slot has no switch and starts
 * with a value of the right shape, which for text is `""`: whether that may be empty is the slot's
 * `minLength` to say, and the run checks it, not this module.
 */
import { parse as parseYaml } from "yaml";
import type { JsonValue } from "@declarative-ai/json";
import {
  SHARED_SESSION,
  WORKFLOW_JSON,
  WORKFLOW_YAML,
  type BoardCard,
  type SessionRef,
  type StateView,
  type TaskSummary,
  type WorkflowEntry,
  type WorkflowLayer,
} from "@jaira/shared/browser";
import { checkBlocker, seedFor, type FieldError, type FormCheck } from "./schemaForm/model";
import type { CheckItem } from "./schemaForm/check";
import type { Schema } from "./schemaForm/types";
import { slotRowOf } from "./slotForm";

// --- what the state asks for -------------------------------------------------

/** One declared input, as a member of the run form. */
export interface RunField {
  name: string;
  /**
   * The schema the form DRAWS the slot with: the declared schema, with the slot's `description` and
   * `default` folded in so the member can say them. `{}` for a slot with no schema — it takes anything.
   */
  schema: Schema;
  /**
   * The schema the value is CHECKED against — exactly what the slot declares, nothing folded in, so
   * the verdict is the run's. Absent when the slot names a linked type the loader expands and this
   * module cannot: that value is checked when the run starts.
   */
  declared?: Schema;
  /** SPEC §4.1: a slot is required unless it says `optional` or carries a `default`. */
  required: boolean;
  description: string;
  /** The declared default, when there is one. */
  default?: JsonValue;
  /**
   * The slot binds itself, so nothing is asked for it.
   *
   * Unusual on a state's own `inputs` — wiring normally lives on the PARENT, as
   * `children.<key>.inputs` — but legal, and a box beside a binding would be a box whose value the
   * engine discards. Shown read-only instead, which at least says where the value comes from.
   */
  binding?: string;
  /**
   * A `name*` spread (§3.5): N slots republished from a child, not one slot.
   *
   * There is no single value to type, so it is listed and not filled.
   */
  spread?: boolean;
  /** The slot's schema is a LINK to a named type (`"schema": "$/types/plan"`). */
  typeRef?: string;
}

/** What the form holds: a value per slot that is set. An absent key is a slot left NOT SET. */
export type RunValues = Record<string, JsonValue>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function fieldOf(name: string, raw: unknown): RunField {
  const row = slotRowOf(name, raw);
  const decl = isRecord(raw) ? raw : {};
  const fallback = decl["default"] as JsonValue | undefined;
  let schema: Schema;
  let declared: Schema | undefined;
  if (row.typeRef !== undefined) {
    // A linked type is expanded by the loader, and the renderer does not have it. The form still says
    // what it is, and the value still reaches the run — which checks it against the real thing.
    schema = row.type?.list === true ? { type: "array" } : {};
    declared = undefined;
  } else {
    declared = isRecord(decl["schema"]) ? (decl["schema"] as Schema) : {};
    schema = { ...declared };
  }
  const description =
    row.typeRef !== undefined
      ? [row.description, `a ${row.typeRef} — checked when the run starts`].filter((s) => s.length > 0).join(" · ")
      : row.description;
  if (description.length > 0 && typeof schema["description"] !== "string") schema["description"] = description;
  if (fallback !== undefined) schema["default"] = fallback;
  return {
    name,
    schema,
    ...(declared !== undefined ? { declared } : {}),
    // A `default` satisfies the slot as surely as `optional` does: the run applies it to a slot that
    // was not set.
    required: !row.optional && fallback === undefined,
    description: row.description,
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(row.binding.length > 0 || row.structured === true ? { binding: row.binding } : {}),
    ...(row.spread === true ? { spread: true } : {}),
    ...(row.typeRef !== undefined ? { typeRef: row.typeRef } : {}),
  };
}

/** Parse a state document by the type the tree gave it. `null` when it does not parse. */
function parseState(text: string, mime: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = mime === WORKFLOW_YAML ? parseYaml(text) : JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The slots a state's `inputs` declares, in declaration order.
 *
 * `null` means the document does not parse — genuinely different from a state with no inputs, and
 * the panel says so rather than showing an empty form under a Run button that would fail.
 */
export function runFieldsOf(text: string, mime: string): RunField[] | null {
  const doc = parseState(text, mime);
  if (doc === null) return null;
  return Object.entries(isRecord(doc["inputs"]) ? doc["inputs"] : {}).map(([name, raw]) => fieldOf(name, raw));
}

/** True when a field takes a value from the person running it. */
export function isFilled(field: RunField): boolean {
  return field.binding === undefined && field.spread !== true;
}

/**
 * The run form as ONE object schema: a member per slot a person fills in.
 *
 * `required` lists the slots with no switch. Everything else is optional in the form's sense — it may
 * be left not set — which for a slot with a default means "the run uses the default".
 */
export function runSchemaOf(fields: readonly RunField[]): Schema {
  const filled = fields.filter(isFilled);
  return {
    type: "object",
    properties: Object.fromEntries(filled.map((field) => [field.name, field.schema])),
    required: filled.filter((field) => field.required).map((field) => field.name),
  };
}

/** What the form opens holding: every required slot at a value of its shape, everything else not set. */
export function initialRunValues(fields: readonly RunField[]): RunValues {
  const values: RunValues = {};
  for (const field of fields) {
    if (isFilled(field) && field.required) values[field.name] = seedFor(field.schema) as JsonValue;
  }
  return values;
}

/**
 * The form filled with what one run was actually CALLED with.
 *
 * A panel describing a run that has already happened should show the values that run had rather than
 * the defaults the slots declare. A slot the run carried nothing for is NOT SET — absent is what "the
 * default applied" looks like from here — and a required one it somehow lacks opens at a fresh value.
 */
export function runValuesOf(fields: readonly RunField[], inputs: Record<string, JsonValue>): RunValues {
  const values = initialRunValues(fields);
  for (const field of fields) {
    if (!isFilled(field)) continue;
    const value = inputs[field.name];
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

/** The values to send to the main process's check: every slot that is set and has a schema to meet. */
export function runChecksOf(fields: readonly RunField[], values: RunValues): CheckItem[] {
  const out: CheckItem[] = [];
  for (const field of fields) {
    const value = values[field.name];
    if (!isFilled(field) || value === undefined || field.declared === undefined) continue;
    out.push({ path: field.name, schema: field.declared, value });
  }
  return out;
}

/**
 * The complaints the form knows without asking: a required slot with no value.
 *
 * Rare, because a required slot opens with one and has no switch to take it away — but the run would
 * refuse it (`required input missing`), so it is said here rather than there.
 */
export function missingOf(fields: readonly RunField[], values: RunValues): FieldError[] {
  return fields
    .filter((field) => isFilled(field) && field.required && values[field.name] === undefined)
    .map((field) => ({ path: field.name, message: "required" }));
}

/** What `task:create` takes: the slots that are set, as they are. */
export function runInputsOf(fields: readonly RunField[], values: RunValues): Record<string, JsonValue> {
  const inputs: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (isFilled(field) && value !== undefined) inputs[field.name] = value;
  }
  return inputs;
}

// --- where it runs -----------------------------------------------------------

/**
 * The project a run is recorded in, decided by the LAYER the file is in.
 *
 * A state under `<root>/workflows` belongs to the shared library, not to a checkout, so its runs go
 * to the root opened as a project of its own ({@link SHARED_SESSION}). The alternative — recording
 * them in whichever project happened to be focused — gets both halves wrong: a shared workflow
 * clutters one checkout's board, and it is unrunnable in the mode it is most often authored in,
 * which is with no checkout open at all.
 *
 * Not JaiRA's OWN project, which is a different thing with a different lifetime: these runs belong
 * to THIS root and stop being listed when the root is repointed, while a description sync's history
 * has to survive that. See `SHARED_SESSION`.
 *
 * The trade is real and worth stating: a shared run's workspace is the root, not your repo. A shared
 * workflow that expects a checkout will not find one, which is why the panel names where the run is
 * going rather than leaving it to be discovered.
 */
export interface RunTarget {
  /** The `project` a task-scoped call takes. `"system"` for the shared root; absent ⇒ the focused one. */
  project?: string;
  /** What to call it on screen. */
  label: string;
  /** False when there is no such project to run in — a project-layer file with nothing open. */
  open: boolean;
}

/** Where a file in this layer runs. `at` is null when no user project is open. */
export function runTargetOf(layer: WorkflowLayer, at: string | null): RunTarget {
  if (layer === "base") return { project: SHARED_SESSION, label: "the shared root", open: true };
  const name = at === null ? null : (at.split(/[/\\]/).filter(Boolean).pop() ?? at);
  return { label: name ?? "this project", open: at !== null };
}

// --- whether it can run at all -----------------------------------------------

/** What the Run button needs to know about the world around the form. */
export interface RunContext {
  state: StateView | null;
  /** Where the run would be recorded — see {@link runTargetOf}. */
  target: RunTarget;
  /** The state's own file exists on disk — a never-saved draft has nothing to snapshot. */
  exists: boolean;
  fields: RunField[] | null;
  /** The verdict on the form's values — see `useSchemaCheck`. */
  check: FormCheck;
  busy: boolean;
}

/**
 * Why Run is disabled, or `null` when it is not.
 *
 * Ordered by what a person can act on first: nowhere to run, then no file, then a document that does
 * not parse, then lint errors, then the form itself. Reporting the last of those before the first
 * would be asking someone to fill in boxes on a state that could not have run either way.
 *
 * `state.fileOnly` is deliberately NOT a refusal. It means the view was read without a user project,
 * which is the normal way to look at the shared root — and a shared state runs in JaiRA's own
 * project, which does not need one. What it costs is real (no run history in the second group, no
 * dependants) and is said where those would have been, not here.
 *
 * Warnings are also not here. A state with three warnings runs; refusing would make the distinction
 * between a warning and an error meaningless at the one moment it matters.
 */
export function runBlocker({ state, target, exists, fields, check, busy }: RunContext): string | null {
  if (state === null) return "select a state to run";
  if (!target.open) return "open a project to run this";
  if (!exists) return "save this file before running it";
  if (fields === null) return "this file does not parse";
  const errors = state.issues.filter((issue) => issue.severity === "error").length;
  if (errors > 0) return `${errors} validation error${errors === 1 ? "" : "s"} — fix them first`;
  const form = checkBlocker(check);
  if (form !== null) return form;
  if (busy) return "busy";
  return null;
}

/**
 * The title a run gets, since the form does not ask for one.
 *
 * The state id plus a count, so the Tasks view lists `feature/plan #1`, `#2`, `#3` rather than three
 * rows with the same name. Counted from the runs already started here, which is a number the panel
 * is showing on screen directly above the button — a title that matches what you can see beats one
 * with a timestamp in it nobody can match to anything.
 */
export function runTitle(stateId: string, startedHere: number): string {
  return `${stateId} #${startedHere + 1}`;
}

// --- what has run before -----------------------------------------------------

/**
 * Previous runs, in the two groups they genuinely fall into.
 *
 * They are different questions and conflating them was never going to be right. `startedHere` is
 * every task whose workflow IS this state — the runs this panel's button produces, and the ones a
 * person means by "run it again". `passedThrough` is every task that entered this state on its way
 * through some larger workflow; for a child state that is usually all of them, and for a root it is
 * usually none, because a root's own runs are already in the first group.
 */
export interface RunHistory {
  startedHere: TaskSummary[];
  passedThrough: BoardCard[];
}

/**
 * The run a state's panel opens on — its newest, or `null` when it has never run.
 *
 * `tasksHere` before `tasksRecent`, and not merely by timestamp: a run parked in this state RIGHT
 * NOW is what you came to look at, even when something that finished later was touched more
 * recently. Within each group, newest wins.
 */
export function newestRunOf(state: StateView | null): BoardCard | null {
  const newest = (cards: BoardCard[]): BoardCard | undefined =>
    [...cards].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (state === null) return null;
  return newest(state.tasksHere) ?? newest(state.tasksRecent) ?? null;
}

/**
 * Which of a task's conversations to show, given the state whose panel you are on.
 *
 * A task's LATEST instance is the deepest state it reached, so a task selected from
 * `feature/plan/goals` used to open `critique`'s transcript — the right task, the wrong state, and
 * nothing on screen saying the two had come apart. The newest instance OF THAT STATE is the answer;
 * newest rather than first because a loop runs one state several times and the last pass is the one
 * being asked about.
 *
 * `null` means "no opinion" — no state named, or the task never reached it — and the caller then
 * lets `session:view` pick the latest, which is the behaviour that was always there.
 */
export function instanceAt(history: SessionRef[], stateId: string | null): string | null {
  if (stateId == null) return null;
  return history.filter((row) => row.stateId === stateId).at(-1)?.instanceId ?? null;
}

export function runHistoryOf(stateId: string, tasks: TaskSummary[], state: StateView | null): RunHistory {
  const startedHere = tasks.filter((task) => task.workflow === stateId).sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Set(startedHere.map((task) => task.taskId));
  const passedThrough: BoardCard[] = [];
  // `tasksHere` and `tasksRecent` are two projections of one board and a task can be in both, so
  // this dedupes across them as well as against the group above.
  for (const card of [...(state?.tasksHere ?? []), ...(state?.tasksRecent ?? [])]) {
    if (seen.has(card.taskId)) continue;
    seen.add(card.taskId);
    passedThrough.push(card);
  }
  passedThrough.sort((a, b) => b.updatedAt - a.updatedAt);
  return { startedHere, passedThrough };
}

// --- starting a run with nothing open ----------------------------------------

/**
 * The MIME of a workflow file, from the file's own name.
 *
 * `workflow:read` answers with an ABSOLUTE path and no type, because a state id is enough to find
 * one and the caller normally knows what it asked for. The new-task form does not: it is handed a
 * root id from the picker and has to parse whatever spelling that root happens to be written in.
 * The rule is the one {@link mimeOfPath} applies to a file under `workflows/`, restated for a path
 * that is not root-relative — and defaulting to JSON, because that is what a state with no
 * recognised extension is.
 */
export function workflowMimeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return ext === "yaml" || ext === "yml" ? WORKFLOW_YAML : WORKFLOW_JSON;
}

/**
 * Which LAYER holds a state's file, as far as the browse listing can say.
 *
 * A root is named by a row of its own, and that row is authoritative: it reports the copy that would
 * actually run, so a project file shadowing a shared one is read as the project's.
 *
 * Anything BELOW a root has no row, and used to be assumed to be the project's — which is wrong for
 * every workflow that lives in the shared root, and a shared workflow with a checkout open is the
 * ordinary case rather than an exotic one. Reading the wrong layer does not fail loudly: a missing
 * file reads back as empty text, and empty text is a state with no inputs in it, so the form reported
 * that the file did not parse without ever having opened one. The root's CLOSURE answers it — a root
 * lists every state under it — and the root's layer is then the best guess for its children.
 *
 * A guess, and it is worth being clear about which part is: a project file may shadow one child of a
 * shared root and not the rest, and no listing here distinguishes that. The caller settles it against
 * the disk (`WorkflowSource.exists`) rather than trusting this.
 */
export function workflowLayerOf(workflows: readonly WorkflowEntry[], stateId: string): WorkflowLayer {
  const own = workflows.find((entry) => entry.rootId === stateId);
  if (own !== undefined) return own.layer;
  return workflows.find((entry) => entry.states.includes(stateId))?.layer ?? "project";
}

/** What the new-task form needs to know about itself before it may be submitted. */
export interface CreateContext {
  /** The root chosen in the picker; empty while none is. */
  workflow: string;
  /**
   * Its declared inputs.
   *
   * Three values, and the third is the one that matters: `undefined` is "not read yet", which is a
   * real state the form spends a round trip in and which must not be reported as an unparseable
   * file. `null` is that file, read and refused.
   */
  fields: RunField[] | null | undefined;
  check: FormCheck;
  busy: boolean;
}

/**
 * Why the new-task form's button is off, or `null` when it is not.
 *
 * The sibling of {@link runBlocker}, ordered by the same rule — what a person can act on first —
 * and deliberately NOT the same function. This form has no open file, no lint result and no layer:
 * it is a picker and the boxes that picker produced, and the two things it can refuse for are the
 * ones a picker can be wrong about. Lint is left to the panel that has a state view to read it
 * from; a workflow with errors can be started here and will fail where it always did.
 */
export function createBlocker({ workflow, fields, check, busy }: CreateContext): string | null {
  if (workflow.trim().length === 0) return "choose a workflow";
  if (fields === undefined) return "reading its inputs";
  if (fields === null) return "that workflow's file does not parse";
  const form = checkBlocker(check);
  if (form !== null) return form;
  if (busy) return "busy";
  return null;
}
