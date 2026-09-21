/**
 * The app service (DESIGN §11.2): everything the renderer can ask for, with no
 * Electron in sight.
 *
 * Keeping this Electron-free is deliberate — the IPC layer becomes a thin
 * adapter (channel name → method call), and the whole app surface stays
 * testable headlessly against a temp project. It is also where DESIGN §12's
 * "task status is derived from the instance tree" is enforced: every view goes
 * through the projection, never through a UI-side copy of engine semantics.
 */
import type { ChoiceQuestion, ChooseOptionConfig } from "@jaira/shared";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import {
  DirectedTransitions,
  InMemoryPersistence,
  loadBundle,
  moduleHash as moduleHashOf,
  type CallResult,
  type DirectedTransition,
  type EngineEvent,
  type LoadedInstance,
  type LoadedState,
  type WorkflowBundle,
} from "@declarative-ai/hw";
import { hostFunction, type ExecServices, type FunctionInputs, type MemoCache, type RecordRef } from "@declarative-ai/exec";
import type { ExecPolicy } from "@declarative-ai/permissions";
import type { JsonValue } from "@declarative-ai/json";
import {
  baseFileTree,
  baseSource,
  baseStateView,
  beginTaskRun,
  buildTaskLoad,
  rehydrateArtifactInputs,
  releaseRevivedFailures,
  resetUserModules,
  releaseUnconsumedFailures,
  rewindTask as cutTaskJournal,
  forkTask as copyTaskPrefix,
  taskOriginOf,
  parseSessionRef,
  loadPinnedBundle,
  userModules,
  canonicalModulePath,
  prepareUserModules,
  resolveUserFunctions,
  gitFor,
  type HiddenRules,
  boardForState,
  boardView,
  browseBaseWorkflows,
  browseSource,
  browseWorkflows,
  commitSync,
  digestSource,
  conversationView,
  ensureWorkspace,
  fileTree,
  hashText,
  initBase,
  RunOwner,
  runCauses,
  runCostUsd,
  instanceAddresses,
  stateSessions,
  cancelTask,
  createTask,
  deleteTask,
  removeWorktree,
  finishTaskRun,
  hasJournalHistory,
  holdingOf,
  type TaskRuntimeRow,
  historySize,
  initProject,
  isProject,
  // Aliased: this module has its own `isUnder` for dot-separated JSON-schema paths, which is a
  // different question with a different answer for the same two strings.
  isUnder as isUnderState,
  listDescriptions,
  loadLayeredConfig,
  openProject,
  openSharedProject,
  sessionStoreFor,
  JobOutputSink,
  jobOutput,
  SqliteMemoCache,
  SqliteSessionStore,
  messagesOfRecord,
  ownershipOf,
  projectSource,
  pruneHistory,
  rootsBoard,
  stateHashes,
  effectiveState,
  stateSlots,
  stateView,
  taskDetailView,
  readSyncRecord,
  syncDrift,
  taskSummaries,
  workflowRoots,
  bundleFor,
  projectRun,
  eventsOf,
  type DescriptionBoundary,
  type DescriptionOwnership,
  type Project,
  type StoredInteraction,
  type TaskWorkspace,
  type WorkflowDigestOptions,
  type LayerSource,
} from "@jaira/persistence";
import {
  ApprovalHub,
  artifactWiring,
  buildPromptExecutor,
  askedSoFar,
  followUpOperation,
  followUpQuestionsOf,
  followUpServices,
  MAX_FOLLOW_UP_ROUNDS,
  mergedAnswers,
  nextRoundInputs,
  roundOf,
  settledFollowUp,
  wantsFollowUp,
  causesOfEvents,
  compilePolicy,
  enabledAdapters,
  failureMessage,
  enabledGenericAgents,
  listExecutors,
  probeExecutor,
  checkForges,
  registerRemoteFunctions,
  reviewWithRemote,
  RemoteEventHub,
  RemoteWatcher,
  PollingSource,
  forgeForHost,
  type WatchTarget,
  type RemoteSettled,
  type RemoteProgress,
  type PublishAnswer,
  type PublishRequest,
  type ForgeHttp,
  SecretResolver,
  persistEngineArtifacts,
  registerFileTools,
  registerSearchTools,
  createReadFileTool,
  READ_FILE,
  executeWorkflow,
  gateCapabilities,
  registerAgentRuntimes,
  registerCommandFunction,
  registerGenericAgents,
  registerTools,
  registerWebTools,
  gateTools,
  claudePermissionSettings,
  compileClaudeScopeRules,
  grantAlwaysGrantedTools,
  planAgentTools,
  functionNamesOf,
  InteractionHub,
  UserEventHub,
  defaultExecutorTree,
  modelRouterOptions,
  probeModelRoutes,
  agentPromptRoutes,
  agentPromptRouteNames,
  agentRouteVendors,
  createMcpBridgeHost,
  type McpBridgeHost,
  type StartMcpBridge,
  knownModels,
  JAIRA_TOOLS,
  usableRouteKeys,
  newRegistry,
  registerUserFunctions,
  prepareUserFunctions,
  Git,
  NodeExec,
  parseFakeRules,
  policyCanEscalate,
  ScriptedFunctions,
  sessionServicesFor,
  statusOfResult,
  withNativeCapture,
  captureNativeSession,
  foldIntoEntries,
  isEmptyCapture,
  chatOperationOf,
  chatPlanFor,
  stateWithChatSettings,
  holdsConversation,
  isChatInstance,
  runChatTurn,
  withSessionLayers,
  chatInstanceIdOf,
  CHAT_CHILD_KEY,
  type ChatSettings,
  type ChatTurnResult,
  withTurnStream,
  syncOutcomeOf,
  syncRespondPrompt,
  syncRootId,
  syncWorkflowFiles,
  verdictOfFindings,
  editsChangeset,
  registerChangesetFunctions,
  withinWorkspace,
  worktreeChangeset,
  changesetReviewFiles,
  changesetReviewLoopFiles,
  CHANGESET_REVIEW_ID,
  CHANGESET_REVIEW_LOOP_ID,
  REVIEW_ARTIFACTS,
  INTERACTIVE,
  QuestionHub,
  type ApprovalRequest,
  type ExecObserver,
  type FakeRule,
  type HubRequest,
  type PolicyAuditEntry,
  type QuestionRequest,
  type SyncEdit,
} from "@jaira/runtime";
import {
  ARTIFACT_SCHEME,
  compileHidden,
  defaultSettings,
  descriptionRootOf,
  hiddenRules,
  isComponentName,
  isStartableStatus,
  isTextMime,
  changesetOf,
  changesetInputOf,
  type Changeset,
  parseChangesetSource,
  isWritableLayer,
  jairaBasePaths,
  jairaBuiltInPaths,
  DEFAULT_EXECUTOR,
  mergeConfigDocuments,
  mimeOfPath,
  parseComponentConfig,
  parseConfig,
  parseSettings,
  listSchemas,
  propertiesOf,
  resolveExecutorTree,
  schemaById,
  sessionKey,
  JAIRA_DIR_NAME,
  SHARED_SESSION,
  FORGE_LABELS,
  resultOfSettlement,
  REVIEW_NOTE_ARTIFACT,
  handleOfRow,
  type ForgeProvider,
  type RemoteStatusView,
  validateComponentResult,
  WORKFLOW_JSON,
  unnamedRouteOf,
  PERMISSION_PRESETS,
  presetOf,
  ALWAYS_GRANTED_TOOLS,
  declaresTools,
  toolModes,
  toolsetOfSettings,
  withAlwaysGranted,
  isTerminalStatus,
  ApprovalRequired,
  Refusal,
  type ModuleApproval,
} from "@jaira/shared";
import { Diagnostics, stackDetail } from "./diagnostics";
import { WorkerTypeCheck } from "./tsCheck";
import type { BaselineOverlay, TypeCheckPort } from "./tsProject";
import {
  errorToJson,
  resetLevelPolicy,
  resetLogSink,
  setLevelPolicy,
  setLogSink,
  setMinLevel,
  type LevelMatchContext,
  type LevelPolicy,
  type LogRecord,
  type LogSink,
  type ResolvedLevel,
} from "@declarative-ai/log";

/**
 * The sink currently installed BY THIS MODULE, if any.
 *
 * `@declarative-ai/log` has no way to read back the active sink, and a service must not reset one it
 * did not install — with two alive in a process (tests do this), the younger one owns the seam.
 */
let installed: LogSink | undefined;

/**
 * The level policy currently installed BY THIS MODULE, if any.
 *
 * Tracked for the same reason the sink is, and the trap is the same one: `setLevelPolicy` is
 * process-global, so a second service constructed after this one has already replaced it, and a
 * service that reset it unconditionally on close would leave a service that is still running with
 * no policy at all — recording at the library's default rather than at the setting a person chose.
 */
let installedPolicy: LevelPolicy | undefined;
import { LiveTurnFlusher, partialRecordValue } from "./liveTurns";
import { ProjectSession, type SyncHolder, SUSPENDED_WAITING } from "./session";
import type {
  Scope,
  ApprovalScope,
  BoardView,
  ComponentConfig,
  ConfigView,
  ConversationView,
  JobOutputChunk,
  JobRow,
  LogEntry,
  LogLevel,
  LogOverride,
  LogPage,
  LogPolicy,
  LogQuery,
  ProjectSummary,
  ProjectTask,
  RunMetrics,
  SessionOutput,
  SessionRef,
  SessionTurn,
  OperationRecordView,
  SessionView,
  CreateFileRequest,
  CheckFileRequest,
  CheckTarget,
  DefineFileRequest,
  FileDefinitions,
  FileHover,
  FileReferences,
  SourceFileRequest,
  CreateTaskRequest,
  DeleteFileRequest,
  ExecutorInfo,
  FileCheck,
  FileMutationResult,
  FileSource,
  FileNode,
  FileTree,
  AvailabilitySnapshot,
  JairaOperationNode,
  HistorySize,
  JairaSettings,
  LiveTurnSnapshot,
  PendingApproval,
  PendingInteraction,
  PendingQuestion,
  PendingUserEvent,
  TaskMoveRequest,
  TaskMoveResult,
  ProbeResult,
  PruneRequest,
  PruneResult,
  PushMessage,
  MoveWorkflowRequest,
  ReadFileRequest,
  ReadUriRequest,
  ReviewChangesRequest,
  ReviewChangesResult,
  ReviewSyncRequest,
  ArtifactSummary,
  ProjectRef,
  ServeArtifactRequest,
  ServedArtifact,
  UriContent,
  ReadWorkflowRequest,
  RenameFileRequest,
  SecretCapabilities,
  SetSecretRequest,
  StartTaskRequest,
  ResumePlan,
  SchemaViolation,
  StateSlots,
  StateView,
  EffectiveState,
  EffectiveStateValues,
  DetectSchemaResult,
  ValidateSchemaRequest,
  ValidateSchemaResult,
  SchemaCheckRequest,
  SchemaCheckResponse,
  SchemaCheckError,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  WorkflowBrowser,
  WorkflowLayer,
  WritableLayer,
  WorkflowMutationResult,
  WorkflowSource,
  WorkflowSyncEdit,
  WorkflowSyncRequest,
  WorkflowSyncResult,
  WorkflowSyncStatus,
  SyncDirection,
  WriteConfigRequest,
  WriteFileRequest,
  WriteWorkflowRequest,
  InstanceNode,
  ChatBranch,
  ChatEditPoint,
  ChatFork,
  ChatPlanView,
  ChatThreadView,
  JairaPromptNode,
  PermissionMode,
  ToolChoice,
} from "@jaira/shared";
import { fanOutHostFor } from "./fanOut";

export type Publish = (message: PushMessage) => void;

export interface AppServiceOptions {
  /** Where pushes go — the Electron main process forwards them to the renderer. */
  publish?: Publish;
  /**
   * The persistent MCP bridge CLI agent runs register on. Default: a worker-thread host reading its
   * worker file from beside `main.cjs` — right for the bundled app, and a seam here so a test that
   * runs a real CLI agent from source can hand in a host that knows where the worker is.
   */
  bridgeHost?: McpBridgeHost;
  /** Deterministic request ids in tests. */
  nextInteractionId?: () => string;
  nextApprovalId?: () => string;
  nextQuestionId?: () => string;
  nextUserEventId?: () => string;
  /**
   * Read a crashed call's native session files at recovery. Default: the real
   * `~/.claude/projects` reader — a seam for the same reason every other file-I/O boundary here has
   * one, since the alternative is a test that has to lay out an agent's config directory.
   */
  captureNative?: typeof captureNativeSession;
  /**
   * Debounce for the workflows watcher, ms. An editor writes a file in several
   * syscalls, so re-linting on every raw event would lint half-written files.
   */
  watchDebounceMs?: number;
  /** Set false to skip watching `.jaira/workflows/` (tests that don't need it). */
  watchWorkflows?: boolean;
  /**
   * The OS keychain, injected by the Electron main process.
   *
   * Injected rather than imported because `safeStorage` is Electron's and this class must stay
   * Electron-free — that is what keeps the whole app surface testable headlessly, and it lets a
   * test drive the secret paths with an in-memory store.
   */
  keychain?: KeychainPort;
  /** Override the shared base root. Defaults to the saved setting, then `JAIRA_HOME`, then `~/.jaira`. */
  baseDir?: string;
  /**
   * Show a file in the OS file manager, injected by the Electron main process.
   *
   * Injected for the same reason the keychain is: `shell.showItemInFolder` is Electron's, and this
   * class stays Electron-free so the whole app surface remains testable headlessly. Absent in a
   * headless run, where "reveal" has no meaning and quietly doing nothing is the right answer.
   */
  reveal?: (file: string) => void;
  /**
   * Ask the OS for a directory, injected by the Electron main process.
   *
   * The last capability this class cannot have itself, for the same reason as {@link reveal}:
   * `dialog.showOpenDialog` is Electron's. Absent in a headless run, where {@link chooseProject}
   * answers null — a test drives {@link open} and {@link init} with a path directly, which is the
   * part worth testing anyway.
   */
  chooseDirectory?: (options: { title: string; buttonLabel: string }) => Promise<string | null>;
  /**
   * Run the availability checks by themselves — at construction, at project open, and after every
   * configuration write.
   *
   * OFF by default, and turned on by the Electron main process. The asymmetry is deliberate: the
   * checks spawn `--version` processes and open a socket, which is exactly right for an app that has
   * a settings screen to keep current and exactly wrong for a headless caller that constructs a
   * service to read one projection. A constructor that spawns processes unasked is a constructor
   * every test then has to work around.
   *
   * Nothing about the checks themselves depends on this: {@link AppService.refreshAvailability} is
   * always available, and the snapshot is always readable — this only decides who triggers them.
   */
  probeOnStart?: boolean;
  /**
   * How a forge is reached (decision 0004 §1). Absent ⇒ the platform `fetch`; a test passes a replay,
   * so checking a connection never leaves the process.
   */
  forgeHttp?: ForgeHttp;
  /**
   * What answers {@link AppService.checkFile} — the TypeScript language service, wherever it runs.
   *
   * Injected for the reason every other port here is: the real one spawns a worker thread that loads
   * a bundled file out of `dist/`, which exists in the packaged app and not in a test. A test hands
   * in {@link TsProjects} directly and checks real files against a real `tsconfig.json`, which is
   * the part worth testing — the thread is a performance decision, not part of the meaning.
   *
   * Absent means the worker-backed one, built on first use. Nothing is spawned by a service that is
   * never asked to check a file.
   */
  typeCheck?: TypeCheckPort;
}

/**
 * The encrypted secret store, as this service needs it.
 *
 * Deliberately synchronous and tiny. Everything about WHERE the bytes go is Electron's problem;
 * what matters here is that the value never crosses back into the renderer, which is why there is
 * no bulk read.
 */
/**
 * What kind of failure reached {@link AppService.recordCrash} — the word that leads the log line.
 *
 * `push` is here so a send that failed is not filed as an uncaught exception. It is neither: nothing
 * escaped, the sender caught it, and calling it what it is keeps the Logs panel honest for the one
 * failure most likely to be silent.
 *
 * `renderer` is the window failing rather than this process — it crashed, it hung, it would not
 * load, or it printed an error. Recorded HERE because the Logs panel is drawn by the renderer, so
 * the surface that would have reported the failure is the one that just stopped: main is the only
 * side of the wire that survives a white window, and until it listened, nothing did.
 */
export type CrashKind = "unhandledRejection" | "uncaughtException" | "push" | "renderer";

export interface KeychainPort {
  /** False on a platform (or a build) with no encrypted store — the chain then starts at `.env.local`. */
  available(): boolean;
  /** Why it is unavailable, for the UI to explain rather than silently offering fewer options. */
  reason?: string;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  remove(name: string): void;
}

/**
 * ajv's errors, as one row per actual mistake.
 *
 * Every leaf in these schemas is an `anyOf` — its own type, or one of the binding forms a value may
 * arrive as (`$ref`, `expr`, `json`). That is what stops a reference being reported as an error, and
 * it has a cost ajv makes you pay at the other end: one wrong `temperature` produces FIVE errors, one
 * per failed branch plus the `anyOf` itself. Five rows for one typo is how a panel becomes noise
 * people stop reading, which would cost more than the validation is worth.
 *
 * So errors are grouped by what they are ABOUT, and each group reports once. Within a group the first
 * non-`anyOf` error wins: branch order is schema order, and branch zero is always the field's own
 * type — which makes "must be number" the message, rather than "must match a schema in anyOf".
 *
 * The grouping key is the path, EXCEPT for unknown fields: those all sit at the parent's path, so two
 * misspelled keys in one object would collapse into one row. They key on the offending name instead.
 */
/** One allowed value, as it would be written in the file — quoted when it is a string. */
function literal(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

/**
 * True for an error that only exists because a leaf offers the binding forms.
 *
 * Every leaf is `anyOf: [own type, {$ref}, {$expr}, {json}]`. When something deep inside one is wrong,
 * ajv reports the real error AND, at every enclosing level, that the value "must have required
 * property '$ref'" — because it did not happen to be a reference either. One misspelled `type` four
 * levels down produced four rows, three of them advising that `inputs` could have been a `$ref`.
 *
 * None of those is ever an authoring error: nothing in this format requires the author to write a
 * binding form, so a `required` error naming one is always the wrapper talking about itself.
 */
function isBindingFormArtifact(error: ErrorObject): boolean {
  if (error.keyword !== "required") return false;
  const missing = (error.params as { missingProperty?: string }).missingProperty;
  return missing === "$ref" || missing === "$expr" || missing === "json";
}

function collapseErrors(all: readonly ErrorObject[]): SchemaViolation[] {
  // Keep the unfiltered set as a fallback: reporting nothing for a document ajv called invalid would
  // be a worse failure than reporting noise.
  const real = all.filter((error) => !isBindingFormArtifact(error));
  const errors = real.length > 0 ? real : all;

  const groups = new Map<string, ErrorObject[]>();
  for (const error of errors) {
    // ajv's `instancePath` is a JSON pointer (`/operation/temperature`); the editor shows dotted
    // paths, which is how the format's own documentation writes them.
    const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
    const extra =
      error.keyword === "additionalProperties"
        ? String((error.params as { additionalProperty?: string }).additionalProperty)
        : "";
    const key = `${path}|${extra}`;
    const group = groups.get(key);
    if (group) group.push(error);
    else groups.set(key, [error]);
  }

  const rows = [...groups.entries()].map(([key, group]) => {
    const chosen = group.find((error) => error.keyword !== "anyOf") ?? group[0]!;
    const path = key.slice(0, key.lastIndexOf("|"));
    return { path, keyword: chosen.keyword, ...messageFor(chosen) };
  });

  /**
   * Drop an `anyOf` summary that a deeper error already explains.
   *
   * "must match a schema in anyOf" says nothing on its own, and ajv emits one at every level between
   * the root and a nested failure. A misspelled `type` inside `inputs.x.schema` reported four rows:
   * the useful one, and three ancestors saying they had failed to match — which they had, because of
   * the useful one.
   *
   * Only ancestors are dropped, not every `anyOf`. Two independent problems in one document both
   * deserve a row, and the second may have nothing better than an `anyOf` to say for itself.
   */
  const explained = rows.filter(
    (row) =>
      row.keyword !== "anyOf" ||
      !rows.some((other) => other !== row && isUnder(other.path, row.path)),
  );

  return explained.map(({ path, message }) => ({ path, message }));
}

/** True when `path` names something strictly inside `ancestor`. */
function isUnder(path: string, ancestor: string): boolean {
  if (path === ancestor) return false;
  return ancestor.length === 0 ? path.length > 0 : path.startsWith(`${ancestor}.`);
}

/** One error, worded for someone reading it beside the document rather than debugging a validator. */
function messageFor(error: ErrorObject): { message: string } {
  if (error.keyword === "additionalProperties") {
    const name = String((error.params as { additionalProperty?: string }).additionalProperty);
    return { message: `unknown field '${name}' — nothing else is recognized here` };
  }
  // "must be equal to one of the allowed values" without saying which ones sends you to the
  // documentation for something the schema is already holding. ajv puts them in `params`.
  if (error.keyword === "enum") {
    const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
    if (allowed.length > 0) return { message: `must be one of: ${allowed.map(literal).join(", ")}` };
  }
  if (error.keyword === "const") {
    const allowed = (error.params as { allowedValue?: unknown }).allowedValue;
    if (allowed !== undefined) return { message: `must be ${literal(allowed)}` };
  }
  return { message: error.message ?? "is not valid" };
}

/**
 * How a file is addressed while a sync proposal is outstanding.
 *
 * The same `layer:path` spelling the renderer keys its drafts by (`renderer/drafts.ts`), and that is
 * the point: the set of files a sync is waiting on and the set of files with unsaved edits are the
 * same set, and two spellings of one key is how they would come to disagree about which file.
 */
function docKey(layer: WorkflowLayer, path: string): string {
  return `${layer}:${path}`;
}

/** What a state file may be called on disk — the suffixes `existingStateFile` searches. */
const STATE_FILE_SUFFIX = /\.(json|jsonc|ya?ml)$/i;

/**
 * One proposed path, in the spelling {@link AppService.placeEdits} places from.
 *
 * The prompt asks for a path under `workflows/` or `prompts/` and says so twice, and models answer
 * with the STATE ID anyway — `feature/documentation.json` rather than
 * `workflows/feature/documentation.json`. That is not a near miss to be refused: an id is what the
 * digest they were reading is keyed by, so the omitted prefix is the one thing about the answer that
 * came from this app's filing rather than from the workflow. A whole run's proposals were blocked on
 * it (fourteen files, none applicable, nothing to review), which is the worst possible shape for a
 * mistake — the work was done and correct, and the report said the sync found nothing.
 *
 * So a bare path is folded into `workflows/` when it can only be a state file: a state-file suffix,
 * or no suffix at all, which is a state id written plainly. Nothing else is widened — `lib/helper.md`
 * is still refused, because a bare `.md` is as likely to be a description as a prompt and guessing
 * between them would put a proposal in a directory nobody asked for. Containment is unaffected:
 * every path still goes through `layerFile`/`workflowFile`, so `../../.ssh/config` is refused by the
 * same check it always was — one prefix further in.
 */
export function syncEditPath(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.startsWith("workflows/") || path.startsWith("prompts/")) return path;
  const last = path.slice(path.lastIndexOf("/") + 1);
  const suffixed = last.includes(".");
  if (!suffixed || STATE_FILE_SUFFIX.test(last)) return `workflows/${path}`;
  return path;
}

/**
 * A root directory as a person writes it: `~/.jaira` under the home directory, the path otherwise.
 *
 * The basename alone is not enough for this one. Every other project is named for its checkout, where
 * the basename IS the name; the shared root's basename is `.jaira`, which names nothing on its own
 * and collides with any project that happens to contain one.
 */
function shortRoot(dir: string): string {
  const home = homedir();
  const rel = relative(home, dir);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel.split(sep).join("/")}` : dir;
}

/**
 * The shared root's nodes, with `shadowed` reduced across every open project's view of it.
 *
 * `shadowed` means "this copy is not the one that loads", which is a fact about ONE project — and
 * the shared root is listed once, beside all of them (SHELL.md §2.2). So it survives only where
 * EVERY open project overrides the state: that is the one reading still true of a row belonging to
 * no project. A file two of three projects override is left unmarked, because in the third it is
 * exactly the file that runs.
 *
 * Shape is taken from the first tree — the roots are the same directory walked the same way, so they
 * differ only in these marks.
 */
function sharedShadows(trees: readonly FileTree[]): FileNode[] {
  const bases = trees.map((tree) => tree.roots.find((root) => root.layer === "base")?.nodes ?? []);
  const merge = (lists: FileNode[][]): FileNode[] =>
    (lists[0] ?? []).map((node, index) => {
      const everywhere = node.shadowed === true && lists.every((list) => list[index]?.shadowed === true);
      const out: FileNode = { ...node };
      if (!everywhere) delete out.shadowed;
      if (node.children !== undefined) out.children = merge(lists.map((list) => list[index]?.children ?? []));
      return out;
    });
  return merge(bases);
}

/**
 * A question as the renderer sees it (the hub's request, minus the session key).
 *
 * `project` is passed rather than read off the request because the hub does not know it: hubs are
 * built per session by {@link AppService.hubsFor}, and the session is what supplies the answer.
 */
function pendingQuestionOf(request: QuestionRequest, project: string): PendingQuestion {
  return {
    requestId: request.requestId,
    questions: request.questions as PendingQuestion["questions"],
    ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
    project,
    at: request.at,
  };
}

/** An approval as the renderer sees it (the hub's request, minus internals). */
function pendingApprovalOf(request: ApprovalRequest, project: string): PendingApproval {
  return {
    requestId: request.requestId,
    tool: request.tool,
    ...(request.command !== undefined ? { command: request.command } : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    input: request.input as Record<string, JsonValue>,
    ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
    project,
    at: request.at,
  };
}

/**
 * Stamp a gate with its parsed contract — the one step a live park and a recovered row share.
 *
 * Parsed here, once, so the renderer receives a normalized contract instead of re-deriving it, and
 * so a malformed state file surfaces as a parse error on the request rather than an empty dialog.
 *
 * From `inputs` itself, not from `inputs["config"]`. There is no `config` key and there never was:
 * a component's authored surface IS `operation.args` — which is what `componentConfigIssues` lints
 * — and a function receives its args merged with the state's resolved inputs, flat. Reading a key
 * nothing writes meant `config` was undefined for every component ever parked, and the renderer got
 * `configError` instead of a contract.
 */
function withContract(pending: PendingInteraction): PendingInteraction {
  if (!isComponentName(pending.component)) return pending;
  try {
    pending.config = parseComponentConfig(pending.component, pending.inputs);
  } catch (e) {
    pending.configError = (e as Error).message;
  }
  return pending;
}

/**
 * `startTask` as the service sees it. The IPC contract carries `fake` as opaque
 * JSON (it is parsed with `parseFakeRules`); in-process callers usually have
 * typed rules already, so both are accepted here.
 */
/**
 * Re-exported, NOT redefined.
 *
 * A second `class Refusal` here would typecheck, read identically, and quietly break the one thing
 * the marker is for: `instanceof` is per-class, so a refusal thrown by `@jaira/persistence` would
 * fail the check below and be re-filed at `error` as a malfunction. There is one class, in
 * `@jaira/shared`, because every package that refuses has to be measured against the same one.
 */
export { Refusal } from "@jaira/shared";

/**
 * Fields a library may attach that this app indexes rather than buries in `detail`, and the type
 * each has to BE.
 *
 * Checked rather than cast. `LogRecord.fields` is `Record<string, unknown>` filled by whatever call
 * site wrote it, so `{ taskId: 42 }` is a typo nothing stops — and a `LogEntry.taskId` holding a
 * number is a crash in whichever renderer treats it as the string its type promises. A value of the
 * wrong shape stays in `detail`, where it is visible and harmless.
 */
const POINTERS = {
  taskId: "string",
  instanceId: "string",
  jobId: "number",
  project: "string",
} as const;

/**
 * A library's log record as one of this app's entries.
 *
 * The SCOPE becomes the source, because that is what each already is: `jaira.persistence.lifecycle`
 * and `engine.providers.generate` say where a line came from in exactly the way the panel's `source`
 * column exists to show, and inventing a mapping table would only let the two drift.
 *
 * The pointers are lifted out of `fields` rather than left inside `detail`, because they are what
 * makes a row ACTIONABLE — `taskId` opens the task, `jobId` opens that process's output. Everything
 * else stays as detail, unread until somebody expands the row.
 */
function entryOfRecord(record: LogRecord): Omit<LogEntry, "id" | "at"> {
  const fields = { ...(record.fields ?? {}) };
  const pointers: Record<string, string | number> = {};
  for (const [key, want] of Object.entries(POINTERS)) {
    const value = fields[key];
    if (value === undefined) continue;
    // Only when it is what it claims to be. A mistyped pointer is left where it was rather than
    // promoted into a typed field it does not satisfy.
    if (typeof value !== want) continue;
    pointers[key] = value as string | number;
    delete fields[key];
  }
  const detail = { ...fields, ...(record.err !== undefined ? { err: errorToJson(record.err) } : {}) };
  return {
    level: record.level,
    source: record.scope,
    message: record.message,
    ...(pointers as { taskId?: string; instanceId?: string; jobId?: number; project?: string }),
    ...(Object.keys(detail).length > 0 ? { detail: detail as JsonValue } : {}),
  };
}

/**
 * The app's log policy, in the shape `@declarative-ai/log` asks a consumer for.
 *
 * The library resolves a record's level through this BEFORE formatting it, which is the only place a
 * `debug` inside a hot loop costs nothing at all. `undefined` means "no opinion here" and the
 * library falls back to its global minimum — which {@link AppService.applyLogPolicy} keeps in step
 * with the policy's own floor, so the two can never disagree.
 *
 * Errors are not sampled: the library enforces that itself, and {@link Diagnostics} enforces it
 * again on the app's own entries, because a policy that can lose an error makes every absence in the
 * file ambiguous.
 */
function resolveLogLevel(policy: LogPolicy, scope: string, tag: string | undefined): ResolvedLevel | undefined {
  const rule = logOverrideFor(policy, scope, tag);
  if (rule === undefined) return { minLevel: policy.minLevel, samplingRate: 1 };
  return { minLevel: rule.minLevel, samplingRate: rule.samplingRate ?? 1 };
}

/** `a.b.c` is under `a.b` and under itself — the same rule the Logs panel's source filter uses. */
const underLogScope = (scope: string, ancestor: string): boolean => scope === ancestor || scope.startsWith(`${ancestor}.`);

/** A tag beats a scope, and the longest matching scope beats a shorter one. See {@link LogOverride}. */
function logOverrideFor(policy: LogPolicy, scope: string, tag: string | undefined): LogOverride | undefined {
  if (tag !== undefined) {
    const hit = policy.overrides.find((o) => o.match === "tag" && o.key === tag);
    if (hit !== undefined) return hit;
  }
  let best: LogOverride | undefined;
  for (const o of policy.overrides) {
    if (o.match !== "scope" || !underLogScope(scope, o.key)) continue;
    if (best === undefined || o.key.length > best.key.length) best = o;
  }
  return best;
}

export interface StartRunRequest extends Omit<StartTaskRequest, "fake"> {
  fake?: JsonValue | FakeRule[];
}

export class AppService {
  /**
   * The open projects, by {@link sessionKey}.
   *
   * A map rather than a field, because a process holds several: the user's work, and — from the
   * moment JaiRA's own runs became tasks — the base root behind it. Keyed by canonical
   * directory so two spellings of one path cannot become two `better-sqlite3` handles on one file.
   */
  private readonly sessions = new Map<string, ProjectSession>();

  /**
   * ONE request-id generator for every hub in the process.
   *
   * Per-session counters would each emit `ui-1`, and `submitInteraction` carries nothing but a
   * request id — so two projects with a gate open would answer each other's. The generator is shared
   * and the owner is recorded, which makes the id globally unique and the lookup O(1).
   */
  private interactionSeq = 0;
  private approvalSeq = 0;
  private questionSeq = 0;
  private userEventSeq = 0;
  private readonly requestOwner = new Map<string, string>();
  /**
   * The JSON-editor schema machinery, built on first use.
   *
   * Lazy because most sessions never open the schema picker, and compiling every registered document
   * at construction would cost that on every window — see {@link validateSchema}.
   */
  private ajv?: Ajv;
  private readonly schemaValidators = new Map<string, ValidateFunction>();
  /**
   * The validator a FORM's values are checked with — see {@link checkValues}. Its own instance, not
   * the editor's: an author's slot schema may carry an `$id`, and sharing one registry with the static
   * editor schemas is how two unrelated documents come to collide over it.
   */
  private valueAjv?: Ajv;
  private readonly valueValidators = new Map<string, ValidateFunction>();
  /** What the app has said about itself — see {@link Diagnostics}. */
  private readonly diagnostics: Diagnostics;
  /** This service's sink, held so {@link close} can tell whether it is still the installed one. */
  private readonly sink: LogSink = (record) => this.diagnostics.log(entryOfRecord(record));

  constructor(private readonly options: AppServiceOptions = {}) {
    this.baseDir = jairaBasePaths(options.baseDir ?? settingsBaseDir()).baseDir;
    this.diagnostics = new Diagnostics({
      // Under the root's `system/` with the rest of what JaiRA writes for itself, rather than beside
      // the workflows a person authors — see `SYSTEM_DIR_NAME`.
      dir: jairaBasePaths(this.baseDir).logsDir,
      publish: (entry) => this.publish({ type: "log:entry", entry }),
    });
    // What is worth keeping, from the setting that says so. BEFORE the sink is installed below, so
    // the first record of the launch is already gated by the policy rather than by the default.
    this.applyLogPolicy();
    // Every library's records, into the same panel. `@declarative-ai/log` has always had a swappable
    // sink and its own header said JaiRA installs one — and JaiRA never did, so everything the model
    // layer, the engine and JaiRA's own persistence and runtime had to say went to stderr and died
    // there. Which is why the panel could be empty at the exact moment somebody was told a thing had
    // gone wrong.
    //
    // Installed in the CONSTRUCTOR rather than at `open`, because a failure while opening a project
    // is precisely one of the failures worth having, and a sink installed afterwards would miss it.
    // It is a process-wide seam and this is the process's one service.
    installed = this.sink;
    setLogSink(this.sink);
    // The checks that decide what can answer a prompt run BY THEMSELVES, from here on. They used to
    // wait for someone to open Settings and press a button, which meant the app's own idea of what
    // was available was whatever it had assumed — everything — until a run failed to prove otherwise.
    if (options.probeOnStart === true) this.kickAvailability();
  }

  /**
   * The SELECTED root as a project — where a run of a shared workflow is recorded, and where JaiRA's
   * own runs go.
   *
   * This one IS the root, so repointing the root gives a different database and the old library's
   * runs stop being listed — correct, because they were that library's.
   *
   * Keyed by the base directory's own key, so pointing `JAIRA_PROJECT` at `~/.jaira` finds this
   * session rather than opening a second handle on the same file.
   */
  private sharedSession(): ProjectSession | undefined {
    return this.roleSession("shared");
  }

  /**
   * The shared project, but only if the root is already there.
   *
   * What the BROWSE surfaces use. Opening the shared project calls `initBase`, which creates the
   * directories and a database — fine as the cost of running something, and wrong as the cost of
   * looking. A window that has never opened a project would otherwise acquire a `~/.jaira/jaira.db`
   * by having the Files view clicked once.
   *
   * It also keeps the one affordance that depends on the root being absent: the tree says "not
   * created yet — adding a state here will create it", which is an invitation, and materializing the
   * directory behind the reader's back turns it into a lie about what they have already done.
   */
  private sharedIfPresent(): ProjectSession | undefined {
    return existsSync(jairaBasePaths(this.baseDir).workflowsDir) ? this.sharedSession() : undefined;
  }

  /**
   * The role project, opened the first time something needs it.
   *
   * ON FIRST USE rather than in the constructor, which is where this started. Opening eagerly made
   * merely CONSTRUCTING a service create directories and a database — so a person who never runs a
   * sync still gets one, and every caller that constructs a service becomes responsible for closing
   * a handle it never asked for. First use is the honest trigger.
   *
   * The guarantee that mattered survives: it works with NO user project open, because it does not
   * consult one. And it cannot take the app down — a corrupt database, a native ABI mismatch or a
   * read-only home leaves {@link roleError} set and everything else running.
   *
   * Still parameterized by role, with one role left: what it does is "open the project that is
   * addressed by name rather than by directory", and a second such role is a plausible thing to
   * want again.
   */
  private roleSession(role: "shared"): ProjectSession | undefined {
    const open = [...this.sessions.values()].find((s) => s.kind === role);
    if (open !== undefined) return open;
    // Never AFTER `close()`. A late read — a queued `job:output`, a base-layer `syncStatus` racing the
    // quit — would otherwise re-open the database into a handle nothing will ever close again.
    if (this.closed) return undefined;
    // One attempt per role. Retrying on every read would re-pay a failing open — and re-create the
    // directories — on every keystroke in a file the sync panel happens to be watching.
    if (this.roleError[role] !== undefined) return undefined;
    try {
      const project = openSharedProject({ baseDir: this.baseDir });
      // Keyed by the directory it actually opened, so pointing `JAIRA_PROJECT` at the root finds
      // this session rather than opening a second handle on the same file.
      const key = sessionKey(project.paths.projectDir);
      const session = new ProjectSession({ key, kind: role, project, ...this.hubsFor(key) });
      this.sessions.set(key, session);
      return session;
    } catch (e) {
      const message = (e as Error).message;
      this.roleError[role] = message;
      // Reported here rather than only where a run refuses: this is the entry someone will look for,
      // and it has no project whose database could hold it — which is why the ring is in memory.
      this.log({
        level: "error",
        source: "app",
        message: `the ${role} project could not be opened: ${message}`,
        // WITH the stack. This one is the most expensive entry in the file to be given without one:
        // the message is whatever the failing layer said ("no such file"), and which layer said it is
        // the entire question.
        ...stackDetail(e),
      });
      return undefined;
    }
  }

  /**
   * Why a role project is unavailable, when it is.
   *
   * Held rather than thrown (see {@link roleSession}) and reported where it matters: a run refuses
   * with this rather than with whatever the missing session would have produced three layers in.
   */
  private readonly roleError: { shared?: string } = {};

  /**
   * The hubs one session parks on, wired to publish through this service.
   *
   * Built per session rather than once, so a gate in one project cannot be answered by a request id
   * minted in another — and so closing a project rejects only its own parked calls.
   */
  private hubsFor(key: string): { hub: InteractionHub; approvals: ApprovalHub; questions: QuestionHub; userEvents: UserEventHub; remoteEvents: RemoteEventHub } {
    const hub = new InteractionHub({
      onRequest: (request) => this.publishInteraction(key, request),
      onResolved: (requestId, fate) => {
        const session = this.sessions.get(key);
        // A DECISION ends the question; the process going away does not (see `RequestFate`). Only
        // the first deletes the durable row — leaving it on shutdown is exactly what lets the next
        // open ask the same thing again instead of pretending it was answered.
        if (fate === "settled") session?.project.interactions.close(requestId);
        session?.requestTask.delete(requestId);
        this.requestOwner.delete(requestId);
        this.publish({ type: "interaction:resolved", requestId });
      },
      nextId: this.options.nextInteractionId ?? (() => `ui-${++this.interactionSeq}`),
    });
    const approvals = new ApprovalHub({
      onRequest: (request) => {
        this.requestOwner.set(request.requestId, key);
        this.publish({ type: "approval:requested", pending: pendingApprovalOf(request, this.refOf(key)) });
      },
      onResolved: (requestId, decision) => {
        // The human's answer is the audit entry policy alone could not produce.
        const session = this.sessions.get(key);
        const run = session?.approvalRun.get(requestId);
        session?.approvalRun.delete(requestId);
        this.requestOwner.delete(requestId);
        if (run && session) {
          const request = session.approvalsSeen.get(requestId);
          session.project.commands.record({
            taskId: run.taskId,
            tool: request?.tool ?? "unknown",
            ...(request?.command !== undefined ? { command: request.command } : {}),
            decision: decision.decision === "allow" ? "approved" : "denied",
            decidedBy: "user",
            ...(request?.reason !== undefined ? { reason: request.reason } : {}),
            scope: decision.scope,
            ...(request?.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          });
        }
        session?.approvalsSeen.delete(requestId);
        this.publish({ type: "approval:resolved", requestId, decision: decision.decision });
      },
      // The same spelling the hub's own default uses, so ids are unchanged for anything reading them.
      nextId: this.options.nextApprovalId ?? (() => `approval-${++this.approvalSeq}`),
    });
    // Mid-run questions (`AskUserQuestion`) — the third inbox channel. Same ownership discipline as
    // the other two: the owner is recorded at request so an answer can be routed by request id alone.
    const questions = new QuestionHub({
      onRequest: (request) => {
        this.requestOwner.set(request.requestId, key);
        this.publish({ type: "question:requested", pending: pendingQuestionOf(request, this.refOf(key)) });
      },
      onResolved: (requestId) => {
        this.requestOwner.delete(requestId);
        this.publish({ type: "question:resolved", requestId });
      },
      nextId: this.options.nextQuestionId ?? (() => `question-${++this.questionSeq}`),
    });
    /**
     * Transitions waiting on a gesture — the fourth channel, and the one with no dialog.
     *
     * Published as a LIST rather than as a request the renderer has to answer: nothing is shown when
     * a wait arrives. The board consults what is waiting to decide which cards can be picked up, so
     * the only visible effect is that a card becomes draggable — and the only way to answer is to
     * drop it somewhere.
     */
    const userEvents = new UserEventHub({
      onRequest: (request) => {
        this.requestOwner.set(request.requestId, key);
        this.publish({ type: "userEvent:requested", request });
      },
      onResolved: (requestId) => {
        this.requestOwner.delete(requestId);
        this.publish({ type: "userEvent:resolved", requestId });
      },
      nextId: this.options.nextUserEventId ?? (() => `event-${++this.userEventSeq}`),
    });
    // A wait on the forge shows nothing here; what it needs from this process is a probe, now.
    const remoteEvents = new RemoteEventHub({ onWaiting: () => this.kickRemotes() });
    return { hub, approvals, questions, userEvents, remoteEvents };
  }

  // --- watching merge requests (decision 0004) ---------------------------------

  private remoteSource?: PollingSource;
  private remoteWatcher?: { dispose(): void; watcher: RemoteWatcher };

  /** Every open project, as somewhere awaited requests live. */
  private watchTargets(): WatchTarget[] {
    return [...this.sessions.values()].map((session) => ({
      key: session.key,
      handles: session.project.remotes,
      settleAfter: session.project.config.integrations.review.settleAfter,
      provider: (host: string) => this.forgeFor(session, host),
    }));
  }

  /**
   * One provider per (project, host), kept across polling ticks.
   *
   * A provider REMEMBERS things that cost a request to learn — who the token is, whether it may read
   * `/notifications`, which commenters can write — and a fresh one per tick would re-learn them every
   * minute, which is the budget this whole design exists to protect. Dropped whenever what it was
   * built from may have changed: a settings write, a stored secret.
   */
  private readonly forges = new Map<string, ForgeProvider>();
  private forgeFor(session: ProjectSession, host: string): ForgeProvider {
    const key = JSON.stringify([session.key, host]);
    let provider = this.forges.get(key);
    if (provider === undefined) {
      provider = forgeForHost(session.project.config.integrations, host, {
        secrets: this.secretResolver(session),
        ...(this.options.forgeHttp !== undefined ? { http: this.options.forgeHttp } : {}),
      });
      this.forges.set(key, provider);
    }
    return provider;
  }

  /**
   * Probe the forges NOW: a wait just began, the app just started, the window came back after five
   * minutes away, the machine woke, or somebody pressed "Check now".
   *
   * Also where the watcher is BUILT, on first use — a service that never waits on a forge never
   * makes one, and one that does still polls nothing while nothing is parked.
   */
  kickRemotes(): void {
    if (this.closed) return;
    if (this.remoteSource === undefined) {
      this.remoteSource = new PollingSource({
        targets: () => this.watchTargets(),
        onError: (connection, error) => this.log({ level: "warn", source: "runtime", message: `could not check ${connection}: ${error.message}` }),
      });
      const watcher = new RemoteWatcher({
        targets: () => this.watchTargets(),
        sources: [this.remoteSource],
        subjectOf: (target, row) => this.remoteSubject(target, row.requestId),
        onSettled: (event) => this.remoteSettled(event),
        onProgress: (event) => {
          this.remoteHeard.set(JSON.stringify([event.target, event.row.taskId, event.row.key]), event);
          this.publish({ type: "store:invalidate", scope: "task", taskId: event.row.taskId, project: this.refOf(event.target) });
        },
      });
      this.remoteWatcher = { watcher, dispose: watcher.start().dispose };
      return; // `start` kicks.
    }
    this.remoteSource.kick();
  }

  /** What the last read of each request found — in memory only: it is a drawing aid, and the row is the record. */
  private readonly remoteHeard = new Map<string, RemoteProgress>();

  /** A task's merge requests, as the gate's remote strip draws them. Touches nothing but the database. */
  remoteStatus(taskId: string, project?: string): RemoteStatusView[] {
    const session = this.session(project);
    return session.project.remotes.forTask(taskId).map((row) => {
      const heard = this.remoteHeard.get(JSON.stringify([session.key, taskId, row.key]));
      const said = heard?.state === undefined ? [] : [...heard.state.comments, ...heard.state.threads.flatMap((t) => t.comments)].filter((c) => !c.own).sort((a, b) => a.at.localeCompare(b.at));
      const notes: Record<string, unknown[]> = {};
      if (heard?.step !== undefined) {
        const step = heard.step.kind === "settled" ? heard.step.settlement : heard.step;
        for (const decision of step.decisions) if (decision.notes !== undefined) notes[decision.id] = decision.notes;
        if (step.notes.length > 0) notes[REVIEW_NOTE_ARTIFACT] = step.notes;
      }
      return {
        key: row.key,
        provider: row.provider,
        host: row.host,
        project: row.project,
        branch: row.branch,
        target: row.target,
        ...(row.number !== undefined ? { number: row.number } : {}),
        ...(row.url !== undefined ? { url: row.url } : {}),
        awaiting: row.awaiting,
        ...(row.settleAt !== undefined ? { settleAt: row.settleAt } : {}),
        ...(row.checkedAt !== undefined ? { checkedAt: row.checkedAt } : {}),
        ...(row.lastError !== undefined ? { error: row.lastError } : {}),
        commenters: [...new Set(said.map((c) => c.who))],
        ...(Object.keys(notes).length > 0 ? { notes } : {}),
      };
    });
  }

  /** "Check now" on the gate: read the forge for this task's awaited requests, and say what was found. */
  async checkRemotes(taskId: string, project?: string): Promise<RemoteStatusView[]> {
    const session = this.session(project);
    this.kickRemotes();
    const watcher = this.remoteWatcher?.watcher;
    const target = this.watchTargets().find((t) => t.key === session.key);
    if (watcher !== undefined && target !== undefined) {
      await Promise.all(session.project.remotes.forTask(taskId).filter((row) => row.awaiting).map((row) => watcher.check(target, row)));
    }
    return this.remoteStatus(taskId, project);
  }

  /**
   * Reply on a forge thread from the reviewer (decision 0004: "replying here posts there").
   *
   * An outward act, and not a new kind of one: the task has already been allowed to publish — the
   * request this thread lives on exists because it was — and a reply on it is the same conversation.
   * So it is refused only for a request this task never opened. The reply is JaiRA's own voice on the
   * forge (`own`), which the settlement mapping never treats as an event: replying does not restart
   * the quiet window and cannot settle the gate.
   */
  async replyRemote(request: { taskId: string; key: string; thread: string; body: string; resolve?: boolean; project?: string }): Promise<RemoteStatusView[]> {
    const session = this.session(request.project);
    const row = session.project.remotes.get(request.taskId, request.key);
    const handle = row === undefined ? undefined : handleOfRow(row);
    if (row === undefined || handle === undefined) throw this.refusal("run", `task '${request.taskId}' has no open merge request '${request.key}' to reply on`);
    const body = request.body.trim();
    if (body.length === 0) throw this.refusal("run", "a reply needs words");
    const target = this.watchTargets().find((t) => t.key === session.key)!;
    await target.provider(row.host).reply(handle, request.thread, body, request.resolve === true);
    return this.checkRemotes(request.taskId, request.project);
  }

  /** The forge settled a request: hand the settlement to whatever is waiting on it. */
  private remoteSettled(event: RemoteSettled): void {
    const session = this.sessions.get(event.target);
    if (session === undefined) return;
    const result = resultOfSettlement(event.settlement, event.handle) as unknown as JsonValue;
    if (event.requestId === undefined) {
      session.remoteEvents.deliver(event.row.taskId, event.row.key, result, event.row.pushedHead);
      return;
    }
    // A GATE was parked on it: the forge's answer goes through the same door a person's does. Live,
    // the engine is waiting on the promise. Not live — closed for a weekend is the normal case — the
    // answer is seeded and the task resumed, exactly as for a recovered gate answered by hand.
    // Deliberately not through `submitInteraction`: that validates a RENDERER's claim, and this value
    // was computed here, from the forge, by the mapping the tests pin.
    if (session.hub.submit(event.requestId, result)) return;
    try {
      this.answerRecoveredInteraction(event.requestId, result);
    } catch (e) {
      this.log({ level: "warn", source: "runtime", message: `the forge settled a review nothing was waiting on: ${(e as Error).message}`, project: event.target, taskId: event.row.taskId });
    }
  }

  /** What a parked gate is deciding — its changeset and its vocabulary — for the settlement mapping. */
  private remoteSubject(target: string, requestId: string | undefined): { changeset?: Changeset; options?: readonly string[] } | undefined {
    if (requestId === undefined) return undefined;
    const session = this.sessions.get(target);
    const inputs = session?.hub.list().find((r) => r.requestId === requestId)?.inputs ?? session?.project.interactions.get(requestId)?.inputs;
    if (inputs === undefined) return undefined;
    const changeset = changesetInputOf(inputs).changeset;
    let options: string[] = [];
    try {
      const parsed = parseComponentConfig(REVIEW_ARTIFACTS, inputs);
      if (parsed.component === REVIEW_ARTIFACTS) options = (parsed.options ?? []).map((o) => o.value);
    } catch {
      // An unreadable contract decides nothing at review level; the per-change decisions still stand.
    }
    // Given even when empty: a gate may only answer a word its state named.
    return { ...(changeset !== undefined ? { changeset } : {}), options };
  }

  /**
   * The most recent probe per executor.
   *
   * Kept so availability can mean "enabled *and* not known to be broken" without a state view
   * shelling out to `--version` for every executor every time the tree selection changes. Absence is
   * deliberately optimistic — see {@link stateViewOptions}.
   */
  private readonly lastProbes = new Map<string, ProbeResult>();

  /**
   * The last availability check: what answered, what did not, and when it was asked.
   *
   * Held rather than recomputed on demand because the checks are not all free — one of them opens a
   * socket — and because the answer has to be READY when a settings screen is opened rather than
   * arriving after it. {@link AppService.refreshAvailability} fills it at startup, at project open,
   * and after every configuration write; nothing else needs to ask.
   *
   * `checkedAt: 0` is the honest starting value and the UI shows it as such: no check has run, which
   * is a different statement from "everything is fine".
   */
  private availability: AvailabilitySnapshot = { routes: [], executors: [], checkedAt: 0 };

  /**
   * The refresh in flight, so a burst of config writes collapses into one pass.
   *
   * Saving a route's URL and then its credential is two writes a second apart, and each would
   * otherwise start its own round of socket connects while the previous one was still open.
   */
  private availabilityRun?: Promise<AvailabilitySnapshot>;

  /**
   * The re-run promised to whoever asked while a pass was already going — see
   * {@link AppService.refreshAvailability}.
   *
   * One, not a queue: any number of requests arriving during one pass are all answered by a single
   * follow-up, because they all want the same thing — an answer computed after the change they made.
   */
  private availabilityAgain?: Promise<AvailabilitySnapshot>;

  /**
   * The resolved shared root, used by the settings, secret and workflow surfaces.
   *
   * Assigned in the constructor rather than as a field initializer: `options` is a parameter
   * property, so it does not exist yet when field initializers run.
   */
  private readonly baseDir: string;

  /**
   * The same, for the shell — which reports it at launch and cannot otherwise say which root this
   * window is standing on (the flag, the environment and the saved setting all resolve to it here).
   */
  baseRoot(): string {
    return this.baseDir;
  }

  /**
   * The sync state of a description no open session owns.
   *
   * Used only when the system project could not be opened ({@link systemError}). The shared root is
   * syncable regardless — that is the mode shared workflows are authored in — so its in-flight run
   * and its pending proposal still need somewhere to live when there is no session to hold them.
   */
  private readonly detachedSync: SyncHolder = {};

  // --- lifecycle -------------------------------------------------------------

  async open(dir: string): Promise<{ dir: string; recovered: string[] }> {
    // Opening a project ADDS a session; it does not evict one (SHELL.md §2.3). What used to close
    // every other user project here was answering a question the shell has since answered a better
    // way: "which project do the project-free channels answer for?" is now "none of them, because
    // there are no project-free channels" — the project is the head of every address, so each call
    // says whose it is and several can be open without any of them being THE one.
    //
    // Re-opening a project already open is a no-op rather than a second handle: the map is keyed by
    // canonical directory, so the existing session is returned and its database is not touched.
    const key = sessionKey(dir);
    const already = this.sessions.get(key);
    if (already !== undefined) return { dir: already.dir, recovered: [] };
    const project = openProject(dir, { baseDir: this.baseDir });
    // js/ts function modules (SPEC §7.5), built once for the process: the TypeScript compiler is the
    // single `await`, and everything after it is synchronous — which is what lets the SYNC
    // `loadBundle` behind every view consult it. Idempotent, so opening a second project costs
    // nothing; `rebuild` is what a later approval or a changed file needs.
    await prepareUserModules(project.paths, { searchPath: project.config.workflows.path });
    const session = new ProjectSession({ key, kind: "user", project, ...this.hubsFor(key) });
    this.sessions.set(key, session);
    this.log({
      level: "info",
      source: "project",
      message: `opened ${project.paths.projectDir}`,
      project: key,
      ...(project.recovered.length > 0 ? { detail: { recovered: project.recovered } } : {}),
    });
    if (this.options.watchWorkflows !== false) this.watchWorkflows(session);
    // Requests still awaited from the process before this one: closed for a weekend is the normal
    // case, so the first thing an open project does is ask what happened while nobody was running.
    if (project.remotes.awaiting().length > 0) this.kickRemotes();
    if (project.recovered.length > 0) {
      this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
      // Not awaited: the agent's files are on disk and are not going anywhere, while the window
      // opening behind this call is. It publishes its own invalidate when it finds something.
      void this.recoverNativeSessions(session);
    }
    // Not awaited either: a resume loads the machine and re-parks the question, and the window
    // should not wait on that. Each one logs its own failure. The promise is kept on the session so
    // a close that arrives while this is still going waits for it — a resume that started after
    // the close began would be a run with no session and a database on its way out.
    session.resuming = this.resumeSuspended(session);
    // A project brings its own config layer, so what was available a moment ago is not what is
    // available now: it can name different routes, different credentials, and different executors.
    if (this.options.probeOnStart === true) this.kickAvailability();
    // Last, and only once the open has actually worked: the list is "what this window had open", and
    // remembering a directory the open threw on would be a project that fails to open on every start
    // from now on.
    this.remember(project.paths.projectDir);
    return { dir: project.paths.projectDir, recovered: project.recovered };
  }

  /**
   * Re-open the projects this person last had open (see {@link JairaSettings.projects}).
   *
   * Called once at startup, BEFORE the window exists, for the same reason the startup directory is
   * opened there: a window that paints and then acquires its projects one by one is a window that
   * flashes an empty shell over work that was never closed.
   *
   * Best-effort per entry, and the failures are treated differently. A directory that is gone from a
   * filesystem that is plainly THERE — deleted, moved, or its `.jaira/` removed, with its parent
   * still on disk — is FORGOTTEN, because it will never open again and retrying it every start would
   * keep an error on the screen about a folder the person got rid of on purpose. Everything else is
   * logged and KEPT: a locked database, or a whole drive that is not mounted this morning, is a
   * temporary condition, and permanent amnesia is the wrong punishment for it. That is the one
   * distinction `existsSync` alone cannot draw — an unmounted `Z:` and a deleted folder both answer
   * "no" — so the parent is what is asked.
   *
   * The order of the list is preserved, so the project opened most recently is opened last and is
   * therefore the one {@link current} hands the window to stand at.
   */
  async restore(): Promise<{ opened: string[]; forgotten: string[] }> {
    const opened: string[] = [];
    const forgotten: string[] = [];
    for (const dir of this.readSettings().projects) {
      if (!isProject(dir)) {
        if (existsSync(dirname(dir))) forgotten.push(dir);
        else {
          this.log({
            level: "warn",
            source: "project",
            message: `${dir} is not reachable, so it stays in the list rather than being forgotten`,
            project: sessionKey(dir),
          });
        }
        continue;
      }
      try {
        const result = await this.open(dir);
        opened.push(result.dir);
      } catch (e) {
        this.log({
          level: "warn",
          source: "project",
          message: `could not re-open ${dir}: ${(e as Error).message}`,
          project: sessionKey(dir),
          ...stackDetail(e),
        });
      }
    }
    // One line for the whole restore, because the interesting outcome is the SHAPE of it: a window
    // that came back with fewer projects than it had says so here, and the per-project warnings above
    // say which. A restore that opened nothing because the list was empty is worth an entry too — it
    // is the difference between "the app forgot" and "there was nothing to remember".
    this.log({
      level: "info",
      source: "project",
      message:
        opened.length === 0 && forgotten.length === 0
          ? "no projects were remembered from the last session"
          : `restored ${opened.length} project${opened.length === 1 ? "" : "s"}`,
      ...(opened.length > 0 || forgotten.length > 0 ? { detail: { opened, forgotten } } : {}),
    });
    if (forgotten.length > 0) this.writeSettings({ projects: this.readSettings().projects.filter((dir) => !forgotten.includes(dir)) });
    return { opened, forgotten };
  }

  /**
   * What a directory IS, before anything is done to it.
   *
   * The read behind "this folder is not a project yet — set it up?". Without it the only way to
   * learn that a chosen folder has no `.jaira/` was to try to open it and match on the message of
   * the error that came back, which makes an ordinary answer ("not one yet") indistinguishable from
   * a real failure and puts a red toast in front of a person who has done nothing wrong.
   *
   * Reads and nothing else — it neither opens nor creates, which is what lets the renderer ask the
   * question before deciding which of those to do.
   */
  inspect(dir: string): { dir: string; exists: boolean; project: boolean; open: boolean } {
    const at = resolvePath(dir);
    return { dir: at, exists: existsSync(at), project: isProject(at), open: this.sessions.has(sessionKey(at)) };
  }

  /**
   * Add a project to the remembered list, newest last.
   *
   * One already in the list stays exactly where it is, and that is the rule that keeps this list the
   * same shape as {@link userSessions}: both are "opened in this order", so a restored window is the
   * window that was quit rather than one whose projects have been re-sorted by whatever was clicked
   * last. It also makes re-opening an open project as free here as it is there — the session is
   * already the one being returned, and the preferences file is not written again to say so.
   *
   * Never fatal. A preferences file that cannot be written is a project that will not be remembered,
   * which must not be a project that will not open.
   */
  private remember(dir: string): void {
    try {
      const kept = this.readSettings().projects;
      if (kept.some((at) => sessionKey(at) === sessionKey(dir))) return;
      this.writeSettings({ projects: [...kept, dir] });
    } catch (e) {
      this.log({
        level: "warn",
        source: "project",
        message: `could not remember ${dir} as open: ${(e as Error).message}`,
        project: sessionKey(dir),
        ...stackDetail(e),
      });
    }
  }

  /**
   * Recover what a crashed run's DELEGATED calls actually said, from the agent's own session files.
   *
   * The streamed partial in the record is bounded by the last flush; the agent's file is not
   * bounded at all — it holds every turn, the `toolUseResult` records, the context injections, the
   * threading. A call that died mid-flight never reached the close that normally captures it, so
   * this is that capture, run once at the open that discovered the interruption.
   *
   * It is possible only because the provider handle now reaches the row WHILE the call runs (see
   * `update`): a crashed call used to have no handle at all, and a session file cannot be
   * found without one. The cwd is the run's own workspace, read exactly as the chat path reads it —
   * never ensured, because recovering a record must not create a worktree.
   *
   * Best-effort throughout, per the capture's own rule: a file that will not read leaves the record
   * exactly as the crash left it, which is still the streamed partial.
   */
  private async recoverNativeSessions(session: ProjectSession): Promise<void> {
    const { project } = session;
    let recoveredAny = false;
    for (const taskId of project.recovered) {
      const store = sessionStoreFor(project);
      let rows: ReturnType<SqliteSessionStore["recoverable"]>;
      try {
        rows = store.recoverable(taskId);
      } catch {
        continue;
      }
      if (rows.length === 0) continue;
      const worktree = project.runtime.get(taskId)?.worktreePath;
      const cwd = worktree !== undefined && existsSync(worktree) ? worktree : project.paths.projectDir;
      const capture = this.options.captureNative ?? captureNativeSession;
      for (const row of rows) {
        try {
          const captured = await capture(row.providerSessionId, { cwd, sinceMs: row.startedAt });
          if (isEmptyCapture(captured)) continue;
          store.foldNativeCapture(row.id, (value) => foldIntoEntries(value, captured) as Record<string, JsonValue>);
          recoveredAny = true;
          this.log({
            level: "info",
            source: "engine",
            message: `recovered the agent's own transcript for an interrupted call in ${taskId}`,
            project: session.key,
            taskId,
          });
        } catch (e) {
          this.log({
            level: "warn",
            source: "engine",
            message: `recovering a native session failed: ${(e as Error).message}`,
            project: session.key,
            taskId,
            ...stackDetail(e),
          });
        }
      }
    }
    // Only when something changed: the panels re-read on this, and an open that recovered nothing
    // must not make every viewer refetch to learn that.
    if (recoveredAny) this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
  }

  /**
   * Watch `.jaira/workflows/` so the browser re-lints as the user edits (DESIGN
   * §11.1: "editing happens in the user's editor, JaiRA watches and re-lints").
   *
   * Recursive watching is unavailable on Linux, so a failure is not fatal — the
   * browser is still correct on demand, it just stops being live. That matters
   * because CI and Linux developers must not be a broken app.
   */
  private watchWorkflows(session: ProjectSession): void {
    const notify = (): void => {
      clearTimeout(session.watchTimer);
      // Coalesce: a single save often produces several events, and an editor's
      // temp-file dance would otherwise lint a file that no longer exists.
      session.watchTimer = setTimeout(() => {
        this.publish({ type: "store:invalidate", scope: "workflows" });
      }, this.options.watchDebounceMs ?? 150);
      session.watchTimer.unref?.();
    };
    for (const dir of [session.project.paths.workflowsDir, session.project.paths.base.workflowsDir]) {
      let watcher: FSWatcher | undefined;
      try {
        watcher = watch(dir, { recursive: true }, notify);
      } catch {
        try {
          watcher = watch(dir, notify);
        } catch (e) {
          watcher = undefined;
          // Recursive watching is unavailable on Linux, so this is not fatal — the browser is still
          // correct on demand, it just stops being live. Silently giving up made that indistinguishable
          // from a watcher that was working.
          this.log({
            level: "warn",
            source: "project",
            message: `cannot watch ${dir} for changes; the workflow browser will not re-lint on save`,
            project: session.key,
            detail: { reason: (e as Error).message },
          });
        }
      }
      if (watcher === undefined) continue;
      watcher.on("error", () => {
        // A deleted workflows directory ends the watch; on-demand browsing still works.
        watcher?.close();
        session.watchers = session.watchers.filter((w) => w !== watcher);
      });
      session.watchers.push(watcher);
    }
  }

  /**
   * Create `.jaira/` and open it — `jaira init` without a terminal.
   *
   * Until this existed the app could only ever open a project some other tool had made: the startup
   * path resolves a directory and calls {@link open}, which refuses one with no `.jaira/`. So a new
   * checkout was a dead end in the UI, and the shared root — the place a workflow meant to outlive
   * one project is authored — could not be synced from an app that had no way to give it a project
   * to be synced against.
   *
   * `initProject` is idempotent and keeps an existing `settings.json`, so pointing this at a directory
   * that is already a project is an open, not an overwrite.
   */
  async init(dir: string): Promise<{ dir: string; recovered: string[] }> {
    // THIS service's base root, not the ambient one. `open` below uses it, and a create that
    // resolved a different shared root than the open that follows it would lay the project out
    // against one library and then read it against another.
    initProject(dir, this.baseDir);
    return this.open(dir);
  }

  /**
   * Ask the OS for a directory to open or initialize. Null when the dialog was dismissed, or when
   * this process has no dialog to show.
   *
   * The wording differs per mode because the two answers differ: "open" wants a folder that already
   * is a project, and "init" wants one that is about to become one.
   */
  async chooseProject(mode: "open" | "init" = "open"): Promise<{ dir: string } | null> {
    const dir = await this.options.chooseDirectory?.({
      title: mode === "init" ? "Choose a folder to set up as a JaiRA project" : "Open a JaiRA project",
      buttonLabel: mode === "init" ? "Set up here" : "Open",
    });
    return dir === undefined || dir === null ? null : { dir };
  }

  /**
   * The user project opened most recently, or null when none is.
   *
   * A STARTING POINT for the address, and deliberately nothing more: it is read once, when a window
   * needs somewhere to stand before anybody has navigated. Nothing resolves against it — that was
   * `focusedKey`'s job, and the reason a second project could not stay open (SHELL.md §2.3).
   */
  current(): { dir: string } | null {
    const open = this.userSessions();
    const last = open[open.length - 1];
    return last ? { dir: last.dir } : null;
  }

  /**
   * Close every open session — user projects first, the base root last.
   *
   * The order is load-bearing for the same reason a session drains its runs before closing its
   * database: a run recorded in the root can be ABOUT a user project (a sync of its description resolves that
   * project's config and reads its workflows), so tearing the target down first would leave the run
   * settling against a closed handle.
   */
  async close(): Promise<void> {
    // Terminal. Set FIRST, so a read arriving during the drain cannot re-open what is being closed.
    this.closed = true;
    this.remoteWatcher?.dispose();
    // Hand the log back, but only if it is still OURS. The sink is process-global, so a second
    // service constructed after this one has already replaced it — resetting unconditionally would
    // silence a service that is still running on behalf of the one shutting down.
    if (installed === this.sink) {
      resetLogSink();
      installed = undefined;
    }
    // Handed back on its OWN condition rather than the sink's: the two are installed at different
    // moments (the policy in the constructor, the sink just after), so a service can own one and not
    // the other, and resetting the pair together would silence whichever it did not own.
    if (installedPolicy === this.levelPolicy) {
      resetLevelPolicy();
      installedPolicy = undefined;
    }
    await this.closeUserSessions();
    for (const session of [...this.sessions.values()]) await this.closeSession(session.key);
    // The approval store is PROCESS-wide rather than per session — it is keyed by absolute path and
    // spans every project (see `approvalsIn`) — so no session close releases it. It holds an open
    // connection to the base database, and a service that shut down while still holding one leaves
    // the root it was using locked.
    resetUserModules();
    // The worker holding the TypeScript program, if one was ever asked for. It is `unref`'d so it
    // would not hold the process open, but a service that is closed and still answering checks is a
    // service that is not closed.
    await this.checker?.close();
    this.checker = undefined;
    // The bridge worker, if a CLI agent ever ran. `unref`'d like the checker, and closed for the
    // same reason: a run that ends after its service has is a run nobody is watching.
    await this.bridgeHost?.close();
    this.bridgeHost = undefined;
  }

  /** Whether {@link close} has run. A closed service answers; it does not re-open anything. */
  private closed = false;

  /**
   * The persistent MCP bridge every CLI agent run registers on: one listener, on a worker thread.
   *
   * Spawned on the first run that needs it, never at construction — a headless caller reading one
   * projection starts no thread. The worker file lands beside `main.cjs` (see `build.mjs`), which is
   * the one address a bundled main process has for it; the per-run in-process bridge this replaces
   * lived on the main loop and was measured losing the CLI's handshake race whenever that loop was
   * busy, which mid-task it is.
   */
  private bridgeHost: McpBridgeHost | undefined;
  private readonly startBridge: StartMcpBridge = (spec) => {
    if (this.closed) return Promise.reject(new Error("the service is closed"));
    this.bridgeHost ??= this.options.bridgeHost ?? createMcpBridgeHost({ workerFile: join(__dirname, "mcpBridgeWorker.cjs") });
    return this.bridgeHost.start(spec);
  };

  /** Every user project, leaving the base root open. What switching a checkout does. */
  private async closeUserSessions(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.kind === "user") await this.closeSession(session.key);
    }
  }

  /** Close one session and forget it. Unknown keys are a no-op, so closing twice is safe. */
  private async closeSession(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (session === undefined) return;
    // The other half of `opened …`. A pair of entries is what turns "the board is empty" into a
    // question with an answer — a project that was closed, or one that was never opened.
    this.log({ level: "info", source: "project", message: `closing ${session.project.paths.projectDir}`, project: key });
    this.sessions.delete(key);
    for (const [requestId, owner] of [...this.requestOwner]) if (owner === key) this.requestOwner.delete(requestId);
    // The resumes the open started, settled before the close unwinds what they started.
    await session.resuming;
    await session.close();
  }

  /**
   * The session a request NAMES — or the only one there is, when it names none.
   *
   * {@link focusedKey} is gone (SHELL.md §2.3), and this is deliberately NOT it. A focus CHOOSES
   * among open projects, which is the one thing that cannot be done on a caller's behalf: with two
   * checkouts open, "the focused one" is a guess, and a guess here reads the wrong database and
   * answers confidently about another project's task.
   *
   * What is left is the case where there is nothing to choose. With exactly one user project open
   * there is one possible answer and it is not a guess — it is what every unqualified caller has
   * always meant, and it is what keeps the CLI (which cannot have two) from having to name the
   * project it just opened. With none, and with two or more, an unqualified call gets `undefined`
   * and its caller reports rather than picks. That is the property that matters: no width of
   * ambiguity is ever resolved silently.
   *
   * The renderer does not rely on it — every call from there names its project, because the project
   * is the head of the address it is standing on.
   *
   * `"shared"` is reserved and addresses the base root by role, which is the only way to reach it —
   * it is never what a bare directory resolves to, and never what this answers with no ref.
   */
  private sessionOf(ref?: string): ProjectSession | undefined {
    if (ref === undefined) {
      const open = this.userSessions();
      return open.length === 1 ? open[0] : undefined;
    }
    if (ref === SHARED_SESSION) return this.sharedSession();
    return this.sessions.get(sessionKey(ref));
  }

  /** The same, but a missing one is an error rather than an absence. */
  private session(ref?: string): ProjectSession {
    const session = this.sessionOf(ref);
    if (session === undefined) {
      if (ref !== undefined) throw this.refusal("project", `project '${ref}' is not open`);
      // Two different faults, and telling them apart is the whole reason there is no focus: one is a
      // window with nothing open, the other is a caller that had to say which and did not.
      throw this.refusal("project", this.hasProject ? "several projects are open, so this call must name one" : "no project is open");
    }
    return session;
  }

  /** A named project. Shorthand for the overwhelmingly common `this.session(ref).project`. */
  private p(ref?: string): Project {
    return this.session(ref).project;
  }

  /**
   * Is a user project open at all?
   *
   * The guard for every surface that FALLS BACK to the shared root rather than refusing — the files
   * tree, a state view, the config layers. Those read the base directly, so they answer with no
   * project; they just answer about a different thing.
   */
  private get hasProject(): boolean {
    return this.userSessions().length > 0;
  }

  /**
   * Every open USER project, in the order they were opened.
   *
   * Insertion order rather than sorted, because the one thing that reads it in order wants the
   * newest — see {@link current}. `listProjects` does its own sort, which is a different question
   * (what to show, outward from what you are working on).
   */
  private userSessions(): ProjectSession[] {
    return [...this.sessions.values()].filter((s) => s.kind === "user");
  }

  private publish(message: PushMessage): void {
    this.options.publish?.(message);
  }

  /**
   * Publish something that is ABOUT one project, stamped with which.
   *
   * The stamp is what lets a window ignore news it cannot act on. Without it, a run in the base
   * project invalidated "tasks", and a window with no user project open dutifully asked for a task
   * list it has none of — which throws, by design, because a task cannot exist without a project.
   */
  private publishFor(session: ProjectSession, message: PushMessage): void {
    this.publish({ ...message, project: session.dir } as PushMessage);
  }

  /**
   * Say what happened.
   *
   * The one channel for everything the app used to know and never said. Deliberately not a throwing
   * call: several of its callers are catch blocks whose whole point is that they must not fail, and a
   * reporter that could fail is one every one of them would have to defend against — which is how the
   * silence started.
   */
  private log(entry: Omit<LogEntry, "id" | "at">): void {
    this.diagnostics.log(entry);
  }

  /**
   * Decline, saying why — the one way this service refuses, and the one place that records it.
   *
   * Returns the error rather than throwing it, so the call site keeps `throw`. That is not a style
   * choice: a helper that threw would still be a plain call as far as the compiler is concerned, and
   * every `if (row === undefined) …` guard would stop narrowing the moment the throw went inside it.
   * `throw this.refusal(…)` reads as what it is and costs nothing.
   *
   * `warn`, always. The two levels answer different questions — `error` is the code malfunctioning,
   * `warn` is something going wrong that the code then handled — and a refusal is by construction the
   * second: the service checked, decided, and said so. The site picks the SOURCE, because only it
   * knows which part of the app just declined.
   *
   * A {@link Refusal} is also what stops the IPC boundary logging this a second time at `error`, and
   * that pairing is the whole point: the line is written here, where the decision was taken, at the
   * level the decision deserves.
   */
  private refusal(
    source: string,
    message: string,
    context: Omit<LogEntry, "id" | "at" | "level" | "source" | "message"> = {},
  ): Refusal {
    this.log({ level: "warn", source, message, ...context });
    return new Refusal(message);
  }

  /**
   * An IPC handler threw.
   *
   * Public because the boundary that catches it is in `index.ts`, and because it is the single
   * highest-value diagnostic in the app: every failed channel call becomes one legible line, where
   * before it was a rejection that died in a renderer catch and was recorded nowhere.
   *
   * `error` is the right level for what is LEFT here — an exception nobody expected, which is the one
   * kind a boundary can classify without knowing anything about what it was doing. A {@link Refusal}
   * is not that, and is skipped: see the class.
   */
  recordIpcFailure(channel: string, error: unknown): void {
    // Already logged where it was DECIDED, at the level only that site could choose. Logging it a
    // second time here would file the service working correctly under "the code is malfunctioning",
    // which is the distinction the two levels exist to make.
    if (error instanceof Refusal) return;
    const e = error instanceof Error ? error : new Error(String(error));
    this.log({
      level: "error",
      source: "ipc",
      message: `${channel}: ${e.message}`,
      ...(e.stack !== undefined ? { detail: { stack: e.stack } as JsonValue } : {}),
    });
  }

  /**
   * A failure that reached the PROCESS — an unhandled rejection, an uncaught exception, or a push
   * that could not be delivered.
   *
   * The last resort, and it exists because it was missing. A `NaN` in a bound argument threw inside
   * a detached promise, and Node printed `UnhandledPromiseRejectionWarning` to a console the app does
   * not own and nobody was watching: not in the Logs panel, not in the NDJSON mirror, not in the run's
   * own record. The run hung, and the one sentence naming the cause was written where it could not be
   * found. Anything that gets this far is a bug, so it is logged at `error` with its stack.
   *
   * NEVER THROWS: it is reached from a process-level handler, where there is nothing above to catch.
   */
  /**
   * A Node process warning — `MaxListenersExceededWarning`, a deprecation, anything `emitWarning`.
   *
   * `warn` rather than `error`, and a source of its own: nothing failed. A warning is the runtime
   * telling us about a shape it does not like, which is a different claim from either "the code
   * malfunctioned" or "a child process said something", and filing it as either would put it where
   * a reader is not looking for it.
   *
   * The STACK is the entire point of recording these. The message names a symptom that could have
   * come from anywhere — "11 abort listeners added to [AbortSignal]" is true of every signal in the
   * process — and the stack names the `addEventListener` that crossed the line. Node fills it in
   * whether or not `--trace-warnings` was passed; that flag only changes what Node's OWN printer
   * shows, so a handler that reads `.stack` gets the frames for free.
   */
  recordWarning(warning: Error): void {
    try {
      this.log({
        level: "warn",
        source: "runtime",
        message: `${warning.name}: ${warning.message}`,
        ...(warning.stack !== undefined ? { detail: { stack: warning.stack } as JsonValue } : {}),
      });
    } catch {
      // A warning is the least important thing in this process; losing one must not cost anything.
    }
  }

  recordCrash(kind: CrashKind, error: unknown): void {
    try {
      const e = error instanceof Error ? error : new Error(String(error));
      this.log({
        level: "error",
        // NOT `process`, which this app already uses for output from a CHILD process and which every
        // reader treats as belonging to a task. A crash belongs to nothing — that is what makes it a
        // crash — so it gets a source of its own rather than arriving as a job with no job.
        source: "crash",
        message: `${kind}: ${e.message}`,
        ...(e.stack !== undefined ? { detail: { stack: e.stack } as JsonValue } : {}),
      });
    } catch {
      // The reporter itself failed. There is no channel left, and taking the process down for a
      // diagnostic would be worse than the diagnostic being lost.
    }
  }

  /**
   * A run, as it happens — from the journal it is already writing.
   *
   * "Started" and "completed" were the whole of what a run said here, which is a report with no
   * middle: a run that took forty minutes and a run that was stuck in one state for thirty-nine of
   * them produced the same two lines. The journal has always held the middle, and it goes past this
   * point on its way to the database, so the trace costs a switch rather than a second stream.
   *
   * Levels do the filtering, and they say what a reader means by them:
   *
   *  - `debug` for the SHAPE of the run — a state entered, a call parked on a person. Ordinary
   *    progress, off by default in the panel's own filter, and the thing you turn on to answer
   *    "where did it get to".
   *  - `warn` for a call that failed and a child that could not be entered. Neither necessarily
   *    fails the RUN — a guard retries, a branch is not taken — which is exactly why they were
   *    invisible: nothing above them treated them as failures, so nothing reported them, and the
   *    only account of a state that failed three times before succeeding was in the journal.
   *
   * `instanceId` rather than only `taskId`, because it is a pointer: it names the state inside the
   * task, which is the difference between opening a run and opening the place in it.
   */
  private traceRun(project: string, taskId: string, event: EngineEvent): void {
    switch (event.type) {
      case "instance.entered":
        this.log({
          level: "debug",
          source: "run",
          message: `entered ${event.stateId}${event.childKey === undefined ? "" : ` (${event.childKey})`}`,
          project,
          taskId,
          instanceId: event.instanceId,
        });
        return;
      case "instance.blocked":
        this.log({
          level: "warn",
          source: "run",
          // No `instanceId`: nothing became an instance, which IS the event. The mount is the only
          // address it has, so the message carries it.
          message: `could not enter ${event.stateId}${event.childKey === undefined ? "" : ` (${event.childKey})`}: ${event.reason}`,
          project,
          taskId,
        });
        return;
      case "operation.failed":
        this.log({
          level: "warn",
          source: "run",
          message: `${event.op} failed in ${event.stateId}: ${event.failure.reason}`,
          project,
          taskId,
          instanceId: event.instanceId,
          detail: { classification: event.failure.classification },
        });
        return;
      case "call.waiting":
        this.log({
          level: "debug",
          source: "run",
          // The one thing a stalled run looks exactly like from outside: a wait on a person is a
          // journal that stops, and this is the line that says it stopped on purpose.
          message: `waiting on someone in ${event.stateId}`,
          project,
          taskId,
          instanceId: event.instanceId,
        });
        return;
      default:
        // Everything else is the journal's business. `operation.started` / `completed` would be two
        // more lines per call saying what `entered` and the run's own outcome already say.
        return;
    }
  }

  /**
   * Install the log policy — on both streams, from the one setting.
   *
   * Two seams, because there are two producers and they are gated in different places. The libraries
   * are gated by `@declarative-ai/log` itself, BEFORE a record is formatted or a sink is called,
   * which is the only place a `debug` in a hot loop costs nothing; the app's own entries are gated in
   * {@link Diagnostics}, which is where they are recorded. One policy object answers both, so the
   * control in the Logs page cannot mean two different things depending on who wrote the line.
   *
   * `setMinLevel` carries the floor because the library's own default is `info` and would otherwise
   * silently overrule a policy that asked for `debug` — the setting would appear to do nothing, which
   * is the worst way for a control to fail.
   */
  private applyLogPolicy(): void {
    const policy = this.readSettings().logging;
    this.diagnostics.setPolicy(policy);
    setMinLevel(policy.minLevel);
    installedPolicy = (scope: string, ctx?: LevelMatchContext) => resolveLogLevel(policy, scope, ctx?.tag);
    setLevelPolicy(installedPolicy);
    this.levelPolicy = installedPolicy;
  }

  /** This service's level policy, held so {@link close} can tell whether it is still the installed one. */
  private levelPolicy: LevelPolicy | undefined;

  /**
   * Something the SHELL did that the service could not have seen.
   *
   * `main/index.ts` owns the things Electron owns — the command line, the versions, the window, the
   * quit — and every one of them is an answer somebody looking at the Logs panel wants: which build
   * is this, which root did it open, was it even asked to open that project. They were reported to a
   * terminal nobody has, or to nothing at all, because the only public way into the log was a crash.
   *
   * Kept as one method rather than four named ones so the shell stays what its header says it is: a
   * file that owns windows and forwards. The SOURCE is fixed at `app` for the same reason `crash` and
   * `runtime` are fixed at theirs — a reader filtering by source is asking "which part of the machine
   * said this", and the answer here is always "the shell around it".
   *
   * NEVER THROWS: several callers are the last frame before a failure is lost.
   */
  recordApp(level: LogLevel, message: string, detail?: JsonValue): void {
    try {
      this.log({ level, source: "app", message, ...(detail === undefined ? {} : { detail }) });
    } catch {
      // Same last-resort rule as the rest of this family.
    }
  }

  /**
   * A page of what the app has said — what the Logs panel reads, newest first.
   *
   * Read from the mirror rather than from memory, so the answer spans every launch on disk; paged
   * rather than whole, so a panel that has been open through three runs is not the reason the main
   * process is holding a hundred thousand strings.
   */
  readLogs(query: LogQuery = {}): LogPage {
    return this.diagnostics.read(query);
  }

  /** The child processes one task's run started, newest last. */
  listJobs(request: { project?: string; taskId?: string } = {}): JobRow[] {
    // No silent fall-through to the base root: a job id is a rowid in ONE database, so answering
    // an unqualified ask with the system project's rows would show an unrelated process under an id
    // the caller took from somewhere else.
    const session = request.project !== undefined ? this.sessionOf(request.project) : this.sessionOf();
    if (session === undefined) return [];
    return request.taskId === undefined ? session.project.jobs.live(Date.now()) : session.project.jobs.list(request.taskId);
  }

  /**
   * What one child process printed.
   *
   * POLLED with a cursor rather than pushed. A chatty agent would flood the IPC channel and the
   * renderer with output nobody is looking at; a cursor cannot flood, and the panel asks only while it
   * is open.
   */
  jobOutput(request: { project?: string; jobId: number; stream?: "stdout" | "stderr"; limit?: number }): JobOutputChunk[] {
    // Same rule as {@link listJobs}: a job id means nothing without the database it came from.
    const session = request.project !== undefined ? this.sessionOf(request.project) : this.sessionOf();
    return session === undefined ? [] : jobOutput(session.project.db, request);
  }

  private publishInteraction(key: string, request: HubRequest): void {
    this.requestOwner.set(request.requestId, key);
    // The registration's own task, and only as a fallback the sole live run — which is the guess this
    // used to make unconditionally, and which is right only while exactly one run exists.
    const session = this.sessions.get(key);
    const taskId = request.taskId ?? [...(session?.live.keys() ?? [])][0] ?? "";
    session?.requestTask.set(request.requestId, taskId);
    const pending = this.pendingOf(request);
    // Written down before it is published, so the row exists for every renderer that could act on
    // the event. This is what makes a gate survive the process: the hub's Map is the run, and the
    // question is not — see `InteractionStore`. A request with no task has nothing to be resumed
    // against, so it stays live-only rather than becoming a row nothing can ever answer.
    if (session !== undefined && pending.taskId !== "") {
      session.project.interactions.open({
        requestId: pending.requestId,
        taskId: pending.taskId,
        component: pending.component,
        inputs: pending.inputs,
        ...(pending.about !== undefined ? { about: pending.about } : {}),
        ...(pending.subjectProject !== undefined ? { subjectProject: pending.subjectProject } : {}),
        createdAt: Date.now(),
      });
    }
    this.publish({ type: "interaction:requested", pending });
  }

  /**
   * The {@link ProjectRef} a session key names — what a renderer sends back to address it.
   *
   * The key is a canonicalized realpath and the ref is the directory as opened; they differ on
   * Windows, where the key is lower-cased. Both resolve through {@link sessionOf}, but only the ref
   * matches what `project:list` published, which is what a strip row has to compare against.
   */
  private refOf(key: string): string {
    return this.sessions.get(key)?.dir ?? key;
  }

  private pendingOf(request: HubRequest): PendingInteraction {
    const ownerKey = this.requestOwner.get(request.requestId) ?? "";
    const owner = this.sessions.get(ownerKey);
    const pending: PendingInteraction = {
      requestId: request.requestId,
      taskId: request.taskId ?? owner?.requestTask.get(request.requestId) ?? "",
      project: this.refOf(ownerKey),
      component: request.component,
      inputs: request.inputs,
    };
    // Which project this request's file reads are about, when the session it parked in is not it.
    // See `ProjectSession.subjectProject`: a review runs in the base root and reads another project's.
    const subject = owner?.subjectProject.get(pending.taskId);
    if (subject !== undefined) pending.subjectProject = subject;
    // A changeset gate parked by a REVIEW task is about the task whose worktree it reviews — the
    // join the review task's labels carry (`["jaira", "changeset-review", <target>]`), and what
    // lets the reviewer render in the reviewed task's conversation (§8.1's default host).
    if (request.component === REVIEW_ARTIFACTS && pending.taskId !== "") {
      const labels = owner?.project.tasks.tryRead(pending.taskId)?.labels ?? [];
      const at = labels.indexOf("changeset-review");
      const about = at >= 0 ? labels[at + 1] : undefined;
      if (about !== undefined && about !== pending.taskId) pending.about = about;
    }
    return withContract(pending);
  }

  /**
   * A gate read back off disk, in the shape a live one is published in.
   *
   * The row already holds everything `pendingOf` had to derive — the joins that produced `about` and
   * `subjectProject` were made when it parked and stored with it, because the session that could
   * make them is exactly the one that went away. What is left is the contract parse, which is a pure
   * function of the inputs and so is done here rather than stored.
   *
   * `resumes` is what the renderer needs to say the true thing: nothing is waiting on this answer
   * right now, and giving one starts the task again from its record.
   */
  private pendingOfStored(key: string, row: StoredInteraction): PendingInteraction {
    // A stored row is what a run parked, and a run parked before the engine rehydrated loaded
    // inputs wrote a document as `{artifact: true, name}` alone — the reference a review component
    // then drew where the document belonged. The record store still holds the document by that
    // name, so the row is filled in on the way out rather than left to say less than is known.
    const session = this.sessions.get(key);
    const inputs = session === undefined ? row.inputs : rehydrateArtifactInputs(session.project, row.taskId, row.inputs);
    return withContract({
      requestId: row.requestId,
      taskId: row.taskId,
      project: this.refOf(key),
      component: row.component,
      inputs,
      resumes: true,
      ...(row.about !== undefined ? { about: row.about } : {}),
      ...(row.subjectProject !== undefined ? { subjectProject: row.subjectProject } : {}),
    });
  }

  /** The parsed contract for a parked request, when it has one — with the request's own inputs,
   *  because `review_artifacts` is validated against the changeset it was asked about. */
  private configOf(requestId: string): { config: ComponentConfig; inputs: Record<string, JsonValue> } | undefined {
    const owner = this.sessions.get(this.requestOwner.get(requestId) ?? "");
    // The live park, then the stored row. A recovered gate is answered through the same channel and
    // must be held to the same contract — skipping the check because the engine is not waiting yet
    // would make "close the app first" a way past main's validation.
    const request: { component: string; inputs: Record<string, JsonValue> } | undefined =
      owner?.hub.list().find((r) => r.requestId === requestId) ?? this.findStoredInteraction(requestId)?.row;
    if (!request || !isComponentName(request.component)) return undefined;
    try {
      return { config: parseComponentConfig(request.component, request.inputs), inputs: request.inputs };
    } catch {
      return undefined;
    }
  }

  // --- reads -----------------------------------------------------------------

  /**
   * One project's tasks. Named or focused; see the channel's note on `project`.
   *
   * Still THROWS when nothing is open and none is named — deliberately, because an empty answer
   * there would hide a real mistake. A caller that legitimately has no project asks for one by name
   * instead of asking and ignoring the refusal.
   */
  listTasks(project?: string): TaskSummary[] {
    return taskSummaries(this.session(project).project);
  }

  /**
   * The BASE root's runs — a person's shared workflows, and JaiRA's own syncs.
   *
   * A separate read rather than a flag on {@link listTasks} because it names no project: a window
   * with nothing open still has these. Empty rather than an error when the root could not be opened:
   * nothing has run, which is an answer.
   */
  listSystemTasks(): TaskSummary[] {
    const shared = this.sessionOf(SHARED_SESSION);
    return shared === undefined ? [] : taskSummaries(shared.project);
  }

  /**
   * Interactive functions, from the app's own registry vocabulary: a gate is
   * whatever this process routes to the renderer. Passing it makes a parked
   * state read `waiting_for_user` on the board.
   */
  /**
   * The gate vocabulary, across every open project.
   *
   * A union rather than the focused session's, because it answers a question about the FUNCTION name
   * — is `choose_option` something this process routes to a human? — and the answer does not vary by
   * project. Empty with nothing open, which is the honest answer and not an error: the shared root is
   * browsable with no project, and a state view there must still render.
   */
  private gateVocabulary(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const session of this.sessions.values()) for (const name of session.interactive) names.add(name);
    return names;
  }

  private viewOptions(): { interactiveFunctions: ReadonlySet<string> } {
    return { interactiveFunctions: this.gateVocabulary() };
  }

  /**
   * One board level.
   *
   * A `level` is resolved against the workflow that actually contains it, not against whichever
   * workflow the newest task happens to run — otherwise clicking a state in the Files tree would
   * draw an empty board whenever the newest task belonged to a different workflow. `boardView`
   * remains the fallback, and is still what answers the no-level "just show me something" case.
   */
  board(request?: { level?: string; project?: string } | string): BoardView {
    // A bare string is the old shape and still the common call. Widened rather than replaced because
    // the Tasks view now draws one board PER project, and a level means nothing without saying whose.
    const { level, project } = typeof request === "string" ? { level: request, project: undefined } : (request ?? {});
    const open = this.session(project);
    if (level !== undefined && level.length > 0) {
      const board = boardForState(open.project, level, this.browseWorkflowsIn(open), this.stateViewOptions());
      if (board) return board;
    }
    return boardView(open.project, level, this.viewOptions());
  }

  /**
   * The root listing: one column per workflow root, project and shared together.
   *
   * Empty rather than an error with no project open. These two are "show me what is here" reads, and
   * with no project the honest answer is "nothing" — the view renders its own empty state. Throwing
   * would make every rail click a potential error toast, which is a trap the renderer has already
   * fallen into once.
   */
  boardRoots(request?: { project?: string }): BoardView {
    const open = this.sessionOf(request?.project);
    if (open === undefined) return { level: "", label: "All workflows", breadcrumb: [], columns: [], atLevel: [], finished: [] };
    return rootsBoard(open.project, this.browseWorkflowsIn(open), this.stateViewOptions());
  }

  /**
   * The Files view's left panel: the ROOT the shell is standing on, and nothing else.
   *
   * `request.project` is `AppState.at` — where you have navigated (SHELL.md §2.2). What it selects:
   *
   *  - **A checkout** — that project's own `.jaira/`, alone. Its files are the ones actually in that
   *    project's folder, which is the whole rule this panel now follows.
   *  - **The shared root** — `~/.jaira`, browsed as the place it is. It has a sidebar row of its
   *    own, so it is reached by standing in it rather than by appearing inside every checkout.
   *  - **The root, "all projects"** — every open checkout side by side, which is what that place
   *    means. Still no `~/.jaira`: it is not in any project's folder either.
   *
   * The shared root used to be appended to all of these, as a sibling of the projects. That is what
   * put `functions/`, `prompts/`, `skills/` and `workflows/` under a checkout that contains none of
   * them — four folders from `C:\Users\<you>\.jaira` presented as if they were the project's, and
   * for a project whose own `.jaira/` holds nothing but configuration, they were the ONLY thing in
   * the tree. A layer you resolve against is not a folder you are in.
   *
   * With nothing open at all it is still `~/.jaira`, and that is not an exception to the rule: with
   * no project to stand in, the shared root is the only place there is, and its workflows are the
   * ones that outlive any checkout.
   */
  filesTree(request?: { project?: ProjectRef }): FileTree {
    const open = this.userSessions();
    const at = request?.project;
    const baseDir = jairaBasePaths(this.baseDir).baseDir;
    const baseTree = (): FileTree => {
      const hidden = this.hiddenRulesFor(this.effectiveConfig());
      // Linted against the shared project's own tasks when it is open, so a state a run is pinned to
      // reports drift here the same way it would in a checkout.
      const shared = this.sharedIfPresent();
      if (shared !== undefined) return baseFileTree(baseDir, browseBaseWorkflows(baseDir, {}, shared.project), hidden);
      // Linted with no project open, exactly as a project's tree is. The shared root is where a
      // workflow meant to outlive one checkout gets authored, so leaving it unvalidated meant the one
      // mode people write shared workflows in was the one mode that never said anything was wrong.
      return baseFileTree(baseDir, browseBaseWorkflows(baseDir), hidden);
    };

    if (open.length === 0) return baseTree();
    // Standing IN the shared root: it is a project row like any other, and this is what selecting it
    // shows. Asked before the session lookup because the alias never resolves to a user session.
    if (at === SHARED_SESSION || (at !== undefined && sessionKey(at) === sessionKey(baseDir))) return baseTree();

    // One tree per project, each of which also produced its own view of the shared root — the two
    // are linted TOGETHER, so a project's copy of a base state can be marked as shadowing it. The
    // base root is dropped from the OUTPUT rather than from the walk, because that shadow mark is
    // exactly what a project's own rows need in order to say they override something.
    const shown = at === undefined ? open : open.filter((session) => sessionKey(session.dir) === sessionKey(at));
    // An `at` naming a project this window does not have open is a stale address, not an error worth
    // an empty panel: fall back to every open project, which is what the root shows.
    const sessions = shown.length > 0 ? shown : open;
    const trees = sessions.map((session) =>
      fileTree(session.project, this.browseWorkflowsIn(session), this.hiddenRulesFor(session.project.config)),
    );
    return { roots: trees.flatMap((tree) => tree.roots.filter((root) => root.layer === "project")) };
  }

  /**
   * Everything the Files view shows about one state.
   *
   * Executor availability is passed in from *this* process's view of the machine, which is what
   * makes "generic-cli is off, so this state cannot start" an authoring diagnostic rather than a
   * run-time surprise (DESIGN §8.2).
   */
  stateView(stateId: string, project?: string): StateView {
    const open = this.sessionOf(project);
    if (open !== undefined) {
      return stateView(open.project, stateId, this.browseWorkflowsIn(open), this.stateViewOptions());
    }
    // No checkout open. The shared root is still a PROJECT — it has a workflows directory and a run
    // history of its own — so this is the full view, not a degraded one: boards, dependants, drift
    // and the tasks that have passed through each state, exactly as a checkout gets.
    //
    // The browser is the BASE one even so, because it is what decides the layer, and every file here
    // is the base layer. Reading it off the project instead would call the shared root's files
    // `project` — and the Files view routes a run by that layer, so it would send them to whichever
    // checkout was open. The project supplies the runs; the browser supplies the layer.
    const baseDir = jairaBasePaths(this.baseDir).baseDir;
    const shared = this.sharedIfPresent();
    if (shared !== undefined) {
      return stateView(shared.project, stateId, browseBaseWorkflows(baseDir, {}, shared.project), this.stateViewOptions());
    }
    // Only when the shared project could not be opened at all. Then what the view CANNOT know —
    // references, drift, runs — is marked rather than reported as empty (see `StateView.fileOnly`).
    return baseStateView(baseDir, stateId, this.stateViewOptions(), browseBaseWorkflows(baseDir));
  }

  /**
   * One state as the loader resolved it — the effective configuration of that state.
   *
   * `taskId` is what makes this a fact about a RUN rather than about a file: a task pins the
   * workflow it started against, so the state that ran is in that snapshot, and the state on disk is
   * whatever it has been edited into since. Asked without one — from a state file open in the Files
   * view — disk is the only copy there is and the only one meant.
   *
   * The snapshot is read out of the project that HOLDS the task, which is the same project the
   * browser comes from, so a shared workflow's run reads its own recorded copy rather than whichever
   * checkout happens to be focused.
   */
  effectiveState(request: { stateId: string; taskId?: string; instanceId?: string; project?: string }): EffectiveState {
    const open = this.session(request.project);
    const project = open.project;
    const pinned = request.taskId === undefined ? undefined : project.runtime.get(request.taskId)?.snapshotHash;
    const document = effectiveState(project, request.stateId, this.browseWorkflowsIn(open), {
      ...(pinned !== undefined ? { snapshotHash: pinned } : {}),
    });
    if (request.taskId === undefined) return document;
    const values = this.runValuesOf(open, request.taskId, request.stateId, request.instanceId);
    return values === undefined ? document : { ...document, values };
  }

  /**
   * What ONE execution of a state actually held — the values behind its bindings.
   *
   * Read, never derived. Each field is something already written down: `instance.entered` carries
   * the inputs the engine resolved on the way in, `operation.completed` names the record whose
   * result is what the call returned, and a child's own `instance.entered` carries what the wiring
   * on this state produced for it. A published output whose binding is an expression over children
   * is deliberately absent — evaluating it is the engine's job, and a service guessing at it would
   * be inventing a fact rather than reporting one.
   *
   * The LAST execution when the caller names none: a loop runs one state several times, and the
   * pass somebody has clicked through from is the one they were reading.
   */
  private runValuesOf(
    open: ProjectSession,
    taskId: string,
    stateId: string,
    instanceId?: string,
  ): EffectiveStateValues | undefined {
    const events = open.project.events.list(taskId);
    const entered = events.filter(
      (stored) => stored.event.type === "instance.entered" && stored.event.stateId === stateId,
    );
    const mine =
      instanceId === undefined
        ? entered.at(-1)
        : entered.find((stored) => (stored.event as { instanceId: string }).instanceId === instanceId);
    if (mine === undefined) return undefined;
    const id = (mine.event as { instanceId: string }).instanceId;
    const inputs = (mine.event as { inputs?: Record<string, JsonValue> }).inputs;

    // Every child of THIS instance, by the key it was mounted under — the other end of the wiring
    // table. A child that ran twice reports its latest pass, for the same reason this state does.
    const children: Record<string, Record<string, JsonValue>> = {};
    for (const stored of events) {
      const event = stored.event as {
        type: string;
        parentInstanceId?: string;
        childKey?: string;
        stateId?: string;
        inputs?: Record<string, JsonValue>;
      };
      if (event.type !== "instance.entered" || event.parentInstanceId !== id) continue;
      const key = event.childKey ?? event.stateId;
      if (key !== undefined && event.inputs !== undefined) children[key] = event.inputs;
    }

    // Through the record's POSITION, the way `sessionView` reaches the same row. A settled
    // `operation.completed` also carries a content id, and it is the wrong key here: a record that
    // sat in a conversation — which every prompt op does — is stored under `#i<instance>:<seq>`, and
    // only an unplaced one is filed under its content hash.
    const placed = this.sessionHistory({ taskId, project: open.key }).find((row) => row.instanceId === id);
    const output =
      placed === undefined
        ? undefined
        : sessionStoreFor(open.project, { taskId }).at(placed.sessionId, placed.seq)?.value;

    return {
      instanceId: id,
      ...(inputs !== undefined ? { inputs } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(Object.keys(children).length > 0 ? { children } : {}),
    };
  }

  /**
   * What a set of states declare — the authoring form's answer to "what does this child need wired,
   * and what can I read back off it" (WORKFLOWS.md §6.1).
   *
   * Resolved against the same layer roots everything else searches, so the slots the form seeds are
   * the slots the loader will look for. With no project open the shared root is the only layer there
   * is, which is also the only layer authorable in that mode.
   */
  stateSlots(stateIds: string[], project?: string): Record<string, StateSlots> {
    const open = this.sessionOf(project);
    // With no project open the shared root is the only layer a person has — and what ships is still
    // behind it (decision 0006), so a slot declared by a built-in state is found in both modes.
    const roots =
      open !== undefined
        ? workflowRoots(open.project)
        : [jairaBasePaths(this.baseDir).workflowsDir, jairaBuiltInPaths().workflowsDir];
    return stateSlots(roots, stateIds);
  }

  /** A task's run, read back out of the journal as turns. */
  conversation(taskId: string, project?: string): ConversationView {
    return conversationView(this.session(project).project, taskId);
  }

  /**
   * Every state this task went through, with the conversation each one ran in.
   *
   * One half of what selecting a task at a leaf must answer. The other is {@link sessionView}, which
   * takes one of these rows and returns the transcript behind it.
   */
  sessionHistory(request: { taskId: string; project?: string }): SessionRef[] {
    const session = this.session(request.project);
    const costs = new Map<string, { status: "success" | "error"; costUsd?: number; metrics?: RunMetrics }>();
    // When each CALL began, which `stateSessions` cannot see — it reads `operation.completed` alone,
    // and a completion carries no start. Taken from the same pass the costs come from rather than a
    // query of its own: this loop is already reading every event of the run.
    //
    // A LIST per instance, not a value. One instance runs one operation in the ordinary case, but a
    // conversation continued by hand runs another in the same state, and a single slot would hand
    // both of them the same timestamp — putting the older call at the newer one's position, which is
    // exactly the ordering the conversation panel lays out by.
    const starts = new Map<string, number[]>();
    for (const row of session.project.events.list(request.taskId)) {
      if (row.event.type === "operation.started") {
        const key = row.event.instanceId;
        starts.set(key, [...(starts.get(key) ?? []), row.createdAt]);
      } else if (row.event.type === "operation.completed") {
        const metrics = runMetricsOf(row.event.metrics);
        costs.set(row.event.instanceId, {
          status: "success",
          ...(typeof row.event.metrics?.costUsd === "number" ? { costUsd: row.event.metrics.costUsd } : {}),
          ...(metrics !== undefined ? { metrics } : {}),
        });
      } else if (row.event.type === "operation.failed") {
        // A failed call's SPEND, which used to be dropped on the floor: a post-dispatch failure
        // carries the metrics of the call it made (upstream), and an agent that billed a dollar
        // before failing spent it just as surely as one that succeeded.
        const failed = row.event as { instanceId?: string; metrics?: { costUsd?: number } };
        const metrics = runMetricsOf(failed.metrics as never);
        costs.set(failed.instanceId ?? "", {
          status: "error",
          ...(typeof failed.metrics?.costUsd === "number" ? { costUsd: failed.metrics.costUsd } : {}),
          ...(metrics !== undefined ? { metrics } : {}),
        });
      }
    }
    // `stateSessions` returns settled calls in journal order, so the n-th row of an instance is the
    // n-th call it made — which is what pairs it with the n-th start.
    const taken = new Map<string, number>();
    /**
     * Lineage, per distinct CONVERSATION rather than per row.
     *
     * Several operations share one session on purpose — that is what `environment.session` is for —
     * and where a conversation came from is a fact about the conversation, not about each call in
     * it. Memoised for the same reason the costs above are folded in one pass: a run of forty states
     * through four sessions should open four lineage reads, not forty.
     *
     */
    // Every operation's place in the workflow — the one name a stop and its continuation share.
    const addresses = instanceAddresses(session.project, request.taskId);
    const store = sessionStoreFor(session.project, { taskId: request.taskId });
    const lineage = new Map<string, { parent: string; at: number } | undefined>();
    const branchOf = (sessionId: string): { parent: string; at: number } | undefined => {
      if (!lineage.has(sessionId)) {
        lineage.set(sessionId, store.lineageOf(sessionId));
      }
      return lineage.get(sessionId);
    };
    return stateSessions(session.project, request.taskId).map((s) => {
      const key = s.instanceId;
      const nth = taken.get(key) ?? 0;
      taken.set(key, nth + 1);
      const startedAt = starts.get(key)?.[nth];
      // The ROW's own verdict wins over the journal roll-up. An interrupted call has no terminal
      // event, so `costs` holds nothing for it, and a failed one is now distinguished at the source
      // rather than inferred — see `StateSession.outcome`.
      const settled = costs.get(key);
      const status =
        s.outcome === "interrupted" || s.outcome === "running" || s.outcome === "error" ? s.outcome : settled?.status;
      const branch = branchOf(s.sessionId);
      return {
        instanceId: s.instanceId,
        stateId: s.stateId,
        sessionId: s.sessionId,
        seq: s.seq,
        at: s.at,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(settled ?? {}),
        ...(status !== undefined ? { status } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(addresses.get(s.instanceId) !== undefined ? { address: addresses.get(s.instanceId)! } : {}),
      };
    });
  }

  /**
   * The conversation ONE state instance ran — what a leaf task shows.
   *
   * The record it reads is the whole `LlmOutput` the call returned, so an agent's every message, tool
   * call and result is here rather than a summary of them. Empty is an ANSWER, not a fault: a
   * function op runs in no conversation, and a run journaled before transcripts were kept has none to
   * read — both say so rather than rendering a blank panel.
   *
   * ⚠️ What it CANNOT distinguish is a state that ran no model call from one whose call left no
   * conversation behind, and for a long time every real (non-scripted) run was the second: a prompt
   * core projects its `LlmOutput` down to the op's output value INSIDE the call, so the record held
   * the answer and no messages at all. Fixed upstream — a value-mode core now reports what it
   * appended on the `SessionOutcome` channel — rather than by softening the wording here, because the
   * wording was right and the data was wrong.
   */
  /**
   * Every call one run made — what a derivation resolves its impure bindings against.
   *
   * Scoped to the RUN and not to an instance, because the store does not attribute a record to one
   * and does not need to: a resolved binding finds its own record by CONTENT id (`hashCanonical` of
   * the request is the `record_id`). So a reader takes the run's records once and looks them up by
   * hash — one round trip for a whole conversation rather than one per state, and no attribution by
   * time, which is the thing that would be ambiguous when two instances run at once.
   */
  runRecords(request: { taskId: string; project?: string }): OperationRecordView[] {
    const session = this.session(request.project);
    return sessionStoreFor(session.project, { taskId: request.taskId }).records();
  }

  sessionView(request: { taskId: string; instanceId?: string; project?: string }): SessionView {
    const session = this.session(request.project);
    const history = this.sessionHistory({ taskId: request.taskId, ...(request.project !== undefined ? { project: request.project } : {}) });
    // The LAST match, not the first. The history spans the task's whole life, and a legacy journal's
    // counter ids restarted at 1 on each run — so `#i2` named the second instance of every run there
    // had ever been. Durable UUIDs cannot collide like that, but old rows are still read here, and
    // taking the first match showed run 1's conversation for a card belonging to run 4 — the same
    // failure as showing none except that it looks like an answer.
    const row =
      request.instanceId === undefined
        ? history.at(-1)
        : [...history].reverse().find((h) => h.instanceId === request.instanceId);
    const base = {
      taskId: request.taskId,
      instanceId: row?.instanceId ?? request.instanceId ?? "",
      stateId: row?.stateId ?? "",
      sessionId: row?.sessionId ?? "",
      seq: row?.seq ?? 0,
      turns: [],
    } satisfies SessionView;
    if (row === undefined) {
      return { ...base, empty: "this state ran no model call, so there is no conversation to show" };
    }
    // Scoped to the task that wrote it, which is where its aliases and legacy spellings resolve.
    const store = sessionStoreFor(session.project, { taskId: request.taskId });
    const record = store.at(row.sessionId, row.seq);
    if (record === undefined) {
      return { ...base, empty: "this run was recorded before conversations were kept" };
    }
    // Through the SAME reader the thread uses. This panel had its own fold, and the two drifted: it
    // grew the interrupted call's trailing fragment and never grew the message that PROVOKED the
    // call, so a stopped agent's transcript opened on an answer to a question that was nowhere on the
    // page. Which of two readers a person happened to open is not a fact about the conversation.
    //
    // No subtraction, and no `store.messages` read to subtract WITH: a record holds the messages its
    // call contributed and nothing else, so what this state added is simply what its record says.
    const turns = turnsSaidBy(record);
    if (turns.length === 0) {
      // A record that contributed no messages. Rare, and an answer rather than a blank panel: the
      // call happened, and it added nothing anybody can read.
      return { ...base, empty: "this state added nothing to the conversation it was given" };
    }
    const sidechains = sidechainsOf(record.value);
    const providerEvents = recordEventsOf(record.value);
    const native = nativeOf(record.value);
    // Against the turns as RENDERED, not the record's raw messages: `turnsSaidBy` can append the
    // half-written tail of an interrupted call, and an index measured before that would name a
    // different turn than the one the viewer counts to.
    const output = structuredOutputOf(record, turns);
    return {
      ...base,
      ...(record.externalId !== undefined ? { providerSessionId: record.externalId } : {}),
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
      turns,
      ...(sidechains !== undefined ? { sidechains } : {}),
      ...(providerEvents !== undefined ? { providerEvents } : {}),
      ...(native !== undefined ? { native } : {}),
      ...(output !== undefined ? { outputs: [output] } : {}),
    };
  }

  /**
   * The executors that would actually run.
   *
   * Enabled is the rule, refined by the last probe when one has been taken: an executor nobody has
   * tested yet is assumed to work, because refusing to start a task over a check that has never run
   * would be worse than the failure it is trying to prevent. Since the checks now run at startup,
   * "nobody has tested it yet" is a much narrower window than it used to be — but it is not empty,
   * and the optimistic reading is still the right one inside it.
   */
  private stateViewOptions(): {
    interactiveFunctions: ReadonlySet<string>;
    availableExecutors: ReadonlySet<string>;
    knownExecutors: ReadonlySet<string>;
  } {
    const all = this.listExecutors();
    const available = new Set(
      all
        .filter((info) => info.enabled && this.lastProbes.get(info.name)?.status !== "failed")
        .map((info) => info.name),
    );
    return {
      interactiveFunctions: this.gateVocabulary(),
      availableExecutors: available,
      knownExecutors: new Set(all.map((info) => info.name)),
    };
  }

  taskDetail(taskId: string, project?: string): TaskDetail {
    // Scoped, because the Tasks view now shows the root's runs beside the project's and selecting one
    // must read the database it actually lives in.
    const detail = taskDetailView(this.session(project).project, taskId, this.viewOptions());
    // Folded in HERE rather than fetched separately, because the one surface that needs it — the
    // activity strip's verb — already has the detail and would otherwise draw a button before
    // knowing what it does. Computed only for a task that could actually start: for anything else
    // `resumable` answers `none` off the status alone, and folding a completed task's whole journal
    // on every panel draw would be work with no reader.
    if (!isStartableStatus(detail.status)) return detail;
    return { ...detail, resume: this.resumable(taskId, project) };
  }

  /**
   * Every task in every open project, newest first, each stamped with the project holding it.
   *
   * What the ROOT of the address reads — "all projects" is a place, not the absence of one. Sorted
   * here rather than by the caller because the order is the answer: a list spanning four databases
   * has no meaningful order until something imposes one, and recency is the only one that means the
   * same thing in all of them.
   *
   * `workflows` is a filter on the workflow ROOT, passed by the caller that knows what it is looking
   * for — the Chat view narrows to its two conversation states rather than making this channel know
   * what a conversation is.
   */
  listAllTasks(request?: { workflows?: string[] }): ProjectTask[] {
    // Materialized first, so the shared root is in the answer before anything has run in it — the
    // same reason `listProjects` does it.
    this.sharedSession();
    const wanted = request?.workflows === undefined ? undefined : new Set(request.workflows);
    const out: ProjectTask[] = [];
    for (const session of this.sessions.values()) {
      for (const task of taskSummaries(session.project)) {
        if (wanted !== undefined && !wanted.has(task.workflow)) continue;
        out.push({ ...task, project: session.dir });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Every project this window can draw a board for — the user's, and the base root.
   *
   * One group per project rather than one merged board: a board is per workflow ROOT, and columns
   * from two projects side by side would be columns of different things.
   */
  listProjects(): ProjectSummary[] {
    // Materialized, so the group exists before the first run rather than appearing once something has
    // used it. A window that shows JaiRA's board only after a sync has run is a window that cannot be
    // used to watch the first one.
    this.sharedSession();
    const out: ProjectSummary[] = [];
    for (const session of this.sessions.values()) {
      const tasks = taskSummaries(session.project);
      const statuses: Partial<Record<TaskStatus, number>> = {};
      for (const task of tasks) statuses[task.status] = (statuses[task.status] ?? 0) + 1;
      // Which of them are parked on a person. Read off the session's own hubs rather than projected
      // out of the journal: a gate, an approval and a question are exactly what the inbox strip
      // lists, so counting them here is counting the same facts and the two cannot drift apart.
      // A run's task is `running` in the runtime row while it waits, so the set is intersected with
      // the running rows — a parked request whose task has since been cancelled counts for nothing.
      const running = new Set(tasks.filter((t) => t.status === "running").map((t) => t.taskId));
      const parked = new Set<string>();
      for (const request of session.hub.list()) {
        const taskId = request.taskId ?? session.requestTask.get(request.requestId);
        if (taskId !== undefined && running.has(taskId)) parked.add(taskId);
      }
      for (const request of [...session.approvals.list(), ...session.questions.list()]) {
        if (request.taskId !== undefined && running.has(request.taskId)) parked.add(request.taskId);
      }
      out.push({
        project: session.dir,
        // The shared group is named for the root it IS, not "shared": repointing the root is the one
        // thing that changes which runs are in it, so the directory is the useful label.
        //
        // Written HOME-RELATIVE where it is under the home directory, which in the default install is
        // the whole of it: `~/.jaira` is what a person calls that place and what every document here
        // calls it, where the bare basename `.jaira` names nothing and collides with any project that
        // happens to have one. A root pointed elsewhere still prints its own directory.
        label: session.kind === "shared" ? shortRoot(session.dir) : basename(session.dir),
        kind: session.kind,
        tasks: tasks.length,
        running: running.size,
        statuses,
        waiting: parked.size,
        // What a status pill could be counting — see `ProjectSummary.ended`. `queued` is not here
        // for the same reason it has no pill: it has not stopped, because it has not started.
        ended: tasks
          .filter((t) => t.status !== "running" && t.status !== "queued")
          .map((t) => ({ taskId: t.taskId, status: t.status, updatedAt: t.updatedAt })),
      });
    }
    // The user's work first, then the shared root — outward from what you are working on to the
    // background it runs against.
    const rank = (kind: ProjectSummary["kind"]): number => (kind === "user" ? 0 : 1);
    return out.sort((a, b) => (rank(a.kind) === rank(b.kind) ? a.label.localeCompare(b.label) : rank(a.kind) - rank(b.kind)));
  }

  /**
   * The workflow browser + lint results (DESIGN §11.1). No registry is passed: an
   * interactive function is only registered once a run needs it, so linting
   * against this process's partial registry would flag every human gate.
   */
  browseWorkflows(project?: string): WorkflowBrowser {
    return browseWorkflows(this.p(project));
  }

  /** The same, for a named session — what a board drawn for another project reads. */
  private browseWorkflowsIn(session: ProjectSession): WorkflowBrowser {
    return browseWorkflows(session.project);
  }

  /** Rows currently stored, for the pruning panel's "before" figure. */
  historySize(project?: string): HistorySize {
    return historySize(this.p(project));
  }

  /**
   * Plan or apply a prune (SPEC §13).
   *
   * A request without `apply` is a plan and deletes nothing, which is what the UI
   * shows before asking — history is not recoverable. The §13 safety rule lives in
   * `pruneHistory`, so it holds no matter which caller asks.
   */
  pruneHistory(request: PruneRequest = {}): PruneResult & { remaining: HistorySize } {
    const open = this.session();
    const project = open.project;
    const days = request.olderThanDays ?? 0;
    if (!Number.isFinite(days) || days < 0) throw this.refusal("project", "olderThanDays must be a non-negative number");
    const result = pruneHistory(project, {
      before: Date.now() - days * 86_400_000,
      dryRun: request.apply !== true,
    });
    if (!result.dryRun && result.tasks.length > 0) {
      // History backs the detail view and the board's finished cards.
      this.publishFor(open, { type: "store:invalidate", scope: "tasks" });
      this.publishFor(open, { type: "store:invalidate", scope: "board" });
      for (const task of result.tasks) this.publishFor(open, { type: "store:invalidate", scope: "task", taskId: task.taskId });
    }
    return { ...result, remaining: historySize(project) };
  }

  // --- writes ----------------------------------------------------------------

  /**
   * Create a task, in the focused project or in one it names.
   *
   * `request.project` exists for the shared root. A state under `~/.jaira/workflows` belongs to the
   * machine rather than to a checkout, so its runs are recorded in the root's own project — the same
   * routing a base-layer description sync already uses, and the reason the Files view can offer Run
   * on a shared workflow with no user project open at all.
   */
  createTask(request: CreateTaskRequest): TaskSummary {
    const open = this.session(request.project);
    const project = open.project;
    const meta = createTask(project, {
      title: request.title,
      workflow: request.workflow,
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.labels !== undefined ? { labels: request.labels } : {}),
      ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
    });
    this.publishFor(open, { type: "store:invalidate", scope: "tasks" });
    const row = project.runtime.get(meta.id)!;
    return {
      taskId: meta.id,
      title: meta.title,
      status: row.status,
      workflow: meta.workflow,
      ...(meta.labels !== undefined ? { labels: meta.labels } : {}),
      createdAt: meta.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Start a run in this process, streaming its events to the renderer as they
   * are journaled. Interactive states are answered by the renderer through
   * {@link submitInteraction} unless `request.interactions` scripts them.
   */
  /**
   * What a task's last start attempt refused over, per task id.
   *
   * Kept because the rejection cannot carry it: Electron serializes an IPC error's MESSAGE and drops
   * every own property, so `ApprovalRequired.pending` does not survive the trip. Written on the way
   * out of {@link startTask} and read back by `functions:pending` — one entry per task, replaced by
   * the next attempt, and deleted the moment a start succeeds so a stale list cannot be shown
   * against a run that is already going.
   */
  private readonly moduleApprovals = new Map<string, ModuleApproval[]>();

  /** {@link moduleApprovals} for one task, or empty where the last start did not stop on the gate. */
  functionsPending(request: { taskId: string; project?: string }): ModuleApproval[] {
    return this.moduleApprovals.get(request.taskId) ?? [];
  }

  /**
   * Approve module files, then REBUILD so the next load can see them.
   *
   * Approving without rebuilding is the failure this method exists to make impossible: the symbol
   * index this process built at startup was gated on the approvals as they stood then, and it
   * answers from that reading until something replaces it.
   */
  async functionsApprove(request: { files: string[]; project?: string }): Promise<{ approved: number }> {
    const open = this.session(request.project);
    const modules = userModules();
    if (modules === undefined) throw this.refusal("functions", "this process has no js/ts function support to approve into");
    let approved = 0;
    for (const file of request.files) {
      const source = modules.vfs.read(canonicalModulePath(file));
      // Hashed HERE rather than trusting a hash the renderer sent back: an approval records what the
      // file says now, and the only reading of "now" that can be trusted is the one taken beside the
      // write. A file that changed between the prompt and the answer must not be approved as what
      // was shown.
      if (source === undefined) throw this.refusal("functions", `cannot approve '${file}': it could not be read`);
      modules.approvals.approve(canonicalModulePath(file), moduleHashOf(source));
      approved += 1;
    }
    await prepareUserModules(open.project.paths, { searchPath: open.project.config.workflows.path, rebuild: true });
    return { approved };
  }

  async startTask(request: StartRunRequest): Promise<{ taskId: string }> {
    // The session that HOLDS the task, which is also whose config and secrets govern it — see the
    // rule on {@link startRun}. For a system task those are the shared root's, which is the pairing
    // a workflow that lives in the shared root wants.
    const open = this.session(request.project);
    const bundle = this.overriddenBundle(open, request.taskId, request.overrides);
    try {
      const started = await this.startRun(open, request.taskId, {
        config: open.project.config,
        secrets: this.secretResolver(open),
        ...(bundle !== undefined ? { bundle } : {}),
        ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
        ...(request.fake !== undefined ? { fake: request.fake } : {}),
      });
      // A start that got through settles the question, whatever it was last time.
      this.moduleApprovals.delete(request.taskId);
      return started;
    } catch (e) {
      // Stashed, then RETHROWN unchanged. The renderer's contract does not move — it still gets the
      // rejection and can still just show the message — but a renderer that would rather ask now has
      // somewhere to read the list from.
      if (e instanceof ApprovalRequired) this.moduleApprovals.set(request.taskId, [...e.pending]);
      throw e;
    }
  }

  /**
   * This run's workflow with the caller's settings written into its root state — see
   * `StartTaskRequest.overrides`.
   *
   * `undefined` whenever there is nothing to change, which is the common case and also every case
   * that is not a conversation being started: no overrides, an empty override object, a workflow that
   * will not load, or a root that has no prompt operation to write them into. The run then reads the
   * files off disk exactly as it always has.
   *
   * The bundle is loaded from LIVE files rather than a snapshot on purpose — this runs before
   * `beginTaskRun` pins one, and what it is rewriting is what that call is about to read.
   */
  private overriddenBundle(open: ProjectSession, taskId: string, overrides?: ChatSettings): WorkflowBundle | undefined {
    if (overrides === undefined || Object.keys(overrides).length === 0) return undefined;
    const meta = open.project.tasks.tryRead(taskId);
    if (meta === undefined) return undefined;
    const bundle = bundleFor(open.project, meta.workflow);
    const root = bundle?.states[bundle.rootId];
    if (bundle === undefined || root === undefined) return undefined;
    const state = stateWithChatSettings(root, overrides);
    return state === undefined ? undefined : { ...bundle, states: { ...bundle.states, [bundle.rootId]: state } };
  }

  /**
   * Start a run — the machinery, with the three things a caller other than a task can differ on.
   *
   * `startTask` is this with everything defaulted. The parameters exist for JaiRA's OWN runs (a
   * description sync, §11.2), which are recorded in the system project but are ABOUT something else,
   * and that split is the rule this signature encodes:
   *
   * > **The recording session owns the RUN. The `config`/`secrets` own the CONFIGURATION.**
   *
   * Get it wrong and nothing visibly breaks: a project-layer sync silently resolves the shared root's
   * models and the shared root's credentials, calls a different model than the project asked for, and
   * reports success.
   */
  private async startRun(
    open: ProjectSession,
    taskId: string,
    opts: {
      /** Whose models, presets, executors and policy govern the run. */
      config: JairaConfigOf;
      /** Whose `.env` chain resolves its credentials. */
      secrets: SecretResolver;
      /** Supplied ⇒ `ensureWorkspace` is skipped, because the caller has already decided. */
      workspace?: TaskWorkspace;
      /** A synthesized workflow, pinned as this run's snapshot instead of read off disk. */
      bundle?: WorkflowBundle;
      /**
       * What the run may CALL, replacing the full host registry.
       *
       * A sync deliberately gets `read_file` and nothing else — no `write_file`, no `bash`, no agent
       * runtimes — because it returns text for a person to accept and must not touch disk. That
       * refusal is load-bearing, so it is a parameter rather than something to remember.
       */
      capabilities?: (registry: ReturnType<typeof newRegistry>) => void;
      interactions?: StartRunRequest["interactions"];
      fake?: JsonValue | FakeRule[];
      /**
       * The stopped machine's description — supplied ⇒ this run is a RESUME, and the engine LOADS
       * the machine instead of walking a fresh one (Identity and Resume §04).
       *
       * It changes nothing else about starting: the same snapshot is pinned, the same worktree is
       * ensured, a new run row is opened. What differs is that nothing already answered runs again —
       * history becomes the records its parents read, and only the active leaves dispatch.
       */
      loaded?: LoadedInstance;
      /** Recorded call answers by scoped id — the durable store behind hw's `answers` seam. */
      answers?: (scopedId: string) => CallResult | undefined;
      /**
       * The run's move port, ALREADY HOLDING a move (decision 0005) — supplied by `moveTask` when a
       * task that is not running is reopened to take one: the loaded engine claims it as it builds
       * the instance it names. Absent ⇒ a fresh port, which every run gets.
       */
      directed?: DirectedTransitions;
      /** This start reopens a COMPLETED task to take that move — `BeginRunOptions.reopen`. */
      reopen?: boolean;
    },
  ): Promise<{ taskId: string }> {
    const project = open.project;
    const config = opts.config;
    if (open.live.has(taskId)) throw this.refusal("run", `task '${taskId}' is already running in this process`);

    const scripted = opts.interactions ? new ScriptedFunctions(opts.interactions) : undefined;
    const registry = newRegistry();
    // Registration order matters: a scripted answer wins over the live hub, so a
    // demo run never parks waiting for a human.
    scripted?.register(registry);

    // A task HOLDING for a dependency (decision 0003) is refused before anything is materialized for
    // it: `beginTaskRun` refuses the same way, but a worktree cut for a task that then does not start
    // is a worktree somebody has to explain. The names are the message either way.
    {
      const meta = project.tasks.tryRead(taskId);
      const holding = meta !== undefined ? holdingOf(project, meta) : [];
      if (holding.length > 0) {
        throw this.refusal("run", `task '${taskId}' is waiting for ${holding.map((h) => `'${h.title}' (${h.status})`).join(", ")} to complete`);
      }
    }
    // Materialize the worktree before marking the task running, so a git failure
    // leaves it startable rather than `running` with nowhere to run (DESIGN §9.2).
    const workspace = opts.workspace ?? (await ensureWorkspace(project, taskId));

    // Child-process tracking (DESIGN §4.2a). The registry is built before the run
    // exists, so the observer forwards to a claim made below — safe because nothing
    // spawns until the run starts.
    let owner: RunOwner | undefined;
    let observe: ExecObserver<number> | undefined;
    const observer: ExecObserver = {
      onSpawn: (event) => {
        const token = observe?.onSpawn(event);
        // The lifecycle row. `taskId` clicks through to the task and `jobId` opens what this process
        // printed — one stamp answering both "which run was that" and "what did it say".
        this.log({
          level: "info",
          source: "process",
          message: `started ${event.command}`,
          project: open.key,
          taskId,
          ...(typeof token === "number" ? { jobId: token } : {}),
          detail: { argv: [...event.argv], ...(event.pid !== undefined ? { pid: event.pid } : {}) },
        });
        return token;
      },
      onExit: (token, event) => {
        const code = event.signal !== null ? `signal:${event.signal}` : `exit:${event.code ?? "?"}`;
        this.log({
          level: event.code === 0 ? "info" : "warn",
          source: "process",
          message: `finished ${code}`,
          project: open.key,
          taskId,
          ...(typeof token === "number" ? { jobId: token } : {}),
        });
        observe?.onExit(token as number | undefined, event);
      },
      onOutput: (token, event) => observe?.onOutput?.(token as number | undefined, event),
      onError: (error, phase) => observe?.onError?.(error, phase),
    };
    const exec = new NodeExec({ execEnv: config.execEnvironment, observer });

    if (opts.capabilities !== undefined) {
      // A caller that states what the run may call gets THAT and nothing else — see `capabilities`.
      opts.capabilities(registry);
    } else {
      // Delegated agent runtimes are available to every run (DESIGN §8.1); a state
      // reaches one with a `claude-code` function op.
      // Only the executors this project has turned on: a disabled one is left OUT of the registry
      // rather than registered and refusing, so a state naming it fails at start rather than midway.
      registerAgentRuntimes(registry, {
        execEnv: config.execEnvironment,
        observer,
        startBridge: this.startBridge,
        adapters: enabledAdapters(config.agents),
        ...(config.agents.claudeCli?.command !== undefined ? { cliCommand: config.agents.claudeCli.command } : {}),
        ...(config.agents.codex?.command !== undefined ? { codexCommand: config.agents.codex.command } : {}),
        ...(config.agents.codex?.sandbox !== undefined ? { codexSandbox: config.agents.codex.sandbox } : {}),
      });
      // Non-Claude CLIs the project configured (DESIGN §8.1). Nothing is registered
      // when none are, so a state naming one fails honestly instead of running some
      // default binary.
      registerGenericAgents(registry, {
        execEnv: config.execEnvironment,
        exec,
        agents: enabledGenericAgents(config.agents),
      });
      // Our own tools, so an agent's commands go through the policy at all: an agent
      // calling its native shell would be invisible to it (DESIGN §10.1).
      registerTools(registry, { execEnv: config.execEnvironment, exec });
      // A state can also run a command directly, without delegating to an agent; it
      // gates itself with the same policy (DESIGN §10.1).
      registerCommandFunction(registry, { execEnv: config.execEnvironment, exec });
      // The changeset application step and its status helper (CHANGESETS.md §4.2). The GATE is not
      // here: `review_artifacts` is interactive and reaches the registry only through the
      // hub, like every other component — which is the §4.1 guarantee.
      registerChangesetFunctions(registry);
    }
    // The workflow's OWN TypeScript functions (SPEC §7.5) are merged BELOW, once the run's bundle is
    // known — see the note beside `resolveUserFunctions`. Read here so the prepare step at the end of
    // this method and the merge agree on which pair they are talking about.
    const userFns = userModules();

    // Gates this task was holding from an earlier process go now, not when this run reaches them.
    // A run walking the same workflow parks its OWN request with its own id, and a row from the
    // process before it would sit beside that one as a second copy of one question — the first
    // answerable only by resuming a task that is already running. What this run re-reaches it
    // re-asks; what it does not, nobody should be answering.
    project.interactions.clearTask(taskId);
    // And the same for what it was waiting on from the forge: this run re-parks what it re-reaches,
    // with a request id of its own. The row keeps its window, its cursor and what it has seen.
    project.remotes.stopAwaiting(taskId);

    const started = await beginTaskRun(project, taskId, {
      functions: registry.functions,
      ...(opts.bundle !== undefined ? { bundle: opts.bundle } : {}),
      // A start carrying a loaded machine is the continuation `beginTaskRun` otherwise refuses to
      // let a previously-run task make — restarting in place is the conversation-preamble hazard.
      ...(opts.loaded !== undefined ? { continues: true } : {}),
      ...(opts.reopen === true ? { reopen: true } : {}),
    });

    // The workflow's OWN TypeScript functions (SPEC §7.5), merged rather than wrapped: a resolved
    // symbol is already a registry entry carrying its capabilities, signature and error contract.
    //
    // AFTER the start, and resolved from the bundle the run will actually execute. The merge used to
    // sit above `beginTaskRun` and copy whatever the facade had resolved so far — which is nothing
    // for a task pinned to a snapshot (the resolved definition loads without resolving a symbol) and
    // nothing in a process whose pair was rebuilt after an approval. Every such run failed at its
    // first call with "no function 'user:…#confidence.score' is registered", about a function that
    // was approved, frozen and inside the snapshot. Asking for each reference by name first is the
    // same resolution the loader would have done, and idempotent where a load already did.
    if (userFns !== undefined) {
      resolveUserFunctions(userFns, started.bundle);
      registerUserFunctions(registry, userFns.userFunctions);
    }

    // Artifact placement (DESIGN §7.6): one wiring shared by the file tools and the
    // post-run sink, so an agent's writes and a prompt state's returned content land
    // under the same destination.
    const artifacts = artifactWiring({
      destination: config.artifacts.destination,
      artifactDir: config.artifacts.dir,
      inlineMaxBytes: config.artifacts.inlineMaxBytes,
      taskId,
      workspaceRoot: workspace.root,
      projectDir: project.paths.projectDir,
      jairaDir: project.paths.jairaDir,
    });
    // Registering these is what makes JaiRA own the agent's writes at all — and its reads, its
    // searches and its fetches, which used to be capabilities only the AGENT had. A tool we do not
    // register is a tool the gate has never heard of, and an unrecognised tool cannot be decided.
    registerFileTools(registry, {
      destination: artifacts.destination,
      store: project.artifacts,
      vars: artifacts.vars,
      inlineMaxBytes: artifacts.inlineMaxBytes,
    });
    registerSearchTools(registry, { cwd: workspace.root });
    registerWebTools(registry, {});

    // The run's half of `ToolSpec.alwaysGranted` — the chat path gets it inside `planAgentTools`,
    // and a run resolves `environment.tools` through the engine instead, so it has to be folded in
    // before the bundle is handed over.
    grantAlwaysGrantedTools(started.bundle.states);

    // §8.2: refuse a state whose runtime cannot enforce the policy it runs under,
    // rather than letting it run unguarded.
    // The RESOLVED states: a snapshot-loaded bundle carries no `source` (EXPRESSIONS.md §11), so
    // reading it would have gated a pinned run against `{}` — a check that always passes.
    const gateIssues = gateCapabilities(registry, started.bundle.states, {
      policyNeedsApproval: policyCanEscalate(config.policy),
    });
    if (gateIssues.length > 0) {
      finishTaskRun(project, taskId, "failed", {
        failure: { classification: "permanent", reason: gateIssues[0]!.message },
      });
      throw this.refusal("run", gateIssues.map((i) => `${i.stateId}: ${i.message}`).join("; "));
    }
    const abort = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    const directed = opts.directed ?? new DirectedTransitions();
    let endedCompleted = false;
    open.live.set(taskId, { taskId, abort, done, directed });

    // Claim the run (DESIGN §4.2a). Two things follow: another process opening this
    // project will see a live heartbeat and leave the task alone instead of
    // interrupting it, and a cancel requested from elsewhere reaches this abort
    // controller through the polled flag.
    // Where a child's output lands. Bounded head-and-tail and flushed on a debounce, because
    // `better-sqlite3` is synchronous and this is the main thread: one INSERT per `data` event on a
    // chatty agent is a stutter in the UI for output nobody is reading yet.
    const output = new JobOutputSink(project.db);
    owner = new RunOwner({
      jobs: project.jobs,
      taskId,
      output,
      onObserverError: (error, phase) =>
        this.log({
          level: "warn",
          source: "process",
          message: `recording a child process failed (${phase}): ${error.message}`,
          project: open.key,
          taskId,
          ...stackDetail(error),
        }),
      onCancelRequested: () => this.cancelTaskIn(open, taskId),
    });
    observe = owner.observer();

    // Every interactive function the bundle names that the script didn't answer
    // is routed to the renderer.
    for (const name of functionNamesOf(started.bundle)) {
      open.interactive.add(name);
      // The task is named at REGISTRATION, so every request this run parks carries it. The service
      // used to label a request with whichever run came first in its live map — right only while
      // exactly one existed, and now routinely wrong.
      if (!registry.functions.has(name)) open.hub.register(registry, name, taskId);
      scripted?.registerWildcard(registry, name);
    }

    // `on_user_event` is registered for EVERY run, not only for a bundle that names it. Unlike the
    // functions above it is not a state's operation, so it appears nowhere in `functionNamesOf` — it
    // is called from inside a transition guard, which is a binding and not a name this could walk to.
    // Registering it unconditionally costs a map entry and is what makes a guard that calls it work
    // in any workflow rather than in the ones a walker happened to recognise.
    open.userEvents.register(registry, taskId);
    // Its sibling on the forge, for every run for the same reason: it is called from a guard.
    open.remoteEvents.register(registry, taskId, project.remotes);

    // The remote primitives (decision 0004 §2), for every run for the reason `on_user_event` is: they
    // cost five map entries, and a workflow that reaches for one should find it whatever else it is
    // allowed. What they may DO is decided per call — `remote.publish` — and not by being registered.
    const remotePrimitives = registerRemoteFunctions(registry, {
      taskId,
      ...(project.tasks.tryRead(taskId)?.title !== undefined ? { taskTitle: project.tasks.tryRead(taskId)!.title } : {}),
      // Where the task was cut from is what the PROJECT directory has checked out; asked of git only
      // when a request is actually being made.
      baseBranch: () => new Git({ exec, repoDir: project.paths.projectDir, execEnv: config.execEnvironment }).currentBranch(),
      workspaceRoot: workspace.root,
      scratchDir: join(project.paths.systemDir, "remote-worktrees"),
      handles: project.remotes,
      integrations: config.integrations,
      policy: config.policy,
      secrets: this.secretResolver(open),
      exec,
      execEnv: config.execEnvironment,
      ...(this.options.forgeHttp !== undefined ? { http: this.options.forgeHttp } : {}),
      // A scripted run has nobody to ask: left out, `ask` refuses with a sentence instead of parking
      // a question a test never answers.
      ...(scripted === undefined ? { confirmPublish: (request: PublishRequest) => this.askToPublish(open, taskId, request) } : {}),
      grantProject: () => this.grantPublish(open),
    });
    // The gate's second door (decision 0004 §3). `review_artifacts` is interactive and was routed to
    // the hub above like every component; with a `remote` it ALSO lives on the forge, so this run's
    // registration parks through a wrapper that publishes first and tells the forge afterwards. With
    // no `remote` the wrapper is the plain park. Not for a scripted run, whose answers win.
    if (scripted === undefined && open.interactive.has(REVIEW_ARTIFACTS)) {
      const title = project.tasks.tryRead(taskId)?.title;
      registry.functions.set(
        REVIEW_ARTIFACTS,
        hostFunction(
          (inputs: FunctionInputs, ctx: unknown) =>
            reviewWithRemote(
              {
                taskId,
                ...(title !== undefined ? { taskTitle: title } : {}),
                // Parked on the hub, like every gate — which is also how the forge's answer arrives: the
                // watcher submits it to the same request, so there is nothing to race here.
                ask: (given, hooks) => open.hub.ask(REVIEW_ARTIFACTS, given, taskId, hooks.onParked),
                handles: project.remotes,
                primitives: remotePrimitives,
                workspace: { root: workspace.root, isWorktree: workspace.isWorktree === true },
                who: async () => (await new Git({ exec, repoDir: workspace.root, execEnv: config.execEnvironment }).identity()).name,
                onAwaiting: () => this.kickRemotes(),
                log: (message) => this.log({ level: "warn", source: "runtime", message, project: open.key, taskId }),
              },
              inputs,
              ctx,
            ),
          INTERACTIVE,
        ),
      );
    }

    const fakeRules = opts.fake !== undefined ? parseFakeRules(opts.fake) : undefined;
    if (fakeRules !== undefined) open.fakeRules.set(taskId, fakeRules);
    // The scope floor, compiled into a delegated agent's OWN permission rules and folded over every
    // prompt call. This is the run path's half of the rule compiler: the chat path emits the same
    // rules per message, and without this a workflow's states bounded nothing but our own callbacks
    // — the agent's built-ins ran under its default posture.
    const floor = scopeFloorOf(config);
    const scopeRules =
      floor === undefined ? {} : claudePermissionSettings(compileClaudeScopeRules(floor, { root: workspace.root }));
    // `claudePermissionSettings` returns the providerOptions VALUE — the key is this caller's, the
    // same way `chatOperationOf` writes it.
    const securityFloor = Object.keys(scopeRules).length > 0 ? { providerOptions: scopeRules as JsonValue } : undefined;
    const prompt = buildPromptExecutor({
      ...(fakeRules !== undefined ? { fakeRules } : {}),
      ...(securityFloor !== undefined ? { securityFloor } : {}),
      ...this.promptWiring(config, {
        fake: fakeRules !== undefined,
        secrets: opts.secrets,
        // The same observer the agent FUNCTION adapters get, a few lines up. A prompt op reaches an
        // agent through a model prefix rather than a `functionRef`, and that difference had come to
        // mean "and is not recorded as a job" — which is invisible until a run is stopped and the
        // process it left behind cannot be found.
        observer,
        // The durable store a definition's `memoize` step writes to. The RECORDING project's, because
        // that is where this run's database is — a memo is part of the run record, not of the config
        // that decided which model to call.
        memoCache: new SqliteMemoCache(project.db),
      }),
      // The DEFAULT executor's tree, resolved from what this machine can actually do. The startup
      // check is what makes that adaptive: without it a derived route lands on whichever adapter is
      // listed first, installed or not, and the run fails at its first prompt with a spawn error
      // rather than at its start with a legible one.
      tree: this.defaultTree(config, started.bundle, fakeRules !== undefined, opts.secrets).prompt,
    });
    // Partial answers, forwarded as they arrive. The transports already stream and nothing consumed
    // it; hw does not drain the prompt handle's events, so this is the single consumer that contract
    // asks for. Composed INSIDE the session layers below, which is what lets a delta name the position
    // it belongs to instead of being attributed by guesswork.
    // The live turn's DURABLE copy: the accumulated partial streams into the open record row on a
    // throttle, so a crash loses at most one flush window of finished turns. The store is scoped
    // exactly as the run's own record store is — same task, same run — which is what makes the
    // position key match the row `withRecord` claimed.
    const liveStore = sessionStoreFor(project, { taskId });
    // The record a flush lands in, resolved from the position ONCE and held while that position is
    // what the live turn reports. A flush addresses a record, not a place: when the handle coming back
    // says a call is not in the conversation the store assumed, the record moves to a branch, and a
    // position-addressed flush after that would find nothing.
    let flushingAt: string | undefined;
    let flushingRef: RecordRef | undefined;
    const liveFlush = new LiveTurnFlusher(() => {
      const snap = open.liveTurns.snapshot(taskId);
      if (snap === null || snap.sessionId === undefined || snap.seq === undefined) return;
      const at = `${snap.sessionId}@${snap.seq}`;
      if (at !== flushingAt) {
        flushingAt = at;
        flushingRef = liveStore.recordAt({ id: snap.sessionId, seq: snap.seq });
      }
      if (flushingRef === undefined) return;
      const partial = partialRecordValue(snap);
      if (partial !== null) liveStore.update(flushingRef, { value: partial, providerSessionId: snap.providerSessionId });
    });
    // What "stop" writes down before it stops anything — see `ProjectSession.liveFlush`.
    open.liveFlush.set(taskId, () => liveFlush.flush());
    const streaming = withTurnStream((delta) => {
      // Folded into main's live-turn log FIRST, so the number the push carries is the count a
      // `session:live` snapshot taken now would report — the merge protocol that lets a viewer seed
      // from the snapshot and skip the pushes already folded into it. The published entry is the
      // log's ENRICHED copy (timestamps, thought duration), so viewer, snapshot and persisted
      // partial all hold the same stamps.
      const { n, entry } = open.liveTurns.apply(taskId, delta);
      liveFlush.note();
      this.publish({
        type: "session:turn",
        taskId,
        n,
        ...(delta.session !== undefined ? { sessionId: delta.session.id, seq: delta.session.seq } : {}),
        ...(delta.stateId !== undefined ? { stateId: delta.stateId } : {}),
        ...(delta.text !== undefined ? { text: delta.text } : {}),
        ...(delta.thinking !== undefined ? { thinking: delta.thinking } : {}),
        ...(entry !== undefined ? { entry } : {}),
      });
    }, prompt, open.liveCalls);

    // Conversation `summary` mode (DESIGN §14 phase 7): installed only for the
    // sessions whose states asked for it, and summarizing through this run's own
    // prompt executor so a scripted run needs no provider.
    // Conversations, kept. `inner` is the seam `sessionServicesFor` has always had and never been
    // given: without it every run built a `MapSessionStore`, wrote every model call into it complete —
    // messages, thinking, tool calls, the provider's own handle — and dropped the whole thing when the
    // process exited. Scoped to this run, so a stored transcript can be found from the task that made
    // it (`stateSessions` is the other half of that join).
    const session = sessionServicesFor({ inner: sessionStoreFor(project, { taskId }) });
    // A delegated agent's record is its stream, and its stream is not its whole story: the agent's
    // own session file holds the context injections, `toolUseResult` records and line threading that
    // never ride the wire — and the file is the agent's, prunable on its schedule. Captured into the
    // record at each close, keyed by the workspace the agent ran in.
    session.records = withNativeCapture(session.records, {
      cwd: workspace.root,
      onError: (e: Error) =>
        this.log({
          level: "warn",
          source: "engine",
          message: `native session capture failed: ${e.message}`,
          project: open.key,
          taskId,
          ...stackDetail(e),
        }),
    });

    // Policy for this run: authored project rules compiled to an ExecPolicy, with
    // every decision audited and `require_approval` routed to the inbox (§10.2).
    const auditPolicy = (entry: PolicyAuditEntry): void => {
      open.approvals.noteDecision(entry);
      project.commands.record({
        taskId,
        tool: entry.tool,
        ...(entry.command !== undefined ? { command: entry.command } : {}),
        ...(entry.parsed !== undefined ? { parsed: entry.parsed as never } : {}),
        // A policy escalation is not itself a decision — the human's answer is
        // recorded separately when it arrives.
        decision: entry.action === "allow" ? "allowed" : entry.action === "deny" ? "blocked" : "allowed",
        decidedBy: "policy",
        reason: entry.reason,
        sessionId: entry.sessionId,
      });
    };
    const policy = compilePolicy(config.policy, {
      execEnv: config.execEnvironment,
      onDecision: auditPolicy,
      // The executor's scope floor, compiled onto `ExecPolicy.scopeOf`. The engine hands it to every
      // gate and every wrapped tool, and a tool that ENUMERATES reads it off `ctx.policy` to withhold
      // what an open would refuse. Absent ⇒ no narrowing, and nothing pays for the feature.
      ...(scopeFloorOf(config) !== undefined ? { scopes: scopeFloorOf(config)! } : {}),
      workspaceRoot: workspace.root,
      // The size a produced artifact has to exceed before somebody is asked about it. The number is
      // artifact configuration; turning it into an escalation is the policy's job.
      askAboveBytes: config.artifacts.askAboveBytes,
    });
    // OPEN THE GATE. A previous run of this task may have shut it on the way out (`stop`), and a
    // stop that outlived the run it stopped would refuse the first tool of the next one — a resumed
    // task that can never touch a file, failing for a reason nothing on screen would explain.
    open.approvals.allow(taskId);
    const approve = open.approvals.approver({ taskId });

    const recorder = project.events.recorder(taskId);
    let seq = 0;
    // A run STARTING is the first thing anyone looking for it wants to see, and nothing said it. The
    // logs held failures and process spawns, so a run that was merely slow looked identical to a
    // button that did nothing.
    this.log({
      level: "info",
      source: "run",
      message: `started ${started.meta.workflow} (${taskId})`,
      project: open.key,
      taskId,
    });
    this.publishFor(open, { type: "store:invalidate", scope: "tasks" });

    void (async () => {
      try {
        // Compile the workflow's own TypeScript before anything calls it — the step SPEC §7.5.5
        // puts on the far side of the approval gate `beginTaskRun`'s freeze already ran.
        if (userFns !== undefined) await prepareUserFunctions(userFns.userFunctions);
        const result = await executeWorkflow({
          bundle: started.bundle,
          inputs: started.meta.inputs ?? {},
          registry,
          prompt: streaming,
          ...(opts.loaded !== undefined ? { loaded: opts.loaded } : {}),
          ...(opts.answers !== undefined ? { answers: opts.answers } : {}),
          // A hosted fan-out's elements become tasks (decision 0003) — made, started and waited
          // for here, in the process that holds this run. The lists this task is split on travel
          // beside it, so a split mount over one of them narrows to this task's element.
          fanOut: fanOutHostFor({
            project,
            taskId,
            meta: started.meta,
            bundle: started.bundle,
            workspace,
            // The parent's scripted answers, if any, script the tasks it makes: a fake run's split
            // copies and mount tasks would otherwise reach for a real provider.
            startTask: (childId, o) => this.startMadeTask(open, childId, { ...o, ...(opts.fake !== undefined ? { fake: opts.fake } : {}) }),
            waitForTask: (childId, signal) => this.waitForTask(open, childId, signal),
            cancelTask: (childId) => {
              this.cancelTaskIn(open, childId);
            },
            tasksChanged: () => this.publishFor(open, { type: "store:invalidate", scope: "tasks" }),
            log: (level, message, at) => this.log({ level, source: "run", message, project: open.key, ...(at !== undefined ? { taskId: at } : {}) }),
          }),
          ...(started.meta.split !== undefined ? { split: started.meta.split } : {}),
          directed,
          // Tee the journal: persist, then push the same event to the renderer so
          // the detail view streams live without polling the database.
          persistence: {
            record: (event, atMs) => {
              recorder.record(event, atMs);
              this.traceRun(open.key, taskId, event);
              // The record lands when the operation settles — the stored view now holds everything
              // the live tail held, so the tail goes BEFORE the event that makes viewers refetch.
              // Kept in step with the renderer, which drops its own copy on the same two events.
              if (event.type === "operation.completed" || event.type === "operation.failed") {
                open.liveTurns.clear(taskId);
              }
              this.publishFor(open, {
                type: "engine:event",
                taskId,
                seq: ++seq,
                at: atMs,
                event: event as unknown as JsonValue,
              });
              this.publishFor(open, { type: "store:invalidate", scope: "board" });
            },
          },
          policy,
          approve,
          // Mid-run questions go to the person, not to the approval gate — see `QuestionHub`.
          askUser: open.questions.asker({ taskId }),
          session,
          workspace: {
            root: workspace.root,
            ...(workspace.treeHash !== undefined ? { treeHash: workspace.treeHash } : {}),
          },
          abortSignal: abort.signal,
        });
        const status = statusOfResult(result);
        // Blob content a state RETURNED never went through the file tools, so it is
        // placed here under the same destination. After the run: the work is done,
        // and an unwritable artifact must not fail it.
        persistEngineArtifacts(result.value as JsonValue | undefined, {
          destination: artifacts.destination,
          store: project.artifacts,
          vars: artifacts.vars,
          inlineMaxBytes: artifacts.inlineMaxBytes,
          onError: (name, error) =>
            this.publish({
              type: "engine:event",
              taskId,
              seq: ++seq,
              at: Date.now(),
              event: { type: "artifact.failed", name, reason: error.message } as unknown as JsonValue,
            }),
        });
        this.log({
          level: status === "completed" ? "info" : "warn",
          source: "run",
          message: `${status} ${started.meta.workflow} (${taskId})`,
          project: open.key,
          taskId,
          ...("error" in result && result.error !== undefined ? { detail: { reason: result.error.reason } } : {}),
        });
        // A run unwound by the app closing while its task was waiting on a person is SUSPENDED, and
        // its row says so in the spelling the next open resumes on — see `SUSPENDED_WAITING`.
        const suspended = status === "canceled" && open.suspendedAtClose.has(taskId);
        finishTaskRun(project, taskId, status, {
          outputs: result.value,
          ...(suspended
            ? { failure: { classification: "canceled", reason: SUSPENDED_WAITING } }
            : "error" in result && result.error !== undefined
              ? { failure: result.error }
              : {}),
        });
        this.publishFor(open, { type: "run:finished", taskId, status });
        this.settleWaiters(open, taskId);
        if (status === "completed") this.releaseDependents(open, taskId);
        endedCompleted = status === "completed";
      } catch (e) {
        // A crash between beginTaskRun and finishTaskRun would otherwise leave the
        // task `running` forever (recovery would call it interrupted next open).
        // The stack, before the failure becomes a bare `reason` on the run row — which is all that
        // survived, and which turned a crash in the run loop into a one-line mystery.
        this.log({
          level: "error",
          source: "engine",
          message: `the run loop crashed: ${(e as Error).message}`,
          project: open.key,
          taskId,
          ...((e as Error).stack !== undefined ? { detail: { stack: (e as Error).stack! } } : {}),
        });
        finishTaskRun(project, taskId, "failed", {
          failure: { classification: "permanent", reason: (e as Error).message },
        });
        this.publishFor(open, { type: "run:finished", taskId, status: "failed" });
        this.settleWaiters(open, taskId);
      } finally {
        // Give up the claim and close any child still recorded as running, so the
        // next project open sees no phantom owner and no phantom orphans.
        // Everything still buffered, written before the claim goes — a process's last words belong
        // with the run that produced them, not with whatever timer was pending when it ended.
        output.flush();
        owner?.release();
        // An answer this run never reached is an answer nothing is owed. Leaving it on the hub would
        // spend it on whatever the NEXT run of this task asks first, which from the person's side is
        // a gate that answered itself with something they said about a different question.
        open.hub.unseed(taskId);
        open.fakeRules.delete(taskId);
        open.live.delete(taskId);
        open.liveTurns.drop(taskId);
        liveFlush.dispose();
        open.liveFlush.delete(taskId);
        this.publishFor(open, { type: "store:invalidate", scope: "tasks" });
        this.publishFor(open, { type: "store:invalidate", scope: "task", taskId });
        settle();
        // A move that reached the port after the engine let go of it (decision 0005): the task
        // ended underneath the person's gesture. It is taken the way any move on a task that is
        // not running is — by reopening. Not for a run that was stopped: a stop is the later word.
        // Only for a run that COMPLETED: a run that failed before its engine ever attached still
        // holds the move it was reopened with, and taking that again would reopen it forever.
        const leftover = directed.queued().at(-1);
        if (leftover !== undefined && endedCompleted) {
          void this.moveTask({
            project: open.key,
            taskId,
            toState: leftover.to,
            by: leftover.by,
            ...(leftover.skip === true ? { skip: true } : {}),
            ...(leftover.instanceId !== undefined ? { instanceId: leftover.instanceId } : {}),
            ...(leftover.inputs !== undefined ? { inputs: leftover.inputs as Record<string, JsonValue> } : {}),
          }).catch((e: unknown) => {
            this.log({ level: "warn", source: "run", message: `a move left waiting when ${taskId} ended was not taken: ${(e as Error).message}`, project: open.key, taskId });
          });
        }
      }
    })();

    return { taskId };
  }

  // --- continuing a conversation by hand ---------------------------------------
  //
  // `NoConversationHere` (below the class) separates the two things that can go wrong here: this
  // instance is quiet, versus this installation is broken. Only the first is an ANSWER.
  //
  // A person typing into a run's transcript. The message runs as a prompt op under a child of the
  // instance being read — inheriting that state's model, tools and permissions from the run's PINNED
  // snapshot — and takes no part in the state machine: nothing binds to it, no transition fires from
  // it, and the task's status does not move. See `chatOperation.ts` and `chatTurn.ts`.

  /**
   * The settings a message WOULD run under, for the composer to show before anything is sent.
   *
   * Separate from sending because the composer has to render the model, effort, permissions and tools
   * the moment a run is selected — and a control that only learned its value by sending a message
   * would be a control nobody could trust before they had already committed to using it.
   */
  chatPlan(request: { taskId: string; instanceId: string; project?: string; overrides?: ChatSettings }): ChatPlanView | null {
    const open = this.session(request.project);
    let context;
    try {
      context = this.chatContextOf(request.taskId, request.instanceId, request.project);
    } catch (e) {
      // NULL, not a throw. This channel asks a QUESTION — "can I type here, and under what
      // settings?" — and "no" is one of its two answers. A composite orchestrates and says nothing,
      // so it holds no conversation; that is the ordinary shape of half the states in a workflow,
      // not a fault. Throwing made the composer's own catch turn it into the same disabled box while
      // main logged a stack trace per selected run, which is a log nobody can use and an error
      // nobody can act on.
      //
      // Only that class of answer is swallowed. A missing snapshot is the installation being broken
      // rather than this instance being quiet, and it still throws — see {@link NoConversationHere}.
      if (e instanceof NoConversationHere) return null;
      throw e;
    }
    const sessionId = sessionOf(context.position);
    // Which of the three things Enter does. Read at plan time rather than pushed: the composer
    // re-asks whenever the settings change, and a stale answer here is one wrong word rather than a
    // wrong action, because `sendChatMessage` re-checks before it does anything.
    const live: ChatPlanView["live"] =
      open.liveCalls.get(sessionId) === undefined ? "idle" : open.liveCalls.canSend(sessionId) ? "steerable" : "busy";
    const plan = chatPlanFor(context.path, request.overrides ?? {});
    // Built ONCE and shared with `effectiveOf`: it lists the routes on offer here and supplies the
    // pinned/unnamed-route fallback there, and `defaultTree` compiles the whole prompt tree.
    const router = this.defaultTree(open.project.config, context.bundle, false, this.secretResolver(open), false).prompt as {
      defaults?: Record<string, JsonValue>;
      routes?: Record<string, JairaPromptNode>;
    };
    const tools = AppService.gateableTools();
    return {
      ...plan,
      live,
      effective: this.effectiveOf(
        open,
        router,
        plan,
        this.modelOfRecord(open, request.taskId, context.position),
        tools,
      ),
      available: this.availableFor(open, router, tools),
    };
  }

  /**
   * The gateable tool set, named once — see JAIRA_TOOLS.
   *
   * Each carries `readOnly`, which is what lets a preset assign a mode by asking what the tool DOES
   * rather than by knowing its name. A CLI route also offers "default", which means its OWN tools
   * rather than any of these.
   */
  private static gateableTools(): ToolChoice[] {
    return JAIRA_TOOLS.map((t) => ({ name: t.name, readOnly: t.readOnly }));
  }

  /** What this machine can offer a composer: who can answer, what can be gated, which models exist. */
  private availableFor(
    open: ProjectSession,
    router: { routes?: Record<string, JairaPromptNode> },
    tools: readonly ToolChoice[],
  ): ChatPlanView["available"] {
    return {
      // Provider routes AND agent routes, as peers. `claude-cli` and `anthropic` are two different
      // answers to "who answers this" — one is a program on this machine running on a subscription,
      // the other is the API — so they are sibling rows rather than one folded into the other.
      routes: [
        ...new Set([...Object.keys(router.routes ?? {}), ...Object.keys(agentPromptRouteNames(open.project.config.agents))]),
      ].sort(),
      tools: [...tools],
      models: knownModels(),
    };
  }

  /**
   * The settings a conversation that has not been started yet would run under.
   *
   * The same question `chatPlan` answers, asked one screen earlier. It exists because the box that
   * STARTS a conversation is a box that sends a message, and every reason the settings belong on the
   * composer applies at least as much to the first message as to the fortieth: it is the one that
   * decides what the whole conversation inherits, and it used to be the only one sent blind.
   *
   * Read off the state FILE rather than off a run, which is the only difference between this and
   * `chatPlan` and the source of both `undefined`s below. Nothing has answered yet, so there is no
   * recorded model to prefer over the router's; and nothing is in flight, so Enter is always `idle`.
   *
   * A state id nobody has installed yet is an ANSWER, not a fault — the Chat view writes its states
   * on first send, so on a fresh machine this is asked before the file exists. `chatPlanFor` already
   * takes an absent state (that is what a composite's path is made of), and what comes back is a plan
   * whose every origin is `unset`: no inheritance to report, and the machine's own defaults reported
   * around it. The composer renders exactly that, and the first message installs the file.
   */
  chatStartPlan(request: { stateId: string; project?: string; overrides?: ChatSettings }): ChatPlanView {
    const open = this.session(request.project);
    // Live files, never a snapshot: this conversation has not pinned one, and what it will run is
    // whatever `beginTaskRun` reads a moment from now — which is this.
    const bundle = bundleFor(open.project, request.stateId);
    const plan = chatPlanFor([bundle?.states[request.stateId]], request.overrides ?? {});
    // The router, built over an EMPTY bundle. `defaultExecutorTree` refuses when a workflow's prompt
    // states name no model and nothing on this machine can answer one — a refusal that belongs to the
    // attempt and not to the preview. Raised here it would blank the composer on precisely the
    // machine where somebody needs to read it: the one where they have to pick a route by hand
    // before the first message can go anywhere. The routes and defaults come from the configuration
    // either way; the bundle only decides whether to throw.
    const router = this.defaultTree(open.project.config, { rootId: request.stateId, states: {} }, false, this.secretResolver(open), false)
      .prompt as {
      defaults?: Record<string, JsonValue>;
      routes?: Record<string, JairaPromptNode>;
    };
    const tools = AppService.gateableTools();
    return {
      ...plan,
      live: "idle",
      effective: this.effectiveOf(open, router, plan, undefined, tools),
      available: this.availableFor(open, router, tools),
    };
  }

  /**
   * Which model answered the last turn of this conversation.
   *
   * Read off the STORED RESULT rather than inferred from config, because it is the only place the
   * answer exists: routing happens inside the call, so a state naming `claude-cli` and a state naming
   * nothing at all both resolve to a model that no configuration file mentions.
   */
  private modelOfRecord(open: ProjectSession, taskId: string, position: string): string | undefined {
    const at = position.lastIndexOf("@");
    if (at <= 0) return undefined;
    const id = position.slice(0, at);
    const seq = Number(position.slice(at + 1));
    if (!Number.isInteger(seq)) return undefined;
    // Scoped to the task that wrote it, exactly as sessionView is — where its aliases and legacy
    // spellings resolve.
    const store = sessionStoreFor(open.project, { taskId });
    // The position is where the NEXT turn goes, so the last one written is the seq below it.
    const record = store.at(id, seq - 1) ?? store.at(id, seq);
    // `record.value` is the ENVELOPE; the `LlmOutput` is its own `value` inside it — the same nesting
    // `messagesOfRecord` reads as `value.value.messages`. Reading one level too shallow found `model`
    // on nothing, so this silently never fired and every chip fell through to the router default.
    const envelope = record?.value;
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
    const output = (envelope as Record<string, unknown>)["value"];
    if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
    const model = (output as Record<string, unknown>)["model"];
    return typeof model === "string" && model.length > 0 ? model : undefined;
  }
  /**
   * What will ACTUALLY run when nothing is changed.
   *
   * A control saying "no model" is answering a question nobody asked. The person is not wondering
   * whether the state named one — they are wondering what happens if they press Enter, and "nothing
   * was declared here" is a fact about the workflow file rather than an answer about the call.
   *
   * Where a value cannot be known, this says which thing decides it rather than inventing one. The
   * model is the interesting case: a state naming none does not fall back to a fixed default, it
   * falls to the ROUTER, which picks the first route that can answer an unnamed model. So the honest
   * answer is the route's name, not a model id we would have had to make up.
   *
   * Takes the resolved prompt ROUTER rather than building one: the caller has already built it to
   * list the routes it offers, and `defaultTree` is not cheap enough to run twice for one view.
   */
  private effectiveOf(
    open: ProjectSession,
    router: { defaults?: Record<string, JsonValue>; routes?: Record<string, JairaPromptNode> },
    plan: ReturnType<typeof chatPlanFor>,
    /**
     * What answered the LAST turn of this conversation, when there was one — read off the record by
     * the caller. Passed in rather than looked up here because a conversation that has not started
     * has no record and no position to look one up by, and `undefined` is the whole of what that
     * difference amounts to: the answer falls through to the router, exactly as it did for the first
     * turn of every conversation that now has a history.
     */
    lastModel: string | undefined,
    tools: readonly ToolChoice[],
  ): ChatPlanView["effective"] {
    // What ANSWERED this conversation last. It beats everything below it: a state that named no
    // model, or named a route that picks its own, was still answered by something, and the record is
    // where that decision was written down.
    const model =
      plan.settings.model ??
      lastModel ??
      (() => {
        const pinned = router.defaults?.["model"];
        if (typeof pinned === "string") return pinned;
        const route = unnamedRouteOf(router.routes);
        // A REAL id, not prose. "claude-cli decides" was declining to answer a question this can
        // answer well enough: the route is known now and the model it will pick is not, and
        // `claude-cli/default` says exactly that in the one syntax everything downstream parses.
        // It is also why the chip lost its logo — the icon reads the route off the prefix, and a
        // string with a space in it has no prefix to read.
        return route === undefined ? undefined : `${route}/default`;
      })();
    return {
      ...(model !== undefined ? { model } : {}),
      // No project-level default to read: a call with no `reasoning` gets the model's own. Naming
      // the decider beats printing a value we invented.
      reasoning: plan.settings.reasoning?.effort ?? "the model's default",
      // The per-tool MAP, named as the preset it matches — see `postureOf`. The map is what the
      // executor is handed, so it is the only honest thing to report.
      // The posture is worded off the per-tool modes, and a message that carries a TOOLSET has them
      // in the map rather than in the block (decision 0007) — so they are read from wherever they are.
      permissions: postureOf(
        open.project.config,
        tools,
        plan.settings.toolset === undefined
          ? plan.settings.permissions
          : (() => {
              const { toolset } = toolsetOfSettings(plan.settings);
              return { tools: toolModes(toolset), ...(toolset.other !== undefined ? { default: toolset.other } : {}), ...(toolset.profile !== undefined ? { profile: toolset.profile } : {}) };
            })(),
      ),
    };
  }

  /**
   * Wait for something, but not forever.
   *
   * Every wait on this path is a wait on a CALL, and a provider that stops answering would otherwise
   * take the waiter with it — and the waiter is an IPC handler, so it would take the request with it
   * too: no reply, no error, nothing to cancel. Past the bound the caller carries on and the store
   * resolves the collision by forking, which is a worse answer than a continuation and a far better
   * one than a request that never returns.
   */
  private static async within(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([promise, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** What one typed message is, as a request — the same shape whether it queues or goes straight in. */
  private static chatSend: {
    taskId: string;
    instanceId: string;
    message: string;
    overrides?: ChatSettings;
    project?: string;
    branchAt?: string;
    fake?: JsonValue | FakeRule[];
  };

  /**
   * Send one message into the conversation an instance ran — behind the message before it.
   *
   * ## Why a message has to know about the one ahead of it
   *
   * Where a message goes is computed from where the conversation is recorded as ENDING, and a message
   * that has been sent but has not yet been written down is invisible to that computation. So two
   * messages sent close together both read the same end, both resolve to it, and the store answers
   * the only way it honestly can: the second collides and branches. One conversation becomes two, the
   * thread reads one of them, and the other message is on disk and on no screen.
   *
   * That window is entirely reachable now that a message can be sent mid-turn — it is the time
   * between pressing Enter twice — and nothing that can be QUERIED closes it. The live register holds
   * a call only while it runs, so it is silent both before the call starts and after it settles, and
   * a waiter that consulted it in either window computed a position something else was holding.
   *
   * So each send takes the previous one's completion promise on the way in, synchronously, before any
   * await — the point being that no second send can read the chain between this one reading it and
   * joining it. What it does with that promise is {@link runChatMessage}'s business: a message that
   * can JOIN the turn in flight does not wait for it at all.
   *
   * The promise is resolved in the `finally`, so a message that fails anywhere — before its call, in
   * its call, in the journal write after it — cannot leave the ones behind it waiting.
   */
  async sendChatMessage(
    request: typeof AppService.chatSend,
  ): Promise<ChatTurnResult & { instanceId: string; index: number; steered?: boolean }> {
    if (request.message.trim() === "") throw this.refusal("run", "a message cannot be empty");
    const open = this.session(request.project);
    // Taken before this send installs its own, so it names the PREDECESSOR rather than itself.
    const settledAhead = open.chatDone.get(request.taskId);
    let finished = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    open.chatDone.set(request.taskId, done);
    try {
      return await this.runChatMessage(open, request, settledAhead);
    } finally {
      if (open.chatDone.get(request.taskId) === done) open.chatDone.delete(request.taskId);
      finished();
    }
  }

  /**
   * One typed message, run — everything after its turn in the queue has come round.
   *
   * The child never joins the state machine — nothing binds to it and no transition fires from it —
   * so this assembles what a prompt call needs and nothing else. Notably NOT a run: no workspace is
   * materialized, no job is claimed, no task status moves. A conversation continued by hand is a
   * conversation, not a second execution of the workflow.
   */
  private async runChatMessage(
    open: ProjectSession,
    request: typeof AppService.chatSend,
    /** The typed turn ahead of this one, if there is one — resolves when it has landed. */
    settledAhead?: Promise<void>,
  ): Promise<ChatTurnResult & { instanceId: string; index: number; steered?: boolean }> {
    const project = open.project;
    let context = this.chatContextOf(request.taskId, request.instanceId, request.project, request.branchAt);

    // A call still taking its turn, in the conversation being read. Talking to THAT is different from
    // starting a turn beside it: the message joins the turn already in progress and the agent answers
    // in its own stream, so there is no child to record and no position to claim. Only some transports
    // can do it — `sessionSteering` is declared, not discovered — and `steerOf` returns nothing at all
    // when they cannot, which is why this is a branch rather than an attempt.
    // An EDIT is never steering. Steering joins the turn in flight — which is the turn being
    // replaced, or one after it — and "say this instead" is the opposite of "also say this".
    const steer = request.branchAt === undefined ? this.steerOf(open, context.position) : undefined;
    if (steer !== undefined) {
      await steer.send(request.message);
      return { instanceId: context.hostInstanceId, index: context.index, steered: true };
    }

    /**
     * It cannot be steered, so this message goes AFTER whatever is in flight — which means waiting
     * for that to land, and there are two different things it might be.
     *
     * A TYPED TURN ahead of this one in the queue is waited for by its own promise. The live register
     * cannot stand in for it: a call is registered only while it runs, so between this message being
     * let through (which happens when the turn ahead STARTS) and that turn journalling its result,
     * the register can be empty while the position is very much taken. Asked first, and asked
     * unconditionally, because the answer is not visible anywhere a query could find it yet.
     */
    if (settledAhead !== undefined) {
      await AppService.within(settledAhead, CHAT_WAIT_MS);
      // Re-read: the head MOVED, which is the whole reason for waiting. Sending the position computed
      // beforehand would fork every time and defeat it.
      context = this.chatContextOf(request.taskId, request.instanceId, request.project, request.branchAt);
    }
    /**
     * And a RUN's own call — the opening message of a conversation, or a workflow state being typed
     * into mid-run. That one is not a chat turn and has no promise here, so the register is exactly
     * the right question for it.
     */
    const sessionId = sessionOf(context.position);
    if (open.liveCalls.get(sessionId) !== undefined) {
      // BOUNDED. An unbounded await is the same promise the call is parked on, so a provider that
      // stops answering takes this IPC handler with it — the composer sits on `busy` with no reply,
      // no error and nothing to cancel. Past the bound we append BESIDE the call instead, which
      // `withSessionPosition` handles by forking: a branch is a worse answer than a continuation and
      // a much better one than a request that never returns.
      const settled = await open.liveCalls.settle(sessionId, CHAT_WAIT_MS);
      // Re-read, because the head MOVED — which is the entire reason for waiting. Sending the position
      // computed before the wait would fork every time and defeat it.
      if (settled) context = this.chatContextOf(request.taskId, request.instanceId, request.project, request.branchAt);
    }
    // NOT refused when the state named no model. Refusing rejected exactly the case the resolution
    // chain exists for: a state naming none is answered by the ROUTER, which is how its own run
    // succeeded — so throwing here made a continuation refuse what the workflow does routinely, and
    // did it while the chip above showed a model. The op carries no model and the router answers it,
    // exactly as it answered the state.
    const plan = chatPlanFor(context.path, request.overrides ?? {});

    const config = project.config;
    const secrets = this.secretResolver(open);
    const fakeRules = request.fake !== undefined ? parseFakeRules(request.fake) : undefined;
    const fake = fakeRules !== undefined;
    // ONE executor, used twice. It was built twice — once for the summarizer and once for the turn —
    // with hand-copied options and a memo cache each, so the two had to be kept in step by eye and
    // neither could reuse the other's memo. The summarizer takes the BARE executor and the turn takes
    // it under the session layers, which is the only difference between the two uses.
    const prompt = buildPromptExecutor({
      ...(fakeRules !== undefined ? { fakeRules } : {}),
      // No observer: a chat turn is not a run, so it holds no job claim for a child to hang off (see
      // `cancelChatTurn`). Stated rather than left out, because an observer omitted by accident is
      // exactly how the run path came to spawn unrecorded agents. An agent started from a
      // conversation is therefore still unfindable as an orphan — worth closing, and it needs a claim
      // to close it, not another argument here.
      ...this.promptWiring(config, { fake, secrets, memoCache: new SqliteMemoCache(project.db) }),
      tree: this.defaultTree(config, context.bundle, fake, secrets).prompt,
    });
    // The workspace root is READ, never ensured: a bound task's worktree path is recorded, and
    // `ensureWorkspace` would CREATE one — which is the one thing this path promises not to do, since
    // a conversation is not a second execution. An unbound task, or a bound one whose worktree has
    // been removed, falls back to the project directory, which is where its run read from anyway.
    const recordedWorktree = project.runtime.get(request.taskId)?.worktreePath;
    const workspaceRoot =
      recordedWorktree !== undefined && existsSync(recordedWorktree) ? recordedWorktree : project.paths.projectDir;
    const liveStore = sessionStoreFor(project, { taskId: request.taskId });
    const stores = sessionServicesFor({ inner: liveStore });
    // The same capture `startRun` wires: a chat turn is a real delegated call, and its record would
    // otherwise be the one kind missing the agent's own session lines.
    stores.records = withNativeCapture(stores.records, {
      cwd: workspaceRoot,
      onError: (e: Error) =>
        this.log({
          level: "warn",
          source: "engine",
          message: `native session capture failed: ${e.message}`,
          project: open.key,
          taskId: request.taskId,
          ...stackDetail(e),
        }),
    });
    /**
     * The live turn, for a message somebody typed — everything `startRun` wires, wired here too.
     *
     * A chat turn had none of it, and the three things missing were not three conveniences:
     *
     *  - **Nothing streamed.** The reply appeared when the call settled, so a long answer was a
     *    frozen box; and the run's own first message DID stream, which made the conversation appear
     *    to lose a capability after its opening exchange.
     *  - **Nothing was persisted while it ran.** `update` writes the accumulated turn into the
     *    open row on a throttle, and it is also what stamps the provider's handle early. Without it
     *    an interrupted turn's record held the error and nothing else: what the model had already
     *    said was gone, and the next message had no handle to resume from.
     *  - **Nothing was registered as a live call.** `liveCalls` is what `chatPlan` reads to answer
     *    `steerable`, so a mid-turn message could never JOIN the turn — the one thing the composer's
     *    "joins this turn" line has always promised.
     *
     * Composed INSIDE the session layers, as in `startRun`: by then `ctx.session` is the resolved
     * position, so a delta names the conversation it belongs to instead of being attributed by guess.
     */
    // Resolved once per position and held — see the same shape in `startRun`.
    let flushingAt: string | undefined;
    let flushingRef: RecordRef | undefined;
    const liveFlush = new LiveTurnFlusher(() => {
      const snap = open.liveTurns.snapshot(request.taskId);
      if (snap === null || snap.sessionId === undefined || snap.seq === undefined) return;
      const at = `${snap.sessionId}@${snap.seq}`;
      if (at !== flushingAt) {
        flushingAt = at;
        flushingRef = liveStore.recordAt({ id: snap.sessionId, seq: snap.seq });
      }
      if (flushingRef === undefined) return;
      const partial = partialRecordValue(snap);
      if (partial !== null) liveStore.update(flushingRef, { value: partial, providerSessionId: snap.providerSessionId });
    });
    // What "stop" writes down before it stops anything — see `ProjectSession.liveFlush`.
    open.liveFlush.set(request.taskId, () => liveFlush.flush());
    const streaming = withTurnStream((delta) => {
      const { n, entry } = open.liveTurns.apply(request.taskId, delta);
      liveFlush.note();
      this.publish({
        type: "session:turn",
        taskId: request.taskId,
        n,
        ...(delta.session !== undefined ? { sessionId: delta.session.id, seq: delta.session.seq } : {}),
        ...(delta.stateId !== undefined ? { stateId: delta.stateId } : {}),
        ...(delta.text !== undefined ? { text: delta.text } : {}),
        ...(delta.thinking !== undefined ? { thinking: delta.thinking } : {}),
        ...(entry !== undefined ? { entry } : {}),
      });
    }, prompt, open.liveCalls);
    const executor = withSessionLayers(stores, streaming);

    // JaiRA registered these and JaiRA compiled the policy, so it always knows what it is handing
    // over — see `gateTools`. An unresolvable name throws rather than quietly running without it.
    //
    // BOTH registrations, exactly as `startTask` does them. `registerTools` supplies `bash` alone;
    // the file tools come from `registerFileTools`, and with only the first of the two a reader who
    // ticked `read_file` got `tool 'read_file' is not registered` — the loud failure that call is
    // designed to give for a name nobody registered, raised here for a wiring gap instead.
    const registry = newRegistry();
    registerTools(registry, { execEnv: config.execEnvironment, exec: new NodeExec({ execEnv: config.execEnvironment }) });
    // The same artifact wiring the run used, so a file this turn writes lands where that run's files
    // landed rather than somewhere only this conversation knows about.
    //
    // `workspaceRoot` is resolved above, where the session capture needed it first — the same
    // read-never-ensure rule stated there.
    const artifacts = artifactWiring({
      destination: config.artifacts.destination,
      artifactDir: config.artifacts.dir,
      inlineMaxBytes: config.artifacts.inlineMaxBytes,
      taskId: request.taskId,
      workspaceRoot,
      projectDir: project.paths.projectDir,
      jairaDir: project.paths.jairaDir,
    });
    registerFileTools(registry, {
      destination: artifacts.destination,
      store: project.artifacts,
      vars: artifacts.vars,
      inlineMaxBytes: artifacts.inlineMaxBytes,
    });
    registerSearchTools(registry, { cwd: workspaceRoot });
    registerWebTools(registry, {});
    const approve = open.approvals.approver({ taskId: request.taskId });
    /**
     * The project policy with THIS message's per-tool modes folded into its baseline.
     *
     * Two consumers, and the fold is for the second. `gateTools` reads the authored modes directly,
     * so JaiRA's own tools are gated either way. But a DELEGATED agent reads `ctx.policy.baseline.tools`
     * to build its deny floor — the set of tools it is never even offered — and that read goes to the
     * project baseline, which knows nothing about what was picked in the composer. Unfolded, a tool
     * set to `deny` here was still handed to the agent, refused only once it tried to call it.
     *
     * The message's own choice wins over the project's: it is the narrower, later statement.
     */
    //
    // ONE map is read for all of it (decision 0007): the message's toolset, or the list, the
    // `permissions` block and the implementations the composer still writes, folded into one.
    const { toolset } = toolsetOfSettings(plan.settings);
    const policy: ExecPolicy = compilePolicy(config.policy, {
      execEnv: config.execEnvironment,
      ...(scopeFloorOf(config) !== undefined ? { scopes: scopeFloorOf(config)! } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      askAboveBytes: config.artifacts.askAboveBytes,
      toolset,
    });
    // The tools to RESOLVE are the ones being injected, which is not the same set as the ones
    // granted: a tool granted with a NATIVE implementation is not ours to wrap — the agent runs its
    // own, and what makes it answerable is the ask-rule `chatOperationOf` writes plus the gate
    // below, which decides by logical name whichever implementation called. Wrapping it here as
    // well would build a tool nothing would ever call.
    const wiring = planAgentTools(toolset);
    const { tools, gate } = gateTools({
      registry,
      // `tools === undefined` means the message said nothing and the STATE's declaration stands, so
      // the plan is not what runs and its injections must not be wrapped. The always-granted set is
      // the exception, and has to be: a conversation with no tools at all is exactly the one that
      // reaches for a mockup, and `chat/assistant.json` declares none.
      names: declaresTools(plan.settings) ? wiring.inject : [...ALWAYS_GRANTED_TOOLS],
      sessionId: sessionOf(context.position),
      policy,
      approve,
      // A message that carries a toolset hands it over as it is. One that carries the legacy block
      // leaves the fold to `gateTools`, which folds it over the names actually INJECTED — so an
      // always-granted tool the list never mentioned still takes the block's `default`, as it did.
      // `authored` goes either way, for its `scopes`: where a tool may act is not part of a toolset.
      ...(plan.settings.toolset !== undefined ? { toolset } : {}),
      ...(plan.settings.permissions !== undefined ? { authored: plan.settings.permissions } : {}),
      // What a relative scope glob and a relative call path resolve against — see `scopeNarrowingFor`.
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    });

    const { operation } = chatOperationOf(plan, { message: request.message, session: { id: context.position } });
    const recorder = project.events.recorder(request.taskId);
    /** Push ordering for this turn's journal events — the renderer's own `seq`, as a run supplies. */
    let chatSeq = 0;
    /**
     * What "stop" reaches — see {@link cancelChatTurn}.
     *
     * Registered against the TASK, and only for the duration of the turn. An abort lands in
     * `runChatTurn` as an ordinary failure with `classification: "canceled"`, so the journal records
     * a canceled turn rather than a hole: the message stays, and whatever the model had said by then
     * is what the transcript keeps.
     */
    const abort = new AbortController();
    // ADDED, never replacing. A turn already in flight here is a turn somebody is still waiting for
    // an answer to — the message being sent now joined it, or is queued behind it — and the previous
    // spelling aborted it on the way past, so a follow-up question killed the reply it was following
    // up on. See `ProjectSession.chatTurns`.
    const turns = open.chatTurns.get(request.taskId) ?? new Set<AbortController>();
    turns.add(abort);
    open.chatTurns.set(request.taskId, turns);
    const result = await this.whileChatting(open, request.taskId, abort, liveFlush, () =>
      runChatTurn(
      {
        executor,
        sessions: stores.sessions,
        /**
         * Journalled, then TEED to the renderer — the same shape `startRun` gives its own events.
         *
         * A chat turn published nothing, which mattered once it started streaming: the renderer drops
         * its live tail on `operation.completed`/`operation.failed` and had no other signal, so the
         * tail would have stayed on screen beside the settled record it is a copy of. Main's own copy
         * goes first, for the reason stated in `startRun`: the stored view holds it by then.
         */
        record: (event, atMs) => {
          recorder.record(event, atMs);
          if (event.type === "operation.completed" || event.type === "operation.failed") {
            open.liveTurns.clear(request.taskId);
          }
          this.publishFor(open, {
            type: "engine:event",
            taskId: request.taskId,
            seq: ++chatSeq,
            at: atMs,
            event: event as unknown as JsonValue,
          });
        },
        /**
         * Everything the call needs that is not the session — and three of the four were missing.
         *
         * `tools` alone gated JaiRA's own three and nothing else, which is only half the surface when
         * the route is a delegated agent. Such an agent arrives with its OWN tools and enforces them
         * through the two seams below, so a turn that supplied neither ran `claude-cli`'s built-in
         * Bash and Write with no approval prompt and no deny floor — while the composer above it
         * displayed a permission posture that had no bearing on them.
         *
         *  - `gate` is the full decision — profile, mode, `smart`, then the human — over the agent's
         *    OWN tools, which no wrapper here can reach. It is what makes the four modes mean the
         *    same thing on an agent route as on a plain model one.
         *  - `approve` is the older, thinner seam an adapter falls back to, and what the gate itself
         *    escalates to. Absent, an un-gated adapter builds no callback at all.
         *  - `policy` is where an adapter reads its deny floor — the tools it is not offered in the
         *    first place. Folded with this message's choices above.
         *  - `workspace` is what `bash` and the file tools resolve paths against, so without it a
         *    command ran in whatever directory the app was launched from. The run's own root — read,
         *    never ensured (see above).
         */
        services: {
          tools,
          gate,
          workspace: { root: workspaceRoot },
          policy,
          approve,
          // A chat turn can reach an agent that asks — same question channel as a run's.
          askUser: open.questions.asker({ taskId: request.taskId }),
          // The same signal a run hands its calls. Without it there was nothing between "sent" and
          // "the provider is done", however long that took.
          abortSignal: abort.signal,
        } as ExecServices,
      },
      {
        instance: {
          // Derived, never allocated: stable per host instance, so the second message reopens the
          // same node instead of entering a sibling that would supersede the first. Keyed on the
          // HOST rather than on whatever was clicked, so two composites under one speaking state
          // continue the same conversation instead of minting a chat child each.
          instanceId: chatInstanceIdOf(context.hostInstanceId),
          parentInstanceId: context.hostInstanceId,
          stateId: context.stateId,
          childKey: CHAT_CHILD_KEY,
          index: context.index,
        },
        operation,
        position: context.position,
      },
      ),
    );
    // `task`, not `tasks`. The renderer refreshes the conversation and the session views on `task`
    // and only the task LIST on `tasks` — so the plural left the reply invisible: the box cleared,
    // the turn ran, and the panel above stayed byte-identical until something unrelated invalidated.
    this.publishFor(open, { type: "store:invalidate", scope: "task", taskId: request.taskId });
    return { ...result, instanceId: chatInstanceIdOf(context.hostInstanceId), index: context.index };
  }

  /**
   * Run a turn with its stop registered, and give back everything the turn held however it ends.
   *
   * THIS turn's controller leaves the set and the others stay: a thread can have two turns in flight,
   * and removing the task's whole entry would disarm the stop button for the one still going.
   *
   * The flusher is disposed on the same path, and it has to be on a path that runs even when the turn
   * throws: a pending timer keeps a handle open and would fire against a record that has settled.
   * The live tail is cleared as a BACKSTOP — the settle event clears it first in the ordinary case,
   * and a turn that failed before reaching one would otherwise leave a tail on screen forever. Only
   * once nothing is left in flight, or a settling turn would take a live one's tail off the screen.
   */
  private async whileChatting<T>(
    open: ProjectSession,
    taskId: string,
    abort: AbortController,
    liveFlush: LiveTurnFlusher,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } finally {
      const turns = open.chatTurns.get(taskId);
      turns?.delete(abort);
      if (turns?.size === 0) open.chatTurns.delete(taskId);
      liveFlush.dispose();
      if (!open.chatTurns.has(taskId)) {
        open.liveTurns.clear(taskId);
        open.liveFlush.delete(taskId);
      }
    }
  }

  /**
   * Stop the turn a conversation is taking.
   *
   * `task:cancel` cannot do this and should not learn how: a chat turn is not a run, so there is no
   * job to release and no task row to settle — cancelling the TASK of a conversation that has been
   * idle for an hour would mark a finished run interrupted for the sake of a message nobody sent.
   *
   * `false` means there was nothing to stop, which is an answer rather than a fault: the turn may
   * have landed between the button being shown and being pressed.
   *
   * EVERY turn this conversation has going, because that is what the button says. A thread can have
   * two in flight — a message sent mid-turn joins the one already running, and a queued one starts
   * its own — and a stop that reached only one of them would leave the agent working under a
   * composer that had just told the person it had stopped.
   */
  cancelChatTurn(request: { taskId: string; project?: string }): { canceled: boolean } {
    const open = this.session(request.project);
    const turns = open.chatTurns.get(request.taskId);
    if (turns === undefined || turns.size === 0) return { canceled: false };
    // What it had said by now, written down BEFORE it is stopped — while the record is still open and
    // a partial can still reach it. See `ProjectSession.liveFlush`.
    open.liveFlush.get(request.taskId)?.();
    for (const abort of turns) abort.abort();
    open.chatTurns.delete(request.taskId);
    return { canceled: true };
  }

  /**
   * Rename a task.
   *
   * The title is what a conversation is FOUND by, so this is a first-class verb rather than an edit
   * of a file somebody has to know the shape of. Nothing about a run depends on it: the meta file is
   * rewritten with the new title and every list that shows one is invalidated.
   */
  renameTask(request: { taskId: string; title: string; project?: string }): TaskSummary {
    const title = request.title.trim();
    if (title === "") throw this.refusal("run", "a task needs a title");
    const open = this.session(request.project);
    const project = open.project;
    const meta = project.tasks.read(request.taskId);
    project.tasks.write({ ...meta, title });
    const row = project.runtime.get(request.taskId);
    if (row === undefined) throw this.refusal("run", `unknown task '${request.taskId}'`);
    this.publishFor(open, { type: "store:invalidate", scope: "tasks" });
    this.publishFor(open, { type: "store:invalidate", scope: "board" });
    return {
      taskId: meta.id,
      title,
      status: row.status,
      workflow: meta.workflow,
      ...(meta.labels !== undefined ? { labels: meta.labels } : {}),
      createdAt: meta.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * The control for a call in flight in this conversation, when there is one and it can be talked to.
   *
   * The position a reply would be sent AT is `<session>@<seq>`, and the register is keyed by the
   * session alone — a call in flight has not finished claiming its position, so matching on the whole
   * ref would never hit. Splitting on the last `@` is the same arithmetic the store uses, and it is
   * why a compaction's `planning~compact1@3` still resolves to one id.
   */
  private steerOf(open: ProjectSession, position: string): { send(text: string): Promise<void> } | undefined {
    // `send` specifically, not `control`: every method on `ExecControl` is individually optional, so
    // a transport offering `interrupt` and nothing else is representable — and would give us an object
    // here whose `send` is not there.
    const send = open.liveCalls.get(sessionOf(position))?.control?.send;
    return send === undefined ? undefined : { send: (text) => send(text) };
  }

  /**
   * Everything a chat turn needs to know about where it is being sent.
   *
   * The bundle is the run's PINNED snapshot rather than live `workflows/`, for the same reason
   * execution reads the snapshot: the settings shown must be the ones the conversation on screen
   * actually ran under, and an edit since then would otherwise silently change them.
   */
  private chatContextOf(
    taskId: string,
    instanceId: string,
    projectKey?: string,
    /** Send at this position rather than after everything — see `chat:send`'s `branchAt`. */
    branchAt?: string,
  ): {
    bundle: WorkflowBundle;
    /** The instance whose conversation is being continued — see below on why it may not be the one asked for. */
    hostInstanceId: string;
    stateId: string;
    path: Array<LoadedState | undefined>;
    position: string;
    index: number;
  } {
    const open = this.session(projectKey);
    const project = open.project;
    const task = project.runtime.get(taskId);
    if (task?.snapshotHash === undefined) throw new NoConversationHere(`task '${taskId}' has never run`);
    const bundle = bundleFor(project, task.snapshotHash, task.snapshotHash);
    if (bundle === undefined) throw this.refusal("run", `the snapshot for task ${taskId} is missing`);

    const { events, atMs } = eventsOf(project.events.list(taskId));
    const tree = projectRun(events, undefined, atMs);
    const found = AppService.findInstance(tree.instances, instanceId);
    // Ordinary rather than a fault: the renderer holds an instance id from a projection main may
    // have re-read since, so a selection that is one refresh stale lands here routinely.
    if (found === undefined) throw new NoConversationHere(`task ${taskId} has no instance ${instanceId}`);

    // Nearest first: the clicked instance, then its ancestors.
    const path = found.path.map((node) => bundle.states[node.stateId]);
    // The HOST — the nearest instance on that path that actually holds a conversation.
    //
    // Resolved with `holdsConversation`, the same predicate `chatPlanFor` picks its SETTINGS with,
    // because the two answers have to be about one state. Reading the settings from one instance and
    // the position from another is not a near miss: it is a plan for one conversation and a position
    // in a different one, and the position lookup then simply finds nothing.
    //
    // A CHAT child is skipped rather than matched. It is recorded under its host's state id, so it
    // passes `holdsConversation` on the state alone — and a reader who clicks the reply they are
    // already looking at would then mount a second conversation INSIDE the first, at iteration 0,
    // under `2_000_000 + n`. A chat child IS a conversation; it does not host one. Addressing it
    // means continuing it, which is its host's turn to take.
    const hostAt = found.path.findIndex(
      (node) => !isChatInstance(node.instanceId) && holdsConversation(bundle.states[node.stateId]),
    );
    if (hostAt === -1) {
      // The honest answer for a COMPOSITE. It orchestrates and says nothing, so it has no session and
      // no position; and its ancestors are composites too, since a state that speaks has no children
      // to be an ancestor OF. Its panel shows its children's transcripts, and which of three
      // conversations a message belongs to is not a question this can answer on the reader's behalf.
      throw new NoConversationHere(
        `instance ${instanceId} is not part of any conversation — no state on its path runs a prompt`,
      );
    }
    const host = found.path[hostAt]!;
    const chatId = chatInstanceIdOf(host.instanceId);
    const chat = host.children.find((c: InstanceNode) => c.instanceId === chatId);
    return {
      bundle,
      hostInstanceId: host.instanceId,
      stateId: host.stateId,
      // From the host outward. `chatPlanFor` would find the same state in the longer list, but the
      // states BELOW the host are not ancestors of the conversation and have no business in it.
      path: path.slice(hostAt),
      position: (() => {
        if (branchAt === undefined) return this.chatPositionOf(taskId, host.instanceId, projectKey);
        // The handle came from `chat:thread`, which read this task's chain — but it may have been on
        // screen a while, and a position that names nothing here must not be written into. Checked
        // against the TASK-SCOPED store, which is the boundary that matters: a ref only resolves in
        // it if this task's records are what it names. Not checked against the current session id —
        // every edit forks a new branch, so turns before an earlier edit legitimately carry the id
        // the conversation had then.
        const store = sessionStoreFor(project, { taskId });
        const seq = Number(branchAt.slice(branchAt.lastIndexOf("@") + 1));
        if (!Number.isInteger(seq) || store.at(sessionOf(branchAt), seq) === undefined) {
          throw new NoConversationHere(`'${branchAt}' is not a message in this conversation`);
        }
        return branchAt;
      })(),
      // The loop's next turn. `iteration` counts transitions taken, so a child that has answered
      // twice is at 1 and the message about to be sent is 2.
      index: chat === undefined ? 0 : chat.index + 1,
    };
  }

  /**
   * Where the displayed conversation currently ends.
   *
   * The chat child's own last turn when it has one, the host's otherwise — a reply continues what is
   * on screen, and after the first exchange what is on screen ends with the reply rather than with
   * the state that started it. `seq + 1` because a row names the position a call was AT and the next
   * call goes after it, which is the same arithmetic `withSessionPosition` reports back.
   *
   * Takes the HOST's id, never the clicked one: a composite has no row here at all, which is what
   * `chatContextOf` resolves before it calls this.
   */
  private chatPositionOf(taskId: string, hostInstanceId: string, projectKey?: string): string {
    const history = this.sessionHistory({ taskId, project: projectKey });
    const mine = [...history]
      .reverse()
      .find((h) => h.instanceId === chatInstanceIdOf(hostInstanceId) || h.instanceId === hostInstanceId);
    if (mine === undefined) {
      throw new NoConversationHere(
        `instance ${hostInstanceId} ran no model call, so there is no conversation to continue`,
      );
    }
    return `${mine.sessionId}@${mine.seq + 1}`;
  }

  /**
   * A task's conversation, WHOLE — every turn of the chain in order, forks walked.
   *
   * `sessionView` is the other reading and stays the right one for a run: it answers what ONE state
   * added to the conversation it was handed, which is what a transcript beside a board is asking. A
   * chat asks the opposite question. Its conversation is a chain of records — the run's own call,
   * then one per message — and reading them as separate views gives a stack of panels each showing
   * one exchange, which is a filing cabinet rather than a conversation.
   *
   * So this walks the chain the store already knows how to walk (`transcript`, which follows a fork
   * into its parent) and folds each record's OWN messages onto the end. Two things fall out of that
   * for free: an edited message shows its branch and not the one it replaced, because the chain from
   * the newest position runs through the fork; and the boundaries between records are exactly the
   * points a message can be replaced AT, which is what `points` reports.
   */
  chatThread(request: { taskId: string; project?: string }): ChatThreadView | null {
    const open = this.session(request.project);
    const project = open.project;
    const host = this.chatHostOf(request.taskId, request.project);
    if (host === null) return null;
    let context;
    try {
      context = this.chatContextOf(request.taskId, host, request.project);
    } catch (e) {
      // Same rule as `chatPlan`: "there is no conversation here" is an answer this channel is
      // supposed to give, and only a broken installation is an error.
      if (e instanceof NoConversationHere) return null;
      throw e;
    }
    const store = sessionStoreFor(project, { taskId: request.taskId });
    const rows = store.transcript(context.position);
    /**
     * Where each record's TURN begins in the journal — what a cut takes (see `cut.ts`).
     *
     * A chat turn is a transition on the chat instance (the first is its entry), and the record it
     * dispatched is named by the settle that follows. So the journal is walked once: each instance's
     * newest turn start is remembered, and a settle stamps its record with it.
     */
    const turnStarts = new Map<string, number>();
    const seqOfRecord = new Map<string, number>();
    /** By SEAT, for a chat turn: its settle names no record, only the position the call ended at. */
    const seqOfSeat = new Map<string, number>();
    for (const row of project.events.list(request.taskId)) {
      if (row.instanceId === undefined) continue;
      if (row.type === "instance.entered" || row.type === "transition.taken") turnStarts.set(row.instanceId, row.seq);
      if (row.type !== "operation.dispatched" && row.type !== "operation.completed" && row.type !== "operation.failed") continue;
      const start = turnStarts.get(row.instanceId);
      if (start === undefined) continue;
      if (row.operationId !== undefined && !seqOfRecord.has(row.operationId)) seqOfRecord.set(row.operationId, start);
      const ended = parseSessionRef((row.event as { metrics?: { sessionRef?: string } }).metrics?.sessionRef ?? "");
      // The record sits one back from where its call ended — `stateSessions` makes the same reading.
      if (ended !== undefined && !seqOfSeat.has(`${ended.id}@${ended.seq - 1}`)) seqOfSeat.set(`${ended.id}@${ended.seq - 1}`, start);
    }
    const origin = (() => {
      const row = project.runtime.get(request.taskId);
      return row === undefined ? undefined : taskOriginOf(project, row);
    })();

    const turns: SessionTurn[] = [];
    const points: ChatEditPoint[] = [];
    const sidechains: Record<string, SessionTurn[]> = {};
    const providerEvents: Array<{ index: number; event: JsonValue }> = [];
    const native: Array<{ index: number; line: JsonValue }> = [];
    const outputs: SessionOutput[] = [];
    /** Per branch: the turn its own rows begin at, so a fork can be reported as a turn index. */
    const begins = new Map<string, number>();
    for (const [i, row] of rows.entries()) {
      const at = turns.length;
      if (!begins.has(row.sessionId)) begins.set(row.sessionId, at);
      // Concatenated, not subtracted. A record holds the messages its call contributed — the store's
      // own `materialize` adds records up exactly this way to build the history a provider is
      // replayed, and a reader that disagreed with it would be describing a different conversation
      // from the one the model is having.
      const said = turnsSaidBy(row);
      turns.push(...said);
      // The run's own call is not a message somebody typed — editing it means running the task
      // again with different inputs, which is a different verb in a different place.
      if (i > 0) {
        const seq = seqOfRecord.get(row.recordId) ?? seqOfSeat.get(`${row.sessionId}@${row.seq}`);
        points.push({ turn: at, at: `${sessionOf(context.position)}@${row.seq}`, ...(seq !== undefined ? { seq } : {}) });
      }
      // A TURN index is record-relative, so it shifts onto the thread by where that record started —
      // the same arithmetic the two index families below do. A call id needs no shifting: it is the
      // provider's own id and is unique across the whole thread, which is why it is not a position.
      const output = structuredOutputOf(row, said);
      if (output !== undefined) outputs.push(output.turn !== undefined ? { ...output, turn: output.turn + at } : output);
      for (const [call, chain] of Object.entries(sidechainsOf(row.value) ?? {})) sidechains[call] = chain;
      // Both index families count TURNS within their own record, so they are shifted onto the thread
      // by where that record started.
      for (const event of recordEventsOf(row.value) ?? []) {
        providerEvents.push({ index: event.index + at, event: event.event });
      }
      for (const line of nativeOf(row.value) ?? []) native.push({ index: line.index + at, line: line.line });
    }

    const session: SessionView = {
      taskId: request.taskId,
      instanceId: host,
      stateId: context.stateId,
      sessionId: sessionOf(context.position),
      seq: rows.length,
      turns,
      ...(Object.keys(sidechains).length > 0 ? { sidechains } : {}),
      ...(providerEvents.length > 0 ? { providerEvents } : {}),
      ...(native.length > 0 ? { native } : {}),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(turns.length === 0 ? { empty: "this conversation has not said anything yet" } : {}),
    };
    /**
     * The places this conversation SPLIT, folded into turns the same way the thread was.
     *
     * A replaced message branches rather than deletes, and the branch left behind is intact in the
     * record and on no path anybody reads — so an edit looked like a deletion, and there was nothing
     * on screen to say otherwise or to read the other side with. The seam is reported as a TURN index
     * because that is the only coordinate the renderer has; the store's own `at` is a position, which
     * nothing above this line is allowed to parse.
     *
     * A branch whose start we cannot place is dropped rather than guessed at: a split drawn between
     * the wrong two turns is a worse statement than no split at all.
     */
    const forks: ChatFork[] = [];
    for (const fork of store.forks(context.position)) {
      const begin = begins.get(fork.taken);
      if (begin === undefined) continue;
      const left: ChatBranch[] = [];
      for (const branch of fork.left) {
        const said = branch.rows.flatMap((row) => turnsSaidBy(row));
        if (said.length > 0) left.push({ sessionId: branch.sessionId, turns: said });
      }
      if (left.length > 0) forks.push({ turn: begin, left });
    }
    return {
      taskId: request.taskId,
      instanceId: host,
      session,
      points,
      ...(forks.length > 0 ? { forks } : {}),
      ...(origin !== undefined ? { origin } : {}),
    };
  }

  /**
   * Delete everything past a point in a task's journal and carry on from there ("task:rewind").
   *
   * The deletion is `cut.ts`'s; what this adds is the boundary a service owns. A running task is
   * refused — here, and by the same test `deleteTask` makes for a run driven by another process —
   * and a question parked on the task is dismissed, because it was asked by a state that no longer
   * ran. Then the ordinary resume: the truncated journal loads exactly as a crash does, and the
   * machine picks up at the cut.
   */
  async rewindTask(request: {
    taskId: string;
    at: number;
    project?: string;
    interactions?: Record<string, JsonValue[]>;
    fake?: JsonValue;
  }): Promise<{ taskId: string }> {
    const session = this.session(request.project);
    const { taskId } = request;
    if (session.live.has(taskId) || session.project.jobs.liveRunJob(taskId, Date.now()) !== undefined) {
      throw this.refusal("run", `task '${taskId}' is running — stop it before rewinding it`);
    }
    const before = session.project.runtime.get(taskId);
    if (before === undefined) throw this.refusal("run", `unknown task '${taskId}'`);
    // The parked question, if any, goes with the state that asked it — dismissed, not answered.
    for (const [requestId, owner] of session.requestTask) {
      if (owner === taskId) session.hub.reject(requestId, "the task was rewound to before this question");
    }
    session.questions.dismissFor(taskId);
    const cut = cutTaskJournal(session.project, taskId, request.at);
    this.log({
      level: "info",
      source: "run",
      message: `rewound ${taskId} to before event ${request.at}: ${cut.events} event(s) and ${cut.records} record(s) deleted`,
      project: session.key,
      taskId,
    });
    this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
    // Only a machine with something left to do is resumed. A cut inside the turns typed AFTER a run
    // finished — the chat case — leaves the machine exactly as it ended, and a resume of that
    // would be a run that does nothing; the task goes back to standing as it did.
    const plan = this.resumable(taskId, request.project);
    if (plan.frontier.length === 0) {
      if (before.outcome !== undefined) session.project.runtime.endTask(taskId, before.outcome, Date.now());
      session.project.runtime.setStatus(taskId, before.status, Date.now());
      this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
      return { taskId };
    }
    return this.resumeTask({
      taskId,
      ...(request.project !== undefined ? { project: request.project } : {}),
      ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
      ...(request.fake !== undefined ? { fake: request.fake } : {}),
    });
  }

  /**
   * A second task that shares everything up to a point ("task:fork") — see `cut.ts`.
   *
   * A run fork resumes at once: there is nothing to type, and the fork's first act is the
   * machine's. A chat fork (with a message) stands as its parent does and takes the message as its
   * next turn — sent, not awaited, so the caller gets the new conversation to open while the turn
   * is answered into it, exactly as a `chat:send` into an open conversation is watched.
   */
  async forkTask(request: {
    taskId: string;
    at: number;
    message?: string;
    overrides?: ChatSettings;
    project?: string;
    interactions?: Record<string, JsonValue[]>;
    fake?: JsonValue;
  }): Promise<{ taskId: string }> {
    const session = this.session(request.project);
    const { taskId } = request;
    if (session.live.has(taskId) || session.project.jobs.liveRunJob(taskId, Date.now()) !== undefined) {
      throw this.refusal("run", `task '${taskId}' is running — stop it before forking it`);
    }
    const message = request.message?.trim();
    const fork = copyTaskPrefix(session.project, taskId, request.at, { standing: message !== undefined && message !== "" ? "asIs" : "startable" });
    this.log({
      level: "info",
      source: "run",
      message: `forked ${taskId} before event ${request.at} as ${fork.taskId}`,
      project: session.key,
      taskId: fork.taskId,
    });
    this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
    if (message === undefined || message === "") {
      return this.resumeTask({
        taskId: fork.taskId,
        ...(request.project !== undefined ? { project: request.project } : {}),
        ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
        ...(request.fake !== undefined ? { fake: request.fake } : {}),
      });
    }
    const host = this.chatHostOf(fork.taskId, request.project);
    if (host === null) throw this.refusal("run", `the fork of '${taskId}' holds no conversation to continue`);
    void this.sendChatMessage({
      taskId: fork.taskId,
      instanceId: host,
      message,
      ...(request.overrides !== undefined ? { overrides: request.overrides } : {}),
      ...(request.project !== undefined ? { project: request.project } : {}),
      ...(request.fake !== undefined ? { fake: request.fake } : {}),
    }).catch((e: unknown) => {
      this.log({
        level: "error",
        source: "run",
        message: `the fork's first message failed: ${e instanceof Error ? e.message : String(e)}`,
        project: session.key,
        taskId: fork.taskId,
      });
    });
    return { taskId: fork.taskId };
  }

  /**
   * Which instance a task's conversation belongs to — the one a message continues.
   *
   * Read off the session history rather than walked out of the instance tree: a state that SPOKE is
   * one that wrote a record, and that is the same fact the history is a list of. The FIRST such
   * instance, because a conversation's own first record is the run's, and everything after it is a
   * turn of that same conversation. Chat children are skipped — they are the conversation, not its
   * host, which is the distinction `chatContextOf` also draws.
   */
  private chatHostOf(taskId: string, projectKey?: string): string | null {
    const history = this.sessionHistory({ taskId, project: projectKey });
    const host = history.find((h) => !isChatInstance(h.instanceId));
    return host?.instanceId ?? null;
  }

  /** Cancel a task: abort a live run here, or record a terminal status. */
  cancelTask(taskId: string, project?: string): { taskId: string } {
    return this.cancelTaskIn(this.session(project), taskId);
  }

  /**
   * Resume the tasks the last close left waiting on a person, so they are waiting on them again.
   *
   * Closing the app is not an answer. A run parked on a gate or a drag was unwound by the close —
   * the process ends, so it had to be — but the question it was asking is still the question, and
   * the person opening the app again expects to find it where they left it, not a canceled task
   * and a Resume button to work out. Only the row the close itself marked qualifies — `canceled`
   * with {@link SUSPENDED_WAITING} as its reason, which the run-end handler writes for a run whose
   * task was on either hub when the session closed.
   *
   * A CRASH is deliberately not this. Recovery marks a dead process's tasks `interrupted`, and even
   * one with a gate still parked in `pending_interactions` is left for the strip's Resume: nobody
   * decided to stop it, so nobody has said what its record is worth, and the row is offered rather
   * than re-run. A resume that cannot be made (unreadable records, a legacy journal) is logged and
   * left for the strip the same way.
   */
  private async resumeSuspended(session: ProjectSession): Promise<void> {
    const project = session.project;
    const candidates = project.runtime
      .list()
      .filter((row) => row.status === "canceled" && reasonOf(row.failureJson) === SUSPENDED_WAITING);
    for (const row of candidates) {
      // A session already on its way out — `closeSession` deletes it before awaiting this — must
      // not have a run started under it.
      if (this.closed || this.sessions.get(session.key) !== session) return;
      try {
        await this.resumeTask({ taskId: row.taskId, project: project.paths.projectDir });
        this.log({ level: "info", source: "run", message: `resumed ${row.taskId}: it was waiting on you when the app closed`, project: session.key, taskId: row.taskId });
      } catch (e) {
        this.log({
          level: "warn",
          source: "run",
          message: `could not resume ${row.taskId}, which was waiting on you when the app closed: ${(e as Error).message}`,
          project: session.key,
          taskId: row.taskId,
          ...stackDetail(e),
        });
      }
    }
  }

  /**
   * Pick a stopped task up where it left off, rather than starting it over ("task:resume").
   *
   * The machine is LOADED, not re-walked (Identity and Resume §04): the journal joined to the
   * record store describes the stopped run — the tree, the inputs, everything each operation
   * returned — and the engine constructs its instances from that description, keeping every
   * recorded id. Nothing already answered runs again or is journaled again; only the active leaves
   * dispatch, and a cut call's re-dispatch computes the same scoped record id and REOPENS its own
   * record rather than asking twice.
   *
   * Two shapes reach this, and the strip names them differently because what they mean differs:
   *
   *  - `interrupted` — the process died, or a stop unwound the tree, with work still to do. The
   *    frontier's calls are re-made into their own records; nothing behind them is.
   *  - `failed` — a state failed and nothing handled it. The fold presents that state live again,
   *    which is a retry of it with all its history intact — and per §05 the failed call's record,
   *    having consumed nothing remotely, was deleted so the identity and the seat are simply free.
   *
   * Refused when the description could not be read in full: an operation missing its answer is one
   * the engine would DISPATCH, and for a state that already wrote a file that is a double-apply
   * nobody asked for. Better to say so and let the caller start over deliberately.
   */
  async resumeTask(request: StartRunRequest): Promise<{ taskId: string }> {
    const open = this.session(request.project);
    const taskId = request.taskId;
    const at = { project: open.key, taskId };
    const row = open.project.runtime.get(taskId);
    if (row === undefined) throw this.refusal("run", `cannot resume unknown task '${taskId}'`, at);
    if (row.status === "running") throw this.refusal("run", `task '${taskId}' is already running`, at);
    if (!isStartableStatus(row.status)) {
      throw this.refusal("run", `task '${taskId}' is ${row.status} and cannot be resumed — run it again instead`, at);
    }
    if (row.snapshotHash === undefined) {
      throw this.refusal("run", `task '${taskId}' has no pinned snapshot to resume against — run it instead`, at);
    }
    // §05, before the fold reads the store: a failed call that consumed no provider sequence never
    // happened remotely, so its record is deleted and the identity and seat are free again. A cut
    // call's record is deliberately NOT touched — it may be the only witness to turns already in
    // the remote stream, and the re-dispatch continues into it.
    releaseUnconsumedFailures(open.project, taskId);
    const bundle = loadPinnedBundle(open.project, row);
    const load = buildTaskLoad(open.project, taskId, bundle.states);
    if (load.blocked !== undefined || load.loaded === undefined) {
      throw this.refusal("run", `task '${taskId}' cannot be resumed: ${load.blocked ?? "nothing was recorded"}`, at);
    }
    if (load.unreadable.length > 0) {
      const first = load.unreadable[0]!;
      throw this.refusal(
        "run",
        `task '${taskId}' cannot be resumed: ${load.unreadable.length} operation(s) have no readable record ` +
          `(first: ${first.stateId} — ${first.reason}). Running it again would repeat them.`,
        {
          ...at,
          // The whole list, because one example names the symptom and the set is what someone would
          // need to work out whether the history is holed in one place or everywhere.
          detail: load.unreadable.map((entry) => ({ stateId: entry.stateId, reason: entry.reason })),
        },
      );
    }
    // The failure the retry revives is deleted with the record it already freed (§05): the journal
    // said the chain ended in error, the retry says it is live again, and every reader of the journal
    // — the conversation's notes, the run causes — was drawing the old ending beside the new run.
    releaseRevivedFailures(open.project, load);
    // What a resume actually IS, written down before it happens: how much is being taken from the
    // record and where the spending starts again. Without this a resumed run is indistinguishable in
    // the log from an ordinary one, and the interesting number — what it did NOT re-run — is the one
    // nothing else reports.
    const frontier = load.frontier.map((entry) => entry.stateId);
    this.log({
      level: "info",
      source: "run",
      message: `resuming ${taskId}: ${load.loadedOps} operation(s) loaded, ${
        frontier.length > 0 ? `re-entering ${frontier.join(", ")}` : "nothing left in flight"
      }`,
      project: open.key,
      taskId,
    });
    return this.startRun(open, taskId, {
      config: open.project.config,
      secrets: this.secretResolver(open),
      loaded: load.loaded,
      answers: load.answers,
      ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
      ...(request.fake !== undefined ? { fake: request.fake } : {}),
    });
  }

  /**
   * Runs waiting on a TASK to end — a parent's hosted fan-out waiting on the tasks it made
   * (decision 0003). Keyed by project and task; settled by the run-end handler, which is the one
   * place a row becomes terminal in this process.
   */
  private readonly taskWaiters = new Map<string, Set<(row: TaskRuntimeRow) => void>>();

  private waiterKey(open: ProjectSession, taskId: string): string {
    return `${open.key}\u0000${taskId}`;
  }

  /**
   * Resolves when `taskId`'s row is terminal — at once if it already is — or when `signal` fires,
   * with the row as it then stands. A task that ends in another process is not seen here; the
   * parent's own resume asks again, from the rows, and reads the answer off the store.
   */
  private waitForTask(open: ProjectSession, taskId: string, signal: AbortSignal): Promise<TaskRuntimeRow> {
    const now = open.project.runtime.get(taskId);
    if (now === undefined) return Promise.reject(new Error(`unknown task '${taskId}'`));
    if (isTerminalStatus(now.status) || signal.aborted) return Promise.resolve(now);
    return new Promise((resolve) => {
      const key = this.waiterKey(open, taskId);
      const waiter = (row: TaskRuntimeRow): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(row);
      };
      const onAbort = (): void => {
        this.taskWaiters.get(key)?.delete(waiter);
        resolve(open.project.runtime.get(taskId) ?? now);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let set = this.taskWaiters.get(key);
      if (set === undefined) this.taskWaiters.set(key, (set = new Set()));
      set.add(waiter);
    });
  }

  private settleWaiters(open: ProjectSession, taskId: string): void {
    const key = this.waiterKey(open, taskId);
    const set = this.taskWaiters.get(key);
    if (set === undefined) return;
    this.taskWaiters.delete(key);
    const row = open.project.runtime.get(taskId);
    if (row === undefined) return;
    for (const waiter of set) waiter(row);
  }

  /**
   * Start a task a hosted fan-out made — fresh where it has no history (a mount task), resumed
   * where it has (a split copy, standing at its mount). Both land in `startRun`; the difference is
   * whether the machine is walked or loaded, and the journal is what says which.
   */
  private async startMadeTask(open: ProjectSession, taskId: string, options: { bundle?: WorkflowBundle; fake?: JsonValue | FakeRule[] }): Promise<void> {
    if (hasJournalHistory(open.project, taskId)) {
      await this.resumeTask({ taskId, project: open.dir, ...(options.fake !== undefined ? { fake: options.fake as JsonValue } : {}) });
      return;
    }
    await this.startRun(open, taskId, {
      config: open.project.config,
      secrets: this.secretResolver(open),
      ...(options.bundle !== undefined ? { bundle: options.bundle } : {}),
      ...(options.fake !== undefined ? { fake: options.fake } : {}),
    });
  }

  /**
   * A task completed: every task that was holding for it and now holds for nothing is started — a
   * split copy standing queued, or a task interrupted while it held (a split's own task holds
   * in-process while it runs, and after a crash holds by its row like a copy). A copy whose wire said
   * `start: "manual"` is left to a person; absent reads as the default, `when_ready`.
   */
  private releaseDependents(open: ProjectSession, completed: string): void {
    for (const meta of open.project.tasks.list()) {
      if (!(meta.dependsOn ?? []).includes(completed)) continue;
      if (meta.origin?.kind === "split" && meta.origin.start === "manual") continue;
      const row = open.project.runtime.get(meta.id);
      if (row === undefined || (row.status !== "queued" && row.status !== "interrupted") || holdingOf(open.project, meta).length > 0) continue;
      // The completed task's scripted answers, if it had any, script what it releases — the same
      // rule a parent applies to what it makes, so a fake run stays fake to its last dependent.
      const fake = open.fakeRules.get(completed);
      void this.startMadeTask(open, meta.id, fake !== undefined ? { fake } : {}).catch((e: unknown) => {
        this.log({ level: "error", source: "run", message: `could not start '${meta.title}' once '${completed}' completed: ${(e as Error).message}`, project: open.key, taskId: meta.id });
      });
    }
  }

  /**
   * What resuming this task would do, for a caller that has to say so before doing it ("task:resumable").
   *
   * The renderer needs this to choose a verb: a task with a frontier is one to CONTINUE, and one
   * without is one whose failed state gets another go. Both are the same machinery; the words are
   * not, and a button that says the wrong one is worse than no button.
   */
  resumable(taskId: string, project?: string): ResumePlan {
    const open = this.session(project);
    const row = open.project.runtime.get(taskId);
    if (row === undefined || !isStartableStatus(row.status)) {
      // Nothing to offer: a finished task cannot re-enter its own lifecycle at all, so what it gets
      // is a copy. Deliberately not `fresh` — `fresh` is a promise that a plain start will work.
      return { taskId, kind: "none", replayed: 0, frontier: [] };
    }
    // A task that has said nothing simply STARTS — no snapshot pinned yet, or a start that died
    // before the engine journaled anything. Asked with `hasJournalHistory`, which is the predicate
    // `beginTaskRun`'s own guard refuses on, so the button and the lifecycle cannot disagree.
    if (row.snapshotHash === undefined || !hasJournalHistory(open.project, taskId)) {
      return { taskId, kind: "fresh", replayed: 0, frontier: [] };
    }
    const bundle = loadPinnedBundle(open.project, row);
    const load = buildTaskLoad(open.project, taskId, bundle.states);
    if (load.blocked !== undefined || load.loaded === undefined) {
      return { taskId, kind: "none", replayed: 0, frontier: [], ...(load.blocked !== undefined ? { blocked: load.blocked } : {}) };
    }
    if (load.unreadable.length > 0) {
      return { taskId, kind: "none", replayed: 0, frontier: [], blocked: load.unreadable[0]!.reason };
    }
    return {
      taskId,
      // The fold says WHY each leaf is still to do: an `interrupted` one — a crash or a stop caught
      // it — is somewhere to CONTINUE, and a task whose every live leaf is a revived failure has
      // nothing in flight at all; what is left is the state that ended it, which is a retry.
      kind: load.frontier.some((entry) => entry.cause === "interrupted") ? "continue" : "retry",
      replayed: load.loadedOps,
      frontier: load.frontier.map((entry) => ({ stateId: entry.stateId, stopped: entry.stopped })),
    };
  }

  /**
   * Run a task's work AGAIN, as a new task ("task:rerun").
   *
   * A re-run creates a new state machine instance with the same inputs (Identity and Resume §05):
   * new task id, new sessions, linked to its predecessor by `parentTaskId`. It is not a
   * continuation and does not pretend to be one — that is {@link resumeTask}, which loads the
   * SAME machine. Minting unconditionally is what keeps a task one machine: restarting in place
   * would grow a second tree in one journal, which is exactly the shape the runs collapse retired.
   */
  async rerunTask(request: StartRunRequest): Promise<{ taskId: string }> {
    const open = this.session(request.project);
    const row = open.project.runtime.get(request.taskId);
    if (row === undefined) throw this.refusal("run", `unknown task '${request.taskId}'`);
    if (row.status === "running") throw this.refusal("run", `task '${request.taskId}' is already running`);
    const meta = open.project.tasks.read(request.taskId);
    const copy = createTask(open.project, {
      title: meta.title,
      workflow: meta.workflow,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.labels !== undefined ? { labels: meta.labels } : {}),
      ...(meta.inputs !== undefined ? { inputs: meta.inputs } : {}),
      ...(meta.branch !== undefined ? { branch: meta.branch } : {}),
      // The predecessor, not its parent: the chain reads newest → oldest.
      parentTaskId: request.taskId,
    });
    this.publishFor(open, { type: "store:invalidate", scope: "tasks" });
    return this.startTask({ ...request, taskId: copy.id });
  }

  /**
   * Delete a task outright ("task:delete") — its rows, its file, and its worktree.
   *
   * Refused while the task runs anywhere: a live run in this process holds an engine over the
   * journal being deleted, and one in another process is found the same way cancel finds it, by the
   * job table's heartbeat. The worktree goes FIRST and with `force` — the renderer has already asked
   * the human, and this is the one caller for whom "uncommitted work" is not a reason to stop — so a
   * failure to remove it leaves the task intact and reportable rather than rows gone and a worktree
   * orphaned.
   */
  async deleteTask(taskId: string, project?: string): Promise<{ taskId: string }> {
    const session = this.session(project);
    if (session.live.has(taskId) || session.project.jobs.liveRunJob(taskId, Date.now()) !== undefined) {
      throw this.refusal("run", `task '${taskId}' is running — cancel it before deleting it`);
    }
    if (session.project.runtime.get(taskId)?.worktreePath !== undefined) {
      const result = await removeWorktree(session.project, taskId, { force: true });
      if (!result.removed) throw this.refusal("run", `could not remove the task's worktree: ${result.reason}`);
    }
    deleteTask(session.project, taskId);
    this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
    // Both projections: the lists, and the board whose column the card just left.
    this.publishFor(session, { type: "store:invalidate", scope: "board" });
    return { taskId };
  }

  /**
   * One instance and the ancestors above it, nearest first.
   *
   * The path is what lets a composite continue under the nearest state that actually holds a
   * conversation — see `chatPlanFor`. Built by walking down and remembering the way, because the
   * projection's nodes carry `parentInstanceId` but the tree is only navigable downward.
   */
  private static findInstance(
    roots: readonly InstanceNode[],
    instanceId: string,
    above: InstanceNode[] = [],
  ): { node: InstanceNode; path: InstanceNode[] } | undefined {
    for (const node of roots) {
      if (node.instanceId === instanceId) return { node, path: [node, ...above] };
      const found = AppService.findInstance(node.children, instanceId, [node, ...above]);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * The same, in a named session.
   *
   * Split out because a sync is a task in JaiRA's OWN project, so cancelling one must reach a session
   * that is deliberately never the focused one.
   */
  private cancelTaskIn(session: ProjectSession, taskId: string): { taskId: string } {
    const run = session.live.get(taskId);
    if (run) {
      // Fail any gate this task is parked on, or the abort would never be observed.
      for (const [requestId, owner] of session.requestTask) {
        if (owner === taskId) session.hub.reject(requestId, "the task was canceled");
      }
      // SHUT THE GATE, rather than only answering what happens to be waiting at it.
      //
      // A parked approval blocks the agent's tool loop just as hard as a gate does, and denying it
      // was enough to unblock the loop — after which the agent asked for the next tool and the
      // question came straight back. Held shut, the agent finishes the tool it is inside, asks for
      // the next, is refused, and winds down on its own: the cheapest boundary a stop has, and the
      // only one that works for a transport with no interrupt at all.
      session.approvals.stop(taskId);
      // And so does a parked question — dismissed, not errored: nobody is going to answer it.
      session.questions.dismissFor(taskId);
      // A stopped task waits on nothing from the forge either. (A SHUTDOWN is different and leaves the
      // rows awaited — the question is still open; this is a person saying stop.)
      session.project.remotes.stopAwaiting(taskId);
      // SAY SO, for the interval between the decision and the end of the stream.
      //
      // The task used to jump to `canceled` here, while output was visibly still arriving — the panel
      // reported a run that had ended and the transcript beside it kept growing. `stopping` is that
      // interval, and the run settling is what ends it: the ordinary finish path writes `canceled`
      // when the stream actually stops, so nothing else has to know this state exists.
      session.project.runtime.setStatus(taskId, "stopping", Date.now());
      this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
      // What it had said by now, written down while its record is still open to take it.
      session.liveFlush.get(taskId)?.();
      run.abort.abort();
    } else if (session.project.jobs.liveRunJob(taskId, Date.now()) !== undefined) {
      // Another process is driving it. Raise the flag its heartbeat polls — cross-
      // process cancel needs no socket, unlike answering a parked gate (§4.2a).
      session.project.jobs.requestCancel(taskId, Date.now());
    } else {
      // Nothing is running HERE, so there is no park to reject — but a gate an earlier process left
      // behind is still on offer, and saying stop is a decision about it. See `InteractionStore`:
      // the row survives a process, not a person saying no.
      //
      // Outside the `cancelable` guard, deliberately. A task that quit while parked is already
      // `canceled` — so the status transition is a no-op and the offer would be the only thing left,
      // which is a question about a task the person has just said they are done with.
      session.project.interactions.clearTask(taskId);
      // The same for the forge: a cancelled task waits on nothing, so its requests stop being polled.
      // The merge request itself is left as it is — closing it is the workflow's or the person's to do.
      session.project.remotes.stopAwaiting(taskId);
      if (this.cancelable(session, taskId)) {
        cancelTask(session.project, taskId);
        this.publishFor(session, { type: "store:invalidate", scope: "tasks" });
      }
    }
    return { taskId };
  }

  /**
   * Is there anything left to cancel — or has this task already stopped on its own?
   *
   * A cancel arriving from the UI is a REQUEST, and `cancelTask` is a state TRANSITION; the gap
   * between those two is a race nobody can close. The button is rendered from a snapshot, and a task
   * that fails between the render and the click is still showing one. Pressing it then threw
   * `task 't-…' is already failed` out of the IPC handler and into the main process log — an
   * unhandled error for a user who asked for a thing to not be running, about a thing that was not
   * running.
   *
   * So the request is IDEMPOTENT here, where it is a request. `cancelTask` keeps its refusal, and
   * the CLI keeps getting it: `jaira cancel` on a finished task is someone stating something untrue
   * about a task they named, and telling them is the useful answer. An unknown task still throws on
   * both paths — that one is not a race, it is a wrong id.
   */
  private cancelable(session: ProjectSession, taskId: string): boolean {
    const row = session.project.runtime.get(taskId);
    if (row === undefined) throw this.refusal("run", `unknown task '${taskId}'`);
    return !isTerminalStatus(row.status);
  }

  // --- interaction -----------------------------------------------------------

  /** Approvals awaiting a human (DESIGN §10.2). */
  pendingApprovals(): PendingApproval[] {
    // Every session's, not the focused one's: an approval names its own request id, and a run in
    // another project parked on a tool call is still waiting for the same person.
    return [...this.sessions.values()].flatMap((s) => s.approvals.list().map((r) => pendingApprovalOf(r, s.dir)));
  }

  /**
   * Answer a parked approval. `scope` is how long the answer applies — the reason
   * a user is not asked the same question on every tool call.
   */
  submitApproval(requestId: string, decision: "allow" | "deny", scope: ApprovalScope = "once"): { requestId: string } {
    // Routed by OWNER rather than to the focused project. A request id is all the renderer sends, and
    // answering it against the wrong session would deny a call nobody asked about while the one that
    // is actually parked waits forever.
    const owner = this.sessions.get(this.requestOwner.get(requestId) ?? "");
    if (owner === undefined || !owner.approvals.decide(requestId, decision, scope)) {
      throw this.refusal("run", `no pending approval '${requestId}'`);
    }
    return { requestId };
  }

  /** Mid-run questions awaiting the person — `AskUserQuestion`, parked by a running agent. */
  pendingQuestions(): PendingQuestion[] {
    return [...this.sessions.values()].flatMap((s) => s.questions.list().map((r) => pendingQuestionOf(r, s.dir)));
  }

  /**
   * Answer a parked question — or dismiss it (`answers` absent), which tells the agent to use its
   * own judgment and continue. Routed by owner, exactly as approvals are.
   */
  submitQuestion(requestId: string, answers?: Record<string, string | string[]>): { requestId: string } {
    const owner = this.sessions.get(this.requestOwner.get(requestId) ?? "");
    if (owner === undefined || !owner.questions.answer(requestId, answers)) {
      throw this.refusal("run", `no pending question '${requestId}'`);
    }
    return { requestId };
  }

  /**
   * Transitions waiting on a gesture, across every open project — what makes a card draggable.
   *
   * Every session's, not the focused one's: a board can be looking at any project, and a wait that
   * did not travel with the list would be a card that silently refused to be picked up.
   */
  pendingUserEvents(): PendingUserEvent[] {
    return [...this.sessions.entries()].flatMap(([key, s]) =>
      s.userEvents.list().map((request) => ({ ...request, project: this.refOf(key) })),
    );
  }

  /**
   * The gesture happened.
   *
   * `delivered: false` rather than a throw for an id nobody is holding, because that is a race and not
   * a mistake: a card can be dropped a moment after its run moved on, and the honest answer is that
   * there was nothing there to tell. Routed by OWNER, exactly as the other three channels are.
   */
  deliverUserEvent(requestId: string): { requestId: string; delivered: boolean } {
    const owner = this.sessions.get(this.requestOwner.get(requestId) ?? "");
    return { requestId, delivered: owner?.userEvents.deliver(requestId) ?? false };
  }

  /**
   * A person MOVED a task to a state — `task_move`, published (decision 0005 §3–§5).
   *
   * One publication, three ways it lands, tried in this order:
   *
   *  1. **A transition is already waiting on exactly this** — `on_user_event('task_move' | 'task_drag',
   *     { to_state })` for this task. It gets its answer, and the workflow's own rule moves the task
   *     (the engine holds a standing rule's answer until the running state ends). Not tried for a
   *     `skip`, which means NOW, or for a move aimed below the root, which no board wait names.
   *  2. **The task is running here** — the move is handed to its engine as a DIRECTED transition:
   *     journaled `transition.taken` with who asked, held until the running state ends unless it
   *     says `skip`, and what it steps over recorded `skipped`.
   *  3. **The task is not running** — it is REOPENED to take it: loaded, like a resume, with the move
   *     waiting on the port for the instance it names. A `completed` task is reopened under its own
   *     id, which no other path may do; a stopped or failed one steps past the state it stopped in
   *     (`skip`), because nothing is running there to wait for.
   *
   * A move that cannot be made — an unknown task, a state the target is not a child of, a task
   * another process is running — is refused with the reason, before anything is started.
   */
  async moveTask(request: TaskMoveRequest): Promise<TaskMoveResult> {
    const open = this.session(request.project);
    const taskId = request.taskId;
    const at = { project: open.key, taskId };
    const row = open.project.runtime.get(taskId);
    if (row === undefined) throw this.refusal("run", `cannot move unknown task '${taskId}'`, at);
    const move: DirectedTransition = {
      to: request.toState,
      by: request.by ?? "person",
      ...(request.instanceId !== undefined ? { instanceId: request.instanceId } : {}),
      ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
      ...(request.skip === true ? { skip: true } : {}),
    };

    const live = open.live.get(taskId);
    if (live !== undefined) {
      if (move.skip !== true && move.instanceId === undefined && open.userEvents.answerMove(taskId, move.to) !== undefined) {
        this.log({ level: "info", source: "run", message: `moved ${taskId} to '${move.to}': a transition was waiting on it`, ...at });
        return { taskId, status: "answered" };
      }
      const outcome = live.directed.direct(move);
      if (outcome.status === "refused") throw this.refusal("run", `cannot move task '${taskId}' to '${move.to}': ${outcome.reason}`, at);
      // `queued` is a run whose engine has not attached yet, or has just let go: the port keeps the
      // move, a starting engine claims it, and the run-end handler reopens for one left behind.
      const status = outcome.status === "taking" ? "taking" : "held";
      this.log({ level: "info", source: "run", message: `moved ${taskId} to '${move.to}' (${move.by}${move.skip === true ? ", skip" : ""}): ${status}`, ...at });
      return { taskId, status };
    }

    if (row.status === "running" || row.status === "stopping") {
      throw this.refusal("run", `task '${taskId}' is ${row.status} in another process — move it there`, at);
    }
    if (row.snapshotHash === undefined) {
      throw this.refusal("run", `task '${taskId}' has never run, so it stands nowhere to be moved from — start it instead`, at);
    }
    releaseUnconsumedFailures(open.project, taskId);
    const bundle = loadPinnedBundle(open.project, row);
    const load = buildTaskLoad(open.project, taskId, bundle.states);
    if (load.blocked !== undefined || load.loaded === undefined) {
      throw this.refusal("run", `task '${taskId}' cannot be moved: ${load.blocked ?? "nothing was recorded"}`, at);
    }
    if (load.unreadable.length > 0) {
      const first = load.unreadable[0]!;
      throw this.refusal(
        "run",
        `task '${taskId}' cannot be moved: ${load.unreadable.length} operation(s) have no readable record ` +
          `(first: ${first.stateId} — ${first.reason}). Reopening it would repeat them.`,
        at,
      );
    }
    // The target is checked against the PINNED definition before anything starts: the engine drops a
    // queued move naming no child, and a task reopened for nothing would just finish again.
    const find = (node: LoadedInstance, id: string): LoadedInstance | undefined =>
      node.id === id ? node : (node.children ?? []).map((child) => find(child, id)).find((hit) => hit !== undefined);
    const owner = move.instanceId === undefined ? load.loaded : find(load.loaded, move.instanceId);
    if (owner === undefined) throw this.refusal("run", `cannot move task '${taskId}': it has no instance '${move.instanceId}'`, at);
    if (bundle.states[owner.stateId]?.children?.[move.to] === undefined) {
      throw this.refusal("run", `cannot move task '${taskId}' to '${move.to}': it is not a state of '${owner.stateId}'`, at);
    }
    // Nothing is running in a task that is not running, so there is nothing to wait out: a state
    // the task stopped or failed in is stepped past, not continued first.
    const port = new DirectedTransitions();
    port.direct(row.status === "completed" ? move : { ...move, skip: true });
    this.log({ level: "info", source: "run", message: `reopening ${taskId} (${row.status}) to move it to '${move.to}' (${move.by})`, ...at });
    await this.startRun(open, taskId, {
      config: open.project.config,
      secrets: this.secretResolver(open),
      loaded: load.loaded,
      answers: load.answers,
      directed: port,
      reopen: true,
    });
    return { taskId, status: "reopened" };
  }

  /**
   * The live turn a task is streaming right now — everything `session:turn` has carried for the
   * call in flight, re-readable by a viewer that navigated away and back. `null` ⇒ nothing is
   * streaming, which after the record lands is the ordinary answer.
   */
  sessionLive(request: { taskId: string; project?: string }): LiveTurnSnapshot | null {
    return this.session(request.project).liveTurns.snapshot(request.taskId);
  }

  /**
   * Every gate awaiting a person — the live ones and the ones an earlier process left behind.
   *
   * The two are one list on purpose. From where somebody is sitting there is no difference between
   * a question whose run is blocked on it and a question whose run died holding it: both are things
   * being asked of them, in the same conversation, and both are answered the same way. What differs
   * is what answering DOES, and that is `resumes` on the row rather than a second channel.
   *
   * The live park wins when a request id is both — which is the moment a resumed run re-reaches its
   * gate, before the row is deleted.
   */
  pendingInteractions(): PendingInteraction[] {
    const live = [...this.sessions.values()].flatMap((s) => s.hub.list().map((request) => this.pendingOf(request)));
    const seen = new Set(live.map((p) => p.requestId));
    const stored = [...this.sessions.entries()].flatMap(([key, s]) =>
      this.storedInteractionsOf(key, s).filter((row) => !seen.has(row.requestId)),
    );
    return [...live, ...stored];
  }

  /**
   * One session's recovered gates — the rows whose run is NOT in flight here.
   *
   * A row for a task this process is currently running is filtered out rather than shown: that run
   * either still holds the park (in which case it is in `hub.list()` and is the live copy) or has
   * moved past it and the row is about to go. Offering both would put two copies of one question in
   * front of the person.
   */
  private storedInteractionsOf(key: string, session: ProjectSession): PendingInteraction[] {
    return session.project.interactions
      .list()
      .filter((row) => !session.live.has(row.taskId))
      .map((row) => this.pendingOfStored(key, row));
  }

  /**
   * Answer a parked interaction.
   *
   * The submitted value is re-validated against the component's contract here, in
   * the main process (DESIGN §7.1). The renderer is the untrusted half of the
   * boundary, so an undeclared decision or a missing required field is refused
   * before it can become a workflow output — the engine's own output-schema check
   * is a second, independent gate.
   *
   * Two things can be on the other end. A LIVE park is an engine waiting on this promise, and
   * submitting hands it over. A RECOVERED one has no engine at all: the process that parked it is
   * gone, so the answer is seeded on the hub and the task is resumed — it replays what it already
   * did, re-reaches the state it stopped in, and takes the seeded answer without asking again. From
   * the renderer both are `interaction:submit` with a value, which is the point.
   */
  submitInteraction(requestId: string, value: JsonValue): { requestId: string } {
    const contract = this.configOf(requestId);
    if (contract) {
      const check = validateComponentResult(contract.config, value, contract.inputs);
      if (!check.ok) throw this.refusal("run", `invalid ${contract.config.component} response: ${check.errors}`);
    }
    const owner = this.sessions.get(this.requestOwner.get(requestId) ?? "");
    // A multi-part chooser's answer is EVERY round's answers, and the loop's own bookkeeping stays
    // out of what the engine gets — see `followUp.ts`. Whether a round follows is the STATE's
    // `follow_up`, never the person's; a chooser without it is the plain case: its own answers,
    // merged with nothing.
    let settled = value;
    if (contract !== undefined && contract.config.component === "choose_option" && contract.config.questions !== undefined) {
      const answers = mergedAnswers(contract.inputs, value);
      if (owner !== undefined && wantsFollowUp(contract.config) && owner.hub.list().some((r) => r.requestId === requestId)) {
        this.followUp(owner, requestId, contract.config, contract.inputs, answers);
        return { requestId };
      }
      // A RECOVERED gate has no live park to hold, so a follow-up state's answer settles as it is:
      // the loop needs a run to re-park on, and the resumed run gets these answers seeded.
      settled = settledFollowUp(answers);
    }
    if (owner !== undefined && owner.hub.submit(requestId, settled)) return { requestId };
    return this.answerRecoveredInteraction(requestId, settled);
  }

  /**
   * The follow-up round of a multi-part chooser — the loop `choose_option`'s `follow_up: true` runs.
   *
   * The person answered a state that asks for follow-ups. The park is HELD (off the screen, its row
   * closed, the engine still waiting), a model is asked whether the answers opened anything only a
   * person can settle, and the same call is then either parked again with those questions — a new
   * request, a new row, the same promise — or settled with every round's answers. A model that
   * fails, or a loop that has been round `MAX_FOLLOW_UP_ROUNDS` times, settles too: a follow-up is
   * a courtesy, and the answers already given are never lost to it.
   */
  private followUp(
    open: ProjectSession,
    requestId: string,
    config: ChooseOptionConfig,
    inputs: Record<string, JsonValue>,
    answers: Record<string, JsonValue>,
  ): void {
    const held = open.hub.hold(requestId);
    if (held === undefined) return;
    const taskId = held.taskId ?? "";
    const settle = (): void => {
      open.hub.release(requestId, settledFollowUp(answers));
    };
    if (roundOf(inputs) >= MAX_FOLLOW_UP_ROUNDS) {
      settle();
      return;
    }
    void this.askFollowUp(open, taskId, config, inputs, answers).then(
      (questions) => {
        if (questions.length === 0) {
          settle();
          return;
        }
        open.hub.repark(requestId, nextRoundInputs(config, inputs, answers, questions));
      },
      (e: unknown) => {
        this.log({
          level: "warn",
          source: "run",
          message: `follow-up questions could not be asked; the answers given stand: ${(e as Error).message}`,
          project: open.key,
          ...(taskId !== "" ? { taskId } : {}),
          ...stackDetail(e),
        });
        settle();
      },
    );
  }

  /**
   * One model call, outside any run: does this round of answers open more questions?
   *
   * The DEFAULT executor, built the way every UI-initiated call is (`defaultTree`) and under the
   * task's scripted rules when it has them, so a headless test of the loop answers from its script.
   * A bare call: no session, no tools, no gate — a question about some answers, with the state's
   * other inputs as context, needs none of them.
   */
  private async askFollowUp(
    open: ProjectSession,
    taskId: string,
    config: ChooseOptionConfig,
    inputs: Record<string, JsonValue>,
    answers: Record<string, JsonValue>,
  ): Promise<ChoiceQuestion[]> {
    const project = open.project.config;
    const fakeRules = open.fakeRules.get(taskId);
    const fake = fakeRules !== undefined;
    const secrets = this.secretResolver(open);
    const prompt = buildPromptExecutor({
      ...(fakeRules !== undefined ? { fakeRules } : {}),
      ...this.promptWiring(project, { fake, secrets }),
      tree: this.defaultTree(project, { rootId: "follow_up", states: {} }, fake, secrets, false).prompt,
    });
    const op = followUpOperation(config, inputs, answers);
    const result = await prompt.start(op, followUpServices()).result;
    if ("error" in result) throw new Error(result.error.reason);
    return followUpQuestionsOf(result.value as JsonValue | undefined, askedSoFar(config, inputs));
  }

  /**
   * Answer a gate whose run is no longer in this process — see {@link submitInteraction}.
   *
   * The row goes FIRST, inside the same call that starts the resume, because the resumed run parks
   * a fresh request the moment it gets there and a stale row beside it is two questions where there
   * is one. If the resume then refuses — a task somebody deleted, a snapshot that will not load —
   * the seed is dropped with it, so nothing is left holding an answer for a run that never comes.
   */
  private answerRecoveredInteraction(requestId: string, value: JsonValue): { requestId: string } {
    const found = this.findStoredInteraction(requestId);
    if (found === undefined) throw this.refusal("run", `no pending interaction '${requestId}'`);
    const { session, row } = found;
    session.hub.seed(row.taskId, row.component, value);
    session.project.interactions.close(requestId);
    this.publish({ type: "interaction:resolved", requestId });
    void this.resumeTask({ taskId: row.taskId, project: session.dir }).catch((e: unknown) => {
      session.hub.unseed(row.taskId);
      this.log({
        level: "error",
        source: "run",
        message: `answering ${row.component} could not continue ${row.taskId}: ${(e as Error).message}`,
        project: session.key,
        taskId: row.taskId,
        ...stackDetail(e),
      });
    });
    return { requestId };
  }

  /** Which session is holding a stored gate, and the row itself. */
  private findStoredInteraction(requestId: string): { session: ProjectSession; row: StoredInteraction } | undefined {
    for (const session of this.sessions.values()) {
      const row = session.project.interactions.get(requestId);
      if (row !== undefined) return { session, row };
    }
    return undefined;
  }

  // --- settings --------------------------------------------------------------

  /**
   * User preferences (theme). Readable with NO project open — they belong to the person, not to a
   * checkout, which is why they live in the shared root rather than in `.jaira/settings.json`.
   */
  readSettings(): JairaSettings {
    return readSettingsFile(this.baseDir);
  }

  /**
   * Merge a partial change into the settings file and return the whole result.
   *
   * ONE level deep, which is what the `ui` slice has to be written whole for: a patch carrying only
   * `panes` would replace the folds and the tree state with nothing. That is the renderer's rule to
   * keep (it holds the live copy, so sending all of it costs it nothing), and a deep merge here
   * would be worse than the rule — it would leave no way to REMOVE a remembered pane at all.
   */
  writeSettings(patch: Partial<JairaSettings>): JairaSettings {
    const next: JairaSettings = { ...this.readSettings(), ...patch };
    const file = jairaBasePaths(this.baseDir).userSettingsFile;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    // The one setting with an effect outside this file: what the app keeps in its log. Re-installed
    // here rather than watched, so a change made in the Logs page governs the very next entry —
    // which is the only behaviour that makes turning a scope down while it floods you useful.
    if (patch.logging !== undefined) this.applyLogPolicy();
    return next;
  }

  // --- configuration ---------------------------------------------------------

  /**
   * Both configuration layers as authored, plus the merged result a run would use.
   *
   * `project` is WHICH project's layer to show. The layer switch became the crumb (SHELL.md §2.2):
   * at the root there is no project layer to edit and Settings edits `base` only, which is exactly
   * the rule the no-project case already stated.
   */
  readConfig(project?: string): ConfigView {
    const base = jairaBasePaths(this.baseDir);
    const projectFile = this.sessionOf(project)?.project.paths.settingsFile;
    const baseDoc = readJsonIfPresent(base.settingsFile);
    const projectDoc = projectFile !== undefined ? readJsonIfPresent(projectFile) : null;
    return {
      base: baseDoc,
      project: projectDoc,
      // Parsed, so the UI shows defaults filled in rather than the sparse document — "what will
      // actually happen" is the question this pane exists to answer.
      //
      // `?? {}` is load-bearing: with NEITHER layer holding a `settings.json` the merge is undefined,
      // and parsing that threw "config must be a JSON object" — so the one state where a person has
      // configured nothing yet was the state where the settings screen could not be read at all.
      // Two absent layers mean the built-in defaults, which is what an empty document parses to.
      effective: parseConfig(
        mergeConfigDocuments(baseDoc ?? undefined, projectDoc ?? undefined) ?? {},
      ) as unknown as JsonValue,
      baseFile: base.settingsFile,
      projectFile: projectFile ?? "",
      baseDir: base.baseDir,
    };
  }

  /**
   * Replace one layer's `settings.json`.
   *
   * Validated BEFORE writing, and validated as it will actually be read — the project layer is
   * checked merged over the base, because a project document that is only valid on its own would
   * still break every run. Writing an unloadable config would leave the app unable to open the
   * project it was just configured with, which is the one failure a settings screen must not cause.
   */
  writeConfig(request: WriteConfigRequest): ConfigView {
    this.forges.clear();
    const base = jairaBasePaths(this.baseDir);
    // Before validating, not after: a document reported field by field and THEN refused for having
    // nowhere to go tells the author to fix the wrong thing. The base layer is always writable —
    // it is the machine's, and `initBase` creates it — so only the project layer can fail here.
    if (request.layer !== "base" && this.sessionOf(request.project) === undefined) {
      throw this.refusal("config", 
        request.project === undefined
          ? "no project was named, so there is no project config to write"
          : `project '${request.project}' is not open`,
      );
    }
    const current = this.readConfig(request.project);
    const merged =
      request.layer === "base"
        ? mergeConfigDocuments(request.config, current.project ?? undefined)
        : mergeConfigDocuments(current.base ?? undefined, request.config);
    parseConfig(merged ?? {}); // throws with the offending field named
    let file: string;
    if (request.layer === "base") {
      initBase(base.baseDir);
      file = base.settingsFile;
    } else {
      file = this.p(request.project).paths.settingsFile;
    }
    writeFileSync(file, `${JSON.stringify(request.config, null, 2)}\n`, "utf8");
    // The open project holds a PARSED copy, and everything downstream of this write reads that copy
    // rather than the file: the executor inventory, the probes, and the registry a run is built
    // from. Re-layering it here is what makes a settings change take effect now instead of at the
    // next reopen — the settings screen would otherwise answer a save by re-reporting the old
    // configuration, which reads as a write that did not happen.
    for (const open of this.sessions.values()) open.project.config = loadLayeredConfig(open.project.paths);
    this.publish({ type: "store:invalidate", scope: "config" });
    this.publish({ type: "store:invalidate", scope: "workflows" });
    // The write may have named a credential, moved a server, or turned a route on. Whatever the
    // settings screen was showing about availability described the configuration BEFORE this, so it
    // is re-observed rather than left to be corrected by hand.
    if (this.options.probeOnStart === true) this.kickAvailability();
    return this.readConfig(request.project);
  }

  // --- executors -------------------------------------------------------------

  /**
   * Health-check the provider routes (DESIGN §8.3) — without calling one.
   *
   * The counterpart of {@link AppService.probeExecutors}, and it follows the same rule for the same
   * reason: a check must never start a generation. What it reports is whether a key resolves, whether
   * a local server ANSWERS, and whether the weights a route names are on disk — everything that can
   * be observed for nothing, and nothing that costs money.
   */
  async probeModelRoutes(): Promise<ProbeResult[]> {
    return probeModelRoutes(this.effectiveConfig().models, { secrets: this.secretResolver() });
  }

  /**
   * What can answer a prompt here, as last observed.
   *
   * The CACHED snapshot, deliberately: this is what a settings screen reads when it opens, and a read
   * that re-ran the checks would make opening the screen the slow thing that pressing a button used
   * to be. {@link AppService.refreshAvailability} is what makes the cache current, and it runs by
   * itself — at startup, at project open, and after every configuration write.
   */
  readAvailability(): AvailabilitySnapshot {
    return this.availability;
  }

  /**
   * Re-observe everything, and remember it.
   *
   * This is the answer to "why did I have to press Test?": the checks that decide whether a provider
   * or an executor can be used are the same checks that decide what a run picks by default, so they
   * belong to the app's startup rather than to a button. Cheap ones (an environment variable, a file
   * on disk) are nearly free; the two that are not (a socket to a local server, `--version` on a
   * binary) are bounded and run concurrently.
   *
   * Concurrent with itself only once: a second call while one is in flight does not start a second
   * round of connects. It does not JOIN the first either, and that distinction is the whole of a bug
   * this had:
   *
   * The reason to ask again is almost always that the INPUTS changed — a project opened, a
   * credential was written — and a pass that started before the change cannot answer a question
   * about what came after it. Joining meant inheriting a stale answer. Which is what happened at
   * every startup: the constructor probes with no project open, so the secret chain has no project
   * `.env.local` and every remote route reports "no key"; the project then opens, kicks a refresh
   * exactly because "a project brings its own config layer" — and that refresh joined the
   * project-less pass already in flight and adopted its verdict. Settings opened showing `anthropic`
   * and `openrouter` as not working, and pressing Recheck "fixed" it: by then nothing was in flight,
   * so the button got the fresh pass that project-open should have had.
   *
   * So a request that arrives mid-pass is promised a FOLLOW-UP pass instead, and gets that one's
   * answer. Coalesced to one follow-up however many arrive, and re-armed if more arrive during it.
   */
  async refreshAvailability(): Promise<AvailabilitySnapshot> {
    if (this.availabilityRun !== undefined) {
      // `catch` rather than `then`: a pass that THREW must still be followed by the one that was
      // asked for, or one failed socket connect strands every later request behind it forever.
      this.availabilityAgain ??= this.availabilityRun.catch(() => undefined).then(() => {
        this.availabilityAgain = undefined;
        return this.refreshAvailability();
      });
      return this.availabilityAgain;
    }
    const run = this.computeAvailability().finally(() => {
      this.availabilityRun = undefined;
    });
    this.availabilityRun = run;
    return run;
  }

  private async computeAvailability(): Promise<AvailabilitySnapshot> {
    const config = this.effectiveConfig();
    const secrets = this.secretResolver();
    const [routes, executors, forges] = await Promise.all([
      probeModelRoutes(config.models, { secrets }),
      this.probeExecutors(),
      // A connection with no token stored makes no request, so an install that uses no forge pays
      // nothing here; one that does is asked who its token is, which is the whole of the check.
      checkForges(config.integrations, {
        secrets,
        ...(this.options.forgeHttp !== undefined ? { http: this.options.forgeHttp } : {}),
      }),
    ]);
    // What the DEFAULT executor's tree resolves to, derived from both halves and only here: an
    // executor whose binary is missing is not a route, which is the difference between "it routes to
    // claude-cli" and "it routes to claude-cli and the run then fails to start it".
    const available = new Set(executors.filter((p) => p.status === "ok").map((p) => p.name));
    const tree = resolveExecutorTree(config.executors[DEFAULT_EXECUTOR], {
      providers: usableRouteKeys(config.models, secrets),
      agents: Object.keys(agentPromptRouteNames(config.agents)).filter((name) => available.has(name)),
      // Whose models each agent answers for, so the settings screen shows the same routing the run
      // will do — a bare `claude-sonnet-5` resolving to `claude-cli` is a property of the tree.
      vendors: agentRouteVendors(config.agents),
    });
    this.availability = { routes, executors, forges, tree, checkedAt: Date.now() };
    this.publish({ type: "store:invalidate", scope: "availability" });
    return this.availability;
  }

  /**
   * The default executor's tree, resolved for this configuration and this machine.
   *
   * One place, so every UI-initiated operation — starting a task, proposing workflow changes,
   * summarizing a conversation — gets the SAME executor. They used to build their own from the same
   * ingredients, which is a coincidence rather than a guarantee.
   */
  private defaultTree(
    config: JairaConfigOf,
    bundle: WorkflowBundle,
    fake: boolean,
    secrets: SecretResolver = this.secretResolver(),
    /**
     * Whether an unservable prompt should REFUSE, which only a caller about to run one wants.
     *
     * The readers below build this tree to render it — which routes exist, what fills a call the
     * composer has not overridden. They must not inherit a start-time refusal: a workflow naming a
     * model this machine cannot reach is a run that will not start, and it should say so when
     * somebody starts it, not by leaving the chat panel unable to describe itself.
     */
    refuse = true,
  ): JairaOperationNode {
    const available = this.availableExecutors();
    return defaultExecutorTree(config, bundle, {
      fake,
      secrets,
      refuse,
      ...(available !== undefined ? { available } : {}),
    });
  }

  /**
   * The executors a check has shown to work, or `undefined` when none has run yet.
   *
   * `undefined` rather than an empty set, and the difference is the whole contract: an empty set says
   * "nothing works here" and would refuse every run, where "no check has run" must stay optimistic —
   * the same rule {@link AppService.stateViewOptions} follows for the same reason.
   */
  private availableExecutors(): ReadonlySet<string> | undefined {
    if (this.availability.checkedAt === 0) return undefined;
    return new Set(this.availability.executors.filter((p) => p.status === "ok").map((p) => p.name));
  }

  /**
   * Start a refresh without waiting for it.
   *
   * The callers are lifecycle points — construction, project open, a config write — and none of them
   * should be held up by a socket timeout. The result reaches the UI through the invalidate the
   * refresh publishes when it lands, which is the same path every other background change takes.
   */
  private kickAvailability(): void {
    void this.refreshAvailability().catch(() => {
      // A failed refresh leaves the previous snapshot in place. It is a health check: it must never
      // be the reason the app fails to start.
    });
  }

  /** Every executor this project could use, enabled or not (DESIGN §8.1). */
  listExecutors(): ExecutorInfo[] {
    return listExecutors(this.effectiveConfig().agents);
  }

  /**
   * Health-check executors without running them.
   *
   * Each probe is a `--version` call: the one invocation these binaries all support, that exits
   * immediately, and that cannot be talked into doing work. Pressing "Test" must not start a
   * session or spend money.
   */
  async probeExecutors(name?: string): Promise<ProbeResult[]> {
    const config = this.effectiveConfig();
    const wanted = listExecutors(config.agents).filter((info) => name === undefined || info.name === name);
    if (name !== undefined && wanted.length === 0) throw this.refusal("config", `unknown executor '${name}'`);
    const exec = new NodeExec({ execEnv: config.execEnvironment });
    const secrets = this.secretResolver();
    const results = await Promise.all(
      wanted.map((info) =>
        probeExecutor(info, { exec, execEnv: config.execEnvironment, secrets }),
      ),
    );
    // Remembered so a state view can say "this executor is not available" without probing again.
    // A workflow whose executor just came back to life should stop showing an error, so this is a
    // reason to re-lint the authoring surface.
    for (const result of results) this.lastProbes.set(result.name, result);
    this.publish({ type: "store:invalidate", scope: "workflows" });
    return results;
  }

  // --- secrets ---------------------------------------------------------------

  /** What the secret store can do here — the keychain needs Electron and an OS that provides one. */
  secretCapabilities(): SecretCapabilities {
    const keychain = this.options.keychain;
    const available = keychain?.available() === true;
    return {
      keychain: available,
      ...(available || keychain?.reason === undefined ? {} : { keychainReason: keychain.reason }),
    };
  }

  /**
   * Ask whether a task may publish (decision 0004 §1: publishing is a policy decision).
   *
   * Through `confirm_action`, parked on the hub like any gate — so it renders in the conversation of
   * the state that is asking, is written down, and survives the app closing. What it shows is what
   * will be SENT and AS WHOM, because "push?" cannot be answered without either.
   */
  private async askToPublish(open: ProjectSession, taskId: string, request: PublishRequest): Promise<PublishAnswer> {
    const forge = FORGE_LABELS[request.provider];
    const result = await open.hub.ask(
      "confirm_action",
      {
        prompt: `Push this review to ${forge.name} and open a ${forge.request}?`,
        confirmLabel: "Push and open",
        cancelLabel: "Review here only",
        details: [
          { label: "to", value: request.to },
          { label: "branch", value: `${request.branch} → ${request.target}` },
          { label: "commits as", value: request.commitsAs },
          ...(request.openedBy !== undefined ? [{ label: "request opened by", value: `${request.openedBy} (the ${forge.name} connection's token)` }] : []),
        ],
        options: [{ value: "always", label: "Always for this project", description: "sets policy.remote.publish to allow in this project's settings" }],
      },
      taskId,
    );
    // A rejected park is a shutdown or a cancel, never a yes.
    if ("error" in result && result.error !== undefined) return "no";
    const value = ((result as { value?: unknown }).value ?? {}) as { confirmed?: unknown; choice?: unknown };
    if (value.confirmed !== true) return "no";
    return value.choice === "always" ? "always" : "once";
  }

  /**
   * "Always for this project": write `policy.remote.publish = "allow"` into the project's own layer.
   *
   * The project layer and never the shared root — the person was asked about THIS project. A write
   * that fails is logged and swallowed: the push they just approved must not fail because a settings
   * file could not be rewritten, and the cost is only being asked once more.
   */
  private grantPublish(open: ProjectSession): void {
    try {
      const layer = open.kind === "shared" ? "base" : "project";
      const view = this.readConfig(open.key);
      const doc = structuredClone(((layer === "base" ? view.base : view.project) ?? {}) as Record<string, unknown>);
      const policy = (doc["policy"] ??= {}) as Record<string, unknown>;
      policy["remote"] = { ...((policy["remote"] ?? {}) as object), publish: "allow" };
      this.writeConfig({ layer, project: open.key, config: doc as JsonValue });
    } catch (e) {
      this.log({ level: "warn", source: "runtime", message: `could not record the publish grant: ${(e as Error).message}`, project: open.key });
    }
  }

  /**
   * Store (or clear) a credential.
   *
   * An empty value REMOVES it, which is how a key is revoked without hunting for the file. Only the
   * three machine-local targets can be written: JaiRA will not put a secret in a project's
   * committed `.env`, and it cannot set a variable in someone else's shell.
   */
  setSecret(request: SetSecretRequest): { name: string; target: SecretTargetOf } {
    // A provider holds the token it was built with; a new one must not keep answering as the old.
    this.forges.clear();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(request.name)) {
      throw this.refusal("config", `'${request.name}' is not a usable secret name`);
    }
    if (request.target === "keychain") {
      const keychain = this.options.keychain;
      if (keychain?.available() !== true) {
        throw this.refusal("config", this.secretCapabilities().keychainReason ?? "no encrypted store is available here");
      }
      if (request.value.length === 0) keychain.remove(request.name);
      else keychain.set(request.name, request.value);
      return { name: request.name, target: request.target };
    }
    // The project's `.jaira/.env.local`, which is the FIRST project link of the chain (DESIGN §8.1)
    // and the one `jaira init` gitignores. It used to be the repository root's, which still works —
    // it is link four — but writing a secret to a file JaiRA does not ignore, when there is one it
    // does, is the wrong default to hand somebody who just typed a key into a form.
    const file =
      request.target === "base-env-local"
        ? join(jairaBasePaths(this.baseDir).baseDir, ".env.local")
        : join(this.requireProjectDir(request.project), JAIRA_DIR_NAME, ".env.local");
    writeEnvEntry(file, request.name, request.value);
    return { name: request.name, target: request.target };
  }

  // --- workflow authoring ----------------------------------------------------

  /** One state file as text, from a named layer. A file that does not exist yet reads as empty. */
  readWorkflow(request: ReadWorkflowRequest): WorkflowSource {
    const file = this.workflowFile(request.stateId, request.layer, request.project);
    const exists = existsSync(file);
    return {
      stateId: request.stateId,
      layer: request.layer,
      file,
      text: exists ? readFileSync(file, "utf8") : "",
      exists,
    };
  }

  /**
   * Write one state file.
   *
   * Parsed first: an unparsable state file breaks the browser for every workflow in the layer, and
   * refusing here is far better than writing it and reporting the damage afterwards. Deeper
   * validation is deliberately NOT done — a half-written workflow must be saveable, and the lint
   * surface already reports what is wrong with it.
   */
  writeWorkflow(request: WriteWorkflowRequest): WorkflowSource {
    this.writable(request.layer);
    try {
      JSON.parse(request.text);
    } catch (e) {
      throw this.refusal("file", `not valid JSON: ${(e as Error).message}`);
    }
    const file = this.workflowFile(request.stateId, request.layer, request.project);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, request.text.endsWith("\n") ? request.text : `${request.text}\n`, "utf8");
    this.publish({ type: "store:invalidate", scope: "workflows" });
    this.noteSyncWrite(request.layer, `workflows/${request.stateId}.json`);
    return { stateId: request.stateId, layer: request.layer, file, text: request.text, exists: true };
  }

  /**
   * Rename a state, duplicate it, or copy it into the other layer.
   *
   * All three go through {@link workflowFile} at BOTH ends, so the containment check that protects
   * the write surface protects the destination too — a copy is a write, and `../../.ssh/config` is
   * as good a destination as it is a source.
   *
   * A rename that changes the id breaks every state naming the old one, so it is refused by default
   * and reports who. Duplicating and overriding break nothing and are never refused.
   */
  moveWorkflow(request: MoveWorkflowRequest): WorkflowMutationResult {
    // The destination always; the source only when it would be REMOVED. Copying out of the built-in
    // layer is the override itself (decision 0006) — the one thing this surface must keep allowing.
    this.writable(request.toLayer);
    if (request.copy !== true) this.writable(request.layer);
    const from = this.workflowFile(request.stateId, request.layer, request.project);
    const to = this.workflowFile(request.to, request.toLayer, request.project);
    if (!existsSync(from)) throw this.refusal("file", `'${request.stateId}' does not exist in the ${request.layer} layer`);
    if (from === to) throw this.refusal("file", "the source and destination are the same file");
    if (existsSync(to)) throw this.refusal("file", `'${request.to}' already exists in the ${request.toLayer} layer`);

    const renaming = request.copy !== true && request.to !== request.stateId;
    const referencedBy = renaming ? this.referrersOf(request.stateId, request.project) : [];
    if (referencedBy.length > 0 && request.force !== true) {
      return { stateId: request.stateId, layer: request.layer, applied: false, referencedBy };
    }

    mkdirSync(dirname(to), { recursive: true });
    if (request.copy === true) copyFileSync(from, to);
    else renameSync(from, to);
    this.publish({ type: "store:invalidate", scope: "workflows" });
    return { stateId: request.to, layer: request.toLayer, applied: true, referencedBy };
  }

  /**
   * Delete a state file.
   *
   * Refused while anything still declares it as a child, because the result would be a workflow that
   * fails to load rather than one with a gap. `force` is the deliberate override, and the refusal
   * names the referrers so there is something to act on.
   */
  deleteWorkflow(request: { stateId: string; layer: WorkflowLayer; force?: boolean; project?: string }): WorkflowMutationResult {
    this.writable(request.layer);
    const file = this.workflowFile(request.stateId, request.layer, request.project);
    if (!existsSync(file)) throw this.refusal("file", `'${request.stateId}' does not exist in the ${request.layer} layer`);
    const referencedBy = this.referrersOf(request.stateId, request.project);
    if (referencedBy.length > 0 && request.force !== true) {
      return { stateId: request.stateId, layer: request.layer, applied: false, referencedBy };
    }
    rmSync(file);
    this.publish({ type: "store:invalidate", scope: "workflows" });
    return { stateId: request.stateId, layer: request.layer, applied: true, referencedBy };
  }

  /**
   * Check a hand-edited document against a registered schema.
   *
   * Uses ajv directly rather than `@declarative-ai/validate`'s `SchemaValidator`, and the reason is
   * the shape of the answer rather than the checking. That wrapper collapses a failure to one joined
   * string (`errorsText`) because its consumer is an error artifact — one message, written once. This
   * surface needs the opposite: one row per violation, each carrying the path it is about, so the
   * editor can list them and say *where*. Taking `fn.errors` apart is what produces that, and there
   * is no way to recover it from the joined string.
   *
   * Everything else the wrapper offers — `$ref` resolution against a content-addressed store, lazy
   * registration — is machinery for schemas this surface does not have. These are static,
   * self-contained documents built at import time.
   */
  validateSchema(request: ValidateSchemaRequest): ValidateSchemaResult {
    const entry = schemaById(request.schemaId);
    if (!entry) throw this.refusal("config", `no schema named '${request.schemaId}'`);

    let value: unknown;
    try {
      value = JSON.parse(request.text);
    } catch (e) {
      // The parse error IS the answer while it stands: schema errors against a half-typed document
      // would all be noise about the part that has not been written yet.
      return { schemaId: entry.id, parseError: (e as Error).message, violations: [] };
    }

    const validate = this.schemaValidator(entry.id, entry.document);
    if (validate(value)) return { schemaId: entry.id, violations: [] };
    return { schemaId: entry.id, violations: collapseErrors(validate.errors ?? []) };
  }

  /**
   * Check the values a form holds against the schemas the form was drawn from.
   *
   * The configuration is the RUN's, deliberately and exactly: `@declarative-ai/validate`'s
   * `SchemaValidator` is `new Ajv({ allErrors: true, strict: false })`, and so is this. What differs is
   * only the shape of the answer — that wrapper joins every error into one string for an error
   * artifact, and a form needs them apart, each with the path it is about. Same keywords, same
   * verdicts: a form cannot refuse a value the run would take, or take one it would refuse.
   *
   * A schema that will not compile is reported rather than thrown. The run WOULD throw on it, so it is
   * a real problem worth showing, but one broken slot must not stop the others from being checked.
   */
  checkValues(request: SchemaCheckRequest): SchemaCheckResponse {
    return {
      results: request.checks.map(({ key, schema, value }) => {
        // `true` and `{}` constrain nothing — the run skips them without compiling anything either.
        if (schema === true || (schema !== null && typeof schema === "object" && !Array.isArray(schema) && Object.keys(schema).length === 0)) {
          return { key, ok: true, errors: [] };
        }
        let validate: ValidateFunction;
        try {
          validate = this.valueValidator(schema);
        } catch (e) {
          return { key, ok: false, errors: [], compileError: (e as Error).message };
        }
        if (validate(value)) return { key, ok: true, errors: [] };
        const errors: SchemaCheckError[] = (validate.errors ?? []).map((error) => ({
          instancePath: error.instancePath,
          schemaPath: error.schemaPath,
          keyword: error.keyword,
          params: JSON.parse(JSON.stringify(error.params ?? {})) as SchemaCheckError["params"],
          ...(error.message !== undefined ? { message: error.message } : {}),
        }));
        return { key, ok: false, errors };
      }),
    };
  }

  /** Compiled, keyed by the schema's text. A form re-checks on every pause in typing, and compiling is the slow half. */
  private valueValidator(schema: unknown): ValidateFunction {
    const id = JSON.stringify(schema);
    const cached = this.valueValidators.get(id);
    if (cached) return cached;
    // Bounded by starting over: a long session opens many states, and a registry that only grows would
    // also keep every `$id` it has ever seen reserved.
    if (this.valueValidators.size > 500 || this.valueAjv === undefined) {
      this.valueValidators.clear();
      this.valueAjv = new Ajv({ allErrors: true, strict: false });
    }
    const compiled = this.valueAjv.compile(schema as object);
    this.valueValidators.set(id, compiled);
    return compiled;
  }

  /**
   * Which registered schema a document already satisfies (DESIGN §11.1).
   *
   * The picker used to be a menu you had to know the answer to — open a `.json` file and it sat on
   * "none — plain JSON" whether or not the file was obviously a state. This answers it from the
   * document.
   *
   * Validating is NOT enough on its own, and assuming it was is the trap here. Two of the three
   * schemas are `additionalProperties: false`, so satisfying one really does mean "carries no key
   * this kind does not have" — but `prompt-operation` deliberately is not: hw passes any field it
   * does not own straight into the call config ("the operation IS the call"), so the schema has to
   * admit knobs it has never heard of. Which means a `package.json` validates against it cleanly.
   *
   * So a match also has to be POSITIVE: every top-level key the document carries must be one the
   * schema declares. That is the same question `additionalProperties: false` asks, asked here
   * instead of being delegated to a keyword one schema cannot afford to set.
   *
   * Ties are broken by SPECIFICITY, not registration order. A state whose operation is a prompt
   * satisfies both `state` and `state-prompt`; the second says more about the same file, so it wins.
   * `expected` is the measure — the keys a complete document of that kind carries — counted only
   * where the document actually has them, so a bare `{}` does not get promoted to the most demanding
   * schema on the strength of matching everything vacuously.
   */
  detectSchema(text: string): DetectSchemaResult {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Nothing to detect from. Not an error: this is asked while a file is opening, and an empty or
      // half-written document is the ordinary case.
      return { schemaId: null, candidates: [] };
    }
    // A non-object cannot be any of these, and `{}` satisfies all of them vacuously — suggesting one
    // for an empty file would be picking for the author rather than reading what they wrote.
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { schemaId: null, candidates: [] };
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return { schemaId: null, candidates: [] };

    const scored = listSchemas()
      .filter((entry) => {
        const declared = new Set(propertiesOf(entry).map((property) => property.key));
        return keys.every((key) => declared.has(key)) && this.schemaValidator(entry.id, entry.document)(value);
      })
      .map((entry) => ({ id: entry.id, score: entry.expected.filter((key) => keys.includes(key)).length }))
      .sort((a, b) => b.score - a.score);
    const candidates = scored.map((s) => s.id);
    return { schemaId: candidates[0] ?? null, candidates };
  }

  /** Compiled validators, cached by schema id. The documents are static, so one compile each. */
  private schemaValidator(id: string, document: object): ValidateFunction {
    const cached = this.schemaValidators.get(id);
    if (cached) return cached;
    // `strict: false` for the same reason the shared wrapper sets it: these documents carry `title`
    // and other harmless extras, and a strictness throw here would break the editor, not the schema.
    this.ajv ??= new Ajv({ allErrors: true, strict: false });
    const compiled = this.ajv.compile(document);
    this.schemaValidators.set(id, compiled);
    return compiled;
  }

  /**
   * Read any file under a layer root as text.
   *
   * The path-addressed generalisation of {@link readWorkflow}, and the channel the Files view opens
   * everything through — a prompt, a skill's markdown, a state file, `settings.json`. Containment is
   * {@link layerFile}'s, the same check the write surface rests on, so a `path` from the renderer
   * cannot reach outside the root it names.
   *
   * A type that is not text is refused rather than decoded. `readFileSync(.., "utf8")` on a PNG
   * succeeds and returns replacement characters, and the failure only shows up when someone saves
   * that back over the original — an error here is the difference between "no editor for this" and
   * silent data loss.
   */
  readFile(request: ReadFileRequest): FileSource {
    const file = this.treeFile(request.path, request.layer, request.project);
    // A file OUTSIDE the layer keeps its own path here, which is right: `mimeOfPath` falls through
    // to the extension for anything it does not recognise by position, and a checkout's source file
    // is exactly that.
    const named = this.layerPathOf(request.path, request.layer, request.project) ?? request.path;
    const mime = mimeOfPath(named);
    if (!isTextMime(mime)) throw this.refusal("file", `'${request.path}' is ${mime}, which is not text`);
    const exists = existsSync(file);
    if (exists && statSync(file).isDirectory()) throw this.refusal("file", `'${request.path}' is a directory`);
    return {
      layer: request.layer,
      // Echoed back, so the document the panel holds knows which project it is in — the tree's
      // highlight and every write that follows read it from here (SHELL.md §2.2).
      ...(request.project !== undefined ? { project: request.project } : {}),
      path: request.path,
      file,
      mime,
      text: exists ? readFileSync(file, "utf8") : "",
      exists,
      ...(this.stateIdOf(named) ?? {}),
    };
  }

  /**
   * Type-check one file against the project it is actually in (see {@link CheckFileRequest}).
   *
   * Addressed exactly like {@link readFile}, and through the same {@link treeFile} containment, so a
   * path from the renderer cannot make the compiler read outside the root it names. `text` is the
   * open buffer, which is what makes the answer follow typing rather than the last save.
   *
   * The refusals {@link readFile} makes are NOT repeated here. A file that does not exist, or that
   * is not text, simply has nothing to check — and answering "no project covers it" is a better
   * outcome for an editor than an exception it has to catch on every keystroke.
   */
  async checkFile(request: CheckFileRequest): Promise<FileCheck> {
    const at = this.checkRoot(request);
    const file = this.contained(at, request.path, request.layer);
    const baseline = request.baseline?.map(
      (b): BaselineOverlay => ({ file: this.contained(at, b.path, request.layer), text: b.text }),
    );
    return this.typeCheck().check(file, request.text, baseline);
  }

  /**
   * The tree a check's paths are relative to — the checkout, or a task's worktree.
   *
   * The worktree is not a fallback and not a preference: a review is ABOUT the tree the agent
   * worked in, which has its own `tsconfig.json`, its own dependencies and its own copy of every
   * sibling the file imports. Answering out of the checkout instead would be answering about a
   * different text — the version the agent started from — which is worse than not answering, because
   * it looks like an answer.
   *
   * So a `taskId` that names no worktree is REFUSED rather than quietly resolved somewhere else.
   */
  private checkRoot(request: CheckTarget): string {
    if (request.taskId === undefined) {
      if (request.layer === "system") return jairaBuiltInPaths().dir;
      return request.layer === "base"
        ? jairaBasePaths(this.baseDir).baseDir
        : this.requireProject(request.project).paths.projectDir;
    }
    const worktree = this.requireProject(request.project).runtime.get(request.taskId)?.worktreePath;
    if (worktree === undefined) {
      throw this.refusal("file", `task '${request.taskId}' has no worktree to check '${request.path}' in`);
    }
    return worktree;
  }

  /**
   * Where the symbol under the caret is defined — see {@link DefineFileRequest}.
   *
   * Each answer is given the address the Files view would open it by, when it has one. Working that
   * out here rather than in the renderer is the same choice {@link checkFile} makes about
   * containment: main knows which tree the question was rooted at, and a renderer re-deriving it
   * from an absolute path would be guessing at the answer to a question it already asked.
   */
  async defineFile(request: DefineFileRequest): Promise<FileDefinitions> {
    const asked = this.atCaret(request);
    const found = await asked.ask.definitions(...asked.args);
    return { ...found, definitions: found.definitions.map((d) => asked.addressed(d)) };
  }

  /** Everywhere the symbol under the caret is used — see {@link FileReferences}. */
  async referencesInFile(request: DefineFileRequest): Promise<FileReferences> {
    const asked = this.atCaret(request);
    const found = await asked.ask.references(...asked.args);
    return { ...found, references: found.references.map((r) => asked.addressed(r)) };
  }

  /** What the symbol under the caret IS — see {@link FileHover}. */
  async hoverInFile(request: DefineFileRequest): Promise<FileHover> {
    const asked = this.atCaret(request);
    return asked.ask.hover(...asked.args);
  }

  /**
   * Everything the three position questions need, worked out once.
   *
   * They ask the same thing of this class and differ only in which method of the port they call:
   * resolve the path in the right tree ({@link checkRoot}), keep it and the baseline's paths
   * contained, and give each answer the address the Files view would open it by. Three copies of
   * that is how two of them stay right and the third quietly does not.
   */
  private atCaret(request: DefineFileRequest): {
    ask: TypeCheckPort;
    args: [string, { line: number; column: number }, string | undefined, BaselineOverlay[] | undefined];
    addressed: <T extends { file: string }>(found: T) => T;
  } {
    const root = this.checkRoot(request);
    return {
      ask: this.typeCheck(),
      args: [
        this.contained(root, request.path, request.layer),
        { line: request.line, column: request.column },
        request.text,
        request.baseline?.map((b) => ({ file: this.contained(root, b.path, request.layer), text: b.text })),
      ],
      addressed: (found) => ({ ...found, ...(this.addressOf(root, found.file, request) ?? {}) }),
    };
  }

  /**
   * How the Files view would address a file the compiler named, or nothing.
   *
   * Nothing is a real answer and the common one for a dependency: a definition in `node_modules`
   * reached through a workspace junction resolves to a path outside this tree, and there is no row
   * in the tree that means it. The renderer draws no link rather than one that goes somewhere else.
   *
   * The WORKTREE case deliberately answers nothing as well. A review's paths are addressed by task
   * and the Files view is not — it draws the checkout — so a definition inside a worktree has no
   * address the tree could open, even though the file is plainly there.
   */
  private addressOf(
    root: string,
    file: string,
    request: CheckTarget,
  ): { at: { layer: WorkflowLayer; project?: string; path: string } } | undefined {
    if (request.taskId !== undefined) return undefined;
    const rel = relative(root, file);
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return {
      at: {
        layer: request.layer,
        ...(request.project !== undefined ? { project: request.project } : {}),
        path: rel.split(sep).join("/"),
      },
    };
  }

  /**
   * The text of a file the program resolved — see {@link SourceFileRequest}.
   *
   * `file` is NOT contained the way every other path here is, and deliberately: the bound is the
   * program rather than a root. A path the compiler never resolved is simply not in it, so nothing
   * can be fished for — while a definition that legitimately resolved outside the tree, which in
   * this repository is most of them, can still be previewed.
   */
  async sourceOfFile(request: SourceFileRequest): Promise<{ text?: string }> {
    const root = this.checkRoot(request);
    const text = await this.typeCheck().sourceOf(
      this.contained(root, request.path, request.layer),
      request.file,
      request.baseline?.map((b) => ({ file: this.contained(root, b.path, request.layer), text: b.text })),
    );
    return text === undefined ? {} : { text };
  }

  /** Forget an open buffer — the file on disk is the truth again. */
  async releaseFile(request: CheckTarget): Promise<void> {
    // Nothing is spawned to forget something nobody ever checked.
    if (this.checker === undefined && this.options.typeCheck === undefined) return;
    await this.typeCheck().release(this.contained(this.checkRoot(request), request.path, request.layer));
  }

  /** The checker, built on first use — see {@link AppServiceOptions.typeCheck}. */
  private typeCheck(): TypeCheckPort {
    this.checker ??= this.options.typeCheck ?? new WorkerTypeCheck();
    return this.checker;
  }

  private checker: TypeCheckPort | undefined;

  /**
   * Project files matching a query — what an `@` in the composer completes against.
   *
   * A walk rather than an index, and bounded twice over: at {@link FIND_VISIT} files looked at and
   * at the caller's `limit` returned. Both bounds are the point. This runs on the main thread while
   * somebody is typing, and a repository is an unbounded thing — an unbounded walk of one would
   * freeze the window on the checkout it matters most in.
   *
   * `truncated` says the walk stopped early, so the caller can say "keep typing" instead of showing
   * thirty results as though they were the thirty best.
   *
   * Skipped directories are the ones nobody means by `@`: version control, dependencies, build
   * output, and JaiRA's own state — which the Files view browses properly and which would otherwise
   * bury a project's own files under a hundred workflow fragments.
   */
  findFiles(request: { query: string; project?: string; limit?: number }): { paths: string[]; truncated: boolean } {
    const open = this.session(request.project);
    const root = open.project.paths.projectDir;
    const limit = Math.min(Math.max(request.limit ?? 30, 1), 200);
    // Subsequence matching, the way every file picker matches: `apsvc` finds `app/service.ts`. Empty
    // matches everything, which is what makes the picker useful the moment `@` is typed.
    const needle = request.query.trim().toLowerCase();
    const matches = (path: string): boolean => {
      if (needle === "") return true;
      const haystack = path.toLowerCase();
      let at = 0;
      for (const ch of needle) {
        at = haystack.indexOf(ch, at) + 1;
        if (at === 0) return false;
      }
      return true;
    };

    const out: string[] = [];
    let visited = 0;
    let truncated = false;
    // Breadth-first, so a shallow file — which is what a person usually means — is found before the
    // walk spends its budget in one deep subtree.
    const queue: string[] = [""];
    while (queue.length > 0 && out.length < limit && !truncated) {
      const rel = queue.shift()!;
      let entries;
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        continue; // unreadable directory — the rest of the tree is still worth walking
      }
      for (const entry of entries) {
        if (visited >= FIND_VISIT) {
          truncated = true;
          break;
        }
        visited += 1;
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!FIND_SKIP.has(entry.name) && !entry.name.startsWith(".")) queue.push(path);
          continue;
        }
        if (!entry.isFile() || !matches(path)) continue;
        out.push(path);
        if (out.length >= limit) break;
      }
    }
    return { paths: out.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)), truncated: truncated || queue.length > 0 };
  }

  /**
   * Artifacts granted to a frame, by the token minted for each — see {@link serveArtifact}.
   *
   * Bounded and evicted oldest-first. The bound is not about memory so much as about how long a
   * grant stays live: a window open all day should not accumulate an unbounded set of addresses that
   * still resolve, and an artifact reopened after eviction simply mints a new one.
   */
  private readonly served = new Map<string, { body: string; mediaType: string; interactive: boolean }>();

  /**
   * Who git would sign a commit as here — the name a review note carries (decision 0002).
   *
   * Cached for the process: `git config` spawns, a reviewer writes several notes in a sitting, and
   * a name that changed mid-session is not a case worth a subprocess per comment. Asked of the
   * project's own repository so a per-repo identity wins, and answered as `{}` rather than thrown
   * when there is no project or no git at all — an unsigned note is better than a refused one.
   */
  private readonly identities = new Map<string, { name?: string; email?: string }>();

  async gitIdentity(request: { project?: ProjectRef } = {}): Promise<{ name?: string; email?: string }> {
    const session = request.project !== undefined ? this.sessionOf(request.project) : this.sessionOf();
    const dir = session?.project.paths.projectDir;
    const key = dir ?? "~";
    const cached = this.identities.get(key);
    if (cached !== undefined) return cached;

    /**
     * The project first, then the machine.
     *
     * Asking only the project was wrong in the cases that come up most: a review can be ABOUT the
     * shared root, or a directory that is not a git repository at all, and both answered `{}` — so
     * every note was signed "you" on a machine whose global `user.name` was sitting right there.
     * `git config --get` walks repo → global → system by itself; running it somewhere that is not a
     * repo simply skips the first rung.
     */
    let identity: { name?: string; email?: string } = {};
    if (session !== undefined && dir !== undefined) {
      try {
        identity = await gitFor(session.project, dir).identity();
      } catch {
        /* Not a repo, or no git. The machine-wide read below is the answer. */
      }
    }
    if (identity.name === undefined) {
      try {
        const anywhere = new Git({ exec: new NodeExec(), repoDir: homedir() });
        const global = await anywhere.identity();
        identity = { ...global, ...identity };
      } catch {
        /* No git on this machine. An unsigned note is better than a refused one. */
      }
    }
    this.identities.set(key, identity);
    return identity;
  }

  /**
   * Everything one task produced, oldest first — what the artifacts panel lists.
   *
   * Metadata only, deliberately: see {@link ArtifactSummary}. A conversation that wrote forty
   * documents would otherwise send all forty to draw a list of names.
   */
  listArtifacts(request: { taskId: string; project?: ProjectRef }): ArtifactSummary[] {
    const session = request.project !== undefined ? this.sessionOf(request.project) : this.sessionOf();
    if (session === undefined) throw this.refusal("file", "no project is open");
    return session.project.artifacts.list(request.taskId).map((record) => ({
      path: record.logicalPath,
      // The recorded type, else what the name implies — the same order `serveArtifact` resolves in,
      // so a row in the list and the thing that opens from it cannot disagree about what it is.
      mediaType: record.format ?? mimeOfPath(record.logicalPath),
      bytes: record.bytes,
      interactive: record.interactive === true,
      createdAt: record.createdAt,
      ...(record.stateId !== undefined ? { stateId: record.stateId } : {}),
      ...(record.slot !== undefined ? { slot: record.slot } : {}),
    }));
  }

  /**
   * Mint an address a frame can load ONE artifact from (see {@link ServeArtifactRequest}).
   *
   * The renderer names an artifact it can already see; this resolves it and returns an opaque token.
   * The alternative — a protocol that parses `<taskId>/<path>` out of the URL and reads the artifact
   * map itself — would be a second door into project data, reachable by any URL the page contrives,
   * and it would have to re-implement every containment rule the map's readers already apply. A token
   * grants exactly what was granted.
   */
  async serveArtifact(request: ServeArtifactRequest): Promise<ServedArtifact> {
    const session = request.project !== undefined ? this.sessionOf(request.project) : this.sessionOf();
    if (session === undefined) throw this.refusal("file", "no project is open");
    const record = session.project.artifacts.get(request.taskId, request.path);
    if (record === undefined) throw this.refusal("file", `no artifact at '${request.path}' for task ${request.taskId}`);

    // Inline copy first, then wherever it was placed — the artifact map's own resolution order, and
    // the reason a `virtual:` artifact is servable at all.
    const body =
      record.content ??
      (record.physicalPath !== undefined && existsSync(record.physicalPath)
        ? readFileSync(record.physicalPath, "utf8")
        : undefined);
    if (body === undefined) throw this.refusal("file", `the bytes for '${request.path}' are no longer where they were placed`);

    const mediaType = request.mediaType ?? record.format ?? mimeOfPath(request.path);
    const interactive = record.interactive === true;
    const token = randomUUID();
    this.served.set(token, { body, mediaType, interactive });
    // Oldest-first eviction, so the map cannot grow without bound in a long-lived window.
    while (this.served.size > 64) {
      const oldest = this.served.keys().next();
      if (oldest.done === true) break;
      this.served.delete(oldest.value);
    }
    return { url: `${ARTIFACT_SCHEME}://frame/${token}`, mediaType, bytes: Buffer.byteLength(body, "utf8"), interactive };
  }

  /**
   * What the protocol handler serves for a token, or `undefined` when nothing was granted for it.
   *
   * Kept here rather than in the Electron layer so the whole grant/serve cycle is testable without a
   * browser — the handler above it does nothing but turn this into a response.
   */
  servedArtifact(token: string): { body: string; mediaType: string; interactive: boolean } | undefined {
    return this.served.get(token);
  }

  /**
   * One generalised read channel (CHANGESETS.md §8.5): `file:` and the `$…` anchors, `git:` blobs,
   * `db://` recorded values — the addresses a changeset's chain speaks, resolvable by the renderer.
   *
   * Anchor-guarded the way artifact destinations are ({@link withinWorkspace} is the same refusal
   * `artifactPath.ts` makes for `"dir": "../../escape"`): a path resolves only under `$PROJECT`,
   * `$JAIRA`, or a task's `$WORKTREE`, and a `git:` blob only in the project's own repository. A
   * renderer-reachable channel that resolves arbitrary `file:` URIs is a sandbox escape, so
   * anything else — and anything unrecognised — is refused rather than guessed at.
   */
  async readUri(request: ReadUriRequest): Promise<UriContent> {
    const session = request.project !== undefined ? this.sessionOf(request.project) : this.sessionOf();
    if (session === undefined) throw this.refusal("file", "no project is open");
    const project = session.project;
    const uri = request.uri.trim();

    const guarded = (root: string, rel: string): UriContent => {
      const file = withinWorkspace(root, rel);
      if (file === undefined) throw this.refusal("file", `'${uri}' escapes its anchor — refused`);
      const mime = mimeOfPath(rel.replace(/\\/g, "/"));
      if (!isTextMime(mime)) throw this.refusal("file", `'${uri}' is ${mime}, which is not text`);
      if (!existsSync(file) || statSync(file).isDirectory()) throw this.refusal("file", `'${uri}' does not name a readable file`);
      return { uri, mime, text: readFileSync(file, "utf8") };
    };

    const anchored = /^\$(PROJECT|JAIRA|WORKTREE)\/(.+)$/.exec(uri);
    if (anchored !== null) {
      const [, anchor, rel] = anchored;
      if (anchor === "PROJECT") return guarded(project.paths.projectDir, rel!);
      if (anchor === "JAIRA") return guarded(project.paths.jairaDir, rel!);
      const worktree = request.taskId !== undefined ? project.runtime.get(request.taskId)?.worktreePath : undefined;
      if (worktree === undefined) throw this.refusal("file", `'$WORKTREE' needs a task with a worktree — pass taskId`);
      return guarded(worktree, rel!);
    }

    /*
     * `artifact://<taskId>/<logicalPath>` — the address a produced artifact carries.
     *
     * Resolved through the MAP rather than the filesystem, which is the whole reason it is a scheme
     * of its own: an artifact under `virtual:` has no path on disk, and one under any other
     * destination is not where its logical name says it is. Both answer here.
     *
     * No anchor guard is needed and none would help: nothing is joined onto a root, so there is no
     * `..` to climb. The bound is the map itself — a `(taskId, logicalPath)` pair either names a
     * record this project wrote or it names nothing.
     */
    const artifact = /^artifact:\/\/([^/]+)\/(.+)$/.exec(uri);
    if (artifact !== null) {
      const [, taskId, logicalPath] = artifact;
      const record = project.artifacts.get(decodeURIComponent(taskId!), logicalPath!);
      if (record === undefined) throw this.refusal("file", `'${uri}' names no artifact this project produced`);
      const text =
        record.content ??
        (record.physicalPath !== undefined && existsSync(record.physicalPath)
          ? readFileSync(record.physicalPath, "utf8")
          : undefined);
      if (text === undefined) throw this.refusal("file", `the bytes for '${uri}' are no longer where they were placed`);
      return { uri, mime: record.format ?? mimeOfPath(logicalPath!), text };
    }

    if (uri.startsWith("git:")) {
      const source = parseChangesetSource(uri);
      if (source.scheme !== "git" || source.path === undefined) {
        throw this.refusal("file", `'${uri}' names a commit, not a blob — read git:<sha>:<path>`);
      }
      // The project's OWN repository — §1.1's longest-match becomes ls-tree for this scheme, but a
      // read of one blob needs no listing at all.
      const git = gitFor(project, project.paths.projectDir);
      const text = await git.show(source.rev, source.path);
      if (text === undefined) throw this.refusal("file", `'${uri}' does not resolve in this project's repository`);
      return { uri, mime: mimeOfPath(source.path), text };
    }

    if (uri.startsWith("db://")) {
      const source = parseChangesetSource(uri);
      if (source.scheme !== "db") throw this.refusal("file", `'${uri}' is not a db:// address`);
      if (source.table !== "operation_records") {
        throw this.refusal("file", `'${uri}' addresses table '${source.table}' — only operation_records is addressable`);
      }
      const store = sessionStoreFor(project, {
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
      });
      let value: unknown;
      if ("recordId" in source) {
        // The content-id form (§10.6): the id a settled operation event carries, resolvable whether
        // or not the call ever claimed a conversation seat. Rooted at {request, result} because
        // §5.3 puts a gate's changeset in the REQUEST.
        const record = store.record(source.recordId);
        if (record === undefined) throw this.refusal("file", `'${uri}' names a record this scope has not written`);
        value = record;
      } else {
        const row = store.at(source.session, source.seq);
        if (row === undefined) throw this.refusal("file", `'${uri}' names a position no record has claimed`);
        value = { result: row.value };
      }
      for (const step of source.pointer) {
        value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[step] : undefined;
      }
      if (value === undefined) throw this.refusal("file", `'${uri}' resolves a record, but '${source.pointer.join(".")}' is not in it`);
      return { uri, mime: "application/json", text: JSON.stringify(value, null, 2) };
    }

    if (uri.startsWith("file:")) {
      const source = parseChangesetSource(uri);
      if (source.scheme !== "file") throw this.refusal("file", `'${uri}' is not a file: address`);
      // Absolute, but still confined: the path must land under one of the anchors this project owns.
      const worktree = request.taskId !== undefined ? project.runtime.get(request.taskId)?.worktreePath : undefined;
      const roots = [project.paths.projectDir, project.paths.jairaDir, ...(worktree !== undefined ? [worktree] : [])];
      const inside = roots
        .map((root) => ({ root, rel: relative(root, source.path) }))
        .find(({ rel }) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
      if (inside === undefined) throw this.refusal("file", `'${uri}' is outside every anchor this project owns — refused`);
      const content = guarded(inside.root, inside.rel);
      if (source.sha256 !== undefined) {
        const now = createHash("sha256").update(content.text).digest("hex");
        if (now !== source.sha256) return { ...content, drifted: true };
      }
      return content;
    }

    throw this.refusal("file", `unrecognised uri '${uri}' — expected $PROJECT/, $JAIRA/, $WORKTREE/, file:, git: or db:// (refused rather than guessed at)`);
  }

  /**
   * Write any file under a layer root.
   *
   * Unparsed, deliberately — see {@link WriteFileRequest}. A state file saved through here would
   * skip the JSON check {@link writeWorkflow} exists to perform, so the renderer routes state files
   * to that channel instead; this one refuses them rather than trusting it to, because a bypass that
   * depends on the untrusted half of the boundary choosing correctly is not a check at all.
   */
  writeFile(request: WriteFileRequest): FileSource {
    this.writable(request.layer);
    // How the LAYER spells this file, which is what everything below keys on: the mime that decides
    // whether it is a state, the state id echoed back, and the sync baseline. A file outside the
    // layer keeps its own path — it is none of those things, and `mimeOfPath` reads it by extension.
    const named = this.layerPathOf(request.path, request.layer, request.project) ?? request.path;
    const mime = mimeOfPath(named);
    if (!isTextMime(mime)) throw this.refusal("file", `'${request.path}' is ${mime}, which is not text`);
    if (mime === WORKFLOW_JSON) throw this.refusal("file", `'${request.path}' is a state file — write it through workflow:write`);
    const file = this.treeFile(request.path, request.layer, request.project);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, request.text, "utf8");
    this.publish({ type: "store:invalidate", scope: "workflows" });
    // Saving what a sync proposed is what accepts it — the description goes through here, and so
    // does a `.jsonc` state file.
    this.noteSyncWrite(request.layer, named);
    return {
      layer: request.layer,
      path: request.path,
      file,
      mime,
      text: request.text,
      exists: true,
      ...(this.stateIdOf(named) ?? {}),
    };
  }

  /**
   * The state id a root-relative path defines, if it defines one.
   *
   * The same derivation the tree uses (`stateViews.walkDir`) rather than a second one: a path that
   * the tree calls a state and the panel does not would open the board on one and not the other.
   */
  private stateIdOf(path: string): { stateId: string } | null {
    if (!path.startsWith("workflows/") || !/\.(json|ya?ml)$/i.test(path)) return null;
    return { stateId: path.slice("workflows/".length).replace(/\.(json|ya?ml)$/i, "") };
  }

  /**
   * Create a plain file or a directory under a layer root.
   *
   * Addressed by path rather than by state id, so it gets its own containment check against the
   * WHOLE layer root — `prompts/`, `skills/` and bare directories are all legitimate destinations,
   * and `../../.ssh` is still not.
   *
   * Refuses to clobber: an existing path is an error rather than a silent overwrite, because "new
   * file" that quietly emptied an existing one is the worst possible reading of the verb.
   */
  createFile(request: CreateFileRequest): { file: string } {
    this.writable(request.layer);
    const file = this.treeFile(request.path, request.layer, request.project);
    if (existsSync(file)) throw this.refusal("file", `'${request.path}' already exists`);
    if (request.kind === "directory") {
      mkdirSync(file, { recursive: true });
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, request.text ?? "", "utf8");
    }
    this.publish({ type: "store:invalidate", scope: "workflows" });
    return { file };
  }

  /**
   * Rename or move a file or a directory inside a layer root.
   *
   * The path-addressed counterpart of {@link moveWorkflow}, and the reason the tree can rename the
   * things that are not states: a prompt, a skill folder, a directory of workflows. Both ends go
   * through {@link layerFile}, so the destination is contained exactly as the source is.
   *
   * A directory under `workflows/` is the interesting case — its path IS the id prefix of every
   * state inside it, so moving it renames all of them at once. That is checked with the same
   * question a state rename asks, applied to the whole set: who outside it names something inside?
   */
  renameFile(request: RenameFileRequest): FileMutationResult {
    this.writable(request.layer);
    const from = this.treeFile(request.path, request.layer, request.project);
    const to = this.treeFile(request.to, request.layer, request.project);
    if (!existsSync(from)) throw this.refusal("file", `'${request.path}' does not exist in the ${request.layer} root`);
    if (from === to) throw this.refusal("file", "the source and destination are the same path");
    if (existsSync(to)) throw this.refusal("file", `'${request.to}' already exists`);
    // Moving a directory into itself leaves the tree with an unreachable branch, and `renameSync`
    // reports it as a bare EINVAL that says nothing about what was attempted.
    if (to.startsWith(`${from}${sep}`)) throw this.refusal("file", `'${request.to}' is inside '${request.path}'`);

    const states = this.statesUnder(from, request.layer, request.project);
    const referencedBy = this.brokenBy(states, request.project);
    if (referencedBy.length > 0 && request.force !== true) {
      return { path: request.path, layer: request.layer, applied: false, referencedBy, states };
    }

    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    this.publish({ type: "store:invalidate", scope: "workflows" });
    return { path: request.to, layer: request.layer, applied: true, referencedBy, states };
  }

  /**
   * Delete a file or a directory under a layer root.
   *
   * A directory takes everything in it, which is why the refusal matters more here than anywhere
   * else: deleting `workflows/feature/` is one click that can remove a dozen states, and the states
   * that named them would only report it at load time.
   */
  deleteFile(request: DeleteFileRequest): FileMutationResult {
    this.writable(request.layer);
    const file = this.treeFile(request.path, request.layer, request.project);
    if (!existsSync(file)) throw this.refusal("file", `'${request.path}' does not exist in the ${request.layer} root`);

    const states = this.statesUnder(file, request.layer, request.project);
    const referencedBy = this.brokenBy(states, request.project);
    if (referencedBy.length > 0 && request.force !== true) {
      return { path: request.path, layer: request.layer, applied: false, referencedBy, states };
    }

    rmSync(file, { recursive: true, force: true });
    this.publish({ type: "store:invalidate", scope: "workflows" });
    return { path: request.path, layer: request.layer, applied: true, referencedBy, states };
  }

  /** Show a file in the OS file manager, when the host provides a way to. */
  revealFile(request: { file: string }): { file: string } {
    this.options.reveal?.(request.file);
    return request;
  }

  // --- keeping the description and the workflows in step ---------------------

  /**
   * Which of `workflows/workflow.md` and the state files has moved since they were last agreed.
   *
   * Answered from the recorded baseline (`persistence/workflowSync.ts`) and from `text`, which is
   * the document as the EDITOR has it. Passing the unsaved draft in is the whole reason this takes a
   * text at all: a status line computed from the saved file, next to a panel showing a rewritten
   * one, would say "in sync" about a document nobody has on screen.
   *
   * Never throws. Every way this can fail to have an answer — no project for a project-layer
   * description, no workflows — is a `blocked` string instead, because the panel is rendered by
   * opening a file and an exception there is a blank surface with no explanation on it.
   */
  syncStatus(request: { layer: WorkflowLayer; path: string; text?: string; project?: string }): WorkflowSyncStatus {
    // A sync AUTHORS in its layer, and nothing is authored into what ships (decision 0006). Said as a
    // `blocked` line rather than thrown, for the reason this method gives about every other obstacle.
    if (!isWritableLayer(request.layer)) {
      return {
        layer: request.layer,
        path: request.path,
        exists: false,
        synced: false,
        documentChanged: false,
        statesChanged: false,
        changedStates: [],
        suggested: null,
        blocked: "what ships with JaiRA is read-only, so there is nothing to sync into it",
      };
    }
    const base = {
      layer: request.layer,
      path: request.path,
      exists: false,
      synced: false,
      documentChanged: false,
      statesChanged: false,
      changedStates: [],
      suggested: null,
      ...(this.syncHolder(request.layer).pendingSync !== undefined
        ? { pending: this.syncHolder(request.layer).pendingSync!.direction }
        : {}),
    } satisfies WorkflowSyncStatus;

    if (request.layer === "project" && !this.hasProject) {
      return { ...base, blocked: "open a project to sync its workflows" };
    }

    const source = this.syncSource(request.layer, request.project);
    let file: string;
    try {
      file = this.layerFile(request.path, request.layer, request.project);
    } catch (e) {
      return { ...base, blocked: (e as Error).message };
    }
    const exists = existsSync(file);
    const text = request.text ?? (exists ? readFileSync(file, "utf8") : "");

    // Which workflow this description is about — the file beside it, or every root when it is the
    // layer-wide `workflow.md`. A root named by a description that does not exist is reported here
    // rather than at run time, because it is a typo in a filename and the panel is where it shows.
    const root = descriptionRootOf(request.path);
    const where = request.layer === "base" ? "the shared root" : "this project";
    const known = new Set(browseSource(source).workflows.map((w) => w.rootId));
    if (root !== null && !known.has(root)) {
      return {
        ...base,
        exists,
        blocked:
          known.size === 0
            ? `'${root}' names no workflow — ${where} has none yet`
            : `'${root}' names no workflow here. ${where === "this project" ? "This project" : "The shared root"} has: ${[...known].sort().join(", ")}`,
      };
    }

    // The state files this description is answerable for: its subtree, minus every subtree a nearer
    // description owns. Without the subtraction, editing a state would report drift on this
    // document AND on the one that actually describes it, with no way to say which is now stale.
    const scope = this.scopeOf(source, request.path);
    const covered = new Set(this.ownedFiles(source, request.path));
    const states = stateHashes(source.paths.workflowsDir, covered);
    const record = readSyncRecord(source.paths.syncFile, request.path);
    const drift = syncDrift(record, { documentHash: hashText(text), states });
    // Delegation is not an error, so it is reported beside the status rather than as a block — but
    // it has to be reported. Otherwise you edit a delegated state, this panel says "in step", and
    // the honest answer ("that belongs to another document") is nowhere on screen.
    const delegated = scope.ownership.delegates;
    const blocked =
      text.trim() === ""
        ? "this description is empty — write what the workflows should do, then sync"
        : Object.keys(states).length === 0
          ? delegated.length > 0
            ? `every state here is described by ${delegated.map((d) => d.document).join(", ")}`
            : root === null
              ? `${where} has no workflows to sync against`
              : `'${root}' resolves entirely from the shared root, so this project has no files to sync`
          : undefined;
    return {
      ...base,
      exists,
      synced: record !== undefined,
      ...(record !== undefined ? { at: record.at, lastDirection: record.direction } : {}),
      ...drift,
      ...(delegated.length > 0 ? { delegated } : {}),
      ...(blocked !== undefined ? { blocked } : {}),
    };
  }

  /**
   * Run a sync, and write nothing.
   *
   * The result is a PROPOSAL: rewritten markdown, or whole state files. The renderer holds it as
   * unsaved drafts, so the person who wrote the document is the one who decides it now says
   * something else. That is not a nicety — one direction rewrites prose somebody authored and the
   * other rewrites code that will run, and a model doing either straight to disk is a model
   * with commit rights.
   *
   * The run is the ordinary engine (`syncWorkflowFiles`), so it obeys the project's model defaults,
   * costs are rolled up, `fake` scripts it with no provider, and it can be canceled.
   */
  /**
   * What a sync may CALL — one read-only tool, and nothing else.
   *
   * The function registry stays empty: a sync runs no commands and delegates to no agent, so giving
   * it a registry that could would be a capability nothing in it asks for. What it does get is
   * `read_file`, because the digest CLIPS a long state (reported in the run's `notes`) and a run that
   * can open the file it was told about proposes an edit against what is actually there rather than
   * against a truncation.
   *
   * `write_file` and `bash` are deliberately absent. A sync returns text for a person to accept; one
   * that could touch disk would be a model with commit rights. This is a parameter to `startRun`
   * rather than something the run assembles, so the refusal is stated where it is enforced.
   *
   * The registry is HALF the statement. It bounds what a provider-served loop can call; a DELEGATED
   * agent answering the same states runs its own loop with its own built-ins, which no registry
   * reaches. The other half is authored on the workflow itself: the sync states carry
   * `permissions: { profile: "read-only" }` (`syncWorkflowFiles`), which the engine hands the agent
   * transport as its gate — claude loses its write-capable built-ins up-front, codex runs
   * `--sandbox read-only`, and a transport that can enforce neither refuses the state.
   */
  private syncCapabilities(
    registry: ReturnType<typeof newRegistry>,
    source: ReturnType<AppService["syncSource"]>,
    config: JairaConfigOf,
  ): void {
    registry.tools.set(
      READ_FILE,
      createReadFileTool({
        // No artifact store and no destination: nothing is being PLACED, so the read falls through to
        // the workspace, which is scoped to the workflows directory this sync is answerable for.
        vars: {
          taskId: "sync",
          worktree: source.paths.workflowsDir,
          project: source.paths.projectDir,
          jaira: source.paths.jairaDir,
          artifactDir: config.artifacts.dir,
        },
        cwd: source.paths.workflowsDir,
      }),
    );
  }

  async runSync(request: WorkflowSyncRequest): Promise<WorkflowSyncResult> {
    this.writable(request.layer);
    const source = this.syncSource(request.layer, request.project);
    const owner = this.syncHolder(request.layer);
    if (owner.syncTask !== undefined) throw this.refusal("sync", "a sync is already running");

    const file = this.layerFile(request.path, request.layer, request.project);
    const spec = request.text ?? (existsSync(file) ? readFileSync(file, "utf8") : "");
    if (spec.trim() === "") throw this.refusal("sync", `${request.path} is empty; there is nothing to sync`);

    // Scoped to what this description OWNS: the root it names, minus every subtree a nearer
    // description covers. The delegated subtrees are still in the digest, as contracts — a parent
    // has to be able to say what it handed off — but not as states this run may rewrite.
    const scope = this.scopeOf(source, request.path);
    const digest = digestSource(source, scope.digestOptions);
    // A workflow that does not load used to be refused here, on the reasoning that a sync over
    // partial evidence would propose against a graph it only half read. That got the case backwards:
    // a broken workflow is the one somebody most wants help fixing, and refusing meant the only
    // surface that could have named the broken file instead greyed its own button out. The digest
    // now RENDERS an unloadable root from its files on disk and says so in the markdown, so the
    // evidence is present and labelled rather than absent — and the breakage is in scope for the
    // proposal instead of a precondition for it.
    if (digest.roots.length === 0) {
      throw this.refusal("sync", `${request.layer === "base" ? "the shared root" : "this project"} has no workflows to sync against`);
    }

    const bundle = loadBundle(syncWorkflowFiles(), syncRootId(request.direction));
    // The configuration the run obeys is the TARGET's — the project whose description this is, or the
    // shared root's for a base-layer one. Not the recording project's: a project-layer sync journaled
    // into the system project must still call the model that project asked for, with the credentials
    // its own `.env` chain resolves. See {@link startRun}.
    // WHOSE CONFIGURATION governs it — deliberately not where it is recorded (see below). A
    // base-layer sync resolves the SHARED root's models and the shared root's `.env`, because that
    // is the library being synced. JaiRA's own project is a bare directory with no credential chain
    // of its own, so reading configuration out of it would silently fall back to defaults.
    const target = request.layer === "base" ? this.sessionOf(SHARED_SESSION) : this.sessionOf();
    // BOTH from the target, or the two disagree. `effectiveConfig()` answers for the FOCUSED project,
    // so a base-layer sync was resolving a user project's models against the shared root's credentials
    // — the exact mismatch `startRun`'s contract exists to prevent, reintroduced one level above it.
    const config = target?.project.config ?? this.effectiveConfig();
    const secrets = this.secretResolver(target);

    // WHERE THE RUN IS RECORDED. The base root, always — so a sync works with no user project open,
    // and never appears on a board somebody else owns. Without it there is nowhere to journal, and
    // the run falls back to what it did before it was a task at all.
    const system = this.sessionOf(SHARED_SESSION);
    if (system === undefined) {
      // Refused rather than run unrecorded. An unjournaled sync is what this used to be, and its
      // failures were unreadable — running one anyway would quietly restore that, and the person
      // would have no way to tell which kind of sync they had just watched fail.
      throw this.refusal("sync", `the shared root could not be opened, so a sync cannot be recorded: ${this.roleError.shared}`);
    }

    this.log({
      level: "info",
      source: "sync",
      message: `proposing ${request.direction === "document" ? "description" : "workflow"} changes for ${request.layer}:${request.path}`,
      project: system.key,
      detail: { workflows: digest.roots.length, spec: spec.length },
    });
    const task = createTask(system.project, {
      title: `${request.direction === "document" ? "Sync the description" : "Sync the workflows"} · ${request.path}`,
      workflow: syncRootId(request.direction),
      inputs: { spec, implementation: digest.markdown },
      // The layer and the target, so a row in JaiRA's own task list says what it was about. No
      // `branch`: `createTask` refuses one on a system project, which is what keeps these out of
      // anybody's worktrees.
      labels: ["jaira", "sync", request.direction, request.layer],
    });

    // Claimed and released in ONE try/finally around everything that can throw. Set outside it, the
    // marker leaked on any failure between here and the await — `startRun` refuses a capability gate,
    // `beginTaskRun` refuses a bundle — and that layer then reported "a sync is already running" for
    // the life of the process, with no way to clear it.
    owner.syncTask = task.id;
    try {
      await this.startRun(system, task.id, {
        config,
        secrets,
        bundle,
        // The workspace is the workflows directory this sync is answerable for — NOT the system
        // project's own directory, which is where `ensureWorkspace` would have pointed it.
        workspace: { root: source.paths.workflowsDir, isWorktree: false },
        capabilities: (registry) => this.syncCapabilities(registry, source, config),
        ...(request.fake !== undefined ? { fake: request.fake } : {}),
      });
      // The run is a task now, so waiting for it is waiting for its live entry to settle.
      // `workflow:sync` stays blocking on purpose: the panel, the IPC contract and the result shape are
      // unchanged, and what it gains is a journal, a live event stream and a row to go back to.
      await system.live.get(task.id)?.done;
    } finally {
      owner.syncTask = undefined;
    }

    const run = system.project.runtime.get(task.id);
    if (run?.outcome !== "success") {
      // The operation-level reasons, out of the journal this run now keeps — the same thing
      // `jaira task start` prints, rather than the parent composite's view of its child. This is what
      // the run's own `InMemoryPersistence` was standing in for before it had somewhere to write.
      const causes = runCauses(system.project, task.id).map((c: { stateId: string; reason: string }) => `${c.stateId}: ${c.reason}`);
      const failure = run?.failureJson === undefined ? undefined : (JSON.parse(run.failureJson) as { reason?: string });
      throw this.refusal("sync", causes.length > 0 ? causes.join("; ") : (failure?.reason ?? "the sync did not finish"));
    }

    const outcome = syncOutcomeOf(
      run.outputsJson === undefined ? undefined : (JSON.parse(run.outputsJson) as JsonValue),
      request.direction,
    );
    // Summed from the journal rather than read off the result: the run settled into the database, and
    // its spend is the roll-up of what each operation reported.
    const costUsd = runCostUsd(system.project, task.id);
    // A clipped state is evidence the run did not see in full, and the caller must be told rather
    // than shown a proposal that quietly ignored half a workflow.
    const notes = [
      ...outcome.notes,
      ...digest.truncated.map((id) => `state '${id}' is too long for the digest and was clipped before the sync saw it`),
    ];
    // The findings are the evidence; a verdict that contradicts them is not believed here either.
    const verdict = verdictOfFindings(outcome.findings);

    const common = {
      // The sync run's own task. The panel passes it back as `parentTaskId` when the person opens
      // the review by hand, so a review started from the button is parented exactly as one the sync
      // auto-opened.
      taskId: task.id,
      direction: request.direction,
      workflows: digest.roots,
      requirements: outcome.requirements,
      findings: outcome.findings,
      extras: outcome.extras,
      verdict,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };

    if (request.direction === "document") {
      const text = outcome.document?.text ?? "";
      const changed = hashText(text) !== hashText(spec);
      // Nothing to accept means the two already agree — which is a sync that succeeded, so the
      // baseline moves. The alternative would leave a project that IS in step reporting drift
      // forever, with no button that could ever clear it.
      if (changed) {
        this.beginPendingSync("document", request.path, request.layer, [docKey(request.layer, request.path)], request.project);
      }
      else this.commitSyncRecord("document", request.path, request.layer, request.project);
      return {
        ...common,
        document: { text, changes: outcome.document?.changes ?? [] },
        notes: changed ? notes : ["the description already describes what the workflows do", ...notes],
      };
    }

    const edits = this.placeEdits(outcome.edits ?? [], scope.ownership, source.layer, request.project);
    const applicable = edits.filter((e) => e.applicable);
    const identical = (outcome.edits ?? []).length - edits.length;
    // The same proposals, lowered into ONE changeset (CHANGESETS.md §1): the sync stops being its
    // own review mechanism and becomes a producer of the value the reviewer takes. `before` is the
    // tree as it stands, and the source pins it by content hash — drift is then detectable (§3.2).
    const layerByPath = new Map(applicable.map((e) => [e.path, e.layer] as const));
    const changeset =
      applicable.length > 0
        ? await editsChangeset(
            request.layer === "base" ? jairaBasePaths(this.baseDir).baseDir : this.requireProject(request.project).paths.jairaDir,
            applicable.map((e) => ({ path: e.path, action: e.action, text: e.text, reason: e.reason })),
            (path: string) => {
              try {
                const file = this.layerFile(path, layerByPath.get(path) ?? request.layer, request.project);
                return existsSync(file) ? readFileSync(file, "utf8") : undefined;
              } catch {
                return undefined;
              }
            },
          )
        : undefined;
    if (applicable.length > 0) {
      this.beginPendingSync(
        "states",
        request.path,
        request.layer,
        applicable.map((e) => docKey(e.layer, e.path)),
        request.project,
      );
    } else if (edits.length === 0) {
      this.commitSyncRecord("states", request.path, request.layer, request.project);
    }
    // The review, opened by the sync itself when asked to. The reviewer arrives as a pending
    // interaction — from MAIN, not from whichever renderer state happened to await this channel —
    // so a window that reloaded or wandered off during an hour-long run still gets the diff UI the
    // moment there is something to decide. Failure to open it is reported as a note, never as a
    // failed sync: the proposal exists and the panel's own button can still start a review.
    let reviewTaskId: string | undefined;
    if (request.review === true && changeset !== undefined) {
      try {
        const review = await this.reviewSyncChangeset({
          layer: request.layer,
          path: request.path,
          changeset,
          parentTaskId: task.id,
          ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
          ...(request.fake !== undefined ? { fake: request.fake } : {}),
        });
        reviewTaskId = review.reviewTaskId;
      } catch (e) {
        notes.push(`the changeset review could not be opened: ${(e as Error).message}`);
      }
    }
    return {
      ...common,
      edits,
      ...(changeset !== undefined ? { changeset } : {}),
      ...(reviewTaskId !== undefined ? { reviewTaskId } : {}),
      notes: [
        ...notes,
        ...(identical > 0 ? [`${identical} proposed file(s) were already identical to what is on disk`] : []),
        ...(edits.length === 0 ? ["the workflows already run what the description asks for"] : []),
      ],
    };
  }

  /**
   * Review a task's worktree edits as a changeset (CHANGESETS.md's flagship flow) — the paragraph
   * that motivated the design: the edits exist, are perfectly readable by `git diff`, and nothing
   * read them.
   *
   * Produces the changeset from the worktree against `base` (default HEAD — the agent's
   * uncommitted work), then runs the built-in review workflow with the WORKTREE as the run's
   * workspace, so a settled review's `apply-changeset` writes exactly there. Recorded in JaiRA's
   * own project the way a sync is, labelled with the task it is about: a review is JaiRA's
   * operation on the task's work, not a second run of the task's workflow.
   *
   * NOT awaited past the start, unlike a sync: the very next thing this run does is park on the
   * gate, and the renderer answers it through the ordinary interaction flow — the reviewer UI pops
   * from `interaction:requested` like any other component. Blocking the channel until a human
   * finishes reading a multi-file diff would hang the renderer that has to show it.
   */
  async reviewChanges(request: ReviewChangesRequest): Promise<ReviewChangesResult> {
    const session = request.project !== undefined ? this.sessionOf(request.project) : this.sessionOf();
    if (session === undefined) throw this.refusal("review", "no project is open");
    const row = session.project.runtime.get(request.taskId);
    const worktree = row?.worktreePath;
    if (worktree === undefined) {
      throw this.refusal("review", `task '${request.taskId}' has no worktree — only a branch-bound task's edits can be reviewed`);
    }
    const git = gitFor(session.project, worktree);
    const changeset = await worktreeChangeset(git, request.base ?? "HEAD", (path) => {
      const file = withinWorkspace(worktree, path);
      if (file === undefined || !existsSync(file)) return undefined;
      return readFileSync(file, "utf8");
    });
    if (changeset.changes.length === 0) {
      throw this.refusal("review", `the worktree matches ${request.base ?? "HEAD"} — there is nothing to review`);
    }

    // Recorded in the base root, like a sync — and refused rather than run unrecorded, for the
    // same reason (§5.3: the record is what pins the changeset once the worktree moves on).
    const system = this.sessionOf(SHARED_SESSION);
    if (system === undefined) {
      throw this.refusal("review", `the shared root could not be opened, so a review cannot be recorded: ${this.roleError.shared}`);
    }
    const meta = session.project.tasks.tryRead(request.taskId);
    const rootId = request.loop === true ? CHANGESET_REVIEW_LOOP_ID : CHANGESET_REVIEW_ID;
    const bundle = loadBundle(
      request.loop === true ? changesetReviewLoopFiles({ tree: "proposal" }) : changesetReviewFiles({ tree: "proposal" }),
      rootId,
    );
    const task = createTask(system.project, {
      title: `Review changes · ${meta?.title ?? request.taskId}`,
      workflow: rootId,
      inputs: { changeset: changeset as unknown as JsonValue },
      labels: ["jaira", "changeset-review", request.taskId],
      // The task whose worktree this reviews. Usually a task in ANOTHER project's store — recorded
      // all the same, because the record is the fact; a board that cannot resolve it simply leaves
      // this run where it stands.
      parentTaskId: request.taskId,
    });
    // The reviewed task's project, so the gate's `$WORKTREE` finds the worktree row — it is in THIS
    // project's runtime, not the system project the review is recorded in.
    system.subjectProject.set(task.id, session.dir);
    const started = await this.startRun(system, task.id, {
      config: session.project.config,
      secrets: this.secretResolver(session),
      bundle,
      workspace: { root: worktree, isWorktree: true },
      capabilities: (registry) => registerChangesetFunctions(registry),
      ...(request.fake !== undefined ? { fake: request.fake } : {}),
      ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
    });
    this.log({
      level: "info",
      source: "review",
      message: `reviewing ${changeset.changes.length} change(s) in ${request.taskId}'s worktree against ${request.base ?? "HEAD"}`,
      project: system.key,
      taskId: task.id,
    });
    return { reviewTaskId: task.id, changes: changeset.changes.length };
  }

  /**
   * Review a sync's proposals through the changeset gate — the "one mechanism" half of
   * CHANGESETS.md's opening claim, closing the loop the drafts map opened: same reviewer, same
   * decisions, same application step as a worktree review, with the LAYER ROOT as the workspace and
   * `tree: "base"` because the proposals exist only as data.
   *
   * The LOOPING review (flow 1, `changeset/review-loop`), not the single round: a `comment`
   * decision sends the changeset back to a model that revises it — under the same state-file and
   * prompts-folder rules the proposal was written under, against the same description
   * ({@link syncRespondPrompt}) — and the revision comes back to the gate. Merged and reverted
   * decisions settle the round exactly as before.
   *
   * The sync baseline moves in a continuation, when the run finishes with EVERY change of the final
   * round merged — a partially-accepted proposal leaves the drift standing, which is true: the
   * workflows still do not run what the description asks for.
   */
  async reviewSyncChangeset(request: ReviewSyncRequest): Promise<ReviewChangesResult> {
    const changeset = changesetOf(request.changeset);
    if (changeset.changes.length === 0) throw this.refusal("review", "the proposal has no changes to review");
    this.writable(request.layer);
    const root = request.layer === "base" ? jairaBasePaths(this.baseDir).baseDir : this.requireProject(request.project).paths.jairaDir;

    const system = this.sessionOf(SHARED_SESSION);
    if (system === undefined) {
      throw this.refusal("review", `the shared root could not be opened, so a review cannot be recorded: ${this.roleError.shared}`);
    }
    // The description the proposal exists to satisfy, for the respond rounds. Read from disk: the
    // draft the sync itself read is the renderer's, and by the time a comment comes back the disk
    // copy is the closest thing to a stable truth this side of the IPC boundary.
    let spec = "";
    try {
      const file = this.layerFile(request.path, request.layer, request.project);
      if (existsSync(file)) spec = readFileSync(file, "utf8");
    } catch {
      // Outside the root or unreadable — the reviewer still works; respond just loses the document.
    }
    const bundle = loadBundle(
      changesetReviewLoopFiles({
        tree: "base",
        prompt: "Review the sync's proposed files",
        respondPrompt: syncRespondPrompt(spec),
      }),
      CHANGESET_REVIEW_LOOP_ID,
    );
    const task = createTask(system.project, {
      title: `Review sync proposals · ${request.path}`,
      workflow: CHANGESET_REVIEW_LOOP_ID,
      inputs: { changeset: changeset as unknown as JsonValue },
      labels: ["jaira", "sync-review", request.layer],
      // The sync run this proposal came from. Recorded so the root listing can file this run under
      // the sync workflow's column instead of presenting `changeset/review-loop` as a top-level
      // workflow of its own — the review is a round OF the sync, and the record is what says so.
      ...(request.parentTaskId !== undefined ? { parentTaskId: request.parentTaskId } : {}),
    });
    // The TARGET's configuration, exactly as the sync itself resolves it — see {@link runSync}.
    const target = request.layer === "base" ? this.sessionOf(SHARED_SESSION) : this.sessionOf();
    // And the target's ROOT is what the gate's file reads are about: these proposals are paths under
    // the layer root, so a base-layer review reads the shared root — including when no user project
    // is open at all, which is the case the focused-project fallback could not answer.
    if (target !== undefined) system.subjectProject.set(task.id, target.dir);
    const started = await this.startRun(system, task.id, {
      config: target?.project.config ?? this.effectiveConfig(),
      secrets: this.secretResolver(target),
      bundle,
      workspace: { root, isWorktree: false },
      capabilities: (registry) => registerChangesetFunctions(registry),
      ...(request.fake !== undefined ? { fake: request.fake } : {}),
      ...(request.interactions !== undefined ? { interactions: request.interactions } : {}),
    });
    // The continuation, not the caller, moves the baseline: the gate parks on a human, and this
    // channel must return before they answer. A failure here is the run's own to report.
    void (async () => {
      try {
        await system.live.get(task.id)?.done;
        const run = system.project.runtime.get(task.id);
        if (run?.outcome !== "success" || run.outputsJson === undefined) return;
        // The loop terminates successfully only through `apply`, so `applied` present IS "the
        // review settled"; `decisions` are the FINAL round's — the ones the application acted on.
        const outputs = JSON.parse(run.outputsJson) as { applied?: string[]; decisions?: Array<{ decision?: string }> };
        const decisions = outputs.decisions ?? [];
        if (outputs.applied !== undefined && decisions.length > 0 && decisions.every((d) => d.decision === "merged")) {
          this.commitSyncRecord("states", request.path, request.layer, request.project);
        }
        this.publish({ type: "store:invalidate", scope: "workflows" });
      } catch {
        // The review run's own failure is already visible on its task; the baseline simply stays.
      }
    })();
    return { reviewTaskId: task.id, changes: changeset.changes.length };
  }

  /** Abort a sync in flight. False when there was nothing running. */
  cancelSync(): { canceled: boolean } {
    // Whichever holder has one in flight. The renderer sends no layer here, and a sync is one at a
    // time per holder, so "the one running" is unambiguous without being told.
    const running = this.syncHolders().filter((h) => h.syncTask !== undefined);
    if (running.length === 0) return { canceled: false };
    const system = this.sessionOf(SHARED_SESSION);
    // Cancelled as the TASK it is, so the row settles as `canceled` and the claim is released —
    // rather than aborting the work and leaving the record saying it is still going.
    for (const holder of running) if (system !== undefined) this.cancelTaskIn(system, holder.syncTask!);
    return { canceled: true };
  }

  /**
   * Where each proposed file goes, and whether it can be handed over as a draft.
   *
   * A proposal is a FILE now — a state file under `workflows/`, or a prompt file under `prompts/`
   * (the sync tells the model to keep reusable prompt text there rather than inline it). Four
   * things are decided here rather than by the model, because all four are questions about this
   * project rather than about the workflow:
   *
   *  - **Containment.** A path arrives from a language model by way of the renderer, and
   *    `../../.ssh/config` is a perfectly good relative path. {@link workflowFile} /
   *    {@link layerFile} are the same checks every other write rests on — and only the two
   *    directories a sync is entitled to write are accepted at all.
   *  - **The existing file.** A state authored as `.jsonc` keeps its suffix; one authored as YAML is
   *    reported and NOT offered, because handing JSON to a `.yaml` file would silently produce a
   *    state file in two syntaxes at once.
   *  - **Whether it changes anything.** A proposal identical to the file is dropped, so the tree
   *    marks only the files a person actually has to look at.
   *  - **Ownership.** A state another description owns is reported and NOT offered. The digest
   *    already renders such a subtree as a contract rather than as states, so a proposal reaching
   *    past the boundary is a model that inferred what it could not see — and applying it would let
   *    a parent document silently rewrite what a more specific one is the authority on. Reported
   *    rather than dropped, because it usually means the OTHER description is what needs changing.
   *    Prompt files have no owner: a prompt is a library entry, and reuse across descriptions is
   *    the point of the folder.
   */
  private placeEdits(
    edits: readonly SyncEdit[],
    ownership: DescriptionOwnership,
    layer: WorkflowLayer,
    project?: string,
  ): WorkflowSyncEdit[] {
    const out: WorkflowSyncEdit[] = [];
    const ownerOf = (stateId: string): DescriptionBoundary | undefined =>
      ownership.delegates.find((delegate) => isUnderState(stateId, delegate.root));
    for (const edit of edits) {
      // A blocked edit still names the file it would have touched, so the panel can say WHICH file
      // it declined to write rather than only that something was refused.
      const blocked = (path: string, reason: string, stateId?: string): WorkflowSyncEdit => ({
        ...(stateId !== undefined ? { stateId } : {}),
        layer,
        path,
        action: edit.action,
        text: edit.text,
        reason: edit.reason,
        requirements: edit.requirements,
        applicable: false,
        blocked: reason,
      });
      const place = (path: string, stateId?: string): void => {
        const file = this.layerFile(path, layer, project);
        const exists = existsSync(file);
        if (exists && hashText(readFileSync(file, "utf8")) === hashText(edit.text)) return;
        out.push({
          ...(stateId !== undefined ? { stateId } : {}),
          layer,
          path,
          // What the model called it is a claim about the project, and the project is right here.
          action: exists ? "update" : "create",
          text: edit.text,
          reason: edit.reason,
          requirements: edit.requirements,
          applicable: true,
        });
      };
      const raw = syncEditPath(edit.path);
      if (raw.startsWith("prompts/")) {
        try {
          this.layerFile(raw, layer, project);
        } catch (e) {
          out.push(blocked(raw, (e as Error).message));
          continue;
        }
        place(raw);
        continue;
      }
      if (!raw.startsWith("workflows/")) {
        out.push(blocked(raw, "a sync may only propose files under workflows/ or prompts/"));
        continue;
      }
      const stateId = raw.slice("workflows/".length).replace(/\.(json|jsonc|ya?ml)$/i, "");
      try {
        this.workflowFile(stateId, layer, project);
      } catch (e) {
        out.push(blocked(`workflows/${stateId}.json`, (e as Error).message, stateId));
        continue;
      }
      const owner = ownerOf(stateId);
      if (owner !== undefined) {
        out.push(
          blocked(
            this.existingStateFile(stateId, layer, project) ?? `workflows/${stateId}.json`,
            `\`${owner.document}\` describes this state — change that document instead`,
            stateId,
          ),
        );
        continue;
      }
      const existing = this.existingStateFile(stateId, layer, project);
      if (existing !== undefined && /\.ya?ml$/i.test(existing)) {
        out.push(blocked(existing, "this state is authored as YAML, and the proposal is JSON", stateId));
        continue;
      }
      place(existing ?? `workflows/${stateId}.json`, stateId);
    }
    return out;
  }

  /** The layer-relative path of a state's file, when the layer already has one. */
  private existingStateFile(stateId: string, layer: WorkflowLayer, project?: string): string | undefined {
    for (const suffix of [".json", ".jsonc", ".yaml", ".yml"]) {
      const path = `workflows/${stateId}${suffix}`;
      try {
        if (existsSync(this.layerFile(path, layer, project))) return path;
      } catch {
        return undefined; // outside the root — the caller has already refused it
      }
    }
    return undefined;
  }

  /**
   * Remember what a sync proposed, so saving it can be recognised as accepting it.
   *
   * In memory, and deliberately: this is about a proposal someone is looking at right now, and one
   * that outlived the window would credit a save made a week later to a sync nobody remembers
   * running. Losing it costs nothing but a stale baseline, which the next sync corrects.
   */
  private beginPendingSync(
    direction: SyncDirection,
    document: string,
    layer: WorkflowLayer,
    targets: string[],
    project?: string,
  ): void {
    this.syncHolder(layer).pendingSync = {
      direction,
      document,
      layer,
      ...(project !== undefined ? { project } : {}),
      remaining: new Set(targets),
    };
  }

  /**
   * Where a description's in-flight sync state lives — the holder that owns the DOCUMENT.
   *
   * A base-layer description belongs to the shared root, which is the system project — so its
   * proposal survives a user project being switched underneath it, which it did not when this was one
   * field on the service.
   *
   * {@link detachedSync} is the fallback for one case only: a machine where the system project could
   * not be opened at all (see {@link roleError}). The shared root is still syncable there, in
   * memory, exactly as it was before it had a database.
   */
  private syncHolder(layer: WorkflowLayer): SyncHolder {
    const session = layer === "base" ? this.sessionOf(SHARED_SESSION) : this.sessionOf();
    return session ?? this.detachedSync;
  }

  /** Every holder a write could settle a proposal in. */
  private syncHolders(): SyncHolder[] {
    return [...this.sessions.values(), this.detachedSync];
  }

  /**
   * A file was written; if it was the last thing a pending sync proposed, the two are now in step.
   *
   * Saving a target counts as accepting it even when the text was edited on the way — someone who
   * reworded the rewritten document still took the sync, and refusing to record that would leave
   * them with a baseline that can never be reached except by accepting a proposal verbatim.
   */
  private noteSyncWrite(layer: WorkflowLayer, path: string): void {
    // Every session's, because a write names a layer and a path but not whose proposal it settles —
    // and a base-layer document's proposal is owned by a different session than a project file's.
    for (const holder of this.syncHolders()) {
      const pending = holder.pendingSync;
      if (pending === undefined) continue;
      if (!pending.remaining.delete(docKey(layer, path))) continue;
      if (pending.remaining.size > 0) continue;
      holder.pendingSync = undefined;
      this.commitSyncRecord(pending.direction, pending.document, pending.layer, pending.project);
    }
  }

  /**
   * Record that the description and the state files agree, as of what is on disk right now.
   *
   * Both sides are re-read here rather than reused from the run: the point of the baseline is that
   * the pair agreed at one instant, and half of it taken before the save would describe a state of
   * the project that never existed.
   */
  private commitSyncRecord(direction: SyncDirection, document: string, layer: WorkflowLayer, project?: string): void {
    let source: LayerSource;
    let text = "";
    try {
      source = this.syncSource(layer, project);
      const file = this.layerFile(document, layer, project);
      if (existsSync(file)) text = readFileSync(file, "utf8");
    } catch {
      // The project closed between the proposal and the save, or the document moved out from under
      // it. A baseline is a convenience; losing one costs a stale status line, which the next sync
      // corrects.
      return;
    }
    // The same scope the status reads back, or the baseline would be taken over files this
    // description was never answerable for and every unrelated edit would read as drift.
    const covered = new Set(this.ownedFiles(source, document));
    commitSync(source.paths.syncFile, {
      document,
      documentHash: hashText(text),
      states: stateHashes(source.paths.workflowsDir, covered),
      direction,
      at: Date.now(),
    });
  }

  /**
   * The project-layer state files ONE description is answerable for, relative to `.jaira/workflows/`.
   *
   * Its subtree minus everything a nearer description owns — see `persistence/descriptions.ts`. That
   * subtraction is what keeps a baseline honest once descriptions nest: `feature.md` must not claim
   * agreement about files `feature/plan.md` is the authority on, or accepting one sync would settle
   * a document nobody looked at.
   *
   * Empty when the root does not load — a half-written state file must not silently narrow the
   * baseline to the states that still parse, and the sync itself refuses over the same condition.
   */
  private ownedFiles(source: LayerSource, document: string): string[] {
    try {
      const scope = this.scopeOf(source, document);
      return digestSource(source, scope.digestOptions).files;
    } catch {
      return [];
    }
  }

  /**
   * What one description covers: the roots it is judged against, and the subtrees it stops at.
   *
   * The single place ownership is turned into digest options, so the status line, the baseline and
   * the run cannot disagree about where a description's responsibility ends. They did not have to
   * agree before there was more than one description per layer; now a mismatch between them would
   * show as a sync that reports drift it can never clear.
   */
  private scopeOf(
    source: LayerSource,
    document: string,
  ): { root: string | null; ownership: DescriptionOwnership; digestOptions: WorkflowDigestOptions } {
    const browser = browseSource(source);
    const descriptions = listDescriptions(source.paths.workflowsDir);
    const states = [...new Set(browser.workflows.flatMap((w) => w.states))];
    const ownership = ownershipOf(document, descriptions, states);
    const boundaries = ownership.delegates.map((delegate) => ({
      stateId: delegate.root,
      document: delegate.document,
      ...this.descriptionText(source, delegate.document),
    }));
    return {
      root: ownership.root,
      ownership,
      digestOptions: {
        ...(ownership.root === null ? {} : { roots: [ownership.root] }),
        ...(boundaries.length > 0 ? { boundaries } : {}),
      },
    };
  }

  /** A description's prose, for the digest to hand a parent. Absent when it cannot be read. */
  private descriptionText(source: LayerSource, document: string): { text?: string } {
    try {
      const file = join(source.paths.jairaDir, ...document.split("/"));
      return existsSync(file) ? { text: readFileSync(file, "utf8") } : {};
    } catch {
      return {};
    }
  }

  /**
   * Which root a description is judged against, and where its baseline lives.
   *
   * The layer decides, and nothing else does. A description in the shared root is checked against
   * the SHARED root's workflows and recorded in `~/.jaira/sync.json` — the same answer whether a
   * project is open, none is, or a different one is tomorrow. That is the whole reason this is a
   * function of the layer: judging a machine-global document against whichever checkout happened to
   * be open would give it an answer that changed per window, and writing that answer into that
   * project's baseline would scatter one document's history across every project on the machine.
   *
   * Throws for a project-layer path with no project open, which is a caller that should have
   * checked; {@link syncStatus} reports that case as a `blocked` line instead.
   */
  private syncSource(layer: WorkflowLayer, project?: string): LayerSource {
    return layer === "base" ? baseSource(this.baseDir) : projectSource(this.p(project));
  }

  // --- internals -------------------------------------------------------------

  /**
   * The states that declare `stateId` as a child.
   *
   * Empty with no project named: the reference graph is built from a project's browser, and a
   * base-only edit has nothing to check against. That is a real limitation rather than a safe
   * default — a shared state renamed with no project open can still break a project that used it —
   * so it is worth saying out loud rather than implying the check always ran.
   *
   * Asked of ONE project rather than of every open one. The answer is what a confirmation dialog
   * says before a rename, and "seven states reference this" is only useful if a person can tell
   * which project's seven; the project a delete came FROM is the one it is about.
   */
  private referrersOf(stateId: string, project?: string): string[] {
    const open = this.sessionOf(project);
    if (open === undefined) return [];
    try {
      return stateView(open.project, stateId, this.browseWorkflowsIn(open), this.stateViewOptions()).referencedBy;
    } catch {
      // A broken workflow cannot answer "who references this"; that is not a reason to block a
      // delete, and the lint surface is already reporting the breakage.
      return [];
    }
  }

  /**
   * The states whose child declarations would stop resolving if everything in `states` moved away.
   *
   * Not simply "the referrers", because a directory move takes referrer and target together and most
   * of them survive it. A child declared the idiomatic way — by KEY, or `./name` (WORKFLOWS.md §6) —
   * resolves relative to the state declaring it, so `workflows/feature/` renamed to `workflows/epic/`
   * leaves every internal link intact. A child declared by absolute id does not: it still names the
   * old path. So the question is asked of the authored declaration rather than of the resolved graph,
   * which is the only place the difference between the two survives.
   *
   * The consequence of getting this wrong in either direction is a check nobody reads: refuse every
   * folder rename and the confirmation becomes a keystroke, refuse none and the first thing you learn
   * about a broken workflow is a run that failed to load.
   */
  private brokenBy(states: string[], project?: string): string[] {
    const open = this.sessionOf(project);
    if (open === undefined || states.length === 0) return [];
    const moving = new Set(states);
    const broken = new Set<string>();
    for (const entry of this.browseWorkflowsIn(open).files) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(join(entry.root, entry.file), "utf8"));
      } catch {
        // Unreadable or mid-edit: the lint surface is already reporting it, and a file nobody can
        // parse is not evidence that a rename is safe OR that it is not.
        continue;
      }
      const children = (doc as { children?: Record<string, unknown> } | null)?.children;
      if (children === null || typeof children !== "object") continue;
      for (const [key, decl] of Object.entries(children)) {
        const named = (decl as { state?: unknown } | null)?.state;
        const isRelative = typeof named !== "string" || named.startsWith("./");
        const target = isRelative
          ? `${entry.stateId}/${typeof named === "string" ? named.slice(2) : key}`
          : named;
        // A relative declaration inside the moving set travels with its target; everything else that
        // points into the set is left naming a state that will not be there.
        if (moving.has(target) && !(isRelative && moving.has(entry.stateId))) broken.add(entry.stateId);
      }
    }
    return [...broken].sort();
  }

  /**
   * The state ids a path covers: one for a state file, all of them for a directory, none otherwise.
   *
   * Derived from the path the same way the tree derives it — the id is the location under
   * `workflows/` — because a check that disagreed with the loader about which state a file is would
   * protect the wrong thing.
   */
  private statesUnder(file: string, layer: WorkflowLayer, project?: string): string[] {
    const workflowsDir =
      layer === "base" ? jairaBasePaths(this.baseDir).workflowsDir : this.requireProject(project).paths.workflowsDir;
    const idOf = (path: string): string | null => {
      const rel = relative(workflowsDir, path).split(sep).join("/");
      if (rel.length === 0 || rel.startsWith("..")) return null;
      return /\.(json|ya?ml)$/i.test(rel) ? rel.replace(/\.(json|ya?ml)$/i, "") : null;
    };
    const out: string[] = [];
    const walk = (path: string): void => {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        return;
      }
      if (!stat.isDirectory()) {
        const id = idOf(path);
        if (id !== null) out.push(id);
        return;
      }
      for (const entry of readdirSync(path)) walk(join(path, entry));
    };
    walk(file);
    return out.sort();
  }

  /**
   * The absolute file a `(path, layer)` pair names, refusing anything outside the layer's root.
   *
   * The whole-root twin of {@link workflowFile}, for the operations addressed by path rather than by
   * state id. One implementation for create, rename and delete: three copies of a containment check
   * is how two of them stay right and the third quietly does not.
   */
  /**
   * One containment check, shared by both address spaces.
   *
   * A path that escapes its root is refused rather than clamped: `../../etc/passwd` is not a typo to
   * be helpfully corrected, and the two resolvers must agree about that or the stricter one is the
   * only one anybody tests.
   */
  private contained(root: string, path: string, layer: WorkflowLayer): string {
    const file = resolvePath(root, path);
    const rel = relative(root, file);
    if (rel.startsWith("..") || rel.length === 0 || resolvePath(root, rel) !== file) {
      throw this.refusal("file", `'${path}' is not inside the ${layer} root`);
    }
    return file;
  }

  /**
   * A Files-view path, as the LAYER would spell it — or `undefined` for a file outside the layer.
   *
   * The bridge between the two address spaces {@link treeFile} describes. A project's paths are
   * relative to the checkout, and three things still key on the layer's own shape: `mimeOfPath`
   * knows a workflow by its `workflows/` prefix, `stateIdOf` derives an id the same way, and
   * `settings.json` is recognised by being exactly that. Handing any of them `.jaira/workflows/x.json`
   * gets a plain JSON file and no state — silently, which is the failure worth naming here.
   *
   * Measured rather than assumed to be `.jaira`, for the reason `prefixOf` is in the tree: a root
   * whose layer sits directly under it has no prefix at all, and hard-coding one makes every file in
   * it stop being a workflow.
   */
  private layerPathOf(path: string, layer: WorkflowLayer, project?: string): string | undefined {
    // The shared root and the built-in layer ARE their layer roots, so a path in either is already spelled the layer's way.
    if (layer === "base" || layer === "system") return path;
    const paths = this.requireProject(project).paths;
    const prefix = relative(paths.projectDir, paths.jairaDir).split(sep).join("/");
    if (prefix.length === 0) return path;
    if (path === prefix) return "";
    return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
  }

  /**
   * The absolute file a `(path, layer)` pair names in the FILES VIEW's address space.
   *
   * There are two, and they differ for exactly one layer:
   *
   *  - **`project`** is rooted at the CHECKOUT here, and at `.jaira/` in {@link layerFile}. The tree
   *    draws the checkout, so a row in it is addressed the way it is drawn — `README.md`, or
   *    `.jaira/workflows/feature/plan.json` with the prefix it visibly has.
   *  - **`base`** is `~/.jaira` in both, because the shared root IS its layer root. Nothing about
   *    the base changes.
   *
   * Two spaces rather than one because two different things address files. The workflow SYNC writes
   * `workflows/x.json` and `prompts/y.md` — paths it derives from a layer's own shape, with no
   * checkout in the picture — and it must keep landing in `.jaira/`. Folding them together would
   * either put a synced workflow at the top of somebody's repository or make every tree row carry a
   * prefix the tree does not show. The containment check is the same in both, and is the reason
   * either exists: one implementation for create, rename and delete, because three copies of a
   * containment check is how two of them stay right and the third quietly does not.
   */
  private treeFile(path: string, layer: WorkflowLayer, project?: string): string {
    // The built-in layer (decision 0006) IS its layer root, as the shared one is, so both address
    // spaces name the same directory for it.
    const root =
      layer === "system"
        ? jairaBuiltInPaths().dir
        : layer === "base"
          ? jairaBasePaths(this.baseDir).baseDir
          : this.requireProject(project).paths.projectDir;
    return this.contained(root, path, layer);
  }

  private layerFile(path: string, layer: WorkflowLayer, project?: string): string {
    const root =
      layer === "system"
        ? jairaBuiltInPaths().dir
        : layer === "base"
          ? jairaBasePaths(this.baseDir).baseDir
          : this.requireProject(project).paths.jairaDir;
    return this.contained(root, path, layer);
  }

  /**
   * Refuse a write into the built-in layer (decision 0006).
   *
   * What ships is the app's, and the app never writes there: an "override" is a copy UP into the
   * shared root or the project, which is a write to one of THOSE. Called at the top of every surface
   * that takes a layer and changes a file — before the path is even resolved — so the rule is one
   * sentence in one place rather than a property each path helper has to remember. Until this
   * existed a `system` layer fell through every `layer === "base" ? … : …` below as `project`, which
   * is not a write into the app but is not what anybody asked for either.
   */
  private writable(layer: WorkflowLayer): asserts layer is WritableLayer {
    if (!isWritableLayer(layer)) {
      throw this.refusal(
        "file",
        "what ships with JaiRA is read-only — copy it into the shared root or into this project to change it",
      );
    }
  }

  /**
   * The absolute file a `(stateId, layer)` pair names, refusing anything outside the layer's root.
   *
   * This is the containment check the write surface rests on. A state id arrives from the renderer
   * — the untrusted half of the boundary (DESIGN §11.2) — and `../../.ssh/authorized_keys` is a
   * perfectly good relative path. Resolving first and then proving the result is still under the
   * root is the check that cannot be fooled by encoding tricks, because it tests the answer rather
   * than the input. An absolute `rel` is its own escape: on Windows, a file on another drive has no
   * relative path from the root, so `relative` hands back the absolute one — no `..` in sight.
   */
  private workflowFile(stateId: string, layer: WorkflowLayer, project?: string): string {
    const root =
      layer === "system"
        ? jairaBuiltInPaths().workflowsDir
        : layer === "base"
          ? jairaBasePaths(this.baseDir).workflowsDir
          : this.requireProject(project).paths.workflowsDir;
    const file = resolvePath(root, `${stateId}.json`);
    const rel = relative(root, file);
    if (rel.startsWith("..") || rel.length === 0 || isAbsolute(rel) || resolvePath(root, rel) !== file) {
      throw this.refusal("file", `'${stateId}' does not name a state inside the ${layer} workflows directory`);
    }
    return file;
  }

  /**
   * How prompt states reach whatever answers them, from this project's configuration.
   *
   * One helper for all three run paths (a task, a CLI-less sync, an ad-hoc run) because they must
   * agree: a workflow that runs from the board and refuses from the sync panel is a bug that looks
   * like a configuration problem. It supplies three things `buildPromptExecutor` used to do without —
   * the provider routes with their credentials RESOLVED (a key in the keychain never used to reach the
   * SDK at all), the named presets a state can select with `configRef`, and the agent executors a
   * model prefix can name.
   *
   * A scripted run gets none of it: the fake executor answers everything and building a real transport
   * beside it would be spawning nothing useful.
   */
  private promptWiring(
    config: JairaConfigOf,
    opts: { fake?: boolean; memoCache?: MemoCache; secrets?: SecretResolver; observer?: ExecObserver } = {},
  ): {
    router?: ReturnType<typeof modelRouterOptions>;
    routes?: ReturnType<typeof agentPromptRoutes>;
    configs?: { get(id: string): Record<string, JsonValue> | undefined };
    definitions?: JairaConfigOf["executors"];
    memoCache?: MemoCache;
  } {
    if (opts.fake) return {};
    const presets = config.models.presets;
    return {
      router: modelRouterOptions(config.models, opts.secrets ?? this.secretResolver()),
      routes: agentPromptRoutes(config.agents, {
        execEnv: config.execEnvironment,
        // The job observer, so an agent a PROMPT op starts is recorded exactly like one an agent
        // FUNCTION op starts. Without it `agentPromptRoutes` builds its own unobserved spawn and
        // every agent reached through a model prefix spawns unrecorded: no `kind='process'` row, no
        // heartbeat, and — the part that bites — nothing for `JobStore.orphans()` to find, which is
        // the one query written to catch a `claude` still running and still billing after its run
        // stopped. The CLI has always passed this (`cli.ts`); the app never did, so the two drivers
        // disagreed about what a run leaves behind — and the app is the one with a Stop button.
        ...(opts.observer !== undefined ? { observer: opts.observer } : {}),
        startBridge: this.startBridge,
      }),
      ...(presets !== undefined ? { configs: { get: (id: string) => presets[id] } } : {}),
      // The named stacks. Each becomes a route keyed by its name, so a state naming `review/…` gets
      // the executor this project built rather than whatever the prefix would otherwise have meant.
      ...(Object.keys(config.executors).length > 0 ? { definitions: config.executors } : {}),
      ...(opts.memoCache !== undefined ? { memoCache: opts.memoCache } : {}),
    };
  }

  /**
   * What this tree leaves out: the layered `config.files.hidden`, then the person's own list.
   *
   * Compiled per CALL rather than cached, because both halves can change under the app — a config
   * write, a settings write, a project opened — and a stale filter is a folder that will not come
   * back until a restart. A tree walk costs orders of magnitude more than compiling five globs.
   */
  private hiddenRulesFor(config: JairaConfigOf): HiddenRules {
    return compileHidden(hiddenRules(config.files.hidden, this.readSettings().filesHidden));
  }

  /** The merged configuration, or plain defaults when no project is open. */
  private effectiveConfig(): JairaConfigOf {
    const open = this.sessionOf();
    if (open) return open.project.config;
    const doc = readJsonIfPresent(jairaBasePaths(this.baseDir).settingsFile);
    return parseConfig(doc ?? {});
  }

  /**
   * The secret chain, anchored on one project.
   *
   * `target` names WHOSE `.env` chain is searched, which is not always the project a run is recorded
   * in: a system run syncing a user project's description resolves that project's credentials, not
   * the shared root's. Absent ⇒ the focused project, which is every ordinary caller.
   */
  private secretResolver(target?: ProjectSession): SecretResolver {
    const keychain = this.options.keychain;
    const anchor = target ?? this.sessionOf();
    return new SecretResolver({
      ...(anchor !== undefined ? { projectDir: anchor.dir } : {}),
      baseDir: this.baseDir,
      ...(keychain?.available() === true ? { keychain: (name: string) => keychain.get(name) } : {}),
    });
  }

  /**
   * The project a `project`-layer address is in.
   *
   * `project` names a LAYER, not a project, and the window holds several (SHELL.md §2.2) — so the
   * pair is what identifies a file. Resolved through {@link session}, which means an address that
   * names no project is answerable exactly while there is nothing to choose between, and reports
   * "several projects are open, so this call must name one" the moment there is.
   */
  private requireProject(ref?: string): Project {
    return this.session(ref).project;
  }

  private requireProjectDir(ref?: string): string {
    return this.requireProject(ref).paths.projectDir;
  }
}

/**
 * "There is nothing to continue here" — as distinct from "this went wrong".
 *
 * The two used to be one `Error`, so the only caller that can tell them apart could not: `chatPlan`
 * asks a question whose answer is legitimately no, and it had to either swallow a missing snapshot
 * along with it or report a composite as a failure. It chose the second, and every click on a
 * composite wrote a stack trace into the main process log.
 *
 * Thrown for the four ordinary quiets — a task that has never run, an instance that is not in this
 * run's projection, a path with no state that speaks, and a state that reached no model call.
 * Everything else stays an ordinary `Error` and keeps being one for both callers: `chatSend` still
 * reports all of it, because a message someone typed and pressed Enter on deserves a reason.
 */
class NoConversationHere extends Error {}

type SecretTargetOf = SetSecretRequest["target"];
type JairaConfigOf = ReturnType<typeof parseConfig>;

/** Read a JSON document, or null when the file is absent. A malformed one is still an error. */
function readJsonIfPresent(file: string): JsonValue | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as JsonValue;
}

/** Where the shared root lives when the service was given no explicit override. */
function settingsBaseDir(): string | undefined {
  // `JAIRA_HOME` wins over the saved preference: an explicit environment is how a test or a one-off
  // invocation points elsewhere, and a stored setting must not silently override the command that
  // launched the process. With neither, `jairaBasePaths` falls back to `~/.jaira`.
  const fromEnv = process.env["JAIRA_HOME"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const saved = readSettingsFile(jairaBasePaths().baseDir);
  return saved.baseDir;
}

function readSettingsFile(baseDir: string): JairaSettings {
  const file = jairaBasePaths(baseDir).userSettingsFile;
  if (!existsSync(file)) return defaultSettings();
  try {
    return parseSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // A corrupt preferences file must never stop the app opening — defaults are a fine answer.
    return defaultSettings();
  }
}

/**
 * Set or remove one key in a `.env` file, leaving every other line exactly as it was.
 *
 * Rewriting the file from a parsed map would be simpler and wrong: these files are hand-edited and
 * hold comments and grouping that carry meaning to whoever wrote them. An in-place edit of the one
 * matching line is what makes this safe to point at a file the user also maintains by hand.
 */
function writeEnvEntry(file: string, name: string, value: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const matches = (line: string): boolean =>
    new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*=`).test(line);
  const remaining = lines.filter((line) => !matches(line));
  if (value.length > 0) {
    // Quoted, because a key can contain characters an unquoted value would truncate at.
    remaining.push(`${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  const text = remaining.filter((line, i) => !(line === "" && i === remaining.length - 1)).join("\n");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.length > 0 ? `${text}\n` : "", "utf8");
}

/**
 * A stored record's messages, as turns the viewer can render.
 *
 * Kept close to what the provider returned: `content` is a string for an ordinary turn and an array
 * of parts (text, tool calls, tool results, reasoning) for an agent's. Text is lifted out because
 * every viewer wants it; the rest is passed through structured, because pairing a tool call with its
 * result is the viewer's job and flattening it here would make that impossible.
 */
function turnOf(raw: JsonValue): SessionTurn {
  const message = (raw ?? {}) as { role?: unknown; content?: unknown };
  const role = typeof message.role === "string" ? message.role : "assistant";
  if (typeof message.content === "string") return { role, text: message.content };
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts
    .filter((p): p is { type: string; text: string } => (p as { type?: unknown })?.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
  return {
    role,
    ...(text.length > 0 ? { text } : {}),
    ...(parts.length > 0 ? { parts: parts as JsonValue } : {}),
  };
}

/**
 * A record's conversation as turns, each wearing the clocks the stream measured for it.
 *
 * Every message a record holds is a message that record CONTRIBUTED — its entries are the turns this
 * call added, a session's messages are its records concatenated
 * (`materialize`), and a fork inherits its prefix by lineage rather than by copying. So there is
 * nothing to subtract here, and this used to try: it dropped a leading run of messages whenever a
 * record happened to begin with the previous record's list in full, which is a shape nothing writes
 * and which cost a repeated exchange its second copy (ask the same question twice, get the same
 * answer twice, and the second pair vanished).
 *
 * The clocks ride ON each turn (`entry.timing`), so there is no alignment to get right. A record
 * with no times — written before turns were timed, or by a transport that never streamed — yields
 * turns without them rather than zeros.
 *
 * The PARTIAL entry is included, deliberately. It is the turn that was being written when a run was
 * stopped, and a conversation that showed the question and then nothing is what the record used to
 * give a person who pressed stop. It is excluded from `messagesOfRecord` instead, which is the read
 * that goes back on the wire — the one place a half-written turn must never appear.
 * */
function turnsOf(value: JsonValue | undefined): SessionTurn[] {
  const entries = (value as { value?: { entries?: JsonValue[] } } | undefined)?.value?.entries;
  if (!Array.isArray(entries)) return [];
  const turns: SessionTurn[] = [];
  for (const raw of entries) {
    const entry = raw as { kind?: unknown; role?: unknown; content?: JsonValue; sidechain?: unknown; timing?: unknown } | null;
    if (entry === null || typeof entry !== "object") continue;
    // Events are not turns, and a subagent's turns belong to the call that spawned it.
    if (entry.kind !== "message" || entry.sidechain !== undefined) continue;
    const turn = turnOf({ role: entry.role, content: entry.content } as JsonValue);
    const timing = (entry.timing ?? {}) as { at?: unknown; startedAt?: unknown; thoughtMs?: unknown };
    turns.push({
      ...turn,
      ...(typeof timing.at === "number" ? { at: timing.at } : {}),
      ...(typeof timing.startedAt === "number" ? { startedAt: timing.startedAt } : {}),
      ...(typeof timing.thoughtMs === "number" ? { thoughtMs: timing.thoughtMs } : {}),
    });
  }
  return turns;
}

/**
 * What one record contributes to a thread — its own turns, plus the two things an INTERRUPTED one
 * leaves in places nobody used to look.
 *
 * Written once and used twice: for the conversation on screen and for the branches beside it (see
 * `SqliteSessionStore.forks`). A branch that was rendered by different code would be a second answer
 * to "what did this record say", and the whole point of showing it is that it is the same kind of
 * thing as what it sits beside.
 */
function turnsSaidBy(row: { value?: JsonValue; status: "open" | "completed" | "failed" | "interrupted" }): SessionTurn[] {
  // Everything this record said, INCLUDING the turn that was still being written when it stopped —
  // that is an entry of its own, marked `partial`, sitting where it happened. It used to live in a
  // field beside the conversation and be appended back on at display time, which is why a stopped
  // run once showed the question and then nothing.
  return turnsOf(row.value);
}


/**
 * Where a record's structured output actually IS — see {@link SessionOutput}.
 *
 * Every half of this is already in the record and none of it was reachable from the read side. The
 * bound value sits at `value.value.value`: the row wraps an `LlmOutput`, and that carries the value
 * the call was read as beside the messages it produced. The schema and the slot's name sit on
 * `request.output`, pinned when the record was opened and never recomputed.
 *
 * Two places are searched, in the order a reader would want them found. A MESSAGE whose text parses
 * and equals the bound value is the answer written as prose-shaped JSON, and the LAST such turn
 * wins — the answer is the last thing a call says, and a model that quoted the same value earlier
 * quoted it, whereas the final turn IS it. Failing that, a TOOL CALL whose arguments equal it: the
 * agent transports deliver a structured output by calling a tool with the value as its input, and
 * that reached the transcript as a collapsed grey row.
 *
 * Text first, and it only matters in a case that should not arise (a call that both wrote the value
 * and passed it to a tool). The message is what a reader is looking at, so it wins.
 *
 * Objects and arrays only. A `kind: "text"` output binds to the string the model wrote, so every
 * assistant turn in a text-mode call would match trivially — and the "structured" rendering of a
 * string is markdown, which is already what a message gets. Nothing to gain and a renderer to lose.
 * Real records make this concrete: five of them declare a `json` output with no schema and bind the
 * agent's whole PROSE answer, and a rule that keyed off the declaration would quote all five.
 *
 * Never matched on the tool's NAME, for the reason `producedArtifact` does not either: the name
 * belongs to whichever transport ran, a name test would have to be kept in step with every one of
 * them, and it would answer wrongly the first time it was not.
 *
 * Exported for its own test: it is the whole of the decision, and the surfaces that call it are
 * database-shaped.
 */
export function structuredOutputOf(
  row: { value?: JsonValue; request?: JsonValue },
  said: readonly SessionTurn[],
): SessionOutput | undefined {
  const llm = (row.value as { value?: { value?: JsonValue; toolCalls?: JsonValue } } | undefined)?.value;
  const bound = llm?.value;
  if (bound === undefined || bound === null || typeof bound !== "object") return undefined;
  const wanted = JSON.stringify(bound);
  const slot = (row.request as { output?: { schema?: JsonValue; name?: unknown } } | undefined)?.output;
  const found = (where: { turn: number } | { callId: string }): SessionOutput => ({
    ...where,
    value: bound,
    ...(slot?.schema !== undefined ? { schema: slot.schema } : {}),
    ...(typeof slot?.name === "string" && slot.name.length > 0 ? { name: slot.name } : {}),
  });

  for (let i = said.length - 1; i >= 0; i -= 1) {
    const turn = said[i]!;
    if (turn.role !== "assistant" || turn.text === undefined) continue;
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(turn.text) as JsonValue;
    } catch {
      continue;
    }
    if (JSON.stringify(parsed) === wanted) return found({ turn: i });
  }

  // `LlmOutput.toolCalls` rather than the turns' parts: it is the normalised list — one shape
  // whatever the transport put on the wire — and the id in it is the same id the viewer pairs by.
  const calls = Array.isArray(llm?.toolCalls) ? (llm.toolCalls as JsonValue[]) : [];
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i] as { toolCallId?: unknown; input?: JsonValue } | null;
    if (call === null || typeof call !== "object") continue;
    if (typeof call.toolCallId !== "string" || call.toolCallId.length === 0) continue;
    if (JSON.stringify(call.input) === wanted) return found({ callId: call.toolCallId });
  }
  return undefined;
}

/**
 * The record's subagent conversations, as turns — DERIVED from the entries that carry the call that
 * spawned them, the way every other reading of a record is derived from the same one array.
 *
 * It used to read `LlmOutput.sidechains`, a second key space holding the same conversation. Upstream
 * folds them into `entries` with a `sidechain` marker, so the grouping happens here, on read.
 */
function sidechainsOf(value: JsonValue | undefined): Record<string, SessionTurn[]> | undefined {
  const entries = (value as { value?: { entries?: JsonValue[] } } | undefined)?.value?.entries;
  if (!Array.isArray(entries)) return undefined;
  const out: Record<string, SessionTurn[]> = {};
  for (const raw of entries) {
    const entry = raw as { kind?: unknown; role?: unknown; content?: JsonValue; sidechain?: { id?: unknown } } | null;
    if (entry === null || typeof entry !== "object" || entry.kind !== "message") continue;
    const call = entry.sidechain?.id;
    if (typeof call !== "string") continue;
    (out[call] ??= []).push(turnOf({ role: entry.role, content: entry.content } as JsonValue));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The record's provider events, each pinned to how many of the record's turns preceded it.
 *
 * The pin is COMPUTED now rather than stored. Upstream used to keep the events in an array of their
 * own carrying an `index`, which every reader had to splice back — and this one got it wrong on real
 * data, subtracting an "inherited prefix" that was the previous record's length, so in an ordinary
 * chat every event after the first collapsed onto index 0 and rendered above the turn it followed.
 * The events are entries now, sitting where they happened, so the index is just how many message
 * entries came before — which is arithmetic that cannot drift from the thing it describes.
 */
function recordEventsOf(value: JsonValue | undefined): Array<{ index: number; event: JsonValue }> | undefined {
  const entries = (value as { value?: { entries?: JsonValue[] } } | undefined)?.value?.entries;
  if (!Array.isArray(entries)) return undefined;
  const out: Array<{ index: number; event: JsonValue }> = [];
  let turns = 0;
  for (const raw of entries) {
    const entry = raw as { kind?: unknown; sidechain?: unknown; event?: { data?: JsonValue } } | null;
    if (entry === null || typeof entry !== "object") continue;
    // A subagent's rows belong to its own chain, not to the main thread's count.
    if (entry.sidechain !== undefined) continue;
    if (entry.kind === "message") turns += 1;
    else if (entry.kind === "event" && entry.event?.data !== undefined) out.push({ index: turns, event: entry.event.data });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The agent's captured session facts, as the transcript reads them — DERIVED from the record's
 * entries rather than stored beside them.
 *
 * The capture used to ride the payload as `nativeLines`, a second encoding of the same conversation
 * with no key joining it to the first; it is merged into the entries at close now (RECORDS.md). What
 * the transcript wants out of it is unchanged — the non-message facts, in order — so this rebuilds
 * exactly those rows and nothing else. `index` counts the main-chain MESSAGES that precede each
 * one, which is what the woven position means.
 *
 */
function nativeOf(value: JsonValue | undefined): Array<{ index: number; line: JsonValue }> | undefined {
  const payload = (value as { value?: { entries?: unknown } } | undefined)?.value;
  if (!Array.isArray(payload?.entries)) return undefined;
  const out: Array<{ index: number; line: JsonValue }> = [];
  let messages = 0;
  for (const raw of payload.entries) {
    const entry = raw as { kind?: unknown; sidechain?: unknown; event?: { type?: unknown; data?: unknown }; uuid?: unknown; timestamp?: unknown };
    if (entry?.sidechain !== undefined) continue;
    if (entry?.kind === "message") {
      messages += 1;
      continue;
    }
    if (entry?.kind !== "event" || typeof entry.event?.type !== "string") continue;
    // Rebuilt in the shape the reader knows: the event's own type at the top, its fields beside it.
    const data = entry.event.data;
    const line = {
      type: entry.event.type,
      ...(typeof entry.uuid === "string" ? { uuid: entry.uuid } : {}),
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      ...(data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, JsonValue>) : {}),
    } as JsonValue;
    out.push({ index: messages, line });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The token counts and cost provenance off one `operation.completed`.
 *
 * Read defensively, field by field: `metrics` is an open record written by whichever executor ran,
 * and different ones report different subsets — the Claude Code CLI reports a cost it was told by
 * the provider, codex reports tokens and deliberately no cost at all. Absent stays absent rather
 * than becoming zero, because "not reported" and "none" are different claims and the panel says so.
 */
function runMetricsOf(metrics: unknown): RunMetrics | undefined {
  if (metrics === null || typeof metrics !== "object") return undefined;
  const m = metrics as Record<string, unknown>;
  const num = (key: string): number | undefined => (typeof m[key] === "number" ? (m[key] as number) : undefined);
  const source = m["costSource"];
  const out: RunMetrics = {
    ...(source === "provider" || source === "table" || source === "unknown" ? { costSource: source } : {}),
    ...(num("inputTokens") !== undefined ? { inputTokens: num("inputTokens")! } : {}),
    ...(num("outputTokens") !== undefined ? { outputTokens: num("outputTokens")! } : {}),
    ...(num("noCacheTokens") !== undefined ? { noCacheTokens: num("noCacheTokens")! } : {}),
    ...(num("cacheReadTokens") !== undefined ? { cacheReadTokens: num("cacheReadTokens")! } : {}),
    ...(num("cacheWriteTokens") !== undefined ? { cacheWriteTokens: num("cacheWriteTokens")! } : {}),
    ...(num("reasoningTokens") !== undefined ? { reasoningTokens: num("reasoningTokens")! } : {}),
    ...(num("durationMs") !== undefined ? { durationMs: num("durationMs")! } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * How long a typed message waits behind a call that cannot be steered.
 *
 * Two minutes is longer than most turns and shorter than a person's patience for a box that has
 * stopped responding. The bound exists at all because the wait is on the CALL's own promise, so
 * without one a stalled provider hangs the IPC handler and the composer sits on `busy` forever with
 * nothing to cancel. Past it the message is appended beside the running call and forks — a branch,
 * which is a real answer, rather than silence, which is not.
 */
const CHAT_WAIT_MS = 120_000;

/**
 * How many directory entries `findFiles` will look at before giving up and saying so.
 *
 * Generous for a repository, cheap for a keystroke: the walk is synchronous on the main thread, and
 * the honest failure ("keep typing") is much better than a window that stops painting while someone
 * types `@`.
 */
const FIND_VISIT = 20_000;

/** Directories `@` never means: version control, dependencies, build output, and JaiRA's own state. */
const FIND_SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "__pycache__"]);

/**
 * The conversation a position names — `<session>@<seq>` without the seq.
 *
 * Split on the LAST `@`, which is the same arithmetic the session store uses: a compaction mints
 * `planning~compact1` and a ref into it carries two, so splitting on the first would name a session
 * that does not exist. A call in flight has not finished claiming its position, so the register is
 * keyed by the session alone and matching a whole ref would never hit.
 */
function sessionOf(position: string): string {
  const at = position.lastIndexOf("@");
  return at > 0 ? position.slice(0, at) : position;
}

/**
 * The permission posture a call runs under, worded as the control that sets it.
 *
 * The per-tool MAP is the answer, because the map is what reaches the executor — `gateTools` reads a
 * mode per tool out of it. So this names the preset those modes correspond to, and says `custom`
 * when they are nobody's. A reader comparing the chip against the tool list sees the same fact
 * twice, which is the point.
 *
 * A PROFILE can still narrow it, and is reported when one is in force. It is never something the
 * composer wrote — it can only be inherited from the state or compiled from the project policy — but
 * it gates ahead of every mode, so omitting it would understate what will happen. `full` is left
 * unsaid: it excludes nothing, and a posture line that always ends in the same word teaches nothing.
 *
 * Compiled rather than read off the raw config, so what is reported is what would be enforced:
 * `compilePolicy` folds the authored rules into a baseline.
 */
function postureOf(
  config: JairaConfigOf,
  tools: readonly ToolChoice[],
  authored?: { profile?: string; default?: PermissionMode; tools?: Record<string, PermissionMode> },
): string {
  const { baseline } = compilePolicy(config.policy, { execEnv: config.execEnvironment });
  const preset = presetOf(authored?.tools, tools);
  const modes =
    preset?.label ??
    (authored?.tools !== undefined && Object.keys(authored.tools).length > 0
      ? "custom"
      : // Nothing per-tool was set, so every tool falls to the default — which is a preset by another
        // name, and `ask` is where the ledger itself ends up.
        (PERMISSION_PRESETS.find((p) => p.id === (authored?.default ?? baseline?.default ?? "ask"))?.label ??
          `${authored?.default ?? baseline?.default ?? "ask"} by default`));
  // The ledger's own fallback, mirrored: `resolveProfile` ends at `full`, which narrows nothing.
  const profile = authored?.profile ?? baseline?.profile ?? "full";
  return profile === "full" ? modes : `${profile} · ${modes}`;
}


/**
 * The scope floor an executor declares — §7's "the screen that configures an executor bounds it".
 *
 * Read off the executor TREE rather than a key of its own, because what an executor may touch is a
 * property of that executor and inherits down its nodes like every other node setting. The topmost
 * declaration wins here; a per-route narrowing is the tree's own business and reaches the gate the
 * same way once the engine resolves which route answered.
 *
 * `undefined` when nobody declared one, which is what keeps a project that has never heard of scopes
 * paying nothing at all.
 */
function scopeFloorOf(config: JairaConfigOf): readonly Scope[] | undefined {
  for (const node of Object.values(config.executors ?? {})) {
    const scopes = (node as { scopes?: Scope[] }).scopes;
    if (Array.isArray(scopes) && scopes.length > 0) return scopes;
  }
  return undefined;
}

/** The `reason` inside a run row's stored failure, or undefined where there is none or it will not parse. */
function reasonOf(failureJson: string | undefined): string | undefined {
  if (failureJson === undefined) return undefined;
  try {
    const parsed = JSON.parse(failureJson) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}
