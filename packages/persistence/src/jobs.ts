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
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import type { JairaDb } from "./db";
import { OWNED_BY } from "./workspace";

// The wire shapes live in `@jaira/shared` so the renderer can name one without reaching into this
// Node-only package — the same rule the lint and view models already follow.
import type { JobKind, JobRow } from "@jaira/shared";
export type { JobKind, JobRow } from "@jaira/shared";

interface RawJob {
  id: number;
  kind: string;
  task_id: string | null;
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

/** A fresh identity for one claim. Not a pid — see the module note. */
export function newOwnerToken(): string {
  return randomUUID();
}

/**
 * THIS process, once — what every claim and child it records is stamped with (`process_token`). An owner
 * token names a claim, and one process makes many; this names the process, so a claim of this very
 * process is never mistaken for a dead one.
 */
export const PROCESS_TOKEN = randomUUID();

/**
 * The machine and the pid namespace a process runs in (`host_key`): a pid means something only beside it.
 * WSL and Windows, two WSL distributions, or a container sharing one base root each see their own pids,
 * so a pid is checked only for a claim made where this process stands.
 */
export const HOST_KEY = ((): string => {
  let namespace = "";
  try {
    namespace = readlinkSync("/proc/self/ns/pid");
  } catch {
    // Not Linux, or no procfs: the platform and host name are the whole key.
  }
  return `${process.platform}|${hostname()}|${namespace}`;
})();

/**
 * Is a process with this pid running? `EPERM` is somebody else's process, and running. Used only for a
 * claim made on this host, beside a token that is not this process's (`deadOwners`) — a pid alone is not
 * an identity, and a reused one only makes the answer cautious.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class JobStore {
  constructor(
    private readonly db: JairaDb,
    private readonly staleMs: number = DEFAULT_STALE_MS,
    /**
     * Whose jobs {@link live} lists, when set — the database holds every workspace's (decision 0013
     * §4). Claims, liveness and the stale sweep stay machine-wide: a process is this machine's whoever
     * started it, and an orphan is reported by whichever open finds it first.
     */
    private readonly workspace?: string,
  ) {}

  /** Claim a task's run for this process. Returns the job id to heartbeat and end. */
  claimRun(input: { taskId: string; ownerToken: string; pid?: number; nowMs: number }): number {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (kind, task_id, owner_token, pid, started_at, heartbeat_at, process_token, host_key)
         VALUES ('run', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.taskId, input.ownerToken, input.pid ?? null, input.nowMs, input.nowMs, PROCESS_TOKEN, HOST_KEY);
    return Number(res.lastInsertRowid);
  }

  /** Record a child process this run spawned. */
  spawned(input: {
    ownerToken: string;
    parentJobId?: number;
    taskId?: string;
    command: string;
    pid?: number;
    /** Where it ran. Received from the observer and, until there was a column, dropped. */
    cwd?: string;
    nowMs: number;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (kind, task_id, parent_job_id, owner_token, pid, command, cwd, started_at, heartbeat_at, process_token, host_key)
         VALUES ('process', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId ?? null,
        input.parentJobId ?? null,
        input.ownerToken,
        input.pid ?? null,
        input.command,
        input.cwd ?? null,
        input.nowMs,
        input.nowMs,
        PROCESS_TOKEN,
        HOST_KEY,
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * The owner tokens of run claims whose PROCESS is gone, though their heartbeat is still fresh — a crash
   * a moment ago, found by the next process to open the project.
   *
   * Waiting out the heartbeat was the only rule, and it left a task the app had just crashed under
   * `running` for half a minute after the reopen — and, since nothing looked again, until the next one.
   * A claim made on THIS host (`host_key`), by a process that is not this one (`process_token`), whose
   * pid no longer runs — or is this very process's, reused — was made by a process that is dead. A claim
   * made elsewhere, or with no pid or token to go on, is still judged by its heartbeat alone.
   */
  deadOwners(nowMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT owner_token, pid FROM jobs
          WHERE kind = 'run' AND ended_at IS NULL AND heartbeat_at > ?
            AND host_key = ? AND process_token IS NOT NULL AND process_token != ? AND pid IS NOT NULL`,
      )
      .all(nowMs - this.staleMs, HOST_KEY, PROCESS_TOKEN) as Array<{ owner_token: string; pid: number }>;
    return rows.filter((row) => row.pid === process.pid || !pidAlive(row.pid)).map((row) => row.owner_token);
  }

  /** The open children of these claims — a dead owner's agents, which may outlive it. */
  childrenOf(ownerTokens: readonly string[]): JobRow[] {
    if (ownerTokens.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE kind = 'process' AND ended_at IS NULL AND owner_token IN (${ownerTokens.map(() => "?").join(", ")}) ORDER BY id`)
      .all(...ownerTokens) as RawJob[];
    return rows.map(toJob);
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
      .prepare(
        `SELECT * FROM jobs WHERE ended_at IS NULL AND heartbeat_at > ?${this.workspace !== undefined ? ` AND (task_id IS NULL OR ${OWNED_BY})` : ""} ORDER BY id DESC`,
      )
      .all(...(this.workspace !== undefined ? [nowMs - this.staleMs, this.workspace] : [nowMs - this.staleMs])) as RawJob[];
    return rows.map(toJob);
  }

  list(taskId: string): JobRow[] {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE task_id = ? ORDER BY id`).all(taskId) as RawJob[];
    return rows.map(toJob);
  }
}
