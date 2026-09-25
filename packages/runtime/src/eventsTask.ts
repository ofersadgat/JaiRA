/**
 * `start_task` and `notify` — the two workflow FUNCTIONS the events task runs (decision 0010 §4).
 *
 * The events task is `$SYSTEM/workflows/system/events` run unattended: its state-level rules wait on
 * `on_event`, and each rule enters an `async` child naming one of two step states,
 * `system/events/start` (this module's `start_task`) or `system/events/notify` (`notify`). Those are
 * the only things it may do — its run's registry is restricted to them and `on_event` — so an
 * automation can start work and say something, and nothing else: it asks nobody anything, runs no
 * agent and touches no file.
 *
 * Registry FUNCTIONS, not agent tools: the workflow tools' `start_task` (`workflowTools.ts`) is a
 * different thing in a different map, a conversation's way to start a child of itself.
 *
 * Both hand the event they were given back in their result (`event`), which is what a step's output
 * of that name is filled from — so the next step of a chain reads `.children.<prev>.outputs.event`.
 */
import { hostFunction, type CapabilityRegistry, type FunctionInputs, type FunctionResult, type HostCapabilities, type InlineFamily, type ResolvedValue, type Signature } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import { isEventName, type EventDelivery } from "@jaira/shared";

export const START_TASK = "start_task";
export const NOTIFY = "notify";

/** What `start_task` is asked to do, checked. */
export interface EventsTaskStart {
  workflow: string;
  inputs?: Record<string, JsonValue>;
  title?: string;
  /** The event the automation fired on, when the step was handed one. */
  event?: EventDelivery;
}

/** What `notify` is asked to say, checked. */
export interface EventsTaskNotice {
  text: string;
  event?: EventDelivery;
}

/**
 * What the host lends the two functions: the app's own create-and-start, and its notices.
 *
 * `startTask` resolves as soon as the new task's run has STARTED (or could not) — never when it
 * finishes. A task that was made but could not start is answered with `error` beside its id, not
 * thrown: one automation's bad target must not end the events task and every other automation with it.
 */
export interface EventsTaskHost {
  startTask(request: EventsTaskStart): Promise<{ task_id: string; error?: string }>;
  notify(notice: EventsTaskNotice): void;
}

export const START_TASK_SIGNATURE: Signature<InlineFamily> = {
  input: {
    workflow: { kind: "text", schema: { type: "string" } },
    inputs: { kind: "json", optional: true, schema: { type: "object" } },
    title: { kind: "text", optional: true, schema: { type: "string" } },
    event: { kind: "json", optional: true },
  },
  output: {
    name: "started",
    kind: "json",
    schema: {
      type: "object",
      properties: { task_id: { type: "string" }, event: { type: "object" }, error: { type: "string" } },
      required: ["task_id"],
    },
  },
};

export const NOTIFY_SIGNATURE: Signature<InlineFamily> = {
  input: {
    text: { kind: "text", schema: { type: "string" } },
    event: { kind: "json", optional: true },
  },
  output: { name: "posted", kind: "json", schema: { type: "object", properties: { event: { type: "object" } } } },
};

/** Outward-facing and not repeatable: a replayed `start_task` would start a second task. */
const CAPABILITIES: HostCapabilities = { interactive: false, readOnly: false, memoizable: false };

/** Absent, null or not an event: none. A value that is not one is not refused — it is just not named. */
function eventOf(value: unknown): EventDelivery | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { name?: unknown; payload?: unknown };
  if (!isEventName(candidate.name) || candidate.payload === null || typeof candidate.payload !== "object") return undefined;
  return value as EventDelivery;
}

/** `start_task`'s arguments, or why they are not arguments. */
export function checkStartTask(inputs: FunctionInputs): EventsTaskStart | { error: string } {
  const workflow = inputs["workflow"];
  if (typeof workflow !== "string" || workflow.trim().length === 0) return { error: `${START_TASK}: 'workflow' names the workflow to start — a root state id such as feature/review` };
  const given = inputs["inputs"];
  if (given !== undefined && given !== null && (typeof given !== "object" || Array.isArray(given))) {
    return { error: `${START_TASK}: 'inputs' is an object of the new task's inputs, by name` };
  }
  const title = inputs["title"];
  if (title !== undefined && title !== null && typeof title !== "string") return { error: `${START_TASK}: 'title' is text` };
  const event = eventOf(inputs["event"]);
  return {
    workflow: workflow.trim(),
    ...(given !== undefined && given !== null ? { inputs: given as Record<string, JsonValue> } : {}),
    ...(typeof title === "string" && title.trim().length > 0 ? { title: title.trim() } : {}),
    ...(event !== undefined ? { event } : {}),
  };
}

/**
 * Register `start_task` and `notify` over `host`. Without a host, only their declarations — what
 * `hostCalleeSignatures` reads so a workflow naming them loads anywhere; a run that is not the events
 * task never registers them, and its start refuses a state that calls one.
 */
export function registerEventsTaskFunctions(registry: CapabilityRegistry<WorkflowMetrics>, host?: EventsTaskHost): void {
  const refuse = (reason: string): FunctionResult<ResolvedValue, WorkflowMetrics> => ({ error: { classification: "permanent", reason } });
  registry.functions.set(
    START_TASK,
    hostFunction(
      async (inputs: FunctionInputs): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
        if (host === undefined) return refuse(`${START_TASK}: only the events task can start tasks`);
        const checked = checkStartTask(inputs);
        if ("error" in checked) return refuse(checked.error);
        try {
          const started = await host.startTask(checked);
          const value = { ...started, ...(checked.event !== undefined ? { event: checked.event } : {}) };
          return { value: value as unknown as ResolvedValue };
        } catch (e) {
          return refuse(`${START_TASK}: ${(e as Error).message}`);
        }
      },
      CAPABILITIES,
      { signature: START_TASK_SIGNATURE },
    ),
  );
  registry.functions.set(
    NOTIFY,
    hostFunction(
      async (inputs: FunctionInputs): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
        if (host === undefined) return refuse(`${NOTIFY}: only the events task posts notices`);
        const text = inputs["text"];
        if (typeof text !== "string" || text.trim().length === 0) return refuse(`${NOTIFY}: 'text' says what the notice is`);
        const event = eventOf(inputs["event"]);
        host.notify({ text: text.trim(), ...(event !== undefined ? { event } : {}) });
        return { value: (event !== undefined ? { event } : {}) as unknown as ResolvedValue };
      },
      CAPABILITIES,
      { signature: NOTIFY_SIGNATURE },
    ),
  );
}
