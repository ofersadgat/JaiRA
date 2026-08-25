/**
 * A form rendered as a READING: nothing in it changes anything, and it shows what a run put in it.
 *
 * The state editor is one component with two jobs now. In the Files view it edits a file. In the
 * side panel beside a run it describes what that run executed — same form, same tabs, same rows —
 * and there both of the facts below are true of every control in it at once.
 *
 * ## Why these are contexts and not props
 *
 * The same argument `valuePanel.ts` makes. The form is a dozen components deep in places — a slot
 * row inside a table inside a tab inside the editor — and every one of them would have to accept a
 * flag it does not use and remember to pass it on. A missed hand-off is not a compile error either:
 * it is an editable box in a panel that promised to be a reading, which nobody notices until they
 * have typed into it.
 *
 * Defaulting to "editable, no values" is what keeps every existing call site correct: the Files view
 * renders no provider and gets exactly the editor it had.
 *
 * ## Two facts, not one
 *
 * A reading is always read-only, but read-only is not always a reading: the same panel opened on a
 * state FILE has no run behind it and no values to show, and must still not offer a Save button. So
 * `ReadOnlyContext` stands alone, and {@link RunReading} is the extra half.
 */
import { createContext, useContext } from "react";
import type { JsonValue } from "@declarative-ai/json";

/**
 * What ONE execution of a state actually held — the values behind its bindings.
 *
 * A binding says where a value comes from; this is what came. They are two different facts and the
 * form has only ever shown the first, which is why "why did this state get an empty document?" was a
 * question you answered by reading the journal rather than by looking at the state.
 *
 * Everything is optional because everything is recorded separately and independently: a state that
 * was entered has inputs, a state whose operation completed has an output, a composite has neither
 * and its children have both.
 */
export interface RunReading {
  /** The inputs the engine resolved on the way in — one per declared input slot, by name. */
  inputs?: Record<string, JsonValue>;
  /**
   * What the operation returned, when it completed.
   *
   * The operation's OWN result, not the state's published outputs: a produced output takes its value
   * from a field of this by name (WORKFLOWS.md §3.3), which is the one binding shape the panel can
   * follow without evaluating anything. Anything else is left blank rather than guessed at.
   */
  output?: JsonValue;
  /** Each child's recorded inputs, by the key the parent mounted it under. */
  children?: Record<string, Record<string, JsonValue>>;
}

/** True where the form is a reading — see the module note. */
export const ReadOnlyContext = createContext(false);

/** The run behind the form, when there is one. */
export const RunReadingContext = createContext<RunReading | null>(null);

/** Whether this form changes anything. False everywhere no provider says otherwise. */
export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/** The values one run put through this state, or null where the form is not about a run. */
export function useRunReading(): RunReading | null {
  return useContext(RunReadingContext);
}

/**
 * The value one slot held, by the table it is in and its name.
 *
 * `path` is the table's lint path, which is already how a slot is addressed everywhere else in the
 * form — `inputs`, `outputs`, `operation.input`. Each maps to a different half of the record, and
 * the ones that map to nothing answer `undefined`, which is what keeps a blank cell honest:
 *
 *  - `inputs` — what the engine resolved on the way in.
 *  - `outputs` — a PRODUCED output (no binding) is a field of the operation's result by name; a
 *    derived one is an expression over children this cannot evaluate, so it stays blank.
 *  - `operation.input` — the call's own arguments, which are not recorded apart from the request.
 */
export function slotValueOf(
  reading: RunReading | null,
  path: string | undefined,
  name: string,
  binding: string,
): JsonValue | undefined {
  if (reading === null || path === undefined || name.length === 0) return undefined;
  if (path === "inputs") return reading.inputs?.[name];
  if (path !== "outputs") return undefined;
  const output = reading.output;
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  // A produced output is filled from the result BY NAME. A derived one names a path over children,
  // and following it would mean evaluating a binding — which is the engine's job, not a panel's.
  if (binding.trim().length === 0) return (output as Record<string, JsonValue>)[name];
  const produced = /^\.operation\.output\.([A-Za-z0-9_]+)$/.exec(binding.trim());
  return produced === null ? undefined : (output as Record<string, JsonValue>)[produced[1]!];
}
