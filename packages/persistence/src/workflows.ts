/**
 * The workflow browser and lint surface (DESIGN §11.1, §14 phase 7).
 *
 * "Read-only tree of state files with lint results; editing happens in the user's
 * editor, JaiRA watches and re-lints." Two consequences shape this module:
 *
 *  - **It must survive a broken workflows directory.** The user is editing these
 *    files in another window, so at any instant one may be half-saved, invalid
 *    JSON, or referencing a state that does not exist yet. A lint surface that
 *    throws on the first bad file tells the author nothing; every failure is
 *    reported as a diagnostic against a file instead. (This is why it does not
 *    reuse `readWorkflowFiles`, which is right to throw for execution.)
 *  - **Roots are derived, not declared.** A state file is a workflow root when no
 *    other state names it as a child, which matches how `jaira task create
 *    --workflow <rootStateId>` is used. If mutual references leave no root at all,
 *    the states are reported as unreachable rather than silently yielding an empty
 *    browser.
 *
 * Linting is `validateBundle` with `strict: true` — the mode its own docs reserve
 * for a lint/CI surface, where every `functionRef` is expected to resolve. The
 * pre-run gate in `beginTaskRun` deliberately stays non-strict, because a state a
 * run never enters never needs its function.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { FunctionCapabilities } from "@declarative-ai/exec";
import { loadBundle, parseReferencedFile, resolveStateRef, snapshotHash, stateIdFromPath, validateBundle } from "@declarative-ai/hw";
import { componentConfigIssues, conversationModesOf, jairaBasePaths, parseJsonText, type JairaPaths } from "@jaira/shared";
import type { LintIssue, WorkflowBrowser, WorkflowEntry, WorkflowFileEntry } from "@jaira/shared";
import type { Project } from "./project";
import { isStateFile } from "./snapshots";
import { workflowLoadOptions } from "./workflowRefs";

// The view models live in `@jaira/shared` so the renderer can name them without
// reaching into this Node-only package.
export type { LintIssue, LintSeverity, WorkflowBrowser, WorkflowEntry, WorkflowFileEntry } from "@jaira/shared";

/**
 * Read every state file under a workflows dir, keeping parse failures as data.
 *
 * Exported because the conformance digest needs the same tolerant read: both
 * surfaces look at a directory the user is editing, and both would rather report
 * one bad file than lose the other twenty.
 */
export function readWorkflowsTolerantly(workflowsDir: string): {
  files: Record<string, unknown>;
  errors: Map<string, string>;
} {
  const files: Record<string, unknown> = {};
  const errors = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !isStateFile(entry.name)) continue;
      const rel = relative(workflowsDir, full).split(sep).join("/");
      try {
        files[rel] = parseReferencedFile(rel, readFileSync(full, "utf8"));
      } catch (e) {
        // The author is mid-edit: report it against the file, don't abort the pass.
        errors.set(rel, (e as Error).message);
      }
    }
  };
  walk(workflowsDir);
  return { files, errors };
}

/**
 * The states a raw state file names as children.
 *
 * A child that declares no `state` runs the one its KEY names (WORKFLOWS.md §6), so the default has
 * to be applied here too — this is what root derivation subtracts, and without it every child of a
 * state that used the shorthand would be reported as a workflow root of its own.
 */
function childStatesOf(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object") return [];
  const children = (raw as { children?: unknown }).children;
  if (children === null || typeof children !== "object") return [];
  const out: string[] = [];
  for (const [key, decl] of Object.entries(children as Record<string, unknown>)) {
    if (decl === null || typeof decl !== "object") continue;
    const state = (decl as { state?: unknown }).state;
    out.push(typeof state === "string" ? state : `./${key}`);
  }
  return out;
}

function labelOf(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const label = (raw as { label?: unknown }).label;
  return typeof label === "string" ? label : undefined;
}

export interface BrowseOptions {
  /** The registry a run would use, so `functionRef`s are resolved while linting. */
  functions?: ReadonlyMap<string, FunctionCapabilities>;
}

/**
 * Where a browse, a digest or a sync reads its workflows from.
 *
 * Named because there are two answers and they are not the same shape. With a project open the
 * search is two layers deep and writes land in the project's `.jaira/`; with none open the shared
 * root is the only layer there is and writes land in IT. Everything downstream — the browser, the
 * digest, the sync baseline — needs the same four facts, and a second code path that re-derived
 * them is how the projectless mode would end up disagreeing with the project one about which file
 * a state came from.
 */
export interface LayerSource {
  /** The layer roots, in search order — first match wins, exactly as reference resolution does. */
  layers: ReadonlyArray<{ dir: string; layer: "project" | "base" }>;
  /**
   * The layer this source AUTHORS in: the one a sync may propose files against, and the one a
   * baseline hashes. Always the first layer — the others are inherited and read-only from here.
   */
  layer: "project" | "base";
  paths: JairaPaths;
  searchPath?: readonly string[] | undefined;
  tasks: TaskIndex;
}

/** The two layers a project searches, and the project layer as the one it writes. */
export function projectSource(project: Project): LayerSource {
  // The base root is browsed too, or the states a project inherits would be invisible in exactly
  // the surface meant to show what it can run — and a lint error in a shared workflow would only
  // ever surface as a load failure in whichever project first used it.
  return {
    layers: [
      { dir: project.paths.workflowsDir, layer: "project" },
      { dir: project.paths.base.workflowsDir, layer: "base" },
    ],
    layer: "project",
    paths: project.paths,
    searchPath: project.config.workflows.path,
    tasks: tasksOf(project),
  };
}

/**
 * The shared root as the ONE layer, for when no project is open.
 *
 * `$`, `$JAIRA` and `$BASE` all name it, which is the truth when it is the only root there is.
 * `$PROJECT` resolves to the base's parent and means nothing; there is no project for it to mean.
 *
 * No tasks, and that is not a gap: a task belongs to a project, so with none open there is nothing
 * to be running or drifted.
 */
export function baseSource(baseDir: string): LayerSource {
  const paths = basePathsAsLayer(baseDir);
  return { layers: [{ dir: paths.workflowsDir, layer: "base" }], layer: "base", paths, tasks: EMPTY_TASKS };
}

/**
 * Browse and lint the live `workflows/` directories a source names.
 *
 * Pure read — nothing is snapshotted or written, so a UI can call this on every
 * file-watch event.
 */
export function browseSource(source: LayerSource, options: BrowseOptions = {}): WorkflowBrowser {
  return browseLayers(source.paths, source.layers, source.searchPath, source.tasks, options);
}

/** Browse and lint the project's live `workflows/` directory. */
export function browseWorkflows(project: Project, options: BrowseOptions = {}): WorkflowBrowser {
  return browseSource(projectSource(project), options);
}

/**
 * Browse and lint the SHARED root with no project open.
 *
 * The app browses `~/.jaira` on its own — it is machine-global, it exists before any checkout, and
 * it is where a workflow meant to outlive one project is authored. Until this existed that surface
 * was the only one in JaiRA that showed state files and never linted them, so a shared workflow was
 * unvalidated in exactly the mode people write shared workflows in: nothing was red because nothing
 * had looked.
 */
export function browseBaseWorkflows(baseDir: string, options: BrowseOptions = {}): WorkflowBrowser {
  return browseSource(baseSource(baseDir), options);
}

/**
 * A `JairaPaths` whose single layer root is the shared root.
 *
 * Built explicitly rather than by pointing `jairaPaths` at the base's parent. That trick appears to
 * work — `jairaPaths` collapses `roots` to one when the base and the project's `.jaira/` are the
 * same directory — but it only holds when the base is literally named `.jaira`. Relocate it with
 * `JAIRA_HOME` and the two stop coinciding, `workflowsDir` points at a sibling that does not exist,
 * and the browse silently finds no states at all.
 *
 * The run-state fields are filled in for the type's sake and are never read: browsing is a pure read
 * of `workflows/`, and there is no database, no snapshot and no worktree without a project.
 */
function basePathsAsLayer(baseDir: string): JairaPaths {
  const base = jairaBasePaths(resolve(baseDir));
  return {
    // Both anchors name the shared root, because with no project open it is the only root there is.
    projectDir: base.baseDir,
    jairaDir: base.baseDir,
    configFile: base.configFile,
    workflowsDir: base.workflowsDir,
    skillsDir: base.skillsDir,
    snapshotsDir: join(base.baseDir, "snapshots"),
    tasksDir: join(base.baseDir, "tasks"),
    dbFile: join(base.baseDir, "jaira.db"),
    syncFile: join(base.baseDir, "sync.json"),
    worktreesDir: join(base.baseDir, "worktrees"),
    base,
    roots: [base.baseDir],
  };
}

/** What a task lookup answers. Empty with no project — see {@link baseSource}. */
export interface TaskIndex {
  byWorkflow: Map<string, string[]>;
  pins: Map<string, Array<{ taskId: string; snapshotHash: string }>>;
}

const EMPTY_TASKS: TaskIndex = { byWorkflow: new Map(), pins: new Map() };

/** Tasks per workflow root, so the browser answers "is anything using this?". */
function tasksOf(project: Project): TaskIndex {
  const byWorkflow = new Map<string, string[]>();
  const pins = new Map<string, Array<{ taskId: string; snapshotHash: string }>>();
  for (const row of project.runtime.list()) {
    const meta = project.tasks.tryRead(row.taskId);
    if (!meta) continue;
    const list = byWorkflow.get(meta.workflow) ?? [];
    list.push(row.taskId);
    byWorkflow.set(meta.workflow, list);
    if (row.snapshotHash !== undefined) {
      const list = pins.get(meta.workflow) ?? [];
      list.push({ taskId: row.taskId, snapshotHash: row.snapshotHash });
      pins.set(meta.workflow, list);
    }
  }
  return { byWorkflow, pins };
}

/**
 * The browse itself, over whatever layers it is handed.
 *
 * Extracted so the projectless case is the SAME code rather than a second, thinner reader that would
 * quietly disagree with this one about what a root is or which issues count.
 */
function browseLayers(
  paths: JairaPaths,
  layers: ReadonlyArray<{ dir: string; layer: "project" | "base" }>,
  searchPath: readonly string[] | undefined,
  tasks: TaskIndex,
  options: BrowseOptions,
): WorkflowBrowser {
  const byStateId = new Map<string, { file: string; raw: unknown; layer: "project" | "base"; root: string }>();
  const fileEntries: WorkflowFileEntry[] = [];
  for (const { dir, layer } of layers) {
    const { files, errors } = readWorkflowsTolerantly(dir);
    for (const [file, message] of errors) {
      fileEntries.push({ stateId: stateIdFromPath(file), file, error: message, layer, root: dir });
    }
    for (const [file, raw] of Object.entries(files)) {
      const stateId = stateIdFromPath(file);
      const label = labelOf(raw);
      // First layer wins, exactly as reference resolution does — the later copy is kept in the list
      // and flagged, because "your base workflow is being overridden here" is worth seeing.
      const shadowed = byStateId.has(stateId);
      if (!shadowed) byStateId.set(stateId, { file, raw, layer, root: dir });
      fileEntries.push({
        stateId,
        file,
        ...(label !== undefined ? { label } : {}),
        layer,
        root: dir,
        ...(shadowed ? { shadowed: true } : {}),
      });
    }
  }
  fileEntries.sort((a, b) => a.stateId.localeCompare(b.stateId) || a.layer.localeCompare(b.layer));

  // A child reference is a PATH (WORKFLOWS.md §2.1), so `./critique` and `feature/plan/critique`
  // can name the same state. Roots are derived by "no one references me", which only works if both
  // spellings are reduced to the canonical id first.
  const refOptions = workflowLoadOptions(paths, { tolerant: true, ...(searchPath !== undefined ? { path: searchPath } : {}) });
  // The winning file per state id, keyed BY id — which is what makes the project's copy of a state
  // the one a bundle loads while the base copy sits inert beside it in the listing.
  const effective: Record<string, unknown> = {};
  for (const [stateId, { raw }] of byStateId) effective[stateId] = raw;
  const referenced = new Set<string>();
  for (const [stateId, { raw }] of byStateId) {
    for (const state of childStatesOf(raw)) {
      try {
        // The whole search path: `resolveStateRef` still cannot SEARCH it (no filesystem in hand),
        // but it folds a `$BASE/…` or absolute spelling back to the bare id the file is listed
        // under, so a root is not "referenced" under one name and listed under another.
        referenced.add(resolveStateRef(state, { ...refOptions, from: stateId }));
      } catch {
        // An unresolvable reference is a load/lint diagnostic below, not a reason to lose the tree.
      }
    }
  }
  const roots = [...byStateId.keys()].filter((id) => !referenced.has(id)).sort();

  const covered = new Set<string>();
  const workflows: WorkflowEntry[] = roots.map((rootId) => {
    const source = byStateId.get(rootId);
    const label = labelOf(source?.raw);
    const taskIds = tasks.byWorkflow.get(rootId) ?? [];
    const base: WorkflowEntry = {
      rootId,
      ...(label !== undefined ? { label } : {}),
      states: [],
      issues: [],
      taskIds,
      driftedTasks: [],
      layer: source?.layer ?? "project",
    };
    let bundle;
    try {
      bundle = loadBundle(effective, rootId, refOptions);
    } catch (e) {
      // An unresolvable child reference or a malformed state: the closure is
      // unknown, so the only honest answer is the load error itself.
      return { ...base, states: [rootId], loadError: (e as Error).message };
    }
    const states = Object.keys(bundle.states).sort();
    for (const id of states) covered.add(id);
    const report = validateBundle(bundle, {
      strict: true,
      ...(options.functions !== undefined ? { functions: options.functions } : {}),
    });
    const issues: LintIssue[] = [
      ...report.errors.map((issue) => ({ ...issue, severity: "error" as const })),
      ...report.warnings.map((issue) => ({ ...issue, severity: "warning" as const })),
    ];
    // A session cannot carry full history and a summary at once (one session, one
    // transcript). JaiRA summarizes it for all of them, so say so at lint time
    // rather than letting a `full_history` state be quietly compacted.
    //
    // Read from the LOADED states, not `source`: a mode inherited from an ancestor's `environment`
    // (WORKFLOWS.md §5) is nowhere in the authored file, and reading the file alone would miss
    // exactly the conflicts inheritance makes easiest to create.
    // Does each state pass its component what the component needs? The engine asks this of any
    // function whose registered entry declares a signature; JaiRA's components have none to declare
    // — their contract lives inside `config` — so the same question is asked from the contract
    // itself. Reported as an ERROR because a `choose_option` with no options is a gate nobody can
    // answer, which is a run that parks forever rather than one that reads oddly.
    // Scoped to THIS root's closure, not to every state on disk: `effective` is the whole layer, and
    // reporting a state outside this workflow against it would attribute the fault to a root that
    // never mounts it.
    const inClosure = Object.fromEntries(states.map((id) => [id, effective[id]]));
    for (const issue of componentConfigIssues(inClosure)) {
      issues.push({ ...issue, severity: "error" });
    }
    for (const conflict of conversationModesOf(bundle.states as unknown as Record<string, unknown>).conflicts) {
      issues.push({
        stateId: conflict.stateIds[0] ?? rootId,
        path: "operation.conversation.mode",
        message:
          `session '${conflict.session}' declares both summary and full_history ` +
          `(${conflict.stateIds.join(", ")}); the transcript is summarized for all of them`,
        severity: "warning",
      });
    }
    const hash = snapshotHash(bundle);
    // A task pinned to a different hash is running older source — worth showing,
    // since execution reads the snapshot and never live `workflows/` (§5.3).
    const drifted = (tasks.pins.get(rootId) ?? []).filter((pin) => pin.snapshotHash !== hash).map((p) => p.taskId);
    return { ...base, states, snapshotHash: hash, issues, driftedTasks: drifted };
  });

  const unreachable = [...byStateId.keys()].filter((id) => !covered.has(id)).sort();
  return { workflows, files: fileEntries, unreachable };
}

/** Errors only, across every workflow — the "can I run anything?" question. */
export function lintErrors(browser: WorkflowBrowser): Array<{ rootId: string; issue: LintIssue | { message: string } }> {
  const out: Array<{ rootId: string; issue: LintIssue | { message: string } }> = [];
  for (const workflow of browser.workflows) {
    if (workflow.loadError !== undefined) out.push({ rootId: workflow.rootId, issue: { message: workflow.loadError } });
    for (const issue of workflow.issues) {
      if (issue.severity === "error") out.push({ rootId: workflow.rootId, issue });
    }
  }
  return out;
}
