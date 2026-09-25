/**
 * `start_task` and `notify` — the two workflow FUNCTIONS the events task runs (decision 0010 §4).
 *
 * The events task is `$SYSTEM/workflows/system/events` run unattended: its state-level rules wait on
 * `on_event`, and each rule enters an `async` child — the automation — whose state is ONE state with
 * an operation LIST (hw SPEC §7.1d, the rulings of 2026-09-25): each step of the automation is one call,
 * `start_task` or `notify`, run in order. Those are the only things it may do — its run's registry is
 * restricted to them and `on_event` — so an automation can start work and say something, and nothing
 * else: it asks nobody anything, runs no agent and touches no file.
 *
 * Registry FUNCTIONS, not agent tools: the workflow tools' `start_task` (`workflowTools.ts`) is a
 * different thing in a different map, a conversation's way to start a child of itself.
 *
 * ## Who called
 *
 * The calling state is not an argument: the engine hands every call its DISPATCH SITE on the context
 * (`ExecServices.scope` — the calling instance's id, and `-i` for call i of a list), and the host reads
 * the rest off the events task's journal — the instance's key (the automation), which firing of it,
 * and the event it was entered with (`.inputs.event`). So an automation's state file says only what to
 * start: `{ "function": "start_task", "args": { "workflow": "feature/review", "inputs": { … } } }`.
 *
 * ## A child, or on its own
 *
 * `start_task` starts the task as the calling state's CHILD by default — provenance on the task
 * (`origin.kind: "started"`) and rows mirrored into the events task's journal, as a hosted fan-out's
 * `each: "task"` does — so the events task lists what it started. `top_level: true` starts it ON ITS
 * OWN instead: no provenance, nothing mirrored, and `startedBy` on the task says where it came from.
 */
import { hostFunction, type CapabilityRegistry, type ExecServices, type FunctionInputs, type FunctionResult, type HostCapabilities, type InlineFamily, type ResolvedValue, type Signature } from "@declarative-ai/exec";
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
  /** Started on its own (`top_level: true`) rather than as the calling state's child. */
  topLevel: boolean;
  /** The event, when the call named one — else the host reads the calling instance's own `.inputs.event`. */
  event?: EventDelivery;
}

/** What `notify` is asked to say, checked. */
export interface EventsTaskNotice {
  text: string;
  event?: EventDelivery;
}

/** Where a call was made from: the engine's dispatch site (`ExecServices.scope`). */
export interface EventsTaskCaller {
  /** The calling instance — the automation's firing. Absent where no engine dispatched the call. */
  instanceId?: string;
  /** Which call of the state's operation list: 0 for the first, or for a single operation. */
  call: number;
}

/**
 * What the host lends the two functions: the app's own create-and-start, and its notices.
 *
 * `startTask` resolves as soon as the new task's run has STARTED (or could not) — never when it
 * finishes. A task that was made but could not start is answered with `error` beside its id, not
 * thrown: one automation's bad target must not end the events task and every other automation with it.
 */
export interface EventsTaskHost {
  startTask(request: EventsTaskStart, caller: EventsTaskCaller): Promise<{ task_id: string; error?: string }>;
  notify(notice: EventsTaskNotice, caller: EventsTaskCaller): void;
}

export const START_TASK_SIGNATURE: Signature<InlineFamily> = {
  input: {
    workflow: { kind: "text", schema: { type: "string" } },
    inputs: { kind: "json", optional: true, schema: { type: "object" } },
    title: { kind: "text", optional: true, schema: { type: "string" } },
    top_level: { kind: "json", optional: true, schema: { type: "boolean" } },
    event: { kind: "json", optional: true },
  },
  output: {
    name: "started",
    kind: "json",
    schema: {
      type: "object",
      properties: { task_id: { type: "string" }, error: { type: "string" } },
      required: ["task_id"],
    },
  },
};

export const NOTIFY_SIGNATURE: Signature<InlineFamily> = {
  input: {
    text: { kind: "text", schema: { type: "string" } },
    event: { kind: "json", optional: true },
  },
  output: { name: "posted", kind: "json", schema: { type: "object" } },
};

/** Outward-facing and not repeatable: a replayed `start_task` would start a second task. */
const CAPABILITIES: HostCapabilities = { interactive: false, readOnly: false, memoizable: false };

/** Absent, null or not an event: none. A value that is not one is not refused — it is just not named. */
export function eventOf(value: unknown): EventDelivery | undefined {
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
  const top = inputs["top_level"];
  if (top !== undefined && top !== null && typeof top !== "boolean") return { error: `${START_TASK}: 'top_level' is true or false` };
  const event = eventOf(inputs["event"]);
  return {
    workflow: workflow.trim(),
    ...(given !== undefined && given !== null ? { inputs: given as Record<string, JsonValue> } : {}),
    ...(typeof title === "string" && title.trim().length > 0 ? { title: title.trim() } : {}),
    topLevel: top === true,
    ...(event !== undefined ? { event } : {}),
  };
}

/** The dispatch site the engine put on the call's context — see {@link EventsTaskCaller}. */
export function callerOf(ctx: ExecServices | undefined): EventsTaskCaller {
  const scope = ctx?.scope;
  if (scope === undefined) return { call: 0 };
  // A list's call i dispatches at `-i`; call 0 (and a single operation) at the state's own site 0.
  return { instanceId: scope.instanceId, call: scope.sequence <= 0 ? Math.abs(scope.sequence) : 0 };
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
      async (inputs: FunctionInputs, ctx: ExecServices): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
        if (host === undefined) return refuse(`${START_TASK}: only the events task can start tasks`);
        const checked = checkStartTask(inputs);
        if ("error" in checked) return refuse(checked.error);
        try {
          const started = await host.startTask(checked, callerOf(ctx));
          return { value: started as unknown as ResolvedValue };
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
      async (inputs: FunctionInputs, ctx: ExecServices): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
        if (host === undefined) return refuse(`${NOTIFY}: only the events task posts notices`);
        const text = inputs["text"];
        if (typeof text !== "string" || text.trim().length === 0) return refuse(`${NOTIFY}: 'text' says what the notice is`);
        const event = eventOf(inputs["event"]);
        host.notify({ text: text.trim(), ...(event !== undefined ? { event } : {}) }, callerOf(ctx));
        return { value: {} as unknown as ResolvedValue };
      },
      CAPABILITIES,
      { signature: NOTIFY_SIGNATURE },
    ),
  );
}
