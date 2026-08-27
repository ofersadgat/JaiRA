/**
 * Task lifecycle rows (`task_runtime` + `runs`). The status column is the
 * engine-facing truth; the JSON task file never carries status (DESIGN §4.1).
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import type { InstanceAddress, TaskStatus } from "@jaira/shared";
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
  /**
   * Where this run's own work began — see `RunView.forkedAt`, which this becomes.
   *
   * Stored as JSON, and read back as structure. Never `addressKey`: that is a map key, it joins with
   * characters a child key may legally contain, and a stored string nothing can parse back is worse
   * than no column at all.
   *
   * Absent is the ROOT — this run shares nothing. Which is what a re-run from the top does, and what
   * every row written before the column existed says.
   */
  forkedAt?: InstanceAddress;
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
  forked_at: string | null;
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

/**
 * The stored fork point, read back as structure — or nothing, which is the root.
 *
 * Tolerant on purpose. A column read back as something other than an array of steps is a row this
 * process did not write, and the honest answer to that is "this run shares nothing" — the same thing
 * NULL means. Throwing would take down a task list over a field that only decides where a mark goes.
 */
function forkedAtOf(raw: string | null): { forkedAt: InstanceAddress } | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const steps = parsed.filter(
      (step): step is InstanceAddress[number] =>
        typeof step === "object" &&
        step !== null &&
        typeof (step as { childKey?: unknown }).childKey === "string" &&
        typeof (step as { occurrence?: unknown }).occurrence === "number",
    );
    return steps.length === parsed.length ? { forkedAt: steps } : undefined;
  } catch {
    return undefined;
  }
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
    ...(forkedAtOf(row.forked_at) ?? {}),
  };
}

export class RuntimeStore {
  /**
   * `log` is present only when `config.storage.tasks` puts them in files (DESIGN §4.4). Every write
   * below re-reads the row it just changed and appends THAT — never a reconstruction of what it
   * thinks it wrote, which with eight writers over two tables is how a file drifts from a table.
   */
  constructor(
    private readonly db: JairaDb,
    private readonly log?: RowLog,
  ) {}

  private logTask(taskId: string): void {
    this.log?.appendFrom(this.db, taskId, "task_runtime", "task_id = ?", [taskId]);
  }

  private logRun(runId: number): void {
    if (this.log === undefined) return;
    const row = this.db.prepare(`SELECT task_id FROM runs WHERE id = ?`).get(runId) as { task_id: string } | undefined;
    if (row !== undefined) this.log.appendFrom(this.db, row.task_id, "runs", "id = ?", [runId]);
  }

  insert(taskId: string, nowMs: number, fields?: { branch?: string }): void {
    this.db
      .prepare(
        `INSERT INTO task_runtime (task_id, status, branch, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, ?)`,
      )
      .run(taskId, fields?.branch ?? null, nowMs, nowMs);
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
   * `forkedAt` is where this run's own work will begin — absent for a run that shares nothing, which
   * is every run started from the top. See `RunRow.forkedAt`.
   */
  beginRun(taskId: string, snapshotHash: string, nowMs: number, forkedAt?: InstanceAddress): number {
    const res = this.db
      .prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at, forked_at) VALUES (?, ?, ?, ?)`)
      .run(taskId, snapshotHash, nowMs, forkedAt === undefined ? null : JSON.stringify(forkedAt));
    // The id is written down because it is REFERENCED — see the note in `rowFile.ts`.
    this.logRun(Number(res.lastInsertRowid));
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
    if (res.changes === 0) throw refusal(log, `no run row with id ${runId}`, { runId });
    this.logRun(runId);
  }

  listRuns(taskId: string): RunRow[] {
    const rows = this.db.prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY id`).all(taskId) as RawRun[];
    return rows.map(toRun);
  }

  /**
   * Workflow-level crash recovery (DESIGN §4.3 as revised by §1a item 1): a task
   * still `running` at open time is marked `interrupted` and its dangling runs
   * closed. Returns the recovered task ids.
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
          .prepare(`UPDATE task_runtime SET status = 'interrupted', updated_at = ? WHERE task_id = ?`)
          .run(nowMs, id);
        this.db
          .prepare(`UPDATE runs SET ended_at = ?, outcome = 'interrupted' WHERE task_id = ? AND ended_at IS NULL`)
          .run(nowMs, id);
        // The task's operation records left 'open' by the crash settle with it. 'open' means "a live
        // process is streaming into this row" — the state signal every record reader now keys on —
        // and no such process exists. The streamed partial in result_json is deliberately KEPT: those
        // turns really were exchanged before the process died, and a settled-failed row is exactly
        // how an errored call's surviving turns are already represented.
        this.db
          .prepare(
            `UPDATE operation_records SET status = 'failed', ended_at = ?,
                    error_json = COALESCE(error_json, ?)
              WHERE task_id = ? AND status = 'open'`,
          )
          .run(nowMs, JSON.stringify({ reason: "interrupted: the process ended before this call settled" }), id);
      }
    });
    recover();
    // Recovery is a write like any other, and one that happens at OPEN — so a file-backed task
    // whose interruption was never appended would come back `running` on the next open, forever.
    for (const id of ids) {
      this.logTask(id);
      for (const run of this.db.prepare(`SELECT id FROM runs WHERE task_id = ?`).all(id) as Array<{ id: number }>) {
        this.logRun(run.id);
      }
    }
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
