/**
 * Task model (DESIGN §4.1, §12): the human-readable half of the hybrid store.
 * A TaskMeta is what lives in `.jaira/tasks/<taskId>.json`; runtime status and
 * history live in SQLite (@jaira/persistence) and reference tasks by id only.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { InputProvenance } from "./adopt";
import type { StoredConnectUndo } from "./connect";

export type TaskStatus =
  | "queued"
  | "running"
  /**
   * A stop has been ASKED FOR and the run has not settled yet.
   *
   * The interval between the decision and the end of the stream is a real state, and it used to be
   * invisible: a task jumped to `canceled` the instant somebody pressed stop, while output was
   * visibly still arriving — the panel said the run had ended and the transcript kept growing.
   *
   * It is not terminal (nothing has settled) and not startable (something still is), which is why it
   * is neither set below. What ends it is the run settling, at which point it becomes `canceled`.
   */
  | "stopping"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export interface TaskMeta {
  id: string;
  title: string;
  description?: string;
  labels?: string[];
  /** Root state ID of the workflow this task runs, relative to `.jaira/workflows/`. */
  workflow: string;
  /** Root workflow inputs, fixed at task creation (e.g. the issue text). JSON by
   *  construction — the task file is JSON, and these are bound as the run's
   *  operation inputs. */
  inputs?: Record<string, JsonValue>;
  /**
   * How each of {@link inputs} was settled (decision 0005 §4): `bound` by wiring, `inferred` by a
   * conversation, `asked` of a person. Recorded when the value is, per input name. An entry whose
   * `from` names a task and whose input is still ABSENT is a value that task has yet to produce —
   * the task holds for it (`dependsOn`) and the value is read when it starts.
   */
  inputProvenance?: Record<string, InputProvenance>;
  /** Branch binding (DESIGN §9.2) — recorded now, acted on in phase 5. */
  branch?: string;
  parentTaskId?: string;
  /**
   * How this task came to be, when a fan-out made it (decision 0003).
   *
   * A `split` copy carries its parent's history up to the mount and stands at it; a `task` is fresh,
   * rooted at the mounted state. Either way the task exists because an element of a list did, and
   * this is what lets a list file it under — or beside — the task that had the list.
   */
  origin?: TaskProvenance;
  /**
   * The lists this task is SPLIT ON, one entry per `each: "split"` it was made from.
   *
   * Inside this task, a wire whose `each: "split"` names one of these expressions resolves to the
   * element at its index rather than the whole list — which is what keeps a feature's task from
   * fanning out over its siblings' features when its journal is loaded.
   */
  split?: SplitEntry[];
  /**
   * Tasks that must complete before this one may start — the `requires` of the element that made
   * it, mapped through its batch. A task with an unfinished dependency is HOLDING: not a status,
   * a fact derived wherever the row is read, so a dependency finishing releases it without a write.
   */
  dependsOn?: string[];
  /**
   * How to take back the connect that last made or moved this task — the card's **Undo**, kept here
   * so it survives a restart. Cleared when it is used.
   */
  connectUndo?: StoredConnectUndo;
  createdAt: string; // ISO 8601
}

/** One list a task is split on — see {@link TaskMeta.split}. */
export interface SplitEntry {
  /** The wire's expression, verbatim — the key the engine matches a later wire against. */
  expr: string;
  /** This task's element in that list. */
  index: number;
}

/** Where a fan-out-made task came from — see {@link TaskMeta.origin}. */
export interface TaskProvenance {
  /**
   * `split`: a copy of the parent, standing at the mount. `task`: a fresh task rooted at the mounted
   * state. `adopt`: a task that ran ALONE and was taken up afterwards (decision 0005 §2) — `taskId`
   * is the parent that adopted it and `key` the child it stands for there. It keeps its own journal,
   * sessions and workspace; only where it files changes.
   */
  kind: "split" | "task" | "adopt";
  /** The task whose list made this one. */
  taskId: string;
  /** The mount key the list was on, in that task. */
  key: string;
  /** Which entry of that mount — a loop around the mount makes a new batch each pass. Default 0. */
  occurrence?: number;
  /** The element's position in the list. */
  index: number;
  /** The element's own identity, when the wire named an id field. */
  item?: string;
  /**
   * For a split: who starts this task once its dependencies are done — the host (`"when_ready"`, at
   * once when it depends on nothing) or a person (`"manual"`). Absent reads as `"when_ready"`, the
   * wire's default.
   */
  start?: "manual" | "when_ready";
  /** For an adoption: the `parentTaskId` the task had before — a re-run's predecessor — put back if it is un-adopted. */
  formerParentTaskId?: string;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "canceled"]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Statuses from which a (re-)run may begin.
 *
 * `canceled` is in the set, and that is the whole of what makes a stopped run resumable. A stop is
 * an INTERRUPTION — the difference between it and a crash is who caused it, which is not a fact about
 * whether there is anything left to pick up. Excluding it meant `resumable()` returned "no plan"
 * before it had looked, so a task whose record held eleven finished operations was offered a fresh
 * copy of itself.
 *
 * Pause and cancel differ in what they RELEASE — a paused run keeps its process and its worktree, a
 * canceled one gives them up — and not in whether they can be continued. Neither is the end of a
 * task's life; deleting is.
 */
export function isStartableStatus(status: TaskStatus): boolean {
  return status === "queued" || status === "interrupted" || status === "failed" || status === "canceled";
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newTaskId(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 10; i++) {
    suffix += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return `t-${suffix}`;
}

export function isTaskId(value: string): boolean {
  return /^t-[a-z0-9]{10}$/.test(value);
}

export function parseTaskMeta(raw: unknown, expectedId?: string): TaskMeta {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("task metadata must be a JSON object");
  }
  const meta = raw as Partial<TaskMeta>;
  if (typeof meta.id !== "string" || meta.id.length === 0) throw new Error("task metadata missing 'id'");
  if (expectedId !== undefined && meta.id !== expectedId) {
    throw new Error(`task metadata id '${meta.id}' does not match file name '${expectedId}'`);
  }
  if (typeof meta.title !== "string" || meta.title.length === 0) throw new Error("task metadata missing 'title'");
  if (typeof meta.workflow !== "string" || meta.workflow.length === 0) {
    throw new Error("task metadata missing 'workflow' (root state id)");
  }
  if (typeof meta.createdAt !== "string") throw new Error("task metadata missing 'createdAt'");
  return meta as TaskMeta;
}
