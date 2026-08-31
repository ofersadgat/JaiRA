/**
 * Parked gates that outlive the process — `pending_interactions` (DESIGN §7.1, CHANGESETS.md §8.1).
 *
 * `InteractionHub` is where a request LIVES while a run is in flight: a Map from request id to the
 * promise the engine is blocked on. That map is the process, and it used to be the only copy — so
 * quitting the app rejected every parked call, the workflow took a failure nobody asked for, and
 * the question the person was in the middle of answering was simply gone.
 *
 * This is the other copy. A row is written when a state parks and deleted when a PERSON answers;
 * closing a project deliberately leaves it behind. What comes back next open is not a live park —
 * the engine that was waiting is gone — but it is enough to draw the same gate, and answering it
 * resumes the task with the answer already in hand (see the service's `submitInteraction`).
 *
 * ## Why the request is stored whole
 *
 * The obvious alternative is a pointer into the journal, and the journal does not hold the right
 * object. `operation.started` fires before the operation's inputs are resolved and carries none;
 * `instance.entered` carries the STATE's resolved inputs, which is a different thing from what the
 * function was called with. A component's authored surface is `operation.args`, and the function
 * receives those MERGED with the state's inputs, flat — that merged object is what a contract is
 * parsed out of (`parseComponentConfig`), and nothing writes it down. So it is what gets stored.
 *
 * ## Not a queue
 *
 * A row is a fact about a task, keyed by the request id its hub minted. Nothing here decides
 * whether a gate is still worth showing; that is `pendingInteractions()`'s job, which joins these
 * rows against the runs that are actually live.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { JairaDb } from "./db";

/** A gate as it was parked, in the shape the renderer draws one from. */
export interface StoredInteraction {
  requestId: string;
  taskId: string;
  runId?: number;
  /** The registered function name — `choose_option`, `review_artifacts`, … */
  component: string;
  /** The function's arguments: the state's resolved inputs merged with its authored `args`. */
  inputs: Record<string, JsonValue>;
  /** The task this gate is ABOUT, when a review runs as its own task. See `PendingInteraction.about`. */
  about?: string;
  /** Whose anchors this gate's file reads resolve against. See `PendingInteraction.subjectProject`. */
  subjectProject?: string;
  createdAt: number;
}

interface RawInteraction {
  request_id: string;
  task_id: string;
  run_id: number | null;
  component: string;
  inputs_json: string;
  about: string | null;
  subject_project: string | null;
  created_at: number;
}

function toStored(row: RawInteraction): StoredInteraction {
  return {
    requestId: row.request_id,
    taskId: row.task_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    component: row.component,
    // A row whose JSON will not parse is a row nothing can draw. Answering `{}` rather than throwing
    // keeps one corrupt gate from making a project impossible to open — the renderer reports a
    // config error, which is what a malformed contract looks like from every other direction too.
    inputs: parseInputs(row.inputs_json),
    ...(row.about !== null ? { about: row.about } : {}),
    ...(row.subject_project !== null ? { subjectProject: row.subject_project } : {}),
    createdAt: row.created_at,
  };
}

function parseInputs(text: string): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, JsonValue>)
      : {};
  } catch {
    return {};
  }
}

export class InteractionStore {
  constructor(private readonly db: JairaDb) {}

  /**
   * A state has parked. Idempotent on the request id, because the hub mints one per park and a
   * re-registration must not fan out into two gates asking the same question.
   */
  open(request: StoredInteraction): void {
    this.db
      .prepare(
        `INSERT INTO pending_interactions
           (request_id, task_id, run_id, component, inputs_json, about, subject_project, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           task_id = excluded.task_id,
           run_id = excluded.run_id,
           component = excluded.component,
           inputs_json = excluded.inputs_json,
           about = excluded.about,
           subject_project = excluded.subject_project`,
      )
      .run(
        request.requestId,
        request.taskId,
        request.runId ?? null,
        request.component,
        JSON.stringify(request.inputs),
        request.about ?? null,
        request.subjectProject ?? null,
        request.createdAt,
      );
  }

  /**
   * A person answered — or declined, which is also an answer. The one caller this must NOT have is
   * a shutdown: a gate rejected because the window closed is still a gate, and forgetting it here is
   * the bug this table exists to fix.
   */
  close(requestId: string): void {
    this.db.prepare(`DELETE FROM pending_interactions WHERE request_id = ?`).run(requestId);
  }

  /** Every gate this project is holding, oldest first — the order they were asked in. */
  list(): StoredInteraction[] {
    const rows = this.db
      .prepare(`SELECT * FROM pending_interactions ORDER BY created_at, rowid`)
      .all() as RawInteraction[];
    return rows.map(toStored);
  }

  get(requestId: string): StoredInteraction | undefined {
    const row = this.db.prepare(`SELECT * FROM pending_interactions WHERE request_id = ?`).get(requestId) as
      | RawInteraction
      | undefined;
    return row === undefined ? undefined : toStored(row);
  }

  /** One task's gates, oldest first. */
  forTask(taskId: string): StoredInteraction[] {
    const rows = this.db
      .prepare(`SELECT * FROM pending_interactions WHERE task_id = ? ORDER BY created_at, rowid`)
      .all(taskId) as RawInteraction[];
    return rows.map(toStored);
  }

  /**
   * Forget everything a task was waiting on.
   *
   * Two callers: deleting the task, and starting it again from the top. A re-run reaches the gate
   * on its own terms and parks a NEW request; leaving the old row would show the person a question
   * whose run no longer exists beside the one that does.
   */
  clearTask(taskId: string): void {
    this.db.prepare(`DELETE FROM pending_interactions WHERE task_id = ?`).run(taskId);
  }
}
