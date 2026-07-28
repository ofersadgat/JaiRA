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
import type { JsonValue } from "@declarative-ai/json";
import {
  beginTaskRun,
  boardView,
  ensureWorkspace,
  cancelTask,
  createTask,
  finishTaskRun,
  openProject,
  taskDetailView,
  taskSummaries,
  type Project,
} from "@jaira/persistence";
import {
  ApprovalHub,
  buildPromptExecutor,
  compilePolicy,
  executeWorkflow,
  gateCapabilities,
  registerAgentRuntimes,
  functionNamesOf,
  InteractionHub,
  modelDefaults,
  newRegistry,
  parseFakeRules,
  policyCanEscalate,
  ScriptedFunctions,
  statusOfResult,
  type ApprovalRequest,
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
  PendingApproval,
  PendingInteraction,
  PushMessage,
  StartTaskRequest,
  TaskDetail,
  TaskSummary,
} from "@jaira/shared";

export type Publish = (message: PushMessage) => void;

export interface AppServiceOptions {
  /** Where pushes go — the Electron main process forwards them to the renderer. */
  publish?: Publish;
  /** Deterministic request ids in tests. */
  nextInteractionId?: () => string;
  nextApprovalId?: () => string;
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

  // --- lifecycle -------------------------------------------------------------

  async open(dir: string): Promise<{ dir: string; recovered: string[] }> {
    await this.close();
    const project = openProject(dir);
    this.project = project;
    if (project.recovered.length > 0) this.publish({ type: "store:invalidate", scope: "tasks" });
    return { dir: project.paths.projectDir, recovered: project.recovered };
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
    // Delegated agent runtimes are available to every run (DESIGN §8.1); a state
    // reaches one with a `claude-code` function op.
    registerAgentRuntimes(registry, { execEnv: project.config.execEnvironment });

    const started = beginTaskRun(project, taskId, { functions: registry.functions });

    // §8.2: refuse a state whose runtime cannot enforce the policy it runs under,
    // rather than letting it run unguarded.
    const gateIssues = gateCapabilities(registry, started.bundle.source ?? {}, {
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
          workspace: {
            root: workspace.root,
            ...(workspace.treeHash !== undefined ? { treeHash: workspace.treeHash } : {}),
          },
          abortSignal: abort.signal,
        });
        const status = statusOfResult(result);
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
