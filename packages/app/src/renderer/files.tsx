/**
 * The Files view (DESIGN §11.1): design the states.
 *
 * Three columns, and the middle one shows exactly what the tree has selected. Every file opens the
 * same way — a viewer on top, an editor below — and WHICH viewer and editor is looked up per file
 * type in the surface registry (`fileTypes.ts`). A state gets its board over the authoring form; a
 * prompt gets its markdown rendered over a text editor; a file whose type registers no viewer gets
 * the editor alone, filling the panel.
 *
 * That indirection is the point. This module used to be able to open exactly one kind of file, and
 * everything else in the tree was a row that did nothing when clicked. It now knows how to lay out
 * two halves and nothing at all about what goes in them.
 *
 * The tree shows BOTH layer roots, which is what removes the layer picker: which copy of a file you
 * are about to edit is its position on screen rather than a mode you have to remember being in.
 */
import { Fragment, useMemo, useState, type CSSProperties, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type {
  BoardCard,
  FileMutationResult,
  FileNode,
  FileRoot,
  FileSource,
  FileTree,
  InstanceNode,
  MoveWorkflowRequest,
  SessionRef,
  StateView,
  TaskDetail,
  WorkflowLayer,
  WorkflowMutationResult,
} from "@jaira/shared/browser";
import { isTextMime } from "@jaira/shared/browser";
import { Badge } from "./board";
import { CrumbBar, alternatives, runCrumbs, shortRunName, type Crumb } from "./crumbs";
import { TaskPanel } from "./detail";
import { resolveFileSurface, type FileSurfaceContext } from "./fileTypes";
import { AskDialog, ContextMenu, type AskSpec, type MenuAnchor, type MenuItem } from "./menu";
import { RunPanel, type RunSurface } from "./runPanel";
import { RunModeToggle } from "./runViews";
import { signatureOf } from "./transcript";
import { durationOf } from "./transcriptView";
import { Splitter } from "./splitter";
import { nodeAt, stepOf, type TrailStep } from "./trail";
import { HALVES, PANE, paneDefault, type HalfMode } from "./uiState";

/**
 * The three positions of the lower half, as the bar says them.
 *
 * A glyph that shows how much of the column this half HAS, rather than an arrow pointing at what a
 * click would do: the arrow was ambiguous the moment there were three positions, and the size of a
 * thing is what a size control should show.
 */
const HALF_GLYPHS: Record<HalfMode, string> = { shut: "▁", half: "▄", full: "█" };
const HALF_WORDS: Record<HalfMode, string> = {
  shut: "folded away",
  half: "half the column",
  full: "the whole column",
};

/**
 * How tall the viewer opens, and what a double-click on the divider restores.
 *
 * Roughly the 46% the stylesheet used to give it on a full-height window. Read from the layout
 * table rather than written here, because the shell holds the live value with the rest of the pane
 * sizes — and a default living in two files is a default that stops agreeing with itself.
 */
const VIEWER_HEIGHT = paneDefault(PANE.filesViewer);

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

/** What the tree asks the store to do; `force` is added by the follow-up confirmation. */
type MoveRequest = MoveWorkflowRequest;

const LAYER_LABEL: Record<WorkflowLayer, string> = {
  project: "this project",
  base: "shared",
};

/** What each file kind looks like in the tree. Glyphs, not colour, so the meaning survives a theme. */
const KIND_GLYPH: Record<string, string> = {
  directory: "▾",
  workflow: "◻",
  prompt: "◈",
  skill: "✦",
  config: "⚙",
  other: "·",
};

// --- the tree ----------------------------------------------------------------

/**
 * The tooltip for a row's lint state, or `undefined` when there is nothing to say.
 *
 * The `unchecked` wording is the one worth getting right. Zero errors on a state no root reaches
 * does not mean it is clean, it means nobody looked — and a file that reads as clean is exactly the
 * file someone starts a task against.
 */
function lintTitle(node: FileNode, isDir: boolean): string | undefined {
  const lint = node.lint;
  if (lint === undefined) return undefined;
  if (lint.unchecked === true) return "not validated — no workflow root reaches this state";
  const parts: string[] = [];
  if (lint.errors > 0) parts.push(`${lint.errors} error${lint.errors === 1 ? "" : "s"}`);
  if (lint.warnings > 0) parts.push(`${lint.warnings} warning${lint.warnings === 1 ? "" : "s"}`);
  if (parts.length === 0) return undefined;
  return `${parts.join(", ")}${isDir ? " below here" : ""}`;
}

function TreeNode({
  node,
  depth,
  rootDir,
  selected,
  dirty,
  collapsed,
  onToggle,
  onSelect,
  onMenu,
}: {
  node: FileNode;
  depth: number;
  rootDir: string;
  selected: FileSelection | null;
  /** Files with unsaved edits, by `layer:path`. A directory is marked when anything under it is. */
  dirty: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSelect: (node: FileNode) => void;
  onMenu: (node: FileNode, rootDir: string, x: number, y: number) => void;
}): JSX.Element {
  // The FOLD key stays per layer, deliberately: `SHUT.folders` is keyed per layer and not per
  // checkout so it does not grow without bound as projects come and go, and two projects that both
  // have a `workflows/review/` sharing its folded state is the trade that buys that.
  const key = `${node.layer}:${node.path}`;
  const isDir = node.kind === "directory";
  const open = isDir && !collapsed.has(key);
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
  return (
    <>
      <li
        className={`tree-item${isSelected ? " sel" : ""}${node.shadowed ? " shadowed" : ""}${tone}${isTextMime(node.mime) || isDir ? "" : " inert"}`}
        onClick={() => (isDir ? onToggle(key) : onSelect(node))}
        onContextMenu={(e) => {
          e.preventDefault();
          // And it stops here. The root's own menu now hangs off the LIST (the row that used to
          // carry it is gone — see `FileTreePanel`), so an unstopped right-click on a file would
          // open this menu and then be overwritten by the root's on the way up.
          e.stopPropagation();
          // Right-click selects too, so the menu always acts on the row that is highlighted — a menu
          // operating on something other than what looks selected is how the wrong file gets deleted.
          if (selectable) onSelect(node);
          onMenu(node, rootDir, e.clientX, e.clientY);
        }}
        title={node.error ?? lintTitle(node, isDir) ?? node.path}
      >
        {/*
          One rule per level of nesting, drawn rather than padded for.
          The indent used to be `paddingLeft`, which says how far in a row is and nothing about what
          it is in. The sidebar answers that with a rule down the left of everything inside a project
          and everything inside a view — and then the tree, which is where nesting actually gets deep,
          dropped the convention at its own first branch. These are the same line, continued: one per
          ancestor, so a row four levels down is joined to all four.
        */}
        {Array.from({ length: depth }, (_, i) => (
          <i key={i} className="tree-guide" />
        ))}
        <span className="glyph">{isDir ? (open ? "▾" : "▸") : (KIND_GLYPH[node.kind] ?? "·")}</span>
        <span className="name">{node.name}</span>
        {unsaved ? (
          <span className="dirty-dot" title={isDir ? "unsaved edits below here" : "unsaved edits"}>
            ●
          </span>
        ) : null}
        {/* A dot as well as the colour. Colour alone is a poor signal — it is the first thing lost to
            a colourblind eye, a dim monitor, or a row that is also selected — and this is the marker
            that says a workflow cannot run. */}
        {tone === " has-error" || tone === " has-warning" ? <span className="lint-dot">●</span> : null}
        {node.error !== undefined ? <span className="chip chip-bad">!</span> : null}
        {node.error === undefined && lint !== undefined && lint.errors > 0 ? (
          <span className="chip chip-bad">{lint.errors}</span>
        ) : null}
        {node.error === undefined && lint !== undefined && lint.errors === 0 && lint.warnings > 0 ? (
          <span className="chip chip-warn">{lint.warnings}</span>
        ) : null}
        {node.shadowed ? <span className="chip">shadowed</span> : null}
      </li>
      {open
        ? (node.children ?? []).map((child) => (
            <TreeNode
              key={`${child.layer}:${child.path}`}
              node={child}
              depth={depth + 1}
              rootDir={rootDir}
              selected={selected}
              dirty={dirty}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
              onMenu={onMenu}
            />
          ))
        : null}
    </>
  );
}

/**
 * The state id a new file inside a directory would get.
 *
 * `null` for anything outside `workflows/`, because a prompt is not a state and offering to create
 * one there would produce a file the loader never looks at.
 */
function statePrefixOf(node: FileNode): string | null {
  if (node.path === "workflows") return "";
  if (node.path.startsWith("workflows/")) return `${node.path.slice("workflows/".length)}/`;
  return null;
}

const copyText = (text: string): void => void navigator.clipboard?.writeText(text);

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

/** The default for {@link FileTreePanel}'s `dirty`. A module constant, so its identity is stable. */
const EMPTY_DIRTY: ReadonlySet<string> = new Set();

export function FileTreePanel({
  tree,
  selected,
  dirty = EMPTY_DIRTY,
  collapsed: collapsedProp,
  onToggleCollapsed,
  busy,
  hasProject,
  onSelect,
  onOpen,
  onCreate,
  onCreateFile,
  onMove,
  onDelete,
  onRenameFile,
  onDeleteFile,
  onReveal,
  find = false,
  creating = false,
  project = null,
}: {
  tree: FileTree | null;
  selected: FileSelection | null;
  /** Files with unsaved edits, by `layer:path`. Defaulted, so a host with no draft store shows none. */
  dirty?: ReadonlySet<string>;
  /**
   * The folded branches, by the same `layer:path` key, and how to fold or unfold one.
   *
   * Controlled when both are supplied — the shell keeps them in `user-settings.json`, so the shape you
   * left the tree in is the shape it opens in — and local otherwise, which keeps this panel usable
   * on its own. Same arrangement as the JSON editor's wrap preference, for the same reason: a
   * component that REQUIRED a store would be a component you could not render without one.
   *
   * Negative — what is listed is SHUT — because a tree defaults to expanded, and a new folder must
   * never appear collapsed on the strength of a file written before it existed.
   */
  collapsed?: ReadonlySet<string> | undefined;
  onToggleCollapsed?: ((key: string) => void) | undefined;
  busy: boolean;
  /** Project-layer operations are impossible without one, so they are offered disabled, not hidden. */
  hasProject: boolean;
  /** Open any file in the panel — a state, a prompt, `settings.json`, anything the registry can render. */
  onSelect: (node: FileNode) => void;
  /** Open an existing state's file. */
  onOpen: (stateId: string, layer: WorkflowLayer) => void;
  /** Create a state — writes the file straight away, then selects it. */
  onCreate: (stateId: string, layer: WorkflowLayer) => void;
  /** Create a plain file or a directory, addressed by path under a layer root. */
  onCreateFile: (layer: WorkflowLayer, path: string, kind: "file" | "directory", text?: string) => void;
  onMove: (request: MoveRequest) => Promise<WorkflowMutationResult | null>;
  onDelete: (stateId: string, layer: WorkflowLayer, force?: boolean) => Promise<WorkflowMutationResult | null>;
  /** Rename anything in the tree that is not a state — a prompt, a skill, a directory. */
  onRenameFile: (
    layer: WorkflowLayer,
    path: string,
    to: string,
    force?: boolean,
  ) => Promise<FileMutationResult | null>;
  /** Delete the same. A directory takes everything in it. */
  onDeleteFile: (layer: WorkflowLayer, path: string, force?: boolean) => Promise<FileMutationResult | null>;
  onReveal: (file: string) => void;
  /**
   * Whether the FIND field is showing, and whether the "new state" form is.
   *
   * Both were permanent: a filter box over the tree and a three-control form under it, on screen in
   * a 250px column whether or not anybody was filtering or creating. They are the Files row's own
   * verbs now (`SidebarAct`), and these say which of them is currently on. Defaulted off, so a host
   * that draws this panel without a row to press still gets a tree.
   */
  find?: boolean;
  creating?: boolean;
  /**
   * The project this tree is being browsed FROM — the row the drawer hangs under.
   *
   * What it decides is which root goes unnamed. The tree's top level is every open project with
   * `~/.jaira` beside them (SHELL.md §2.2), and each of those used to be introduced by a row
   * carrying its own name — which, in a drawer nested under a row that is already that project's
   * name, printed it twice. The one you are standing in is the one that needs no introduction.
   */
  project?: string | null;
}): JSX.Element {
  /** Used only when the host does not control the folding — see the prop's own note. */
  const [ownCollapsed, setOwnCollapsed] = useState<ReadonlySet<string>>(new Set());
  const collapsed = collapsedProp ?? ownCollapsed;
  const [filter, setFilter] = useState("");
  const [newId, setNewId] = useState("");
  const [newLayer, setNewLayer] = useState<WorkflowLayer>("project");
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);

  /**
   * Run a move, and if it was refused because other states point at this one, say who and offer to
   * go ahead. The second ask is the whole value of the refusal — a rename that silently broke three
   * workflows would be discovered later, by a run that failed to load.
   */
  const move = async (request: MoveRequest, verb: string): Promise<void> => {
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
   * "New file…" and "New folder…", relative to a directory.
   *
   * Offered on files too, where "here" means the directory the file sits in — right-clicking the
   * thing next to where you want the new one is how people actually reach for this.
   */
  const creationItems = (layer: WorkflowLayer, dirPath: string): MenuItem[] => {
    const under = dirPath.length > 0 ? `${dirPath}/` : "";
    return [
      {
        label: "New file…",
        onSelect: () =>
          setAsk({
            title: "New file",
            field: "Path",
            initial: under,
            note: `Relative to ${layer === "base" ? "~/.jaira/" : ".jaira/"}`,
            confirmLabel: "Create",
            onConfirm: (v) => {
              setAsk(null);
              onCreateFile(layer, v, "file", "");
            },
          }),
      },
      {
        label: "New folder…",
        onSelect: () =>
          setAsk({
            title: "New folder",
            field: "Path",
            initial: under,
            note: `Relative to ${layer === "base" ? "~/.jaira/" : ".jaira/"}`,
            confirmLabel: "Create",
            onConfirm: (v) => {
              setAsk(null);
              onCreateFile(layer, v, "directory");
            },
          }),
      },
    ];
  };

  /** The verbs a node offers, by what the node actually is. */
  const itemsFor = (node: FileNode, rootDir: string): MenuItem[] => {
    const abs = `${rootDir}/${node.path}`;
    const parentDir = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    const reveal: MenuItem[] = [
      { label: "Copy path", onSelect: () => copyText(abs), separator: true },
      { label: "Reveal in file explorer", onSelect: () => onReveal(abs) },
    ];

    if (node.kind === "directory") {
      const prefix = statePrefixOf(node);
      return [
        ...(prefix === null
          ? []
          : [
              {
                label: "New state here…",
                onSelect: () =>
                  setAsk({
                    title: "New state",
                    field: "State id",
                    initial: prefix,
                    confirmLabel: "Create",
                    onConfirm: (v) => {
                      setAsk(null);
                      onCreate(v, node.layer);
                    },
                  }),
              },
            ]),
        ...creationItems(node.layer, node.path).map((item, i) => (i === 0 && prefix !== null ? { ...item, separator: true } : item)),
        ...pathItems(node, abs),
        ...reveal,
      ];
    }

    if (node.stateId === undefined) {
      // A prompt, a skill, or config: real files, but not states. No state-id verbs — but the same
      // rename and delete, addressed by path, because "the tree cannot rename a prompt" is not a
      // distinction anyone holds in their head while looking at one.
      return [...creationItems(node.layer, parentDir), ...pathItems(node, abs), ...reveal];
    }

    const id = node.stateId;
    const other: WorkflowLayer = node.layer === "base" ? "project" : "base";
    return [
      { label: "Open", onSelect: () => onOpen(id, node.layer) },
      {
        label: "New child state…",
        onSelect: () =>
          setAsk({
            title: "New child state",
            field: "State id",
            initial: `${id}/`,
            confirmLabel: "Create",
            onConfirm: (v) => {
              setAsk(null);
              onCreate(v, node.layer);
            },
          }),
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

  const openMenu = (node: FileNode, rootDir: string, x: number, y: number): void =>
    setMenu({ x, y, items: itemsFor(node, rootDir) });

  const toggle = (key: string): void => {
    if (onToggleCollapsed !== undefined) return onToggleCollapsed(key);
    setOwnCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Filtering flattens: a match three directories down is useless if its parents are still folded,
  // and re-deriving which ancestors to force open costs more than just listing the hits.
  const matches = (nodes: FileNode[], out: FileNode[] = []): FileNode[] => {
    for (const node of nodes) {
      if (node.kind !== "directory" && node.path.toLowerCase().includes(filter.toLowerCase())) out.push(node);
      if (node.children) matches(node.children, out);
    }
    return out;
  };

  /*
   * A plain block, not a column.
   *
   * It used to be an `<aside className="col side">` — its own column of the window, with its own
   * heading saying "Files" over its own scrollbar. It is now one section of the sidebar's accordion,
   * which supplies both: the heading is the accordion's, and the height is whatever the column has
   * left. Everything below here is unchanged, because none of it ever depended on being a column.
   */
  return (
    <div className="file-browser">
      {find ? (
        <input
          className="tree-find"
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => (e.key === "Escape" ? setFilter("") : undefined)}
          placeholder="Filter…"
        />
      ) : null}

      <div className="scroll">
        {tree === null ? (
          <p className="empty">Open a project to browse its files.</p>
        ) : (
          tree.roots.map((root) => {
            const named = rootNeedsName(root, project);
            const rootMenu = (e: ReactMouseEvent): void => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    label: "New state…",
                    onSelect: () =>
                      setAsk({
                        title: `New state in the ${LAYER_LABEL[root.layer]} root`,
                        field: "State id",
                        confirmLabel: "Create",
                        onConfirm: (v) => {
                          setAsk(null);
                          onCreate(v, root.layer);
                        },
                      }),
                  },
                  ...creationItems(root.layer, ""),
                  { label: "Copy path", separator: true, onSelect: () => copyText(root.dir) },
                  {
                    label: "Reveal in file explorer",
                    disabled: !root.exists,
                    onSelect: () => onReveal(root.dir),
                  },
                ],
              });
            };
            return (
            /* Keyed by the ROOT's directory, not by its layer: the tree's top level is the projects
               now (SHELL.md §2.2), so several roots share the layer `project` and only the directory
               tells them apart.

               The root's own menu hangs off the LIST, not off a row, so it survives the row being
               dropped: right-clicking the empty space under a headerless tree still offers "new
               file here". Every node stops the event, so a right-click on a file gets the file's. */
            <ul className="file-tree" key={root.dir} title={named ? undefined : root.dir} onContextMenu={rootMenu}>
              {named ? (
              <li className="tree-root" title={root.dir} onContextMenu={rootMenu}>
                {/* The project's own name, in the data voice — a directory basename, and the same
                    string the crumb prints. `~/.jaira` is listed once beside the projects rather
                    than under each, so it names itself the same way. */}
                <span className="data-secondary">{root.label}</span>
              </li>
              ) : null}
              {(filter.length > 0 ? matches(root.nodes) : root.nodes).map((node) => (
                <TreeNode
                  key={`${node.project ?? node.layer}:${node.path}`}
                  node={node}
                  depth={0}
                  rootDir={root.dir}
                  selected={selected}
                  dirty={dirty}
                  collapsed={collapsed}
                  onToggle={toggle}
                  onSelect={onSelect}
                  onMenu={openMenu}
                />
              ))}
              {root.nodes.length === 0 ? (
                // An absent shared root is the normal starting state, not a fault. Saying so — and
                // saying what fixes it — is the difference between an empty branch that looks
                // broken and one that looks like an invitation.
                <li className="empty root-empty">
                  {root.exists ? "empty" : "not created yet — adding a state here will create it"}
                </li>
              ) : null}
            </ul>
            );
          })
        )}
      </div>

      {/* The one place a layer is still chosen, and the only question it can be: where does a NEW
          thing land? Everything that already exists answers it by where it sits above. Shown when
          the row's `+` asks for it — three controls to create something are worth their height while
          you are creating something and not before. */}
      {creating ? (
      <form
        className="new-state"
        onSubmit={(e) => {
          e.preventDefault();
          if (newId.trim()) onCreate(newId.trim(), newLayer);
          setNewId("");
        }}
      >
        <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="new state id" />
        <select value={newLayer} onChange={(e) => setNewLayer(e.target.value as WorkflowLayer)}>
          <option value="project">in this project</option>
          <option value="base">in the shared root</option>
        </select>
        <button type="submit" className="primary" disabled={busy || !newId.trim()}>
          Create
        </button>
      </form>
      ) : null}

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {ask ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
    </div>
  );
}

// --- the middle panel --------------------------------------------------------

/**
 * Every state id in either root — which crumbs above are worth making clickable.
 *
 * A state id is a PATH, so `plan/draft/critique` names two ancestors. Both usually exist as files
 * and opening one is the move the bar is for; neither is guaranteed to, because an id is a naming
 * convention rather than a containment rule and `plan/draft` can exist with no `plan`. A crumb that
 * opens nothing is worse than a crumb that is plainly not a link, so this is what decides.
 */
function stateIdsOf(tree: FileTree | null): ReadonlySet<string> {
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
function entriesUnder(tree: FileTree | null, layer: WorkflowLayer, dir: string): FileNode[] {
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
    label: entry.layer === "project" ? ".jaira" : "~/.jaira",
    note: entry.layer === "project" ? "this project" : "shared",
    checked: entry.layer === layer,
    onSelect: () => input.onOpenDir(entry.layer, ""),
  }));
  if (input.onOpenProject !== undefined) {
    roots.push({ label: "Open another project…", separator: roots.length > 0, onSelect: input.onOpenProject });
  }
  out.push({
    text: layer === "project" ? ".jaira" : "~/.jaira",
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
      onWalkBack: input.onWalkBack,
      onWalkTo: input.onWalkTo,
      onSelectTask: input.onSelectTask,
    }),
  );
  return out;
}

/**
 * The top row of the window: an address bar for what is open. {@link FileAddressBar} places it.
 *
 * It used to be a title and a subtitle — the state id on one line, its layer and child count on the
 * next — which said where you were and offered no way anywhere. The path is the same information
 * arranged so that every level above the one you are on is one click, which is what a file explorer
 * does with exactly this data.
 *
 * Clicking the bar itself still puts the inspector back on the file: that is the way out of having
 * drilled into a task, and it is why the crumbs stop the click from propagating.
 */
function DocBar({
  input,
  state,
  onInspect,
  children,
}: {
  /** Everything the path is built from — see {@link crumbsOf}. */
  input: CrumbInput;
  state: StateView | null;
  onInspect: () => void;
  /** The right-hand end of the bar — what mode the panel below is in, when it has one. */
  children?: React.ReactNode;
}): JSX.Element {
  const errors = state === null ? 0 : state.issues.filter((i) => i.severity === "error").length;
  const warnings = state === null ? 0 : state.issues.length - errors;
  return (
    <CrumbBar
      crumbs={crumbsOf(input)}
      title={LAYER_LABEL[input.layer]}
      onClick={onInspect}
      trailing={
        <>
          {/*
            The state's human name, at the RIGHT-HAND end with the rest of what is true about the
            open file. It sat directly after the crumbs, where — with no `›` in front of it — it read
            as one more segment of the path, which is the one thing it must not look like: it names
            the file, not a level you can go to. The task a run belongs to is not here at all; that
            is the context panel's subject, and one identity in two places is how the two come to
            disagree.
          */}
          {state?.label ? (
            <span className="sub ellip doc-label" title={state.label}>
              {state.label}
            </span>
          ) : null}
          {errors > 0 ? <span className="chip chip-bad">{errors} error</span> : null}
          {warnings > 0 ? <span className="chip chip-warn">{warnings} warning</span> : null}
        </>
      }
      {...(children !== undefined ? { tools: children } : {})}
    />
  );
}

/**
 * A directory, as a file explorer shows one.
 *
 * The other thing the middle panel can be showing, and the reason the address bar's folder crumbs
 * lead anywhere. Deliberately NOT a second tree: the tree beside it already answers "where is
 * everything", and what this answers is "what is in the place I have navigated to" — one level, in
 * the order a file manager has used for thirty years, with the folders first because they are how
 * you keep going.
 *
 * `..` is a real row rather than a reliance on the bar. Going up is the most common move in a
 * listing, and making it the one move that has to be made somewhere else is how a listing becomes a
 * dead end.
 */
function DirectoryPanel({
  layer,
  path,
  tree,
  onOpenDir,
  onOpenFile,
  onOpenState,
}: {
  layer: WorkflowLayer;
  path: string;
  tree: FileTree | null;
  onOpenDir: (layer: WorkflowLayer, path: string) => void;
  onOpenFile: (layer: WorkflowLayer, path: string) => void;
  onOpenState: (stateId: string) => void;
}): JSX.Element {
  const entries = entriesUnder(tree, layer, path);
  const parent = path === "" ? null : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (
    <div className="folder">
      <div className="folder-list">
        {parent !== null ? (
          <button type="button" className="folder-row up" onClick={() => onOpenDir(layer, parent)}>
            <span className="glyph">↰</span>
            <span className="grow">..</span>
          </button>
        ) : null}
        {entries.map((node) => (
          <button
            type="button"
            key={node.path}
            className={`folder-row${node.kind === "directory" ? " dir" : ""}`}
            title={node.error ?? node.path}
            onClick={() =>
              node.kind === "directory"
                ? onOpenDir(node.layer, node.path)
                : node.stateId !== undefined
                  ? onOpenState(node.stateId)
                  : onOpenFile(node.layer, node.path)
            }
          >
            <span className="glyph">{node.kind === "directory" ? "▸" : (KIND_GLYPH[node.kind] ?? "·")}</span>
            {/* States read as their ids, like everywhere else the bar speaks: the extension is a fact
                about storage and this is a view of the workflow. */}
            <span className="grow ellip">{node.stateId !== undefined ? (node.stateId.split("/").pop() ?? node.name) : node.name}</span>
            {node.error !== undefined ? <span className="chip chip-bad">!</span> : null}
            {node.error === undefined && (node.lint?.errors ?? 0) > 0 ? (
              <span className="chip chip-bad">{node.lint!.errors}</span>
            ) : null}
            {node.error === undefined && (node.lint?.errors ?? 0) === 0 && (node.lint?.warnings ?? 0) > 0 ? (
              <span className="chip chip-warn">{node.lint!.warnings}</span>
            ) : null}
            {node.shadowed ? <span className="chip">shadowed</span> : null}
          </button>
        ))}
        {entries.length === 0 ? <p className="empty">This folder is empty.</p> : null}
      </div>
    </div>
  );
}

/**
 * The address of whatever is open, as the top row of the window.
 *
 * It used to be the first child of the middle column, which put it a title bar and a strip of view
 * chrome down the page — a path bar with two things above it, neither of them a path. It is now the
 * top of the shell itself: the sidebar runs down the left, and the first thing across the rest of
 * the window is where you are. The window has no other title, which is the point — "no project ·
 * Files" was a caption restating what the path says properly.
 *
 * Lifted OUT of {@link FilePanel} rather than positioned differently inside it: the bar spans the
 * viewer, the editor and the inspector beside them, and a component that owns one column cannot draw
 * across three. What is left in the panel is the two halves the bar is about.
 *
 * `null` when nothing is open — an address bar for no address is a row of nothing.
 */
export function FileAddressBar({
  doc,
  dir,
  context,
  onWalkBack,
  onInspect,
}: {
  doc: FileSource | null;
  /** The directory open instead, when one is — exactly one of the two is ever set. */
  dir?: FileSelection | null;
  context: FileSurfaceContext;
  /** Walk the address bar back to a crumb; `-1` is the file with no run open. */
  onWalkBack?: ((index: number) => void) | undefined;
  onInspect: () => void;
}): JSX.Element | null {
  // Before the early return: a hook cannot be conditional, and "no file open" is a condition.
  const known = useMemo(() => stateIdsOf(context.tree), [context.tree]);

  /**
   * Everything the address bar needs, for whichever of the two things is open.
   *
   * One assembly rather than two, because the bar does not care: a folder and a document are both
   * addresses under a layer root, and the only difference is which of them has a state id and what
   * is rendered underneath.
   */
  const barFor = (at: { layer: WorkflowLayer; path: string; stateId?: string | undefined; isDir?: boolean }): CrumbInput => ({
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
    ...(context.detail !== null ? { taskTitle: context.detail.title } : {}),
    onOpenState: context.onDrill,
    onOpenFile: context.onOpenFile ?? ((): void => {}),
    onOpenDir: context.onOpenDir ?? ((): void => {}),
    ...(context.onOpenProject !== undefined ? { onOpenProject: context.onOpenProject } : {}),
    onWalkBack: onWalkBack ?? ((): void => {}),
    onWalkTo: context.onWalkTo ?? ((): void => {}),
    onSelectTask: context.onSelectTask,
  });

  // A folder is an address like any other, so it gets the same bar.
  if (doc === null) {
    return dir == null ? null : <DocBar input={barFor({ ...dir, isDir: true })} state={null} onInspect={onInspect} />;
  }

  const trail = context.trail ?? [];
  // Only where there are two readings — a leaf state's viewer is its conversation, and so is a run
  // that entered no children. Asked of the trail's TAIL, because that is what the panel is showing.
  const tail = trail.at(-1);
  const toggleable =
    doc.stateId !== undefined &&
    context.state?.board != null &&
    (tail === undefined || tail.stateId === doc.stateId || (context.trailState?.board ?? null) !== null);

  return (
    <DocBar input={barFor(doc)} state={context.state} onInspect={onInspect}>
      {/* Only where there are two readings to switch between. A run with no children says what it
          said and nothing else, so a toggle on it would be one live option and one dead one. */}
      {toggleable && context.onRunMode !== undefined ? (
        <RunModeToggle mode={context.runMode ?? "board"} onMode={context.onRunMode} />
      ) : undefined}
    </DocBar>
  );
}

/**
 * The open file: what it IS above, what it SAYS below.
 *
 * Both at once by default — putting the two behind a mode toggle meant every glance at a state's
 * configuration cost you sight of its runs, which is the same mistake the old settings drawer made
 * at the window level, repeated one panel down.
 *
 * The lower half FOLDS, which is not that mistake returning. A mode is a place you are in and have
 * to remember leaving; this is a strip along the bottom that says what is behind it, takes one click,
 * and defaults open. What it buys is the case the split cannot serve: watching a board while the
 * form you finished with an hour ago holds the bottom third of the column.
 *
 * Neither half is chosen here. `resolveFileSurface` answers "what renders a `text/markdown` for
 * reading" and "what renders it for editing", and this component only decides the geometry: with a
 * viewer, the panel splits; without one, the editor takes the whole column. That second case is not
 * a degraded layout — a plain text file has no rendering distinct from its contents, and half a
 * panel of nothing above it would be worse than the space.
 */
export function FilePanel({
  doc,
  dir,
  busy,
  context,
  viewerHeight,
  onViewerHeight,
  half = "half",
  onHalf,
  onSave,
}: {
  doc: FileSource | null;
  /** The directory open instead, when one is — exactly one of the two is ever set. */
  dir?: FileSelection | null;
  busy: boolean;
  context: FileSurfaceContext;
  /**
   * How tall the viewer is, in px — the half above the divider.
   *
   * Held by the shell with the other pane sizes rather than here, for the reason they all are: it
   * has to survive this panel unmounting as you click between files, and a split that reset every
   * time you opened another prompt would be a split nobody bothered to drag.
   */
  viewerHeight: number;
  onViewerHeight: (height: number) => void;
  /**
   * How much of the column the lower half is taking: all of it, the split, or none.
   *
   * A state's configuration is what you edit for a minute and then want out of the way for ten —
   * watching a run on a board squeezed into the top third of the column is why `shut` exists — and
   * it is also the thing you spend an hour in, which is why `full` does. The middle is the default
   * and the two ends are one click away in the same place. Held by the shell with the pane sizes,
   * for the same reason they are: it must survive clicking another file.
   */
  half?: HalfMode;
  onHalf?: ((half: HalfMode) => void) | undefined;
  onSave: (text: string) => void;
}): JSX.Element {
  if (doc === null) {
    // A listing where a document would have had its viewer and editor. The address above it is the
    // shell's now — see {@link FileAddressBar}.
    if (dir != null) {
      return (
        <div className="col mid">
          <DirectoryPanel
            layer={dir.layer}
            path={dir.path}
            tree={context.tree}
            onOpenDir={context.onOpenDir ?? ((): void => {})}
            onOpenFile={context.onOpenFile ?? ((): void => {})}
            onOpenState={context.onDrill}
          />
        </div>
      );
    }
    return (
      <div className="col mid">
        <p className="empty">Select a file in the tree.</p>
      </div>
    );
  }

  const View = resolveFileSurface(doc.mime, "view");
  const Edit = resolveFileSurface(doc.mime, "edit");
  const props = { doc, busy, onSave, context };
  // With no viewer the editor IS the panel, so there is nothing to fold it away from and nothing to
  // grow into: a file type with no viewer is always at `full`, whatever was remembered.
  const at: HalfMode = View === null ? "full" : half;
  const shut = at === "shut";

  return (
    <div
      className={`col mid${shut ? " config-shut" : ""}`}
      style={{ "--viewer-height": `${viewerHeight}px` } as CSSProperties}
    >
      {View !== null && at !== "full" ? (
        <>
          <div className="run-half">
            <View {...props} />
          </div>
          {/* The halves were 46/54 and immovable, which is a guess about what you are doing: a board
              with nine columns and a form with three fields want opposite splits, and the same file
              wants opposite splits at different moments. `reserve` is measured against the column,
              so the divider cannot be dragged off the bottom of a short window.

              Gone entirely when the lower half is folded: a divider with nothing below it to resize
              is a handle that moves a number nobody can see. */}
          {shut ? null : (
            <Splitter
              orientation="horizontal"
              label="Resize the viewer"
              value={viewerHeight}
              reset={VIEWER_HEIGHT}
              min={80}
              max={1600}
              reserve={200}
              onChange={onViewerHeight}
            />
          )}
        </>
      ) : null}

      <div className={View === null || at === "full" ? "config-half whole" : `config-half${shut ? " shut" : ""}`}>
        {View ? (
          // The label became the control. Folded, this row IS the lower half — a bar across the
          // bottom of the column saying what is behind it and taking one click to bring back. It
          // cycles rather than toggles: three positions, one place, and the glyph is how much of the
          // column this half currently has.
          <button
            type="button"
            className="half-bar"
            onClick={() => onHalf?.(HALVES[(HALVES.indexOf(at) + 1) % HALVES.length]!)}
            disabled={onHalf === undefined}
            title={`${HALF_WORDS[at]} — click for ${HALF_WORDS[HALVES[(HALVES.indexOf(at) + 1) % HALVES.length]!]}`}
          >
            <span className="half-caret">{HALF_GLYPHS[at]}</span>
            <span className="half-label">{doc.stateId !== undefined ? "Configuration" : "Source"}</span>
            <span className="grow" />
            {/* Only when folded, and only when it matters: an editor you cannot see holding an
                unsaved change is the one thing this fold could cost you. */}
            {shut && context.drafts?.[`${doc.layer}:${doc.path}`] !== undefined ? (
              <span className="dirty-dot" title="unsaved edits">
                ●
              </span>
            ) : null}
          </button>
        ) : null}
        {shut ? null : Edit ? (
          <Edit {...props} />
        ) : (
          // Reached only by a type that is not text — an image, the database, an archive. Naming the
          // type is the useful part: "no editor" alone reads as a missing feature rather than as a
          // statement about the file.
          <p className="empty">Nothing here can edit {doc.mime}.</p>
        )}
      </div>
    </div>
  );
}

// --- the inspector -----------------------------------------------------------

/**
 * What the right-hand column says about the selected state.
 *
 * Everything here answers a question you can only ask while looking at a state file: how to run it,
 * what running it has produced before, does it validate, what will it run on, where does control go
 * next, who depends on it, and whether the tasks currently inside it would even see an edit.
 *
 * Run comes FIRST, above validation, and that ordering is deliberate. The Files view is where a
 * state is written, and the thing anyone does next after writing one is try it; a button under four
 * sections of reference material is a button reached by scrolling past everything you already know.
 * The validation that would have gone first is not lost — it is the reason the button is disabled,
 * said on the button itself.
 */
export function StateInspector({
  state,
  run,
  onRevealIssue,
}: {
  state: StateView | null;
  /**
   * Starting a run from here, and the runs already started.
   *
   * Absent ⇒ no host that can create a task, and the two sections are omitted rather than shown
   * inert. The same reason the sync panel is optional on a file surface: a control that cannot do
   * its one thing is worse than its absence.
   */
  run?: RunSurface | undefined;
  /**
   * Show the control an issue is about, in the editor beside this panel.
   *
   * Absent ⇒ the issues render as text, which is what they were. Optional rather than required
   * because this component is also rendered from places with no editor to reveal anything in, and a
   * dead link is worse than a paragraph.
   */
  onRevealIssue?: ((path: string) => void) | undefined;
}): JSX.Element {
  if (state === null) return <p className="empty">Select a state.</p>;
  return (
    <div className="inspector">
      <div className="insp-crumb">
        <span className="state-id">{state.stateId.split("/").pop()}</span>
        <span className="sub">· the state</span>
      </div>

      {run !== undefined ? <RunPanel state={state} run={run} /> : null}

      {state.fileOnly ? (
        // Everything below that depends on the project's reference graph is UNKNOWN here, not empty.
        // Saying so is the difference between "nothing depends on this" and "nothing was checked" —
        // and only one of those is safe to act on before renaming it.
        <div className="notice">
          Read from the file alone, with no project open. Lint results, dependants, drift and runs are
          not known — open a project to see them.
        </div>
      ) : null}

      <section>
        <h3>
          <span>Validation</span>
          {state.issues.length > 0 ? <span className="count">{state.issues.length}</span> : null}
        </h3>
        {state.issues.length === 0 ? (
          <div className="sub">{state.fileOnly ? "not checked" : "lints clean"}</div>
        ) : (
          state.issues.map((issue, i) => {
            // A diagnostic with no path is about the FILE — "not valid JSON" — so there is no
            // control to reveal and it stays plain text. Everything else is a position in the
            // document, and the position is the useful half: reading `children.critique.inputs.issue`
            // and then finding that row by eye is the work this button removes.
            const reveal = onRevealIssue !== undefined && issue.path.length > 0;
            const className = `notice ${issue.severity === "error" ? "bad" : "warn"}${reveal ? " clickable" : ""}`;
            const body = (
              <>
                <b>{issue.path === "" ? "this file" : issue.path}</b> — {issue.message}
              </>
            );
            return reveal ? (
              <button
                key={i}
                type="button"
                className={className}
                title="show the control this is about"
                onClick={() => onRevealIssue(issue.path)}
              >
                {body}
              </button>
            ) : (
              <div key={i} className={className}>
                {body}
              </div>
            );
          })
        )}
      </section>

      <section>
        <h3>Environment</h3>
        {state.environment.executor === undefined ? (
          <div className="sub">no executor named — inherited or not a function operation</div>
        ) : (
          <dl className="kv">
            <dt>executor</dt>
            <dd>
              <code>{state.environment.executor}</code>{" "}
              <span className={`chip ${state.environment.available ? "chip-ok" : "chip-bad"}`}>
                {state.environment.available ? "available" : "not available"}
              </span>
            </dd>
            {state.environment.from !== undefined ? (
              <>
                <dt>from</dt>
                <dd>
                  <code>{state.environment.from}</code>
                </dd>
              </>
            ) : null}
            {state.operation?.model !== undefined ? (
              <>
                <dt>model</dt>
                <dd>
                  <code>{state.operation.model}</code>
                </dd>
              </>
            ) : null}
          </dl>
        )}
      </section>

      {state.transitions.length > 0 ? (
        <section>
          {/* Here rather than beside the columns: transitions are not what orders the board, and a
              backward jump drawn among the columns would read as layout instead of control flow. */}
          <h3>
            <span>Transitions</span>
            <span className="count">{state.transitions.length}</span>
          </h3>
          <div className="transitions">
            {state.transitions.map((t, i) => (
              <div key={i} className="trans-row">
                <span className="when">{t.when}</span>
                <span className="arrow">→</span>
                <span className="to">
                  {t.to.split("/").pop()}
                  {t.loops ? " ↺" : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {state.children.length > 0 ? (
        <section>
          <h3>
            <span>Children</span>
            <span className="count">in run order</span>
          </h3>
          <ol className="children">
            {state.children.map((child) => (
              <li key={child.key}>
                <span className="ellip">{child.key}</span>
                {child.hasChildren ? <span className="chip">composite</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {state.references.length > 0 ? (
        <section>
          <h3>References</h3>
          <ul className="refs">
            {state.references.map((ref) => (
              <li key={ref.ref}>
                <Badge status={ref.resolved ? "completed" : "failed"} />
                <code className="grow ellip">{ref.ref}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.referencedBy.length > 0 ? (
        <section>
          <h3>Referenced by</h3>
          <ul className="refs">
            {state.referencedBy.map((id) => (
              <li key={id}>
                <span className="glyph">❏</span>
                <code className="grow ellip">{id}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {state.driftedTasks.length > 0 ? (
        <section>
          {/* Execution reads the pinned snapshot (DESIGN §5.3), so an edit here does not reach a
              running task. That is only actionable next to the edit. */}
          <h3>Snapshot drift</h3>
          <div className="notice warn">
            {state.driftedTasks.length} task(s) here are pinned to an older snapshot and will not see
            an edit until they are re-run.
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The right-hand column for whatever is open.
 *
 * A state gets {@link StateInspector} — validation, environment, transitions, who depends on it.
 * Everything else gets the short version, because for a prompt or a skill there is genuinely less to
 * say: where it is, what it is, and how big. Saying that little honestly is better than borrowing
 * the state inspector's headings and leaving them all empty.
 */
export function FolderInspector({
  layer,
  path,
  tree,
}: {
  layer: WorkflowLayer;
  path: string;
  tree: FileTree | null;
}): JSX.Element {
  const entries = entriesUnder(tree, layer, path);
  const dirs = entries.filter((node) => node.kind === "directory").length;
  const states = entries.filter((node) => node.stateId !== undefined).length;
  const root = tree?.roots.find((r) => r.layer === layer);
  return (
    <div className="inspector">
      <div className="insp-crumb">
        <span className="state-id ellip">{path === "" ? (layer === "project" ? ".jaira" : "~/.jaira") : (path.split("/").pop() ?? path)}</span>
        <span className="sub">· the folder</span>
      </div>
      <section>
        <dl className="kv">
          <dt>path</dt>
          <dd>
            <code className="ellip">{path === "" ? "/" : path}</code>
          </dd>
          <dt>layer</dt>
          <dd>{LAYER_LABEL[layer]}</dd>
          <dt>holds</dt>
          <dd>
            {dirs > 0 ? `${dirs} folder${dirs === 1 ? "" : "s"}` : "no folders"}
            {`, ${entries.length - dirs} file${entries.length - dirs === 1 ? "" : "s"}`}
            {states > 0 ? <span className="sub"> · {states} states</span> : null}
          </dd>
        </dl>
      </section>
      {root !== undefined ? (
        <section>
          <div className="sub file-path" title={root.dir}>
            {root.dir}
            {path === "" ? "" : `/${path}`}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function FileInspector({
  doc,
  state,
  run,
  onRevealIssue,
}: {
  doc: FileSource | null;
  state: StateView | null;
  /**
   * Passed through to {@link StateInspector}, and only reachable there.
   *
   * A prompt has no declared inputs and nothing to start, so the Run section does not appear for one
   * — which is the whole of "which files get a Run section": the ones that are states.
   */
  run?: RunSurface | undefined;
  /** Passed through to {@link StateInspector} — the only half of this panel with issues to reveal. */
  onRevealIssue?: ((path: string) => void) | undefined;
}): JSX.Element {
  if (doc === null) return <p className="empty">Select a file.</p>;
  if (state !== null && doc.stateId !== undefined) {
    return <StateInspector state={state} run={run} onRevealIssue={onRevealIssue} />;
  }
  return (
    <div className="inspector">
      <div className="insp-crumb">
        <span className="state-id">{doc.path.split("/").pop()}</span>
        <span className="sub">· the file</span>
      </div>
      <section>
        <dl className="kv">
          <dt>path</dt>
          <dd>
            <code className="ellip">{doc.path}</code>
          </dd>
          <dt>layer</dt>
          <dd>{LAYER_LABEL[doc.layer]}</dd>
          <dt>type</dt>
          <dd>
            <code>{doc.mime}</code>
          </dd>
          <dt>size</dt>
          <dd>{doc.exists ? `${doc.text.length} characters` : "not created yet"}</dd>
        </dl>
      </section>
      <section>
        <div className="sub file-path" title={doc.file}>
          {doc.file}
        </div>
      </section>
    </div>
  );
}

/** `12,345` — thousands separated, because these are read at a glance and compared. */
const count = (n: number): string => n.toLocaleString();

/** `2.4 s`, `1 m 12 s`. */
function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

/**
 * What the run consumed, summed across every call it made.
 *
 * Here because a cost with nothing beside it is a number you can only believe or disbelieve. Tokens
 * are what make it checkable: `$0.21` next to 40k cached input tokens is an agent session doing
 * ordinary work, and next to 300 tokens it is a bug — and those two used to look identical.
 *
 * `costSource` is shown whenever it is anything other than the provider's own figure, because that
 * is the difference between a charge and an estimate. JaiRA computes neither: it records what the
 * executor reported, and this says which kind of number that was.
 */
function TaskMetrics({ states }: { states: SessionRef[] }): JSX.Element | null {
  const sum = (pick: (m: NonNullable<SessionRef["metrics"]>) => number | undefined): number | undefined => {
    let total: number | undefined;
    for (const row of states) {
      const value = row.metrics === undefined ? undefined : pick(row.metrics);
      if (value !== undefined) total = (total ?? 0) + value;
    }
    return total;
  };
  const cost = states.reduce<number | undefined>(
    (acc, row) => (row.costUsd === undefined ? acc : (acc ?? 0) + row.costUsd),
    undefined,
  );
  const started = states.reduce<number | undefined>((acc, row) => (acc === undefined ? row.at : Math.min(acc, row.at)), undefined);
  const input = sum((m) => m.inputTokens);
  const output = sum((m) => m.outputTokens);
  const cached = sum((m) => m.cacheReadTokens);
  const written = sum((m) => m.cacheWriteTokens);
  const reasoning = sum((m) => m.reasoningTokens);
  const spent = sum((m) => m.durationMs);
  // Worst-of, because a total is only as trustworthy as its least trustworthy part.
  const sources = new Set(states.map((row) => row.metrics?.costSource).filter((s) => s !== undefined));
  const source = sources.has("unknown") ? "unknown" : sources.has("table") ? "table" : sources.has("provider") ? "provider" : undefined;
  if (started === undefined && cost === undefined && input === undefined) return null;

  return (
    <section>
      <h3>
        <span>Metrics</span>
        <span className="count">{states.length} calls</span>
      </h3>
      <dl className="kv metrics">
        {started !== undefined ? (
          <>
            <dt>started</dt>
            <dd title={new Date(started).toISOString()}>{new Date(started).toLocaleString()}</dd>
          </>
        ) : null}
        {spent !== undefined ? (
          <>
            <dt>in calls</dt>
            <dd>{duration(spent)}</dd>
          </>
        ) : null}
        {cost !== undefined ? (
          <>
            <dt>cost</dt>
            <dd>
              ${cost.toFixed(4)}
              {/* Only when it is NOT the provider's own charge. A silent estimate is the one that
                  gets quoted back as a fact. */}
              {source !== undefined && source !== "provider" ? (
                <span className="chip chip-warn" title="not the provider's own charge">
                  {source === "table" ? "price table" : "unknown"}
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
        {input !== undefined ? (
          <>
            <dt>in</dt>
            <dd title="total billed input, including cache reads and writes">{count(input)}</dd>
          </>
        ) : null}
        {output !== undefined ? (
          <>
            <dt>out</dt>
            <dd>
              {count(output)}
              {reasoning !== undefined ? <span className="sub"> · {count(reasoning)} thinking</span> : null}
            </dd>
          </>
        ) : null}
        {cached !== undefined || written !== undefined ? (
          <>
            <dt>cache</dt>
            <dd title="read at roughly a tenth of the base rate; written above it">
              {cached !== undefined ? `${count(cached)} read` : "—"}
              {written !== undefined ? ` · ${count(written)} written` : ""}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * The inspector when the address bar is standing on a RUN.
 *
 * The context panel describes the last element of the path, and once the path can end on a run, the
 * thing to describe is that run: what it was called with, how it went, what it cost. Those are per
 * EXECUTION facts, and the task panel below cannot carry them — a task that looped four times has
 * one status and four runs, and averaging them is how a failed pass disappears.
 *
 * The task is still here, underneath. A run belongs to one, and starting, cancelling and the live
 * event stream are the task's business rather than the run's.
 */
export function RunInspector({
  node,
  stateId,
  detail,
  stream,
  states,
  depth,
  onBack,
  onShowTask,
  onStart,
  onCancel,
  onOpenState,
}: {
  /** The run being described. Null ⇒ the trail names an instance this task no longer has. */
  node: InstanceNode | null;
  /** The state that run entered — what the "open its file" link opens. */
  stateId: string;
  detail: TaskDetail | null;
  stream: string[];
  /** The task's session rows, from which this run's own metrics are taken. */
  states: SessionRef[];
  /** How deep the walk is, so Back can say what it goes back to. */
  depth: number;
  onBack: () => void;
  /** Describe the TASK instead — the third subject of this column, and the only one with no click. */
  onShowTask: () => void;
  onStart: () => void;
  onCancel: () => void;
  onOpenState: (stateId: string) => void;
}): JSX.Element {
  const sig = node === null ? null : signatureOf(node);
  // This run's own row, not the task's. `instanceId` is what tells four passes apart, and it is the
  // whole reason these numbers are worth showing separately from the task's total.
  const mine = node === null ? [] : states.filter((row) => row.instanceId === node.instanceId);
  const took = node?.endedAt !== undefined ? durationOf(node.endedAt - node.startedAt) : undefined;
  return (
    <div className="inspector">
      <div className="insp-crumb">
        <button className="link back-arrow" onClick={onBack} title={depth > 1 ? "back to the run above" : "back to the state"}>
          ←
        </button>
        <span className="state-id ellip">{sig?.label ?? sig?.name ?? stateId.split("/").pop()}</span>
        <span className="sub">· the run</span>
        <span className="grow" />
        {detail !== null ? (
          <button className="link" onClick={onShowTask} title="describe the task this run belongs to">
            the task ↗
          </button>
        ) : null}
      </div>

      {node === null ? (
        // Two different absences, and saying "it was re-run" about the first would be a bug report
        // for something that is merely a round trip in flight.
        <p className="empty">{detail === null ? "Reading the run…" : "That run is no longer in this task — it was re-run."}</p>
      ) : (
        <section>
          <h3>
            <span>This run</span>
            <span className={`chip chip-${node.status === "completed" ? "ok" : node.status === "failed" ? "bad" : "warn"}`}>
              {node.status.replace(/_/g, " ")}
            </span>
          </h3>
          <dl className="kv">
            <dt>state</dt>
            <dd>
              <button className="link ellip" onClick={() => onOpenState(node.stateId)} title="open its file">
                {node.stateId}
              </button>
            </dd>
            <dt>started</dt>
            <dd title={new Date(node.startedAt).toISOString()}>{new Date(node.startedAt).toLocaleTimeString()}</dd>
            {took !== undefined ? (
              <>
                <dt>took</dt>
                <dd>{took}</dd>
              </>
            ) : null}
            {/* What it was called with — the same values the card's signature previews, in full. */}
            {(sig?.params ?? []).map((param) => (
              <Fragment key={param.name}>
                <dt className="ellip">{param.name}</dt>
                <dd className="ellip" title={param.preview}>
                  <code>{param.preview}</code>
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      )}

      {mine.length > 0 ? <TaskMetrics states={mine} /> : null}

      {detail !== null ? (
        <TaskPanel detail={detail} stream={stream} onStart={onStart} onCancel={onCancel} onOpenState={onOpenState} />
      ) : null}
    </div>
  );
}

/**
 * The inspector when a task is what you clicked.
 *
 * The right column is a CONTEXT panel: it describes whatever you last clicked, and clicking a task
 * makes the task the context. Two things follow from that and neither was here before.
 *
 * **Back is always available.** It was a crumb rendered only when a state happened to be open, so a
 * task reached from anywhere else was a one-way trip — the column stayed on the task until you
 * clicked another file. It is now an arrow that is always there, and it RESTORES rather than
 * switches: `inspectFrom` remembers where the context came from, which matters because the links
 * below can move the open state out from under you.
 *
 * **It links out.** A task's whole shape is "these states, in this order", and every one of them is
 * a file you might want to open — most of all the one that just failed. Those links are what make
 * this a context panel rather than a status readout.
 */
export function TaskInspector({
  stateId,
  detail,
  stream,
  states,
  showing,
  onBack,
  onStart,
  onCancel,
  onOpenState,
  onOpenStateAt,
}: {
  /** Where Back goes, for the label. Null ⇒ back to whatever file is open. */
  stateId: string | null;
  detail: TaskDetail | null;
  stream: string[];
  /** Every state the task ran, with its outcome — the panel's links out. */
  states: SessionRef[];
  /** Which instance's transcript the middle panel is showing, so the list says where you are. */
  showing: number | null;
  onBack: () => void;
  onStart: () => void;
  onCancel: () => void;
  /** Open a state's file — the link back to authoring the thing that just ran. */
  onOpenState: (stateId: string) => void;
  /**
   * Open one state THIS task ran, with that pass's transcript in it.
   *
   * One action rather than the two it replaced (read the transcript here / open the file there):
   * "this is the state that failed" and "take me to it" are one thought.
   */
  onOpenStateAt: (stateId: string, instanceId: number) => void;
}): JSX.Element {
  const back = (
    <button className="link back-arrow" onClick={onBack} title={stateId === null ? "Back" : `Back to ${stateId}`}>
      ←
    </button>
  );
  if (detail === null) {
    return (
      <div className="inspector">
        <div className="insp-crumb">
          {back}
          <span className="sub">no task</span>
        </div>
        <p className="empty">That task could not be read.</p>
      </div>
    );
  }
  return (
    <div className="inspector">
      <div className="insp-crumb">
        {back}
        <span className="state-id ellip">{detail.title}</span>
        <span className="sub">· the task</span>
      </div>

      {states.length > 0 ? <TaskMetrics states={states} /> : null}

      {states.length > 0 ? (
        <section>
          {/* In run order, because that is the shape of what happened. A row opens the state's FILE
              and puts THIS run's pass through it in the transcript beside it — which is the move you
              want when the answer to "what went wrong" turns out to be "the prompt". */}
          <h3>
            <span>States it ran</span>
            <span className="count">{states.length}</span>
          </h3>
          <div className="task-states">
            {states.map((row) => (
              <div
                key={`${row.runId}:${row.instanceId}`}
                className={`leaf-row task-state-row${row.instanceId === showing ? " sel" : ""}`}
                onClick={() => onOpenStateAt(row.stateId, row.instanceId)}
                title={`open ${row.stateId} and read this run's pass through it`}
              >
                <span className={`dot ${row.status ?? "unknown"}`} />
                <span className="grow ellip">{row.stateId}</span>
                {row.costUsd !== undefined ? <span className="cost">${row.costUsd.toFixed(3)}</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <TaskPanel
        detail={detail}
        stream={stream}
        onStart={onStart}
        onCancel={onCancel}
        onOpenState={onOpenState}
      />
    </div>
  );
}
