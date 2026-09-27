/**
 * The repository watcher's memory (decision 0010 §2) and where a task's event waits began (§3).
 *
 * `repo_watch_cursors` and `repo_watch_seen` are what make "missed while closed: the latest state
 * only" possible: the watcher compares what the forge says NOW with the last state it saw, and a
 * weekend with the app closed is one comparison, not a replay. Never file-backed — like
 * `remote_handles`, these are facts about this machine's conversation with a forge, not about the
 * repository.
 *
 * `event_waits` is the durable half of the event hub's per-task queue: when a task's guards first
 * waited on an event name. See `EventWaitPort`.
 */
import type {
  EventName,
  EventWaitPort,
  RepoWatchCursor,
  RepoWatchKind,
  RepoWatchPort,
  RepoWatchScope,
  RepoWatchSeen,
} from "@jaira/shared";
import type { JairaDb } from "./db";

function parse<T>(text: string): T | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    // A row that will not parse is a row not seen: the next look re-takes it, which costs one event
    // at most — never a flood, because the cursor is separate.
    return undefined;
  }
}

export class RepoWatchStore implements RepoWatchPort {
  constructor(
    private readonly db: JairaDb,
    /**
     * The workspace watching (decision 0013 §4): two clones of one repository watch the same remote,
     * and each keeps its own baseline.
     */
    private readonly workspace: string,
    private readonly now: () => number = Date.now,
  ) {}

  cursor(scope: RepoWatchScope): RepoWatchCursor | undefined {
    const row = this.db.prepare(`SELECT cursor_json FROM repo_watch_cursors WHERE workspace = ? AND remote = ? AND repository = ?`).get(this.workspace, scope.remote, scope.repository) as
      | { cursor_json: string }
      | undefined;
    return row === undefined ? undefined : (parse<RepoWatchCursor>(row.cursor_json) ?? {});
  }

  /** The last error of a poll, when it failed (`null` clears it; absent leaves it). */
  lastError(scope: RepoWatchScope): string | undefined {
    const row = this.db.prepare(`SELECT last_error FROM repo_watch_cursors WHERE workspace = ? AND remote = ? AND repository = ?`).get(this.workspace, scope.remote, scope.repository) as
      | { last_error: string | null }
      | undefined;
    return row?.last_error ?? undefined;
  }

  setCursor(scope: RepoWatchScope, cursor: RepoWatchCursor, error?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO repo_watch_cursors (workspace, remote, repository, cursor_json, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace, remote, repository) DO UPDATE SET
           cursor_json = excluded.cursor_json,
           last_error = CASE WHEN ? THEN excluded.last_error ELSE repo_watch_cursors.last_error END,
           updated_at = excluded.updated_at`,
      )
      .run(this.workspace, scope.remote, scope.repository, JSON.stringify(cursor), error ?? null, this.now(), error !== undefined ? 1 : 0);
  }

  seen<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K, key: string): RepoWatchSeen[K] | undefined {
    const row = this.db
      .prepare(`SELECT state_json FROM repo_watch_seen WHERE workspace = ? AND remote = ? AND repository = ? AND kind = ? AND key = ?`)
      .get(this.workspace, scope.remote, scope.repository, kind, key) as { state_json: string } | undefined;
    return row === undefined ? undefined : parse<RepoWatchSeen[K]>(row.state_json);
  }

  seenAll<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K): Map<string, RepoWatchSeen[K]> {
    const rows = this.db
      .prepare(`SELECT key, state_json FROM repo_watch_seen WHERE workspace = ? AND remote = ? AND repository = ? AND kind = ? ORDER BY key`)
      .all(this.workspace, scope.remote, scope.repository, kind) as Array<{ key: string; state_json: string }>;
    const out = new Map<string, RepoWatchSeen[K]>();
    for (const row of rows) {
      const state = parse<RepoWatchSeen[K]>(row.state_json);
      if (state !== undefined) out.set(row.key, state);
    }
    return out;
  }

  see<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K, key: string, state: RepoWatchSeen[K]): void {
    this.db
      .prepare(
        `INSERT INTO repo_watch_seen (workspace, remote, repository, kind, key, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace, remote, repository, kind, key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(this.workspace, scope.remote, scope.repository, kind, key, JSON.stringify(state), this.now());
  }

  forget(scope: RepoWatchScope, kind: RepoWatchKind, key: string): void {
    this.db.prepare(`DELETE FROM repo_watch_seen WHERE workspace = ? AND remote = ? AND repository = ? AND kind = ? AND key = ?`).run(this.workspace, scope.remote, scope.repository, kind, key);
  }
}

/** When a task's guards first waited on each event name — see `EventWaitPort`. */
export class EventWaitStore implements EventWaitPort {
  constructor(private readonly db: JairaDb) {}

  since(taskId: string, name: EventName): number | undefined {
    const row = this.db.prepare(`SELECT since FROM event_waits WHERE task_id = ? AND name = ?`).get(taskId, name) as { since: number } | undefined;
    return row?.since;
  }

  /** The first wait wins: a second call for the same name keeps the earlier start. */
  open(taskId: string, name: EventName, since: number): void {
    this.db.prepare(`INSERT INTO event_waits (task_id, name, since) VALUES (?, ?, ?) ON CONFLICT(task_id, name) DO NOTHING`).run(taskId, name, since);
  }

  closeTask(taskId: string): void {
    this.db.prepare(`DELETE FROM event_waits WHERE task_id = ?`).run(taskId);
  }
}
