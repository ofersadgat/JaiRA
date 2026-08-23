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
import {
  baseAsProjectPaths,
  defaultConfig,
  jairaBasePaths,
  jairaPaths,
  mergeConfigDocuments,
  parseConfig,
  readJsonFile,
  systemProjectDir,
  type JairaBasePaths,
  type JairaConfig,
  type JairaPaths,
} from "@jaira/shared";
import { openDb, type JairaDb } from "./db";
import { SqliteArtifactStore } from "./artifactStore";
import { CommandLog } from "./commandLog";
import { JobStore, type JobRow } from "./jobs";
import { SqliteEventLog } from "./eventLog";
import { RuntimeStore } from "./runtime";
import { TaskFileStore } from "./taskStore";

export interface Project {
  /**
   * A user's checkout, or JaiRA's own.
   *
   * `system` is the shared root opened as a project in its own right, so JaiRA's workflows — the
   * description sync, summarization, the conformance check — have somewhere to be recorded. It is
   * not a decoration: `createTask` refuses a branch on one, which is what keeps those runs out of
   * anybody's worktrees.
   */
  kind: "project" | "shared" | "system";
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

# Machine-local: what this disk has agreed to RUN (SPEC §7.5.5). An approval is a
# statement about a file on ONE disk, so syncing it would let one machine confer
# trust on the rest.
approvals.local.json
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

/**
 * Create the shared base root's layout. Idempotent, and called on every open.
 *
 * Created eagerly rather than on first use so the directory a user is told to put shared workflows
 * in actually exists — an empty `~/.jaira/workflows` is a working answer to "where do these go?",
 * where a missing one is a question. No `config.json` is written: an absent base config means "no
 * base layer", which is a different and better default than one full of defaults that then silently
 * override nothing.
 */
export function initBase(baseDir?: string): JairaBasePaths {
  const base = jairaBasePaths(baseDir);
  mkdirSync(base.workflowsDir, { recursive: true });
  mkdirSync(base.functionsDir, { recursive: true });
  mkdirSync(base.skillsDir, { recursive: true });
  // Run state for JaiRA's own project. Created with the rest so the layout is whole after one call,
  // rather than half-created until the first system run happens to need the other half.
  mkdirSync(base.snapshotsDir, { recursive: true });
  mkdirSync(base.tasksDir, { recursive: true });
  // The same rule a project's `.jaira/` follows, for a stronger reason: plenty of people keep their
  // home directory in a synced folder or a dotfiles repository, and a database that lands there is
  // one machine's run history replicated onto every other.
  const ignoreFile = join(base.baseDir, ".gitignore");
  if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, JAIRA_GITIGNORE, "utf8");
  return base;
}

/**
 * Open the SELECTED root as a project in its own right (DESIGN §3.1, amended).
 *
 * Where a run of a workflow living in `<root>/workflows` is recorded. Scoped to the root by
 * construction — it IS the root — which is the property that matters: point the root elsewhere and
 * these tasks stop being listed, because a different root is a different library with a different
 * history.
 *
 * Deliberately not `openProject(baseDir)`, and not for one reason but four. `openProject` refuses a
 * directory with no `.jaira/`, and the base has none — its directories sit directly under it.
 * `jairaPaths(baseDir)` would therefore look for `~/.jaira/.jaira/workflows`. `worktreesDir` would
 * resolve beside a home directory that is not a git repository. And `loadLayeredConfig` would merge
 * the base config with ITSELF, since for this layout `paths.configFile` and `paths.base.configFile`
 * are the same file — harmless today only because merging a document over itself is idempotent, and
 * a trap the moment a merge rule stops being.
 *
 * So the config is parsed directly: there is no layer behind the base, because it IS the layer.
 */
export function openSharedProject(opts?: { now?: () => number; staleMs?: number; baseDir?: string }): Project {
  const base = initBase(opts?.baseDir);
  const paths = baseAsProjectPaths(base.baseDir);
  const doc = existsSync(paths.configFile) ? readJsonFile(paths.configFile) : undefined;
  return openAt(paths, doc === undefined ? defaultConfig() : parseConfig(doc), "shared", opts);
}

/**
 * JaiRA's OWN project — the one a root switch must not move.
 *
 * A fixed directory under the DEFAULT root ({@link systemProjectDir}), not the selected one. A
 * description sync is a fact about the installation, so its history has to outlive a person
 * repointing their shared library; and it must not sit on the same board as that library's runs,
 * which is what giving JaiRA's runs their own project was for in the first place.
 *
 * Its config is the SHARED root's, not its own: the system directory holds a database and nothing
 * else, and a sync still has to resolve the models and credentials the installation is configured
 * with rather than a bare default.
 */
export function openSystemProject(opts?: {
  now?: () => number;
  staleMs?: number;
  /** The SELECTED root — where the config and credentials come from. */
  baseDir?: string;
  /** Where JaiRA's own project lives. Defaults to {@link systemProjectDir}; see the note there. */
  systemDir?: string;
}): Project {
  const base = initBase(opts?.baseDir);
  const paths = baseAsProjectPaths(opts?.systemDir ?? systemProjectDir());
  mkdirSync(paths.projectDir, { recursive: true });
  const configFile = jairaBasePaths(base.baseDir).configFile;
  const doc = existsSync(configFile) ? readJsonFile(configFile) : undefined;
  return openAt(paths, doc === undefined ? defaultConfig() : parseConfig(doc), "system", opts);
}

/**
 * The effective configuration: the shared base root's `config.json` with the project's laid over it
 * (DESIGN §3). Absent files are empty layers, so a machine with no base root behaves exactly as
 * before one existed.
 */
export function loadLayeredConfig(paths: JairaPaths): JairaConfig {
  const base = existsSync(paths.base.configFile) ? readJsonFile(paths.base.configFile) : undefined;
  const project = existsSync(paths.configFile) ? readJsonFile(paths.configFile) : undefined;
  if (base === undefined && project === undefined) return defaultConfig();
  return parseConfig(mergeConfigDocuments(base, project));
}

export function openProject(
  projectDir: string,
  opts?: { now?: () => number; staleMs?: number; baseDir?: string },
): Project {
  const paths = jairaPaths(projectDir, opts?.baseDir);
  if (!existsSync(paths.jairaDir)) {
    throw new Error(`${paths.projectDir} is not a JaiRA project (no .jaira/ — run 'jaira init')`);
  }
  initBase(paths.base.baseDir);
  return openAt(paths, loadLayeredConfig(paths), "project", opts);
}

/**
 * The open itself, once the layout and the configuration have been decided.
 *
 * Shared by both entry points because everything from here down is the same question — what does this
 * database say was happening when we last looked? — and the two differ only in where the layout came
 * from and how its config was resolved.
 */
function openAt(
  paths: JairaPaths,
  config: JairaConfig,
  kind: Project["kind"],
  opts?: { now?: () => number; staleMs?: number },
): Project {
  const now = opts?.now ?? Date.now;
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
    kind,
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
