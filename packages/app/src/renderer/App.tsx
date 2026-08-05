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
 * The approvals strip spans all three. A blocked tool loop is the one thing that must never scroll
 * away, and it stays visible while you are deep in the Files tree.
 */
import { useMemo, useState, type CSSProperties, type JSX } from "react";
import type { PendingApproval, PendingInteraction } from "@jaira/shared/browser";
import { Board, PathBar } from "./board";
import { ApprovalDialog, InteractionDialog } from "./components";
import { TaskPanel } from "./detail";
import { FileInspector, FilePanel, FileTreePanel, TaskInspector, VIEWER_HEIGHT } from "./files";
// Imported for its registrations: this is what puts markdown, JSON, YAML, states and config into the
// surface registry. Nothing else in the shell references the built-in surfaces by name.
import "./fileSurfaces";
import type { FileSurfaceContext } from "./fileTypes";
import { ExecutorsPane, LayerPicker, SettingsPane } from "./panes";
import { Splitter } from "./splitter";
import { History, NewTask } from "./widgets";
import { useApp, type SettingsSection, type View } from "./store";

const RAIL: Array<[View, string, string]> = [
  ["files", "❏", "Files"],
  ["tasks", "▶", "Tasks"],
];

/**
 * The Settings sections.
 *
 * `layered` marks the two the layer switch applies to. History is a project's run journal — there is
 * no shared version of it to edit — so showing the switch above it would offer a choice that changes
 * nothing.
 */
const SECTIONS: Array<{ id: SettingsSection; label: string; layered: boolean }> = [
  { id: "config", label: "Configuration", layered: true },
  { id: "executors", label: "Executors", layered: true },
  { id: "history", label: "History", layered: false },
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
                    stateId={state.stateId}
                    detail={detail}
                    stream={state.stream}
                    onBack={actions.inspectState}
                    onStart={() => (detail ? actions.startTask(detail.taskId) : undefined)}
                    onCancel={() => (detail ? actions.cancelTask(detail.taskId) : undefined)}
                  />
                ) : (
                  <FileInspector
                    doc={state.doc}
                    state={state.state}
                    onRevealIssue={(path) => setReveal((last) => ({ path, nonce: (last?.nonce ?? 0) + 1 }))}
                  />
                )}
              </aside>
            </div>
          ) : null}

          {view === "tasks" ? (
            <div className="view tasks-view" style={{ "--pane-right": `${panes.tasksRight}px` } as CSSProperties}>
              <div className="col mid">
                <PathBar breadcrumb={board?.breadcrumb ?? []} onGo={actions.drillTo}>
                  <span className="sub">
                    {state.tasks.length} tasks · {state.tasks.filter((t) => t.status === "running").length} running
                  </span>
                  <NewTask onCreate={actions.createTask} busy={state.busy} />
                </PathBar>
                {board ? (
                  <Board
                    board={board}
                    selected={state.selected}
                    numbered={board.level !== ""}
                    onSelectTask={actions.select}
                    onDrill={actions.drillTo}
                  />
                ) : (
                  <p className="empty">Open a project to see its board.</p>
                )}
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

          {view === "settings" ? (
            <div className="view settings-view" style={{ "--pane-left": `${panes.settingsLeft}px` } as CSSProperties}>
              <aside className="col side">
                <h3>Settings</h3>
                <ul className="sections">
                  {SECTIONS.map(({ id, label }) => (
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
                {/* One switch for every section under it. The layer is an axis across Configuration
                    and Executors, not a place you navigate to — which is what it used to be for one
                    of them and a picker for the other. */}
                {SECTIONS.find((s) => s.id === state.section)?.layered ? (
                  <LayerPicker value={state.configLayer} onChange={actions.setConfigLayer} disabled={state.busy} />
                ) : null}
                {state.section === "config" ? (
                  <SettingsPane
                    config={state.config}
                    layer={state.configLayer}
                    busy={state.busy}
                    drafts={state.drafts}
                    onDraft={actions.setDraft}
                    onSave={actions.saveConfig}
                  />
                ) : null}
                {state.section === "executors" ? (
                  <ExecutorsPane
                    executors={state.executors}
                    probes={state.probes}
                    probing={state.probing}
                    secrets={state.secrets}
                    busy={state.busy}
                    layer={state.configLayer}
                    onProbe={actions.probeExecutors}
                    onToggle={actions.setExecutorEnabled}
                    onSaveSecret={actions.saveSecret}
                  />
                ) : null}
                {state.section === "history" ? (
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
