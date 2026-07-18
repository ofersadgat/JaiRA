/**
 * The `.jaira/` project layout (DESIGN §3) — one place computes every path so
 * the layout can never drift between packages.
 */
import { join, resolve } from "node:path";

export interface JairaPaths {
  projectDir: string;
  jairaDir: string;
  configFile: string;
  workflowsDir: string;
  snapshotsDir: string;
  tasksDir: string;
  skillsDir: string;
  dbFile: string;
}

export const JAIRA_DIR_NAME = ".jaira";

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
  };
}
