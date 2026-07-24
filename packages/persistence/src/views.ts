/**
 * Read models over an open project (DESIGN §11): task summaries, the board, and
 * task detail.
 *
 * These are pure reads — journal + task files + runtime rows in, view models out
 * — so both the Electron main process and the headless CLI render the same board
 * from the same code. Anything that *runs* a workflow lives above this.
 */
import type { JsonValue } from "@declarative-ai/json";
import { loadBundle, type StateDef, type WorkflowBundle } from "@declarative-ai/hw";
import type { BoardView, TaskDetail, TaskSummary, TimelineEntry } from "@jaira/shared";
import type { Project } from "./project";
import {
  breadcrumbOf,
  eventsOf,
  projectBoard,
  projectRun,
  type ProjectedRun,
  type TaskProjection,
  type WorkflowShape,
} from "./projection";
import { loadSnapshot, readWorkflowFiles } from "./snapshots";
import { workflowShape } from "./shape";

export interface ViewOptions {
  /**
   * Function names that need a human, so a parked gate reads
   * `waiting_for_user` rather than plain `running`. Callers holding a registry
   * pass its interactive entries; a caller with only the document can pass
   * {@link functionRefsOf}, treating every function op as a potential gate.
   */
  interactiveFunctions?: ReadonlySet<string>;
}

/** Every `operation.function` name a bundle references (a pure document query). */
export function functionRefsOf(bundle: WorkflowBundle): Set<string> {
  const names = new Set<string>();
  for (const def of Object.values(bundle.states)) {
    const op = (def as StateDef & { operation?: { kind?: string; functionRef?: unknown } }).operation;
    if (op?.kind === "function" && typeof op.functionRef === "string") names.add(op.functionRef);
  }
  return names;
}

export function taskSummaries(project: Project): TaskSummary[] {
  return project.runtime.list().map((row) => {
    const meta = project.tasks.tryRead(row.taskId);
    return {
      taskId: row.taskId,
      title: meta?.title ?? "(missing task file)",
      status: row.status,
      workflow: meta?.workflow ?? "",
      ...(meta?.labels !== undefined ? { labels: meta.labels } : {}),
      ...(row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash } : {}),
      createdAt: meta?.createdAt ?? new Date(row.createdAt).toISOString(),
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * The bundle a board level is drawn from. A pinned snapshot wins — execution
 * reads the snapshot (DESIGN §5.3), so that is what the run being displayed
 * actually followed; live `workflows/` is the fallback before anything is pinned.
 */
export function bundleFor(project: Project, workflow: string, snapshotHash?: string): WorkflowBundle | undefined {
  if (snapshotHash !== undefined) {
    try {
      return loadSnapshot(project.paths.snapshotsDir, snapshotHash);
    } catch {
      // A missing/corrupt snapshot shouldn't blank the board — fall back below.
    }
  }
  try {
    return loadBundle(readWorkflowFiles(project.paths.workflowsDir), workflow);
  } catch {
    return undefined;
  }
}

function shapeFor(
  project: Project,
  workflow: string,
  snapshotHash: string | undefined,
  options?: ViewOptions,
): { shape: WorkflowShape; rootId: string } | undefined {
  const bundle = bundleFor(project, workflow, snapshotHash);
  if (!bundle) return undefined;
  const interactive = options?.interactiveFunctions ?? functionRefsOf(bundle);
  return { shape: workflowShape(bundle, { interactiveFunctions: interactive }), rootId: bundle.rootId };
}

/** The projected latest run of a task (empty when it has never run). */
export function latestRun(project: Project, taskId: string, shape?: WorkflowShape): ProjectedRun {
  const runs = project.runtime.listRuns(taskId);
  const latest = runs[runs.length - 1];
  if (!latest) return { instances: [], activePath: [], blocked: [] };
  const { events, atMs } = eventsOf(project.events.list(taskId, { runId: latest.id }));
  return projectRun(events, shape, atMs);
}

/**
 * Project a board level. With no `level`, the root board of the workflow the most
 * recently updated task runs — the "open the app and see a board" case.
 */
export function boardView(project: Project, level?: string, options?: ViewOptions): BoardView {
  const summaries = taskSummaries(project);
  const newest = [...summaries].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const workflow = newest?.workflow ?? "";
  const resolved = shapeFor(project, workflow, newest?.snapshotHash, options);
  if (!resolved) {
    const target = level ?? workflow;
    return { level: target, breadcrumb: [target], columns: [], atLevel: [], finished: [] };
  }
  const { shape, rootId } = resolved;
  const target = level ?? rootId;
  const projections: TaskProjection[] = summaries.map((summary) => ({
    taskId: summary.taskId,
    title: summary.title,
    status: summary.status,
    workflow: summary.workflow,
    ...(summary.labels !== undefined ? { labels: summary.labels } : {}),
    updatedAt: summary.updatedAt,
    run: latestRun(project, summary.taskId, shape),
  }));
  return projectBoard(shape, target, projections, { breadcrumb: breadcrumbOf(shape, rootId, target) });
}

/** Timeline entries returned by default (newest kept). */
export const TIMELINE_LIMIT = 200;

export function taskDetailView(project: Project, taskId: string, options?: ViewOptions): TaskDetail {
  const row = project.runtime.get(taskId);
  if (!row) throw new Error(`unknown task '${taskId}'`);
  const meta = project.tasks.tryRead(taskId);
  const shape = meta ? shapeFor(project, meta.workflow, row.snapshotHash, options)?.shape : undefined;
  const run = latestRun(project, taskId, shape);
  const timeline: TimelineEntry[] = project.events
    .list(taskId)
    .slice(-TIMELINE_LIMIT)
    .map((r) => ({
      seq: r.seq,
      runId: r.runId,
      type: r.type,
      at: r.createdAt,
      ...(r.instanceId !== undefined ? { instanceId: r.instanceId } : {}),
      ...("stateId" in r.event && typeof r.event.stateId === "string" ? { stateId: r.event.stateId } : {}),
      event: r.event as unknown as JsonValue,
    }));
  return {
    taskId,
    title: meta?.title ?? "(missing task file)",
    ...(meta?.description !== undefined ? { description: meta.description } : {}),
    ...(meta?.labels !== undefined ? { labels: meta.labels } : {}),
    workflow: meta?.workflow ?? "",
    status: row.status,
    ...(row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash } : {}),
    ...(row.branch !== undefined ? { branch: row.branch } : {}),
    createdAt: meta?.createdAt ?? new Date(row.createdAt).toISOString(),
    ...(meta?.inputs !== undefined ? { inputs: meta.inputs } : {}),
    instances: run.instances,
    activePath: run.activePath,
    blocked: run.blocked,
    runs: project.runtime.listRuns(taskId).map((r) => ({
      runId: r.id,
      outcome: r.outcome ?? "running",
      snapshotHash: r.snapshotHash,
      startedAt: r.startedAt,
      ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
      ...(r.outputsJson !== undefined ? { outputs: JSON.parse(r.outputsJson) as JsonValue } : {}),
      ...(r.failureJson !== undefined ? { failure: JSON.parse(r.failureJson) as JsonValue } : {}),
    })),
    timeline,
  };
}
