/**
 * The journal rows a HOST writes about what it is doing with a task — host vocabulary, like
 * `jaira.answered` and `workflow.version`, and never an engine event.
 *
 * Three things a person asks for used to live only in the memory of the process that was asked, and
 * a restart lost them (decision 0005's Open list, closed 2026-09-22). Each is now a pair of rows in
 * the task's own journal, so whoever loads the task next finds it:
 *
 *  - a FAST-FORWARD — {@link FAST_FORWARD_EVENT} when it starts, {@link FAST_FORWARD_ENDED_EVENT}
 *    when it ends for one of the reasons it ends (arrival, a failure on the way, Stop, Skip, a
 *    rewind). A process that goes away while one is going writes no end, and the resume that follows
 *    takes the mode up again;
 *  - a HELD MOVE — {@link MOVE_HELD_EVENT} when a directed move is held for a running state, and
 *    {@link MOVE_DROPPED_EVENT} when the run that held it ends without taking it. Taken, it needs no
 *    row of its own: the engine's directed `transition.taken` is the taking;
 *  - a REOPENING of a finished task — {@link REOPENED_EVENT}, carrying what the reopening cleared off
 *    the task's row, so a rewind (an Undo) to before it can put the finished task back as it was.
 *
 * None of these rows carries a top-level `instanceId`: the table's `instance_id` column is read off
 * that field, and a row that names an instance is one every reader of an instance's rows would see.
 * Where a row has to name one it says `under`.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { FastForwardEnd } from "./fastForward";

/** A fast-forward started — everything a later process needs to take the mode up again. */
export const FAST_FORWARD_EVENT = "jaira.fastForward";

export interface FastForwardEvent {
  type: typeof FAST_FORWARD_EVENT;
  /** The conversation answering on the way, by its task. */
  controlTaskId: string;
  /** The target state id. */
  target: string;
  targetLabel: string;
  /** The child key the target is entered under. */
  to: string;
  /** Child keys beneath `to`, for a nested target. */
  path: string[];
  /** The composite whose child `to` is. Absent ⇒ the run's root instance. */
  under?: string;
  /** The states stepped through on the way, as child-key paths from the root. */
  through: string[];
  /** What the asker hands the target when it is entered. */
  inputs?: Record<string, JsonValue>;
  startedAt: number;
}

/** A fast-forward ended, for one of the reasons one ends. Never written for a process going away. */
export const FAST_FORWARD_ENDED_EVENT = "jaira.fastForwardEnded";

export interface FastForwardEndedEvent {
  type: typeof FAST_FORWARD_ENDED_EVENT;
  end: FastForwardEnd;
  detail?: string;
}

/** A directed move is HELD for a running state — kept until that state ends, then taken. */
export const MOVE_HELD_EVENT = "jaira.moveHeld";

export interface MoveHeldEvent {
  type: typeof MOVE_HELD_EVENT;
  /** The composite whose child is entered. Absent ⇒ the run's root instance. */
  under?: string;
  to: string;
  by: "person" | "control";
  /** What the asker handed over — to `to`, or to the end of `path` when there is one. */
  inputs?: Record<string, JsonValue>;
  /** The way down from `to` to a nested target. */
  path?: string[];
}

/** A held move the run ended without taking — stopped, or finished some other way. */
export const MOVE_DROPPED_EVENT = "jaira.moveDropped";

export interface MoveDroppedEvent {
  type: typeof MOVE_DROPPED_EVENT;
  /** The instance the dropped move was held by, as its {@link MoveHeldEvent} named it. */
  under?: string;
  reason: string;
}

/** A FINISHED task was reopened to take a move — and what the reopening cleared off its row. */
export const REOPENED_EVENT = "jaira.reopened";

export interface ReopenedEvent {
  type: typeof REOPENED_EVENT;
  /** How the task stood: always `completed` today, the only standing a reopening clears outputs from. */
  status: "completed";
  outcome: "success";
  /** When the finished run had ended. */
  endedAt?: number;
  /** The task row's `outputs_json`, verbatim. */
  outputsJson?: string;
}

/**
 * Rows about what THIS process is doing with a task, which a copy of the task's journal (a fork, a
 * split copy) does not inherit: the copy is another task, and nobody fast-forwarded it or held a move
 * for it.
 */
export const PROCESS_NOTE_EVENTS: ReadonlySet<string> = new Set([FAST_FORWARD_EVENT, FAST_FORWARD_ENDED_EVENT, MOVE_HELD_EVENT, MOVE_DROPPED_EVENT]);
