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
import type { ConnectIntent, ConnectStepResult } from "./connect";
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
 * A CONNECT, written down as it is carried out (decision 0005, "A connect that stops part-way",
 * 2026-09-22) — the durable record of a drop's intent, and the rows its Undo is measured from.
 *
 * All four are on the DRAGGED task's journal, keyed by the drop's own `mark`:
 *
 *  - `intent` — written before the connect writes anything: what was asked, the resolution chosen,
 *    and the steps it will take ({@link ConnectIntent}). It is the durable source a retry, or the next
 *    open after a crash, reads to finish the drop as it was first meant — never a second resolution.
 *    It is also where a move's Undo cuts, and the ADOPTED task's place at the drop for an adoption.
 *  - `step` — one per step done, with what it made (a document, a parent task, an adoption).
 *  - `stopped` — a step refused, or threw. The intent stays open: dropping the task on the same
 *    target again runs the steps not yet done, and nothing else may be done with it until then.
 *  - `done` — every step is done, and the intent is closed. For an adoption it is written on the
 *    parent's journal too. Where it sits closes the drop's own writes: a held move, a fast-forward, a
 *    reopening or a supplied value after it is a later move, not this drop.
 *
 * Rows, not counts or seqs: a row is found wherever it now sits, where a count of rows drifted when a
 * retry deleted a row from before the drop and a seq is re-minted by a file-backed journal's replay.
 * A rewind to before the intent takes the whole drop with it, open or done.
 */
export const CONNECT_EVENT = "jaira.connect";

export type ConnectEvent =
  | { type: typeof CONNECT_EVENT; mark: string; at: "intent"; intent: ConnectIntent }
  | { type: typeof CONNECT_EVENT; mark: string; at: "step"; step: number; result: ConnectStepResult }
  | { type: typeof CONNECT_EVENT; mark: string; at: "stopped"; step: number; reason: string }
  | { type: typeof CONNECT_EVENT; mark: string; at: "done" };

/**
 * A question a fast-forward's conversation LEFT to the person (decision 0005 §4) — below
 * `autopilot.askBelow`, unanswerable, or refused.
 *
 * Keyed by the question's STABLE identity: the instance asking, and the question itself (a gate's
 * component and arguments, an agent's question texts). A request id is not stable — a resumed run
 * parks the same question under a new one — and the decision has to outlive the process that made
 * it: a resume seeds it back (`FastForwardRun.leftKeys`), so the conversation is not offered the
 * question again, and the strip's "left to you" is counted from these rows.
 */
export const LEFT_EVENT = "jaira.left";

export interface LeftEvent {
  type: typeof LEFT_EVENT;
  /** The request id it was parked under when it was left — for a person reading the journal. */
  requestId: string;
  kind: "interaction" | "question";
  /** The instance asking, when exactly one could be — `under`, for the reason the header gives. */
  under?: string;
  /** The question's identity within the instance — see {@link questionKeyOf}. */
  key: string;
  /** The conversation that left it. */
  byTaskId: string;
  reason: string;
}

/** Canonical JSON: keys sorted at every depth, so one value is one string whatever built it. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * What a question IS, apart from the request id it happens to be parked under: a gate's component
 * and the arguments it was called with, or the texts of an agent's questions. The same question asked
 * again by the same instance — after a restart, or re-parked — reads the same.
 */
export function questionKeyOf(what: { kind: "interaction"; component: string; inputs?: unknown } | { kind: "question"; questions: readonly string[] }): string {
  return what.kind === "interaction" ? `interaction:${what.component}:${canonical(what.inputs ?? {})}` : `question:${canonical(what.questions)}`;
}

/**
 * Rows about what THIS process is doing with a task, which a copy of the task's journal (a fork, a
 * split copy) does not inherit: the copy is another task, and nobody fast-forwarded it, held a move
 * for it, left it a question or handed its card an Undo.
 */
export const PROCESS_NOTE_EVENTS: ReadonlySet<string> = new Set([FAST_FORWARD_EVENT, FAST_FORWARD_ENDED_EVENT, MOVE_HELD_EVENT, MOVE_DROPPED_EVENT, CONNECT_EVENT, LEFT_EVENT]);
