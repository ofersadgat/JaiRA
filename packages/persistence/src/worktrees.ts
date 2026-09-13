/**
 * Branch binding and worktree lifecycle (DESIGN §9.2, SPEC §10.5).
 *
 * A task is created either *unbound* — it runs against the project directory —
 * or bound to a branch. A bound task materializes a git worktree on first
 * activation, under `<project-parent>/.jaira-worktrees/<projectName>/<taskId>/`,
 * and the path is recorded in `task_runtime.worktree_path` so the mapping survives
 * restarts (DESIGN §3).
 *
 * The worktree lives outside the project on purpose: an agent is scoped to it, and
 * it must not contain `.jaira/`. Removal is deliberate rather than automatic —
 * `git worktree remove` refuses to discard uncommitted work unless forced, and
 * that refusal is a feature, so the caller decides.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import { existsSync, mkdirSync } from "node:fs";
import { worktreePathFor, type JairaExecEnvironment, type TaskMeta } from "@jaira/shared";
import { Git, NodeExec, type Exec, type ExecEnv } from "@jaira/runtime";
import type { Project } from "./project";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.worktrees");

/** The workspace a task's run executes in. */
export interface TaskWorkspace {
  /** Absolute path as the HOST sees it (what Node's `fs` can read). */
  root: string;
  /** Git tree hash, when the workspace is a git worktree — the memo identity. */
  treeHash?: string;
  branch?: string;
  /** False when the task is unbound and runs against the project directory. */
  isWorktree: boolean;
}

export interface WorktreeOptions {
  exec?: Exec;
  /** Overrides the project config's `execEnvironment`. */
  execEnv?: ExecEnv;
}

function envOf(project: Project, options?: WorktreeOptions): ExecEnv {
  if (options?.execEnv !== undefined) return options.execEnv;
  const configured: JairaExecEnvironment = project.config.execEnvironment;
  return configured;
}

export function gitFor(project: Project, dir: string, options?: WorktreeOptions): Git {
  return new Git({
    exec: options?.exec ?? new NodeExec(),
    repoDir: dir,
    execEnv: envOf(project, options),
  });
}

/**
 * Ensure the workspace for a task, creating its worktree if the task is bound and
 * the worktree does not exist yet. Idempotent: a re-run of an interrupted task
 * reuses the existing worktree rather than failing on an occupied path.
 */
export async function ensureWorkspace(
  project: Project,
  taskId: string,
  options?: WorktreeOptions,
): Promise<TaskWorkspace> {
  const meta = project.tasks.read(taskId);
  const git = gitFor(project, project.paths.projectDir, options);

  // A task a mount made (decision 0003, `each: "task"`) is its parent's own work and runs in its
  // parent's workspace — the worktree the parent's branch materialized, or the project directory
  // where the parent is unbound. It has no branch of its own and never gets one here.
  if (meta.origin?.kind === "task") {
    const parent = project.tasks.tryRead(meta.origin.taskId);
    const parentRow = project.runtime.get(meta.origin.taskId);
    if (parent?.branch !== undefined) {
      const root = parentRow?.worktreePath;
      if (root === undefined || !existsSync(root)) {
        throw refusal(log, `task '${taskId}' runs in its parent's worktree, and '${meta.origin.taskId}' has none materialized`, { taskId });
      }
      const treeHash = await gitFor(project, root, options).treeHash();
      return { root, isWorktree: true, branch: parent.branch, ...(treeHash !== undefined ? { treeHash } : {}) };
    }
    const treeHash = (await git.isRepo()) ? await git.treeHash() : undefined;
    return { root: project.paths.projectDir, isWorktree: false, ...(treeHash !== undefined ? { treeHash } : {}) };
  }

  if (meta.branch === undefined) {
    // Unbound: the project directory itself, with a tree hash when it is a repo
    // (so a workspace-mutating op still has an identity to memoize under).
    const treeHash = (await git.isRepo()) ? await git.treeHash() : undefined;
    return { root: project.paths.projectDir, isWorktree: false, ...(treeHash !== undefined ? { treeHash } : {}) };
  }

  if (!(await git.isRepo())) {
    throw refusal(log, 
      `task '${taskId}' is bound to branch '${meta.branch}' but ${project.paths.projectDir} is not a git repository`,
    );
  }

  const row = project.runtime.get(taskId);
  const recorded = row?.worktreePath;
  const path = recorded ?? worktreePathFor(project.paths, taskId);

  if (!existsSync(path)) {
    // A recorded path whose directory is gone is a crash residue: git still holds
    // an administrative record for it, and `worktree add` would refuse the path
    // until it is pruned.
    if (recorded !== undefined) await git.pruneWorktrees();
    mkdirSync(project.paths.worktreesDir, { recursive: true });
    // A branch cut for a task that DEPENDS on another (decision 0003) starts from the head of the
    // dependency finished most recently — its code is what this task builds on, and the ordering
    // the dependency expressed is what makes that head exist by now. Only where the branch is new:
    // an existing branch is what it is, and `addWorktree` ignores the start point for one.
    await git.addWorktree(path, meta.branch, dependencyBaseOf(project, meta));
  }

  // Record the mapping as soon as the worktree exists, so a crash between here and
  // the run leaves a discoverable (and prunable) worktree rather than an orphan.
  if (recorded !== path) project.runtime.setWorktree(taskId, path, Date.now());

  const inWorktree = gitFor(project, path, options);
  const treeHash = await inWorktree.treeHash();
  return {
    root: path,
    isWorktree: true,
    branch: meta.branch,
    ...(treeHash !== undefined ? { treeHash } : {}),
  };
}

/**
 * The branch a dependent task's own branch should start from: the branch of the completed dependency
 * that ended LAST, since the ordering runs one way and the latest head has the earlier ones under it
 * where the chain is a chain. A dependency without a branch (an unbound task) or one still unfinished
 * contributes nothing, and with nothing to go on the branch starts where a fresh one does.
 */
export function dependencyBaseOf(project: Project, meta: Pick<TaskMeta, "dependsOn">): string | undefined {
  let base: { branch: string; endedAt: number } | undefined;
  for (const dependency of meta.dependsOn ?? []) {
    const row = project.runtime.get(dependency);
    if (row === undefined || row.status !== "completed" || row.branch === undefined) continue;
    const endedAt = row.endedAt ?? 0;
    if (base === undefined || endedAt > base.endedAt) base = { branch: row.branch, endedAt };
  }
  return base?.branch;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Set when removal was refused because the worktree holds uncommitted work. */
  reason?: string;
}

/**
 * Remove a task's worktree. Without `force`, git refuses when the worktree has
 * modified or untracked files and the refusal is reported rather than thrown — the
 * UI asks the user before destroying work (DESIGN §9.2: "when the task completes
 * and the user confirms").
 */
export async function removeWorktree(
  project: Project,
  taskId: string,
  options?: WorktreeOptions & { force?: boolean },
): Promise<RemoveWorktreeResult> {
  const row = project.runtime.get(taskId);
  const path = row?.worktreePath;
  if (path === undefined) return { removed: false, reason: `task '${taskId}' has no worktree` };

  const git = gitFor(project, project.paths.projectDir, options);
  if (!existsSync(path)) {
    // Directory already gone: drop git's record and forget the mapping.
    await git.pruneWorktrees();
    project.runtime.clearWorktree(taskId, Date.now());
    return { removed: true };
  }
  try {
    await git.removeWorktree(path, { ...(options?.force ? { force: true } : {}) });
  } catch (e) {
    return { removed: false, reason: (e as Error).message };
  }
  project.runtime.clearWorktree(taskId, Date.now());
  return { removed: true };
}
