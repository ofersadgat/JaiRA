/**
 * The merge requests a task has opened, one row per `(task, key)` (decision 0004, "The same request
 * on every round").
 *
 * A row is what makes a merge request the SAME one on a loop's next pass, and what makes a weekend
 * with the app closed cost one probe and lose nothing. It holds two kinds of thing:
 *
 *  - **the handle** — provider, host, project, branch, target, number, url, the head last pushed.
 *    This is what rides a function's result as data; the row is only where JaiRA remembers it.
 *  - **the watch** — the probe cursor, the ids of what has already been seen, `settle_at`, and whether
 *    a gate is awaiting it. `settle_at` is a TIMESTAMP on purpose: a quiet window that quitting the
 *    app could lose or extend is not a window.
 *
 * `key` is the identity WITHIN the task: a scoped name's key when the workflow named the request
 * (NAMES.md §3 — `review#<address>`), else `DEFAULT_REMOTE_KEY`, so an unnamed request is still
 * one request per task. A rerun mints a task and therefore a new request; a fork copies the identity and not
 * the request ({@link RemoteHandleStore.copyIdentity}); a rewind keeps the row, because the forge
 * cannot be rewound.
 */
import type { ForgeProviderKind, ProbeCursor, RemoteHandle, RemoteHandlePatch, RemoteHandlePort, RemoteHandleRow } from "@jaira/shared";
import type { JairaDb } from "./db";

interface Raw {
  task_id: string;
  key: string;
  provider: string;
  host: string;
  project: string;
  remote: string;
  branch: string;
  target: string;
  number: number | null;
  url: string | null;
  pushed_head: string | null;
  cursor_json: string;
  seen_json: string;
  settle_at: number | null;
  settle_after_ms: number | null;
  awaiting: number;
  request_id: string | null;
  checked_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function parse<T>(text: string, fallback: T): T {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    // A row whose JSON will not parse still names a real request; losing its cursor costs one read.
    return fallback;
  }
}

function toStored(row: Raw): RemoteHandleRow {
  return {
    taskId: row.task_id,
    key: row.key,
    provider: row.provider as ForgeProviderKind,
    host: row.host,
    project: row.project,
    remote: row.remote,
    branch: row.branch,
    target: row.target,
    ...(row.number !== null ? { number: row.number } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.pushed_head !== null ? { pushedHead: row.pushed_head } : {}),
    cursor: parse<ProbeCursor>(row.cursor_json, {}),
    seen: parse<string[]>(row.seen_json, []),
    ...(row.settle_at !== null ? { settleAt: row.settle_at } : {}),
    ...(row.settle_after_ms !== null ? { settleAfterMs: row.settle_after_ms } : {}),
    awaiting: row.awaiting === 1,
    ...(row.request_id !== null ? { requestId: row.request_id } : {}),
    ...(row.checked_at !== null ? { checkedAt: row.checked_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The row under its persistence-side name, for callers that read it as stored state. */
export type StoredRemoteHandle = RemoteHandleRow;

export class RemoteHandleStore implements RemoteHandlePort {
  constructor(
    private readonly db: JairaDb,
    private readonly now: () => number = Date.now,
  ) {}

  get(taskId: string, key: string): RemoteHandleRow | undefined {
    const row = this.db.prepare(`SELECT * FROM remote_handles WHERE task_id = ? AND key = ?`).get(taskId, key) as Raw | undefined;
    return row === undefined ? undefined : toStored(row);
  }

  /** Every request of one task, oldest first. */
  forTask(taskId: string): RemoteHandleRow[] {
    const rows = this.db.prepare(`SELECT * FROM remote_handles WHERE task_id = ? ORDER BY created_at, key`).all(taskId) as Raw[];
    return rows.map(toStored);
  }

  /** The rows something is parked on — "nothing parked, nothing polled" is this list being empty. */
  awaiting(): RemoteHandleRow[] {
    const rows = this.db.prepare(`SELECT * FROM remote_handles WHERE awaiting = 1 AND number IS NOT NULL ORDER BY created_at, task_id, key`).all() as Raw[];
    return rows.map(toStored);
  }

  /**
   * Make the row for a branch, or return the one already there.
   *
   * Never overwrites where a request lives: the second pass of a loop calls this with the same key and
   * must get the first pass's request back, number and all — which is the whole of "it never opens a
   * second one".
   */
  ensure(identity: Pick<RemoteHandleRow, "taskId" | "key" | "provider" | "host" | "project" | "remote" | "branch" | "target">): RemoteHandleRow {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO remote_handles (task_id, key, provider, host, project, remote, branch, target, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, key) DO NOTHING`,
      )
      .run(identity.taskId, identity.key, identity.provider, identity.host, identity.project, identity.remote, identity.branch, identity.target, at, at);
    return this.get(identity.taskId, identity.key)!;
  }

  update(taskId: string, key: string, patch: RemoteHandlePatch): RemoteHandleRow | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.number !== undefined) set("number", patch.number);
    if (patch.url !== undefined) set("url", patch.url);
    if (patch.pushedHead !== undefined) set("pushed_head", patch.pushedHead);
    if (patch.target !== undefined) set("target", patch.target);
    if (patch.cursor !== undefined) set("cursor_json", JSON.stringify(patch.cursor));
    if (patch.seen !== undefined) set("seen_json", JSON.stringify(patch.seen));
    if (patch.settleAt !== undefined) set("settle_at", patch.settleAt);
    if (patch.settleAfterMs !== undefined) set("settle_after_ms", patch.settleAfterMs);
    if (patch.awaiting !== undefined) set("awaiting", patch.awaiting ? 1 : 0);
    if (patch.requestId !== undefined) set("request_id", patch.requestId);
    if (patch.checkedAt !== undefined) set("checked_at", patch.checkedAt);
    if (patch.lastError !== undefined) set("last_error", patch.lastError);
    if (sets.length > 0) {
      set("updated_at", this.now());
      this.db.prepare(`UPDATE remote_handles SET ${sets.join(", ")} WHERE task_id = ? AND key = ?`).run(...values, taskId, key);
    }
    return this.get(taskId, key);
  }

  /** The row a parked gate is waiting on. */
  byRequest(requestId: string): RemoteHandleRow | undefined {
    const row = this.db.prepare(`SELECT * FROM remote_handles WHERE request_id = ?`).get(requestId) as Raw | undefined;
    return row === undefined ? undefined : toStored(row);
  }

  /** Nothing of this task is awaited any more — a cancel, or the run that parked it ending. */
  stopAwaiting(taskId: string): void {
    this.db.prepare(`UPDATE remote_handles SET awaiting = 0, request_id = NULL, updated_at = ? WHERE task_id = ? AND awaiting = 1`).run(this.now(), taskId);
  }

  /**
   * A fork's rows: the IDENTITY of each of the parent's requests, and not the request.
   *
   * The fork pushes to a branch of its own and its first push opens its own request — two tasks
   * sharing one would be two histories arguing over one branch. So where a request lives, what has
   * been seen on it and any window are all left behind; the branch is re-derived by the caller,
   * because it carries the task's id.
   */
  copyIdentity(fromTaskId: string, toTaskId: string, branchOf: (row: RemoteHandleRow) => string): void {
    for (const row of this.forTask(fromTaskId)) {
      this.ensure({ ...row, taskId: toTaskId, branch: branchOf(row) });
    }
  }

  deleteTask(taskId: string): void {
    this.db.prepare(`DELETE FROM remote_handles WHERE task_id = ?`).run(taskId);
  }
}
