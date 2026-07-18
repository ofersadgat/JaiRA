/**
 * Task lifecycle rows (`task_runtime` + `runs`). The status column is the
 * engine-facing truth; the JSON task file never carries status (DESIGN §4.1).
 */
import type { TaskStatus } from "@jaira/shared";
import { isTerminalStatus } from "@jaira/shared";
import type { JairaDb } from "./db";

export interface TaskRuntimeRow {
  taskId: string;
  status: TaskStatus;
  snapshotHash?: string;
  branch?: string;
  worktreePath?: string;
  rootInstanceId?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RunRow {
  id: number;
  taskId: string;
  snapshotHash: string;
  startedAt: number;
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
  root_instance_id: number | null;
  created_at: number;
  updated_at: number;
}

interface RawRun {
  id: number;
  task_id: string;
  snapshot_hash: string;
  started_at: number;
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
    rootInstanceId: row.root_instance_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RawRun): RunRow {
  return {
    id: row.id,
    taskId: row.task_id,
    snapshotHash: row.snapshot_hash,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    outcome: (row.outcome as RunRow["outcome"]) ?? undefined,
    outputsJson: row.outputs_json ?? undefined,
    failureJson: row.failure_json ?? undefined,
  };
}

export class RuntimeStore {
  constructor(private readonly db: JairaDb) {}

  insert(taskId: string, nowMs: number, fields?: { branch?: string }): void {
    this.db
      .prepare(
        `INSERT INTO task_runtime (task_id, status, branch, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, ?)`,
      )
      .run(taskId, fields?.branch ?? null, nowMs, nowMs);
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
    if (res.changes === 0) throw new Error(`no task_runtime row for task '${taskId}'`);
  }

  setSnapshot(taskId: string, snapshotHash: string, nowMs: number): void {
    const res = this.db
      .prepare(`UPDATE task_runtime SET snapshot_hash = ?, updated_at = ? WHERE task_id = ?`)
      .run(snapshotHash, nowMs, taskId);
    if (res.changes === 0) throw new Error(`no task_runtime row for task '${taskId}'`);
  }

  beginRun(taskId: string, snapshotHash: string, nowMs: number): number {
    const res = this.db
      .prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at) VALUES (?, ?, ?)`)
      .run(taskId, snapshotHash, nowMs);
    return Number(res.lastInsertRowid);
  }

  endRun(
    runId: number,
    outcome: NonNullable<RunRow["outcome"]>,
    nowMs: number,
    extra?: { outputsJson?: string; failureJson?: string },
  ): void {
    const res = this.db
      .prepare(`UPDATE runs SET ended_at = ?, outcome = ?, outputs_json = ?, failure_json = ? WHERE id = ?`)
      .run(nowMs, outcome, extra?.outputsJson ?? null, extra?.failureJson ?? null, runId);
    if (res.changes === 0) throw new Error(`no run row with id ${runId}`);
  }

  listRuns(taskId: string): RunRow[] {
    const rows = this.db.prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY id`).all(taskId) as RawRun[];
    return rows.map(toRun);
  }

  /**
   * Workflow-level crash recovery (DESIGN §4.3 as revised by §1a item 1): any
   * task still `running` at open time has no live engine behind it — mark it
   * `interrupted` and close its dangling runs. Returns the recovered task ids.
   *
   * v1 assumption: exactly one process owns a project's `.jaira/` at a time.
   */
  recoverInterrupted(nowMs: number): string[] {
    const running = this.db.prepare(`SELECT task_id FROM task_runtime WHERE status = 'running'`).all() as Array<{
      task_id: string;
    }>;
    const ids = running.map((r) => r.task_id);
    const recover = this.db.transaction(() => {
      for (const id of ids) {
        this.db
          .prepare(`UPDATE task_runtime SET status = 'interrupted', updated_at = ? WHERE task_id = ?`)
          .run(nowMs, id);
        this.db
          .prepare(`UPDATE runs SET ended_at = ?, outcome = 'interrupted' WHERE task_id = ? AND ended_at IS NULL`)
          .run(nowMs, id);
      }
    });
    recover();
    return ids;
  }

  assertCancelable(taskId: string): TaskRuntimeRow {
    const row = this.get(taskId);
    if (!row) throw new Error(`unknown task '${taskId}'`);
    if (isTerminalStatus(row.status)) {
      throw new Error(`task '${taskId}' is already ${row.status}`);
    }
    return row;
  }
}
