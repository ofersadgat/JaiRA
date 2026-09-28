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
import { Icon } from "./icons";
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type {
  FileMutationResult,
  FileNode,
  FileRoot,
  FileSource,
  FileTree,
  MoveWorkflowRequest,
  StateView,
  WorkflowLayer,
  WorkflowMutationResult,
} from "@jaira/shared/browser";
import { isWritableLayer } from "@jaira/shared/browser";
import { CrumbBar } from "./crumbs";
import { editorPaint } from "./editorThemes";
import { editorPick, pickPalette, viewerPick, type FileSurfaceContext } from "./fileTypes";
import {
  HALF_GLYPHS,
  HALF_WORDS,
  KIND_GLYPH,
  LAYER_LABEL,
  ROOT_WORD,
  anchorIn,
  builtInItems,
  childStateDraft,
  crumbInputOf,
  crumbsOf,
  folderFactsOf,
  issueCountsOf,
  entriesUnder,
  newItems,
  nextHalf,
  rootEmptyText,
  rootNeedsName,
  runToggleableOf,
  stateIdsOf,
  treeMatches,
  treeRowOf,
  type CrumbInput,
  type FileSelection,
  type TreeDraft,
} from "./filesModel";
import { AskDialog, ContextMenu, pointOf, type AskSpec, type MenuAnchor, type MenuItem, type MenuPoint } from "./menu";
import { Popover, usePopover } from "./popover";
import { RunModeToggle } from "./runViews";
import { Splitter } from "./splitter";
import { PANE, paneDefault, type HalfMode } from "./uiState";

// The model — what the tree's rows say, the `+` menus, the address's crumbs — is `filesModel.ts`,
// shared with the universal copies; re-exported so this module's importers are unchanged.
export {
  anchorIn,
  builtInItems,
  childStateDraft,
  crumbsOf,
  entryItem,
  fileDraft,
  inLayerOf,
  newItems,
  revealKeys,
  rootNeedsName,
  standingRoot,
  stateDraft,
  statePrefixOf,
  workflowsDirOf,
  type CrumbInput,
  type FileSelection,
  type TreeDraft,
} from "./filesModel";


/**
 * How tall the viewer opens, and what a double-click on the divider restores.
 *
 * Roughly the 46% the stylesheet used to give it on a full-height window. Read from the layout
 * table rather than written here, because the shell holds the live value with the rest of the pane
 * sizes — and a default living in two files is a default that stops agreeing with itself.
 */
const VIEWER_HEIGHT = paneDefault(PANE.filesViewer);


/** What the tree asks the store to do; `force` is added by the follow-up confirmation. */
type MoveRequest = MoveWorkflowRequest;


// --- the tree ----------------------------------------------------------------


function TreeNode({
  node,
  depth,
  root,
  selected,
  dirty,
  expanded,
  onToggle,
  onSelect,
  onMenu,
  onNew,
  draftUnder,
}: {
  node: FileNode;
  depth: number;
  /** The root this row came under — carried whole now, because its `prefix` is what the menus ask. */
  root: FileRoot;
  selected: FileSelection | null;
  /** Files with unsaved edits, by `layer:path`. A directory is marked when anything under it is. */
  dirty: ReadonlySet<string>;
  /** The directories that are OPEN. Everything else is shut — see `FileTreePanel`'s own note. */
  expanded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSelect: (node: FileNode) => void;
  onMenu: (node: FileNode, root: FileRoot, at: MenuPoint) => void;
  /** The `+` on a folder: the same three verbs, without the ones that act on the folder itself. */
  onNew: (node: FileNode, at: MenuPoint) => void;
  /**
   * The row being typed into, when it is anchored directly under this one.
   *
   * A callback rather than the draft itself, so the panel keeps every decision about what a draft
   * is and this stays what it has always been: a row, and the rows under it.
   */
  draftUnder: (key: string) => JSX.Element | null;
}): JSX.Element {
  // What the row says — its key, fold, selection, unsaved mark, lint tone and glyph — is
  // `treeRowOf` (`filesModel.ts`), shared with the universal copy.
  const { key, isDir, isSelected, unsaved, tone, inert, glyph, title, open } = treeRowOf(node, selected, dirty, expanded);
  const selectable = !isDir;
  const lint = node.lint;
  return (
    <>
      <li
        className={`tree-item${isSelected ? " sel" : ""}${node.shadowed ? " shadowed" : ""}${tone}${inert ? " inert" : ""}`}
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
          // The ROW travels with the point: selecting a file swaps the surface beside the tree, and
          // a surface that follows a transcript scrolls itself — which used to close this menu
          // before it could be read. See `menu.tsx`.
          onMenu(node, root, pointOf(e));
        }}
        title={title}
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
        <span className="glyph">{glyph}</span>
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
        {node.shadowed ? <span className="chip">{node.layer === "system" ? "overridden" : "shadowed"}</span> : null}
        {/* Which layer supplied a state is the row's ROOT, except in the one case the root cannot
            say: this file is a person's, and JaiRA ships a state of the same id beneath it. */}
        {node.overridesBuiltIn ? (
          // One word, because the column is 250px and the NAME is what must not be the part that
          // gives way; the sentence is the tooltip, and the editor's top bar says it in full.
          <span className="chip" title="Overrides built in: JaiRA ships a state with this id, and this file runs instead of it">
            override
          </span>
        ) : null}
        {/* The folder's own `+`. On hover and on focus only — a column of plus signs down a tree is
            a column of things to click by accident — and it stops the click, because the row it
            sits on opens the folder and a menu that opened under a folder that had just closed
            would be a menu pointing at nothing. Not on what ships: nothing is made there. */}
        {isDir && isWritableLayer(node.layer) ? (
          <button
            className="tree-add"
            title={`new file, folder or workflow in ${node.name}`}
            aria-label={`New in ${node.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onNew(node, pointOf(e));
            }}
          >
            +
          </button>
        ) : null}
      </li>
      {draftUnder(key)}
      {open
        ? (node.children ?? []).map((child) => (
            <TreeNode
              key={`${child.layer}:${child.path}`}
              node={child}
              depth={depth + 1}
              root={root}
              selected={selected}
              dirty={dirty}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onMenu={onMenu}
              onNew={onNew}
              draftUnder={draftUnder}
            />
          ))
        : null}
    </>
  );
}

// --- making something new ----------------------------------------------------


/** How far in a row inside `dir` is drawn. The tree draws every level, so the path counts them. */
const depthIn = (dir: string): number => (dir === "" ? 0 : dir.split("/").length);


/**
 * The row being typed into.
 *
 * Its own component, so the name lives and dies with the row: a draft cancelled and restarted
 * somewhere else is a new field rather than the old one's text following the caret around the tree.
 *
 * Committed on Enter and on the way out — the same bargain the hidden-rules field makes, for the
 * same reason: a name typed and then clicked away from was typed on purpose. An empty one commits
 * nothing, so leaving is also how you back out without reaching for Escape.
 */
function DraftRow({
  draft,
  depth,
  missing,
  onCommit,
  onCancel,
}: {
  draft: TreeDraft;
  /** Where {@link anchorIn} put it — the row it hangs under, plus one. */
  depth: number;
  /** The folders on its path that are not there yet, drawn ahead of the field. */
  missing: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  // Enter commits and unmounts, and the unmount blurs: without this, the field would commit twice
  // and the second create would refuse as "already exists".
  const done = useRef(false);
  const finish = (commit: boolean): void => {
    if (done.current) return;
    done.current = true;
    const clean = name.trim().replace(/^\/+|\/+$/g, "");
    if (commit && clean.length > 0) onCommit(clean);
    else onCancel();
  };
  const kind = draft.target.kind;
  return (
    <li className="tree-item tree-draft">
      {Array.from({ length: depth }, (_, i) => (
        <i key={i} className="tree-guide" />
      ))}
      {/* The same column the row it will become uses, wearing that row's mark: a folder's twisty, a
          state's glyph. What is being made is legible before it has a name. */}
      <span className="glyph" aria-hidden="true">
        {kind === "directory" ? "▸" : kind === "state" ? (KIND_GLYPH.workflow ?? "·") : "·"}
      </span>
      {/* `workflows/` for a workflow in a project that has never had one. Part of what the create
          will make, so it is shown as path rather than as prose — and dimmed, because it is the one
          part of this row nobody is being asked to type. */}
      {missing.length > 0 ? <span className="draft-lead">{missing}</span> : null}
      <input
        className="draft-name"
        autoFocus
        spellCheck={false}
        value={name}
        placeholder={kind === "directory" ? "folder name" : kind === "state" ? "state id" : "file name"}
        aria-label={kind === "state" ? "new state id" : `new ${kind} name`}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        }}
      />
    </li>
  );
}

const copyText = (text: string): void => void navigator.clipboard?.writeText(text);


/** The default for {@link FileTreePanel}'s `dirty`. A module constant, so its identity is stable. */
const EMPTY_DIRTY: ReadonlySet<string> = new Set();

export function FileTreePanel({
  tree,
  selected,
  dirty = EMPTY_DIRTY,
  expanded: expandedProp,
  onToggleExpanded,
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
  draft: draftProp,
  onDraft,
  onUnfold,
  project = null,
}: {
  tree: FileTree | null;
  selected: FileSelection | null;
  /** Files with unsaved edits, by `layer:path`. Defaulted, so a host with no draft store shows none. */
  dirty?: ReadonlySet<string>;
  /**
   * The OPEN branches, by the same `layer:path` key, and how to open or close one.
   *
   * Controlled when both are supplied — the shell keeps them in `user-settings.json`, so the shape you
   * left the tree in is the shape it opens in — and local otherwise, which keeps this panel usable
   * on its own. Same arrangement as the JSON editor's wrap preference, for the same reason: a
   * component that REQUIRED a store would be a component you could not render without one.
   *
   * POSITIVE — what is listed is OPEN — which is the opposite of every other tree in the app and of
   * what this prop used to be. The reason is what the tree is rooted at: a checkout. Expanded by
   * default meant a first paint of every file in `packages/`, `docs/` and `test/`, and a shape you
   * had to fold up before you could read it. Collapsed by default, opening a folder is a thing you
   * did rather than a thing you undid — and it applies all the way down, so opening one folder shows
   * the names inside it and not the whole subtree.
   */
  expanded?: ReadonlySet<string> | undefined;
  onToggleExpanded?: ((key: string) => void) | undefined;
  busy: boolean;
  /** Project-layer operations are impossible without one, so they are offered disabled, not hidden. */
  hasProject: boolean;
  /** Open any file in the panel — a state, a prompt, `settings.json`, anything the registry can render. */
  onSelect: (node: FileNode) => void;
  /** Open an existing state's file. */
  onOpen: (stateId: string, layer: WorkflowLayer) => void;
  /**
   * Create a state — writes the file straight away, then selects it.
   *
   * `project` names WHICH checkout, for a `project`-layer create: the tree holds several and the
   * layer alone does not say which one the row that was clicked belongs to (SHELL.md §2.2).
   */
  onCreate: (stateId: string, layer: WorkflowLayer, project?: string) => void;
  /** Create a plain file or a directory, addressed by path under a tree root. Same `project` rule. */
  onCreateFile: (
    layer: WorkflowLayer,
    path: string,
    kind: "file" | "directory",
    text?: string,
    project?: string,
  ) => void;
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
   * Whether the FIND field is showing.
   *
   * It was permanent — a filter box over the tree, on screen in a 250px column whether or not
   * anybody was filtering. It is the Files row's own verb now (`SidebarAct`), and this says whether
   * it is on. Defaulted off, so a host that draws this panel without a row to press still gets a
   * tree.
   */
  find?: boolean;
  /**
   * The row being typed into, and how to start or drop one — controlled when both are supplied,
   * local otherwise, exactly as the folding is.
   *
   * It is lifted for one reason: the `+` that starts the commonest draft is not in this panel. It
   * is on the Files ROW, in the sidebar, next to the search verb — so the menu it opens is drawn by
   * the shell, and the draft it starts has to arrive here.
   */
  draft?: TreeDraft | null;
  onDraft?: ((draft: TreeDraft | null) => void) | undefined;
  /**
   * Open these branches — what a draft in a folded folder needs before it can be seen.
   *
   * Separate from `onToggleExpanded` because it is not a toggle and not one key: revealing
   * `.jaira/workflows` means opening both, and two toggles in one tick both read the state from
   * before either of them (see `withUnfolded`).
   */
  onUnfold?: ((keys: readonly string[]) => void) | undefined;
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
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<string>>(new Set());
  const expanded = expandedProp ?? ownExpanded;
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [ask, setAsk] = useState<AskSpec | null>(null);
  /** Used only when the host does not hold the draft — see the prop. */
  const [ownDraft, setOwnDraft] = useState<TreeDraft | null>(null);
  const draft = draftProp ?? ownDraft;

  /**
   * Start typing a name, having first made the place it lands visible.
   *
   * The unfold is half the verb. "New workflow" names `.jaira/workflows` from a row that may have
   * nothing at all open under it, and a field rendered inside two folded branches is a field that
   * takes the keystrokes and shows none of them.
   */
  const startDraft = (next: TreeDraft): void => {
    const missing = next.reveal.filter((key) => !expanded.has(key));
    if (missing.length > 0) {
      if (onUnfold !== undefined) onUnfold(missing);
      else setOwnExpanded((current) => new Set([...current, ...missing]));
    }
    if (onDraft !== undefined) onDraft(next);
    else setOwnDraft(next);
  };

  const dropDraft = (): void => {
    if (onDraft !== undefined) onDraft(null);
    else setOwnDraft(null);
  };

  /**
   * What the typed name becomes.
   *
   * A state is created by ID and a file by path — the two calls the tree has always had, reached
   * now by one field. The suffix is stripped from a state id because `feature.json` is the FILE and
   * `feature` is the state: typing what you can see in the tree would otherwise produce
   * `feature.json.json`, which the loader reads as a state called `feature.json`.
   */
  const commitDraft = (name: string): void => {
    if (draft === null) return;
    dropDraft();
    if (draft.target.kind === "state") {
      const id = `${draft.target.prefix}${name.replace(/\.(json|jsonc|ya?ml)$/i, "")}`;
      onCreate(id, draft.layer, draft.project);
      return;
    }
    onCreateFile(
      draft.layer,
      draft.dir === "" ? name : `${draft.dir}/${name}`,
      draft.target.kind,
      undefined,
      draft.project,
    );
  };

  /**
   * The draft row, when it belongs directly under `key` in `root`.
   *
   * Resolved here rather than when the draft was made, because where it can be DRAWN is a fact
   * about the tree and the draft is a fact about the destination — and the destination is allowed
   * not to exist. See {@link anchorIn}.
   */
  const draftIn = (root: FileRoot, key: string | null): JSX.Element | null => {
    if (draft === null || draft.rootDir !== root.dir) return null;
    const at = anchorIn(root, draft);
    return at.under === key ? (
      <DraftRow key="draft" draft={draft} depth={at.depth} missing={at.missing} onCommit={commitDraft} onCancel={dropDraft} />
    ) : null;
  };

  /** The `+` menu, for a directory in a root. Also what a folder's right-click starts with. */
  const openNew = (root: FileRoot, dir: string, at: MenuPoint): void =>
    setMenu({ ...at, items: newItems(root, dir, startDraft) });

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

  const openMenu = (node: FileNode, root: FileRoot, at: MenuPoint): void =>
    setMenu({ ...at, items: itemsFor(node, root) });

  const toggle = (key: string): void => {
    if (onToggleExpanded !== undefined) return onToggleExpanded(key);
    setOwnExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Filtering flattens — see `treeMatches`.
  const matches = (nodes: FileNode[]): FileNode[] => treeMatches(nodes, filter);

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
          // A filter FLATTENS the tree (see `matches`), so the folder a draft is anchored under
          // stops being drawn and the field being typed into goes with it. Dropping it is the
          // honest end: a half-typed name with nowhere to land is not a name.
          onChange={(e) => {
            setFilter(e.target.value);
            if (draft !== null) dropDraft();
          }}
          onKeyDown={(e) => (e.key === "Escape" ? setFilter("") : undefined)}
          placeholder="Filter…"
        />
      ) : null}

      <div className="scroll">
        {tree === null ? (
          <p className="empty">Open a project to browse its files.</p>
        ) : (
          tree.roots.map((root) => {
            // What ships always introduces itself: it is never the place you are standing in, and
            // its name is the only thing that says these rows are not yours to edit.
            const writable = isWritableLayer(root.layer);
            const named = !writable || rootNeedsName(root, project);
            const rootMenu = (e: ReactMouseEvent): void => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({
                ...pointOf(e),
                items: [
                  // Nothing is made in what ships, so its root offers the two ways of looking only.
                  ...(writable ? newItems(root, "", startDraft) : []),
                  { label: "Copy path", separator: writable, onSelect: () => copyText(root.dir) },
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
              <li className={writable ? "tree-root" : "tree-root is-readonly"} title={root.dir} onContextMenu={rootMenu}>
                {/* The project's own name, in the data voice — a directory basename, and the same
                    string the crumb prints. `~/.jaira` is listed once beside the projects rather
                    than under each, so it names itself the same way. */}
                <span className="data-secondary grow ellip">{root.label}</span>
                {writable ? (
                /* The `+` every folder has, on the row that stands for the whole root. The one root
                   without this line is the one you are standing in, and that root's `+` is the
                   Files row's own — see `standingRoot`. */
                <button
                  className="tree-add"
                  title={`new file, folder or workflow in ${root.label}`}
                  aria-label={`New in ${root.label}`}
                  onClick={(e) => openNew(root, "", pointOf(e))}
                >
                  +
                </button>
                ) : (
                  <span className="chip" title="What ships with JaiRA. It is never changed in place: editing a file here copies it into Shared (~/.jaira), and the copy is what is used.">
                    edits copy to Shared
                  </span>
                )}
              </li>
              ) : null}
              {draftIn(root, null)}
              {(filter.length > 0 ? matches(root.nodes) : root.nodes).map((node) => (
                <TreeNode
                  key={`${node.project ?? node.layer}:${node.path}`}
                  node={node}
                  depth={0}
                  root={root}
                  selected={selected}
                  dirty={dirty}
                  expanded={expanded}
                  onToggle={toggle}
                  onSelect={onSelect}
                  onMenu={openMenu}
                  onNew={(folder, at) => openNew(root, folder.path, at)}
                  draftUnder={(key) => draftIn(root, key)}
                />
              ))}
              {root.nodes.length === 0 ? (
                // An absent shared root is the normal starting state, not a fault. Saying so — and
                // saying what fixes it — is the difference between an empty branch that looks
                // broken and one that looks like an invitation.
                <li className="empty root-empty">
                  {rootEmptyText(root, writable)}
                </li>
              ) : null}
            </ul>
            );
          })
        )}
      </div>

      {/* The form that used to stand here is gone, and with it the last layer picker.
          It asked the one question a form has to ask and a tree does not: where does this land? A
          row typed INTO the tree has already answered it — the folder above it is the folder — and
          "in this project / in the shared root" was a third control for a fact that was on screen.
          See `TreeDraft`. */}

      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {ask ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
    </div>
  );
}

// --- the middle panel --------------------------------------------------------


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
  const { errors, warnings } = issueCountsOf(state);
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
  facts,
}: {
  doc: FileSource | null;
  /** The directory open instead, when one is — exactly one of the two is ever set. */
  dir?: FileSelection | null;
  context: FileSurfaceContext;
  /** Walk the address bar back to a crumb; `-1` is the file with no run open. */
  onWalkBack?: ((index: number) => void) | undefined;
  onInspect: () => void;
  /** The ⓘ at the bar's right end — see {@link FactsButton}. */
  facts?: React.ReactNode;
}): JSX.Element | null {
  // Before the early return: a hook cannot be conditional, and "no file open" is a condition.
  const known = useMemo(() => stateIdsOf(context.tree), [context.tree]);

  /** Everything the address bar needs, for whichever of the two things is open — see `crumbInputOf`. */
  const barFor = (at: { layer: WorkflowLayer; path: string; stateId?: string | undefined; isDir?: boolean }): CrumbInput =>
    crumbInputOf(at, context, known, onWalkBack);

  // A folder is an address like any other, so it gets the same bar.
  if (doc === null) {
    return dir == null ? null : (
      <DocBar input={barFor({ ...dir, isDir: true })} state={null} onInspect={onInspect}>
        {facts}
      </DocBar>
    );
  }

  // Only where there are two readings — see `runToggleableOf`.
  const toggleable = runToggleableOf(doc, context);

  return (
    <DocBar input={barFor(doc)} state={context.state} onInspect={onInspect}>
      {/* Only where there are two readings to switch between. A run with no children says what it
          said and nothing else, so a toggle on it would be one live option and one dead one. */}
      {toggleable && context.onRunMode !== undefined ? (
        <RunModeToggle mode={context.runMode ?? "board"} onMode={context.onRunMode} />
      ) : undefined}
      {/* A shipped file that is not a state has no editor bar of its own to say what an edit does —
          the state editor's layer bar says it for states — so the address says it (copy-on-edit, the
          panel rulings of 2026-09-24). */}
      {doc.layer === "system" && doc.stateId === undefined ? (
        doc.builtIn?.layers.includes("base") === true ? (
          <span className="chip chip-warn" title="Shared already has its own copy of this file, and that copy is the one in use.">
            built in · Shared has its copy
          </span>
        ) : (
          <span className="chip" title="This file ships with JaiRA. The first change you make copies it into ~/.jaira with the change in it, and the copy is what is used.">
            built in · an edit copies it to Shared
          </span>
        )
      ) : null}
      {facts}
    </DocBar>
  );
}

/**
 * When copy-on-edit last asked to copy each shipped file, by path. Module state rather than a hook,
 * because {@link FilePanel} returns early before its hooks would run; the window is how long a copy
 * takes to open, after which the file shown is the copy and nothing here is asked again.
 */
const COPY_ASKED = new Map<string, number>();
const COPY_WINDOW_MS = 5000;

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

  /**
   * The two halves, worked out from what this type can be drawn BY — see `viewerFor` / `editorFor`.
   *
   * Neither is declared any more. A renderer says what kind of rendering it is (text, data, preview)
   * and whether it writes; the upper half takes the rendering, the lower half takes the thing that
   * writes, and this person's choice per kind decides which of each. That indirection is why a
   * `.json` file can have a data tree above and an editor below without either being described as
   * the other's alternative.
   */
  const viewer = viewerPick(doc.mime, context.renderers);
  const View = viewer?.renderer.surface ?? null;
  const edits = editorPick(doc.mime, context.renderers);
  const editor = edits?.renderer ?? null;
  const Edit = editor?.surface ?? null;
  /**
   * The palette each half is painted in — the one thing a surface cannot work out for itself.
   *
   * A theme is per type and per view (§6.4) and the root can hold ONE, which `applyAppearance`
   * writes there as the default for everything nobody has said anything about. A DOM editor takes
   * its colours from that mapping and from nothing else — so a palette chosen for Markdown reached
   * the settings preview, which paints a container of its own, and reached no editor in the window
   * at all. This is that container, around the real thing: the class switches the stylesheet's
   * mapping on and the variables are the colours it maps, so everything under it is repainted and
   * nothing outside it moves. Null where nothing was said, which leaves the window's own default
   * standing rather than restating it one element down.
   */
  const viewPaint = editorPaint(pickPalette(viewer, doc.mime, context.renderers));
  const editPaint = editorPaint(pickPalette(edits, doc.mime, context.renderers));
  const props = { doc, busy, onSave, context };
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
  const shippedProps: typeof props | undefined =
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
          <div className={`run-half${viewPaint === null ? "" : ` ${viewPaint.className}`}`} style={viewPaint?.style}>
            <View {...viewProps} />
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

      <div
        className={`${View === null || at === "full" ? "config-half whole" : `config-half${shut ? " shut" : ""}`}${
          editPaint === null ? "" : ` ${editPaint.className}`
        }`}
        style={editPaint?.style}
      >
        {View ? (
          // The label became the control. Folded, this row IS the lower half — a bar across the
          // bottom of the column saying what is behind it and taking one click to bring back. It
          // cycles rather than toggles: three positions, one place, and the glyph is how much of the
          // column this half currently has.
          <button
            type="button"
            className="half-bar"
            onClick={() => onHalf?.(nextHalf(at))}
            disabled={onHalf === undefined}
            title={`${HALF_WORDS[at]} — click for ${HALF_WORDS[nextHalf(at)]}`}
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
          // What ships is never written in place (decision 0006), and it is edited all the same:
          // COPY-ON-EDIT (the panel rulings, 2026-09-24). A shipped STATE's editor copies it into
          // Shared on its first change; any other shipped file is mounted live with its first draft
          // turned into the same copy (`shippedProps`). Only a file Shared already has a copy of —
          // the copy is what is read — is mounted as the READING of its type.
          <Edit {...(isWritableLayer(doc.layer) || doc.stateId !== undefined ? props : (shippedProps ?? viewProps))} />
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

/**
 * What there is to say about a plain file or a folder — where it is, what it is, how big — behind
 * the ⓘ on the address ({@link FactsButton}). A state says more, and says it in the side panel; these
 * used to take the whole column to say four facts.
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
  const { entries, dirs, states, root } = folderFactsOf(tree, layer, path);
  return (
    <div className="inspector">
      <div className="insp-crumb">
        <span className="state-id ellip">{path === "" ? ROOT_WORD[layer] : (path.split("/").pop() ?? path)}</span>
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

export function FileInspector({ doc }: { doc: FileSource | null }): JSX.Element {
  if (doc === null) return <p className="empty">Select a file.</p>;
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

/**
 * The ⓘ at the right of the Files address: a plain file's or a folder's facts, in a popover (the
 * panel rulings, 2026-09-24). The side panel closes for these — there is nothing to DO with a
 * prompt's size and path, and a column that says four facts pushes the file it describes into less
 * of the window.
 */
export function FactsButton({ children }: { children: React.ReactNode }): JSX.Element {
  const pop = usePopover<HTMLSpanElement>();
  const { open, setOpen } = pop;
  return (
    <span className="facts-wrap" ref={pop.anchor}>
      <button type="button" className={`sp-icon facts-btn${open ? " on" : ""}`} aria-expanded={open} title="About this" onClick={() => setOpen((v) => !v)}>
        <Icon name="info" />
      </button>
      {open ? (
        <Popover at={pop} side="below" align="end" className="facts-pop" role="dialog" aria-label="About this">
          {children}
        </Popover>
      ) : null}
    </span>
  );
}
