/**
 * Moving a task (decision 0005, "The rulings of 2026-09-22") — what a move MAY do, judged from where
 * the target is and what the task is doing.
 *
 * "Move" is the person's word for what a board drop, a next-transition chip, a conversation's
 * `move_task` and `jaira task move` all do; `connect` is only the host operation's name. One table
 * decides all of them, so the drop's hover, the chip and the tool can never disagree:
 *
 * | target, from where the task stands | working | waiting for the person's input | waiting for a user event |
 * | --- | --- | --- | --- |
 * | **ahead** — reachable through the transitions the workflow DEFINES | fast-forward | fast-forward (the conversation answers on the way) | the pending event, if it leads there; else fast-forward |
 * | **behind** — already entered | ASK: stop and rewind? (the target entered again, history kept) | rewind | rewind |
 * | **unreachable** — a sideways jump, or past a decision already taken | ILLEGAL | ILLEGAL | ILLEGAL |
 * | **elsewhere** — another workflow (adopt), or a new transition (modify) | ASK: pause and move? | move | move |
 *
 * A task standing where the workflow defines nothing further — a finished task, or one in its last
 * state — has no "ahead": a move anywhere it has not been is a NEW transition, which is the last row.
 *
 * The ASK cells are a confirmation the UI puts in front of the drop, which is otherwise the commit;
 * they are never a refusal of the move. What a move still needs after that is asked in the task's own
 * conversation (`MoveQuestion`), never by a separate conversation or a model in words.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ConnectMissingInput } from "./connect";

/**
 * What a task is doing, as a move sees it — the table's columns.
 *
 *  - `working`       — an engine is running it and nothing is waiting on a person;
 *  - `waiting-input` — something is being asked of the person: a gate, an agent's question, an approval;
 *  - `waiting-event` — a transition is waiting on a user event (`on_user_event`) and nothing is asked;
 *  - `stopped`       — nothing runs it and it has not finished (paused, interrupted, failed, never started);
 *  - `finished`      — it completed.
 *
 * `stopped` and `finished` are neither working nor waiting: every cell of theirs is the waiting one's,
 * without the ASK.
 */
export type TaskActivity = "working" | "waiting-input" | "waiting-event" | "stopped" | "finished";

/** Where the target is, from where the task stands — the table's rows. */
export type MoveWhere = "ahead" | "behind" | "unreachable" | "elsewhere";

/**
 * What the move does:
 *
 *  - `next`         — the state that comes next anyway: taken when the state the task stands in ends;
 *  - `fast-forward` — the machine runs the states between, its conversation answering on the way;
 *  - `event`        — a rule of the workflow is waiting on exactly this move: it is answered;
 *  - `back`         — the target is entered again as its next occurrence, what came after it reset;
 *  - `move`         — into another workflow (an adoption) or along a new transition (a modification);
 *  - `illegal`      — refused.
 */
export type MoveWay = "next" | "fast-forward" | "event" | "back" | "move" | "illegal";

/** The two ASK cells, as the confirmation names them. */
export type MoveConfirm = "stop-and-rewind" | "pause-and-move";

/** The table's answer for one move — what a dry run carries, and what a hover and a chip say. */
export interface MoveJudgement {
  where: MoveWhere;
  activity: TaskActivity;
  way: MoveWay;
  /** Present on an ASK cell: the drop asks this before it commits. */
  confirm?: MoveConfirm;
  /** An `illegal` move's reason, or an ASK cell's question — a plain sentence. */
  sentence?: string;
}

/** The table itself — see the module header. Pure, so every caller reads the same cell. */
export function judgeMove(where: MoveWhere, activity: TaskActivity, at: { eventLeadsThere?: boolean; next?: boolean } = {}): Pick<MoveJudgement, "way" | "confirm"> {
  switch (where) {
    case "ahead":
      if (activity === "waiting-event" && at.eventLeadsThere === true) return { way: "event" };
      return { way: at.next === true ? "next" : "fast-forward" };
    case "behind":
      return activity === "working" ? { way: "back", confirm: "stop-and-rewind" } : { way: "back" };
    case "unreachable":
      return { way: "illegal" };
    case "elsewhere":
      return activity === "working" ? { way: "move", confirm: "pause-and-move" } : { way: "move" };
  }
}

/** Whether an engine holds the task right now — the columns that are not `stopped`/`finished`. */
export const isLive = (activity: TaskActivity): boolean => activity === "working" || activity === "waiting-input" || activity === "waiting-event";

/**
 * One NEXT TRANSITION a task's card offers as a chip — computed in the main process from the
 * transitions its pinned workflow DEFINES out of the state it stands in, and from the rules waiting on
 * a user event right now. Every chip is legal by the table: it is ahead, it is the event, or it is a
 * loop the workflow defines back to a state already entered.
 */
export interface NextMove {
  /** The state id the chip moves to. */
  target: string;
  /** Child keys from the task's root to it — the exact mount, handed back to `task:connect` as `path`. */
  path: string[];
  label?: string;
  way: MoveWay;
  /** A rule of the workflow is waiting on exactly this move (`on_user_event`). */
  event?: true;
  /** An ASK cell — a loop back while the task works: pressing the chip asks this first, as a drop does. */
  confirm?: MoveConfirm;
  /** The confirmation's question. */
  sentence?: string;
  /** Why pressing it cannot be served right now, when it cannot — drawn as a disabled chip saying so. */
  blocked?: string;
}

// ---------------------------------------------------------------------------------------------------
// the input question
// ---------------------------------------------------------------------------------------------------

/**
 * A legal move whose target still lacks required inputs ASKS FOR THEM in the task's own conversation
 * (the rulings of 2026-09-22, 2): the host parks a question there — a `fill_form` gate over the
 * inputs' own declared schemas, drawn by the one schema form — and answering it supplies the inputs,
 * recorded `asked`, and takes the move. The question is a gate like any other, so it outlives the
 * process (`pending_interactions`), and the journal says where in the task's history it was asked.
 *
 * Its request id carries this prefix, so a reader that only has the id — the inbox, the gate list —
 * knows the answer is the host's to act on and not a run's.
 */
export const MOVE_QUESTION_PREFIX = "move:";

export const isMoveQuestion = (requestId: string): boolean => requestId.startsWith(MOVE_QUESTION_PREFIX);

/** The move a question is holding, as it will be asked again once answered. */
export interface HeldMoveRequest {
  target: string;
  workflow?: string;
  path?: string[];
  skip?: boolean;
  /** The person already confirmed an ASK cell for this move. */
  confirmed?: true;
  by: "person" | "control";
}

/** `jaira.moveAsked` — the host parked a move's input question in the task's conversation. */
export const MOVE_ASKED_EVENT = "jaira.moveAsked";
export interface MoveAskedEvent {
  type: typeof MOVE_ASKED_EVENT;
  requestId: string;
  move: HeldMoveRequest;
  /** What the question asks for: the required inputs nothing binds, then the optional ones. */
  missing: ConnectMissingInput[];
  optional?: ConnectMissingInput[];
  /** Where the task will stand — the words the question's heading uses. */
  targetLabel?: string;
}

/** `jaira.moveAnswered` — the question was answered and the move taken, or taken and refused. */
export const MOVE_ANSWERED_EVENT = "jaira.moveAnswered";
export interface MoveAnsweredEvent {
  type: typeof MOVE_ANSWERED_EVENT;
  requestId: string;
  outcome: "moved" | "refused" | "dismissed";
  /** What the person answered, by input name — what the settled question is drawn with. */
  answered?: Record<string, JsonValue>;
  message?: string;
}

/**
 * The question's form: each input under its OWN declared name, with its declared schema and
 * description — nothing the platform names (§0). Required inputs are required; optional ones may be
 * left out.
 */
export function moveQuestionSchema(missing: readonly ConnectMissingInput[], optional: readonly ConnectMissingInput[] = []): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const add = (input: ConnectMissingInput): void => {
    const base = input.schema !== null && typeof input.schema === "object" && !Array.isArray(input.schema) ? { ...(input.schema as Record<string, unknown>) } : {};
    if (input.description !== undefined && base["description"] === undefined) base["description"] = input.description;
    properties[input.name] = base;
  };
  for (const input of missing) add(input);
  for (const input of optional) if (properties[input.name] === undefined) add(input);
  return { type: "object", properties, required: [...new Set(missing.map((input) => input.name))] };
}

/** The question's heading: what the move is, in a sentence. */
export function moveQuestionPrompt(title: string, targetLabel: string, missing: readonly ConnectMissingInput[]): string {
  const one = missing.length === 1;
  return `Moving '${title}' to ${targetLabel} needs ${one ? "an input" : `${missing.length} inputs`} nothing the task produced gives. The move is taken when ${one ? "it is" : "they are"} answered.`;
}
