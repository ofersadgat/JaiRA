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
 * - `"split"` — element 0 STAYS in this task, which continues with it as its own (the engine is
 *   answered "continue"); every other element becomes a copy of this task up to the mount, standing
 *   at it with the element as its own, on a branch of its own, holding for whatever it `requires`
 *   and started the moment it holds for nothing — unless the wire says `start: "manual"`, which
 *   leaves every start to a person. This task holds the same way for whatever element 0 requires,
 *   in-process, before it answers. A split over ONE element never arrives here: the engine runs it
 *   inline, since there is nothing to put beside the parent.
 *
 * ## The record is written before anything is made
 *
 * A `fanout.made` row in this task's journal lists every element's task id — this task's own for a
 * split's element 0 — and it is written BEFORE any copy is cut or any task created, so that a copy
 * cut after it carries the same list, and so that a host asked again after a crash finds the ids it
 * chose and makes only what is still missing. Every task in the batch draws the line at the mount
 * from that one row, each excluding itself.
 *
 * A `"task"` mount's elements are also MIRRORED into the parent's journal as `instance.entered`
 * rows whose instance id IS the task's id, and their ends as `instance.terminated` — the rows the
 * engine hands back on a resume (`request.loaded`), since the parent's mount is history it reads
 * through the host. A split writes no such rows: its own element is a real instance here, and the
 * copies are elsewhere.
 */
import type { Failure, ResolvedValue } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import { combineElements, uuidv7, type ElementTermination, type EngineEvent, type FanOutHost, type FanOutOutcome, type FanOutRequest, type LoadedInstance, type SpawnFields, type TerminationOutcome, type WorkflowBundle } from "@declarative-ai/hw";
import { createTask, forkTask as copyTaskPrefix, gitFor, type Project, type TaskRuntimeRow, type TaskWorkspace } from "@jaira/persistence";
import { isTerminalStatus, newTaskId, type TaskMeta, type TaskProvenance } from "@jaira/shared";

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
    ...(kind === "split" ? { start: request.spawn.start } : {}),
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
// the record
// ---------------------------------------------------------------------------------------------------

/**
 * The `fanout.made` row this mount already wrote, when it did — the batch's task ids by element.
 * Written before anything is made (see {@link recordMade}), so a host asked again after a crash
 * finds the ids it had already chosen and makes only what is still missing.
 */
function recordedRuns(deps: FanOutDeps, request: FanOutRequest): Map<number, string> | undefined {
  for (const stored of deps.project.events.list(deps.taskId)) {
    const event = stored.event;
    if (event.type !== "fanout.made" || event.childKey !== request.key || event.occurrence !== request.occurrence) continue;
    return new Map(event.runs.map((run) => [run.element, run.runId]));
  }
  return undefined;
}

/** The record of the batch, in this task's journal, before the runs exist — so a copy cut after it carries it too. */
function recordMade(deps: FanOutDeps, request: FanOutRequest, elements: readonly Element[], ids: ReadonlyMap<number, string>): void {
  const event: EngineEvent = {
    type: "fanout.made",
    instanceId: request.instanceId,
    stateId: request.stateId,
    childKey: request.key,
    occurrence: request.occurrence,
    kind: request.kind,
    runs: elements.map((element) => ({ element: element.index, id: element.id, runId: ids.get(element.index)!, title: element.title })),
  };
  deps.project.events.recorder(deps.taskId).record(event, (deps.now ?? Date.now)());
}

// ---------------------------------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------------------------------

async function split(deps: FanOutDeps, request: FanOutRequest): Promise<FanOutOutcome> {
  const axis = Object.keys(request.exprs)[0];
  const expr = axis !== undefined ? request.exprs[axis] : undefined;
  if (expr === undefined) throw new Error("a split has no axis");
  if ((request.loaded ?? []).length > 0) throw new Error("a split's mount is continued from its own element, never from recorded rows");
  const elements = batchOf(request, deps.meta.title);
  // Nothing to split over: nothing is made, and this task ends after the mount as a split does.
  if (elements.length === 0) return { outcome: "success", outputs: { tasks: [] as unknown as ResolvedValue } };
  const now = deps.now ?? Date.now;

  // Element 0 is this task's own. The rest become copies, under ids chosen — and recorded — before
  // any copy is cut, so every copy carries the same list and a host asked again finds the same ids.
  const recorded = recordedRuns(deps, request);
  const ids = new Map<number, string>();
  for (const element of elements) {
    ids.set(element.index, element.index === 0 ? deps.taskId : (recorded?.get(element.index) ?? existingOf(deps, "split", request, element.index)?.id ?? newTaskId()));
  }
  if (recorded === undefined) recordMade(deps, request, elements, ids);
  const taskOf = new Map(elements.map((element) => [element.id, ids.get(element.index)!] as const));
  const dependsOnOf = (element: Element): string[] => element.requires.map((id) => taskOf.get(id)!);

  // A copy takes this task's journal as it stands, the record included. A copy gets a branch of its
  // own where a branch can exist: a checkout. A project directory that is not one takes unbound
  // copies, as it takes unbound tasks — a binding there would refuse at start, and this is where it
  // can still be decided.
  const last = deps.project.events.list(deps.taskId).at(-1)?.seq ?? 0;
  const checkout = deps.project.kind === "project" && (await gitFor(deps.project, deps.project.paths.projectDir).isRepo());
  const base = deps.meta.split ?? [];
  for (const element of elements) {
    if (element.index === 0) continue;
    const taskId = ids.get(element.index)!;
    if (deps.project.runtime.get(taskId) !== undefined) continue;
    const branch = !checkout ? null : deps.meta.branch !== undefined ? `${deps.meta.branch}/${refSegment(element.id)}` : refSegment(element.id);
    const fork = copyTaskPrefix(deps.project, deps.taskId, last + 1, {
      id: taskId,
      standing: "queued",
      title: element.title,
      branch,
      parentTaskId: deps.taskId,
      origin: provenanceOf(deps, "split", request, element),
      split: [...base, { expr, index: element.index }],
      dependsOn: dependsOnOf(element),
      ofLiveTask: true,
      nowMs: now(),
    });
    // The copy stands AT the mount: entered, element 0 of the one-element batch its narrowed list
    // will be, with the element's inputs — and nothing after, so its load dispatches from here.
    const entered: EngineEvent = {
      type: "instance.entered",
      instanceId: uuidv7(now()),
      stateId: request.state,
      childKey: request.key,
      parentInstanceId: fork.instanceIds.get(request.instanceId) ?? request.instanceId,
      element: 0,
      inputs: element.inputs,
    };
    deps.project.events.recorder(fork.taskId).record(entered, now());
    deps.log("info", `split element ${element.index + 1} of ${request.key} ('${element.title}') as ${fork.taskId}`, deps.taskId);
  }

  // This task's own standing, written once: split on the list at element 0 — what makes every later
  // mount over the list narrow to it — titled by its element where the element has a title, and
  // holding for whatever element 0 requires, the way a copy holds.
  const own = elements[0]!;
  const mine = deps.project.tasks.read(deps.taskId);
  if (!(mine.split ?? []).some((entry) => entry.expr === expr)) {
    const titled = stringField(own.item, request.spawn.title);
    const requires = dependsOnOf(own);
    deps.project.tasks.write({
      ...mine,
      split: [...base, { expr, index: 0 }],
      ...(titled !== undefined ? { title: titled } : {}),
      ...(requires.length > 0 ? { dependsOn: requires } : {}),
    });
  }
  deps.tasksChanged();

  // What has nothing to wait for starts now; the rest are released by their dependencies finishing,
  // which the service watches for. A wire that says `start: "manual"` leaves both to a person: a
  // holding task then stands where it was put until someone presses Start.
  if (request.spawn.start !== "manual") {
    for (const element of elements) {
      if (element.index === 0 || element.requires.length > 0) continue;
      const taskId = ids.get(element.index)!;
      if (deps.project.runtime.get(taskId)?.status !== "queued") continue;
      await deps.startTask(taskId, {});
    }
  }

  // Element 0 holds HERE, in this process, for what it requires — the same holding a copy does
  // standing queued, and read the same way by the board and the list (`dependsOn` on the meta).
  // A task stopped while holding holds by its row instead, and is released as a copy is.
  for (const dependency of dependsOnOf(own)) {
    const row = await deps.waitForTask(dependency, request.signal);
    if (request.signal.aborted) return { outcome: "canceled" };
    if (row.status !== "completed") {
      const title = deps.project.tasks.tryRead(dependency)?.title ?? dependency;
      return { outcome: "error", failure: { classification: "permanent", reason: `element '${own.id}' waits for '${title}', which ended ${row.status}` } };
    }
  }
  return { outcome: "continue", index: 0 };
}

// ---------------------------------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------------------------------

async function tasks(deps: FanOutDeps, request: FanOutRequest): Promise<FanOutOutcome> {
  const elements = batchOf(request, deps.meta.title);
  const rows = new Map<number, LoadedInstance>((request.loaded ?? []).map((row) => [row.element ?? 0, row]));
  const childDef = deps.bundle.states[request.state];
  const rerooted: WorkflowBundle = { ...deps.bundle, rootId: request.state };

  // Every task first, under ids recorded before any is made — the list the line at the mount draws
  // — and mirrored into this task's journal; then run, in order unless the mount is `async`.
  const recorded = recordedRuns(deps, request);
  const ids = new Map<number, string>();
  for (const element of elements) {
    ids.set(element.index, rows.get(element.index)?.id ?? recorded?.get(element.index) ?? existingOf(deps, "task", request, element.index)?.id ?? newTaskId());
  }
  if (recorded === undefined && elements.length > 0) recordMade(deps, request, elements, ids);
  for (const element of elements) {
    const taskId = ids.get(element.index)!;
    if (deps.project.runtime.get(taskId) === undefined) {
      createTask(deps.project, {
        id: taskId,
        title: element.title,
        workflow: request.state,
        inputs: element.inputs as Record<string, JsonValue>,
        parentTaskId: deps.taskId,
        origin: provenanceOf(deps, "task", request, element),
      });
      deps.log("info", `made element ${element.index + 1} of ${request.key} ('${element.title}') as ${taskId}`, deps.taskId);
    }
    // Made, never mirrored — the crash the provenance lookup exists for — or made just now.
    if (!rows.has(element.index)) mirrorEntered(deps, request, element, taskId);
  }
  deps.tasksChanged();

  const runOne = async (element: Element): Promise<ElementTermination> => {
    const row = rows.get(element.index);
    const taskId = ids.get(element.index)!;
    // A row that has already ended is history; anything else is work to start or continue.
    let standing = deps.project.runtime.get(taskId);
    if (standing === undefined) throw new Error(`task '${taskId}' made for element ${element.index} is gone`);
    if (!isTerminalStatus(standing.status)) {
      if (request.signal.aborted) return { outcome: "canceled" };
      if (standing.status !== "running" && standing.status !== "stopping") await deps.startTask(taskId, { bundle: rerooted });
      const onAbort = (): void => deps.cancelTask(taskId);
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
