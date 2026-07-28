/**
 * The command audit trail — `command_log` (DESIGN §4.2, §10.2).
 *
 * "Every requested, executed, blocked, and approved command lands in
 * `command_log`", which is what makes SPEC §10.2's run record real: after the
 * fact you can say what an agent asked to do, what policy decided, and — when a
 * human was involved — what they chose and for how long.
 *
 * This is the first of the deferred §4.2 tables to arrive, because policy is the
 * feature that needs it.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { JairaDb } from "./db";

/** What was decided about a command, and by whom. */
export type CommandDecision = "allowed" | "blocked" | "approved" | "denied";

/** Who decided: policy alone, or a human answering an escalation. */
export type CommandDecider = "policy" | "user";

export interface CommandLogEntry {
  taskId: string;
  runId: number;
  tool: string;
  /** The raw command line, when the tool takes one. */
  command?: string;
  /** Parsed intent, so the audit shows what policy actually matched on. */
  parsed?: JsonValue;
  decision: CommandDecision;
  decidedBy: CommandDecider;
  reason?: string;
  /** For an approved/denied entry: how long the human's answer applies. */
  scope?: string;
  /** The agent session the call belonged to. */
  sessionId?: string;
}

export interface StoredCommandLogEntry extends CommandLogEntry {
  id: number;
  createdAt: number;
}

interface RawRow {
  id: number;
  task_id: string;
  run_id: number;
  tool: string;
  command: string | null;
  parsed_json: string | null;
  decision: string;
  decided_by: string;
  reason: string | null;
  scope: string | null;
  session_id: string | null;
  created_at: number;
}

export class CommandLog {
  constructor(private readonly db: JairaDb) {}

  record(entry: CommandLogEntry, atMs = Date.now()): number {
    const res = this.db
      .prepare(
        `INSERT INTO command_log
           (task_id, run_id, tool, command, parsed_json, decision, decided_by, reason, scope, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.taskId,
        entry.runId,
        entry.tool,
        entry.command ?? null,
        entry.parsed !== undefined ? JSON.stringify(entry.parsed) : null,
        entry.decision,
        entry.decidedBy,
        entry.reason ?? null,
        entry.scope ?? null,
        entry.sessionId ?? null,
        atMs,
      );
    return Number(res.lastInsertRowid);
  }

  list(taskId: string, opts?: { runId?: number; limit?: number }): StoredCommandLogEntry[] {
    const clauses = ["task_id = ?"];
    const params: unknown[] = [taskId];
    if (opts?.runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(opts.runId);
    }
    let sql = `SELECT * FROM command_log WHERE ${clauses.join(" AND ")} ORDER BY id`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return (this.db.prepare(sql).all(...params) as RawRow[]).map((row) => ({
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      tool: row.tool,
      ...(row.command !== null ? { command: row.command } : {}),
      ...(row.parsed_json !== null ? { parsed: JSON.parse(row.parsed_json) as JsonValue } : {}),
      decision: row.decision as CommandDecision,
      decidedBy: row.decided_by as CommandDecider,
      ...(row.reason !== null ? { reason: row.reason } : {}),
      ...(row.scope !== null ? { scope: row.scope } : {}),
      ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
      createdAt: row.created_at,
    }));
  }

  /** Counts per decision, for a run summary. */
  summary(taskId: string, runId?: number): Record<CommandDecision, number> {
    const totals: Record<CommandDecision, number> = { allowed: 0, blocked: 0, approved: 0, denied: 0 };
    for (const entry of this.list(taskId, runId !== undefined ? { runId } : {})) totals[entry.decision]++;
    return totals;
  }
}
