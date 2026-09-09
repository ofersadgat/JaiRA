/**
 * Task lifecycle rows (`task_runtime`). The status column is the engine-facing truth; the JSON task
 * file never carries status (DESIGN §4.1).
 *
 * A task IS one state machine instance (Identity and Resume §02/§05): resume loads the machine and
 * continues it under the same task id, and a re-run mints a NEW task pointing back through
 * `parent_task_id`. So the lifecycle facts the retired `runs` table held per attempt — when it
 * started, how it ended, what it produced — are facts about the task, and live on its one row.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import type { TaskStatus } from "@jaira/shared";
import { isTerminalStatus } from "@jaira/shared";
import type { JairaDb } from "./db";
import type { RowLog } from "./rowFile";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.runtime");

export interface TaskRuntimeRow {
  taskId: string;
  status: TaskStatus;
  snapshotHash?: string;
  branch?: string;
  worktreePath?: string;
  /**
   * The machine's root instance — which parentless journal entry is the task's own tree.
   *
   * A reader never has to guess against two shapes history still contains: a legacy re-run grew a
   * second tree in the same journal, and a sub-workflow journaling into the task enters parentless
   * too. Stamped by migration 16 for tasks that predate the collapse; a task begun since has one
   * machine and its first parentless entry is it, so absence means exactly that.
   */
  rootInstanceId?: string;
  /** The task this one re-ran — the re-run chain (§05). Absent for a task started on its own. */
  parentTaskId?: string;
  /**
   * Where this task was CUT FROM its parent, when it is a fork (migration 17): the parent's journal
   * seq the copy stops before. Paired with {@link parentTaskId}; a re-run carries the parent alone.
   */
  forkedAtSeq?: number;
  /** The copy's own last journaled event — the seam, in this task's coordinates. */
  forkBoundarySeq?: number;
  createdAt: number;
  updatedAt: number;
  /** When the machine last started executing. Absent for a task that never ran. */
  startedAt?: number;
  /** When it last stopped — cleared by {@link RuntimeStore.beginTask}, so absent means "running or never ran". */
  endedAt?: number;
  outcome?: "success" | "error" | "canceled" | "interrupted";
  outputsJson?: string;
  failureJson?: string;
}

interface RawRuntime {
  task_id: string;
  status: string;
  snapshot_hash: string | null;
  branch: string | null;
  worktree_path: string | null;
  root_instance_id: string | number | null;
  parent_task_id: string | null;
  forked_at_seq?: number | null;
  fork_boundary_seq?: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  outcome: string | null;
  outputs_json: string | null;
  failure_json: string | null;
}

function toRuntime(row: RawRuntime): TaskRuntimeRow {
  return {
    taskId: row.task_id,
    status: row.status as TaskStatus,
    snapshotHash: row.snapshot_hash ?? undefined,
    branch: row.branch ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    rootInstanceId: row.root_instance_id === null ? undefined : String(row.root_instance_id),
    parentTaskId: row.parent_task_id ?? undefined,
    forkedAtSeq: row.forked_at_seq ?? undefined,
    forkBoundarySeq: row.fork_boundary_seq ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    outcome: (row.outcome as TaskRuntimeRow["outcome"]) ?? undefined,
    outputsJson: row.outputs_json ?? undefined,
    failureJson: row.failure_json ?? undefined,
  };
}

export class RuntimeStore {
  /**
   * `log` is present only when `config.storage.tasks` puts them in files (DESIGN §4.4). Every write
   * below re-reads the row it just changed and appends THAT — never a reconstruction of what it
   * thinks it wrote, which with eight writers over one table is how a file drifts from it.
   */
  constructor(
    private readonly db: JairaDb,
    private readonly log?: RowLog,
  ) {}

  private logTask(taskId: string): void {
    this.log?.appendFrom(this.db, taskId, "task_runtime", "task_id = ?", [taskId]);
  }

  insert(taskId: string, nowMs: number, fields?: { branch?: string; parentTaskId?: string }): void {
    this.db
      .prepare(
        `INSERT INTO task_runtime (task_id, status, branch, parent_task_id, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, ?, ?)`,
      )
      .run(taskId, fields?.branch ?? null, fields?.parentTaskId ?? null, nowMs, nowMs);
    this.logTask(taskId);
  }

  get(taskId: string): TaskRuntimeRow | undefined {
    const row = this.db.prepare(`SELECT * FROM task_runtime WHERE task_id = ?`).get(taskId) as
      | RawRuntime
      | undefined;
    return row ? toRuntime(row) : undefined;
  }

  list(): TaskRuntimeRow[] {
    const rows = this.db.prepare(`SELECT * FROM task_runtime ORDER BY created_at, task_id`).all() as RawRuntime[];
    return rows.map(toRuntime);
  }

  setStatus(taskId: string, status: TaskStatus, nowMs: number): void {
    const res = this.db
      .prepare(`UPDATE task_runtime SET status = ?, updated_at = ? WHERE task_id = ?`)
      .run(status, nowMs, taskId);
    if (res.changes === 0) throw refusal(log, `no task_runtime row for task '${taskId}'`, { taskId });
    this.logTask(taskId);
  }

  setSnapshot(taskId: string, snapshotHash: string, nowMs: number): void {
    const res = this.db
      .prepare(`UPDATE task_runtime SET snapshot_hash = ?, updated_at = ? WHERE task_id = ?`)
      .run(snapshotHash, nowMs, taskId);
    if (res.changes === 0) throw refusal(log, `no task_runtime row for task '${taskId}'`, { taskId });
    this.logTask(taskId);
  }

  /** Record the task ↔ worktree mapping (DESIGN §3: it lives in SQLite). */
  setWorktree(taskId: string, worktreePath: string, nowMs: number): void {
    const res = this.db
      .prepare(`UPDATE task_runtime SET worktree_path = ?, updated_at = ? WHERE task_id = ?`)
      .run(worktreePath, nowMs, taskId);
    if (res.changes === 0) throw refusal(log, `no task_runtime row for task '${taskId}'`, { taskId });
    this.logTask(taskId);
  }

  clearWorktree(taskId: string, nowMs: number): void {
    this.db
      .prepare(`UPDATE task_runtime SET worktree_path = NULL, updated_at = ? WHERE task_id = ?`)
      .run(nowMs, taskId);
    this.logTask(taskId);
  }

  /**
   * The machine (re)starts executing: stamp when, pin what, and clear how the LAST stretch ended —
   * `ended_at IS NULL` while running is what makes "how did this end" unambiguous to read.
   */
  beginTask(taskId: string, snapshotHash: string, nowMs: number): void {
    const res = this.db
      .prepare(
        `UPDATE task_runtime
            SET snapshot_hash = ?, started_at = ?, ended_at = NULL, outcome = NULL,
                outputs_json = NULL, failure_json = NULL, updated_at = ?
          WHERE task_id = ?`,
      )
      .run(snapshotHash, nowMs, nowMs, taskId);
    if (res.changes === 0) throw refusal(log, `no task_runtime row for task '${taskId}'`, { taskId });
    this.logTask(taskId);
  }

  /**
   * The machine was CUT — a rewind deleted its tail (see `cut.ts`).
   *
   * `interrupted`, because that is the truthful word for a run whose end was taken away rather than
   * reached: the task is startable again, and the resume that follows a rewind is what picks up at
   * the cut. The end is stamped, not cleared, so a task left un-resumed still reads as stopped.
   */
  markCut(taskId: string, nowMs: number): void {
    const res = this.db
      .prepare(
        `UPDATE task_runtime SET status = 'interrupted', outcome = 'interrupted', ended_at = ?,
                outputs_json = NULL, failure_json = NULL, updated_at = ?
          WHERE task_id = ?`,
      )
      .run(nowMs, nowMs, taskId);
    if (res.changes === 0) throw refusal(log, `no task_runtime row for task '${taskId}'`, { taskId });
    this.logTask(taskId);
  }

  /**
   * Stamp a task as a COPY of a prefix of another (migration 17) — everything the copy inherits
   * that a fresh task would earn by running: the snapshot, the machine's root, and how it stands.
   */
  stampFork(
    taskId: string,
    fork: {
      snapshotHash: string;
      rootInstanceId?: string | undefined;
      forkedAtSeq: number;
      forkBoundarySeq: number;
      status: TaskStatus;
      startedAt?: number | undefined;
      endedAt?: number | undefined;
      outcome?: TaskRuntimeRow["outcome"] | undefined;
    },
    nowMs: number,
  ): void {
    const res = this.db
      .prepare(
        `UPDATE task_runtime
            SET snapshot_hash = ?, root_instance_id = ?, forked_at_seq = ?, fork_boundary_seq = ?,
                status = ?, started_at = ?, ended_at = ?, outcome = ?, updated_at = ?
          WHERE task_id = ?`,
      )
      .run(
        fork.snapshotHash,
        fork.rootInstanceId ?? null,
        fork.forkedAtSeq,
        fork.forkBoundarySeq,
        fork.status,
        fork.startedAt ?? null,
        fork.endedAt ?? null,
        fork.outcome ?? null,
        nowMs,
        taskId,
      );
    if (res.changes === 0) throw refusal(log, `no task_runtime row for task '${taskId}'`, { taskId });
    this.logTask(taskId);
  }

  endTask(
    taskId: string,
    outcome: NonNullable<TaskRuntimeRow["outcome"]>,
    nowMs: number,
    extra?: { outputsJson?: string; failureJson?: string },
  ): void {
    const res = this.db
      .prepare(`UPDATE task_runtime SET ended_at = ?, outcome = ?, outputs_json = ?, failure_json = ?, updated_at = ? WHERE task_id = ?`)
      .run(nowMs, outcome, extra?.outputsJson ?? null, extra?.failureJson ?? null, nowMs, taskId);
    if (res.changes === 0) throw refusal(log, `no task_runtime row for task '${taskId}'`, { taskId });
    this.logTask(taskId);
  }

  /**
   * Workflow-level crash recovery (DESIGN §4.3 as revised by §1a item 1): a task
   * still `running` at open time is marked `interrupted`. Returns the recovered task ids.
   *
   * `isLive` is the §4.2a fix. Without it this had to *assume* no other process
   * existed, so opening a project while a run was live falsely interrupted it.
   * Given a liveness oracle — the `jobs` table's heartbeat — a claimed task is
   * left alone and only genuinely abandoned ones are recovered. Absent, the old
   * assume-crashed behaviour stands, which is still right for a caller that has no
   * job store (a test, a one-shot read).
   */
  recoverInterrupted(nowMs: number, isLive?: (taskId: string) => boolean): string[] {
    const running = this.db.prepare(`SELECT task_id FROM task_runtime WHERE status = 'running'`).all() as Array<{
      task_id: string;
    }>;
    const ids = running.map((r) => r.task_id).filter((id) => isLive === undefined || !isLive(id));
    const recover = this.db.transaction(() => {
      for (const id of ids) {
        this.db
          .prepare(
            `UPDATE task_runtime SET status = 'interrupted', outcome = 'interrupted', ended_at = ?, updated_at = ?
              WHERE task_id = ?`,
          )
          .run(nowMs, nowMs, id);
        // The task's operation records left 'open' by the crash settle with it. 'open' means "a live
        // process is streaming into this row" — the state signal every record reader now keys on —
        // and no such process exists. The streamed partial in result_json is deliberately KEPT: those
        // turns really were exchanged before the process died.
        //
        // `interrupted`, at last its own word (Identity and Resume §03): the sweep used to write
        // `failed` over calls that were never answered, which erased the one distinction that
        // matters to a resume — `failed` means the call itself answered with an error and is not
        // re-entered; `interrupted` means we stopped it or the process died under it, its turns may
        // already exist remotely, and a load treats it as an active leaf.
        this.db
          .prepare(
            `UPDATE operation_records SET status = 'interrupted', ended_at = ?,
                    error_json = COALESCE(error_json, ?)
              WHERE task_id = ? AND status = 'open'`,
          )
          .run(nowMs, JSON.stringify({ reason: "interrupted: the process ended before this call settled" }), id);
      }
    });
    recover();
    // Recovery is a write like any other, and one that happens at OPEN — so a file-backed task
    // whose interruption was never appended would come back `running` on the next open, forever.
    for (const id of ids) this.logTask(id);
    return ids;
  }

  assertCancelable(taskId: string): TaskRuntimeRow {
    const row = this.get(taskId);
    if (!row) throw refusal(log, `unknown task '${taskId}'`, { taskId });
    if (isTerminalStatus(row.status)) {
      throw refusal(log, `task '${taskId}' is already ${row.status}`, { taskId });
    }
    return row;
  }
}
