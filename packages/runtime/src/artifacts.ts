/**
 * The artifact map (DESIGN §7.6): what an agent *thinks* it wrote, and where the
 * bytes actually went.
 *
 * The invariant this exists to keep: **a write to `P` followed by a read of `P`
 * returns the content**, whatever the configured destination did with the file. The
 * agent is never told its file moved, so a workflow authored against one
 * destination runs unchanged against another.
 *
 * The store is an interface rather than a table because of package layering:
 * `@jaira/runtime` must not import `@jaira/persistence` (the dependency runs the
 * other way). The app and CLI inject a SQLite-backed store; everything else gets
 * the in-memory one, which is also what `virtual:` uses.
 */

/** One recorded write: the logical path an agent used → where it landed. */
export interface ArtifactRecord {
  taskId: string;
  runId?: number;
  /** The path as the producer addressed it, relative to the workspace, `/`-separated. */
  logicalPath: string;
  /** Absolute host path. Absent when the destination is `virtual:`. */
  physicalPath?: string;
  /** Inline content — always present for `virtual:`, and for small files. */
  content?: string;
  /** sha-256 of the content, for identity independent of location. */
  hash: string;
  bytes: number;
  format?: string;
  /** Which instance and output slot produced it, when it came from one. */
  instanceId?: number;
  stateId?: string;
  slot?: string;
  createdAt: number;
}

export interface ArtifactStore {
  /** Record a write, replacing any previous record for the same logical path. */
  put(record: ArtifactRecord): void;
  /** The most recent record for a logical path within a task. */
  get(taskId: string, logicalPath: string): ArtifactRecord | undefined;
  list(taskId: string): ArtifactRecord[];
}

/** The default store: run-scoped, in memory. Also the whole of `virtual:`. */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly byTask = new Map<string, Map<string, ArtifactRecord>>();

  put(record: ArtifactRecord): void {
    const key = record.taskId;
    const map = this.byTask.get(key) ?? new Map<string, ArtifactRecord>();
    map.set(record.logicalPath, record);
    this.byTask.set(key, map);
  }

  get(taskId: string, logicalPath: string): ArtifactRecord | undefined {
    return this.byTask.get(taskId)?.get(logicalPath);
  }

  list(taskId: string): ArtifactRecord[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])];
  }
}
