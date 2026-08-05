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
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { loadBundle } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import {
  baseFileTree,
  baseStateView,
  beginTaskRun,
  boardForState,
  boardView,
  browseBaseWorkflows,
  browseWorkflows,
  commitSync,
  conversationView,
  ensureWorkspace,
  fileTree,
  hashText,
  initBase,
  RunOwner,
  cancelTask,
  createTask,
  finishTaskRun,
  historySize,
  initProject,
  // Aliased: this module has its own `isUnder` for dot-separated JSON-schema paths, which is a
  // different question with a different answer for the same two strings.
  isUnder as isUnderState,
  listDescriptions,
  openProject,
  ownershipOf,
  pruneHistory,
  rootsBoard,
  stateHashes,
  stateSlots,
  stateView,
  taskDetailView,
  readSyncRecord,
  syncDrift,
  taskSummaries,
  workflowDigest,
  workflowRoots,
  type DescriptionBoundary,
  type DescriptionOwnership,
  type Project,
  type WorkflowDigestOptions,
} from "@jaira/persistence";
import {
  ApprovalHub,
  artifactWiring,
  buildPromptExecutor,
  compilePolicy,
  enabledAdapters,
  enabledGenericAgents,
  listExecutors,
  probeExecutor,
  SecretResolver,
  persistEngineArtifacts,
  registerFileTools,
  executeWorkflow,
  gateCapabilities,
  registerAgentRuntimes,
  registerCommandFunction,
  registerGenericAgents,
  registerTools,
  functionNamesOf,
  InteractionHub,
  modelDefaults,
  newRegistry,
  NodeExec,
  parseFakeRules,
  policyCanEscalate,
  promptSummarizer,
  ScriptedFunctions,
  sessionServicesFor,
  statusOfResult,
  syncOutcomeOf,
  syncRootId,
  syncWorkflowFiles,
  verdictOfFindings,
  type ApprovalRequest,
  type ExecObserver,
  type FakeRule,
  type HubRequest,
  type PolicyAuditEntry,
  type StateEdit,
} from "@jaira/runtime";
import {
  defaultSettings,
  descriptionRootOf,
  isComponentName,
  isTextMime,
  jairaBasePaths,
  mergeConfigDocuments,
  mimeOfPath,
  parseComponentConfig,
  parseConfig,
  parseSettings,
  listSchemas,
  propertiesOf,
  schemaById,
  validateComponentResult,
  WORKFLOW_JSON,
} from "@jaira/shared";
import type {
  ApprovalScope,
  BoardView,
  ComponentConfig,
  ConfigView,
  ConversationView,
  CreateFileRequest,
  CreateTaskRequest,
  DeleteFileRequest,
  ExecutorInfo,
  FileMutationResult,
  FileSource,
  FileTree,
  HistorySize,
  JairaSettings,
  PendingApproval,
  PendingInteraction,
  ProbeResult,
  PruneRequest,
  PruneResult,
  PushMessage,
  MoveWorkflowRequest,
  ReadFileRequest,
  ReadWorkflowRequest,
  RenameFileRequest,
  SecretCapabilities,
  SetSecretRequest,
  StartTaskRequest,
  SchemaViolation,
  StateSlots,
  StateView,
  DetectSchemaResult,
  ValidateSchemaRequest,
  ValidateSchemaResult,
  TaskDetail,
  TaskSummary,
  WorkflowBrowser,
  WorkflowLayer,
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
} from "@jaira/shared";

export type Publish = (message: PushMessage) => void;

export interface AppServiceOptions {
  /** Where pushes go — the Electron main process forwards them to the renderer. */
  publish?: Publish;
  /** Deterministic request ids in tests. */
  nextInteractionId?: () => string;
  nextApprovalId?: () => string;
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
}

/**
 * The encrypted secret store, as this service needs it.
 *
 * Deliberately synchronous and tiny. Everything about WHERE the bytes go is Electron's problem;
 * what matters here is that the value never crosses back into the renderer, which is why there is
 * no bulk read.
 */
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
 * Every leaf is `anyOf: [own type, {$ref}, {expr}, {json}]`. When something deep inside one is wrong,
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
  return missing === "$ref" || missing === "expr" || missing === "json";
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

/** An approval as the renderer sees it (the hub's request, minus internals). */
function pendingApprovalOf(request: ApprovalRequest): PendingApproval {
  return {
    requestId: request.requestId,
    tool: request.tool,
    ...(request.command !== undefined ? { command: request.command } : {}),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    input: request.input as Record<string, JsonValue>,
    ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
    at: request.at,
  };
}

interface LiveRun {
  taskId: string;
  runId: number;
  abort: AbortController;
  /** Resolves when the run has finished recording and settled its task row. */
  done: Promise<void>;
}

/**
 * `startTask` as the service sees it. The IPC contract carries `fake` as opaque
 * JSON (it is parsed with `parseFakeRules`); in-process callers usually have
 * typed rules already, so both are accepted here.
 */
export interface StartRunRequest extends Omit<StartTaskRequest, "fake"> {
  fake?: JsonValue | FakeRule[];
}

export class AppService {
  private project?: Project;
  private readonly live = new Map<string, LiveRun>();
  private readonly hub: InteractionHub;
  /** requestId → taskId, so a pending interaction can name its task. */
  private readonly requestTask = new Map<string, string>();
  /**
   * Function names this process routes to the renderer — the app's gate
   * vocabulary. Grows as runs register their bundles' functions, and is what
   * makes a parked state read `waiting_for_user` in the views.
   */
  private readonly interactive = new Set<string>();
  /**
   * Per-command approvals (DESIGN §10.2) — a separate channel from workflow gates:
   * these are provider-initiated, so they cannot be authored states.
   */
  private readonly approvals: ApprovalHub;
  /** requestId → the run it belongs to, so a decision can be audited against it. */
  private readonly approvalRun = new Map<string, { taskId: string; runId: number }>();
  /**
   * The JSON-editor schema machinery, built on first use.
   *
   * Lazy because most sessions never open the schema picker, and compiling every registered document
   * at construction would cost that on every window — see {@link validateSchema}.
   */
  private ajv?: Ajv;
  private readonly schemaValidators = new Map<string, ValidateFunction>();

  constructor(private readonly options: AppServiceOptions = {}) {
    this.baseDir = jairaBasePaths(options.baseDir ?? settingsBaseDir()).baseDir;
    this.hub = new InteractionHub({
      onRequest: (request) => this.publishInteraction(request),
      onResolved: (requestId) => {
        this.requestTask.delete(requestId);
        this.publish({ type: "interaction:resolved", requestId });
      },
      ...(options.nextInteractionId !== undefined ? { nextId: options.nextInteractionId } : {}),
    });
    this.approvals = new ApprovalHub({
      onRequest: (request) => this.publish({ type: "approval:requested", pending: pendingApprovalOf(request) }),
      onResolved: (requestId, decision) => {
        // The human's answer is the audit entry policy alone could not produce.
        const run = this.approvalRun.get(requestId);
        this.approvalRun.delete(requestId);
        if (run && this.project) {
          const request = this.approvalsSeen.get(requestId);
          this.p.commands.record({
            taskId: run.taskId,
            runId: run.runId,
            tool: request?.tool ?? "unknown",
            ...(request?.command !== undefined ? { command: request.command } : {}),
            decision: decision.decision === "allow" ? "approved" : "denied",
            decidedBy: "user",
            ...(request?.reason !== undefined ? { reason: request.reason } : {}),
            scope: decision.scope,
            ...(request?.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          });
        }
        this.approvalsSeen.delete(requestId);
        this.publish({ type: "approval:resolved", requestId, decision: decision.decision });
      },
      ...(options.nextApprovalId !== undefined ? { nextId: options.nextApprovalId } : {}),
    });
  }

  /** Requests seen, kept until resolved so the audit entry can name the command. */
  private readonly approvalsSeen = new Map<string, ApprovalRequest>();

  /**
   * The workflows watchers and their shared debounce timer (§11.1 re-lint).
   *
   * Plural because there are two roots to watch: the project's own and the shared base root. A base
   * edit changes what THIS project runs, so leaving it unwatched would mean the browser quietly
   * described a workflow that no longer exists.
   */
  private watchers: FSWatcher[] = [];
  private watchTimer?: ReturnType<typeof setTimeout>;

  /**
   * The most recent probe per executor.
   *
   * Kept so availability can mean "enabled *and* not known to be broken" without a state view
   * shelling out to `--version` for every executor every time the tree selection changes. Absence is
   * deliberately optimistic — see {@link stateViewOptions}.
   */
  private readonly lastProbes = new Map<string, ProbeResult>();

  /**
   * The resolved shared root, used by the settings, secret and workflow surfaces.
   *
   * Assigned in the constructor rather than as a field initializer: `options` is a parameter
   * property, so it does not exist yet when field initializers run.
   */
  private readonly baseDir: string;

  /** The sync in flight, if any — one at a time, so the abort has an unambiguous target. */
  private syncRun?: AbortController;

  /**
   * What the last sync proposed and which of its files are still unsaved.
   *
   * The baseline advances when a proposal is ACCEPTED, not when it is produced (see
   * `persistence/workflowSync.ts`), so something has to remember what was on offer between the run
   * and the save. Session-scoped, like the drafts it corresponds to.
   */
  private pendingSync?: { direction: SyncDirection; document: string; remaining: Set<string> };

  // --- lifecycle -------------------------------------------------------------

  async open(dir: string): Promise<{ dir: string; recovered: string[] }> {
    await this.close();
    const project = openProject(dir, { baseDir: this.baseDir });
    this.project = project;
    if (this.options.watchWorkflows !== false) this.watchWorkflows(project);
    if (project.recovered.length > 0) this.publish({ type: "store:invalidate", scope: "tasks" });
    return { dir: project.paths.projectDir, recovered: project.recovered };
  }

  /**
   * Watch `.jaira/workflows/` so the browser re-lints as the user edits (DESIGN
   * §11.1: "editing happens in the user's editor, JaiRA watches and re-lints").
   *
   * Recursive watching is unavailable on Linux, so a failure is not fatal — the
   * browser is still correct on demand, it just stops being live. That matters
   * because CI and Linux developers must not be a broken app.
   */
  private watchWorkflows(project: Project): void {
    const notify = (): void => {
      clearTimeout(this.watchTimer);
      // Coalesce: a single save often produces several events, and an editor's
      // temp-file dance would otherwise lint a file that no longer exists.
      this.watchTimer = setTimeout(() => {
        this.publish({ type: "store:invalidate", scope: "workflows" });
      }, this.options.watchDebounceMs ?? 150);
      this.watchTimer.unref?.();
    };
    for (const dir of [project.paths.workflowsDir, project.paths.base.workflowsDir]) {
      let watcher: FSWatcher | undefined;
      try {
        watcher = watch(dir, { recursive: true }, notify);
      } catch {
        try {
          watcher = watch(dir, notify);
        } catch {
          watcher = undefined;
        }
      }
      if (watcher === undefined) continue;
      watcher.on("error", () => {
        // A deleted workflows directory ends the watch; on-demand browsing still works.
        watcher?.close();
        this.watchers = this.watchers.filter((w) => w !== watcher);
      });
      this.watchers.push(watcher);
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
   * `initProject` is idempotent and keeps an existing `config.json`, so pointing this at a directory
   * that is already a project is an open, not an overwrite.
   */
  async init(dir: string): Promise<{ dir: string; recovered: string[] }> {
    initProject(dir);
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

  current(): { dir: string } | null {
    return this.project ? { dir: this.project.paths.projectDir } : null;
  }

  /**
   * Abort every live run and close the project.
   *
   * Awaiting the aborted runs is not optional: a run keeps journaling for a beat
   * after its abort (and still has a `finishTaskRun` to write), so closing the
   * database first would throw "database connection is not open" from inside the
   * engine's event tee — an unhandled rejection, and a task row left `running`.
   */
  async close(): Promise<void> {
    clearTimeout(this.watchTimer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.hub.rejectAll("the project was closed");
    this.approvals.denyAll();
    // A sync holds no run record and nothing to settle, but it does hold a model call — and the
    // proposal it was about to produce belongs to a project that is going away.
    this.syncRun?.abort();
    this.syncRun = undefined;
    this.pendingSync = undefined;
    const inFlight = [...this.live.values()];
    for (const run of inFlight) run.abort.abort();
    await Promise.allSettled(inFlight.map((run) => run.done));
    this.live.clear();
    this.project?.close();
    this.project = undefined;
  }

  private get p(): Project {
    if (!this.project) throw new Error("no project is open");
    return this.project;
  }

  private publish(message: PushMessage): void {
    this.options.publish?.(message);
  }

  private publishInteraction(request: HubRequest): void {
    const taskId = [...this.live.keys()][0] ?? "";
    this.requestTask.set(request.requestId, taskId);
    this.publish({ type: "interaction:requested", pending: this.pendingOf(request) });
  }

  private pendingOf(request: HubRequest): PendingInteraction {
    const pending: PendingInteraction = {
      requestId: request.requestId,
      taskId: this.requestTask.get(request.requestId) ?? "",
      component: request.component,
      inputs: request.inputs,
    };
    // Parse the authored config here, once, so the renderer receives a normalized
    // contract instead of re-deriving it — and so a malformed state file surfaces
    // as a parse error on the request rather than an empty dialog.
    if (isComponentName(request.component)) {
      try {
        pending.config = parseComponentConfig(request.component, request.inputs["config"]);
      } catch (e) {
        pending.configError = (e as Error).message;
      }
    }
    return pending;
  }

  /** The parsed contract for a parked request, when it has one. */
  private configOf(requestId: string): ComponentConfig | undefined {
    const request = this.hub.list().find((r) => r.requestId === requestId);
    if (!request || !isComponentName(request.component)) return undefined;
    try {
      return parseComponentConfig(request.component, request.inputs["config"]);
    } catch {
      return undefined;
    }
  }

  // --- reads -----------------------------------------------------------------

  listTasks(): TaskSummary[] {
    return taskSummaries(this.p);
  }

  /**
   * Interactive functions, from the app's own registry vocabulary: a gate is
   * whatever this process routes to the renderer. Passing it makes a parked
   * state read `waiting_for_user` on the board.
   */
  private viewOptions(): { interactiveFunctions: ReadonlySet<string> } {
    return { interactiveFunctions: this.interactive };
  }

  /**
   * One board level.
   *
   * A `level` is resolved against the workflow that actually contains it, not against whichever
   * workflow the newest task happens to run — otherwise clicking a state in the Files tree would
   * draw an empty board whenever the newest task belonged to a different workflow. `boardView`
   * remains the fallback, and is still what answers the no-level "just show me something" case.
   */
  board(level?: string): BoardView {
    if (level !== undefined && level.length > 0) {
      const board = boardForState(this.p, level, this.browseWorkflows(), this.stateViewOptions());
      if (board) return board;
    }
    return boardView(this.p, level, this.viewOptions());
  }

  /**
   * The root listing: one column per workflow root, project and shared together.
   *
   * Empty rather than an error with no project open. These two are "show me what is here" reads, and
   * with no project the honest answer is "nothing" — the view renders its own empty state. Throwing
   * would make every rail click a potential error toast, which is a trap the renderer has already
   * fallen into once.
   */
  boardRoots(): BoardView {
    if (!this.project) return { level: "", label: "All workflows", breadcrumb: [], columns: [], atLevel: [], finished: [] };
    return rootsBoard(this.p, this.browseWorkflows(), this.stateViewOptions());
  }

  /**
   * Both layer roots as trees — the Files view's left panel.
   *
   * With no project open you still get the SHARED root, because it is machine-global: `~/.jaira`
   * exists independently of any checkout, and its workflows are the ones every project can reach.
   * Showing nothing until a project is open would hide the one place you can author something that
   * outlives this checkout — and would hide it exactly when a new user is looking for somewhere to
   * start.
   */
  filesTree(): FileTree {
    if (this.project) return fileTree(this.p, this.browseWorkflows());
    const baseDir = jairaBasePaths(this.baseDir).baseDir;
    // Linted with no project open, exactly as a project's tree is. The shared root is where a
    // workflow meant to outlive one checkout gets authored, so leaving it unvalidated meant the one
    // mode people write shared workflows in was the one mode that never said anything was wrong.
    return baseFileTree(baseDir, browseBaseWorkflows(baseDir));
  }

  /**
   * Everything the Files view shows about one state.
   *
   * Executor availability is passed in from *this* process's view of the machine, which is what
   * makes "generic-cli is off, so this state cannot start" an authoring diagnostic rather than a
   * run-time surprise (DESIGN §8.2).
   */
  stateView(stateId: string): StateView {
    if (this.project) return stateView(this.p, stateId, this.browseWorkflows(), this.stateViewOptions());
    // The shared root is browsable and authorable with no project open, so a state in it has to be
    // viewable too. What that view CANNOT know — references, drift, runs — is marked rather than
    // reported as empty (see `StateView.fileOnly`).
    const baseDir = jairaBasePaths(this.baseDir).baseDir;
    return baseStateView(baseDir, stateId, this.stateViewOptions(), browseBaseWorkflows(baseDir));
  }

  /**
   * What a set of states declare — the authoring form's answer to "what does this child need wired,
   * and what can I read back off it" (WORKFLOWS.md §6.1).
   *
   * Resolved against the same layer roots everything else searches, so the slots the form seeds are
   * the slots the loader will look for. With no project open the shared root is the only layer there
   * is, which is also the only layer authorable in that mode.
   */
  stateSlots(stateIds: string[]): Record<string, StateSlots> {
    const roots = this.project ? workflowRoots(this.p) : [jairaBasePaths(this.baseDir).workflowsDir];
    return stateSlots(roots, stateIds);
  }

  /** A task's run, read back out of the journal as turns. */
  conversation(taskId: string): ConversationView {
    return conversationView(this.p, taskId);
  }

  /**
   * The executors that would actually run.
   *
   * Enabled is the rule, refined by the last probe when one has been taken: an executor nobody has
   * tested yet is assumed to work, because refusing to start a task over a check that has never run
   * would be worse than the failure it is trying to prevent.
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
      interactiveFunctions: this.interactive,
      availableExecutors: available,
      knownExecutors: new Set(all.map((info) => info.name)),
    };
  }

  taskDetail(taskId: string): TaskDetail {
    return taskDetailView(this.p, taskId, this.viewOptions());
  }

  /**
   * The workflow browser + lint results (DESIGN §11.1). No registry is passed: an
   * interactive function is only registered once a run needs it, so linting
   * against this process's partial registry would flag every human gate.
   */
  browseWorkflows(): WorkflowBrowser {
    return browseWorkflows(this.p);
  }

  /** Rows currently stored, for the pruning panel's "before" figure. */
  historySize(): HistorySize {
    return historySize(this.p);
  }

  /**
   * Plan or apply a prune (SPEC §13).
   *
   * A request without `apply` is a plan and deletes nothing, which is what the UI
   * shows before asking — history is not recoverable. The §13 safety rule lives in
   * `pruneHistory`, so it holds no matter which caller asks.
   */
  pruneHistory(request: PruneRequest = {}): PruneResult & { remaining: HistorySize } {
    const project = this.p;
    const days = request.olderThanDays ?? 0;
    if (!Number.isFinite(days) || days < 0) throw new Error("olderThanDays must be a non-negative number");
    const keep = request.keepRunsPerTask ?? 1;
    if (!Number.isInteger(keep) || keep < 0) throw new Error("keepRunsPerTask must be a non-negative integer");
    const result = pruneHistory(project, {
      before: Date.now() - days * 86_400_000,
      keepRunsPerTask: keep,
      dryRun: request.apply !== true,
    });
    if (!result.dryRun && result.runs.length > 0) {
      // Run history backs the detail view and the board's finished cards.
      this.publish({ type: "store:invalidate", scope: "tasks" });
      this.publish({ type: "store:invalidate", scope: "board" });
      for (const run of result.runs) this.publish({ type: "store:invalidate", scope: "task", taskId: run.taskId });
    }
    return { ...result, remaining: historySize(project) };
  }

  // --- writes ----------------------------------------------------------------

  createTask(request: CreateTaskRequest): TaskSummary {
    const project = this.p;
    const meta = createTask(project, {
      title: request.title,
      workflow: request.workflow,
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.labels !== undefined ? { labels: request.labels } : {}),
      ...(request.inputs !== undefined ? { inputs: request.inputs } : {}),
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
    });
    this.publish({ type: "store:invalidate", scope: "tasks" });
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
  async startTask(request: StartRunRequest): Promise<{ taskId: string; runId: number }> {
    const project = this.p;
    const { taskId } = request;
    if (this.live.has(taskId)) throw new Error(`task '${taskId}' is already running in this process`);

    const scripted = request.interactions ? new ScriptedFunctions(request.interactions) : undefined;
    const registry = newRegistry();
    // Registration order matters: a scripted answer wins over the live hub, so a
    // demo run never parks waiting for a human.
    scripted?.register(registry);

    // Materialize the worktree before marking the task running, so a git failure
    // leaves it startable rather than `running` with nowhere to run (DESIGN §9.2).
    const workspace = await ensureWorkspace(project, taskId);

    // Child-process tracking (DESIGN §4.2a). The registry is built before the run
    // exists, so the observer forwards to a claim made below — safe because nothing
    // spawns until the run starts.
    let owner: RunOwner | undefined;
    let observe: ExecObserver<number> | undefined;
    const observer: ExecObserver = {
      onSpawn: (event) => observe?.onSpawn(event),
      onExit: (token, event) => observe?.onExit(token as number | undefined, event),
    };
    const exec = new NodeExec({ execEnv: project.config.execEnvironment, observer });

    // Delegated agent runtimes are available to every run (DESIGN §8.1); a state
    // reaches one with a `claude-code` function op.
    // Only the executors this project has turned on: a disabled one is left OUT of the registry
    // rather than registered and refusing, so a state naming it fails at start rather than midway.
    registerAgentRuntimes(registry, {
      execEnv: project.config.execEnvironment,
      observer,
      adapters: enabledAdapters(project.config.agents),
      ...(project.config.agents.claudeCli?.command !== undefined ? { cliCommand: project.config.agents.claudeCli.command } : {}),
      ...(project.config.agents.codex?.command !== undefined ? { codexCommand: project.config.agents.codex.command } : {}),
      ...(project.config.agents.codex?.sandbox !== undefined ? { codexSandbox: project.config.agents.codex.sandbox } : {}),
    });
    // Non-Claude CLIs the project configured (DESIGN §8.1). Nothing is registered
    // when none are, so a state naming one fails honestly instead of running some
    // default binary.
    registerGenericAgents(registry, {
      execEnv: project.config.execEnvironment,
      exec,
      agents: enabledGenericAgents(project.config.agents),
    });
    // Our own tools, so an agent's commands go through the policy at all: an agent
    // calling its native shell would be invisible to it (DESIGN §10.1).
    registerTools(registry, { execEnv: project.config.execEnvironment, exec });
    // A state can also run a command directly, without delegating to an agent; it
    // gates itself with the same policy (DESIGN §10.1).
    registerCommandFunction(registry, { execEnv: project.config.execEnvironment, exec });

    const started = beginTaskRun(project, taskId, { functions: registry.functions });

    // Artifact placement (DESIGN §7.6): one wiring shared by the file tools and the
    // post-run sink, so an agent's writes and a prompt state's returned content land
    // under the same destination.
    const artifacts = artifactWiring({
      destination: project.config.artifacts.destination,
      artifactDir: project.config.artifacts.dir,
      inlineMaxBytes: project.config.artifacts.inlineMaxBytes,
      taskId,
      runId: started.runId,
      workspaceRoot: workspace.root,
      projectDir: project.paths.projectDir,
      jairaDir: project.paths.jairaDir,
    });
    // Registering these is what makes JaiRA own the agent's writes at all.
    registerFileTools(registry, {
      destination: artifacts.destination,
      store: project.artifacts,
      vars: artifacts.vars,
      inlineMaxBytes: artifacts.inlineMaxBytes,
    });

    // §8.2: refuse a state whose runtime cannot enforce the policy it runs under,
    // rather than letting it run unguarded.
    // The RESOLVED states: a snapshot-loaded bundle carries no `source` (EXPRESSIONS.md §11), so
    // reading it would have gated a pinned run against `{}` — a check that always passes.
    const gateIssues = gateCapabilities(registry, started.bundle.states, {
      policyNeedsApproval: policyCanEscalate(project.config.policy),
    });
    if (gateIssues.length > 0) {
      finishTaskRun(project, taskId, started.runId, "failed", {
        failure: { classification: "permanent", reason: gateIssues[0]!.message },
      });
      throw new Error(gateIssues.map((i) => `${i.stateId}: ${i.message}`).join("; "));
    }
    const abort = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    this.live.set(taskId, { taskId, runId: started.runId, abort, done });

    // Claim the run (DESIGN §4.2a). Two things follow: another process opening this
    // project will see a live heartbeat and leave the task alone instead of
    // interrupting it, and a cancel requested from elsewhere reaches this abort
    // controller through the polled flag.
    owner = new RunOwner({
      jobs: project.jobs,
      taskId,
      runId: started.runId,
      onCancelRequested: () => this.cancelTask(taskId),
    });
    observe = owner.observer();

    // Every interactive function the bundle names that the script didn't answer
    // is routed to the renderer.
    for (const name of functionNamesOf(started.bundle)) {
      this.interactive.add(name);
      if (!registry.functions.has(name)) this.hub.register(registry, name);
      scripted?.registerWildcard(registry, name);
    }

    const fakeRules = request.fake !== undefined ? parseFakeRules(request.fake) : undefined;
    const prompt = buildPromptExecutor({
      ...(fakeRules !== undefined ? { fakeRules } : {}),
      defaults: modelDefaults(project.config, started.bundle, { fake: fakeRules !== undefined }),
    });

    // Conversation `summary` mode (DESIGN §14 phase 7): installed only for the
    // sessions whose states asked for it, and summarizing through this run's own
    // prompt executor so a scripted run needs no provider.
    const { modes: _summaryModes, ...session } = sessionServicesFor(started.bundle, promptSummarizer(prompt));

    // Policy for this run: authored project rules compiled to an ExecPolicy, with
    // every decision audited and `require_approval` routed to the inbox (§10.2).
    const auditPolicy = (entry: PolicyAuditEntry): void => {
      this.approvals.noteDecision(entry);
      project.commands.record({
        taskId,
        runId: started.runId,
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
    const policy = compilePolicy(project.config.policy, {
      execEnv: project.config.execEnvironment,
      onDecision: auditPolicy,
    });
    const approve = this.approvals.approver({ taskId });

    const recorder = project.events.recorder(taskId, started.runId);
    let seq = 0;
    this.publish({ type: "store:invalidate", scope: "tasks" });

    void (async () => {
      try {
        const result = await executeWorkflow({
          bundle: started.bundle,
          inputs: started.meta.inputs ?? {},
          registry,
          prompt,
          // Tee the journal: persist, then push the same event to the renderer so
          // the detail view streams live without polling the database.
          persistence: {
            record: (event, atMs) => {
              recorder.record(event, atMs);
              this.publish({
                type: "engine:event",
                taskId,
                runId: started.runId,
                seq: ++seq,
                at: atMs,
                event: event as unknown as JsonValue,
              });
              this.publish({ type: "store:invalidate", scope: "board" });
            },
          },
          policy,
          approve,
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
          runId: started.runId,
          onError: (name, error) =>
            this.publish({
              type: "engine:event",
              taskId,
              runId: started.runId,
              seq: ++seq,
              at: Date.now(),
              event: { type: "artifact.failed", name, reason: error.message } as unknown as JsonValue,
            }),
        });
        finishTaskRun(project, taskId, started.runId, status, {
          outputs: result.value,
          ...("error" in result && result.error !== undefined ? { failure: result.error } : {}),
        });
        this.publish({ type: "run:finished", taskId, runId: started.runId, status });
      } catch (e) {
        // A crash between beginTaskRun and finishTaskRun would otherwise leave the
        // task `running` forever (recovery would call it interrupted next open).
        finishTaskRun(project, taskId, started.runId, "failed", {
          failure: { classification: "permanent", reason: (e as Error).message },
        });
        this.publish({ type: "run:finished", taskId, runId: started.runId, status: "failed" });
      } finally {
        // Give up the claim and close any child still recorded as running, so the
        // next project open sees no phantom owner and no phantom orphans.
        owner?.release();
        this.live.delete(taskId);
        this.publish({ type: "store:invalidate", scope: "tasks" });
        this.publish({ type: "store:invalidate", scope: "task", taskId });
        settle();
      }
    })();

    return { taskId, runId: started.runId };
  }

  /** Cancel a task: abort a live run here, or record a terminal status. */
  cancelTask(taskId: string): { taskId: string } {
    const run = this.live.get(taskId);
    if (run) {
      // Fail any gate this task is parked on, or the abort would never be observed.
      for (const [requestId, owner] of this.requestTask) {
        if (owner === taskId) this.hub.reject(requestId, "the task was canceled");
      }
      // A parked approval blocks the agent's tool loop just as hard as a gate.
      for (const [requestId, run] of this.approvalRun) {
        if (run.taskId === taskId) this.approvals.decide(requestId, "deny", "once");
      }
      run.abort.abort();
    } else if (this.p.jobs.liveRunJob(taskId, Date.now()) !== undefined) {
      // Another process is driving it. Raise the flag its heartbeat polls — cross-
      // process cancel needs no socket, unlike answering a parked gate (§4.2a).
      this.p.jobs.requestCancel(taskId, Date.now());
    } else {
      cancelTask(this.p, taskId);
      this.publish({ type: "store:invalidate", scope: "tasks" });
    }
    return { taskId };
  }

  // --- interaction -----------------------------------------------------------

  /** Approvals awaiting a human (DESIGN §10.2). */
  pendingApprovals(): PendingApproval[] {
    return this.approvals.list().map(pendingApprovalOf);
  }

  /**
   * Answer a parked approval. `scope` is how long the answer applies — the reason
   * a user is not asked the same question on every tool call.
   */
  submitApproval(requestId: string, decision: "allow" | "deny", scope: ApprovalScope = "once"): { requestId: string } {
    if (!this.approvals.decide(requestId, decision, scope)) {
      throw new Error(`no pending approval '${requestId}'`);
    }
    return { requestId };
  }

  pendingInteractions(): PendingInteraction[] {
    return this.hub.list().map((request) => this.pendingOf(request));
  }

  /**
   * Answer a parked interaction.
   *
   * The submitted value is re-validated against the component's contract here, in
   * the main process (DESIGN §7.1). The renderer is the untrusted half of the
   * boundary, so an undeclared decision or a missing required field is refused
   * before it can become a workflow output — the engine's own output-schema check
   * is a second, independent gate.
   */
  submitInteraction(requestId: string, value: JsonValue): { requestId: string } {
    const config = this.configOf(requestId);
    if (config) {
      const check = validateComponentResult(config, value);
      if (!check.ok) throw new Error(`invalid ${config.component} response: ${check.errors}`);
    }
    if (!this.hub.submit(requestId, value)) {
      throw new Error(`no pending interaction '${requestId}'`);
    }
    return { requestId };
  }

  // --- settings --------------------------------------------------------------

  /**
   * User preferences (theme). Readable with NO project open — they belong to the person, not to a
   * checkout, which is why they live in the shared root rather than in `.jaira/config.json`.
   */
  readSettings(): JairaSettings {
    return readSettingsFile(this.baseDir);
  }

  /** Merge a partial change into the settings file and return the whole result. */
  writeSettings(patch: Partial<JairaSettings>): JairaSettings {
    const next: JairaSettings = { ...this.readSettings(), ...patch };
    const file = jairaBasePaths(this.baseDir).settingsFile;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  // --- configuration ---------------------------------------------------------

  /** Both configuration layers as authored, plus the merged result a run would use. */
  readConfig(): ConfigView {
    const base = jairaBasePaths(this.baseDir);
    const projectFile = this.project?.paths.configFile;
    const baseDoc = readJsonIfPresent(base.configFile);
    const projectDoc = projectFile !== undefined ? readJsonIfPresent(projectFile) : null;
    return {
      base: baseDoc,
      project: projectDoc,
      // Parsed, so the UI shows defaults filled in rather than the sparse document — "what will
      // actually happen" is the question this pane exists to answer.
      //
      // `?? {}` is load-bearing: with NEITHER layer holding a `config.json` the merge is undefined,
      // and parsing that threw "config must be a JSON object" — so the one state where a person has
      // configured nothing yet was the state where the settings screen could not be read at all.
      // Two absent layers mean the built-in defaults, which is what an empty document parses to.
      effective: parseConfig(
        mergeConfigDocuments(baseDoc ?? undefined, projectDoc ?? undefined) ?? {},
      ) as unknown as JsonValue,
      baseFile: base.configFile,
      projectFile: projectFile ?? "",
      baseDir: base.baseDir,
    };
  }

  /**
   * Replace one layer's `config.json`.
   *
   * Validated BEFORE writing, and validated as it will actually be read — the project layer is
   * checked merged over the base, because a project document that is only valid on its own would
   * still break every run. Writing an unloadable config would leave the app unable to open the
   * project it was just configured with, which is the one failure a settings screen must not cause.
   */
  writeConfig(request: WriteConfigRequest): ConfigView {
    const base = jairaBasePaths(this.baseDir);
    // Before validating, not after: a document reported field by field and THEN refused for having
    // nowhere to go tells the author to fix the wrong thing. The base layer is always writable —
    // it is the machine's, and `initBase` creates it — so only the project layer can fail here.
    if (request.layer !== "base" && !this.project) {
      throw new Error("no project is open, so there is no project config to write");
    }
    const current = this.readConfig();
    const merged =
      request.layer === "base"
        ? mergeConfigDocuments(request.config, current.project ?? undefined)
        : mergeConfigDocuments(current.base ?? undefined, request.config);
    parseConfig(merged ?? {}); // throws with the offending field named
    let file: string;
    if (request.layer === "base") {
      initBase(base.baseDir);
      file = base.configFile;
    } else {
      file = this.p.paths.configFile;
    }
    writeFileSync(file, `${JSON.stringify(request.config, null, 2)}\n`, "utf8");
    // The open project holds a parsed copy, so it has to be reopened for the change to take effect.
    this.publish({ type: "store:invalidate", scope: "config" });
    this.publish({ type: "store:invalidate", scope: "workflows" });
    return this.readConfig();
  }

  // --- executors -------------------------------------------------------------

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
    if (name !== undefined && wanted.length === 0) throw new Error(`unknown executor '${name}'`);
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
   * Store (or clear) a credential.
   *
   * An empty value REMOVES it, which is how a key is revoked without hunting for the file. Only the
   * three machine-local targets can be written: JaiRA will not put a secret in a project's
   * committed `.env`, and it cannot set a variable in someone else's shell.
   */
  setSecret(request: SetSecretRequest): { name: string; target: SecretTargetOf } {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(request.name)) {
      throw new Error(`'${request.name}' is not a usable secret name`);
    }
    if (request.target === "keychain") {
      const keychain = this.options.keychain;
      if (keychain?.available() !== true) {
        throw new Error(this.secretCapabilities().keychainReason ?? "no encrypted store is available here");
      }
      if (request.value.length === 0) keychain.remove(request.name);
      else keychain.set(request.name, request.value);
      return { name: request.name, target: request.target };
    }
    const file =
      request.target === "base-env-local"
        ? join(jairaBasePaths(this.baseDir).baseDir, ".env.local")
        : join(this.requireProjectDir(), ".env.local");
    writeEnvEntry(file, request.name, request.value);
    return { name: request.name, target: request.target };
  }

  // --- workflow authoring ----------------------------------------------------

  /** One state file as text, from a named layer. A file that does not exist yet reads as empty. */
  readWorkflow(request: ReadWorkflowRequest): WorkflowSource {
    const file = this.workflowFile(request.stateId, request.layer);
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
    try {
      JSON.parse(request.text);
    } catch (e) {
      throw new Error(`not valid JSON: ${(e as Error).message}`);
    }
    const file = this.workflowFile(request.stateId, request.layer);
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
    const from = this.workflowFile(request.stateId, request.layer);
    const to = this.workflowFile(request.to, request.toLayer);
    if (!existsSync(from)) throw new Error(`'${request.stateId}' does not exist in the ${request.layer} layer`);
    if (from === to) throw new Error("the source and destination are the same file");
    if (existsSync(to)) throw new Error(`'${request.to}' already exists in the ${request.toLayer} layer`);

    const renaming = request.copy !== true && request.to !== request.stateId;
    const referencedBy = renaming ? this.referrersOf(request.stateId) : [];
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
  deleteWorkflow(request: { stateId: string; layer: WorkflowLayer; force?: boolean }): WorkflowMutationResult {
    const file = this.workflowFile(request.stateId, request.layer);
    if (!existsSync(file)) throw new Error(`'${request.stateId}' does not exist in the ${request.layer} layer`);
    const referencedBy = this.referrersOf(request.stateId);
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
    if (!entry) throw new Error(`no schema named '${request.schemaId}'`);

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
   * everything through — a prompt, a skill's markdown, a state file, `config.json`. Containment is
   * {@link layerFile}'s, the same check the write surface rests on, so a `path` from the renderer
   * cannot reach outside the root it names.
   *
   * A type that is not text is refused rather than decoded. `readFileSync(.., "utf8")` on a PNG
   * succeeds and returns replacement characters, and the failure only shows up when someone saves
   * that back over the original — an error here is the difference between "no editor for this" and
   * silent data loss.
   */
  readFile(request: ReadFileRequest): FileSource {
    const file = this.layerFile(request.path, request.layer);
    const mime = mimeOfPath(request.path);
    if (!isTextMime(mime)) throw new Error(`'${request.path}' is ${mime}, which is not text`);
    const exists = existsSync(file);
    if (exists && statSync(file).isDirectory()) throw new Error(`'${request.path}' is a directory`);
    return {
      layer: request.layer,
      path: request.path,
      file,
      mime,
      text: exists ? readFileSync(file, "utf8") : "",
      exists,
      ...(this.stateIdOf(request.path) ?? {}),
    };
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
    const mime = mimeOfPath(request.path);
    if (!isTextMime(mime)) throw new Error(`'${request.path}' is ${mime}, which is not text`);
    if (mime === WORKFLOW_JSON) throw new Error(`'${request.path}' is a state file — write it through workflow:write`);
    const file = this.layerFile(request.path, request.layer);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, request.text, "utf8");
    this.publish({ type: "store:invalidate", scope: "workflows" });
    // Saving what a sync proposed is what accepts it — the description goes through here, and so
    // does a `.jsonc` state file.
    this.noteSyncWrite(request.layer, request.path);
    return {
      layer: request.layer,
      path: request.path,
      file,
      mime,
      text: request.text,
      exists: true,
      ...(this.stateIdOf(request.path) ?? {}),
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
    const file = this.layerFile(request.path, request.layer);
    if (existsSync(file)) throw new Error(`'${request.path}' already exists`);
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
    const from = this.layerFile(request.path, request.layer);
    const to = this.layerFile(request.to, request.layer);
    if (!existsSync(from)) throw new Error(`'${request.path}' does not exist in the ${request.layer} root`);
    if (from === to) throw new Error("the source and destination are the same path");
    if (existsSync(to)) throw new Error(`'${request.to}' already exists`);
    // Moving a directory into itself leaves the tree with an unreachable branch, and `renameSync`
    // reports it as a bare EINVAL that says nothing about what was attempted.
    if (to.startsWith(`${from}${sep}`)) throw new Error(`'${request.to}' is inside '${request.path}'`);

    const states = this.statesUnder(from, request.layer);
    const referencedBy = this.brokenBy(states);
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
    const file = this.layerFile(request.path, request.layer);
    if (!existsSync(file)) throw new Error(`'${request.path}' does not exist in the ${request.layer} root`);

    const states = this.statesUnder(file, request.layer);
    const referencedBy = this.brokenBy(states);
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
   * Never throws. Every way this can fail to have an answer — no project, no workflows, a base-layer
   * description — is a `blocked` string instead, because the panel is rendered by opening a file and
   * an exception there is a blank surface with no explanation on it.
   */
  syncStatus(request: { layer: WorkflowLayer; path: string; text?: string }): WorkflowSyncStatus {
    const base = {
      layer: request.layer,
      path: request.path,
      exists: false,
      synced: false,
      documentChanged: false,
      statesChanged: false,
      changedStates: [],
      suggested: null,
      ...(this.pendingSync !== undefined ? { pending: this.pendingSync.direction } : {}),
    } satisfies WorkflowSyncStatus;

    if (this.project === undefined) return { ...base, blocked: "open a project to sync its workflows" };
    // A shared-root description would be checked against whichever project happens to be open, and
    // recorded in that project's baseline — an answer that changes meaning per window. The honest
    // move is to say so rather than to produce it.
    if (request.layer !== "project") {
      return { ...base, blocked: "the shared root's description is not checked against one project's workflows" };
    }

    const project = this.p;
    let file: string;
    try {
      file = this.layerFile(request.path, request.layer);
    } catch (e) {
      return { ...base, blocked: (e as Error).message };
    }
    const exists = existsSync(file);
    const text = request.text ?? (exists ? readFileSync(file, "utf8") : "");

    // Which workflow this description is about — the file beside it, or every root when it is the
    // layer-wide `workflow.md`. A root named by a description that does not exist is reported here
    // rather than at run time, because it is a typo in a filename and the panel is where it shows.
    const root = descriptionRootOf(request.path);
    const known = new Set(browseWorkflows(project).workflows.map((w) => w.rootId));
    if (root !== null && !known.has(root)) {
      return {
        ...base,
        exists,
        blocked:
          known.size === 0
            ? `'${root}' names no workflow — this project has none yet`
            : `'${root}' names no workflow here. This project has: ${[...known].sort().join(", ")}`,
      };
    }

    // The state files this description is answerable for: its subtree, minus every subtree a nearer
    // description owns. Without the subtraction, editing a state would report drift on this
    // document AND on the one that actually describes it, with no way to say which is now stale.
    const scope = this.scopeOf(project, request.path);
    const covered = new Set(this.ownedFiles(project, request.path));
    const states = stateHashes(project.paths.workflowsDir, covered);
    const record = readSyncRecord(project.paths.syncFile, request.path);
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
              ? "this project has no workflows to sync against"
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
  async runSync(request: WorkflowSyncRequest): Promise<WorkflowSyncResult> {
    const project = this.p;
    if (request.layer !== "project") throw new Error("only this project's description can be synced");
    if (this.syncRun !== undefined) throw new Error("a sync is already running");

    const file = this.layerFile(request.path, request.layer);
    const spec = request.text ?? (existsSync(file) ? readFileSync(file, "utf8") : "");
    if (spec.trim() === "") throw new Error(`${request.path} is empty; there is nothing to sync`);

    // Scoped to what this description OWNS: the root it names, minus every subtree a nearer
    // description covers. The delegated subtrees are still in the digest, as contracts — a parent
    // has to be able to say what it handed off — but not as states this run may rewrite.
    const scope = this.scopeOf(project, request.path);
    const digest = workflowDigest(project, scope.digestOptions);
    // The same refusal `jaira workflow check` makes, for the same reason: a sync over partial
    // evidence would rewrite the document to describe workflows it could not read, or propose state
    // files against a graph it only half loaded.
    if (digest.unreadable.length > 0 || digest.loadErrors.length > 0) {
      const detail = [
        ...digest.unreadable.map((f) => `${f.file}: ${f.error}`),
        ...digest.loadErrors.map((e) => `${e.rootId}: ${e.error}`),
      ].join("; ");
      throw new Error(`cannot sync while a workflow does not load: ${detail}`);
    }
    if (digest.roots.length === 0) throw new Error("this project has no workflows to sync against");

    const bundle = loadBundle(syncWorkflowFiles(), syncRootId(request.direction));
    const fakeRules = request.fake !== undefined ? parseFakeRules(request.fake) : undefined;
    // Every state here is a prompt state, so the registry stays empty: a sync has no tools, runs no
    // commands and delegates to no agent, and giving it a registry that could would be a capability
    // nothing in it asks for.
    const registry = newRegistry();
    const prompt = buildPromptExecutor({
      ...(fakeRules !== undefined ? { fakeRules } : {}),
      defaults: modelDefaults(project.config, bundle, { fake: fakeRules !== undefined }),
    });
    const { modes: _modes, ...session } = sessionServicesFor(bundle, promptSummarizer(prompt));

    const abort = new AbortController();
    this.syncRun = abort;
    let result;
    try {
      result = await executeWorkflow({
        bundle,
        inputs: { spec, implementation: digest.markdown },
        registry,
        prompt,
        session,
        abortSignal: abort.signal,
      });
    } finally {
      this.syncRun = undefined;
    }
    if (statusOfResult(result) !== "completed") {
      const failure = "error" in result ? result.error : undefined;
      throw new Error(failure?.reason ?? "the sync did not finish");
    }

    const outcome = syncOutcomeOf(result.value, request.direction);
    // A clipped state is evidence the run did not see in full, and the caller must be told rather
    // than shown a proposal that quietly ignored half a workflow.
    const notes = [
      ...outcome.notes,
      ...digest.truncated.map((id) => `state '${id}' is too long for the digest and was clipped before the sync saw it`),
    ];
    // The findings are the evidence; a verdict that contradicts them is not believed here either.
    const verdict = verdictOfFindings(outcome.findings);

    const common = {
      direction: request.direction,
      workflows: digest.roots,
      requirements: outcome.requirements,
      findings: outcome.findings,
      extras: outcome.extras,
      verdict,
      ...(result.metrics.costUsd !== undefined ? { costUsd: result.metrics.costUsd } : {}),
    };

    if (request.direction === "document") {
      const text = outcome.document?.text ?? "";
      const changed = hashText(text) !== hashText(spec);
      // Nothing to accept means the two already agree — which is a sync that succeeded, so the
      // baseline moves. The alternative would leave a project that IS in step reporting drift
      // forever, with no button that could ever clear it.
      if (changed) this.beginPendingSync("document", request.path, [docKey(request.layer, request.path)]);
      else this.commitSyncRecord("document", request.path);
      return {
        ...common,
        document: { text, changes: outcome.document?.changes ?? [] },
        notes: changed ? notes : ["the description already describes what the workflows do", ...notes],
      };
    }

    const edits = this.placeEdits(outcome.edits ?? [], scope.ownership);
    const applicable = edits.filter((e) => e.applicable);
    const identical = (outcome.edits ?? []).length - edits.length;
    if (applicable.length > 0) {
      this.beginPendingSync(
        "states",
        request.path,
        applicable.map((e) => docKey(e.layer, e.path)),
      );
    } else if (edits.length === 0) {
      this.commitSyncRecord("states", request.path);
    }
    return {
      ...common,
      edits,
      notes: [
        ...notes,
        ...(identical > 0 ? [`${identical} proposed file(s) were already identical to what is on disk`] : []),
        ...(edits.length === 0 ? ["the workflows already run what the description asks for"] : []),
      ],
    };
  }

  /** Abort a sync in flight. False when there was nothing running. */
  cancelSync(): { canceled: boolean } {
    if (this.syncRun === undefined) return { canceled: false };
    this.syncRun.abort();
    return { canceled: true };
  }

  /**
   * Where each proposed state file goes, and whether it can be handed over as a draft.
   *
   * Three things are decided here rather than by the model, because all three are questions about
   * this project rather than about the workflow:
   *
   *  - **Containment.** A state id arrives from a language model by way of the renderer, and
   *    `../../.ssh/config` is a perfectly good relative path. {@link workflowFile} is the same check
   *    every other write rests on.
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
   */
  private placeEdits(edits: readonly StateEdit[], ownership: DescriptionOwnership): WorkflowSyncEdit[] {
    const out: WorkflowSyncEdit[] = [];
    const ownerOf = (stateId: string): DescriptionBoundary | undefined =>
      ownership.delegates.find((delegate) => isUnderState(stateId, delegate.root));
    for (const edit of edits) {
      // A blocked edit still names the file it would have touched, so the panel can say WHICH file
      // it declined to write rather than only that something was refused.
      const blocked = (path: string, reason: string): WorkflowSyncEdit => ({
        stateId: edit.stateId,
        layer: "project",
        path,
        action: edit.action,
        text: edit.text,
        reason: edit.reason,
        requirements: edit.requirements,
        applicable: false,
        blocked: reason,
      });
      try {
        this.workflowFile(edit.stateId, "project");
      } catch (e) {
        out.push(blocked(`workflows/${edit.stateId}.json`, (e as Error).message));
        continue;
      }
      const owner = ownerOf(edit.stateId);
      if (owner !== undefined) {
        out.push(
          blocked(
            this.existingStateFile(edit.stateId) ?? `workflows/${edit.stateId}.json`,
            `\`${owner.document}\` describes this state — change that document instead`,
          ),
        );
        continue;
      }
      const existing = this.existingStateFile(edit.stateId);
      if (existing !== undefined && /\.ya?ml$/i.test(existing)) {
        out.push(blocked(existing, "this state is authored as YAML, and the proposal is JSON"));
        continue;
      }
      const path = existing ?? `workflows/${edit.stateId}.json`;
      const file = this.layerFile(path, "project");
      const exists = existsSync(file);
      if (exists && hashText(readFileSync(file, "utf8")) === hashText(edit.text)) continue;
      out.push({
        stateId: edit.stateId,
        layer: "project",
        path,
        // What the model called it is a claim about the project, and the project is right here.
        action: exists ? "update" : "create",
        text: edit.text,
        reason: edit.reason,
        requirements: edit.requirements,
        applicable: true,
      });
    }
    return out;
  }

  /** The layer-relative path of a state's file, when the project already has one. */
  private existingStateFile(stateId: string): string | undefined {
    for (const suffix of [".json", ".jsonc", ".yaml", ".yml"]) {
      const path = `workflows/${stateId}${suffix}`;
      try {
        if (existsSync(this.layerFile(path, "project"))) return path;
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
  private beginPendingSync(direction: SyncDirection, document: string, targets: string[]): void {
    this.pendingSync = { direction, document, remaining: new Set(targets) };
  }

  /**
   * A file was written; if it was the last thing a pending sync proposed, the two are now in step.
   *
   * Saving a target counts as accepting it even when the text was edited on the way — someone who
   * reworded the rewritten document still took the sync, and refusing to record that would leave
   * them with a baseline that can never be reached except by accepting a proposal verbatim.
   */
  private noteSyncWrite(layer: WorkflowLayer, path: string): void {
    const pending = this.pendingSync;
    if (pending === undefined) return;
    if (!pending.remaining.delete(docKey(layer, path))) return;
    if (pending.remaining.size > 0) return;
    this.pendingSync = undefined;
    this.commitSyncRecord(pending.direction, pending.document);
  }

  /**
   * Record that the description and the state files agree, as of what is on disk right now.
   *
   * Both sides are re-read here rather than reused from the run: the point of the baseline is that
   * the pair agreed at one instant, and half of it taken before the save would describe a state of
   * the project that never existed.
   */
  private commitSyncRecord(direction: SyncDirection, document: string): void {
    const project = this.project;
    if (project === undefined) return;
    let text = "";
    try {
      const file = this.layerFile(document, "project");
      if (existsSync(file)) text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    // The same scope the status reads back, or the baseline would be taken over files this
    // description was never answerable for and every unrelated edit would read as drift.
    const covered = new Set(this.ownedFiles(project, document));
    commitSync(project.paths.syncFile, {
      document,
      documentHash: hashText(text),
      states: stateHashes(project.paths.workflowsDir, covered),
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
  private ownedFiles(project: Project, document: string): string[] {
    try {
      const scope = this.scopeOf(project, document);
      return workflowDigest(project, scope.digestOptions).files;
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
    project: Project,
    document: string,
  ): { root: string | null; ownership: DescriptionOwnership; digestOptions: WorkflowDigestOptions } {
    const browser = browseWorkflows(project);
    const descriptions = listDescriptions(project.paths.workflowsDir);
    const states = [...new Set(browser.workflows.flatMap((w) => w.states))];
    const ownership = ownershipOf(document, descriptions, states);
    const boundaries = ownership.delegates.map((delegate) => ({
      stateId: delegate.root,
      document: delegate.document,
      ...this.descriptionText(project, delegate.document),
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
  private descriptionText(project: Project, document: string): { text?: string } {
    try {
      const file = join(project.paths.jairaDir, ...document.split("/"));
      return existsSync(file) ? { text: readFileSync(file, "utf8") } : {};
    } catch {
      return {};
    }
  }

  // --- internals -------------------------------------------------------------

  /**
   * The states that declare `stateId` as a child.
   *
   * Empty with no project open: the reference graph is built from the project's browser, and a
   * base-only edit has nothing to check against. That is a real limitation rather than a safe
   * default — a shared state renamed with no project open can still break a project that used it —
   * so it is worth saying out loud rather than implying the check always ran.
   */
  private referrersOf(stateId: string): string[] {
    if (!this.project) return [];
    try {
      return stateView(this.p, stateId, this.browseWorkflows(), this.stateViewOptions()).referencedBy;
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
  private brokenBy(states: string[]): string[] {
    if (!this.project || states.length === 0) return [];
    const moving = new Set(states);
    const broken = new Set<string>();
    for (const entry of this.browseWorkflows().files) {
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
  private statesUnder(file: string, layer: WorkflowLayer): string[] {
    const workflowsDir =
      layer === "base" ? jairaBasePaths(this.baseDir).workflowsDir : this.requireProject().paths.workflowsDir;
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
  private layerFile(path: string, layer: WorkflowLayer): string {
    const root = layer === "base" ? jairaBasePaths(this.baseDir).baseDir : this.requireProject().paths.jairaDir;
    const file = resolvePath(root, path);
    const rel = relative(root, file);
    if (rel.startsWith("..") || rel.length === 0 || resolvePath(root, rel) !== file) {
      throw new Error(`'${path}' is not inside the ${layer} root`);
    }
    return file;
  }

  /**
   * The absolute file a `(stateId, layer)` pair names, refusing anything outside the layer's root.
   *
   * This is the containment check the write surface rests on. A state id arrives from the renderer
   * — the untrusted half of the boundary (DESIGN §11.2) — and `../../.ssh/authorized_keys` is a
   * perfectly good relative path. Resolving first and then proving the result is still under the
   * root is the check that cannot be fooled by encoding tricks, because it tests the answer rather
   * than the input.
   */
  private workflowFile(stateId: string, layer: WorkflowLayer): string {
    const root =
      layer === "base"
        ? jairaBasePaths(this.baseDir).workflowsDir
        : this.requireProject().paths.workflowsDir;
    const file = resolvePath(root, `${stateId}.json`);
    const rel = relative(root, file);
    if (rel.startsWith("..") || rel.length === 0 || resolvePath(root, rel) !== file) {
      throw new Error(`'${stateId}' does not name a state inside the ${layer} workflows directory`);
    }
    return file;
  }

  /** The merged configuration, or plain defaults when no project is open. */
  private effectiveConfig(): JairaConfigOf {
    if (this.project) return this.project.config;
    const doc = readJsonIfPresent(jairaBasePaths(this.baseDir).configFile);
    return parseConfig(doc ?? {});
  }

  private secretResolver(): SecretResolver {
    const keychain = this.options.keychain;
    return new SecretResolver({
      ...(this.project !== undefined ? { projectDir: this.project.paths.projectDir } : {}),
      baseDir: this.baseDir,
      ...(keychain?.available() === true ? { keychain: (name: string) => keychain.get(name) } : {}),
    });
  }

  private requireProject(): Project {
    if (!this.project) throw new Error("no project is open");
    return this.project;
  }

  private requireProjectDir(): string {
    return this.requireProject().paths.projectDir;
  }
}

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
  const file = jairaBasePaths(baseDir).settingsFile;
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
