/**
 * Read models over an open project (DESIGN §11): task summaries, the board, and
 * task detail.
 *
 * These are pure reads — journal + task files + runtime rows in, view models out
 * — so both the Electron main process and the headless CLI render the same board
 * from the same code. Anything that *runs* a workflow lives above this.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/json";
import { loadBundle, type StateDef, type WorkflowBundle } from "@declarative-ai/hw";
import type { BoardView, InstanceAddress, InstanceNode, TaskDetail, TaskSummary, TimelineEntry } from "@jaira/shared";
import type { Project } from "./project";
import { workflowLoadOptions } from "./workflowRefs";
import {
  breadcrumbOf,
  eventsOf,
  foldRuns,
  projectBoard,
  projectRun,
  type ProjectedRun,
  type TaskProjection,
  type WorkflowShape,
} from "./projection";
import { loadSnapshot, readWorkflowFiles } from "./snapshots";
import { bareSessionId, ON_RECORD, scopedSessionId } from "./sessionStore";
import { workflowShape } from "./shape";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.views");

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
      ...(meta?.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
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
    // Tolerant: a half-saved file the workflow does not reference must not blank the
    // board (the user is editing in another window).
    return loadBundle(
      readWorkflowFiles(project.paths.workflowsDir, { onError: () => undefined }),
      workflow,
      workflowLoadOptions(project.paths, { tolerant: true, path: project.config.workflows.path }),
    );
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

/**
 * The operation failures and blocked children recorded for a run, innermost
 * first.
 *
 * A composite workflow reports the *parent's* view of a failure ("child 'goals'
 * terminated with error and no transition handled it"), which says nothing about
 * what actually went wrong. The root cause is in the journal, so surfacing it is
 * how a failed run becomes diagnosable instead of a shrug.
 */
export function runCauses(project: Project, taskId: string, runId?: number): Array<{ stateId: string; reason: string }> {
  const runs = project.runtime.listRuns(taskId);
  const target = runId ?? runs[runs.length - 1]?.id;
  if (target === undefined) return [];
  const causes: Array<{ stateId: string; reason: string }> = [];
  for (const row of project.events.list(taskId, { runId: target })) {
    if (row.event.type === "operation.failed") {
      causes.push({ stateId: row.event.stateId, reason: row.event.failure.reason });
    } else if (row.event.type === "instance.blocked") {
      causes.push({ stateId: row.event.stateId, reason: row.event.reason });
    }
  }
  return causes;
}

/**
 * One state instance, and the conversation position its operation ran at.
 *
 * This is the join the leaf panel asks for twice — "the session for this state" and "every state
 * this task went through, with its session" — and it needs nothing new recorded. The engine already
 * carries it: `withSessionPosition` reports the position a call ENDED at on `ExecMetrics.sessionRef`
 * (`<id>@<seq+1>`, its documented contract), and hw puts those metrics on `operation.completed`. The
 * journal has held the link all along; it was simply not queryable without reading every payload,
 * which is what the `session_ref` generated column fixed.
 */
export interface StateSession {
  runId: number;
  instanceId: string;
  stateId: string;
  /** The conversation. Opaque — nothing here parses it beyond splitting the position off. */
  sessionId: string;
  /** Where THIS operation's record sits in it. One position back from where the call ended. */
  seq: number;
  at: number;
  /**
   * How the call ENDED — and the last two cannot come from the journal at all.
   *
   * A completed call and a failed one each wrote a terminal event; a call the process died inside
   * wrote neither, and is recovered from its own record row instead (see
   * {@link interruptedSessions}). Absent means the journal predates the distinction, which reads as
   * the success it always did.
   *
   * `running` is that same recovery pass looking at a call that has not ended at ALL. A live call
   * and a crashed one leave the journal in exactly the same shape — a start with no terminal event —
   * so for as long as this said only `interrupted`, every state a person watched while it was
   * speaking was labelled with its own death notice, and the panel beside it said the process had
   * ended. The record row is what tells them apart: `open` means a live process is streaming into
   * it, which is the whole reason that status exists.
   */
  outcome?: "success" | "error" | "interrupted" | "running";
}

/**
 * Split `<id>@<seq>` — on the LAST `@`, because a session id may contain one.
 *
 * A compaction mints `planning~compact1@7`, so a ref built from it reads `planning~compact1@7@8`.
 * Splitting on the first `@` would name a conversation that does not exist.
 */
export function parseSessionRef(ref: string): { id: string; seq: number } | undefined {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return undefined;
  const seq = Number(ref.slice(at + 1));
  return Number.isInteger(seq) ? { id: ref.slice(0, at), seq } : undefined;
}

/**
 * Every operation of a task that ran in a conversation, oldest first.
 *
 * `runId` narrows it to one run; absent, it is the task's whole history — which is what the "all the
 * other states the executor went through" half of the leaf panel reads.
 */
export function stateSessions(project: Project, taskId: string, runId?: number): StateSession[] {
  // Queried through the `session_ref` generated column rather than by folding the whole journal: the
  // rows wanted are a small fraction of a run's events, the column is indexed, and NOT NULL on it is
  // precisely "this operation ran in a conversation". That column is what migration 1 exists for.
  //
  // BOTH settled kinds. A failed call ran, said things, and cost money — its transcript is in the
  // record store exactly as a successful one's is, and reading only completions is why an errored
  // state's conversation was unreachable from the panel that lists them. It appears here at all
  // because `operation.failed` now carries the metrics a post-dispatch failure has (upstream), and
  // `session_ref` is derived from them.
  const rows = project.db
    .prepare(
      `SELECT run_id, type, payload_json, session_ref, created_at FROM state_machine_events
        WHERE task_id = ? AND type IN ('operation.completed', 'operation.failed') AND session_ref IS NOT NULL
          ${runId === undefined ? "" : "AND run_id = ?"}
        ORDER BY seq`,
    )
    .all(...(runId === undefined ? [taskId] : [taskId, runId])) as Array<{
    run_id: number;
    type: string;
    payload_json: string;
    session_ref: string;
    created_at: number;
  }>;
  const out: StateSession[] = [];
  for (const row of rows) {
    const position = parseSessionRef(row.session_ref);
    if (position === undefined) continue;
    const event = JSON.parse(row.payload_json) as { instanceId: string; stateId: string };
    out.push({
      runId: row.run_id,
      instanceId: event.instanceId,
      stateId: event.stateId,
      sessionId: position.id,
      // The record was written at the position the call STARTED from, which is one back from where it
      // ended. `withSessionPosition` reports the end because that is the value a caller cannot
      // otherwise learn — a call that had to fork ended somewhere it did not begin.
      seq: position.seq - 1,
      at: row.created_at,
      outcome: row.type === "operation.failed" ? "error" : "success",
    });
  }
  out.push(...interruptedSessions(project, taskId, runId));
  // One list in time order, however each row was found — the panel reads a run top to bottom, and a
  // recovered call belongs where it happened rather than appended after everything that outlived it.
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The calls with no terminal event — recovered by pairing the journal against the record store,
 * because neither half can answer alone.
 *
 * A crash is the case this was written for and not the only one it finds: a call that is STILL
 * RUNNING leaves the journal in the identical shape, since the terminal event is written when it
 * ends. Both arrive here and the record's own status separates them — see {@link
 * StateSession.outcome}.
 *
 * A process that dies mid-call writes no `operation.completed` and no `operation.failed`, so the
 * journal join every other row here uses does not exist. What survives is an `operation.started`
 * event with the instance and state on it, and an operation record holding the position — and,
 * since recovery settles them, the outcome.
 *
 * ## A call can SETTLE and still lose its terminal event
 *
 * The process dying is not the only way. The engine publishes the operation node — and the journal
 * event with it — AFTER the call has returned, so anything that throws in between leaves a record
 * settled `completed`, holding the whole answer, with nothing in the journal to find it by. That is
 * not hypothetical: a store missing `refAt` did exactly this, and a finished chat vanished from the
 * panel mid-conversation while its transcript sat in the database. So the run filter admits every
 * NON-SUCCESS outcome — errored, canceled, interrupted — the record filter is "no terminal event
 * names this position" rather than "not completed", and the outcome comes off the record's own
 * status instead of being assumed. A run that ended tidily still contributes nothing: every start is
 * terminated, so it leaves before any of this.
 *
 * CANCELED is in that list because stopping a run is the ordinary way to leave a start unterminated,
 * not an exotic one. Cancellation ends the instance (`instance.terminated`, outcome `canceled`) and
 * settles the record where it stood — a `failed` row holding everything the call had streamed — but
 * it emits no `operation.completed` or `operation.failed`, so the journal join above finds nothing
 * and this is the only pass that can. Naming only `interrupted` and `error` here is what made a
 * stopped conversation read as one that had never said anything, with every word of it in the
 * database: `stateSessions` returned no row, so the chat had no host, no position, and no thread.
 *
 * ## …and a run can END WELL and still be holding an unsettled call
 *
 * A conversation continued by hand outlives its run. The run finishes, the task reads `completed`,
 * and every message after that is a chat turn recorded under the same run id — so a process killed
 * during one leaves an open record inside a run whose outcome is `success`, which the filter above
 * excludes by name. The consequence is not a missing row, it is a WRONG one: the position that
 * record holds is invisible, so the next message computes it as free, collides with it, and forks —
 * onto a branch that does not contain the interrupted turn, taking it off the screen for good.
 *
 * Hence the second arm of the filter. It asks the records rather than the outcome — "is this run
 * holding anything unsettled" — which is the actual precondition, and it costs a cheap EXISTS on
 * an indexed column. A run that ended tidily has no open record and no unterminated start, so it
 * still leaves before any of this whichever arm admitted it.
 *
 * ## Why pairing in ORDER is sound rather than a guess
 *
 * Both lists are in START order: the engine emits `operation.started` immediately before dispatch,
 * and `withRecord` inserts the record immediately after, so the n-th unterminated start is the n-th
 * record left behind — under concurrency too, since both orders are the same order. The lists are
 * required to be the same LENGTH before anything is paired: a mismatch means an operation started
 * without recording (a pre-dispatch failure is excluded by being terminated, but the invariant is
 * upstream's to keep, not ours to assume), and the honest answer to an ambiguous pairing is no rows
 * at all. A conversation attributed to the wrong state is worse than one that is merely missing.
 */
function interruptedSessions(project: Project, taskId: string, runId?: number): StateSession[] {
  // Read through `project.db` like the query above it, rather than through the runtime and event
  // STORES: everything here is one join over three tables, and depending on the wrappers would make
  // this the only projection in the file that cannot run against a bare database handle.
  const runs = project.db
    .prepare(
      `SELECT id, ended_at FROM runs
        WHERE task_id = ?
          AND (outcome IN ('interrupted', 'error', 'canceled')
               OR EXISTS (SELECT 1 FROM operation_records r
                           WHERE r.task_id = runs.task_id AND r.run_id = runs.id AND r.status = 'open'))
          ${runId === undefined ? "" : "AND id = ?"} ORDER BY id`,
    )
    .all(...(runId === undefined ? [taskId] : [taskId, runId])) as Array<{ id: number; ended_at: number | null }>;
  const out: StateSession[] = [];
  for (const run of runs) {
    // Which instances started an operation that never settled — the calls that were in flight.
    const events = project.db
      .prepare(
        `SELECT type, payload_json, session_ref, created_at FROM state_machine_events
          WHERE task_id = ? AND run_id = ?
            AND type IN ('operation.started', 'operation.completed', 'operation.failed')
          ORDER BY seq`,
      )
      .all(taskId, run.id) as Array<{ type: string; payload_json: string; session_ref: string | null; created_at: number }>;
    const scope = { taskId, runId: run.id };
    const started = new Map<string, { stateId: string; at: number }>();
    /**
     * The POSITIONS the journal already accounts for — one back from the end each terminal event
     * reported, spelled `<sessionId>@<seq>` here purely as a set key.
     *
     * Positions rather than record ids. A record's id is opaque: `withRecord` stamps a content hash on
     * it, and the `<sessionId>:<seq>` spelling a placed record used to carry duplicated the pair
     * `session_positions` already keys on (migration 8). Matching on the position asks the question
     * directly instead of reconstructing an id and hoping the two agree.
     */
    const listed = new Set<string>();
    for (const row of events) {
      const event = JSON.parse(row.payload_json) as { instanceId?: string; stateId?: string };
      if (event.instanceId === undefined) continue;
      if (row.type === "operation.started") {
        started.set(event.instanceId, { stateId: event.stateId ?? "", at: row.created_at });
      } else {
        started.delete(event.instanceId);
        const end = row.session_ref === null ? undefined : parseSessionRef(row.session_ref);
        // SCOPED to match what the store wrote: a journal ref names a session the way the workflow
        // file does, and `session_positions.session_id` carries the run namespace in front of it.
        if (end !== undefined) listed.add(`${scopedSessionId(scope, end.id)}@${end.seq - 1}`);
      }
    }
    if (started.size === 0) continue;
    // The records those calls left: placed ones — an unplaced call has no conversation to list —
    // that no terminal event accounts for. Asking the journal rather than the record's status is what
    // finds a call that SETTLED and then lost its event; a status test would call that one listed and
    // leave the answer it holds unreachable. Ordered by insertion, which is start order.
    const records = (
      project.db
        .prepare(
          `SELECT p.session_id AS session_id, p.seq AS seq, r.status AS status FROM operation_records r
           JOIN session_positions p ON ${ON_RECORD}
          WHERE r.task_id = ? AND r.run_id = ?
          ORDER BY r.id`,
        )
        .all(taskId, run.id) as Array<{ session_id: string; seq: number; status: string }>
    ).filter((record) => !listed.has(`${record.session_id}@${record.seq}`));
    if (records.length !== started.size) continue; // ambiguous — see the header
    const inFlight = [...started.entries()];
    for (const [i, record] of records.entries()) {
      // The position, read off `session_positions` rather than parsed back out of a record id. The
      // parse used to split on the LAST colon because a session id may contain one — a guess the
      // position table makes unnecessary.
      const [instanceId, where] = inFlight[i]!;
      out.push({
        runId: run.id,
        instanceId,
        stateId: where.stateId,
        sessionId: bareSessionId(scope, record.session_id),
        seq: record.seq,
        at: where.at,
        // Read off the record rather than assumed. `completed` is the one status that means the call
        // RETURNED and lost only its event afterwards — reporting that answer as interrupted would
        // be as wrong as not listing it. `open` is the opposite end: a live process is streaming
        // into that row right now, and calling it interrupted is a death notice on a call still
        // talking — which is what a person watching a run saw on every state as it ran. The run
        // still has to be going for that reading to hold: an `open` row left behind by a run that
        // ENDED is a crash nothing has recovered yet, and that one really is interrupted.
        // Everything else is interrupted, `failed` included: a call that really failed wrote a
        // terminal event and would not be in this list at all, so a failed row with none is what
        // `recoverInterrupted` wrote over a row the crash left open.
        outcome:
          record.status === "completed"
            ? "success"
            : record.status === "open" && run.ended_at === null
              ? "running"
              : "interrupted",
      });
    }
  }
  return out;
}

/**
 * What one run spent, summed from the journal.
 *
 * The engine reports cost per completed operation, and the run row does not carry a total — so this
 * is the roll-up, computed where the events already are. `undefined` when no operation reported one,
 * which is a different claim from zero: a scripted run costs nothing, and a run whose transport does
 * not price its calls costs an unknown amount.
 */
export function runCostUsd(project: Project, taskId: string, runId?: number): number | undefined {
  const target = runId ?? project.runtime.listRuns(taskId).at(-1)?.id;
  if (target === undefined) return undefined;
  let total: number | undefined;
  for (const row of project.events.list(taskId, { runId: target })) {
    if (row.event.type !== "operation.completed") continue;
    const cost = row.event.metrics?.costUsd;
    if (typeof cost === "number") total = (total ?? 0) + cost;
  }
  return total;
}

/**
 * The projected TASK — every run folded by position (`foldRuns`).
 *
 * What a person means by "this task": a resume is a new run that re-walks from the root, so no single
 * run's journal is the task's history once one has happened. This is what the detail view reads, and
 * it is why a failed resume no longer draws over what an earlier run reached.
 */
export function taskRun(project: Project, taskId: string, shape?: WorkflowShape): ProjectedRun {
  const runs = project.runtime.listRuns(taskId);
  if (runs.length === 0) return { instances: [], activePath: [], blocked: [] };
  return foldRuns(
    runs.map((run) => {
      const { events, atMs } = eventsOf(project.events.list(taskId, { runId: run.id }));
      return { runId: run.id, run: projectRun(events, shape, atMs) };
    }),
  );
}

/**
 * Every operation's ADDRESS, by the run and instance that ran it.
 *
 * The join `SessionRef` needs to be self-describing. A ref carries the run and the instance, and
 * instance ids are minted per walk — so two runs' calls at one place in the workflow have nothing in
 * common to group them by, which is precisely what a run-scale fork has to do. The address is that
 * thing, and every run's own projection already stamps it.
 *
 * Per RUN and not folded: a fold keeps one node per position and drops the losers, and the losers
 * are exactly the earlier attempts a fork mark exists to offer.
 */
export function addressesByRun(project: Project, taskId: string): Map<string, InstanceAddress> {
  const out = new Map<string, InstanceAddress>();
  for (const run of project.runtime.listRuns(taskId)) {
    const { events, atMs } = eventsOf(project.events.list(taskId, { runId: run.id }));
    const walk = (nodes: readonly InstanceNode[]): void => {
      for (const node of nodes) {
        if (node.address !== undefined) out.set(`${run.id}:${node.instanceId}`, node.address);
        walk(node.children);
      }
    };
    walk(projectRun(events, undefined, atMs).instances);
  }
  return out;
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
    return { level: target, breadcrumb: [{ stateId: target }], columns: [], atLevel: [], finished: [] };
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
  // With the project, for the reason `conversationView` states: the id is never the surprising
  // half of this failure — the database it was looked for in is.
  if (!row) throw refusal(log, `unknown task '${taskId}' in ${project.paths.projectDir}`, { taskId });
  const meta = project.tasks.tryRead(taskId);
  const shape = meta ? shapeFor(project, meta.workflow, row.snapshotHash, options)?.shape : undefined;
  // The TASK, not its last run — see `taskRun`. The timeline below is still every event in order,
  // so the panel shows the folded tree beside the unfolded history that produced it.
  const run = taskRun(project, taskId, shape);
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
    ...(row.worktreePath !== undefined ? { worktreePath: row.worktreePath } : {}),
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
      ...(r.forkedAt !== undefined ? { forkedAt: r.forkedAt } : {}),
    })),
    timeline,
  };
}
