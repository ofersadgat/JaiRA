/**
 * Read models over an open project (DESIGN §11): task summaries, the board, and
 * task detail.
 *
 * These are pure reads — journal + task files + runtime rows in, view models out
 * — so both the Electron main process and the headless CLI render the same board
 * from the same code. Anything that *runs* a workflow lives above this.
 */
import { createLogger } from "@declarative-ai/log";
import { ANSWERED_EVENT, isTaskId, refusal, SUPPLIED_EVENT, type AnsweredEvent, type SuppliedEvent } from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/json";
import type { EngineEvent, StateDef, WorkflowBundle } from "@declarative-ai/hw";
import { loadWorkflowBundle } from "./toolsets";
import type { BoardView, InputProvenance, InputSettledVia, InstanceAddress, InstanceNode, TaskDetail, TaskMeta, TaskOrigin, TaskSummary, TimelineEntry } from "@jaira/shared";
import type { Project } from "./project";
import type { TaskRuntimeRow } from "./runtime";
import { holdingOf } from "./lifecycle";
import { workflowLoadOptions } from "./workflowRefs";
import {
  activePathOf,
  breadcrumbOf,
  eventsOf,
  headingOf,
  projectBoard,
  projectRun,
  type ProjectedRun,
  type TaskProjection,
  type WorkflowShape,
} from "./projection";
import { loadSnapshot, readWorkflowFiles } from "./snapshots";
import { EFFECTIVE_SEQ, EFFECTIVE_SESSION, bareSessionId } from "./sessionStore";
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
  // Who stands under whom: a task filed beneath another, adopted by it, or made by its fan-out.
  const under = new Map<string, number>();
  for (const meta of project.tasks.list()) {
    const above = meta.origin?.taskId ?? meta.parentTaskId;
    if (above !== undefined) under.set(above, (under.get(above) ?? 0) + 1);
  }
  return project.runtime.list().map((row) => {
    const meta = project.tasks.tryRead(row.taskId);
    const origin = taskOriginOf(project, row, meta);
    const waitingFor = meta !== undefined ? holdingOf(project, meta) : [];
    // The request the task is parked on, when it is parked on one — the oldest, if there are several.
    const awaited = project.remotes.forTask(row.taskId).find((r) => r.awaiting && r.number !== undefined && r.url !== undefined);
    return {
      taskId: row.taskId,
      title: meta?.title ?? "(missing task file)",
      status: row.status,
      workflow: meta?.workflow ?? "",
      ...(meta?.labels !== undefined ? { labels: meta.labels } : {}),
      ...(row.snapshotHash !== undefined ? { snapshotHash: row.snapshotHash } : {}),
      ...(meta?.parentTaskId !== undefined ? { parentTaskId: meta.parentTaskId } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(waitingFor.length > 0 ? { waitingFor } : {}),
      ...((under.get(row.taskId) ?? 0) > 0 ? { controls: under.get(row.taskId)! } : {}),
      ...(awaited !== undefined ? { inReview: { provider: awaited.provider, number: awaited.number!, url: awaited.url! } } : {}),
      ...(meta?.connectUndo !== undefined ? { undoable: true as const } : {}),
      createdAt: meta?.createdAt ?? new Date(row.createdAt).toISOString(),
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * Where a copied task came from, in words — see `TaskOrigin` and `cut.ts`.
 *
 * The label reads the parent's journal at the cut, which is the only place that knows what the
 * point WAS: a state's entry, a rule, a message. Read per ask rather than stored, and cheap enough
 * for a list because it is one row by primary key; a parent that is gone leaves a copy that still
 * says it is one, with the point it can no longer describe.
 *
 * A task a fan-out made (decision 0003) says so from its meta instead: a SPLIT copy is a cut like a
 * fork's and carries the fork stamp too, but its sentence is the mount and the element, not the
 * event; a mount TASK was never cut from anything and has no seam, so `at` and `boundary` are zero.
 */
export function taskOriginOf(project: Project, row: TaskRuntimeRow, meta?: TaskMeta): TaskOrigin | undefined {
  const made = (meta ?? project.tasks.tryRead(row.taskId))?.origin;
  if (made !== undefined) {
    const parent = project.tasks.tryRead(made.taskId);
    const boundary =
      row.forkBoundarySeq !== undefined
        ? (project.db.prepare(`SELECT created_at FROM state_machine_events WHERE task_id = ? AND seq = ?`).get(row.taskId, row.forkBoundarySeq) as { created_at: number } | undefined)
        : undefined;
    return {
      kind: made.kind,
      taskId: made.taskId,
      ...(parent !== undefined ? { title: parent.title } : {}),
      key: made.key,
      index: made.index,
      at: row.forkedAtSeq ?? 0,
      boundary: row.forkBoundarySeq ?? 0,
      boundaryAt: boundary?.created_at ?? 0,
      // An adoption (decision 0005 §2) was no element of anything: it stands for the child itself.
      label: made.kind === "adopt" ? `as ${made.key}` : `element ${made.index + 1} of ${made.key}${made.item !== undefined ? ` (${made.item})` : ""}`,
    };
  }
  if (row.parentTaskId === undefined || row.forkedAtSeq === undefined || row.forkBoundarySeq === undefined) return undefined;
  const parent = project.tasks.tryRead(row.parentTaskId);
  const event = project.db
    .prepare(`SELECT type, payload_json FROM state_machine_events WHERE task_id = ? AND seq = ?`)
    .get(row.parentTaskId, row.forkedAtSeq) as { type: string; payload_json: string } | undefined;
  const boundary = project.db
    .prepare(`SELECT created_at FROM state_machine_events WHERE task_id = ? AND seq = ?`)
    .get(row.taskId, row.forkBoundarySeq) as { created_at: number } | undefined;
  return {
    kind: "fork",
    taskId: row.parentTaskId,
    ...(parent !== undefined ? { title: parent.title } : {}),
    at: row.forkedAtSeq,
    boundary: row.forkBoundarySeq,
    boundaryAt: boundary?.created_at ?? 0,
    label: event === undefined ? (parent === undefined ? "a task since deleted" : `event ${row.forkedAtSeq}`) : cutLabelOf(event.type, event.payload_json),
  };
}

/** The sentence a cut point makes: what the journal was about to do there. */
function cutLabelOf(type: string, payloadJson: string): string {
  let payload: { instanceId?: unknown; stateId?: unknown; childKey?: unknown; to?: unknown; index?: unknown } = {};
  try {
    payload = JSON.parse(payloadJson) as typeof payload;
  } catch {
    // An unreadable payload still has a type to name.
  }
  const chat = typeof payload.instanceId === "string" && payload.instanceId.startsWith("chat:");
  if (type === "instance.entered") {
    // Counted as a reader counts the thread: the run's own message is the first, the first typed one the second.
    if (chat) return "before message 2";
    const name =
      typeof payload.childKey === "string"
        ? payload.childKey
        : typeof payload.stateId === "string"
          ? (payload.stateId.split("/").pop() ?? payload.stateId)
          : "a state";
    return `before ${name}`;
  }
  if (type === "transition.taken") {
    if (chat && typeof payload.index === "number") return `before message ${payload.index + 2}`;
    return typeof payload.to === "string" ? `before ${payload.to}` : "at a transition";
  }
  return `at ${type}`;
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
    return loadWorkflowBundle(
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
export function runCauses(project: Project, taskId: string): Array<{ stateId: string; reason: string }> {
  const causes: Array<{ stateId: string; reason: string }> = [];
  for (const row of project.events.list(taskId)) {
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
 * Every operation of a task that ran in a conversation, oldest first — the task's whole history,
 * which is what the "all the other states the executor went through" half of the leaf panel reads.
 */
export function stateSessions(project: Project, taskId: string): StateSession[] {
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
      `SELECT type, payload_json, session_ref, created_at FROM state_machine_events
        WHERE task_id = ? AND type IN ('operation.completed', 'operation.failed') AND session_ref IS NOT NULL
        ORDER BY seq`,
    )
    .all(taskId) as Array<{
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
  out.push(...interruptedSessions(project, taskId));
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
function interruptedSessions(project: Project, taskId: string): StateSession[] {
  // Read through `project.db` like the query above it, rather than through the runtime and event
  // STORES: everything here is one join over three tables, and depending on the wrappers would make
  // this the only projection in the file that cannot run against a bare database handle.
  //
  // One machine per task now, so the question is asked of the TASK: did it stop other than cleanly,
  // or is anything still streaming into an open record?
  const task = project.db
    .prepare(
      `SELECT outcome, ended_at, status FROM task_runtime
        WHERE task_id = ?
          AND (outcome IN ('interrupted', 'error', 'canceled') OR status = 'running'
               OR EXISTS (SELECT 1 FROM operation_records r
                           WHERE r.task_id = task_runtime.task_id AND r.status = 'open'))`,
    )
    .get(taskId) as { outcome: string | null; ended_at: number | null; status: string } | undefined;
  if (task === undefined) return [];
  const running = task.status === "running" || task.ended_at === null;
  // Which instances started an operation that never settled — the calls that were in flight. Keyed
  // by durable instance id, which is what lets one pass cover a machine that stopped and continued:
  // a re-dispatch on the continuation starts the same instance's operation again.
  const events = project.db
    .prepare(
      `SELECT type, payload_json, session_ref, created_at FROM state_machine_events
        WHERE task_id = ?
          AND type IN ('operation.started', 'operation.completed', 'operation.failed')
        ORDER BY seq`,
    )
    .all(taskId) as Array<{ type: string; payload_json: string; session_ref: string | null; created_at: number }>;
  const scope = { taskId };
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
  /**
   * The calls the journal says FAILED. A position is what the provider's session holds in its
   * message history, and a failed call added nothing to it — so it occupies no position, its seat
   * is released, and the next call in that conversation claims the same seq. Its record is still
   * on disk under that seq, though, and it must not be mistaken for the call now sitting there:
   * counting it as "accounted for" hid the reclaiming call for as long as it ran, and counting it
   * as a record made the pairing below ambiguous. Set aside by instance, which is the one thing a
   * failed record and the live claimant of its seat never share.
   */
  const failed = new Set<string>();
  for (const row of events) {
    const event = JSON.parse(row.payload_json) as { instanceId?: string; stateId?: string };
    if (event.instanceId === undefined) continue;
    if (row.type === "operation.started") {
      started.set(event.instanceId, { stateId: event.stateId ?? "", at: row.created_at });
      continue;
    }
    started.delete(event.instanceId);
    if (row.type === "operation.failed") {
      failed.add(String(event.instanceId)); // as TEXT: the generated column below has text affinity
      continue;
    }
    // Only a COMPLETED call occupies a position.
    const end = row.session_ref === null ? undefined : parseSessionRef(row.session_ref);
    if (end !== undefined) listed.add(`${end.id}@${end.seq - 1}`);
  }
  if (started.size === 0) return [];
  // The records those calls left: placed ones — an unplaced call has no conversation to list —
  // that no terminal event accounts for. Asking the journal rather than the record's status is what
  // finds a call that SETTLED and then lost its event; a status test would call that one listed and
  // leave the answer it holds unreachable. Ordered by insertion, which is start order. Matched
  // under BOTH spellings: a new ref carries the session's own id — the row's key since ids became
  // assigned (migration 15) — while a legacy row carries the run namespace in front of it, taken
  // back off with `bareSessionId`.
  const records = (
    project.db
      .prepare(
        `SELECT ${EFFECTIVE_SESSION} AS session_id, ${EFFECTIVE_SEQ} AS seq, status, instance_id FROM operation_records
        WHERE task_id = ? AND session_id IS NOT NULL
        ORDER BY rowid`,
      )
      .all(taskId) as Array<{ session_id: string; seq: number; status: string; instance_id: string | null }>
  ).filter(
    (record) =>
      (record.instance_id === null || !failed.has(String(record.instance_id))) &&
      !listed.has(`${record.session_id}@${record.seq}`) &&
      !listed.has(`${bareSessionId(scope, record.session_id)}@${record.seq}`),
  );
  if (records.length !== started.size) return []; // ambiguous — see the header
  const out: StateSession[] = [];
  const inFlight = [...started.entries()];
  for (const [i, record] of records.entries()) {
    const [instanceId, where] = inFlight[i]!;
    out.push({
      instanceId,
      stateId: where.stateId,
      sessionId: bareSessionId(scope, record.session_id),
      seq: record.seq,
      at: where.at,
      // Read off the record rather than assumed. `completed` is the one status that means the call
      // RETURNED and lost only its event afterwards — reporting that answer as interrupted would
      // be as wrong as not listing it. `open` is the opposite end: a live process is streaming
      // into that row right now, and calling it interrupted is a death notice on a call still
      // talking — which is what a person watching a run saw on every state as it ran. The machine
      // still has to be going for that reading to hold: an `open` row left behind by a task that
      // ENDED is a crash nothing has recovered yet, and that one really is interrupted.
      // Everything else is interrupted, `failed` included: a call that really failed wrote a
      // terminal event and would not be in this list at all, so a failed row with none is what
      // `recoverInterrupted` wrote over a row the crash left open.
      outcome:
        record.status === "completed" ? "success" : record.status === "open" && running ? "running" : "interrupted",
    });
  }
  return out;
}

/**
 * What this task spent, summed from the journal.
 *
 * The engine reports cost per completed operation, and the task row does not carry a total — so this
 * is the roll-up, computed where the events already are. `undefined` when no operation reported one,
 * which is a different claim from zero: a scripted run costs nothing, and a run whose transport does
 * not price its calls costs an unknown amount.
 */
export function runCostUsd(project: Project, taskId: string): number | undefined {
  let total: number | undefined;
  for (const row of project.events.list(taskId)) {
    if (row.event.type !== "operation.completed") continue;
    const cost = row.event.metrics?.costUsd;
    if (typeof cost === "number") total = (total ?? 0) + cost;
  }
  return total;
}

/**
 * The projected TASK — its one machine, from its one journal.
 *
 * A task IS a machine now (Identity and Resume §05): a resume continues the same instances under
 * the same ids, so the whole journal projects in one pass and the fold-by-address that survived
 * re-walking is gone. History from before the collapse can hold several trees — old-style re-runs
 * each grew one — and for those `root_instance_id` (stamped by migration 16) names the newest
 * attempt's, which is what the projection keeps as the task's own; sub-workflow trees and older
 * attempts stay in the timeline without being drawn over it.
 */
/**
 * Stamp the instances that are tasks a fan-out MADE (decision 0003) — see `InstanceNode.made`.
 *
 * A mirrored element is a node with no operation and no children whose instance id is a task's, and
 * whose provenance names this task. The projection is pure over events and cannot know; this is the
 * one place the tree meets the task store, so it is where the join happens. Only childless,
 * operation-less nodes are looked up — every other node is plainly the machine's own.
 */
function markMade(project: Project, taskId: string, nodes: readonly InstanceNode[]): void {
  for (const node of nodes) {
    if (node.children.length > 0) {
      markMade(project, taskId, node.children);
      continue;
    }
    if (node.operation !== undefined || !isTaskId(node.instanceId)) continue;
    const origin = project.tasks.tryRead(node.instanceId)?.origin;
    if (origin?.taskId === taskId) node.made = { taskId: node.instanceId, kind: origin.kind };
  }
}

/**
 * Stamp how each instance's inputs were SETTLED (decision 0005 §4) — see `InstanceNode.inputProvenance`.
 *
 * Three sources, and the journal plus the task's file hold all of them. The ROOT's inputs are the
 * task's own, and its file says how each was settled; a file written before provenance was recorded
 * says nothing, and then a task a fan-out made was bound by the wire that made it and any other was
 * typed into a form. A CHILD's inputs are bound — the parent's wiring resolved them, which is what
 * entering a child is — except the ones a DIRECTED transition handed it (`transition.taken` with
 * `by` and `inputs`): those came from whoever moved the task, a person or a conversation.
 */
function markProvenance(project: Project, taskId: string, nodes: readonly InstanceNode[], events: readonly EngineEvent[]): void {
  const meta = project.tasks.tryRead(taskId);
  /** Inputs a directed transition handed the NEXT entry of `to` under an instance, by parent and key. */
  const handed = new Map<string, { via: InputSettledVia; names: string[] }>();
  const directed = new Map<string, { via: InputSettledVia; names: Set<string> }>();
  const sep = String.fromCharCode(0);
  /**
   * What a CONVERSATION said about the values it handed the next entry of a key (`jaira.supplied`,
   * step 6): per name, inferred or asked, and how sure. It is finer than `by`, which only knows that
   * a conversation asked for the move — and it also covers a generated mount, whose supplied values
   * are literals in the document and ride no transition at all.
   */
  const told: SuppliedEvent[] = [];
  const supplied = new Map<string, SuppliedEvent["provenance"]>();
  let rootId: string | undefined;
  for (const event of events) {
    if ((event as { type: string }).type === SUPPLIED_EVENT) {
      told.push(event as unknown as SuppliedEvent);
    } else if (event.type === "transition.taken" && event.by !== undefined && event.inputs !== undefined) {
      handed.set(`${event.instanceId}${sep}${event.to}`, { via: event.by === "control" ? "inferred" : "asked", names: Object.keys(event.inputs) });
    } else if (event.type === "instance.entered" && event.parentInstanceId === undefined) {
      rootId ??= event.instanceId;
    } else if (event.type === "instance.entered" && event.childKey !== undefined) {
      const at = told.findIndex((row) => row.to === event.childKey && (row.nested === true || (row.instanceId ?? rootId) === event.parentInstanceId));
      if (at >= 0) supplied.set(event.instanceId, told.splice(at, 1)[0]!.provenance);
      const key = `${event.parentInstanceId}${sep}${event.childKey}`;
      const gift = handed.get(key);
      if (gift === undefined) continue;
      handed.delete(key);
      directed.set(event.instanceId, { via: gift.via, names: new Set(gift.names) });
    }
  }
  const walk = (list: readonly InstanceNode[], isRoot: boolean): void => {
    for (const node of list) {
      const names = Object.keys(node.inputs ?? {});
      if (names.length > 0) {
        const out: Record<string, InputProvenance> = {};
        for (const name of names) {
          if (isRoot) out[name] = meta?.inputProvenance?.[name] ?? { via: meta?.origin !== undefined && meta.origin.kind !== "adopt" ? "bound" : "asked" };
          else {
            const said = supplied.get(node.instanceId)?.[name];
            if (said !== undefined) out[name] = { via: said.via, ...(said.confidence !== undefined ? { confidence: said.confidence } : {}) };
            else out[name] = directed.get(node.instanceId)?.names.has(name) === true ? { via: directed.get(node.instanceId)!.via } : { via: "bound" };
          }
        }
        node.inputProvenance = out;
      }
      walk(node.children, false);
    }
  };
  walk(nodes, true);
}

/**
 * Stamp the gates a CONTROL CONVERSATION answered (decision 0005 §4) — see `InstanceNode.settledBy`.
 *
 * The `jaira.answered` row names the instance whose gate it settled, because `answer_question` looked it up
 * at the moment it answered — the hub's park carries no instance, and joining after the fact would
 * be a guess about which of two parallel questions got which answer. A row that names none is
 * dropped rather than attached to whatever was waiting.
 *
 * The seq matters as much as the mark: it is what "Answer it yourself" rewinds to. Cutting there
 * deletes the answer and the completion that followed it, so the state dispatches its gate again.
 */
function markAnswered(nodes: readonly InstanceNode[], rows: readonly { seq: number; event: EngineEvent }[]): void {
  const byInstance = new Map<string, AnsweredEvent & { seq: number }>();
  /** Every agent-question row per instance — `InstanceNode.answeredQuestions`. An agent asks more than once. */
  const questions = new Map<string, AnsweredEvent[]>();
  /**
   * Where each instance was ENTERED — the rewind point. Not the answered row itself: a cut keeps the
   * settle of a call that had started before it (`partitionAt`, which is right for a conversation cut
   * mid-turn), so cutting at the answer would keep the answer's completion and ask nothing. Cut at
   * the entry, the state is entered again as the next occurrence and parks its gate for the person.
   */
  const enteredAt = new Map<string, number>();
  for (const row of rows) {
    const event = row.event as unknown as AnsweredEvent;
    if (row.event.type === "instance.entered" && !enteredAt.has(row.event.instanceId)) enteredAt.set(row.event.instanceId, row.seq);
    if (event.type !== ANSWERED_EVENT || event.instanceId === undefined) continue;
    // The FIRST: a follow-up round answered again is the same question, and taking it back means
    // going back to where it was first asked.
    if (!byInstance.has(event.instanceId)) byInstance.set(event.instanceId, { ...event, seq: row.seq });
    if (event.kind === "question") questions.set(event.instanceId, [...(questions.get(event.instanceId) ?? []), event]);
  }
  if (byInstance.size === 0) return;
  const walk = (list: readonly InstanceNode[]): void => {
    for (const node of list) {
      const said = byInstance.get(node.instanceId);
      const at = enteredAt.get(node.instanceId) ?? said?.seq ?? 0;
      if (said !== undefined) node.settledBy = { ...said.settled_by, byTaskId: said.byTaskId, at };
      // The same rewind point for each: taking back any of an agent's answers re-enters the state.
      const asked = questions.get(node.instanceId);
      if (asked !== undefined) {
        node.answeredQuestions = asked.map((row) => ({ ...row.settled_by, byTaskId: row.byTaskId, at, ...(row.questions !== undefined ? { questions: row.questions } : {}) }));
      }
      walk(node.children);
    }
  };
  walk(nodes);
}

export function taskRun(project: Project, taskId: string, shape?: WorkflowShape): ProjectedRun {
  const rows = project.events.list(taskId);
  const { events, atMs } = eventsOf(rows);
  if (events.length === 0) return { instances: [], activePath: [], blocked: [] };
  const projected = projectRun(events, shape, atMs);
  markMade(project, taskId, projected.instances);
  markProvenance(project, taskId, projected.instances, events);
  markAnswered(projected.instances, rows);
  if (projected.instances.length <= 1) return projected;
  // Several parentless trees is history's shape, not the machine's: an in-place restart before
  // re-runs minted tasks grew one per attempt. The NEWEST is the task's own — the same rule the
  // load fold applies — with the migration's stamp winning where present, since it is the same
  // answer computed while run boundaries still existed to read.
  const stamped = project.runtime.get(taskId)?.rootInstanceId;
  const keep =
    (stamped !== undefined && projected.instances.some((node) => node.instanceId === stamped)
      ? stamped
      : undefined) ?? projected.instances.at(-1)!.instanceId;
  const kept = projected.instances.filter((node) => node.instanceId === keep);
  return { ...projected, instances: kept, activePath: activePathOf(kept) };
}

/**
 * Every instance's ADDRESS, keyed by its durable id.
 *
 * The join `SessionRef` needs to be self-describing: a ref carries the instance, and the address is
 * the one name that means the same thing across a stop and its continuation. The projection already
 * stamps it; this flattens the walk into the lookup the view layer asks by.
 */
export function instanceAddresses(project: Project, taskId: string): Map<string, InstanceAddress> {
  const out = new Map<string, InstanceAddress>();
  const { events, atMs } = eventsOf(project.events.list(taskId));
  const walk = (nodes: readonly InstanceNode[]): void => {
    for (const node of nodes) {
      if (node.address !== undefined) out.set(node.instanceId, node.address);
      walk(node.children);
    }
  };
  walk(projectRun(events, undefined, atMs).instances);
  return out;
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
    ...(summary.origin !== undefined ? { origin: summary.origin } : {}),
    ...(summary.waitingFor !== undefined ? { waitingFor: summary.waitingFor } : {}),
    ...(summary.undoable === true ? { undoable: true as const } : {}),
    updatedAt: summary.updatedAt,
    run: taskRun(project, summary.taskId, shape),
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
  const heading = headingOf(run, shape);
  const origin = taskOriginOf(project, row);
  const waitingFor = meta !== undefined ? holdingOf(project, meta) : [];
  const timeline: TimelineEntry[] = project.events
    .list(taskId)
    .slice(-TIMELINE_LIMIT)
    .map((r) => ({
      seq: r.seq,
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
    ...(origin !== undefined ? { origin } : {}),
    ...(waitingFor.length > 0 ? { waitingFor } : {}),
    instances: run.instances,
    activePath: run.activePath,
    blocked: run.blocked,
    // The name the path gives the task, drawn by the same rule the board card uses so the two agree.
    ...(heading !== undefined ? { heading } : {}),
    // The machine's one execution summary — an array still, because a task that never started has
    // nothing to summarize and the renderer maps over what there is.
    runs:
      row.startedAt === undefined || row.snapshotHash === undefined
        ? []
        : [
            {
              outcome: row.outcome ?? "running",
              snapshotHash: row.snapshotHash,
              startedAt: row.startedAt,
              ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
              ...(row.outputsJson !== undefined ? { outputs: JSON.parse(row.outputsJson) as JsonValue } : {}),
              ...(row.failureJson !== undefined ? { failure: JSON.parse(row.failureJson) as JsonValue } : {}),
            },
          ],
    timeline,
  };
}
