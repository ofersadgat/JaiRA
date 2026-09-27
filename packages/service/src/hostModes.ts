/**
 * What a person asked of a task that outlives the process that was asked (decision 0005's Open list,
 * closed 2026-09-22) — the app's half of `@jaira/persistence` `hostRows.ts`.
 *
 * Three things used to live only in memory, and each is now written where the next process finds it,
 * the way a parked gate was made durable (`pending_interactions` + `RequestFate` + `InteractionHub.seed`):
 *
 *  1. **A fast-forward** — its start and its end are journal rows. A resume of a task whose
 *     fast-forward is still open puts the mode back on the session ({@link restoreHostModes}), so the
 *     conversation answers what comes up, the strip shows, and Skip works. It still ends only for the
 *     reasons it ends: arrival, a failure on the way, Stop, Skip — and a rewind, which is a person
 *     taking the work back. Nothing about approvals changes: the mode is reached only from the gate
 *     and question hubs, however it was begun.
 *  2. **A held move** — journaled when it is held, re-queued on the resumed run's port, and taken
 *     when the source state ends, exactly as the in-memory hold is. A run that ends without taking it
 *     (a Stop is the later word) writes that it dropped it.
 *  3. **A connect's Undo** — kept on the task file (`@jaira/persistence` `connectUndo.ts`, which also
 *     holds the rule that ends it); and a finished task's reopening journals the outputs it cleared,
 *     so a rewind to before it — an Undo — gives them back.
 *
 * The one rule they share: **a close is not a decision.** A session that is closing writes no end and
 * drops no hold (`ProjectSession.closing`); only a person, or the run itself, ends what a person began.
 * A close does not drop a kept Undo either.
 */
import { DirectedTransitions, type DirectedTransition } from "@declarative-ai/hw";
import { heldMoves, openFastForward, recordHostRow, type Project, type TaskRuntimeRow } from "@jaira/persistence";
import {
  FAST_FORWARD_ENDED_EVENT,
  FAST_FORWARD_EVENT,
  MOVE_DROPPED_EVENT,
  MOVE_HELD_EVENT,
  REOPENED_EVENT,
  type FastForwardEnd,
  type TaskMoveRequest,
} from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/json";
import { restoredFastForward, type FastForwardRun } from "./fastForward";
import type { ProjectSession } from "./session";

// --- fast-forward -----------------------------------------------------------------------------------

/** Journal a fast-forward's start — what a later process needs to take the mode up again. */
export function noteFastForwardStart(project: Project, run: FastForwardRun): void {
  recordHostRow(project, run.taskId, {
    type: FAST_FORWARD_EVENT,
    controlTaskId: run.controlTaskId,
    target: run.target,
    targetLabel: run.targetLabel,
    to: run.to,
    path: [...run.path],
    ...(run.instanceId !== undefined ? { under: run.instanceId } : {}),
    through: [...run.through],
    ...(run.inputs !== undefined ? { inputs: run.inputs } : {}),
    startedAt: run.startedAt,
  });
}

/** Journal a fast-forward's end. The caller has already decided this is an end and not a close. */
export function noteFastForwardEnd(project: Project, taskId: string, end: FastForwardEnd, detail?: string): void {
  recordHostRow(project, taskId, { type: FAST_FORWARD_ENDED_EVENT, end, ...(detail !== undefined ? { detail } : {}) });
}

/** What a resume picked back up — for its log line and for `startRun`. */
export interface RestoredModes {
  /** The fast-forward put back on the session, when one was still open. */
  forward?: FastForwardRun;
  /** An open fast-forward whose target had already been entered: ended as arrived, not restored. */
  arrived?: boolean;
  /** The run's move port, already holding the moves that were held when the process went away. */
  directed?: DirectedTransitions;
  held: number;
}

/**
 * Before a task is RESUMED: take up what its journal says is still going.
 *
 * The fast-forward goes on the session (unless this process already holds one for the task — a
 * fast-forward being begun resumes the task itself), and the held moves go on a fresh port the loaded
 * engine claims as it builds the instances they name. Nothing here starts anything.
 */
export function restoreHostModes(open: ProjectSession, taskId: string): RestoredModes {
  const project = open.project;
  const events = project.events.list(taskId);
  const out: RestoredModes = { held: 0 };
  if (!open.fastForwards.has(taskId)) {
    const found = openFastForward(project, taskId, events);
    if (found !== undefined) {
      const { run, arrived } = restoredFastForward(
        taskId,
        found.row,
        events.map((stored) => stored.event),
        found.since.map((stored) => stored.event),
      );
      if (arrived) {
        noteFastForwardEnd(project, taskId, "arrived", "the target was entered before the process running it went away");
        out.arrived = true;
      } else {
        open.fastForwards.set(taskId, run);
        out.forward = run;
      }
    }
  }
  const held = heldMoves(project, taskId, events);
  if (held.length > 0) {
    const port = new DirectedTransitions();
    for (const hold of held) {
      port.direct({
        to: hold.to,
        by: hold.by,
        ...(hold.under !== undefined ? { instanceId: hold.under } : {}),
        ...(hold.path !== undefined && hold.path.length > 0 ? { path: hold.path } : {}),
        ...(hold.inputs !== undefined ? { inputs: hold.inputs } : {}),
      });
    }
    out.directed = port;
    out.held = held.length;
  }
  return out;
}

/**
 * A run of this task ENDED in this process, and not because its session is closing: close what the
 * journal still has open. A fast-forward nobody ended in memory (a run this process resumed without
 * restoring one, or reopened for a move) did not arrive; a hold nobody took is dropped — a run that
 * was stopped, or that finished without reaching it, is the later word about it.
 */
export function settleHostRowsAtRunEnd(open: ProjectSession, taskId: string, status: TaskRuntimeRow["status"] | undefined): void {
  if (open.closing) return;
  const project = open.project;
  const events = project.events.list(taskId);
  if (openFastForward(project, taskId, events) !== undefined) {
    noteFastForwardEnd(project, taskId, status === "canceled" ? "stopped" : "failed", "the run ended before it reached the target");
  }
  for (const hold of heldMoves(project, taskId, events)) {
    recordHostRow(project, taskId, {
      type: MOVE_DROPPED_EVENT,
      ...(hold.under !== undefined ? { under: hold.under } : {}),
      reason: status === "canceled" ? "the run was stopped before the state it was held for ended" : "the run ended without taking it",
    });
  }
}

// --- held moves and reopenings ----------------------------------------------------------------------

/** Journal a move the running engine is HOLDING (or has queued for the engine about to attach). */
export function noteHeldMove(project: Project, request: TaskMoveRequest, move: DirectedTransition): void {
  recordHostRow(project, request.taskId, {
    type: MOVE_HELD_EVENT,
    ...(move.instanceId !== undefined ? { under: move.instanceId } : {}),
    to: move.to,
    by: move.by,
    ...(move.inputs !== undefined ? { inputs: move.inputs as Record<string, JsonValue> } : {}),
    ...(move.path !== undefined && move.path.length > 0 ? { path: [...move.path] } : {}),
  });
}

/** Journal that a FINISHED task is being reopened, with what the reopening is about to clear off its row. */
export function noteReopened(project: Project, row: TaskRuntimeRow): void {
  if (row.status !== "completed") return;
  recordHostRow(project, row.taskId, {
    type: REOPENED_EVENT,
    status: "completed",
    outcome: "success",
    ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    ...(row.outputsJson !== undefined ? { outputsJson: row.outputsJson } : {}),
  });
}
