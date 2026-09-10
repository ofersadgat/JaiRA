/**
 * The surface registry: `(MIME type, action) → component`.
 *
 * The Files view shows an open file as two halves — what it *is* on top, what it *says* below — and
 * until now both halves were hardwired to one file type. The middle panel rendered a board and a
 * workflow form because the only thing it could open was a state; a prompt was a row in the tree
 * that did nothing when you clicked it.
 *
 * This is the indirection that fixes that. A type registers what should render it, the panel looks
 * the pair up, and adding markdown preview means adding a registration rather than another branch in
 * a component that already knows about workflows. The three concepts stay separate on purpose:
 *
 *  - **type** — a MIME string from `mimeOfPath`, carried on every tree node.
 *  - **kind** — `text`, `data` or `preview`: WHAT SORT of rendering this is (see {@link RenderKind}).
 *  - **renderer** — a NAMED way of drawing a type in one of those kinds: an id, a label and a
 *    component. A kind may have several, and the first registered is what draws it when nobody has
 *    said otherwise.
 *  - **component** — a {@link FileSurface}, which is a plain React component over one props shape.
 *
 * The kind is the newest of the four and it replaced the wrong axis. The table used to be keyed by
 * `view` and `edit` — which are not kinds of rendering but PLACES, the panel's two halves — and that
 * conflation made both this file and the settings screen say untrue things. It made the JSON data
 * tree and the JSON editor look like alternatives to each other, when they answer different
 * questions and a person wants both at once; and it had no room at all for the fact that a `.json`
 * file has a text rendering too, which is drawn by Monaco exactly like every other source file.
 *
 * A renderer says what it IS and whether it writes; where it goes follows. What has NOT changed is
 * the default: every built-in leads its own list, so an app nobody has configured draws exactly what
 * it drew before.
 *
 * Two rules make the table small. Resolution walks `mimeFallbacks`, so a vendor type inherits the
 * surfaces of the syntax it is written in and every text type ends at `text/plain` — which is why an
 * unregistered file still opens in an editor instead of showing an error. And `view` is genuinely
 * optional: a type with no viewer gives its editor the whole panel, because a plain text file has
 * nothing to render that its own contents do not already show.
 */
import type { JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import type {
  Changeset,
  ConfigLayer,
  DetectSchemaResult,
  ConfigView,
  ConversationView,
  InstanceNode,
  PendingUserEvent,
  OperationRecordView,
  SessionRef,
  SessionView,
  ExecutorInfo,
  FileSource,
  FileTree,
  StateSlots,
  StateView,
  TaskDetail,
  SyncDirection,
  ValidateSchemaResult,
  WorkflowLayer,
  WorkflowSource,
  WorkflowSyncEdit,
  WorkflowSyncResult,
  WorkflowSyncStatus,
  WritingTool,
  PendingInteraction,
  PendingQuestion,
  ApprovalScope,
  PendingApproval,
} from "@jaira/shared/browser";
import { defaultRendererChoice, mimeFallbacks, paneFamilyOf } from "@jaira/shared/browser";
import type { EditorKind, PaneFamily, RendererChoice, RendererChoices, RenderView } from "@jaira/shared/browser";
import type { ComponentServices } from "./changesetReview";
import type { EditorServices } from "./components";
import type { Drafts, SetDraft } from "./drafts";
import type { EditorTab } from "./editorChrome";
import type { TrailStep } from "./trail";

/**
 * Which half of the panel a rendering lands in — DERIVED, never declared.
 *
 * Kept as a name because the panel's two halves are still two halves; what changed is that nothing
 * registers itself into one. A renderer says what KIND of rendering it is (see {@link RenderKind})
 * and whether it writes, and `viewerFor` / `editorFor` work out where that puts it.
 */
export type FileAction = "view" | "edit";

/**
 * Keeping a description and the state files in step — what the description's viewer needs.
 *
 * Its own bag rather than five more fields on the context, because it is the whole surface of one
 * feature and exactly one surface uses it. Optional for the same reason the draft store is: a panel
 * rendered without it degrades to a markdown preview, which is what the file was before.
 *
 * Nothing here writes to disk. {@link SyncSurface.run} produces a proposal, and the store turns it
 * into drafts — see `syncPanel.tsx`.
 */
export interface SyncSurface {
  /** Which side has moved since the two last agreed. Null until the first answer arrives. */
  status: WorkflowSyncStatus | null;
  /** The last proposal, with the findings behind it. Cleared when another file is opened. */
  result: WorkflowSyncResult | null;
  running: boolean;
  error: string | null;
  /** What the run is doing while it does it — see `SyncState.progress`. */
  progress: string[];
  /**
   * Ask for the status of one document.
   *
   * Takes the document's address rather than reading the open file, so the panel can ask on mount
   * without the store having to guess which file the question is about. Unsaved edits are added by
   * the panel (`syncState.driftOf`) rather than sent here — otherwise this would fire per keystroke.
   */
  refresh: (layer: WorkflowLayer, path: string) => void;
  /** Run the sync. The draft, not the saved file, is what gets synced. */
  run: (direction: SyncDirection) => void;
  cancel: () => void;
  /** Open a proposed state file, so a listed edit is one click from being read. */
  openEdit?: (edit: WorkflowSyncEdit) => void;
  /**
   * Open another description — the one that owns a delegated subtree.
   *
   * The whole point of naming the owner is that it tells you where to go next, and a name you then
   * have to find in the tree is a name that mostly does not get followed.
   */
  openDocument?: (layer: WorkflowLayer, path: string) => void;
  /**
   * Walk the sync's proposals through the changeset gate (CHANGESETS.md) instead of the drafts
   * map: same reviewer as a worktree review, in rounds — a comment sends the changeset back to a
   * model for revision — merged decisions applied, the baseline moved when the final round merged
   * everything. The reviewer arrives as a pending interaction moments after this returns.
   *
   * `parentTaskId` is the sync run the changeset came from (`WorkflowSyncResult.taskId`), so the
   * review is recorded as a round of that sync rather than a workflow of its own.
   */
  reviewChangeset?: (layer: WorkflowLayer, path: string, changeset: Changeset, parentTaskId?: string) => void;
}

/**
 * The window's remembered layout, as a surface sees it — see `uiState.ts`.
 *
 * Getters that take their own fallback, rather than a value plus a default table. A surface knows
 * what its pane opens at and the store does not, so the store is not the place to keep that number;
 * this way a new pane in a new surface needs nothing here at all.
 */
export interface UiSurface {
  /** The remembered size of a named pane, in px, or `fallback` when nothing has been dragged. */
  pane: (id: string, fallback: number) => number;
  setPane: (id: string, size: number) => void;
  /** Whether a named disclosure is open, or `fallback` when nothing has been remembered. */
  open: (id: string, fallback: boolean) => boolean;
  setOpen: (id: string, open: boolean) => void;
}

/**
 * Everything a surface may need beyond the file itself.
 *
 * One bag rather than per-type props, and that is a deliberate trade. A workflow's viewer needs the
 * board, the running tasks and the conversation; its editor needs the tree and the executor list to
 * complete names against; the config editor needs both layers merged. None of that can be expressed
 * in a props shape the registry knows, so the registry passes the union and each surface takes the
 * two or three fields it actually reads. The alternative — a generic parameter threaded through the
 * table — buys type safety the caller cannot use, because the panel does not know at compile time
 * which component it is about to render.
 */
export interface FileSurfaceContext {
  /** The state this file defines, when it defines one. Null for everything else. */
  state: StateView | null;
  /** Both configuration layers plus the merged result — what the config surfaces read. */
  config: ConfigView | null;
  /** Both layer roots, for name completion in the workflow editor. */
  tree: FileTree | null;
  executors: ExecutorInfo[];
  /** The selected task, and its conversation — what a leaf state's viewer shows. */
  /**
   * Which project the selected task lives in — the scope every task-scoped channel needs.
   *
   * Absent ⇒ the focused one. A channel called WITHOUT it answers `no project is open` whenever the
   * task belongs to the shared or system project, and those are reached routinely: the focus never
   * points at either. The same omission blanked the conversation panel mid-read once already.
   */
  project?: string | undefined;
  selected: string | null;
  conversation: ConversationView | null;
  /**
   * The selected task's instance tree — every state it entered, in the shape it entered them.
   *
   * What the composite views are built from. A board column holds one card per EXECUTION rather
   * than one per task, and an execution is an instance: the state id and the child key are the same
   * on every pass through a loop, and only the instance tells them apart.
   */
  detail: TaskDetail | null;
  /** Transcripts by instance id, and how to fetch one — see `sessionKey`. */
  sessions: Record<string, SessionView>;
  onLoadSession: (instanceId: string) => void;
  /**
   * Fetch SEVERAL, in one round.
   *
   * Beside the single fetch rather than replacing it: one card being expanded is still one
   * transcript. What needs this is the session-panelled conversation, which opens every panel it
   * draws and so wants every transcript in the subtree at once — as one patch, because eight separate
   * ones re-render the whole conversation eight times while it is still assembling itself.
   */
  onLoadSessions: (at: ReadonlyArray<{ instanceId: string }>) => void;
  /** Every state that task went through, and the transcript of the one being looked at. */
  sessionHistory: SessionRef[];
  /**
   * What each call the task made actually ran, by operation id — the store's `records`.
   *
   * Joined against `InstanceNode.calls`, which is how a state that computed its outputs by calling
   * functions gets to say WHICH functions, with what, and what they answered.
   */
  records: Record<string, OperationRecordView>;
  session: SessionView | null;
  sessionInstance: string | null;
  /** The answer being written right now, when there is one — text and thinking tails, every stream item. */
  liveTurn: {
    sessionId?: string;
    seq?: number;
    stateId?: string;
    text: string;
    thinking: string;
    /** When each tail began — what the live "thought for 12 s" counter measures from. */
    textStartedAt?: number;
    thinkingStartedAt?: number;
    entries: JsonValue[];
    /** Subagent turns streaming by, keyed by the spawning call — see `AppState.liveTurn`. */
    sidechains: Record<string, JsonValue[]>;
    /** The tool call whose arguments are still streaming — see `WritingTool`. */
    writing?: WritingTool;
  } | null;
  onShowSession: (instanceId: string | null) => void;
  waiting?: { component: string } | undefined;
  /**
   * Transitions parked on a gesture, across every project — `on_user_event` (WORKFLOWS.md §7.4).
   *
   * The whole list rather than this task's, because that is what the hub publishes and filtering is
   * the reader's job: the board wants all of them to light its columns, and a conversation wants the
   * ones belonging to the task it is drawing.
   *
   * A wait is NOT an instance, which is why it arrives here instead of on the instance tree. It sits
   * between states — the guard of a transition evaluated `on_user_event(...)` and stopped — so there
   * is no node to hang it off and no operation to read a status from. `projection.ts` does set
   * `waiting_for_user` on the instance, but it sets the same value for an interactive OPERATION, so
   * the two are indistinguishable once projected; the request is what tells them apart.
   */
  /**
   * Which states in a run's conversation are folded, and how to fold one.
   *
   * Remembered rather than held per panel, because a fold is a statement about what you are done
   * reading and navigating away is not a retraction of it. `JairaUiState.shut` already stores this
   * shape — a list of keys per tree id — so this is a place that exists rather than a new one.
   */
  shutStates: ReadonlySet<string>;
  onToggleShutState: (key: string) => void;
  /** Fold or unfold SEVERAL at once — what the gutter's collapse-all spends. */
  onSetShutStates: (keys: readonly string[], shut: boolean) => void;
  userEvents: PendingUserEvent[];
  /**
   * Satisfy one, without the gesture it was waiting for.
   *
   * The drag on the board is the gesture the workflow author had in mind, and it stays. This is the
   * same delivery from the surface where the run is being READ — the person is already looking at
   * the state that stopped, and sending them to another view to move a card is asking them to
   * remember which column it wanted.
   */
  onDeliverUserEvent: (requestId: string) => void;
  onSelectTask: (taskId: string) => void;
  onDrill: (stateId: string) => void;
  /**
   * The runs walked into below this file, and the two moves that change them.
   *
   * The address bar and the viewer read the same list: the bar draws it, and the viewer shows its
   * LAST element. That is the whole contract — everything else about which board or which transcript
   * appears follows from which step is on the end.
   *
   * Optional so a surface can be rendered outside the shell; absent behaves as an empty trail, which
   * is the state's own view.
   */
  trail?: readonly TrailStep[] | undefined;
  /** The tail's declared children, when the tail is deeper than this file — see `AppState.trailState`. */
  trailState?: StateView | null | undefined;
  /** Walk into a run: append it to the path and show it. */
  onWalkInto?: ((node: InstanceNode) => void) | undefined;
  /**
   * Walk into a SUBAGENT CONVERSATION: append a sidechain step to the path and show it.
   *
   * `node` is the HOST — the run whose session holds the chain under `call`; `name` is what the
   * crumb will read. See `TrailStep.sidechain` for why the step names the host rather than a run.
   */
  onWalkIntoSidechain?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
  /**
   * Describe the WORKFLOW a conversation was opened by, with that run's own values against it.
   *
   * What the link in a session panel's gutter does. The subject is a state and the scope is one
   * execution of it, which is why both travel: the panel it lands in is the state inspector, and
   * `instanceId` is what fills its run form with what this pass was actually called with instead of
   * with the slots' defaults.
   *
   * Optional, like every other navigation on this bag — a surface rendered outside the shell has no
   * column to describe anything in, and the gutter then shows the session id alone.
   */
  onOpenWorkflow?: ((stateId: string, instanceId: string) => void) | undefined;
  /**
   * Walk SIDEWAYS: replace the path from `index` down with this run.
   *
   * What a chevron's menu does — picking a sibling of a level you are already standing on is not a
   * step deeper, and appending it would claim a descent that did not happen.
   */
  onWalkTo?: ((index: number, node: InstanceNode) => void) | undefined;
  /** Open any file by its address — what the chevrons above a document that is not a state offer. */
  onOpenFile?: ((layer: WorkflowLayer, path: string) => void) | undefined;
  /** Show a DIRECTORY's contents — what makes the address bar's folder crumbs lead anywhere. */
  onOpenDir?: ((layer: WorkflowLayer, path: string) => void) | undefined;
  /**
   * Choose another project.
   *
   * The last entry under the root crumb's chevron, and the only navigation in that bar that is not
   * already on disk: every other place it can go is a path under a root this window has open.
   */
  onOpenProject?: (() => void) | undefined;
  /**
   * Which reading of a composite is on screen — its board, or its conversation.
   *
   * Here rather than inside the viewer because the control that switches it is in the panel's top
   * bar, and the bar and the viewer are siblings. Optional, and the viewer falls back to its own
   * state: a surface rendered outside the shell still toggles, it just has no bar to do it from.
   */
  runMode?: "board" | "conversation" | undefined;
  onRunMode?: ((mode: "board" | "conversation") => void) | undefined;
  /**
   * A bookmark for the conversation in the middle column: scroll to this instance's letterhead.
   *
   * Set by the task panel's Instances index when the middle column IS the conversation (`runMode`
   * says so), because that column is the document and the panel's own conversation is not on
   * screen. `at` is a stamp rather than a flag — pressing the same label twice is two asks, and the
   * conversation serves each once (see `SessionBandsView`'s focus effect).
   */
  runFocus?: { instance: string; at: number } | undefined;
  onRunFocus?: ((focus: { instance: string; at: number }) => void) | undefined;
  /**
   * The gate parked on the selected task, for the middle column's conversation to host.
   *
   * The task panel has hosted it since gates moved out of the modal; the middle column, which draws
   * the same conversation when the toggle says Conversation, drew the asking state's INPUTS instead
   * — a value dump of `docs`, `score` and `reasons` where the panel beside it showed the question.
   * Same gate, same answer channel, same services, so the two columns cannot disagree about what is
   * being asked.
   */
  runGate?: PendingInteraction | undefined;
  onRunGate?: ((value: unknown) => void) | undefined;
  runGateServices?: Partial<ComponentServices> | undefined;
  runGateEditor?: EditorServices | undefined;
  /**
   * The question a running agent in this task has asked, hosted in the conversation under the state
   * whose agent asked it — the same place a gate goes, for the same reason: a question is where the
   * task is sitting, and a modal over the whole window is not a place.
   */
  runQuestion?: PendingQuestion | undefined;
  onRunQuestion?: ((answers: Record<string, string | string[]> | undefined) => void) | undefined;
  /** The command approval a running agent in this task is waiting on, hosted the same way. */
  runApproval?: PendingApproval | undefined;
  onRunApproval?: ((decision: "allow" | "deny", scope: ApprovalScope) => void) | undefined;
  onAnswer?: (() => void) | undefined;
  /**
   * Set this run going again — `task:rerun`, and the shell's own action rather than a raw call.
   *
   * It has to be the action because the answer is sometimes a DIFFERENT task: the engine will not
   * re-enter a finished lifecycle, so re-running a completed or canceled one starts a fresh copy and
   * names it. A surface calling the channel directly would leave the window describing the task that
   * did not restart. See `store.ts`'s `rerunTask`, which moves the selection with it.
   *
   * Absent where a surface is drawn outside the shell, which is the honest posture: a specimen or a
   * dialog has nowhere to navigate to, so it offers no button rather than one that goes nowhere.
   */
  onRerun?: ((taskId: string) => void) | undefined;
  /**
   * Pick a stopped task up where it left off, rather than starting it over.
   *
   * Separate from {@link onRerun} rather than a flag on it because they are different promises: this
   * one keeps everything the task already did and never changes the task id, and a surface that
   * offered it where the channel is not wired would say "Resume" and start over. Absent ⇒ the strip
   * offers the restart, with the restart's wording.
   */
  onResume?: ((taskId: string) => void) | undefined;
  /**
   * Delete everything past a point in the task's journal and carry on from there ("task:rewind").
   *
   * `seq` is the journal position of the row the person chose — a state's entry, a transition — and
   * the deletion is confirmed BEFORE this is called: the strip asks, the conversation shows what
   * goes, and this is what pressing the filled button does. Absent ⇒ the verbs are not offered.
   */
  onRewind?: ((taskId: string, seq: number) => void) | undefined;
  /** A second task sharing everything before `seq` ("task:fork"). Starts at once; the shell opens it. */
  onFork?: ((taskId: string, seq: number) => void) | undefined;
  /** Write a configuration layer as a parsed document — validated in main, unlike a raw file write. */
  onSaveConfig: (layer: ConfigLayer, doc: unknown) => void;
  /** Check a draft against a registered schema — what the JSON editor's picker turns on. */
  validateSchema: (schemaId: string, text: string) => Promise<ValidateSchemaResult | null>;
  /**
   * What a set of states declare — how the children table knows which slots a mount has to fill,
   * and what a binding may point at (WORKFLOWS.md §6.1).
   *
   * Asked for rather than carried on the tree: the tree is every file under both roots, and reading
   * each of them to answer a question about the four children of one state would be most of a
   * project's disk for none of its benefit.
   */
  stateSlots: (stateIds: string[]) => Promise<Record<string, StateSlots> | null>;
  /**
   * Read one state's file without opening it, and write one that is not the open file.
   *
   * The pair the graph's side panel needs: clicking a box asks what the state behind it is, and the
   * answer is a document the address bar is not standing on. Optional together — a surface with
   * neither shows the box's own declaration instead, which is what it can prove without asking.
   */
  readState?: ((stateId: string) => Promise<WorkflowSource | null>) | undefined;
  saveState?: ((source: WorkflowSource, text: string) => void) | undefined;
  /** Any file's text, for showing what a LINKED property says — see `linkPreview.tsx`. */
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
  /**
   * The schema chosen per document, keyed by `layer:path`, and how to change one.
   *
   * An ABSENT key means nobody has decided; `""` means "plain JSON" was chosen. The distinction is
   * what lets {@link FileSurfaceContext.detectSchema} fill the picker on open without overruling
   * someone who deliberately turned it off.
   */
  schemaChoice: Record<string, string>;
  onSchemaChoice: (key: string, schemaId: string | null) => void;
  /**
   * Unsaved text per document, keyed the same way, and how to change one — see `drafts.ts`.
   *
   * Passed in rather than held by each surface, and that is the point: an editor is unmounted every
   * time another file is clicked or another view is opened, so a draft it owned would be a draft it
   * silently discarded. `null` clears, which is what Revert and "typed it back" both mean.
   *
   * Optional, and `useDraftBox` is what makes that safe: a surface rendered without a store keeps
   * its draft locally instead of refusing to accept typing. Absent means "no store here", never
   * "this file has no draft" — those are the same value only because an inert store is the same
   * thing as no store.
   */
  drafts?: Drafts | undefined;
  onDraft?: SetDraft | undefined;
  /**
   * Which tab a state file's editor was left on, keyed the same way, and how to change it.
   *
   * The one piece of per-file editor chrome worth remembering: coming back to a state you were
   * hand-editing should not put you on the form. Optional for the same reason as the draft store —
   * the editor falls back to its own state.
   */
  editorTab?: Record<string, EditorTab> | undefined;
  /** What a file nothing is remembered about opens on — see `AppState.editorTabLast`. */
  editorTabLast?: EditorTab | undefined;
  onEditorTab?: ((key: string, tab: EditorTab) => void) | undefined;
  /**
   * The description-vs-workflows machinery, for the one surface that shows it.
   *
   * Absent ⇒ no host for it (a panel rendered outside the shell), and the viewer falls back to the
   * markdown preview rather than offering buttons that would do nothing.
   */
  sync?: SyncSurface | undefined;
  /** Which registered schema a document already satisfies. Null when nothing could be asked. */
  detectSchema: (text: string) => Promise<DetectSchemaResult | null>;
  /** Word wrap in the JSON editor — a saved preference, not per-document (`editors.json.wrap`). */
  wrapJson: boolean;
  onWrapJson: (wrap: boolean) => void;
  /**
   * Which renderer this person has chosen per type and kind — see {@link chosenRenderer}.
   *
   * Carried on the context rather than read from a module, for the reason the draft store and the
   * remembered layout are: a surface, and the panel that resolves one, must work when rendered
   * outside the shell. Absent ⇒ every default, which is what a specimen and a gallery want.
   */
  renderers?: RendererChoices | undefined;
  /**
   * Which of the type's two views this surface is BEING mounted as.
   *
   * A surface cannot work it out: the same component is the reading of one type and the editor of
   * another, and `onSave` says whether it may write rather than which half asked for it. Only the
   * thing that resolved it knows, so the thing that resolved it says.
   *
   * Absent ⇒ the editor, which is what almost every mount is and what everything did before this
   * existed. What reads it is the palette (`RendererChoice.theme`), which is keyed per view: a
   * reading drawn in the editor's colours is the bug this field is here to stop.
   */
  view?: RenderView | undefined;
  /**
   * The window's remembered layout, for surfaces that have a pane or a fold of their own.
   *
   * Four functions rather than the state itself, and that is what keeps the coupling one-way: a
   * surface asks for the size of a named pane and reports a new one, and never learns that the
   * answer is stored in `user-settings.json` or what else is in there beside it.
   *
   * Optional, like the draft store and for the same reason — a surface rendered outside the shell
   * (the settings panes do this) still has to work, and falls back to its own state.
   */
  ui?: UiSurface | undefined;
  /**
   * The diagnostic the inspector last asked to be SHOWN, as a lint path (`outputs.report`).
   *
   * The inspector lists the issues and the editor holds the controls, and they are two columns
   * apart; this is the one thing they have to agree on. `nonce` rises on every click so that asking
   * for the same path twice flashes it twice — without it, clicking an issue you have already
   * visited would do nothing at all, which reads as a broken link rather than as "you are here".
   */
  revealIssue?: { path: string; nonce: number } | null;
  /**
   * Take the window to a definition — what "Go to Definition" does when the answer is another file.
   *
   * Held by the app rather than by the editor because it is navigation: the file has to be opened,
   * the tree has to follow, and the inspector has to start describing the new path. A standalone
   * Monaco can do none of that — it holds one model — which is why the menu item did nothing at all
   * for a symbol that came from an import.
   *
   * Absent ⇒ the editor offers no cross-file jump. Right for a surface mounted with no shell behind
   * it, where there is nowhere to navigate to.
   */
  onOpenDefinition?: (
    at: { layer: WorkflowLayer; project?: string; path: string },
    caret: { line: number; column: number },
  ) => void;
  /**
   * Where the caret was asked to land, and in which file — the other half of {@link onOpenDefinition}.
   *
   * The PATH is carried with it and compared before it is used, because opening a file is
   * asynchronous and the person may have clicked somewhere else in the meantime: a position that
   * outlived the request it belonged to must not be applied to whatever is open now.
   *
   * No nonce, unlike {@link revealIssue}, and for a reason worth stating: a jump WITHIN a file never
   * arrives here — Monaco performs that itself — so this only ever accompanies a file that was not
   * open a moment ago, and the editor for it is being created rather than re-used.
   */
  revealAt?: { path: string; line: number; column: number } | null;
}

export interface FileSurfaceProps {
  doc: FileSource;
  busy: boolean;
  /**
   * Save this file's text.
   *
   * The store picks the channel by what is open — a state file goes through `workflow:write`, which
   * parses and re-lints, everything else through `file:write`. A surface never chooses, which is
   * what stops a new editor from quietly acquiring the power to write an unlinted workflow.
   */
  onSave: (text: string) => void;
  context: FileSurfaceContext;
}

export type FileSurface = (props: FileSurfaceProps) => JSX.Element;

/**
 * What KIND of rendering a renderer is — the axis that was missing, and the one that matters.
 *
 * A document can be drawn three ways and they are not alternatives to each other. They are answers
 * to three different questions, and a type can have one of each at the same time:
 *
 *  - **text** — the characters as they are on disk. Monaco, the code view, the live-preview editor,
 *    the schema-aware editor: all of them draw the SOURCE, and they differ in what they let you do
 *    with it.
 *  - **data** — the value the document denotes, once parsed. The tree, a table of rows, the
 *    authoring form. A JSON file has one of these and still has a text renderer; that is the whole
 *    point of separating the two.
 *  - **preview** — what the document MEANS, rendered. Markdown as prose, HTML as a page, an SVG as a
 *    drawing, a patch as the change it describes, a state as its board.
 *
 * The registry used to be keyed by `view` and `edit` instead, which are not kinds but PLACES — the
 * panel's upper and lower halves. That conflated two questions and made the settings screen
 * incoherent: the JSON editor and the data tree appeared as alternatives to each other because one
 * happened to be registered above the divider and the other below, when in fact they answer
 * different questions and a person wants both. Where a renderer goes is now derived (see
 * {@link viewerFor} and {@link editorFor}) rather than declared, which is the right way round: the
 * panel's layout follows from what the renderers ARE.
 */
export type RenderKind = "text" | "data" | "preview";

/** In the order the settings pane asks about them, and the order the panel resolves in. */
export const RENDER_KINDS: readonly RenderKind[] = ["text", "data", "preview"];

/**
 * One way of drawing a type — a component, and enough about it to put on a menu.
 *
 * The id is the part that has to be thought about, because it is the only thing here that is
 * WRITTEN DOWN: it lands in `user-settings.json` and has to still mean the same thing after a
 * rename, a refactor and a minifier. So it is a word chosen for the rendering it names — `monaco`,
 * `rendered`, `tree` — never the component's own name, which `Function.name` would have given for
 * free and which survives none of those three.
 *
 * `surface: null` is a real renderer and not an absence: "nothing here", offered under `preview` so
 * a person who only ever wants the source can have the editor take the whole column. Resolution
 * returns that null, and the panel already knows what to do with it — see `FilePanel`.
 */
export interface FileRenderer {
  /** Stable across builds and renames: this is what a settings file stores. */
  id: string;
  /** What the picker says. A rendering, not a component: "Monaco", "Rendered", "Table". */
  label: string;
  /** One line under the label, where the choice is not self-evident. */
  note?: string;
  /**
   * Whether this renderer can be TYPED INTO.
   *
   * What decides which half of the panel a renderer lands in, rather than a second registration.
   * Most data and preview renderers only read — a table of rows is not a place to edit a CSV — and
   * the two that do write (a workflow's authoring form; every text editor) are what the lower half
   * is for. A text renderer that does not write is a legitimate choice and not an oversight: the
   * code view is coloured source you cannot damage, which is exactly what some people want a file
   * they are only reading to be.
   */
  writes?: boolean;
  /**
   * Whether this renderer has a PALETTE of its own — a theme, in the editor's sense.
   *
   * True for the surfaces Monaco and CodeMirror paint, and false for everything else, which is not a
   * shortcoming: a data tree, an authoring form, a table of rows and a board are drawn in the app's
   * own tokens, and they should be, because they are parts of the app rather than a rendering of
   * somebody's source. What it decides is whether a colour-scheme control appears beside this
   * renderer at all — and a control over a surface that would ignore it is the one thing a settings
   * screen must not have, because it is invisible.
   */
  themed?: boolean;
  /**
   * Which editing SURFACE this renderer is, where it is one — the knobs that move it.
   *
   * Four implementations answer for every type this app opens (`EditorKind`), because a `.ts` and a
   * `.yaml` are the same Monaco pane with a different grammar. Saying which one a renderer is puts
   * its controls where the renderer is chosen, rather than in a second section that names surfaces
   * a person would have to map back onto the file they were thinking about.
   *
   * Absent for everything that is not an editing surface — a tree, a table, a board, a rendering —
   * and those show no knobs, which is a fact about them rather than an omission.
   */
  look?: EditorKind;
  /** The component, or `null` for "draw nothing at all". */
  surface: FileSurface | null;
}

/**
 * `mime` → kind → the renderers registered for it, in order. Populated by `fileSurfaces.tsx`.
 *
 * A LIST rather than one component, and the order is the meaning: the first is what draws the type
 * when nobody has said otherwise. Everything after it is an alternative a person may pick in
 * Appearance, and a kind with only one entry has nothing to pick between — which is why the settings
 * table can be derived from this map rather than written out beside it and left to drift.
 */
const REGISTRY = new Map<string, Partial<Record<RenderKind, FileRenderer[]>>>();

/** How a choice is addressed, in settings and in the picker. One spelling, used by everything. */
export function rendererKey(mime: string, kind: RenderKind): string {
  return `${mime}:${kind}`;
}

/**
 * The same, for a whole FAMILY of types — `family:code:text`.
 *
 * A second key shape rather than a preference against some parent type, because a family is not a
 * MIME chain: `text/x-typescript` and `application/xml` are both code and share no ancestor but
 * `text/plain`. So there is no type a preference about Code could be written against, and inventing
 * one would make the settings file say something untrue about what inherits from what.
 */
export function familyKey(family: PaneFamily, kind: RenderKind): string {
  return `family:${family}:${kind}`;
}

/**
 * What one person has said about one type and kind, with their family's answer behind it.
 *
 * Read as a chain and per FIELD, which is the part worth stating: a type that names its own editor
 * still takes its family's reading, because those are two decisions and only one of them was made
 * here. `off` is the exception and is taken whole — a type that lists any refusal is describing its
 * own menu, and merging two lists would leave no way to put back something the family removed.
 */
/**
 * The stored lines that could speak about one type and kind, nearest first.
 *
 * Two axes rather than one, because they answer different questions. The MIME chain is about what a
 * document IS — a workflow description is markdown, and a preference about markdown reaches it
 * without anybody naming a vendor type they have never heard of. The family is about what a person
 * SET TOGETHER, and it cannot be a link in that chain: `text/x-typescript` and `application/xml` are
 * both code and share no ancestor but `text/plain`, so there is no type an opinion about Code could
 * be written against.
 *
 * Kept as a list rather than merged here, because whether a line ANSWERS depends on what is being
 * asked. A renderer id has to be checked against what this build actually offers before the walk
 * stops on it — see {@link viewRenderer} — and a merge would have already thrown the alternatives
 * away by then.
 */
function choiceLines(mime: string, kind: RenderKind, chosen: RendererChoices): RendererChoice[] {
  const lines: RendererChoice[] = [];
  for (const candidate of mimeFallbacks(mime)) {
    const line = chosen[rendererKey(candidate, kind)];
    if (line !== undefined) lines.push(line);
  }
  const family = chosen[familyKey(paneFamilyOf(mime), kind)];
  if (family !== undefined) lines.push(family);
  return lines;
}

export function rendererChoiceFor(
  mime: string,
  kind: RenderKind,
  chosen?: RendererChoices | undefined,
): RendererChoice {
  if (chosen === undefined) return defaultRendererChoice();
  /**
   * The lines that could speak, nearest first: this type, then the syntax it is written in, then its
   * family.
   *
   * Two axes rather than one, because they answer different questions. The MIME chain is about what
   * a document IS — a workflow description is markdown, and a preference about markdown reaches it
   * without anybody naming a vendor type they have never heard of. The family is about what a person
   * SET TOGETHER, and it cannot be a link in that chain: `text/x-typescript` and `application/xml`
   * are both code and share no ancestor but `text/plain`, so there is no type an opinion about Code
   * could be written against.
   */
  const lines = choiceLines(mime, kind, chosen);
  if (lines.length === 0) return defaultRendererChoice();
  // Per FIELD, which is the part worth stating: a type that names its own editor still takes its
  // family's reading, because those are two decisions and only one of them was made here.
  const first = <T,>(read: (line: RendererChoice) => T | null): T | null => {
    for (const line of lines) {
      const said = read(line);
      if (said !== null) return said;
    }
    return null;
  };
  return {
    read: first((line) => line.read),
    write: first((line) => line.write),
    // Taken WHOLE from the nearest line that states one. Merging two lists would leave no way to put
    // back something a vaguer line removed, and a refusal is a description of one menu.
    off: lines.find((line) => line.off.length > 0)?.off ?? [],
    theme: {
      read: first((line) => line.theme.read),
      write: first((line) => line.theme.write),
    },
  };
}

/**
 * What a type is actually OFFERED for one kind — the registered list, less anything refused.
 *
 * Empty is a real answer and means the kind is off for this type: every renderer that could have
 * drawn it was taken off the menu, and falling back to one of them would be honouring a preference
 * by ignoring it.
 */
export function enabledRenderers(
  mime: string,
  kind: RenderKind,
  chosen?: RendererChoices | undefined,
): readonly FileRenderer[] {
  const off = rendererChoiceFor(mime, kind, chosen).off;
  if (off.length === 0) return fileRenderers(mime, kind);
  return fileRenderers(mime, kind).filter((renderer) => !off.includes(renderer.id));
}

/**
 * The renderer drawing one VIEW of a type — the reading, or the editor.
 *
 * The two differ in what may answer. Any renderer can be the reading, because every rendering can be
 * looked at; only one that WRITES can be the editor, which is the registry's own flag rather than a
 * second thing to configure. A kind with nothing that writes has no editor, and says so by answering
 * null rather than by offering a surface that cannot be typed into.
 *
 * A choice naming a renderer this build does not have, or one that has been taken off the menu, is
 * stepped over rather than repaired: the person is left looking at the default, which is a state
 * they can see and correct, instead of at an empty panel with nothing to say why.
 */
export function viewRenderer(
  mime: string,
  kind: RenderKind,
  view: RenderView,
  chosen?: RendererChoices | undefined,
): FileRenderer | null {
  const offered = enabledRenderers(mime, kind, chosen);
  // `Nothing` belongs to both views, but only where there is something to decline. It is not a
  // renderer that writes, it is the ABSENCE of one — "do not give me the authoring form to type
  // into" is a statement a person must be able to make, and "the editor for this preview is
  // Nothing" is not a statement at all. So it joins the editor's list exactly when that list has a
  // real writer in it; otherwise this kind has no editor and says so by answering null.
  const writes = offered.some((renderer) => renderer.writes === true);
  const list = offered.filter(
    (renderer) => view === "read" || renderer.writes === true || (writes && renderer.surface === null),
  );
  if (list.length === 0) return null;
  // Walked rather than merged, so that a line naming a renderer this build does not have is STEPPED
  // OVER and a vaguer one still applies. Merging first would let a stale specific answer swallow a
  // good general one — the person would see the app's default and have no way to tell which of their
  // two preferences had gone stale.
  for (const line of chosen === undefined ? [] : choiceLines(mime, kind, chosen)) {
    const want = line[view];
    if (want === null) continue;
    const picked = list.find((renderer) => renderer.id === want);
    if (picked !== undefined) return picked;
  }
  return list[0]!;
}

/**
 * The palette one view is drawn in — see `RendererChoice.theme`.
 *
 * Null where nothing has been said, which is what `DEFAULT_EDITOR_THEME` answers; the caller is the
 * one that knows whether the renderer it landed on has a palette at all.
 */
export function viewTheme(
  mime: string,
  kind: RenderKind,
  view: RenderView,
  chosen?: RendererChoices | undefined,
): string | null {
  return rendererChoiceFor(mime, kind, chosen).theme[view];
}

/**
 * Connect a type and a kind of rendering to a way of doing it.
 *
 * FIRST registration wins as the default, which is what makes a stored preference meaningful: "last
 * one wins" is a rule about load order, and a default that depends on load order is a default nobody
 * can name in a settings file. A registration whose id is already present REPLACES it in place — so
 * overriding a built-in is still one call, it just has to say which renderer it is overriding.
 */
export function registerFileSurface(mime: string, kind: RenderKind, renderer: FileRenderer): void {
  const entry = REGISTRY.get(mime) ?? {};
  const list = entry[kind] ?? [];
  const at = list.findIndex((known) => known.id === renderer.id);
  if (at === -1) list.push(renderer);
  else list[at] = renderer;
  entry[kind] = list;
  REGISTRY.set(mime, entry);
}

/**
 * What a type can be drawn by, for one kind, best first.
 *
 * Walks the fallback chain, so `application/vnd.jaira.workflow+yaml` with no text renderers of its
 * own gets YAML's, and every text type ends at `text/plain` — which is why an unregistered file
 * still opens in an editor instead of showing an error. The FIRST candidate with any registration
 * for this kind answers; a more specific type therefore replaces the list rather than adding to it,
 * which is what stops a config file from inheriting the plain JSON editor that would write it
 * unvalidated.
 */
export function fileRenderers(mime: string, kind: RenderKind): readonly FileRenderer[] {
  for (const candidate of mimeFallbacks(mime)) {
    const list = REGISTRY.get(candidate)?.[kind];
    if (list !== undefined && list.length > 0) return list;
  }
  return [];
}

/**
 * The renderer a person has chosen for one kind, or the one that leads.
 *
 * `chosen` is their preferences, keyed by {@link rendererKey}, and it is consulted AT THE LINK OF THE
 * CHAIN the list came from — so choosing the source reading for `text/markdown` reaches a workflow
 * description too, because that is markdown and it inherits markdown's list. A description with a
 * choice of its own keeps it, because the walk finds the more specific list first.
 *
 * A choice naming a renderer this build does not have is ignored rather than repaired: the person is
 * left looking at the default, which is a state they can see and correct, instead of at an empty
 * panel with nothing to say why.
 */
export function chosenRenderer(
  mime: string,
  kind: RenderKind,
  chosen?: RendererChoices | undefined,
): FileRenderer | null {
  return viewRenderer(mime, kind, "read", chosen);
}

/**
 * Is this mount a READING? — the question every renderer that writes has to ask.
 *
 * A type's two views are two separate picks, and most renderers that can write are legitimate
 * answers to both: Monaco is a fine way to READ a `.ts` file, the live preview is a fine way to read
 * markdown, the schema-aware editor is a fine way to read a `.json`. What must not follow from
 * "this renderer can write" is that this particular mount may be typed into — a reading that takes a
 * keystroke can lose somebody's file to a stray key, and the Save button under it is an offer
 * nothing asked for.
 *
 * So the SURFACE asks, rather than the panel withholding `onSave`. Withholding it would say "there
 * is nowhere for a change to go", and every renderer here answers that by drawing something else
 * entirely — the tokenizer instead of Monaco, markdown-it instead of the live preview. The answer to
 * "read this" is the renderer that was chosen, with the typing off.
 *
 * Absent is `write`, which is what almost every mount is — see `FileSurfaceContext.view`.
 */
export function isReading(context: Pick<FileSurfaceContext, "view">): boolean {
  return context.view === "read";
}

/**
 * A renderer AND the pair it was resolved through — what a panel needs in order to paint it.
 *
 * The renderer alone was enough while a palette was one value for the whole window. It is not now: a
 * theme is stored per type, per kind and per view, and a half of the panel that knows only which
 * component it is mounting has no key to ask with.
 */
export interface PanelPick {
  renderer: FileRenderer;
  kind: RenderKind;
  view: RenderView;
}

/**
 * The panel's UPPER half: what this document is, rather than what it says.
 *
 * Preview first, then data, and that order is the claim the two kinds make. A rendering answers
 * "what does this mean" and beats a parse of the same file; a parsed value answers it for the types
 * that have no rendering, which is most data formats. A WRITING data renderer is skipped here
 * because it is the lower half — a workflow's authoring form is not a reading of the state, it is
 * where the state is written.
 *
 * Null is a real answer and not a gap: a `.ts` file has no rendering distinct from its own text, and
 * half a panel of nothing above it would be worse than the space. It is also what a person asks for
 * by choosing `Nothing` under preview.
 */
export function viewerFor(mime: string, chosen?: RendererChoices | undefined): FileSurface | null {
  return viewerPick(mime, chosen)?.renderer.surface ?? null;
}

/**
 * The same resolution, WITH the pair it resolved through — see {@link PanelPick}.
 *
 * Split out rather than worked out twice, because only this walk knows which kind and which view a
 * half landed on: the upper half is the preview of one type and the data reading of another, and a
 * palette is stored against exactly that pair. Asked against a guess it is a preference read from
 * the wrong key, which is a control that silently does nothing.
 */
export function viewerPick(mime: string, chosen?: RendererChoices | undefined): PanelPick | null {
  const preview = viewRenderer(mime, "preview", "read", chosen);
  if (preview !== null) return { renderer: preview, kind: "preview", view: "read" };
  const data = viewRenderer(mime, "data", "read", chosen);
  return data !== null && data.writes !== true ? { renderer: data, kind: "data", view: "read" } : null;
}

/**
 * The panel's LOWER half: where the document is changed.
 *
 * A writing DATA renderer wins over the text one, which is the workflow authoring form and the
 * reason this order exists: a state file opens on its fields, and its source is one choice away
 * (pick `Nothing` under data, and this falls through to the text renderer). Everything else has no
 * writing data renderer, so this is the text renderer — which is what "how do I edit a `.ts` file"
 * has always meant.
 *
 * The renderer comes back WHOLE rather than as a component, because the panel has to be able to say
 * that it does not write: choosing the code view is choosing not to type, and a Save button over a
 * surface that cannot be typed into would be a lie.
 */
export function editorFor(mime: string, chosen?: RendererChoices | undefined): FileRenderer | null {
  return editorPick(mime, chosen)?.renderer ?? null;
}

/** The lower half's resolution, with the pair it resolved through — see {@link viewerPick}. */
export function editorPick(mime: string, chosen?: RendererChoices | undefined): PanelPick | null {
  const data = viewRenderer(mime, "data", "write", chosen);
  // A data editor that draws NOTHING is a refusal of the data editor, not of editing: the text
  // renderer takes it, which is what "give me the source of my state file instead of the form" has
  // always meant. Only a real surface stops the fall-through.
  if (data !== null && data.surface !== null) return { renderer: data, kind: "data", view: "write" };
  // The reading FIRST, where it is one that cannot be typed into — which is only ever because
  // somebody said so. Choosing the code view is choosing not to type, and the panel already knows
  // how to draw a surface with no Save; without this, a text reading that does not write would be a
  // preference the panel silently declined. Everything else falls through to the editor, which is
  // what "how do I edit a `.ts` file" has always meant.
  const read = viewRenderer(mime, "text", "read", chosen);
  if (read !== null && read.writes !== true) return { renderer: read, kind: "text", view: "read" };
  const write = viewRenderer(mime, "text", "write", chosen);
  return write === null ? null : { renderer: write, kind: "text", view: "write" };
}

/**
 * The palette a mounted surface has to carry ITSELF, or null for "whatever the window is in".
 *
 * Two questions, and both have to be asked. A renderer with no palette of its own is drawn in the
 * app's own tokens, and painting a container around it would be a preference reaching a surface it
 * was never about — that is `themed`, the same flag that decides whether the control appears at
 * all. And a view nobody has said anything about answers null, which leaves the window's default
 * standing rather than restating it one element down.
 */
export function pickPalette(
  pick: PanelPick | null,
  mime: string,
  chosen?: RendererChoices | undefined,
): string | null {
  if (pick === null || pick.renderer.themed !== true) return null;
  return viewTheme(mime, pick.kind, pick.view, chosen);
}

/** Every type with at least one registered renderer. Exported for the tests that guard the table. */
export function registeredMimes(): string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * Every type-and-kind a person actually has a choice about — what the Appearance pane draws.
 *
 * Derived rather than declared, so a renderer added to the table below shows up in settings with
 * nothing else to write, and one removed cannot leave behind a row that sets a preference nothing
 * reads. Kinds with a single renderer are left out: a menu of one is a statement dressed as a
 * question.
 *
 * Registration order throughout — the map's, and each list's — because that order is already the
 * argument the table makes about what leads, and re-sorting it here would be this file having a
 * second opinion about a decision it does not own.
 */
export function rendererChoices(): Array<{ mime: string; kind: RenderKind; renderers: readonly FileRenderer[] }> {
  const out: Array<{ mime: string; kind: RenderKind; renderers: readonly FileRenderer[] }> = [];
  for (const [mime, kinds] of REGISTRY) {
    for (const kind of RENDER_KINDS) {
      const renderers = kinds[kind];
      if (renderers !== undefined && renderers.length > 1) out.push({ mime, kind, renderers });
    }
  }
  return out;
}
