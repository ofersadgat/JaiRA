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
import type {
  BlockedChild,
  BoardCard,
  BoardColumn,
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
  return {
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

/** Status of the deepest live instance — what a card's badge shows. */
function activeStatusOf(run: ProjectedRun): InstanceStatus | undefined {
  const deepest = run.activePath[run.activePath.length - 1];
  if (deepest === undefined) return undefined;
  return flattenInstances(run.instances).find((n) => n.instanceId === deepest.instanceId)?.status;
}

/**
 * Project one board level: columns are the level state's declared children (in
 * declaration/sequence order), and each task is placed in the column its active
 * path enters at that level.
 *
 * A task whose path reaches the level but no further sits in `atLevel` (the
 * level's own operation is running); a terminal task has no active path at all
 * and lands in `finished`.
 */
export function projectBoard(
  shape: WorkflowShape,
  level: string,
  tasks: readonly TaskProjection[],
  options?: { breadcrumb?: string[] },
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
    const path = task.run.activePath;
    if (TERMINAL.has(task.status) || path.length === 0) {
      finished.push(cardOf(task, path, 0));
      continue;
    }
    // Where does this path sit relative to `level`?
    const at = path.findIndex((step) => step.stateId === level);
    if (at < 0) continue; // the path doesn't pass through this level
    const next = path[at + 1];
    const card = cardOf(task, path, at, activeStatusOf(task.run));
    const column = next?.childKey !== undefined ? byKey.get(next.childKey) : undefined;
    if (column) column.cards.push(card);
    else atLevel.push(card);
  }

  return {
    level,
    ...(levelShape?.label !== undefined ? { label: levelShape.label } : {}),
    breadcrumb: options?.breadcrumb ?? [level],
    columns,
    atLevel,
    finished,
  };
}

/** The breadcrumb from the workflow root down to `level`, inclusive. */
export function breadcrumbOf(shape: WorkflowShape, rootId: string, level: string): string[] {
  if (rootId === level) return [rootId];
  const seen = new Set<string>();
  const walk = (id: string, trail: string[]): string[] | undefined => {
    if (id === level) return [...trail, id];
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const child of shape[id]?.children ?? []) {
      const hit = walk(child.stateId, [...trail, id]);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(rootId, []) ?? [level];
}
