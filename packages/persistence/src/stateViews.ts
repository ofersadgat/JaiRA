/**
 * The Files view's read models (DESIGN §11.1): the two-root file tree, the board of any state, and
 * everything the inspector says about the one state selected.
 *
 * Three things here are not in `views.ts`, and each is a deliberate departure from how the board
 * used to work:
 *
 *  - **A board can be asked for any state.** `boardView` resolves its shape from the most recently
 *    updated task's workflow, which is right for "open the app and see something" and wrong for
 *    "show me the state I just clicked in the tree". {@link boardForState} finds the workflow whose
 *    closure actually contains the state and projects that one.
 *  - **The root listing is a board too.** {@link rootsBoard} gives one column per workflow root, so
 *    the top of the Tasks view is the whole project rather than one workflow chosen for you. Its
 *    columns are the only ones with no run order — roots do not run relative to each other.
 *  - **A state knows whether its executor exists.** The executors enabled in settings *are* the
 *    default environment, so a state naming one that is off is an authoring error reported here,
 *    beside the file, rather than a failure discovered part-way through a run.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { parseReferencedFile, stateFilePath } from "@declarative-ai/hw";
import { compileHidden, hiddenRules, isHiddenPath, mimeOfPath, SETTINGS_FILE_NAME } from "@jaira/shared";
import type {
  BoardCard,
  BoardView,
  FileKind,
  FileLint,
  FileNode,
  FileTree,
  LintIssue,
  StateChild,
  StateReference,
  StateSlotInfo,
  StateSlots,
  StateTransition,
  StateView,
  EffectiveState,
  WorkflowSource,
  WorkflowBrowser,
  WorkflowEntry,
  WorkflowLayer,
} from "@jaira/shared";
import type { Project } from "./project";
import { boardPathOf, breadcrumbOf, endedAtOf, projectBoard, type TaskProjection, type WorkflowShape } from "./projection";
import { isStateFile } from "./snapshots";
import { workflowShape } from "./shape";
import { bundleFor, taskRun, taskSummaries, type ViewOptions } from "./views";

/** What the Files view needs to know about the machine, on top of the project itself. */
export interface StateViewOptions extends ViewOptions {
  /**
   * Executors that would actually run — enabled *and* reachable. A state naming a function outside
   * this set gets an error, but only if the name is one JaiRA recognises as an executor at all:
   * `review_artifact` — or `review_artifacts` (CHANGESETS.md §4.1) — is a UI component, not a
   * missing runtime.
   */
  availableExecutors?: ReadonlySet<string>;
  /** Every executor name JaiRA knows about, available or not. Absent ⇒ nothing is judged. */
  knownExecutors?: ReadonlySet<string>;
}

// --- the file tree -----------------------------------------------------------

/**
 * Classify a path by the directory it sits in — asked of the path relative to the LAYER root.
 *
 * Which is not the path relative to the tree's root any more. A project's tree is rooted at the
 * CHECKOUT, so `packages/app/src/index.ts` is an ordinary file with no layer at all and
 * `.jaira/workflows/feature/plan.json` is a state — and the difference is exactly the `.jaira/`
 * prefix, which {@link layerRelative} strips before asking.
 */
function kindOf(layerPath: string | undefined, name: string): FileKind {
  if (layerPath === undefined) return "other";
  const top = layerPath.split("/")[0];
  if (top === "workflows") return isStateFile(name) ? "workflow" : "other";
  if (top === "prompts") return "prompt";
  if (top === "skills") return "skill";
  if (layerPath === SETTINGS_FILE_NAME) return "config";
  return "other";
}

/**
 * The part of a tree path that is inside the layer root, or `undefined` for one that is not.
 *
 * The tree's root and the LAYER's root are no longer the same directory. A project's tree is rooted
 * at the checkout and its layer lives one directory down, so `.jaira/workflows/plan.json` declares a
 * state and `README.md` is a file in the project and nothing else — asking what state that declares
 * is a category error rather than a miss.
 *
 * `prefix` is MEASURED (`relative(treeRoot, layerRoot)`) rather than written as `.jaira`, because
 * the two are not always different: a base root IS its own layer root, and so is any root whose
 * layer sits directly under it. Hard-coding the directory name made every such root's files stop
 * being states — silently, since a file with no layer path is simply an ordinary file.
 */
function layerRelative(treePath: string, prefix: string): string | undefined {
  if (prefix.length === 0) return treePath;
  if (treePath === prefix) return "";
  return treePath.startsWith(`${prefix}/`) ? treePath.slice(prefix.length + 1) : undefined;
}

/** Where a layer root sits inside the tree root that contains it: `""` or `.jaira`, forward-slashed. */
function prefixOf(treeRoot: string, layerRoot: string): string {
  const rel = relative(treeRoot, layerRoot);
  return rel.length === 0 ? "" : rel.split(sep).join("/");
}

/**
 * The compiled hidden-path rules a walk carries.
 *
 * Passed down rather than read from a module constant because the rules are now a SETTING — layered
 * config plus the person's own list (`hiddenPaths.ts`) — and two projects open in one window can
 * disagree about them. Compiled by the CALLER, so the cost is per tree rather than a `RegExp` per
 * pattern per directory entry.
 *
 * Both tree functions take it optionally and fall back to {@link defaultRules}, which is right for
 * a test or a script and wrong for the app: a caller that means to honour the setting and forgets
 * to pass it gets a plausible tree built from the wrong rules. `AppService.filesTree` is the one
 * that must always pass it.
 */
export type HiddenRules = ReturnType<typeof compileHidden>;

/** The rules a caller that has expressed no opinion gets: `system/` and dependencies. */
const defaultRules = (): HiddenRules => compileHidden(hiddenRules(undefined));

function walkDir(
  root: string,
  dir: string,
  layer: WorkflowLayer,
  hidden: HiddenRules,
  /** Where this root's LAYER sits inside it — see {@link layerRelative}. */
  prefix: string,
  project?: string,
): FileNode[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    // A leading dot is no longer a reason on its own. It used to be, and it could be while the tree
    // showed only `.jaira/` — nothing in there starts with one except the `.gitignore` the layout
    // writes. A tree rooted at the CHECKOUT has to draw `.jaira/` itself, so the rule cannot be
    // "skip dot-entries"; it is the hidden list, which names `.git` and the rest and can be read.
    if (isHiddenPath(rel, hidden)) continue;
    if (entry.isDirectory()) {
      nodes.push({
        path: rel,
        name: entry.name,
        kind: "directory",
        mime: mimeOfPath(rel, true),
        layer,
        ...(project !== undefined ? { project } : {}),
        children: walkDir(root, full, layer, hidden, prefix, project),
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const layerPath = layerRelative(rel, prefix);
    const kind = kindOf(layerPath, entry.name);
    const node: FileNode = {
      path: rel,
      name: entry.name,
      kind,
      mime: mimeOfPath(rel),
      layer,
      // Every node says which project it is in, so a file identifies itself — see `FileNode.project`.
      ...(project !== undefined ? { project } : {}),
    };
    if (kind === "workflow" && layerPath !== undefined) {
      // The state id is the path under `workflows/`, minus the suffix — the same derivation the
      // loader uses, so the tree and a `--workflow` argument name the same thing. Taken from the
      // LAYER path, so a project's `.jaira/workflows/feature/plan.json` is `feature/plan` and not
      // `.jaira/feature/plan`.
      node.stateId = layerPath.replace(/^workflows\//, "").replace(/\.(json|ya?ml)$/i, "");
    }
    nodes.push(node);
  }
  // Directories first, then files, each alphabetical: a listing you can predict is a listing you can
  // navigate without reading it.
  nodes.sort((a, b) => {
    if ((a.kind === "directory") !== (b.kind === "directory")) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

/**
 * Both layer roots as trees, in search-path order.
 *
 * A base file the project overrides is marked `shadowed` wherever it appears, which is what lets the
 * tree replace the layer picker: which copy you are about to edit is its position on screen.
 *
 * Every root is listed even when its directory is absent — see {@link FileTree}. `walkDir` already
 * treats an unreadable directory as empty rather than an error, so an absent root costs one
 * `existsSync` and yields an empty, still-usable branch: writing a state into it creates the
 * directory chain on the way.
 */
export function fileTree(project: Project, browser?: WorkflowBrowser, hidden?: HiddenRules): FileTree {
  const shadowed = new Set(
    (browser?.files ?? []).filter((f) => f.shadowed === true).map((f) => `${f.layer}:${f.stateId}`),
  );
  const errors = new Map(
    (browser?.files ?? []).filter((f) => f.error !== undefined).map((f) => [`${f.layer}:${f.stateId}`, f.error!]),
  );
  const lint = lintByStateId(browser);
  const rules = hidden ?? defaultRules();
  // The project layer is rooted at the CHECKOUT, not at `.jaira/`. A person's project is their
  // files, and `.jaira/` is one directory in it — the tree said otherwise, and for a project that
  // keeps its workflows in the shared root it therefore had nothing at all to draw. `paths.roots` is
  // NOT what this iterates any more: that list is the workflow SEARCH PATH, and `<checkout>/workflows`
  // is not where a state lives.
  // `roots` is still what says whether there IS a layer behind this one — it is deduplicated when the
  // base and the project resolve to the same directory — but its FIRST entry is `.jaira/`, and the
  // tree wants the checkout that contains it. So the head is replaced and the tail is kept.
  const layerRoots: Array<{ dir: string; layer: WorkflowLayer; prefix: string }> = [
    {
      dir: project.paths.projectDir,
      layer: "project",
      // Measured, not assumed: `.jaira` for an ordinary checkout, and empty for a root whose layer
      // sits directly under it.
      prefix: prefixOf(project.paths.projectDir, project.paths.roots[0] ?? project.paths.projectDir),
    },
    ...project.paths.roots.slice(1).map((dir) => ({ dir, layer: "base" as WorkflowLayer, prefix: "" })),
  ];
  const roots = layerRoots.map(({ dir, layer, prefix }) => {
    const nodes = walkDir(dir, dir, layer, rules, prefix, layer === "project" ? project.paths.projectDir : undefined);
    const mark = (list: FileNode[]): void => {
      for (const node of list) {
        if (node.stateId !== undefined) {
          const key = `${layer}:${node.stateId}`;
          if (shadowed.has(key)) node.shadowed = true;
          const error = errors.get(key);
          if (error !== undefined) node.error = error;
          // A shadowed base copy is INERT in this project — the loader never reads it, so the issues
          // reported against that state id belong to the file that overrode it, not to this one.
          // Marking it would put a red row beside a file that has nothing to do with the failure.
          if (!node.shadowed) {
            const found = lint?.get(node.stateId);
            if (found !== undefined) node.lint = found;
          }
        }
        if (node.children) mark(node.children);
      }
    };
    mark(nodes);
    rollUpLint(nodes);
    return {
      layer,
      // Stamped on the PROJECT root only. The shared root belongs to no project — see `FileTree`,
      // where the window's several projects are the top level and `~/.jaira` is their sibling.
      ...(layer === "project" ? { project: project.paths.projectDir } : {}),
      label: layer === "project" ? basename(project.paths.projectDir) : "~/.jaira",
      dir,
      // Measured on the way in and carried out — see `FileRoot.prefix`. The renderer asks a path
      // three questions and all three are about where the layer sits inside this root.
      prefix,
      exists: existsSync(dir),
      nodes,
    };
  });
  return { roots };
}

/**
 * Every state id the browser has an opinion about, and what that opinion is.
 *
 * `undefined` when there is no browser at all — no project is open, so nothing has been linted and
 * the tree must say nothing rather than mark every file clean. That is the same distinction
 * `StateView.fileOnly` draws, for the same reason.
 *
 * A state reachable from more than one root is linted once per root, so the same issue can arrive
 * twice; they are counted per (path, message) to keep a shared subroutine from reading as N times
 * more broken than it is. A root that failed to LOAD reports no issues at all — every state under it
 * is `unchecked`, not clean, because the loader never got far enough to look at them.
 */
function lintByStateId(browser: WorkflowBrowser | undefined): Map<string, FileLint> | undefined {
  if (browser === undefined) return undefined;
  const out = new Map<string, FileLint>();
  const seen = new Map<string, Set<string>>();
  const checked = new Set<string>();
  for (const workflow of browser.workflows) {
    if (workflow.loadError !== undefined) continue;
    for (const stateId of workflow.states) checked.add(stateId);
  }
  for (const workflow of browser.workflows) {
    for (const issue of workflow.issues) {
      const keys = seen.get(issue.stateId) ?? new Set<string>();
      seen.set(issue.stateId, keys);
      const key = `${issue.severity}\u0000${issue.path}\u0000${issue.message}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const entry = out.get(issue.stateId) ?? { errors: 0, warnings: 0 };
      if (issue.severity === "error") entry.errors += 1;
      else entry.warnings += 1;
      out.set(issue.stateId, entry);
    }
  }
  // Everything the browser listed as a file but no loaded root reached. `unreachable` is the
  // browser's own name for the cycle/failed-load case; a file simply not referenced by any root is
  // just as unvalidated, so both are derived from `checked` rather than read off one list.
  for (const file of browser.files) {
    if (checked.has(file.stateId) || out.has(file.stateId)) continue;
    out.set(file.stateId, { errors: 0, warnings: 0, unchecked: true });
  }
  return out;
}

/**
 * Give every directory the totals of what is beneath it, so a collapsed branch still shows a fault.
 *
 * Counts only. `unchecked` deliberately does not roll up: it is a claim that nothing validated THIS
 * file, and an aggregate one would say that about a directory where a single state happens to be
 * unreferenced — which reads as "none of this was checked" and would be false.
 */
function rollUpLint(nodes: FileNode[]): FileLint {
  const total: FileLint = { errors: 0, warnings: 0 };
  for (const node of nodes) {
    const below = node.children === undefined ? undefined : rollUpLint(node.children);
    if (below !== undefined && (below.errors > 0 || below.warnings > 0)) node.lint = below;
    const own = node.lint;
    if (own === undefined) continue;
    total.errors += own.errors;
    total.warnings += own.warnings;
  }
  return total;
}

/**
 * One state in the shared root, read from its file alone.
 *
 * The projectless twin of {@link stateView}, for the case the Files view now allows: browsing and
 * authoring `~/.jaira` with nothing open. Everything structural comes from the document — label,
 * operation, children in run order, transitions — and everything that needs the project's reference
 * graph is reported as UNKNOWN via `fileOnly` rather than as an empty list.
 *
 * Deliberately does not load a bundle. Resolution needs a search path, a search path needs the
 * project's configuration, and inventing one would make this view disagree with the real one about
 * which file a reference names.
 */
export function baseStateView(
  baseDir: string,
  stateId: string,
  options: StateViewOptions = {},
  browser?: WorkflowBrowser,
): StateView {
  const workflowsDir = join(baseDir, "workflows");
  const file = `${stateFilePath(stateId, workflowsDir)}.json`;
  let def: unknown;
  let parseError: string | undefined;
  try {
    def = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    parseError = (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : (e as Error).message;
  }
  const exists = existsSync(file);

  const doc = record(def);
  const declared = Object.keys(record(doc?.["children"]) ?? {});
  const sequence = (Array.isArray(doc?.["sequence"]) ? (doc["sequence"] as unknown[]) : [])
    .filter((k): k is string => typeof k === "string" && declared.includes(k));
  const order = [...sequence, ...declared.filter((k) => !sequence.includes(k))];

  const children: StateChild[] = order.map((key) => {
    const decl = record(record(doc?.["children"])?.[key]);
    const named = stringOf(decl?.["state"]);
    // A child with no `state` runs the one its KEY names, relative to this state (WORKFLOWS.md §6).
    const childId = named === undefined || named.startsWith("./") ? `${stateId}/${named?.slice(2) ?? key}` : named;
    let hasChildren = false;
    try {
      const childDoc = record(JSON.parse(readFileSync(`${stateFilePath(childId, workflowsDir)}.json`, "utf8")));
      hasChildren = Object.keys(record(childDoc?.["children"]) ?? {}).length > 0;
    } catch {
      // A child that cannot be read here is a lint problem, not a reason to lose the column.
    }
    return { key, stateId: childId, hasChildren };
  });

  const op = record(doc?.["operation"]);
  const kind = stringOf(op?.["kind"]);
  // The AUTHORED spelling is `function`; `functionRef` is what the loader produces. Both are read,
  // because this view is the only one that sees the document before the loader touches it.
  const functionRef = stringOf(op?.["function"]) ?? stringOf(op?.["functionRef"]);
  const model = stringOf(record(op?.["config"])?.["model"]) ?? stringOf(op?.["model"]);
  const executor = kind === "function" ? functionRef : undefined;
  const judged = executor !== undefined && options.knownExecutors?.has(executor) === true;
  const available = !judged || options.availableExecutors?.has(executor!) === true;

  // The browser's own diagnostics for this state, so the inspector and the tree agree. Without a
  // browser they are UNKNOWN rather than empty — which is what `fileOnly` already says.
  const issues: LintIssue[] = (browser?.workflows ?? []).flatMap((w) => w.issues.filter((i) => i.stateId === stateId));
  if (parseError !== undefined) {
    issues.push({ stateId, path: "", message: `not valid JSON: ${parseError}`, severity: "error" });
  }
  if (judged && !available) {
    issues.push({
      stateId,
      path: "operation.function",
      message: `executor '${executor}' is not available — a task reaching this state is refused at start`,
      severity: "error",
    });
  }

  return {
    stateId,
    ...(stringOf(doc?.["label"]) !== undefined ? { label: stringOf(doc?.["label"])! } : {}),
    layer: "base",
    file,
    exists,
    ...(kind === "prompt" || kind === "function"
      ? { operation: { kind, ...(functionRef !== undefined ? { functionRef } : {}), ...(model !== undefined ? { model } : {}) } }
      : {}),
    children,
    // Columns still, even with no runs to put in them: they are the state's STRUCTURE, and the
    // structure is most of what you open a composite state to look at. Empty columns say "nothing is
    // here", which is true; a leaf rendering would say "this state has no children", which is not.
    board:
      children.length === 0
        ? null
        : {
            level: stateId,
            ...(stringOf(doc?.["label"]) !== undefined ? { label: stringOf(doc?.["label"])! } : {}),
            breadcrumb: [{ stateId }],
            columns: children.map((child) => ({ key: child.key, stateId: child.stateId, cards: [] })),
            atLevel: [],
            finished: [],
          },
    tasksHere: [],
    tasksRecent: [],
    // No ancestor chain without a bundle, so only a self-reference is knowably a loop.
    transitions: transitionsOf(def, stateId, new Set()),
    environment: { ...(executor !== undefined ? { executor } : {}), available },
    issues,
    references: [...refsIn(def)].map((ref) => ({ ref, resolved: true, layer: "base" as const })),
    referencedBy: [],
    driftedTasks: [],
    fileOnly: true,
  };
}

/**
 * The shared root alone, for when no project is open.
 *
 * `~/.jaira` belongs to the machine, not to a checkout, so it stays browsable with nothing else
 * loaded. Shadowing cannot apply — there is no project layer to override anything — so nothing here
 * needs the browser.
 */
export function baseFileTree(baseDir: string, browser?: WorkflowBrowser, hidden?: HiddenRules): FileTree {
  // A base root IS its layer root, so nothing is prefixed.
  const nodes = walkDir(baseDir, baseDir, "base", hidden ?? defaultRules(), "");
  // Linted exactly as a project's tree is. Skipping it here was the whole of "validation is not
  // working": the shared root is browsable with nothing open, and that was the one surface in JaiRA
  // that listed state files and never said a word about them.
  const lint = lintByStateId(browser);
  const errors = new Map((browser?.files ?? []).filter((f) => f.error !== undefined).map((f) => [f.stateId, f.error!]));
  const mark = (list: FileNode[]): void => {
    for (const node of list) {
      if (node.stateId !== undefined) {
        const error = errors.get(node.stateId);
        if (error !== undefined) node.error = error;
        const found = lint?.get(node.stateId);
        if (found !== undefined) node.lint = found;
      }
      if (node.children) mark(node.children);
    }
  };
  mark(nodes);
  rollUpLint(nodes);
  // The shared root IS its own layer, so `workflows/` is at the top of it and the prefix is empty.
  return { roots: [{ layer: "base", label: "~/.jaira", dir: baseDir, prefix: "", exists: existsSync(baseDir), nodes }] };
}

// --- declared inputs ---------------------------------------------------------

/** The extensions a state file may carry, in the order a reference probes them. */
const STATE_EXTENSIONS: readonly string[] = ["json", "yaml", "yml"];

/**
 * Read one state's document by id, searching the layer roots in order.
 *
 * First match wins, which is the rule reference resolution uses — the project's copy shadows the
 * base's. Failure of any sort yields `undefined`: the caller is answering "what does this child
 * declare" for a form where the id is being TYPED, so most calls are expected to miss.
 */
function readStateDoc(roots: readonly string[], stateId: string): Record<string, unknown> | undefined {
  for (const root of roots) {
    const base = stateFilePath(stateId, root);
    for (const ext of STATE_EXTENSIONS) {
      const file = `${base}.${ext}`;
      try {
        return record(parseReferencedFile(file, readFileSync(file, "utf8")));
      } catch {
        // Absent, or mid-edit and unparsable. Either way there is nothing to declare from it.
      }
    }
  }
  return undefined;
}

/**
 * Read one `inputs`/`outputs` map into slot info.
 *
 * A slot is REQUIRED unless it says otherwise, and there are two ways to say otherwise: `optional`,
 * and a `default`. Both are read, because a form that seeded a blank row for a defaulted slot would
 * be inviting an edit that overrode a default nobody wanted overridden.
 *
 * `undefined` — rather than an empty list — when the block is present but is not a map, i.e. a
 * TRANSCLUDED block. Expanding it needs the loader's search path, and a form that showed half a
 * transclusion would be worse than one that showed none of it: the author would take the short list
 * for the whole surface.
 */
function slotsOf(raw: unknown): StateSlotInfo[] | undefined {
  const map = record(raw);
  if (raw !== undefined && map === undefined) return undefined;
  return Object.entries(map ?? {}).map(([name, decl]) => {
    const slot = record(decl);
    const description = stringOf(slot?.["description"]);
    return {
      name,
      optional: slot?.["optional"] === true || slot?.["default"] !== undefined,
      ...(description !== undefined ? { description } : {}),
    };
  });
}

/**
 * What a state declares about its conversation — see {@link StateSlots.session}.
 *
 * Nearest layer wins, which for one document is `operation` over `environment` (WORKFLOWS.md §5.2).
 * A composite declares only the `environment` one, and that is not a lesser answer: a session on a
 * composite root is the ordinary way to give a whole subtree one conversation.
 */
function sessionOf(doc: Record<string, unknown>): { session: { declared: unknown } } | Record<string, never> {
  for (const layer of ["operation", "environment"]) {
    const block = record(doc[layer]);
    if (block !== undefined && "session" in block) return { session: { declared: block["session"] } };
  }
  return {};
}

/**
 * The slots a set of states declare (SPEC §4.1) — see {@link StateSlots}.
 *
 * Ids that name nothing are simply absent from the result: the caller is a form where the reference
 * is being typed, so a miss is the normal case and not an error. So is a state whose `inputs` is a
 * transclusion — see {@link slotsOf} for why that is not the same as declaring none.
 */
export function stateSlots(roots: readonly string[], stateIds: readonly string[]): Record<string, StateSlots> {
  const out: Record<string, StateSlots> = {};
  for (const stateId of new Set(stateIds)) {
    if (stateId.length === 0) continue;
    const doc = readStateDoc(roots, stateId);
    if (doc === undefined) continue;
    const inputs = slotsOf(doc["inputs"]);
    if (inputs === undefined) continue;
    // A transcluded `outputs` costs only the completion list, not the wiring rows, so it degrades to
    // an empty list rather than dropping the state's inputs with it.
    out[stateId] = { inputs, outputs: slotsOf(doc["outputs"]) ?? [], ...sessionOf(doc) };
  }
  return out;
}

/** The workflows directory of every layer, in search order — what {@link stateInputs} resolves against. */
export function workflowRoots(project: Project): string[] {
  return [project.paths.workflowsDir, project.paths.base.workflowsDir];
}

// --- boards ------------------------------------------------------------------

/** Task projections for one workflow, ready for {@link projectBoard}. */
function projectionsFor(project: Project, shape: WorkflowShape | undefined, workflow?: string): TaskProjection[] {
  return taskSummaries(project)
    .filter((summary) => workflow === undefined || summary.workflow === workflow)
    .map((summary) => ({
      taskId: summary.taskId,
      title: summary.title,
      status: summary.status,
      workflow: summary.workflow,
      ...(summary.labels !== undefined ? { labels: summary.labels } : {}),
      updatedAt: summary.updatedAt,
      run: taskRun(project, summary.taskId, shape),
    }));
}

/**
 * The workflow root whose closure contains `stateId`.
 *
 * A shared library state can be mounted under several roots, so this is genuinely ambiguous. A root
 * with tasks in it wins, because the reason to ask is almost always "where is the work" — and a tie
 * falls back to id order so the answer is at least stable between calls.
 */
export function rootContaining(browser: WorkflowBrowser, stateId: string): WorkflowEntry | undefined {
  const candidates = browser.workflows.filter((w) => w.rootId === stateId || w.states.includes(stateId));
  return candidates.find((w) => w.taskIds.length > 0) ?? candidates[0];
}

/**
 * One state's document, and whether it is still the one a run executed.
 *
 * The form in the side panel is the Files view's, and the Files view's form reads an AUTHORED state
 * file — names, types, bindings written the way somebody typed them. So this hands back the file.
 *
 * ## What a snapshot can and cannot give back
 *
 * A run pins its workflow (DESIGN §5.3), and it would be better to hand back the pinned copy of the
 * file. It cannot: a snapshot stores the LOWERED states — bindings compiled into expression trees,
 * the inherited environment already folded into each operation — which is what the engine re-runs
 * and not what a form can draw. `.children.critique.output.outcome` does not survive that trip.
 *
 * What survives is the pin itself. So the file on disk is what is shown, and {@link
 * EffectiveState.from} says whether it is still the one that ran: `pinned` when the run's snapshot
 * is the workflow as it stands, `moved` when the workflow has changed since — which is the case a
 * reader of an old failure has to be told about rather than left to assume. `disk` is for a caller
 * that named no run, where the question does not arise.
 */
export function effectiveState(
  project: Project,
  stateId: string,
  browser: WorkflowBrowser,
  options: { snapshotHash?: string } = {},
): EffectiveState {
  const owning = rootContaining(browser, stateId);
  // The same lookup `stateView` makes, and it has to be: the panel and the inspector describe one
  // file, and a shadowed base copy is not the one that runs.
  const entry =
    browser.files.find((f) => f.stateId === stateId && f.shadowed !== true) ??
    browser.files.find((f) => f.stateId === stateId);
  const source = ((): WorkflowSource | undefined => {
    if (entry === undefined) return undefined;
    const file = join(entry.root, entry.file);
    if (!existsSync(file)) return undefined;
    return { stateId, layer: entry.layer, file, text: readFileSync(file, "utf8"), exists: true };
  })();

  const pinned = options.snapshotHash;
  const from: EffectiveState["from"] =
    pinned === undefined ? "disk" : pinned === owning?.snapshotHash ? "pinned" : "moved";

  return {
    stateId,
    from,
    ...(pinned !== undefined ? { snapshotHash: pinned } : {}),
    ...(owning !== undefined ? { rootId: owning.rootId } : {}),
    // Absent rather than an empty document: a state id nothing on the search path defines is a real
    // answer — renamed, or belonging to a root this project does not reach — and an empty form would
    // read as a state that declares nothing.
    ...(source !== undefined ? { source } : {}),
  };
}

/**
 * The board of an arbitrary state: its children as columns, the tasks inside them as cards.
 *
 * Returns `null` when nothing can be projected — the state belongs to no loadable workflow — so the
 * caller can say "no board" rather than render an empty one that looks like "no tasks".
 */
export function boardForState(
  project: Project,
  stateId: string,
  browser: WorkflowBrowser,
  options?: StateViewOptions,
): BoardView | null {
  const root = rootContaining(browser, stateId);
  if (!root) return null;
  const bundle = bundleFor(project, root.rootId);
  if (!bundle) return null;
  const interactive = options?.interactiveFunctions;
  const shape = workflowShape(bundle, interactive !== undefined ? { interactiveFunctions: interactive } : {});
  if (shape[stateId] === undefined) return null;
  return projectBoard(shape, stateId, projectionsFor(project, shape, root.rootId), {
    breadcrumb: breadcrumbOf(shape, root.rootId, stateId),
  });
}

/**
 * The root listing: one column per workflow root, every task in the column of the workflow it runs.
 *
 * Not a `projectBoard` call, because there is no state above these — the roots are siblings with no
 * parent and no order. `atLevel` stays empty for the same reason: there is no level for a task to be
 * at.
 *
 * EVERY task lands in a column, whatever it is doing. A task cannot move between workflows and its
 * parentage is fixed at creation, so the column it belongs to is decided by facts that never
 * change, and a finished run sorted out of its own workflow into a tray was a card filed under a
 * status rather than a place — which is what the lanes inside a column are for. A task spawned by
 * another task files under its ancestor's column: the flow the person started, not the machinery
 * it ran through.
 */
export function rootsBoard(project: Project, browser: WorkflowBrowser, options?: StateViewOptions): BoardView {
  const summaries = taskSummaries(project);
  const finished: BoardCard[] = [];
  const columns = browser.workflows.map((workflow) => ({
    key: workflow.rootId,
    stateId: workflow.rootId,
    ...(workflow.label !== undefined ? { label: workflow.label } : {}),
    cards: [] as BoardCard[],
  }));
  const byRoot = new Map(columns.map((c) => [c.key, c]));

  // A workflow this project has RUN but has no file for still gets a column.
  //
  // Roots are derived from `workflows/` because that is where a workflow you can start lives. JaiRA's
  // own project is the case that does not fit: its workflows are SYNTHESIZED and pinned as snapshots
  // (`beginTaskRun`'s `bundle` option), so there is no file to derive a root from — and a board built
  // from files alone showed nothing at all for a project whose whole content is runs.
  //
  // A task that names no workflow at all gets one keyed by its TITLE. There is nothing else to group
  // it by, and the alternative is the tray this listing no longer has: a task with no readable
  // workflow is still a task, and a column of one is a truthful board.
  const keyOf = (summary: { workflow: string; title: string }): string =>
    summary.workflow.length > 0 ? summary.workflow : summary.title;

  // A task spawned BY another task — a sync's review round, a worktree review — belongs to the flow
  // it originated from, so it files under its TOPMOST ancestor's column rather than presenting its
  // own workflow as a top-level one. `parentTaskId` is the recorded fact this walk follows; without
  // it, every subsidiary run's workflow became a column of its own the moment its runs existed,
  // which is how `changeset/review-loop` ended up beside the sync workflows it was serving. The
  // walk stops where the records do: a parent this project holds no row for (a review of another
  // project's task) leaves the child where it stands, and a cycle — corrupt records, nothing else
  // writes one — stops rather than spins.
  const byTaskId = new Map(summaries.map((s) => [s.taskId, s]));
  const homeOf = (summary: (typeof summaries)[number]): (typeof summaries)[number] => {
    let current = summary;
    const seen = new Set<string>([current.taskId]);
    while (current.parentTaskId !== undefined) {
      const parent = byTaskId.get(current.parentTaskId);
      if (parent === undefined || seen.has(parent.taskId)) break;
      seen.add(parent.taskId);
      current = parent;
    }
    return current;
  };
  for (const summary of summaries) {
    const home = homeOf(summary);
    const key = keyOf(home);
    if (byRoot.has(key)) continue;
    const column = {
      key,
      stateId: home.workflow,
      ...(home.workflow.length === 0 ? { label: home.title } : {}),
      cards: [] as BoardCard[],
    };
    columns.push(column);
    byRoot.set(column.key, column);
  }

  for (const summary of summaries) {
    // One bundle per workflow would be cheaper, but a card at this level only needs the task's own
    // active path, and `taskRun` without a shape still yields one.
    const bundle = bundleFor(project, summary.workflow, summary.snapshotHash);
    const interactive = options?.interactiveFunctions;
    const shape = bundle
      ? workflowShape(bundle, interactive !== undefined ? { interactiveFunctions: interactive } : {})
      : undefined;
    const run = taskRun(project, summary.taskId, shape);
    // Where it is, or where it stopped — one rule, so a card does not change column the moment its
    // run ends. See `boardPathOf`.
    const path = boardPathOf(run);
    const deepest = path[path.length - 1];
    const live = run.activePath.length > 0;
    const over = summary.status === "completed" || summary.status === "failed" || summary.status === "canceled";
    // When it ended, for a run that has. See `BoardCard.endedAt` — the task row's own clock moves for
    // anything that touches the record, and this is the journal's answer.
    const ended = over ? endedAtOf(run) : undefined;
    const card: BoardCard = {
      ...(ended !== undefined ? { endedAt: ended } : {}),
      taskId: summary.taskId,
      title: summary.title,
      status: summary.status,
      workflow: summary.workflow,
      ...(live && deepest !== undefined ? { activeStateId: deepest.stateId } : {}),
      activePath: path,
      // Every root has children worth walking into, so a card here is always a drill.
      hasSubBoard: path.length > 0,
      ...(summary.labels !== undefined ? { labels: summary.labels } : {}),
      updatedAt: summary.updatedAt,
    };
    // Always found: the loop above made a column for every flow the summaries resolve to, whether
    // or not a file backs it.
    byRoot.get(keyOf(homeOf(summary)))?.cards.push(card);
    // The census — see `projectBoard`. These cards are in their columns too.
    if (over) finished.push(card);
  }

  return { level: "", label: "All workflows", breadcrumb: [], columns, atLevel: [], finished };
}

// --- one state ---------------------------------------------------------------

/** Read a field off a raw/loaded state without depending on the engine's exact types. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Every `$ref` string anywhere in a document.
 *
 * Walked rather than read from known fields because references are a general mechanism — a prompt, an
 * operation block, a type, a guard — and listing only the places we happen to remember would make
 * the inspector quietly incomplete.
 */
function refsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, out);
    return out;
  }
  const obj = record(value);
  if (!obj) return out;
  for (const [key, child] of Object.entries(obj)) {
    if (key === "$ref" && typeof child === "string") out.add(child);
    else refsIn(child, out);
  }
  return out;
}

function transitionsOf(def: unknown, stateId: string, ancestors: ReadonlySet<string>): StateTransition[] {
  const raw = record(def)?.["transitions"];
  if (!Array.isArray(raw)) return [];
  const out: StateTransition[] = [];
  for (const entry of raw) {
    const t = record(entry);
    if (!t) continue;
    const to = stringOf(t["to"]);
    if (to === undefined) continue;
    // `when` is authored as an expression string or lowered to a ref; show whichever is there rather
    // than an empty guard, which would read as unconditional.
    const when = stringOf(t["when"]) ?? (t["when"] !== undefined ? JSON.stringify(t["when"]) : "always");
    out.push({ when, to, loops: to === stateId || ancestors.has(to) });
  }
  return out;
}

/** The ancestors of a state within one workflow, for deciding whether a transition loops. */
function ancestorsOf(shape: WorkflowShape, rootId: string, stateId: string): Set<string> {
  const trail = breadcrumbOf(shape, rootId, stateId);
  return new Set(trail.slice(0, -1).map((crumb) => crumb.stateId));
}

/**
 * Everything the Files view shows about one state.
 *
 * One call rather than several, because the middle panel and the inspector are two renderings of the
 * same subject and fetching them separately is how they end up disagreeing about which state is open.
 */
export function stateView(
  project: Project,
  stateId: string,
  browser: WorkflowBrowser,
  options: StateViewOptions = {},
): StateView {
  const entry = browser.files.find((f) => f.stateId === stateId && f.shadowed !== true)
    ?? browser.files.find((f) => f.stateId === stateId);
  const layer: WorkflowLayer = entry?.layer ?? "project";
  const root = layer === "base" ? project.paths.base.workflowsDir : project.paths.workflowsDir;
  const file = entry !== undefined ? join(entry.root, entry.file) : `${stateFilePath(stateId, root)}.json`;

  const owning = rootContaining(browser, stateId);
  const bundle = owning ? bundleFor(project, owning.rootId) : undefined;
  const interactive = options.interactiveFunctions;
  const shape = bundle ? workflowShape(bundle, interactive !== undefined ? { interactiveFunctions: interactive } : {}) : {};
  const def = bundle?.states[stateId] as unknown;

  const children: StateChild[] = (shape[stateId]?.children ?? []).map((child) => ({
    key: child.key,
    stateId: child.stateId,
    ...(child.label !== undefined ? { label: child.label } : {}),
    hasChildren: (shape[child.stateId]?.children?.length ?? 0) > 0,
  }));

  const op = record(record(def)?.["operation"]);
  const kind = stringOf(op?.["kind"]);
  const functionRef = stringOf(op?.["functionRef"]) ?? stringOf(op?.["function"]);
  const model = stringOf(record(op?.["config"])?.["model"]) ?? stringOf(op?.["model"]);

  // The environment the loader already merged (`LoadedState.environment` is the resolved chain), so
  // an executor inherited from an ancestor is reported without walking the tree again here.
  const env = record(record(def)?.["environment"]);
  const envExecutor = stringOf(env?.["executor"]) ?? stringOf(record(env?.["operation"])?.["functionRef"]);
  const executor = envExecutor ?? (kind === "function" ? functionRef : undefined);
  const known = options.knownExecutors;
  const available = options.availableExecutors;
  // Only a name JaiRA recognises as an executor is judged. `review_artifact` and
  // `review_artifacts` are UI components, and calling one "unavailable" would be both wrong
  // and unfixable.
  const judged = executor !== undefined && known !== undefined && known.has(executor);
  const isAvailable = !judged || available?.has(executor!) === true;

  const issues: LintIssue[] = (owning?.issues ?? []).filter((issue) => issue.stateId === stateId);
  // The loader carries a failure to lower an operation as DATA rather than throwing, so a state can
  // arrive here with no `operation` at all and no explanation of why. Surfacing it is the difference
  // between an inspector that says "no operation" and one that says what is wrong with it.
  const operationError = stringOf(record(def)?.["operationError"]);
  if (operationError !== undefined) {
    issues.push({ stateId, path: "operation", message: operationError, severity: "error" });
  }
  if (judged && !isAvailable) {
    issues.push({
      stateId,
      path: "operation.functionRef",
      message:
        `executor '${executor}' is not available — it is not in the default environment, ` +
        `so a task reaching this state is refused at start`,
      severity: "error",
    });
  }

  const board = owning && shape[stateId] !== undefined
    ? projectBoard(shape, stateId, projectionsFor(project, shape, owning.rootId), {
        breadcrumb: breadcrumbOf(shape, owning.rootId, stateId),
      })
    : null;

  // A leaf has no columns to hold its tasks, so they are listed directly. Taken from the same
  // projection the board uses, which is what keeps the two renderings from disagreeing.
  const hasChildren = children.length > 0;
  // "Here" is the present tense, so the ended runs are filtered out of it — they are in the columns
  // now (see `BoardView.finished`), and a list of what is at this state should not answer with what
  // finished here last week. `tasksRecent` is that question, and takes them from the census.
  const ended = new Set((board?.finished ?? []).map((c) => c.taskId));
  const tasksHere = board
    ? [...board.atLevel, ...board.columns.flatMap((c) => c.cards)].filter((c) => !ended.has(c.taskId))
    : [];
  const tasksRecent = board ? [...board.finished].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8) : [];

  const refs = new Set<string>();
  if (entry !== undefined) {
    // Read from the AUTHORED document: the loaded state has its references resolved away, and the
    // inspector's job is to show what the file says before resolution, plus whether it worked.
    const authored = browser.files.find((f) => f.stateId === stateId && f.layer === layer);
    if (authored !== undefined) refsIn(def, refs);
  }
  const references: StateReference[] = [...refs].map((ref) => ({
    ref,
    // A reference that survived into the loaded bundle resolved by definition — the loader would
    // have reported it otherwise, and that report is already in `issues`.
    resolved: true,
    layer,
  }));

  const referencedBy = Object.entries(shape)
    .filter(([, s]) => s.children.some((c) => c.stateId === stateId))
    .map(([id]) => id)
    .sort();

  const drifted = (owning?.driftedTasks ?? []).filter((taskId) => tasksHere.some((c) => c.taskId === taskId));

  return {
    stateId,
    ...(shape[stateId]?.label !== undefined ? { label: shape[stateId]!.label } : {}),
    layer,
    file,
    exists: entry !== undefined,
    ...(owning !== undefined ? { rootId: owning.rootId } : {}),
    ...(kind === "prompt" || kind === "function"
      ? {
          operation: {
            kind,
            ...(functionRef !== undefined ? { functionRef } : {}),
            ...(model !== undefined ? { model } : {}),
          },
        }
      : {}),
    children,
    board: hasChildren ? board : null,
    tasksHere,
    tasksRecent,
    transitions: owning ? transitionsOf(def, stateId, ancestorsOf(shape, owning.rootId, stateId)) : [],
    environment: {
      ...(executor !== undefined ? { executor } : {}),
      available: isAvailable,
      ...(envExecutor !== undefined && kind !== "function" ? { from: "environment" } : {}),
    },
    issues,
    references,
    referencedBy,
    driftedTasks: drifted,
  };
}
