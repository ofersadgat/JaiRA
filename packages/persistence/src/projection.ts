/**
 * Board and task-detail projection (DESIGN §11, §12).
 *
 * The engine's `EngineEvent` journal is the only source: folding it yields the
 * instance tree, each instance's status, and the active path. That is what makes
 * DESIGN §12's guarantee real — "task status is derived from its instance tree,
 * so the board never disagrees with the engine" — instead of the UI keeping its
 * own parallel state machine.
 *
 * Two event shapes need care:
 *  - `child.superseded` carries the **parent's** instanceId plus the cleared
 *    child key (a sequence reset, SPEC §3.3). History is kept; superseded
 *    instances just stop counting as active.
 *  - `instance.blocked` carries `instanceId: -1` — an input-wiring failure means
 *    the child never became an instance, so it is recorded separately rather
 *    than as a phantom node.
 */
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import { resolveLabel } from "./runLabel";
import type {
  BlockedChild,
  BoardCard,
  BoardColumn,
  BoardCrumb,
  BoardView,
  InstanceNode,
  InstanceStatus,
  OperationView,
  PathStep,
  TaskStatus,
} from "@jaira/shared";
import type { StoredEvent } from "./eventLog";

/** A state's board-relevant shape, supplied by whoever holds the bundle. */
export interface StateShape {
  label?: string;
  /** Declared children, in board (column) order. */
  children: Array<{ key: string; stateId: string; label?: string }>;
  /** True when this state's operation needs a human (an interactive function). */
  interactive?: boolean;
}

/** The workflow shape a projection reads: state id → shape. */
export type WorkflowShape = Record<string, StateShape>;

interface MutableNode extends Omit<InstanceNode, "children"> {
  children: MutableNode[];
}

export interface ProjectedRun {
  /** Instance roots (normally one — the workflow root). */
  instances: InstanceNode[];
  /** Outermost-first chain of live instances. Empty once the root terminates. */
  activePath: PathStep[];
  blocked: BlockedChild[];
}

const OUTCOME_STATUS: Record<string, InstanceStatus> = {
  success: "completed",
  error: "failed",
  canceled: "canceled",
  timeout: "timeout",
};

/**
 * Fold a run's events into an instance forest.
 *
 * `shape` is optional and only sharpens status: an instance whose interactive
 * operation has started but not finished is `waiting_for_user` rather than a
 * generic `running`, which is what the board badge needs.
 */
/** The resolved inputs off an entry event, as plain JSON. Absent when the run recorded none. */
function inputsOf(event: Extract<EngineEvent, { type: "instance.entered" }>): Record<string, JsonValue> | undefined {
  const raw = event.inputs as Record<string, unknown> | undefined;
  if (raw === undefined) return undefined;
  const out: Record<string, JsonValue> = {};
  // A `ResolvedValue` wraps the value the engine settled on; anything not JSON-shaped (a stream, a
  // symbol) is dropped rather than stringified, because a card showing `[object Object]` is worse
  // than a card showing one input fewer.
  for (const [name, value] of Object.entries(raw)) {
    const unwrapped = value !== null && typeof value === "object" && "value" in value
      ? (value as { value: unknown }).value
      : value;
    if (unwrapped === undefined || typeof unwrapped === "function" || typeof unwrapped === "symbol") continue;
    out[name] = unwrapped as JsonValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** This run's name, resolved from the state's `label` against its own inputs — see `resolveLabel`. */
function runLabelOf(
  event: Extract<EngineEvent, { type: "instance.entered" }>,
  shape?: WorkflowShape,
): string | undefined {
  const declared = shape?.[event.stateId]?.label;
  return resolveLabel(declared, inputsOf(event) ?? {}).label;
}

export function projectRun(events: readonly EngineEvent[], shape?: WorkflowShape, atMs?: readonly number[]): ProjectedRun {
  const byId = new Map<number, MutableNode>();
  const roots: MutableNode[] = [];
  const blocked: BlockedChild[] = [];
  /** parent instanceId → child keys cleared by a sequence reset. */
  const supersededKeys = new Map<number, Set<string>>();

  events.forEach((event, i) => {
    const at = atMs?.[i] ?? 0;
    switch (event.type) {
      case "instance.entered": {
        const node: MutableNode = {
          instanceId: event.instanceId,
          stateId: event.stateId,
          ...(event.childKey !== undefined ? { childKey: event.childKey } : {}),
          ...(event.parentInstanceId !== undefined ? { parentInstanceId: event.parentInstanceId } : {}),
          status: "running",
          iteration: 0,
          superseded: false,
          startedAt: at,
          // What this run was CALLED WITH, and what to call it. Both come off the entry event, which
          // has carried the resolved inputs since the journal existed and projected them nowhere.
          // They are what tells four runs of one child apart: the state id, the child key and the
          // state's own name are identical across all of them.
          ...(inputsOf(event) !== undefined ? { inputs: inputsOf(event)! } : {}),
          ...(runLabelOf(event, shape) !== undefined ? { label: runLabelOf(event, shape)! } : {}),
          children: [],
        };
        byId.set(node.instanceId, node);
        const parent = event.parentInstanceId !== undefined ? byId.get(event.parentInstanceId) : undefined;
        if (parent) {
          // A re-entered child key (loop iteration) supersedes the previous
          // instance under that key even without an explicit reset event.
          if (node.childKey !== undefined) {
            for (const sibling of parent.children) {
              if (sibling.childKey === node.childKey && sibling.instanceId !== node.instanceId) {
                sibling.superseded = true;
              }
            }
          }
          parent.children.push(node);
        } else {
          roots.push(node);
        }
        break;
      }
      case "operation.started": {
        const node = byId.get(event.instanceId);
        if (!node) break;
        const interactive = event.op === "function" && shape?.[event.stateId]?.interactive === true;
        node.operation = { kind: event.op, status: "running" };
        if (interactive) node.status = "waiting_for_user";
        break;
      }
      case "operation.completed": {
        const node = byId.get(event.instanceId);
        if (!node) break;
        const op: OperationView = { kind: event.op, status: "completed" };
        const cost = event.metrics?.costUsd;
        if (typeof cost === "number") op.costUsd = cost;
        node.operation = op;
        if (node.status === "waiting_for_user") node.status = "running";
        break;
      }
      case "operation.failed": {
        const node = byId.get(event.instanceId);
        if (!node) break;
        node.operation = { kind: event.op, status: "failed", reason: event.failure.reason };
        if (node.status === "waiting_for_user") node.status = "running";
        break;
      }
      case "transition.taken": {
        const node = byId.get(event.instanceId);
        if (node) node.iteration = event.iteration;
        break;
      }
      case "child.superseded": {
        let keys = supersededKeys.get(event.instanceId);
        if (!keys) {
          keys = new Set();
          supersededKeys.set(event.instanceId, keys);
        }
        keys.add(event.childKey);
        const parent = byId.get(event.instanceId);
        if (parent) {
          for (const child of parent.children) {
            if (child.childKey === event.childKey) child.superseded = true;
          }
        }
        break;
      }
      case "instance.blocked": {
        // instanceId is the -1 sentinel: no instance exists to attach this to.
        blocked.push({ stateId: event.stateId, reason: event.reason });
        break;
      }
      case "instance.terminated": {
        const node = byId.get(event.instanceId);
        if (!node) break;
        node.status = OUTCOME_STATUS[event.outcome] ?? "failed";
        node.endedAt = at;
        if (event.failure !== undefined && node.operation !== undefined) {
          node.operation = { ...node.operation, status: "failed", reason: event.failure.reason };
        }
        break;
      }
    }
  });

  return { instances: roots, activePath: activePathOf(roots), blocked };
}

function isLive(node: MutableNode | InstanceNode): boolean {
  return !node.superseded && (node.status === "running" || node.status === "waiting_for_user" || node.status === "blocked");
}

/** The outermost-first chain of live instances: root → deepest running child. */
export function activePathOf(roots: readonly InstanceNode[]): PathStep[] {
  const path: PathStep[] = [];
  let level: readonly InstanceNode[] = roots;
  for (;;) {
    // The most recently entered live instance wins — a loop's later iteration.
    const node = [...level].reverse().find(isLive);
    if (!node) return path;
    path.push({
      instanceId: node.instanceId,
      stateId: node.stateId,
      ...(node.childKey !== undefined ? { childKey: node.childKey } : {}),
    });
    level = node.children;
  }
}

/**
 * The chain a run came to REST on: outermost-first, deepest last, live or not.
 *
 * {@link activePathOf} answers "where is this task now" and is empty the moment a run ends, which is
 * the right answer to that question and the wrong one for a board — a finished task is still a task
 * that went somewhere, and a board that only knows about live paths has nowhere to put it. So the
 * same walk, without the liveness test: the last non-superseded instance at each level, which for a
 * running task IS the active path and for a finished one is where it stopped.
 *
 * Superseded instances are skipped here as they are there. A loop's earlier iteration was replaced
 * by a later one, and the run does not rest on it.
 */
export function restingPathOf(roots: readonly InstanceNode[]): PathStep[] {
  const path: PathStep[] = [];
  let level: readonly InstanceNode[] = roots;
  for (;;) {
    const node = [...level].reverse().find((n) => !n.superseded);
    if (node === undefined) return path;
    path.push({
      instanceId: node.instanceId,
      stateId: node.stateId,
      ...(node.childKey !== undefined ? { childKey: node.childKey } : {}),
    });
    level = node.children;
  }
}

/**
 * Where a board should place this run: where it is, or where it stopped.
 *
 * One rule for both, so a card does not move to a different column at the moment its run ends.
 */
export function boardPathOf(run: ProjectedRun): PathStep[] {
  return run.activePath.length > 0 ? run.activePath : restingPathOf(run.instances);
}

/** Flatten a forest depth-first (roots first) — handy for tests and list views. */
export function flattenInstances(nodes: readonly InstanceNode[]): InstanceNode[] {
  const out: InstanceNode[] = [];
  const walk = (list: readonly InstanceNode[]): void => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Convert stored rows to the `(events, times)` pair `projectRun` folds. */
export function eventsOf(rows: readonly StoredEvent[]): { events: EngineEvent[]; atMs: number[] } {
  return { events: rows.map((r) => r.event), atMs: rows.map((r) => r.createdAt) };
}

// --- Board -------------------------------------------------------------------

/** One task's projected run plus the metadata a card needs. */
export interface TaskProjection {
  taskId: string;
  title: string;
  status: TaskStatus;
  workflow: string;
  labels?: string[];
  updatedAt: number;
  run: ProjectedRun;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "canceled"]);

/**
 * `levelIndex` is where this board's level sits on the task's active path. The
 * card is placed in the column at `levelIndex + 1`, so a drill-down is only
 * meaningful when the path continues *below* that column — hence `+ 2`.
 */
function cardOf(task: TaskProjection, path: PathStep[], levelIndex: number, activeStatus?: InstanceStatus): BoardCard {
  const deepest = path[path.length - 1];
  // Only for a run that is OVER. A live run has terminated instances behind it — every child it has
  // finished with — and reporting the newest of those as a completion date would put a date on a
  // card that is still moving.
  const ended = TERMINAL.has(task.status) ? endedAtOf(task.run) : undefined;
  return {
    ...(ended !== undefined ? { endedAt: ended } : {}),
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    workflow: task.workflow,
    ...(activeStatus !== undefined ? { activeStatus } : {}),
    ...(deepest !== undefined ? { activeStateId: deepest.stateId } : {}),
    activePath: path,
    hasSubBoard: path.length > levelIndex + 2,
    ...(task.labels !== undefined ? { labels: task.labels } : {}),
    updatedAt: task.updatedAt,
  };
}

/**
 * When a run ended: the last of its instances to terminate.
 *
 * The MAX rather than the root's own `endedAt`, because a root that was cancelled or that failed on
 * the way out is not guaranteed to be the last thing recorded, and "when was this over" should not
 * depend on which node happened to be written last. Undefined while anything is still open, which is
 * exactly the case where a card has no completion to report.
 */
export function endedAtOf(run: ProjectedRun): number | undefined {
  let ended: number | undefined;
  for (const node of flattenInstances(run.instances)) {
    if (node.endedAt !== undefined && (ended === undefined || node.endedAt > ended)) ended = node.endedAt;
  }
  return ended;
}

/** Status of the deepest live instance — what a card's badge shows. */
function activeStatusOf(run: ProjectedRun): InstanceStatus | undefined {
  const deepest = run.activePath[run.activePath.length - 1];
  if (deepest === undefined) return undefined;
  return flattenInstances(run.instances).find((n) => n.instanceId === deepest.instanceId)?.status;
}

/**
 * Project one board level: columns are the level state's declared children (in
 * declaration/sequence order), and each task is placed in the column its path
 * enters at that level.
 *
 * PATH, not active path — see {@link boardPathOf}. A finished task used to have
 * no active path and so no column, and every one of them piled into a tray at
 * the bottom of the board labelled with what it was not. It went somewhere; the
 * board says where, and the card's own status says that it is done.
 *
 * A task whose path reaches the level but no further sits in `atLevel` (the
 * level's own operation is running). One that never reached the level at all is
 * not on this board and is left off it.
 */
export function projectBoard(
  shape: WorkflowShape,
  level: string,
  tasks: readonly TaskProjection[],
  options?: { breadcrumb?: BoardCrumb[] },
): BoardView {
  const levelShape = shape[level];
  const columns: BoardColumn[] = (levelShape?.children ?? []).map((child) => ({
    key: child.key,
    stateId: child.stateId,
    ...(child.label ?? shape[child.stateId]?.label ? { label: child.label ?? shape[child.stateId]?.label } : {}),
    cards: [],
  }));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const atLevel: BoardCard[] = [];
  const finished: BoardCard[] = [];

  for (const task of tasks) {
    const path = boardPathOf(task.run);
    // Where does this path sit relative to `level`?
    const at = path.findIndex((step) => step.stateId === level);
    const card = cardOf(task, path, Math.max(at, 0), activeStatusOf(task.run));

    if (path.length === 0) {
      // Never run. It will BEGIN at its workflow root, so it is at this level exactly when this
      // level IS that root — the honest answer for a queued task, and the one that keeps it on the
      // board it is about to move through rather than in a tray of what the columns would not take.
      if (task.workflow === level) atLevel.push(card);
    } else if (at >= 0) {
      const next = path[at + 1];
      const column = next?.childKey !== undefined ? byKey.get(next.childKey) : undefined;
      if (column) column.cards.push(card);
      else atLevel.push(card);
    }

    /**
     * The census: runs that ENDED and that went through this level.
     *
     * Not a bucket — a card here is usually in a column too — and not the same question as where the
     * run came to rest, which is why it is asked of the whole instance tree rather than of the path.
     * A run that passed through `goals` on its way to `critique` rests in `critique` and has still
     * been to `goals`, and "what has run here" is exactly what `StateView.tasksRecent` asks.
     */
    if (TERMINAL.has(task.status) && flattenInstances(task.run.instances).some((n) => n.stateId === level)) {
      finished.push(card);
    }
  }

  return {
    level,
    ...(levelShape?.label !== undefined ? { label: levelShape.label } : {}),
    breadcrumb: options?.breadcrumb ?? [{ stateId: level, ...(levelShape?.label !== undefined ? { label: levelShape.label } : {}) }],
    columns,
    atLevel,
    finished,
  };
}

/**
 * The breadcrumb from the workflow root down to `level`, inclusive.
 *
 * Each step carries the name the BOARD would draw for it, resolved the same way a column's is: the
 * parent's declared override, then the state's own label. Without that the path spelled a state by
 * its file name while the column you clicked to get there spelled it by its title — see
 * {@link BoardCrumb}.
 */
export function breadcrumbOf(shape: WorkflowShape, rootId: string, level: string): BoardCrumb[] {
  const crumbOf = (stateId: string, declared?: string): BoardCrumb => {
    const label = declared ?? shape[stateId]?.label;
    return { stateId, ...(label !== undefined ? { label } : {}) };
  };
  const seen = new Set<string>();
  const walk = (id: string, trail: BoardCrumb[], declared?: string): BoardCrumb[] | undefined => {
    const here = [...trail, crumbOf(id, declared)];
    if (id === level) return here;
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const child of shape[id]?.children ?? []) {
      const hit = walk(child.stateId, here, child.label);
      if (hit) return hit;
    }
    return undefined;
  };
  // A level the walk cannot reach still gets a crumb: the path names where the board says it is.
  return walk(rootId, []) ?? [crumbOf(level)];
}
