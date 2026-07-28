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
import { JobStore, type JobRow } from "./jobs";
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
  /** Process claims and child processes (DESIGN §4.2a). */
  jobs: JobStore;
  /** Task ids marked `interrupted` by recovery during this open. */
  recovered: string[];
  /**
   * Child processes found still open with no live owner — abandoned agents and
   * commands from a previous, crashed process. Reported, never killed.
   */
  orphans: JobRow[];
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

export function openProject(projectDir: string, opts?: { now?: () => number; staleMs?: number }): Project {
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
  const jobs = new JobStore(db, opts?.staleMs);

  // Read orphans BEFORE reaping: the rows are the only record those processes ever
  // existed, and an abandoned agent is still running and still billing.
  const at = now();
  const orphans = jobs.orphans(at);
  // A task with a live claim is being driven by another process right now — the
  // whole point of §4.2a. Only genuinely abandoned tasks are recovered.
  const recovered = runtime.recoverInterrupted(at, (taskId) => jobs.liveRunJob(taskId, at) !== undefined);
  jobs.reapStale(at);

  return {
    paths,
    config,
    db,
    tasks: new TaskFileStore(paths.tasksDir),
    runtime,
    events: new SqliteEventLog(db),
    commands: new CommandLog(db),
    artifacts: new SqliteArtifactStore(db),
    jobs,
    recovered,
    orphans,
    close: () => db.close(),
  };
}
