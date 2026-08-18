/**
 * Starting a run from the file you are looking at — everything about it that is not React.
 *
 * The Files view could open, lint and edit a state without ever offering to run one, so the loop
 * "change it, try it, read what happened" went through the Tasks view and a state id typed from
 * memory. This module is the half of closing that loop which can be tested: what a state declares it
 * needs, what the boxes hold, what that becomes as `task:create` inputs, and why a run is refused.
 *
 * Two rules shape the whole thing.
 *
 * **The saved file is what runs.** Fields are read from `doc.text`, never from a draft. A run pins a
 * snapshot of what is on disk (DESIGN §5.3), so a form built from unsaved typing would be a form
 * describing inputs the run will not have. The panel says so when the two differ rather than quietly
 * offering the wrong boxes.
 *
 * **A box's type comes from the slot's schema, and only where the schema is small enough to trust.**
 * {@link slotTypeOf} answers `null` for anything richer than the vocabulary — `properties`, an
 * `enum`, a bound — and those slots get a JSON box rather than a control that could only round the
 * value down. Same refusal the slot table makes, for the same reason.
 */
import { parse as parseYaml } from "yaml";
import type { JsonValue } from "@declarative-ai/json";
import {
  SHARED_SESSION,
  WORKFLOW_YAML,
  type BoardCard,
  type SessionRef,
  type SlotType,
  type StateView,
  type TaskSummary,
  type WorkflowLayer,
} from "@jaira/shared/browser";
import { jsonValueOf } from "./jsonText";
import { slotsOf, type SlotRow } from "./slotForm";

// --- what the state asks for -------------------------------------------------

/** How a field is typed in, once its schema has been read. */
export type RunControl = "text" | "multiline" | "number" | "boolean" | "json";

/** One box in the run form: a slot the state declares, as something a person fills in. */
export interface RunField {
  name: string;
  /** The slot's type, or `null` when its schema is richer than the vocabulary. */
  type: SlotType | null;
  /** Which control to render. Derived from {@link type}; see {@link controlFor}. */
  control: RunControl;
  /** SPEC §4.1: a slot is required unless it says `optional` or carries a `default`. */
  required: boolean;
  description: string;
  /** What the box starts at — the slot's `default`, as text. Empty when it declares none. */
  initial: string;
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
   * There is no single value to type, so it is listed and not filled — the same thing the slot table
   * does with the type picker on a spread row.
   */
  spread?: boolean;
}

/** The text in each box, keyed by slot name. What the panel holds and hands back. */
export type RunValues = Record<string, string>;

function controlFor(type: SlotType | null): RunControl {
  if (type === null) return "json";
  if (type.list) return "json";
  switch (type.name) {
    case "boolean":
      return "boolean";
    case "number":
    case "integer":
    case "datetime":
      return "number";
    case "artifact":
      // Content with a media type — a paragraph of markdown far more often than a word, and a
      // one-line box for it is the difference between pasting an issue and retyping it.
      return "multiline";
    case "text":
    case "url":
    case "file":
      return "text";
    case "object":
    case "any":
      return "json";
  }
}

function fieldOf(row: SlotRow): RunField {
  const type = row.typeRef !== undefined ? null : row.type;
  return {
    name: row.name,
    type,
    control: controlFor(type),
    // A `default` satisfies the slot as surely as `optional` does, so it is not required even though
    // the box it prefills can be cleared — clearing it sends nothing, and the default applies.
    required: !row.optional && row.default.length === 0,
    description: row.description,
    initial: row.default,
    ...(row.binding.length > 0 || row.structured === true ? { binding: row.binding } : {}),
    ...(row.spread === true ? { spread: true } : {}),
  };
}

/** Parse a state document by the type the tree gave it. `null` when it does not parse. */
function parseState(text: string, mime: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = mime === WORKFLOW_YAML ? parseYaml(text) : JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The boxes a state's `inputs` asks for, in declaration order.
 *
 * `null` means the document does not parse — genuinely different from a state with no inputs, and
 * the panel says so rather than showing an empty form under a Run button that would fail.
 */
export function runFieldsOf(text: string, mime: string): RunField[] | null {
  const doc = parseState(text, mime);
  if (doc === null) return null;
  return slotsOf(doc["inputs"]).map(fieldOf);
}

/** Every box at its starting value — what the form opens showing. */
export function initialRunValues(fields: RunField[]): RunValues {
  const values: RunValues = {};
  for (const field of fields) values[field.name] = field.initial;
  return values;
}

/** True when a field takes no value from the person running it. */
export function isFilled(field: RunField): boolean {
  return field.binding === undefined && field.spread !== true;
}

// --- what the boxes become ---------------------------------------------------

/** One box that cannot be read as the type its slot declares. */
export interface RunFieldError {
  name: string;
  reason: string;
}

/** The boxes, read. `inputs` is what `task:create` takes; the other two are why it may not be sent. */
export interface RunInputs {
  inputs: Record<string, JsonValue>;
  /** Required slots left empty. Refused here rather than at the first state of the run. */
  missing: string[];
  bad: RunFieldError[];
}

/**
 * One box's text as the value its slot declares — or the reason it is not one.
 *
 * The `text` case is the one worth stating: a string slot takes the text VERBATIM. Typing `123` into
 * a text box means the three characters, not the number, and running it through a JSON parse "for
 * convenience" would retype it silently. `any` is the opposite case and gets the lenient reading
 * from {@link jsonValueOf}, because a slot with no schema really will take either.
 */
function readField(field: RunField, text: string): { value: JsonValue } | { reason: string } {
  const trimmed = text.trim();
  switch (field.control) {
    case "text":
    case "multiline":
      return { value: text };
    case "boolean":
      if (trimmed === "true") return { value: true };
      if (trimmed === "false") return { value: false };
      return { reason: "must be true or false" };
    case "number": {
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { reason: `'${trimmed}' is not a number` };
      if (field.type?.name === "integer" && !Number.isInteger(value)) return { reason: "must be a whole number" };
      return { value };
    }
    case "json":
      // `any` has no schema to disappoint, so `hello` is the string `hello`. Everything else here —
      // an object, a list, a schema outside the vocabulary — is asking for JSON, and the fallback to
      // "it is a string then" would turn a typo into a value the run accepts and misreads.
      if (field.type?.name === "any" && field.type.list === false) return { value: jsonValueOf(text) as JsonValue };
      try {
        return { value: JSON.parse(trimmed) as JsonValue };
      } catch (e) {
        return { reason: (e as Error).message };
      }
  }
}

/** Read the whole form: the inputs to send, and everything standing in the way of sending them. */
export function runInputsOf(fields: RunField[], values: RunValues): RunInputs {
  const inputs: Record<string, JsonValue> = {};
  const missing: string[] = [];
  const bad: RunFieldError[] = [];
  for (const field of fields) {
    if (!isFilled(field)) continue;
    const text = values[field.name] ?? "";
    if (text.trim().length === 0) {
      // Empty is ABSENT, never `""`. A slot with a default then gets its default, and a required one
      // is reported — which is the whole difference between the two.
      if (field.required) missing.push(field.name);
      continue;
    }
    const read = readField(field, text);
    if ("reason" in read) bad.push({ name: field.name, reason: read.reason });
    else inputs[field.name] = read.value;
  }
  return { inputs, missing, bad };
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
  inputs: RunInputs;
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
export function runBlocker({ state, target, exists, fields, inputs, busy }: RunContext): string | null {
  if (state === null) return "select a state to run";
  if (!target.open) return "open a project to run this";
  if (!exists) return "save this file before running it";
  if (fields === null) return "this file does not parse";
  const errors = state.issues.filter((issue) => issue.severity === "error").length;
  if (errors > 0) return `${errors} validation error${errors === 1 ? "" : "s"} — fix them first`;
  if (inputs.missing.length > 0) return `${inputs.missing.join(", ")} ${inputs.missing.length === 1 ? "is" : "are"} required`;
  if (inputs.bad.length > 0) return `${inputs.bad[0]!.name}: ${inputs.bad[0]!.reason}`;
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
export function instanceAt(history: SessionRef[], stateId: string | null): number | null {
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
