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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  baseAsProjectPaths,
  defaultConfig,
  jairaBasePaths,
  jairaPaths,
  JAIRA_DIR_NAME,
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
import { InteractionStore } from "./interactions";
import { RemoteHandleStore } from "./remoteHandles";
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
  /**
   * Gates parked and not yet answered (DESIGN §7.1).
   *
   * Durable on purpose: a run that dies with a state parked on a person leaves the question behind
   * rather than taking it with it — see {@link InteractionStore}.
   */
  interactions: InteractionStore;
  /** The merge requests tasks have opened, and what each has already heard (decision 0004). */
  remotes: RemoteHandleStore;
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

# The key that signs this machine's approvals (SPEC §7.5.5). Committing it would hand
# every clone the ability to mint approvals for this disk, which is the one thing the
# signature exists to prevent — so it is ignored for a stronger reason than derived
# state: it is a secret.
${SYS}/machine.key

# Machine-local: what this disk has agreed to RUN. The approvals themselves live in
# the database above now, and are ignored with it; this line is for the file older
# roots still carry. An approval is a statement about a file on ONE disk, so syncing
# it would let one machine confer trust on the rest.
${SYS}/approvals.local.json

# Credentials. .env.local is machine-local by convention and is the first project link of the
# secret chain (DESIGN §8.1). Its sibling .env is deliberately NOT ignored: a project that wants
# to commit a non-secret default has to be able to.
.env.local
`;

/**
 * Make sure an EXISTING `.gitignore` hides the machine key.
 *
 * The template is written only when there is no file, which is right for taste — somebody who edited
 * their ignores should keep them — and wrong for exactly one line. Every root created before the key
 * existed has an ignore file that does not mention it, and the consequence of that gap is a secret
 * in a commit. So this one entry is appended when it is missing, and nothing else is ever touched.
 *
 * Idempotent, and generous about what counts as already handled: the name appearing anywhere, or the
 * whole `system/` directory being ignored wholesale, both mean there is nothing to add.
 */
function ensureKeyIgnored(ignoreFile: string): void {
  let text: string;
  try {
    text = readFileSync(ignoreFile, "utf8");
  } catch {
    return; // No file — the template is about to be written, and it carries the line.
  }
  if (text.includes("machine.key")) return;
  if (text.split(/\r?\n/).some((line) => line.trim() === `${SYS}/` || line.trim() === SYS)) return;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  writeFileSync(
    ignoreFile,
    `${text}${separator}
# Added by JaiRA: the key that signs this machine's approvals (SPEC §7.5.5). Committing
# it would hand every clone the ability to mint approvals for this disk.
${SYS}/machine.key
`,
    "utf8",
  );
}

/**
 * Create the `.jaira/` layout (DESIGN §3). Idempotent; keeps an existing config.
 *
 * `baseDir` for the same reason {@link openProject} takes one: {@link jairaPaths} resolves the shared
 * root alongside the project's own directories, so a call that omits it reaches for `~/.jaira`
 * whether or not anything here reads it. Nothing here does — every directory written below is the
 * project's — but the resolution happens anyway, which is enough to make a test that only ever
 * wanted a scratch project depend on the developer's home.
 */
export function initProject(projectDir: string, baseDir?: string): JairaPaths {
  const paths = jairaPaths(projectDir, baseDir);
  mkdirSync(paths.workflowsDir, { recursive: true });
  mkdirSync(paths.skillsDir, { recursive: true });
  mkdirSync(paths.snapshotsDir, { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
  if (!existsSync(paths.settingsFile)) {
    // `integrations` is left out of the starter file. A connection is a fact about a MACHINE — its
    // hosts, its tokens — and belongs to the shared root; a project file that spelled the defaults out
    // would shadow whatever the shared root says, in every project created after it was said.
    const { integrations: _machineWide, ...starter } = defaultConfig();
    writeFileSync(paths.settingsFile, JSON.stringify(starter, null, 2) + "\n", "utf8");
  }
  const ignoreFile = join(paths.jairaDir, ".gitignore");
  if (existsSync(ignoreFile)) ensureKeyIgnored(ignoreFile);
  else writeFileSync(ignoreFile, JAIRA_GITIGNORE, "utf8");
  return paths;
}

/**
 * Does this directory have a `.jaira/` in it?
 *
 * Asked directly rather than through {@link jairaPaths}, which resolves the SHARED root alongside the
 * project's own directories — so a question about one directory used to depend on where the base
 * root was, and answering "is this a project" for a path somebody typed reached into `~/.jaira`.
 * Nothing about the answer needs it: the whole question is whether one directory exists.
 */
export function isProject(projectDir: string): boolean {
  return existsSync(join(resolve(projectDir), JAIRA_DIR_NAME));
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
  if (existsSync(ignoreFile)) ensureKeyIgnored(ignoreFile);
  else writeFileSync(ignoreFile, JAIRA_GITIGNORE, "utf8");
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
export function openSharedProject(opts?: { now?: () => number; staleMs?: number; baseDir?: string; builtInDir?: string }): Project {
  const base = initBase(opts?.baseDir);
  const paths = baseAsProjectPaths(base.baseDir, opts?.builtInDir);
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
 * database is thrown away and the conversations are not there. An unscoped store — no task — gets no
 * log because it has nothing to name a file by; it is a read already narrowed.
 */
export function sessionStoreFor(project: Project, scope: SessionScope = {}): SqliteSessionStore {
  const filed = isFileBacked(project.config.storage.conversations);
  const log =
    filed && scope.taskId !== undefined
      ? new ConversationLog(project.paths.conversationsDir, project.config.storage.format, scope.taskId)
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
  opts?: { now?: () => number; staleMs?: number; baseDir?: string; builtInDir?: string },
): Project {
  const paths = jairaPaths(projectDir, opts?.baseDir, opts?.builtInDir);
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
  // Everything under `system/` is generated, so a missing one is regenerated rather than refused.
  // Deleting it is how a person discards state whose format has moved on, and a clone of a project
  // that committed only its settings never had one to begin with: the database is gitignored, and
  // the directories beside it exist only once something has been written to them. Both used to fail
  // the open, because `new Database` on a path whose directory is missing reports a missing
  // directory rather than a project that needs one.
  //
  // The same two directories `initProject` guarantees under it, and no more — the JSONL directories
  // belong to their writers, and only a file-backed concern gets one (see below).
  mkdirSync(paths.snapshotsDir, { recursive: true });
  mkdirSync(paths.tasksDir, { recursive: true });
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
    interactions: new InteractionStore(db),
    remotes: new RemoteHandleStore(db),
    recovered,
    orphans,
    storage,
    close: () => db.close(),
  };
}
