/**
 * The events workflow as a project reads it, and the one task that runs it (decision 0010 §4).
 *
 * `system/events` is resolved like any bare id — the project's copy, else Shared's, else the one JaiRA
 * ships (`$SYSTEM/workflows/system/events`, which has no automations). What the supervisor needs from
 * it is three facts: does it load, how many automations its root holds, and which version it is (the
 * snapshot hash a task of it would pin — the same comparison the workflow browser's drift check makes).
 *
 * ## Shared's copy, when a project keeps it
 *
 * A project's copy follows Shared's by `$ref: "$BASE/workflows/system/events"`. A named root names ONE
 * place and never searches (REFERENCES.md §1), so with no copy in Shared that reference names nothing
 * and the project's copy does not load. It is not made to fall back: the writer of a project's copy
 * writes Shared's first — {@link ensureBaseEventsCopy}, a copy that follows the built-in — which is
 * also what a person editing the files by hand would see there. That copy spells `transitions` and
 * `children` out, empty: the project's copy reads `$BASE/workflows/system/events.transitions`, and a
 * property read of a file that holds only a `$ref` finds nothing (the engine reads the file's own keys).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { snapshotHash, type EngineEvent, type WorkflowBundle } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import { isEventName, type EventDelivery, type JairaBasePaths, type StartingState, type TaskMeta } from "@jaira/shared";
import { loadWorkflowBundle } from "./permissionSets";
import type { Project } from "./project";
import { readWorkflowFiles } from "./snapshots";
import { workflowLoadOptions } from "./workflowRefs";

/** The events workflow's id, in every layer. */
export const EVENTS_WORKFLOW = "system/events";
/** The events task's title, and its system marker (`TaskMeta.system`). */
export const EVENTS_TASK = "events";

/** The events workflow as it stands now in one project. */
export interface EventsWorkflowReading {
  bundle: WorkflowBundle;
  /** Its version: what a task started now would pin. */
  hash: string;
  /** Its automations: the root's transitions, by name where one is given, else by target. */
  lines: string[];
}

/**
 * Load `system/events` as this project resolves it — live files, like a first start. Throws the load
 * or validation error (a broken copy is not "no automations": the caller leaves a running task alone).
 */
export function readEventsWorkflow(project: Project): EventsWorkflowReading {
  const bundle = loadWorkflowBundle(
    readWorkflowFiles(project.paths.workflowsDir, { onError: () => undefined }),
    EVENTS_WORKFLOW,
    workflowLoadOptions(project.paths, { path: project.config.workflows.path }),
  );
  const root = bundle.states[bundle.rootId] as { transitions?: ReadonlyArray<{ name?: string; to?: string }> } | undefined;
  const lines = (root?.transitions ?? []).map((t, i) => t.name ?? t.to ?? `#${i + 1}`);
  return { bundle, hash: snapshotHash(bundle), lines };
}

/** The project's events task: the newest task of `system/events` carrying the system marker. */
export function eventsTaskOf(project: Project): TaskMeta | undefined {
  const found = project.tasks.list().filter((meta) => meta.system === EVENTS_TASK && meta.workflow === EVENTS_WORKFLOW);
  return found.at(-1);
}

/**
 * Give Shared a copy of `system/events` that follows the built-in, unless it has one — what a project's
 * copy's `$ref: "$BASE/workflows/system/events"` needs to name something. Idempotent: an existing copy
 * (JSON or YAML) is left exactly as it is.
 */
export function ensureBaseEventsCopy(base: Pick<JairaBasePaths, "workflowsDir">): { file: string; created: boolean } {
  for (const ext of [".json", ".yaml", ".yml"]) {
    const file = join(base.workflowsDir, `${EVENTS_WORKFLOW}${ext}`);
    if (existsSync(file)) return { file, created: false };
  }
  const file = join(base.workflowsDir, `${EVENTS_WORKFLOW}.json`);
  mkdirSync(dirname(file), { recursive: true });
  // `transitions` and `children` spelled out, empty, rather than inherited: a project's copy reads
  // `$BASE/workflows/system/events.transitions`, and a property read of a file that holds only a
  // `$ref` finds nothing there — the engine reads the file's own keys, not its target's.
  writeFileSync(file, `${JSON.stringify({ $ref: `$SYSTEM/workflows/${EVENTS_WORKFLOW}`, transitions: [], children: {} }, null, 2)}\n`, "utf8");
  return { file, created: true };
}

// --- what an automation's `start_task` started (decision 0010 §4, the rulings of 2026-09-25) --------

/** The state that called `start_task` or `notify`, read off the events task's journal. */
export interface CallingState extends Omit<StartingState, "call"> {
  /** The calling instance — the automation's firing. */
  instanceId: string;
  /** What it was entered with as `.inputs.event` — the event the rule fired on. */
  event?: EventDelivery;
}

/** A settled value as a journal row carries it: the engine's `{ value }` wrapper, or the value itself. */
const unwrapped = (value: unknown): unknown => (value !== null && typeof value === "object" && !Array.isArray(value) && "value" in value ? (value as { value: unknown }).value : value);

/**
 * Who called: the instance `instanceId` in `taskId`'s journal — its key under the root (the
 * automation), its path, its state, which entry of that key it is, and the event it was entered with.
 * `undefined` when the journal holds no entry for it (a call no engine dispatched).
 */
export function callingStateOf(project: Project, taskId: string, instanceId: string): CallingState | undefined {
  const entered = new Map<string, { parent?: string; key?: string; stateId: string; inputs?: Record<string, unknown> }>();
  const counts = new Map<string, number>();
  let occurrence = 0;
  for (const row of project.events.list(taskId)) {
    const event = row.event;
    if (event.type !== "instance.entered" || entered.has(event.instanceId)) continue;
    // A started task's mirror is no entry of the machine's (see `mirrorStarted`).
    if ((event as { started?: boolean }).started === true) continue;
    entered.set(event.instanceId, {
      ...(event.parentInstanceId !== undefined ? { parent: event.parentInstanceId } : {}),
      ...(event.childKey !== undefined ? { key: event.childKey } : {}),
      stateId: event.stateId,
      ...(event.inputs !== undefined ? { inputs: event.inputs as Record<string, unknown> } : {}),
    });
    if (event.childKey === undefined) continue;
    const slot = `${event.parentInstanceId ?? ""}\u0000${event.childKey}`;
    const n = counts.get(slot) ?? 0;
    counts.set(slot, n + 1);
    if (event.instanceId === instanceId) occurrence = n;
  }
  const own = entered.get(instanceId);
  if (own?.key === undefined) return undefined;
  const steps: string[] = [];
  for (let at: string | undefined = instanceId; at !== undefined; at = entered.get(at)?.parent) {
    const key = entered.get(at)?.key;
    if (key !== undefined) steps.unshift(key);
  }
  const event = unwrapped(own.inputs?.["event"]) as { name?: unknown; payload?: unknown } | undefined;
  const delivered = event !== undefined && event !== null && isEventName(event.name) && typeof event.payload === "object" ? (event as EventDelivery) : undefined;
  return { instanceId, key: own.key, path: steps.join("/"), stateId: own.stateId, occurrence, ...(delivered !== undefined ? { event: delivered } : {}) };
}

/**
 * The task an automation already started for this call — its (events task, key, firing, call) — found
 * by what every such task carries: `origin` for a child, `startedBy.state` for one on its own. What a
 * resumed events task finds when it re-runs a `start_task` whose answer it never recorded, so the call
 * is answered with the task it made rather than a second one.
 */
export function startedTaskOf(project: Project, eventsTaskId: string, at: Pick<StartingState, "key" | "occurrence" | "call">): TaskMeta | undefined {
  return project.tasks.list().find((meta) => {
    const origin = meta.origin;
    if (origin?.kind === "started") return origin.taskId === eventsTaskId && origin.key === at.key && (origin.occurrence ?? 0) === at.occurrence && origin.index === at.call;
    const by = meta.startedBy;
    return by !== undefined && by.fromTask === eventsTaskId && by.state !== undefined && by.state.key === at.key && by.state.occurrence === at.occurrence && by.state.call === at.call;
  });
}

/**
 * Mirror a task the events task started as a CHILD into its journal (the fan-out host's `each: "task"`
 * rows, `fanOut.ts`): an `instance.entered` whose instance id IS the task's, parented at the calling
 * state and marked `started` — so the conversation and the Steps list show it under the automation,
 * and the load leaves it out of the machine (`load.ts`). No child key: the calling state never mounted
 * it. Written once; a second call finds it there.
 */
export function mirrorStarted(project: Project, eventsTaskId: string, at: Pick<CallingState, "instanceId">, task: Pick<TaskMeta, "id" | "workflow" | "inputs">, nowMs = Date.now()): void {
  if (project.events.list(eventsTaskId).some((row) => row.event.type === "instance.entered" && row.event.instanceId === task.id)) return;
  const event = {
    type: "instance.entered",
    instanceId: task.id,
    stateId: task.workflow,
    parentInstanceId: at.instanceId,
    inputs: (task.inputs ?? {}) as Record<string, JsonValue>,
    started: true,
  } as unknown as EngineEvent;
  project.events.recorder(eventsTaskId).record(event, nowMs);
}

/**
 * The END of a started child's mirror, once its task has ended: an `instance.terminated` for it in the
 * events task's journal, as `fanOut.ts` writes an element's. Nothing when the task was started on its
 * own, when the events task that started it is gone, or when the end is already written. Returns the
 * events task it wrote into.
 */
export function settleStartedMirror(project: Project, taskId: string, status: "completed" | "failed" | "canceled", nowMs = Date.now()): string | undefined {
  const origin = project.tasks.tryRead(taskId)?.origin;
  if (origin?.kind !== "started" || project.runtime.get(origin.taskId) === undefined) return undefined;
  let entered: { stateId: string } | undefined;
  let ended = false;
  for (const row of project.events.list(origin.taskId)) {
    const event = row.event;
    if (event.type === "instance.entered" && event.instanceId === taskId) {
      entered = { stateId: event.stateId };
      ended = false;
    } else if (event.type === "instance.terminated" && event.instanceId === taskId) ended = true;
  }
  if (entered === undefined || ended) return undefined;
  const outcome = status === "completed" ? "success" : status === "canceled" ? "canceled" : "error";
  const event = { type: "instance.terminated", instanceId: taskId, stateId: entered.stateId, outcome } as EngineEvent;
  project.events.recorder(origin.taskId).record(event, nowMs);
  return origin.taskId;
}
