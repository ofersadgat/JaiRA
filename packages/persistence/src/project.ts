/**
 * Opening a JaiRA project: layout creation, config load, DB open, and startup
 * crash recovery (DESIGN §4.3 as revised by §1a item 1).
 *
 * v1 ownership model: one process at a time owns a project's `.jaira/`.
 * Recovery therefore treats every `running` task found at open time as
 * interrupted — there is no live engine that could still be driving it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, jairaPaths, parseConfig, readJsonFile, type JairaConfig, type JairaPaths } from "@jaira/shared";
import { openDb, type JairaDb } from "./db";
import { SqliteArtifactStore } from "./artifactStore";
import { CommandLog } from "./commandLog";
import { SqliteEventLog } from "./eventLog";
import { RuntimeStore } from "./runtime";
import { TaskFileStore } from "./taskStore";

export interface Project {
  paths: JairaPaths;
  config: JairaConfig;
  db: JairaDb;
  tasks: TaskFileStore;
  runtime: RuntimeStore;
  events: SqliteEventLog;
  /** The command audit trail (DESIGN §4.2, §10.2). */
  commands: CommandLog;
  /** The artifact map: logical path → where the bytes went (DESIGN §7.6). */
  artifacts: SqliteArtifactStore;
  /** Task ids marked `interrupted` by recovery during this open. */
  recovered: string[];
  close(): void;
}

/**
 * What of `.jaira/` should NOT be committed.
 *
 * `workflows/`, `tasks/` and `skills/` are source — hand-edited and worth
 * versioning. The database and the snapshot cache are derived per-checkout state:
 * committing them would put one machine's run history into everyone's tree, and
 * (because a worktree checkout mirrors the branch) would copy a stale database
 * into every task worktree.
 */
const JAIRA_GITIGNORE = `# Derived state — see DESIGN §3. Workflows, tasks and skills ARE meant to be committed.
jaira.db
jaira.db-wal
jaira.db-shm
snapshots/
`;

/** Create the `.jaira/` layout (DESIGN §3). Idempotent; keeps an existing config. */
export function initProject(projectDir: string): JairaPaths {
  const paths = jairaPaths(projectDir);
  mkdirSync(paths.workflowsDir, { recursive: true });
  mkdirSync(paths.snapshotsDir, { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
  mkdirSync(paths.skillsDir, { recursive: true });
  if (!existsSync(paths.configFile)) {
    writeFileSync(paths.configFile, JSON.stringify(defaultConfig(), null, 2) + "\n", "utf8");
  }
  const ignoreFile = join(paths.jairaDir, ".gitignore");
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, JAIRA_GITIGNORE, "utf8");
  return paths;
}

export function isProject(projectDir: string): boolean {
  return existsSync(jairaPaths(projectDir).jairaDir);
}

export function openProject(projectDir: string, opts?: { now?: () => number }): Project {
  const paths = jairaPaths(projectDir);
  if (!existsSync(paths.jairaDir)) {
    throw new Error(`${paths.projectDir} is not a JaiRA project (no .jaira/ — run 'jaira init')`);
  }
  const now = opts?.now ?? Date.now;
  const config = existsSync(paths.configFile)
    ? parseConfig(readJsonFile(paths.configFile))
    : defaultConfig();
  const db = openDb(paths.dbFile);
  const runtime = new RuntimeStore(db);
  const recovered = runtime.recoverInterrupted(now());
  return {
    paths,
    config,
    db,
    tasks: new TaskFileStore(paths.tasksDir),
    runtime,
    events: new SqliteEventLog(db),
    commands: new CommandLog(db),
    artifacts: new SqliteArtifactStore(db),
    recovered,
    close: () => db.close(),
  };
}
