/**
 * Comments on a published artifact (the design canvas's comment mode): a pin on an artboard, at a place
 * on it and over the element there, with what the person wrote.
 *
 * Kept beside the versions, never in them: a comment is not part of the design, and written into
 * `canvas.json` it would be a person's edit of that file — the model's next publish of it refused for a
 * note. So it outlives the version it was written on, and the pin stays where it was put on the artboard.
 *
 * Only in the database, whatever `storage.artifacts` says: a comment is resolved and deleted, which a
 * row file's last-wins log would carry as rows that never leave.
 */
import type { ArtifactComment } from "@jaira/shared";
import type { JairaDb } from "./db";

interface RawComment {
  id: string;
  task_id: string;
  artifact: string;
  file: string;
  x: number;
  y: number;
  element_json: string | null;
  version: number;
  text: string;
  to_claude: number;
  sent_at: number | null;
  resolved_at: number | null;
  created_at: number;
}

function toComment(row: RawComment): ArtifactComment {
  return {
    id: row.id,
    taskId: row.task_id,
    artifact: row.artifact,
    file: row.file,
    x: row.x,
    y: row.y,
    ...(row.element_json !== null ? { element: JSON.parse(row.element_json) as NonNullable<ArtifactComment["element"]> } : {}),
    version: row.version,
    text: row.text,
    toClaude: row.to_claude === 1,
    ...(row.sent_at !== null ? { sentAt: row.sent_at } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    createdAt: row.created_at,
  };
}

/** A new comment's id. */
export const commentId = (): string => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class ArtifactCommentStore {
  constructor(private readonly db: JairaDb) {}

  add(comment: ArtifactComment): ArtifactComment {
    this.db
      .prepare(
        `INSERT INTO artifact_comments (id, task_id, artifact, file, x, y, element_json, version, text, to_claude, sent_at, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comment.id,
        comment.taskId,
        comment.artifact,
        comment.file,
        comment.x,
        comment.y,
        comment.element !== undefined ? JSON.stringify(comment.element) : null,
        comment.version,
        comment.text,
        comment.toClaude ? 1 : 0,
        comment.sentAt ?? null,
        comment.resolvedAt ?? null,
        comment.createdAt,
      );
    return comment;
  }

  /** A task's comments on one artifact, oldest first. */
  list(taskId: string, artifact: string): ArtifactComment[] {
    const rows = this.db.prepare(`SELECT * FROM artifact_comments WHERE task_id = ? AND artifact = ? ORDER BY created_at, id`).all(taskId, artifact) as RawComment[];
    return rows.map(toComment);
  }

  get(taskId: string, id: string): ArtifactComment | undefined {
    const row = this.db.prepare(`SELECT * FROM artifact_comments WHERE task_id = ? AND id = ?`).get(taskId, id) as RawComment | undefined;
    return row !== undefined ? toComment(row) : undefined;
  }

  /** Sent into the task's conversation at `at`. */
  markSent(taskId: string, id: string, at: number): void {
    this.db.prepare(`UPDATE artifact_comments SET sent_at = ? WHERE task_id = ? AND id = ?`).run(at, taskId, id);
  }

  /** Resolved at `at`, or open again (`null`). */
  resolve(taskId: string, id: string, at: number | null): void {
    this.db.prepare(`UPDATE artifact_comments SET resolved_at = ? WHERE task_id = ? AND id = ?`).run(at, taskId, id);
  }

  remove(taskId: string, id: string): void {
    this.db.prepare(`DELETE FROM artifact_comments WHERE task_id = ? AND id = ?`).run(taskId, id);
  }
}
