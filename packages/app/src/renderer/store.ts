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
  ProjectSummary,
  SessionRef,
  SessionView,
  AvailabilitySnapshot,
  ExecutorInfo,
  JairaOperationNode,
  FileMutationResult,
  FileNode,
  FileSource,
  FileTree,
  HistorySize,
  InstanceNode,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResponse as Response,
  JairaBridge,
  JairaSettings,
  JairaTheme,
  PendingApproval,
  PendingInteraction,
  ProbeResult,
  PushMessage,
  SecretCapabilities,
  SecretTarget,
  StateView,
  SyncDirection,
  TaskDetail,
  WorkflowMutationResult,
  WorkflowSyncEdit,
  WorkflowSyncResult,
  WorkflowSyncStatus,
  TaskSummary,
  WorkflowLayer,
} from "@jaira/shared/browser";
import { CONFIG_JSON, isTextMime, SHARED_SESSION, WORKFLOW_JSON } from "@jaira/shared/browser";
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
import { instanceAt, newestRunOf, runTargetOf } from "./runForm";
import { instanceOf, nodeAt, prunedTrail, sameTrail, stepOf, type TrailStep } from "./trail";
import { SELF_TEST_ROOT, SELF_TEST_STATES, selfTestFiles, selfTestScript } from "./debugWorkflow";

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

/** See {@link AppState.inspect}. */
export type InspectSubject = "path" | "task";

export interface AppState {
  projectDir: string | null;
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
  /** Live event lines for the selected task, newest last. */
  stream: string[];
  /** How much history is stored, for the pruning panel. */
  history: HistorySize | null;
  /** The last prune plan (dry run) or applied result — never auto-applied. */
  prune: PruneReport | null;
  error: string | null;
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
  editorTab: Record<string, "form" | "json">;

  /**
   * What has been typed into a state's run form, keyed by STATE ID then by input name.
   *
   * Keyed by state id rather than by `layer:path` — the two layers hold two copies of one state, but
   * a run names the id and gets whichever copy the search path resolves, so remembering the boxes
   * per file would split one form's contents across two keys that run the same thing.
   *
   * SPARSE, and that is what makes it work: a name absent here falls back to the slot's `default`,
   * so opening a state shows its declared defaults without this map ever being seeded, while a box
   * someone deliberately CLEARED is stored as `""` and stays cleared. Held here rather than in the
   * panel for the reason the drafts are: the inspector unmounts on the next click in the tree.
   */
  runValues: Record<string, Record<string, string>>;

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
  /** The conversation of the state being looked at — one operation, whole. */
  session: SessionView | null;
  /** Which instance the viewer is showing. Null ⇒ the task's most recent. */
  sessionInstance: number | null;
  /**
   * Transcripts by instance id, for the composite view — several cards can be open at once.
   *
   * Beside {@link session} rather than replacing it: that one is "the conversation being read",
   * which the leaf and the task panel both point at, while this is a CACHE of the several a run's
   * children produced. Fetched on expand rather than up front, because rendering a list of eight
   * folded headers would otherwise cost eight round trips before anyone had asked to read one.
   *
   * Cleared whenever the selected task changes — an instance id is only unique within a run, so a
   * stale entry would show the previous task's words under this one's card.
   */
  sessions: Record<number, SessionView>;
  /**
   * What the app has said about itself, newest last, and the process output a row opened.
   *
   * Held rather than fetched per render because entries ARRIVE — the main process pushes each one, so
   * the list is a live tail with a backfill, not a query.
   */
  logs: LogEntry[];
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
   */
  projects: ProjectSummary[];
  boards: Record<string, BoardView | null>;
  levels: Record<string, string | null>;
  /** Which group is expanded. A collapsed one keeps its level, so re-opening it lands where it was. */
  collapsed: Record<string, boolean>;
  /** Which project the selected task belongs to — a task id means nothing without it. */
  selectedProject: string | null;
  /**
   * The answer currently being written, before it is a turn.
   *
   * A record persists once, at the end of its operation — so without this a long agent run shows an
   * empty conversation for as long as it is thinking. Cleared when the record lands, because the
   * stored turn is the same text and better: it has its tool calls with it.
   */
  liveTurn: { sessionId?: string; seq?: number; stateId?: string; text: string } | null;
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
 * `matches` is the third answer and the reason this is not a boolean: a file that exists but says
 * something else is a file somebody edited, and overwriting it without saying so would throw away
 * an experiment. The pane reports it and offers the overwrite as its own button.
 */
export interface DebugFile {
  stateId: string;
  /** Absolute path, for the "where did this land" line. */
  file: string;
  exists: boolean;
  /** True when the file on disk is byte-for-byte what {@link selfTestFiles} would write. */
  matches: boolean;
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
  /** True while installing or starting — the buttons say so rather than doing it twice. */
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

/** The destinations on the activity rail. */
export type View = "files" | "tasks" | "logs" | "debug" | "settings";

/**
 * Sections of the Settings view — everything that was never one of the two activities.
 *
 * `providers`, `executors` and `config` are read at the layer {@link AppState.configLayer} names;
 * `history` is a project's run journal and has no layer to pick — nor anything to show without a
 * project, which is why the shell hides it on an empty window rather than rendering it empty.
 */
export type SettingsSection = "providers" | "executors" | "config" | "history";

const EMPTY: AppState = {
  projectDir: null,
  tasks: [],
  sharedTasks: [],
  board: null,
  level: null,
  selected: null,
  detail: null,
  pending: [],
  approvals: [],
  stream: [],
  history: null,
  prune: null,
  error: null,
  busy: false,
  // Light until the saved preference says otherwise, matching the stylesheet's own default so the
  // first paint and the loaded setting agree in the common case.
  settings: { theme: "light", wrapJson: false },
  config: null,
  executors: [],
  probes: {},
  modelProbes: {},
  availability: { routes: [], executors: [], checkedAt: 0 },
  rechecking: false,
  secrets: { keychain: false },
  schemaChoice: {},
  sync: { status: null, result: null, running: false, error: null, progress: [] },
  debug: { files: [], taskId: null, busy: false, error: null },
  drafts: {},
  editorTab: {},
  runValues: {},
  doc: null,
  dir: null,
  view: "tasks",
  tree: null,
  stateId: null,
  state: null,
  inspect: "path",
  inspectFrom: null,
  conversation: null,
  sessionHistory: [],
  session: null,
  sessionInstance: null,
  sessions: {},
  logs: [],
  jobOutput: null,
  liveTurn: null,
  projects: [],
  boards: {},
  levels: {},
  collapsed: {},
  selectedProject: null,
  trail: [],
  trailState: null,
  section: "providers",
  configLayer: "project",
};

/** Keep the live log bounded — a long run would otherwise grow without limit. */
const STREAM_LIMIT = 300;
/** How many diagnostics the renderer keeps. The main process holds more; this is the visible tail. */
const LOG_LIMIT = 2000;
/** How many lines of a sync's own narration the panel keeps. Enough for a three-state run. */
const SYNC_PROGRESS_LIMIT = 60;

/** One engine event as a line: what happened, and to which state. */
function engineLine(raw: unknown): string {
  const event = raw as { type?: string; stateId?: string; to?: string; outcome?: string };
  const detail = [event.stateId, event.to ?? event.outcome].filter(Boolean).join(" → ");
  return `${event.type ?? "event"}  ${detail}`;
}

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
   * not theoretical: a caller that set `projectDir` and then refreshed in the same tick read the
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
   * The focused project's tasks.
   *
   * ASKED FOR unconditionally, and a refusal read as "none". The guard this replaces tested
   * `ref.current.projectDir`, and `ref.current` is assigned during RENDER — so every caller that
   * patched `projectDir` and then refreshed in the same tick (opening a project does exactly that)
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
    if (ref.current.projectDir === null) return patch({ tasks: [] });
    try {
      patch({ tasks: await invoke("task:list", undefined) });
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
        const board = next === null ? await invoke("board:roots", undefined) : await invoke("board:view", { level: next });
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
  const refreshTree = useCallback(async () => {
    try {
      patch({ tree: await invoke("files:tree", undefined) });
    } catch {
      patch({ tree: null });
    }
  }, [patch]);

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
        const view = await invoke("state:view", { stateId });
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
    async (layer: WorkflowLayer | null, path: string | null) => {
      if (layer === null || path === null) return patch({ doc: null });
      try {
        const doc = await invoke("file:read", { layer, path });
        // A draft the file has caught up with is no longer an edit — see `settled`. Dropped here,
        // where the document is re-read, rather than at the save site: the same thing is true of a
        // file changed under us, and there is one place that learns about both.
        patch({ doc, drafts: settled(ref.current.drafts, docKey(layer, path), doc.text) });
      } catch {
        patch({ doc: null });
      }
    },
    [patch],
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
          at = (await invoke("state:view", { stateId })).layer;
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
    patch({ projects, boards });
  }, [patch]);

  const refreshLogs = useCallback(async () => {
    try {
      patch({ logs: await invoke("log:list", { limit: 1000 }) });
    } catch {
      patch({ logs: [] });
    }
  }, [patch]);

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
      instanceId: number | null = null,
      project?: string,
      atState?: string | null,
      // Which instance was resolved, so a NAVIGATION can start the trail at it. Returned rather than
      // patched here: this also runs on every invalidating push, and re-seeding the trail from one
      // would drop you back to the top of the walk on each engine event.
    ): Promise<number | null> => {
      if (taskId === null) {
        patch({ sessionHistory: [], session: null, sessionInstance: null });
        return null;
      }
      const scope = project ?? ref.current.selectedProject ?? undefined;
      const at = scope !== undefined ? { project: scope } : {};
      try {
        const history = await invoke("session:history", { taskId, ...at });
        const wanted = instanceId ?? instanceAt(history, atState ?? null);
        const session = await invoke("session:view", {
          taskId,
          ...(wanted !== null ? { instanceId: wanted } : {}),
          ...at,
        });
        // The live tail goes when the record lands: the stored turn is the same text with its tool
        // calls attached, so keeping both would show the answer twice.
        patch({ sessionHistory: history, session, sessionInstance: wanted, liveTurn: null });
        return wanted;
      } catch {
        patch({ sessionHistory: [], session: null, sessionInstance: null });
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
        patch({ trailState: await invoke("state:view", { stateId }) });
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
    const focused = ref.current.projectDir ?? undefined;
    return layer === undefined ? focused : (runTargetOf(layer, ref.current.projectDir).project ?? focused);
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
        // is the one surface that must not describe a place you cannot get to.
        const trail = prunedTrail(ref.current.trail, detail.instances);
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
        patch({ selected: null, sessionHistory: [], session: null, sessionInstance: null, conversation: null, sessions: {}, trail: [], trailState: null });
        return;
      }
      const newest = newestRunOf(view);
      if (newest === null) {
        patch({ selected: null, sessionHistory: [], session: null, sessionInstance: null, conversation: null, trail: [], trailState: null });
        return;
      }
      // The project the STATE's runs live in, not the focused one — see `owningProject`. `view` is
      // authoritative about the layer here, and it is the value the reads below have to agree with.
      const at = runTargetOf(view.layer, ref.current.projectDir).project ?? ref.current.projectDir ?? undefined;
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
    [patch, refreshConversation, refreshDetail, refreshSession, refreshTasks, refreshSharedTasks, seedTrail],
  );

  /**
   * One child's transcript, cached by instance id — what a run card opens.
   *
   * Quiet and idempotent: it fires from a click on a folded header, several may be in flight at
   * once, and a state that ran no model call answers with `empty` rather than an error. Re-fetching
   * one already held would flicker a card someone is reading, so a hit is a no-op.
   */
  const loadSession = useCallback(
    async (instanceId: number) => {
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

  const refreshHistory = useCallback(async () => {
    // Same rule as {@link refreshTasks}: run history belongs to a project, so with none open there is
    // nothing to size.
    if (ref.current.projectDir === null) return patch({ history: { runs: 0, events: 0, commands: 0 } });
    try {
      patch({ history: await invoke("history:size", undefined) });
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
      patch({ settings: await invoke("settings:read", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshConfig = useCallback(async () => {
    try {
      const [config, executors, secrets] = await Promise.all([
        invoke("config:read", undefined),
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
   * Where the self-test's state files stand in the shared root.
   *
   * The SHARED root, not the project's: the self-test is a fact about this installation rather than
   * about a checkout, and writing it into `.jaira/` would put three debug files into whatever
   * repository happened to be open — and into its next commit. Written once, reachable from every
   * project, and visible in the Files tree under the shared root like anything else there.
   */
  const refreshDebugFiles = useCallback(async () => {
    const wanted = selfTestFiles();
    const files = await Promise.all(
      SELF_TEST_STATES.map(async (stateId): Promise<DebugFile> => {
        const expected = JSON.stringify(wanted[stateId]);
        try {
          const source = await invoke("workflow:read", { stateId, layer: "base" });
          let matches = false;
          try {
            // Compared as VALUES, not as bytes. Re-indenting a file is not editing it, and a pane
            // that offered to overwrite a formatting change would be crying wolf.
            matches = source.exists && JSON.stringify(JSON.parse(source.text) as unknown) === expected;
          } catch {
            matches = false;
          }
          return { stateId, file: source.file, exists: source.exists, matches };
        } catch {
          return { stateId, file: "", exists: false, matches: false };
        }
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
      projectDir: current?.dir ?? null,
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
    ]);
    if (!current) return;
    await Promise.all([
      refreshTasks(),
      refreshBoard(),
      refreshPending(),
      refreshApprovals(),
      refreshHistory(),
      // Again, now that a project layer exists to lay over the base one.
      refreshConfig(),
      // Again, now that a project supplies a second root to walk.
      refreshTree(),
      refreshDetail(ref.current.selected),
      refreshState(ref.current.stateId),
    ]);
  }, [
    patch,
    refreshTasks,
    refreshSharedTasks,
    refreshBoard,
    refreshPending,
    refreshApprovals,
    refreshHistory,
    refreshSettings,
    refreshConfig,
    refreshAvailability,
    refreshTree,
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
      if (message.type === "store:invalidate" && about !== undefined && about !== ref.current.projectDir) {
        // …except JaiRA's own lists, which are nobody's project and so are nobody's to ignore.
        if (message.scope === "tasks") {
          void refreshProjects();
          // A shared workflow's runs land here, and the Files inspector shows them beside its Run
          // button. Dropping this invalidate is what would leave that history one run behind.
          void refreshSharedTasks();
        }
        return;
      }
      switch (message.type) {
        case "store:invalidate":
          if (message.scope === "tasks") {
            void refreshTasks();
            void refreshHistory();
            // The open state's view carries its own task lists (`tasksHere`, `tasksRecent`), which
            // the Files inspector reads for the second half of its run history and the middle panel
            // reads for its task list. A `tasks` invalidate is exactly the event that changes them,
            // and it used to refresh neither — so a run started from the Run button sat there at
            // whatever the panel last happened to fetch until something touched the board.
            void refreshState(ref.current.stateId);
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
          }
          if (message.scope === "task") {
            void refreshDetail(ref.current.selected);
            // Whenever a run is on screen — the address bar is standing on one, or the panel is on
            // its task. Keyed off `inspect` alone, a walk into a run left the transcript frozen at
            // whatever it said when you walked in.
            if (ref.current.inspect === "task" || ref.current.trail.length > 0) {
              void refreshConversation(ref.current.selected);
              void refreshSession(ref.current.selected, ref.current.sessionInstance);
            }
          }
          if (message.scope === "workflows") {
            void refreshTree();
            void refreshState(ref.current.stateId);
          }
          if (message.scope === "config") void refreshConfig();
          // The checks main runs by itself have landed. Nothing asked for them, so nothing is waiting
          // on a response — this push is how their result reaches the screen.
          if (message.scope === "availability") void refreshAvailability();
          break;
        case "engine:event": {
          const line = engineLine(message.event);
          // A sync's events name a task nobody selected — it runs in JaiRA's own project. While one is
          // in flight, anything not about the selected task is that sync narrating itself.
          if (message.taskId !== ref.current.selected) {
            if (ref.current.sync.running) {
              patch({ sync: { ...ref.current.sync, progress: [...ref.current.sync.progress, line].slice(-SYNC_PROGRESS_LIMIT) } });
            }
            return;
          }
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
        case "run:finished":
          void refreshProjects();
          void refreshTasks();
          void refreshSharedTasks();
          void refreshBoard();
          void refreshDetail(ref.current.selected);
          void refreshState(ref.current.stateId);
          if (ref.current.inspect === "task" || ref.current.trail.length > 0) {
            void refreshConversation(ref.current.selected);
          }
          break;
        case "session:turn": {
          // Accumulated per position: a delta is a fragment, and the fragments of one call belong to one
          // answer. A delta for a different position REPLACES rather than appends, because that is a
          // different state speaking and concatenating two would invent a turn neither produced.
          const live = ref.current.liveTurn;
          const same = live !== null && live.sessionId === message.sessionId && live.seq === message.seq;
          patch({
            liveTurn: {
              ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
              ...(message.seq !== undefined ? { seq: message.seq } : {}),
              ...(message.stateId !== undefined ? { stateId: message.stateId } : {}),
              text: same ? live.text + message.text : message.text,
            },
          });
          break;
        }
        case "log:entry": {
          // Appended rather than re-fetched: entries arrive one at a time and the list is a tail.
          // Capped, because a long agent run produces a great many and none is worth a leak.
          const logs = [...ref.current.logs, message.entry];
          patch({ logs: logs.length > LOG_LIMIT ? logs.slice(-LOG_LIMIT) : logs });
          break;
        }
      }
    });
  }, [
    refreshAll,
    refreshTasks,
    refreshSharedTasks,
    refreshBoard,
    refreshDetail,
    refreshPending,
    refreshApprovals,
    refreshHistory,
    refreshConfig,
    refreshTree,
    refreshState,
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
        // Named, then whatever the last selection resolved to, then the owner of the open file — NOT
        // the focused project, which with no checkout open is none and makes every read that follows
        // throw. See `owningProject`.
        const at = project ?? ref.current.selectedProject ?? owningProject();
        const from = atState ?? ref.current.stateId;
        patch({
          selected: taskId,
          selectedProject: taskId === null ? null : (at ?? null),
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

      /** Fold a project's board away. Its level is kept, so re-opening lands where it was. */
      toggleProject: (project: string) =>
        patch({ collapsed: { ...ref.current.collapsed, [project]: !ref.current.collapsed[project] } }),

      /** Drill into one project's board. `null` returns that group to its workflow roots. */
      drillProject: (project: string, level: string | null) => {
        patch({ levels: { ...ref.current.levels, [project]: level } });
        void refreshProjects();
      },

      /** Fetch one child run's transcript, for a card that has just been opened. */
      loadSession: (instanceId: number) => void loadSession(instanceId),

      /** Look at another state's conversation — clicking a row of the task's history. */
      showSession: (instanceId: number | null) => {
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
        if (ref.current.projectDir === null) return;
        void refreshBoard(level);
      },
      dismissError: () => patch({ error: null }),
      createTask: async (title: string, workflow: string, issue: string) => {
        patch({ busy: true, error: null });
        try {
          const summary = await invoke("task:create", {
            title,
            workflow,
            ...(issue ? { inputs: { issue } } : {}),
          });
          patch({ busy: false, selected: summary.taskId });
          await Promise.all([refreshTasks(), refreshBoard(), refreshDetail(summary.taskId)]);
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
          await invoke("task:start", {
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
      planPrune: async (olderThanDays: number, keepRunsPerTask: number) => {
        try {
          patch({ prune: await invoke("history:prune", { olderThanDays, keepRunsPerTask }) });
        } catch (e) {
          fail(e);
        }
      },
      applyPrune: async (olderThanDays: number, keepRunsPerTask: number) => {
        patch({ busy: true, error: null });
        try {
          const result = await invoke("history:prune", { olderThanDays, keepRunsPerTask, apply: true });
          patch({ prune: result, history: result.remaining, busy: false });
        } catch (e) {
          fail(e);
        }
      },
      dismissPrune: () => patch({ prune: null }),
      openProject: async (dir: string) => {
        patch({ busy: true, error: null });
        try {
          await invoke("project:open", { dir });
          patch({ busy: false, selected: null, detail: null });
          await refreshAll();
        } catch (e) {
          fail(e);
        }
      },
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
          patch({ settings: await invoke("settings:write", { theme }) });
        } catch (e) {
          fail(e);
        }
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
        // Backfilled once on open; everything after arrives on the push.
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
        if (section === "providers" || section === "executors") void refreshAvailability();
      },
      // Refused rather than silently accepted when there is nothing to write: the shell hides the
      // switch without a project, and an action that could still be reached another way should agree
      // with it rather than leaving the panes claiming to edit a document that does not exist.
      setConfigLayer: (configLayer: ConfigLayer) => {
        if (configLayer === "project" && ref.current.projectDir === null) return;
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
        if (isTextMime(node.mime)) return void refreshDoc(node.layer, node.path);
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
      openStateAt: (stateId: string, instanceId: number) => {
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
          patch({ sync: { ...ref.current.sync, status: await invoke("workflow:syncStatus", { layer, path }) } });
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
          const next = await invoke("config:write", { layer, config: config as never });
          patch({ config: next, busy: false });
          await refreshConfig();
          // `config.json` is the one editor that does not save through `saveDoc` — it writes a
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
      createWorkflow: async (stateId: string, layer: WorkflowLayer) => {
        patch({ busy: true, error: null, view: "files" });
        try {
          await invoke("workflow:write", { stateId, layer, text: "{}" });
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
      createFile: async (layer: WorkflowLayer, path: string, kind: "file" | "directory", text?: string) => {
        patch({ busy: true, error: null });
        try {
          await invoke("file:create", { layer, path, kind, ...(text !== undefined ? { text } : {}) });
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
          const result = await invoke("workflow:move", request);
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

      /** Delete a state file. Refused while anything references it, unless `force`. */
      deleteWorkflow: async (
        stateId: string,
        layer: WorkflowLayer,
        force?: boolean,
      ): Promise<WorkflowMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          const at = await locateState(stateId, layer);
          const result = await invoke("workflow:delete", { stateId, layer, ...(force === true ? { force } : {}) });
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
          const result = await invoke("file:rename", { layer, path, to, ...(force === true ? { force } : {}) });
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
          const result = await invoke("file:delete", { layer, path, ...(force === true ? { force } : {}) });
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
          return await invoke("state:slots", { stateIds });
        } catch {
          return null;
        }
      },

      /**
       * Turn word wrap on or off in the JSON editor.
       *
       * Written through to `settings.json` like the theme is, so the choice outlives the window. The
       * local patch lands first: waiting for the round-trip would make the toggle feel like it had
       * not registered, and a failed write leaves the setting where the file says it is on next read.
       */
      setWrapJson: async (wrapJson: boolean) => {
        patch({ settings: { ...ref.current.settings, wrapJson } });
        try {
          patch({ settings: await invoke("settings:write", { wrapJson }) });
        } catch (e) {
          fail(e);
        }
      },

      // --- the Debug view's self-test (DESIGN §11.3) --------------------------

      /** Re-read the three state files — what the pane's status line reports. */
      debugRefresh: () => {
        void refreshDebugFiles();
      },

      /**
       * Write the self-test's state files into the shared root.
       *
       * `force` is the difference between the two buttons. Without it only what is MISSING is
       * written, so a file somebody edited to try something is left alone; with it all three are
       * put back to what this build says they are.
       */
      debugInstall: async (force = false) => {
        patchDebug({ busy: true, error: null });
        try {
          const wanted = selfTestFiles();
          const present = new Map(ref.current.debug.files.map((f) => [f.stateId, f]));
          for (const stateId of SELF_TEST_STATES) {
            if (!force && present.get(stateId)?.exists === true) continue;
            await invoke("workflow:write", {
              stateId,
              layer: "base",
              text: JSON.stringify(wanted[stateId], null, 2),
            });
          }
          patchDebug({ busy: false });
          await Promise.all([refreshDebugFiles(), refreshTree()]);
        } catch (e) {
          patchDebug({ busy: false, error: (e as Error).message });
        }
      },

      /**
       * Install what is missing, make a task for the self-test, and start it.
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
      /**
       * Run the self-test, in JaiRA's own project.
       *
       * It always belonged there and said otherwise. The self-test's states are written to the
       * SHARED root — deliberately, so that "does any of this work" is a fact about the installation
       * rather than three debug files in whatever repository happened to be open — and then the run
       * was recorded in the focused project, which put JaiRA's own runs on the user's board and, with
       * no project open, refused with "Open a project first". That refusal was the wrong half of the
       * contradiction to resolve: an empty window is exactly where someone reaches for a self-test,
       * because it is what you press when nothing else is working yet.
       *
       * Same rule as everything else that lives in the shared root — see `runTargetOf`.
       */
      debugRun: async (options: { scripted?: boolean; fresh?: boolean } = {}) => {
        patchDebug({ busy: true, error: null });
        try {
          // Missing files only. A run must never silently discard an edit somebody made to the
          // workflow it is about to run — that is the one thing this pane is watching.
          const wanted = selfTestFiles();
          for (const stateId of SELF_TEST_STATES) {
            const at = ref.current.debug.files.find((f) => f.stateId === stateId);
            if (at?.exists === true) continue;
            await invoke("workflow:write", {
              stateId,
              layer: "base",
              text: JSON.stringify(wanted[stateId], null, 2),
            });
          }
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

          await invoke("task:start", {
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

      /** Remember which tab a state file's editor is on, so returning to the file returns to it. */
      setEditorTab: (key: string, tab: "form" | "json") =>
        patch({ editorTab: { ...ref.current.editorTab, [key]: tab } }),

      /** Hold one box of a state's run form. See {@link AppState.runValues} on why `""` is stored. */
      setRunValue: (stateId: string, name: string, text: string) =>
        patch({
          runValues: {
            ...ref.current.runValues,
            [stateId]: { ...(ref.current.runValues[stateId] ?? {}), [name]: text },
          },
        }),

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
          const at = project ?? ref.current.projectDir ?? undefined;
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
          await invoke("task:start", { taskId: summary.taskId, ...(project !== undefined ? { project } : {}) });
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
            await invoke("workflow:write", { stateId: doc.stateId, layer: doc.layer, text });
          } else {
            await invoke("file:write", { layer: doc.layer, path: doc.path, text });
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
      locateState,
      owningProject,
      refreshConversation,
      refreshSession,
      refreshSharedTasks,
      focusStateRun,
      refreshDebugFiles,
      afterFileChange,
      refreshTrailState,
      seedTrail,
    ],
  );

  // Actions that call sibling actions read them through here, so the memo above does not have to
  // depend on itself.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  return { state, actions };
}
