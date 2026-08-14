/**
 * The shell (DESIGN §11.1).
 *
 * One sidebar, three views, and no window chrome above either. The frame's title bar and Electron's
 * menu bar are both gone (`main/index.ts`), which is what lets the sidebar start at the top of the
 * window rather than 60px down it; the title they were carrying is now a strip over the body, and
 * the app's own name and the open project's are at the head of the sidebar. See `sidebar.tsx` for
 * why that column is one column and not the two it used to be.
 *
 * The app has exactly two activities — designing the states and operating the runs — and they used
 * to compete for the same three columns, so opening any settings pane evicted the task you were
 * watching. They are separate rooms now:
 *
 *  - **Files** designs. The tree opens any file; the middle shows it as a viewer over an editor,
 *    both chosen by file type in the surface registry; the inspector describes what you last clicked.
 *  - **Tasks** operates. The same board, reached by drilling a path instead of by clicking a file,
 *    with the selected task's detail beside it.
 *  - **Settings** holds everything that was never one of the two: configuration, executors,
 *    credentials, history. Its section list is an accordion in the sidebar, so it is no longer a
 *    second left column that existed in one view only.
 *
 * Two more sit beside them and belong to neither: **Logs** is what the app said about itself, and
 * **Debug** (DESIGN §11.3) runs a two-state workflow against this installation so that "does any of
 * this work" is a button rather than an afternoon.
 *
 * The approvals strip spans all three. A blocked tool loop is the one thing that must never scroll
 * away, and it stays visible while you are deep in the Files tree.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import type { ConfigLayer, PendingApproval, PendingInteraction, WorkflowLayer } from "@jaira/shared/browser";
import { Board } from "./board";
import { ApprovalDialog, InteractionDialog } from "./components";
import {
  FileAddressBar,
  FileInspector,
  FilePanel,
  FileTreePanel,
  FolderInspector,
  RunInspector,
  TaskInspector,
} from "./files";
// Imported for its registrations: this is what puts markdown, JSON, YAML, states and config into the
// surface registry. Nothing else in the shell references the built-in surfaces by name.
import "./fileSurfaces";
import type { FileSurfaceContext } from "./fileTypes";
import { LogsPanel } from "./logs";
import { LayerPicker, SettingsPane } from "./panes";
import { ConfigPane } from "./configPane";
import { DebugPane } from "./debugPane";
import { ProvidersPane } from "./providersPane";
import { ExecutorsPane } from "./executorsPane";
import { initialRunValues, runFieldsOf, runTargetOf } from "./runForm";
import type { RunSurface } from "./runPanel";
import { RunModeToggle, RunView, TaskContext } from "./runViews";
import { Sidebar, type SidebarView } from "./sidebar";
import { Splitter } from "./splitter";
import { TaskAddressBar } from "./taskBar";
import { nodeAt } from "./trail";
import { FOLD, PANE, SHUT, SIDEBAR_RAIL, openOf, paneDefault, paneOf, shutOf } from "./uiState";
import { History, NewTask } from "./widgets";
import { useApp, type SettingsSection, type View } from "./store";

/**
 * The bar above every settings section: which layer is being edited, and when the checks last ran.
 *
 * One component rather than a picker in each pane, and it is where the no-project rule lives. With
 * no project open there is no `.jaira/config.json` to write, so the switch is not merely disabled —
 * it is ABSENT, along with every mention of "this project". A control offering a choice that cannot
 * be made is worse than no control: the old screen showed the switch, let it be clicked, and then
 * explained in a notice that nothing could be saved.
 */
function SettingsHeader({
  section,
  layer,
  hasProject,
  busy,
  rechecking,
  checkedAt,
  onLayer,
  onRecheck,
}: {
  section: SettingsSection;
  layer: ConfigLayer;
  hasProject: boolean;
  busy: boolean;
  rechecking: boolean;
  checkedAt: number;
  onLayer: (layer: ConfigLayer) => void;
  onRecheck: () => void;
}): JSX.Element | null {
  const meta = SECTIONS.find((s) => s.id === section);
  const observed = section === "providers" || section === "executors";
  if (meta === undefined || (!meta.layered && !observed)) return null;
  return (
    <div className="settings-head">
      {meta.layered ? (
        hasProject ? (
          <LayerPicker value={layer} onChange={onLayer} disabled={busy} />
        ) : (
          <span className="sub">
            Editing the shared settings, which apply to every project on this machine. Open a project to
            override them for it.
          </span>
        )
      ) : null}
      {observed ? (
        <div className="settings-head-right">
          {/* Not "Test": nothing here is waiting to be tested. The checks ran at startup and after the
              last save; this is only for a world that changed since — a server started, a key
              installed in another window. */}
          <span className="sub">{checkedAgo(checkedAt)}</span>
          <button className="ghost" onClick={onRecheck} disabled={busy || rechecking}>
            {rechecking ? "checking…" : "Re-check"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** "checked 2 min ago", or the honest absence of one. */
function checkedAgo(at: number): string {
  if (at === 0) return "not checked yet";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "checked just now";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `checked ${minutes} min ago` : `checked ${Math.round(minutes / 60)} h ago`;
}

const VIEWS: readonly SidebarView[] = [
  { id: "files", glyph: "❏", label: "Files" },
  { id: "tasks", glyph: "▶", label: "Tasks" },
  { id: "logs", glyph: "≡", label: "Logs" },
  // In the sidebar rather than inside Settings: the self-test is the thing you reach for when the
  // app is not behaving, and burying it behind a configuration screen would make it hardest to find
  // in exactly the situation it exists for.
  { id: "debug", glyph: "⌁", label: "Debug" },
];

/**
 * The window's name for a project directory: its last segment.
 *
 * The full path is what the crumb's tooltip carries. A column 250px wide cannot show
 * `C:/checkouts/acme/services/billing` and would show the wrong half of it if it tried — the half
 * every project on the machine has in common.
 */
function projectName(dir: string | null): string {
  if (dir === null) return "";
  const parts = dir.split(/[\\/]/).filter((p) => p.length > 0);
  return parts.at(-1) ?? dir;
}

/**
 * The window's name, for the taskbar and the window switcher.
 *
 * `document.title` only — with no frame there is nothing else to set, and nothing on screen shows
 * it. The strip along the top of the body used to, and the caption was removed: it named the
 * project, which the sidebar names, and then the open path, which the address bar in that very
 * strip states properly. Outside the window the pair is still what identifies this one, because
 * "JaiRA" alone is what every window of this app would say.
 */
function windowTitle(project: string | null, view: View | "settings", doc: string | null): string {
  const where = project === null ? "no project" : projectName(project);
  const what = view === "files" && doc !== null ? doc : (VIEWS.find((v) => v.id === view)?.label ?? "Settings");
  return `${where} · ${what}`;
}

/**
 * The Settings sections.
 *
 * `layered` marks the ones the layer switch applies to. History is a project's run journal — there is
 * no shared version of it to edit — so showing the switch above it would offer a choice that changes
 * nothing. `needsProject` marks the ones with nothing to say on an empty window; they are HIDDEN
 * there rather than shown empty, because a section that cannot do anything is a section that should
 * not be offered.
 *
 * Providers and Executors are the two halves of one question that used to be one tab and answered
 * neither half: *what can run here* and *what actually gets used*. "Anthropic has a key" and
 * "prompts go to Anthropic" are different facts, and one row with one checkbox was being asked to
 * mean both.
 */
const SECTIONS: Array<{ id: SettingsSection; label: string; layered: boolean; needsProject?: boolean }> = [
  { id: "providers", label: "Providers", layered: true },
  { id: "executors", label: "Executors", layered: true },
  { id: "config", label: "Configuration", layered: true },
  { id: "history", label: "History", layered: false, needsProject: true },
];

/**
 * The approvals strip.
 *
 * Command approvals come first: an agent's tool loop is blocked until one is answered, whereas a
 * workflow gate is a state politely waiting. Both live here rather than in a sidebar, because this
 * is the only surface in the app that is genuinely interrupt-driven.
 */
function InboxStrip({
  pending,
  approvals,
  onSelect,
}: {
  pending: PendingInteraction[];
  approvals: PendingApproval[];
  onSelect: (taskId: string) => void;
}): JSX.Element | null {
  const total = pending.length + approvals.length;
  if (total === 0) return null;
  const shown = [
    ...approvals.slice(0, 2).map((item) => ({
      key: item.requestId,
      badge: "badge-blocked",
      glyph: "⛔",
      text: item.command ?? item.tool,
      title: item.reason ?? "",
      taskId: item.taskId,
    })),
    ...pending.slice(0, 2).map((item) => ({
      key: item.requestId,
      badge: "badge-waiting_for_user",
      glyph: "⏸",
      text: item.config?.prompt ?? item.component,
      title: item.component,
      taskId: item.taskId as string | undefined,
    })),
  ].slice(0, 3);
  return (
    <footer className="strip">
      <span className="strip-label">Awaiting you</span>
      <span className="chip chip-warn">{total}</span>
      {shown.map((item) => (
        <span
          key={item.key}
          className="strip-item"
          title={item.title}
          onClick={() => (item.taskId ? onSelect(item.taskId) : undefined)}
        >
          <span className="sep" />
          <span className={`badge ${item.badge}`}>{item.glyph}</span>
          <span className="ellip">{item.text}</span>
        </span>
      ))}
      {total > shown.length ? <span className="sub more">+{total - shown.length} more</span> : null}
    </footer>
  );
}

export default function App(): JSX.Element {
  const { state, actions } = useApp();
  /**
   * The remembered layout — every pane size, fold and collapsed branch in the window.
   *
   * It reads out of `settings.json` (see `uiState.ts`) rather than out of `useState`, which is the
   * one thing that makes a dragged divider or a folded branch outlive the window. Held per CONTROL
   * rather than per view: the layout of Files has nothing to say about the layout of Tasks, and one
   * tree width dragged narrow should not follow you into a board.
   */
  const ui = state.settings.ui;
  /**
   * Which diagnostic the inspector last asked the editor to show.
   *
   * Held here because the two are siblings: the inspector is the right column and the editor is the
   * middle one, and neither is inside the other. The nonce is what makes clicking the same issue
   * twice mean "show me again" rather than nothing — see `FileSurfaceContext.revealIssue`.
   */
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  /**
   * Which reading the Files viewer is showing — a board, or the conversation.
   *
   * Held here rather than in the panel for the reason the layout is: it is set from the panel's top
   * bar and has to survive clicking another file, which unmounts everything below that bar. Unlike
   * the layout it is session-scoped ON PURPOSE — it says what you are currently reading about one
   * run, not how you like the window arranged, and restoring it a week later would answer a question
   * nobody had asked yet.
   */
  const [runMode, setRunMode] = useState<"board" | "conversation">("board");
  const { board, detail, pending, view } = state;

  /**
   * The files with unsaved edits, as the `layer:path` keys the tree rows are identified by.
   *
   * The map holds differences from disk only (see `drafts.ts`), so its keys ARE the dirty set — no
   * second flag to keep in step with it.
   */
  const dirtyFiles = useMemo(() => new Set(Object.keys(state.drafts)), [state.drafts]);

  /**
   * What the shell can lend a changeset reviewer beyond the defaults (CHANGESETS.md §8.2): the
   * unsaved-edit map, and a way into the editor. Supplied to BOTH hosts — the gate modal and the
   * conversation view — because a host's reach, not the component, is what decides these exist.
   */
  const reviewerServices = useMemo(
    () => ({
      drafts: new Map(Object.entries(state.drafts)),
      openFile: (layer: string, path: string) => {
        actions.setView("files");
        actions.openPath(layer as WorkflowLayer, path);
      },
    }),
    [state.drafts, actions],
  );

  /**
   * The parked changeset gate whose task's conversation is ON SCREEN — §8.1's default host. `about`
   * joins a review run to the task whose worktree it reviews; the review task itself matches too,
   * for a reader who followed the run into JaiRA's own project. Everything else keeps the modal.
   */
  const inlineGate =
    view === "tasks" &&
    detail !== null &&
    pending[0] !== undefined &&
    pending[0].component === "user-approve-changeset" &&
    (pending[0].about === detail.taskId || pending[0].taskId === detail.taskId)
      ? pending[0]
      : null;

  /**
   * The Files tree's folded branches.
   *
   * Built once per render rather than inside the map over rows: `shutOf` materialises a Set, and
   * asking it per row would build one per row on the screen to answer one question about each.
   */
  const foldedFolders = useMemo(() => shutOf(ui, SHUT.folders), [ui]);

  /**
   * Which board group the Tasks column is scrolled to, while it is showing all of them.
   *
   * The address bar over the column is the header of the section you are IN — see `taskBar.tsx` —
   * and this is what tells it which that is. Measured rather than tracked in the store, because it
   * is a fact about where a scrollbar is: nothing outside this column can change it, and nothing
   * outside this column has a use for it.
   */
  const boardsRef = useRef<HTMLDivElement | null>(null);
  const [atProject, setAtProject] = useState<string | null>(null);
  const trackBoards = useCallback(() => {
    const column = boardsRef.current;
    if (column === null) return;
    // The LAST group whose top has passed the top of the column — the one under the bar. Measured
    // against the viewport rather than with `offsetTop`, which is relative to whichever ancestor
    // happens to be positioned and so would silently answer a different question after a restyle.
    const top = column.getBoundingClientRect().top;
    let at: string | null = null;
    for (const group of column.querySelectorAll<HTMLElement>("[data-project]")) {
      if (group.getBoundingClientRect().top - top <= 1) at = group.dataset.project ?? null;
    }
    setAtProject((was) => (was === at ? was : at));
  }, []);

  // Groups arriving, folding, or being narrowed away all move the boundaries this is measuring, and
  // none of them is a scroll — so the answer is recomputed whenever the column's contents change.
  useEffect(trackBoards, [trackBoards, state.projects, state.boards, state.taskFocus, view]);

  /**
   * The tasks standing at the level the Tasks walk began from — the base run crumb's alternatives.
   *
   * The Files bar takes these from the open state's own board; here the board is the one the column
   * is drawing, so they are its cards. Flattened across the columns because at this level they are
   * all runs OF this level, whichever child each has gone on into.
   */
  const taskLevelCards = useMemo(() => {
    const board = state.taskFocus === null ? null : state.boards[state.taskFocus];
    return board === null || board === undefined ? [] : [...board.atLevel, ...board.columns.flatMap((c) => c.cards)];
  }, [state.boards, state.taskFocus]);

  /**
   * The sidebar's two remembered numbers: how wide, and whether it is showing at all.
   *
   * The fold is stored POSITIVELY — `shell.sidebar` open means the sidebar is open — so that a
   * settings file written before this existed opens the app with the sidebar showing rather than
   * with the window's navigation collapsed for no reason anybody could reconstruct.
   */
  const sidebarShut = !openOf(ui, FOLD.shellSidebar);
  const sidebarWidth = paneOf(ui, PANE.shellSidebar);

  // The window's name outside the window — see {@link windowTitle}. Nothing on screen shows it.
  const title = windowTitle(state.projectDir, view, state.doc?.path ?? state.dir?.path ?? null);
  useEffect(() => {
    document.title = `${title} — JaiRA`;
  }, [title]);

  // The interaction the selected task is parked on, if any — what the leaf conversation pins.
  const waiting = pending.find((p) => p.taskId === state.selected);

  /**
   * The open state's declared inputs, read from the SAVED document.
   *
   * Memoised on the text rather than recomputed per render: this parses the file, and it sits above
   * a form whose every keystroke re-renders the column. `doc.text` and not the draft — a run pins
   * what is on disk (DESIGN §5.3), so boxes built from unsaved typing would describe inputs the run
   * is not going to have. The panel says so instead.
   */
  const runFields = useMemo(
    () => (state.doc === null || state.doc.stateId === undefined ? null : runFieldsOf(state.doc.text, state.doc.mime)),
    [state.doc],
  );

  /**
   * Starting a run of the open state, and what has run before.
   *
   * Assembled here for the same reason the file surfaces are: the inspector renders a column and
   * should not also know how a task gets made. Absent when the open file is not a state — which is
   * what keeps the Run section off a prompt.
   */
  const runSurface: RunSurface | undefined = ((): RunSurface | undefined => {
    const doc = state.doc;
    if (doc === null || doc.stateId === undefined) return undefined;
    // The LAYER decides where it runs: the shared root is JaiRA's own project, a project file is the
    // open checkout's. Same routing a base-layer description sync uses — see `runTargetOf`.
    const target = runTargetOf(doc.layer, state.projectDir);
    const dir =
      target.project === undefined
        ? (state.projectDir ?? undefined)
        : state.projects.find((p) => p.kind === "shared")?.project;
    return {
      fields: runFields,
      // Declared defaults underneath, what has been typed over the top. See `AppState.runValues`:
      // the map is sparse, so a box nobody has touched shows its default and a box someone
      // emptied stays empty.
      values: { ...initialRunValues(runFields ?? []), ...(state.runValues[doc.stateId] ?? {}) },
      target,
      targetDir: dir,
      exists: doc.exists,
      dirty: dirtyFiles.has(`${doc.layer}:${doc.path}`),
      busy: state.busy,
      // The target's task list, so "started here" is read out of the database the button writes to.
      tasks: target.project === undefined ? state.tasks : state.sharedTasks,
      selected: state.selected,
      onChange: (name, text) => actions.setRunValue(doc.stateId ?? "", name, text),
      onRun: (title, inputs) => void actions.runState(doc.stateId ?? "", title, inputs, target.project),
      onSelectTask: actions.select,
    };
  })();

  /**
   * Everything a file surface may need beyond the file itself.
   *
   * Assembled here, once, rather than threaded through {@link FilePanel}: the panel decides geometry
   * and nothing else, so it has no business knowing that a workflow viewer wants the board and a
   * config editor wants both configuration layers. Each surface reads the fields it actually uses.
   */
  const surfaces: FileSurfaceContext = {
    state: state.state,
    config: state.config,
    tree: state.tree,
    executors: state.executors,
    // The scope every task-scoped channel needs. Omitted, a task in the shared or system project
    // answers `no project is open`, because the focus never points at either.
    ...(state.selectedProject !== null ? { project: state.selectedProject } : {}),
    selected: state.selected,
    conversation: state.conversation,
    detail,
    sessions: state.sessions,
    onLoadSession: actions.loadSession,
    onLoadSessions: actions.loadSessions,
    sessionHistory: state.sessionHistory,
    session: state.session,
    sessionInstance: state.sessionInstance,
    liveTurn: state.liveTurn,
    onShowSession: actions.showSession,
    waiting: waiting ? { component: waiting.config?.prompt ?? waiting.component } : undefined,
    onSelectTask: actions.select,
    onDrill: actions.selectState,
    // The address bar's tail and the viewer read the same list: the bar draws it, the viewer shows
    // its last element. See `trail.ts`.
    trail: state.trail,
    trailState: state.trailState,
    onWalkInto: actions.walkInto,
    onWalkIntoSidechain: actions.walkIntoSidechain,
    onWalkTo: actions.walkTo,
    onOpenFile: actions.openPath,
    onOpenDir: actions.openDir,
    onOpenProject: () => actions.chooseProject("open"),
    runMode,
    onRunMode: setRunMode,
    onAnswer: waiting ? () => actions.select(waiting.taskId) : undefined,
    onSaveConfig: actions.saveConfig,
    validateSchema: actions.validateSchema,
    stateSlots: actions.stateSlots,
    schemaChoice: state.schemaChoice,
    onSchemaChoice: actions.setSchemaChoice,
    drafts: state.drafts,
    onDraft: actions.setDraft,
    // The same store the shell's own dividers and folds write to, reached by name. A surface with a
    // pane of its own — the JSON editor's field reference is the one — therefore remembers it the
    // same way the columns around it do, without the shell having to know that pane exists.
    ui: {
      pane: (id, fallback) => ui.panes[id] ?? fallback,
      setPane: actions.setPane,
      open: (id, fallback) => ui.open[id] ?? fallback,
      setOpen: actions.setFold,
    },
    // The description's viewer, and the one surface that can write to files other than the open one
    // — a proposed state file becomes a draft against its own row in the tree.
    sync: {
      status: state.sync.status,
      result: state.sync.result,
      running: state.sync.running,
      error: state.sync.error,
      progress: state.sync.progress,
      refresh: actions.syncStatus,
      run: actions.runSync,
      cancel: actions.cancelSync,
      openEdit: actions.openSyncEdit,
      openDocument: actions.openPath,
      reviewChangeset: actions.reviewSyncChangeset,
    },
    editorTab: state.editorTab,
    onEditorTab: actions.setEditorTab,
    detectSchema: actions.detectSchema,
    wrapJson: state.settings.wrapJson,
    onWrapJson: actions.setWrapJson,
    revealIssue: reveal,
  };

  /**
   * The sidebar's rows, with the drawer each one opens onto.
   *
   * Built here rather than in the sidebar because the drawers are the app's — a file tree wired to
   * eight actions, a section list wired to one — and a navigation column that knew how to construct
   * either would be a navigation column that had to be handed the whole store. It takes rows.
   */
  const rows: SidebarView[] = VIEWS.map((v) =>
    v.id !== "files"
      ? v
      : {
          ...v,
          open: openOf(ui, FOLD.shellFiles),
          onOpen: (open: boolean) => actions.setFold(FOLD.shellFiles, open),
          panel: (
            <FileTreePanel
              tree={state.tree}
              selected={state.doc ? { layer: state.doc.layer, path: state.doc.path } : null}
              // Which rows have edits that are not on disk. Now that a draft outlives the editor
              // showing it, this is the only thing that says so about a file you are not looking
              // at — and an unsaved change nobody can see is one that gets closed with the window.
              dirty={dirtyFiles}
              // Which branches are folded, and where a click on a twisty goes. Both come from the
              // saved layout rather than from the panel's own state, which is what makes the shape
              // of the tree the thing you left it as rather than a fresh full expansion.
              collapsed={foldedFolders}
              onToggleCollapsed={(key) => actions.toggleShut(SHUT.folders, key)}
              busy={state.busy}
              hasProject={state.projectDir !== null}
              onSelect={actions.selectFile}
              onOpen={actions.openWorkflow}
              onCreate={actions.createWorkflow}
              onCreateFile={actions.createFile}
              onMove={actions.moveWorkflow}
              onDelete={actions.deleteWorkflow}
              onRenameFile={actions.renameFile}
              onDeleteFile={actions.deleteFile}
              onReveal={actions.revealFile}
            />
          ),
        },
  );

  const settingsRow: SidebarView = {
    id: "settings",
    glyph: "⚙",
    label: "Settings",
    open: openOf(ui, FOLD.shellSections),
    onOpen: (open: boolean) => actions.setFold(FOLD.shellSections, open),
    panel: (
      <ul className="sections">
        {SECTIONS.filter((s) => !s.needsProject || state.projectDir !== null).map(({ id, label }) => (
          <li key={id} className={state.section === id ? "sel" : undefined} onClick={() => actions.setSection(id)}>
            {label}
          </li>
        ))}
      </ul>
    ),
  };

  return (
    <div
      className="app"
      style={{ "--sidebar": `${sidebarShut ? SIDEBAR_RAIL : sidebarWidth}px` } as CSSProperties}
    >
      <Sidebar
        views={rows}
        settings={settingsRow}
        view={view}
        onView={(id) => actions.setView(id as View)}
        collapsed={sidebarShut}
        onCollapsed={(shut) => actions.setFold(FOLD.shellSidebar, !shut)}
        project={state.projectDir}
        projectLabel={projectName(state.projectDir)}
        busy={state.busy}
        theme={state.settings.theme}
        onTheme={actions.setTheme}
        onChooseProject={(mode) => void actions.chooseProject(mode)}
      />

      {/* No divider on a collapsed sidebar: the rail is a fixed strip of glyphs, and a handle that
          dragged it wider would be a handle that undid the collapse without saying so. */}
      {sidebarShut ? null : (
        <Splitter
          label="Resize the sidebar"
          value={sidebarWidth}
          reset={paneDefault(PANE.shellSidebar)}
          min={180}
          max={520}
          onChange={(size) => actions.setPane(PANE.shellSidebar, size)}
        />
      )}

      <div className="body">
        {/*
          The top of the window: the ADDRESS of what is open, and nothing else.

          It is a strip over the body and NOT over the sidebar, which is the whole point of the
          arrangement: the sidebar runs from the top of the window to the bottom, and the columns
          under this strip run from just below it to the bottom. It spans the inspector as well as
          the two halves below it, which is why the bar is assembled here rather than by the panel
          that used to own it — see `FileAddressBar`.

          There was a caption in this row saying "no project · workflows/plan.json". It is gone: the
          path already says the second half, the sidebar already says the first, and a title that
          restates its neighbours is a title nobody reads twice. What is left of it is
          `document.title`, which the taskbar reads and no frame supplies any more.

          The filler beside it is what you grab to move the window, and it holds the gutter the OS
          draws its own three buttons into — see `--wco-right` in the stylesheet, and
          `titleBarOverlay` in `main/index.ts`. It is a separate element because a drag region
          swallows clicks, and the crumbs in the bar have to stay clickable.
        */}
        <header className="title-bar">
          {view === "files" ? (
            <FileAddressBar
              doc={state.doc}
              dir={state.dir}
              context={surfaces}
              onWalkBack={actions.walkBackTo}
              onInspect={actions.inspectState}
            />
          ) : null}
          {/*
            The same row, over the other view. The Tasks column used to carry a breadcrumb PER board
            group, stacked down the page — so "where am I" moved as you scrolled and there were as
            many answers as you had checkouts open. One address, in the row the Files view puts its
            own in, is what makes the two views one app.
          */}
          {view === "tasks" ? (
            <TaskAddressBar
              projects={state.projects}
              focus={state.taskFocus}
              at={atProject}
              boards={state.boards}
              trail={state.trail}
              run={{
                instances: detail?.instances ?? [],
                // The other tasks standing where this walk began — the same set the Files bar offers
                // under the base run's chevron, taken from the board rather than from a StateView.
                runs: taskLevelCards,
                selectedTask: state.selected,
                ...(detail?.title !== undefined ? { taskTitle: detail.title } : {}),
                onWalkTo: actions.walkTo,
                onSelectTask: (taskId) => actions.select(taskId, state.selectedProject ?? undefined),
              }}
              onFocus={actions.focusProject}
              onDrill={actions.drillProject}
              onWalkBack={actions.walkBackTo}
              onOpenProject={() => void actions.chooseProject("open")}
              tools={
                <>
                  {/* Which reading of the run is on screen, in the row that says which run it is —
                      the same place, and the same control, as the Files view's. */}
                  {state.trail.length > 0 && state.taskFocus !== null ? (
                    <RunModeToggle mode={runMode} onMode={setRunMode} />
                  ) : null}
                  {/* Only the focused project can be created into: a task belongs to a checkout, and
                      JaiRA's own runs are started by JaiRA. */}
                  {(state.taskFocus ?? atProject) === state.projectDir && state.projectDir !== null ? (
                    <NewTask onCreate={actions.createTask} busy={state.busy} />
                  ) : null}
                </>
              }
            />
          ) : null}
          <span className="title-drag" />
        </header>

        <div className="viewport">
          {view === "files" ? (
            <div
              className="view files-view"
              style={{ "--pane-right": `${paneOf(ui, PANE.filesInspector)}px` } as CSSProperties}
            >
              <FilePanel
                doc={state.doc}
                dir={state.dir}
                busy={state.busy}
                context={surfaces}
                viewerHeight={paneOf(ui, PANE.filesViewer)}
                onViewerHeight={(size) => actions.setPane(PANE.filesViewer, size)}
                configOpen={openOf(ui, FOLD.filesEditor)}
                onConfigOpen={(open) => actions.setFold(FOLD.filesEditor, open)}
                onSave={actions.saveDoc}
              />

              <Splitter
                label="Resize the inspector"
                value={paneOf(ui, PANE.filesInspector)}
                reset={paneDefault(PANE.filesInspector)}
                invert
                min={220}
                max={680}
                onChange={(size) => actions.setPane(PANE.filesInspector, size)}
              />

              <aside className="col panel">
                {/*
                  The context panel describes the LAST ELEMENT OF THE ADDRESS BAR, always: the run
                  the path ends on, or the open file when no run is on it. One rule, decided by the
                  bar rather than by a mode, which is what stops the two from disagreeing — the panel
                  used to keep describing a file while the path beside it stood on a run.

                  The task is the one exception, and it is reached only by asking for it on the run's
                  own panel: a run belongs to a task, but a task is not a level of the address and
                  cannot be navigated to. Any change to the bar drops back to the rule.
                */}
                {state.inspect === "task" ? (
                  <TaskInspector
                    stateId={state.inspectFrom}
                    detail={detail}
                    stream={state.stream}
                    states={state.sessionHistory}
                    showing={state.sessionInstance}
                    onOpenState={actions.selectState}
                    onOpenStateAt={actions.openStateAt}
                    onBack={actions.inspectState}
                    // In the project that HOLDS it. Clicking a shared workflow's run in the history
                    // section selects a task in JaiRA's own project, and starting or cancelling it
                    // against the open checkout would answer "unknown task".
                    onStart={() =>
                      detail ? actions.startTask(detail.taskId, undefined, state.selectedProject ?? undefined) : undefined
                    }
                    onCancel={() =>
                      detail ? actions.cancelTask(detail.taskId, state.selectedProject ?? undefined) : undefined
                    }
                  />
                ) : state.trail.length > 0 ? (
                  <RunInspector
                    node={nodeAt(detail?.instances ?? [], state.trail.at(-1)!.instanceId) ?? null}
                    stateId={state.trail.at(-1)!.stateId}
                    detail={detail}
                    stream={state.stream}
                    states={state.sessionHistory}
                    depth={state.trail.length}
                    onBack={() => actions.walkBackTo(state.trail.length - 2)}
                    onShowTask={actions.inspectTask}
                    onStart={() =>
                      detail ? actions.startTask(detail.taskId, undefined, state.selectedProject ?? undefined) : undefined
                    }
                    onCancel={() =>
                      detail ? actions.cancelTask(detail.taskId, state.selectedProject ?? undefined) : undefined
                    }
                    onOpenState={actions.selectState}
                  />
                ) : state.dir !== null ? (
                  // A folder is the end of the address too, so it is what the panel describes.
                  <FolderInspector layer={state.dir.layer} path={state.dir.path} tree={state.tree} />
                ) : (
                  <FileInspector
                    doc={state.doc}
                    state={state.state}
                    run={runSurface}
                    onRevealIssue={(path) => setReveal((last) => ({ path, nonce: (last?.nonce ?? 0) + 1 }))}
                  />
                )}
              </aside>
            </div>
          ) : null}

          {view === "tasks" ? (
            <div
              className={`view tasks-view${state.taskFocus !== null ? " narrowed" : ""}`}
              style={{ "--pane-right": `${paneOf(ui, PANE.tasksPanel)}px` } as CSSProperties}
            >
              {/*
                A RUN is on the path, so the column shows that run — its executions as cards, or what
                it said. The board is the level above it and the address still holds every step back
                out to it. Exactly what the Files view shows for the same path, reached by drilling
                instead of by opening a file: see `RunView`.
              */}
              {state.trail.length > 0 && state.taskFocus !== null ? (
                <div className="col mid">
                  <RunView context={surfaces} />
                </div>
              ) : (
              <div className="col mid" ref={boardsRef} onScroll={trackBoards}>
                {/*
                  ONE BOARD PER PROJECT, grouped — the user's checkout, and JaiRA's own runs beneath it.
                  Grouped rather than merged because a board's columns are the children of ONE workflow
                  state: columns from two projects side by side would be columns of different things.
                  Each group keeps its own drill level, because drilling into one is not a statement
                  about the other.

                  NARROWED to one group once a project is chosen in the address bar, because the path
                  up there then describes levels that exist inside that project only — a column still
                  listing the others would be a screen the address was half true of. Unchosen, every
                  group is a section of one list and each header sticks under the bar as you reach it.
                */}
                {state.projects.length === 0 ? <p className="empty">Open a project to see its board.</p> : null}
                {state.projects
                  .filter((p) => state.taskFocus === null || p.project === state.taskFocus)
                  .map((p, i) => (
                    <section key={p.project} className="board-group" data-project={p.project}>
                      {/*
                        A header per section, EXCEPT the first — which is the one the address bar is
                        already naming when you are at the top of the column, and two rows saying the
                        same project one under the other is one row too many. The rest scroll up out
                        of view as you reach them, and the bar takes over from each in turn.

                        Not shown at all when the column is narrowed to one project: then the bar is
                        that project's header, whatever you have scrolled to.
                      */}
                      {i > 0 && state.taskFocus === null ? (
                        // The SAME control, standing on this project rather than on the scrolled-to
                        // one. Identical by construction and not by a stylesheet that has to be kept
                        // in step, which is what makes scrolling past a section read as the bar
                        // above taking that row's place rather than as two rows that resemble
                        // each other.
                        <TaskAddressBar
                          projects={state.projects}
                          focus={null}
                          at={p.project}
                          boards={state.boards}
                          trail={[]}
                          onFocus={actions.focusProject}
                          onDrill={actions.drillProject}
                          onWalkBack={actions.walkBackTo}
                          onOpenProject={() => void actions.chooseProject("open")}
                        />
                      ) : null}
                      {state.boards[p.project] ? (
                        <Board
                          board={state.boards[p.project]!}
                          selected={state.selectedProject === p.project ? state.selected : null}
                          numbered={state.boards[p.project]!.level !== ""}
                          onSelectTask={(taskId) => actions.select(taskId, p.project)}
                          onDrill={(level) => actions.drillProject(p.project, level)}
                          // Double-clicking a COLUMN opens that state and every task in it;
                          // double-clicking a CARD opens that one run. The level a run is walked into
                          // at is the board's own, except at the root listing — where the columns are
                          // workflows and the level below the listing is the card's own workflow.
                          onOpenTask={(card) =>
                            actions.openTask(
                              card.taskId,
                              p.project,
                              state.boards[p.project]!.level === "" ? card.workflow : state.boards[p.project]!.level,
                            )
                          }
                        />
                      ) : (
                        <p className="empty">No board here yet.</p>
                      )}
                    </section>
                  ))}
                {/*
                  Room to scroll past the end.
                  Without it the LAST group can never reach the top of the column, so it can never
                  become the section the bar is naming — the bar would sit on the second-to-last
                  project while you were looking at the last one. Only while there is more than one
                  group: with one, there is nothing to scroll between and this would be a screen of
                  blank under a single board.
                */}
                {state.taskFocus === null && state.projects.length > 1 ? <div className="board-tail" /> : null}
              </div>
              )}

              <Splitter
                label="Resize the task panel"
                value={paneOf(ui, PANE.tasksPanel)}
                reset={paneDefault(PANE.tasksPanel)}
                invert
                min={260}
                max={760}
                onChange={(size) => actions.setPane(PANE.tasksPanel, size)}
              />

              <aside className="col panel">
                {/*
                  What a click on a card gets you: that task's CONVERSATION. Clicking a card asks what
                  the run said, and the panel used to answer with an instance tree and a list of event
                  types — facts about the run, none of which is the run — so reading one meant leaving
                  for the Files view to find the transcript. The detail is still here, behind the
                  toggle in the header, which is the order they are wanted in.
                */}
                {detail ? (
                  <TaskContext
                    detail={detail}
                    stream={state.stream}
                    context={surfaces}
                    onStart={() => actions.startTask(detail.taskId, undefined, state.selectedProject ?? undefined)}
                    onCancel={() => actions.cancelTask(detail.taskId, state.selectedProject ?? undefined)}
                    onReviewChanges={() => actions.reviewChanges(detail.taskId, state.selectedProject ?? undefined)}
                    onOpenState={(stateId) => {
                      actions.setView("files");
                      actions.selectState(stateId);
                    }}
                    {...(inlineGate !== null
                      ? {
                          gate: inlineGate,
                          onGate: (value: unknown) => actions.answer(inlineGate.requestId, value),
                          gateServices: reviewerServices,
                        }
                      : {})}
                  />
                ) : (
                  <p className="empty">Select a task.</p>
                )}
              </aside>
            </div>
          ) : null}

          {view === "logs" ? (
            <div className="view logs-view">
              <LogsPanel
                entries={state.logs}
                output={state.jobOutput}
                onOpenJob={(jobId) => void actions.openJobOutput(jobId)}
                onOpenTask={(taskId) => {
                  // Into the task, in the view that shows one — a link that only filtered this list
                  // would answer "where do I look next" with "here".
                  actions.setView("tasks");
                  actions.select(taskId);
                }}
                onClearOutput={actions.closeJobOutput}
              />
            </div>
          ) : null}

          {view === "debug" ? (
            <DebugPane
              debug={state.debug}
              detail={detail}
              conversation={state.conversation}
              sessionHistory={state.sessionHistory}
              session={state.session}
              sessionInstance={state.sessionInstance}
              liveTurn={state.liveTurn}
              stream={state.stream}
              availability={state.availability}
              hasProject={state.projectDir !== null}
              onRun={(options) => void actions.debugRun(options)}
              onCancel={() => void actions.debugCancel()}
              onInstall={(force) => void actions.debugInstall(force)}
              onRecheck={actions.debugRefresh}
              onDismissError={actions.debugDismissError}
              onOpenState={(stateId) => void actions.openWorkflow(stateId, "base")}
              onShowSession={actions.showSession}
            />
          ) : null}

          {view === "settings" ? (
            /* One column now. The section list moved into the sidebar's accordion, and the project
               row went with it — "which project is this" is a fact about the WINDOW, so it belongs
               in the window's own address bar rather than restated at the foot of one view. Opening
               another one is the chevron beside it. */
            <div className="view settings-view">
              <div className="col mid settings-body">
                <SettingsHeader
                  section={state.section}
                  layer={state.configLayer}
                  hasProject={state.projectDir !== null}
                  busy={state.busy}
                  rechecking={state.rechecking}
                  checkedAt={state.availability.checkedAt}
                  onLayer={actions.setConfigLayer}
                  onRecheck={actions.recheckAvailability}
                />
                {state.section === "config" ? (
                  <ConfigPane
                    config={state.config}
                    layer={state.configLayer}
                    busy={state.busy}
                    editable={state.configLayer === "base" || state.projectDir !== null}
                    onSave={actions.saveConfig}
                  >
                    <SettingsPane
                      config={state.config}
                      layer={state.configLayer}
                      busy={state.busy}
                      drafts={state.drafts}
                      onDraft={actions.setDraft}
                      onSave={actions.saveConfig}
                      showEffective={openOf(ui, FOLD.settingsEffective)}
                      onShowEffective={(open) => actions.setFold(FOLD.settingsEffective, open)}
                    />
                  </ConfigPane>
                ) : null}
                {state.section === "providers" ? (
                  <ProvidersPane
                    config={state.config}
                    executors={state.executors}
                    routeProbes={state.modelProbes}
                    executorProbes={state.probes}
                    secrets={state.secrets}
                    busy={state.busy}
                    layer={state.configLayer}
                    editable={state.configLayer === "base" || state.projectDir !== null}
                    onSaveRoute={actions.saveModels}
                    onSaveExecutor={actions.setExecutorConfig}
                    onAdd={actions.addExecutor}
                    onRemove={actions.removeExecutor}
                    onSaveCredential={actions.saveCredential}
                  />
                ) : null}
                {state.section === "executors" ? (
                  <ExecutorsPane
                    config={state.config}
                    executors={state.executors}
                    probes={state.probes}
                    availability={state.availability}
                    busy={state.busy}
                    layer={state.configLayer}
                    editable={state.configLayer === "base" || state.projectDir !== null}
                    onSaveModels={actions.saveModels}
                    onSaveExecutor={actions.setExecutorConfig}
                    onSaveDefinition={actions.saveDefinition}
                  />
                ) : null}
                {state.section === "history" && state.projectDir !== null ? (
                  <History
                    size={state.history}
                    report={state.prune}
                    busy={state.busy}
                    onPreview={actions.planPrune}
                    onApply={actions.applyPrune}
                    onDismiss={actions.dismissPrune}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <InboxStrip pending={pending} approvals={state.approvals} onSelect={actions.select} />
      </div>

      {state.approvals.length > 0 ? (
        <ApprovalDialog
          pending={state.approvals[0]!}
          error={state.error}
          onDecide={(decision, scope) => actions.decideApproval(state.approvals[0]!.requestId, decision, scope)}
        />
      ) : pending.length > 0 && inlineGate === null ? (
        // The modal is the FALLBACK host now, not the only one (CHANGESETS.md §8.1): a changeset
        // gate whose task's conversation is on screen renders there instead — see `inlineGate`.
        <InteractionDialog
          pending={pending[0]!}
          error={state.error}
          onSubmit={(value) => actions.answer(pending[0]!.requestId, value)}
          services={reviewerServices}
        />
      ) : null}

      {state.error ? (
        <div className="toast" onClick={actions.dismissError}>
          {state.error}
        </div>
      ) : null}
    </div>
  );
}
