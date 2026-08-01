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
import { watch, type FSWatcher } from "node:fs";
import type { JsonValue } from "@declarative-ai/json";
import {
  beginTaskRun,
  boardView,
  browseWorkflows,
  ensureWorkspace,
  RunOwner,
  cancelTask,
  createTask,
  finishTaskRun,
  historySize,
  openProject,
  pruneHistory,
  taskDetailView,
  taskSummaries,
  type Project,
} from "@jaira/persistence";
import {
  ApprovalHub,
  artifactWiring,
  buildPromptExecutor,
  compilePolicy,
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
  type ApprovalRequest,
  type ExecObserver,
  type FakeRule,
  type HubRequest,
  type PolicyAuditEntry,
} from "@jaira/runtime";
import { isComponentName, parseComponentConfig, validateComponentResult } from "@jaira/shared";
import type {
  ApprovalScope,
  BoardView,
  ComponentConfig,
  CreateTaskRequest,
  HistorySize,
  PendingApproval,
  PendingInteraction,
  PruneRequest,
  PruneResult,
  PushMessage,
  StartTaskRequest,
  TaskDetail,
  TaskSummary,
  WorkflowBrowser,
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

  constructor(private readonly options: AppServiceOptions = {}) {
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

  /** The `.jaira/workflows/` watcher and its debounce timer (§11.1 re-lint). */
  private watcher?: FSWatcher;
  private watchTimer?: ReturnType<typeof setTimeout>;

  // --- lifecycle -------------------------------------------------------------

  async open(dir: string): Promise<{ dir: string; recovered: string[] }> {
    await this.close();
    const project = openProject(dir);
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
    try {
      this.watcher = watch(project.paths.workflowsDir, { recursive: true }, notify);
    } catch {
      try {
        this.watcher = watch(project.paths.workflowsDir, notify);
      } catch {
        this.watcher = undefined;
      }
    }
    this.watcher?.on("error", () => {
      // A deleted workflows directory ends the watch; on-demand browsing still works.
      this.watcher?.close();
      this.watcher = undefined;
    });
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
    this.watcher?.close();
    this.watcher = undefined;
    this.hub.rejectAll("the project was closed");
    this.approvals.denyAll();
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

  board(level?: string): BoardView {
    return boardView(this.p, level, this.viewOptions());
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
    registerAgentRuntimes(registry, { execEnv: project.config.execEnvironment, observer });
    // Non-Claude CLIs the project configured (DESIGN §8.1). Nothing is registered
    // when none are, so a state naming one fails honestly instead of running some
    // default binary.
    registerGenericAgents(registry, {
      execEnv: project.config.execEnvironment,
      exec,
      ...(project.config.agents.genericCli !== undefined ? { agents: project.config.agents.genericCli } : {}),
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
}
