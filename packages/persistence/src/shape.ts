/**
 * Deriving a board `WorkflowShape` from a loaded bundle.
 *
 * The projection deliberately does not depend on the engine's state format — it
 * takes the small shape it needs (labels, ordered children, which states need a
 * human) so it stays testable with hand-written fixtures. This module is the one
 * adapter from `@declarative-ai/hw`'s bundle to that shape.
 */
import type { WorkflowBundle } from "@declarative-ai/hw";
import type { StateShape, WorkflowShape } from "./projection";

export interface ShapeOptions {
  /**
   * Names of registered functions that need a human (interactive capabilities).
   * A state whose function op names one of these is shown `waiting_for_user`
   * while it runs.
   */
  interactiveFunctions?: ReadonlySet<string>;
}

/**
 * Column order is the state's `sequence` where declared (that is the order the
 * engine actually advances through, SPEC §3.3), with any children omitted from
 * the sequence appended in declaration order so nothing silently disappears
 * from the board.
 */
function childOrder(states: WorkflowBundle["states"], stateId: string): string[] {
  const def = states[stateId];
  const declared = Object.keys(def?.children ?? {});
  const sequence = (def?.sequence ?? []).filter((key) => declared.includes(key));
  return [...sequence, ...declared.filter((key) => !sequence.includes(key))];
}

export function workflowShape(bundle: WorkflowBundle, options?: ShapeOptions): WorkflowShape {
  const shape: WorkflowShape = {};
  for (const [stateId, def] of Object.entries(bundle.states)) {
    const children = childOrder(bundle.states, stateId).map((key) => {
      const child = def.children?.[key];
      const childState = child?.state ?? key;
      return {
        key,
        stateId: childState,
        ...(bundle.states[childState]?.label !== undefined ? { label: bundle.states[childState]!.label } : {}),
      };
    });
    const op = def.operation;
    const interactive =
      op !== undefined &&
      op.kind === "function" &&
      typeof op.functionRef === "string" &&
      options?.interactiveFunctions?.has(op.functionRef) === true;
    const entry: StateShape = { children };
    if (def.label !== undefined) entry.label = def.label;
    if (interactive) entry.interactive = true;
    shape[stateId] = entry;
  }
  return shape;
}
