/**
 * The durable artifact map — `artifacts` (DESIGN §7.6, §4.2).
 *
 * Implements `@jaira/runtime`'s `ArtifactStore` against SQLite. The interface lives
 * in runtime and the implementation here because the dependency runs that way:
 * runtime must not import persistence, so the app and CLI inject this.
 *
 * Durability is the point. A per-process map would resolve a logical path only for
 * the state that wrote it; a later state, a later run, and the artifacts panel all
 * need the same answer, and "where did that file go" must survive a restart.
 */
import type { ArtifactRecord, ArtifactStore } from "@jaira/runtime";
import type { JairaDb } from "./db";

interface RawArtifact {
  task_id: string;
  run_id: number | null;
  logical_path: string;
  physical_path: string | null;
  content: string | null;
  hash: string;
  bytes: number;
  format: string | null;
  instance_id: number | null;
  state_id: string | null;
  slot: string | null;
  created_at: number;
}

function toRecord(row: RawArtifact): ArtifactRecord {
  return {
    taskId: row.task_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    logicalPath: row.logical_path,
    ...(row.physical_path !== null ? { physicalPath: row.physical_path } : {}),
    ...(row.content !== null ? { content: row.content } : {}),
    hash: row.hash,
    bytes: row.bytes,
    ...(row.format !== null ? { format: row.format } : {}),
    ...(row.instance_id !== null ? { instanceId: row.instance_id } : {}),
    ...(row.state_id !== null ? { stateId: row.state_id } : {}),
    ...(row.slot !== null ? { slot: row.slot } : {}),
    createdAt: row.created_at,
  };
}

export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly db: JairaDb) {}

  /** Upsert: rewriting a logical path replaces the record, so a read gets the latest. */
  put(record: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts
           (task_id, run_id, logical_path, physical_path, content, hash, bytes, format,
            instance_id, state_id, slot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, logical_path) DO UPDATE SET
           run_id = excluded.run_id,
           physical_path = excluded.physical_path,
           content = excluded.content,
           hash = excluded.hash,
           bytes = excluded.bytes,
           format = excluded.format,
           instance_id = excluded.instance_id,
           state_id = excluded.state_id,
           slot = excluded.slot,
           created_at = excluded.created_at`,
      )
      .run(
        record.taskId,
        record.runId ?? null,
        record.logicalPath,
        record.physicalPath ?? null,
        record.content ?? null,
        record.hash,
        record.bytes,
        record.format ?? null,
        record.instanceId ?? null,
        record.stateId ?? null,
        record.slot ?? null,
        record.createdAt,
      );
  }

  get(taskId: string, logicalPath: string): ArtifactRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM artifacts WHERE task_id = ? AND logical_path = ?`)
      .get(taskId, logicalPath) as RawArtifact | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(taskId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE task_id = ? ORDER BY id`)
      .all(taskId) as RawArtifact[];
    return rows.map(toRecord);
  }
}
