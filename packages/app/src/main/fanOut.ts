/**
 * The host's half of a hosted fan-out (decision 0003): what `each: "task"` and `each: "split"`
 * make of their elements.
 *
 * The engine resolves the elements and hands them here (hw's `EngineConfig.fanOut`); this module
 * makes a TASK of each one and answers the engine with what became of them. The two kinds differ in
 * what the task is and what the parent does next:
 *
 * - `"task"` — a fresh task rooted at the mounted state, run in the parent's workspace, one after
 *   another unless the mount is `async`. The parent waits, and reads the tasks' outputs back
 *   gathered exactly as it would an inline batch's (`combineElements`).
 * - `"split"` — a copy of the parent up to the mount, standing at it with the element as its own,
 *   on a branch of its own, holding for whatever it `requires`. The parent's answer is the tasks it
 *   made; the engine then ends the parent unless a rule on the mount fires.
 *
 * ## The rows are the record
 *
 * Nothing here keeps a table of what it made. Each element's task is MIRRORED into the parent's
 * journal as an `instance.entered` whose instance id IS the task's id, and its end as an
 * `instance.terminated` — the rows a projection needs to draw the parent standing at the mount,
 * and the rows the engine hands back on a resume (`request.loaded`). A task made and not yet
 * mirrored (a crash between the two) is found again by its provenance, which every task made here
 * carries in its meta; so a resumed fan-out never makes an element twice.
 */
import type { Failure, ResolvedValue } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import { combineElements, uuidv7, type ElementTermination, type EngineEvent, type FanOutHost, type FanOutOutcome, type FanOutRequest, type LoadedInstance, type SpawnFields, type TerminationOutcome, type WorkflowBundle } from "@declarative-ai/hw";
import { createTask, forkTask as copyTaskPrefix, gitFor, type Project, type TaskRuntimeRow, type TaskWorkspace } from "@jaira/persistence";
import { isTerminalStatus, type TaskMeta, type TaskProvenance } from "@jaira/shared";

export interface FanOutDeps {
  project: Project;
  /** The task whose run mounted the fan-out — the parent of everything made here. */
  taskId: string;
  meta: TaskMeta;
  /** The parent's pinned workflow — a mount task runs it re-rooted at the mounted state. */
  bundle: WorkflowBundle;
  workspace: TaskWorkspace;
  /** Start a task in this process — fresh, or resumed where it has history. Resolves once it is running. */
  startTask: (taskId: string, options: { bundle?: WorkflowBundle }) => Promise<void>;
  /** Resolves when the task's row is terminal, or when `signal` fires, with the row as it stands. */
  waitForTask: (taskId: string, signal: AbortSignal) => Promise<TaskRuntimeRow>;
  /** Stop a running task — what a parent's abort does to the tasks it is waiting on. */
  cancelTask: (taskId: string) => void;
  /** The task list changed. */
  tasksChanged: () => void;
  log: (level: "info" | "warn" | "error", message: string, taskId?: string) => void;
  now?: () => number;
}

/** The host seam for one parent run. */
export function fanOutHostFor(deps: FanOutDeps): FanOutHost {
  return async (request) => {
    try {
      return request.kind === "split" ? await split(deps, request) : await tasks(deps, request);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      deps.log("error", `child '${request.key}' (each: "${request.kind}") failed: ${reason}`, deps.taskId);
      return { outcome: "error", failure: { classification: "permanent", reason: `child '${request.key}': ${reason}` } };
    }
  };
}

/** One element as the host sees it: its position, its resolved inputs, and the item on the axis. */
interface Element {
  index: number;
  inputs: Record<string, ResolvedValue>;
  item: JsonValue;
  id: string;
  title: string;
  requires: string[];
}

/** The batch: every element the request describes, from the rows it recorded and the list it re-read. */
function batchOf(request: FanOutRequest, fallbackTitle: string): Element[] {
  const axis = Object.keys(request.exprs)[0];
  const rows = new Map<number, LoadedInstance>((request.loaded ?? []).map((row) => [row.element ?? 0, row]));
  const count = Math.max(request.elements.length, rows.size > 0 ? Math.max(...rows.keys()) + 1 : 0);
  const elements: Element[] = [];
  for (let index = 0; index < count; index++) {
    const inputs = request.elements[index]?.inputs ?? rows.get(index)?.inputs;
    if (inputs === undefined) {
      throw new Error(`element ${index} was never recorded and the list cannot be re-read now`);
    }
    const item = (axis !== undefined ? inputs[axis] : undefined) as JsonValue;
    elements.push({
      index,
      inputs,
      item,
      id: stringField(item, request.spawn.id) ?? String(index),
      title: stringField(item, request.spawn.title) ?? `${fallbackTitle} · ${request.key} ${index + 1}`,
      requires: listField(item, request.spawn.requires),
    });
  }
  checkRequires(elements, request.spawn);
  return elements;
}

function stringField(item: JsonValue, name: string): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const value = (item as Record<string, JsonValue>)[name];
  return typeof value === "string" && value.length > 0 ? value : typeof value === "number" ? String(value) : undefined;
}

function listField(item: JsonValue, name: string): string[] {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
  const value = (item as Record<string, JsonValue>)[name];
  return Array.isArray(value) ? value.flatMap((v) => (typeof v === "string" ? [v] : typeof v === "number" ? [String(v)] : [])) : [];
}

/**
 * `requires` names ids in THIS batch, and no chain of them comes back on itself. Refused before
 * anything is made: a dependency on nothing would hold forever, and a cycle would hold twice.
 */
function checkRequires(elements: readonly Element[], spawn: SpawnFields): void {
  const byId = new Map(elements.map((e) => [e.id, e] as const));
  if (byId.size !== elements.length) {
    const seen = new Set<string>();
    const dup = elements.find((e) => (seen.has(e.id) ? true : (seen.add(e.id), false)));
    throw new Error(`two elements share the id '${dup?.id}' (field '${spawn.id}')`);
  }
  for (const element of elements) {
    for (const id of element.requires) {
      if (!byId.has(id)) throw new Error(`element '${element.id}' requires '${id}', which is not in the batch (field '${spawn.requires}')`);
    }
  }
  const state = new Map<string, "open" | "done">();
  const visit = (id: string, trail: string[]): void => {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "open") throw new Error(`the requires of ${[...trail, id].join(" → ")} form a cycle`);
    state.set(id, "open");
    for (const next of byId.get(id)!.requires) visit(next, [...trail, id]);
    state.set(id, "done");
  };
  for (const element of elements) visit(element.id, []);
}

/** A task this parent already made for this element, by the provenance every such task carries. */
function existingOf(deps: FanOutDeps, kind: TaskProvenance["kind"], request: FanOutRequest, index: number): TaskMeta | undefined {
  return deps.project.tasks
    .list()
    .find(
      (meta) =>
        meta.origin?.kind === kind &&
        meta.origin.taskId === deps.taskId &&
        meta.origin.key === request.key &&
        (meta.origin.occurrence ?? 0) === request.occurrence &&
        meta.origin.index === index,
    );
}

function provenanceOf(deps: FanOutDeps, kind: TaskProvenance["kind"], request: FanOutRequest, element: Element): TaskProvenance {
  return {
    kind,
    taskId: deps.taskId,
    key: request.key,
    ...(request.occurrence !== 0 ? { occurrence: request.occurrence } : {}),
    index: element.index,
    item: element.id,
    ...(kind === "split" && request.spawn.start === "when_ready" ? { start: "when_ready" as const } : {}),
  };
}

/** The mirrored entry of an element in the PARENT's journal — the task's id is the instance's. */
function mirrorEntered(deps: FanOutDeps, request: FanOutRequest, element: Element, taskId: string): void {
  const event: EngineEvent = {
    type: "instance.entered",
    instanceId: taskId,
    stateId: request.state,
    childKey: request.key,
    parentInstanceId: request.instanceId,
    element: element.index,
    inputs: element.inputs,
  };
  deps.project.events.recorder(deps.taskId).record(event, (deps.now ?? Date.now)());
}

function mirrorTerminated(deps: FanOutDeps, request: FanOutRequest, taskId: string, term: ElementTermination): void {
  const event: EngineEvent = {
    type: "instance.terminated",
    instanceId: taskId,
    stateId: request.state,
    outcome: term.outcome,
    ...(term.failure !== undefined ? { failure: term.failure } : {}),
  };
  deps.project.events.recorder(deps.taskId).record(event, (deps.now ?? Date.now)());
}

/** A git ref segment from an element id — what a split copy's branch is named by. */
function refSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "element";
}

// ---------------------------------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------------------------------

async function split(deps: FanOutDeps, request: FanOutRequest): Promise<FanOutOutcome> {
  const axis = Object.keys(request.exprs)[0];
  const expr = axis !== undefined ? request.exprs[axis] : undefined;
  if (expr === undefined) throw new Error("a split has no axis");
  const elements = batchOf(request, deps.meta.title);
  const rows = new Map<number, LoadedInstance>((request.loaded ?? []).map((row) => [row.element ?? 0, row]));
  const made = new Map<number, string>();
  for (const [index, row] of rows) made.set(index, row.id);

  // Every copy first, then the mirrors: a copy takes the parent's journal as it stands, and a mirror
  // of element 0 in that journal would arrive in element 1's copy as a settled element under the
  // very mount the copy is to stand at.
  const last = deps.project.events.list(deps.taskId).at(-1)?.seq ?? 0;
  // A copy gets a branch of its own where a branch can exist: a checkout. A project directory that
  // is not one takes unbound copies, as it takes unbound tasks — a binding there would refuse at
  // start, and this is where it can still be decided.
  const checkout = deps.project.kind === "project" && (await gitFor(deps.project, deps.project.paths.projectDir).isRepo());
  for (const element of elements) {
    if (made.has(element.index)) continue;
    const existing = existingOf(deps, "split", request, element.index);
    if (existing !== undefined) {
      made.set(element.index, existing.id);
      continue;
    }
    const branch = !checkout ? null : deps.meta.branch !== undefined ? `${deps.meta.branch}/${refSegment(element.id)}` : refSegment(element.id);
    const fork = copyTaskPrefix(deps.project, deps.taskId, last + 1, {
      standing: "queued",
      title: element.title,
      branch,
      parentTaskId: deps.taskId,
      origin: provenanceOf(deps, "split", request, element),
      split: [...(deps.meta.split ?? []), { expr, index: element.index }],
      ofLiveTask: true,
      nowMs: (deps.now ?? Date.now)(),
    });
    // The copy stands AT the mount: entered, element 0 of the one-element batch its narrowed list
    // will be, with the element's inputs — and nothing after, so its load dispatches from here.
    const entered: EngineEvent = {
      type: "instance.entered",
      instanceId: uuidv7((deps.now ?? Date.now)()),
      stateId: request.state,
      childKey: request.key,
      parentInstanceId: fork.instanceIds.get(request.instanceId) ?? request.instanceId,
      element: 0,
      inputs: element.inputs,
    };
    deps.project.events.recorder(fork.taskId).record(entered, (deps.now ?? Date.now)());
    made.set(element.index, fork.taskId);
    deps.log("info", `split element ${element.index + 1} of ${request.key} ('${element.title}') as ${fork.taskId}`, deps.taskId);
  }

  // Dependencies, now that every id has a task. Written once; a resumed split finds them written.
  const taskOf = new Map(elements.map((e) => [e.id, made.get(e.index)!] as const));
  for (const element of elements) {
    if (element.requires.length === 0) continue;
    const taskId = made.get(element.index)!;
    const meta = deps.project.tasks.tryRead(taskId);
    if (meta === undefined || meta.dependsOn !== undefined) continue;
    deps.project.tasks.write({ ...meta, dependsOn: element.requires.map((id) => taskOf.get(id)!) });
  }

  // The parent's own record of what it made, where the rows were not already there.
  for (const element of elements) {
    if (rows.has(element.index)) continue;
    mirrorEntered(deps, request, element, made.get(element.index)!);
    mirrorTerminated(deps, request, made.get(element.index)!, { outcome: "success" });
  }
  deps.tasksChanged();

  // A split that starts itself starts what has nothing to wait for; the rest are released by their
  // dependencies finishing, which the service watches for.
  if (request.spawn.start === "when_ready") {
    for (const element of elements) {
      if (element.requires.length > 0) continue;
      const taskId = made.get(element.index)!;
      const row = deps.project.runtime.get(taskId);
      if (row?.status !== "queued") continue;
      await deps.startTask(taskId, {});
    }
  }

  return {
    outcome: "success",
    outputs: { tasks: elements.map((e) => ({ id: e.id, taskId: made.get(e.index)!, title: e.title })) as unknown as ResolvedValue },
  };
}

// ---------------------------------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------------------------------

async function tasks(deps: FanOutDeps, request: FanOutRequest): Promise<FanOutOutcome> {
  const elements = batchOf(request, deps.meta.title);
  const rows = new Map<number, LoadedInstance>((request.loaded ?? []).map((row) => [row.element ?? 0, row]));
  const childDef = deps.bundle.states[request.state];
  const rerooted: WorkflowBundle = { ...deps.bundle, rootId: request.state };

  const runOne = async (element: Element): Promise<ElementTermination> => {
    const row = rows.get(element.index);
    let taskId = row?.id ?? existingOf(deps, "task", request, element.index)?.id;
    if (taskId === undefined) {
      const meta = createTask(deps.project, {
        title: element.title,
        workflow: request.state,
        inputs: element.inputs as Record<string, JsonValue>,
        parentTaskId: deps.taskId,
        origin: provenanceOf(deps, "task", request, element),
      });
      taskId = meta.id;
      mirrorEntered(deps, request, element, taskId);
      deps.tasksChanged();
      deps.log("info", `made element ${element.index + 1} of ${request.key} ('${element.title}') as ${taskId}`, deps.taskId);
    } else if (row === undefined) {
      // Made, never mirrored — the crash the provenance lookup exists for.
      mirrorEntered(deps, request, element, taskId);
    }
    // A row that has already ended is history; anything else is work to start or continue.
    let standing = deps.project.runtime.get(taskId);
    if (standing === undefined) throw new Error(`task '${taskId}' made for element ${element.index} is gone`);
    if (!isTerminalStatus(standing.status)) {
      if (request.signal.aborted) return { outcome: "canceled" };
      if (standing.status !== "running" && standing.status !== "stopping") await deps.startTask(taskId, { bundle: rerooted });
      const onAbort = (): void => deps.cancelTask(taskId!);
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        standing = await deps.waitForTask(taskId, request.signal);
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    }
    const term = terminationOf(standing);
    if (row === undefined || row.live) mirrorTerminated(deps, request, taskId, term);
    return term;
  };

  const terms: ElementTermination[] = [];
  if (request.async) {
    terms.push(...(await Promise.all(elements.map(runOne))));
  } else {
    for (const element of elements) {
      const term = await runOne(element);
      terms.push(term);
      if (term.outcome !== "success") break;
    }
  }
  return combineElements(request.key, childDef, terms);
}

/** How a task's row reads as an element's termination. */
function terminationOf(row: TaskRuntimeRow): ElementTermination {
  const failure = row.failureJson !== undefined ? (JSON.parse(row.failureJson) as Failure) : undefined;
  const outcome: TerminationOutcome =
    row.status === "completed" && (row.outcome === undefined || row.outcome === "success")
      ? "success"
      : row.status === "canceled" || row.outcome === "canceled"
        ? "canceled"
        : "error";
  if (outcome === "success") {
    const outputs = row.outputsJson !== undefined ? (JSON.parse(row.outputsJson) as Record<string, ResolvedValue>) : {};
    return { outcome, outputs };
  }
  return {
    outcome,
    failure: failure ?? { classification: "permanent", reason: `task '${row.taskId}' ended ${row.status}${row.outcome !== undefined ? ` (${row.outcome})` : ""}` },
  };
}
