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
import { useState, type CSSProperties, type JSX } from "react";
import type {
  FileMutationResult,
  FileNode,
  FileSource,
  FileTree,
  MoveWorkflowRequest,
  StateView,
  TaskDetail,
  WorkflowLayer,
  WorkflowMutationResult,
} from "@jaira/shared/browser";
import { isTextMime } from "@jaira/shared/browser";
import { Badge } from "./board";
import { TaskPanel } from "./detail";
import { resolveFileSurface, type FileSurfaceContext } from "./fileTypes";
import { AskDialog, ContextMenu, type AskSpec, type MenuAnchor, type MenuItem } from "./menu";
import { Splitter } from "./splitter";

/**
 * How tall the viewer opens, and what a double-click on the divider restores.
 *
 * Roughly the 46% the stylesheet used to give it on a full-height window. Exported because the
 * shell holds the live value with the rest of the pane sizes, and a default living in two files is
 * a default that stops agreeing with itself.
 */
export const VIEWER_HEIGHT = 320;

/** What the tree highlights: a file is identified by its layer and its path, never by its id. */
export interface FileSelection {
  layer: WorkflowLayer;
  path: string;
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
  const key = `${node.layer}:${node.path}`;
  const isDir = node.kind === "directory";
  const open = isDir && !collapsed.has(key);
  // Every file opens now, whatever it is: the registry has a surface for anything that is text, and
  // for anything that is not the panel says so. Highlighting is by layer AND path, because the same
  // state id exists in both roots and only one of them is the file you clicked.
  const selectable = !isDir;
  const isSelected = selectable && selected !== null && selected.layer === node.layer && selected.path === node.path;
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
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={() => (isDir ? onToggle(key) : onSelect(node))}
        onContextMenu={(e) => {
          e.preventDefault();
          // Right-click selects too, so the menu always acts on the row that is highlighted — a menu
          // operating on something other than what looks selected is how the wrong file gets deleted.
          if (selectable) onSelect(node);
          onMenu(node, rootDir, e.clientX, e.clientY);
        }}
        title={node.error ?? lintTitle(node, isDir) ?? node.path}
      >
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

/** The default for {@link FileTreePanel}'s `dirty`. A module constant, so its identity is stable. */
const EMPTY_DIRTY: ReadonlySet<string> = new Set();

export function FileTreePanel({
  tree,
  selected,
  dirty = EMPTY_DIRTY,
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
}: {
  tree: FileTree | null;
  selected: FileSelection | null;
  /** Files with unsaved edits, by `layer:path`. Defaulted, so a host with no draft store shows none. */
  dirty?: ReadonlySet<string>;
  busy: boolean;
  /** Project-layer operations are impossible without one, so they are offered disabled, not hidden. */
  hasProject: boolean;
  /** Open any file in the panel — a state, a prompt, `config.json`, anything the registry can render. */
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
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
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

  const toggle = (key: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Filtering flattens: a match three directories down is useless if its parents are still folded,
  // and re-deriving which ancestors to force open costs more than just listing the hits.
  const matches = (nodes: FileNode[], out: FileNode[] = []): FileNode[] => {
    for (const node of nodes) {
      if (node.kind !== "directory" && node.path.toLowerCase().includes(filter.toLowerCase())) out.push(node);
      if (node.children) matches(node.children, out);
    }
    return out;
  };

  return (
    <aside className="col side files-side">
      <h3>
        <span>Files</span>
        <span className="count">{tree?.roots.length ?? 0} roots</span>
      </h3>
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" />

      <div className="scroll">
        {tree === null ? (
          <p className="empty">Open a project to browse its files.</p>
        ) : (
          tree.roots.map((root) => (
            <ul className="file-tree" key={root.layer}>
              <li
                className="tree-root"
                title={root.dir}
                onContextMenu={(e) => {
                  e.preventDefault();
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
                }}
              >
                {root.layer === "project" ? ".jaira/" : "~/.jaira/"} · {LAYER_LABEL[root.layer]}
              </li>
              {(filter.length > 0 ? matches(root.nodes) : root.nodes).map((node) => (
                <TreeNode
                  key={`${node.layer}:${node.path}`}
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
          ))
        )}
      </div>

      {/* The one place a layer is still chosen, and the only question it can be: where does a NEW
          thing land? Everything that already exists answers it by where it sits above. */}
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
        <button type="submit" disabled={busy || !newId.trim()}>
          Create
        </button>
      </form>

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {ask ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
    </aside>
  );
}

// --- the middle panel --------------------------------------------------------

/**
 * The head of the middle panel: what is open, and where it lives.
 *
 * It says the same three things about every file — its name, its layer, its type — and adds the
 * state's own summary when the file happens to define one. Clicking it puts the inspector back on
 * the file, which is the way out of having drilled into a task.
 */
function FileHead({
  doc,
  state,
  onInspect,
}: {
  doc: FileSource;
  state: StateView | null;
  onInspect: () => void;
}): JSX.Element {
  const errors = state === null ? 0 : state.issues.filter((i) => i.severity === "error").length;
  const warnings = state === null ? 0 : state.issues.length - errors;
  return (
    <header className="doc-head" onClick={onInspect} title={doc.file}>
      <div className="doc-title">
        <div className="state-id">{state?.stateId ?? doc.path}</div>
        <div className="sub ellip">
          {state?.label ? `${state.label} · ` : ""}
          {LAYER_LABEL[doc.layer]}
          {state === null
            ? ` · ${doc.mime}`
            : state.children.length > 0
              ? ` · ${state.children.length} child ${state.children.length === 1 ? "state" : "states"}`
              : " · no child states"}
        </div>
      </div>
      {doc.exists ? null : <span className="chip">new</span>}
      {errors > 0 ? <span className="chip chip-bad">{errors} error</span> : null}
      {warnings > 0 ? <span className="chip chip-warn">{warnings} warning</span> : null}
    </header>
  );
}

/**
 * The open file: what it IS above, what it SAYS below.
 *
 * Both at once, and always — putting the two behind a mode toggle meant every glance at a state's
 * configuration cost you sight of its runs, which is the same mistake the old settings drawer made
 * at the window level, repeated one panel down.
 *
 * Neither half is chosen here. `resolveFileSurface` answers "what renders a `text/markdown` for
 * reading" and "what renders it for editing", and this component only decides the geometry: with a
 * viewer, the panel splits; without one, the editor takes the whole column. That second case is not
 * a degraded layout — a plain text file has no rendering distinct from its contents, and half a
 * panel of nothing above it would be worse than the space.
 */
export function FilePanel({
  doc,
  busy,
  context,
  viewerHeight,
  onViewerHeight,
  onSave,
  onInspect,
}: {
  doc: FileSource | null;
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
  onSave: (text: string) => void;
  onInspect: () => void;
}): JSX.Element {
  if (doc === null) {
    return (
      <div className="col mid">
        <p className="empty">Select a file in the tree.</p>
      </div>
    );
  }

  const View = resolveFileSurface(doc.mime, "view");
  const Edit = resolveFileSurface(doc.mime, "edit");
  const props = { doc, busy, onSave, context };

  return (
    <div className="col mid" style={{ "--viewer-height": `${viewerHeight}px` } as CSSProperties}>
      <FileHead doc={doc} state={context.state} onInspect={onInspect} />

      {View ? (
        <>
          <div className="run-half">
            <View {...props} />
          </div>
          {/* The halves were 46/54 and immovable, which is a guess about what you are doing: a board
              with nine columns and a form with three fields want opposite splits, and the same file
              wants opposite splits at different moments. `reserve` is measured against the column,
              so the divider cannot be dragged off the bottom of a short window. */}
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
        </>
      ) : null}

      <div className={View ? "config-half" : "config-half whole"}>
        {View ? <h3 className="half-label">{doc.stateId !== undefined ? "Configuration" : "Source"}</h3> : null}
        {Edit ? (
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
 * Everything here answers a question you can only ask while looking at a state file: does it
 * validate, what will it run on, where does control go next, who depends on it, and whether the
 * tasks currently inside it would even see an edit.
 */
export function StateInspector({
  state,
  onRevealIssue,
}: {
  state: StateView | null;
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
export function FileInspector({
  doc,
  state,
  onRevealIssue,
}: {
  doc: FileSource | null;
  state: StateView | null;
  /** Passed through to {@link StateInspector} — the only half of this panel with issues to reveal. */
  onRevealIssue?: ((path: string) => void) | undefined;
}): JSX.Element {
  if (doc === null) return <p className="empty">Select a file.</p>;
  if (state !== null && doc.stateId !== undefined) {
    return <StateInspector state={state} onRevealIssue={onRevealIssue} />;
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

/** The inspector when a task is what you clicked. */
export function TaskInspector({
  stateId,
  detail,
  stream,
  onBack,
  onStart,
  onCancel,
}: {
  stateId: string | null;
  detail: TaskDetail | null;
  stream: string[];
  onBack: () => void;
  onStart: () => void;
  onCancel: () => void;
}): JSX.Element {
  if (detail === null) return <p className="empty">Select a task.</p>;
  return (
    <div className="inspector">
      <div className="insp-crumb">
        {stateId !== null ? (
          <button className="link" onClick={onBack}>
            {stateId.split("/").pop()}
          </button>
        ) : null}
        <span className="sub">›</span>
        <span className="state-id">{detail.title}</span>
      </div>
      <TaskPanel detail={detail} stream={stream} onStart={onStart} onCancel={onCancel} />
    </div>
  );
}
