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
import type {
  BoardCard,
  ConfigLayer,
  PendingApproval,
  PendingInteraction,
  PendingQuestion,
  ProjectSummary,
  ProjectTask,
  WorkflowLayer,
} from "@jaira/shared/browser";
import { Board, lanesOf } from "./board";
import { dragOffersOf } from "./taskDrag";
import { ChatListPanel, ChatView, chatProjectOf, conversationsOf, type ChatSurface } from "./chatPane";
import { isChatWorkflow } from "./chatWorkflow";
import { ApprovalDialog, InteractionDialog, QuestionDialog } from "./components";
import { AskDialog, ContextMenu, type AskSpec, type MenuAnchor, type MenuItem } from "./menu";
import { AppearancePane } from "./appearancePane";
import {
  addCounts,
  hueOf,
  minusCounts,
  Pill,
  projectCounts,
  taskCounts,
  unseenRows,
  unseenTasks,
  type PillCounts,
} from "./pill";
import { PointerMenus } from "./pointerMenu";
import { projectName } from "./projects";
import { ValuePanelContext, type PinnedValue } from "./valuePanel";
import { MessageTypeContext, type MessageTypeStore } from "./messageTypes";
import { ValueView } from "./valueView";
import {
  FileAddressBar,
  FileInspector,
  FilePanel,
  FileTreePanel,
  FolderInspector,
  RunInspector,
  StateInspector,
  TaskInspector,
} from "./files";
// Imported for its registrations: this is what puts markdown, JSON, YAML, states and config into the
// surface registry. Nothing else in the shell references the built-in surfaces by name.
import "./fileSurfaces";
import type { FileSurfaceContext } from "./fileTypes";
import { LogsPanel } from "./logs";
import { LayerPicker, SettingsPane } from "./panes";
import { ConfigPane } from "./configPane";
import { ConfigPanel } from "./configPanel";
import { DebugPane } from "./debugPane";
import { ProvidersPane } from "./providersPane";
import { ExecutorsPane } from "./executorsPane";
import { initialRunValues, runFieldsOf, runTargetOf, runValuesOf } from "./runForm";
import type { RunSurface } from "./runPanel";
import { RunModeToggle, RunView, TaskContext } from "./runViews";
import { Sidebar, type SidebarAct, type SidebarProject, type SidebarView } from "./sidebar";
import { Splitter } from "./splitter";
import { TaskAddressBar } from "./taskBar";
import { nodeAt } from "./trail";
import {
  FOLD,
  HALVES,
  PANE,
  PANE_SURFACE,
  PANE_WIDE,
  SHUT,
  SIDEBAR_RAIL,
  modeOf,
  openOf,
  paneDefault,
  paneOf,
  shutOf,
} from "./uiState";
import { Icon } from "./icons";
import { History, NewTask } from "./widgets";
import { invoke, useApp, type SettingsSection, type View } from "./store";

/**
 * How wide each view lets its context panel be dragged while it is describing something.
 *
 * Not in `uiState.ts` with the defaults, because these are not defaults: they are the shell's own
 * bound on a gesture, and they are read twice each — once by the splitter that enforces them and
 * once by the column that has to obey them when the bound moves. See {@link PANE_WIDE} for what
 * replaces them while the panel is holding a document instead.
 */
const PANE_CEILING = { files: 680, tasks: 760 };

/**
 * A value held still, in the panel beside whatever is going on.
 *
 * The panel's other subjects — a file, a run, a task — are all things the ADDRESS names, and each is
 * chosen by the rule that the panel describes the end of the path. This one is chosen by hand: it is
 * there because somebody said "keep this where I can see it" about a document that would otherwise
 * be twenty turns up a transcript. So it OUTRANKS the rule while it is open, and closing it hands
 * the panel back — the same shape the task inspector already had.
 *
 * The header carries the name and the way out, and nothing else. Everything a value can do is in the
 * viewer's own `…`, including opening it here, which is where somebody who wants to save it will
 * already be looking.
 *
 * Except that the viewer INSIDE the panel has no panel: the provider is cleared here, so the value
 * that is already pinned is not offered the chance to pin itself. Its `…` still saves a file, which
 * is the item somebody reading a document in this column actually wants.
 */
function PinnedPane({ pinned, onClose }: { pinned: PinnedValue; onClose: () => void }): JSX.Element {
  return (
    <div className="pinned-pane">
      <div className="pinned-head">
        <span className="pinned-title ellip" title={pinned.title}>
          {pinned.title}
        </span>
        <button type="button" className="pinned-close" title="Close this and give the panel back" onClick={onClose}>
          <Icon name="cross" />
        </button>
      </div>
      <div className={pinned.node === undefined ? "pinned-body" : "pinned-body pinned-surface"}>
        <ValuePanelContext.Provider value={null}>
          {/* A surface when one was handed over — see {@link PinnedValue.node} — and the value viewer
              otherwise, which is what everything but the graph's boxes pins. */}
          {pinned.node ?? (
            <ValueView
              value={pinned.value}
              {...(pinned.hint !== undefined ? { hint: pinned.hint } : {})}
              {...(pinned.label !== undefined ? { label: pinned.label } : {})}
              {...(pinned.serve !== undefined ? { serve: pinned.serve } : {})}
              {...(pinned.onPrompt !== undefined ? { onPrompt: pinned.onPrompt } : {})}
            />
          )}
        </ValuePanelContext.Provider>
      </div>
    </div>
  );
}

/**
 * The bar above every settings section: which layer is being edited, and when the checks last ran.
 *
 * One component rather than a picker in each pane, and it is where the no-project rule lives. With
 * no project open there is no `.jaira/settings.json` to write, so the switch is not merely disabled —
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

/**
 * The rooms INSIDE a project — nested under whichever one the address is standing on (SHELL.md
 * §5.1). Each is a view of that project's work, so none of them means anything at the root.
 */
const VIEWS: readonly SidebarView[] = [
  { id: "files", glyph: "❏", label: "Files" },
  { id: "tasks", glyph: "▶", label: "Tasks" },
  // The third activity, and the newest: TALKING. Files designs, Tasks operates, and this is the one
  // you open when what you want is a conversation rather than a workflow — see `chatPane.tsx`.
  { id: "chat", glyph: "✎", label: "Chat" },
];

/**
 * The rooms that belong to NO project, and therefore sit in the footer beside Settings.
 *
 * Debug is here rather than inside Settings for the same reason it always was: the self-test is what
 * you reach for when the app is not behaving, and burying it behind a configuration screen would
 * make it hardest to find in exactly the situation it exists for.
 */
const FOOTER_VIEWS: readonly SidebarView[] = [
  { id: "logs", glyph: "≡", label: "Logs" },
  { id: "debug", glyph: "⌁", label: "Debug" },
];

/**
 * The rooms at the ROOT of the address — every project's work at once.
 *
 * The same two view ids the projects nest, because they are the same rooms seen from one level up:
 * Tasks at the root is the board sectioned by project, and Chat at the root is every conversation in
 * recency order. Named for the level rather than the room, because "Tasks" appearing twice in one
 * column with no way to tell which is which is the thing that would make this unreadable.
 *
 * No Files. The tree's top level is ALREADY every project with `~/.jaira` beside them (§2.2), so a
 * root Files row would open the same tree a project row opens — two ways to one view.
 */
const ROOT_VIEWS: readonly SidebarView[] = [
  { id: "tasks", glyph: "▦", label: "All tasks" },
  { id: "chat", glyph: "✻", label: "All conversations" },
];

/** Every nav row, for the lookups that do not care which group a view is in. */
const ALL_VIEWS: readonly SidebarView[] = [...VIEWS, ...FOOTER_VIEWS];

/** The views that live INSIDE the settings panel — see `beforeSettings` and the sidebar's own rule. */
const PANEL_VIEWS: ReadonlySet<string> = new Set<string>(["settings", ...FOOTER_VIEWS.map((v) => v.id)]);

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
  const what = view === "files" && doc !== null ? doc : (ALL_VIEWS.find((v) => v.id === view)?.label ?? "Settings");
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
  // Not layered and not project-scoped: typography belongs to a PERSON, not to a checkout, and a
  // window with nothing open is exactly where somebody sets it up.
  { id: "appearance", label: "Appearance", layered: false },
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
  questions,
  projects,
  hues,
  onSelect,
}: {
  pending: PendingInteraction[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  projects: ProjectSummary[];
  /** Directory → the colour that project wears everywhere else. See `hueOf`. */
  hues: Readonly<Record<string, string>>;
  onSelect: (taskId: string, project: string) => void;
}): JSX.Element | null {
  const total = pending.length + approvals.length + questions.length;
  if (total === 0) return null;
  // The strip's own list is cross-project (`pendingApprovals()` flat-maps every session), so a row
  // has to say WHOSE task it is — and hand that project back with the click. Selecting on the task
  // id alone read the id against whichever project was focused. See SHELL.md §2.4.
  // The published label and hue when the project is still listed; the basename and the grey when it
  // is not, which is what a request outliving its session by a tick looks like.
  const chipOf = (project: string): { label: string; hue: string } => {
    const found = projects.find((p) => p.project === project);
    return {
      label: found?.label ?? projectName(project),
      hue: hues[project] ?? "var(--p0)",
    };
  };
  const shown = [
    // Questions first: the agent addressed the person directly, and its loop is parked on the reply.
    ...questions.slice(0, 2).map((item) => ({
      key: item.requestId,
      badge: "badge-waiting_for_user",
      glyph: "❓",
      text: item.questions[0]?.question ?? "the agent has a question",
      title: item.questions.map((q) => q.question).join(" · "),
      taskId: item.taskId,
      project: item.project,
    })),
    ...approvals.slice(0, 2).map((item) => ({
      key: item.requestId,
      badge: "badge-blocked",
      glyph: "⛔",
      text: item.command ?? item.tool,
      title: item.reason ?? "",
      taskId: item.taskId,
      project: item.project,
    })),
    ...pending.slice(0, 2).map((item) => ({
      key: item.requestId,
      badge: "badge-waiting_for_user",
      glyph: "⏸",
      text: item.config?.prompt ?? item.component,
      title: item.component,
      taskId: item.taskId as string | undefined,
      project: item.project,
    })),
  ].slice(0, 3);
  return (
    <footer className="strip">
      {/* App voice, sentence case. It was an uppercase warn-coloured label, which made the strip
          shout the same thing whether one thing was waiting or nine — the COUNT beside it is what
          varies, so the count is the coloured part. */}
      <span className="strip-label app-title">Awaiting you</span>
      <Pill kind="waiting" n={total} title={`${total} waiting on you`} />
      {shown.map((item) => {
        const chip = chipOf(item.project);
        return (
          <span
            key={item.key}
            className="strip-item"
            title={item.title}
            onClick={() => (item.taskId ? onSelect(item.taskId, item.project) : undefined)}
          >
            {/* The project's hue, the same one its sidebar row and its address crumb carry — which is
                how a row here is tied back to somewhere without spelling out a path. */}
            <span className="chip strip-project" style={{ "--hue": chip.hue } as CSSProperties}>
              {chip.label}
            </span>
            <span className="ellip data-text">{item.text}</span>
          </span>
        );
      })}
      {total > shown.length ? <span className="more app-secondary">+{total - shown.length} more</span> : null}
    </footer>
  );
}

export default function App(): JSX.Element {
  const { state, actions } = useApp();
  /**
   * The remembered layout — every pane size, fold and collapsed branch in the window.
   *
   * It reads out of `user-settings.json` (see `uiState.ts`) rather than out of `useState`, which is the
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
  /**
   * Which of the sidebar drawers is currently showing its FIND field (SHELL.md §5.1).
   *
   * Session-scoped, and deliberately not in the remembered layout beside the folds: a fold is how
   * you like the column arranged and is worth reopening the app on, while a search is a thing you
   * are in the middle of. A window that opened with a stale query in it, filtering a tree, would be
   * a window that opened looking broken.
   */
  const [finding, setFinding] = useState<Record<string, boolean>>({});
  const find = (id: string): SidebarAct => ({
    id: "find",
    glyph: "⌕",
    label: `find in ${id}`,
    on: finding[id] === true,
    onAct: () => setFinding((f) => ({ ...f, [id]: !(f[id] ?? false) })),
  });
  const { board, detail, pending, view } = state;
  /**
   * Where "back" goes from Settings — the view the window was showing when it was opened.
   *
   * Settings is the one view that is not a place in the address: you go into it FROM somewhere, and
   * the way out is that somewhere rather than a default. A ref rather than state, because nothing
   * renders differently for it: it is read only when the arrow is clicked.
   */
  const beforeSettings = useRef<View>("files");
  useEffect(() => {
    // Every view the settings panel holds is excluded, not Settings alone. Logs and Debug are
    // reached from inside it, so recording one as "where I was" would make the way out lead back
    // into the panel — the arrow would do nothing and there would be no way back to your work.
    if (!PANEL_VIEWS.has(view)) beforeSettings.current = view;
  }, [view]);

  /**
   * The files with unsaved edits, as the `layer:path` keys the tree rows are identified by.
   *
   * The map holds differences from disk only (see `drafts.ts`), so its keys ARE the dirty set — no
   * second flag to keep in step with it.
   */
  const dirtyFiles = useMemo(() => new Set(Object.keys(state.drafts)), [state.drafts]);

  /**
   * Everything the Chat view needs, assembled here like every other pane's context.
   *
   * The project is DERIVED rather than remembered: conversations belong to the open checkout, and to
   * JaiRA's own root when there is none (`runTargetOf`'s rule for base-layer workflows). Deriving it
   * means closing a project cannot leave the list pointed at a database this window is no longer
   * reading — the list simply becomes the other one.
   */
  /**
   * The projects the SIDEBAR lists, and the colour each one wears.
   *
   * JaiRA's own runs are not a row of their own. They happen against the shared root, so the one
   * `~/.jaira` row is the whole of "the machine's own" as far as somewhere to stand is concerned —
   * two rows for one place is two answers to "where am I". Those runs are still everywhere they
   * were: the root's Tasks board draws them under it, which is where a description sync belongs —
   * filed under JaiRA rather than mixed into a checkout.
   */
  const shownProjects = state.projects;
  /** Directory → hue, for the surfaces that draw a project they did not enumerate. */
  const projectHues = useMemo(
    () => Object.fromEntries(state.projects.map((p, i) => [p.project, hueOf(p.kind, i)])),
    [state.projects],
  );
  /**
   * Directory → what to call it, for the same surfaces.
   *
   * Main's own labels: the basename for a checkout, `~/.jaira` for the shared root, `JaiRA` for its
   * own. Handed out rather than re-derived per surface, so one project is called one thing wherever
   * the window mentions it — and so the two places that cannot derive it (a root is not its
   * basename) do not have to.
   */
  const projectNames = useMemo(
    () => Object.fromEntries(state.projects.map((p) => [p.project, p.label])),
    [state.projects],
  );

  /**
   * Which project the Chat view reads and writes — the open conversation's, or where a new one goes.
   *
   * The rule is `chatProjectOf`, stated where the surface it feeds is defined. What matters here is
   * that it is never `null`: a chat call NAMES its project, because main resolves an unnamed one
   * only while exactly one user project is open.
   */
  const chatProject = chatProjectOf(state.chat.project, state.at);
  const chat: ChatSurface = {
    // At the ROOT: every project's conversations, newest first, each stamped with its own project —
    // "all conversations" is a place, and this is what it holds. Inside a project: that project's.
    conversations: useMemo(
      () => (state.at === null ? state.allConversations : conversationsOf(state.tasks)),
      [state.at, state.allConversations, state.tasks],
    ),
    hues: projectHues,
    names: projectNames,
    taskId: state.chat.taskId,
    project: chatProject,
    busy: state.chat.busy,
    opening: state.chat.opening,
    error: state.chat.error,
    // The detail, journal and live tail are the SELECTED task's — opening a conversation selects it,
    // so these are about the thread on screen. Guarded on that rather than assumed: a selection made
    // in the Tasks view would otherwise lend this panel another task's transcript.
    detail: state.selected === state.chat.taskId ? detail : null,
    journal: state.selected === state.chat.taskId ? state.conversation : null,
    live: state.selected === state.chat.taskId ? state.liveTurn : null,
    hasProject: state.at !== null,
    producing: state.producing,
    seen: ui.seen,
    onSeen: actions.markSeen,
    onOpen: actions.openConversation,
    onNew: actions.newConversation,
    onRename: actions.renameTask,
    onDelete: actions.deleteTasks,
    onCancelRun: actions.cancelTask,
  };

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
    pending[0].component === "review_artifacts" &&
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
  /** The folded states of every run — see `SHUT.runStates` for why one bucket is enough. */
  const foldedStates = useMemo(() => shutOf(ui, SHUT.runStates), [ui]);

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
   * The Tasks board's selection — one task, or a set of them.
   *
   * The SET lives here rather than in the store because it is a fact about this board's cards on
   * this screen: the store's `selected` stays the single task the panel describes (always the last
   * card touched), and this remembers which others are gathered around it. Scoped to ONE project —
   * a task id is a rowid in one database, and every verb the set can be offered takes a project —
   * so touching another project's board starts a new selection rather than quietly building a set
   * no action could be applied to.
   *
   * `anchor` is where a shift-range measures from: the last plainly-clicked card, file-explorer
   * style.
   */
  const [picked, setPicked] = useState<{ project: string; ids: readonly string[]; anchor: string } | null>(null);
  const pickedSet = useMemo(() => (picked === null ? null : new Set(picked.ids)), [picked]);
  // A selection made somewhere other than the board — the logs view, a run link — replaces the set,
  // which would otherwise keep highlighting cards the panel is no longer about.
  useEffect(() => {
    setPicked((was) => (was !== null && state.selected !== null && !was.ids.includes(state.selected) ? null : was));
  }, [state.selected]);

  /**
   * One project's cards in the order the board DRAWS them — columns left to right, each split into
   * lanes, then the at-this-level tray — which is the order "everything in between" means to the
   * person shift-clicking. Built from the same `lanesOf` the board renders with, so the range can
   * never disagree with what is on screen.
   */
  const boardCardsOf = useCallback(
    (project: string): BoardCard[] => {
      const b = state.boards[project];
      if (b === undefined || b === null) return [];
      return [
        ...b.columns.flatMap((c) => lanesOf(c.cards).flatMap((l) => l.cards)),
        ...lanesOf(b.atLevel).flatMap((l) => l.cards),
      ];
    },
    [state.boards],
  );

  /** A click on a card: plain selects, ctrl/cmd toggles membership, shift extends from the anchor. */
  const pickTask = useCallback(
    (project: string, taskId: string, e?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
      const same = picked !== null && picked.project === project ? picked : null;
      if (e?.shiftKey === true && same !== null) {
        const order = boardCardsOf(project).map((c) => c.taskId);
        const a = order.indexOf(same.anchor);
        const b = order.indexOf(taskId);
        if (a >= 0 && b >= 0) {
          // The range REPLACES the set (explorer semantics), and the anchor stays put so a second
          // shift-click re-measures from the same end rather than from wherever the first landed.
          setPicked({ project, ids: order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor: same.anchor });
          actions.select(taskId, project);
          return;
        }
      }
      if ((e?.ctrlKey === true || e?.metaKey === true) && same !== null) {
        const had = same.ids.includes(taskId);
        const ids = had ? same.ids.filter((id) => id !== taskId) : [...same.ids, taskId];
        if (ids.length === 0) {
          setPicked(null);
          return;
        }
        setPicked({ project, ids, anchor: had ? same.anchor : taskId });
        // The panel follows the last card TOUCHED — for a removal, the last one still standing.
        actions.select(had ? ids[ids.length - 1]! : taskId, project);
        return;
      }
      setPicked({ project, ids: [taskId], anchor: taskId });
      actions.select(taskId, project);
    },
    [actions, boardCardsOf, picked],
  );

  /**
   * The Tasks board's right-click menu, and the one confirmation inside it.
   *
   * The menu is the card's VERBS — open, run again, cancel, delete — which all existed before it
   * did, as a double-click, a button on the panel, or nothing at all. Right-click is where people
   * look for them, and it is the only place "delete" appears: destroying history is not a verb that
   * belongs one mis-click from a card's face.
   *
   * Right-clicking INSIDE a multi-selection offers the set the same verbs, each labelled with the
   * count it will actually touch — a verb a member is ineligible for skips that member and the note
   * says so, because "Re-run 3 tasks" doing something to two of them is how trust in a menu dies.
   * Right-clicking outside the selection collapses it to the clicked card first, explorer-style.
   */
  const [taskMenu, setTaskMenu] = useState<MenuAnchor | null>(null);
  const [taskAsk, setTaskAsk] = useState<AskSpec | null>(null);
  /**
   * What somebody has asked to keep in the side panel — see {@link PinnedPane}.
   *
   * Shell state rather than store state, and deliberately not remembered across restarts. It is a
   * gesture about the next few minutes ("hold this while I read it"), not a preference: an app that
   * reopened with a document pinned beside a conversation nobody is having any more would be
   * restoring furniture rather than work.
   */
  const [pinned, setPinned] = useState<PinnedValue | null>(null);
  const valuePanel = useMemo(() => ({ open: (item: PinnedValue) => setPinned(item) }), []);

  /**
   * Where a reader's "no, this message is markdown" is kept — see `messageTypes.ts`.
   *
   * `ui.modes` because that is already the map for controls with more than two positions, and a type
   * is one: it is a position, it belongs to one person on one machine, and it must never travel in
   * `settings.json` where a pull request could change how somebody reads their own transcripts.
   *
   * Clearing writes an empty string rather than deleting the key. `withMode` only ever sets, and a
   * `withoutMode` beside it would be a second way to spell absence — so absence is spelled once,
   * here, and every reader gets it from {@link MessageTypeStore.get}.
   */
  const messageTypes = useMemo<MessageTypeStore>(
    () => ({
      get: (key) => {
        const held = ui.modes[key];
        return held === undefined || held === "" ? undefined : held;
      },
      set: (key, mime) => actions.setMode(key, mime ?? ""),
    }),
    [ui, actions],
  );

  /**
   * How wide a context panel actually is, given that its ceiling MOVES.
   *
   * A panel holding a document may be dragged out to {@link PANE_WIDE}; the same panel back to
   * describing a file may not. Clamped at the point of use rather than by rewriting the stored
   * number, so closing a pinned document snaps the column back to inspector width and opening one
   * again restores the width it was dragged to. What is remembered is what somebody chose, not what
   * happened to fit at the time.
   */
  /**
   * How wide the context panel is, given what it is holding.
   *
   * A pinned SURFACE has a floor as well as a ceiling: a state's configuration is a form, and a form
   * whose rows are a name, a type, a binding and a switch stops being a form somewhere around 460px.
   * Opening one into a column dragged narrow for an inspector would show it broken — so the column
   * grows to meet it, once, and stays wherever it is dragged afterwards.
   */
  const panelWidth = (id: string, ceiling: number): number => {
    const held = pinned !== null;
    const floor = pinned?.node === undefined ? 0 : PANE_SURFACE;
    return Math.max(floor, Math.min(paneOf(ui, id), held ? PANE_WIDE : ceiling));
  };
  const openTaskMenu = useCallback(
    (project: string, card: BoardCard, x: number, y: number) => {
      const plural = (k: number): string => `${k} task${k === 1 ? "" : "s"}`;
      const set =
        picked !== null && picked.project === project && picked.ids.length > 1 && picked.ids.includes(card.taskId)
          ? picked.ids
          : null;

      if (set !== null) {
        const byId = new Map(boardCardsOf(project).map((c) => [c.taskId, c] as const));
        const cards = set.map((id) => byId.get(id)).filter((c): c is BoardCard => c !== undefined);
        const n = cards.length;
        const notRunning = cards.filter((c) => c.status !== "running");
        const cancelable = cards.filter(
          (c) => c.status === "queued" || c.status === "running" || c.status === "interrupted",
        );
        setTaskMenu({
          x,
          y,
          items: [
            {
              label: `Re-run ${plural(notRunning.length)}`,
              disabled: notRunning.length === 0,
              ...(notRunning.length < n ? { note: "running skipped" } : {}),
              onSelect: () =>
                void actions.rerunTasks(
                  notRunning.map((c) => c.taskId),
                  project,
                ),
            },
            {
              label: `Cancel ${plural(cancelable.length)}`,
              disabled: cancelable.length === 0,
              ...(cancelable.length < n ? { note: "finished skipped" } : {}),
              onSelect: () =>
                void actions.cancelTasks(
                  cancelable.map((c) => c.taskId),
                  project,
                ),
            },
            {
              label: "Copy task ids",
              separator: true,
              onSelect: () => void navigator.clipboard?.writeText(cards.map((c) => c.taskId).join("\n")),
            },
            {
              label: `Delete ${plural(notRunning.length)}…`,
              separator: true,
              danger: true,
              disabled: notRunning.length === 0,
              ...(notRunning.length < n ? { note: "running skipped" } : {}),
              onSelect: () =>
                setTaskAsk({
                  title: `Delete ${plural(notRunning.length)}?`,
                  note: "This deletes each task, every run it made, and its worktree — uncommitted work included. None of it comes back.",
                  confirmLabel: "Delete",
                  danger: true,
                  onConfirm: () => {
                    setTaskAsk(null);
                    setPicked(null);
                    void actions.deleteTasks(
                      notRunning.map((c) => c.taskId),
                      project,
                    );
                  },
                }),
            },
          ],
        });
        return;
      }

      // Selecting first, so the panel beside the menu describes the card the menu is about — the
      // same answer a plain click gives, and the confirmation dialog then names a task whose detail
      // is on screen.
      setPicked({ project, ids: [card.taskId], anchor: card.taskId });
      actions.select(card.taskId, project);
      const running = card.status === "running";
      const terminal = card.status === "completed" || card.status === "failed" || card.status === "canceled";
      // Opening a card follows the same level rule as double-clicking it — see the Board's
      // `onOpenTask` below.
      const level = state.boards[project]?.level ?? "";
      const items: MenuItem[] = [
        {
          label: "Open",
          onSelect: () => actions.openTask(card.taskId, project, level === "" ? card.workflow : level),
        },
        {
          // The same distinctions the task panel's button draws, plus the one it cannot: a FINISHED
          // task reruns as a fresh copy ("task:rerun"), and the label says so rather than letting
          // "Re-run" quietly mean "make another task".
          //
          // A CONVERSATION is the same story arrived at differently. Re-running one in place would
          // start a second conversation in the same task, and a thread is read from the latest run —
          // so everything already said would still be in the database and reachable from nowhere.
          // `task:rerun` copies it instead, and this is where that stops being a surprise.
          label:
            card.status === "queued"
              ? "Start"
              : terminal || isChatWorkflow(card.workflow)
                ? "Re-run as a new task"
                : "Re-run",
          disabled: running,
          ...(terminal || isChatWorkflow(card.workflow) ? { note: "fresh copy" } : {}),
          onSelect: () => void actions.rerunTask(card.taskId, project),
        },
        {
          label: "Cancel",
          // A terminal task has nothing left to cancel; the item stays, disabled, so the menu keeps
          // one shape and the reason a verb is unavailable is visible where it would have been.
          disabled: terminal,
          onSelect: () => void actions.cancelTask(card.taskId, project),
        },
        { label: "Copy task id", separator: true, onSelect: () => void navigator.clipboard?.writeText(card.taskId) },
        {
          label: "Delete…",
          separator: true,
          danger: true,
          disabled: running,
          onSelect: () =>
            setTaskAsk({
              title: `Delete "${card.title}"?`,
              note: "This deletes the task, every run it made, and its worktree — uncommitted work included. None of it comes back.",
              confirmLabel: "Delete",
              danger: true,
              onConfirm: () => {
                setTaskAsk(null);
                void actions.deleteTasks([card.taskId], project);
              },
            }),
        },
      ];
      setTaskMenu({ x, y, items });
    },
    [actions, boardCardsOf, picked, state.boards],
  );

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
  const title = windowTitle(state.at, view, state.doc?.path ?? state.dir?.path ?? null);
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
    const target = runTargetOf(doc.layer, state.at);
    const dir =
      target.project === undefined
        ? (state.at ?? undefined)
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
   * The same surface for the workflow the TASKS view has selected — a board column, not a file.
   *
   * Built here beside the Files view's for the reason that one is built here: assembling a run is
   * knowing where a task is recorded and which list its history reads, and neither belongs in a
   * column that draws an inspector.
   *
   * Where it differs from the file's is the routing. A file's layer decides its project — a shared
   * state runs in JaiRA's own — but a COLUMN was clicked on a particular board, and a shared root is
   * a column on every board that can reach it. So the project is the group's, which is the board the
   * card would appear on, and `exists` is unconditional: the listing is built from files on disk.
   *
   * Absent while the inputs are still being read, so the Run section appears once rather than
   * appearing first as "this file does not parse" — see {@link AppState.workflowForms}, where
   * `undefined` is "not asked yet" and `null` is the file, read and refused.
   */
  const workflowRunSurface: RunSurface | undefined = ((): RunSurface | undefined => {
    const stateId = state.taskWorkflow;
    if (stateId === null) return undefined;
    const fields = state.workflowForms[stateId];
    if (fields === undefined) return undefined;
    const project = state.taskWorkflowProject;
    const summary = state.projects.find((p) => p.project === project);
    /**
     * What this panel's boxes hold.
     *
     * Reached from a board column, they are the state's own defaults with whatever has been typed
     * over them — a form for the NEXT run. Reached from a conversation's gutter, the panel is
     * describing a run that already happened, so they hold what that run was called with; typing
     * still wins, because the reason to look at those values beside the Run button is usually to
     * change one of them and go again.
     */
    const run = state.taskWorkflowRun === null ? null : nodeAt(detail?.instances ?? [], state.taskWorkflowRun);
    const called = run?.inputs;
    return {
      fields,
      values: {
        ...(called !== undefined ? runValuesOf(fields ?? [], called) : initialRunValues(fields ?? [])),
        ...(state.runValues[stateId] ?? {}),
      },
      target: {
        ...(project !== null && project !== state.at ? { project } : {}),
        label: summary?.label ?? projectName(project),
        open: project !== null,
      },
      ...(project !== null ? { targetDir: project } : {}),
      exists: true,
      // A board column is a file on disk by construction. There is no editor here to have unsaved
      // edits in — the one that could is in the other view, describing whatever IT has open.
      dirty: false,
      busy: state.busy,
      tasks: summary?.kind === "shared" ? state.sharedTasks : state.tasks,
      selected: state.selected,
      onChange: (name, text) => actions.setRunValue(stateId, name, text),
      onRun: (title, inputs) => void actions.runState(stateId, title, inputs, project ?? undefined),
      onSelectTask: actions.select,
    };
  })();

  /**
   * Put the configuration this run resolves against in the side panel.
   *
   * The project is the one HOLDING the run, not the focused one: a shared workflow's runs are
   * recorded in JaiRA's own project, and reading the open checkout's settings beside one would
   * describe a document that had nothing to do with it.
   *
   * `read` rather than the configuration itself, because the panel outlives the click — see
   * `configPanel.tsx`. The Settings link is what makes this a reading rather than a dead end.
   */
  const openConfigPanel = (
    stateId: string,
    of?: { project?: string | null; taskId?: string; instanceId?: number },
  ): void => {
    const project = of?.project ?? state.selectedProject ?? state.at;
    const taskId = of?.taskId;
    const instanceId = of?.instanceId;
    setPinned({
      title: `${stateId.split("/").pop() ?? stateId} · configuration`,
      node: (
        <ConfigPanel
          read={() =>
            invoke("state:effective", {
              stateId,
              ...(taskId !== undefined ? { taskId } : {}),
              ...(instanceId !== undefined ? { instanceId } : {}),
              ...(project !== null ? { project } : {}),
            })
          }
          // The form's completions want both of these — the tree for state references, the executor
          // list for an operation's function. A reading is still the same form.
          tree={state.tree}
          executors={state.executors}
          // And these are what let it show a state WHOLE: a prompt held in another file is the
          // substance of the state, and a reader that cannot open it shows a path instead.
          services={{
            readFile: actions.readFile,
            readState: actions.readState,
            loadStateSlots: actions.stateSlots,
            validateSchema: actions.validateSchema,
            wrapJson: state.settings.wrapJson,
            onWrapJson: actions.setWrapJson,
          }}
          onOpenState={(id) => {
            actions.setView("files");
            actions.selectState(id);
          }}
        />
      ),
    });
  };

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
    shutStates: foldedStates,
    onToggleShutState: (key: string) => actions.toggleShut(SHUT.runStates, key),
    onSetShutStates: (keys: readonly string[], shut: boolean) => actions.setShut(SHUT.runStates, keys, shut),
    userEvents: state.userEvents,
    onDeliverUserEvent: actions.deliverUserEvent,
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
    // The link in a session panel's gutter: describe the workflow that opened that conversation,
    // scoped to the run that opened it. In the project holding the selected task — a shared workflow
    // reached from a run of it is still that run's project's business.
    onOpenWorkflow: (stateId: string, instanceId: number) =>
      actions.inspectWorkflow(stateId, instanceId, state.selectedProject ?? undefined),
    onWalkTo: actions.walkTo,
    onOpenFile: actions.openPath,
    onOpenDir: actions.openDir,
    onOpenProject: () => actions.chooseProject("open"),
    runMode,
    onRunMode: setRunMode,
    onAnswer: waiting ? () => actions.select(waiting.taskId) : undefined,
    // The action, not the channel — re-running a finished task answers with a DIFFERENT task, and
    // this is what moves the selection onto it. See `FileSurfaceContext.onRerun`.
    onRerun: (taskId: string) => void actions.rerunTask(taskId, state.selectedProject ?? undefined),
    onResume: (taskId: string) => void actions.resumeTask(taskId, state.selectedProject ?? undefined),
    onSaveConfig: actions.saveConfig,
    validateSchema: actions.validateSchema,
    stateSlots: actions.stateSlots,
    readState: actions.readState,
    saveState: actions.saveState,
    readFile: actions.readFile,
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
    editorTabLast: state.editorTabLast,
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
  /**
   * The projects, as the sidebar draws them.
   *
   * The counts are the same ones the address bar carries — one derivation, so a project row and the
   * crumb over its board can never disagree about how much is waiting.
   */
  const sidebarProjects: SidebarProject[] = shownProjects.map((p) => ({
    project: p.project,
    label: p.label,
    kind: p.kind,
    // Looked up rather than recomputed from THIS list's index: the sidebar hides one project and the
    // strip and the crumb bar hide none, and a hue derived from each list's own position would give
    // one project two colours the moment those lists differ.
    hue: projectHues[p.project] ?? "var(--p0)",
    counts: projectCounts(p, ui.seen),
    onSeen: () => actions.markProjectSeen(p.project),
  }));

  /**
   * The conversations of the projects the sidebar lists, and of the OPEN one.
   *
   * `allConversations` is fetched for every open project whatever view is showing, so it is the one
   * list that can answer "which of these ended rows is a conversation" — a project summary cannot:
   * its `ended` rows carry a status and a clock and no workflow. That question is what makes a view
   * row's pills honest, and answering it wrong is what put a `✓` on **All conversations** for a
   * task that was never a conversation.
   */
  const chatsOf = (project: string): ProjectTask[] =>
    state.allConversations.filter((t) => t.project === project);
  /** The stopped rows of a project that are NOT conversations — what the Tasks rows count. */
  const runsOf = (p: ProjectSummary): { taskId: string; at: number }[] => {
    const chats = new Set(chatsOf(p.project).map((t) => t.taskId));
    return unseenTasks(p, ui.seen).filter(({ taskId }) => !chats.has(taskId));
  };

  /**
   * The root rows: every project's work at once, split by which ROOM it is in.
   *
   * Summed rather than per-project, which is what makes them a level: "all tasks" is one place, and
   * the number beside it is how much is in it. Clicking the pills marks that row's share seen.
   *
   * Split, because the two rows are two rooms and the counts have to say which. Given the same
   * total, **All conversations** carried a `✓` for a run that finished in a workflow — a mark
   * pointing at a place that did not contain the thing it was pointing at, and no row below it
   * repeating the mark, so there was nothing to follow it to. Chat counts conversations; Tasks
   * counts what is left.
   */
  const chatCounts = taskCounts(state.allConversations, ui.seen);
  /** The project the address is standing on, as the summary its rows count from. */
  const atSummary = state.at === null ? null : (shownProjects.find((p) => p.project === state.at) ?? null);
  const atChats = state.at === null ? [] : chatsOf(state.at);
  /**
   * Start a conversation, from the row that names them.
   *
   * The button used to be the first line of the drawer, which meant "open Chat, wait for the list,
   * then click the thing above it". On the row it is the verb the row is for.
   */
  const newChat: SidebarAct = {
    id: "new",
    glyph: "+",
    label: "new conversation",
    onAct: () => {
      actions.setView("chat");
      actions.openConversation(null);
    },
  };
  /**
   * The same verb on the ROOT's row, which goes to the root first.
   *
   * Exactly what clicking that row does, and for the same reason: a conversation started from the
   * row that spans every project belongs to the shared root, not to whichever checkout the address
   * happened to be standing on when the `+` was clicked.
   */
  const newRootChat: SidebarAct = {
    ...newChat,
    onAct: () => {
      actions.standOn(null);
      newChat.onAct();
    },
  };
  /** Every project's work, before it is split between the two rooms. */
  const allCounts = shownProjects.reduce<PillCounts>((sum, p) => addCounts(sum, projectCounts(p, ui.seen)), {});
  const rootRows: SidebarView[] = ROOT_VIEWS.map((v) => {
    if (v.id !== "chat") {
      return {
        ...v,
        counts: minusCounts(allCounts, chatCounts),
        onSeen: () => actions.markSeenAll(shownProjects.flatMap(runsOf)),
      };
    }
    return {
      ...v,
      counts: chatCounts,
      onSeen: () => actions.markSeenAll(unseenRows(state.allConversations, ui.seen)),
      // The same list the project's own Chat row opens, one level up (SHELL.md §5.1). "All
      // conversations" is a place and this is what is in it; a row that names a level and opens
      // onto nothing is the one arrangement that makes the level look empty.
      acts: [newRootChat, find("conversations")],
      panel: <ChatListPanel surface={chat} find={finding.conversations === true} />,
    };
  });

  const rows: SidebarView[] = VIEWS.map((v) =>
    v.id === "tasks"
      ? {
          ...v,
          // This project's work, less what is in the room next door — see `rootRows`.
          counts: minusCounts(
            atSummary === null ? {} : projectCounts(atSummary, ui.seen),
            taskCounts(atChats, ui.seen),
          ),
          onSeen: () => actions.markSeenAll(atSummary === null ? [] : runsOf(atSummary)),
        }
      : v.id === "chat"
      ? {
          ...v,
          counts: taskCounts(atChats, ui.seen),
          onSeen: () => actions.markSeenAll(unseenRows(atChats, ui.seen)),
          acts: [newChat, find("chat")],
          panel: <ChatListPanel surface={chat} find={finding.chat === true} />,
        }
      : v.id !== "files"
      ? v
      : {
          ...v,
          acts: [
            {
              id: "new",
              glyph: "+",
              label: "new file or state here",
              on: finding["files.new"] === true,
              onAct: () => setFinding((f) => ({ ...f, "files.new": !(f["files.new"] ?? false) })),
            },
            find("files"),
          ],
          panel: (
            <FileTreePanel
              tree={state.tree}
              selected={
                state.doc
                  ? { layer: state.doc.layer, path: state.doc.path, ...(state.doc.project !== undefined ? { project: state.doc.project } : {}) }
                  : null
              }
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
              hasProject={state.at !== null}
              onSelect={actions.selectFile}
              onOpen={actions.openWorkflow}
              onCreate={actions.createWorkflow}
              onCreateFile={actions.createFile}
              onMove={actions.moveWorkflow}
              onDelete={actions.deleteWorkflow}
              onRenameFile={actions.renameFile}
              onDeleteFile={actions.deleteFile}
              onReveal={actions.revealFile}
              // Both were permanent fixtures of the drawer — a filter field over the tree and a
              // three-control form under it, on screen whether or not anybody was filtering or
              // creating. They are the row's verbs now, and this is the row saying which one is on.
              find={finding.files === true}
              creating={finding["files.new"] === true}
              // Which root goes unnamed: the one the drawer is hanging under. See the prop.
              project={state.at}
            />
          ),
        },
  );

  const settingsRow: SidebarView = {
    id: "settings",
    glyph: "⚙",
    label: "Settings",
    panel: (
      <ul className="sections">
        {SECTIONS.filter((s) => !s.needsProject || state.at !== null).map(({ id, label }) => (
          <li
            key={id}
            // Only while Settings is what you are LOOKING at. The list stays drawn in Logs and in
            // Debug — it is the panel's, not the view's — and a row marked selected there claimed
            // the window was showing Providers while it was showing the log.
            className={view === "settings" && state.section === id ? "sel" : undefined}
            onClick={() => {
              actions.setSection(id);
              // From Logs or Debug this row is a way BACK into Settings, so it has to go there.
              // Remembering the section without showing it would be a click that did nothing.
              actions.setView("settings");
            }}
          >
            {label}
          </li>
        ))}
      </ul>
    ),
  };

  return (
    /* Every `ValueView` in the window, however deeply it is drawn, can put its value in the panel —
       see `valuePanel.ts` on why this is a context and not six more props. */
    <ValuePanelContext.Provider value={valuePanel}>
    <MessageTypeContext.Provider value={messageTypes}>
    <div
      className="app"
      style={{ "--sidebar": `${sidebarShut ? SIDEBAR_RAIL : sidebarWidth}px` } as CSSProperties}
    >
      <Sidebar
        views={rows}
        roots={rootRows}
        footer={FOOTER_VIEWS}
        settings={settingsRow}
        onLeaveSettings={() => actions.setView(beforeSettings.current)}
        view={view}
        onView={(id) => actions.setView(id as View)}
        collapsed={sidebarShut}
        onCollapsed={(shut) => actions.setFold(FOLD.shellSidebar, !shut)}
        projects={sidebarProjects}
        at={state.at}
        onProject={actions.standOn}
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
              seen={ui.seen}
              onSeen={actions.markProjectSeen}
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
                  {(state.taskFocus ?? atProject) === state.at && state.at !== null ? (
                    <NewTask
                      workflows={state.workflows}
                      // Both maps whole, keyed by state id: WHICH workflow is picked is the popover's
                      // own state, so it is the popover that looks the two up.
                      forms={state.workflowForms}
                      values={state.runValues}
                      busy={state.busy}
                      onPick={actions.pickWorkflow}
                      onChange={actions.setRunValue}
                      onCreate={(workflow, inputs) => void actions.createTask(workflow, inputs)}
                    />
                  ) : null}
                </>
              }
            />
          ) : null}
          {/* The conversation's name, in the row the other views put their address in. Not a crumb
              trail: a conversation has no path — it is one thing, with one name, and the list it
              was picked from is beside it. */}
          {view === "chat" ? (
            <span className="chat-title ellip">
              {chat.conversations.find((c) => c.taskId === chat.taskId)?.title ?? "New conversation"}
            </span>
          ) : null}
          <span className="title-drag" />
        </header>

        <div className="viewport">
          {view === "files" ? (
            <div
              className="view files-view"
              style={{ "--pane-right": `${panelWidth(PANE.filesInspector, PANE_CEILING.files)}px` } as CSSProperties}
            >
              <FilePanel
                doc={state.doc}
                dir={state.dir}
                busy={state.busy}
                context={surfaces}
                viewerHeight={paneOf(ui, PANE.filesViewer)}
                onViewerHeight={(size) => actions.setPane(PANE.filesViewer, size)}
                half={modeOf(ui, FOLD.filesEditor, HALVES, "half")}
                onHalf={(half) => actions.setMode(FOLD.filesEditor, half)}
                onSave={actions.saveDoc}
              />

              <Splitter
                label="Resize the inspector"
                value={paneOf(ui, PANE.filesInspector)}
                reset={paneDefault(PANE.filesInspector)}
                invert
                min={220}
                // A document pinned here wants room an inspector never did — see PANE_WIDE.
                max={pinned !== null ? PANE_WIDE : PANE_CEILING.files}
                onChange={(size) => actions.setPane(PANE.filesInspector, size)}
              />

              <aside className={`col panel${pinned !== null ? " holding" : ""}`}>
                {/*
                  The context panel describes the LAST ELEMENT OF THE ADDRESS BAR, always: the run
                  the path ends on, or the open file when no run is on it. One rule, decided by the
                  bar rather than by a mode, which is what stops the two from disagreeing — the panel
                  used to keep describing a file while the path beside it stood on a run.

                  Two things outrank the rule, and both are reached by asking for them rather than by
                  navigating. The task is reached on the run's own panel: a run belongs to a task, but
                  a task is not a level of the address and cannot be navigated to. A PINNED value is
                  reached from a value's own `…` — see {@link PinnedPane} — and outranks even that,
                  because it is the most recent thing anybody said about this column. Any change to
                  the bar drops back to the rule; closing the pinned value hands the panel back.
                */}
                {pinned !== null ? (
                  <PinnedPane pinned={pinned} onClose={() => setPinned(null)} />
                ) : state.inspect === "workflow" ? (
                  // The third thing reached by asking: the workflow a conversation on the left was
                  // opened by, with that run's own values in its form. Same inspector the Tasks view
                  // puts beside a board column, because it is the same question — what does the state
                  // behind these words say — asked from where the words are.
                  <StateInspector
                    state={state.taskState}
                    {...(workflowRunSurface !== undefined ? { run: workflowRunSurface } : {})}
                    onBack={() => actions.selectWorkflow(null)}
                    // The task is what decides WHICH copy: it pins the workflow, so the state that
                    // ran is in its snapshot and the state on disk is whatever it has been edited
                    // into since. See `state:effective`.
                    onOpenConfig={() =>
                      state.taskWorkflow !== null
                        ? openConfigPanel(state.taskWorkflow, {
                            project: state.taskWorkflowProject,
                            ...(detail !== null ? { taskId: detail.taskId } : {}),
                          })
                        : undefined
                    }
                  />
                ) : state.inspect === "task" ? (
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
                    // The state this run entered, out of the task's pinned snapshot — which is the
                    // copy it actually executed, not whatever the file says now.
                    onOpenConfig={() =>
                      openConfigPanel(state.trail.at(-1)!.stateId, {
                        ...(detail !== null ? { taskId: detail.taskId } : {}),
                        // THIS pass, not the newest one of that state: a loop runs it several times
                        // and the panel beside it is standing on one of them.
                        instanceId: state.trail.at(-1)!.instanceId,
                      })
                    }
                  />
                ) : state.dir !== null ? (
                  // A folder is the end of the address too, so it is what the panel describes.
                  <FolderInspector layer={state.dir.layer} path={state.dir.path} tree={state.tree} />
                ) : (
                  <FileInspector
                    doc={state.doc}
                    state={state.state}
                    run={runSurface}
                    // No task, so no pin: this panel describes the open FILE, and the copy it means
                    // is the one on disk. The focused project rather than the selected task's, for
                    // the same reason.
                    {...(state.stateId !== null
                      ? { onOpenConfig: () => openConfigPanel(state.stateId!, { project: state.at }) }
                      : {})}
                    onRevealIssue={(path) => setReveal((last) => ({ path, nonce: (last?.nonce ?? 0) + 1 }))}
                  />
                )}
              </aside>
            </div>
          ) : null}

          {view === "tasks" ? (
            <div
              className={`view tasks-view${state.taskFocus !== null ? " narrowed" : ""}`}
              style={{ "--pane-right": `${panelWidth(PANE.tasksPanel, PANE_CEILING.tasks)}px` } as CSSProperties}
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
                          seen={ui.seen}
                          onSeen={actions.markProjectSeen}
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
                          selectedSet={picked !== null && picked.project === p.project ? pickedSet! : undefined}
                          numbered={state.boards[p.project]!.level !== ""}
                          onSelectTask={(taskId, e) => pickTask(p.project, taskId, e)}
                          // Clicking a COLUMN describes the state it stands for, in the panel that
                          // describes whatever was last clicked — the Files view's answer to clicking
                          // a state in the tree, reached from the board instead. The project travels
                          // with it: a shared root is a column on every board, and the run the panel
                          // would start belongs to the one it was clicked on.
                          onSelectColumn={(stateId) => actions.selectWorkflow(stateId, p.project)}
                          selectedColumn={state.taskWorkflowProject === p.project ? state.taskWorkflow : null}
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
                          onTaskMenu={(card, x, y) => openTaskMenu(p.project, card, x, y)}
                          // What the running workflows are WAITING for somebody to do
                          // (`on_user_event`, WORKFLOWS.md §7.4). Computed per board, because a wait
                          // is an offer only where both ends of it are on screen: the card, and the
                          // column its rule names.
                          dragOffers={dragOffersOf(state.boards[p.project]!, state.userEvents)}
                          onTaskDrop={(requestId) => void actions.deliverUserEvent(requestId)}
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
                max={pinned !== null ? PANE_WIDE : PANE_CEILING.tasks}
                onChange={(size) => actions.setPane(PANE.tasksPanel, size)}
              />

              <aside className={`col panel${pinned !== null ? " holding" : ""}`}>
                {/*
                  What a click on a card gets you: that task's CONVERSATION. Clicking a card asks what
                  the run said, and the panel used to answer with an instance tree and a list of event
                  types — facts about the run, none of which is the run — so reading one meant leaving
                  for the Files view to find the transcript. The detail is still here, behind the
                  toggle in the header, which is the order they are wanted in.
                */}
                {pinned !== null ? (
                  <PinnedPane pinned={pinned} onClose={() => setPinned(null)} />
                ) : state.taskWorkflow !== null ? (
                  // A COLUMN is what was last clicked, so the column is what the panel is about — the
                  // same inspector the Files view puts beside a state, with the same sections in the
                  // same order, because it is the same question asked from the other view. Selecting
                  // a card takes it back; see `selectWorkflow`.
                  <StateInspector
                    state={state.taskState}
                    {...(workflowRunSurface !== undefined ? { run: workflowRunSurface } : {})}
                    // Only when it was reached by ASKING — the link in a conversation's gutter. A
                    // column click has a card click as its way back, and an arrow there would offer
                    // a second answer to a question the board already answers.
                    {...(state.inspect === "workflow" ? { onBack: () => actions.selectWorkflow(null) } : {})}
                    onOpenConfig={() =>
                      state.taskWorkflow !== null
                        ? openConfigPanel(state.taskWorkflow, {
                            project: state.taskWorkflowProject,
                            ...(detail !== null ? { taskId: detail.taskId } : {}),
                          })
                        : undefined
                    }
                  />
                ) : detail ? (
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

          {view === "chat" ? (
            /*
              One column by DEFAULT, and still for the same reason: a conversation has nothing beside
              it to describe. The facts a task panel would list — which state, which instance, what it
              cost — belong to the Tasks view, which the conversation's task is on like any other, and
              putting them here would be answering a question nobody reading a thread has asked.

              A second column appears only when somebody asks for one, by pinning a value to it. That
              is the case the rule above never covered: an artifact is produced IN the conversation,
              and the one place it cannot be read is the column it was produced in, because the next
              turn pushes it off the screen. So the panel is not a description of the thread — it is
              a thing taken out of the thread and held still. It exists while it holds something and
              not a moment longer.
            */
            <div
              className={`view chat-view${pinned !== null ? " with-panel" : ""}`}
              style={{ "--pane-right": `${paneOf(ui, PANE.chatPanel)}px` } as CSSProperties}
            >
              <ChatView surface={chat} />
              {pinned !== null ? (
                <>
                  <Splitter
                    label="Resize the context panel"
                    value={paneOf(ui, PANE.chatPanel)}
                    reset={paneDefault(PANE.chatPanel)}
                    invert
                    min={280}
                    max={PANE_WIDE}
                    onChange={(size) => actions.setPane(PANE.chatPanel, size)}
                  />
                  <aside className="col panel holding">
                    <PinnedPane pinned={pinned} onClose={() => setPinned(null)} />
                  </aside>
                </>
              ) : null}
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
              hasProject={state.at !== null}
              onRun={(options) => void actions.debugRun(options)}
              onCancel={() => void actions.debugCancel()}
              onInstall={(force) => void actions.debugInstall(force)}
              onRecheck={actions.debugRefresh}
              onDismissError={actions.debugDismissError}
              onOpenState={(stateId) => void actions.openWorkflow(stateId, "base")}
              onShowSession={actions.showSession}
              validateSchema={actions.validateSchema}
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
                  hasProject={state.at !== null}
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
                    editable={state.configLayer === "base" || state.at !== null}
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
                    editable={state.configLayer === "base" || state.at !== null}
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
                    editable={state.configLayer === "base" || state.at !== null}
                    onSaveModels={actions.saveModels}
                    onSaveExecutor={actions.setExecutorConfig}
                    onSaveDefinition={actions.saveDefinition}
                  />
                ) : null}
                {state.section === "appearance" ? (
                  <AppearancePane appearance={state.settings.appearance} busy={state.busy} onChange={actions.setAppearance} />
                ) : null}
                {state.section === "history" && state.at !== null ? (
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

        <InboxStrip
          pending={pending}
          approvals={state.approvals}
          questions={state.questions}
          projects={state.projects}
          hues={projectHues}
          onSelect={actions.select}
        />
      </div>

      {state.questions.length > 0 ? (
        // The agent ASKED — that outranks everything else waiting, because it is the one item the
        // person was explicitly addressed by.
        <QuestionDialog
          key={state.questions[0]!.requestId}
          pending={state.questions[0]!}
          error={state.error}
          onSubmit={(answers) => actions.answerQuestion(state.questions[0]!.requestId, answers)}
        />
      ) : state.approvals.length > 0 ? (
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
          editor={{
            drafts: state.drafts,
            onDraft: actions.setDraft,
            validateSchema: actions.validateSchema,
            wrapJson: state.settings.wrapJson,
            onWrapJson: (wrap) => void actions.setWrapJson(wrap),
          }}
        />
      ) : null}

      {taskMenu !== null ? <ContextMenu anchor={taskMenu} onClose={() => setTaskMenu(null)} /> : null}
      {taskAsk !== null ? <AskDialog spec={taskAsk} onCancel={() => setTaskAsk(null)} /> : null}

      {/* A folder that is not a project YET. The same dialog every other "are you sure" uses, and
          deliberately not `danger`: this creates a directory beside the person's work rather than
          taking anything away, and it is the one gesture that turns a checkout into somewhere JaiRA
          can run. Dismissing leaves the folder exactly as it was found. */}
      {state.initPrompt !== null ? (
        <AskDialog
          spec={{
            title: `Set up JaiRA in ${projectName(state.initPrompt)}?`,
            note: `${state.initPrompt} is not a JaiRA project yet. Setting it up creates a .jaira/ folder there for its workflows, settings and run history. Nothing else in the folder is touched.`,
            confirmLabel: "Set up project",
            onConfirm: () => void actions.initProject(),
          }}
          onCancel={actions.dismissInit}
        />
      ) : null}

      {/* Right-click on CONTENT — a selection, a picture, a link — anywhere in the window, including
          inside an artifact frame. Mounted once and unconditionally: see `pointerMenu.tsx` on why a
          menu that exists in some views and not others is one people stop reaching for. */}
      <PointerMenus />

      {state.error ? (
        <div className="toast" onClick={actions.dismissError}>
          {state.error}
        </div>
      ) : null}
    </div>
    </MessageTypeContext.Provider>
    </ValuePanelContext.Provider>
  );
}
