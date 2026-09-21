/**
 * Renderer store (DESIGN §11.2): the board is a *subscription*, not a poll.
 *
 * Pushes from main say what changed (`store:invalidate`, `engine:event`); this
 * store refetches the affected view. It deliberately derives nothing about engine
 * semantics — statuses, columns and active paths all arrive pre-projected, which
 * is what keeps the UI from disagreeing with the engine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JsonValue } from "@declarative-ai/json";
import type {
  ApprovalScope,
  BoardView,
  ConfigLayer,
  ConfigView,
  ConversationView,
  JobOutputChunk,
  LogEntry,
  LogPolicy,
  LogQuery,
  ProjectSummary,
  ProjectTask,
  OperationRecordView,
  SessionRef,
  SessionView,
  AvailabilitySnapshot,
  ExecutorInfo,
  JairaOperationNode,
  JairaUiState,
  FileMutationResult,
  FileNode,
  FileSource,
  FileTree,
  HistorySize,
  ChatSettings,
  InstanceNode,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResponse as Response,
  JairaBridge,
  JairaSettings,
  Appearance,
  ConversationLook,
  JairaTheme,
  PendingApproval,
  ModuleApproval,
  StartTaskRequest,
  PendingQuestion,
  PendingUserEvent,
  PendingInteraction,
  ProbeResult,
  PushMessage,
  SecretCapabilities,
  SecretTarget,
  Changeset,
  StateView,
  SyncDirection,
  TaskDetail,
  BuiltInLeftover,
  WorkflowMutationResult,
  WorkflowSyncEdit,
  WorkflowSyncResult,
  WorkflowSyncStatus,
  EditorKind,
  EditorLook,
  TaskSummary,
  WorkflowEntry,
  WorkflowLayer,
  WorkflowSource,
  RendererChoice,
  RendererEdit,
} from "@jaira/shared/browser";
import {
  CONFIG_JSON,
  defaultAppearance,
  defaultConversationLook,
  defaultEditors,
  defaultLogPolicy,
  defaultRendererChoice,
  isTextMime,
  SHARED_SESSION,
  WORKFLOW_JSON,
  type WritingTool,
} from "@jaira/shared/browser";
import {
  docKey,
  movedDraft,
  movedDraftsUnder,
  settled,
  withDraft,
  withoutDraftsUnder,
  type Drafts,
} from "./drafts";
import {
  addGenericExecutor,
  applyExecutorPatch,
  removeGenericExecutor,
  type ExecutorPatch,
  type ExecutorTarget,
} from "./executorConfig";
import { applyModelPatch, type ModelPatch } from "./modelsConfig";
import type { FileSelection } from "./files";
import type { EditorTab } from "./editorChrome";
import {
  instanceAt,
  newestRunOf,
  runFieldsOf,
  runHistoryOf,
  runTargetOf,
  runTitle,
  workflowLayerOf,
  workflowMimeOf,
  type RunField,
} from "./runForm";
import { instanceOf, nodeAt, prunedTrail, sameTrail, stepOf, type TrailStep } from "./trail";
import { SELF_TEST_ROOT, SELF_TEST_STATES, selfTestScript } from "./debugWorkflow";
import { CHAT_AGENT, CHAT_STATES, titleOf } from "./chatWorkflow";
import { applyAppearance } from "./appearance";
import { applyEditors } from "./editorLook";
import { publishRenderChoices } from "./renderChoice";
import { unseenTasks } from "./pill";
import { sessionKey, withoutSession } from "./sessionCache";
import { alreadyFolded, foldLiveTurn, liveTurnOfSnapshot, tailIsAhead } from "./liveTurnFold";
import {
  emptyUiState,
  forgetSeen,
  SHUT,
  toggleShut,
  toggleUnfolded,
  withShut,
  withUnfolded,
  withMode,
  withOpen,
  withPane,
  withSeen,
  withSeenAll,
} from "./uiState";

/** A prune plan or result, as `history:prune` returns it. */
export type PruneReport = Response<"history:prune">;

declare global {
  interface Window {
    jaira?: JairaBridge;
  }
}

function bridge(): JairaBridge {
  const api = window.jaira;
  if (!api) throw new Error("the JaiRA bridge is unavailable (preload did not run)");
  return api;
}

export async function invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  return bridge().invoke(channel, request);
}

/**
 * Listen to what main pushes, from outside the store.
 *
 * Almost everything pushed is state this hook owns, so almost every push is handled below. The
 * exception is a message that is not about state at all — a right-click that happened in a frame,
 * which is an event with a place on screen and no bearing on anything stored. Routing that through
 * the store would mean holding a menu position in application state until something drew it.
 */
export function subscribe(listener: (message: PushMessage) => void): () => void {
  return bridge().subscribe(listener);
}

/** See {@link AppState.inspect}. */
export type InspectSubject = "path" | "task" | "workflow";

export interface AppState {
  /**
   * The project the shell is STANDING ON — the first crumb of the address (SHELL.md §2.2).
   *
   * Not "the open project": several are open at once, and this one is derived from where you have
   * navigated rather than from what has been loaded. It moves when you narrow the Tasks board, open
   * a file, or select a task; it moves nothing else when it moves, and opening a project no longer
   * closes the one you were on.
   *
   * It is what every project-scoped call names, which is the whole reason it exists as one field: a
   * window that could not say which project it was standing in had to let main guess, and a guess
   * reads the wrong database.
   *
   * Null is the ROOT — "all projects", a real place and not "nothing chosen". Settings edits `base`
   * there, the Tasks board lists every group, and the composer asks which project once.
   */
  at: string | null;
  tasks: TaskSummary[];
  /**
   * The SELECTED root's own tasks — runs of the workflows that live in it.
   *
   * Beside {@link tasks} rather than merged into it, because they answer different questions and
   * mixing them is the pollution separate projects exist to prevent. Held because a state in the
   * shared root runs there: its history is these, and it is readable with no checkout open at all.
   *
   * Scoped to the root by construction: repoint the root and this is a different database, so the
   * old library's runs stop being listed. That is deliberate — they were that library's.
   */
  sharedTasks: TaskSummary[];
  board: BoardView | null;
  /**
   * The board level the Tasks view is showing. `null` is the ROOT LISTING — one column per workflow
   * root — which is a different projection, not a missing level, so it gets its own value rather
   * than being spelled `undefined` and confused with "not loaded yet".
   */
  level: string | null;
  selected: string | null;
  detail: TaskDetail | null;
  pending: PendingInteraction[];
  /** Per-command approvals awaiting a decision (DESIGN §10.2). */
  approvals: PendingApproval[];
  /**
   * A start that stopped on the js/ts module gate, and the files it is waiting on (SPEC §7.5.5).
   *
   * Deliberately NOT folded into {@link approvals}: that inbox is per-COMMAND and mid-run, raised by
   * a tool call a model made. This is answered before anything runs at all, it is about source on
   * disk rather than a command line, and its answer is durable — approving here writes a machine-local
   * record that outlives the task. One inbox for both would have to explain that difference anyway.
   */
  moduleApproval: { request: StartTaskRequest; files: ModuleApproval[] } | null;
  /** Mid-run questions a running agent asked (`AskUserQuestion`) — answered, never approved. */
  questions: PendingQuestion[];
  /**
   * Transitions waiting on a gesture (`on_user_event`) — what makes a card draggable.
   *
   * Not an inbox: nothing here is rendered as a request. The board reads it to decide which cards can
   * be picked up and which columns will accept them, so the list's only visible effect is an
   * affordance appearing on a card somebody was already looking at.
   */
  userEvents: PendingUserEvent[];
  /** Live event lines for the selected task, newest last. */
  stream: string[];
  /** How much history is stored, for the pruning panel. */
  history: HistorySize | null;
  /** The last prune plan (dry run) or applied result — never auto-applied. */
  prune: PruneReport | null;
  error: string | null;
  /**
   * A directory somebody chose to open that is not a project yet, held until they answer.
   *
   * Not an error, which is the point of it having its own field. A folder with no `.jaira/` is how
   * every project starts, so the answer to picking one is an offer to set it up — `project:init` on
   * the same path — and not a red toast quoting the message `project:open` throws. Null when there is
   * no such question outstanding.
   */
  initPrompt: string | null;
  busy: boolean;

  // --- settings, executors and workflow authoring ---------------------------

  /** User preferences. Loaded before the first paint settles, so the theme applies immediately. */
  settings: JairaSettings;
  /** Both configuration layers plus the merged result; null until first read. */
  config: ConfigView | null;
  /** Every executor this project could use, enabled or not. */
  executors: ExecutorInfo[];
  /** The most recent health check, keyed by executor name. */
  probes: Record<string, ProbeResult>;
  /**
   * What the PROVIDER routes reported, keyed by route prefix.
   *
   * A separate map from `probes` rather than one keyed namespace: an executor and a route are
   * different things that happen to be checkable, and a shared map would collide the moment someone
   * configures a generic CLI called `local`.
   */
  modelProbes: Record<string, ProbeResult>;
  /**
   * The whole availability picture as main last observed it, including WHEN.
   *
   * `probes`/`modelProbes` are this snapshot indexed for lookup; this is kept beside them for the two
   * things an index cannot carry — the time of the check, and the model that would be chosen. A screen
   * that shows a green badge without saying when it was earned is a screen that ages badly.
   */
  availability: AvailabilitySnapshot;
  /** True while a re-check is in flight, so the button can say so. */
  rechecking: boolean;
  /** What the secret store can do here — decides which "save key to…" options are offered. */
  secrets: SecretCapabilities;
  /**
   * The schema each document has been held to, keyed by `layer:path`.
   *
   * Per file rather than global: a picker that reset on every selection would be re-chosen constantly,
   * and one that remembered a single choice would apply a state schema to the next `.json` you opened.
   * Session-scoped — this is a view preference about a file, not a fact about it, and writing it to
   * disk would mean deciding which layer it belonged to.
   */
  schemaChoice: Record<string, string>;

  /**
   * Unsaved edits, keyed by `layer:path` — see `drafts.ts`.
   *
   * Here rather than inside the editors because a draft has to outlive the component showing it:
   * clicking another file unmounts that editor and switching to Tasks unmounts the entire view, and
   * neither is a decision to discard what someone typed. An entry exists only while it DIFFERS from
   * the file, which is also what lets the tree mark the rows with something pending.
   */
  drafts: Drafts;

  /**
   * Which tab a state file's editor was left on, keyed the same way.
   *
   * Per file for the same reason the schema choice is: one remembered globally would put you on the
   * JSON tab of the next state you opened because of a raw edit made to a different one.
   */
  editorTab: Record<string, EditorTab>;

  /**
   * The reading last CHOSEN, for a file nothing has been remembered about.
   *
   * Per file is the rule (see {@link editorTab}) and this is what it falls back to. Opening a child
   * from the graph should land you in the graph — you were reading a picture and you asked for the
   * next one — and the same holds for someone working through a directory on the JSON tab. Only an
   * explicit click on a tab moves it, so it is a statement about how the person is working rather
   * than a trail left by wherever they happened to navigate.
   */
  editorTabLast: EditorTab;

  /**
   * What a state's run form holds, keyed by STATE ID — the whole form once anything in it has changed.
   *
   * Keyed by state id rather than by `layer:path` — the two layers hold two copies of one state, but
   * a run names the id and gets whichever copy the search path resolves, so remembering the boxes
   * per file would split one form's contents across two keys that run the same thing.
   *
   * A state with no entry opens at its declared shape — required slots at a value, the rest NOT SET —
   * and the first change stores the whole form, because "not set" is a key's ABSENCE: a sparse overlay
   * could not tell a slot someone switched off from one nobody touched. Held here rather than in the
   * panel for the reason the drafts are: the inspector unmounts on the next click in the tree.
   */
  runValues: Record<string, Record<string, JsonValue>>;

  /**
   * Every workflow ROOT that can be started here, as the picker lists them.
   *
   * The New-task form used to ask for the root id as free text, which is a box you can only fill
   * from memory and which reports a typo as "unknown state" after the click. Held in the store
   * rather than fetched by the popover because the popover is unmounted whenever it is shut, and a
   * round trip on every open is a picker that appears empty and then fills in.
   *
   * The FOCUSED project's, plus the shared root's — which is what `workflow:browse` answers and what
   * the board's root listing draws its columns from. Refetched on the same `workflows` invalidation
   * the tree and the lint surface use, so a root added on disk appears in the picker.
   */
  workflows: WorkflowEntry[];

  /**
   * What a workflow DECLARES it needs, keyed by state id — the boxes its form draws.
   *
   * Read from the saved file through `workflow:read`, exactly as the Files inspector reads them from
   * the open document, so one workflow asked about in two places produces one form. Three values per
   * key and all three are distinct: absent is "never asked", `null` is "asked, and the file does not
   * parse", and an array is the answer — a state with no inputs being the empty one.
   *
   * A CACHE, and deliberately not cleared on a `workflows` invalidation: what is stale here is one
   * file's inputs, and re-reading every workflow anyone has looked at because an unrelated one was
   * saved is a round trip per keystroke of somebody else's editing. Whatever the picker or the panel
   * selects is re-read on selection, which is the moment the answer is about to be shown.
   */
  workflowForms: Record<string, RunField[] | null>;

  /**
   * The workflow the Tasks view has SELECTED — a column, not a card.
   *
   * The Tasks board's columns are states: whole workflows at the root listing, and children of one
   * below it. Clicking a card has always described the run; clicking the place the run sits in used
   * to describe nothing at all, and the same state opened in the Files view had a whole panel — its
   * inputs, its validation, its history, a button to run it. This is that panel, reached from the
   * board.
   *
   * It OUTRANKS the selected task while it is set, and is cleared by selecting a task, because the
   * two are one column with one subject: the last thing clicked is what the panel is about.
   */
  taskWorkflow: string | null;
  /**
   * WHICH project's board that column was clicked on.
   *
   * A workflow root is listed on every board that can reach it — the shared library's roots appear
   * as columns on each open checkout — so "this workflow" is not a place by itself. The project is
   * where a run started from the panel would be recorded and which task list its history reads, and
   * getting it from the group the click came from is the only way it can be right for a root that is
   * on three boards at once.
   */
  taskWorkflowProject: string | null;
  /**
   * The state view behind {@link taskWorkflow}.
   *
   * Its own field rather than the Files view's {@link state}, which looks like a duplicate and is
   * not: that one is tied to the open FILE, and having a click on a board column rewrite it would
   * leave the Files inspector describing a state its tree is not standing on the next time it is
   * opened.
   */
  taskState: StateView | null;
  /**
   * WHICH run the workflow being described was reached from, when it was reached from a conversation.
   *
   * A workflow inspector opened off a board column describes the state in general — its inputs are
   * empty boxes waiting for a new run. Opened from a panel's gutter it is describing a conversation
   * that already happened, and the boxes should hold what that pass was called with. Null is the
   * general case, which is the one the column click has always produced.
   */
  taskWorkflowRun: string | null;

  /**
   * Where the open description and the state files stand, and the last proposal.
   *
   * Beside the drafts rather than inside the panel showing it, for the reason every other piece of
   * this view state is: a sync is a model call that takes a while, and a result held by a component
   * would be discarded by clicking anything during the wait. `result` is cleared when another file
   * is opened — a proposal is about one document, and showing it over another would be a lie about
   * which one it read.
   */
  sync: SyncState;
  /** The Chat view: which conversation is open. */
  chat: ChatState;
  /**
   * Which tasks have a call in flight RIGHT NOW, by task id and depth.
   *
   * The one thing `status` cannot answer for a conversation. A typed turn is deliberately not a run —
   * no workspace, no job, no status change (see `runChatMessage`) — so a task that is answering its
   * fourth message is still `completed` as far as the task list is concerned. What does move is the
   * journal: every call emits `operation.started` and exactly one terminal event, whatever happens to
   * it, and those are published for every task rather than only the selected one.
   *
   * A DEPTH rather than a flag, because a composite state's children emit the same pair inside their
   * parent's: counting means a child settling does not report the parent as finished.
   */
  producing: Record<string, number>;

  /** The Debug view's self-test — see {@link DebugState}. */
  debug: DebugState;

  /**
   * The file open in the middle panel — any file, not just a state.
   *
   * One document rather than one per type, because the panel's two halves must be looking at the
   * same revision of the same thing: a viewer reading one source and an editor writing another is
   * how a preview ends up describing a file that no longer exists.
   */
  doc: FileSource | null;

  /**
   * The DIRECTORY open in the middle panel, when a directory is what was opened.
   *
   * Beside {@link doc} rather than folded into it, because a folder is not a document: it has no
   * text, no viewer and no editor, and giving it a `FileSource` with an empty body would make every
   * surface in the registry have to know it was lying. Exactly one of the two is set — opening
   * either clears the other, which is what makes "what is the panel showing" a question with one
   * answer.
   *
   * A path of `""` is the layer root itself, which is a real place you can stand: it is what the
   * chevron before the project crumb navigates to.
   */
  dir: FileSelection | null;

  // --- the shell ------------------------------------------------------------

  /** Which of the three views the rail has selected. */
  view: View;
  /** Both layer roots as trees — the Files view's left panel. */
  tree: FileTree | null;
  /** Copies of built-in states in the shared root that JaiRA wrote and nobody changed — see `refreshTree`. */
  leftovers: BuiltInLeftover[];
  /**
   * The state the open file defines, when it defines one.
   *
   * Kept beside {@link doc} rather than derived from it because plenty of the app still addresses
   * states by id — the board drills into one, the inspector reports drift against one — and null
   * here is the honest answer for a prompt.
   */
  stateId: string | null;
  /** Everything about that state: its board or its tasks, plus the inspector's subject. */
  state: StateView | null;
  /**
   * What the context panel is describing.
   *
   * `path` is the rule and the default: the panel describes the LAST ELEMENT OF THE ADDRESS BAR —
   * the run the path ends on, or the open file when no run is on it. It is not a third subject
   * beside "file" and "run"; it is the statement that those two are decided by the bar rather than
   * by a mode, which is what stops the two from disagreeing. Every navigation returns to it.
   *
   * `task` is the one deliberate exception, reached only by asking for it on the run's own panel.
   * A task is not a level of the address — a run belongs to one, but you cannot navigate to it —
   * so it cannot be expressed as a position, and any change to the bar drops back to `path`.
   */
  inspect: InspectSubject;
  /**
   * The state the inspector was describing before a task took it over — what Back returns to.
   *
   * Remembered rather than recomputed, because {@link stateId} moves underneath: a task's context
   * panel links to the other states it went through, and following one changes what "before" would
   * have meant. Null is a legitimate answer (a task clicked from the Tasks view came from no state),
   * and Back then simply puts the column back on the open file.
   */
  inspectFrom: string | null;
  /** The selected task's run, read out of the journal — what a leaf state shows. */
  conversation: ConversationView | null;
  /**
   * Every state the selected task went through, with the conversation each ran in.
   *
   * Distinct from `conversation`, which is a projection of the JOURNAL — states entered, tools
   * attempted, policy decisions. This is the transcript itself, which the journal never held.
   */
  sessionHistory: SessionRef[];
  /**
   * Every call the selected task made, by operation id — see `OperationCall`.
   *
   * Fetched with the history rather than per state: `run:records` is scoped to the task and a
   * conversation forty states deep would otherwise be forty round trips to answer one question. The
   * join is `InstanceNode.calls`, which the projection stamps from `operation.dispatched`.
   */
  records: Record<string, OperationRecordView>;
  /** The conversation of the state being looked at — one operation, whole. */
  session: SessionView | null;
  /** Which instance the viewer is showing. Null ⇒ the task's most recent. */
  sessionInstance: string | null;
  /**
   * Transcripts by instance id, for the composite view — several cards can be open at once.
   *
   * Beside {@link session} rather than replacing it: that one is "the conversation being read",
   * which the leaf and the task panel both point at, while this is a CACHE of the several a run's
   * children produced. Fetched on expand rather than up front, because rendering a list of eight
   * folded headers would otherwise cost eight round trips before anyone had asked to read one.
   *
   * Keyed by RUN and instance (`sessionKey`) — see that function's note: durable ids no longer
   * collide across runs, but the record a transcript is read from is still filed per run, and legacy
   * journals hold counter ids that do repeat. Still cleared whenever the selected task changes.
   */
  sessions: Record<string, SessionView>;
  /**
   * What the app has said about itself, NEWEST FIRST, and the process output a row opened.
   *
   * A window onto the mirror rather than the whole of it: `logs` holds the pages fetched so far,
   * `logCursor` is where the next (older) page continues from, and `undefined` there means the log
   * has been read to its beginning. Held rather than fetched per render because entries also ARRIVE
   * — the main process pushes each one, and a push is a PREPEND now that the newest is at the top.
   */
  logs: LogEntry[];
  /** Where older entries continue from, or absent when there are none. See {@link LogPage}. */
  logCursor?: string;
  /** A page is in flight — what stops the scroll handler asking for the same one four times. */
  logsLoading: boolean;
  jobOutput: { jobId: number; chunks: JobOutputChunk[] } | null;
  /**
   * JaiRA's own runs, which belong to no checkout.
   *
   * Held separately from `tasks` because they answer a different question — mixing them is the
   * pollution the system project exists to prevent — and because a window with no project open has
   * these and nothing else.
   */
  /**
   * Every project the Tasks view draws a board for, and one board apiece.
   *
   * Grouped rather than merged: a board's columns are the children of ONE workflow state, so columns
   * from two projects side by side would be columns of different things. Each group keeps its own
   * drill level, because drilling into one is not a statement about the other.
   *
   * There is no folding here any more. Groups used to have an accordion header apiece, and once the
   * address bar became the header of the section you are scrolled to, that header was the same row
   * twice — so it went, and {@link taskFocus} does what folding was for: narrowing the column to the
   * project you are reading, reversibly, from the path rather than from a twisty.
   */
  projects: ProjectSummary[];
  /**
   * Every conversation in every open project, newest first — what the ROOT's Chat list shows.
   *
   * Separate from {@link tasks}, which is one project's, because it answers a different question:
   * this is "what have I been talking to, anywhere", and its order spans databases. Each row carries
   * its own project, because a row that cannot say whose task it is cannot be opened.
   */
  allConversations: ProjectTask[];
  boards: Record<string, BoardView | null>;
  levels: Record<string, string | null>;
  /**
   * Which project the Tasks view is NARROWED to, or null for the listing of all of them.
   *
   * The first segment of the Tasks address (see `taskBar.tsx`), and the only thing that decides how
   * many groups the column draws. Null is a real place rather than "nothing chosen" — it is the level
   * above every project, the same way the layer root is a place to stand in the Files view.
   *
   * Session-scoped on purpose, unlike {@link levels}: which board you had drilled into is where you
   * left your work, while which project you were reading is answered again by opening one.
   */
  taskFocus: string | null;
  /** Which project the selected task belongs to — a task id means nothing without it. */
  selectedProject: string | null;
  /**
   * The answer currently being written, before it is a turn.
   *
   * A record persists once, at the end of its operation — so without this a long agent run shows an
   * empty conversation for as long as it is thinking. `text` is the fragment tail of the answer;
   * `entries` is everything else the stream carried in order — finished turns (tool calls and results
   * ride on them) and events we may not even recognise, all rendered, because an hour-long agent
   * run whose tools are invisible reads as an agent doing nothing. Cleared when the record lands,
   * because the stored turn is the same content and better.
   *
   * `sidechains` is the same accumulation for SUBAGENT turns, keyed by the tool call that spawned
   * each — entries tagged `parentToolUseId` land here and nowhere else. Kept apart from `entries`
   * because a subagent's words are not the main thread's (see `liveEntriesOf`); the doorway row
   * and the sidechain panel are what render them, while the run is still going.
   */
  liveTurn: {
    sessionId?: string;
    seq?: number;
    stateId?: string;
    /**
     * The last delta folded in, in main's per-task numbering. A `session:live` seed reports how
     * many deltas it already holds, so a push at or below this is skipped rather than applied
     * twice; absent on a tail built purely from pushes before any seed carried a number.
     */
    n?: number;
    text: string;
    thinking: string;
    /** When the tails began — what makes "still thinking, for 12 s" a number rather than a pulse. */
    textStartedAt?: number;
    thinkingStartedAt?: number;
    entries: JsonValue[];
    sidechains: Record<string, JsonValue[]>;
    /**
     * The tool call whose ARGUMENTS are still being written, when one is.
     *
     * The only trace a model producing a large argument leaves before the call exists — see
     * `WritingTool`. Without it, a minute spent writing a page is a transcript with nothing on it.
     */
    writing?: WritingTool;
  } | null;
  /**
   * The runs walked into below the open file — the tail of the Files view's address bar.
   *
   * The state-id crumbs come from the document and are fixed by which file is open; these are where
   * you went from there, and the viewer shows the LAST one. See `trail.ts` for why it is a list
   * rather than a selection, and why it is scoped to one task.
   *
   * Empty means "the state itself, before a run was chosen": a composite shows its task board and a
   * leaf asks you to pick one.
   */
  trail: TrailStep[];
  /**
   * The state view of the trail's tail, when the tail is deeper than the open file.
   *
   * Only for its DECLARED CHILDREN — a board's columns are what the state declares, so a child that
   * was never reached is still a column, and the instance tree alone cannot know about one. Null
   * when the tail is the open file's own state, which already has its view in {@link state}.
   */
  trailState: StateView | null;
  /** Which section the Settings view is showing. */
  section: SettingsSection;
  /**
   * Which configuration layer the Settings view is editing.
   *
   * An axis rather than a section, because it crosses two of them: Config and Executors are both
   * per-layer, and listing "This project" and "Shared" as siblings of "Executors" made the layer a
   * place you navigated to for one and a picker you operated for the other — two mechanisms for one
   * question, which is how the two ended up able to disagree.
   */
  configLayer: ConfigLayer;
}

/**
 * One state file of the self-test, as the Debug view finds it on disk.
 *
 * `layer` is the answer the pane leads with: the self-test SHIPS (decision 0006), so `system` is the
 * ordinary case and anything else is a person's copy winning over it — which a run will use, and
 * which is therefore the first thing to know about a self-test that behaves oddly.
 */
export interface DebugFile {
  stateId: string;
  /** Absolute path of the copy that loads, for the "where is this" line. Empty when none was found. */
  file: string;
  /** The layer that copy is in, or `null` when no layer holds the state at all — a broken build. */
  layer: WorkflowLayer | null;
  /** The copy that loads, as text: what the pane shows under "the state files". */
  text: string;
  /** Set on a person's copy that is identical to a version JaiRA shipped — see `BuiltInStanding`. */
  identical?: "current" | "superseded";
}

/**
 * The Debug view's own state.
 *
 * Everything else it shows — the instances, the conversation, the live events — belongs to the
 * SELECTED task and is already held above, because the self-test is an ordinary task and the point
 * of running it here is that it goes through the ordinary machinery. What is genuinely this view's
 * is only this: where the files are, which run it started, and how it is being run.
 */
export interface DebugState {
  files: DebugFile[];
  /** The self-test task this window started, if any. Null until the first run. */
  taskId: string | null;
  /** True while starting — the buttons say so rather than doing it twice. */
  busy: boolean;
  /** The last failure, kept beside the pane rather than in the global toast, which scrolls away. */
  error: string | null;
}

/** The sync surface's state: the last answer, the last proposal, and whether one is in flight. */
export interface SyncState {
  status: WorkflowSyncStatus | null;
  result: WorkflowSyncResult | null;
  running: boolean;
  error: string | null;
  /**
   * What the run is doing, while it does it.
   *
   * A sync is a task in JaiRA's OWN project, so its engine events name a task this window has not
   * selected and the per-task stream drops them. Without this the panel showed one static line for
   * however long three model calls take — which is indistinguishable from a button that did nothing.
   */
  progress: string[];
}

/**
 * What is left of a sync when another file is opened.
 *
 * The proposal and the status are about ONE document, so both go. `running` does not: a sync in
 * flight is still in flight, and clearing the flag would offer a second Run while the first is
 * still going — which main refuses, so the only thing it would produce is an error.
 */
function clearedSync(sync: SyncState): SyncState {
  return sync.result === null && sync.status === null && sync.error === null
    ? sync
    : { status: null, result: null, running: sync.running, error: null, progress: sync.progress };
}

/**
 * Fold an availability snapshot into the three fields the panes read.
 *
 * The snapshot is kept whole AND indexed, rather than one or the other, because the two shapes answer
 * different questions and deriving either on every render is worse than storing both: a row needs its
 * own result by name, and the pane header needs the check's time and the model it settled on.
 */
function applyAvailability(patch: (next: Partial<AppState>) => void, availability: AvailabilitySnapshot): void {
  const index = (results: ProbeResult[]): Record<string, ProbeResult> =>
    Object.fromEntries(results.map((result) => [result.name, result]));
  patch({
    availability,
    probes: index(availability.executors),
    modelProbes: index(availability.routes),
  });
}

/**
 * The Chat view's own state.
 *
 * Small on purpose. A conversation IS a task (see `chatWorkflow.ts`), so everything about the one on
 * screen — its detail, its instance tree, its transcript, the live turn streaming into it — is
 * already held above under the ordinary selection, and duplicating any of it here would be two
 * copies to keep in step. What is genuinely this view's is which conversation it is reading. (It
 * used to hold whether the chat states had been installed; they ship now, decision 0006.)
 *
 * `taskId` is held SEPARATELY from `selected` even though opening a conversation selects it: the
 * Tasks view selects too, and a person who goes to look at a board and comes back expects to find
 * the conversation they left rather than the card they last clicked.
 */
export interface ChatState {
  /** The open conversation, or null for the empty view. */
  taskId: string | null;
  /** Which project holds it — the checkout when one is open, JaiRA's own root otherwise. */
  project: string | null;
  /** True while a conversation is being created and started — the first message is a run. */
  busy: boolean;
  /**
   * The message that OPENED the conversation, until the record holding it exists.
   *
   * The first message is the run's own prompt, and a run's record lands when its call settles — so
   * for the length of the first answer there is nothing on disk that contains what the person just
   * typed. Held here so the thread can show it anyway. Every later message is the composer's own
   * problem and does not come through the store.
   */
  opening: string | null;
  /** The last failure, beside the composer rather than in the toast that scrolls away. */
  error: string | null;
}

/** The destinations on the activity rail. */
export type View = "files" | "tasks" | "chat" | "logs" | "debug" | "gallery" | "settings";

/**
 * Sections of the Settings view — everything that was never one of the two activities.
 *
 * `providers`, `executors` and `config` are read at the layer {@link AppState.configLayer} names;
 * `history` is a project's run journal and has no layer to pick — nor anything to show without a
 * project, which is why the shell hides it on an empty window rather than rendering it empty.
 */
export type SettingsSection = "providers" | "executors" | "integrations" | "files" | "appearance" | "conversation" | "config" | "history";

const EMPTY: AppState = {
  at: null,
  tasks: [],
  sharedTasks: [],
  board: null,
  level: null,
  selected: null,
  detail: null,
  pending: [],
  approvals: [],
  moduleApproval: null,
  questions: [],
  userEvents: [],
  stream: [],
  history: null,
  prune: null,
  error: null,
  initPrompt: null,
  busy: false,
  // Light until the saved preference says otherwise, matching the stylesheet's own default so the
  // first paint and the loaded setting agree in the common case. The layout starts EMPTY rather than
  // at the defaults: an absent id means "whatever this control opens at", so the first paint is the
  // default layout without this having to restate what those numbers are.
  settings: {
    theme: "light",
    ui: emptyUiState(),
    appearance: defaultAppearance(),
    editors: defaultEditors(),
    renderers: {},
    logging: defaultLogPolicy(),
    projects: [],
    filesHidden: [],
    conversation: defaultConversationLook(),
  },
  config: null,
  executors: [],
  probes: {},
  modelProbes: {},
  availability: { routes: [], executors: [], checkedAt: 0 },
  rechecking: false,
  secrets: { keychain: false },
  schemaChoice: {},
  sync: { status: null, result: null, running: false, error: null, progress: [] },
  chat: { taskId: null, project: null, busy: false, opening: null, error: null },
  producing: {},
  debug: { files: [], taskId: null, busy: false, error: null },
  drafts: {},
  editorTab: {},
  editorTabLast: "form",
  runValues: {},
  workflows: [],
  workflowForms: {},
  taskWorkflow: null,
  taskWorkflowProject: null,
  taskWorkflowRun: null,
  taskState: null,
  doc: null,
  dir: null,
  view: "tasks",
  tree: null,
  leftovers: [],
  stateId: null,
  state: null,
  inspect: "path",
  inspectFrom: null,
  conversation: null,
  sessionHistory: [],
  records: {},
  session: null,
  sessionInstance: null,
  sessions: {},
  logs: [],
  logsLoading: false,
  jobOutput: null,
  liveTurn: null,
  projects: [],
  allConversations: [],
  boards: {},
  levels: {},
  taskFocus: null,
  selectedProject: null,
  trail: [],
  trailState: null,
  section: "providers",
  configLayer: "project",
};

/** Keep the live log bounded — a long run would otherwise grow without limit. */
const STREAM_LIMIT = 300;
/**
 * How many diagnostics the renderer keeps.
 *
 * A bound on the WINDOW, not on the log: the whole of it is on disk and paged in as it is scrolled
 * to, so this is the point past which scrolling back further starts costing the top of the list —
 * which is exactly the trade a reader who has scrolled that far has already chosen.
 */
const LOG_LIMIT = 5000;

/** One page. Enough to fill a tall window twice over, so scrolling asks rather than stutters. */
const LOG_PAGE = 200;
/** How many lines of a sync's own narration the panel keeps. Enough for a three-state run. */
const SYNC_PROGRESS_LIMIT = 60;
/**
 * The journal events that change a run's SHAPE — see the `engine:event` case.
 *
 * A run enters a state, settles a call, leaves a state. Between those the instance tree and the
 * session history are exactly what they were, so refetching them per journal entry would be three
 * round trips to learn nothing. These four are the entries where that stops being true.
 */
const STRUCTURAL_EVENTS = new Set(["instance.entered", "instance.terminated", "operation.completed", "operation.failed"]);
/**
 * The journal entries that write a LINE into the run's own narration — everything `conversationView`
 * projects into a turn.
 *
 * A SUPERSET of {@link STRUCTURAL_EVENTS}, and it has to be its own set rather than a reuse: a
 * transition fired and a child that could not be entered move no instance and open no conversation,
 * so neither changes the tree or the session history — and both are a sentence in the story of the
 * run. `entered product → explore` is one of them.
 *
 * Until this existed the journal projection was refetched only on a `task` invalidate, which a run
 * publishes exactly once, when it ENDS. So the notes drawn between the panels — every state entered,
 * every transition taken, every child blocked — were frozen at whatever had happened by the moment
 * the task was opened, and the rest of the run's path appeared only after it was over.
 */
const NARRATED_EVENTS = new Set([
  ...STRUCTURAL_EVENTS,
  "operation.started",
  // The runs a fan-out made (decision 0003): a line at the mount, and the copies it names appear.
  "fanout.made",
  "transition.taken",
  "instance.blocked",
]);
/**
 * How long the layout has to stop changing before it is written to `user-settings.json`, in ms.
 *
 * Long enough that a drag is one write rather than several hundred, short enough that letting go of
 * a divider and quitting immediately still saves — which is the case the `pagehide` flush exists to
 * cover anyway. A click on a fold pays this too, and nobody can tell.
 */
const UI_WRITE_DELAY = 400;

/** One engine event as a line: what happened, and to which state. */
function engineLine(raw: unknown): string {
  const event = raw as { type?: string; stateId?: string; to?: string; outcome?: string };
  const detail = [event.stateId, event.to ?? event.outcome].filter(Boolean).join(" → ");
  return `${event.type ?? "event"}  ${detail}`;
}

/**
 * The window's state and the actions that move it.
 *
 * **One call site, and the views must not become a second** (SHELL.md §9.4). Every view component —
 * `Board`, `FileTreePanel`, `ChatView`, `ChatListPanel`, `TaskAddressBar`, `Sidebar` — takes its
 * address as PROPS and reaches for nothing global, which is what keeps them instanceable. The split
 * pane is wanted: authoring a state while watching it run is a different job from navigating, and one
 * pane cannot be in two places at once. A view that called this directly would bind itself to the
 * window and cost a rewrite to unbind.
 *
 * What is still per-window is the ADDRESS this holds — {@link AppState.at}, `view`, `doc`. Splitting
 * the pane means making those per-pane; the components are already ready for it.
 */
export function useApp() {
  const [state, setState] = useState<AppState>(EMPTY);
  /**
   * The state as callbacks need to read it: what is true NOW, not what was last painted.
   *
   * Declared before {@link patch} because that is what writes it. The render-time assignment below
   * stays as the backstop that re-syncs after a functional update.
   */
  const ref = useRef(state);
  /**
   * Apply a partial update, and keep {@link ref} in step with it IMMEDIATELY.
   *
   * The ref used to be assigned during render and nowhere else, so `ref.current` meant "the state as
   * of the last paint" — while every reader of it in this file is a callback asking "what is true
   * now". Between a `patch` and the render it schedules those are different answers, and the gap is
   * not theoretical: a caller that set `at` and then refreshed in the same tick read the
   * value from before it set it, decided no project was open, and wrote an empty list that nothing
   * retried because nothing had failed.
   *
   * Assigning here closes the gap for every reader at once, which is better than each of them
   * learning to thread the new value through by hand. The render-time assignment stays as the
   * backstop: it is what re-syncs the ref after a functional update computed from the real state.
   */
  const patch = useCallback((next: Partial<AppState>) => {
    ref.current = { ...ref.current, ...next };
    setState((s) => ({ ...s, ...next }));
  }, []);
  /**
   * Update the Debug slice from its LATEST value rather than from {@link ref}.
   *
   * `patch({ debug: { ...ref.current.debug, … } })` is the shape the rest of this file uses for a
   * nested slice, and it is safe only when nothing else touched the slice since the last render.
   * A self-test run patches it four times across three awaits — install, re-read the files, start,
   * settle — so it is exactly the case where that assumption fails, and the visible symptom would
   * be the file list reverting to what it said before the install.
   */
  const patchDebug = useCallback((next: Partial<DebugState>) => {
    ref.current = { ...ref.current, debug: { ...ref.current.debug, ...next } };
    setState((s) => ({ ...s, debug: { ...s.debug, ...next } }));
  }, []);
  // The backstop: after a render the ref is the state, whatever the incremental writes above did.
  ref.current = state;

  const fail = useCallback((e: unknown) => patch({ error: (e as Error).message, busy: false }), [patch]);

  /**
   * The pending write of the remembered layout, and whether one has been read yet.
   *
   * Both are refs rather than state because neither is drawn. `hydrated` is the one that matters:
   * after the first successful read the RENDERER owns the layout, and a later `settings:read` — one
   * happens on every project open — must not overwrite a divider dragged a moment ago with what the
   * file said before the drag.
   */
  const uiWrite = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiHydrated = useRef(false);

  /**
   * A settings document from main, with THIS window's layout kept.
   *
   * Every write to `user-settings.json` answers with the whole file, and the layout inside it is up to
   * {@link UI_WRITE_DELAY} out of date — a divider dragged and the theme flipped a moment later
   * would answer with the width from before the drag and snap the pane back. Same rule as
   * {@link refreshSettings}: the file seeds the layout once, and the window owns it after that.
   */
  const keepingUi = useCallback((settings: JairaSettings): JairaSettings => {
    return { ...settings, ui: ref.current.settings.ui };
  }, []);

  /** Push the layout to disk now, cancelling any write that was waiting to happen. */
  const flushUi = useCallback(() => {
    if (uiWrite.current === null) return;
    clearTimeout(uiWrite.current);
    uiWrite.current = null;
    // Quiet on failure, and deliberately so: this is a cache of gestures. A preferences file that
    // cannot be written is not worth a toast over a window whose layout is already correct.
    void invoke("settings:write", { ui: ref.current.settings.ui }).catch(() => undefined);
  }, []);

  /**
   * Apply a layout change locally, and write it to disk once the gesture stops.
   *
   * The local patch is not debounced — it is what the pane is drawn from, so a dragged divider has
   * to follow the pointer. The FILE write is, because a drag is sixty of these a second and each one
   * is a `writeFileSync` in main. The value written is read from the ref at the moment of the write
   * rather than captured here, so the trailing call always stores where the drag ended.
   */
  const setUi = useCallback(
    (ui: JairaUiState) => {
      patch({ settings: { ...ref.current.settings, ui } });
      if (uiWrite.current !== null) clearTimeout(uiWrite.current);
      uiWrite.current = setTimeout(() => {
        uiWrite.current = null;
        void invoke("settings:write", { ui: ref.current.settings.ui }).catch(() => undefined);
      }, UI_WRITE_DELAY);
    },
    [patch],
  );

  /**
   * Do not lose the last gesture to the window closing.
   *
   * A layout change made inside {@link UI_WRITE_DELAY} of a quit is exactly the one someone would
   * notice missing — you drag a pane and close the app because you are done. `pagehide` fires on the
   * way out and is the last point at which the renderer can still reach main.
   */
  useEffect(() => {
    window.addEventListener("pagehide", flushUi);
    return () => {
      window.removeEventListener("pagehide", flushUi);
      flushUi();
    };
  }, [flushUi]);

  /**
   * The focused project's tasks.
   *
   * ASKED FOR unconditionally, and a refusal read as "none". The guard this replaces tested
   * `ref.current.at`, and `ref.current` is assigned during RENDER — so every caller that
   * patched `at` and then refreshed in the same tick (opening a project does exactly that)
   * read the value from before the patch, concluded there was no project, and wrote `tasks: []`.
   * Nothing retried it, because nothing had failed. It went unseen for as long as it did because
   * `state.tasks` had no reader until the Files inspector grew a run history — every other surface
   * reads the per-project boards from `project:list`.
   *
   * Main throws "no project is open" here deliberately, so that an empty answer cannot hide a real
   * mistake. That is still true of main; it is just not something to raise a toast about in a window
   * where having no project open is a perfectly ordinary state.
   */
  const refreshTasks = useCallback(async () => {
    // The guard is back, and it is now TRUSTWORTHY: `ref.current` is written by `patch` rather than
    // only at render, so "is a project open" is answered with the current value instead of the last
    // painted one. Without the guard main logs `no project is open` for every refresh in a window
    // that simply has no project — a real error, raised by design, about a question nobody asked.
    if (ref.current.at === null) return patch({ tasks: [] });
    try {
      // NAMED, not left to main to resolve. Unqualified it was answerable only while one project was
      // open, and threw "several projects are open" the moment a second one did — which is the whole
      // point of the rule, working, on a call that had simply not been told where it was standing.
      patch({ tasks: await invoke("task:list", { project: ref.current.at }) });
    } catch {
      // Quiet, not a toast: the overwhelmingly likely cause is a project closing underneath a
      // refresh already in flight, and an empty list is the right answer to that.
      patch({ tasks: [] });
    }
  }, [patch]);

  /**
   * JaiRA's own runs — a separate read, because they live in a separate project.
   *
   * NOT guarded on a user project the way {@link refreshTasks} is, and that is the point: the shared
   * root is browsable and now runnable with nothing open, so its history has to be readable in the
   * same mode. Main answers with an empty list rather than an error when JaiRA's project could not
   * be opened, so a failure here is a real one.
   */
  const refreshSharedTasks = useCallback(async () => {
    try {
      patch({ sharedTasks: await invoke("task:list", { project: SHARED_SESSION }) });
    } catch {
      // Quiet: the shared project materializes on first use, and a machine where it cannot be opened
      // at all is already saying so in the log. An empty list is the right answer either way.
      patch({ sharedTasks: [] });
    }
  }, [patch]);

  /**
   * Fetch one board level. `null` is the root listing, which is a different channel — the roots have
   * no parent state to be the children of, so there is nothing for `board:view` to project.
   *
   * Called with no argument it re-fetches whatever level is current, which is what a push
   * invalidation wants.
   */
  const refreshBoard = useCallback(
    async (level?: string | null) => {
      try {
        const next = level === undefined ? ref.current.level : level;
        // Named, like every other project-scoped read: the project is the head of the address and
        // this board is of whatever the shell is standing on. At the root there is none, and main
        // answers the roots board with an empty one rather than throwing.
        const at = ref.current.at === null ? {} : { project: ref.current.at };
        const board = next === null ? await invoke("board:roots", at) : await invoke("board:view", { level: next, ...at });
        patch({ board, level: next });
      } catch (e) {
        fail(e);
      }
    },
    [patch, fail],
  );

  /**
   * The Files tree. Refetched on the same `workflows` invalidation the lint surface uses.
   *
   * Quiet on failure, like the config read: the overwhelmingly common cause is no project being
   * open, and the panel already renders its own empty state for that. An error toast on switching
   * views would be noise reporting a condition the user can see.
   */
  /**
   * The project half of a layer-scoped address.
   *
   * A `base` address has one root and it is the shared one, so it names no project. A `project`
   * address is in whichever project the shell is standing on — `project` is a LAYER, not a project,
   * and with several open the pair is what identifies a file (SHELL.md §2.2).
   *
   * Empty at the root, where there is no project layer to be in. Main then answers only if there is
   * nothing to choose between, and reports rather than guessing if there is.
   */
  const inLayer = useCallback(
    (layer: WorkflowLayer, project?: string): { project?: string } => {
      if (layer === "base") return {};
      const at = project ?? ref.current.at;
      return at === null || at === undefined ? {} : { project: at };
    },
    [],
  );

  const refreshTree = useCallback(async () => {
    try {
      // WHERE THE SHELL IS STANDING, because that is what the tree draws now: one project's own
      // folder, or `~/.jaira` when that is the row you are on. Read off the ref rather than taken as
      // an argument so every existing caller — a save, a create, a push telling us the disk moved —
      // keeps asking about the right place without knowing there is a place to ask about.
      const at = ref.current.at;
      patch({ tree: await invoke("files:tree", at === null ? {} : { project: at }) });
    } catch {
      patch({ tree: null });
    }
    // With the tree, because the tree is where it is offered: the copies of built-in states the old
    // install steps left in the shared root (decision 0006), which the "Built in" root offers to
    // delete. Every write that redraws the tree can change the list, and none of them knows it.
    // Quiet on failure — this is housekeeping, and a tree must not fail to draw over it.
    try {
      patch({ leftovers: await invoke("builtin:leftovers", undefined) });
    } catch {
      patch({ leftovers: [] });
    }
  }, [patch]);

  /**
   * Every workflow root that can be started here — what the New-task picker offers.
   *
   * Scoped to the FOCUSED project, which is the one a new task would be created in. `workflow:browse`
   * answers with the shared root's workflows beside it, exactly as the board's root listing does, so
   * the picker and the columns list the same set of things.
   *
   * Quiet on failure, like the tree beside it: with no project open the honest answer is the shared
   * root's alone, and an error toast on a read nobody asked for is noise about a state the screen
   * already shows.
   */
  const refreshWorkflows = useCallback(async () => {
    try {
      const browser = await invoke("workflow:browse", ref.current.at !== null ? { project: ref.current.at } : {});
      patch({ workflows: browser.workflows });
    } catch {
      patch({ workflows: [] });
    }
  }, [patch]);

  /**
   * One workflow's declared inputs, read from the file on disk.
   *
   * The same reading the Files inspector does of the OPEN document, made available to the two places
   * that have a state id and no file open: the New-task picker, and a column clicked on the board.
   * Through `workflow:read` rather than `file:read` because a state id is all either of them has —
   * and the layer comes from the browse listing, so a project file that shadows a shared one is read
   * as the project's, which is the copy that would actually run.
   *
   * The MIME is derived from the file's own name; see {@link workflowMimeOf}. Nothing is patched
   * while the read is in flight, so a form already showing one workflow's boxes keeps them until the
   * next answer lands rather than blanking between the two.
   */
  const refreshWorkflowForm = useCallback(
    async (stateId: string | null) => {
      if (stateId === null) return;
      /**
       * WHICH layer holds this state's file — asked of the listing first, and of the disk after.
       *
       * The listing's answer is {@link workflowLayerOf}'s, and it is a guess for anything below a
       * root. `exists` is what settles it: a read that found nothing is re-asked of the other layer
       * rather than reported as a parse failure — which is what a missing file used to become here,
       * since it reads back as empty text and empty text is a state with no inputs in it.
       */
      const guess = workflowLayerOf(ref.current.workflows, stateId);
      const read = (layer: WorkflowLayer): Promise<WorkflowSource> =>
        invoke("workflow:read", { stateId, layer, ...inLayer(layer) });
      try {
        let source = await read(guess);
        if (!source.exists) {
          // Its own catch: the other layer may not be reachable at all — `project` with no project
          // open is an error, not an empty file — and a failed second look must leave the first
          // answer standing rather than turning it into "this does not parse".
          // In search order, so the first hit is the copy that would run — the built-in layer last
          // (decision 0006), which is where a shipped child of a shipped root is found.
          for (const layer of (["project", "base", "system"] as const).filter((one) => one !== guess)) {
            try {
              const elsewhere = await read(layer);
              if (!elsewhere.exists) continue;
              source = elsewhere;
              break;
            } catch {
              /* a layer that cannot be asked — `project` with nothing open — is not where it is */
            }
          }
        }
        patch({
          workflowForms: {
            ...ref.current.workflowForms,
            [stateId]: runFieldsOf(source.text, workflowMimeOf(source.file)),
          },
        });
      } catch {
        // Unreadable is unparseable as far as a form is concerned: there are no boxes either way, and
        // the one thing the caller must not do is offer a Create button over a state it cannot read.
        patch({ workflowForms: { ...ref.current.workflowForms, [stateId]: null } });
      }
    },
    [patch, inLayer],
  );

  /**
   * The selected state's view.
   *
   * Silent on failure rather than raising a toast: the tree can point at a state whose file the user
   * is mid-edit, and a parse error there is already reported against the file itself.
   */
  const refreshState = useCallback(
    async (stateId: string | null): Promise<StateView | null> => {
      if (stateId === null) {
        patch({ state: null });
        return null;
      }
      try {
        const view = await invoke("state:view", { stateId, ...(ref.current.at !== null ? { project: ref.current.at } : {}) });
        patch({ state: view });
        return view;
      } catch {
        patch({ state: null });
        return null;
      }
    },
    [patch],
  );

  /**
   * The same read, for the state the TASKS view has selected.
   *
   * A second field rather than a second caller of {@link refreshState}, because the two subjects move
   * independently: the Files inspector describes the state the tree is standing on, and clicking a
   * column on the board must not rewrite it. Same channel, same silence on failure.
   */
  const refreshTaskState = useCallback(
    async (stateId: string | null) => {
      if (stateId === null) return patch({ taskState: null });
      try {
        patch({
          taskState: await invoke("state:view", { stateId, ...(ref.current.at !== null ? { project: ref.current.at } : {}) }),
        });
      } catch {
        patch({ taskState: null });
      }
    },
    [patch],
  );

  /**
   * Read the open file, by path.
   *
   * Loaded alongside its state view rather than behind an "Edit" button: both halves of the panel
   * are on screen at once, so the source has to arrive with the selection.
   *
   * One channel for every file type, including states. `workflow:read` still exists and is still
   * what `openWorkflow` uses when all it has is an id, but the panel holds one document and it comes
   * from here — two ways of loading the same file is how the viewer and the editor end up a revision
   * apart.
   */
  const refreshDoc = useCallback(
    async (layer: WorkflowLayer | null, path: string | null, project?: string) => {
      if (layer === null || path === null) return patch({ doc: null });
      try {
        // The NODE's project where the caller had one — a file identifies itself (`FileNode.project`)
        // — and the shell's otherwise, which is where a state id resolved from an address lands.
        const doc = await invoke("file:read", { layer, path, ...inLayer(layer, project) });
        // A draft the file has caught up with is no longer an edit — see `settled`. Dropped here,
        // where the document is re-read, rather than at the save site: the same thing is true of a
        // file changed under us, and there is one place that learns about both.
        patch({ doc, drafts: settled(ref.current.drafts, docKey(layer, path), doc.text) });
      } catch {
        patch({ doc: null });
      }
    },
    [patch, inLayer],
  );

  /**
   * Where a state id lives, as a `(layer, path)` pair.
   *
   * Answered from the tree rather than by deriving `workflows/${id}.json`, because a state may be
   * authored as YAML. Falls back to that derivation, which is the path `workflow:write` would create.
   *
   * `layer` is passed in when the caller already knows which of the two copies it means — a
   * right-clicked tree row does. Without it, the layer is whichever one the search path resolves to,
   * which is what a board column drilling into a child id is asking for.
   */
  const locateState = useCallback(
    async (stateId: string, layer?: WorkflowLayer): Promise<{ layer: WorkflowLayer; path: string } | null> => {
      let at: WorkflowLayer;
      if (layer !== undefined) {
        at = layer;
      } else {
        try {
          at = (await invoke("state:view", { stateId, ...(ref.current.at !== null ? { project: ref.current.at } : {}) })).layer;
        } catch {
          return null;
        }
      }
      const find = (nodes: FileNode[]): FileNode | null => {
        for (const node of nodes) {
          if (node.stateId === stateId && node.layer === at) return node;
          const hit = node.children ? find(node.children) : null;
          if (hit) return hit;
        }
        return null;
      };
      const root = ref.current.tree?.roots.find((r) => r.layer === at);
      const node = root ? find(root.nodes) : null;
      return { layer: at, path: node?.path ?? `workflows/${stateId}.json` };
    },
    [],
  );

  /**
   * Put the selection somewhere that still exists after a path-addressed rename or delete.
   *
   * A directory operation can take the state the middle panel is showing with it — renaming
   * `workflows/feature/` changes the id of everything under it — and a selection left pointing at an
   * id that no longer names anything shows an empty panel with no explanation of what happened.
   */
  const afterFileChange = useCallback(
    async (result: FileMutationResult, moved?: { layer: WorkflowLayer; path: string; to?: string }) => {
      // The drafts for whatever the operation touched, which for a directory is everything inside
      // it. A rename carries them to the new path; a delete is the end of them.
      if (moved !== undefined) {
        patch({
          drafts:
            moved.to === undefined
              ? withoutDraftsUnder(ref.current.drafts, moved.layer, moved.path)
              : movedDraftsUnder(ref.current.drafts, moved.layer, moved.path, moved.to),
        });
      }
      await refreshTree();
      const open = ref.current.stateId;
      if (open !== null && result.states.includes(open)) {
        return patch({ stateId: null, state: null, doc: null, dir: null, inspect: "path" });
      }
      await refreshState(open);
    },
    [patch, refreshTree, refreshState],
  );

  /**
   * The selected task's conversation.
   *
   * Falls back to {@link AppState.selectedProject} like {@link refreshDetail} and
   * {@link refreshSession} do, and for the same reason: `undefined` does not mean "wherever the task
   * is", it means "the FOCUSED project", which with no checkout open is none at all. The selection
   * carries its project because a task id is a rowid in one database; the reads about it have to name
   * that database every time, not only on the click that made the selection.
   *
   * Missing it here alone was invisible until a push arrived: `select` passes the project explicitly,
   * so the panel filled correctly, and then the first `task`/`run:finished` invalidate re-read the
   * conversation with no scope and main answered `no project is open`. The panel blanked mid-read and
   * the log grew an error per engine event, while the detail and history beside it — the two that do
   * fall back — carried on reading the right project.
   */
  const refreshConversation = useCallback(
    async (taskId: string | null, project?: string) => {
      if (taskId === null) return patch({ conversation: null });
      const scope = project ?? ref.current.selectedProject ?? undefined;
      try {
        patch({ conversation: await invoke("task:conversation", { taskId, ...(scope !== undefined ? { project: scope } : {}) }) });
      } catch {
        patch({ conversation: null });
      }
    },
    [patch],
  );

  /**
   * The transcript half: which states ran, and the conversation of the one being looked at.
   *
   * Fetched together because they are one question asked twice — a history row is chosen by clicking
   * it, and the default choice is the state the task is at now. Quiet on failure like every other
   * panel-side read: a task with no conversation is an empty viewer, not an error toast.
   */
  /** The backfill. Every entry after this arrives on the push, so this runs once per panel open. */
  /**
   * The groups, and a board for each.
   *
   * Never throws for want of a project: JaiRA's own is always there, which is what a window with
   * nothing open still has to show.
   */
  const refreshProjects = useCallback(async () => {
    let projects: ProjectSummary[];
    try {
      projects = await invoke("project:list", undefined);
    } catch {
      return patch({ projects: [], boards: {}, levels: {} });
    }
    const levels = ref.current.levels;
    const boards: Record<string, BoardView | null> = {};
    await Promise.all(
      projects.map(async (p) => {
        const level = levels[p.project] ?? null;
        try {
          boards[p.project] =
            level === null
              ? await invoke("board:roots", { project: p.project })
              : await invoke("board:view", { level, project: p.project });
        } catch {
          // A group whose board will not load is shown empty rather than taking the view down with it.
          boards[p.project] = null;
        }
      }),
    );
    // A narrowing that names a project this window no longer has is a filter that hides everything
    // and says nothing — which is what closing the checkout the Tasks view was narrowed to would
    // otherwise leave behind. Back to the listing, which always has something in it.
    const focus = ref.current.taskFocus;
    const gone = focus !== null && !projects.some((p) => p.project === focus);
    patch({ projects, boards, ...(gone ? { taskFocus: null } : {}) });
  }, [patch]);

  /**
   * The conversations of every open project, for the root's Chat list.
   *
   * Narrowed to the chat workflows at the CHANNEL, not after: `chatWorkflow.ts` is the one module
   * that says what a conversation is, and passing its two states keeps main from having to know —
   * while keeping a board's worth of rows off the wire to draw a list of threads.
   */
  const refreshAllConversations = useCallback(async () => {
    try {
      patch({ allConversations: await invoke("task:all", { workflows: [...CHAT_STATES] }) });
    } catch {
      // Quiet: a project closing under a refresh already in flight, and an empty list is the honest
      // answer to that until the next one lands.
      patch({ allConversations: [] });
    }
  }, [patch]);

  /**
   * The newest page, from whatever the filters currently say.
   *
   * Replaces rather than merges: a filter change is a different question, and a list that kept the
   * answers to the previous one would be a list nobody could trust. The cursor comes back with the
   * page, so "is there more" is the reader's answer rather than this side's guess.
   */
  const refreshLogs = useCallback(
    async (query: LogQuery = {}) => {
      patch({ logsLoading: true });
      try {
        const page = await invoke("log:list", { ...query, limit: LOG_PAGE });
        patch({ logs: page.entries, logCursor: page.cursor, logsLoading: false });
      } catch {
        patch({ logs: [], logCursor: undefined, logsLoading: false });
      }
    },
    [patch],
  );

  /**
   * The next page BACKWARDS — what the panel asks for as it is scrolled towards the past.
   *
   * Guarded on `logsLoading` and on there being a cursor at all, because a scroll handler fires many
   * times for one gesture and each of those would otherwise be a separate read of the same bytes.
   * The scan is bounded on the far side, so an empty page with a cursor is a legitimate answer —
   * "nothing matched in the budget, ask again" — and appending nothing is the correct response.
   */
  const loadOlderLogs = useCallback(
    async (query: LogQuery = {}) => {
      const { logCursor, logsLoading } = ref.current;
      if (logCursor === undefined || logsLoading) return;
      patch({ logsLoading: true });
      try {
        const page = await invoke("log:list", { ...query, before: logCursor, limit: LOG_PAGE });
        patch({ logs: [...ref.current.logs, ...page.entries], logCursor: page.cursor, logsLoading: false });
      } catch {
        // The page that could not be read is not a reason to lose the ones that could. The cursor is
        // left where it was, so the next scroll tries again rather than declaring the log finished.
        patch({ logsLoading: false });
      }
    },
    [patch],
  );

  /**
   * The transcript panel: every state the task went through, and the one being read.
   *
   * `atState` is what makes the panel answer the question the click asked. A task's LATEST instance
   * is the deepest state it reached, so selecting a task from the panel of `feature/plan/goals` used
   * to open `critique`'s conversation — the right task, the wrong state, and no indication that the
   * two had come apart. Given a state, the newest instance OF THAT STATE is shown instead; a loop
   * runs one state several times, so newest rather than first.
   *
   * A miss falls back to the latest instance rather than to nothing: a task that has not reached
   * this state yet still has a conversation worth reading, and an empty panel would be a worse
   * answer than a labelled one — the header names the state either way.
   */
  const refreshSession = useCallback(
    async (
      taskId: string | null,
      instanceId: string | null = null,
      project?: string,
      atState?: string | null,
      // Which instance was resolved, so a NAVIGATION can start the trail at it. Returned rather than
      // patched here: this also runs on every invalidating push, and re-seeding the trail from one
      // would drop you back to the top of the walk on each engine event.
    ): Promise<string | null> => {
      if (taskId === null) {
        patch({ sessionHistory: [], records: {}, session: null, sessionInstance: null });
        return null;
      }
      const scope = project ?? ref.current.selectedProject ?? undefined;
      const at = scope !== undefined ? { project: scope } : {};
      try {
        const history = await invoke("session:history", { taskId, ...at });
        /**
         * What each of those calls actually RAN, keyed by the id the journal names it with.
         *
         * Tolerated rather than folded into the failure path: a task whose records cannot be read
         * still has a conversation, and losing the whole panel because the derivation is unavailable
         * would trade the thing that works for the thing that was missing.
         */
        let records: Record<string, OperationRecordView> = {};
        try {
          const rows = await invoke("run:records", { taskId, ...at });
          records = Object.fromEntries(rows.map((row) => [row.recordId, row]));
        } catch {
          records = {};
        }
        const wanted = instanceId ?? instanceAt(history, atState ?? null);
        const session = await invoke("session:view", {
          taskId,
          ...(wanted !== null ? { instanceId: wanted } : {}),
          ...at,
        });
        // The live tail is re-seeded from MAIN, not wiped. Wiping it here is how a watched run went
        // blank on every navigation: the record lands only when the operation settles, so while a
        // call is in flight the tail IS the conversation — and this refresh runs on every task
        // invalidate. Main keeps the same accumulation (`session:live`); `null` there means nothing
        // is streaming, which is exactly when dropping the tail is right (the stored turn is the
        // same content with its tool calls attached, and keeping both would show the answer twice).
        let live: Awaited<ReturnType<typeof invoke<"session:live">>> = null;
        try {
          live = await invoke("session:live", { taskId, ...at });
        } catch {
          live = null;
        }
        // A tail already AHEAD of the snapshot stays: pushes folded in while the snapshot was in
        // flight would be lost by reverting to it, and `n` says which of the two has seen more.
        const keep = tailIsAhead(ref.current.liveTurn, live);
        patch({
          sessionHistory: history,
          records,
          session,
          sessionInstance: wanted,
          ...(keep ? {} : { liveTurn: liveTurnOfSnapshot(live) }),
        });
        return wanted;
      } catch {
        patch({ sessionHistory: [], records: {}, session: null, sessionInstance: null });
        return null;
      }
    },
    [patch],
  );

  /**
   * The declared children of whatever the trail is standing on.
   *
   * Fetched only when the tail is DEEPER than the open file: a board's columns are what a state
   * declares, and a child that was never reached is a column the instance tree cannot know about.
   * At the base the open file's own view already answers it, and asking again would be a round trip
   * for a value we are holding.
   */
  const refreshTrailState = useCallback(
    async (stateId: string | null) => {
      if (stateId === null || stateId === ref.current.stateId) return patch({ trailState: null });
      try {
        patch({ trailState: await invoke("state:view", { stateId, ...(ref.current.at !== null ? { project: ref.current.at } : {}) }) });
      } catch {
        // A state that will not load leaves the board to the instance tree, which is the honest
        // fallback: the columns that ran, without the ones that did not.
        patch({ trailState: null });
      }
    },
    [patch],
  );

  /**
   * Put the trail on ONE run — the base of a walk.
   *
   * Every navigation that chooses a run lands here: selecting a task, opening a state on its newest
   * run, following a link from the task panel. It REPLACES rather than appends, because arriving at
   * a run from outside is not a step deeper into the walk you were on — and an instance id from
   * another task names nothing here.
   */
  const seedTrail = useCallback(
    (detail: TaskDetail | null, stateId: string | null) => {
      // A LATE answer for a file that is no longer open. Every caller resolves the run over a round
      // trip, so clicking a second file before the first one's detail lands would otherwise put that
      // file's run on this file's path — the one thing an address bar must never do.
      if (stateId !== null && stateId !== ref.current.stateId) return;
      // From the INSTANCE TREE, not the session history. A composite orchestrates and says nothing,
      // so it has no conversation and no session row — which is why seeding from the history left
      // exactly the states with children showing no run on the path at all.
      const node = stateId === null ? undefined : instanceOf(detail?.instances ?? [], stateId);
      if (node === undefined) return patch({ trail: [], trailState: null });
      patch({ trail: [stepOf(node)], trailState: null });
    },
    [patch],
  );

  /**
   * Open a state's most recent run, so looking at a state shows what it DID.
   *
   * Selecting a state used to load its board, its file and its lint results and leave the transcript
   * beside them saying "select a task" — which made the one panel that answers "what did this
   * actually say" the one panel you had to go and ask for. A state that has run has a newest run,
   * and that is the answer to the question the click asked.
   *
   * Three rules keep it from fighting the person using it:
   *
   *  - It runs on NAVIGATION only (clicking a file, drilling a column, following a link), never on
   *    the refresh that every journaled event triggers — otherwise each engine event would yank the
   *    selection back to the newest run mid-read.
   *  - The transcript opens at THIS state's instance, not the deepest one the task reached.
   *  - `inspect` is untouched. This is not a click on a task, so it must not take the column away
   *    from the state whose file is open — see {@link AppState.inspectFrom}.
   */
  /**
   * Which project holds the runs of whatever the Files view has open.
   *
   * The same layer rule the Run button follows ({@link runTargetOf}), applied to READS. Every
   * task-scoped channel — detail, conversation, session history — resolves the focused project when
   * told nothing, and with no checkout open that is not a project at all: main throws `no project is
   * open` for a task that exists perfectly well in the shared one. Selecting a task and asking about
   * it have to name the same database, or looking at a shared run is a handful of errors in the log
   * and three empty panels.
   *
   * Falls back to the focused project when nothing is open in the Files view, which is what the
   * Tasks view wants.
   */
  const owningProject = useCallback((): string | undefined => {
    const layer = ref.current.doc?.layer ?? ref.current.state?.layer;
    const focused = ref.current.at ?? undefined;
    return layer === undefined ? focused : (runTargetOf(layer, ref.current.at).project ?? focused);
  }, []);

  /**
   * When a task was last touched, from whichever of this window's lists happens to hold its row.
   *
   * Three, because the three answer for different populations and a window has any of them at any
   * moment: the open project's tasks, every project's conversations, and the per-project summaries'
   * `ended` rows — which is the only one that knows about a stopped task in a project the Tasks view
   * has not been opened on.
   *
   * `null` for a task none of them has, which is not a fault: a run reached from the Files inspector
   * may belong to a project no list has been fetched for, and a watermark that cannot be dated is
   * one there is no honest value to move.
   */
  /**
   * WHICH project's database holds a task — recovered from whatever this window already knows.
   *
   * A task id is a rowid in ONE store, and every read about it names that store. What names it is
   * `selectedProject`, which is set from whatever could be worked out at the moment of the click:
   * `project ?? selectedProject ?? owningProject()`. The middle term is the trap. It is the project
   * of the PREVIOUS selection, so a click that names none does not fall through to "unknown" — it
   * inherits, confidently and silently, wherever the reader happened to be standing before.
   *
   * Observed: reading the shared root as a project and then opening a checkout's task from a surface
   * that passes no project. `selectedProject` was still `"shared"`, every read about the task went
   * to the base root, and main answered `unknown task 't-…' in ~/.jaira` — once per invalidate, for
   * as long as the task stayed selected. The panel empties and nothing on screen says why: the
   * refreshers swallow the refusal, which is right for a selection that HAS gone stale and wrong for
   * this one, where the task is fine and the window is simply looking in the wrong database.
   *
   * So it asks the lists instead of guessing, and a task's project is a FACT in four of them: the
   * cross-project conversation list stamps every row, and the three inbox lists each stamp the
   * project their request parked in — "required, not optional, because the inbox is ALREADY
   * cross-project". The per-project summaries answer for anything that has stopped. A task none of
   * them holds returns null, which is honest: this recovers what is known and invents nothing.
   *
   * ⚠️ It outranks `selectedProject` at the one call site that uses it, and that is the point rather
   * than an aggressive default. The previous selection is a guess about the next one; a row that
   * says which database it came out of is the answer.
   */
  const projectOfTask = useCallback((taskId: string): string | undefined => {
    const stamped =
      ref.current.allConversations.find((t) => t.taskId === taskId)?.project ??
      ref.current.pending.find((p) => p.taskId === taskId)?.project ??
      ref.current.approvals.find((a) => a.taskId === taskId)?.project ??
      ref.current.questions.find((q) => q.taskId === taskId)?.project;
    if (stamped !== undefined && stamped !== "") return stamped;
    for (const project of ref.current.projects) {
      if (project.ended.some((t) => t.taskId === taskId)) return project.project;
    }
    return undefined;
  }, []);

  const taskClock = useCallback((taskId: string): number | null => {
    const row =
      ref.current.tasks.find((t) => t.taskId === taskId) ??
      ref.current.allConversations.find((t) => t.taskId === taskId);
    if (row !== undefined) return row.updatedAt;
    for (const project of ref.current.projects) {
      const ended = project.ended.find((t) => t.taskId === taskId);
      if (ended !== undefined) return ended.updatedAt;
    }
    return null;
  }, []);

  const refreshDetail = useCallback(
    // The detail is RETURNED as well as patched, because it is what a navigation seeds the address
    // bar from: the run a path stands on is an instance, and the instance tree is the only record
    // that has one for a state which ran no model call.
    async (taskId: string | null, project?: string): Promise<TaskDetail | null> => {
      if (!taskId) {
        patch({ detail: null, trail: [], trailState: null });
        return null;
      }
      const scope = project ?? ref.current.selectedProject ?? undefined;
      try {
        const detail = await invoke("task:detail", { taskId, ...(scope !== undefined ? { project: scope } : {}) });
        // The walk is checked against the tree it walks. A retry restarts instance ids, so a trail
        // held across one would offer crumbs into a run that no longer exists — and the address bar
        // is the one surface that must not describe a place you cannot get to. A sidechain step is
        // also checked against its host's session where one is cached; an uncached session keeps
        // the step, because the cache empties on every run boundary and that is not evidence.
        const trail = prunedTrail(ref.current.trail, detail.instances, (instanceId) => ref.current.sessions[instanceId]);
        patch({ detail, ...(sameTrail(trail, ref.current.trail) ? {} : { trail }) });
        return detail;
      } catch {
        // Quiet, like the conversation and session reads beside it. This fires on every selection
        // change and on every push about the selected task, so a selection that has gone stale — a
        // project closed underneath it, a task pruned — would otherwise raise a toast per event
        // rather than emptying the panel, which is the honest answer and the one already rendered.
        patch({ detail: null });
      }
      return null;
    },
    [patch],
  );

  const focusStateRun = useCallback(
    (view: StateView | null) => {
      // Both task lists, every time a state is opened. The run history reads one of them — which one
      // depends on the file's layer — and they are otherwise only refetched when a push says so.
      // A push that was missed, dropped by the other-project guard, or never sent because the run
      // failed before it emitted anything then leaves the history describing a moment that has
      // passed, with nothing to make it look again. One round trip per navigation buys the property
      // that looking at a state always reads a list fetched after you looked.
      void refreshTasks();
      void refreshSharedTasks();
      if (view === null) {
        patch({ selected: null, sessionHistory: [], records: {}, session: null, sessionInstance: null, conversation: null, sessions: {}, trail: [], trailState: null });
        return;
      }
      const newest = newestRunOf(view);
      if (newest === null) {
        patch({ selected: null, sessionHistory: [], records: {}, session: null, sessionInstance: null, conversation: null, trail: [], trailState: null });
        return;
      }
      // The project the STATE's runs live in, not the focused one — see `owningProject`. `view` is
      // authoritative about the layer here, and it is the value the reads below have to agree with.
      // …and the task's OWN project as the last resort, for a layer that resolved to nothing and a
      // window with no checkout focused — see `projectOfTask`. Last, because `view.layer` is
      // authoritative here and a recovered answer must never overrule a stated one.
      const at =
        runTargetOf(view.layer, ref.current.at).project ?? ref.current.at ?? projectOfTask(newest.taskId) ?? undefined;
      patch({ selected: newest.taskId, selectedProject: at ?? null, stream: [], sessions: {}, trail: [], trailState: null });
      void refreshConversation(newest.taskId, at);
      void refreshSession(newest.taskId, null, at, view.stateId);
      // The trail starts at the run that was opened: the panel is showing it, so the address bar has
      // to say so — a path whose last element is not what is on screen is not an address. The detail
      // is fetched HERE rather than only on a click, because that instance tree is both what the
      // board draws and what the path stands on, and without it the two disagreed on open: the bar
      // said no run, the panel showed one.
      void refreshDetail(newest.taskId, at).then((detail) => seedTrail(detail, view.stateId));
    },
    [patch, projectOfTask, refreshConversation, refreshDetail, refreshSession, refreshTasks, refreshSharedTasks, seedTrail],
  );

  /**
   * One child's transcript, cached by instance id — what a run card opens.
   *
   * Quiet and idempotent: it fires from a click on a folded header, several may be in flight at
   * once, and a state that ran no model call answers with `empty` rather than an error. Re-fetching
   * one already held would flicker a card someone is reading, so a hit is a no-op.
   */
  const loadSession = useCallback(
    async (instanceId: string) => {
      const taskId = ref.current.selected;
      if (taskId === null || ref.current.sessions[instanceId] !== undefined) return;
      const scope = ref.current.selectedProject ?? undefined;
      try {
        const view = await invoke("session:view", {
          taskId,
          instanceId,
          ...(scope !== undefined ? { project: scope } : {}),
        });
        patch({ sessions: { ...ref.current.sessions, [instanceId]: view } });
      } catch {
        // Left absent rather than cached as empty: the card says "not loaded" and a second click
        // retries, where a cached failure would be permanent for the life of the selection.
      }
    },
    [patch],
  );

  /**
   * Several transcripts, in one round and one patch.
   *
   * The conversation panel needs every session under the run it is drawing, because it opens all of
   * them — see `RunConversation`. Done one at a time that is N round trips AND N patches, and the
   * patches are the expensive half: each one re-renders a conversation that is still filling in, so
   * the panel visibly assembles itself a state at a time.
   *
   * Failures are DROPPED rather than cached, exactly as the single fetch drops them — a missing entry
   * is a card that says "loading" and will be asked for again, where a cached failure would be
   * permanent for the life of the selection. The `taskId` is re-read after the awaits because a
   * selection can change while eight requests are in flight, and writing those answers into the new
   * selection would file one task's words under another's instance ids.
   */
  const loadSessions = useCallback(
    async (at: ReadonlyArray<{ instanceId: string }>) => {
      const taskId = ref.current.selected;
      if (taskId === null) return;
      const scope = ref.current.selectedProject ?? undefined;
      // Asked for by INSTANCE, which is the whole address: a task is one machine and its instance
      // ids are durable, so one id names one conversation for the task's whole life.
      const key = sessionKey;
      const wanted = at.filter((one) => ref.current.sessions[key(one)] === undefined);
      if (wanted.length === 0) return;
      const loaded = await Promise.all(
        wanted.map(async (one) => {
          try {
            const view = await invoke("session:view", {
              taskId,
              instanceId: one.instanceId,
              ...(scope !== undefined ? { project: scope } : {}),
            });
            return [key(one), view] as const;
          } catch {
            return null;
          }
        }),
      );
      if (ref.current.selected !== taskId) return;
      const next = { ...ref.current.sessions };
      let landed = false;
      for (const entry of loaded) {
        if (entry === null) continue;
        next[entry[0]] = entry[1];
        landed = true;
      }
      /**
       * Only when something ACTUALLY arrived — otherwise this is a spin.
       *
       * The panel asks for whatever it is missing whenever `sessions` changes identity, and `patch`
       * makes a new object every time it is called. So a round in which every fetch failed used to
       * publish an identical map under a new identity, the panel would see the same entries still
       * missing, ask again, fail again — as fast as the round trips resolve, for as long as the
       * failure lasts. Dropping a failure so it can be re-asked is right; re-asking it in a loop
       * with nothing in between is what turns one broken transcript into an unusable window.
       *
       * The retry is not lost. Anything that legitimately moves the panel — a record landing, a
       * state entered, the selection changing — re-runs the fetch, which is the cadence a transient
       * failure wants anyway.
       */
      if (landed) patch({ sessions: next });
    },
    [patch],
  );

  const refreshPending = useCallback(async () => {
    try {
      patch({ pending: await invoke("interaction:pending", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshApprovals = useCallback(async () => {
    try {
      patch({ approvals: await invoke("approval:pending", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshQuestions = useCallback(async () => {
    try {
      patch({ questions: await invoke("question:pending", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshUserEvents = useCallback(async () => {
    try {
      patch({ userEvents: await invoke("userEvent:pending", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshHistory = useCallback(async () => {
    // Same rule as {@link refreshTasks}: run history belongs to a project, so with none open there is
    // nothing to size.
    if (ref.current.at === null) return patch({ history: { tasks: 0, events: 0, commands: 0 } });
    try {
      patch({ history: await invoke("history:size", { ...(ref.current.at !== null ? { project: ref.current.at } : {}) }) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  /**
   * Settings, config, executors and secret capabilities.
   *
   * None of the four needs a project. Settings belong to the person, so the theme applies on an
   * empty window; the other three are answered from the SHARED root when nothing is open —
   * `readConfig` never touches a project, `effectiveConfig` falls back to the base document, and
   * secret capabilities are the machine's keychain. They used to sit behind the no-project return in
   * {@link refreshAll}, which left `config` null and made both settings layers — including Shared,
   * which is always editable — render "open a project to edit its configuration".
   */
  const refreshSettings = useCallback(async () => {
    try {
      const settings = await invoke("settings:read", undefined);
      // The LAYOUT is taken from the file once and owned here afterwards. This runs again on every
      // project open, and by then the window has a layout that the file may be up to
      // {@link UI_WRITE_DELAY} behind — so re-reading it would occasionally snap a divider back to
      // where it was before the drag that opened the project.
      patch({ settings: uiHydrated.current ? keepingUi(settings) : settings });
      uiHydrated.current = true;
    } catch (e) {
      fail(e);
    }
  }, [patch, fail, keepingUi]);

  const refreshConfig = useCallback(async () => {
    try {
      const [config, executors, secrets] = await Promise.all([
        invoke("config:read", { ...inLayer("project") }),
        invoke("executor:list", undefined),
        invoke("secret:capabilities", undefined),
      ]);
      patch({ config, executors, secrets });
    } catch {
      // Nothing here needs a project, so a failure is a real one — but the panes render their own
      // emptiness and an error banner over a settings screen helps nobody.
    }
  }, [patch]);

  /**
   * Read the availability snapshot main already computed.
   *
   * A READ, not a check: the checks run on main's own schedule (startup, project open, config write)
   * and this only collects the answer. That is the whole difference from the button this replaced —
   * opening Settings should not be the thing that finally goes and looks.
   */
  const refreshAvailability = useCallback(async () => {
    try {
      const availability = await invoke("availability:read", undefined);
      applyAvailability(patch, availability);
    } catch {
      // Availability is a health report. Failing to fetch one must not blank the screen it annotates.
    }
  }, [patch]);

  /**
   * Which copy of each self-test state LOADS, and from which layer.
   *
   * The files ship in the built-in layer (decision 0006), so nothing is installed and nothing can be
   * missing short of a broken build. What is worth reporting is an OVERRIDE: the self-test runs in
   * the shared root's own project, whose search path is `~/.jaira` and then what ships, so a copy in
   * `~/.jaira` — which is exactly what earlier builds wrote there — is the one a run uses. Asked in
   * that order, first hit wins, the same rule reference resolution follows.
   */
  const refreshDebugFiles = useCallback(async () => {
    const files = await Promise.all(
      SELF_TEST_STATES.map(async (stateId): Promise<DebugFile> => {
        for (const layer of ["base", "system"] as const) {
          try {
            const source = await invoke("workflow:read", { stateId, layer });
            if (!source.exists) continue;
            const identical = source.builtIn?.identical;
            return { stateId, file: source.file, layer, text: source.text, ...(identical !== undefined ? { identical } : {}) };
          } catch {
            // An unreadable layer is an absent one as far as "which copy loads" goes.
          }
        }
        return { stateId, file: "", layer: null, text: "" };
      }),
    );
    patchDebug({ files });
  }, [patchDebug]);

  const refreshAll = useCallback(async () => {
    const current = await invoke("project:current", undefined).catch(() => null);
    // With no project there is no project LAYER either, and the settings screens must not merely
    // hide the switch — they have to actually be editing the layer they say they are. Left on
    // `project`, every control rendered disabled with no visible reason, which is what a screen that
    // says one thing and does another looks like.
    patch({
      at: current?.dir ?? null,
      ...(current ? {} : { configLayer: "base" as ConfigLayer }),
    });
    // Before the early return: preferences are the person's, and the shared root is the machine's.
    // Both mean something with no project open, and the Files view and Settings are reachable on an
    // empty window — which is where someone goes to set the shared layer up in the first place.
    // Before the early return: JaiRA's own runs belong to no checkout, so they are exactly what a
    // window with nothing open should still be able to see.
    await Promise.all([
      refreshSettings(),
      refreshTree(),
      refreshConfig(),
      refreshAvailability(),
      refreshProjects(),
      refreshSharedTasks(),
      refreshWorkflows(),
    ]);
    if (!current) return;
    await Promise.all([
      refreshTasks(),
      refreshBoard(),
      refreshPending(),
      refreshApprovals(),
      refreshQuestions(),
      refreshUserEvents(),
      refreshHistory(),
      // Again, now that a project layer exists to lay over the base one.
      refreshConfig(),
      // Again, now that a project supplies a second root to walk.
      refreshTree(),
      // And again for the same reason: the picker lists the focused project's roots beside the shared
      // ones, and the pass above ran before there was a focused project to ask about.
      refreshWorkflows(),
      refreshDetail(ref.current.selected),
      refreshState(ref.current.stateId),
      refreshAllConversations(),
    ]);
  }, [
    patch,
    refreshTasks,
    refreshSharedTasks,
    refreshAllConversations,
    refreshBoard,
    refreshPending,
    refreshApprovals,
    refreshQuestions,
    refreshHistory,
    refreshSettings,
    refreshConfig,
    refreshAvailability,
    refreshTree,
    refreshWorkflows,
    refreshDetail,
    refreshState,
  ]);

  /**
   * Apply the theme to the document element.
   *
   * Written as a data attribute rather than a class because that is what the stylesheet's
   * `:root[data-theme="dark"]` block selects on, and because it is trivially inspectable in
   * devtools when a colour looks wrong.
   */
  useEffect(() => {
    document.documentElement.dataset["theme"] = state.settings.theme;
  }, [state.settings.theme]);

  /**
   * Apply the typography preferences to the same element (SHELL.md §6).
   *
   * Beside the theme because it is the same gesture — a display preference written onto `:root`,
   * where it beats the stylesheet's own values without a specificity fight and without a second copy
   * of the palette. Everything downstream is already a multiple of the two bases, so this is four
   * property writes and the whole window moves coherently.
   */
  useEffect(() => {
    applyAppearance(document.documentElement, state.settings.appearance);
  }, [state.settings.appearance]);

  /**
   * Publish how each editor looks, on the same terms — see `editorLook.ts`.
   *
   * Beside the typography rather than inside it because the two travel differently: a font size is a
   * custom property and nothing else, and these are typed values that live editors are TOLD about.
   * Same gesture from here, though — one settings field, one effect, and every editor already on
   * screen follows a switch as it is flipped instead of at the next time a file is opened.
   */
  useEffect(() => {
    applyEditors(document.documentElement, state.settings.editors);
  }, [state.settings.editors]);

  /**
   * Publish the renderer choices for the components that cannot be handed them.
   *
   * The Files panel gets this same field on its context — an explicit prop, because there is one
   * panel. A value view is dozens of components deep inside a transcript, so it reads the published
   * copy instead; see `renderChoice.ts` on why that is a delivery route rather than a second source.
   */
  useEffect(() => {
    publishRenderChoices(state.settings.renderers);
  }, [state.settings.renderers]);

  // Initial load + push subscription.
  useEffect(() => {
    void refreshAll();
    return bridge().subscribe((message: PushMessage) => {
      // An INVALIDATE about a project this window is not showing.
      //
      // Narrow on purpose. JaiRA's own project forced it — a sync runs there and invalidates ITS task
      // list, and a window with no user project open then asked for tasks it has none of, which throws
      // by design. But it applies to INVALIDATES only: an `engine:event` or a `log:entry` from that
      // same run is exactly what the person who pressed the button is waiting to see, and dropping
      // those made a running sync indistinguishable from a button that did nothing.
      const about = (message as { project?: string }).project;
      if (message.type === "store:invalidate" && about !== undefined && about !== ref.current.at) {
        // …except JaiRA's own lists, which are nobody's project and so are nobody's to ignore. The
        // Tasks view draws a board for EVERY project, including this one, so a card of its that has
        // moved has moved on screen.
        if (message.scope === "tasks" || (message.scope === "board" && ref.current.view === "tasks")) {
          void refreshProjects();
        }
        // A shared workflow's runs land here, and the Files inspector shows them beside its Run
        // button. Dropping this invalidate is what would leave that history one run behind.
        if (message.scope === "tasks") void refreshSharedTasks();
        // The root's conversation list spans every project, so a thread that moved in one this
        // window is not standing in still moved on screen.
        if (message.scope === "tasks") void refreshAllConversations();
        // …and except the task on SCREEN. A sync or a review runs in JaiRA's own project, and the
        // person watching its conversation is owed the same refresh cadence as any selected task —
        // dropping these is why a watched run showed nothing until it finished, then everything at
        // once. The refreshers scope themselves to `selectedProject`, which is exactly `about`.
        if (about === ref.current.selectedProject && message.scope === "task" && ref.current.selected !== null) {
          void refreshDetail(ref.current.selected);
          void refreshConversation(ref.current.selected);
          void refreshSession(ref.current.selected, ref.current.sessionInstance);
        }
        return;
      }
      switch (message.type) {
        case "store:invalidate":
          if (message.scope === "tasks") {
            void refreshTasks();
            void refreshHistory();
            void refreshAllConversations();
            // The open state's view carries its own task lists (`tasksHere`, `tasksRecent`), which
            // the Files inspector reads for the second half of its run history and the middle panel
            // reads for its task list. A `tasks` invalidate is exactly the event that changes them,
            // and it used to refresh neither — so a run started from the Run button sat there at
            // whatever the panel last happened to fetch until something touched the board.
            void refreshState(ref.current.stateId);
            // And the Tasks view's, which is the same panel with its own subject — a run started from
            // a board column belongs in the history section right under the button that started it.
            void refreshTaskState(ref.current.taskWorkflow);
            // JaiRA's own lists too. They are not project-scoped, so they are refreshed for an
            // invalidate about ANY project — including the system one, whose invalidates the guard
            // above drops.
            void refreshProjects();
            void refreshSharedTasks();
          }
          if (message.scope === "board") {
            void refreshBoard();
            // The Files board is the same projection reached another way, so a card that moved has
            // to move there too.
            void refreshState(ref.current.stateId);
            // And the Tasks view's boards, which are a THIRD reading of it — one per project, in
            // `boards`, rebuilt only by this. Without it a card sat in whatever column it was in when
            // the run started until the run ended: every transition in between published exactly this
            // message, and every one of them refreshed two projections and not the one on screen.
            //
            // Only while that view is on screen. This message is published per JOURNAL ENTRY, and
            // rebuilding it costs a fetch per project — worth paying to watch a card move, not worth
            // paying to keep a screen nobody is looking at up to date. `setView` catches up on entry.
            if (ref.current.view === "tasks") void refreshProjects();
          }
          if (message.scope === "task") {
            void refreshDetail(ref.current.selected);
            // Whenever a run is on screen. That is now any selected task at all: the Tasks panel
            // reads a task AS its conversation, so the two conditions that used to gate this — the
            // panel showing a task, the address bar standing on a run — are both narrower than the
            // set of screens the transcript is on.
            if (ref.current.selected !== null) {
              void refreshConversation(ref.current.selected);
              void refreshSession(ref.current.selected, ref.current.sessionInstance);
            }
          }
          if (message.scope === "workflows") {
            void refreshTree();
            void refreshState(ref.current.stateId);
            // A root added, renamed or deleted on disk changes what the New-task picker may offer, and
            // a picker listing a state that no longer exists is a Create button that fails on click.
            void refreshWorkflows();
            // Whatever the Tasks view is describing, for the reason the Files view's state view is
            // refreshed above: the two are the same panel reached from two boards.
            void refreshTaskState(ref.current.taskWorkflow);
          }
          if (message.scope === "config") void refreshConfig();
          // The checks main runs by itself have landed. Nothing asked for them, so nothing is waiting
          // on a response — this push is how their result reaches the screen.
          if (message.scope === "availability") void refreshAvailability();
          break;
        case "engine:event": {
          const line = engineLine(message.event);
          /*
           * "Is this task saying something right now", tracked for EVERY task and not just the
           * selected one — see {@link AppState.producing}. Before the guard below, deliberately: the
           * conversation list draws a spinner for whichever of its rows is answering, and every row
           * but one is by definition not the selection.
           */
          const op = (message.event as { type?: string }).type;
          if (op === "operation.started" || op === "operation.completed" || op === "operation.failed") {
            const depth = (ref.current.producing[message.taskId] ?? 0) + (op === "operation.started" ? 1 : -1);
            const producing = { ...ref.current.producing };
            // Never negative. A window opened mid-turn sees the terminal event without its start, and
            // a count that went to −1 would then need two starts before it read as speaking again.
            if (depth > 0) producing[message.taskId] = depth;
            else delete producing[message.taskId];
            patch({ producing });
          }
          // A sync's events name a task nobody selected — it runs in JaiRA's own project. While one is
          // in flight, anything not about the selected task is that sync narrating itself.
          if (message.taskId !== ref.current.selected) {
            if (ref.current.sync.running) {
              patch({ sync: { ...ref.current.sync, progress: [...ref.current.sync.progress, line].slice(-SYNC_PROGRESS_LIMIT) } });
            }
            return;
          }
          // A record lands when its operation settles, and the cached view of that instance was
          // fetched while the record was still OPEN — empty, or missing its newest call. Dropping it
          // makes the conversation panel refetch (it loads whatever is missing), and the live tail
          // goes with it: the stored turn is the same content with its tool calls attached. Without
          // this, a transcript watched from the start stayed empty after the run finished.
          const ev = message.event as { type?: string; instanceId?: string };
          if ((ev.type === "operation.completed" || ev.type === "operation.failed") && typeof ev.instanceId === "string") {
            /**
             * Through {@link withoutSession}, which knows BOTH keys the cache can be holding it
             * under — this used to spell one of them itself, and spelled the wrong one.
             *
             * Dropping a stale key is what lets the settled answer arrive: every panel a person had
             * open while a run was going would otherwise stay frozen on whatever the record held
             * mid-call. The live tail is cleared in the same breath.
             */
            const rest = withoutSession(ref.current.sessions, { instanceId: ev.instanceId });
            if (rest !== ref.current.sessions) patch({ sessions: rest, liveTurn: null });
            else patch({ liveTurn: null });
          }
          /**
           * The RUN'S SHAPE changed — refetch what draws it.
           *
           * A run publishes `store:invalidate` at `board` scope per journal entry and at `task` scope
           * only when it ENDS, so for the whole of a run the two projections the transcript is built
           * from — the instance tree and the session history — were whatever they happened to be when
           * you arrived. Walk into a child while it is the only one that has run, wait for its
           * siblings to finish, walk back out, and the level above still shows one child: not a stale
           * render, a stale fetch, and nothing on the way back up re-asks.
           *
           * Gated on the structural events rather than done per entry. These fire once per state
           * entered and once per call settled — the moments the shape actually moves — while token
           * deltas arrive on `session:turn` and must not cost three round trips each.
           */
          if (STRUCTURAL_EVENTS.has(ev.type ?? "")) {
            void refreshDetail(ref.current.selected);
            void refreshSession(ref.current.selected, ref.current.sessionInstance);
          }
          // A computed TITLE settled (SPEC §5.2): the detail header names the task by it, and was
          // fetched while it was still pending. Only the detail — the board refetches on its own
          // per-entry invalidate, and a settled field changes no session history.
          else if (ev.type === "value.settled" && (message.event as { field?: string }).field === "title") {
            void refreshDetail(ref.current.selected);
          }
          // The run's NARRATION, on the wider set — see {@link NARRATED_EVENTS}. The instance tree
          // says what exists; this says what happened, and the transcript draws the second between
          // its panels. Refetched here rather than left to the end-of-run invalidate, which is when
          // a path somebody is watching being walked is of no further use to them.
          if (NARRATED_EVENTS.has(ev.type ?? "")) void refreshConversation(ref.current.selected);
          setState((s) => ({ ...s, stream: [...s.stream, line].slice(-STREAM_LIMIT) }));
          break;
        }
        case "interaction:requested":
        case "interaction:resolved":
          void refreshPending();
          break;
        case "approval:requested":
        case "approval:resolved":
          void refreshApprovals();
          break;
        case "question:requested":
        case "question:resolved":
          void refreshQuestions();
          break;
        case "userEvent:requested":
        case "userEvent:resolved":
          void refreshUserEvents();
          break;
        case "run:finished": {
          // The backstop for {@link AppState.producing}. A run's every call is balanced by its own
          // terminal event, so this is normally already zero — but a process killed mid-call publishes
          // this and nothing else, and a spinner that never stops is worse than one that starts late.
          if (ref.current.producing[message.taskId] !== undefined) {
            const { [message.taskId]: _done, ...rest } = ref.current.producing;
            patch({ producing: rest });
          }
          void refreshProjects();
          void refreshTasks();
          void refreshSharedTasks();
          void refreshBoard();
          void refreshDetail(ref.current.selected);
          void refreshState(ref.current.stateId);
          if (ref.current.selected !== null) {
            void refreshConversation(ref.current.selected);
            // The session HISTORY too, not only the detail beside it. It is what says which states
            // held a conversation, so a run that finished three children while you were reading the
            // first one left the panel able to name them (the instance tree refreshed) and unable to
            // show what any of them said.
            void refreshSession(ref.current.selected, ref.current.sessionInstance);
          }
          // Every cached transcript of the finished run was fetched while it could still grow. The
          // panel refetches what it is showing; the live tail's record has landed with it.
          if (message.taskId === ref.current.selected) patch({ sessions: {}, liveTurn: null });
          break;
        }
        case "session:turn": {
          // Somebody ELSE's turn. There is one tail here and it belongs to what is on screen, so a
          // delta from another task is dropped rather than folded in: a background sync, a run in
          // another project, or a conversation in another window would otherwise write its answer
          // into the transcript being read. `n` is per task, so a stray one also breaks the merge
          // protocol — the skip rule compares counts that were never counting the same thing.
          if (message.taskId !== ref.current.selected) break;
          // Already folded in — the tail was seeded from a `session:live` snapshot that had seen
          // this delta. Applying it again would show the fragment twice.
          const live = ref.current.liveTurn;
          if (alreadyFolded(live, message)) break;
          // The fold itself is shared with a made task's nested conversation (`liveTurnFold.ts`),
          // which holds a tail of its own for its task and must fold identically.
          patch({ liveTurn: foldLiveTurn(live, message) });
          break;
        }
        case "log:entry": {
          // PREPENDED rather than re-fetched: entries arrive one at a time, and the newest is at the
          // top. Capped from the far end — the pages a reader scrolled back to are the ones they are
          // least likely to want kept, and the mirror still holds them.
          const logs = [message.entry, ...ref.current.logs];
          patch({ logs: logs.length > LOG_LIMIT ? logs.slice(0, LOG_LIMIT) : logs });
          break;
        }
      }
    });
  }, [
    refreshAll,
    refreshTasks,
    refreshSharedTasks,
    refreshAllConversations,
    refreshBoard,
    refreshProjects,
    refreshDetail,
    refreshPending,
    refreshApprovals,
    refreshQuestions,
    refreshHistory,
    refreshConfig,
    refreshTree,
    refreshWorkflows,
    refreshState,
    refreshTaskState,
    refreshConversation,
    refreshSession,
  ]);

  const actions = useMemo(
    () => ({
      /**
       * Select a task, in the project it belongs to, from wherever it was clicked.
       *
       * Three things travel with the click, and each one was a bug without it:
       *
       *  - **`project`** — a task id is a rowid in ONE database, and both views now show JaiRA's own
       *    runs beside the checkout's. Reading a system task out of the user's project answers
       *    "unknown task".
       *  - **the inspector swaps onto the task**, which is the contextual-inspector rule: what you
       *    clicked is what the right-hand column describes. {@link AppState.inspectFrom} remembers
       *    what it was showing, so the panel has somewhere to go back to.
       *  - **`atState`** — the state whose panel the click came from, so the transcript opens at
       *    THIS state's instance rather than at the deepest one the task reached. See
       *    {@link refreshSession}.
       */
      select: (taskId: string | null, project?: string, atState?: string | null) => {
        // Named, then the task's OWN project where a list knows it, then whatever the last selection
        // resolved to, then the owner of the open file — NOT the focused project, which with no
        // checkout open is none and makes every read that follows throw. See `projectOfTask` for why
        // a stamped row outranks the previous selection, and `owningProject` for the last step.
        const at =
          project ?? (taskId === null ? undefined : projectOfTask(taskId)) ?? ref.current.selectedProject ?? owningProject();
        // OPENING IS LOOKING (SHELL.md §4.3). A status pill counts what has stopped since you last
        // looked, so the gesture that clears it is the one that answers it — going and reading the
        // thing. Clicking the pills stays as the way to dismiss a row you are not going to open.
        //
        // Marked to the row's OWN clock rather than to now, for the reason `markProjectSeen` is: a
        // turn landing in the same millisecond as the click is news, and `Date.now()` swallows it.
        if (taskId !== null) {
          const clock = taskClock(taskId);
          if (clock !== null) {
            const next = withSeen(ref.current.settings.ui, taskId, clock);
            if (next !== ref.current.settings.ui) setUi(next);
          }
        }
        const from = atState ?? ref.current.stateId;
        patch({
          selected: taskId,
          selectedProject: taskId === null ? null : (at ?? null),
          // One column, one subject: a card clicked takes the panel back off whatever workflow was
          // being described. See {@link AppState.taskWorkflow}.
          taskWorkflow: null,
          taskWorkflowProject: null,
          taskWorkflowRun: null,
          stream: [],
          sessions: {},
          // A trail names one task's instances (see `trail.ts`), so arriving at another task starts
          // a new one rather than extending this.
          trail: [],
          trailState: null,
          // Back to following the bar. A task card in a state's board IS a run of that state, and the
          // panel describes wherever the path now ends — see {@link AppState.inspect}.
          inspect: "path",
          // Only on the way IN. Clicking a second task while already on one must not overwrite the
          // state we came from with the task we are leaving — that is what turns Back into a loop.
          ...(taskId !== null && ref.current.inspect === "path" ? { inspectFrom: ref.current.stateId } : {}),
        });
        void refreshDetail(taskId, at).then((detail) => seedTrail(detail, from));
        void refreshConversation(taskId, at);
        void refreshSession(taskId, null, at, from);
      },

      /**
       * Walk into a run: append it to the path, and show it.
       *
       * The whole of "the view is the last element" — everything else here is bookkeeping to make
       * that true. The transcript moves to this instance (so a leaf tail shows what it said), the
       * declared children of its state are fetched (so a composite tail has columns for what never
       * ran), and the inspector follows, because the context bar describes where you are standing.
       */
      walkInto: (node: InstanceNode) => actionsRef.current.walkTo(ref.current.trail.length, node),

      /**
       * Put a run at one level of the path, replacing everything from there down.
       *
       * Both moves are this. Walking IN appends at the end; picking a sibling out of a chevron's menu
       * replaces at that level, because a sibling is not a step deeper and the levels below it
       * described a descent through the run you just left.
       */
      walkTo: (index: number, node: InstanceNode) => {
        patch({ trail: [...ref.current.trail.slice(0, index), stepOf(node)], inspect: "path" });
        void refreshSession(ref.current.selected, node.instanceId, ref.current.selectedProject ?? undefined);
        void refreshTrailState(node.stateId);
      },

      /**
       * Walk into a SUBAGENT CONVERSATION — a doorway row, appended to the path as a step.
       *
       * The step names the HOST instance (the run whose session holds the chain) plus the call id
       * that keys it; see `TrailStep.sidechain`. The host is a piece of whatever panel the doorway
       * was clicked in, which may be deeper than the trail's tail — that is fine, because the step
       * carries its own host rather than assuming the tail. No `trailState`: a sidechain declares
       * no children, so there is no board to fetch columns for.
       */
      walkIntoSidechain: (node: InstanceNode, call: string, name: string) => {
        patch({
          trail: [...ref.current.trail, { instanceId: node.instanceId, stateId: node.stateId, sidechain: call, name }],
          trailState: null,
          inspect: "path",
        });
      },

      /**
       * Walk back out to a crumb. `-1` is the file itself — the state, before any run was chosen.
       *
       * Truncating to the file CLEARS the selection rather than keeping it: with no run in the path
       * the view is the state's own board, and a highlighted task in it would be claiming a run is
       * open when the bar says none is.
       */
      walkBackTo: (index: number) => {
        if (index < 0) {
          // The detail goes with the selection. Left behind, the board would keep drawing that run's
          // executions — the previous level of the walk — under a path that says no run is open.
          patch({
            trail: [],
            trailState: null,
            selected: null,
            detail: null,
            conversation: null,
            session: null,
            sessionInstance: null,
            sessions: {},
            inspect: "path",
          });
          return;
        }
        const trail = ref.current.trail.slice(0, index + 1);
        const step = trail.at(-1);
        if (step === undefined) return;
        patch({ trail, inspect: "path" });
        void refreshSession(ref.current.selected, step.instanceId, ref.current.selectedProject ?? undefined);
        void refreshTrailState(step.stateId);
      },

      /**
       * Narrow the Tasks view to one project, or back to the listing of all of them.
       *
       * See {@link AppState.taskFocus}. Nothing is fetched — every group's board is already loaded,
       * because the listing draws them all.
       */
      focusProject: (project: string | null) => {
        patch({ taskFocus: project, at: project });
        // Except the picker's list, which is per project: the New-task button is offered only in the
        // focused one, and a picker still listing the last project's roots would create tasks from
        // workflows this one may not even have.
        void refreshWorkflows();
        // And the tree, which is now a view of ONE place: this moves `at`, so it moves which place.
        // Narrowing the board and then opening Files used to show whatever the tree was left at.
        void refreshTree();
      },

      /**
       * Put the address on a project — what clicking a project row in the sidebar does.
       *
       * Null is the ROOT, which is a real place and not "nothing chosen": the Tasks board lists
       * every group there, Settings edits `base`, and no project is expanded because there is no
       * project for the views to be views OF.
       *
       * It moves the Tasks narrowing with it, because the two are one address (SHELL.md §2.2) and a
       * board still filtered to the project you have just left is a column describing somewhere
       * else. Nothing is CLOSED by this: standing somewhere else is not closing where you were, and
       * that is the whole difference between an address and a mode.
       */
      standOn: (project: string | null) => {
        if (project === ref.current.at) return;
        patch({
          at: project,
          taskFocus: project,
          // With no project there is no project LAYER either, and the settings screens must not
          // merely hide the switch — they have to be editing the layer they say they are.
          ...(project === null ? { configLayer: "base" as ConfigLayer } : {}),
          trail: [],
          trailState: null,
        });
        void refreshTree();
        void refreshWorkflows();
        void refreshConfig();
        void refreshTasks();
        void refreshHistory();
        // The ROOT's conversation list spans every project, so moving to the root is arriving at a
        // list this window may never have fetched. It was filled once at startup — before main had
        // finished reopening the projects it is a list OF — and then only by task invalidates, so a
        // window that had simply not been told anything since it opened showed an empty root.
        void refreshAllConversations();
      },

      /**
       * Drill into one project's board. `null` returns that group to its workflow roots.
       *
       * Also NARROWS to that project, because a drill is a statement about where you want to be: the
       * levels below a workflow root only exist inside one project, so an address that grew them
       * while the column was still listing every group would be a path describing one of the things
       * on screen and not the others.
       *
       * And it drops the WALK. A run on the path was reached through the level you are leaving, so
       * once that level changes the run is no longer below it — kept, the column went on showing that
       * run while the crumbs said you had gone somewhere else, which is what made clicking the
       * project crumb look like a button that did nothing.
       */
      drillProject: (project: string, level: string | null) => {
        patch({
          levels: { ...ref.current.levels, [project]: level },
          taskFocus: project,
          trail: [],
          trailState: null,
        });
        void refreshProjects();
      },

      /**
       * Walk into a task from the Tasks board: put ITS RUN at this level on the address.
       *
       * The other half of the drill. Double-clicking a COLUMN goes to that state and shows every
       * task inside it, and double-clicking a CARD used to do the same thing — which answered a
       * question about one run by opening the board of the state it happened to be in. This is the
       * question the click actually asked: `.jaira › hello_world › #3`, and the middle column
       * redraws as that run rather than as its neighbours.
       *
       * `level` is the state the walk begins at — the board's own level, or the card's workflow at
       * the root listing, which is the same rule the Files view uses when it seeds a trail from an
       * open state's board. The board is drilled to it first, so the address has a state segment for
       * the run to hang off; without that step a card opened from the root listing would read
       * `.jaira › #3` and name no workflow at all.
       *
       * A task that never entered `level` gets no trail. It has no run there to walk into, and a
       * crumb standing on an instance that does not exist is worse than one crumb fewer.
       */
      openTask: (taskId: string, project: string, level: string) => {
        if (ref.current.levels[project] !== level) {
          patch({ levels: { ...ref.current.levels, [project]: level } });
          void refreshProjects();
        }
        patch({
          selected: taskId,
          selectedProject: project,
          taskFocus: project,
          // A run walked into is the subject now — see {@link AppState.taskWorkflow}.
          taskWorkflow: null,
          taskWorkflowProject: null,
          taskWorkflowRun: null,
          stream: [],
          sessions: {},
          trail: [],
          trailState: null,
          inspect: "path",
        });
        void refreshDetail(taskId, project).then((detail) => {
          // A LATE answer for a card that is no longer the one on the path — clicking a second task
          // while the first one's detail is still in flight. Same guard `seedTrail` carries, against
          // the same round trip.
          if (ref.current.selected !== taskId) return;
          const node = instanceOf(detail?.instances ?? [], level);
          if (node === undefined) return;
          patch({ trail: [stepOf(node)] });
          void refreshTrailState(node.stateId);
        });
        void refreshConversation(taskId, project);
        void refreshSession(taskId, null, project, level);
      },

      /** Fetch one child run's transcript, for a card that has just been opened. */
      loadSession: (instanceId: string) => void loadSession(instanceId),

      /** Fetch every transcript a session-panelled conversation is about to draw. */
      loadSessions: (at: ReadonlyArray<{ instanceId: string }>) => void loadSessions(at),

      /** Look at another state's conversation — clicking a row of the task's history. */
      showSession: (instanceId: string | null) => {
        void refreshSession(ref.current.selected, instanceId);
      },

      /**
       * Read what one process printed.
       *
       * POLLED on open rather than streamed: a chatty agent pushing every chunk would flood the
       * channel with output nobody is looking at, and a fetch cannot flood.
       */
      openJobOutput: async (jobId: number) => {
        try {
          patch({ jobOutput: { jobId, chunks: await invoke("job:output", { jobId }) } });
        } catch (e) {
          fail(e);
        }
      },
      closeJobOutput: () => patch({ jobOutput: null }),
      /**
       * Ask the log a different question — a level, a source, a substring.
       *
       * The filters live in the PANEL and the reading happens in main, so they travel with the
       * request rather than being applied to what arrived: a search that only sifted the page in
       * hand would be a search of the last five minutes wearing the clothes of a search of the log.
       */
      searchLogs: (query: LogQuery) => void refreshLogs(query),
      /** The next page towards the past — what scrolling to the end of the list asks for. */
      loadOlderLogs: (query: LogQuery) => void loadOlderLogs(query),
      /**
       * Put the inspector back where it was before a task took it over.
       *
       * The Back arrow, and what clicking the panel header does. It RESTORES rather than merely
       * switching: following a task's link to another state moves {@link AppState.stateId}, so
       * "show the state again" and "go back" stopped being the same place the moment the task panel
       * gained links. `inspectFrom` is the place; when it is still the open file, this is the cheap
       * switch it always was.
       */
      inspectState: () => {
        const back = ref.current.inspectFrom;
        patch({ inspect: "path", inspectFrom: null });
        // Which now means "describe the end of the address again" — the file when no run is on it,
        // and the run when one is. Restoring the state that was open is the other half, and it is
        // still needed because a task's links can move it out from under you.
        if (back === null || back === ref.current.stateId) return;
        actionsRef.current.selectState(back);
      },
      /**
       * Describe the TASK a run belongs to, rather than the run.
       *
       * The third subject of the context panel, and the only one with no click of its own: a run is
       * reached by walking into it and a file by opening it, but the task around them is something
       * you ask for — which is why this is a link on the run's panel rather than a mode.
       */
      inspectTask: () => patch({ inspect: "task" }),
      /**
       * Walk into a level in the Tasks view. `null` returns to the root listing.
       *
       * The breadcrumb is clickable before a project is open, so this needs the same guard
       * {@link setView} does.
       */
      drillTo: (level: string | null) => {
        if (ref.current.at === null) return;
        void refreshBoard(level);
      },
      dismissError: () => patch({ error: null }),

      /**
       * Which workflow the New-task form is filling in, and the boxes that go with it.
       *
       * Two steps rather than one because the second is a round trip: picking a root is instant, and
       * its declared inputs arrive a moment later into {@link AppState.workflowForms}, where the form
       * reads them. Nothing is cleared in between — see {@link refreshWorkflowForm} — so switching
       * between two workflows does not flash an empty form.
       *
       * The picked root is not held here. It is the form's own state: a popover that is closed has no
       * workflow picked, and remembering one across an open would be answering a question that was
       * asked and abandoned.
       */
      pickWorkflow: (stateId: string) => void refreshWorkflowForm(stateId),

      /**
       * Describe a WORKFLOW in the Tasks panel — the board's answer to clicking a file in the tree.
       *
       * A board column is a state, and until this the only thing on the Tasks view a click could
       * describe was a card. So the panel had nothing to say about the place every card in front of
       * you was sitting in, while the same state opened in the Files view had its inputs, its
       * validation, its dependants and a button to run it.
       *
       * The task selection is CLEARED, not kept: one column, one subject, and the last thing clicked
       * is what it is about. `select` does the same in the other direction.
       */
      selectWorkflow: (stateId: string | null, project?: string) => {
        patch({
          taskWorkflow: stateId,
          taskWorkflowProject: stateId === null ? null : (project ?? ref.current.at),
          // A column names a state and nothing narrower, so whatever run the panel was last scoped
          // to is not this one — see {@link AppState.taskWorkflowRun}.
          taskWorkflowRun: null,
          // Letting go of the workflow subject is going back to the rule — the panel describes the
          // end of the address again. Only from `workflow`: a click that lands on a column while the
          // panel is describing a task must not quietly change what Back means there.
          ...(stateId === null && ref.current.inspect === "workflow" ? { inspect: "path" as const } : {}),
          ...(stateId === null ? { taskState: null } : { selected: null, selectedProject: null, stream: [] }),
        });
        if (stateId === null) return;
        void refreshTaskState(stateId);
        void refreshWorkflowForm(stateId);
      },

      /**
       * Describe the workflow ONE conversation was opened by — the link in a session panel's gutter.
       *
       * Two things separate it from {@link selectWorkflow}, and both come from where it is clicked.
       *
       * The task stays selected. A column click is somebody leaving a card behind; this is somebody
       * reading a run and asking what the state behind it says, and dropping the selection would
       * take away both the conversation they were reading and the way back to it.
       *
       * The panel is scoped to the RUN: `taskWorkflowRun` is what fills the inspector's run form
       * with the inputs this pass was actually called with, and the run history beside it marks this
       * task because `selected` is still pointing at it.
       */
      inspectWorkflow: (stateId: string, instanceId: string, project?: string) => {
        patch({
          inspect: "workflow",
          taskWorkflow: stateId,
          taskWorkflowProject: project ?? ref.current.selectedProject ?? ref.current.at,
          taskWorkflowRun: instanceId,
        });
        void refreshTaskState(stateId);
        void refreshWorkflowForm(stateId);
      },

      /**
       * Create a task, from the workflow picked and the boxes its inputs produced.
       *
       * No title is asked for, and that is the point of the form's shape: a title typed before the
       * work exists is a name for something nobody has seen yet, and the one anybody actually wants
       * — `feature/plan #3` — is derivable. Generated exactly as the Files view's Run button
       * generates it ({@link runTitle}), from the runs this workflow has already had here, so a task
       * made from either surface reads the same on the board. Renaming one is a row's own menu item.
       *
       * In the FOCUSED project, which is the only project the button is offered in (see `App.tsx`)
       * and the one whose board the new card appears on.
       */
      createTask: async (workflow: string, inputs: Record<string, JsonValue>) => {
        patch({ busy: true, error: null });
        try {
          const summary = await invoke("task:create", {
            title: runTitle(workflow, runHistoryOf(workflow, ref.current.tasks, null).startedHere.length),
            workflow,
            ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
          });
          // Selected before anything else lands, for the reason `runState` does it: the panels that
          // follow a task have to be pointed at it to show its beginning rather than its middle.
          patch({ busy: false, selected: summary.taskId, taskWorkflow: null, taskWorkflowProject: null, taskWorkflowRun: null });
          await Promise.all([refreshTasks(), refreshBoard(), refreshProjects(), refreshDetail(summary.taskId)]);
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Start (or re-start) a task, in the project that holds it.
       *
       * `project` is not optional decoration once JaiRA's own runs are reachable from the Files
       * inspector: a shared workflow's task is a row in the system project's database, and starting
       * it against the focused one answers "unknown task".
       */
      startTask: async (taskId: string, fake?: unknown, project?: string) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          await actionsRef.current.startTaskAsking({
            taskId,
            ...(fake !== undefined ? { fake: fake as never } : {}),
            ...(project !== undefined ? { project } : {}),
          });
          patch({ busy: false });
        } catch (e) {
          fail(e);
        }
      },
      cancelTask: async (taskId: string, project?: string) => {
        try {
          await invoke("task:cancel", { taskId, ...(project !== undefined ? { project } : {}) });
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Run a task again. The response's task id is the one that actually started — a finished
       * task reruns as a fresh copy (see "task:rerun") — so the selection follows it: the card the
       * user is now watching is the run that is happening, not the record it was made from.
       */
      rerunTask: async (taskId: string, project?: string) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          const started = await invoke("task:rerun", { taskId, ...(project !== undefined ? { project } : {}) });
          patch({ busy: false, selected: started.taskId, selectedProject: project ?? ref.current.selectedProject });
          await Promise.all([refreshTasks(), refreshBoard(), refreshDetail(started.taskId, project)]);
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Pick a stopped task up where it left off.
       *
       * Unlike `rerunTask` the task id never changes: resuming is something a task does to itself,
       * and the copy-a-finished-task rule has no counterpart here — a completed or canceled run is
       * refused outright rather than duplicated, because there is nothing to continue.
       */
      resumeTask: async (taskId: string, project?: string) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          await invoke("task:resume", { taskId, ...(project !== undefined ? { project } : {}) });
          patch({ busy: false });
          await Promise.all([refreshTasks(), refreshBoard(), refreshDetail(taskId, project)]);
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Delete everything past a point and carry on from there — see "task:rewind".
       *
       * The same task, so the selection stays; what changes is everything the detail and the
       * conversation were drawing past the point, which the refresh below replaces.
       */
      rewindTask: async (taskId: string, seq: number, project?: string) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          await invoke("task:rewind", { taskId, at: seq, ...(project !== undefined ? { project } : {}) });
          patch({ busy: false });
          await Promise.all([refreshTasks(), refreshBoard(), refreshDetail(taskId, project)]);
        } catch (e) {
          fail(e);
        }
      },
      /**
       * A second task sharing everything before a point — see "task:fork". The copy is what is
       * running now, so the selection follows it, exactly as a re-run's does.
       */
      forkTask: async (taskId: string, seq: number, project?: string) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          const started = await invoke("task:fork", { taskId, at: seq, ...(project !== undefined ? { project } : {}) });
          patch({ busy: false, selected: started.taskId, selectedProject: project ?? ref.current.selectedProject });
          await Promise.all([refreshTasks(), refreshBoard(), refreshDetail(started.taskId, project)]);
        } catch (e) {
          fail(e);
        }
      },
      /**
       * The Chat view's fork: a second conversation sharing everything before a message, with the
       * message typed into it as its first own turn. Opened as the conversation being read, the way
       * a new conversation is.
       */
      forkConversation: async (taskId: string, seq: number, message: string, overrides: ChatSettings = {}, project?: string): Promise<string | null> => {
        const text = message.trim();
        if (text === "") return null;
        patch({ chat: { ...ref.current.chat, busy: true, error: null } });
        try {
          const forked = await invoke("task:fork", {
            taskId,
            at: seq,
            message: text,
            overrides,
            ...(project !== undefined ? { project } : {}),
          });
          patch({ chat: { ...ref.current.chat, taskId: forked.taskId, project: project ?? ref.current.chat.project, busy: false, opening: null } });
          actionsRef.current.select(forked.taskId, project);
          await Promise.all([project === SHARED_SESSION ? refreshSharedTasks() : refreshTasks(), refreshBoard()]);
          return forked.taskId;
        } catch (e) {
          patch({ chat: { ...ref.current.chat, busy: false, error: e instanceof Error ? e.message : String(e) } });
          return null;
        }
      },
      /** The Chat view's rewind: the conversation is cut before a message and stays the one being read. */
      rewindConversation: async (taskId: string, seq: number, project?: string): Promise<void> => {
        patch({ chat: { ...ref.current.chat, busy: true, error: null } });
        try {
          await invoke("task:rewind", { taskId, at: seq, ...(project !== undefined ? { project } : {}) });
          patch({ chat: { ...ref.current.chat, busy: false } });
          await Promise.all([project === SHARED_SESSION ? refreshSharedTasks() : refreshTasks(), refreshBoard(), refreshDetail(taskId, project)]);
        } catch (e) {
          patch({ chat: { ...ref.current.chat, busy: false, error: e instanceof Error ? e.message : String(e) } });
        }
      },
      /**
       * Delete tasks for good. The confirmation happened in the UI; by here the only job left is
       * to not keep showing what no longer exists — a deleted task that is also the selection would
       * otherwise leave the panel describing a record the next fetch cannot find.
       *
       * A LIST rather than one id, because the board's multi-select deletes a set in one gesture and
       * a refresh per member would redraw the board once per deletion. Sequential on purpose: each
       * delete may remove a git worktree, and racing several `git worktree remove` against one
       * repository is a lock contest git sometimes loses.
       */
      deleteTasks: async (taskIds: readonly string[], project?: string) => {
        patch({ busy: true, error: null });
        try {
          for (const taskId of taskIds) {
            await invoke("task:delete", { taskId, ...(project !== undefined ? { project } : {}) });
          }
          // A deleted conversation stops being the open one, or the Chat view would keep asking for
          // a transcript nothing can answer with.
          if (ref.current.chat.taskId !== null && taskIds.includes(ref.current.chat.taskId)) {
            patch({ chat: { ...ref.current.chat, taskId: null, error: null } });
          }
          // …and stops being remembered as read. This is the only moment the map can be pruned
          // safely — see `forgetSeen` on why the other direction is not available.
          setUi(forgetSeen(ref.current.settings.ui, taskIds));
          if (ref.current.selected !== null && taskIds.includes(ref.current.selected)) {
            patch({
              selected: null,
              detail: null,
              stream: [],
              sessions: {},
              sessionHistory: [],
              records: {},
              session: null,
              sessionInstance: null,
              conversation: null,
              trail: [],
              trailState: null,
              inspect: "path",
            });
          }
          patch({ busy: false });
          await Promise.all([refreshTasks(), refreshBoard()]);
        } catch (e) {
          fail(e);
        }
      },
      /** The set-menu's Re-run: each member in turn, with one refresh at the end. */
      rerunTasks: async (taskIds: readonly string[], project?: string) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          for (const taskId of taskIds) {
            await invoke("task:rerun", { taskId, ...(project !== undefined ? { project } : {}) });
          }
          patch({ busy: false });
          await Promise.all([refreshTasks(), refreshBoard()]);
        } catch (e) {
          fail(e);
        }
      },
      /** The set-menu's Cancel. Like the single cancel, the pushes carry the redraw. */
      cancelTasks: async (taskIds: readonly string[], project?: string) => {
        try {
          for (const taskId of taskIds) {
            await invoke("task:cancel", { taskId, ...(project !== undefined ? { project } : {}) });
          }
        } catch (e) {
          fail(e);
        }
      },
      // --- conversations ---------------------------------------------------------
      //
      // A conversation is a task whose workflow is one of the built-in chat states, so these three
      // verbs are the whole of what the Chat view needs the store for: which one is open, making a
      // new one, and naming it. Sending a message is not here — it is `chat:send`, addressed to an
      // instance the panel is already holding, and routing it through the store would put a channel
      // call between the composer and the thread it belongs to for no gain.

      /**
       * Open a conversation — the Chat view's selection.
       *
       * Selects the task as well, because everything the thread renders (the detail, the instance
       * tree, the transcript, the live tail) is fetched by the ordinary selection and re-fetched by
       * the ordinary invalidations. What this adds is a selection the Chat view REMEMBERS: the Tasks
       * view selects too, and coming back to a conversation you left should not find whichever card
       * was clicked in between.
       */
      openConversation: (taskId: string | null, project?: string) => {
        patch({ chat: { ...ref.current.chat, taskId, project: project ?? null, opening: null, error: null } });
        actionsRef.current.select(taskId, project);
      },

      /**
       * Start a conversation: create the task, and send the first message by running it.
       *
       * The first message is the RUN — the state's prompt is `{{.inputs.message}}` — which is what
       * makes a conversation an ordinary task with an ordinary journal rather than a special case
       * threaded through the engine. Every message after this one goes through `chat:send`.
       *
       * Where it runs is where the work is: the open checkout when there is one, so an agent
       * conversation reads and writes the project you are looking at. With nothing open it goes to
       * JaiRA's own root — the same routing every base-layer workflow uses (`runTargetOf`), and the
       * reason a conversation can be had on an empty window at all.
       */
      newConversation: async (message: string, overrides: ChatSettings = {}): Promise<string | null> => {
        const text = message.trim();
        if (text === "") return null;
        patch({ chat: { ...ref.current.chat, busy: true, opening: text, error: null } });
        // NAMED, both when there is a checkout to name and when there is not. `undefined` meant "the
        // focused project", which main resolves only while exactly one user project is open — so
        // creating a conversation with a second checkout open failed with "several projects are
        // open, so this call must name one". The address is the answer, and at the root it is the
        // shared one (`runTargetOf`'s rule for base-layer workflows).
        const project = ref.current.at ?? SHARED_SESSION;
        try {
          // Nothing is installed first (decision 0006): `chat/agent` ships in the built-in layer, the
          // last of every project's search path, so it resolves on an empty window, under a
          // repointed shared root and under a read-only one alike. A copy of it in `~/.jaira` or in
          // the project still wins, which is what an override is.
          const summary = await invoke("task:create", {
            title: titleOf(text),
            // Always the working conversation — see `chatWorkflow.ts` on why the view stopped asking.
            // `chat/assistant` still ships beside it: it is what conversations already started as one
            // continue to run under.
            workflow: CHAT_AGENT,
            inputs: { message: text },
            project,
          });
          // Selected BEFORE it starts, so the thread is pointed at the run when its first delta
          // arrives — selecting afterwards means watching the opening in the past tense.
          patch({ chat: { ...ref.current.chat, taskId: summary.taskId, project, busy: false } });
          actionsRef.current.select(summary.taskId, project);
          await Promise.all([project === SHARED_SESSION ? refreshSharedTasks() : refreshTasks(), refreshBoard()]);
          // The composer's picks ride the START, because for a conversation the first message IS the
          // run — see `StartTaskRequest.overrides`. Every later message carries them on `chat:send`
          // instead, which is the same settings reaching the same call by the route that call takes.
          await actionsRef.current.startTaskAsking({
            taskId: summary.taskId,
            ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
            project,
          });
          return summary.taskId;
        } catch (e) {
          patch({ chat: { ...ref.current.chat, busy: false, error: (e as Error).message } });
          return null;
        }
      },

      /** Name a conversation — or any task. The title is metadata; nothing about the run depends on it. */
      renameTask: async (taskId: string, title: string, project?: string) => {
        try {
          await invoke("task:rename", { taskId, title, ...(project !== undefined ? { project } : {}) });
          await Promise.all([
            project === SHARED_SESSION ? refreshSharedTasks() : refreshTasks(),
            refreshBoard(),
            refreshDetail(taskId, project),
          ]);
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Review a task's worktree edits (CHANGESETS.md). The call returns as soon as the review run
       * starts; the reviewer itself arrives as a pending interaction and pops through the ordinary
       * gate flow — nothing here waits on a human.
       */
      reviewChanges: async (taskId: string, project?: string) => {
        try {
          await invoke("changeset:review", { taskId, ...(project !== undefined ? { project } : {}) });
        } catch (e) {
          fail(e);
        }
      },
      /** The sync's proposals through the same gate — see `SyncSurface.reviewChangeset`. */
      reviewSyncChangeset: async (layer: WorkflowLayer, path: string, changeset: Changeset, parentTaskId?: string) => {
        try {
          await invoke("changeset:reviewSync", {
            layer,
            path,
            changeset,
            ...(parentTaskId !== undefined ? { parentTaskId } : {}),
          });
        } catch (e) {
          fail(e);
        }
      },
      /**
       * The gesture happened — a card was dropped on a column a waiting transition was offering it
       * (`on_user_event`, WORKFLOWS.md §7.4).
       *
       * No optimistic move of the card. What a drop does is answer a rule, and where the run goes
       * next is the workflow's decision, not the board's — so the card moves when the run says it
       * moved, which arrives on the ordinary board refresh.
       */
      deliverUserEvent: async (requestId: string) => {
        try {
          await invoke("userEvent:deliver", { requestId });
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Answer a per-command approval. `scope` is why a user is not asked the same
       * question on every tool call (DESIGN §10.2).
       */
      decideApproval: async (requestId: string, decision: "allow" | "deny", scope: ApprovalScope = "once") => {
        try {
          await invoke("approval:submit", { requestId, decision, scope });
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Answer a running agent's question — or dismiss it (`answers` absent), which tells the agent
       * to use its own judgment and continue.
       */
      answerQuestion: async (requestId: string, answers?: Record<string, string | string[]>) => {
        try {
          await invoke("question:submit", { requestId, ...(answers !== undefined ? { answers } : {}) });
        } catch (e) {
          fail(e);
        }
      },
      answer: async (requestId: string, value: unknown) => {
        try {
          await invoke("interaction:submit", { requestId, value: value as never });
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Preview a prune (SPEC §13). Always a dry run: the panel shows what would
       * go before the user confirms, because deleted history does not come back.
       */
      planPrune: async (olderThanDays: number) => {
        try {
          patch({ prune: await invoke("history:prune", { olderThanDays }) });
        } catch (e) {
          fail(e);
        }
      },
      applyPrune: async (olderThanDays: number) => {
        patch({ busy: true, error: null });
        try {
          const result = await invoke("history:prune", { olderThanDays, apply: true });
          patch({ prune: result, history: result.remaining, busy: false });
        } catch (e) {
          fail(e);
        }
      },
      dismissPrune: () => patch({ prune: null }),
      openProject: async (dir: string) => {
        patch({ busy: true, error: null });
        try {
          // Asked before opening, so "not a project yet" can be an offer rather than a failure —
          // see {@link AppState.initPrompt}. An already-open project is opened again anyway: main
          // answers with the session it has, which is the cheapest way to say "you are already
          // there" without this having to know.
          const what = await invoke("project:inspect", { dir });
          if (!what.project) {
            patch({ busy: false, initPrompt: what.dir });
            return;
          }
          await invoke("project:open", { dir: what.dir });
          patch({ busy: false, selected: null, detail: null });
          await refreshAll();
        } catch (e) {
          fail(e);
        }
      },
      /**
       * Set up the folder the person was offered, and open it.
       *
       * The path comes from {@link AppState.initPrompt} rather than from the click, so the directory
       * written into is the one the dialog named — a second argument would be a second chance to
       * disagree with what was on screen.
       */
      initProject: async () => {
        const dir = ref.current.initPrompt;
        if (dir === null) return;
        patch({ busy: true, error: null, initPrompt: null });
        try {
          await invoke("project:init", { dir });
          patch({ busy: false, selected: null, detail: null });
          await refreshAll();
        } catch (e) {
          fail(e);
        }
      },
      dismissInit: () => patch({ initPrompt: null }),
      /**
       * Pick a directory, then open or set up whatever was picked.
       *
       * Two round trips rather than one channel that does both, so the failure has a path in it: a
       * folder chosen for "open" that turns out not to be a project fails with its own name in the
       * message, and the offer to set it up instead is a second click rather than a silent write
       * into a directory somebody only meant to look at.
       */
      chooseProject: async (mode: "open" | "init") => {
        patch({ busy: true, error: null });
        try {
          const picked = await invoke("project:choose", { mode });
          if (picked === null) {
            patch({ busy: false });
            return;
          }
          // "Open" on a folder that is not a project yet asks rather than fails: picking a checkout
          // that has never been set up is how a project starts, and refusing it was the app telling
          // someone to go and run `jaira init` in a terminal. "New project…" already means "write a
          // layout here", so it does not ask.
          if (mode === "open") {
            const what = await invoke("project:inspect", { dir: picked.dir });
            if (!what.project) {
              patch({ busy: false, initPrompt: what.dir });
              return;
            }
          }
          await invoke(mode === "init" ? "project:init" : "project:open", { dir: picked.dir });
          patch({ busy: false, selected: null, detail: null });
          await refreshAll();
        } catch (e) {
          fail(e);
        }
      },

      // --- appearance -------------------------------------------------------

      /**
       * Switch theme.
       *
       * The new value is applied to local state FIRST and persisted after: the toggle has to feel
       * instant, and a settings file that cannot be written is not a reason to refuse the change
       * for this session.
       */
      setTheme: async (theme: JairaTheme) => {
        patch({ settings: { ...ref.current.settings, theme } });
        try {
          patch({ settings: keepingUi(await invoke("settings:write", { theme })) });
        } catch (e) {
          fail(e);
        }
      },

      // --- the remembered layout (see `uiState.ts`) ---------------------------

      /**
       * Resize a pane.
       *
       * Every splitter in the app calls this instead of a `useState` setter, which is the whole
       * change: a width used to be undone by closing the window, and two of them by switching views.
       * The write to disk is deferred — see {@link setUi} — so a drag stays a drag.
       */
      setPane: (id: string, size: number) => setUi(withPane(ref.current.settings.ui, id, size)),

      /** Open or close a disclosure — the Files editor half, the field reference, "Show effective". */
      setFold: (id: string, open: boolean) => setUi(withOpen(ref.current.settings.ui, id, open)),

      /** Put a control with more than two positions into one of them — see `uiState`'s `modes`. */
      setMode: (id: string, mode: string) => setUi(withMode(ref.current.settings.ui, id, mode)),

      /**
       * Fold one branch of a collapsible tree, or unfold it.
       *
       * The row key is the tree's own — `layer:path` for the Files tree — and it is stored rather
       * than interpreted here, because which rows exist is the tree's business and a folded key that
       * no longer matches anything is harmless.
       */
      toggleShut: (id: string, key: string) => setUi(toggleShut(ref.current.settings.ui, id, key)),
      /** The same for a tree that defaults SHUT — see `unfolded` in the settings. */
      toggleUnfolded: (id: string, key: string) => setUi(toggleUnfolded(ref.current.settings.ui, id, key)),
      /** Open several at once — and see `withUnfolded` for why a loop over the one above loses. */
      unfold: (id: string, keys: readonly string[]) => setUi(withUnfolded(ref.current.settings.ui, id, keys, true)),
      /** Several at once — see `withShut` for why this is not a loop over the one above. */
      setShut: (id: string, keys: readonly string[], shut: boolean) =>
        setUi(withShut(ref.current.settings.ui, id, keys, shut)),

      /**
       * Remember that a conversation has been read as far as a given moment.
       *
       * Called from a render effect while a conversation is open, so it is called OFTEN — several
       * times a second while an answer is streaming. The guard is what makes that fine: `withSeen`
       * is monotonic and returns the state it was given when the mark would not move, so the common
       * call does nothing at all rather than patching an identical object and re-rendering the
       * window that asked.
       */
      markSeen: (taskId: string, at: number) => {
        const next = withSeen(ref.current.settings.ui, taskId, at);
        if (next !== ref.current.settings.ui) setUi(next);
      },

      /**
       * Mark a whole project's stopped tasks read — what clicking its pills does (SHELL.md §4.3).
       *
       * The status pills clear and the active ones stay, because they are not about having looked:
       * a run still working is still working. Marks move to each task's OWN clock rather than to
       * `Date.now()`, so a turn that lands in the same millisecond as the click is not swallowed.
       */
      markProjectSeen: (project: string) => {
        const summary = ref.current.projects.find((p) => p.project === project);
        if (summary === undefined) return;
        const next = withSeenAll(ref.current.settings.ui, unseenTasks(summary, ref.current.settings.ui.seen));
        if (next !== ref.current.settings.ui) setUi(next);
      },

      /**
       * Mark a NAMED set of rows read — what a view row's pills clear.
       *
       * `markProjectSeen` clears a whole project because that is what a project row counts. A view
       * row counts one of the two things inside it (SHELL.md §4.3), so it has to name its own share
       * rather than take the project's: clearing Chat's `✓2` must not also clear the three finished
       * runs on Tasks, or the pills would be answering a question nobody asked.
       */
      markSeenAll: (marks: readonly { taskId: string; at: number }[]) => {
        const next = withSeenAll(ref.current.settings.ui, marks);
        if (next !== ref.current.settings.ui) setUi(next);
      },

      // --- the shell --------------------------------------------------------

      /**
       * Switch view, refetching what that view reads.
       *
       * The Files tree is fetched whether or not a project is open — the shared root is
       * machine-global, so there is always something to show. Both refreshers swallow their own
       * failures, which is what stopped switching views from raising "no project is open" as a
       * toast; guarding the call instead would have hidden the shared root as well.
       */
      setView: (view: View) => {
        patch({ view, error: null });
        if (view === "settings") void refreshConfig();
        if (view === "files") void refreshTree();
        // The per-project boards go stale while this view is not on screen — a running task's
        // transitions are not followed there, deliberately, because following them costs a fetch per
        // project per journal entry. Arriving is when that debt is paid. See the `board` invalidate.
        if (view === "tasks") void refreshProjects();
        // Backfilled once on open; everything after arrives on the push.
        // Same for arriving at Chat by any other door: the list it draws is fetched by nothing else.
        if (view === "chat") void refreshAllConversations();
        if (view === "logs") void refreshLogs();
        // What the pane leads with is whether the self-test is installed, so it has to be true when
        // the pane appears rather than after the first click.
        if (view === "debug") void refreshDebugFiles();
      },
      setSection: (section: SettingsSection) => {
        patch({ section });
        // Read what main already knows. It does NOT trigger a check: the checks ran at startup and
        // after the last write, so opening this section shows an answer immediately rather than a row
        // of "not checked" that fills in a second later — which is what the old on-open probe did.
        if (section === "providers" || section === "executors" || section === "integrations") void refreshAvailability();
      },
      // Refused rather than silently accepted when there is nothing to write: the shell hides the
      // switch without a project, and an action that could still be reached another way should agree
      // with it rather than leaving the panes claiming to edit a document that does not exist.
      setConfigLayer: (configLayer: ConfigLayer) => {
        if (configLayer === "project" && ref.current.at === null) return;
        patch({ configLayer });
      },

      /**
       * Open a file in the Files tree.
       *
       * The node carries everything the panel needs to decide what to render — its layer, its path,
       * its MIME type, and its state id when it has one — so selection is one call whatever was
       * clicked. Opening a different file drops whatever task the inspector was describing, because
       * that task has nothing to do with the new file.
       */
      selectFile: (node: FileNode) => {
        patch({ stateId: node.stateId ?? null, inspect: "path", doc: null, dir: null, sync: clearedSync(ref.current.sync) });
        void refreshState(node.stateId ?? null).then((view) => focusStateRun(view));
        if (isTextMime(node.mime)) return void refreshDoc(node.layer, node.path, node.project);
        // A PNG or the database: `file:read` would refuse it, and a refusal here would leave the
        // panel empty with nothing to explain it. Open it as a document with no contents instead —
        // the panel then says which type it cannot edit, which is the answer to why it is blank.
        patch({
          doc: { layer: node.layer, path: node.path, file: node.path, mime: node.mime, text: "", exists: true },
        });
      },

      /**
       * Select a state by id — what walking into a board column does.
       *
       * A column knows a child's id but not which file supplied it, so the pair has to be looked up
       * before the document can be read. Drilling and selecting stay one action: the tree highlights
       * the file this resolves to, so it always says where you are.
       */
      selectState: (stateId: string | null) => {
        patch({ stateId, inspect: "path", doc: null, dir: null, sync: clearedSync(ref.current.sync) });
        void refreshState(stateId).then((view) => focusStateRun(view));
        if (stateId === null) return void refreshDoc(null, null);
        void locateState(stateId).then((at) => refreshDoc(at?.layer ?? null, at?.path ?? null));
      },

      /**
       * Open one state a task ran, showing THAT run's conversation in it.
       *
       * The move the task panel's list of states is for: "this is the state that failed" and "take me
       * to it" are one thought, and they were two clicks in different places — the row read the
       * transcript, a separate arrow opened the file, and neither did the other.
       *
       * Deliberately NOT {@link selectState}, which would pick the state's newest run and could
       * therefore land you in a different task's conversation than the one you were reading. The
       * instance is passed through, so the transcript that opens is this task's pass through this
       * state — the exact record the row named.
       *
       * `inspect` stays on the task. You are walking a run's states; taking the column away from the
       * list you are walking would end the walk after one step. The Back arrow still goes where the
       * context came from.
       */
      openStateAt: (stateId: string, instanceId: string) => {
        // `inspect` goes back to the path like every other move that changes the bar. This one used
        // to hold the column on the task so its list of states could be walked; it cannot any more,
        // because the rule is that the panel describes where the address ends. The list is one click
        // away on the run's own panel.
        patch({ stateId, doc: null, dir: null, inspect: "path", sync: clearedSync(ref.current.sync) });
        void refreshState(stateId);
        void locateState(stateId).then((at) => refreshDoc(at?.layer ?? null, at?.path ?? null));
        void refreshSession(ref.current.selected, instanceId, ref.current.selectedProject ?? owningProject());
        // The path lands on the run that was clicked, not on the state's newest — the row named one
        // pass through it, and that is the one about to be on screen.
        const node = nodeAt(ref.current.detail?.instances ?? [], instanceId);
        patch(node === undefined ? { trail: [], trailState: null } : { trail: [stepOf(node)], trailState: null });
      },

      /**
       * Open a DIRECTORY: show what is in it, as a file explorer does.
       *
       * The other half of an address bar. A path whose segments you can click is only navigable if
       * the segments themselves are places — and every segment but the last one is a folder, so
       * without this the bar could only ever go to the file it already had open.
       *
       * `""` is the layer root. Everything a file open would set is cleared, because a folder is not
       * a state and not a document: leaving `stateId` behind would leave the inspector describing a
       * state you have navigated away from, and the trail with it.
       */
      openDir: (layer: WorkflowLayer, path: string) => {
        patch({
          dir: { layer, path },
          doc: null,
          stateId: null,
          state: null,
          inspect: "path",
          trail: [],
          trailState: null,
          sync: clearedSync(ref.current.sync),
        });
      },

      /**
       * Open a file by its path, for callers that have one and no tree node.
       *
       * `selectState` cannot serve this: it resolves an id through `state:view`, which fails for a
       * state that does not exist yet — and a state file a sync has just PROPOSED is exactly that.
       * Opening by path shows the file as "not created yet" with the proposal in its editor, which
       * is the correct picture of what saving would do.
       */
      openPath: (layer: WorkflowLayer, path: string) => {
        patch({ inspect: "path", doc: null, dir: null, sync: clearedSync(ref.current.sync) });
        // One read, not two: the document that arrives is what says whether this path defines a
        // state, and asking twice is how the panel and the inspector end up a revision apart.
        void refreshDoc(layer, path).then(() => {
          const stateId = ref.current.doc?.stateId ?? null;
          patch({ stateId });
          return refreshState(stateId).then((view) => focusStateRun(view));
        });
      },

      // --- the description and the workflows --------------------------------

      /**
       * Which of the description and the state files has moved since they were last in step.
       *
       * Quiet on failure like the other panel-side reads: this fires when a file is opened, and a
       * project that is not open yet is not something to raise a toast about. A null status is a
       * "checking…" line rather than an error.
       */
      syncStatus: async (layer: WorkflowLayer, path: string) => {
        try {
          patch({ sync: { ...ref.current.sync, status: await invoke("workflow:syncStatus", { layer, path, ...inLayer(layer) }) } });
        } catch {
          patch({ sync: { ...ref.current.sync, status: null } });
        }
      },

      /**
       * Run a sync, and turn what it proposes into unsaved drafts.
       *
       * The two halves of the promise this feature makes are both here. The document sent is the
       * DRAFT — what the editor is showing, not what the file says — so a sync answers about the
       * description in front of you. And what comes back is written to `drafts`, never to disk: the
       * rewritten description lands in the editor below the panel, proposed state files land against
       * their own rows in the tree, and every one of them is saved, or not, by the person reading it.
       *
       * A proposal identical to the file on disk is recorded as no draft at all — `drafts` holds
       * differences (see `drafts.ts`), and an entry equal to the file would mark a row as edited
       * when nothing about it would change.
       */
      runSync: async (direction: SyncDirection) => {
        const doc = ref.current.doc;
        if (doc === null) return;
        const key = docKey(doc.layer, doc.path);
        const text = ref.current.drafts[key] ?? doc.text;
        patch({ sync: { ...ref.current.sync, running: true, error: null, progress: [] } });
        try {
          const result = await invoke("workflow:sync", {
            layer: doc.layer,
            path: doc.path,
            direction,
            text,
            // A states sync opens its review itself: the diff UI arrives as a pending interaction
            // from main, so it reaches the user even if this await never resolves for them — a
            // reloaded window, an hour-long run, a different view on screen.
            ...(direction === "states" ? { review: true } : {}),
          });
          let drafts = ref.current.drafts;
          if (result.document !== undefined) {
            drafts = withDraft(drafts, key, result.document.text === doc.text ? null : result.document.text);
          }
          for (const edit of result.edits ?? []) {
            if (edit.applicable) drafts = withDraft(drafts, docKey(edit.layer, edit.path), edit.text);
          }
          // The narration goes with the run it narrated: the result is here now, and a finished run's
          // step-by-step is noise beside it.
          patch({ drafts, sync: { status: ref.current.sync.status, result, running: false, error: null, progress: [] } });
          // The status moves with the proposal: a sync that found nothing to do has just recorded
          // that the two agree, and the panel should say so without being reopened.
          await actionsRef.current.syncStatus(doc.layer, doc.path);
        } catch (e) {
          patch({ sync: { ...ref.current.sync, running: false, error: (e as Error).message } });
        }
      },

      /** Abort a sync in flight. The proposal it would have produced is simply never delivered. */
      cancelSync: async () => {
        try {
          await invoke("workflow:syncCancel", undefined);
        } catch (e) {
          fail(e);
        }
      },

      /** Open the file one proposed edit would change, so a listed edit is one click from readable. */
      openSyncEdit: (edit: WorkflowSyncEdit) => actionsRef.current.openPath(edit.layer, edit.path),

      // --- configuration ----------------------------------------------------

      /**
       * Replace one configuration layer. Main validates before writing, so a rejected save leaves
       * the file untouched and the message names the offending field.
       */
      saveConfig: async (layer: "base" | "project", config: unknown) => {
        patch({ busy: true, error: null });
        try {
          const next = await invoke("config:write", { layer, config: config as never, ...inLayer(layer === "base" ? "base" : "project") });
          patch({ config: next, busy: false });
          await refreshConfig();
          // `settings.json` is the one editor that does not save through `saveDoc` — it writes a
          // parsed document so main can validate it — so its draft has to be released here. Only
          // when the open file IS that layer's config: the Settings pane calls this too, and it has
          // no business clearing an edit to whatever the Files view happens to have open.
          const open = ref.current.doc;
          if (open !== null && open.mime === CONFIG_JSON && open.layer === layer) {
            patch({ drafts: withDraft(ref.current.drafts, docKey(open.layer, open.path), null) });
          }
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Write `config.models` into a named layer — the default id, the routes, the presets.
       *
       * The same layering rule the executor form follows, for the same reason: patched into that
       * layer's own document, never the merged one, so saving in a project cannot silently copy the
       * shared root's settings out of it.
       */
      saveModels: async (fields: ModelPatch, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = applyModelPatch(layer === "base" ? current.base : current.project, fields);
        // The write itself makes main re-check and push, so nothing is probed from here: a probe
        // fired beside the write would race it and report the configuration that was just replaced.
        await actions.saveConfig(layer, doc);
      },

      /**
       * Write `config.files.hidden` into a named layer — what the Files tree leaves out.
       *
       * `null` REMOVES the key, which is the difference between "I have no opinion" and "show
       * everything": an absent key means the defaults, and `[]` means a person has asked to see
       * `system/` and the rest. A pane that could only write an array could never say the first
       * thing again once it had said the second.
       */
      saveHiddenPaths: async (patterns: string[] | null, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = (layer === "base" ? current.base : current.project) ?? {};
        const base = typeof doc === "object" && doc !== null && !Array.isArray(doc) ? { ...doc } : {};
        const files = base["files"];
        const block = typeof files === "object" && files !== null && !Array.isArray(files) ? { ...files } : {};
        if (patterns === null) delete block["hidden"];
        else block["hidden"] = patterns;
        // An empty `files` block is noise in a file people read, so it goes rather than being left
        // behind as `"files": {}` by a person who removed their last pattern.
        if (Object.keys(block).length === 0) delete base["files"];
        else base["files"] = block;
        await actions.saveConfig(layer, base);
        // Main draws the tree from this, and `saveConfig` invalidates configuration alone — so
        // without this the pattern you just added does nothing visible until something else happens
        // to re-read the tree.
        await refreshTree();
      },

      /**
       * Re-observe everything now.
       *
       * The one action behind both "Re-check" buttons, because there is one question — what can
       * answer a prompt here? — and answering half of it was how the Models screen came to show a
       * route as fine while the executor that would actually have run was missing.
       *
       * It exists for the cases a startup check cannot cover: a local server started since, a key
       * just installed outside the app. Nothing depends on it being pressed.
       */
      recheckAvailability: async () => {
        if (ref.current.rechecking) return;
        patch({ rechecking: true, error: null });
        try {
          applyAvailability(patch, await invoke("availability:refresh", undefined));
        } catch (e) {
          fail(e);
        } finally {
          patch({ rechecking: false });
        }
      },

      // --- executors --------------------------------------------------------

      /**
       * Write one executor's settings into a named layer.
       *
       * Patched into that layer's raw document rather than the merged one, or saving would copy
       * every inherited base value into the project and freeze it there. A field patched to
       * `undefined` is removed, which is how a project stops overriding the shared root.
       */
      setExecutorConfig: async (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = applyExecutorPatch(layer === "base" ? current.base : current.project, executor, fields);
        // The write may have changed the binary or the credential, so what was known about this
        // executor's health no longer describes the executor that is now configured. Main re-checks
        // on every config write and pushes the result, so this does not ask for one itself — a probe
        // fired here would race the write and report the executor that was just replaced.
        await actionsRef.current.saveConfig(layer, doc);
      },

      /**
       * Write one named executor DEFINITION into a layer (`config.executors.<name>`).
       *
       * `undefined` removes it. Patched into the layer's own document like every other write here,
       * so saving in a project cannot copy the shared root's definitions out of it.
       */
      saveDefinition: async (
        name: string,
        definition: JairaOperationNode | undefined,
        layer: ConfigLayer,
      ) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = structuredClone(
          (layer === "base" ? current.base : current.project) ?? {},
        ) as Record<string, unknown>;
        const executors = { ...((doc["executors"] ?? {}) as Record<string, unknown>) };
        if (definition === undefined) delete executors[name];
        else executors[name] = definition;
        // An emptied block is deleted rather than left as `{}`: this layer defines no executors now,
        // and the document should say so — an empty object reads as a deliberate, if inert, override.
        if (Object.keys(executors).length === 0) delete doc["executors"];
        else doc["executors"] = executors;
        await actionsRef.current.saveConfig(layer, doc as ConfigView["effective"]);
      },

      /** Turn an executor on or off — the one field every executor shares. */
      setExecutorEnabled: async (name: string, enabled: boolean, layer: ConfigLayer) => {
        const executor = ref.current.executors.find((e) => e.name === name);
        if (executor === undefined) return;
        await actionsRef.current.setExecutorConfig(executor, { enabled }, layer);
      },

      /** Declare a new non-Claude CLI executor in a layer (DESIGN §8.1's `generic-cli`). */
      addExecutor: async (spec: { name: string; command: string }, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        try {
          const doc = addGenericExecutor(layer === "base" ? current.base : current.project, spec);
          await actionsRef.current.saveConfig(layer, doc);
        } catch (e) {
          fail(e);
        }
      },

      /** Delete a configured CLI executor from a layer. Built-ins are turned off, never removed. */
      removeExecutor: async (name: string, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = removeGenericExecutor(layer === "base" ? current.base : current.project, name);
        await actionsRef.current.saveConfig(layer, doc);
      },

      /**
       * Store an executor's credential: the NAME into config, the VALUE into the secret store.
       *
       * One action rather than two calls from the pane, because the two halves are one intention and
       * doing them separately gets the order wrong in a way that shows: naming a secret the config
       * did not mention re-probes, and a probe between the two steps reports the key as missing when
       * it is merely a moment from being written.
       *
       * The value goes straight to main and is never held in renderer state; an empty one CLEARS the
       * secret, which is how a key is revoked.
       */
      saveCredential: async (request: {
        executor: ExecutorTarget & { credential?: string | undefined };
        name: string;
        value: string;
        target: SecretTarget;
        layer: ConfigLayer;
      }) => {
        const { executor, name, value, target, layer } = request;
        patch({ busy: true, error: null });
        try {
          await invoke("secret:set", { name, value, target });
          patch({ busy: false });
          if (name !== executor.credential) {
            // A stored key nothing points at would never be looked up, so naming it in the layer
            // being edited is part of saving it — not a second thing to remember.
            await actionsRef.current.setExecutorConfig(executor, { credential: name }, layer);
          } else {
            // The name was already in config, so nothing was written and no re-check was pushed —
            // but the VALUE behind it changed, which is exactly what the last check was reporting on.
            await actionsRef.current.recheckAvailability();
          }
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Store a forge connection's token (decision 0004 §1) — {@link saveCredential}'s sibling.
       *
       * The value goes straight to main and is never held in renderer state; an empty one CLEARS it.
       * A connection that names no token yet gets the name written into the layer being edited, for
       * the reason an executor does: a stored secret nothing points at is never looked up.
       */
      saveForgeToken: async (request: {
        connection: string;
        named?: string;
        name: string;
        value: string;
        target: SecretTarget;
        layer: ConfigLayer;
      }) => {
        const { connection, named, name, value, target, layer } = request;
        patch({ busy: true, error: null });
        try {
          await invoke("secret:set", { name, value, target });
          patch({ busy: false });
          if (name !== named) {
            const view = ref.current.config;
            const doc = structuredClone(((layer === "base" ? view?.base : view?.project) ?? {}) as Record<string, unknown>);
            const integrations = (doc["integrations"] ??= {}) as Record<string, unknown>;
            const forges = (integrations["forges"] ??= {}) as Record<string, unknown>;
            forges[connection] = { ...((forges[connection] ?? {}) as object), credential: name };
            // Writing config re-checks on its own, with the new name in hand.
            await actionsRef.current.saveConfig(layer, doc);
          } else {
            // The name was already in config, so nothing was written and no re-check was pushed —
            // but the VALUE behind it changed, which is exactly what the last check was reporting on.
            await actionsRef.current.recheckAvailability();
          }
        } catch (e) {
          fail(e);
        }
      },

      // --- workflow authoring -----------------------------------------------

      /**
       * Select a state and load its file — what opening one from a menu does.
       *
       * Takes the layer explicitly, unlike {@link selectState}: the caller right-clicked one of the
       * two copies, and resolving the id again would be free to pick the other one.
       */
      openWorkflow: async (stateId: string, layer: WorkflowLayer) => {
        patch({ busy: true, error: null, view: "files", stateId, inspect: "path" });
        try {
          const at = await locateState(stateId, layer);
          await refreshDoc(layer, at?.path ?? `workflows/${stateId}.json`);
          patch({ busy: false });
          await refreshState(stateId);
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Create a state, writing the file immediately.
       *
       * Not "open an editor over a file that does not exist yet": a state you have named and then
       * cannot see in the tree is a state you will name again. The document starts empty and the
       * lint surface says what it still needs, which is the same thing it would say after a Save.
       */
      createWorkflow: async (stateId: string, layer: WorkflowLayer, project?: string) => {
        patch({ busy: true, error: null, view: "files" });
        try {
          // WHICH project, when the tree holds several: the row the create was started from names
          // it, and the standing one is only the fallback. Without it, a `+` pressed in another
          // checkout's branch wrote into the project the shell happened to be on.
          await invoke("workflow:write", { stateId, layer, text: "{}", ...inLayer(layer, project) });
          patch({ busy: false, stateId, inspect: "path" });
          await Promise.all([
            refreshTree(),
            refreshState(stateId),
            refreshDoc(layer, `workflows/${stateId}.json`),
          ]);
        } catch (e) {
          fail(e);
        }
      },

      /** Create a plain file or a directory under a layer root. */
      createFile: async (layer: WorkflowLayer, path: string, kind: "file" | "directory", text?: string, project?: string) => {
        patch({ busy: true, error: null });
        try {
          // Same as {@link createWorkflow}: the row that was clicked names the project, not the shell.
          await invoke("file:create", { layer, path, kind, ...(text !== undefined ? { text } : {}), ...inLayer(layer, project) });
          patch({ busy: false });
          await refreshTree();
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Rename, duplicate, or copy a state into the other layer.
       *
       * Returns the result rather than swallowing it: a refusal carries the states that reference
       * this one, and the caller is the only thing that can decide whether to ask and retry.
       */
      moveWorkflow: async (request: {
        stateId: string;
        layer: WorkflowLayer;
        to: string;
        toLayer: WorkflowLayer;
        copy?: boolean;
        force?: boolean;
      }): Promise<WorkflowMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          // Where the file is NOW, asked before the move so there is still something to find. A
          // rename leaves nothing at the old path, and a draft stranded there would reappear under
          // whatever is created with that name next.
          const from = request.copy === true ? null : await locateState(request.stateId, request.layer);
          const result = await invoke("workflow:move", { ...request, ...inLayer(request.layer) });
          patch({ busy: false });
          if (result.applied) {
            // Follow the file: after a rename the old id names nothing, and leaving the tree
            // pointed at it would show "select a state" for something that just moved.
            await refreshTree();
            const at = await locateState(result.stateId, result.layer);
            // The draft follows it too. Renaming a state is usually part of the same piece of work
            // as editing it, so this is one action, not a reason to lose the other half of it.
            if (from !== null) {
              const to = at === null ? null : docKey(at.layer, at.path);
              patch({ drafts: movedDraft(ref.current.drafts, docKey(from.layer, from.path), to) });
            }
            if (ref.current.stateId === request.stateId || request.copy === true) {
              patch({ stateId: result.stateId, inspect: "path" });
              await Promise.all([refreshState(result.stateId), refreshDoc(at?.layer ?? null, at?.path ?? null)]);
            } else {
              await refreshState(ref.current.stateId);
            }
          }
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /**
       * Delete copies of built-in states that JaiRA itself wrote (decision 0006) — after a person
       * said yes to a dialog naming each file. Main re-checks every one against the disk, so a copy
       * edited since the dialog opened is left alone; what comes back is what actually went.
       */
      cleanupBuiltIn: async (stateIds: string[]): Promise<BuiltInLeftover[]> => {
        patch({ busy: true, error: null });
        try {
          const gone = await invoke("builtin:cleanup", { stateIds });
          patch({ busy: false });
          // The open document may have been one of them: re-read it where it now resolves from.
          const open = ref.current.doc;
          if (open !== null && gone.some((left) => left.layer === open.layer && left.stateId === open.stateId)) {
            actionsRef.current.selectState(open.stateId ?? null);
          }
          await Promise.all([refreshTree(), refreshDebugFiles(), refreshWorkflows()]);
          return gone;
        } catch (e) {
          fail(e);
          return [];
        }
      },

      /** Delete a state file. Refused while anything references it, unless `force`. */
      deleteWorkflow: async (
        stateId: string,
        layer: WorkflowLayer,
        force?: boolean,
      ): Promise<WorkflowMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          const at = await locateState(stateId, layer);
          const result = await invoke("workflow:delete", { stateId, layer, ...(force === true ? { force } : {}), ...inLayer(layer) });
          patch({ busy: false });
          if (result.applied) {
            const wasOpen = ref.current.stateId === stateId;
            if (at !== null) patch({ drafts: withoutDraftsUnder(ref.current.drafts, at.layer, at.path) });
            await refreshTree();
            if (wasOpen) {
              patch({ stateId: null, state: null, inspect: "path", doc: null });
            } else {
              await refreshState(ref.current.stateId);
            }
          }
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /**
       * Rename or move a file or directory, addressed by path.
       *
       * Returns the result for the same reason {@link moveWorkflow} does: a refusal names the
       * states that would break, and only the caller can decide whether to ask and retry.
       */
      renameFile: async (
        layer: WorkflowLayer,
        path: string,
        to: string,
        force?: boolean,
      ): Promise<FileMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          const result = await invoke("file:rename", { layer, path, to, ...(force === true ? { force } : {}), ...inLayer(layer) });
          patch({ busy: false });
          if (result.applied) await afterFileChange(result, { layer, path, to });
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /** Delete a file or directory. A directory takes every state inside it. */
      deleteFile: async (layer: WorkflowLayer, path: string, force?: boolean): Promise<FileMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          const result = await invoke("file:delete", { layer, path, ...(force === true ? { force } : {}), ...inLayer(layer) });
          patch({ busy: false });
          if (result.applied) await afterFileChange(result, { layer, path });
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /**
       * Check a draft against a schema.
       *
       * Returns null on failure rather than raising a toast: the editor is being typed into, and an
       * error banner over every transiently-bad state would be its own kind of noise. The status
       * chip going quiet is the report.
       */
      validateSchema: async (schemaId: string, text: string) => {
        try {
          return await invoke("schema:validate", { schemaId, text });
        } catch {
          return null;
        }
      },

      /**
       * What a set of states declare as inputs, for the children table's wiring rows.
       *
       * Null on failure, and quietly, for the same reason `validateSchema` is: this is asked while a
       * child's `state` field is being TYPED, so most calls name something that does not exist yet.
       * A toast per keystroke would report the author's own typing back at them.
       */
      stateSlots: async (stateIds: string[]) => {
        if (stateIds.length === 0) return {};
        try {
          return await invoke("state:slots", { stateIds, ...inLayer("project") });
        } catch {
          return null;
        }
      },

      /**
       * Turn word wrap on or off in the JSON editor.
       *
       * Written through to `user-settings.json` like the theme is, so the choice outlives the window. The
       * local patch lands first: waiting for the round-trip would make the toggle feel like it had
       * not registered, and a failed write leaves the setting where the file says it is on next read.
       *
       * It lands in `editors.json.wrap`, which is where the Appearance pane's own wrap switch reads
       * from — so the toggle above the editor and the one in settings are the same setting rather
       * than two that disagree the moment either is used. See {@link setEditorLook}.
       */
      setWrapJson: (wrap: boolean) => {
        void actions.setEditorLook("json", { wrap });
      },

      /**
       * Change how one editing surface looks — see {@link EditorLook}.
       *
       * Patched locally first and written after, exactly like {@link setAppearance}: a switch that
       * waited for a round trip before the editor moved would read as a switch that had not
       * registered. Written WHOLE, for the reason every named block in that file is — `writeSettings`
       * merges one level deep, so a partial `editors` would delete the three surfaces it omitted.
       */
      setEditorLook: async (kind: EditorKind, patchTo: Partial<EditorLook>) => {
        const editors = { ...ref.current.settings.editors, [kind]: { ...ref.current.settings.editors[kind], ...patchTo } };
        patch({ settings: { ...ref.current.settings, editors } });
        try {
          patch({ settings: keepingUi(await invoke("settings:write", { editors })) });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Say something about how a file type is drawn — see `fileTypes.ts`.
       *
       * A PATCH rather than a value, because one key now holds four separate statements: the reading,
       * the editor, what the menu offers, and the palette each view is painted in. A caller changing
       * the reading must not have to restate the other three, and one that did would silently undo
       * whatever it had not thought about.
       *
       * `null` in a field, and `null` for the whole patch, both mean UNSAID rather than "store the
       * default's id" — the same rule the typography follows. A key that ends up saying nothing is
       * deleted rather than left behind as an empty object, so what is not chosen stays unwritten and
       * the app's own default keeps reaching everybody who never expressed an opinion, including when
       * that default changes.
       */
      setRenderer: async (edits: readonly RendererEdit[]) => {
        const renderers = { ...ref.current.settings.renderers };
        for (const { key, edit } of edits) {
          if (edit === null) {
            delete renderers[key];
            continue;
          }
          const was = renderers[key] ?? defaultRendererChoice();
          const next: RendererChoice = {
            read: edit.read === undefined ? was.read : edit.read,
            write: edit.write === undefined ? was.write : edit.write,
            off: edit.off === undefined ? was.off : [...new Set(edit.off)],
            theme: {
              read: edit.theme?.read === undefined ? was.theme.read : edit.theme.read,
              write: edit.theme?.write === undefined ? was.theme.write : edit.theme.write,
            },
          };
          const says =
            next.read !== null || next.write !== null || next.off.length > 0 || next.theme.read !== null || next.theme.write !== null;
          if (says) renderers[key] = next;
          else delete renderers[key];
        }
        patch({ settings: { ...ref.current.settings, renderers } });
        try {
          patch({ settings: keepingUi(await invoke("settings:write", { renderers })) });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Change the typography (SHELL.md §6).
       *
       * Patched LOCALLY first and written after, like the theme: dragging a size slider must move
       * the window as it moves, and a round-trip per pixel would make it feel like it was resisting.
       * The write is whole rather than a delta, because appearance is one setting made of seven
       * fields and `writeSettings` merges only one level deep.
       */
      setAppearance: async (patchTo: Partial<Appearance>) => {
        const appearance = { ...ref.current.settings.appearance, ...patchTo };
        patch({ settings: { ...ref.current.settings, appearance } });
        try {
          patch({ settings: keepingUi(await invoke("settings:write", { appearance })) });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * How a conversation is drawn — the Conversation section of Settings. Patched locally first
       * and written whole, like the typography and for the same reason.
       */
      setConversation: async (patchTo: Partial<ConversationLook>) => {
        const conversation = { ...ref.current.settings.conversation, ...patchTo };
        patch({ settings: { ...ref.current.settings, conversation } });
        try {
          patch({ settings: keepingUi(await invoke("settings:write", { conversation })) });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * What the app keeps in its log — the Configure panel in the Logs page.
       *
       * Patched locally first like every other preference, so a control moves on the click. Written
       * WHOLE, because `writeSettings` merges one level deep and a partial policy would be a policy
       * with no rules; main re-installs it on the write, so the next entry is already gated by it.
       */
      setLogPolicy: async (logging: LogPolicy) => {
        patch({ settings: { ...ref.current.settings, logging } });
        try {
          patch({ settings: keepingUi(await invoke("settings:write", { logging })) });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * This person's own additions to what the tree hides.
       *
       * Written whole, like appearance and for the same reason — `writeSettings` merges one level
       * deep, so a partial list would be the whole list. Patched locally first so a row disappears
       * on the click rather than on the round-trip.
       */
      setFilesHidden: async (filesHidden: string[]) => {
        patch({ settings: { ...ref.current.settings, filesHidden } });
        try {
          patch({ settings: keepingUi(await invoke("settings:write", { filesHidden })) });
        } catch (e) {
          fail(e);
        }
        // The tree is drawn in main from these rules, so it has to be re-read: nothing else in the
        // settings file changes what `files:tree` answers, which is why no existing write does this.
        await refreshTree();
      },

      // --- the Debug view's self-test (DESIGN §11.3) --------------------------

      /** Re-read which copy of each self-test state loads — what the pane's status rows report. */
      debugRefresh: () => {
        void refreshDebugFiles();
      },

      /**
       * Run the self-test, in JaiRA's own project.
       *
       * It always belonged there and said otherwise. The self-test is a fact about the INSTALLATION
       * — its states ship with the app (decision 0006), and used to be written to the shared root
       * for the same reason — and yet the run was recorded in the focused project, which put JaiRA's
       * own runs on the user's board and, with no project open, refused with "Open a project first".
       * That refusal was the wrong half of the contradiction to resolve: an empty window is exactly
       * where someone reaches for a self-test, because it is what you press when nothing else is
       * working yet.
       *
       * Same rule as everything else that lives in the shared root — see `runTargetOf`.
       *
       * `scripted` swaps the LLM for the canned replies in `selfTestScript()`. It is the FIRST thing
       * to try when a live run fails: everything but the provider is identical, so a scripted run
       * that passes and a live one that does not is a provider problem, and a scripted run that
       * fails is a JaiRA problem. That distinction is the whole reason this pane exists.
       *
       * `fresh` makes a new task instead of adding a run to the last one. Both are useful and they
       * are different questions — "does it work now" versus "what changed since the last run" — so
       * the pane offers both rather than guessing.
       */
      debugRun: async (options: { scripted?: boolean; fresh?: boolean } = {}) => {
        patchDebug({ busy: true, error: null });
        try {
          // Nothing to install: the states ship. Re-read which copies load, so the rows above the
          // button are true of the run that is about to start.
          await refreshDebugFiles();

          const reuse = options.fresh === true ? null : ref.current.debug.taskId;
          const taskId =
            reuse ??
            (
              await invoke("task:create", {
                title: options.scripted === true ? "Self-test (scripted)" : "Self-test (live)",
                workflow: SELF_TEST_ROOT,
                labels: ["debug"],
                project: SHARED_SESSION,
              })
            ).taskId;

          // Selected before it is started, so every panel this view borrows — the instance tree, the
          // conversation, the live event stream — is already pointed at the run when its first event
          // arrives. Selecting afterwards means watching the beginning in the past tense.
          patchDebug({ taskId });
          patch({ selected: taskId, selectedProject: SHARED_SESSION, stream: [], inspect: "path" });
          await Promise.all([
            refreshSharedTasks(),
            refreshBoard(),
            refreshDetail(taskId, SHARED_SESSION),
            refreshConversation(taskId, SHARED_SESSION),
          ]);

          await actionsRef.current.startTaskAsking({
            taskId,
            project: SHARED_SESSION,
            ...(options.scripted === true ? { fake: selfTestScript() } : {}),
          });
          patchDebug({ busy: false });
        } catch (e) {
          patchDebug({ busy: false, error: (e as Error).message });
        }
      },

      /** Stop a self-test that is running — the same cancel the task panel offers. */
      debugCancel: async () => {
        const taskId = ref.current.debug.taskId;
        if (taskId === null) return;
        try {
          await invoke("task:cancel", { taskId, project: SHARED_SESSION });
        } catch (e) {
          patchDebug({ busy: false, error: (e as Error).message });
        }
      },

      /** Clear the pane's own error line. */
      debugDismissError: () => patchDebug({ error: null }),

      /**
       * Remember which schema a document is being held to.
       *
       * `null` is recorded as `""` rather than by deleting the entry, because ABSENT and NONE are
       * now different answers: absent means nobody has decided yet, and that is what lets a file be
       * detected when it opens. Deleting the key would make "plain JSON, I chose that" indis-
       * tinguishable from "not looked at", and the detector would overrule the choice on every
       * re-render.
       */
      setSchemaChoice: (key: string, schemaId: string | null) =>
        patch({ schemaChoice: { ...ref.current.schemaChoice, [key]: schemaId ?? "" } }),

      /**
       * Hold — or forget — one file's unsaved text.
       *
       * `null` is "there is no draft", which is what both Revert and typing the file back to what it
       * says mean. The map holds differences only, so this is also what un-marks the row in the tree.
       */
      setDraft: (key: string, text: string | null) => patch({ drafts: withDraft(ref.current.drafts, key, text) }),

      /**
       * Read one state's file WITHOUT opening it.
       *
       * What the graph's side panel shows about a child: the box draws a mount, and the thing an
       * author wants to see when they click it is the state that mount runs — its slots, its
       * operation, its own children — which lives in another file entirely. Opening that file is the
       * other gesture (double-click); this one leaves the address exactly where it is.
       *
       * `null` for anything that cannot be resolved, because a panel that cannot find a state has
       * something to say ("nothing here defines it") and an exception has not.
       */
      readState: async (stateId: string): Promise<WorkflowSource | null> => {
        const at = await locateState(stateId);
        if (at === null) return null;
        try {
          return await invoke("workflow:read", { stateId, layer: at.layer, ...inLayer(at.layer) });
        } catch {
          return null;
        }
      },

      /**
       * Read any file in either layer, as text, without opening it.
       *
       * What a LINKED property's preview shows: a reference moves the substance of a field into
       * another file, and the form would otherwise show a path where six lines of prompt used to be.
       * `null` for anything unreadable, because a preview is never worth an error — the linter is
       * what reports a reference that resolves to nothing.
       */
      readFile: async (layer: WorkflowLayer, path: string): Promise<string | null> => {
        try {
          return (await invoke("file:read", { layer, path, ...inLayer(layer) })).text;
        } catch {
          return null;
        }
      },

      /**
       * Save a state that is not the open file — the panel's editor, and only it.
       *
       * Through `workflow:write` like every other state write, so the same parse and the same re-lint
       * happen: a file edited in a side panel is not a lesser file. The tree and the open state are
       * refreshed afterwards because this may well have been the state the middle column is showing
       * a board of.
       */
      saveState: async (source: WorkflowSource, text: string) => {
        patch({ busy: true, error: null });
        try {
          await invoke("workflow:write", {
            stateId: source.stateId,
            layer: source.layer,
            text,
            ...inLayer(source.layer),
          });
          patch({ busy: false });
          await Promise.all([refreshTree(), refreshState(ref.current.stateId)]);
        } catch (e) {
          fail(e);
        }
      },

      /** Remember which tab a state file's editor is on, so returning to the file returns to it. */
      setEditorTab: (key: string, tab: EditorTab) =>
        patch({ editorTab: { ...ref.current.editorTab, [key]: tab }, editorTabLast: tab }),

      /** Hold a state's run form, whole. See {@link AppState.runValues} on why it is not a per-box overlay. */
      setRunValues: (stateId: string, values: Record<string, JsonValue>) =>
        patch({ runValues: { ...ref.current.runValues, [stateId]: values } }),

      /**
       * Start a run of the open state, from the Files view's inspector.
       *
       * Create then start, as one act — the two calls are an implementation detail of `task:create`
       * returning before anything executes, not a decision anyone wants to make twice.
       *
       * The new task is SELECTED before it is started, for the reason the self-test does the same:
       * the panels that follow a run — the leaf conversation, the event stream, the task inspector —
       * have to be pointed at it before its first event arrives, or the beginning is only readable
       * afterwards, in the journal.
       *
       * `inspect` deliberately stays on the state. The run was started from the state's own panel and
       * its history row is right there; flipping the column to the task inspector would take away the
       * form the moment it was used, which is precisely wrong when the next thing anyone does is run
       * it again with one input changed.
       */
      runState: async (stateId: string, title: string, inputs: Record<string, JsonValue>, project?: string) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          const at = project ?? ref.current.at ?? undefined;
          const summary = await invoke("task:create", {
            title,
            workflow: stateId,
            ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
            ...(project !== undefined ? { project } : {}),
          });
          patch({ busy: false, selected: summary.taskId, selectedProject: at ?? null });
          await Promise.all([
            // Whichever list the run landed in. A shared workflow's run is in JaiRA's own project and
            // would not appear in the checkout's — which is the list the history section reads for a
            // base-layer file.
            project === undefined ? refreshTasks() : refreshSharedTasks(),
            refreshBoard(),
            // So the run appears in the history section it was started from, now rather than at the
            // first push.
            refreshState(stateId),
            refreshDetail(summary.taskId, at),
            refreshConversation(summary.taskId, at),
          ]);
          await actionsRef.current.startTaskAsking({ taskId: summary.taskId, ...(project !== undefined ? { project } : {}) });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Start a task, and ASK rather than only reporting when the js/ts module gate stops it.
       *
       * Every `task:start` in this store goes through here. The gate refuses before the workflow is
       * validated, snapshotted or frozen, so nothing has happened when the question is raised and a
       * second attempt after the answer is an ordinary first start rather than a resume.
       *
       * The pending list is FETCHED rather than read off the rejection: an Electron IPC error carries
       * its message and nothing else, so the service keeps the list and `functions:pending` hands it
       * back. When it comes back empty the failure was something else, and the error stands as it is.
       */
      startTaskAsking: async (request: StartTaskRequest): Promise<void> => {
        try {
          await invoke("task:start", request);
        } catch (e) {
          // The WHOLE request is kept, not just the task id: a retry that dropped `fake` or
          // `overrides` would start a different run than the one the person asked for.
          const files = await invoke("functions:pending", {
            taskId: request.taskId,
            ...(request.project !== undefined ? { project: request.project } : {}),
          }).catch(() => [] as ModuleApproval[]);
          if (files.length === 0) throw e;
          patch({ moduleApproval: { request, files }, busy: false });
        }
      },

      /** Dismiss the module-approval prompt without approving. Nothing has run, so there is nothing to undo. */
      dismissModuleApproval: () => patch({ moduleApproval: null }),

      /**
       * Approve the files this task stopped on, then start it again.
       *
       * The approval is written by the MAIN process, which re-reads and re-hashes each file beside
       * the write — a file that changed between the prompt and this click must not be approved as
       * what was shown. The retry then goes back through {@link startTaskAsking}, so a second
       * unapproved file behind the first raises a second prompt rather than a bare failure.
       */
      approveModulesAndStart: async () => {
        const stopped = ref.current.moduleApproval;
        if (stopped === null) return;
        patch({ moduleApproval: null, busy: true });
        try {
          await invoke("functions:approve", {
            files: stopped.files.map((f) => f.file),
            ...(stopped.request.project !== undefined ? { project: stopped.request.project } : {}),
          });
          await actionsRef.current.startTaskAsking(stopped.request);
          patch({ busy: false });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Which schema a document already satisfies, for the picker's initial value.
       *
       * Quiet on failure like the other editor-side calls: this runs as a file opens, and the answer
       * is a suggestion. Failing to guess is not something to interrupt anyone about.
       */
      detectSchema: async (text: string) => {
        try {
          return await invoke("schema:detect", { text });
        } catch {
          return null;
        }
      },

      /** Show a file in the OS file manager. */
      revealFile: async (file: string) => {
        try {
          await invoke("shell:reveal", { file });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Save the open file, by whichever channel its type requires.
       *
       * The surface that called this does not choose — see `FileSurfaceProps.onSave`. A state file
       * goes through `workflow:write`, which parses it and re-lints the browser; everything else
       * goes through `file:write`, which does not, because a half-written markdown prompt must be
       * saveable and a half-written state file must not break every workflow in the layer.
       */
      saveDoc: async (text: string) => {
        const doc = ref.current.doc;
        if (doc === null) return;
        patch({ busy: true, error: null });
        try {
          if (doc.stateId !== undefined && doc.mime === WORKFLOW_JSON) {
            await invoke("workflow:write", { stateId: doc.stateId, layer: doc.layer, text, ...inLayer(doc.layer, doc.project) });
          } else {
            await invoke("file:write", { layer: doc.layer, path: doc.path, text, ...inLayer(doc.layer, doc.project) });
          }
          patch({ busy: false });
          await Promise.all([
            refreshTree(),
            refreshState(doc.stateId ?? null),
            refreshDoc(doc.layer, doc.path),
          ]);
          // After the re-read, not before it: the draft is what the editor is showing, and clearing
          // it while the old contents were still in `doc` would flash the pre-save text on screen.
          // `refreshDoc` usually drops it already — this covers a write that came back normalised,
          // where the file no longer matches the draft byte for byte but the save did happen.
          patch({ drafts: withDraft(ref.current.drafts, docKey(doc.layer, doc.path), null) });
        } catch (e) {
          fail(e);
        }
      },
    }),
    [
      patch,
      patchDebug,
      setUi,
      keepingUi,
      fail,
      refreshAll,
      refreshTasks,
      refreshBoard,
      refreshDetail,
      refreshConfig,
      refreshTree,
      refreshState,
      refreshDoc,
      loadSession,
      loadSessions,
      locateState,
      owningProject,
      projectOfTask,
      taskClock,
      refreshConversation,
      refreshSession,
      refreshSharedTasks,
      refreshAllConversations,
      focusStateRun,
      refreshDebugFiles,
      afterFileChange,
      refreshTrailState,
      seedTrail,
      refreshWorkflowForm,
      refreshWorkflows,
      refreshTaskState,
    ],
  );

  // Actions that call sibling actions read them through here, so the memo above does not have to
  // depend on itself.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  return { state, actions };
}
