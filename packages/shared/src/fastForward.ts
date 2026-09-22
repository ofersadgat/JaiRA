/**
 * Fast-forward (decision 0005 §4, step 7) — what the strip says, and what a Skip takes.
 *
 * A forward move inside a workflow RUNS THE MACHINE to the target. That is not a transition: the
 * states between where the work stands and where it was sent run normally, one after another, and
 * the only thing that is different about them is who answers their questions — the control
 * conversation, through `answer_question`, marked as such and rewindable. So there is nothing in the journal
 * that IS a fast-forward. It is a mode a task is in, held by the process driving it, and this is
 * what that mode looks like from outside.
 *
 * ⚠️ It ends on ARRIVAL. The target state runs normally and its questions come to the person: the
 * whole point of sending work ahead is to be there when it gets there.
 */

/** Why a fast-forward stopped being one. */
export type FastForwardEnd =
  /** The target was entered. The mode is over and the state runs normally. */
  | "arrived"
  /** Something on the way failed, or the run ended without reaching the target. */
  | "failed"
  /** A person pressed Skip: what was running was interrupted and the target entered directly. */
  | "skipped"
  /** A person stopped the run, or the project closed. */
  | "stopped";

/**
 * A fast-forward in flight — the activity strip's whole content.
 *
 * "Fast-forwarding to **implementation** · at `ux → item` · 1 of 3", with **Skip to implementation**
 * beside **Stop**.
 */
export interface FastForwardView {
  /** The task being walked forward. */
  taskId: string;
  /** The conversation answering on the way, by its task — never the same thing as `taskId` unless the task IS one. */
  controlTaskId: string;
  /** The target state id, as `list_workflows` spells it. */
  target: string;
  /** What the strip calls it: the target's child key, or the tail of its id. */
  targetLabel: string;
  /** The child key of the target at the level it is entered — what a Skip is a move TO. */
  to: string;
  /** Child keys beneath `to`, when the target is nested deeper — as `connect`'s move carries them. */
  path: string[];
  /** The states stepped through on the way, as child-key paths from the run's root. */
  through: string[];
  /** How many of `through` have been entered — the `1` of "1 of 3". */
  step: number;
  /** Where the run stands right now, as child keys joined by ` → `. Absent before it has entered anything. */
  at?: string;
  /** How many questions the conversation has answered on the way. */
  answered: number;
  /** How many it left to the person, being less sure than `autopilot.askBelow`. */
  left: number;
  startedAt: number;
}

/**
 * Who settled a question, when it was not the person — drawn on the gate, and a rewind point.
 *
 * `at` is the journal seq of the ENTRY of the state that asked. Cutting there deletes the entry, the
 * answer and everything after, so the state is entered again and asks: "Answer it yourself" is the
 * ordinary rewind and nothing else. Not the answered row's own seq — a cut keeps the settle of a call
 * that had started before it, so cutting at the answer would keep its completion and ask nothing.
 */
export interface SettledByView {
  via: "control";
  confidence: number;
  /** The conversation's task. */
  byTaskId: string;
  at: number;
  /**
   * For an agent's `AskUserQuestion`: the question texts the answer was for — what picks the question
   * block it settled out of the agent's transcript (`jaira.answered`'s `questions`). Absent on a gate.
   */
  questions?: string[];
}
