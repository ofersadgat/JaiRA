/**
 * View models (DESIGN §11): what the renderer renders. These are plain
 * serializable shapes — the renderer never touches the engine or the database,
 * it only ever sees these (DESIGN §2, "the renderer never touches the engine
 * directly"), so every one of them must survive an IPC round-trip as JSON.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { TaskStatus } from "./task";

/**
 * Per-instance status, derived from the event journal (SPEC §10.1). `blocked` is
 * an input-wiring failure; `waiting_for_user` is an interactive operation that
 * has started and not returned.
 */
export type InstanceStatus =
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed"
  | "canceled"
  | "timeout";

/** The operation an instance is running, as far as the journal shows. */
export interface OperationView {
  kind: "prompt" | "function";
  status: "running" | "completed" | "failed";
  /** Failure reason when `status === "failed"`. */
  reason?: string;
  costUsd?: number;
}

/** One state instance in a task's tree. */
export interface InstanceNode {
  instanceId: number;
  stateId: string;
  /** Key in the parent's `children` map — distinct from `stateId`, since one
   *  state file can be mounted under several keys. */
  childKey?: string;
  parentInstanceId?: number;
  status: InstanceStatus;
  /** Transitions taken so far (SPEC §3.4). */
  iteration: number;
  operation?: OperationView;
  /**
   * True once a sequence reset cleared this instance (DESIGN §4.2): history is
   * preserved, but it no longer contributes to the active path or to
   * `children.<key>` resolution.
   */
  superseded: boolean;
  startedAt: number;
  endedAt?: number;
  /**
   * What this instance was CALLED WITH — the inputs the engine resolved on the way in.
   *
   * Recorded on `instance.entered` since the journal existed and projected nowhere until now. It is
   * what lets a card say which of four `design` runs it is: the state id and the child key are the
   * same on all of them, and the inputs are the only thing that differs.
   *
   * Values are shown previewed in a card header and in full inside the conversation, so they travel
   * whole rather than pre-truncated — the projection does not know which of the two is asking.
   */
  inputs?: Record<string, JsonValue>;
  /**
   * What to call this RUN, resolved from {@link inputs} — see `resolveLabel`.
   *
   * Distinct from the state's own name, which is the same on every run of it. Absent when the state
   * declares no label, and the caller then falls back to listing the inputs.
   */
  label?: string;
  children: InstanceNode[];
}

/** A child that never became an instance because its input wiring failed. */
export interface BlockedChild {
  stateId: string;
  reason: string;
}

/** One step of the active path, outermost first. */
export interface PathStep {
  instanceId: number;
  stateId: string;
  childKey?: string;
}

/** A card on the board: one task, positioned by where its active path runs. */
export interface BoardCard {
  taskId: string;
  title: string;
  /** Task-level status (the runtime row), not the instance status. */
  status: TaskStatus;
  workflow: string;
  /** The deepest active instance's status — what the badge shows. */
  activeStatus?: InstanceStatus;
  /** State id of the deepest active instance. */
  activeStateId?: string;
  activePath: PathStep[];
  /** True when the active path continues below this board level (drill-down). */
  hasSubBoard: boolean;
  labels?: string[];
  updatedAt: number;
  /**
   * When the run ENDED, from the journal — the last instance of it to terminate.
   *
   * Distinct from {@link updatedAt}, which is the task ROW's clock and moves for anything at all
   * that touches the task. This is the fact a finished card reports and the key its lane is sorted
   * by, and neither wants "when did anything last happen to this record".
   *
   * Absent while a run is still going, and for a task that has never run.
   */
  endedAt?: number;
}

/** One column of a board level: a declared child of the level's state. */
export interface BoardColumn {
  /** The parent's `children` key — the column's identity. */
  key: string;
  stateId: string;
  label?: string;
  cards: BoardCard[];
}

/**
 * One level of a board's breadcrumb: the state, and what a person calls it.
 *
 * The label travels WITH the id because the two answer different questions and only one of them is
 * readable. A board draws its columns with `BoardColumn.label`, so double-clicking a column headed
 * "Sync the workflows" and watching `states` appear on the path was the address disagreeing with the
 * thing you had just clicked — the same state under two names, one of which was a file name.
 *
 * Resolved exactly as the column's is: the parent's declared override first, then the state's own.
 */
export interface BoardCrumb {
  stateId: string;
  label?: string;
}

/**
 * One board level. The root board's `level` is the workflow root; drilling into
 * a card whose active state has children yields that state's board.
 */
export interface BoardView {
  /** State id this board shows the children of. */
  level: string;
  label?: string;
  /** Breadcrumb from the workflow root down to `level`, inclusive. */
  breadcrumb: BoardCrumb[];
  columns: BoardColumn[];
  /**
   * Cards whose active path reaches this level but is not inside any declared
   * child — the level's own operation is running (or it has just been entered).
   */
  atLevel: BoardCard[];
  /**
   * The tasks on this board that have ENDED — completed, failed or canceled.
   *
   * A CENSUS and not a bucket: every card here is also in the column it came to rest in. It used to
   * be the other way round — a terminal task had no active path, so it had no column and this was
   * where it went — which filed a card under a status instead of under a place, and left a board
   * with a tray at the bottom holding everything the columns had refused.
   *
   * What it is for now is the question a column cannot answer: which runs of this level are OVER,
   * most recent first. See `StateView.tasksRecent`.
   */
  finished: BoardCard[];
}

/** A recorded event, as the detail view's timeline shows it. */
export interface TimelineEntry {
  seq: number;
  runId: number;
  type: string;
  at: number;
  instanceId?: number;
  stateId?: string;
  /** The event payload, for the raw view. */
  event: JsonValue;
}

/** One execution attempt of a task. */
export interface RunView {
  runId: number;
  outcome: "success" | "error" | "canceled" | "interrupted" | "running";
  snapshotHash: string;
  startedAt: number;
  endedAt?: number;
  outputs?: JsonValue;
  failure?: JsonValue;
}

/** The task detail panel (DESIGN §11.1). */
export interface TaskDetail {
  taskId: string;
  title: string;
  description?: string;
  labels?: string[];
  workflow: string;
  status: TaskStatus;
  snapshotHash?: string;
  branch?: string;
  /** Git worktree this task runs in, when bound to a branch (DESIGN §9.2). */
  worktreePath?: string;
  createdAt: string;
  inputs?: Record<string, JsonValue>;
  /** Instance forest for the latest run (roots first). */
  instances: InstanceNode[];
  activePath: PathStep[];
  blocked: BlockedChild[];
  runs: RunView[];
  /** Most recent events last. */
  timeline: TimelineEntry[];
}

// --- workflow browser (DESIGN §11.1) ----------------------------------------

/** Errors block a task start (§5.2); warnings are advisory. */
export type LintSeverity = "error" | "warning";

/**
 * One lint diagnostic. Structurally the engine's `ValidationIssue` plus a
 * severity — restated here so the renderer's types never reach into
 * `@declarative-ai/hw`.
 */
export interface LintIssue {
  stateId: string;
  /** Where in the state file, e.g. `transitions[2].when`. */
  path: string;
  message: string;
  severity: LintSeverity;
}

/**
 * Which layer of the search path supplied a state file.
 *
 * `project` is the project's own `.jaira/`; `base` is the shared root behind every project on the
 * machine. The distinction is not cosmetic — editing a `base` file changes every project that has
 * not overridden it, so the UI has to be able to say so before someone types.
 */
export type WorkflowLayer = "project" | "base";

/** One state file in the browser's tree. */
export interface WorkflowFileEntry {
  stateId: string;
  /** Path relative to the root that supplied it, forward slashes. */
  file: string;
  label?: string;
  /** Set when the file could not be read or parsed (the author is mid-edit). */
  error?: string;
  /** Which layer this file came from. */
  layer: WorkflowLayer;
  /** The root it is relative to, absolute — what an editor needs to open it. */
  root: string;
  /**
   * Set on a BASE file that a project file of the same state id shadows. The base copy is inert in
   * this project: it is listed so the override is visible rather than looking like a missing file.
   */
  shadowed?: boolean;
}

/** A workflow root and its lint state. */
export interface WorkflowEntry {
  rootId: string;
  label?: string;
  /** Every state in the root's transitive closure, in id order. */
  states: string[];
  /** Identity of the workflow as it stands on disk, comparable to a task's pin. */
  snapshotHash?: string;
  issues: LintIssue[];
  /** Set when the bundle could not be loaded at all, so `issues` is empty. */
  loadError?: string;
  taskIds: string[];
  /** Tasks pinned to a snapshot other than what is on disk now. */
  driftedTasks: string[];
  /** Which layer supplied this root's own state file. */
  layer: WorkflowLayer;
}

export interface WorkflowBrowser {
  workflows: WorkflowEntry[];
  files: WorkflowFileEntry[];
  /** States no root reaches — a reference cycle, or a failed load above them. */
  unreachable: string[];
}

// --- the file tree (DESIGN §11.1, the Files view) ----------------------------

/**
 * What a file in `.jaira/` is, as far as the tree cares.
 *
 * `workflow` is the only kind that maps to a state id and therefore opens a board; the rest exist so
 * prompts and skills stop being `$ref` strings typed from memory and become things you can find.
 */
export type FileKind = "directory" | "workflow" | "prompt" | "skill" | "config" | "other";

/**
 * What linting knows about one node of the tree.
 *
 * The tree used to say only whether a file PARSED, which is the smallest of the things that can be
 * wrong with it. A state that parses perfectly and forgets to wire a child's required input is a
 * state that cannot run, and until this existed you had to click every file to find out.
 *
 * `unchecked` is the third state and the reason this is not just two numbers. A state no workflow
 * root reaches is never validated at all, so zero errors on it means "nobody looked", not "clean" —
 * and those are opposite things to believe before starting a task.
 */
export interface FileLint {
  /** Errors on this file; on a directory, the total below it. */
  errors: number;
  /** Warnings, counted the same way. */
  warnings: number;
  /**
   * Set on a state file nothing validated: no root's closure reaches it, or the root that would
   * have failed to load. Never set on a directory — an aggregate "some of this was not checked"
   * reads as a claim about the whole subtree.
   */
  unchecked?: boolean;
}

/** One entry in the two-root file tree. Directories carry `children`. */
export interface FileNode {
  /** Path relative to the root that supplied it, forward slashes. */
  path: string;
  name: string;
  kind: FileKind;
  /**
   * The MIME type, from {@link mimeOfPath} — what the Files view resolves its surfaces on.
   *
   * Carried on the node rather than re-derived in the renderer so the tree and the panel can never
   * disagree about what a file is, and so the classification lives on one side of the IPC boundary.
   */
  mime: string;
  layer: WorkflowLayer;
  /** The state this file defines, when `kind` is `workflow`. */
  stateId?: string;
  /** Set on a BASE file that a project file of the same state id shadows (see {@link WorkflowFileEntry}). */
  shadowed?: boolean;
  /** Set when the file could not be read or parsed. */
  error?: string;
  /** Lint state, joined from the workflow browser. Absent on a node nothing is known about. */
  lint?: FileLint;
  children?: FileNode[];
}

/**
 * Both roots, in search-path order: the project's `.jaira/` first, the shared root second.
 *
 * Showing them as two trees rather than one merged list is what removes the layer picker — which
 * copy of a state you are editing is its position on screen, not a mode you have to remember.
 *
 * A root is listed whether or not it exists on disk. The shared root is a place you can put things
 * before it is a directory, and hiding it until someone has already used it would mean the one
 * affordance for "share this across projects" only appears once you have found another way to do
 * it. `exists` is false in that case, so the tree can say so rather than showing a bare "empty".
 */
export interface FileTree {
  roots: Array<{ layer: WorkflowLayer; dir: string; exists: boolean; nodes: FileNode[] }>;
}

// --- one state, as the Files view shows it -----------------------------------

/** A declared child of a state — one column of its board. */
export interface StateChild {
  /** Key in the parent's `children` map; the column's identity. */
  key: string;
  stateId: string;
  label?: string;
  /** True when this child has children of its own, so its column can be walked into. */
  hasChildren: boolean;
}

/**
 * One slot a state declares, as a PARENT needs it — enough to wire it and nothing more.
 *
 * Deliberately not the whole `ParameterDecl`: the parent authors a BINDING, and a binding needs the
 * slot's name, whether it has to be there, and something to hover over. The schema is the child's
 * business.
 */
export interface StateSlotInfo {
  name: string;
  /** True when the slot need not be wired: `optional`, or carrying a `default` (SPEC §4.1). */
  optional: boolean;
  description?: string;
}

/**
 * Both halves of a child's surface — what it takes, and what it hands back.
 *
 * The authoring form needs both and for different reasons, which is why they travel together rather
 * than as two lookups. `inputs` is what a mount must FILL: the wiring table opens showing the slots
 * that have to be bound, instead of an empty list the author fills from memory — which is what made
 * "required child input 'x' is not wired" a lint error people met after saving rather than a blank
 * they were looking straight at. `outputs` is what a binding may POINT AT: every
 * `.children.<key>.outputs.<name>` a sibling or the parent could read, so a binding is picked from a
 * list rather than typed from memory and got subtly wrong.
 */
export interface StateSlots {
  inputs: StateSlotInfo[];
  outputs: StateSlotInfo[];
}

/**
 * The environment a state's operation would run in.
 *
 * `available` is the executor-availability rule made visible: the executors enabled in settings
 * *are* the default environment, so naming one that is off is an authoring error the state view
 * reports rather than a surprise 40 seconds into a run.
 */
export interface StateEnvironment {
  /** The function the operation names, when it is a function op. */
  executor?: string;
  /** False when `executor` is named but not enabled/reachable here. */
  available: boolean;
  /** Set when the executor came from an ancestor rather than this state. */
  from?: string;
}

/** One transition off a state. Deliberately not what orders the board's columns. */
export interface StateTransition {
  when: string;
  to: string;
  /** True when `to` re-enters this state or an ancestor of it — a loop, worth marking. */
  loops: boolean;
}

/** A reference a state makes, and whether it resolved. */
export interface StateReference {
  ref: string;
  resolved: boolean;
  /** Which layer supplied it, when it resolved. */
  layer?: WorkflowLayer;
}

/**
 * Everything the Files view needs about the one state selected in the tree.
 *
 * Deliberately one round trip: the middle panel and the inspector are two renderings of the same
 * subject, and fetching them separately is how they end up disagreeing about which state is open.
 */
export interface StateView {
  stateId: string;
  label?: string;
  layer: WorkflowLayer;
  /** Absolute path of the file that defines it. */
  file: string;
  exists: boolean;
  /** The workflow root whose closure contains this state, when one does. */
  rootId?: string;
  operation?: {
    kind: "prompt" | "function";
    functionRef?: string;
    model?: string;
  };
  children: StateChild[];
  /**
   * The board of this state's children, already projected — null when the state is a leaf, which is
   * what makes the Files view render a task list instead.
   */
  board: BoardView | null;
  /** Tasks whose active path is inside this state right now (what a leaf shows). */
  tasksHere: BoardCard[];
  /** Tasks that have passed through and finished, newest first — so an idle leaf still says something. */
  tasksRecent: BoardCard[];
  transitions: StateTransition[];
  environment: StateEnvironment;
  issues: LintIssue[];
  references: StateReference[];
  /** States that declare this one as a child. */
  referencedBy: string[];
  /** Tasks in this state pinned to a snapshot older than what is on disk (DESIGN §5.3). */
  driftedTasks: string[];
  /**
   * True when this was read from the file alone, with no project open.
   *
   * The shared root is browsable without a project, but the things that need a project's reference
   * graph — lint issues, `referencedBy`, drift, and every task list — are then UNKNOWN rather than
   * empty. The distinction matters: an empty `referencedBy` would otherwise read as "nothing depends
   * on this", which is exactly the wrong thing to believe before renaming it.
   */
  fileOnly?: boolean;
}

// --- the conversation inside one task ----------------------------------------

/**
 * One turn of a run, read back out of the event journal.
 *
 * The journal is the only record there is, so this is a projection of it rather than a separate
 * transcript: what the operation did, what it called, whether its output validated, and every point
 * a human was asked something.
 */
export type TurnKind = "operation" | "tool" | "output" | "policy" | "interaction" | "failure" | "transition";

export interface ConversationTurn {
  seq: number;
  at: number;
  kind: TurnKind;
  stateId?: string;
  /** The message, command, or reason — whatever this kind's one line is. */
  text?: string;
  /** Tool name, for `tool` turns. */
  tool?: string;
  /** Whether the thing succeeded, where that is meaningful. */
  ok?: boolean;
  /** Structured payload, for `output` turns. */
  data?: JsonValue;
}

export interface ConversationView {
  taskId: string;
  title: string;
  runId?: number;
  turns: ConversationTurn[];
  /** The interaction this task is parked on, when it is one. */
  waitingOn?: { requestId: string; component: string };
}

// --- history pruning (SPEC §13) ----------------------------------------------

/** One run's worth of history in a prune plan. */
export interface PrunePlanEntry {
  taskId: string;
  runId: number;
  endedAt?: number;
  events: number;
  commands: number;
}

/** What a prune did, or (when `dryRun`) would do. */
export interface PruneResult {
  runs: PrunePlanEntry[];
  events: number;
  commands: number;
  /** Tasks the §13 safety rule refused to touch, with the reason. */
  skippedTasks: Array<{ taskId: string; status: string; reason: string }>;
  dryRun: boolean;
}

/** Rows currently stored — the "before you prune" summary. */
export interface HistorySize {
  runs: number;
  events: number;
  commands: number;
}

/**
 * One project this window can draw a board for.
 *
 * The Tasks view groups by project rather than merging: a board is per workflow ROOT, so columns from
 * two projects side by side would be columns of different things.
 */
export interface ProjectSummary {
  /** The project directory — the key every project-scoped channel takes. */
  project: string;
  /** What to call it in a group header. */
  label: string;
  /** `shared` is the selected root as a project; `system` is JaiRA's own. See `SHARED_SESSION`. */
  kind: "user" | "shared" | "system";
  tasks: number;
  running: number;
}

/** A row in the task list. */
export interface TaskSummary {
  taskId: string;
  title: string;
  status: TaskStatus;
  workflow: string;
  labels?: string[];
  snapshotHash?: string;
  /**
   * The task this one was spawned FOR — a sync's review round, a worktree review. What lets the
   * root listing file a subsidiary run under the flow it originated from rather than presenting its
   * workflow as a top-level one. May name a task in another project's store, in which case it
   * simply does not resolve here.
   */
  parentTaskId?: string;
  createdAt: string;
  updatedAt: number;
}

/**
 * One state instance and the conversation its operation ran in — a row of the task's history.
 *
 * "Every state the executor went through, with its session", which is one half of what selecting a
 * task at a leaf must answer. Derived from the journal: hw puts the position a call ended at on
 * `operation.completed`'s metrics, so the link needed nothing new recorded.
 */
export interface SessionRef {
  runId: number;
  instanceId: number;
  stateId: string;
  /** The conversation. Opaque — the UI shows it, nothing parses it. */
  sessionId: string;
  /** Where this operation's record sits in that conversation. */
  seq: number;
  at: number;
  /**
   * When the CALL began — `operation.started`, not the instance's entry.
   *
   * The two differ by the whole of a subtree for a composite that both delegates and speaks, and the
   * difference is what decides whether two sessions were running at the same time. A conversation
   * laid out with vertical space standing for time needs the operation's own span; the instance's is
   * an envelope around it. Absent for a run journaled before this was projected.
   */
  startedAt?: number;
  /** Present once the operation settled. */
  status?: "success" | "error";
  costUsd?: number;
  /** What the call consumed and what that number is worth — see {@link RunMetrics}. */
  metrics?: RunMetrics;
}

/**
 * What one call (or one whole run) actually consumed.
 *
 * Recorded on `operation.completed` all along and shown nowhere, which made a cost figure something
 * to either believe or not. Tokens are the thing that makes it checkable: `$0.21` beside 40k cached
 * input tokens is a Claude Code session doing ordinary work, and beside 300 tokens it is a bug —
 * and until these were on screen those two looked identical.
 *
 * Split the way it is BILLED rather than into one input number, because the rates differ by an order
 * of magnitude: a cache read costs about a tenth of the base rate and a 1-hour cache write about
 * twice it, so a single "input" figure cannot be priced and cannot be checked against a total.
 */
export interface RunMetrics {
  /** How much a cost figure can be trusted: the provider's own charge, our price table, or a guess. */
  costSource?: "provider" | "table" | "unknown";
  /** Total input, INCLUDING cache reads and writes — the provider's billed input. */
  inputTokens?: number;
  outputTokens?: number;
  /** Uncached input, billed at the base rate. */
  noCacheTokens?: number;
  /** Cache hits, billed at roughly a tenth of the base rate. */
  cacheReadTokens?: number;
  /** Input written to the cache, billed above the base rate. */
  cacheWriteTokens?: number;
  /** Reasoning output, a subset of {@link outputTokens}. */
  reasoningTokens?: number;
  /** Wall-clock for the call, ms. */
  durationMs?: number;
}

/**
 * One turn of a conversation, as the viewer renders it.
 *
 * Deliberately close to what the provider returned rather than a projection of it: a delegated agent
 * hands back every message, tool call and result on the same wire, and the record stores that
 * verbatim. Flattening it here would throw away exactly what a session view is for.
 */
export interface SessionTurn {
  role: string;
  /** The turn's text, when it has any — a tool-call turn does not. */
  text?: string;
  /** Tool calls and their results, kept structured so a viewer can pair and collapse them. */
  parts?: JsonValue;
}

/**
 * The conversation ONE state instance ran.
 *
 * A leaf state runs one operation, which is one record at one position — and for a delegated agent
 * that single operation contains the agent's whole loop. So this is the whole thing, undivided.
 */
export interface SessionView {
  taskId: string;
  runId: number;
  instanceId: number;
  stateId: string;
  sessionId: string;
  seq: number;
  /** The agent's own session handle, when it had one — what lets its native transcript be found. */
  providerSessionId?: string;
  status?: "success" | "error";
  costUsd?: number;
  turns: SessionTurn[];
  /**
   * Subagent conversations, keyed by the tool call that spawned each — a `Task` call's turns, read
   * the same way `turns` is. The viewer renders the spawning call as a link into them rather than
   * folding them into the thread they did not happen in.
   */
  sidechains?: Record<string, SessionTurn[]>;
  /**
   * The provider events the record pinned among its messages — session init, compaction
   * boundaries, rate-limit windows — opaque payloads with no neutral home, `index` counting the
   * turns that preceded each, so the viewer can interleave them where they happened. Distinct from
   * {@link native}: these rode the STREAM and were recorded live; the native lines never rode it.
   */
  providerEvents?: Array<{ index: number; event: JsonValue }>;
  /**
   * Lines of the agent's OWN session file that never rode the stream — its context injections
   * (`attachment` lines), structured tool-execution records (`toolUseResult` on message envelopes),
   * and bookkeeping (`queue-operation`, `ai-title`) — captured into the record at operation close,
   * in file order. Absent for a record closed before capture existed, or a transport with no file.
   */
  native?: Array<{ index: number; line: JsonValue }>;
  /** Set when the state ran in no conversation at all — a function op, or a run before this existed. */
  empty?: string;
}

/** How bad an entry is. Filtering by one means "this and worse", not "this exactly". */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One line of what the app did.
 *
 * Three streams share this shape because they answer one question — "what happened, and where do I
 * look next" — and keeping them apart in the UI would mean three panels nobody correlates. What makes
 * a row actionable is its POINTERS: `taskId` opens the task, `instanceId` selects the state inside it,
 * `jobId` opens that process's captured output.
 */
export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  /** Where it came from — `ipc`, `engine`, `process`, `project`, `availability`, `app`. */
  source: string;
  message: string;
  /** The session key of the project it concerns, when it concerns one. */
  project?: string;
  taskId?: string;
  runId?: number;
  instanceId?: number;
  jobId?: number;
  /** A stack, an argv, an exit code — whatever the reader would want and the message cannot hold. */
  detail?: JsonValue;
}

/** A process JaiRA claimed or started (DESIGN §4.2a). Named here so the renderer can read one. */
export type JobKind = "run" | "process";

export interface JobRow {
  id: number;
  kind: JobKind;
  taskId?: string;
  runId?: number;
  parentJobId?: number;
  ownerToken: string;
  pid?: number;
  command?: string;
  /** Where it ran. Received from the observer and, until there was a column, dropped. */
  cwd?: string;
  startedAt: number;
  heartbeatAt: number;
  cancelRequestedAt?: number;
  endedAt?: number;
  outcome?: string;
}

/**
 * A slice of what a child process printed.
 *
 * `dropped` is the bytes elided immediately BEFORE this chunk. The capture keeps a head and a tail
 * and discards the middle, so a reader who cannot see the gap would misread the tail as the whole.
 */
export interface JobOutputChunk {
  id: number;
  jobId: number;
  stream: "stdout" | "stderr";
  seq: number;
  chunk: string;
  dropped: number;
  createdAt: number;
}
