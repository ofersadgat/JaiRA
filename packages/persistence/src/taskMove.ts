/**
 * A conversation MOVED to another workspace of its project (decision 0013 ruling 7, built 2026-11-20:
 * "move it there"). Its id, its journal, its records and what it was asking go with it; what tied it
 * to the place it left does not:
 *
 * - the agent's own session handle (`sessions.provider_session_id`): the agent keeps its session in a
 *   file under the folder it ran in, on the machine it ran on, so the next call there cannot resume it.
 *   With no handle the next call replays the conversation from the records — the same path a rewind
 *   takes (`cutSession`) — and earns a handle of its own.
 * - its worktree (`task_runtime.worktree_path`): a folder of the checkout it left. The next run makes
 *   one in the new checkout when its task has a branch.
 *
 * Within one machine every workspace shares the database, so a move is the owner row re-pointed and
 * the task file carried across. Between machines the task travels as a replica's `TaskBundle`, and the
 * machine taking it in becomes its owner: a copy it held of the task as a replica is let go first.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { JairaDb } from "./db";
import { importTask, removeReplicaTask, writeSnapshot, type ReplicaDirs, type TaskBundle } from "./replica";
import { ownerOf } from "./workspace";

/** Where a workspace keeps a task's file and the snapshots its runs are pinned to. */
export interface MoveDirs {
  tasksDir: string;
  snapshotsDir: string;
}

/**
 * The task's own sessions forget the agent's handle, and its runtime row its worktree. Only its OWN
 * sessions — those its records and names point at — not the ancestors a fork of it starts from, which
 * other conversations may still continue.
 */
export function forgetPlace(db: JairaDb, taskId: string): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET provider_session_id = NULL, provider = NULL WHERE id IN (
         SELECT session_id FROM operation_records WHERE task_id = :t AND session_id IS NOT NULL
         UNION SELECT landed_session_id FROM operation_records WHERE task_id = :t AND landed_session_id IS NOT NULL
         UNION SELECT session_id FROM session_names WHERE task_id = :t)`,
    ).run({ t: taskId });
    db.prepare(`UPDATE task_runtime SET worktree_path = NULL WHERE task_id = ?`).run(taskId);
  })();
}

/**
 * Hand a task to another workspace in the same database: the owner row, then the task file and the
 * snapshot it runs under, carried to the new workspace's folders. Refused (an error) unless `from`
 * owns it.
 */
export function moveTaskLocally(db: JairaDb, taskId: string, from: { workspace: string } & MoveDirs, to: { workspace: string } & MoveDirs, snapshot?: string): void {
  const owner = ownerOf(db, taskId);
  if (owner !== from.workspace) throw new Error(`task '${taskId}' is not this workspace's to move`);
  db.prepare(`UPDATE task_owners SET workspace = ? WHERE task_id = ?`).run(to.workspace, taskId);
  forgetPlace(db, taskId);
  carry(join(from.tasksDir, `${taskId}.json`), join(to.tasksDir, `${taskId}.json`), to.tasksDir);
  if (snapshot !== undefined) {
    const there = join(to.snapshotsDir, snapshot);
    // Another task of the new workspace may run under the same snapshot: it stays where it is.
    if (!existsSync(there) && existsSync(join(from.snapshotsDir, snapshot))) cpSync(join(from.snapshotsDir, snapshot), there, { recursive: true });
  }
}

/**
 * Take in a task moved here from another machine, as this workspace's own. A copy this machine held
 * of it as a replica (it was that machine's, and copied here) is let go first; a task another of THIS
 * machine's workspaces owns is refused. `replicaDirsOf` says where a replica workspace's files are.
 */
export function importMovedTask(
  db: JairaDb,
  workspace: string,
  bundle: TaskBundle,
  blobs: Record<string, string>,
  dirs: ReplicaDirs,
  snapshotFiles: Record<string, string> | undefined,
  replicaDirsOf: (workspace: string) => ReplicaDirs | undefined,
): void {
  const id = bundle.taskId;
  const owner = ownerOf(db, id);
  if (owner !== undefined && owner !== workspace) {
    const row = db.prepare(`SELECT machine FROM workspaces WHERE id = ?`).get(owner) as { machine: string | null } | undefined;
    const replicaDirs = row?.machine !== null && row?.machine !== undefined ? replicaDirsOf(owner) : undefined;
    if (replicaDirs === undefined) throw new Error(`task '${id}' already belongs to another workspace on this machine`);
    removeReplicaTask(db, owner, id, replicaDirs);
  }
  if (!importTask(db, workspace, { ...bundle, full: true }, blobs, dirs)) throw new Error(`task '${id}' could not be taken in`);
  // `importTask` keeps a replica's bookkeeping — which of the owner's journal numbers it holds — and
  // this workspace is the owner now: there is nobody's numbering to keep.
  db.transaction(() => {
    db.prepare(`DELETE FROM replica_seqs WHERE workspace = ? AND local_seq IN (SELECT seq FROM main.state_machine_events WHERE task_id = ?)`).run(workspace, id);
    db.prepare(`DELETE FROM replica_versions WHERE workspace = ? AND task_id = ?`).run(workspace, id);
  })();
  forgetPlace(db, id);
  if (bundle.snapshot !== undefined && snapshotFiles !== undefined && Object.keys(snapshotFiles).length > 0) writeSnapshot(dirs, bundle.snapshot, snapshotFiles);
}

/**
 * The leaving workspace lets go of a task that went to another machine, once its rows are deleted: the
 * owner row a delete keeps (so no clone takes the id up) goes too, or this machine would still answer
 * for the task, and refuse the copy of it the machine it went to sends back.
 */
export function releaseMovedTask(db: JairaDb, workspace: string, taskId: string): void {
  db.prepare(`DELETE FROM task_owners WHERE task_id = ? AND workspace = ?`).run(taskId, workspace);
}

function carry(from: string, to: string, dir: string): void {
  if (!existsSync(from) || from === to) return;
  mkdirSync(dir, { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    // Another volume: copied, then let go.
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}
