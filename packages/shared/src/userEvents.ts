/**
 * The user-event vocabulary (WORKFLOWS.md §7.4) — what `on_user_event(...)` names, and what it takes.
 *
 * Here rather than beside the hub that serves it, because three layers need it and none of them may
 * depend on the others: PERSISTENCE hands the document to the loader so the bare name resolves, the
 * RUNTIME registers the implementation, and the RENDERER matches a drop against a pending wait. Three
 * copies of "the option is called `to_state`" is three chances to disagree.
 *
 * Pure data and types only — this half is imported by the browser bundle.
 */
import type { JsonValue } from "@declarative-ai/json";

/** The registered function name, and the bare name a guard calls. */
export const ON_USER_EVENT = "on_user_event";

/**
 * The event a card dragged from one column to another raises.
 *
 * The event TYPE is the first argument rather than part of the function name, so a guard reads as one
 * question — "did the user do this?" — and a new gesture is a new value here rather than a new
 * function, a new document and a new registration.
 */
export const TASK_DRAG = "task_drag";

/**
 * `task_drag`'s options. The event type decides the shape of the bag, which is why this is named for
 * the event and not for the function.
 */
export interface TaskDragOptions {
  /**
   * Where the card has to be dropped for this to count, as a CHILD KEY of the state whose transition
   * is waiting — the same namespace the transition's own `to` names, and the one the board keys its
   * columns by.
   *
   * Absent ⇒ the transition's own `to`. The wait carries it filled in either way, so a reader never
   * has to know which of the two it was (`UserEventRequest.options`).
   */
  to_state?: string;
  /**
   * Seconds to wait before answering `false`, letting the rules behind this one have their turn.
   *
   * Absent ⇒ indefinitely, which is what a column on a board means: the task sits there until
   * somebody moves it.
   */
  timeout?: number;
}

/**
 * One wait, as everything outside the engine sees it — the hub publishes these and the board reads
 * them.
 *
 * A request exists only because the engine REACHED the call, which means every condition ahead of it
 * in the guard was true. That is what makes this list, and not a re-reading of the workflow file, the
 * answer to "may this card be dragged": the preconditions are honoured by construction rather than
 * re-evaluated against a second copy of the expression language.
 */
export interface UserEventRequest {
  requestId: string;
  /** The event type — the first argument. */
  event: string;
  /** The options the call named, with `to_state` filled in from the rule where the author left it out. */
  options: Record<string, JsonValue>;
  /** The task whose run is waiting. */
  taskId?: string;
  at: number;
}

// The SIGNATURE lives beside the IMPLEMENTATION, in `@jaira/runtime`'s `userEvents`, because a
// registry entry declares its own slots now (SPEC §7.5) — so the thing the engine dispatches and the
// thing the loader binds arguments against are one object rather than two that can drift. It cannot
// live here anyway: a `Signature` is an `@declarative-ai/exec` type, and this module is in the
// browser bundle, which is why it only ever held the shape as untyped `JsonValue`.
