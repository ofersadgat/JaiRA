/**
 * Opening a JaiRA project: layout creation, config load, DB open, and startup
 * crash recovery (DESIGN §4.3 as revised by §1a item 1).
 *
 * v1 ownership model: one process at a time owns a project's `.jaira/`.
 * Recovery therefore treats every `running` task found at open time as
 * interrupted — there is no live engine that could still be driving it.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
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
  SYSTEM_DIR_NAME,
  type JairaBasePaths,
  type JairaConfig,
  type JairaPaths,
} from "@jaira/shared";
import { openDb, type JairaDb } from "./db";
import { applyStorage, isFileBacked, type ShadowReport } from "./shadow";
import { journalFiles, replayJournal } from "./journalFile";
import { conversationFiles, ConversationLog, replayConversations } from "./conversationFile";
import { ARTIFACT_ROWS, fingerprintOf, replayRows, RowLog, rowFiles, TASK_ROWS } from "./rowFile";
import { SqliteSessionStore, type SessionScope } from "./sessionStore";
import { SqliteArtifactStore } from "./artifactStore";
import { CommandLog } from "./commandLog";
import { JobStore, type JobRow } from "./jobs";
import { SqliteEventLog } from "./eventLog";
import { RuntimeStore } from "./runtime";
import { TaskFileStore } from "./taskStore";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.project");

export interface Project {
  /**
   * A user's checkout, or the base root.
   *
   * `shared` is the base opened as a project in its own right, so both the workflows a person keeps
   * in `<root>/workflows` and JaiRA's own — the description sync, summarization, the conformance
   * check — have somewhere to be recorded. It is not a decoration: `createTask` refuses a branch on
   * one, which is what keeps those runs out of anybody's worktrees.
   */
  kind: "project" | "shared";
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
  /** What `config.storage` did to this connection — see {@link applyStorage}. Empty when everything
   *  is in the database, which is the default. */
  storage: ShadowReport;
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
 * `workflows/` and `skills/` are source — hand-edited and worth versioning, and they sit outside
 * `system/` for exactly that reason. `system/` used to be ignored wholesale on the argument that it
 * was derived per-checkout state, and DESIGN §4.4 retired that: once a concern's truth is a JSONL
 * git can merge, there is nothing derived left to hide, and hiding it would defeat the point of
 * choosing files at all. So the list INVERTED — it names what stays out rather than what comes in.
 *
 * Two things stay out:
 *
 *  - **The database.** It is a rebuildable index of those files now, and an unmergeable binary
 *    either way; committing it would also copy a stale one into every task worktree, since a
 *    worktree checkout mirrors the branch.
 *  - **`logs/`.** This machine talking to itself, conflicting on every line.
 *
 * Everything else is meant to be committed — which for `snapshots/` and `artifacts/` is a change,
 * and a deliberate one: a snapshot is content-addressed and immutable, so two people producing the
 * same one produce the same bytes, and an artifact is a run's output that its own project may well
 * want to keep. A project that disagrees can ignore either in its own `.gitignore`; what it cannot
 * do is un-ignore something this file hid from it.
 *
 * `.env.local` is here because `.jaira/` became a place credentials live (DESIGN §8.1) the moment it
 * became the FIRST project link of the secret chain. Its sibling `.env` is deliberately not ignored:
 * the `.local` suffix is the whole convention for "this machine's", and a project that wants to
 * commit a non-secret default has to be able to.
 */
const SYS = SYSTEM_DIR_NAME;
const JAIRA_GITIGNORE = `# Two files, and everything else under ${SYS}/ is meant to be COMMITTED —
# see DESIGN §4.4. Once a concern's truth is a JSONL that git can merge, there is
# nothing derived left to hide, and hiding it would defeat the point of choosing files.
#
# The database is what survives: it is a rebuildable index of those files now, and an
# unmergeable binary either way. The logs are this machine talking to itself and would
# conflict on every line.
${SYS}/jaira.db
${SYS}/jaira.db-wal
${SYS}/jaira.db-shm
${SYS}/logs/

# Machine-local: what this disk has agreed to RUN (SPEC §7.5.5). An approval is a
# statement about a file on ONE disk, so syncing it would let one machine confer
# trust on the rest.
${SYS}/approvals.local.json

# Credentials. .env.local is machine-local by convention and is the first project link of the
# secret chain (DESIGN §8.1). Its sibling .env is deliberately NOT ignored: a project that wants
# to commit a non-secret default has to be able to.
.env.local
`;

/** Create the `.jaira/` layout (DESIGN §3). Idempotent; keeps an existing config. */
export function initProject(projectDir: string): JairaPaths {
  const paths = jairaPaths(projectDir);
  mkdirSync(paths.workflowsDir, { recursive: true });
  mkdirSync(paths.skillsDir, { recursive: true });
  mkdirSync(paths.snapshotsDir, { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
  if (!existsSync(paths.settingsFile)) {
    writeFileSync(paths.settingsFile, JSON.stringify(defaultConfig(), null, 2) + "\n", "utf8");
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
 * where a missing one is a question. No `settings.json` is written: an absent base config means "no
 * base layer", which is a different and better default than one full of defaults that then silently
 * override nothing.
 */
export function initBase(baseDir?: string): JairaBasePaths {
  const base = jairaBasePaths(baseDir);
  mkdirSync(base.workflowsDir, { recursive: true });
  mkdirSync(base.functionsDir, { recursive: true });
  mkdirSync(base.skillsDir, { recursive: true });
  // Run state for the base opened as a project. Created with the rest so the layout is whole after
  // one call, rather than half-created until the first run happens to need the other half.
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
 * the base config with ITSELF, since for this layout `paths.settingsFile` and `paths.base.settingsFile`
 * are the same file — harmless today only because merging a document over itself is idempotent, and
 * a trap the moment a merge rule stops being.
 *
 * So the config is parsed directly: there is no layer behind the base, because it IS the layer.
 */
export function openSharedProject(opts?: { now?: () => number; staleMs?: number; baseDir?: string }): Project {
  const base = initBase(opts?.baseDir);
  const paths = baseAsProjectPaths(base.baseDir);
  const doc = existsSync(paths.settingsFile) ? readJsonFile(paths.settingsFile) : undefined;
  return openAt(paths, doc === undefined ? defaultConfig() : parseConfig(doc), "shared", opts);
}

/**
 * The effective configuration: the shared base root's `settings.json` with the project's laid over it
 * (DESIGN §3). Absent files are empty layers, so a machine with no base root behaves exactly as
 * before one existed.
 */
/**
 * A session store wired to whatever `config.storage.conversations` says.
 *
 * THE constructor for one, and the reason it exists rather than nine `new SqliteSessionStore(db, …)`
 * calls: a store built by hand writes to the table and not to the file, which is invisible until the
 * database is thrown away and the conversations are not there. An unscoped store — no task, no run —
 * gets no log because it has nothing to name a file by; it is a read of one run already narrowed.
 */
export function sessionStoreFor(project: Project, scope: SessionScope = {}): SqliteSessionStore {
  const filed = isFileBacked(project.config.storage.conversations);
  const log =
    filed && scope.taskId !== undefined && scope.runId !== undefined
      ? new ConversationLog(project.paths.conversationsDir, project.config.storage.format, scope.taskId, scope.runId)
      : undefined;
  return new SqliteSessionStore(project.db, scope, log);
}

export function loadLayeredConfig(paths: JairaPaths): JairaConfig {
  const base = existsSync(paths.base.settingsFile) ? readJsonFile(paths.base.settingsFile) : undefined;
  const project = existsSync(paths.settingsFile) ? readJsonFile(paths.settingsFile) : undefined;
  if (base === undefined && project === undefined) return defaultConfig();
  return parseConfig(mergeConfigDocuments(base, project));
}

export function openProject(
  projectDir: string,
  opts?: { now?: () => number; staleMs?: number; baseDir?: string },
): Project {
  const paths = jairaPaths(projectDir, opts?.baseDir);
  if (!existsSync(paths.jairaDir)) {
    throw refusal(log, `${paths.projectDir} is not a JaiRA project (no .jaira/ — run 'jaira init')`);
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
  // BEFORE anything reads. A file-backed concern is served by a `TEMP` table standing in front of
  // its `main` counterpart (DESIGN §4.4), and a store constructed against the connection first would
  // have prepared its statements against the table it is meant to shadow.
  const storage = applyStorage(db, config.storage, {
    journal: () => replayJournal(db, paths.journalDir),
    conversations: () => replayConversations(db, paths.conversationsDir),
    tasks: () => replayRows(db, paths.taskRowsDir, TASK_ROWS),
    artifacts: () => replayRows(db, paths.artifactRowsDir, ARTIFACT_ROWS),
  }, {
    // What `both` compares against, so a `git pull` under a persisted index is noticed.
    journal: () => fingerprintOf(journalFiles(paths.journalDir).map((f) => f.file)),
    conversations: () => fingerprintOf(conversationFiles(paths.conversationsDir)),
    tasks: () => fingerprintOf(rowFiles(paths.taskRowsDir)),
    artifacts: () => fingerprintOf(rowFiles(paths.artifactRowsDir)),
  });
  // Only a file-backed concern gets a directory to write to — a recorder handed one would otherwise
  // append to files nothing replays, which is a slower way of writing to /dev/null.
  const journalDir = isFileBacked(config.storage.journal) ? paths.journalDir : undefined;
  const taskLog = isFileBacked(config.storage.tasks) ? new RowLog(paths.taskRowsDir) : undefined;
  const artifactLog = isFileBacked(config.storage.artifacts) ? new RowLog(paths.artifactRowsDir) : undefined;
  const runtime = new RuntimeStore(db, taskLog);
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
    events: new SqliteEventLog(db, journalDir),
    commands: new CommandLog(db),
    artifacts: new SqliteArtifactStore(db, artifactLog),
    jobs,
    recovered,
    orphans,
    storage,
    close: () => db.close(),
  };
}
