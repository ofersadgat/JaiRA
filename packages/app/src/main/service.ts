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
  buildPromptExecutor,
  executeWorkflow,
  functionNamesOf,
  InteractionHub,
  modelDefaults,
  newRegistry,
  parseFakeRules,
  ScriptedFunctions,
  statusOfResult,
  type FakeRule,
  type HubRequest,
} from "@jaira/runtime";
import { isComponentName, parseComponentConfig, validateComponentResult } from "@jaira/shared";
import type {
  BoardView,
  ComponentConfig,
  CreateTaskRequest,
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

  constructor(private readonly options: AppServiceOptions = {}) {
    this.hub = new InteractionHub({
      onRequest: (request) => this.publishInteraction(request),
      onResolved: (requestId) => {
        this.requestTask.delete(requestId);
        this.publish({ type: "interaction:resolved", requestId });
      },
      ...(options.nextInteractionId !== undefined ? { nextId: options.nextInteractionId } : {}),
    });
  }

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
    const started = beginTaskRun(project, taskId, { functions: registry.functions });
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
      run.abort.abort();
    } else {
      cancelTask(this.p, taskId);
      this.publish({ type: "store:invalidate", scope: "tasks" });
    }
    return { taskId };
  }

  // --- interaction -----------------------------------------------------------

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
