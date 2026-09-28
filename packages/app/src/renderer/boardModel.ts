/**
 * The board's pure half (decision 0015): what a card says and where it goes, with no DOM in it, so the
 * universal copies and the native app can use it without pulling in the board's React-DOM half
 * (`board.tsx` → `menu` → `popover` → `react-dom`). `board.tsx` re-exports all of it.
 */
import type { BoardCard, BoardView, NextMove } from "@jaira/shared/browser";
import { nestUnder } from "./connectDrag";
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

/**
 * Which lanes still earn a heading (SHELL.md §5.3).
 *
 * Not the active two. Every card in `running` and `paused` now carries a FILLED pill naming what it
 * is doing, so a "Running" rule over them is a line saying what each card under it already says —
 * the same argument `lanesOf` makes about a single-lane column, applied one level in.
 *
 * `finished` keeps its heading, and that is where the argument stops working: its pills go flat, and
 * flat is the register the whole rest of the column is in. `not-started` keeps one for a blunter
 * reason — a queued card has no pill at all, so the heading is the only thing saying what it is.
 */
export const LANE_HEADED: ReadonlySet<Lane> = new Set<Lane>(["not-started", "finished"]);

/**
 * A column's cards split for drawing: the LIVE ones, which go in the lanes, and the archived ones,
 * held at the foot behind one line saying how many (the person, 2026-09-27) — newest archived first.
 */
export function archivedSplitOf(cards: readonly BoardCard[]): { live: readonly BoardCard[]; held: BoardCard[] } {
  const held = cards.filter((card) => card.status === "archived").sort((a, b) => (b.archived?.at ?? 0) - (a.archived?.at ?? 0));
  const live = held.length === 0 ? cards : cards.filter((card) => card.status !== "archived");
  return { live, held };
}

/** One card in a lane, whether it is the last there (`.card:last-child`), and the adopted ones filed beneath it. */
export interface LaneEntry {
  card: BoardCard;
  last: boolean;
  beneath: { card: BoardCard; last: boolean }[];
}

/**
 * The live cards of a column, as the board draws them (`Lanes` in `board.tsx`, and its universal copy).
 *
 * `boxed` false: one lane, drawn with no box and no heading — a rule saying "Finished" over a column of
 * nothing but finished cards says what every card under it says. The lane's OWN cards, not the ones
 * passed in, since the lane fixed their order. Otherwise every lane is a box of its own, headed where
 * {@link LANE_HEADED} says, with its count of top-level cards.
 *
 * An adopted task files BENEATH the task that adopted it (decision 0005 §2), wherever its own status
 * would have put it: what relates the two is not a lane.
 *
 * `trailing`: something follows the lanes (the archived foot), so with one lane the last live card is not
 * the `:last-child` it would otherwise be. With several, each lane is its own box and ends in its card.
 */
export function laneRunsOf(
  cards: readonly BoardCard[],
  trailing = false,
): { boxed: boolean; runs: { lane: Lane; headed: boolean; count: number; entries: LaneEntry[] }[] } {
  const { top, beneath } = nestUnder(cards);
  const entriesOf = (list: readonly BoardCard[], followed = false): LaneEntry[] =>
    list.map((card, i) => {
      const lastInLane = !followed && i === list.length - 1;
      const under = beneath.get(card.taskId) ?? [];
      return {
        card,
        last: lastInLane && under.length === 0,
        beneath: under.map((child, j) => ({ card: child, last: lastInLane && j === under.length - 1 })),
      };
    });
  const lanes = lanesOf(top);
  if (lanes.length <= 1) {
    const only = lanes[0];
    return { boxed: false, runs: only === undefined ? [] : [{ lane: only.lane, headed: false, count: only.cards.length, entries: entriesOf(only.cards, trailing) }] };
  }
  return { boxed: true, runs: lanes.map(({ lane, cards: inLane }) => ({ lane, headed: LANE_HEADED.has(lane), count: inLane.length, entries: entriesOf(inLane) })) };
}

/**
 * One board's cards in the order the board DRAWS them — columns left to right, each split into lanes,
 * then the at-this-level tray — which is the order "everything in between" means to the person
 * shift-clicking. Built from the same `lanesOf` the board renders with, so the range can never disagree
 * with what is on screen.
 */
export function boardCardOrderOf(board: BoardView | null | undefined): BoardCard[] {
  if (board === undefined || board === null) return [];
  return [...board.columns.flatMap((c) => lanesOf(c.cards).flatMap((l) => l.cards)), ...lanesOf(board.atLevel).flatMap((l) => l.cards)];
}

/**
 * The Tasks board's selection — one task, or a set of them, scoped to ONE project (a task id is a rowid
 * in one database). `anchor` is where a shift-range measures from: the last plainly-clicked card.
 */
export type BoardPick = { project: string; ids: readonly string[]; anchor: string } | null;

/**
 * A click on a card: plain selects, ctrl/cmd toggles membership, shift extends from the anchor
 * (explorer semantics). What the set becomes, and which task the panel should now describe
 * (`undefined`: leave it), from the set before and the board's drawn order.
 */
export function pickCard(
  picked: BoardPick,
  project: string,
  taskId: string,
  e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean } | undefined,
  order: () => readonly string[],
): { picked: BoardPick; select?: string } {
  const same = picked !== null && picked.project === project ? picked : null;
  if (e?.shiftKey === true && same !== null) {
    const ids = order();
    const a = ids.indexOf(same.anchor);
    const b = ids.indexOf(taskId);
    if (a >= 0 && b >= 0) {
      // The range REPLACES the set (explorer semantics), and the anchor stays put so a second
      // shift-click re-measures from the same end rather than from wherever the first landed.
      return { picked: { project, ids: ids.slice(Math.min(a, b), Math.max(a, b) + 1), anchor: same.anchor }, select: taskId };
    }
  }
  if ((e?.ctrlKey === true || e?.metaKey === true) && same !== null) {
    const had = same.ids.includes(taskId);
    const ids = had ? same.ids.filter((id) => id !== taskId) : [...same.ids, taskId];
    if (ids.length === 0) return { picked: null };
    // The panel follows the last card TOUCHED — for a removal, the last one still standing.
    return { picked: { project, ids, anchor: had ? same.anchor : taskId }, select: had ? ids[ids.length - 1]! : taskId };
  }
  return { picked: { project, ids: [taskId], anchor: taskId }, select: taskId };
}

/**
 * Which state a card walks into.
 *
 * A card drill follows the TASK, not the column: it lands on the state that card is actually in one
 * level down, which is the same place a column drill goes right up until a task's active path skips
 * a level — and then it is the more useful of the two answers.
 *
 * At the root listing there is no level on the path to step past, so the target is the card's own
 * workflow root.
 */
export function drillTargetOf(board: BoardView, card: BoardCard): string | undefined {
  if (board.level === "") return card.workflow.length > 0 ? card.workflow : undefined;
  const at = card.activePath.findIndex((step) => step.stateId === board.level);
  return at < 0 ? undefined : card.activePath[at + 1]?.stateId;
}
