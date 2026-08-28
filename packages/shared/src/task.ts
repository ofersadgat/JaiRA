/**
 * Task model (DESIGN §4.1, §12): the human-readable half of the hybrid store.
 * A TaskMeta is what lives in `.jaira/tasks/<taskId>.json`; runtime status and
 * history live in SQLite (@jaira/persistence) and reference tasks by id only.
 */
import type { JsonValue } from "@declarative-ai/json";

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
  /** Branch binding (DESIGN §9.2) — recorded now, acted on in phase 5. */
  branch?: string;
  parentTaskId?: string;
  createdAt: string; // ISO 8601
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
