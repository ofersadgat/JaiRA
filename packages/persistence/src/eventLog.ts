/**
 * Durable recording of the engine's EngineEvent stream (DESIGN §1a item 1):
 * the `Persistence` port the hw engine calls at every step, backed by the
 * append-only `events` journal. better-sqlite3 is synchronous, matching the
 * port's synchronous `record` contract exactly.
 */
import type { EngineEvent, Persistence } from "@ai-exec/hw";
import type { JairaDb } from "./db";

export interface StoredEvent {
  seq: number;
  taskId: string;
  runId: number;
  instanceId?: number;
  type: EngineEvent["type"];
  event: EngineEvent;
  createdAt: number;
}

interface RawEvent {
  seq: number;
  task_id: string;
  run_id: number;
  instance_id: number | null;
  type: string;
  payload_json: string;
  created_at: number;
}

export class SqliteEventLog {
  constructor(private readonly db: JairaDb) {}

  /** A `Persistence` implementation scoped to one task run. */
  recorder(taskId: string, runId: number): Persistence {
    const insert = this.db.prepare(
      `INSERT INTO events (task_id, run_id, instance_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    return {
      record: (event: EngineEvent, atMs: number): void => {
        insert.run(taskId, runId, event.instanceId ?? null, event.type, JSON.stringify(event), atMs);
      },
    };
  }

  list(taskId: string, opts?: { runId?: number; afterSeq?: number; limit?: number }): StoredEvent[] {
    const clauses = ["task_id = ?"];
    const params: unknown[] = [taskId];
    if (opts?.runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(opts.runId);
    }
    if (opts?.afterSeq !== undefined) {
      clauses.push("seq > ?");
      params.push(opts.afterSeq);
    }
    let sql = `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as RawEvent[];
    return rows.map((row) => ({
      seq: row.seq,
      taskId: row.task_id,
      runId: row.run_id,
      instanceId: row.instance_id ?? undefined,
      type: row.type as EngineEvent["type"],
      event: JSON.parse(row.payload_json) as EngineEvent,
      createdAt: row.created_at,
    }));
  }
}
