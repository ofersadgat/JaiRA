/**
 * Words typed into a composer and not sent, kept by the engine that owns the conversation (decision
 * 0018 §9): a draft is the person's, so it reaches their other devices through the change log, and the
 * later write wins by this engine's clock when it arrives.
 *
 * Kept under the composer's own key — `chat:<task>`, `task:<task>#<instance>`, `chat:new:<project>` —
 * with the task it belongs to where it belongs to one. An empty draft is no draft: its row goes.
 */
import type { JairaDb } from "./db";

export interface Draft {
  text: string;
  /** When this engine received it. */
  at: number;
}

export function draftOf(db: JairaDb, key: string): Draft | null {
  const row = db.prepare(`SELECT text, updated_at FROM drafts WHERE key = ?`).get(key) as { text: string; updated_at: number } | undefined;
  return row === undefined ? null : { text: row.text, at: row.updated_at };
}

export function keepDraft(db: JairaDb, key: string, taskId: string | null, text: string, nowMs = Date.now()): void {
  if (text.length === 0) {
    db.prepare(`DELETE FROM drafts WHERE key = ?`).run(key);
    return;
  }
  db.prepare(
    `INSERT INTO drafts (key, task_id, text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET task_id = excluded.task_id, text = excluded.text, updated_at = excluded.updated_at`,
  ).run(key, taskId, text, nowMs);
}
