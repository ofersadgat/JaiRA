/**
 * Durable recording of the engine's EngineEvent stream (DESIGN §1a item 1):
 * the `Persistence` port the hw engine calls at every step, backed by the
 * append-only `state_machine_events` journal (the rename of `events`,
 * CHANGESETS.md §5.1 — lifecycle truth, and nothing else rides in it).
 * better-sqlite3 is synchronous, matching the port's synchronous `record`
 * contract exactly.
 *
 * The journal is deliberately schema-light — `type` plus the whole event as
 * JSON — so the engine's event vocabulary can evolve without a migration. It
 * already has once: `operation.*` events carry `op: "prompt" | "function"`
 * since the declarative-ai ops redesign (was `ui | agent | skill`).
 */
import type { EngineEvent, Persistence } from "@declarative-ai/hw";
import type { JairaDb } from "./db";
import { appendJournal } from "./journalFile";

export interface StoredEvent {
  seq: number;
  taskId: string;
  instanceId?: string;
  type: EngineEvent["type"];
  event: EngineEvent;
  createdAt: number;
  /** The settled operation's content id, when the event carries one — the record-store join (§10.6). */
  operationId?: string;
}

interface RawEvent {
  seq: number;
  task_id: string;
  instance_id: string | null;
  type: string;
  payload_json: string;
  created_at: number;
}

/** The event's instance id, when the event names one — `instance.blocked` never does. */
function instanceIdOf(event: EngineEvent): string | undefined {
  return (event as { instanceId?: string }).instanceId;
}

export class SqliteEventLog {
  /**
   * `journalDir` is given only when `config.storage.journal` puts the journal in files (DESIGN §4.4).
   * Absent means the table is the truth, which is the default and what every open did before.
   */
  constructor(
    private readonly db: JairaDb,
    private readonly journalDir?: string,
  ) {}

  /** A `Persistence` implementation scoped to one task. */
  recorder(taskId: string): Persistence {
    const insert = this.db.prepare(
      `INSERT INTO state_machine_events (task_id, instance_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const journalDir = this.journalDir;
    return {
      record: (event: EngineEvent, atMs: number): void => {
        const instanceId = instanceIdOf(event);
        // The FILE first, and synchronously. It is the truth when there is one, so an event that
        // reached the table and not the disk would be an event a replay does not have — the exact
        // shape of loss the design refuses by not making the table a write-back cache.
        if (journalDir !== undefined) {
          appendJournal(journalDir, {
            type: event.type,
            timestamp: new Date(atMs).toISOString(),
            taskId,
            ...(instanceId !== undefined ? { instanceId } : {}),
            event,
          });
        }
        insert.run(taskId, instanceId ?? null, event.type, JSON.stringify(event), atMs);
      },
    };
  }

  list(taskId: string, opts?: { afterSeq?: number; limit?: number }): StoredEvent[] {
    const clauses = ["task_id = ?"];
    const params: unknown[] = [taskId];
    if (opts?.afterSeq !== undefined) {
      clauses.push("seq > ?");
      params.push(opts.afterSeq);
    }
    let sql = `SELECT * FROM state_machine_events WHERE ${clauses.join(" AND ")} ORDER BY seq`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as RawEvent[];
    return rows.map((row) => {
      const event = JSON.parse(row.payload_json) as EngineEvent;
      const operationId = (event as { operationId?: string }).operationId;
      return {
        seq: row.seq,
        taskId: row.task_id,
        instanceId: row.instance_id ?? undefined,
        type: row.type as EngineEvent["type"],
        event,
        createdAt: row.created_at,
        ...(operationId !== undefined ? { operationId } : {}),
      };
    });
  }
}
