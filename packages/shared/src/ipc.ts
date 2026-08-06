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
import type { ComponentConfig } from "./components";
import type { ExecutorInfo, ProbeResult, SecretTarget } from "./executors";
import type { JairaSettings } from "./settings";
import type { SchemaViolation } from "./schemas";
import type {
  BoardView,
  ConversationView,
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

export interface CreateTaskRequest {
  title: string;
  workflow: string;
  description?: string;
  labels?: string[];
  inputs?: Record<string, JsonValue>;
  branch?: string;
}

export interface StartTaskRequest {
  taskId: string;
  /** Scripted interactive answers, keyed by function name — the headless/demo
   *  path. Absent ⇒ the renderer answers interactive states live. */
  interactions?: Record<string, JsonValue[]>;
  /** Scripted prompt rules (the `--fake` surface), for demos and tests. */
  fake?: JsonValue;
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

/** Answer to a pending interactive request (DESIGN §7.1). */
export interface SubmitInteractionRequest {
  requestId: string;
  value: JsonValue;
}

/** A pending interactive request the renderer must render. */
export interface PendingInteraction {
  requestId: string;
  taskId: string;
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
  /** Scripted prompt rules (the `--fake` surface), for demos and tests. */
  fake?: JsonValue;
}

/**
 * One proposed state file, whole.
 *
 * Whole rather than a patch: the file is what gets written, a partial edit would have to be applied
 * by something that understood the document, and a draft is text. `applicable` is false for a
 * proposal that cannot be handed over as-is — see {@link WorkflowSyncEdit.blocked}.
 */
export interface WorkflowSyncEdit {
  stateId: string;
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
  direction: SyncDirection;
  /** The workflow roots the run judged, so the report can say what it read. */
  workflows: string[];
  /** The rewritten description. Present for `direction: "document"`. */
  document?: { text: string; changes: Array<{ summary: string; requirements: string[] }> };
  /** The proposed state files. Present for `direction: "states"`. */
  edits?: WorkflowSyncEdit[];
  /** Anything the run wants said that is not an edit — a gap it could not close on its own. */
  notes: string[];
  costUsd?: number;
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
  "task:list": { request: void; response: TaskSummary[] };
  "task:detail": { request: { taskId: string }; response: TaskDetail };
  "task:create": { request: CreateTaskRequest; response: TaskSummary };
  "task:start": { request: StartTaskRequest; response: { taskId: string; runId: number } };
  "task:cancel": { request: { taskId: string }; response: { taskId: string } };
  /**
   * One board level. `level` is any state id — not only one on the newest task's workflow — so the
   * Files view can open the board of whatever the tree has selected.
   */
  "board:view": { request: { level?: string }; response: BoardView };
  /**
   * The top of the board: one column per workflow root, project and shared together. This is the
   * root listing of the file-explorer metaphor, and the only level whose columns have no run order.
   */
  "board:roots": { request: void; response: BoardView };
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
  "task:conversation": { request: { taskId: string }; response: ConversationView };
  "interaction:pending": { request: void; response: PendingInteraction[] };
  "interaction:submit": { request: SubmitInteractionRequest; response: { requestId: string } };
  "approval:pending": { request: void; response: PendingApproval[] };
  "approval:submit": { request: SubmitApprovalRequest; response: { requestId: string } };
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
   * A route has no `--version` to run and no free endpoint to poke, so this reports exactly what can
   * be observed for nothing: whether the named credential resolves and where from, whether a local
   * server has an endpoint configured, whether embedded weights are named. `not-checked` where nothing
   * could be observed — reporting an unverifiable route as healthy is the failure this surface exists
   * to prevent, and pressing Test must never spend money.
   */
  "model:probe": { request: void; response: ProbeResult[] };
  /** Check a document against a registered schema — see {@link ValidateSchemaRequest}. */
  "schema:validate": { request: ValidateSchemaRequest; response: ValidateSchemaResult };
  /** Which registered schema a document already satisfies — see {@link DetectSchemaResult}. */
  "schema:detect": { request: { text: string }; response: DetectSchemaResult };
  /** Read any file under a layer root as text. Refuses types that are not text. */
  "file:read": { request: ReadFileRequest; response: FileSource };
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
  "board:view",
  "board:roots",
  "files:tree",
  "state:view",
  "state:slots",
  "task:conversation",
  "interaction:pending",
  "interaction:submit",
  "approval:pending",
  "approval:submit",
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
  "secret:capabilities",
  "secret:set",
];

// --- push channels -----------------------------------------------------------

/**
 * Main → renderer pushes. `engine:event` streams the run record live;
 * `store:invalidate` tells the renderer which views to refetch, which keeps the
 * board consistent without the renderer re-deriving engine semantics.
 */
export type PushMessage =
  | { type: "engine:event"; taskId: string; runId: number; seq: number; at: number; event: JsonValue }
  /**
   * `workflows` fires when a watched workflows directory changes on disk (§11.1's re-lint) — the
   * project's and the shared base root's alike, since a base edit changes what this project runs.
   * `config` fires when either configuration layer is rewritten.
   */
  | { type: "store:invalidate"; scope: "tasks" | "board" | "task" | "workflows" | "config"; taskId?: string }
  | { type: "interaction:requested"; pending: PendingInteraction }
  | { type: "interaction:resolved"; requestId: string }
  | { type: "approval:requested"; pending: PendingApproval }
  | { type: "approval:resolved"; requestId: string; decision: "allow" | "deny" }
  | { type: "run:finished"; taskId: string; runId: number; status: "completed" | "failed" | "canceled" };

export const PUSH_CHANNEL = "jaira:push";

/** The API the preload script exposes on `window.jaira`. */
export interface JairaBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  /** Subscribe to pushes; returns an unsubscribe function. */
  subscribe(listener: (message: PushMessage) => void): () => void;
}
