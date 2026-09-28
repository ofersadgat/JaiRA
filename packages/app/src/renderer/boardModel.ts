/**
 * The board's pure half (decision 0013): what a card says and where it goes, with no DOM in it, so the
 * universal copies and the native app can use it without pulling in the board's React-DOM half
 * (`board.tsx` → `menu` → `popover` → `react-dom`). `board.tsx` re-exports all of it.
 */
import type { BoardCard, NextMove } from "@jaira/shared/browser";
import { cardRemoteWord } from "./remoteStrip";

/**
 * The four things a card in a column can be DOING, in the order work moves through them.
 *
 * A column says WHERE a task is; a lane says whether anything is happening to it there. Those are
 * different questions and a column answered only the first, so a state holding two live runs, five
 * finished ones and a queue read as one stack of eight — the two you had to look at were wherever
 * the sort had left them.
 *
 * `paused` is the one worth naming: a run parked on a question, blocked on its inputs, or stopped
 * part-way is not running and is not finished, and it is the only one of the four that is waiting on
 * a PERSON. Left in with `running` it was invisible, which is the opposite of what it needs to be.
 */
export const LANES = ["running", "paused", "not-started", "finished"] as const;
export type Lane = (typeof LANES)[number];

export const LANE_LABEL: Record<Lane, string> = {
  running: "Running",
  paused: "Paused",
  "not-started": "Not started",
  finished: "Finished",
};

/**
 * Which lane a card belongs in.
 *
 * Read off the TASK's status at both ends and the ACTIVE INSTANCE's in the middle, because that is
 * where each answer actually lives: whether a task has started or ended is a fact about the task,
 * and what it is doing while it runs is a fact about the state it is sitting in — a running task
 * parked on a question has task status `running` and says so nowhere else.
 */
export function laneOf(card: BoardCard): Lane {
  if (card.status === "completed" || card.status === "failed" || card.status === "canceled" || card.status === "archived") return "finished";
  // HOLDING for a dependency (decision 0003) is waiting on something other than itself, whatever
  // else the task is doing — queued and never started, or running and parked at the split until
  // the task it requires completes — which is what this lane is for. One holding for nothing and
  // never started is simply not started.
  if (card.waitingFor !== undefined && card.waitingFor.length > 0) return "paused";
  if (card.status === "queued") return "not-started";
  // Stopped part-way and resumable, which is a pause somebody has to end — not a failure.
  if (card.status === "interrupted") return "paused";
  const at = card.activeStatus;
  return at === "waiting_for_user" || at === "blocked" ? "paused" : "running";
}

/** When a run ended, falling back to the task row's clock for a card the journal cannot date. */
export function endedAtOf(card: BoardCard): number {
  return card.endedAt ?? card.updatedAt;
}

/**
 * The cards of one column, split into lanes, empty ones dropped.
 *
 * The FINISHED lane is re-ordered, newest first. Everywhere else the board's own order is the order
 * the projection produced and means something; a pile of ended runs has no such order, and the only
 * question anybody asks of one is "what happened last" — which put the answer at the bottom of a
 * list that grows forever.
 */
export function lanesOf(cards: readonly BoardCard[]): { lane: Lane; cards: BoardCard[] }[] {
  const by = new Map<Lane, BoardCard[]>();
  for (const card of cards) {
    const lane = laneOf(card);
    const list = by.get(lane);
    if (list === undefined) by.set(lane, [card]);
    else list.push(card);
  }
  by.get("finished")?.sort((a, b) => endedAtOf(b) - endedAtOf(a));
  return LANES.flatMap((lane) => {
    const found = by.get(lane);
    return found === undefined ? [] : [{ lane, cards: found }];
  });
}

/**
 * A card's origin line — `started by events · push_main · git.push a1b2c3d on main` — the words, and
 * where a click goes: the events task, AT the automation that started it. Two sources, one line (the
 * rulings of 2026-09-25): a task started as the automation's CHILD carries it in its provenance
 * (`origin.kind: "started"`), one started on its own in `startedBy`. None: no line.
 */
export function originLineOf(card: Pick<BoardCard, "startedBy" | "origin">): { words: string; taskId: string; stateId?: string } | undefined {
  const say = (key: string | undefined, summary: string | undefined): string => ["started by events", key, summary].filter((part) => part !== undefined && part.length > 0).join(" · ");
  const by = card.startedBy;
  if (by !== undefined) return { words: say(by.state?.key, by.summary), taskId: by.fromTask, ...(by.state !== undefined ? { stateId: by.state.stateId } : {}) };
  const made = card.origin;
  if (made?.kind === "started") return { words: say(made.key, made.event), taskId: made.taskId, ...(made.stateId !== undefined ? { stateId: made.stateId } : {}) };
  return undefined;
}

/** What pressing a chip does, in the words its tooltip says it. */
export function chipTip(move: NextMove, name: string): string {
  if (move.blocked !== undefined) return move.blocked;
  switch (move.way) {
    case "event":
      return `Move to ${name} — the workflow is waiting for exactly this move`;
    case "fast-forward":
      return `Fast-forward to ${name} — the states between run, the conversation answering on the way`;
    case "back":
      return `Go back to ${name} — entered again as its next pass`;
    default:
      return `Move to ${name} — taken when the state it stands in ends`;
  }
}

/** The units an age is rounded to, largest first. Seconds is the floor, so the list ends there. */
const AGES: readonly { unit: string; ms: number }[] = [
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
  { unit: "second", ms: 1000 },
];

/**
 * How long ago a run ended, to ONE unit — "3 minutes ago", "2 days ago".
 *
 * Relative because that is the question actually being asked of a finished card: not when it ended
 * but how stale it is, and "14:22" makes you work that out from the clock on the wall. One unit and
 * no remainder, because a card's footer has room for a fact and not for a duration.
 *
 * PAST A WEEK it becomes a date. Beyond that the relative form stops being the easier reading — "23
 * days ago" is a subtraction somebody has to undo to know which day that was — and the exact moment
 * is on the tooltip either way.
 */
export function endedLabel(at: number, now: number = Date.now()): string {
  // A clock that has drifted, or a record written a moment ahead of this render. Not an error worth
  // showing as one — the run has just ended, and that is what it says.
  const age = Math.max(0, now - at);
  if (age >= 7 * 86_400_000) {
    const when = new Date(at);
    return when.getFullYear() === new Date(now).getFullYear()
      ? when.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  for (const { unit, ms } of AGES) {
    const n = Math.floor(age / ms);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/**
 * WHICH kind of waiting, for a card that is parked (SHELL.md §5.3).
 *
 * The pill merges the two — a gate and a tool approval are the same thing to a person, and `⏸5` is
 * the number they want. The card has room to keep the difference, and it is a real one: a `gate` is
 * a state the workflow AUTHOR put there and a `blocked` instance is the engine saying this run
 * cannot proceed on the inputs it was given, which is somebody else's problem to fix.
 *
 * `undefined` for anything not parked — there is nothing to distinguish, and the pill has already
 * said what it is.
 */
export function waitingKindOf(card: BoardCard): string | undefined {
  // The question is open on a FORGE (decision 0004): say where, rather than "gate" — the person
  // looking at this board is not necessarily who is being waited on.
  if (card.inReview !== undefined) return cardRemoteWord(card.inReview);
  if (card.activeStatus === "waiting_for_user") return "gate";
  if (card.activeStatus === "blocked") return "blocked";
  // Holding for a dependency (decision 0003): a queued task whose `requires` are not done yet.
  if (card.waitingFor !== undefined && card.waitingFor.length > 0) return "holding";
  return undefined;
}

/** What a holding card is waiting for, in words — the titles, and how many there are. */
export function holdingLabelOf(card: Pick<BoardCard, "waitingFor">): string | undefined {
  const waiting = card.waitingFor ?? [];
  if (waiting.length === 0) return undefined;
  const named = waiting.slice(0, 2).map((h) => h.title);
  const more = waiting.length - named.length;
  return `waiting for ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
