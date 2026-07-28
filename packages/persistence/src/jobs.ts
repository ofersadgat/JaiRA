/**
 * Process claims — `jobs` (DESIGN §4.2a).
 *
 * This exists because a `running` task row carries no liveness signal: at project
 * open, "the writer crashed" and "the writer is another live process" look
 * identical, so recovery had to guess. v1 guessed *crashed*, which falsely
 * interrupts a live run whenever a second process opens the project.
 *
 * A job answers the question directly. Liveness is a heartbeat, not a pid — a pid
 * is not an identity (after a reboot, 1234 is some other program), so a random
 * per-process `ownerToken` plus a recent `heartbeatAt` is what "alive" means here.
 * `pid` is recorded for the two things that genuinely need it: telling a human what
 * is running, and killing an orphan — and killing needs more care than a pid alone
 * provides, which is why this module reports orphans and never kills them.
 */
import { randomUUID } from "node:crypto";
import type { JairaDb } from "./db";

export type JobKind = "run" | "process";

export interface JobRow {
  id: number;
  kind: JobKind;
  taskId?: string;
  runId?: number;
  parentJobId?: number;
  ownerToken: string;
  pid?: number;
  command?: string;
  startedAt: number;
  heartbeatAt: number;
  cancelRequestedAt?: number;
  endedAt?: number;
  outcome?: string;
}

interface RawJob {
  id: number;
  kind: string;
  task_id: string | null;
  run_id: number | null;
  parent_job_id: number | null;
  owner_token: string;
  pid: number | null;
  command: string | null;
  started_at: number;
  heartbeat_at: number;
  cancel_requested_at: number | null;
  ended_at: number | null;
  outcome: string | null;
}

function toJob(row: RawJob): JobRow {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.parent_job_id !== null ? { parentJobId: row.parent_job_id } : {}),
    ownerToken: row.owner_token,
    ...(row.pid !== null ? { pid: row.pid } : {}),
    ...(row.command !== null ? { command: row.command } : {}),
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    ...(row.cancel_requested_at !== null ? { cancelRequestedAt: row.cancel_requested_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(row.outcome !== null ? { outcome: row.outcome } : {}),
  };
}

/**
 * How long a heartbeat stays believable.
 *
 * The trade is crash-detection latency against falsely reclaiming a live run. A
 * beat every 5s and a 30s window means a crashed owner is noticed within half a
 * minute, while a process would have to miss six consecutive beats to be
 * mistakenly declared dead.
 */
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_STALE_MS = 30_000;

/** A fresh per-process identity. Not a pid — see the module note. */
export function newOwnerToken(): string {
  return randomUUID();
}

export class JobStore {
  constructor(
    private readonly db: JairaDb,
    private readonly staleMs: number = DEFAULT_STALE_MS,
  ) {}

  /** Claim a run for this process. Returns the job id to heartbeat and end. */
  claimRun(input: { taskId: string; runId: number; ownerToken: string; pid?: number; nowMs: number }): number {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (kind, task_id, run_id, owner_token, pid, started_at, heartbeat_at)
         VALUES ('run', ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.taskId, input.runId, input.ownerToken, input.pid ?? null, input.nowMs, input.nowMs);
    return Number(res.lastInsertRowid);
  }

  /** Record a child process this run spawned. */
  spawned(input: {
    ownerToken: string;
    parentJobId?: number;
    taskId?: string;
    runId?: number;
    command: string;
    pid?: number;
    nowMs: number;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (kind, task_id, run_id, parent_job_id, owner_token, pid, command, started_at, heartbeat_at)
         VALUES ('process', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId ?? null,
        input.runId ?? null,
        input.parentJobId ?? null,
        input.ownerToken,
        input.pid ?? null,
        input.command,
        input.nowMs,
        input.nowMs,
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * Refresh every open job this process owns.
   *
   * One timer per process covers its run job and all its children, so a crash
   * leaves the whole subtree stale at once — which is what makes orphan detection
   * a single query.
   */
  heartbeat(ownerToken: string, nowMs: number): void {
    this.db
      .prepare(`UPDATE jobs SET heartbeat_at = ? WHERE owner_token = ? AND ended_at IS NULL`)
      .run(nowMs, ownerToken);
  }

  end(jobId: number, outcome: string, nowMs: number): void {
    this.db.prepare(`UPDATE jobs SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL`).run(nowMs, outcome, jobId);
  }

  /** Close everything this process owns — the clean-shutdown path. */
  endOwner(ownerToken: string, outcome: string, nowMs: number): void {
    this.db
      .prepare(`UPDATE jobs SET ended_at = ?, outcome = ? WHERE owner_token = ? AND ended_at IS NULL`)
      .run(nowMs, outcome, ownerToken);
  }

  /** The live claim on a task, if any. This is the liveness question, asked directly. */
  liveRunJob(taskId: string, nowMs: number): JobRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE kind = 'run' AND task_id = ? AND ended_at IS NULL AND heartbeat_at > ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId, nowMs - this.staleMs) as RawJob | undefined;
    return row ? toJob(row) : undefined;
  }

  /** True when some other process is live on this task. */
  isClaimedElsewhere(taskId: string, ownerToken: string, nowMs: number): boolean {
    const live = this.liveRunJob(taskId, nowMs);
    return live !== undefined && live.ownerToken !== ownerToken;
  }

  /**
   * Ask the owning process to stop. A flag it polls, not a signal — which is why
   * cross-process *cancel* needs no socket, unlike answering a parked gate.
   */
  requestCancel(taskId: string, nowMs: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE jobs SET cancel_requested_at = ?
         WHERE kind = 'run' AND task_id = ? AND ended_at IS NULL AND cancel_requested_at IS NULL`,
      )
      .run(nowMs, taskId);
    return res.changes > 0;
  }

  /** Has a cancel been requested for this job? Polled by the process that owns it. */
  cancelRequested(jobId: number): boolean {
    const row = this.db.prepare(`SELECT cancel_requested_at FROM jobs WHERE id = ?`).get(jobId) as
      | { cancel_requested_at: number | null }
      | undefined;
    return row?.cancel_requested_at != null;
  }

  /**
   * Child processes whose owner stopped breathing.
   *
   * These are the abandoned agents — a `claude` still running and still billing
   * after the app died. Reported, never killed: a pid alone is not identity, so
   * killing needs a human's confirmation.
   */
  orphans(nowMs: number): JobRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE kind = 'process' AND ended_at IS NULL AND heartbeat_at <= ?
         ORDER BY id`,
      )
      .all(nowMs - this.staleMs) as RawJob[];
    return rows.map(toJob);
  }

  /**
   * Close every job whose owner is stale, returning what was reaped.
   *
   * Run at project open, after {@link orphans} has been read: the rows are the only
   * record that those processes existed, so they are reported before being closed.
   */
  reapStale(nowMs: number): number {
    const res = this.db
      .prepare(`UPDATE jobs SET ended_at = ?, outcome = 'abandoned' WHERE ended_at IS NULL AND heartbeat_at <= ?`)
      .run(nowMs, nowMs - this.staleMs);
    return res.changes;
  }

  /** Everything currently open, newest first — what a "what is running?" view reads. */
  live(nowMs: number): JobRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE ended_at IS NULL AND heartbeat_at > ? ORDER BY id DESC`)
      .all(nowMs - this.staleMs) as RawJob[];
    return rows.map(toJob);
  }

  list(taskId: string): JobRow[] {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE task_id = ? ORDER BY id`).all(taskId) as RawJob[];
    return rows.map(toJob);
  }
}
