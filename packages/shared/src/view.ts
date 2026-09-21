/**
 * View models (DESIGN §11): what the renderer renders. These are plain
 * serializable shapes — the renderer never touches the engine or the database,
 * it only ever sees these (DESIGN §2, "the renderer never touches the engine
 * directly"), so every one of them must survive an IPC round-trip as JSON.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { TaskStatus } from "./task";
import type { InputProvenance } from "./adopt";
import type { FastForwardView, SettledByView } from "./fastForward";
import type { ModuleApproval } from "./refusal";

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
  | "timeout"
  /** A person's move stepped past it (decision 0005): interrupted by a Skip, or never entered. */
  | "skipped";

/** The operation an instance is running, as far as the journal shows. */
export interface OperationView {
  kind: "prompt" | "function";
  status: "running" | "completed" | "failed";
  /** Failure reason when `status === "failed"`. */
  reason?: string;
  /**
   * The failure's classification, when it failed — `"interrupted"` is the one readers act on: the
   * call was CUT (a stop, or the process dying under it) rather than answered with an error, which
   * is what separates "continue this" from "retry this" at the frontier.
   */
  classification?: string;
  costUsd?: number;
}

/**
 * One step of an instance ADDRESS: a child key, and which time through it this is.
 *
 * The only name in the system that means the same thing in two runs. Instance ids are minted
 * `nextInstanceId++` as the engine walks, so two runs agree about them by luck; a content hash
 * repeats whenever a loop dispatches the same operation twice. The address is a position in the
 * workflow, and it survives — which is why `replay.ts` keys every recorded answer on it.
 *
 * READONLY, as hw's is — an address is a position, and nothing has any business editing one.
 *
 * Restated here rather than imported because this package is what the RENDERER reads and hw is the
 * engine. `replay.ts` asserts the two shapes stay assignable, so a field added upstream fails a
 * build rather than quietly splitting into two vocabularies.
 *
 * ⚠️ Compared STRUCTURALLY, step by step. `addressKey` exists and is the right thing for a `Map`
 * inside one process; it is not an identity. It joins with `/` and `#`, neither of which is reserved
 * in a child key, so a key containing either produces a string nothing can read back — the same trap
 * `parseSessionRef` documents for `@`. Encode it for a lookup, never to store or to send.
 */
export interface AddressStep {
  childKey: string;
  occurrence: number;
  /**
   * The element position under a mount that FANS OUT (`each: true` on one of its wires,
   * WORKFLOWS.md §6.2). The elements of one entry share an occurrence and differ here; an ordinary
   * entry has none, and none is not 0.
   */
  element?: number;
}

/** Where an instance sits in the workflow — the root is the empty address. See {@link AddressStep}. */
export type InstanceAddress = readonly AddressStep[];

/**
 * One address step as a PATH SEGMENT — the spelling a journal path uses for the same place.
 *
 * `build` for an ordinary entry, `build[0]` for the first element of a fan-out: the element is part
 * of where the instance is, and a path that dropped it would name the mount rather than the
 * instance. The conversation's notes are spelled this way by the projection, and its panels are
 * placed by their address; the rail reads both, so the two have to agree — when they did not, every
 * panel under a fan-out closed every lane and opened them again, and the rail read as broken.
 */
export function addressSegment(step: AddressStep): string {
  return step.element === undefined ? step.childKey : `${step.childKey}[${step.element}]`;
}

/** The child key of a path segment: `build[0]` → `build`. What a lane is called and coloured by. */
export function segmentKey(segment: string): string {
  return segment.replace(/\[\d+\]$/, "");
}

/** One state instance in a task's tree. */
export interface InstanceNode {
  instanceId: string;
  stateId: string;
  /** Key in the parent's `children` map — distinct from `stateId`, since one
   *  state file can be mounted under several keys. */
  childKey?: string;
  /**
   * Which element of a fanned-out mount this is (WORKFLOWS.md §6.2) — what tells the third element
   * of a batch from the third pass of a loop, which are otherwise the same thing in a journal: one
   * more entry under one key in one parent. A pass supersedes the one before it; an element sits
   * beside its siblings. Absent for an ordinary entry.
   */
  element?: number;
  parentInstanceId?: string;
  status: InstanceStatus;
  /** Transitions taken so far (SPEC §3.4) — every one, not just a loop's passes. */
  index: number;
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
   * The TASK this element became, when a fan-out made one of it (decision 0003). Such a node has no
   * operation and no children of its own — its work is in that task — so a conversation draws it as
   * a line rather than a panel, and a board files the task by it.
   */
  made?: { taskId: string; kind: "split" | "task" | "adopt" };
  /**
   * How each of {@link inputs} was settled (decision 0005 §4) — `bound` by the workflow's wiring,
   * `inferred` by a conversation, `asked` of a person. Per input name; an input with no entry was
   * recorded before provenance was.
   */
  inputProvenance?: Record<string, InputProvenance>;
  /**
   * The control conversation answered this instance's question FOR the person (decision 0005 §4).
   *
   * Only ever set on a state whose operation is an interactive one, and only from the
   * `jaira.answered` row a fast-forward's `answer` wrote. It carries the journal seq it was written
   * at, which is what "Answer it yourself" rewinds to.
   */
  settledBy?: SettledByView;
  /**
   * What to call this RUN, resolved from {@link inputs} — see `resolveLabel`.
   *
   * Distinct from the state's own name, which is the same on every run of it. Absent when the state
   * declares no label, and the caller then falls back to listing the inputs.
   */
  label?: string;
  /**
   * Where this instance sits, as an address — see {@link AddressStep}.
   *
   * Stamped by the projection, because that is where the walk already happens. Doing it there
   * rather than in the renderer keeps every consumer speaking one language: a second walk counting
   * occurrences even slightly differently would disagree about which iteration of a loop a panel
   * belongs to, and nothing would say so.
   *
   * Absent on a projection built before this existed.
   */
  address?: InstanceAddress;
  /**
   * Every call this instance dispatched, in dispatch order — see {@link OperationCall}.
   *
   * Absent on a projection built before this existed, and empty is a different answer from absent
   * only in principle: a state that dispatched nothing simply has no entry.
   */
  calls?: OperationCall[];
  /**
   * This instance's computed TITLE, once it has settled (SPEC §5.2) — the latest `value.settled`
   * event for the field `title`.
   *
   * Absent means nothing has settled: either the state declares no title, or it does and the value
   * is still PENDING. Which of the two is a question about the STATE, answered by the workflow shape
   * rather than the journal — see `headingOf`.
   */
  title?: InstanceTitle;
  children: InstanceNode[];
}

/**
 * A settled `title` field, as the journal recorded it (`value.settled`, SPEC §5.3).
 *
 * `outcome: "error"` WITH a `text` is a fallback: the binding failed and its `failureValue` stood
 * in, so the text is displayable and `error` says why it is not the computed one. With no `text` the
 * binding failed with nothing to stand in, and the instance failed with it.
 */
export interface InstanceTitle {
  outcome: "value" | "error";
  text?: string;
  fallback?: boolean;
  error?: string;
}

/**
 * The name a task displays, derived from its path (SPEC §5.2): the title of the nearest instance
 * whose state declares one, or that state's label while the title is still settling.
 *
 * Absent from a card or a detail when no state on the path declares a title — the task's own
 * `title` is the name then, as it always was.
 */
export interface TaskHeading {
  text: string;
  /** The title has not settled yet, so {@link text} is the declaring state's label standing in. */
  pending?: boolean;
  /** The title's binding failed and its `failureValue` is what {@link text} shows. */
  fallback?: boolean;
  /** Why the title could not be computed — on a fallback, or on a failure that left only the label. */
  error?: string;
  /** The instance the title belongs to, and its state. */
  instanceId: string;
  stateId: string;
}

/** A child that never became an instance because its input wiring failed. */
export interface BlockedChild {
  stateId: string;
  reason: string;
}

/** One step of the active path, outermost first. */
export interface PathStep {
  instanceId: string;
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
  /** The name the task's path gives it, when a state on the path declares a title — see {@link TaskHeading}. */
  heading?: TaskHeading;
  /** The dependencies still unfinished — non-empty means the card is holding. See {@link Holding}. */
  waitingFor?: Holding[];
  /** Where the question is open when it is open on a FORGE — see {@link InReview}. */
  inReview?: InReview;
  /** How a fan-out made this task, when one did — the word the card's origin line uses. */
  origin?: TaskOrigin;
  /**
   * The task this card files BENEATH (decision 0005 §2): an adopted task, under the task that
   * adopted it. A board draws it indented under that card when both are in one column — the root
   * listing always, a level's board when the parent stands in the child's column — and as an
   * ordinary card otherwise.
   */
  under?: string;
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
/**
 * A task whose question is open on a forge (decision 0004).
 *
 * What the board card says instead of "waiting for you": the person running JaiRA is not necessarily
 * who is being waited on, and a card that claims they are is a card they learn to ignore.
 */
export interface InReview {
  provider: string;
  number: number;
  url: string;
}

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
  type: string;
  at: number;
  instanceId?: string;
  stateId?: string;
  /** The event payload, for the raw view. */
  event: JsonValue;
}

/**
 * The machine's execution summary — when it last started, how it ended, what it produced.
 *
 * One per task since the runs collapse (Identity and Resume §05): a resume CONTINUES the machine
 * under the same task, and a re-run is a new task linked by `parentTaskId`, so there is no second
 * attempt to list and no run-scale fork mark to draw. The name survives because "the run" is still
 * what a person calls a task's execution.
 */
export interface RunView {
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
  /** Where this task was forked from, when it is a fork — see {@link TaskOrigin}. */
  origin?: TaskOrigin;
  /** The dependencies still unfinished — non-empty means the task is holding. See {@link Holding}. */
  waitingFor?: Holding[];
  /**
   * Instance forest for the TASK — its one machine, projected from its one journal.
   *
   * Instance ids are durable and a resume continues them, so the whole history projects in one
   * pass; the fold-by-position that reconciled re-walked attempts went with the runs table.
   */
  instances: InstanceNode[];
  activePath: PathStep[];
  blocked: BlockedChild[];
  /** The name the task's path gives it, when a state on the path declares a title — see {@link TaskHeading}. */
  heading?: TaskHeading;
  /** Empty for a task that never started; otherwise the machine's one summary. */
  runs: RunView[];
  /** Most recent events last. */
  timeline: TimelineEntry[];
  /**
   * What resuming would do, for a task that could still start.
   *
   * Absent for every other status, which is the same answer as `kind: "none"` and cheaper: the
   * service only folds a task's journal when there is a button whose wording depends on it.
   */
  resume?: ResumePlan;
  /**
   * The task is being FAST-FORWARDED (decision 0005 §4) — what the activity strip says while it is.
   *
   * Live only: the mode is held by the process driving the run, and nothing in the journal is a
   * fast-forward. Absent the moment it arrives, is skipped, fails or is stopped.
   */
  fastForward?: FastForwardView;
}

/**
 * What resuming a stopped task would do — enough for a button to say it truthfully.
 *
 * The distinction the UI turns on is `kind`, and it is a fact about how the run ENDED rather than a
 * preference:
 *
 *  - `continue` — instances were still live when it stopped, which is what a process dying looks
 *    like. There is somewhere to pick up, and {@link frontier} says where.
 *  - `retry` — nothing is live. A state failed and the run ended with it, so every instance
 *    terminated; the frontier is empty by construction. Resuming replays everything that completed
 *    and re-runs the state that failed, with its history intact.
 *  - `none` — there is nothing to resume, or the record cannot be read (see {@link blocked}). The
 *    caller offers a plain re-run instead.
 */
export interface ResumePlan {
  taskId: string;
  /**
   * What starting this task again would DO — the one answer every surface asks for.
   *
   *  - `continue` / `retry` — the machine is loaded and picked up where it stopped, under the same
   *    task id. The two differ only in what is left: something in flight, or the state that failed.
   *  - `fresh` — nothing is recorded, so the task simply STARTS, in place. It is what a queued task
   *    is, and what a start that died before the engine journaled anything leaves behind: no tree,
   *    no conversations, nothing a fresh walk could contaminate.
   *  - `none` — it cannot be picked up and it cannot safely be walked again either (there is history,
   *    and it is unreadable or unloadable), so the only honest offer is a COPY: a new task with the
   *    same inputs. See `service.rerunTask`.
   */
  kind: "continue" | "retry" | "fresh" | "none";
  /** How many operations would be taken from the record rather than run again. */
  replayed: number;
  /** Where it would pick up — for `retry`, the state that gets another go. Empty otherwise. */
  frontier: Array<{ stateId: string; stopped: "mid-operation" | "between-children" }>;
  /**
   * Why resuming is refused, when it is.
   *
   * Present only with `kind: "none"` and only for the unreadable-record case — "there is nothing
   * here to resume" needs no reason, but "this task's history has a hole in it" is something the
   * person deciding what to do next should be told rather than left to infer from a missing button.
   */
  blocked?: string;
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
 *
 * `system` is what JaiRA ships (`$SYSTEM`, decision 0006): the last layer, behind both. It is
 * READ-ONLY — every write surface that takes a layer refuses this one, and "override" means copying
 * the file up into one of the other two.
 */
export type WorkflowLayer = "project" | "base" | "system";

/** The layers a person can write to — every layer but the one that ships. */
export type WritableLayer = Exclude<WorkflowLayer, "system">;

/**
 * Whether a write may land in this layer. The one spelling of the rule, so a new write surface has
 * something to call rather than a comparison to remember.
 */
export function isWritableLayer(layer: WorkflowLayer): layer is WritableLayer {
  return layer !== "system";
}

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
  /**
   * The js/ts module files this root reaches that nobody has approved (SPEC §7.5.5).
   *
   * Set only alongside a `loadError`, and when it is set the load error is a CONSEQUENCE: an
   * unapproved module contributes no symbol, so the call site fails to resolve and reads as a typo.
   * A surface showing both should lead with this one — it is the fault, and it is answerable.
   */
  needsApproval?: ModuleApproval[];
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
  /**
   * WHICH project this file is in, for a `project`-layer node. Absent on the shared root.
   *
   * Stamped on every node rather than looked up from the root it came under, so a file identifies
   * itself: with several projects in one tree (see {@link FileTree}), `{layer, path}` names two
   * different files and everything holding one — a selection, a draft, a write — would have had to
   * carry the root it was found beneath.
   */
  project?: string;
  /** The state this file defines, when `kind` is `workflow`. */
  stateId?: string;
  /**
   * Set on a file a layer AHEAD of it shadows: a base file the project overrides, or a built-in one
   * that either of the others does (see {@link WorkflowFileEntry}).
   */
  shadowed?: boolean;
  /**
   * Set on a project or shared state file whose id JaiRA also ships (decision 0006) — the other end
   * of a built-in row's `shadowed`. It is what lets a row say "this is an override of something that
   * ships" without the tree that holds it also having to hold the built-in root.
   */
  overridesBuiltIn?: boolean;
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
/**
 * Both layer roots — and, since the window holds several projects, one `project` root per open
 * project with the shared one listed ONCE beside them (SHELL.md §2.2).
 *
 * Once beside rather than under each: `~/.jaira` is machine-global, so repeating it per project
 * would draw the same directory three times and invite somebody to wonder which copy they were
 * editing. The projects are the tree's top level and the shared root is their sibling.
 *
 * The LAST root is always what ships (`layer: "system"`, decision 0006): read-only, listed once, and
 * the one root every tree has whatever the shell is standing in — it is behind all of them.
 */
export interface FileTree {
  roots: FileRoot[];
}

export interface FileRoot {
  layer: WorkflowLayer;
  /**
   * Which project this root IS, for a `project` root. Absent on the shared root, which belongs to
   * no project — see {@link FileTree}.
   */
  project?: string;
  /** What to call it: the project's basename, `~/.jaira` for the shared root, `Built in` for what ships. */
  label: string;
  dir: string;
  /**
   * Where this root's LAYER sits inside it, root-relative and without a trailing slash.
   *
   * `.jaira` for an ordinary checkout — the tree is rooted at the checkout, so `workflows/` is at
   * `.jaira/workflows` — and `""` for the shared root, which IS its own layer. Carried rather than
   * re-derived because every question the tree asks about a path is asked through it: whether a
   * directory is under `workflows/` (so it can offer a state), whether it is inside `.jaira/` at all
   * (so it can offer a workflow), and what a new file's path is relative to. A renderer that guessed
   * `.jaira` would be wrong for the shared root and for a checkout whose layer sits directly under
   * it, and the guess is exactly what made "New state here…" unreachable in a project's own
   * `workflows/` folder.
   */
  prefix: string;
  exists: boolean;
  nodes: FileNode[];
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
  /**
   * What this state declares about the conversation its operation joins, exactly as authored.
   *
   * A WRAPPER rather than the value, because `null` is a declaration — the explicit "a fresh stream,
   * private to this call" marker — and absent is not. The two mean opposite things and a bare
   * nullable field cannot tell them apart.
   *
   * Raw rather than resolved, because resolving it needs the ancestry: a session is the pair
   * (name, scope), and `in` names the scope RELATIVE to whoever wrote the declaration. The state
   * that mounts this one is the only thing that knows where it sits, so it is the one that resolves.
   */
  session?: { declared: unknown };
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

/**
 * One call a run made, as the renderer reads it.
 *
 * The complete account of a call, and the reason a state with no model call is explicable at all:
 * `request` carries the callee AND its arguments with their RESOLVED values (an operation's
 * `input.<slot>.binding.json` is the value the engine settled on), and `result` carries what came
 * back. Neither needs the workflow file open beside it.
 *
 * ⚠️ `result` is the stored ENVELOPE — `{ value }`, or `{ error, value? }` — rather than the callee's
 * own value. It is passed through unopened because two readers want different halves: a derivation
 * wants the value, and a failure display wants to know an envelope carried an error even where the
 * status column says `completed`. Unwrapping here would make the second impossible.
 *
 * `recordId` is the CONTENT id: `hashCanonical` of the request. That is what lets a resolved binding
 * find its record without being attributed by time or by state — the address is the request itself,
 * so two instances running at once cannot be confused for one another.
 */
/**
 * ONE CALL an instance dispatched — the handle onto what it actually ran.
 *
 * `operation.dispatched` is the only event that carries an operation id, and the id it carries is
 * the RECORD id: `run:records` returns rows keyed by exactly this string, holding the request (which
 * function, bound to which arguments) and the result. The journal has the attribution and the store
 * has the content, and until this neither side could be reached from the other — so a state that
 * computed its outputs by calling three functions was drawn as a state that did nothing, with the
 * three function names, their arguments and their answers all sitting in the database.
 *
 * Distinct from {@link InstanceNode.operation}, which is the state's OWN operation and is set only
 * on `operation.started`. A state can have none of those and still have dispatched calls: an output
 * bound to a function expression dispatches without the state itself being a function op, which is
 * precisely the shape that read as silence.
 */
export interface OperationCall {
  /** The record id — what `run:records` keys on. */
  operationId: string;
  kind: "prompt" | "function";
}

export interface OperationRecordView {
  recordId: string;
  status: string;
  request?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
  startedAt?: number;
  endedAt?: number;
}

// --- the conversation inside one task ----------------------------------------

/**
 * One turn of a run, read back out of the event journal.
 *
 * The journal is the only record there is, so this is a projection of it rather than a separate
 * transcript: what the operation did, what it called, whether its output validated, and every point
 * a human was asked something.
 */
/**
 * ONE KIND PER JOURNAL EVENT. Three of these used to be `operation`.
 *
 * `instance.entered`, `operation.started` and `instance.terminated` all projected onto a single
 * `operation` kind, and every reader that needed them apart matched on the free-text `text` field
 * against the literal `"entered"` — with `ok === undefined` standing in for "has not finished". That
 * is a discriminated union spelled as a magic string, and it made three different questions
 * ("did the machine move here", "did a call start", "how did this end") indistinguishable to the
 * type system while looking answerable in the editor.
 *
 * So they are three kinds. The cost is one wider union; what it buys is that a reader asking the
 * wrong question no longer compiles, which is the only reason the error routing below can be
 * checked rather than reviewed.
 */
export type TurnKind =
  /** A state was walked into. The machine moving, which is not the same as a call beginning. */
  | "entered"
  /** An operation was dispatched. `text` is its kind — `prompt` or `function`. */
  | "started"
  /** An instance ended. `ok` says whether it ended well; `text` is the outcome or the reason. */
  | "terminated"
  | "tool"
  | "output"
  | "policy"
  | "interaction"
  /** An OPERATION failed — the call ran and errored. Distinct from the machine failing. */
  | "failure"
  /** A child could not be entered at all. Carries no instance, because there never was one. */
  | "blocked"
  | "transition"
  /**
   * The runs a fan-out MADE of its elements (decision 0003): the machine made tasks rather than
   * entering states. One line at the mount, carried by every task in the batch; `made` says what
   * was made, and the line links to every run but the reader's own.
   */
  | "made";

export interface ConversationTurn {
  seq: number;
  at: number;
  kind: TurnKind;
  stateId?: string;
  /**
   * WHICH instance this turn is about.
   *
   * The join every reader downstream needs and none of them had. `stateId` names a state DEFINITION,
   * so a loop that ran `draft` four times produced four indistinguishable sets of turns — which is
   * why the transcript's own note says "a state that ran twice shows both passes' events on both
   * cards". The instance is the thing that actually happened.
   *
   * It is also what makes the error routing structural: a failure belongs in a panel exactly when
   * the instance it names has an operation, and without this there is nothing to look up.
   *
   * ABSENT is meaningful and is not a `-1`. A `blocked` turn never became an instance — that is what
   * blocked means — so it has no id to carry, and the absence is the fact rather than a sentinel
   * every reader would have to remember to test for.
   */
  instanceId?: string;
  /**
   * Where this happened, as the chain of CHILD KEYS from the run's root — `product/explore`, not
   * `explore`. Empty string for the root itself.
   *
   * Distinct from `stateId`, and the distinction is the point: one state file is mounted under
   * several keys in several parents, so `explore` names a definition and says nothing about which of
   * the six phases was running it. Computed here rather than in a view because the answer is only in
   * the ORDER of the events — each `instance.entered` names its parent, and the path is the walk.
   */
  path?: string;
  /** The message, command, or reason — whatever this kind's one line is. */
  text?: string;
  /** Tool name, for `tool` turns. */
  tool?: string;
  /** Whether the thing succeeded, where that is meaningful. */
  ok?: boolean;
  /** Structured payload, for `output` turns. */
  data?: JsonValue;
  /** For a `made` turn: the runs the batch's elements became. */
  made?: MadeBatch;
}

/**
 * The runs a fan-out MADE of its elements (decision 0003), as the line at the mount says them.
 *
 * ONE record, read from many places. The task that split writes the whole list into its journal
 * before cutting the copies, so every task in the batch carries the same `fanout.made` row — and
 * each draws it from where it stands: its own run is `self` (the element that runs inline below the
 * line, never a link), and a run its `dependsOn` names is one it `waitsFor`. A `"task"` mount's
 * parent is in the list nowhere, since it made every element.
 */
export interface MadeBatch {
  /** `adopt`: not a fan-out at all — a task that ran alone, taken up as this child (decision 0005 §2). */
  kind: "split" | "task" | "adopt";
  /** Every element's run, in element order — the reader's own included. */
  runs: MadeTask[];
}

/**
 * One run of a batch. `status` and `holding` are the task's standing NOW, read off its row when the
 * view is built — the line says "Beta · running" and then "· completed" on the next read, which the
 * run-end push triggers.
 */
export interface MadeTask {
  taskId: string;
  /** The element's position in the list. */
  element: number;
  /** The element's own identity, when the wire named an id field. */
  id?: string;
  title: string;
  status: TaskStatus;
  /** How many dependencies it is still holding for. */
  holding: number;
  /**
   * Made HELD and started by nobody: a generated split's `start: "manual"` (decision 0005 §3), whose
   * tasks are made and nothing confirmed. `release` — the board's gesture, or the conversation's
   * tool — is what starts one. Different from `holding`, which is a task waiting its turn.
   */
  held?: boolean;
  /** This run is the task reading the record — the one drawn inline, not as a link. */
  self: boolean;
  /** The reading task holds for this run to complete. */
  waitsFor: boolean;
}

export interface ConversationView {
  taskId: string;
  title: string;
  turns: ConversationTurn[];
  /** The interaction this task is parked on, when it is one. */
  waitingOn?: { requestId: string; component: string };
}

// --- history pruning (SPEC §13) ----------------------------------------------

/** One task's worth of history in a prune plan — the machine's how, never its what. */
export interface PrunePlanEntry {
  taskId: string;
  endedAt?: number;
  events: number;
  commands: number;
}

/** What a prune did, or (when `dryRun`) would do. */
export interface PruneResult {
  tasks: PrunePlanEntry[];
  events: number;
  commands: number;
  /** Tasks the §13 safety rule refused to touch, with the reason. */
  skippedTasks: Array<{ taskId: string; status: string; reason: string }>;
  dryRun: boolean;
}

/** Rows currently stored — the "before you prune" summary. */
export interface HistorySize {
  tasks: number;
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
  /** `shared` is the selected root as a project — the machine's, not a checkout. See `SHARED_SESSION`. */
  kind: "user" | "shared";
  tasks: number;
  /** Running, INCLUDING the ones parked on a person — see {@link waiting}, which is a subset. */
  running: number;
  /**
   * The same rows {@link tasks} counts, split by status.
   *
   * The status pills read this (SHELL.md §4), and they need the split rather than the total: "four
   * tasks" and "four tasks, three of which failed" are the same number and different news.
   */
  statuses: Partial<Record<TaskStatus, number>>;
  /**
   * Of the running tasks, how many are parked on a PERSON — a workflow gate, a tool approval or a
   * mid-run question.
   *
   * Not a task status, and it cannot be one: a task parked at a gate is `running` in the runtime row
   * and says so nowhere else. It is counted from the session's own parked requests, which is the
   * same place the inbox strip reads, so the two can never disagree.
   */
  waiting: number;
  /**
   * Every task that has STOPPED, with the clock a read-watermark is compared against.
   *
   * Here rather than as another tally because the status pills are UNSEEN counts (SHELL.md §4.3):
   * "three finished" means three finished since you last looked, and answering that needs the ids —
   * the watermark lives in the renderer's settings (`ui.seen`), which is the one place a count of
   * what a PERSON has read can live.
   *
   * Only the stopped ones. A running or parked task is a live fact, always true whether or not
   * anybody looked, so its count comes from {@link statuses} and needs no row here — which also
   * bounds this to the tasks a status pill could possibly be counting.
   */
  ended: EndedTask[];
}

/** One stopped task, as small as an unseen count needs it (see {@link ProjectSummary.ended}). */
export interface EndedTask {
  taskId: string;
  status: TaskStatus;
  /** The task ROW's clock — the same one `ui.seen` watermarks against. */
  updatedAt: number;
}

/**
 * A task, stamped with the project holding it — what a list spanning every project is made of.
 *
 * The stamp is not optional here: a row in a cross-project list that cannot say whose task it is
 * cannot be opened, for exactly the reason the inbox strip's rows could not (SHELL.md §2.4).
 */
export interface ProjectTask extends TaskSummary {
  project: string;
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
  /** Present when this task is a FORK of {@link parentTaskId} — a copy cut at a point, not a re-run. */
  origin?: TaskOrigin;
  /** The dependencies still unfinished — non-empty means the task is holding. See {@link Holding}. */
  waitingFor?: Holding[];
  /**
   * How many tasks stand UNDER this one — filed beneath it, adopted by it, or made by its fan-out
   * (decision 0005). What the Chat list says of a conversation that is controlling work: "3 tasks".
   */
  controls?: number;
  /** A merge request this task is waiting on (decision 0004) — see {@link InReview}. */
  inReview?: InReview;
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
  instanceId: string;
  stateId: string;
  /** The conversation. Opaque — the UI shows it, nothing parses it. */
  sessionId: string;
  /** Where this operation's record sits in that conversation. */
  seq: number;
  at: number;
  /**
   * Where this conversation LEFT another one, when it is a branch of one.
   *
   * A retried state re-enters a position the failed attempt already claimed, so it forks rather than
   * stacking a second answer on top of the first (SESSIONS.md §4) — and until this field the two
   * arrived on screen as unrelated panels with unfamiliar ids, one of them silently carrying the
   * other's first six turns. The record always knew: `sessions.parent` and `sessions.cursor` have
   * held it since the store was written, and `SqliteSessionStore.lineageOf` is what reads it.
   *
   * `parent` is the conversation this one left; `at` is the position they share — which is also the
   * position the parent's own record occupies, so the two sides of a fork are found by matching this
   * pair against `{ sessionId, seq }`. Absent for a root, which is nearly every session: nothing is
   * paid for until a conversation actually divides.
   */
  branch?: { parent: string; at: number };
  /**
   * When the CALL began — `operation.started`, not the instance's entry.
   *
   * The two differ by the whole of a subtree for a composite that both delegates and speaks, and the
   * difference is what decides whether two sessions were running at the same time. A conversation
   * laid out with vertical space standing for time needs the operation's own span; the instance's is
   * an envelope around it. Absent for a run journaled before this was projected.
   */
  startedAt?: number;
  /**
   * How the call ended — or that it has not. `interrupted` is the case that never settled: the
   * process died inside it, so no terminal event was ever written and the verdict comes from its
   * own record row instead. `running` comes from the same place and means the opposite: the record
   * is still open, so the call is speaking right now.
   */
  status?: "success" | "error" | "interrupted" | "running";
  costUsd?: number;
  /** What the call consumed and what that number is worth — see {@link RunMetrics}. */
  metrics?: RunMetrics;
  /**
   * Where the operation sits in the workflow — see {@link AddressStep}.
   *
   * The one name that means the same thing in two runs, and therefore the only way to say that this
   * call and one from another run are the same piece of work done twice. `instanceId` cannot: it is
   * minted per walk. Without it a call the folded tree dropped — an earlier run's work a later run
   * overwrote — is on the page with nothing to group it by, and a run-scale fork loses the very
   * sides it exists to offer.
   *
   * Absent for a run journaled before addresses were projected.
   */
  address?: InstanceAddress;
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
  /**
   * When the turn ARRIVED, host clock — kept on the entry in `timing`, apart from the provider's own
   * `timestamp`. The two are different facts and only one of them goes back on the wire. Absent for
   * a turn nothing streamed.
   */
  at?: number;
  /** When the turn STARTED — its first streamed fragment, thinking included. */
  startedAt?: number;
  /** How long the model spent thinking before it began answering — the "thought for 12 s" number. */
  thoughtMs?: number;
}

/**
 * The conversation ONE state instance ran.
 *
 * A leaf state runs one operation, which is one record at one position — and for a delegated agent
 * that single operation contains the agent's whole loop. So this is the whole thing, undivided.
 */
export interface SessionView {
  taskId: string;
  instanceId: string;
  stateId: string;
  sessionId: string;
  seq: number;
  /** The agent's own session handle, when it had one — what lets its native transcript be found. */
  providerSessionId?: string;
  /** See {@link SessionRef.status} — `running` means the call has not finished, not that it died. */
  status?: "success" | "error" | "interrupted" | "running";
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
  /**
   * The turns that ARE a structured output rather than prose — see {@link SessionOutput}.
   *
   * A list keyed by turn index rather than one field, for the same reason {@link providerEvents} and
   * {@link native} are: a chat thread is a chain of records, each with an output of its own, and a
   * single slot would be able to describe only the last one.
   */
  outputs?: SessionOutput[];
  /** Set when the state ran in no conversation at all — a function op, or a run before this existed. */
  empty?: string;
}

/**
 * A turn whose text is not prose but the operation's declared output, serialized.
 *
 * ## Two ways a model delivers one, and neither of them looked like a value
 *
 * **In TEXT.** A model with no structured-output tool writes the JSON as its message and upstream
 * binds it. Both facts end up in the record — the message the model wrote, and the value it was read
 * as — and the conversation only ever showed the first, so a state that produced four labelled
 * fields rendered as a paragraph of `{"matched": false, "match_reason": …}` run through a markdown
 * renderer. {@link turn} names that message.
 *
 * **Through a TOOL.** An agent transport exposes a tool whose arguments are the output, and calling
 * it is how the agent terminates with a value. That reached the transcript as an ordinary tool row —
 * a collapsed grey line, the value behind a disclosure triangle, and a result reading "Structured
 * output provided successfully" — which is the whole point of the call, folded away, next to an
 * acknowledgement that is not information. {@link callId} names that call.
 *
 * Exactly one of the two is set. The value and the schema are the same either way, which is the
 * point: how the model happened to hand it over is a fact about the transport, not about the answer.
 *
 * ## Identity, never inference
 *
 * A turn is named here only when its text parses AND equals the value the record bound, exactly. A
 * call is named only when its arguments equal it. Not "the operation declares JSON and this looks
 * like JSON": that rule would relabel a model's prose about a value as the value, and — worse —
 * would present an output the binding REJECTED as though it had been accepted.
 *
 * The two are read differently downstream for a reason that follows from that. A message is
 * REPLACED, because equality means there is nothing in the text that is not in the value. A call is
 * not: its row stays and the value is drawn beneath it, the way a page a tool produced is (see
 * `producedArtifact`). Matching a call is the weaker claim of the two — a genuine tool whose
 * arguments happen to equal the output would be indistinguishable — and the cost of being wrong
 * should be a value shown twice, never a call that vanished from the record.
 *
 * Absent for records that keep only their messages — a scripted fake, a value-mode core whose
 * payload was projected away inside the call (see `projectValue`). There is no bound value to check
 * against, and a rendering that cannot be checked is the thing this deliberately does not do.
 */
export interface SessionOutput {
  /** Index into {@link SessionView.turns} — which turn's text is this value. */
  turn?: number;
  /**
   * The provider's id for the tool call whose ARGUMENTS are this value.
   *
   * Globally unique, and that is why it is an id rather than a position: unlike {@link turn} it
   * needs no shifting when records are concatenated into a thread.
   */
  callId?: string;
  /** What the record bound, which is what gets drawn. */
  value: JsonValue;
  /** The output slot's declared schema, when the request pinned one — `ViewHint.schema`. */
  schema?: JsonValue;
  /**
   * Which slot this filled, when the request named one.
   *
   * The label over the drawn value, and the one word a reader could not otherwise guess: a block of
   * JSON where a paragraph was says that the model answered structurally, and `plan_doc` says what
   * it answered WITH. It is also what gives the value a head at all — a plain object has one
   * rendering, so `ValueView` draws no toggle and hence no row to hang "download" or "open in the
   * context panel" off, and those are worth more here than on any tool result.
   */
  name?: string;
}

/**
 * A whole CONVERSATION, rather than one call of it — what the Chat view reads.
 *
 * {@link SessionView} answers "what did this state add to the conversation it was in", which is the
 * right question for a run and the wrong one for a chat: a conversation is a chain of records, each
 * adding a message and a reply, and a reader wants the chain. So this walks it — forks included,
 * which is what makes an edited message show its branch and not the one it replaced — and hands back
 * one session view whose turns are the whole thread.
 *
 * `points` is what makes editing possible without the renderer knowing anything about positions: it
 * says which turns began a record, and the opaque handle to send in their place.
 */
export interface ChatThreadView {
  taskId: string;
  /** The instance whose conversation this is — what `chat:send` and `chat:plan` address. */
  instanceId: string;
  /** The thread, shaped exactly like any other session so the same viewer renders it. */
  session: SessionView;
  /** Where a message may be sent INSTEAD of an existing one — see `chat:send`'s `branchAt`. */
  points: ChatEditPoint[];
  /**
   * Where this conversation SPLIT, and what it said down the other side.
   *
   * Absent for the ordinary conversation, which is most of them: nothing here is paid for until
   * somebody replaces a message. See {@link ChatFork}.
   */
  forks?: ChatFork[];
  /** Where this conversation was forked from, when it is a fork — see {@link TaskOrigin}. */
  origin?: TaskOrigin;
}

/**
 * One place a conversation divided in two.
 *
 * A replaced message does not delete what followed it — it branches, and the branch that was left
 * behind is intact in the record and on no path anybody reads. Reported so the view can say so: the
 * thread runs down to {@link turn}, and from there it is two conversations that share everything
 * above and nothing below.
 */
export interface ChatFork {
  /** The turn the split happens AFTER — the last one both sides have in common. */
  turn: number;
  /** What was said instead, one entry per branch that was left behind. */
  left: ChatBranch[];
}

/** One side of a {@link ChatFork} that the thread is not showing. */
export interface ChatBranch {
  /** The conversation id — opaque, and the only durable name the two halves share. */
  sessionId: string;
  /** What it said, from the split onward, in the same shape as any other thread's turns. */
  turns: SessionTurn[];
}

/** One replaceable message: which turn of the thread it is, and the position it occupies. */
export interface ChatEditPoint {
  /** Index into {@link ChatThreadView.session}'s turns — the first turn the record contributed. */
  turn: number;
  /** Opaque. It goes back to `chat:send` as `branchAt` and is parsed by nothing in the renderer. */
  at: string;
  /**
   * The journal position this message's turn begins at — what `task:rewind` and `task:fork` take.
   *
   * A chat turn is a transition on the chat instance, so cutting the journal there is cutting the
   * conversation before this message. Absent for a turn the journal does not name, which nothing
   * can be cut at.
   */
  seq?: number;
}

/**
 * Where a forked task CAME FROM — what the origin seam draws and links to.
 *
 * `at` is the parent's journal position the copy was cut before; `boundary` is the copy's own last
 * journaled event, which is where the seam sits in this task's coordinates. `label` says the cut in
 * words — "before review", "after message 3" — computed where the parent's journal can still be
 * read, because it may not be readable later (the parent can be deleted, and the copy survives it).
 */
export interface TaskOrigin {
  /**
   * What made the copy. A `fork` is a person's verb; `split` and `task` are a fan-out's (decision
   * 0003). Absent means `fork`, which is every origin projected before the field existed.
   */
  kind?: "fork" | "split" | "task" | "adopt";
  taskId: string;
  /** The parent's title, when the parent is still there to have one. */
  title?: string;
  /** For a fan-out's task: the mount key in the parent, and which element — what files a mount task in that column. */
  key?: string;
  index?: number;
  at: number;
  boundary: number;
  /** When the boundary event happened — where the seam sits among rows laid out by the clock. */
  boundaryAt: number;
  label: string;
}

/**
 * A task this one is HOLDING for — a dependency that has not completed (decision 0003).
 *
 * Derived wherever a task row is read, never stored: the dependency's status is the fact, and a
 * stored "holding" would have to be rewritten by whichever process saw the dependency finish.
 */
export interface Holding {
  taskId: string;
  title: string;
  status: TaskStatus;
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
  /**
   * Where this entry IS, not how many came before it.
   *
   * The byte it begins at in its day of the mirror, for an entry read back from disk; the writing
   * counter for one that never reached a file. Either way it is an identity and not an order — the
   * order is the array, and the position to continue from is the page's `cursor`. It was a per-launch
   * counter when the panel was served from memory, which meant every launch wrote an entry called
   * `7` and no reader spanning two of them could tell them apart.
   */
  id: number;
  at: number;
  level: LogLevel;
  /**
   * Where it came from — `ipc`, `engine`, `process`, `crash`, `runtime`, `project`, `availability`,
   * `app`.
   *
   * `process` is a CHILD process and `runtime` is the Node process this app is: a warning Node
   * emitted about itself is not a job, and filing it as one would put it under a task that does not
   * exist. `crash` is the third of that family and the loudest — something escaped.
   */
  source: string;
  message: string;
  /** The session key of the project it concerns, when it concerns one. */
  project?: string;
  taskId?: string;
  instanceId?: string;
  jobId?: number;
  /** A stack, an argv, an exit code — whatever the reader would want and the message cannot hold. */
  detail?: JsonValue;
}

/**
 * A page of the log, NEWEST FIRST.
 *
 * Newest first because that is the order a log is read in: the question is almost always "what just
 * happened", and a reader who has to scroll to the bottom to find it is reading the file backwards
 * by hand. It also makes the paging honest — the page you have is the recent end, and `cursor` is
 * how you ask for more of the past, rather than everything being held in memory so that the middle
 * can be indexed.
 *
 * `cursor` absent ⇒ there is nothing older. It is opaque: today it names a file and a byte offset in
 * the NDJSON mirror, and nothing outside the reader may assume that.
 */
export interface LogPage {
  entries: LogEntry[];
  cursor?: string;
}

/**
 * What to show, and where to continue from.
 *
 * The filters are applied where the entries are READ rather than after they arrive, which is the
 * difference between a search that spans every day on disk and one that spans whatever happened to
 * be in memory.
 */
export interface LogQuery {
  /** Continue from a previous page — its `cursor`. Absent ⇒ start at the newest entry. */
  before?: string;
  limit?: number;
  /** "This and worse", as everywhere else. */
  level?: LogLevel;
  /** An exact source, or a dot-path prefix of one (`jaira.persistence` matches its children). */
  source?: string;
  project?: string;
  /** A substring of the message, the source, or the detail — the box you type a file name into. */
  text?: string;
}

/**
 * The sources the app itself writes under, for a picker that is usable before any of them has said
 * anything.
 *
 * A catalogue, not a closed set: library scopes (`jaira.persistence.views`, `llm.generate`) arrive
 * as whatever the library calls itself, and the picker unions this list with what is actually in the
 * log. Listing them is what lets somebody turn `run` down to `warn` before the run that would
 * otherwise flood them has started.
 */
export const LOG_SOURCES: readonly string[] = [
  "app",
  "crash",
  "engine",
  "ipc",
  "process",
  "project",
  "review",
  "run",
  "runtime",
  "sync",
];

/**
 * One rule about what is worth keeping — see {@link LogPolicy}.
 *
 * `scope` matches a source exactly or as a dot-path ancestor (`jaira.persistence` covers
 * `jaira.persistence.views`), longest match winning. `tag` matches a record's classification tag,
 * which only the libraries set, and beats a scope match: a tag is the more specific statement of the
 * two — "this KIND of record", wherever it comes from.
 */
export interface LogOverride {
  match: "scope" | "tag";
  key: string;
  minLevel: LogLevel;
  /**
   * Fraction of the matching non-error records to keep, 0..1. Errors are never sampled away — a
   * dropped error is the one thing a log may not do, and a rate that could drop them would make
   * every absence ambiguous.
   */
  samplingRate?: number;
}

/**
 * What the app keeps and what it throws away, before anything is written.
 *
 * A logger with one fixed level is either too quiet to diagnose anything or too loud to read, and
 * which of those it is changes by the hour — so this is a preference, and the Logs page edits it.
 * It gates BOTH streams: the libraries, through `@declarative-ai/log`'s level policy, which drops a
 * record before it is ever formatted; and the app's own entries, at the point they are recorded.
 */
export interface LogPolicy {
  /** The floor, where no override matches. */
  minLevel: LogLevel;
  overrides: LogOverride[];
}

/** A process JaiRA claimed or started (DESIGN §4.2a). Named here so the renderer can read one. */
export type JobKind = "run" | "process";

export interface JobRow {
  id: number;
  kind: JobKind;
  taskId?: string;
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
