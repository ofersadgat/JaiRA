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
 *  - **action** — `view` (read it) or `edit` (change it).
 *  - **component** — a {@link FileSurface}, which is a plain React component over one props shape.
 *
 * Two rules make the table small. Resolution walks `mimeFallbacks`, so a vendor type inherits the
 * surfaces of the syntax it is written in and every text type ends at `text/plain` — which is why an
 * unregistered file still opens in an editor instead of showing an error. And `view` is genuinely
 * optional: a type with no viewer gives its editor the whole panel, because a plain text file has
 * nothing to render that its own contents do not already show.
 */
import type { JSX } from "react";
import type {
  ConfigLayer,
  DetectSchemaResult,
  ConfigView,
  ConversationView,
  InstanceNode,
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
  WorkflowSyncEdit,
  WorkflowSyncResult,
  WorkflowSyncStatus,
} from "@jaira/shared/browser";
import { mimeFallbacks } from "@jaira/shared/browser";
import type { Drafts, SetDraft } from "./drafts";
import type { TrailStep } from "./trail";

/** What a surface does with the file. The two halves of the panel, top to bottom. */
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
  /** Transcripts by instance id, and how to fetch one. See `AppState.sessions`. */
  sessions: Record<number, SessionView>;
  onLoadSession: (instanceId: number) => void;
  /** Every state that task went through, and the transcript of the one being looked at. */
  sessionHistory: SessionRef[];
  session: SessionView | null;
  sessionInstance: number | null;
  /** The answer being written right now, when there is one. */
  liveTurn: { sessionId?: string; seq?: number; stateId?: string; text: string } | null;
  onShowSession: (instanceId: number | null) => void;
  waiting?: { component: string } | undefined;
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
  onAnswer?: (() => void) | undefined;
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
  editorTab?: Record<string, "form" | "json"> | undefined;
  onEditorTab?: ((key: string, tab: "form" | "json") => void) | undefined;
  /**
   * The description-vs-workflows machinery, for the one surface that shows it.
   *
   * Absent ⇒ no host for it (a panel rendered outside the shell), and the viewer falls back to the
   * markdown preview rather than offering buttons that would do nothing.
   */
  sync?: SyncSurface | undefined;
  /** Which registered schema a document already satisfies. Null when nothing could be asked. */
  detectSchema: (text: string) => Promise<DetectSchemaResult | null>;
  /** Word wrap in the JSON editor — a saved preference, not per-document. */
  wrapJson: boolean;
  onWrapJson: (wrap: boolean) => void;
  /**
   * The diagnostic the inspector last asked to be SHOWN, as a lint path (`outputs.report`).
   *
   * The inspector lists the issues and the editor holds the controls, and they are two columns
   * apart; this is the one thing they have to agree on. `nonce` rises on every click so that asking
   * for the same path twice flashes it twice — without it, clicking an issue you have already
   * visited would do nothing at all, which reads as a broken link rather than as "you are here".
   */
  revealIssue?: { path: string; nonce: number } | null;
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

/** `mime` → action → component. Populated by `fileSurfaces.tsx` at import time. */
const REGISTRY = new Map<string, Partial<Record<FileAction, FileSurface>>>();

/**
 * Connect a type and an action to a component.
 *
 * Last registration wins, so a project-specific surface can replace a built-in one by registering
 * after it. That is the only override mechanism there is, and it is enough: the table is small, and
 * a priority number would be a second thing to reason about for a case that has not come up.
 */
export function registerFileSurface(mime: string, action: FileAction, surface: FileSurface): void {
  const entry = REGISTRY.get(mime) ?? {};
  entry[action] = surface;
  REGISTRY.set(mime, entry);
}

/**
 * The component for a pair, or null when nothing handles it.
 *
 * Walks the fallback chain, so `application/vnd.jaira.workflow+yaml` with no editor of its own gets
 * the YAML one, and an unknown text type gets the plain editor. Null is a real answer for `view` —
 * see the module comment — and for `edit` it means the file is not text at all.
 */
export function resolveFileSurface(mime: string, action: FileAction): FileSurface | null {
  for (const candidate of mimeFallbacks(mime)) {
    const surface = REGISTRY.get(candidate)?.[action];
    if (surface) return surface;
  }
  return null;
}

/** Every type with at least one registered surface. Exported for the tests that guard the table. */
export function registeredMimes(): string[] {
  return [...REGISTRY.keys()].sort();
}
