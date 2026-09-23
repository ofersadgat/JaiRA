/**
 * The typed IPC contract (DESIGN §11.2).
 *
 * One place defines every channel, its request, and its response, so main and
 * renderer are checked against the same declaration. Two directions:
 *
 *  - **invoke** (`ipcMain.handle` / `ipcRenderer.invoke`) — request/response.
 *  - **push** (`webContents.send`) — engine events and store invalidations,
 *    so the board is a subscription rather than a poll.
 *
 * This channel is also the security boundary that makes SPEC §11.4 true by
 * construction: a UI state's answer can only enter a run through the renderer,
 * and no agent process can reach this surface.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { BaselineFile, Changeset } from "./changeset";
import type { Choice, ComponentConfig } from "./components";
import type { AvailabilitySnapshot, ExecutorInfo, ProbeResult, SecretTarget } from "./executors";
import type { RemoteStatusView } from "./forge";
import type { JairaSettings } from "./settings";
import type { SchemaViolation } from "./schemas";
import type { TaskFastForwardRequest, TaskFastForwardResult, TaskMoveRequest, TaskMoveResult, UserEventRequest } from "./userEvents";
import type { TaskConnectRequest, TaskConnectResult, TaskConnectUndoRequest, TaskConnectUndoResult } from "./connect";
import type { InputProvenance, InputSourcesRequest, InputSourcesResponse, TaskAdoptRequest, TaskAdoptResult, TaskOutputRef } from "./adopt";
import type { ModuleApproval } from "./refusal";
import type { ChatPlanView, ChatSettings } from "./operationVocabulary";
import type { CommandApproval } from "./commandParts";
import type { ToolsetChoice } from "./toolsetBuckets";
import type { ToolsetDecl } from "./toolsets";
import type { ToolsetsView, ToolsetWriteKind } from "./toolsetSettings";
import type {
  BoardView,
  ChatThreadView,
  ConversationView,
  JobOutputChunk,
  JobRow,
  LogEntry,
  LogPage,
  LogQuery,
  ProjectSummary,
  ProjectTask,
  SessionRef,
  OperationRecordView,
  SessionView,
  FileTree,
  HistorySize,
  PruneResult,
  StateSlots,
  StateView,
  ResumePlan,
  TaskDetail,
  TaskSummary,
  WorkflowBrowser,
  WorkflowLayer,
  WritableLayer,
} from "./view";

// --- invoke channels ---------------------------------------------------------

/**
 * Which project a task-scoped call is about. Absent ⇒ the focused one.
 *
 * One value is reserved, and it is the only way to reach the project it names because the focus
 * never points there: {@link SHARED_SESSION} is the selected root opened as a project. It is what
 * makes a workflow living in `<root>/workflows` runnable at all — the run has to be recorded
 * somewhere, and recording it in whichever checkout happened to be open is how a shared library
 * becomes one project's clutter.
 */
export type ProjectRef = string;

/**
 * The reserved value of {@link ProjectRef} that names the BASE root opened as a project.
 *
 * An alias rather than a path, because a caller asking for it is asking for a role — "wherever this
 * machine keeps the shared library and its runs" — and must not have to know where that was put.
 * Re-exported from `paths.ts`, which is where the rest of the path vocabulary lives, but defined
 * here because the renderer sends it and `paths.ts` is Node-only.
 *
 * It holds two kinds of run and there is one database for both: runs of the workflows a person
 * authors in `~/.jaira/workflows`, and JaiRA's own — a description sync, summarization, the
 * conformance check.
 *
 * **There used to be a second alias**, `system`, for JaiRA's own runs, pinned to the default root so
 * that repointing the root could not carry a sync's bookkeeping off with a library it was not about.
 * The lifetimes are genuinely different and the split still cost more than it bought: two databases
 * inside one root, two boards, and a `system/` directory that meant "JaiRA's project" where it now
 * means "JaiRA's generated files". One root, one project.
 */
export const SHARED_SESSION = "shared";

export interface CreateTaskRequest {
  title: string;
  workflow: string;
  description?: string;
  labels?: string[];
  inputs?: Record<string, JsonValue>;
  /**
   * Inputs taken FROM A TASK (decision 0005 §2): per input name, the earlier task's output to read.
   * Resolved at creation when that task has completed — the value is checked against nothing here;
   * the run's own slot validation is the judge — and recorded `bound` with where it came from. A
   * source still on its way makes the new task HOLD for it (`dependsOn`), and the value is read when
   * the task starts.
   */
  sources?: Record<string, TaskOutputRef>;
  /**
   * How the typed `inputs` were settled. Absent ⇒ `asked`: a person filled in a form. A conversation
   * creating a task on somebody's behalf says `inferred`, per input, with how sure it was.
   */
  provenance?: Record<string, InputProvenance>;
  branch?: string;
  /** Where the task is recorded. See {@link ProjectRef}. */
  project?: ProjectRef;
}

export interface StartTaskRequest {
  taskId: string;
  /** Scripted interactive answers, keyed by function name — the headless/demo
   *  path. Absent ⇒ the renderer answers interactive states live. */
  interactions?: Record<string, JsonValue[]>;
  /** Scripted prompt rules (the `--fake` surface), for demos and tests. */
  fake?: JsonValue;
  /**
   * Which project holds the task. See {@link ProjectRef}.
   *
   * It also decides whose config and credentials govern the run — a system run resolves the shared
   * root's models and the shared root's `.env`, which is the correct pairing for a workflow that
   * belongs to the machine rather than to a checkout.
   */
  project?: ProjectRef;
  /**
   * Per-run settings for the state this run STARTS at — what the composer picked before there was a
   * conversation to pick them in.
   *
   * The first message of a conversation is the run (see `chatWorkflow.ts`), so without this the one
   * message that decides what the whole thread inherits would be the only one sent under the file's
   * settings alone, beneath a composer showing controls it did not obey.
   *
   * Applied by SYNTHESIZING the bundle: the root state's operation and environment are rewritten and
   * the result is pinned as this run's snapshot, so the record says what actually ran rather than
   * what was on disk. The authored file is never touched. Ignored — deliberately, rather than
   * applied somewhere else — when the root state has no prompt operation of its own to rewrite.
   */
  overrides?: ChatSettings;
}

/**
 * A pending per-command approval (DESIGN §10.2).
 *
 * Deliberately distinct from {@link PendingInteraction}: a workflow gate is an
 * authored UI state, while this is provider-initiated and unpredictable — policy
 * escalated a tool call. They share the inbox, not the mechanism.
 */
export interface PendingApproval {
  requestId: string;
  tool: string;
  /** The command line, when the tool takes one. */
  command?: string;
  /** Why policy escalated. */
  reason?: string;
  /**
   * A shell line as the requests it is made of (decision 0007 §4): per part its span in
   * {@link command}, the span of the words that matched, its subject, its path or url, its verdict
   * and the toolset entry that decided it. Absent for a tool that takes no command line.
   */
  parts?: CommandApproval;
  /**
   * The toolset that judged the line, and where a remembered answer could be WRITTEN — what the
   * answer menu's "add to the toolset" offers. Absent when no toolset judged the call.
   */
  toolset?: ApprovalToolset;
  input: Record<string, JsonValue>;
  taskId?: string;
  /**
   * The project whose database holds {@link taskId} — the session this request parked in.
   *
   * Required, not optional, because the inbox is ALREADY cross-project: `pendingApprovals()`
   * flat-maps every open session, so a strip row carrying a bare task id resolves it against
   * whichever project happens to be focused and answers "unknown task" — or worse, names a
   * different task that happens to share the rowid. See SHELL.md §2.4.
   */
  project: ProjectRef;
  at: number;
}

/** One layer an answer can be written into — see {@link ApprovalToolset}. */
export interface ApprovalToolsetTarget {
  layer: WritableLayer;
  /** The file, as a person reads it: `.jaira/toolsets/chat/ask-first.json`, `~/.jaira/toolsets/…`. */
  file: string;
  /**
   * Set when this layer does not hold the toolset yet: the write CREATES an override here that keeps
   * following the named lower layer's file (`$SYSTEM/toolsets/chat/ask-first`).
   */
  follows?: string;
  /** A nearer layer holds its own copy that does not follow this one, so a line written here is not read in this project. */
  shadowed?: true;
}

/** The toolset behind a command approval (decision 0007 §4). */
export interface ApprovalToolset {
  /** `<bucket>/<name>` — `feature/implementation/writes-asking`. Absent for a map with no file. */
  id?: string;
  /** The layers a line can be written into, nearest first. Empty ⇒ {@link unwritable} says why. */
  targets: ApprovalToolsetTarget[];
  /** Why nothing can be written, as a sentence the menu shows. */
  unwritable?: string;
}

/** How long an approval answer applies (upstream's PermissionScope). */
export type ApprovalScope = "once" | "session" | "workflow-run" | "always";

export interface SubmitApprovalRequest {
  requestId: string;
  decision: "allow" | "deny";
  /** Defaults to `once` — the narrowest answer. */
  scope?: ApprovalScope;
  /**
   * "For this run", for a shell line: the widths chosen for its asking PARTS — one of each part's
   * `widths` (`"git commit"`, or `"git"`). `[]` takes each part's narrowest. It is the parts that are
   * remembered, never the line, so `scope` is not also applied. Writing the entry into a toolset
   * file ("add to the toolset") is a separate act.
   */
  remember?: string[];
  /**
   * "Add to the toolset": write the asking parts, at the widths {@link remember} names, into the
   * toolset file that asked, in this layer — then answer, remembering them for the run as well (a
   * started task reads its pinned snapshot, so the file alone would not stop this run asking). A
   * write that fails refuses the submit and leaves the request parked.
   */
  addTo?: WritableLayer;
}

/** One choice a {@link PendingQuestion}'s question offers. */
export interface QuestionOption {
  label: string;
  /** What choosing this means — trade-offs, implications. */
  description?: string;
}

/** One question a running agent asked. */
export interface AgentQuestion {
  /** The complete question, e.g. "Which library should we use?" */
  question: string;
  /** Short chip label (e.g. "Library"). */
  header?: string;
  options: QuestionOption[];
  /** True ⇒ several options may be chosen; the answer is then a list of labels. */
  multiSelect?: boolean;
}

/**
 * A pending mid-run QUESTION (`AskUserQuestion`) — the third kind of inbox item.
 *
 * Distinct from {@link PendingApproval} the way that is distinct from {@link PendingInteraction}:
 * an approval authorizes a tool call, where here the call IS the question and the human's answer is
 * its payload. Routing questions through the approval channel asked the person to approve being
 * asked, and never showed them the question.
 */
export interface PendingQuestion {
  requestId: string;
  questions: AgentQuestion[];
  taskId?: string;
  /** The workflow instance whose agent asked — stamped by the engine on the request. */
  instanceId?: string;
  /** The asking `AskUserQuestion` call's own id, when the agent's transport reported it. */
  toolCallId?: string;
  /** Where {@link taskId} is recorded. Same reason as {@link PendingApproval.project}. */
  project: ProjectRef;
  at: number;
}

/**
 * An agent's questions as the ONE shape the renderer draws (decision 0002).
 *
 * The mirror of `choicesOfConfig`: same destination, different origin. Every agent question carries
 * an "Other" field, and it is `instead` — the text the person types REPLACES the option they
 * picked, which is what the wire expects and what makes it unlike a gate's `comments`.
 *
 * `value` is the option's LABEL rather than an id, because a label is what travels back as the
 * tool's input. An agent's options are its own words, and there is no declared enum behind them.
 */
export function choicesOfQuestions(questions: readonly AgentQuestion[]): Choice[] {
  return questions.map((q) => {
    const choice: Choice = {
      question: q.question,
      options: q.options.map((o) => ({
        value: o.label,
        ...(o.description === undefined ? {} : { description: o.description }),
      })),
      freeText: { label: "Other", placeholder: "Type your own answer…", role: "instead" },
    };
    if (q.header !== undefined && q.header.length > 0) choice.header = q.header;
    if (q.multiSelect === true) choice.multiple = true;
    return choice;
  });
}

export interface SubmitQuestionRequest {
  requestId: string;
  /**
   * Question text → the chosen option label(s), or free text. A multi-select answers with a list.
   * Absent ⇒ DISMISSED: the agent is told to use its own judgment and continue.
   */
  answers?: Record<string, string | string[]>;
}

/** Answer to a pending interactive request (DESIGN §7.1). */
/**
 * A transition waiting on a gesture, as the renderer sees it.
 *
 * The hub's own request plus the project it parked in — the same shape every other pending thing in
 * this file takes, and for the same reason: a request id is only unique because one generator mints
 * them all, and the reader still has to know whose board it belongs on.
 */
export interface PendingUserEvent extends UserEventRequest {
  project: ProjectRef;
}

export interface SubmitInteractionRequest {
  requestId: string;
  value: JsonValue;
}

/** A pending interactive request the renderer must render. */
export interface PendingInteraction {
  requestId: string;
  taskId: string;
  /** Where {@link taskId} is recorded. Same reason as {@link PendingApproval.project}. */
  project: ProjectRef;
  /**
   * The task this request is ABOUT, when that is a different task than the one that parked it.
   *
   * A changeset review runs as its own task in JaiRA's project (see `changeset:review`), but the
   * thing being reviewed is another task's worktree — and the conversation view of THAT task is
   * where §8.1 says the reviewer should live. This is the join that lets it: absent means the
   * request is about the task that parked it, which is every other component.
   */
  about?: string;
  /**
   * The project whose ANCHORS this request's file reads resolve against — what a renderer passes
   * back as `uri:read`'s `project`.
   *
   * Deliberately NOT {@link project}, which is the project the request was parked in: for a
   * changeset review those are always different. A review runs in JaiRA's own project, and the
   * files it is about live in the reviewed task's project (a worktree review) or in the layer root
   * the proposal targets (a sync review). Without the stamp the reviewer read `$WORKTREE`, `$JAIRA`
   * and `$PROJECT` against whatever happened to be FOCUSED — another project's files when one was
   * open, and `no project is open` when none was.
   *
   * Absent ⇒ {@link project}, which is right for every request parked by a run of that project's
   * own workflow. Named for `ProjectSession.subjectProject`, the map it is stamped from.
   */
  subjectProject?: string;
  /** The registered function name — `choose_option`, `review_artifact`, … */
  component: string;
  /** Resolved inputs, including the state's authored `config` surface. */
  inputs: Record<string, JsonValue>;
  /** The parsed component contract, normalized in main so the renderer does not
   *  re-derive it. Absent for a function that is not a built-in component. */
  config?: ComponentConfig;
  /** Set instead of `config` when the state's authored config is malformed, so the
   *  UI can show the authoring error rather than an empty dialog. */
  configError?: string;
  /**
   * Nothing is blocked on this answer right now — giving one CONTINUES the task rather than
   * unblocking it.
   *
   * A gate outlives the process that parked it (`pending_interactions`), so a question asked before
   * the app was closed is still being asked after it reopens. The engine that was waiting is not:
   * answering seeds the reply and resumes the run, which replays what it already did and picks the
   * answer up at the state it stopped in. Absent ⇒ a live park, with a run blocked on it.
   *
   * The renderer needs this only to say the true thing on the button. It is not a second way to
   * answer — both go through `interaction:submit` with a value.
   */
  resumes?: boolean;
  /**
   * A MOVE's question (decision 0005, the rulings of 2026-09-22): the host parked it in the task's
   * conversation because the move lacks inputs, and answering it takes the move. No run is blocked on it.
   */
  moves?: true;
}

/**
 * A prune request (SPEC §13). `apply` is the destructive form; without it the
 * response is a plan, which is what the UI shows before asking.
 */
export interface PruneRequest {
  /** Only prune tasks whose machine ended more than this many days ago. Default 0 (any age). */
  olderThanDays?: number;
  apply?: boolean;
}

// --- configuration, executors and workflow authoring -------------------------

/**
 * The two configuration layers, as the settings UI addresses them.
 *
 * `base` is the shared root behind every project on this machine; `project` is this checkout's own
 * `.jaira/settings.json`, laid over it. Every write names its layer explicitly — there is no "current"
 * layer — because "did I just change this project or every project?" is precisely the question a
 * settings screen must never leave ambiguous.
 */
export type ConfigLayer = "base" | "project";

/** Both layers as authored, plus what they add up to. */
export interface ConfigView {
  /** The raw document of each layer, or null when that layer has no `settings.json`. */
  base: JsonValue | null;
  project: JsonValue | null;
  /** Base merged under project, parsed and defaulted — what a run would actually use. */
  effective: JsonValue;
  /** Where each layer's file lives, so the UI can show the path it is editing. */
  baseFile: string;
  projectFile: string;
  /** The shared root itself, for the "where does this come from" line. */
  baseDir: string;
}

export interface WriteConfigRequest {
  layer: ConfigLayer;
  /** WHICH project, for the `project` layer — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** The whole document for that layer. Parsed and validated before it is written. */
  config: JsonValue;
}

/** Read one workflow state file, as text, from a named layer. */
export interface ReadWorkflowRequest {
  stateId: string;
  layer: WorkflowLayer;
  /**
   * WHICH project, when {@link layer} is `project`. See {@link ProjectRef}.
   *
   * A layer is not a project: `project` says which of the two roots an address is in, and the
   * window holds several projects at once (SHELL.md §2.2), so the pair is what identifies a file.
   * Absent is only valid for a `base` address, where there is one root and it is the shared one.
   */
  project?: ProjectRef;
}

export interface WorkflowSource {
  stateId: string;
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Absolute path of the file, for display. */
  file: string;
  /** The file as it stands, or an empty string when it does not exist yet. */
  text: string;
  /** False when nothing is at this path yet — a write would create it. */
  exists: boolean;
  /** How this state stands against what ships — see {@link BuiltInStanding}. */
  builtIn?: BuiltInStanding;
}

/**
 * How one state file stands against the built-in layer (decision 0006).
 *
 * Present only where the layer is involved: on a shipped file itself, and on a person's file whose
 * state id JaiRA also ships. Absent everywhere else, which is almost every file, so a surface that
 * reads it needs no second test for "is this about a built-in at all".
 */
export interface BuiltInStanding {
  /**
   * Every layer holding a file for this state id, in search order — so the first is the one that
   * loads. What decides which "Override…" an editor may still offer: a layer already listed has its
   * copy, and copying over it is refused.
   */
  layers: WorkflowLayer[];
}

/**
 * One state as a RUN had it — see `effectiveState` in `@jaira/persistence`.
 *
 * Two things a `WorkflowSource` alone cannot say, which is why this exists beside it.
 *
 * WHICH COPY. A run pins its workflow (DESIGN §5.3), so the state it executed lives in that
 * snapshot and the state on disk is whatever it has been edited into since. {@link from} says which
 * of the two came back, and a reader of a week-old failure needs that stated rather than assumed.
 *
 * WHAT WENT THROUGH IT. A binding says where a value comes from; {@link values} is what came, this
 * once. The form has always shown the first and never the second.
 */
export interface EffectiveState {
  stateId: string;
  /**
   * Whether the document below is still the one that RAN.
   *
   *  - `pinned` — the run's snapshot is the workflow as it stands, so this file is what executed.
   *  - `moved` — the workflow has changed since; this is the file as it is now, and the run's copy
   *    of it is gone. A snapshot keeps the LOWERED states, which no form can draw (see
   *    `effectiveState`), so there is no third document to offer.
   *  - `disk` — no run was named, and the question does not arise.
   */
  from: "pinned" | "moved" | "disk";
  /** The snapshot the run pinned, when there was a run. */
  snapshotHash?: string;
  /** The workflow root whose closure contains it, when one does. */
  rootId?: string;
  /**
   * The state's own document, as that copy holds it — what the editor renders.
   *
   * Absent when the bundle has no such state: renamed, or belonging to another root. That is an
   * answer, and a caller should say so rather than draw an empty form.
   */
  source?: WorkflowSource;
  /**
   * What ONE execution of it recorded. Absent when the caller named no run.
   *
   * Nothing here is derived: each field is a value the journal or the operation record already
   * holds. A published output whose binding is an expression over children is deliberately NOT
   * evaluated — that is the engine's job, and a panel guessing at it would be inventing a fact.
   */
  values?: EffectiveStateValues;
}

/** The values behind one execution's bindings — see {@link EffectiveState.values}. */
export interface EffectiveStateValues {
  /** Which execution these are. A loop runs one state several times, and each pass had its own. */
  instanceId: string;
  /** The inputs the engine resolved on the way in, by slot name (`instance.entered`). */
  inputs?: Record<string, JsonValue>;
  /** What the operation returned, when it completed — the record's own result. */
  output?: JsonValue;
  /** Each child's recorded inputs, by the key this state mounted it under. */
  children?: Record<string, Record<string, JsonValue>>;
}

export interface WriteWorkflowRequest {
  stateId: string;
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** The full file contents. Must parse as JSON; the workflow is re-linted after the write. */
  text: string;
}

/**
 * Put a state at a new id, a new layer, or both.
 *
 * One request rather than three, because rename, duplicate and "override here" are the same file
 * operation with different arguments — and writing them separately is how the containment check
 * ends up implemented three times and wrong in one of them.
 */
export interface MoveWorkflowRequest {
  stateId: string;
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** The id it ends up at. Equal to `stateId` when only the layer changes — that is an override. */
  to: string;
  /** The layer it lands in. Equal to `layer` for a plain rename. */
  toLayer: WorkflowLayer;
  /** Leave the original in place: duplicate and override, rather than rename. */
  copy?: boolean;
  /**
   * Proceed even though other states reference this one.
   *
   * A rename changes the id every referrer names, so it breaks them. The default refuses and
   * reports who, which is the only point at which that is cheap to fix.
   */
  force?: boolean;
}

/**
 * Create a plain file or a directory anywhere under a layer root.
 *
 * Separate from {@link WriteWorkflowRequest} because it is addressed by PATH, not by state id — a
 * prompt, a skill's `prompt.md`, an empty folder. That means its own containment check: the root here
 * is the whole layer (`.jaira/`), not just `workflows/`.
 */
export interface CreateFileRequest {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root, forward slashes. */
  path: string;
  kind: "file" | "directory";
  /** Initial contents for a file. Ignored for a directory. */
  text?: string;
}

/**
 * Rename or move a file or a directory within a layer root.
 *
 * The path-addressed twin of {@link MoveWorkflowRequest}, for everything in the tree that is not a
 * state: a prompt, a skill directory, a folder full of states. It is not folded into that request
 * because the two address different things — a state id is not a path, and a directory has no id at
 * all — but it carries the same `force`, because renaming a directory under `workflows/` changes the
 * id of every state inside it and breaks the same referrers a state rename would.
 */
export interface RenameFileRequest {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root, forward slashes. */
  path: string;
  /** Where it ends up, relative to the same layer root. Directories on the way are created. */
  to: string;
  /** Proceed even though states outside the moved set name states inside it. */
  force?: boolean;
}

/**
 * Check a hand-edited document against one of the registered schemas.
 *
 * Validation is a main-process job because ajv is: `@declarative-ai/validate` is the only package in
 * the workspace carrying it, and nothing the renderer imports is allowed to pull it in. Sending the
 * text rather than the parsed value is deliberate too — the parse error and the schema errors are
 * one answer to one question ("is what I have typed acceptable yet?"), and splitting them across two
 * round-trips is how they end up disagreeing about which revision they describe.
 */
export interface ValidateSchemaRequest {
  /** A {@link SchemaEntry} id. Unknown ids are an error rather than a silent pass. */
  schemaId: string;
  text: string;
}

export interface ValidateSchemaResult {
  schemaId: string;
  /** Set when the text is not JSON at all — no schema errors are reported in that case. */
  parseError?: string;
  violations: SchemaViolation[];
}

/**
 * Check VALUES against schemas a form is drawn from — a state's input slots, a gate's fields.
 *
 * The sibling of `schema:validate`, for the other question: not "is this document a state" but "would
 * the run accept this value". So it answers with the same validator configuration the run itself
 * uses (ajv, `allErrors`, `strict: false` — `@declarative-ai/validate`'s), and a form built on it
 * cannot refuse what the run would take or take what the run would refuse. The errors come back
 * whole rather than collapsed to one string, because a form puts each one under the field it names.
 *
 * Batched, because a Run form is one check per slot: a slot's schema is its own document (a local
 * `$ref` in it points into THAT schema), so slots cannot be folded into one object schema and checked
 * as one.
 */
export interface SchemaCheckRequest {
  checks: SchemaCheckItem[];
}

export interface SchemaCheckItem {
  /** The caller's name for this check — a slot name — echoed on its result. */
  key: string;
  schema: JsonValue;
  value: JsonValue;
}

/** One complaint, exactly as ajv reports it. */
export interface SchemaCheckError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, JsonValue>;
  message?: string;
}

export interface SchemaCheckResult {
  key: string;
  ok: boolean;
  errors: SchemaCheckError[];
  /** The schema itself could not be compiled — an external `$ref`, an unknown meta-schema. The run would throw on it too. */
  compileError?: string;
}

export interface SchemaCheckResponse {
  results: SchemaCheckResult[];
}

/**
 * Which schema a document already satisfies, so opening a file selects it (DESIGN §11.1).
 *
 * The picker was a menu you had to know the answer to. Every schema in it is `additionalProperties:
 * false`, so satisfying one is a real signal and not a coincidence — an arbitrary JSON file matches
 * nothing, and the answer is `null`.
 *
 * Only ever a SUGGESTION: it fills the picker when the file is first opened, and any explicit choice
 * (including "none") wins from then on. A guess that silently overrode what someone picked would be
 * worse than no guess.
 */
export interface DetectSchemaResult {
  /** The best match, or null when the document satisfies none of them. */
  schemaId: string | null;
  /** Every schema the document satisfies, best first — for a caller that wants to say "or…". */
  candidates: string[];
}

/** Read any file under a layer root as text, addressed by path. */
export interface ReadFileRequest {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root, forward slashes. */
  path: string;
}

/**
 * WHICH file, and which tree to read it in — the address half of a check.
 *
 * Its own type because two channels take exactly this and nothing more: the check, and the release
 * that withdraws its buffer. An address spelled twice is an address that eventually differs in one
 * of the two places.
 */
export interface CheckTarget {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root, forward slashes — addressed exactly as {@link ReadFileRequest}. */
  path: string;
  /**
   * Resolve `path` inside THIS task's worktree rather than in the checkout — what a review is about.
   *
   * An agent's work lives in a worktree, and a worktree is a whole tree: its own `tsconfig.json`,
   * its own `node_modules` junction, its own copy of every sibling the file imports. So a review's
   * proposed side is checked THERE, against the program it would actually be compiled in, rather
   * than against the checkout — where the same path holds the version the agent started from.
   *
   * REFUSED rather than fallen back on when the task has no worktree. A fallback would answer about
   * the checkout's copy of the file, which is a different text that would look like an answer.
   */
  taskId?: string;
}

/**
 * Type-check one file against the REAL project it lives in.
 *
 * The editor already had diagnostics: Monaco ships a TypeScript service in a web worker, and it is
 * the reason a `.ts` file in the Files view was underlined. What it could not do is read a disk. Its
 * program held exactly one file — the one on screen — so every import resolved to nothing, and the
 * squiggle it drew under `./main/service` said the module could not be found and suggested changing
 * `moduleResolution`. The file compiles. The advice was wrong. Every other semantic complaint it
 * made rested on the same empty program and was wrong for the same reason.
 *
 * So the check moves to where the project is. Main holds a real `ts.LanguageService` rooted at the
 * `tsconfig.json` that actually covers the file, with that config's `paths`, `lib`, `jsx` and the
 * checkout's `node_modules` — the same program `tsc` builds — and what comes back are the errors a
 * build would report. Nothing is sent that the renderer could have worked out for itself: syntax is
 * still Monaco's, because a parse needs no project and two parsers would draw every missing brace
 * twice.
 *
 * The BUFFER, not the file. `text` is what is on screen including unsaved edits, so the check
 * follows typing rather than trailing the last save — the rest of the program still comes off disk,
 * which is what makes a rename in another file show up here.
 */
export interface CheckFileRequest extends CheckTarget {
  /**
   * The file as the editor holds it, unsaved edits included. ABSENT means "whatever is on disk",
   * which is what a caller checking a file it is not editing wants.
   */
  text?: string;
  /**
   * Check against the tree as it was BEFORE these files changed, rather than as it stands.
   *
   * This is what makes a diff's left-hand side checkable. The right-hand side is on disk — a
   * worktree holds every changed file at its proposed content — so it is checked in the ordinary
   * way. The left-hand side is a git revision, and nothing anywhere holds a tree at that revision to
   * compile against.
   *
   * It does not need one. A base revision differs from the worktree in exactly the changed files, so
   * putting those files back is the whole difference: everything else is read off the disk it is
   * already on. Send the changeset's before-side here and the answer is the errors that were there
   * before anybody touched anything — which is what turns a red underline in a review from "the
   * agent broke this" into a question that has an answer.
   *
   * The cost is a second program, so this is worth sending only for the side that needs it.
   */
  baseline?: BaselineFile[];
}

/** Where a diagnostic is, in the 1-based line/column an editor counts in. */
export interface FileSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** One thing the compiler has to say about a file. */
export interface FileDiagnostic extends FileSpan {
  /** TypeScript's own severity. `error` is what fails a build. */
  severity: "error" | "warning" | "info";
  /** The TS error number — `2792` and the like, so a reader can look one up. */
  code: number;
  /** Flattened to one string, newline-separated: a chain reads as the paragraph it is. */
  message: string;
  /**
   * Set when the diagnostic is anchored in ANOTHER file — the "…is declared here" half of a chain.
   * Absolute, so the renderer can show where without resolving anything.
   */
  file?: string;
  /** The related spans TypeScript attached, if any — kept so a message that points somewhere can. */
  related?: (FileSpan & { file: string; message: string })[];
}

/**
 * Where a symbol is defined — what "Go to Definition" needs and could not have.
 *
 * Same cause as the wrong squiggles, one step further on. Monaco ships a definition provider backed
 * by its own in-browser TypeScript service, whose program is the single file on screen; a symbol
 * that comes from an import therefore resolves to nothing, and the menu item did nothing at all.
 * Anything defined in the same file worked, which is what made it read as broken rather than absent.
 *
 * Answered by the same `ts.LanguageService` that answers {@link CheckFileRequest} — the one with the
 * project's `paths`, its `node_modules` and its `@types` — so a definition is wherever a build would
 * say it is, including in another package of a monorepo or in a `.d.ts` that shipped with a
 * dependency.
 */
export interface DefineFileRequest extends CheckFileRequest {
  /** Where the caret is. 1-based, the way an editor counts and the way a diagnostic reports. */
  line: number;
  column: number;
}

/**
 * One place a symbol is defined.
 *
 * TypeScript answers with a LIST rather than a place, and the list is genuinely plural: an
 * overloaded function, a merged interface, a type and a value sharing a name. The renderer takes one
 * or offers the choice; nothing here decides for it.
 */
export interface FileLocation extends FileSpan {
  /** Absolute path of the file the definition is in — a NAME, and what a model URI is built from. */
  file: string;
  /**
   * How the Files view would address it, so the window can open it.
   *
   * Absent when the definition is outside the tree the request was rooted at — a dependency resolved
   * through a junction, a file in another checkout. The renderer then knows it cannot go there,
   * which is a better answer than navigating somewhere plausible and wrong.
   */
  at?: { layer: WorkflowLayer; project?: ProjectRef; path: string };
  /** What is defined, for a menu that has to offer several — `answer`, `AppService`. */
  name?: string;
}

export interface FileDefinitions {
  /** Empty when nothing is under the caret, or when what is there resolves nowhere. */
  definitions: FileLocation[];
  /** False for the same reasons {@link FileCheck.checked} is, and with the same meaning. */
  checked: boolean;
}

/**
 * Everywhere a symbol is used — "Find All References".
 *
 * The same question as {@link DefineFileRequest} asked in the other direction, and it needs the same
 * program for the same reason: a name is referenced from files that import it, and a service that
 * has read only the file on screen cannot know any of them.
 */
export interface FileReferences {
  references: FileLocation[];
  checked: boolean;
  /**
   * Set when the answer was cut short — see {@link REFERENCE_FILE_LIMIT}.
   *
   * A search that spans more files than the limit returns the files it did reach rather than a
   * partial one silently dressed as complete. Saying so is the difference between "used in eleven
   * places" and "used in at least eleven places".
   */
  truncated?: boolean;
}

/**
 * How many distinct FILES a reference search will answer for.
 *
 * A bound rather than a taste. Every file in the answer needs a text model in the renderer before
 * the references widget can preview it (Monaco can only resolve a model that already exists), so
 * the size of the answer is the size of a read, and a search for something like `invoke` across a
 * monorepo would be hundreds of them. Sixty file groups is already more than anyone reads in a
 * peek widget, and it is stated rather than silent — see {@link FileReferences.truncated}.
 */
export const REFERENCE_FILE_LIMIT = 60;

/**
 * What the compiler says a symbol IS — the hover.
 *
 * Monaco's own hover comes from its in-browser program, so over an imported name it said `any`, or
 * nothing at all. Which is worse than absent: a type is the one thing a hover exists to tell you,
 * and `any` is a specific and wrong answer.
 */
/**
 * The text of a file the PROGRAM holds — what a peek previews.
 *
 * Not a second `file:read`, and the difference is the whole reason it exists. `file:read` is
 * addressed by layer and path and is contained to a tree root, which is right for a file the person
 * opened and wrong for the answer to a question they did not ask: a definition can resolve outside
 * the tree entirely. In this repository most of them do — `@declarative-ai/*` resolves through a
 * workspace junction into a sibling checkout — so a peek that could only preview files under the
 * project root could not preview the imports the project is mostly made of.
 *
 * What bounds it instead is the PROGRAM. The answer is served only when the compiler already holds a
 * source file at that path, which is the set of files it resolved while answering — so a renderer
 * cannot name a path and be given it. It is also free: the text is in memory, put there by the
 * resolution that produced the definition in the first place, so this reads no disk at all.
 */
export interface SourceFileRequest extends CheckTarget {
  /** Absolute path, exactly as a {@link FileLocation} reported it. */
  file: string;
  /** The tree the question was asked in — see {@link CheckFileRequest.baseline}. */
  baseline?: BaselineFile[];
}

export interface FileHover {
  checked: boolean;
  /** Absent when there is nothing under the caret worth describing. */
  info?: FileSpan & {
    /** The signature as TypeScript prints it — `const answer: 42`, `function f(a: string): void`. */
    signature: string;
    /** The doc comment, flattened, when the symbol has one. */
    documentation?: string;
  };
}

/**
 * What a check came back with.
 *
 * `checked: false` is a real answer and not a failure: it means no TypeScript project claims this
 * file, so nobody knows anything about its types. The renderer draws NOTHING in that case, which is
 * the honest rendering of not knowing — and is why Monaco's own semantic validation is off
 * everywhere rather than left on as a fallback that would be guessing.
 */
export interface FileCheck {
  checked: boolean;
  /** Why not, when `checked` is false — for a surface that wants to say so rather than stay blank. */
  reason?: string;
  /** The `tsconfig.json` the answer came from, absolute. Absent when `checked` is false. */
  config?: string;
  /** True when this answer is about the BASELINE — see {@link CheckFileRequest.baseline}. */
  baseline?: boolean;
  diagnostics: FileDiagnostic[];
}

/**
 * One file, as the Files view's two surfaces receive it.
 *
 * The path-addressed generalisation of {@link WorkflowSource}, and it carries the same fields for
 * the same reasons — plus the `mime`, which is what the surface registry resolves on, and the
 * `stateId` when the file happens to define one. A state file arrives through here like everything
 * else: the panel should not have two ways of holding an open document, because that is how the
 * viewer and the editor end up looking at different revisions of it.
 */
export interface FileSource {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root, forward slashes. */
  path: string;
  /** Absolute path of the file, for display. */
  file: string;
  /** The MIME type, from `mimeOfPath`. */
  mime: string;
  /** The file as it stands, or an empty string when it does not exist yet. */
  text: string;
  /** False when nothing is at this path yet — a write would create it. */
  exists: boolean;
  /** The state this file defines, when it is under `workflows/` and named like one. */
  stateId?: string;
  /** How that state stands against what ships — see {@link BuiltInStanding}. */
  builtIn?: BuiltInStanding;
}

/**
 * Write any file under a layer root, addressed by path.
 *
 * Deliberately does NOT parse what it is given. `workflow:write` exists precisely because a state
 * file must be checked before it lands, and folding the two together would either impose JSON on a
 * markdown prompt or drop the check that keeps the workflow browser loadable. Two channels, two
 * contracts — the renderer picks by what it has open.
 */
export interface WriteFileRequest {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root, forward slashes. */
  path: string;
  /** The full file contents. Directories on the way are created. */
  text: string;
}

/**
 * Keep a map as a NEW toolset in a bucket — the composer's `+` (decision 0007 §5).
 *
 * Checked before it lands, which is why this is not a bare `file:write`: the map must parse as a
 * toolset with no error, the name must be one a reference can carry, and an id the chosen layer
 * already holds is refused rather than replaced — `+` adds, and replacing a toolset other states
 * name is a different act with a different surface. The write itself is `file:write`'s, so the
 * read-only `system` layer is refused by the same sentence it is everywhere else.
 */
export interface SaveToolsetRequest {
  /** The bucket path, `/`-separated — `chat`, `feature/implementation`. */
  bucket: string;
  /** The file's name, without an extension. */
  name: string;
  /** "in this project" or "for all projects". `system` is refused. */
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** The map to keep: subject → mode. */
  toolset: ToolsetDecl;
}

/**
 * Save a toolset from Settings → Toolsets (decision 0007 §6): the WHOLE map, into one layer.
 *
 * What the write is depends on what the layer holds, and the answer says which it was
 * ({@link WriteToolsetResult.kind}): an edit in place, format kept; an override that keeps following
 * the nearest lower layer's file, holding only the lines that differ; or — when a line the lower
 * layer holds was taken out, which an override has no way to say — the whole map, no longer
 * following. The built-in layer is refused.
 */
export interface WriteToolsetRequest {
  /** `<bucket>/<name>`. */
  id: string;
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  toolset: ToolsetDecl;
}

export interface WriteToolsetResult {
  /** The file written, as a person reads it. */
  file: string;
  kind: ToolsetWriteKind;
}

/** "Reset to built in": delete a layer's override, so the layer below answers again. */
export interface ResetToolsetRequest {
  id: string;
  layer: WorkflowLayer;
  project?: ProjectRef;
}

/** Delete a file or a directory under a layer root. A directory takes everything in it. */
export interface DeleteFileRequest {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root, forward slashes. */
  path: string;
  /** Proceed even though states outside the deleted set reference states inside it. */
  force?: boolean;
}

/**
 * What a refused path-addressed rename or delete was protecting.
 *
 * The twin of {@link WorkflowMutationResult}, keyed by path rather than by state id. `referencedBy`
 * counts only referrers OUTSIDE the affected set: a directory whose states point at each other is
 * internally consistent after the move, and naming those would refuse every rename of a workflow
 * folder for a breakage that does not happen.
 */
export interface FileMutationResult {
  path: string;
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** False when the operation was refused because {@link referencedBy} is non-empty. */
  applied: boolean;
  referencedBy: string[];
  /** The state ids the path covered, so the UI can tell whether what it had selected is still there. */
  states: string[];
}

/** What a refused move or delete was protecting, so the UI can name it and offer to go ahead. */
export interface WorkflowMutationResult {
  stateId: string;
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** False when the operation was refused because {@link referencedBy} is non-empty. */
  applied: boolean;
  /** States that declare this one as a child. Empty when nothing points at it. */
  referencedBy: string[];
}

// --- keeping the description and the state files in step -----------------------

/**
 * Which of the two accounts a sync REWRITES.
 *
 * `document` rewrites `workflows/workflow.md` from the workflows; `states` proposes state files from
 * the document. Named after the target rather than the source because that is what the button does
 * and what ends up with unsaved changes in it — "sync from the workflows" and "sync the document"
 * are the same operation, and only one of those phrasings says where the edit lands.
 */
export type SyncDirection = "document" | "states";

/** One state file that differs from the last agreed sync. */
export interface SyncStateChange {
  /** Relative to the layer's `workflows/` directory. */
  path: string;
  change: "added" | "edited" | "removed";
}

/**
 * Which side has moved since the two were last agreed.
 *
 * Both flags can be true, and that case is deliberately not resolved here: when the document and the
 * workflows have both changed, there is no mechanical answer to which one is now right, and picking
 * one would silently overwrite somebody's work. {@link suggested} is null there, and the UI asks.
 */
export interface WorkflowSyncStatus {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** The description, relative to the layer root. */
  path: string;
  exists: boolean;
  /** False when the two have never been synced — there is no baseline, so nothing has "changed". */
  synced: boolean;
  /** When the last sync was accepted. */
  at?: number;
  /** Which way the last sync went, for the "last synced" line. */
  lastDirection?: SyncDirection;
  documentChanged: boolean;
  statesChanged: boolean;
  changedStates: SyncStateChange[];
  /** The direction the drift implies. Null when neither side moved, or when both did. */
  suggested: SyncDirection | null;
  /** Why a sync cannot run right now — no project, no workflows, a state file that will not parse. */
  blocked?: string;
  /** A proposal produced in this session and not yet saved everywhere it applies. */
  pending?: SyncDirection;
  /**
   * Subtrees this description does NOT cover, because a nearer one does.
   *
   * Present so the panel can say what it is not counting. Without it, editing a state that belongs
   * to a child description leaves this document reporting "in step" — true, and completely
   * misleading, because the answer "that belongs to `feature/plan.md`" appears nowhere.
   */
  delegated?: SyncDelegation[];
}

/** One subtree another description owns. */
export interface SyncDelegation {
  /** The owning description, relative to the layer root — what the panel names and links to. */
  document: string;
  /** The state it takes over at. */
  root: string;
  /** How many states sit under it. */
  states: number;
}

export interface WorkflowSyncRequest {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  path: string;
  direction: SyncDirection;
  /**
   * The description as the EDITOR has it, unsaved edits included.
   *
   * Absent ⇒ read from disk. Passed in the ordinary case, because a sync run against the saved file
   * while the author is looking at a changed one would answer a question nobody asked.
   */
  text?: string;
  /**
   * Open the changeset review as soon as a states sync produces a proposal.
   *
   * The review runs as its own task and parks on the gate, so the diff UI arrives as a pending
   * interaction the moment the sync lands — surviving a renderer that reloaded or navigated away
   * during a run that can take an hour. The report and the drafts still return as before; this is
   * the difference between "the proposal exists somewhere" and the reviewer being on screen.
   */
  review?: boolean;
  /** Scripted gate answers for the auto-opened review (tests/demos) — see {@link ReviewSyncRequest}. */
  interactions?: Record<string, JsonValue[]>;
  /** Scripted prompt rules (the `--fake` surface), for demos and tests. */
  fake?: JsonValue;
}

/**
 * One proposed file, whole — a state file under `workflows/`, or a prompt file under `prompts/`
 * (the sync is told to keep reusable prompt text there, in category subfolders, rather than
 * inlining it in state files).
 *
 * Whole rather than a patch: the file is what gets written, a partial edit would have to be applied
 * by something that understood the document, and a draft is text. `applicable` is false for a
 * proposal that cannot be handed over as-is — see {@link WorkflowSyncEdit.blocked}.
 */
export interface WorkflowSyncEdit {
  /** The state id, when the file is a state file — derived from the path. Absent for a prompt file. */
  stateId?: string;
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** Relative to the layer root — where the draft is keyed and where a save would land. */
  path: string;
  action: "create" | "update";
  /** The complete file. */
  text: string;
  /** Why this state has to change, in the words of the check that found it. */
  reason: string;
  /** The requirement ids this edit answers. */
  requirements: string[];
  /** False when it is reported but not offered as a draft. */
  applicable: boolean;
  /** Why not — "this state is authored as YAML and the proposal is JSON". */
  blocked?: string;
}

/**
 * The report a sync run produces, plus what it proposes.
 *
 * The findings are the same ones `jaira workflow check` prints — structurally the runtime's
 * `ConformanceReport`, restated here because the wire contract cannot import the runtime. A sync is
 * a check that then acts, and showing the check is what makes the proposal reviewable rather than
 * something that appeared in the editor for reasons of its own.
 */
export interface WorkflowSyncReport {
  verdict: "conforms" | "gaps" | "diverges";
  requirements: Array<{ id: string; requirement: string; category: string; quote: string }>;
  findings: Array<{
    id: string;
    requirement: string;
    status: "satisfied" | "partial" | "missing" | "contradicted";
    states: string[];
    detail: string;
  }>;
  extras: Array<{ states: string[]; detail: string }>;
}

export interface WorkflowSyncResult extends WorkflowSyncReport {
  /**
   * The sync run's own task, in JaiRA's project. Hand it back as
   * {@link ReviewSyncRequest.parentTaskId} when opening a review of this result, so the review run
   * is recorded as originating from this sync.
   */
  taskId: string;
  direction: SyncDirection;
  /** The workflow roots the run judged, so the report can say what it read. */
  workflows: string[];
  /** The rewritten description. Present for `direction: "document"`. */
  document?: { text: string; changes: Array<{ summary: string; requirements: string[] }> };
  /** The proposed files — states and prompts. Present for `direction: "states"`. */
  edits?: WorkflowSyncEdit[];
  /**
   * The same proposals as ONE changeset (CHANGESETS.md §1) — the applicable edits lowered against
   * the tree as it stands, `source` pinned by content hash. This is what makes a sync's proposal
   * reviewable by the same mechanism that reviews an agent's worktree, instead of a bespoke panel.
   * Present for `direction: "states"` when anything is applicable.
   */
  changeset?: Changeset;
  /** The auto-opened review's task, when the request asked for one and there was a changeset to review. */
  reviewTaskId?: string;
  /** Anything the run wants said that is not an edit — a gap it could not close on its own. */
  notes: string[];
  costUsd?: number;
}

/**
 * Read one addressable value (CHANGESETS.md §8.5): `file:` under an anchor, a `git:` blob in the
 * project's own repository, or a `db://` value a recorded operation returned. One generalised read
 * channel — and anchor-guarded the way artifact destinations already are, because a
 * renderer-reachable channel that resolves arbitrary `file:` URIs is a sandbox escape.
 */
export interface ReadUriRequest {
  /**
   * `$PROJECT/…`, `$JAIRA/…`, `$WORKTREE/…` (needs `taskId`), `file:…`, `git:<sha>:<path>`, `db://…`,
   * `artifact://<taskId>/<logicalPath>`.
   *
   * The artifact form is the `uri` a produced artifact carries, so the value a tool returned is
   * directly readable rather than something a caller has to take apart and reassemble.
   */
  uri: string;
  project?: ProjectRef;
  /** Resolves `$WORKTREE` and scopes a `db://` session id to the task that wrote it. */
  taskId?: string;
}

export interface UriContent {
  uri: string;
  mime: string;
  text: string;
  /** Set when a `file:` URI carried a content hash and the tree no longer matches it (§3.2 drift). */
  drifted?: boolean;
}

/**
 * Hand one artifact to a FRAME — the only way a page a model wrote gets to run its own scripts.
 *
 * The renderer cannot show an interactive artifact by putting its markup in a `srcdoc` iframe: a
 * `srcdoc` document inherits the embedder's CSP, and this app's is `script-src 'self'`, so every
 * inline script in it is refused. (Measured, not assumed.) It has to be loaded from a URL whose own
 * response carries a policy permitting inline script — which means a real scheme and a real handler.
 *
 * The grant is EXPLICIT and one artifact at a time. This mints a single-use address for content the
 * renderer has already named, and the handler serves nothing it was not handed: no path parsing, no
 * traversal to worry about, and no ambient authority to read the artifact map by URL. A protocol that
 * resolved `<taskId>/<path>` on its own would be a second, unauthenticated door into project data.
 */
/**
 * One artifact a task produced, as a LIST reads it.
 *
 * Metadata only. The content is fetched per artifact through `uri:read` — a conversation that wrote
 * forty documents would otherwise send all of them to draw a list of forty names, and the list is
 * what somebody looks at first and usually all they need.
 */
export interface ArtifactSummary {
  /** The logical path, as the producer addressed it — the name this is known by everywhere. */
  path: string;
  mediaType: string;
  bytes: number;
  /** Whether it may run when shown. See {@link ServedArtifact.interactive}. */
  interactive: boolean;
  createdAt: number;
  /** Which state and output slot produced it, when it came from one rather than from a tool call. */
  stateId?: string;
  slot?: string;
}

/**
 * The scheme an interactive artifact is loaded from.
 *
 * Named here because three places must agree on it and none of them may guess: the main process
 * registers and handles it, the renderer's CSP has to name it in `frame-src` (without which the frame
 * falls through to `default-src 'none'` and is refused outright), and the URL the grant returns is
 * built from it.
 */
export const ARTIFACT_SCHEME = "jaira-artifact";

export interface ServeArtifactRequest {
  /** The task whose artifact map holds it. */
  taskId: string;
  /** The logical path, as the producer addressed it. */
  path: string;
  project?: ProjectRef;
  /** Overrides the recorded media type; the record's own is used when absent. */
  mediaType?: string;
}

export interface ServedArtifact {
  /** The address to point a frame at. Meaningless to anything but this window. */
  url: string;
  mediaType: string;
  bytes: number;
  /**
   * Whether the producer asked for this to be able to RUN.
   *
   * Carried back so the renderer cannot decide it: an artifact is scriptable because the tool that
   * made it said so and the record kept it, never because of how it is being viewed today.
   */
  interactive: boolean;
}

/**
 * Review a task's worktree edits as a changeset (CHANGESETS.md) — produce the diff against a base,
 * run the built-in review workflow over it, and let the ordinary interaction flow present the gate.
 * The response returns as soon as the run starts; the reviewer arrives as a pending interaction.
 */
export interface ReviewChangesRequest {
  /** The task whose worktree is reviewed. It must have one. */
  taskId: string;
  /** The revision the diff is taken against. Default HEAD — the agent's uncommitted work. */
  base?: string;
  /** Run the LOOPING review (comments go to a model for revision) instead of the single round. */
  loop?: boolean;
  project?: ProjectRef;
  /** Scripted gate answers (tests/demos) — same shape as {@link StartTaskRequest.interactions}. */
  interactions?: Record<string, JsonValue[]>;
  /** Scripted prompt rules for the loop's respond state (tests/demos). */
  fake?: JsonValue;
}

export interface ReviewChangesResult {
  /** The review run's own task, in JaiRA's project — where the round is recorded (§4.4, §5.3). */
  reviewTaskId: string;
  /** How many changes the produced changeset carries. */
  changes: number;
}

/**
 * Review a SYNC's proposals through the same gate (CHANGESETS.md's "one mechanism, one UI"): the
 * changeset a `workflow:sync` returned, walked through the LOOPING reviewer — a `comment` decision
 * sends the changeset back to a model that revises it against the description, and the revision
 * returns to the gate — with merged decisions applied into the layer root, and the sync baseline
 * moved when the final round merged everything.
 */
export interface ReviewSyncRequest {
  layer: WorkflowLayer;
  /** WHICH project — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
  /** The description the sync ran for — what the baseline is keyed by. */
  path: string;
  /** The changeset the sync produced ({@link WorkflowSyncResult.changeset}). */
  changeset: Changeset;
  /**
   * The sync task the changeset came from ({@link WorkflowSyncResult.taskId}). Recorded on the
   * review task, which is what lets the root listing file the review under the sync workflow it
   * originated from instead of listing `changeset/review-loop` as a workflow of its own.
   */
  parentTaskId?: string;
  /** Scripted gate answers (tests/demos). */
  interactions?: Record<string, JsonValue[]>;
  fake?: JsonValue;
}

/** Store a credential. The value goes to the main process and is never read back out. */
export interface SetSecretRequest {
  name: string;
  /** An empty value REMOVES the secret from the target, which is how a key is revoked. */
  value: string;
  target: SecretTarget;
  /** WHICH project, for a project-scoped target — see {@link ReadWorkflowRequest.project}. */
  project?: ProjectRef;
}

/** What the secret store can actually do here — the keychain needs Electron and an OS that has one. */
export interface SecretCapabilities {
  keychain: boolean;
  /** Why the keychain is unavailable, when it is. */
  keychainReason?: string;
}

/**
 * Request/response map for invoke channels. Keys are channel names; each entry
 * declares its argument and result.
 */
export interface IpcContract {
  "project:open": { request: { dir: string }; response: { dir: string; recovered: string[] } };
  /**
   * Create `.jaira/` in a directory and open it — `jaira init`, reachable from the app.
   *
   * Separate from `project:open` rather than a flag on it, because the two differ in what they may
   * do to a directory somebody picked in a file dialog. Opening reads; this one writes a layout into
   * a folder chosen a moment ago, and a channel whose name says so is one a reviewer can find.
   * Idempotent, and it keeps an existing `settings.json`.
   */
  "project:init": { request: { dir: string }; response: { dir: string; recovered: string[] } };
  /**
   * Ask the OS for a directory. Null when the dialog was dismissed.
   *
   * A picker and nothing else: it neither opens nor initializes what it returns, so the renderer
   * stays the one deciding which of those happens and can report the failure with the path in hand.
   */
  "project:choose": { request: { mode: "open" | "init" } | void; response: { dir: string } | null };
  /**
   * What a directory IS, before anything is done to it: does it exist, does it hold a `.jaira/`, is
   * it already open here.
   *
   * The read behind the offer to set a folder up. Opening a directory that is not a project yet is
   * an ordinary thing to do — it is how every project starts — and answering it with the error
   * `project:open` throws made the app's own "Open project…" produce a red toast for it. Asked
   * first, the renderer can offer `project:init` instead of reporting a failure.
   */
  "project:inspect": { request: { dir: string }; response: { dir: string; exists: boolean; project: boolean; open: boolean } };
  "project:current": { request: void; response: { dir: string } | null };
  /**
   * One project's tasks. Absent `project` ⇒ the focused one, and no project open is an ERROR.
   *
   * `project` is how the Files view reads a shared workflow's runs: those are recorded in the
   * selected root's own project ({@link SHARED_SESSION}), which is a different database from the
   * checkout's and is readable with no checkout open at all.
   */
  "task:list": { request: { project?: ProjectRef } | void; response: TaskSummary[] };
  /**
   * Every task in EVERY open project, each stamped with the project holding it.
   *
   * The root of the address is a real place — "all projects" — and this is what it reads. Distinct
   * from calling `task:list` once per project because the answer is one list in one order, which is
   * what a recency-sorted conversation list needs; per-project calls would have to be merged by a
   * caller that then owns the ordering.
   *
   * `workflows` narrows it to tasks created from those workflow roots. The Chat view passes its two
   * (see `chatWorkflow.ts`), which keeps "what counts as a conversation" in the one module that
   * documents it and keeps this channel from shipping a whole board's worth of rows to draw a list
   * of threads.
   */
  "task:all": { request: { workflows?: string[] } | void; response: ProjectTask[] };
  "task:detail": { request: { taskId: string; project?: string }; response: TaskDetail };
  "task:create": { request: CreateTaskRequest; response: TaskSummary };
  "task:start": { request: StartTaskRequest; response: { taskId: string } };
  "task:cancel": { request: { taskId: string; project?: ProjectRef }; response: { taskId: string } };
  /**
   * Run a task again. A startable task (queued / interrupted / failed) simply starts; a finished one
   * (completed / canceled) cannot re-enter its own lifecycle, so it is duplicated — same title,
   * workflow, inputs and branch, a fresh id — and the COPY starts. The response names the task that
   * actually ran, which is why it can differ from the one asked about.
   */
  "task:rerun": { request: StartTaskRequest; response: { taskId: string } };
  /**
   * Pick a stopped task up where it left off, instead of starting it over.
   *
   * The same task, the same pinned snapshot, and a new run — what differs is that every operation an
   * earlier run already completed is TAKEN from the record rather than dispatched, so the engine
   * walks back to where the task stopped without spending anything and without repeating a single
   * thing that had side effects. The first real call is at the frontier.
   *
   * Refused for a task that is not startable, and refused when the record cannot be read in full:
   * an operation with no answer is one the engine would run again, and saying so beats doing it.
   */
  "task:resume": { request: StartTaskRequest; response: { taskId: string } };
  /** What resuming would do — see {@link ResumePlan}. Cheap enough to ask whenever the panel draws. */
  "task:resumable": { request: { taskId: string; project?: ProjectRef }; response: ResumePlan };
  /**
   * Delete everything past a point in a task's journal, then carry on from there.
   *
   * `at` is a journal seq the view was handed: a chat message's turn (`ChatEditPoint.seq`), a
   * state's entry or a transition (`ConversationTurn.seq`). Every instance entered before the point
   * keeps everything it did; everything entered at or after it goes, with its conversations, and the
   * task resumes through the ordinary load — a parent whose child was cut advances again, a state
   * whose answer was cut asks again. Refused while the task runs. Nothing comes back.
   */
  "task:rewind": {
    request: { taskId: string; at: number; project?: ProjectRef; interactions?: Record<string, JsonValue[]>; fake?: JsonValue };
    response: { taskId: string };
  };
  /**
   * A second task that shares everything up to a point — a COPY of what a rewind at `at` would
   * keep, linked to this one by `parentTaskId`, with fresh ids throughout. The original is not
   * touched.
   *
   * With `message`, the fork is a chat fork: the copy stands as its parent does and the message is
   * sent into it as the next turn. Without one, it is a run fork: the copy resumes at once, and the
   * machine picks up at the cut. Answers the new task's id either way.
   */
  "task:fork": {
    request: {
      taskId: string;
      at: number;
      message?: string;
      overrides?: ChatSettings;
      project?: ProjectRef;
      interactions?: Record<string, JsonValue[]>;
      fake?: JsonValue;
    };
    response: { taskId: string };
  };
  /**
   * Delete a task outright — its runs, its journal, its worktree, its file. Refused while it is
   * running (here or in another process); everything else may go, and none of it comes back.
   */
  "task:delete": { request: { taskId: string; project?: ProjectRef }; response: { taskId: string } };
  /**
   * One board level. `level` is any state id — not only one on the newest task's workflow — so the
   * Files view can open the board of whatever the tree has selected.
   */
  "board:view": { request: { level?: string; project?: string }; response: BoardView };
  /**
   * The top of the board: one column per workflow root, project and shared together. This is the
   * root listing of the file-explorer metaphor, and the only level whose columns have no run order.
   */
  "board:roots": { request: { project?: string } | void; response: BoardView };
  /** Every file under both roots, as a tree — the Files view's left panel. */
  /**
   * The tree for ONE place — see {@link FileTree}.
   *
   * `project` is where the shell is standing (`AppState.at`), because main has no notion of a
   * focused project: `sessionOf()` answers only when exactly one is open, and deliberately, so a
   * call that had to name a project could never have one guessed for it. The tree is the one
   * surface where "where am I" is the whole question, so it is asked.
   */
  "files:tree": { request: { project?: ProjectRef } | void; response: FileTree };
  /** Everything the Files view shows about one state: its board or its tasks, plus the inspector. */
  "state:view": { request: { stateId: string; project?: ProjectRef }; response: StateView };
  /**
   * The slots a set of states declare — what the authoring form needs to open a child's wiring table
   * already showing what must be filled, and to complete a binding against what can be read.
   *
   * A batch rather than one call per child: a state's children are edited together, and N round
   * trips would make the table appear a row at a time. An id that names no state is simply absent
   * from the response, which is how a half-typed reference is reported.
   */
  "state:slots": { request: { stateIds: string[]; project?: ProjectRef }; response: Record<string, StateSlots> };
  /**
   * One state as the loader resolved it — what a panel describing a RUN shows.
   *
   * `taskId` decides which copy: with one, the state is read out of that task's pinned snapshot,
   * which is what the run actually executed; without one, out of the files on disk now. See
   * {@link EffectiveState.from}, which reports which of the two came back.
   *
   * `instanceId` names WHICH execution the values are from, since a loop runs one state several
   * times. Without it the newest execution of that state in the run is used, which is what somebody
   * clicking through from a conversation is looking at.
   */
  "state:effective": {
    request: { stateId: string; taskId?: string; instanceId?: string; project?: ProjectRef };
    response: EffectiveState;
  };
  /** A task's run, read back out of the journal as turns. */
  "task:conversation": { request: { taskId: string; project?: string }; response: ConversationView };
  /**
   * The BASE root's runs — a person's shared workflows, and JaiRA's own syncs (DESIGN §3.1).
   *
   * A separate channel rather than a flag on `task:list` because it takes no project: a window with
   * no project open still has these, which is the whole point of them having a home. Empty, never an
   * error, when the root cannot be opened.
   */
  "task:system": { request: void; response: TaskSummary[] };
  /** Every project this window can draw a board for — the user's, and JaiRA's own. */
  "project:list": { request: void; response: ProjectSummary[] };
  /** Every state a task went through, with the conversation each ran in (§11.3). */
  "session:history": { request: { taskId: string; project?: string }; response: SessionRef[] };
  /**
   * Every call a run made — see {@link OperationRecordView}.
   *
   * Scoped to one run rather than one instance, because a record is not attributed to an instance in
   * the store and does not need to be: a resolved binding finds its own by CONTENT id. So the reader
   * takes the run's records once and looks them up by hash, which is one round trip for a whole
   * conversation instead of one per state.
   */
  "run:records": {
    request: { taskId: string; project?: string };
    response: OperationRecordView[];
  };
  /** One state instance's conversation, whole — see {@link SessionView}. */
  "session:view": {
    request: { taskId: string; instanceId?: string; project?: string };
    response: SessionView;
  };
  /**
   * The task's LIVE turn so far — everything `session:turn` has streamed for the call in flight,
   * re-readable. The record lands only when the operation settles, so while a run works the stream
   * is the only holder of its conversation; without this, a viewer that navigated away and back
   * found the accumulated tail gone and the stored view empty. `null` ⇒ nothing is streaming.
   */
  "session:live": {
    request: { taskId: string; project?: string };
    response: LiveTurnSnapshot | null;
  };
  /**
   * The settings a hand-typed message WOULD run under, before one is sent.
   *
   * Separate from sending because the composer renders the moment a run is selected, and a control
   * that only learned its value by sending would be one nobody could trust before committing to it.
   *
   * `null` is "there is no conversation here", and it is an ANSWER rather than a failure: a
   * composite orchestrates and says nothing, which is the ordinary shape of half the states in a
   * workflow. It is the channel's job to say so plainly — main used to throw, so every selected
   * composite wrote a stack trace to the log for a condition the composer then rendered as a
   * perfectly calm disabled box.
   */
  "chat:plan": {
    request: { taskId: string; instanceId: string; project?: string; overrides?: ChatSettings };
    response: ChatPlanView | null;
  };
  /**
   * The same question one screen earlier: what would a conversation started from this state run
   * under, before there is a conversation to ask about.
   *
   * Not `chat:plan` with a missing task, because the two read different things — that one reads a
   * run's pinned snapshot and the record of what has already answered, this one reads the state file
   * as it is on disk. Never `null`: a state nobody has installed yet is a plan with nothing inherited
   * rather than a refusal, since the Chat view writes its states on the first send.
   */
  "chat:startPlan": {
    request: { stateId: string; project?: string; overrides?: ChatSettings };
    response: ChatPlanView;
  };
  /**
   * Send one message into the conversation an instance ran, as a child of that instance.
   *
   * Not a run: no workspace is materialized, no job is claimed, and the task's status does not move.
   * A conversation continued by hand is a conversation, not a second execution of the workflow.
   */
  "chat:send": {
    request: {
      taskId: string;
      instanceId: string;
      message: string;
      project?: string;
      overrides?: ChatSettings;
      /**
       * Send this message INSTEAD of the one at this position, rather than after everything.
       *
       * What "edit and send again" means down here, and the value is an opaque handle from
       * `chat:thread`'s `points` — the renderer never builds or parses one. The conversation is a
       * chain of records at `<session>@<seq>`, so re-asking at an occupied position forks it: the
       * branch keeps every turn before that message and the new one takes its place. Nothing is
       * deleted; the abandoned branch stays in the record and simply stops being on the path, which
       * is exactly what a reader expects an edited message to do.
       */
      branchAt?: string;
    };
    response: { instanceId: string; index: number; sessionRef?: string; failure?: string; steered?: boolean };
  };
  /**
   * Stop the turn this conversation is taking, if it is taking one.
   *
   * A chat turn is not a run — it claims no job and moves no task status — so `task:cancel` has
   * nothing to abort here (`sendChatMessage` deliberately registers nothing in `live`). This aborts
   * the CALL, which lands in the journal as a canceled turn: the message stays, and what the model
   * had said by then is what the transcript keeps.
   */
  "chat:cancel": { request: { taskId: string; project?: string }; response: { canceled: boolean } };
  /**
   * A task's conversation, whole — every turn of the chain, forks walked (see {@link ChatThreadView}).
   *
   * `null` for a task that holds no conversation to read: one that has never run, or whose states
   * only orchestrate. The Chat view's own tasks always have one after their first message.
   */
  "chat:thread": { request: { taskId: string; project?: string }; response: ChatThreadView | null };
  /**
   * Rename a task. The title is metadata — nothing about the run depends on it — so this is a write
   * to the task file and an invalidation, and it is refused for nothing.
   */
  "task:rename": { request: { taskId: string; title: string; project?: ProjectRef }; response: TaskSummary };
  /**
   * A page of what the app has said about itself — newest first, oldest continued through the page's
   * own `cursor` (see {@link LogPage}).
   *
   * Read from the NDJSON mirror rather than from memory, which is what makes the answer span every
   * launch on disk instead of the one you are in.
   */
  "log:list": { request: LogQuery | void; response: LogPage };
  /** The child processes a run started. */
  "job:list": { request: { project?: string; taskId?: string } | void; response: JobRow[] };
  /**
   * What one of them printed — POLLED, never pushed: a chatty child would flood the channel with
   * output nobody is looking at, and a fetch cannot flood.
   *
   * Whole each time, with no cursor. The capture keeps a head and a tail and REWRITES both on every
   * flush, so row ids change as a process runs — an `afterId` over them would re-deliver everything
   * and call it new. Two rows per stream is a cheap thing to re-read.
   */
  "job:output": {
    request: { project?: string; jobId: number; stream?: "stdout" | "stderr"; limit?: number };
    response: JobOutputChunk[];
  };
  "interaction:pending": { request: void; response: PendingInteraction[] };
  "interaction:submit": { request: SubmitInteractionRequest; response: { requestId: string } };
  /**
   * The js/ts module files a task's start refused over, from the last attempt (SPEC §7.5.5).
   *
   * A separate READ rather than data on the rejection, because an Electron IPC rejection carries a
   * message and nothing else — every own property of the error is dropped in serialization. So
   * `task:start` fails with the human-readable message it always did, the service keeps the list,
   * and a renderer that wants to ASK comes back for it.
   */
  "functions:pending": { request: { taskId: string; project?: string }; response: ModuleApproval[] };
  /**
   * Approve module files by path, then rebuild the process's symbol index.
   *
   * The rebuild is not optional and not the caller's to remember: the index was built gated on an
   * approval that did not exist, so without it the retried start fails exactly as the first did.
   */
  "functions:approve": { request: { files: string[]; project?: string }; response: { approved: number } };
  "approval:pending": { request: void; response: PendingApproval[] };
  "approval:submit": { request: SubmitApprovalRequest; response: { requestId: string } };
  "question:pending": { request: void; response: PendingQuestion[] };
  "question:submit": { request: SubmitQuestionRequest; response: { requestId: string } };
  /**
   * Transitions waiting on a gesture (`on_user_event`) — read by the board to decide which cards can
   * be picked up and which columns will take them.
   *
   * A LIST rather than a request-and-answer pair like the three channels above it, because nothing is
   * shown when one arrives: the wait changes what the board AFFORDS, and a person answers it by doing
   * the ordinary thing the affordance now allows.
   */
  "userEvent:pending": { request: void; response: PendingUserEvent[] };
  /** The gesture happened — the card was dropped where this wait was offering. */
  "userEvent:deliver": { request: { requestId: string }; response: { requestId: string; delivered: boolean } };
  /**
   * `task_move`, published (decision 0005): a person moved this task to a state. Answers the
   * transition waiting on exactly that when one is; otherwise hands the running task a directed
   * transition (held until its running state ends, unless `skip`), or reopens a task that is not
   * running to take it. Refused — rejected with the reason — when the move cannot be made.
   */
  "task:move": { request: TaskMoveRequest; response: TaskMoveResult };
  /**
   * FAST-FORWARD (decision 0005 §4): run the task's machine to a state ahead of where it stands, with
   * its controlling conversation answering what comes up — each answer marked and a rewind point,
   * never an approval — and Skip showing. What `task:connect` hands a forward move; exposed on its
   * own for a caller that already knows the move. Rejected with the reason when it cannot be run.
   */
  "task:fastForward": { request: TaskFastForwardRequest; response: TaskFastForwardResult };
  /**
   * SKIP, from the fast-forward strip: interrupt what is running and enter the target directly,
   * recording what was stepped over `skipped`. The jump is journaled before anything is aborted.
   */
  "task:skip": { request: { taskId: string; project?: ProjectRef }; response: TaskMoveResult };
  /**
   * "Answer it yourself": take back an answer the conversation gave — stop a fast-forward still
   * running, then rewind to the `jaira.answered` row (`at`), so the state asks the person again.
   */
  "task:answerYourself": { request: { taskId: string; at: number; project?: ProjectRef }; response: { taskId: string } };
  /**
   * ADOPT (decision 0005 §2): a task that ran alone becomes the child of a NEW task in a workflow
   * that mounts its state — mirror rows in the parent's journal, nothing copied. With `dryRun` it
   * changes nothing and answers with the same shape, so a hover can say what a drop will do. A
   * refusal is an ANSWER (`ok: false`), not a rejection: schema misfit, a hole, a missing input.
   */
  "task:adopt": { request: TaskAdoptRequest; response: TaskAdoptResult };
  /**
   * CONNECT (decision 0005 §1): send a task to a state, finding or making the workflow that relates
   * the two — a move within its workflow, an adoption into a real one, or a modification of its
   * frozen copy. With `dryRun` it changes nothing and answers the same shape, which is what a board
   * asks once per column while a card hovers. A refusal is an ANSWER (`ok: false`): the inputs that
   * do not bind with their schemas, the workflows to choose between, a forward move that needs `skip`.
   */
  "task:connect": { request: TaskConnectRequest; response: TaskConnectResult };
  /** Take a connect back, with the token it handed out: un-adopt, or rewind to before the move. */
  "task:connectUndo": { request: TaskConnectUndoRequest; response: TaskConnectUndoResult };
  /** "From a task…": the earlier tasks' outputs that fit each slot's schema. */
  "task:inputSources": { request: InputSourcesRequest; response: InputSourcesResponse };
  /** A task's merge requests, for the gate's remote strip (decision 0004). Reads nothing from the forge. */
  "remote:status": { request: { taskId: string; project?: ProjectRef }; response: RemoteStatusView[] };
  /** "Check now": read the forge for this task's awaited requests, then answer as `remote:status` does. */
  "remote:check": { request: { taskId: string; project?: ProjectRef }; response: RemoteStatusView[] };
  /**
   * Reply on a forge thread from the reviewer, while the gate is open — "replying here posts there".
   * Posted as the connection's token owner; optionally resolves the thread. Answers as `remote:check`
   * does, after re-reading, so the reply comes back as the forge's own copy of it.
   */
  "remote:reply": { request: { taskId: string; key: string; thread: string; body: string; resolve?: boolean; project?: ProjectRef }; response: RemoteStatusView[] };
  "workflow:browse": { request: { project?: ProjectRef } | void; response: WorkflowBrowser };
  "workflow:read": { request: ReadWorkflowRequest; response: WorkflowSource };
  "workflow:write": { request: WriteWorkflowRequest; response: WorkflowSource };
  /** Rename, duplicate, or copy a state into the other layer. */
  "workflow:move": { request: MoveWorkflowRequest; response: WorkflowMutationResult };
  /** Which of the description and the state files has moved since they were last in step. */
  "workflow:syncStatus": {
    request: { layer: WorkflowLayer; path: string; text?: string; project?: ProjectRef };
    response: WorkflowSyncStatus;
  };
  /**
   * Run the sync. Nothing is written: the result is a proposal the renderer holds as drafts, which
   * is what makes a model's rewrite of someone's document something they read before it lands.
   */
  "workflow:sync": { request: WorkflowSyncRequest; response: WorkflowSyncResult };
  /** Abort a sync in flight. A model call is long enough that a UI without this is a UI that hangs. */
  "workflow:syncCancel": { request: void; response: { canceled: boolean } };
  /**
   * Health-check the configured provider routes WITHOUT calling one.
   *
   * A route has no `--version` to run, so this reports exactly what can be observed for nothing:
   * whether the named credential resolves and where from, whether a local server ANSWERS its ready
   * URL, whether the weights a route names exist on disk and have a loader installed. `not-checked`
   * where nothing could be observed — reporting an unverifiable route as healthy is the failure this
   * surface exists to prevent, and a check must never spend money.
   */
  "model:probe": { request: void; response: ProbeResult[] };
  /**
   * What can answer a prompt here, as last observed — routes, executors, and the chosen default.
   *
   * The CACHED snapshot. The checks behind it run by themselves at startup, at project open and after
   * every configuration write, so a screen that shows availability reads it rather than asking for
   * it: the app should already know, and a user should not have to press anything to find out.
   */
  "availability:read": { request: void; response: AvailabilitySnapshot };
  /** Re-observe everything now — for a server that has since been started, or a key just installed. */
  "availability:refresh": { request: void; response: AvailabilitySnapshot };
  /** Check a document against a registered schema — see {@link ValidateSchemaRequest}. */
  "schema:validate": { request: ValidateSchemaRequest; response: ValidateSchemaResult };
  /** Check values against the schemas a form is drawn from — see {@link SchemaCheckRequest}. */
  "schema:check": { request: SchemaCheckRequest; response: SchemaCheckResponse };
  /** Which registered schema a document already satisfies — see {@link DetectSchemaResult}. */
  "schema:detect": { request: { text: string }; response: DetectSchemaResult };
  /** Read any file under a layer root as text. Refuses types that are not text. */
  "file:read": { request: ReadFileRequest; response: FileSource };
  /** Type-check one file against its real project — see {@link CheckFileRequest}. */
  "file:check": { request: CheckFileRequest; response: FileCheck };
  /** Where the symbol under the caret is defined — see {@link DefineFileRequest}. */
  "file:definition": { request: DefineFileRequest; response: FileDefinitions };
  /** Everywhere the symbol under the caret is used — see {@link FileReferences}. */
  "file:references": { request: DefineFileRequest; response: FileReferences };
  /** What the symbol under the caret IS — see {@link FileHover}. */
  "file:hover": { request: DefineFileRequest; response: FileHover };
  /** The text of a file the program resolved — see {@link SourceFileRequest}. */
  "file:source": { request: SourceFileRequest; response: { text?: string } };
  /**
   * Stop holding a file's unsaved buffer — the editor closed it.
   *
   * The checker keeps what is on screen so diagnostics follow typing, and a buffer nobody withdrew
   * would go on shadowing the file on disk for the whole session. That matters beyond the file
   * itself: a half-typed edit abandoned without saving would keep producing errors in every OTHER
   * file that imports it.
   */
  "file:release": { request: CheckTarget; response: void };
  /** Read one addressable value — see {@link ReadUriRequest}. Refused rather than guessed at. */
  "uri:read": { request: ReadUriRequest; response: UriContent };
  "artifact:serve": { request: ServeArtifactRequest; response: ServedArtifact };
  /**
   * Who this machine's git would attribute a commit to — what a review note is signed with.
   *
   * Answered from the project's repository so a per-repo `user.name` wins, falling back through
   * git's own precedence to the global one. Both fields are optional: an unset name is ordinary,
   * and the renderer shows a placeholder rather than refusing to let you comment.
   */
  "git:identity": { request: { project?: ProjectRef }; response: { name?: string; email?: string } };
  /** Everything one task produced, oldest first — what the artifacts panel lists. */
  "artifact:list": { request: { taskId: string; project?: ProjectRef }; response: ArtifactSummary[] };
  /**
   * Project files whose path matches a query — what an `@` in the composer completes against.
   *
   * The PROJECT's files, not `.jaira/`'s: `files:tree` answers the other question and is what the
   * Files view browses. A conversation about a checkout is about its source, so this walks the
   * working tree, skipping the directories nobody means (`.git`, `node_modules`, build output) and
   * stopping at a bounded number of results — a mention picker is a way of finding a path you
   * already have in mind, not a search engine.
   */
  "file:find": {
    request: { query: string; project?: ProjectRef; limit?: number };
    response: { paths: string[]; truncated: boolean };
  };
  /** Review a task's worktree edits as a changeset — see {@link ReviewChangesRequest}. */
  "changeset:review": { request: ReviewChangesRequest; response: ReviewChangesResult };
  /** Review a sync's proposed files through the same gate — see {@link ReviewSyncRequest}. */
  "changeset:reviewSync": { request: ReviewSyncRequest; response: ReviewChangesResult };
  /** Write any file under a layer root. Unparsed — see {@link WriteFileRequest}. */
  "file:write": { request: WriteFileRequest; response: FileSource };
  /** Keep a map as a new toolset file in a bucket — see {@link SaveToolsetRequest}. */
  "toolset:save": { request: SaveToolsetRequest; response: ToolsetChoice };
  /**
   * Every toolset, layer by layer, and which states name each — what Settings → Toolsets draws.
   *
   * `usedBy: false` leaves out the "used by" scan, which reads every state file under every layer:
   * the state editor's Tools field wants the toolsets and nothing else, and pays for a directory
   * walk of the toolsets alone.
   */
  "toolsets:read": { request: { project?: ProjectRef; usedBy?: boolean }; response: ToolsetsView };
  /** Save a whole toolset into a layer — see {@link WriteToolsetRequest}. */
  "toolsets:write": { request: WriteToolsetRequest; response: WriteToolsetResult };
  /** Delete a layer's override of a toolset — see {@link ResetToolsetRequest}. */
  "toolsets:reset": { request: ResetToolsetRequest; response: { file: string } };
  /** Create a plain file or a directory under a layer root, addressed by path. */
  "file:create": { request: CreateFileRequest; response: { file: string } };
  /** Rename or move a file or directory within a layer root. Refuses when it would break referrers. */
  "file:rename": { request: RenameFileRequest; response: FileMutationResult };
  /** Delete a file or directory under a layer root. Refuses when it would break referrers. */
  "file:delete": { request: DeleteFileRequest; response: FileMutationResult };
  /** Delete a state file. Refuses while other states reference it, unless `force`. */
  "workflow:delete": {
    request: { stateId: string; layer: WorkflowLayer; force?: boolean; project?: ProjectRef };
    response: WorkflowMutationResult;
  };
  /**
   * Show a file in the OS file manager.
   *
   * Here rather than in the renderer because opening a file manager is Electron's `shell`, and the
   * renderer has no Node integration — which is the property that makes the IPC boundary a security
   * boundary rather than a convention.
   */
  "shell:reveal": { request: { file: string }; response: { file: string } };
  /**
   * Save bytes the RENDERER already holds, through the OS save dialog.
   *
   * Base64 rather than a string, because the things worth downloading are not all text — a
   * rasterised SVG is a PNG — and a channel that took text would need a second one the first time
   * somebody asked to save an image. `file` is null when the dialog was dismissed, which is an
   * outcome and not a failure: a cancelled save must not raise where a caller would report it.
   */
  "shell:saveFile": { request: SaveFileRequest; response: { file: string | null } };
  /**
   * Save whatever is at a URL, letting Chromium fetch it.
   *
   * The case {@link SaveFileRequest} cannot cover: an image inside a sandboxed artifact frame, whose
   * bytes the renderer cannot read — an opaque-origin document is exactly what it must not be able
   * to reach into. The browser already has them, so it does the fetching and the saving both.
   */
  "shell:download": { request: { url: string }; response: { started: boolean } };
  /**
   * Copy the image under a point to the clipboard, in window coordinates.
   *
   * By POSITION rather than by URL, which looks indirect and is the only thing that works: this has
   * to serve images inside artifact frames too, and it is Chromium that knows what is under a point
   * in a frame it is compositing. It also gets the decoding for free — a copied image has to reach
   * the clipboard as a bitmap, and every format the page could display is already decoded.
   */
  "shell:copyImageAt": { request: { x: number; y: number }; response: { copied: boolean } };
  /**
   * The four edit verbs, performed by the BROWSER on whatever has focus.
   *
   * `paste` is why this is a channel at all: `document.execCommand("paste")` is refused in web
   * content, and reading the clipboard from script asks a permission for a gesture the person just
   * made explicitly. Doing all four the same way is then simply consistent — Chromium already knows
   * what is focused, including when what is focused is inside an artifact frame, and matching its
   * own behaviour is the point of offering these at all.
   */
  "shell:edit": { request: { verb: "cut" | "copy" | "paste" | "selectAll" }; response: { verb: string } };
  "history:size": { request: { project?: ProjectRef } | void; response: HistorySize };
  "history:prune": { request: PruneRequest; response: PruneResult & { remaining: HistorySize } };
  /** User preferences (theme). Readable with no project open — they belong to the person. */
  "settings:read": { request: void; response: JairaSettings };
  "settings:write": { request: Partial<JairaSettings>; response: JairaSettings };
  "config:read": { request: { project?: ProjectRef } | void; response: ConfigView };
  "config:write": { request: WriteConfigRequest; response: ConfigView };
  "executor:list": { request: void; response: ExecutorInfo[] };
  /** Health-check executors. Without `name`, every one of them. */
  "executor:probe": { request: { name?: string } | void; response: ProbeResult[] };
  "secret:capabilities": { request: void; response: SecretCapabilities };
  "secret:set": { request: SetSecretRequest; response: { name: string; target: SecretTarget } };
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]["request"];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]["response"];

/**
 * Every channel the bridge will carry, as a runtime list.
 *
 * A second statement of the contract, and it has to be: the preload whitelist and the handler
 * registration both need VALUES, and a type is not one. What it must never be is a second statement
 * that can disagree — `readonly IpcChannel[]` accepted any subset, so adding a channel to the
 * contract and forgetting it here compiled cleanly and failed in front of a person, twice over: the
 * handler was never registered in main, and the preload refused the call as "not part of the IPC
 * contract". Which it was.
 *
 * So the list is checked BOTH WAYS. `satisfies` refuses a name the contract does not declare, and
 * the assertion under it refuses a declared name this list omits — by failing to compile with the
 * missing channel written into the error.
 */
export const IPC_CHANNELS = [
  "project:open",
  "project:init",
  "project:choose",
  "project:inspect",
  "project:current",
  "task:list",
  "task:all",
  "task:detail",
  "task:create",
  "task:start",
  "task:cancel",
  "task:rerun",
  "task:resume",
  "task:resumable",
  "task:rewind",
  "task:fork",
  "task:delete",
  "task:rename",
  "board:view",
  "board:roots",
  "files:tree",
  "state:view",
  "state:slots",
  "state:effective",
  "task:conversation",
  "task:system",
  "project:list",
  "session:history",
  "run:records",
  "session:view",
  "session:live",
  "chat:plan",
  "chat:startPlan",
  "chat:send",
  "chat:cancel",
  "chat:thread",
  "log:list",
  "job:list",
  "job:output",
  "interaction:pending",
  "interaction:submit",
  "functions:pending",
  "functions:approve",
  "approval:pending",
  "approval:submit",
  "question:pending",
  "question:submit",
  "userEvent:pending",
  "userEvent:deliver",
  "task:move",
  "task:fastForward",
  "task:skip",
  "task:answerYourself",
  "task:adopt",
  "task:connect",
  "task:connectUndo",
  "task:inputSources",
  "remote:status",
  "remote:check",
  "remote:reply",
  "workflow:browse",
  "workflow:read",
  "workflow:write",
  "workflow:move",
  "workflow:delete",
  "workflow:syncStatus",
  "workflow:sync",
  "workflow:syncCancel",
  "schema:validate",
  "schema:check",
  "schema:detect",
  "file:read",
  "file:check",
  "file:definition",
  "file:references",
  "file:hover",
  "file:source",
  "file:release",
  "uri:read",
  "artifact:serve",
  "artifact:list",
  "git:identity",
  "file:find",
  "changeset:review",
  "changeset:reviewSync",
  "file:write",
  "toolset:save",
  "toolsets:read",
  "toolsets:write",
  "toolsets:reset",
  "file:create",
  "file:rename",
  "file:delete",
  "shell:reveal",
  "shell:saveFile",
  "shell:download",
  "shell:copyImageAt",
  "shell:edit",
  "history:size",
  "history:prune",
  "settings:read",
  "settings:write",
  "config:read",
  "config:write",
  "executor:list",
  "executor:probe",
  "model:probe",
  "availability:read",
  "availability:refresh",
  "secret:capabilities",
  "secret:set",
] as const satisfies readonly IpcChannel[];

/**
 * The other direction: a channel in the contract that nobody listed.
 *
 * Resolves to `never` when the list is complete, and to the missing channel's own literal type when
 * it is not — so the compiler reports `Type 'true' is not assignable to type '"task:resume"'`, which
 * names the omission rather than merely announcing one.
 */
type UnlistedChannel = Exclude<IpcChannel, (typeof IPC_CHANNELS)[number]>;
const _everyChannelIsListed: UnlistedChannel extends never ? true : UnlistedChannel = true;
void _everyChannelIsListed;

/**
 * The live turn main is holding for a task — the same accumulation a from-the-start watcher builds
 * out of `session:turn` pushes, re-readable by a viewer that arrived late (or left and came back).
 * One per task, replaced when a different position starts speaking, cleared when the record lands —
 * exactly the renderer's own `liveTurn` semantics, held where navigation cannot lose it.
 */
export interface LiveTurnSnapshot {
  sessionId?: string;
  seq?: number;
  stateId?: string;
  /** The agent's own session id, sniffed off the stream's envelopes — stamped onto the open record
   *  row so an interrupted call stays resumable/resyncable. */
  providerSessionId?: string;
  /** When the current answer tail started (host clock). Absent ⇒ no text streaming. */
  textStartedAt?: number;
  /** When the current thinking tail started. Present with an empty answer tail = "still thinking". */
  thinkingStartedAt?: number;
  /** How many deltas are folded in — pushes carrying `n` at or below this are already here. */
  n: number;
  /** The answer's text tail. */
  text: string;
  /** The reasoning tail. */
  thinking: string;
  /** Every entry so far, in order — the same shapes `session:turn.entry` carries, and the same
   *  shapes the record's `entries` will hold. One word for one thing, stream to store. */
  entries: JsonValue[];
  /** Subagent turns streaming by, keyed by the spawning call id. */
  sidechains: Record<string, JsonValue[]>;
  /** The tool call whose ARGUMENTS are still being written, when one is — see {@link WritingTool}. */
  writing?: WritingTool;
}

/**
 * A tool call whose ARGUMENTS are still arriving — the gap between "the model started a call" and
 * "the call exists".
 *
 * That gap is normally imperceptible and occasionally enormous. A tool call reaches the stream as a
 * whole `message` entry, assembled; until it does, the only trace is `input_json_delta` bookkeeping,
 * which every layer discarded. For `bash({command: "ls"})` there is nothing to miss. For
 * `show_artifact` writing a fifteen-kilobyte page there is close to a minute in which the model is
 * producing the entire point of the turn and the transcript has no row for it, no text tail, and
 * nothing thinking — a conversation that looks stopped while the work is being done.
 *
 * So the bookkeeping is kept, in the smallest form that answers "what is it making, and is it still
 * making it": a name, a count, and the first bytes of the arguments — enough for the path, which in
 * every tool that writes anything is the argument the model emits first.
 */
export interface WritingTool {
  /** The tool's name, off the block that opened it. */
  name: string;
  /** The content block it is being written at — how a delta is matched to the call it belongs to. */
  index?: number;
  /** How many characters of arguments have arrived. The size of the thing being made, near enough. */
  chars: number;
  /** The first {@link WRITING_HEAD_MAX} characters of the argument JSON, for the path in it. */
  head: string;
}

/** How much of the argument JSON is worth keeping. A path is in the first line of it or nowhere. */
export const WRITING_HEAD_MAX = 512;

/**
 * The provider's own stream line inside an entry, when the entry is one.
 *
 * Both spellings, for the same reason {@link startsThinking} takes both: a live passthrough nests
 * the line under `provider_event`, a pinned event IS the line.
 */
function streamEventOf(entry: JsonValue): Record<string, unknown> | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const rec = entry as { kind?: unknown; event?: unknown };
  if (rec.kind !== "event" || rec.event === null || typeof rec.event !== "object") return undefined;
  const envelope = rec.event as { type?: unknown; payload?: unknown };
  const line = (envelope.type === "provider_event" ? envelope.payload : envelope) as { type?: unknown; event?: unknown };
  if (line === null || typeof line !== "object" || line.type !== "stream_event") return undefined;
  const event = line.event;
  return event !== null && typeof event === "object" && !Array.isArray(event) ? (event as Record<string, unknown>) : undefined;
}

/**
 * Is this entry pure delta bookkeeping — a fragment whose content arrives again, assembled, on the
 * finished turn?
 *
 * Asked so it can be kept OUT of the live entry list. Nothing renders it (`eventEntry` drops every
 * `stream_event`) and nothing persists it (`partialRecordValue` keeps only messages), but the list
 * is capped, and a tool call streaming a large argument produces hundreds of these — enough to push
 * the conversation itself out of a bounded buffer while it is still being read. The one thing these
 * events actually say is folded first, by {@link startsThinking} and {@link foldWriting}; after that
 * they are noise with a quota.
 */
export function isStreamBookkeeping(entry: JsonValue): boolean {
  return streamEventOf(entry) !== undefined;
}

/**
 * Fold one stream entry into "which call is being written right now", or leave it alone.
 *
 * Lives here, beside {@link startsThinking}, for the identical reason: BOTH accumulations ask it —
 * main's `LiveTurnLog` and the renderer's `session:turn` reducer — and either can be the one holding
 * the tail on screen, so they must agree to the character.
 *
 * The block INDEX is what pairs a delta with its call. A turn can open several blocks, and matching
 * on "the last start we saw" attributes one call's arguments to another the moment two interleave.
 * An event with no index is still folded rather than dropped — a transport that omits it is reporting
 * a stream with one block in it, and refusing the fragment there would show nothing at all.
 */
export function foldWriting(writing: WritingTool | undefined, entry: JsonValue): WritingTool | undefined {
  const event = streamEventOf(entry);
  if (event === undefined) return writing;
  const index = typeof event["index"] === "number" ? (event["index"] as number) : undefined;
  const mine = writing !== undefined && (index === undefined || writing.index === undefined || index === writing.index);
  if (event["type"] === "content_block_start") {
    const block = event["content_block"] as { type?: unknown; name?: unknown } | undefined;
    // A text or thinking block opening ENDS any write in progress on this index: the model has moved
    // on, and a stop we never saw would otherwise leave the row up for the rest of the turn.
    if (block === null || typeof block !== "object" || block.type !== "tool_use") return mine ? undefined : writing;
    return {
      name: typeof block.name === "string" ? block.name : "",
      ...(index !== undefined ? { index } : {}),
      chars: 0,
      head: "",
    };
  }
  if (!mine) return writing;
  if (event["type"] === "content_block_stop") return undefined;
  if (event["type"] === "content_block_delta") {
    const delta = event["delta"] as { type?: unknown; partial_json?: unknown } | undefined;
    if (delta === null || typeof delta !== "object" || delta.type !== "input_json_delta") return writing;
    const fragment = typeof delta.partial_json === "string" ? delta.partial_json : "";
    return {
      ...writing!,
      chars: writing!.chars + fragment.length,
      head: writing!.head.length >= WRITING_HEAD_MAX ? writing!.head : (writing!.head + fragment).slice(0, WRITING_HEAD_MAX),
    };
  }
  return writing;
}

/**
 * The path a half-written argument list is about to name, when it has got that far.
 *
 * A regex over an incomplete JSON string rather than a parse, because there is nothing parseable
 * yet — that is the whole situation. It reads what has actually arrived and answers nothing until
 * the value is closed, so a path is never shown half-typed and never shown wrong.
 *
 * `path` is `show_artifact`'s and `write_file`'s spelling; `file_path` is what the agent's own
 * native writers use. Both are asked for because the row is about what is being MADE, and which tool
 * is making it is not the reader's problem.
 */
export function writingPath(head: string): string | undefined {
  const match = /"(?:file_)?path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

/**
 * Does this stream entry say the model STARTED REASONING?
 *
 * Asked because a thinking block does not always carry text. When the provider withholds the
 * reasoning it streams the block anyway: `content_block_start` for a `thinking` block, then deltas
 * whose `thinking` is `""` and whose only payload is the `signature`. Every layer that timed the
 * tails keyed off thinking TEXT — the transports drop an empty fragment, the folds start the clock
 * on a non-empty one — so a withheld think set no clock, published no tail, and drew no row. A
 * model reasoning for four minutes was an empty conversation, indistinguishable from a hung run,
 * which is exactly how it got reported. The bookkeeping is the only notice that arrives, so the
 * bookkeeping is the signal.
 *
 * Lives here, beside {@link LiveTurnSnapshot}, because it is a fact about the wire shape rather
 * than about either end: BOTH folds ask it — main's `LiveTurnLog` and the renderer's `session:turn`
 * reducer — and either can be the one holding the tail on screen, so they must agree.
 */
export function startsThinking(entry: JsonValue): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const rec = entry as { kind?: unknown; event?: unknown };
  if (rec.kind !== "event" || rec.event === null || typeof rec.event !== "object") return false;
  // A passthrough nests the provider's line under `provider_event`; a pinned event IS the line.
  const envelope = rec.event as { type?: unknown; payload?: unknown };
  const line = (envelope.type === "provider_event" ? envelope.payload : envelope) as { type?: unknown; event?: unknown };
  if (line === null || typeof line !== "object" || line.type !== "stream_event") return false;
  const event = line.event as { type?: unknown; content_block?: { type?: unknown }; delta?: { type?: unknown } };
  if (event === null || typeof event !== "object") return false;
  // The block OPENING is the exact moment thinking began, and it is the signal that survives the
  // transport: upstream normalizes a recognized `text_delta`/`thinking_delta` into a partial (and
  // then drops the empty ones), while everything it has no name for — `content_block_start`,
  // `signature_delta` — is forwarded whole. So the opening is what actually arrives here, and the
  // signature delta is the fallback for a start that was coalesced or dropped (`events_dropped` is
  // a real outcome). `thinking_delta` is listed for a transport that forwards raw events.
  if (event.type === "content_block_start") return event.content_block?.type === "thinking";
  if (event.type === "content_block_delta") {
    return event.delta?.type === "thinking_delta" || event.delta?.type === "signature_delta";
  }
  return false;
}

// --- push channels -----------------------------------------------------------

/**
 * Main → renderer pushes. `engine:event` streams the run record live;
 * `store:invalidate` tells the renderer which views to refetch, which keeps the
 * board consistent without the renderer re-deriving engine semantics.
 */
export type PushMessage =
  | { type: "engine:event"; taskId: string; seq: number; at: number; event: JsonValue; project?: string }
  /**
   * `workflows` fires when a watched workflows directory changes on disk (§11.1's re-lint) — the
   * project's and the shared base root's alike, since a base edit changes what this project runs.
   * `config` fires when either configuration layer is rewritten. `availability` fires when the
   * automatic health checks land — at startup, at project open, and after a configuration write —
   * which is what lets a settings screen show what actually works without having asked for it.
   */
  | {
      type: "store:invalidate";
      scope: "tasks" | "board" | "task" | "workflows" | "config" | "availability";
      taskId?: string;
      /**
       * The project directory this concerns, when it concerns one.
       *
       * A window showing project A must IGNORE an invalidate about B, and the case that forced it is
       * JaiRA's own project: a sync runs there and invalidates ITS task list, so a window with no user
       * project open went and asked for tasks it has none of and was told "no project is open".
       *
       * Absent ⇒ machine-wide, which is what `config` and `availability` are.
       */
      project?: string;
    }
  | { type: "interaction:requested"; pending: PendingInteraction }
  | { type: "interaction:resolved"; requestId: string }
  | { type: "userEvent:requested"; request: UserEventRequest }
  | { type: "userEvent:resolved"; requestId: string }
  | { type: "approval:requested"; pending: PendingApproval }
  | { type: "approval:resolved"; requestId: string; decision: "allow" | "deny" }
  | { type: "question:requested"; pending: PendingQuestion }
  | { type: "question:resolved"; requestId: string }
  | {
      type: "run:finished";
      taskId: string;
      status: "completed" | "failed" | "canceled";
      /** Whose run it was — see `store:invalidate`. */
      project?: string;
    }
  /** One line of what the app did — the Logs panel's live feed (§11.4). */
  | { type: "log:entry"; entry: LogEntry }
  /**
   * A partial answer, as a state is writing it.
   *
   * The transcript is persisted once, when the operation's record closes — correct, because a
   * half-written answer is not a turn, and the reason a long agent run used to show nothing at all
   * while it worked. This is the gap: deltas as they arrive, keyed by the conversation POSITION so a
   * viewer can tell whether they belong to the state it is showing.
   */
  | {
      type: "session:turn";
      taskId: string;
      sessionId?: string;
      seq?: number;
      stateId?: string;
      /** A fragment of the answer's text. Exactly one of `text` / `thinking` / `entry` is present. */
      text?: string;
      /** A fragment of the model's reasoning as it thinks — shown live, never part of the answer. */
      thinking?: string;
      /**
       * A whole conversation ENTRY that is not answer text, in stream order with the fragments:
       * `{kind:"message", role, content}` for a finished turn (tool calls and results ride on the
       * content), `{kind:"event", event}` for anything else the executor emitted, verbatim. The
       * viewer renders every one, understood or not — the stream IS the conversation while the
       * record is still open.
       */
      entry?: JsonValue;
      /**
       * This delta's position in main's live-turn log — {@link LiveTurnSnapshot.n} is the count
       * already folded into a snapshot, so a viewer that just seeded from one skips every push with
       * `n` at or below it instead of applying the same fragment twice.
       */
      n?: number;
    }
  /** A right-click inside a sandboxed artifact frame — see {@link FrameContextMenu}. */
  | { type: "frame:contextMenu"; menu: FrameContextMenu };

/** What {@link IpcContract}'s `shell:saveFile` is handed. */
export interface SaveFileRequest {
  /** The name to propose in the dialog. The extension is what picks the filter, so keep it. */
  name: string;
  /** The bytes, base64. */
  data: string;
}

/**
 * A right-click that happened somewhere this window's own document cannot see.
 *
 * Artifacts render in sandboxed frames with an opaque origin, so a `contextmenu` listener in the
 * renderer never hears about one — which is the sandbox working, not a gap to close. The browser
 * process does hear about it, and forwards what it saw; the renderer draws the SAME menu it draws
 * for its own document, so right-clicking a picture in a mockup behaves like right-clicking a
 * picture anywhere else instead of summoning a second menu system in OS chrome.
 *
 * Everything here is a fact Chromium already had. Nothing in it is trusted as a capability: the
 * actions the menu offers are the same ones it offers elsewhere, and each is checked where it runs.
 */
export interface FrameContextMenu {
  /** Where, in the window's web area — the same space as a DOM event's `clientX`/`clientY`. */
  x: number;
  y: number;
  /** What is selected in the frame, empty when nothing is. */
  selectionText: string;
  /** The link under the cursor, empty when there is none. */
  linkURL: string;
  /** The source of the media under the cursor — an image's `src`. Empty when there is none. */
  srcURL: string;
  /** What kind of media is under the cursor, `none` for ordinary content. */
  mediaType: "none" | "image" | "audio" | "video" | "canvas" | "file" | "plugin";
  /** Whether the thing under the cursor is a field that can be typed into. */
  isEditable: boolean;
  /** What the edit verbs would actually do here — Chromium's own answer, not a guess. */
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export const PUSH_CHANNEL = "jaira:push";

/** The API the preload script exposes on `window.jaira`. */
export interface JairaBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  /** Subscribe to pushes; returns an unsubscribe function. */
  subscribe(listener: (message: PushMessage) => void): () => void;
}
