/**
 * The shell (DESIGN §11.1).
 *
 * One rail, three views. The app has exactly two activities — designing the states and operating the
 * runs — and they used to compete for the same three columns, so opening any settings pane evicted
 * the task you were watching. They are separate rooms now:
 *
 *  - **Files** designs. The tree opens any file; the middle shows it as a viewer over an editor,
 *    both chosen by file type in the surface registry; the inspector describes what you last clicked.
 *  - **Tasks** operates. The same board, reached by drilling a path instead of by clicking a file,
 *    with the selected task's detail beside it.
 *  - **Settings** holds everything that was never one of the two: configuration, executors,
 *    credentials, history.
 *
 * Two more sit beside them and belong to neither: **Logs** is what the app said about itself, and
 * **Debug** (DESIGN §11.3) runs a two-state workflow against this installation so that "does any of
 * this work" is a button rather than an afternoon.
 *
 * The approvals strip spans all three. A blocked tool loop is the one thing that must never scroll
 * away, and it stays visible while you are deep in the Files tree.
 */
import { useMemo, useState, type CSSProperties, type JSX } from "react";
import type { ConfigLayer, PendingApproval, PendingInteraction } from "@jaira/shared/browser";
import { Board, PathBar } from "./board";
import { ApprovalDialog, InteractionDialog } from "./components";
import { TaskPanel } from "./detail";
import { FileInspector, FilePanel, FileTreePanel, TaskInspector, VIEWER_HEIGHT } from "./files";
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
import { Splitter } from "./splitter";
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

const RAIL: Array<[View, string, string]> = [
  ["files", "❏", "Files"],
  ["tasks", "▶", "Tasks"],
  ["logs", "≡", "Logs"],
  // On the rail rather than inside Settings: the self-test is the thing you reach for when the app
  // is not behaving, and burying it behind a configuration screen would make it hardest to find in
  // exactly the situation it exists for.
  ["debug", "⌁", "Debug"],
];

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
 * The side-pane widths, and what a double-click on a divider restores.
 *
 * These are the numbers the stylesheet used to hard-code. They moved here because a splitter needs a
 * value to write and a default to go back to, and having the two in different files is how a "reset"
 * ends up restoring a width that was changed months ago in the other one.
 *
 * Held per VIEW rather than shared, for the reason the views are siblings in the first place: the
 * layout of Files has nothing to say about the layout of Tasks, and one tree width dragged narrow
 * should not follow you into a board.
 *
 * `filesTop` is the odd one: a HEIGHT, and the only horizontal divider in the app. It lives here
 * anyway, because what it is really about is the same thing the others are — this window's layout
 * surviving a click on another file.
 */
const PANE_DEFAULTS = {
  filesLeft: 250,
  filesRight: 300,
  filesTop: VIEWER_HEIGHT,
  tasksRight: 360,
  settingsLeft: 214,
};

type PaneWidths = typeof PANE_DEFAULTS;

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
  // Session-scoped, like the schema choice: a pane width is a view preference about this window, and
  // writing it to disk would mean deciding which configuration layer it belonged to.
  const [panes, setPanes] = useState<PaneWidths>(PANE_DEFAULTS);
  /**
   * Which diagnostic the inspector last asked the editor to show.
   *
   * Held here because the two are siblings: the inspector is the right column and the editor is the
   * middle one, and neither is inside the other. The nonce is what makes clicking the same issue
   * twice mean "show me again" rather than nothing — see `FileSurfaceContext.revealIssue`.
   */
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  const { board, detail, pending, view } = state;

  /**
   * The files with unsaved edits, as the `layer:path` keys the tree rows are identified by.
   *
   * The map holds differences from disk only (see `drafts.ts`), so its keys ARE the dirty set — no
   * second flag to keep in step with it.
   */
  const dirtyFiles = useMemo(() => new Set(Object.keys(state.drafts)), [state.drafts]);

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
    selected: state.selected,
    conversation: state.conversation,
    detail,
    sessions: state.sessions,
    onLoadSession: actions.loadSession,
    sessionHistory: state.sessionHistory,
    session: state.session,
    sessionInstance: state.sessionInstance,
    liveTurn: state.liveTurn,
    onShowSession: actions.showSession,
    waiting: waiting ? { component: waiting.config?.prompt ?? waiting.component } : undefined,
    onSelectTask: actions.select,
    onDrill: actions.selectState,
    onAnswer: waiting ? () => actions.select(waiting.taskId) : undefined,
    onSaveConfig: actions.saveConfig,
    validateSchema: actions.validateSchema,
    stateSlots: actions.stateSlots,
    schemaChoice: state.schemaChoice,
    onSchemaChoice: actions.setSchemaChoice,
    drafts: state.drafts,
    onDraft: actions.setDraft,
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
    },
    editorTab: state.editorTab,
    onEditorTab: actions.setEditorTab,
    detectSchema: actions.detectSchema,
    wrapJson: state.settings.wrapJson,
    onWrapJson: actions.setWrapJson,
    revealIssue: reveal,
  };

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-brand">JAIRA</div>
        {RAIL.map(([id, glyph, label]) => (
          <button
            key={id}
            className={view === id ? "on" : undefined}
            title={label}
            aria-label={label}
            aria-current={view === id ? "page" : undefined}
            onClick={() => actions.setView(id)}
          >
            {glyph}
          </button>
        ))}
        <span className="spacer" />
        {/* Theme sits on the rail, not inside Settings: it is a per-person display preference, and
            burying it behind a view that needs an open project would make it unreachable on an empty
            window. */}
        <button
          title={state.settings.theme === "dark" ? "switch to light" : "switch to dark"}
          aria-label="Toggle theme"
          onClick={() => actions.setTheme(state.settings.theme === "dark" ? "light" : "dark")}
        >
          {state.settings.theme === "dark" ? "☀" : "☾"}
        </button>
        <button
          className={view === "settings" ? "on" : undefined}
          title="Settings"
          aria-label="Settings"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={() => actions.setView("settings")}
        >
          ⚙
        </button>
      </nav>

      <div className="body">
        <div className="viewport">
          {view === "files" ? (
            <div
              className="view files-view"
              style={{ "--pane-left": `${panes.filesLeft}px`, "--pane-right": `${panes.filesRight}px` } as CSSProperties}
            >
              <FileTreePanel
                tree={state.tree}
                selected={state.doc ? { layer: state.doc.layer, path: state.doc.path } : null}
                // Which rows have edits that are not on disk. Now that a draft outlives the editor
                // showing it, this is the only thing that says so about a file you are not looking
                // at — and an unsaved change nobody can see is one that gets closed with the window.
                dirty={dirtyFiles}
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

              <Splitter
                label="Resize the file tree"
                value={panes.filesLeft}
                reset={PANE_DEFAULTS.filesLeft}
                min={170}
                max={560}
                onChange={(filesLeft) => setPanes((p) => ({ ...p, filesLeft }))}
              />

              <FilePanel
                doc={state.doc}
                busy={state.busy}
                context={surfaces}
                viewerHeight={panes.filesTop}
                onViewerHeight={(filesTop) => setPanes((p) => ({ ...p, filesTop }))}
                onSave={actions.saveDoc}
                onInspect={actions.inspectState}
              />

              <Splitter
                label="Resize the inspector"
                value={panes.filesRight}
                reset={PANE_DEFAULTS.filesRight}
                invert
                min={220}
                max={680}
                onChange={(filesRight) => setPanes((p) => ({ ...p, filesRight }))}
              />

              <aside className="col panel">
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
            <div className="view tasks-view" style={{ "--pane-right": `${panes.tasksRight}px` } as CSSProperties}>
              <div className="col mid">
                {/*
                  ONE BOARD PER PROJECT, grouped — the user's checkout, and JaiRA's own runs beneath it.
                  Grouped rather than merged because a board's columns are the children of ONE workflow
                  state: columns from two projects side by side would be columns of different things.
                  Each group carries its own breadcrumb and its own drill level, because drilling into
                  one is not a statement about the other.
                */}
                {state.projects.length === 0 ? <p className="empty">Open a project to see its board.</p> : null}
                {state.projects.map((p) => {
                  const group = state.boards[p.project] ?? null;
                  const shut = state.collapsed[p.project] === true;
                  return (
                    <section key={p.project} className={`board-group${shut ? " shut" : ""}`}>
                      <header className="board-group-head" onClick={() => actions.toggleProject(p.project)}>
                        <span className="twist">{shut ? "▸" : "▾"}</span>
                        <span className={`grow ellip ${p.kind}`} title={p.project}>
                          {p.label}
                        </span>
                        <span className="sub">
                          {p.tasks} tasks{p.running > 0 ? ` · ${p.running} running` : ""}
                        </span>
                      </header>
                      {shut ? null : (
                        <>
                          <PathBar
                            breadcrumb={group?.breadcrumb ?? []}
                            onGo={(level) => actions.drillProject(p.project, level)}
                          >
                            {/* Only the focused project can be created into: a task belongs to a
                                checkout, and JaiRA's own runs are started by JaiRA. */}
                            {p.project === state.projectDir ? (
                              <NewTask onCreate={actions.createTask} busy={state.busy} />
                            ) : null}
                          </PathBar>
                          {group ? (
                            <Board
                              board={group}
                              selected={state.selectedProject === p.project ? state.selected : null}
                              numbered={group.level !== ""}
                              onSelectTask={(taskId) => actions.select(taskId, p.project)}
                              onDrill={(level) => actions.drillProject(p.project, level)}
                            />
                          ) : (
                            <p className="empty">No board here yet.</p>
                          )}
                        </>
                      )}
                    </section>
                  );
                })}
              </div>

              <Splitter
                label="Resize the task panel"
                value={panes.tasksRight}
                reset={PANE_DEFAULTS.tasksRight}
                invert
                min={260}
                max={760}
                onChange={(tasksRight) => setPanes((p) => ({ ...p, tasksRight }))}
              />

              <aside className="col panel">
                {detail ? (
                  <TaskPanel
                    detail={detail}
                    stream={state.stream}
                    onStart={() => actions.startTask(detail.taskId)}
                    onCancel={() => actions.cancelTask(detail.taskId)}
                    onOpenState={(stateId) => {
                      actions.setView("files");
                      actions.selectState(stateId);
                    }}
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
            <div className="view settings-view" style={{ "--pane-left": `${panes.settingsLeft}px` } as CSSProperties}>
              <aside className="col side">
                <h3>Settings</h3>
                <ul className="sections">
                  {SECTIONS.filter((s) => !s.needsProject || state.projectDir !== null).map(({ id, label }) => (
                    <li
                      key={id}
                      className={state.section === id ? "sel" : undefined}
                      onClick={() => actions.setSection(id)}
                    >
                      {label}
                    </li>
                  ))}
                </ul>
                <div className="project" title={state.projectDir ?? ""}>
                  {state.projectDir ?? "no project open"}
                </div>
                {/* The only way into a project from inside the app. Everything else — the startup
                    env var, the CLI argument, the current directory — decides before the window
                    exists, which left a running app with no project permanently stuck as one. */}
                <div className="pane-actions">
                  <button className="ghost" disabled={state.busy} onClick={() => actions.chooseProject("open")}>
                    Open…
                  </button>
                  <button className="ghost" disabled={state.busy} onClick={() => actions.chooseProject("init")}>
                    New…
                  </button>
                </div>
              </aside>

              <Splitter
                label="Resize the settings sections"
                value={panes.settingsLeft}
                reset={PANE_DEFAULTS.settingsLeft}
                min={150}
                max={420}
                onChange={(settingsLeft) => setPanes((p) => ({ ...p, settingsLeft }))}
              />

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
      ) : pending.length > 0 ? (
        <InteractionDialog
          pending={pending[0]!}
          error={state.error}
          onSubmit={(value) => actions.answer(pending[0]!.requestId, value)}
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
