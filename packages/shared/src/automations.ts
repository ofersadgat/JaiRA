/**
 * An automation's STATE (decision 0010 §4, the rulings of 2026-09-25): what one line of the events
 * workflow runs when its event arrives.
 *
 * A line is a named rule of the events root, `{ name, when: "on_event(…)", to: name, inputs: { event:
 * ".event" } }`, into an `async` child `name: { "async": true }` whose state is the default `./name` —
 * `system/events/<name>`, a state file of its own in the layer that holds the line, found through the
 * layers like any state (so a project's own copy of that one file changes that automation for that
 * project alone). That state takes the event as its one input and runs its steps as ONE operation
 * LIST (hw SPEC §7.1d), each step one call:
 *
 * ```json
 * {
 *   "label": "push_main",
 *   "inputs": { "event": { "schema": {}, "optional": true } },
 *   "operation": [
 *     { "function": "start_task", "args": { "workflow": "feature/review", "inputs": { "issue": { "$binding": { "$expr": ".inputs.event.payload.commits[0].message" } } } } },
 *     { "function": "notify", "args": { "text": "started a review of main" } }
 *   ]
 * }
 * ```
 *
 * `args` are literal JSON except where a value is WRAPPED — `{ "$binding": { "$expr": ".inputs.event.payload.x" } }`
 * (SPEC §5.3: inside `args` a bare binding could not be told from data; the `$expr` inside, because a
 * bare `.inputs.<name>.<more>` path is not a reference the loader takes — only `.inputs.<name>` is).
 * A string is a literal string.
 * No outputs: a list-operation state must bind every output it declares (§7.1d), and nothing reads one.
 *
 * Pure and browser-safe: the Automations editor writes and reads this, and the persistence migration of
 * the old shape writes it too.
 */
import type { JsonValue } from "@declarative-ai/json";

/** The events workflow's id, in every layer. */
export const EVENTS_STATE_ID = "system/events";

/** An automation's state id: the default `./<key>` of the events root's child `<name>`. */
export const automationStateIdOf = (name: string): string => `${EVENTS_STATE_ID}/${name}`;

/**
 * Where a start's input comes from: typed, or picked from the event — by its path under the delivered
 * event (`payload.branch`, `payload.commits[0].message`; `""` for the whole event).
 */
export type StepValue = { literal: JsonValue } | { event: string };

export type AutomationStep =
  | {
      kind: "start";
      workflow: string;
      inputs: Record<string, StepValue>;
      /** The started task's title; absent: the workflow's id. */
      title?: string;
      /** Started on its own (`top_level: true`) rather than as the automation's child — the default. */
      topLevel?: boolean;
    }
  | { kind: "notify"; text: string };

/** What the state reads the event as. */
const EVENT_REF = ".inputs.event";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A pick from the event as the binding `args` wraps: `.inputs.event.payload.branch`. */
export const eventBindingOf = (path: string): string => (path.length > 0 ? `${EVENT_REF}.${path}` : EVENT_REF);

/** One step as the call it is. */
export function callOfStep(step: AutomationStep): Record<string, unknown> {
  if (step.kind === "notify") return { function: "notify", args: { text: step.text } };
  const args: Record<string, unknown> = { workflow: step.workflow };
  const entries = Object.entries(step.inputs);
  if (entries.length > 0) {
    args["inputs"] = Object.fromEntries(entries.map(([key, value]) => [key, "literal" in value ? value.literal : { $binding: { $expr: eventBindingOf(value.event) } }]));
  }
  if (step.title !== undefined && step.title.length > 0) args["title"] = step.title;
  if (step.topLevel === true) args["top_level"] = true;
  return { function: "start_task", args };
}

/** A call read back as a step; `undefined` when it is not one this format writes. */
export function stepOfCall(call: unknown): AutomationStep | undefined {
  if (!isRecord(call) || !isRecord(call["args"])) return undefined;
  if (Object.keys(call).some((key) => key !== "function" && key !== "args")) return undefined;
  const args = call["args"];
  if (call["function"] === "notify") {
    if (typeof args["text"] !== "string" || Object.keys(args).some((key) => key !== "text")) return undefined;
    return { kind: "notify", text: args["text"] };
  }
  if (call["function"] !== "start_task") return undefined;
  if (typeof args["workflow"] !== "string") return undefined;
  if (Object.keys(args).some((key) => !["workflow", "inputs", "title", "top_level"].includes(key))) return undefined;
  const inputs: Record<string, StepValue> = {};
  const held = args["inputs"];
  if (held !== undefined) {
    if (!isRecord(held)) return undefined;
    for (const [key, value] of Object.entries(held)) {
      if (isRecord(value) && Object.keys(value).length === 1 && "$binding" in value) {
        const wrapped = value["$binding"];
        const ref = isRecord(wrapped) && Object.keys(wrapped).length === 1 ? wrapped["$expr"] : undefined;
        if (typeof ref !== "string" || (ref !== EVENT_REF && !ref.startsWith(`${EVENT_REF}.`))) return undefined;
        inputs[key] = { event: ref === EVENT_REF ? "" : ref.slice(EVENT_REF.length + 1) };
      } else inputs[key] = { literal: value as JsonValue };
    }
  }
  const title = args["title"];
  if (title !== undefined && typeof title !== "string") return undefined;
  const top = args["top_level"];
  if (top !== undefined && typeof top !== "boolean") return undefined;
  return {
    kind: "start",
    workflow: args["workflow"],
    inputs,
    ...(typeof title === "string" && title.length > 0 ? { title } : {}),
    ...(top === true ? { topLevel: true } : {}),
  };
}

/**
 * An automation's state file with `steps` as its operation list — every other key of `previous` kept
 * (a label or a description written by hand), its `event` input declared.
 */
export function automationStateOf(name: string, steps: readonly AutomationStep[], previous?: unknown): Record<string, unknown> {
  const before = isRecord(previous) ? previous : {};
  const inputs = isRecord(before["inputs"]) ? before["inputs"] : {};
  return {
    label: typeof before["label"] === "string" ? before["label"] : name,
    ...before,
    inputs: {
      ...inputs,
      event: { schema: {}, optional: true, description: "The event the automation fired on — its rule hands `.event` in." },
    },
    operation: steps.map(callOfStep),
  };
}

/** An automation's steps, read back from its state file; `undefined` when it is not one this format writes. */
export function stepsOfAutomationState(doc: unknown): AutomationStep[] | undefined {
  if (!isRecord(doc)) return undefined;
  const operation = doc["operation"];
  if (!Array.isArray(operation) || operation.length === 0) return undefined;
  if (doc["outputs"] !== undefined || doc["children"] !== undefined || doc["transitions"] !== undefined) return undefined;
  const steps: AutomationStep[] = [];
  for (const call of operation) {
    const step = stepOfCall(call);
    if (step === undefined) return undefined;
    steps.push(step);
  }
  return steps;
}
