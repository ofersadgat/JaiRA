/**
 * Task lifecycle (DESIGN §12, phases-1/2 slice): create → start → finish /
 * cancel, with workflow-level re-runs after interruption. Engine wiring
 * (executors, providers, interaction) is the caller's concern — this module
 * owns only the durable bookkeeping around a run.
 */
import type { Failure, FunctionCapabilities, JsonValue } from "@declarative-ai/exec";
import { loadBundle, validateBundle, type WorkflowBundle } from "@declarative-ai/hw";
import { newTaskId, isStartableStatus, type TaskMeta, type TaskStatus } from "@jaira/shared";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "./snapshots";
import type { Project } from "./project";

export interface CreateTaskInput {
  title: string;
  workflow: string;
  description?: string;
  labels?: string[];
  inputs?: Record<string, JsonValue>;
  branch?: string;
  parentTaskId?: string;
  id?: string;
}

export function createTask(project: Project, input: CreateTaskInput, nowMs = Date.now()): TaskMeta {
  const meta: TaskMeta = {
    id: input.id ?? newTaskId(),
    title: input.title,
    workflow: input.workflow,
    createdAt: new Date(nowMs).toISOString(),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
  };
  if (project.runtime.get(meta.id)) throw new Error(`task '${meta.id}' already exists`);
  project.tasks.write(meta);
  project.runtime.insert(meta.id, nowMs, { branch: meta.branch });
  return meta;
}

export interface StartedRun {
  meta: TaskMeta;
  runId: number;
  bundle: WorkflowBundle;
  snapshotHash: string;
  snapshotDir: string;
  /** true when this run re-uses a previously pinned snapshot (re-run after interruption). */
  pinned: boolean;
}

export interface BeginRunOptions {
  /**
   * The registry's `functions` facet the bundle will run against. Passing it
   * lets validation resolve every `functionRef` (an interactive host function,
   * a delegated agent, a sub-workflow) at task start instead of failing partway
   * into the run. Omitted ⇒ unregistered refs are warnings, per
   * `validateBundle`'s default.
   */
  functions?: ReadonlyMap<string, FunctionCapabilities>;
  nowMs?: number;
}

/**
 * Transition a task to `running` and pin its workflow version.
 *
 * First run: read live `workflows/`, validate (enforced at task start,
 * DESIGN §5.2), snapshot (§5.3), pin the hash. Re-run after interruption or
 * failure: execute the *pinned* snapshot again from the workflow start
 * (DESIGN §1a item 1) — live workflow edits never affect an existing task.
 */
export function beginTaskRun(project: Project, taskId: string, options: BeginRunOptions = {}): StartedRun {
  const nowMs = options.nowMs ?? Date.now();
  const runtime = project.runtime.get(taskId);
  if (!runtime) throw new Error(`unknown task '${taskId}'`);
  if (!isStartableStatus(runtime.status)) {
    throw new Error(`task '${taskId}' is ${runtime.status}; only queued/interrupted/failed tasks can start`);
  }
  const meta = project.tasks.read(taskId);

  let bundle: WorkflowBundle;
  let hash: string;
  let dir: string;
  const pinned = runtime.snapshotHash !== undefined;
  if (runtime.snapshotHash !== undefined) {
    bundle = loadSnapshot(project.paths.snapshotsDir, runtime.snapshotHash);
    hash = runtime.snapshotHash;
    dir = `${project.paths.snapshotsDir}/${hash}`;
  } else {
    const files = readWorkflowFiles(project.paths.workflowsDir);
    bundle = loadBundle(files, meta.workflow);
    const report = validateBundle(bundle, options.functions ? { functions: options.functions } : {});
    if (report.errors.length > 0) {
      const detail = report.errors.map((e) => `${e.stateId} ${e.path}: ${e.message}`).join("\n  ");
      throw new Error(`workflow validation failed for '${meta.workflow}':\n  ${detail}`);
    }
    const snap = ensureSnapshot(project.paths.snapshotsDir, bundle);
    hash = snap.hash;
    dir = snap.dir;
  }

  const runId = project.db.transaction(() => {
    project.runtime.setSnapshot(taskId, hash, nowMs);
    project.runtime.setStatus(taskId, "running", nowMs);
    return project.runtime.beginRun(taskId, hash, nowMs);
  })();

  return { meta, runId, bundle, snapshotHash: hash, snapshotDir: dir, pinned };
}

export type RunEndStatus = Extract<TaskStatus, "completed" | "failed" | "canceled">;

export function finishTaskRun(
  project: Project,
  taskId: string,
  runId: number,
  status: RunEndStatus,
  result?: { outputs?: unknown; failure?: Failure },
  nowMs = Date.now(),
): void {
  const outcome = status === "completed" ? "success" : status === "canceled" ? "canceled" : "error";
  project.db.transaction(() => {
    project.runtime.endRun(runId, outcome, nowMs, {
      outputsJson: result?.outputs !== undefined ? JSON.stringify(result.outputs) : undefined,
      failureJson: result?.failure !== undefined ? JSON.stringify(result.failure) : undefined,
    });
    project.runtime.setStatus(taskId, status, nowMs);
  })();
}

/**
 * Cancel a non-terminal task. In this headless v1 a `running` row with no live
 * engine in this process is a stale crash residue, so cancel simply records
 * the terminal status; in-process runs are canceled by aborting the engine
 * (the CLI does this on Ctrl-C) and land here through `finishTaskRun`.
 */
export function cancelTask(project: Project, taskId: string, nowMs = Date.now()): void {
  project.runtime.assertCancelable(taskId);
  project.db.transaction(() => {
    project.db
      .prepare(`UPDATE runs SET ended_at = ?, outcome = 'canceled' WHERE task_id = ? AND ended_at IS NULL`)
      .run(nowMs, taskId);
    project.runtime.setStatus(taskId, "canceled", nowMs);
  })();
}
