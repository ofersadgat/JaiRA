/**
 * The `.jaira/` project layout (DESIGN §3) — one place computes every path so
 * the layout can never drift between packages.
 *
 * There are TWO of these layouts, not one. A project has its own `.jaira/`, and
 * behind it sits a shared BASE root (`~/.jaira` by default) that every project on
 * the machine resolves against. The base is the library; the project is the set of
 * overrides. The two directories have the same shape on purpose — a workflow moves
 * between them by being copied, with nothing to rewrite.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
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
 */
export interface JairaBasePaths {
  baseDir: string;
  configFile: string;
  /** User preferences the app owns (theme, …) — not project configuration. */
  settingsFile: string;
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
  /** Run state for JaiRA's own project — see the amendment above. */
  dbFile: string;
  snapshotsDir: string;
  tasksDir: string;
  syncFile: string;
}

export const JAIRA_DIR_NAME = ".jaira";
export const WORKTREES_DIR_NAME = ".jaira-worktrees";

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
  return {
    baseDir: root,
    configFile: join(root, "config.json"),
    settingsFile: join(root, "settings.json"),
    workflowsDir: join(root, "workflows"),
    functionsDir: join(root, "functions"),
    skillsDir: join(root, "skills"),
    envFile: join(root, ".env"),
    envLocalFile: join(root, ".env.local"),
    approvalsFile: join(root, "approvals.local.json"),
    dbFile: join(root, "jaira.db"),
    snapshotsDir: join(root, "snapshots"),
    tasksDir: join(root, "tasks"),
    syncFile: join(root, "sync.json"),
  };
}

/**
 * The shared root as a PROJECT — what `openSystemProject` opens.
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
    jairaDir: base.baseDir,
    configFile: base.configFile,
    workflowsDir: base.workflowsDir,
    snapshotsDir: base.snapshotsDir,
    tasksDir: base.tasksDir,
    skillsDir: base.skillsDir,
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
  const base = jairaBasePaths(baseDir ?? defaultBaseDir());
  return {
    projectDir: root,
    jairaDir,
    configFile: join(jairaDir, "config.json"),
    workflowsDir: join(jairaDir, "workflows"),
    snapshotsDir: join(jairaDir, "snapshots"),
    tasksDir: join(jairaDir, "tasks"),
    skillsDir: join(jairaDir, "skills"),
    dbFile: join(jairaDir, "jaira.db"),
    syncFile: join(jairaDir, "sync.json"),
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
 * The reserved key for JaiRA's own project (`~/.jaira`, DESIGN §3.1).
 *
 * Re-exported from here, where every other path-shaped name lives, but DEFINED in `ipc.ts`: it is a
 * value the renderer sends, and this module is Node-only — it reaches for `realpath` two lines
 * below. Importing it for one string constant would pull `node:fs` into the browser bundle.
 */
export { SHARED_SESSION, SYSTEM_SESSION } from "./ipc";

/**
 * Where JaiRA's OWN project lives — the one a root switch must not move.
 *
 * Pinned to the DEFAULT base directory rather than to the selected root, which is the whole point:
 * a description sync is about the installation, so pointing the root somewhere else must not leave
 * its history behind in the old one. A subdirectory rather than the root itself, because when the
 * root IS the default the two projects would otherwise share a directory and a database.
 *
 * One function so it can move. `defaultBaseDir` still reads the environment, so a test — and an
 * installation that relocates `~/.jaira` wholesale — keeps working; what it deliberately does NOT
 * read is `settings.baseDir`, which is the thing the user changes.
 */
export function systemProjectDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultBaseDir(env), SYSTEM_DIR_NAME);
}

/** The subdirectory of the default root that holds JaiRA's own project. */
export const SYSTEM_DIR_NAME = "system";

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
