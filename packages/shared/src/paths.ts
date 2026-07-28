/**
 * The `.jaira/` project layout (DESIGN §3) — one place computes every path so
 * the layout can never drift between packages.
 */
import { basename, dirname, join, resolve } from "node:path";

export interface JairaPaths {
  projectDir: string;
  jairaDir: string;
  configFile: string;
  workflowsDir: string;
  snapshotsDir: string;
  tasksDir: string;
  skillsDir: string;
  dbFile: string;
  /**
   * Root for this project's task worktrees, **outside** the project directory
   * (DESIGN §3): an agent is scoped to a worktree, and that worktree must not
   * contain `.jaira/`. Layout:
   * `<project-parent>/.jaira-worktrees/<projectName>/<taskId>/`.
   */
  worktreesDir: string;
}

export const JAIRA_DIR_NAME = ".jaira";
export const WORKTREES_DIR_NAME = ".jaira-worktrees";

export function jairaPaths(projectDir: string): JairaPaths {
  const root = resolve(projectDir);
  const jairaDir = join(root, JAIRA_DIR_NAME);
  return {
    projectDir: root,
    jairaDir,
    configFile: join(jairaDir, "config.json"),
    workflowsDir: join(jairaDir, "workflows"),
    snapshotsDir: join(jairaDir, "snapshots"),
    tasksDir: join(jairaDir, "tasks"),
    skillsDir: join(jairaDir, "skills"),
    dbFile: join(jairaDir, "jaira.db"),
    worktreesDir: join(dirname(root), WORKTREES_DIR_NAME, basename(root)),
  };
}

/** Where a task's worktree lives (DESIGN §3, §9.2). */
export function worktreePathFor(paths: JairaPaths, taskId: string): string {
  return join(paths.worktreesDir, taskId);
}
