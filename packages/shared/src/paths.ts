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
 * Behind both sits a THIRD layer nobody writes: what JaiRA ships ({@link JairaBuiltInPaths},
 * decision 0006). It has the authored half of the shape and none of the generated half.
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
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_FILE_NAME, USER_SETTINGS_FILE_NAME } from "./settings";
// Declared in `./hiddenPaths` rather than here, and re-exported so `@jaira/shared` is unchanged:
// the Files screen needs the spelling too, and this module imports `node:fs`, which a renderer
// bundle must not. A second constant with the same value was the alternative, and a spelling three
// things have to agree on is exactly what must not be written twice.
import { JAIRA_DIR_NAME, SYSTEM_DIR_NAME } from "./hiddenPaths";

export { JAIRA_DIR_NAME, SYSTEM_DIR_NAME };

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
   * One JSONL per task, under `<system>/journal/<taskId>/journal.jsonl` (DESIGN §4.4).
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
   * What JaiRA ships, as the layer behind both others (`$SYSTEM` in a reference — decision 0006).
   *
   * Read-only and always LAST: see {@link JairaBuiltInPaths}. Named `builtIn` here rather than
   * `system`, because {@link systemDir} already means something else — the directory of generated
   * files inside a root, which is also what `$SYSTEM` means in an ARTIFACT DESTINATION. The two
   * vocabularies never meet (a destination template is not a reference), but two fields of one
   * object both called `system` would.
   */
  builtIn: JairaBuiltInPaths;
  /**
   * The ordered LAYER ROOTS: this project's `.jaira/`, then the shared one, then what ships.
   *
   * The single list everything else is derived from. A bare `$` is searched along
   * it, so `$/prompts/goals.md` finds the project's copy if there is one, the
   * shared copy otherwise, and the shipped one where nobody wrote either; and the workflow search
   * path is generated from it (`<root>/workflows`, `<root>/functions` per root) rather than
   * maintained by hand. The built-in layer is the LAST entry, whatever else is true.
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
   * The machine's integrity key — a secret generated at first use and never leaving this disk.
   *
   * It keys the HMAC on every approval row. The point is the SEPARATION: what a person has agreed
   * to run lives in the database, and what proves they agreed lives in a file beside it, so writing
   * a row into the table is not the same as being approved. A process that appends a hash without
   * also having found and read this key produces a row that fails verification, and an approval
   * that fails verification is read as no approval at all.
   *
   * **What this defends against, honestly.** It stops a writer that does not know about the scheme
   * — another application, or an agent that finds the store and appends to it. It does NOT stop a
   * process running as you that reads this file: same user, same secret, valid MACs. Raising that
   * bar needs an OS keychain, and the keychain here is Electron's, while the CLI approves and runs
   * modules too — one of the two would then be unable to verify what the other wrote.
   *
   * **Never synced, never committed, and not in the database it protects.** A key stored beside the
   * rows it authenticates would authenticate whoever could write the rows.
   */
  machineKeyFile: string;
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


export const WORKTREES_DIR_NAME = ".jaira-worktrees";

/**
 * The built-in layer (`$SYSTEM`, decision 0006): what JaiRA ships, at the END of the search path.
 *
 * A directory with the same shape as the other two layer roots — `workflows/`, `prompts/`,
 * `functions/`, `toolsets/` — so a state, a prompt or a toolset moves between layers by being
 * copied, with nothing to rewrite. Three properties make it a layer of its own rather than a third
 * copy of the shared root:
 *
 *  - **It is last, always.** {@link jairaPaths} appends it after everything else and
 *    `workflowLoadOptions` appends its search directories after whatever `workflows.path`
 *    configured, so configuration can neither move it ahead of a person's file nor drop it.
 *  - **It is read-only.** Nothing JaiRA does writes here; "override" copies a file UP a layer. It
 *    has no `system/`, no database and no settings — nothing is generated into it.
 *  - **It is trusted.** A `.ts` function under `functions/` here is the app's own code and is not
 *    put to the module approval gate (`userModules.ts`). A person's copy that shadows one is theirs,
 *    and gated like any other.
 *
 * The directory may not exist — a build that shipped nothing, a checkout mid-move. That is an empty
 * layer, not an error: the vfs lists an absent directory as empty and the search moves on, which is
 * the same rule that makes a machine with no `~/.jaira` yet harmless.
 */
export interface JairaBuiltInPaths {
  dir: string;
  workflowsDir: string;
  functionsDir: string;
  promptsDir: string;
  toolsetsDir: string;
}

/** The layer's directory name, in the source tree and beside a bundle. See {@link defaultBuiltInDir}. */
export const BUILT_IN_DIR_NAME = "builtin";

export function jairaBuiltInPaths(builtInDir: string = defaultBuiltInDir()): JairaBuiltInPaths {
  const dir = resolve(builtInDir);
  return {
    dir,
    workflowsDir: join(dir, "workflows"),
    functionsDir: join(dir, "functions"),
    promptsDir: join(dir, "prompts"),
    toolsetsDir: join(dir, "toolsets"),
  };
}

let registeredBuiltInDir: string | undefined;
let locatedBuiltInDir: string | undefined;

/**
 * Name the built-in layer's directory for this process, or pass `undefined` to go back to finding it.
 *
 * For a host that keeps the directory somewhere {@link defaultBuiltInDir} cannot guess, and for a
 * test that wants a fixture in its place across code it does not call directly. Deliberately NOT an
 * environment variable and NOT a settings key: files under this directory skip the module approval
 * gate, so whatever can name it can run code unasked. A process's own startup code is allowed that;
 * a project's `.env`, or a `settings.json` an agent can edit, is not.
 */
export function setBuiltInDir(dir: string | undefined): void {
  registeredBuiltInDir = dir === undefined ? undefined : resolve(dir);
}

/**
 * Where the built-in layer lives when nobody has said (decision 0006, step 1).
 *
 * The layer's source of truth is `packages/shared/builtin/`, and both bundlers copy it to
 * `dist/builtin/` beside their output (`packages/cli/build.mjs`, `packages/app/build.mjs`). So the
 * directory is found relative to THIS module, in whichever of its shapes is running:
 *
 *  1. `<process.resourcesPath>/builtin` — a packaged Electron app that ships the directory as an
 *     extra resource. Outside `app.asar` on purpose: the layer is read with plain `node:fs` by the
 *     main process, by worker threads and by the TypeScript compiler host, and a real directory is
 *     the one thing all of them can read. Under `electron .` this is Electron's own resources
 *     directory, which holds no `builtin/`, so the search moves on.
 *  2. `<dir of this file>/builtin` — a bundle. `dist/cli.mjs` and `dist/main.cjs` both inline this
 *     module, so "this file" is the bundle and the copy sits beside it. This is how the published
 *     CLI finds it: its `files: ["bin", "dist"]` already ships `dist/builtin/`.
 *  3. `<dir of this file>/../builtin` — TypeScript source under tsx or vitest, where this file is
 *     `packages/shared/src/paths.ts`.
 *
 * The first one that EXISTS wins, and the answer is remembered: it cannot change while a process
 * runs, and `jairaPaths` is called far too often to stat three directories each time. When none
 * exists the answer is (2) anyway — a path is not a claim that anything is there, and an absent
 * layer reads as an empty one.
 *
 * `typeof __filename` for the reason `nativeBinding.ts` gives: the Electron main bundle is CJS,
 * where `__filename` exists; the CLI bundle and the sources are ESM, where `import.meta.url` does.
 */
export function defaultBuiltInDir(): string {
  if (registeredBuiltInDir !== undefined) return registeredBuiltInDir;
  if (locatedBuiltInDir !== undefined) return locatedBuiltInDir;
  const here = dirname(typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url));
  const resources = (process as { resourcesPath?: unknown }).resourcesPath;
  const candidates = [
    ...(typeof resources === "string" && resources.length > 0 ? [join(resources, BUILT_IN_DIR_NAME)] : []),
    join(here, BUILT_IN_DIR_NAME),
    join(here, "..", BUILT_IN_DIR_NAME),
  ];
  locatedBuiltInDir = candidates.find((dir) => existsSync(dir)) ?? join(here, BUILT_IN_DIR_NAME);
  return locatedBuiltInDir;
}

/**
 * The layer roots in search order, with the built-in one last and nothing listed twice.
 *
 * One function because both layouts need the same two rules: a directory that is already a layer is
 * not searched again (tests and a misconfigured `JAIRA_HOME` both point the base at the project),
 * and the built-in layer goes on the end whatever came before it.
 */
function layerRoots(own: readonly string[], builtIn: JairaBuiltInPaths): string[] {
  const out: string[] = [];
  for (const dir of [...own, builtIn.dir]) if (!out.includes(dir)) out.push(dir);
  return out;
}



/**
 * The env var that relocates the shared root.
 *
 * Tests need it (a suite must not read or write the developer's real `~/.jaira`),
 * and so does anyone keeping the base on a synced drive.
 */
export const BASE_DIR_ENV = "JAIRA_HOME";

/**
 * `--home <dir>`, lifted out of a command line.
 *
 * Here rather than in either entry point because both of them take it and it has to mean the same
 * thing in each: the CLI strips it before dispatching a subcommand, the app reads it while building
 * its service, and a flag that selected a different root depending on which binary you typed would
 * be worse than no flag.
 *
 * The flag is GLOBAL, and that is a claim about what it selects — the root every other path is read
 * against: the workflows a state resolves through, the settings a provider is configured in, the
 * approvals a module is checked against, the database a task is recorded in. Per-subcommand it would
 * be the same value written fourteen times, and the once it was left off would be a command quietly
 * reading a different library than the one before it.
 *
 * `malformed` rather than a throw: the two callers report a bad command line differently — one
 * prints usage and exits 2, the other has a window to open — and a parse is in no position to pick.
 */
export function takeHomeFlag(argv: readonly string[]): { home?: string; rest: string[]; malformed?: true } {
  const at = argv.indexOf("--home");
  if (at < 0) return { rest: [...argv] };
  const value = argv[at + 1];
  // A malformed flag consumes only ITSELF. `--home --json` means the directory was forgotten, not
  // that `--json` was it, and swallowing the next token would turn one mistake into two — a missing
  // home reported, and a flag the person did write silently dropped.
  if (value === undefined || value.startsWith("--")) {
    return { rest: [...argv.slice(0, at), ...argv.slice(at + 1)], malformed: true };
  }
  return { home: resolve(value), rest: [...argv.slice(0, at), ...argv.slice(at + 2)] };
}

/**
 * Where the shared root lives when nothing overrides it.
 *
 * Under a test runner the home directory is never the answer, and the failure is LOUD rather than
 * silent. `test/setup.ts` points {@link BASE_DIR_ENV} at a scratch directory, but it is wired to the
 * repository root's vitest config — so running the suite scoped to one package
 * (`vitest --root packages/app`) picks up no config, runs no setup, and every test then resolves the
 * base layer to the developer's real `~/.jaira`.
 *
 * That went unnoticed once, and it cost twice. The suite read whatever workflows happened to be
 * authored there, which turned into twenty failures that named nothing recognisable — and, worse, a
 * run that got far enough to open the base as a project WROTE to it: a couple of hundred task rows
 * and a pile of snapshots, in a directory a person keeps their own work in. An exception naming the
 * cause is the only version of this that costs one minute instead of an afternoon.
 */
export function defaultBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[BASE_DIR_ENV];
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  if (env["VITEST"] !== undefined) {
    throw new Error(
      `${BASE_DIR_ENV} is unset under a test run, so the shared base root would resolve to the real ` +
        `${join(homedir(), JAIRA_DIR_NAME)} — which a suite must never read or write. ` +
        `test/setup.ts sets it, and it is wired to the repository root's vitest config: run the tests ` +
        `from the repository root (\`npm test\`, or \`npx vitest run packages/app/test/x.test.ts\`) ` +
        `rather than with \`--root packages/<name>\`.`,
    );
  }
  return join(homedir(), JAIRA_DIR_NAME);
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
    // `system/` shares.
    machineKeyFile: join(system, "machine.key"),
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
 *  - **`roots` is the base, then what ships.** No PERSON's layer is behind it; it is the layer
 *    behind every project. A project's `roots` puts its own `.jaira/` first and this second, and the
 *    built-in layer is last in both.
 *  - **`worktreesDir` is fabricated.** `~` is not a git repository and JaiRA's own runs are refused a
 *    branch, so nothing ever resolves it. It is present because the type requires it, and pointing it
 *    somewhere impossible is better than pointing it somewhere plausible.
 */
export function baseAsProjectPaths(baseDir: string = defaultBaseDir(), builtInDir?: string): JairaPaths {
  const base = jairaBasePaths(baseDir);
  const builtIn = jairaBuiltInPaths(builtInDir);
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
    builtIn,
    roots: layerRoots([base.baseDir], builtIn),
  };
}

/**
 * `baseDir` is a parameter rather than always read from the environment so a test
 * (and the app's own settings surface) can point a project at a scratch base. `builtInDir` is one
 * for the first of those reasons only: a test hands in a fixture, and nothing a person configures
 * reaches it.
 */
export function jairaPaths(projectDir: string, baseDir?: string, builtInDir?: string): JairaPaths {
  const root = resolve(projectDir);
  const jairaDir = join(root, JAIRA_DIR_NAME);
  const system = join(jairaDir, SYSTEM_DIR_NAME);
  const base = jairaBasePaths(baseDir ?? defaultBaseDir());
  const builtIn = jairaBuiltInPaths(builtInDir);
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
    builtIn,
    roots: layerRoots([jairaDir, base.baseDir], builtIn),
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
