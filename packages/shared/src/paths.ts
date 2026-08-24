/**
 * The `.jaira/` project layout (DESIGN §3) — one place computes every path so
 * the layout can never drift between packages.
 *
 * There are TWO of these layouts, not one. A project has its own `.jaira/`, and
 * behind it sits a shared BASE root (`~/.jaira` by default) that every project on
 * the machine resolves against. The base is the library; the project is the set of
 * overrides. The two directories have the same shape on purpose — a workflow moves
 * between them by being copied, with nothing to rewrite.
 *
 * Within either root there is ONE line, and {@link SYSTEM_DIR_NAME} draws it:
 *
 *  - **Beside `system/`** — `workflows/`, `functions/`, `skills/`, `prompts/`, `settings.json` — is
 *    what a person writes. Hand-edited, versioned, and the thing a root is FOR.
 *  - **Inside `system/`** — the database, `tasks/`, `snapshots/`, `logs/`, `artifacts/` — is what
 *    JaiRA writes for itself. Nobody authors it and nobody should have to look at it.
 *
 * They used to be interleaved, so a shared root showed a person their three authored directories
 * next to a database, a WAL file, a snapshot cache and a pile of run logs. The layout said nothing
 * about which of those they owned; now the top level of a root is exactly what they own.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SETTINGS_FILE_NAME, USER_SETTINGS_FILE_NAME } from "./settings";

export interface JairaPaths {
  projectDir: string;
  jairaDir: string;
  /** How this project runs — see {@link SETTINGS_FILE_NAME}. Layered under the base's. */
  settingsFile: string;
  workflowsDir: string;
  skillsDir: string;
  /**
   * Everything JaiRA generates, under one directory (`<root>/system`).
   *
   * The fields below are all inside it, and so are things that are NOT fields here: a `.gitignore`
   * has to name this directory, and an artifact destination anchors on it as `$SYSTEM` — which is
   * why there is no `artifactsDir` beside the others. Where artifacts land is `$ARTIFACT_DIR` under
   * this, and `$ARTIFACT_DIR` is configuration; a second field spelling out the DEFAULT would be
   * quietly wrong for any project that changed it.
   *
   * Artifacts anchor on the PROJECT's system directory even for a task bound to a worktree, so a
   * `git worktree remove` does not take a run's output with it.
   */
  systemDir: string;
  snapshotsDir: string;
  tasksDir: string;
  logsDir: string;
  /**
   * One JSONL per run, under `<system>/journal/<taskId>/<runId>.jsonl` (DESIGN §4.4).
   *
   * Per RUN rather than per table, which is what makes "clean merges" and "shared history" stop
   * being a trade: two people running tasks on one branch write different filenames, so appends
   * never conflict, and a pull replays their runs into the same table. It also makes pruning a file
   * delete rather than a rewrite.
   *
   * Present whatever `config.storage.journal` says — a path is not a claim that anything is there.
   */
  journalDir: string;
  /** One JSONL per run of the records, positions and lineage a run's conversations are (DESIGN §4.4). */
  conversationsDir: string;
  /** One JSONL per task: its runtime row and its runs (DESIGN §4.4). */
  taskRowsDir: string;
  /** One JSONL per task: the artifact MAP. The bytes are `artifacts/` and are a different question. */
  artifactRowsDir: string;
  dbFile: string;
  /**
   * Where the last agreed state of `workflows/workflow.md` and the state files is recorded.
   *
   * A plain JSON file rather than a table in the database, and committed with the project on
   * purpose: "the document and the workflows were last in step at this revision" is a fact about the
   * checkout, not about this machine's run history, and a teammate pulling the branch should inherit
   * it rather than be told, on their first sync, that everything has drifted.
   */
  syncFile: string;
  /**
   * The shared base root behind this project (`$BASE`). Its workflows and
   * functions are the LAST entries on the search path, so a project file with the
   * same bare id shadows the base one — which is what "the project overrides the
   * base" means mechanically (EXPRESSIONS.md §4).
   */
  base: JairaBasePaths;
  /**
   * The ordered LAYER ROOTS: this project's `.jaira/`, then the shared one.
   *
   * The single list everything else is derived from. A bare `$` is searched along
   * it, so `$/prompts/goals.md` finds the project's copy if there is one and the
   * shared copy otherwise; and the workflow search path is generated from it
   * (`<root>/workflows`, `<root>/functions` per root) rather than maintained by
   * hand. Adding a third layer later is one more entry here and nothing else.
   */
  roots: string[];
  /**
   * Root for this project's task worktrees, **outside** the project directory
   * (DESIGN §3): an agent is scoped to a worktree, and that worktree must not
   * contain `.jaira/`. Layout:
   * `<project-parent>/.jaira-worktrees/<projectName>/<taskId>/`.
   */
  worktreesDir: string;
}

/**
 * The shared root's layout (`$BASE`) — the library every project resolves against, and JaiRA's own
 * project.
 *
 * It holds the AUTHORED things a machine shares: workflows, functions, skills, config, settings,
 * secrets. It also holds run state, which it did not use to.
 *
 * **The amendment.** This said "there is no database and no snapshots directory here, because runs
 * belong to a project and putting one machine's history behind every project would be a shared
 * mutable pile with no owner." The reasoning stands and the conclusion no longer follows: JaiRA runs
 * workflows of its OWN — the description sync, summarization, the conformance check — and those runs
 * have an owner. It is this root. Their alternative was a user's project, where they would appear on
 * a board nobody put them on and hold worktrees nobody asked for; or nowhere, which is what they had,
 * and why a failed sync could not be read back at all.
 *
 * So this is a pile with an owner, and the ownership is enforced rather than asserted: a task created
 * here may not name a branch (see `createTask`), so JaiRA's own runs can never take a worktree.
 * `worktreesDir` is the one field {@link baseAsProjectPaths} still fabricates.
 *
 * **There is ONE such pile, not two.** JaiRA's own runs were briefly a second project in a
 * subdirectory, on the theory that a root switch must not carry a description sync off with the
 * library it was not about. What it bought was two databases in one root, two boards, and a
 * `system/` that meant "JaiRA's project" in one breath and "JaiRA's generated files" in the next.
 * The base is one project now, and `system/` means only the second thing.
 */
export interface JairaBasePaths {
  baseDir: string;
  settingsFile: string;
  /** User preferences the app owns (theme, …) — see {@link USER_SETTINGS_FILE_NAME}. */
  userSettingsFile: string;
  workflowsDir: string;
  functionsDir: string;
  skillsDir: string;
  /** Machine-local secrets, checked after the project's own (see the secret chain). */
  envFile: string;
  envLocalFile: string;
  /**
   * What the user has agreed to RUN — the approved content hash of every js/ts function module
   * (SPEC §7.5.5).
   *
   * One store per machine rather than per project, because that is what an approval is a statement
   * about: a file on one disk. A project's `functions/` and the base's are approved into the same
   * table, keyed by absolute path, so approving `$BASE/functions/confidence.ts` once covers every
   * project that resolves it.
   *
   * **Never synced, and gitignored for the same reason.** Propagating approvals would let one
   * compromised machine confer trust on the rest — which is precisely the property the strong form
   * of the rule ("an unknown file is an unapproved file") exists to hold.
   */
  approvalsFile: string;
  /** Everything JaiRA generates for this root — see {@link JairaPaths.systemDir}. */
  systemDir: string;
  /** Run state for the base opened as a project — see the amendment above. */
  dbFile: string;
  snapshotsDir: string;
  tasksDir: string;
  logsDir: string;
  journalDir: string;
  conversationsDir: string;
  taskRowsDir: string;
  artifactRowsDir: string;
  syncFile: string;
}

export const JAIRA_DIR_NAME = ".jaira";
export const WORKTREES_DIR_NAME = ".jaira-worktrees";


/**
 * The one subdirectory of a root that a person does not own.
 *
 * Everything JaiRA generates goes in it — the database, tasks, snapshots, logs, artifacts — and
 * nothing a person authors does. That is the whole rule, and it is worth a constant because three
 * separate things have to agree on the spelling: the path builders here, the `.gitignore` the
 * layout writes, and the `$SYSTEM` an artifact destination resolves.
 */
export const SYSTEM_DIR_NAME = "system";

/**
 * The env var that relocates the shared root.
 *
 * Tests need it (a suite must not read or write the developer's real `~/.jaira`),
 * and so does anyone keeping the base on a synced drive.
 */
export const BASE_DIR_ENV = "JAIRA_HOME";

/** Where the shared root lives when nothing overrides it. */
export function defaultBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[BASE_DIR_ENV];
  return configured && configured.length > 0 ? resolve(configured) : join(homedir(), JAIRA_DIR_NAME);
}

export function jairaBasePaths(baseDir: string = defaultBaseDir()): JairaBasePaths {
  const root = resolve(baseDir);
  const system = join(root, SYSTEM_DIR_NAME);
  return {
    baseDir: root,
    settingsFile: join(root, SETTINGS_FILE_NAME),
    userSettingsFile: join(root, USER_SETTINGS_FILE_NAME),
    workflowsDir: join(root, "workflows"),
    functionsDir: join(root, "functions"),
    skillsDir: join(root, "skills"),
    envFile: join(root, ".env"),
    envLocalFile: join(root, ".env.local"),
    systemDir: system,
    // Generated, machine-local and never read by a person — the three properties everything under
    // `system/` shares. The approvals store is the one that used to sit at the top of the root
    // anyway, where its `.local.json` suffix was doing the explaining this directory now does.
    approvalsFile: join(system, "approvals.local.json"),
    dbFile: join(system, "jaira.db"),
    snapshotsDir: join(system, "snapshots"),
    tasksDir: join(system, "tasks"),
    logsDir: join(system, "logs"),
    journalDir: join(system, "journal"),
    conversationsDir: join(system, "conversations"),
    taskRowsDir: join(system, "taskRows"),
    artifactRowsDir: join(system, "artifactRows"),
    syncFile: join(system, "sync.json"),
  };
}

/**
 * The shared root as a PROJECT — what `openSharedProject` opens.
 *
 * Not `jairaPaths(baseDir)`, which would look for `~/.jaira/.jaira/workflows`: the base's directories
 * sit directly under it, because it is the library rather than a checkout's override of one. So this
 * maps the base's own fields onto the project shape, with two deliberate differences:
 *
 *  - **`roots` is the base alone.** There is no layer behind it; it IS the layer behind everything
 *    else. A project's `roots` puts its own `.jaira/` first and this second.
 *  - **`worktreesDir` is fabricated.** `~` is not a git repository and JaiRA's own runs are refused a
 *    branch, so nothing ever resolves it. It is present because the type requires it, and pointing it
 *    somewhere impossible is better than pointing it somewhere plausible.
 */
export function baseAsProjectPaths(baseDir: string = defaultBaseDir()): JairaPaths {
  const base = jairaBasePaths(baseDir);
  return {
    projectDir: base.baseDir,
    // The base has no `.jaira/` inside it: it IS one. `system/` therefore sits directly under the
    // root, which is what makes the two layouts the same shape one level down.
    jairaDir: base.baseDir,
    settingsFile: base.settingsFile,
    workflowsDir: base.workflowsDir,
    skillsDir: base.skillsDir,
    systemDir: base.systemDir,
    snapshotsDir: base.snapshotsDir,
    tasksDir: base.tasksDir,
    logsDir: base.logsDir,
    journalDir: base.journalDir,
    conversationsDir: base.conversationsDir,
    taskRowsDir: base.taskRowsDir,
    artifactRowsDir: base.artifactRowsDir,
    dbFile: base.dbFile,
    syncFile: base.syncFile,
    worktreesDir: join(base.baseDir, WORKTREES_DIR_NAME),
    base,
    roots: [base.baseDir],
  };
}

/**
 * `baseDir` is a parameter rather than always read from the environment so a test
 * (and the app's own settings surface) can point a project at a scratch base.
 */
export function jairaPaths(projectDir: string, baseDir?: string): JairaPaths {
  const root = resolve(projectDir);
  const jairaDir = join(root, JAIRA_DIR_NAME);
  const system = join(jairaDir, SYSTEM_DIR_NAME);
  const base = jairaBasePaths(baseDir ?? defaultBaseDir());
  return {
    projectDir: root,
    jairaDir,
    settingsFile: join(jairaDir, SETTINGS_FILE_NAME),
    workflowsDir: join(jairaDir, "workflows"),
    skillsDir: join(jairaDir, "skills"),
    systemDir: system,
    snapshotsDir: join(system, "snapshots"),
    tasksDir: join(system, "tasks"),
    logsDir: join(system, "logs"),
    journalDir: join(system, "journal"),
    conversationsDir: join(system, "conversations"),
    taskRowsDir: join(system, "taskRows"),
    artifactRowsDir: join(system, "artifactRows"),
    dbFile: join(system, "jaira.db"),
    syncFile: join(system, "sync.json"),
    worktreesDir: join(dirname(root), WORKTREES_DIR_NAME, basename(root)),
    base,
    // A project's own `.jaira/` always leads: a layer that could be pushed behind another would
    // stop being an override. Deduplicated, so pointing the base at the project (which tests and
    // a misconfigured `JAIRA_HOME` both do) does not search the same directory twice.
    roots: base.baseDir === jairaDir ? [jairaDir] : [jairaDir, base.baseDir],
  };
}

/**
 * The directories a BARE state id is searched along, generated from the layer roots.
 *
 * `workflows/` then `functions/` within each root, roots in order — so a project's `functions/`
 * still loses to its own `workflows/`, and both beat anything shared. Generated rather than written
 * out so that adding a layer cannot forget one of its two directories.
 */
export function workflowSearchPath(roots: readonly string[]): string[] {
  return roots.flatMap((root) => [join(root, "workflows"), join(root, "functions")]);
}

/** Where a task's worktree lives (DESIGN §3, §9.2). */
export function worktreePathFor(paths: JairaPaths, taskId: string): string {
  return join(paths.worktreesDir, taskId);
}

/**
 * The identity of an open project — one key per `.jaira/`, however the path was spelled.
 *
 * This exists because a process may now hold several projects at once, keyed by directory, and two
 * keys that name one directory would mean two `better-sqlite3` handles on one file: two writers, two
 * recovery passes, and a `jobs` claim each believes it owns. Every spelling therefore has to collapse
 * to the same string, and there are three ways they differ:
 *
 *  - **Relative or `..`-laden** — `resolve` settles it.
 *  - **Junctions, symlinks and 8.3 short names** — `realpath` settles those, and Windows file
 *    dialogs still hand out short names. Best-effort: a directory that does not exist yet (an `init`
 *    about to create it) has no real path, and its resolved form is the honest answer.
 *  - **Case** — only on Windows, where `C:\Foo` and `c:\foo` are one directory. Lowercasing
 *    elsewhere would merge two genuinely different projects, which is the worse failure.
 */
/**
 * The reserved key for the base root opened as a project (`~/.jaira`, DESIGN §3.1).
 *
 * Re-exported from here, where every other path-shaped name lives, but DEFINED in `ipc.ts`: it is a
 * value the renderer sends, and this module is Node-only — it reaches for `realpath` two lines
 * below. Importing it for one string constant would pull `node:fs` into the browser bundle.
 */
export { SHARED_SESSION } from "./ipc";

/**
 * The two file names, DEFINED in `settings.ts` for the reason {@link SHARED_SESSION} is defined in
 * `ipc.ts`: the renderer needs them (the Files tree labels one, the config pane opens the other) and
 * this module is Node-only. Re-exported from here, where the rest of the layout lives.
 */
export { SETTINGS_FILE_NAME, USER_SETTINGS_FILE_NAME } from "./settings";

export function sessionKey(dir: string): string {
  const resolved = resolve(dir);
  let real = resolved;
  try {
    real = realpathSync.native(resolved);
  } catch {
    // Not there yet, or not readable. `resolved` is already canonical enough to key by.
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}
