/**
 * View models (DESIGN §11): what the renderer renders. These are plain
 * serializable shapes — the renderer never touches the engine or the database,
 * it only ever sees these (DESIGN §2, "the renderer never touches the engine
 * directly"), so every one of them must survive an IPC round-trip as JSON.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { TaskStatus } from "./task";

/**
 * Per-instance status, derived from the event journal (SPEC §10.1). `blocked` is
 * an input-wiring failure; `waiting_for_user` is an interactive operation that
 * has started and not returned.
 */
export type InstanceStatus =
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled"
  | "timeout";

/** The operation an instance is running, as far as the journal shows. */
export interface OperationView {
  kind: "prompt" | "function";
  status: "running" | "completed" | "failed";
  /** Failure reason when `status === "failed"`. */
  reason?: string;
  costUsd?: number;
}

/** One state instance in a task's tree. */
export interface InstanceNode {
  instanceId: number;
  stateId: string;
  /** Key in the parent's `children` map — distinct from `stateId`, since one
   *  state file can be mounted under several keys. */
  childKey?: string;
  parentInstanceId?: number;
  status: InstanceStatus;
  /** Transitions taken so far (SPEC §3.4). */
  iteration: number;
  operation?: OperationView;
  /**
   * True once a sequence reset cleared this instance (DESIGN §4.2): history is
   * preserved, but it no longer contributes to the active path or to
   * `children.<key>` resolution.
   */
  superseded: boolean;
  startedAt: number;
  endedAt?: number;
  children: InstanceNode[];
}

/** A child that never became an instance because its input wiring failed. */
export interface BlockedChild {
  stateId: string;
  reason: string;
}

/** One step of the active path, outermost first. */
export interface PathStep {
  instanceId: number;
  stateId: string;
  childKey?: string;
}

/** A card on the board: one task, positioned by where its active path runs. */
export interface BoardCard {
  taskId: string;
  title: string;
  /** Task-level status (the runtime row), not the instance status. */
  status: TaskStatus;
  workflow: string;
  /** The deepest active instance's status — what the badge shows. */
  activeStatus?: InstanceStatus;
  /** State id of the deepest active instance. */
  activeStateId?: string;
  activePath: PathStep[];
  /** True when the active path continues below this board level (drill-down). */
  hasSubBoard: boolean;
  labels?: string[];
  updatedAt: number;
}

/** One column of a board level: a declared child of the level's state. */
export interface BoardColumn {
  /** The parent's `children` key — the column's identity. */
  key: string;
  stateId: string;
  label?: string;
  cards: BoardCard[];
}

/**
 * One board level. The root board's `level` is the workflow root; drilling into
 * a card whose active state has children yields that state's board.
 */
export interface BoardView {
  /** State id this board shows the children of. */
  level: string;
  label?: string;
  /** Breadcrumb from the workflow root down to `level`, inclusive. */
  breadcrumb: string[];
  columns: BoardColumn[];
  /**
   * Cards whose active path reaches this level but is not inside any declared
   * child — the level's own operation is running (or it has just been entered).
   */
  atLevel: BoardCard[];
  /** Tasks in a terminal state (completed/failed/canceled), which have no active path. */
  finished: BoardCard[];
}

/** A recorded event, as the detail view's timeline shows it. */
export interface TimelineEntry {
  seq: number;
  runId: number;
  type: string;
  at: number;
  instanceId?: number;
  stateId?: string;
  /** The event payload, for the raw view. */
  event: JsonValue;
}

/** One execution attempt of a task. */
export interface RunView {
  runId: number;
  outcome: "success" | "error" | "canceled" | "interrupted" | "running";
  snapshotHash: string;
  startedAt: number;
  endedAt?: number;
  outputs?: JsonValue;
  failure?: JsonValue;
}

/** The task detail panel (DESIGN §11.1). */
export interface TaskDetail {
  taskId: string;
  title: string;
  description?: string;
  labels?: string[];
  workflow: string;
  status: TaskStatus;
  snapshotHash?: string;
  branch?: string;
  /** Git worktree this task runs in, when bound to a branch (DESIGN §9.2). */
  worktreePath?: string;
  createdAt: string;
  inputs?: Record<string, JsonValue>;
  /** Instance forest for the latest run (roots first). */
  instances: InstanceNode[];
  activePath: PathStep[];
  blocked: BlockedChild[];
  runs: RunView[];
  /** Most recent events last. */
  timeline: TimelineEntry[];
}

// --- workflow browser (DESIGN §11.1) ----------------------------------------

/** Errors block a task start (§5.2); warnings are advisory. */
export type LintSeverity = "error" | "warning";

/**
 * One lint diagnostic. Structurally the engine's `ValidationIssue` plus a
 * severity — restated here so the renderer's types never reach into
 * `@declarative-ai/hw`.
 */
export interface LintIssue {
  stateId: string;
  /** Where in the state file, e.g. `transitions[2].when`. */
  path: string;
  message: string;
  severity: LintSeverity;
}

/** One state file in the browser's tree. */
export interface WorkflowFileEntry {
  stateId: string;
  /** Path relative to `.jaira/workflows/`, forward slashes. */
  file: string;
  label?: string;
  /** Set when the file could not be read or parsed (the author is mid-edit). */
  error?: string;
}

/** A workflow root and its lint state. */
export interface WorkflowEntry {
  rootId: string;
  label?: string;
  /** Every state in the root's transitive closure, in id order. */
  states: string[];
  /** Identity of the workflow as it stands on disk, comparable to a task's pin. */
  snapshotHash?: string;
  issues: LintIssue[];
  /** Set when the bundle could not be loaded at all, so `issues` is empty. */
  loadError?: string;
  taskIds: string[];
  /** Tasks pinned to a snapshot other than what is on disk now. */
  driftedTasks: string[];
}

export interface WorkflowBrowser {
  workflows: WorkflowEntry[];
  files: WorkflowFileEntry[];
  /** States no root reaches — a reference cycle, or a failed load above them. */
  unreachable: string[];
}

// --- history pruning (SPEC §13) ----------------------------------------------

/** One run's worth of history in a prune plan. */
export interface PrunePlanEntry {
  taskId: string;
  runId: number;
  endedAt?: number;
  events: number;
  commands: number;
}

/** What a prune did, or (when `dryRun`) would do. */
export interface PruneResult {
  runs: PrunePlanEntry[];
  events: number;
  commands: number;
  /** Tasks the §13 safety rule refused to touch, with the reason. */
  skippedTasks: Array<{ taskId: string; status: string; reason: string }>;
  dryRun: boolean;
}

/** Rows currently stored — the "before you prune" summary. */
export interface HistorySize {
  runs: number;
  events: number;
  commands: number;
}

/** A row in the task list. */
export interface TaskSummary {
  taskId: string;
  title: string;
  status: TaskStatus;
  workflow: string;
  labels?: string[];
  snapshotHash?: string;
  createdAt: string;
  updatedAt: number;
}
