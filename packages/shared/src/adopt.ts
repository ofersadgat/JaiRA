/**
 * Provenance on recorded inputs, and ADOPT (decision 0005, steps 2 and 3) — the contract.
 *
 * Two things a task's record did not say, and the operation that needs both:
 *
 *  - **How an input's value was settled.** `bound` — the workflow's own wiring resolved it, with no
 *    model and nobody asked; `inferred` — a conversation supplied it from what had been said;
 *    `asked` — a person typed it. Every recorded value keeps which of the three it was, and the
 *    task's inputs view shows it.
 *  - **That a task which ran alone is now somebody's child.** Adoption writes MIRROR ROWS into a new
 *    parent task's journal — `instance.entered` / `instance.terminated` for the child key, whose
 *    instance id IS the adopted task's id, its outputs as the task recorded them — and nothing else:
 *    the adopted task keeps its journal, its sessions and its card. Nothing is copied.
 *
 * The platform never names a workflow's input (decision 0005 §0). Everything here is derived from a
 * state's declared schemas, bindings and descriptions.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ProjectRef } from "./ipc";
import type { TaskStatus } from "./task";

/** How an input's value was settled — see the header. */
export type InputSettledVia = "bound" | "inferred" | "asked";

/** An output of a task, named — where a wired value comes from. */
export interface TaskOutputRef {
  taskId: string;
  /** The output's name on the task's root state. Absent ⇒ one of the task's INPUTS, named by `input`. */
  output?: string;
  /** The task's own input the value was read from — what a backwards inference names. */
  input?: string;
}

/** One recorded input's provenance. */
export interface InputProvenance {
  via: InputSettledVia;
  /** How sure the conversation was, for an `inferred` value. */
  confidence?: number;
  /**
   * The task the value came from, for a `bound` value a task supplied: a "From a task…" pick in the
   * New task form, or a parent input inferred backwards from the child an adoption took up. While the
   * source has not completed the value is still OWED — the input is absent and the task holds for it.
   */
  from?: TaskOutputRef;
}

/** A task's output that fits an input slot — one row of the "From a task…" picker. */
export interface InputSourceOption {
  taskId: string;
  title: string;
  status: TaskStatus;
  workflow: string;
  output: string;
  /** The value, shortened, when the task has produced it. Absent for a task still on its way. */
  preview?: string;
  /** The source has not completed: a task created from it HOLDS until it does. */
  pending: boolean;
}

export interface InputSourcesRequest {
  project?: ProjectRef;
  /** The slots to find sources for: the caller's name for each, and the schema a value must meet. */
  slots: Array<{ key: string; schema: JsonValue }>;
}

export type InputSourcesResponse = Record<string, InputSourceOption[]>;

// --- adopt -------------------------------------------------------------------------------------

/** One task to adopt, and — where the parent mounts its state more than once — under which key. */
export interface AdoptionTarget {
  taskId: string;
  childKey?: string;
}

export interface TaskAdoptRequest extends AdoptionTarget {
  project?: ProjectRef;
  /** The parent workflow — the root state id of the NEW task that adopts. Not needed with {@link parentTaskId}. */
  workflow?: string;
  /**
   * Adopt INTO this task instead of making one: a task something else made — `connect()` composing
   * an adoption with a dynamic workflow's task — that has not reached the child yet. With it,
   * `childKey` says which of its root's children the adopted task stands for; the workflow is the
   * parent's own, read from what it runs under. Refused (`parent-state`) when the task is running or
   * finished, has already entered that child, or stands past it.
   */
  parentTaskId?: string;
  /** More tasks taken up by the same parent: every spine child before the cursor is adopted or unread. */
  also?: AdoptionTarget[];
  /** What the parent's form supplied, for the inputs the adopted tasks do not determine. */
  inputs?: Record<string, JsonValue>;
  /** How the supplied inputs were settled: a person's form (`asked`, the default) or a conversation. */
  suppliedVia?: Exclude<InputSettledVia, "bound">;
  /** The new task's title. Absent ⇒ the adopted task's. */
  title?: string;
  /**
   * Say what WOULD happen, and change nothing. The answer is the same shape either way, so a board
   * can ask on hover and draw exactly what a drop will do — or why it will not.
   */
  dryRun?: boolean;
  /** Start the parent once it is made (the default). `false` leaves it queued, standing past the child. */
  start?: boolean;
  /** Scripted gate answers and prompt rules for the parent's run (tests/demos). */
  interactions?: Record<string, JsonValue[]>;
  fake?: JsonValue;
}

/** Why an adoption is refused. `path` / `reference` name the thing that failed, where one does. */
export interface AdoptRefusal {
  code:
    | "unknown-task"
    | "unknown-workflow"
    | "not-mounted"
    | "ambiguous-child"
    | "unsupported-mount"
    | "already-adopted"
    | "parent-state"
    | "schema-misfit"
    | "hole"
    | "split-element"
    | "inputs-conflict"
    | "inputs-missing"
    | "workspace";
  message: string;
  /** The output path that failed the current schema (`outputs.plan/steps/0`), for `schema-misfit`. */
  path?: string;
  /** The reference that would read a child nobody ran (`children.ux.inputs.brief → children.product`), for `hole`. */
  reference?: string;
}

/** One input the parent's form still has to supply — derived from the declared slot, never named here. */
export interface AdoptAsk {
  name: string;
  required: boolean;
  schema?: JsonValue;
  description?: string;
}

/** One child the plan takes up. */
export interface AdoptedChild {
  taskId: string;
  title: string;
  childKey: string;
  stateId: string;
  /** `split`: the parent mounts the state `each: "split"`, and the new task stands past it with this element. */
  shape: "child" | "split";
  /** The element's position in the list, for the split shape. */
  index?: number;
  /** The task has not completed: the parent is made holding, and the mirror's end is written when it does. */
  pending: boolean;
  /** The state's definition differs from the one the task was pinned to, so its outputs were re-checked. */
  stateChanged: boolean;
}

/** What an adoption does — or, from a dry run, would do. */
export interface AdoptPlan {
  workflow: string;
  /** The existing task adopted INTO, when the request named one. Absent ⇒ a new task is made. */
  parentTaskId?: string;
  title: string;
  adopted: AdoptedChild[];
  /** The child key the parent's cursor stands PAST. */
  cursor: string;
  /** The spine child that runs next, or absent when the adopted child was the last. */
  next?: string;
  /** The parent's inputs as they will be recorded, with how each was settled. */
  inputs: Record<string, JsonValue>;
  provenance: Record<string, InputProvenance>;
  /** What the form still has to ask: declared inputs nothing determined. Required ones refuse a real adoption. */
  asks: AdoptAsk[];
  /** The branch the parent takes up, when an adopted task had one. */
  branch?: string;
  /** Tasks the parent waits for before it starts. */
  waitsFor: string[];
}

export type TaskAdoptResult =
  | { ok: true; dryRun: boolean; plan: AdoptPlan; /** The parent task — absent from a dry run. */ taskId?: string; started?: boolean }
  | { ok: false; dryRun: boolean; refusal: AdoptRefusal };
