/**
 * The Files room's MODEL — the part of `files.tsx` that is not drawing.
 *
 * Moved out unchanged (decision 0015) so the desktop's tree, address bar and panel and their universal
 * copies (`packages/universal/src/components/files/`) derive everything from one place: which rows a
 * tree shows and what each says, what the `+` menus offer and where a new row lands, which crumbs an
 * address has, how the panel splits. Nothing here renders; `files.tsx` re-exports what it always
 * exported, so its importers are unchanged.
 */
import type { BoardCard, FileMutationResult, FileNode, FileRoot, FileSource, FileTree, InstanceNode, MoveWorkflowRequest, StateView, WorkflowLayer, WorkflowMutationResult } from "@jaira/shared/browser";
import { isTextMime, isWritableLayer } from "@jaira/shared/browser";
import { alternatives, runCrumbs, type Crumb } from "./crumbModel";
import { editorPick, viewerPick, type FileSurfaceContext, type SurfaceRegistry } from "./fileTypes";
import type { AskSpec, MenuItem } from "./menu";
import { taskNameOf, taskNamePending } from "./taskName";
import type { TrailStep } from "./trail";
import { HALVES, type HalfMode } from "./uiState";

/**
 * The three positions of the lower half, as the bar says them.
 *
 * A glyph that shows how much of the column this half HAS, rather than an arrow pointing at what a
 * click would do: the arrow was ambiguous the moment there were three positions, and the size of a
 * thing is what a size control should show.
 */
export const HALF_GLYPHS: Record<HalfMode, string> = { shut: "▁", half: "▄", full: "█" };
export const HALF_WORDS: Record<HalfMode, string> = {
  shut: "folded away",
  half: "half the column",
  full: "the whole column",
};

/** What the tree highlights: a file is identified by its layer and its path, never by its id. */
export interface FileSelection {
  layer: WorkflowLayer;
  path: string;
  /**
   * WHICH project, for a `project`-layer file. Absent on the shared root.
   *
   * The tree holds every open project now (SHELL.md §2.2), so `{layer, path}` names as many files as
   * there are projects and the highlight would land on all of them.
   */
  project?: string;
}

export const LAYER_LABEL: Record<WorkflowLayer, string> = {
  project: "this project",
  base: "shared",
  // What ships (decision 0006): the tree's last root, read-only.
  system: "built in",
};

/** What a layer's ROOT is called in the address bar — a directory's name, or the reference that names it. */
export const ROOT_WORD: Record<WorkflowLayer, string> = { project: ".jaira", base: "~/.jaira", system: "$SYSTEM" };

/** What each file kind looks like in the tree. Glyphs, not colour, so the meaning survives a theme. */
export const KIND_GLYPH: Record<string, string> = {
  directory: "▾",
  workflow: "◻",
  prompt: "◈",
  skill: "✦",
  config: "⚙",
  other: "·",
};

/**
 * The tooltip for a row's lint state, or `undefined` when there is nothing to say.
 *
 * The `unchecked` wording is the one worth getting right. Zero errors on a state no root reaches
 * does not mean it is clean, it means nobody looked — and a file that reads as clean is exactly the
 * file someone starts a task against.
 */
export function lintTitle(node: FileNode, isDir: boolean): string | undefined {
  const lint = node.lint;
  if (lint === undefined) return undefined;
  if (lint.unchecked === true) return "not validated — no workflow root reaches this state";
  const parts: string[] = [];
  if (lint.errors > 0) parts.push(`${lint.errors} error${lint.errors === 1 ? "" : "s"}`);
  if (lint.warnings > 0) parts.push(`${lint.warnings} warning${lint.warnings === 1 ? "" : "s"}`);
  if (parts.length === 0) return undefined;
  return `${parts.join(", ")}${isDir ? " below here" : ""}`;
}

/**
 * The `workflows/` directory of a root, root-relative.
 *
 * Every question below goes through the root's own `prefix` rather than through the string
 * `.jaira`, and that is the fix as much as it is the shape: the tree is rooted at the CHECKOUT, so
 * a project's states live at `.jaira/workflows/…` while the shared root's live at `workflows/…`.
 * Asked with the literal, "New state here…" was unreachable in every project's own workflows folder
 * and appeared only in `~/.jaira`.
 */
export function workflowsDirOf(prefix: string): string {
  return prefix === "" ? "workflows" : `${prefix}/workflows`;
}

/**
 * The state id a new file inside a directory would get.
 *
 * `null` for anything outside `workflows/`, because a prompt is not a state and offering to create
 * one there would produce a file the loader never looks at.
 */
export function statePrefixOf(path: string, prefix: string): string | null {
  const dir = workflowsDirOf(prefix);
  if (path === dir) return "";
  return path.startsWith(`${dir}/`) ? `${path.slice(dir.length + 1)}/` : null;
}

/**
 * Is this directory the layer root, or inside it? — what decides whether a folder offers
 * "New workflow…".
 *
 * A workflow is a root state and root states live in one place, so the verb is only sensible where
 * you are already looking at JaiRA's own directory. Offering it beside `src/` would be a menu entry
 * that writes somewhere else in the tree than the folder it was opened on.
 */
export function inLayerOf(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Every directory that has to be OPEN for a row inside `dir` to be on screen — itself included.
 *
 * "New workflow" from the Files row is the case: it names `.jaira/workflows`, which is usually two
 * folded branches away from anything visible, and a name field nobody can see is a name field
 * nobody types into.
 */
export function revealKeys(layer: WorkflowLayer, dir: string): string[] {
  if (dir === "") return [];
  const parts = dir.split("/");
  return parts.map((_, i) => `${layer}:${parts.slice(0, i + 1).join("/")}`);
}

/**
 * A row that does not exist yet: a name being typed, and where what it names will land.
 *
 * The name is typed IN THE TREE rather than into a dialog asking for a path, because the place has
 * already been chosen — you pressed `+` on a folder — and a dialog that then asks for the whole
 * path makes you re-state it, correctly, from memory. What is actually missing is a name, and a row
 * is the shape a name goes in.
 *
 * `target` is the only thing that differs between the three verbs, and a state is genuinely
 * different from a file: it is created by ID (`onCreate` writes `workflows/<id>.json`), so no
 * directory and no suffix appear in it.
 */
export interface TreeDraft {
  /** Which root draws it — `FileRoot.dir`, since several roots share the layer `project`. */
  rootDir: string;
  layer: WorkflowLayer;
  project?: string;
  /**
   * The directory what is typed lands in, root-relative — and it NEED NOT EXIST.
   *
   * That is the whole reason this is a directory rather than a row: `.jaira/workflows/` is where a
   * workflow goes, and a project that keeps its workflows in the shared root has no such folder to
   * hang a row under. Held as the destination and resolved to a row at draw time
   * ({@link anchorIn}), so the field appears under the deepest folder that does exist and the
   * create makes the rest.
   */
  dir: string;
  /**
   * Where the row is drawn, when that cannot be derived from `dir`: a state's first child, whose
   * folder is precisely the thing being created and whose parent is a FILE.
   */
  anchor?: { key: string; depth: number };
  target: { kind: "file" | "directory" } | { kind: "state"; prefix: string };
  /** What {@link revealKeys} says has to be unfolded before it can be seen. */
  reveal: readonly string[];
}

/**
 * Where a draft's row is drawn, and what of its path is not there yet.
 *
 * The deepest directory on the way to `dir` that the tree actually has a row for. A draft whose
 * folder does not exist drew nothing at all — "New workflow" in a project with no
 * `.jaira/workflows/` was a menu entry that did, visibly, nothing — and the honest reading is not
 * that the verb is unavailable but that the folder is part of what it will create. `missing` is
 * that remainder, which the row prints ahead of the field so the path being made is legible before
 * it exists.
 */
export function anchorIn(
  root: FileRoot,
  draft: Pick<TreeDraft, "dir" | "anchor">,
): { under: string | null; depth: number; missing: string } {
  if (draft.anchor !== undefined) return { under: draft.anchor.key, depth: draft.anchor.depth, missing: "" };
  if (draft.dir === "") return { under: null, depth: 0, missing: "" };
  const parts = draft.dir.split("/");
  let nodes: readonly FileNode[] = root.nodes;
  let found = 0;
  for (const part of parts) {
    const path = parts.slice(0, found + 1).join("/");
    const node = nodes.find((n) => n.kind === "directory" && n.path === path);
    if (node === undefined || node.name !== part) break;
    nodes = node.children ?? [];
    found += 1;
  }
  return {
    under: found === 0 ? null : `${root.layer}:${parts.slice(0, found).join("/")}`,
    depth: found,
    missing: parts.slice(found).map((part) => `${part}/`).join(""),
  };
}

/** The root half of a draft — the three fields that say which tree it belongs to. */
const draftRoot = (root: FileRoot): Pick<TreeDraft, "rootDir" | "layer" | "project"> => ({
  rootDir: root.dir,
  layer: root.layer,
  ...(root.project !== undefined ? { project: root.project } : {}),
});

/** A new file or folder, in a directory of this root. */
export function fileDraft(root: FileRoot, dir: string, kind: "file" | "directory"): TreeDraft {
  return { ...draftRoot(root), dir, target: { kind }, reveal: revealKeys(root.layer, dir) };
}

/**
 * A new state, in a directory under `workflows/` — which is what "New workflow…" (that directory
 * being `workflows/` itself) and "New state…" both are.
 */
export function stateDraft(root: FileRoot, dir: string): TreeDraft {
  return {
    ...draftRoot(root),
    dir,
    target: { kind: "state", prefix: statePrefixOf(dir, root.prefix) ?? "" },
    reveal: revealKeys(root.layer, dir),
  };
}

/**
 * A new CHILD of a state: the folder a state's children live in, and the first one in it.
 *
 * Drawn under the state's own row rather than inside that folder, because the folder is usually not
 * there yet — `feature.json` holds the state and `feature/` holds its children, so creating the
 * first child is what creates the directory. One indent under the parent is where the row will be
 * once it exists, which is why the draft appears where the result will.
 */
export function childStateDraft(root: FileRoot, node: FileNode, stateId: string): TreeDraft {
  return {
    ...draftRoot(root),
    dir: `${workflowsDirOf(root.prefix)}/${stateId}`,
    // The parent's own row, one indent in — where `feature/` will draw its rows once it is there.
    anchor: { key: `${node.layer}:${node.path}`, depth: node.path.split("/").length },
    target: { kind: "state", prefix: `${stateId}/` },
    // Its anchor is a row that is already visible, so there is nothing to open.
    reveal: [],
  };
}

/**
 * The root the Files row's own `+` acts on: the one you are standing in.
 *
 * `null` while there is no tree at all. At the address root there is no project layer to be in, so
 * the shared root is what the verb means there — it is a perfectly ordinary place to create
 * something with no project open, and the alternative is a `+` that does nothing.
 */
export function standingRoot(tree: FileTree | null, project: string | null): FileRoot | null {
  if (tree === null || tree.roots.length === 0) return null;
  if (project !== null) {
    const here = tree.roots.find((root) => root.dir === project || root.project === project);
    if (here !== undefined) return here;
  }
  return tree.roots.find((root) => root.layer === "base") ?? tree.roots[0] ?? null;
}

/**
 * The verbs a row under "Built in" offers: READ and OVERRIDE, and nothing else (decision 0006).
 *
 * No New, no Rename, no Duplicate, no Delete — every one of those writes into the layer, and what
 * ships is the app's. It is a separate function from the ordinary menu rather than a set of
 * `disabled` flags on it, so that a verb added to that menu later is not offered here by default:
 * the safe answer to "may this row do X" is no until somebody says otherwise.
 *
 * Overriding is a copy UP a layer under the same id, which is what makes it an override. Both
 * destinations are always listed; the project one is disabled with nothing open, as every
 * project-layer verb in this tree is.
 */
export function builtInItems(
  node: FileNode,
  root: FileRoot,
  act: {
    hasProject: boolean;
    onOpen: (stateId: string, layer: WorkflowLayer) => void;
    onOverride: (stateId: string, toLayer: "base" | "project") => void;
    onCopy: (text: string) => void;
    onReveal: (file: string) => void;
  },
): MenuItem[] {
  const abs = `${root.dir}/${node.path}`;
  const look: MenuItem[] = [
    { label: "Copy path", onSelect: () => act.onCopy(abs) },
    { label: "Reveal in file explorer", onSelect: () => act.onReveal(abs) },
  ];
  const id = node.stateId;
  if (id === undefined) return look;
  return [
    { label: "Open", note: "an edit copies it", onSelect: () => act.onOpen(id, root.layer) },
    { label: "Edit a copy in Shared", note: "~/.jaira", separator: true, onSelect: () => act.onOverride(id, "base") },
    { label: "Override here", note: ".jaira", disabled: !act.hasProject, onSelect: () => act.onOverride(id, "project") },
    { label: "Copy state id", separator: true, onSelect: () => act.onCopy(id) },
    ...look,
  ];
}

/**
 * The three ways to make something, for one directory.
 *
 * Shared by every place that offers them — the Files row's `+`, a folder's `+`, a folder's
 * right-click, a root's — so the list is the same wherever it is opened from and the only thing
 * that varies is what "here" means.
 *
 * "New state…" and "New workflow…" are the same act at two addresses, which is why they never both
 * appear: inside `workflows/` the directory you clicked IS the answer, and outside it — in
 * `.jaira/`, or at the top of the checkout, where the row's own `+` acts — the only sensible answer
 * is `workflows/` itself. Anywhere else in a checkout neither is offered: a workflow written into
 * `src/` is a file the loader never looks at.
 */
export function newItems(root: FileRoot, dir: string, start: (draft: TreeDraft) => void): MenuItem[] {
  const statePrefix = statePrefixOf(dir, root.prefix);
  const items: MenuItem[] = [
    { label: "New file…", onSelect: () => start(fileDraft(root, dir, "file")) },
    { label: "New folder…", onSelect: () => start(fileDraft(root, dir, "directory")) },
  ];
  if (statePrefix !== null) {
    items.push({
      label: "New state…",
      separator: true,
      ...(statePrefix === "" ? {} : { note: statePrefix }),
      onSelect: () => start(stateDraft(root, dir)),
    });
  } else if (dir === "" || inLayerOf(dir, root.prefix)) {
    items.push({
      label: "New workflow…",
      separator: true,
      note: workflowsDirOf(root.prefix),
      onSelect: () => start(stateDraft(root, workflowsDirOf(root.prefix))),
    });
  }
  return items;
}

/**
 * Does this root need introducing, in a tree being browsed from `project`?
 *
 * Not the one the drawer is standing in: the project row directly above the tree is already that
 * name, and printing it again at the top of the branch says the same word twice and costs the first
 * line of a 250px column. Every OTHER root does — a second checkout is a different place, and so is
 * `~/.jaira` while you are standing in a checkout.
 *
 * Matched on the DIRECTORY as well as on the stamp, and that second test is the whole reason this
 * is a named function with a test under it. The shared root carries no `project` — it belongs to
 * none, see `FileTree` — and it is also a row in the sidebar and a perfectly ordinary place to
 * stand. Standing there, a stamp-only test can never be true, so the one root on screen went on
 * introducing itself inside itself.
 */
export function rootNeedsName(root: Pick<FileRoot, "dir" | "project">, project: string | null): boolean {
  if (project === null) return true;
  return root.dir !== project && root.project !== project;
}

/**
 * Every state id in either root — which crumbs above are worth making clickable.
 *
 * A state id is a PATH, so `plan/draft/critique` names two ancestors. Both usually exist as files
 * and opening one is the move the bar is for; neither is guaranteed to, because an id is a naming
 * convention rather than a containment rule and `plan/draft` can exist with no `plan`. A crumb that
 * opens nothing is worse than a crumb that is plainly not a link, so this is what decides.
 */
export function stateIdsOf(tree: FileTree | null): ReadonlySet<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly FileNode[]): void => {
    for (const node of nodes) {
      if (node.stateId !== undefined) out.add(node.stateId);
      if (node.children) walk(node.children);
    }
  };
  for (const root of tree?.roots ?? []) walk(root.nodes);
  return out;
}

/**
 * The directory the workflow hierarchy lives in.
 *
 * The one place a path stops being folders and starts being state ids: `workflows/debug/plan.json`
 * defines the state `debug/plan`. Above it a segment is a folder; below it a segment is a level of
 * the hierarchy, which is what decides the colour.
 */
const WORKFLOWS = "workflows";

/** The state id a directory under `workflows/` is the prefix of, or null when it is not under one. */
function stateIdOfDir(path: string): string | null {
  if (path === WORKFLOWS) return "";
  return path.startsWith(`${WORKFLOWS}/`) ? path.slice(WORKFLOWS.length + 1) : null;
}

/** Everything the address bar needs to build itself. Grouped, because it is most of a screen's state. */
export interface CrumbInput {
  /** Which root the address is in. */
  layer: WorkflowLayer;
  /** The path under that root; `""` is the root itself, which is a real place to stand. */
  path: string;
  /** The state this path defines, when it defines one — what makes the last crumb a state. */
  stateId?: string | undefined;
  /** True when the path names a DIRECTORY, so its last crumb is a folder rather than a document. */
  isDir?: boolean | undefined;
  /** Every state id in either root — which segments under `workflows/` have a file behind them. */
  states: ReadonlySet<string>;
  /** Both roots, whole: the chevrons are directory listings and this is the directory. */
  tree: FileTree | null;
  trail: readonly TrailStep[];
  /** The selected task's instance tree — where a run's siblings come from. */
  instances: readonly InstanceNode[];
  /** The other runs of the open state: what the chevron before the base run offers. */
  runs: readonly BoardCard[];
  selectedTask: string | null;
  /**
   * The selected task's own name — what the BASE run crumb reads.
   *
   * A run is identified by its task, not by its instance id: instance ids restart at 1 on every run,
   * so the root instance of every task is `#1` and a base crumb built from one said the same thing
   * whichever run you picked. See {@link runCrumbOf}.
   */
  taskTitle?: string | undefined;
  /** {@link taskTitle} is a label standing in for a computed title still settling. */
  taskTitlePending?: boolean | undefined;
  onOpenState: (stateId: string) => void;
  onOpenFile: (layer: WorkflowLayer, path: string) => void;
  /** Show a directory's contents. `""` is the root. */
  onOpenDir: (layer: WorkflowLayer, path: string) => void;
  /** Choose another project — the last entry under the root's chevron. */
  onOpenProject?: (() => void) | undefined;
  onWalkBack: (index: number) => void;
  /** Replace the path from `index` down with this run — walking sideways rather than in. */
  onWalkTo: (index: number, node: InstanceNode) => void;
  onSelectTask: (taskId: string) => void;
}

/**
 * What is in one directory of one layer: subdirectories first, then files, each by name.
 *
 * Directories first because that is the order every file manager has used for thirty years, and the
 * reason is still true — the folders are how you keep going, the files are where you stop.
 */
export function entriesUnder(tree: FileTree | null, layer: WorkflowLayer, dir: string): FileNode[] {
  const out: FileNode[] = [];
  const walk = (nodes: readonly FileNode[]): void => {
    for (const node of nodes) {
      const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
      if (parent === dir) out.push(node);
      if (node.children) walk(node.children);
    }
  };
  for (const root of tree?.roots ?? []) if (root.layer === layer) walk(root.nodes);
  return out.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
  );
}

/** One directory entry, as the thing a chevron offers: a folder to enter, a state, or a file. */
export function entryItem(node: FileNode, current: string, input: Pick<CrumbInput, "onOpenDir" | "onOpenState" | "onOpenFile">): MenuItem {
  const checked = node.path === current;
  if (node.kind === "directory") {
    return { label: node.name, note: "folder", checked, onSelect: () => input.onOpenDir(node.layer, node.path) };
  }
  // A state is offered by its ID rather than its filename: `hello_world`, not `hello_world.json`.
  // The extension is a fact about storage, and the bar it would land in speaks state ids.
  if (node.stateId !== undefined) {
    const id = node.stateId;
    return { label: id.split("/").pop() ?? id, checked, onSelect: () => input.onOpenState(id) };
  }
  return { label: node.name, checked, onSelect: () => input.onOpenFile(node.layer, node.path) };
}

/**
 * The path across the top, as a file explorer draws one.
 *
 * THREE families, joined into one address. The FOLDERS are the real path on disk, root included —
 * every one of them a place you can navigate to, which is what makes the bar an address rather than
 * a label. The STATES are the segments under `workflows/`, where a path stops being directories and
 * becomes the workflow hierarchy. The RUNS are where you went from there, one crumb per run walked
 * into, and the view below shows the last element.
 *
 * The root used to be a pill of its own and the folders above `workflows/` were not shown at all,
 * which made the one segment that was drawn differently also the only one you could not click. It is
 * an ordinary folder crumb now.
 *
 * With a run on the path, the file's own last segment stops being where you are and becomes a link
 * like the rest — clicking it is how you get back out to the state itself.
 */
export function crumbsOf(input: CrumbInput): Crumb[] {
  const { layer, path, stateId, isDir, states, tree, trail, instances, runs, selectedTask } = input;
  const out: Crumb[] = [];
  const segments = path === "" ? [] : path.split("/");
  const root = tree?.roots.find((r) => r.layer === layer);

  // The root, as a folder like any other. Its menu is the other roots — and the way to a project
  // that is not open, which is the only navigation in this bar that is not already on disk.
  const roots: MenuItem[] = (tree?.roots ?? []).map((entry) => ({
    label: ROOT_WORD[entry.layer],
    note: LAYER_LABEL[entry.layer],
    checked: entry.layer === layer,
    onSelect: () => input.onOpenDir(entry.layer, ""),
  }));
  if (input.onOpenProject !== undefined) {
    roots.push({ label: "Open another project…", separator: roots.length > 0, onSelect: input.onOpenProject });
  }
  out.push({
    text: ROOT_WORD[layer],
    kind: "folder",
    ...(root !== undefined ? { title: root.dir } : {}),
    ...(segments.length > 0 || trail.length > 0 ? { go: () => input.onOpenDir(layer, "") } : {}),
    ...(alternatives(roots) !== undefined ? { options: alternatives(roots)! } : {}),
  });

  segments.forEach((segment, i) => {
    const here = segments.slice(0, i + 1).join("/");
    const last = i === segments.length - 1;
    const dirId = stateIdOfDir(here);
    // Under `workflows/` a segment is a level of the hierarchy whether or not a file sits at that
    // id — `debug/` with no `debug.json` is still the first half of `debug/hello_world`. What the
    // file's existence decides is where clicking it GOES: to the state, or to the folder that is
    // all there is.
    const asState = last && stateId !== undefined ? stateId : dirId !== null && dirId !== "" ? dirId : undefined;
    const text = last && stateId !== undefined ? (stateId.split("/").pop() ?? segment) : segment;
    const go = last
      ? // Where you already are — unless a run has been walked into, in which case this is the way
        // back out to it. It walks the trail rather than re-opening the document it already has.
        trail.length > 0
        ? (): void => input.onWalkBack(-1)
        : undefined
      : asState !== undefined && states.has(asState)
        ? (): void => input.onOpenState(asState)
        : (): void => input.onOpenDir(layer, here);
    const options = alternatives(
      entriesUnder(tree, layer, segments.slice(0, i).join("/")).map((node) => entryItem(node, here, input)),
    );
    out.push({
      text,
      kind: asState === undefined ? "folder" : "state",
      title: asState === undefined ? here : asState,
      ...(go !== undefined ? { go } : {}),
      ...(options !== undefined ? { options } : {}),
    });
  });

  // A folder's own last crumb is where you are standing, so it gets the current-level treatment the
  // last path segment already has. Nothing more to add — but the LISTING below it is the view, and
  // that is what makes `isDir` worth carrying.
  void isDir;

  // The tail: one crumb per run walked into. The same builder the Tasks address uses — from the run
  // down, the two views are the same address reached two ways. See `runCrumbs`.
  out.push(
    ...runCrumbs({
      trail,
      instances,
      runs,
      selectedTask,
      ...(stateId !== undefined ? { stateId } : {}),
      ...(input.taskTitle !== undefined ? { taskTitle: input.taskTitle } : {}),
      ...(input.taskTitlePending === true ? { taskTitlePending: true } : {}),
      onWalkBack: input.onWalkBack,
      onWalkTo: input.onWalkTo,
      onSelectTask: input.onSelectTask,
    }),
  );
  return out;
}
// --- what the components derive, shared with the universal copies --------------

/** One row of the tree, as {@link FileTreePanel}'s `TreeNode` draws it — every fact the row shows. */
export interface TreeRow {
  /** The fold key, `layer:path`. */
  key: string;
  isDir: boolean;
  /** An open directory. */
  open: boolean;
  isSelected: boolean;
  /** Unsaved edits: this file, or — a directory — anything below it. */
  unsaved: boolean;
  /** The row's lint colour, worst first — as a class suffix, which is what the DOM row wears. */
  tone: "" | " has-error" | " has-warning" | " unchecked";
  /** Not text, so nothing here can open it as text. */
  inert: boolean;
  /** The twisty, or the kind's glyph. */
  glyph: string;
  /** The tooltip: the parse error, the lint, or the path. */
  title: string;
}

export function treeRowOf(
  node: FileNode,
  selected: FileSelection | null,
  dirty: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
): TreeRow {
  // The FOLD key stays per layer, deliberately: `OPENED.folders` is keyed per layer and not per
  // checkout so it does not grow without bound as projects come and go, and two projects that both
  // have a `.jaira/workflows/review/` sharing its folded state is the trade that buys that.
  const key = `${node.layer}:${node.path}`;
  const isDir = node.kind === "directory";
  // POSITIVE: a directory is shut unless it has been opened. Which means a folder nested inside one
  // you just opened is shut too — you get its name, not its contents and everything under them.
  const open = isDir && expanded.has(key);
  // Every file opens now, whatever it is: the registry has a surface for anything that is text, and
  // for anything that is not the panel says so. Highlighting is by PROJECT, layer and path: the same
  // state id exists in both roots and in every open project, and only one of them is the file you
  // clicked (SHELL.md §2.2).
  const selectable = !isDir;
  const isSelected =
    selectable &&
    selected !== null &&
    selected.layer === node.layer &&
    selected.path === node.path &&
    (selected.project ?? undefined) === node.project;
  // The row's own colour, worst-first. A directory carries the totals of what is under it, so a
  // fault stays visible with the branch collapsed — which is the only way it is visible at all when
  // the state that forgot to wire a child is four levels down.
  // Unsaved edits: this file, or — with the branch folded — anything below it. A draft is invisible
  // until it is saved or the window closes, so the tree is where it has to be announced.
  const unsaved =
    dirty.size === 0 ? false : isDir ? [...dirty].some((k) => k.startsWith(`${key}/`)) : dirty.has(key);
  const lint = node.lint;
  const tone =
    node.error !== undefined || (lint?.errors ?? 0) > 0
      ? " has-error"
      : (lint?.warnings ?? 0) > 0
        ? " has-warning"
        : lint?.unchecked === true
          ? " unchecked"
          : "";
  return {
    key,
    isDir,
    open,
    isSelected,
    unsaved,
    tone,
    inert: !(isTextMime(node.mime) || isDir),
    glyph: isDir ? (open ? "▾" : "▸") : (KIND_GLYPH[node.kind] ?? "·"),
    title: node.error ?? lintTitle(node, isDir) ?? node.path,
  };
}

/**
 * Filtering flattens: a match three directories down is useless if its parents are still folded,
 * and re-deriving which ancestors to force open costs more than just listing the hits.
 */
export function treeMatches(nodes: FileNode[], filter: string, out: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    if (node.kind !== "directory" && node.path.toLowerCase().includes(filter.toLowerCase())) out.push(node);
    if (node.children) treeMatches(node.children, filter, out);
  }
  return out;
}

/** What an empty root says: an absent shared root is the normal starting state, not a fault. */
export function rootEmptyText(root: Pick<FileRoot, "exists">, writable: boolean): string {
  return root.exists ? "empty" : writable ? "not created yet — adding a state here will create it" : "nothing ships with this build";
}

/**
 * Everything the address bar needs, for whichever of the two things is open.
 *
 * One assembly rather than two, because the bar does not care: a folder and a document are both
 * addresses under a layer root, and the only difference is which of them has a state id and what
 * is rendered underneath.
 */
export function crumbInputOf(
  at: { layer: WorkflowLayer; path: string; stateId?: string | undefined; isDir?: boolean },
  context: FileSurfaceContext,
  known: ReadonlySet<string>,
  onWalkBack: ((index: number) => void) | undefined,
): CrumbInput {
  return {
    layer: at.layer,
    path: at.path,
    ...(at.stateId !== undefined ? { stateId: at.stateId } : {}),
    ...(at.isDir === true ? { isDir: true } : {}),
    states: known,
    tree: context.tree,
    trail: context.trail ?? [],
    instances: context.detail?.instances ?? [],
    // The state's own runs, which is what the base chevron offers: the ones parked here now first,
    // then the ones that have been through. Same order the leaf panel lists them in.
    runs: [...(context.state?.tasksHere ?? []), ...(context.state?.tasksRecent ?? [])],
    selectedTask: context.selected,
    ...(context.detail !== null ? { taskTitle: taskNameOf(context.detail), taskTitlePending: taskNamePending(context.detail) } : {}),
    onOpenState: context.onDrill,
    onOpenFile: context.onOpenFile ?? ((): void => {}),
    onOpenDir: context.onOpenDir ?? ((): void => {}),
    ...(context.onOpenProject !== undefined ? { onOpenProject: context.onOpenProject } : {}),
    onWalkBack: onWalkBack ?? ((): void => {}),
    onWalkTo: context.onWalkTo ?? ((): void => {}),
    onSelectTask: context.onSelectTask,
  };
}

/**
 * Whether the address offers the board/conversation toggle: only where there are two readings — a
 * leaf state's viewer is its conversation, and so is a run that entered no children. Asked of the
 * trail's TAIL, because that is what the panel is showing.
 */
export function runToggleableOf(doc: FileSource, context: Pick<FileSurfaceContext, "trail" | "state" | "trailState">): boolean {
  const trail = context.trail ?? [];
  const tail = trail.at(-1);
  return (
    doc.stateId !== undefined &&
    context.state?.board != null &&
    (tail === undefined || tail.stateId === doc.stateId || (context.trailState?.board ?? null) !== null)
  );
}

/** A state's issues, as the address bar counts them. */
export function issueCountsOf(state: StateView | null): { errors: number; warnings: number } {
  const errors = state === null ? 0 : state.issues.filter((i) => i.severity === "error").length;
  const warnings = state === null ? 0 : state.issues.length - errors;
  return { errors, warnings };
}

/** The lower half's next position: it cycles rather than toggles — three positions, one place. */
export function nextHalf(at: HalfMode): HalfMode {
  return HALVES[(HALVES.indexOf(at) + 1) % HALVES.length]!;
}

/** What {@link FolderInspector} says about a folder: what it holds, and the root it is under. */
export function folderFactsOf(tree: FileTree | null, layer: WorkflowLayer, path: string): { entries: FileNode[]; dirs: number; states: number; root: FileRoot | undefined } {
  const entries = entriesUnder(tree, layer, path);
  const dirs = entries.filter((node) => node.kind === "directory").length;
  const states = entries.filter((node) => node.stateId !== undefined).length;
  const root = tree?.roots.find((r) => r.layer === layer);
  return { entries, dirs, states, root };
}

/**
 * When copy-on-edit last asked to copy each shipped file, by path. Module state rather than a hook,
 * because {@link FilePanel} returns early before its hooks would run; the window is how long a copy
 * takes to open, after which the file shown is the copy and nothing here is asked again.
 */
const COPY_ASKED = new Map<string, number>();
const COPY_WINDOW_MS = 5000;

/** What a file surface is mounted with (`FileSurfaceProps`, spelled out so this module draws nothing). */
export interface PanelSurfaceProps {
  doc: FileSource;
  busy: boolean;
  onSave: (text: string) => void;
  context: FileSurfaceContext;
}

/**
 * The open file's panel: which renderer draws each half, where the lower half stands, and the props
 * each half is mounted with — `FilePanel`'s resolution, for it and for the universal copy (which passes
 * its own registry of native surfaces).
 */
export function filePanelOf(props: PanelSurfaceProps, half: HalfMode, from?: SurfaceRegistry) {
  const { doc, context } = props;
  /**
   * The two halves, worked out from what this type can be drawn BY — see `viewerFor` / `editorFor`.
   *
   * Neither is declared any more. A renderer says what kind of rendering it is (text, data, preview)
   * and whether it writes; the upper half takes the rendering, the lower half takes the thing that
   * writes, and this person's choice per kind decides which of each. That indirection is why a
   * `.json` file can have a data tree above and an editor below without either being described as
   * the other's alternative.
   */
  const viewer = viewerPick(doc.mime, context.renderers, from);
  const View = viewer?.renderer.surface ?? null;
  const edits = editorPick(doc.mime, context.renderers, from);
  const editor = edits?.renderer ?? null;
  const Edit = editor?.surface ?? null;
  // The same props, said to be the READING. Only this function knows which half it is mounting, and
  // the palette is keyed per view — so a viewer built from `props` would be drawn in the editor's
  // colours. See `FileSurfaceContext.view`.
  const viewProps = { ...props, context: { ...context, view: "read" as const } };
  /**
   * A shipped file that is not a state, mounted LIVE for copy-on-edit: its first draft asks the shell
   * to copy the file into Shared, and the draft moves to the copy (`editBuiltInFile`). The draft is
   * still written under the shipped file's own key, so the editor shows every keystroke while the
   * copy is being made. `undefined` — a reading — when Shared already has its copy, or when this
   * host cannot copy.
   */
  const copyFile = context.builtInActions?.onEditFileCopy;
  const shippedProps: PanelSurfaceProps | undefined =
    doc !== null && doc.layer === "system" && doc.stateId === undefined && copyFile !== undefined && doc.builtIn?.layers.includes("base") !== true
      ? {
          ...props,
          context: {
            ...context,
            onDraft: (key: string, text: string | null) => {
              context.onDraft?.(key, text);
              // Once per copy: every keystroke until the copy opens is a draft here, and the draft is
              // what moves across — see `COPY_ASKED`.
              if (text === null || Date.now() - (COPY_ASKED.get(doc.path) ?? 0) < COPY_WINDOW_MS) return;
              COPY_ASKED.set(doc.path, Date.now());
              copyFile(doc.path, doc.text);
            },
          },
        }
      : undefined;
  // What ships is never written in place (decision 0006), and it is edited all the same:
  // COPY-ON-EDIT (the panel rulings, 2026-09-24). A shipped STATE's editor copies it into
  // Shared on its first change; any other shipped file is mounted live with its first draft
  // turned into the same copy (`shippedProps`). Only a file Shared already has a copy of —
  // the copy is what is read — is mounted as the READING of its type.
  const editProps = isWritableLayer(doc.layer) || doc.stateId !== undefined ? props : (shippedProps ?? viewProps);
  // With no viewer the editor IS the panel, so there is nothing to fold it away from and nothing to
  // grow into: a file type with no viewer is always at `full`, whatever was remembered.
  const at: HalfMode = View === null ? "full" : half;
  return { viewer, View, edits, editor, Edit, at, shut: at === "shut", props, viewProps, editProps };
}

/** What {@link treeMenus} acts through — `FileTreePanel`'s props, and the host's dialog and clipboard. */
export interface TreeVerbs {
  hasProject: boolean;
  onOpen: (stateId: string, layer: WorkflowLayer) => void;
  onMove: (request: MoveWorkflowRequest) => Promise<WorkflowMutationResult | null>;
  onDelete: (stateId: string, layer: WorkflowLayer, force?: boolean) => Promise<WorkflowMutationResult | null>;
  onRenameFile: (layer: WorkflowLayer, path: string, to: string, force?: boolean) => Promise<FileMutationResult | null>;
  onDeleteFile: (layer: WorkflowLayer, path: string, force?: boolean) => Promise<FileMutationResult | null>;
  onReveal: (file: string) => void;
  /** Put text on the clipboard. */
  copy: (text: string) => void;
  /** Ask a question (a confirmation, or a name), or close the one asked. */
  setAsk: (spec: AskSpec | null) => void;
  /** Start typing a new row's name — see {@link TreeDraft}. */
  startDraft: (draft: TreeDraft) => void;
}

/**
 * The tree's right-click menus: a row's verbs (`itemsFor`) and a root's (`rootItems`), with the second
 * ask a refused move or delete makes. `FileTreePanel`'s own, moved out unchanged so the universal copy
 * offers the same verbs (a long press on a phone).
 */
export function treeMenus(verbs: TreeVerbs): { itemsFor: (node: FileNode, root: FileRoot) => MenuItem[]; rootItems: (root: FileRoot, writable: boolean) => MenuItem[] } {
  const { hasProject, onOpen, onMove, onDelete, onRenameFile, onDeleteFile, onReveal, setAsk, startDraft } = verbs;
  const copyText = verbs.copy;
  /**
   * Run a move, and if it was refused because other states point at this one, say who and offer to
   * go ahead. The second ask is the whole value of the refusal — a rename that silently broke three
   * workflows would be discovered later, by a run that failed to load.
   */
  const move = async (request: MoveWorkflowRequest, verb: string): Promise<void> => {
    const result = await onMove(request);
    if (!result || result.applied) return;
    setAsk({
      title: `${verb} '${request.stateId}' anyway?`,
      note: `${result.referencedBy.join(", ")} declare${result.referencedBy.length === 1 ? "s" : ""} it as a child. They will name a state that no longer exists.`,
      confirmLabel: `${verb} anyway`,
      danger: true,
      onConfirm: () => {
        setAsk(null);
        void onMove({ ...request, force: true });
      },
    });
  };

  const remove = async (stateId: string, layer: WorkflowLayer): Promise<void> => {
    const result = await onDelete(stateId, layer);
    if (!result || result.applied) return;
    setAsk({
      title: `Delete '${stateId}' anyway?`,
      note: `${result.referencedBy.join(", ")} declare${result.referencedBy.length === 1 ? "s" : ""} it as a child, and will fail to load without it.`,
      confirmLabel: "Delete anyway",
      danger: true,
      onConfirm: () => {
        setAsk(null);
        void onDelete(stateId, layer, true);
      },
    });
  };

  /**
   * The same two verbs for everything in the tree that is not a state.
   *
   * They exist separately from {@link move} and {@link remove} because these are addressed by PATH:
   * a prompt has no state id, and a directory has neither an id nor a single state to check. The
   * second ask is the same one, over whatever states the path turned out to cover — a directory
   * under `workflows/` is an id prefix, so renaming one is a bulk state rename wearing a different
   * verb, and it can break a workflow just as thoroughly.
   */
  const pathOp = async (
    run: (force?: boolean) => Promise<FileMutationResult | null>,
    path: string,
    verb: string,
    consequence: string,
  ): Promise<void> => {
    const result = await run();
    if (!result || result.applied) return;
    const subject = result.states.length === 1 ? "it" : `${result.states.length} states inside it`;
    setAsk({
      title: `${verb} '${path}' anyway?`,
      note: `${result.referencedBy.join(", ")} declare${result.referencedBy.length === 1 ? "s" : ""} ${subject} as a child. ${consequence}`,
      confirmLabel: `${verb} anyway`,
      danger: true,
      onConfirm: () => {
        setAsk(null);
        void run(true);
      },
    });
  };

  /**
   * "Rename…" and "Delete", for a file or a directory.
   *
   * Rename asks for a PATH rather than a name, so the same dialog moves a prompt into another folder
   * — the field is prefilled with where it is now, and editing the last segment is the common case.
   */
  const pathItems = (node: FileNode, abs: string): MenuItem[] => {
    const what = node.kind === "directory" ? "folder" : "file";
    return [
      {
        label: "Rename…",
        separator: true,
        onSelect: () =>
          setAsk({
            title: `Rename '${node.name}'`,
            field: "Path",
            initial: node.path,
            note: `Relative to ${node.layer === "base" ? "~/.jaira/" : ".jaira/"}`,
            confirmLabel: "Rename",
            onConfirm: (v) => {
              setAsk(null);
              void pathOp(
                (force) => onRenameFile(node.layer, node.path, v, force),
                node.path,
                "Rename",
                "They will name a state that no longer exists.",
              );
            },
          }),
      },
      {
        label: "Delete",
        danger: true,
        onSelect: () =>
          setAsk({
            title: `Delete this ${what}?`,
            // The absolute path, because "prompts/goals.md" exists in both layer roots and the one
            // about to go is decided by which row was right-clicked.
            note: node.kind === "directory" ? `${abs} — and everything inside it.` : abs,
            confirmLabel: "Delete",
            danger: true,
            onConfirm: () => {
              setAsk(null);
              void pathOp(
                (force) => onDeleteFile(node.layer, node.path, force),
                node.path,
                "Delete",
                "They will fail to load without it.",
              );
            },
          }),
      },
    ];
  };

  /**
   * The verbs a node offers, by what the node actually is.
   *
   * The creation half is {@link newItems}, which every other surface shares — a folder's `+`, the
   * root's, the Files row's. Right-click adds what acts on the node itself: rename, delete, and the
   * two ways out to the file system.
   *
   * Offered on files too, where "here" means the directory the file sits in — right-clicking the
   * thing next to where you want the new one is how people actually reach for this.
   */
  const itemsFor = (node: FileNode, root: FileRoot): MenuItem[] => {
    const abs = `${root.dir}/${node.path}`;
    // What ships is read and overridden, and nothing else (decision 0006) — see {@link builtInItems}.
    if (!isWritableLayer(root.layer)) {
      return builtInItems(node, root, {
        hasProject,
        onOpen,
        onOverride: (id, toLayer) => void move({ stateId: id, layer: "system", to: id, toLayer, copy: true }, "Override"),
        onCopy: copyText,
        onReveal,
      });
    }
    const parentDir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    const reveal: MenuItem[] = [
      { label: "Copy path", onSelect: () => copyText(abs), separator: true },
      { label: "Reveal in file explorer", onSelect: () => onReveal(abs) },
    ];

    if (node.kind === "directory") {
      return [...newItems(root, node.path, startDraft), ...pathItems(node, abs), ...reveal];
    }

    if (node.stateId === undefined) {
      // A prompt, a skill, or config: real files, but not states. No state-id verbs — but the same
      // rename and delete, addressed by path, because "the tree cannot rename a prompt" is not a
      // distinction anyone holds in their head while looking at one.
      return [...newItems(root, parentDir, startDraft), ...pathItems(node, abs), ...reveal];
    }

    const id = node.stateId;
    const other: WorkflowLayer = node.layer === "base" ? "project" : "base";
    return [
      { label: "Open", onSelect: () => onOpen(id, node.layer) },
      {
        // The folder as well as the state: `feature/` is where `feature.json`'s children live, and
        // the first child is what creates it. Typed under the parent's own row — see
        // {@link childStateDraft} — so the id you are extending is the line directly above.
        label: "New child state…",
        note: `${id}/`,
        onSelect: () => startDraft(childStateDraft(root, node, id)),
      },
      {
        label: "Duplicate…",
        separator: true,
        onSelect: () =>
          setAsk({
            title: `Duplicate '${id}'`,
            field: "New state id",
            initial: `${id}-copy`,
            confirmLabel: "Duplicate",
            onConfirm: (v) => {
              setAsk(null);
              void move({ stateId: id, layer: node.layer, to: v, toLayer: node.layer, copy: true }, "Duplicate");
            },
          }),
      },
      {
        label: "Rename…",
        onSelect: () =>
          setAsk({
            title: `Rename '${id}'`,
            field: "New state id",
            initial: id,
            note: "A state's id is its path, and every state that names it as a child names this id.",
            confirmLabel: "Rename",
            onConfirm: (v) => {
              setAsk(null);
              void move({ stateId: id, layer: node.layer, to: v, toLayer: node.layer }, "Rename");
            },
          }),
      },
      {
        // The point of the shared layer: changing a shared workflow for ONE project should not mean
        // copying files by hand. Shadowed already means the project has its own copy.
        label: node.layer === "base" ? "Override in this project" : "Copy to shared root",
        separator: true,
        disabled: node.shadowed === true || (node.layer === "base" && !hasProject),
        onSelect: () => void move({ stateId: id, layer: node.layer, to: id, toLayer: other, copy: true }, "Copy"),
      },
      { label: "Copy state id", separator: true, onSelect: () => copyText(id) },
      { label: "Copy path", onSelect: () => copyText(abs) },
      { label: "Reveal in file explorer", onSelect: () => onReveal(abs) },
      {
        label: "Delete",
        danger: true,
        separator: true,
        onSelect: () =>
          setAsk({
            title: `Delete '${id}'?`,
            note: `${abs}`,
            confirmLabel: "Delete",
            danger: true,
            onConfirm: () => {
              setAsk(null);
              void remove(id, node.layer);
            },
          }),
      },
    ];
  };

  /** A root's own menu: the three ways to make something (not in what ships), and the two ways of looking. */
  const rootItems = (root: FileRoot, writable: boolean): MenuItem[] => [
    // Nothing is made in what ships, so its root offers the two ways of looking only.
    ...(writable ? newItems(root, "", startDraft) : []),
    { label: "Copy path", separator: writable, onSelect: () => copyText(root.dir) },
    {
      label: "Reveal in file explorer",
      disabled: !root.exists,
      onSelect: () => onReveal(root.dir),
    },
  ];
  return { itemsFor, rootItems };
}
