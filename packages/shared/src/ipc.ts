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
import type { Changeset } from "./changeset";
import type { ComponentConfig } from "./components";
import type { AvailabilitySnapshot, ExecutorInfo, ProbeResult, SecretTarget } from "./executors";
import type { JairaSettings } from "./settings";
import type { SchemaViolation } from "./schemas";
import type { ChatPlanView, ChatSettings } from "./operationVocabulary";
import type {
  BoardView,
  ChatThreadView,
  ConversationView,
  JobOutputChunk,
  JobRow,
  LogEntry,
  LogLevel,
  ProjectSummary,
  SessionRef,
  SessionView,
  FileTree,
  HistorySize,
  PruneResult,
  StateSlots,
  StateView,
  TaskDetail,
  TaskSummary,
  WorkflowBrowser,
  WorkflowLayer,
} from "./view";

// --- invoke channels ---------------------------------------------------------

/**
 * Which project a task-scoped call is about. Absent ⇒ the focused one.
 *
 * Two values are reserved, and they are the only way to reach the projects they name because the
 * focus never points at either: {@link SHARED_SESSION} is the selected root opened as a project, and
 * {@link SYSTEM_SESSION} is JaiRA's own. `shared` is what makes a workflow living in
 * `<root>/workflows` runnable at all — the run has to be recorded somewhere, and recording it in
 * whichever checkout happened to be open is how a shared library becomes one project's clutter.
 */
export type ProjectRef = string;

/**
 * The reserved value of {@link ProjectRef} that names JaiRA's OWN project.
 *
 * Aliases rather than paths, because a caller asking for one is asking for a role — "wherever this
 * machine keeps JaiRA's runs" — and must not have to know where it was put. Re-exported from
 * `paths.ts`, which is where the rest of the path vocabulary lives, but defined here because the
 * renderer sends them and `paths.ts` is Node-only.
 *
 * `system` and {@link SHARED_SESSION} are two projects and the difference is their LIFETIME:
 *
 *  - **system** holds JaiRA's own runs — a description sync, and whatever else it comes to run for
 *    itself. Those happen whatever root is selected, because they are about the installation. It
 *    therefore lives at a fixed location that a root switch does not move.
 *  - **shared** holds runs of the workflows in the ROOT — the shared library a person authors in
 *    `~/.jaira/workflows`. Point the root somewhere else and those runs are not yours any more: a
 *    different root is a different library with a different history, and none of the old tasks
 *    should still be listed.
 *
 * Conflating them meant a sync's bookkeeping travelled with a root switch and sat on the same board
 * as a person's own shared runs. They are separate databases now.
 */
export const SYSTEM_SESSION = "system";

/** The reserved {@link ProjectRef} for the selected root, opened as a project. See {@link SYSTEM_SESSION}. */
export const SHARED_SESSION = "shared";

export interface CreateTaskRequest {
  title: string;
  workflow: string;
  description?: string;
  labels?: string[];
  inputs?: Record<string, JsonValue>;
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
  input: Record<string, JsonValue>;
  taskId?: string;
  at: number;
}

/** How long an approval answer applies (upstream's PermissionScope). */
export type ApprovalScope = "once" | "session" | "workflow-run" | "always";

export interface SubmitApprovalRequest {
  requestId: string;
  decision: "allow" | "deny";
  /** Defaults to `once` — the narrowest answer. */
  scope?: ApprovalScope;
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
  at: number;
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
export interface SubmitInteractionRequest {
  requestId: string;
  value: JsonValue;
}

/** A pending interactive request the renderer must render. */
export interface PendingInteraction {
  requestId: string;
  taskId: string;
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
   * Not the project the request was parked in, which for a changeset review is always JaiRA's own:
   * a review runs there, and the files it is about live in the reviewed task's project (a worktree
   * review) or in the layer root the proposal targets (a sync review). Without the stamp the
   * reviewer read `$WORKTREE`, `$JAIRA` and `$PROJECT` against whatever happened to be FOCUSED —
   * another project's files when one was open, and `no project is open` when none was.
   *
   * Absent ⇒ the focused project, which is right for every request parked by a run of that
   * project's own workflow.
   */
  project?: string;
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
}

/**
 * A prune request (SPEC §13). `apply` is the destructive form; without it the
 * response is a plan, which is what the UI shows before asking.
 */
export interface PruneRequest {
  /** Only prune runs that ended more than this many days ago. Default 0 (any age). */
  olderThanDays?: number;
  /** Most-recent runs to keep per task. Default 1. */
  keepRunsPerTask?: number;
  apply?: boolean;
}

// --- configuration, executors and workflow authoring -------------------------

/**
 * The two configuration layers, as the settings UI addresses them.
 *
 * `base` is the shared root behind every project on this machine; `project` is this checkout's own
 * `.jaira/config.json`, laid over it. Every write names its layer explicitly — there is no "current"
 * layer — because "did I just change this project or every project?" is precisely the question a
 * settings screen must never leave ambiguous.
 */
export type ConfigLayer = "base" | "project";

/** Both layers as authored, plus what they add up to. */
export interface ConfigView {
  /** The raw document of each layer, or null when that layer has no `config.json`. */
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
  /** The whole document for that layer. Parsed and validated before it is written. */
  config: JsonValue;
}

/** Read one workflow state file, as text, from a named layer. */
export interface ReadWorkflowRequest {
  stateId: string;
  layer: WorkflowLayer;
}

export interface WorkflowSource {
  stateId: string;
  layer: WorkflowLayer;
  /** Absolute path of the file, for display. */
  file: string;
  /** The file as it stands, or an empty string when it does not exist yet. */
  text: string;
  /** False when nothing is at this path yet — a write would create it. */
  exists: boolean;
}

export interface WriteWorkflowRequest {
  stateId: string;
  layer: WorkflowLayer;
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
  /** Relative to the layer root, forward slashes. */
  path: string;
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
  /** Relative to the layer root, forward slashes. */
  path: string;
  /** The full file contents. Directories on the way are created. */
  text: string;
}

/** Delete a file or a directory under a layer root. A directory takes everything in it. */
export interface DeleteFileRequest {
  layer: WorkflowLayer;
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
  /** `$PROJECT/…`, `$JAIRA/…`, `$WORKTREE/…` (needs `taskId`), `file:…`, `git:<sha>:<path>`, `db://…`. */
  uri: string;
  project?: ProjectRef;
  /** Resolves `$WORKTREE` and scopes a `db://` session id to the run that wrote it. */
  taskId?: string;
  runId?: number;
}

export interface UriContent {
  uri: string;
  mime: string;
  text: string;
  /** Set when a `file:` URI carried a content hash and the tree no longer matches it (§3.2 drift). */
  drifted?: boolean;
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
  runId: number;
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
   * Idempotent, and it keeps an existing `config.json`.
   */
  "project:init": { request: { dir: string }; response: { dir: string; recovered: string[] } };
  /**
   * Ask the OS for a directory. Null when the dialog was dismissed.
   *
   * A picker and nothing else: it neither opens nor initializes what it returns, so the renderer
   * stays the one deciding which of those happens and can report the failure with the path in hand.
   */
  "project:choose": { request: { mode: "open" | "init" } | void; response: { dir: string } | null };
  "project:current": { request: void; response: { dir: string } | null };
  /**
   * One project's tasks. Absent `project` ⇒ the focused one, and no project open is an ERROR.
   *
   * `project` is how the Files view reads a shared workflow's runs: those are recorded in the
   * selected root's own project ({@link SHARED_SESSION}), which is a different database from the
   * checkout's and is readable with no checkout open at all.
   */
  "task:list": { request: { project?: ProjectRef } | void; response: TaskSummary[] };
  "task:detail": { request: { taskId: string; project?: string }; response: TaskDetail };
  "task:create": { request: CreateTaskRequest; response: TaskSummary };
  "task:start": { request: StartTaskRequest; response: { taskId: string; runId: number } };
  "task:cancel": { request: { taskId: string; project?: ProjectRef }; response: { taskId: string } };
  /**
   * Run a task again. A startable task (queued / interrupted / failed) simply starts; a finished one
   * (completed / canceled) cannot re-enter its own lifecycle, so it is duplicated — same title,
   * workflow, inputs and branch, a fresh id — and the COPY starts. The response names the task that
   * actually ran, which is why it can differ from the one asked about.
   */
  "task:rerun": { request: StartTaskRequest; response: { taskId: string; runId: number } };
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
  "files:tree": { request: void; response: FileTree };
  /** Everything the Files view shows about one state: its board or its tasks, plus the inspector. */
  "state:view": { request: { stateId: string }; response: StateView };
  /**
   * The slots a set of states declare — what the authoring form needs to open a child's wiring table
   * already showing what must be filled, and to complete a binding against what can be read.
   *
   * A batch rather than one call per child: a state's children are edited together, and N round
   * trips would make the table appear a row at a time. An id that names no state is simply absent
   * from the response, which is how a half-typed reference is reported.
   */
  "state:slots": { request: { stateIds: string[] }; response: Record<string, StateSlots> };
  /** A task's run, read back out of the journal as turns. */
  "task:conversation": { request: { taskId: string; project?: string }; response: ConversationView };
  /**
   * JaiRA's OWN runs — the syncs, and whatever else it comes to run for itself (DESIGN §3.1).
   *
   * A separate channel rather than a flag on `task:list`, because the two answer different questions
   * and mixing them is the pollution the system project exists to prevent. Empty, never an error: a
   * window with no project open still has these, which is the whole point of them having a home.
   */
  /** JaiRA's OWN runs — {@link SYSTEM_SESSION}'s. Empty, never an error, when it cannot be opened. */
  "task:system": { request: void; response: TaskSummary[] };
  /** Every project this window can draw a board for — the user's, and JaiRA's own. */
  "project:list": { request: void; response: ProjectSummary[] };
  /** Every state a task went through, with the conversation each ran in (§11.3). */
  "session:history": { request: { taskId: string; runId?: number; project?: string }; response: SessionRef[] };
  /** One state instance's conversation, whole — see {@link SessionView}. */
  "session:view": {
    request: { taskId: string; runId?: number; instanceId?: number; project?: string };
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
    request: { taskId: string; instanceId: number; project?: string; overrides?: ChatSettings };
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
      instanceId: number;
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
    response: { instanceId: number; iteration: number; sessionRef?: string; failure?: string; steered?: boolean };
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
  /** The tail of what the app has said about itself. */
  "log:list": {
    request: { afterId?: number; level?: LogLevel; source?: string; project?: string; limit?: number } | void;
    response: LogEntry[];
  };
  /** The child processes a run started. */
  "job:list": { request: { project?: string; taskId?: string; runId?: number } | void; response: JobRow[] };
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
  "approval:pending": { request: void; response: PendingApproval[] };
  "approval:submit": { request: SubmitApprovalRequest; response: { requestId: string } };
  "question:pending": { request: void; response: PendingQuestion[] };
  "question:submit": { request: SubmitQuestionRequest; response: { requestId: string } };
  "workflow:browse": { request: void; response: WorkflowBrowser };
  "workflow:read": { request: ReadWorkflowRequest; response: WorkflowSource };
  "workflow:write": { request: WriteWorkflowRequest; response: WorkflowSource };
  /** Rename, duplicate, or copy a state into the other layer. */
  "workflow:move": { request: MoveWorkflowRequest; response: WorkflowMutationResult };
  /** Which of the description and the state files has moved since they were last in step. */
  "workflow:syncStatus": { request: { layer: WorkflowLayer; path: string; text?: string }; response: WorkflowSyncStatus };
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
  /** Which registered schema a document already satisfies — see {@link DetectSchemaResult}. */
  "schema:detect": { request: { text: string }; response: DetectSchemaResult };
  /** Read any file under a layer root as text. Refuses types that are not text. */
  "file:read": { request: ReadFileRequest; response: FileSource };
  /** Read one addressable value — see {@link ReadUriRequest}. Refused rather than guessed at. */
  "uri:read": { request: ReadUriRequest; response: UriContent };
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
  /** Create a plain file or a directory under a layer root, addressed by path. */
  "file:create": { request: CreateFileRequest; response: { file: string } };
  /** Rename or move a file or directory within a layer root. Refuses when it would break referrers. */
  "file:rename": { request: RenameFileRequest; response: FileMutationResult };
  /** Delete a file or directory under a layer root. Refuses when it would break referrers. */
  "file:delete": { request: DeleteFileRequest; response: FileMutationResult };
  /** Delete a state file. Refuses while other states reference it, unless `force`. */
  "workflow:delete": {
    request: { stateId: string; layer: WorkflowLayer; force?: boolean };
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
  "history:size": { request: void; response: HistorySize };
  "history:prune": { request: PruneRequest; response: PruneResult & { remaining: HistorySize } };
  /** User preferences (theme). Readable with no project open — they belong to the person. */
  "settings:read": { request: void; response: JairaSettings };
  "settings:write": { request: Partial<JairaSettings>; response: JairaSettings };
  "config:read": { request: void; response: ConfigView };
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

export const IPC_CHANNELS: readonly IpcChannel[] = [
  "project:open",
  "project:init",
  "project:choose",
  "project:current",
  "task:list",
  "task:detail",
  "task:create",
  "task:start",
  "task:cancel",
  "task:rerun",
  "task:delete",
  "task:rename",
  "board:view",
  "board:roots",
  "files:tree",
  "state:view",
  "state:slots",
  "task:conversation",
  "task:system",
  "project:list",
  "session:history",
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
  "approval:pending",
  "approval:submit",
  "question:pending",
  "question:submit",
  "workflow:browse",
  "workflow:read",
  "workflow:write",
  "workflow:move",
  "workflow:delete",
  "workflow:syncStatus",
  "workflow:sync",
  "workflow:syncCancel",
  "schema:validate",
  "schema:detect",
  "file:read",
  "uri:read",
  "file:find",
  "changeset:review",
  "changeset:reviewSync",
  "file:write",
  "file:create",
  "file:rename",
  "file:delete",
  "shell:reveal",
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
];

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
  /** Whole stream items so far, in order — the same shapes `session:turn.item` carries. */
  items: JsonValue[];
  /** Subagent turns streaming by, keyed by the spawning call id. */
  sidechains: Record<string, JsonValue[]>;
}

// --- push channels -----------------------------------------------------------

/**
 * Main → renderer pushes. `engine:event` streams the run record live;
 * `store:invalidate` tells the renderer which views to refetch, which keeps the
 * board consistent without the renderer re-deriving engine semantics.
 */
export type PushMessage =
  | { type: "engine:event"; taskId: string; runId: number; seq: number; at: number; event: JsonValue; project?: string }
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
  | { type: "approval:requested"; pending: PendingApproval }
  | { type: "approval:resolved"; requestId: string; decision: "allow" | "deny" }
  | { type: "question:requested"; pending: PendingQuestion }
  | { type: "question:resolved"; requestId: string }
  | {
      type: "run:finished";
      taskId: string;
      runId: number;
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
      runId: number;
      sessionId?: string;
      seq?: number;
      stateId?: string;
      /** A fragment of the answer's text. Exactly one of `text` / `thinking` / `item` is present. */
      text?: string;
      /** A fragment of the model's reasoning as it thinks — shown live, never part of the answer. */
      thinking?: string;
      /**
       * A whole stream item that is not answer text, in stream order with the fragments:
       * `{kind:"message", role, content}` for a finished turn (tool calls and results ride on the
       * content), `{kind:"event", event}` for anything else the executor emitted, verbatim. The
       * viewer renders every one, understood or not — the stream IS the conversation while the
       * record is still open.
       */
      item?: JsonValue;
      /**
       * This delta's position in main's live-turn log — {@link LiveTurnSnapshot.n} is the count
       * already folded into a snapshot, so a viewer that just seeded from one skips every push with
       * `n` at or below it instead of applying the same fragment twice.
       */
      n?: number;
    };

export const PUSH_CHANNEL = "jaira:push";

/** The API the preload script exposes on `window.jaira`. */
export interface JairaBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  /** Subscribe to pushes; returns an unsubscribe function. */
  subscribe(listener: (message: PushMessage) => void): () => void;
}
