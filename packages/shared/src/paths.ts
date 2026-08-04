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
 * The shared root's layout (`$BASE`).
 *
 * Deliberately a subset of {@link JairaPaths}: the base holds AUTHORED things —
 * workflows, functions, skills, config, settings, secrets — and no run state. There
 * is no database and no snapshots directory here, because runs belong to a project
 * and putting one machine's history behind every project would be a shared mutable
 * pile with no owner.
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
