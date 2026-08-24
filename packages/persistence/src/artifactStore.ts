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
import type { RowLog } from "./rowFile";

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
  interactive: number;
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
    // Stored as 0/1, because SQLite has no boolean. Only `true` is carried onto the record, so a
    // static artifact stays absent rather than explicitly false — which is what every consumer
    // already treats as "not scriptable".
    ...(row.interactive ? { interactive: true } : {}),
    createdAt: row.created_at,
  };
}

export class SqliteArtifactStore implements ArtifactStore {
  /** `log` is present only when `config.storage.artifacts` puts the MAP in files (DESIGN §4.4). */
  constructor(
    private readonly db: JairaDb,
    private readonly log?: RowLog,
  ) {}

  /** Upsert: rewriting a logical path replaces the record, so a read gets the latest. */
  put(record: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts
           (task_id, run_id, logical_path, physical_path, content, hash, bytes, format,
            instance_id, state_id, slot, interactive, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           interactive = excluded.interactive,
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
        record.interactive === true ? 1 : 0,
        record.createdAt,
      );
    // Re-read rather than reconstructed: `put` is an upsert, so what the row now holds is not
    // simply what was passed — the conflict branch decides.
    this.log?.appendFrom(this.db, record.taskId, "artifacts", "task_id = ? AND logical_path = ?", [
      record.taskId,
      record.logicalPath,
    ]);
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
