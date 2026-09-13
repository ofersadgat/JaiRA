/**
 * The board, shared by both views that draw one (DESIGN §11.1).
 *
 * Files and Tasks render the same projection — child states as columns, the tasks inside them as
 * cards. What differs is how you got there (the file tree, or drilling a breadcrumb) and what the
 * right-hand panel then describes. Keeping the board itself in one place is what stops those two
 * entrances from slowly growing two different boards.
 *
 * Column order is the order the children RUN in — the state's `sequence` where declared, declaration
 * order otherwise, which is what `workflowShape` already computes. Transitions deliberately play no
 * part in it: a guard that jumps backwards is control flow, and letting it reorder the columns would
 * turn the board's shape into something you cannot read left to right.
 */
import { useState, type DragEvent as ReactDragEvent, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { BoardCard, BoardView, InstanceStatus, TaskStatus } from "@jaira/shared/browser";
import { pointOf, type MenuPoint } from "./menu";
import { Pill, PILL_WORD, pillKindOf } from "./pill";
import { canDrag, requestFor, NO_DRAG_OFFERS, type DragOffers } from "./taskDrag";
import { TaskName } from "./taskName";

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
  // A queued task HOLDING for a dependency (decision 0003) is waiting on something other than
  // itself, which is what this lane is for; one holding for nothing is simply not started.
  if (card.status === "queued") return card.waitingFor !== undefined && card.waitingFor.length > 0 ? "paused" : "not-started";
  if (card.status === "completed" || card.status === "failed" || card.status === "canceled") return "finished";
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
 * The glyph vocabulary, still nine entries wide.
 *
 * The PILLS took five of these and folded them into their own set (SHELL.md §4.1) — `blocked` joined
 * `waiting_for_user` under `⏸`, `timeout` joined `failed`. This map stays whole because {@link Badge}
 * has other callers, and they are inspectors: a panel describing ONE instance is the surface where
 * `timeout` and `failed` are worth telling apart, which is exactly the distinction a count on a row
 * of five cannot afford.
 */
const BADGE: Record<string, string> = {
  running: "▶",
  waiting_for_user: "⏸",
  blocked: "⛔",
  completed: "✓",
  failed: "✗",
  canceled: "∅",
  timeout: "⏱",
  queued: "·",
  interrupted: "⚠",
};

export function Badge({ status }: { status?: string }): JSX.Element {
  const key = status ?? "queued";
  return (
    <span className={`badge badge-${key}`} title={key}>
      {BADGE[key] ?? "·"}
    </span>
  );
}

/**
 * A card's status, as the pill (SHELL.md §5.3).
 *
 * A word rather than a count, because a card is one task and "1" is not news. What it buys is the
 * fill: a column of filled pills is the work in flight and a column of flat ones is what is done,
 * and a person sorts the column that way before reading a single title.
 *
 * `queued` has no pill — nothing is happening and nothing has happened — so a not-started card shows
 * none, which is what the "Not started" lane heading is already saying above it.
 */
export function StatusPill({ status }: { status?: string }): JSX.Element | null {
  const kind = pillKindOf(status as TaskStatus | InstanceStatus | undefined);
  if (kind === null) return null;
  return <Pill kind={kind} word={PILL_WORD[kind]} title={status} />;
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

/**
 * A card on a board — the CHROME, with no opinion about what it is a card of.
 *
 * The two boards in this app disagree about what a card IS: on the Tasks view it is a task, and
 * inside a run it is one EXECUTION of a declared child, which is what makes a loop legible (three
 * passes, three cards). That difference is real and it is why there are two boards. Everything
 * around it — the ground, the head row with its trailing pill, the second line — is the same in
 * both, and was duplicated instead of shared until restyling one of them left the other behind.
 *
 * There is no box any more (SHELL.md §5.3). A filled, outlined, shadowed rectangle is a button, and
 * a task is selected rather than pressed; the ground carries both states on its own.
 */
export function Tile({
  status,
  title,
  trailing,
  meta,
  selected,
  tip,
  children,
  onSelect,
  onDrill,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  /** Colours the stripe and picks the badge glyph. Absent ⇒ neither, for a card of something with
      no state of its own to report. */
  status?: string;
  title: ReactNode;
  /** The far end of the head row: a drill arrow, which pass this is. */
  trailing?: ReactNode;
  /** The footer under the rule — where a card says what it is, having said what it is called. */
  meta?: ReactNode;
  selected?: boolean;
  tip?: string;
  /** Anything between the head and the footer. The run board puts its call arguments here. */
  children?: ReactNode;
  /** The event rides along for callers that read its modifiers — the Tasks board's multi-select. */
  onSelect: (e: ReactMouseEvent) => void;
  onDrill?: (() => void) | undefined;
  /** Right-click, where the card has verbs to offer. The Tasks view opens its menu here. */
  onMenu?: ((e: ReactMouseEvent) => void) | undefined;
  /**
   * PICKING THE CARD UP, when a waiting transition has offered the move (`on_user_event`).
   *
   * Present is what makes the card draggable at all — a card nothing is waiting on cannot be
   * lifted, because there would be nowhere for it to land and no meaning in it landing there.
   */
  onDragStart?: ((e: ReactDragEvent) => void) | undefined;
  onDragEnd?: (() => void) | undefined;
}): JSX.Element {
  const draggable = onDragStart !== undefined;
  return (
    <div
      // No `card-${status}` any more: every rule that read it was colouring the left stripe or the
      // status word, and both are the trailing pill's job now. A class nothing styles is a hook the
      // next person has to check before they can change anything.
      className={`card${selected === true ? " card-selected is-active" : ""}${draggable ? " card-draggable" : ""}`}
      // Only where something is waiting for it. `draggable` on every card would offer a gesture that
      // does nothing almost everywhere, and an affordance that usually lies is worse than none.
      {...(draggable ? { draggable: true, onDragStart, ...(onDragEnd !== undefined ? { onDragEnd } : {}) } : {})}
      onClick={onSelect}
      onDoubleClick={onDrill}
      // A shift-click is a range-select gesture here, and the browser's own reading of it — extend
      // the text selection from wherever the last click was — would smear a highlight across every
      // card in between. Swallowed at mousedown, which is where that behaviour starts; a plain drag
      // still selects text within a card.
      onMouseDown={(e) => (e.shiftKey ? e.preventDefault() : undefined)}
      {...(onMenu !== undefined ? { onContextMenu: onMenu } : {})}
      {...(tip !== undefined ? { title: tip } : {})}
    >
      <div className="card-head">
        <span className="card-title">{title}</span>
        {/* TRAILING, not leading (SHELL.md §5.3). A glyph in front of the title indented every card
            by a column that carried one character, and put the status where a person's eye lands
            first — which is the wrong order: you find the card by its name and then ask what it is
            doing. At the end it also lines up down the column, so the shape of the work is readable
            without reading anything. */}
        {status !== undefined ? <StatusPill status={status} /> : null}
        {trailing}
      </div>
      {children}
      {meta !== undefined ? <div className="card-meta">{meta}</div> : null}
    </div>
  );
}

/**
 * A board column — the track, and whatever cards were put in it.
 *
 * Also chrome, and shared for the same reason: a column of tasks and a column of executions are
 * both "a heading, a count, and a stack of cards", and the only board-specific thing about either
 * is what goes inside.
 *
 * The column is a BOX and the card is not, which is the opposite of where this started. A column is
 * a place — the one thing on this screen that a task moves between — so it earns an edge and a
 * heading band that says where its contents stop. A card is one item inside that place, and giving
 * it its own edge as well left two boxes nested one deep, neither of which read as the boundary.
 * Removing the card's box (§5.3) is only half of that argument; this is the other half, and without
 * it the cards of two adjacent columns run together into one field of rounded rectangles.
 */
export function Column({
  name,
  seq,
  count,
  empty,
  tip,
  onOpen,
  onSelect,
  onMenu,
  selected = false,
  drop,
  children,
}: {
  name: ReactNode;
  /** The order this child RUNS in. Absent at the root listing, where the columns have no order. */
  seq?: number;
  count: number;
  /** What to say when there are no cards — "not reached" and "—" are different facts. */
  empty: string;
  tip?: string;
  /** Walking into the column itself, where that means anything. */
  onOpen?: (() => void) | undefined;
  /**
   * Describing the column — the STATE it stands for — rather than walking into it.
   *
   * A single click, beside the double-click that drills, and the pair reads the way it does
   * everywhere else in this app: clicking a thing says what it is, opening it goes there.
   *
   * ANYWHERE IN THE COLUMN that is not a card. The heading alone was the obvious place to put it and
   * the wrong one: an empty column is a heading and a `—`, and the `—` is most of the target — so
   * the columns with nothing in them, which are exactly the ones somebody is about to start a run
   * in, were the hardest ones to click. A card stops the click because a card is a thing INSIDE the
   * place and speaks for itself; everything else — the band, the gap between two cards, the
   * placeholder, a lane heading — is the place.
   */
  onSelect?: (() => void) | undefined;
  /**
   * Right-clicking the column — the PLACE, and the tasks standing in it.
   *
   * Same target as {@link onSelect} and for the same reason: everything that is not a card is the
   * column. A card has its own menu and claims the click before this one is reached.
   */
  onMenu?: ((at: MenuPoint) => void) | undefined;
  /** The panel is describing this column right now. */
  selected?: boolean;
  /**
   * What a card being dragged right now would mean here.
   *
   * `accepts` is whether THIS column is one of the targets the dragged card was offered — so a
   * column lights up only where dropping would actually answer a waiting rule, and every other
   * column stays inert rather than accepting a gesture it would have to discard.
   */
  drop?: { accepts: boolean; onDrop: () => void } | undefined;
  children?: ReactNode;
}): JSX.Element {
  // Whether the pointer is over THIS column, which is a different fact from whether the column would
  // take the card: one says where the cursor is, the other what would happen if it let go.
  const [over, setOver] = useState(false);
  const accepts = drop?.accepts === true;
  /**
   * The click, minus the clicks that belong to a card.
   *
   * A guard here rather than `stopPropagation` on the card, because the card is shared with the run
   * board and with the trays — three callers, only one of which has a column selection to protect,
   * and a swallowed event is invisible to the two that do not want it swallowed. Read off the target
   * so it holds however deep the card's own markup goes.
   */
  const pick = (e: ReactMouseEvent): void => {
    if ((e.target as Element).closest(".card") !== null) return;
    onSelect?.();
  };
  /** The same click, right-handed — and the same guard, so a card's own menu is never overwritten. */
  const raise = (e: ReactMouseEvent): void => {
    if ((e.target as Element).closest(".card") !== null) return;
    e.preventDefault();
    onMenu?.(pointOf(e));
  };
  return (
    <section
      className={`column${selected ? " sel" : ""}${accepts ? " drop-target" : ""}${accepts && over ? " drop-over" : ""}`}
      {...(onSelect !== undefined ? { onClick: pick } : {})}
      {...(onMenu !== undefined ? { onContextMenu: raise } : {})}
      {...(onOpen !== undefined ? { onDoubleClick: onOpen } : {})}
      {...(tip !== undefined ? { title: tip } : {})}
      {...(accepts
        ? {
            // `preventDefault` on drag-over IS the acceptance: without it the browser refuses the
            // drop and the card springs back, which reads as the app rejecting the move.
            onDragOver: (e: ReactDragEvent) => {
              e.preventDefault();
              setOver(true);
            },
            onDragLeave: () => setOver(false),
            onDrop: (e: ReactDragEvent) => {
              e.preventDefault();
              setOver(false);
              drop?.onDrop();
            },
          }
        : {})}
    >
      <h4>
        {/* The order this child RUNS in, as a number and not a chip. A bordered box around a digit
            is the loudest thing in a heading whose job is to name a place, and the columns are laid
            out left to right in that same order — so the number is a confirmation, not news. */}
        {seq !== undefined ? <span className="seq data-num">{seq}</span> : null}
        <span className="col-name">{name}</span>
        <span className="count app-secondary">{count}</span>
      </h4>
      {/* The cards get their own scrolling box, so the heading band stays put over a column longer
          than the screen without a sticky rule that has to repaint its own background. */}
      <div className="column-body">
        {children}
        {count === 0 ? <div className="empty">{empty}</div> : null}
      </div>
    </section>
  );
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
const LANE_HEADED: ReadonlySet<Lane> = new Set<Lane>(["not-started", "finished"]);

/**
 * A column's cards, under a heading per lane.
 *
 * Headings only where there is something under them, and none at all when every card in the column
 * is in the same lane — a "Finished" rule over a column of nothing but finished cards is a line that
 * says what every card below it already says. The sections earn their space by being a DIVISION, so
 * they appear exactly when there is something to divide.
 */
export function Lanes({
  cards,
  render,
}: {
  cards: readonly BoardCard[];
  render: (card: BoardCard) => ReactNode;
}): JSX.Element {
  const lanes = lanesOf(cards);
  // One lane: no heading, because a rule saying "Finished" over a column of nothing but finished
  // cards says what every card under it says. The lane's OWN cards, not the ones passed in — a
  // column that is all finished is the commonest case there is, and it is the one whose order the
  // lane fixed.
  if (lanes.length <= 1) return <>{(lanes[0]?.cards ?? []).map(render)}</>;
  return (
    <>
      {lanes.map(({ lane, cards: inLane }) => (
        <div key={lane} className={`lane lane-${lane}`}>
          {LANE_HEADED.has(lane) ? (
            <h5>
              <span className="grow app-label">{LANE_LABEL[lane]}</span>
              <span className="count data-num">{inLane.length}</span>
            </h5>
          ) : null}
          {inLane.map(render)}
        </div>
      ))}
    </>
  );
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

export function Card({
  card,
  selected,
  onSelect,
  onDrill,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard;
  selected: boolean;
  onSelect: (e: ReactMouseEvent) => void;
  onDrill?: () => void;
  onMenu?: (e: ReactMouseEvent) => void;
  /** Present only when a waiting transition has offered this card a move — see {@link Tile}. */
  onDragStart?: (() => void) | undefined;
  onDragEnd?: (() => void) | undefined;
}): JSX.Element {
  // The card's own status — the one the board is actually about, which for a task inside a workflow
  // is where it is NOW rather than what the task as a whole is doing.
  const status = card.activeStatus ?? card.status;
  return (
    <Tile
      status={status}
      // The name the task's path gives it where a state declares a title (SPEC §5.2), drawn as a
      // placeholder while that title is still settling — see `TaskName`.
      title={<TaskName task={card} />}
      selected={selected}
      // A finished card's tooltip is the exact moment it ended — the footer rounds to one unit, and
      // "2 days ago" is the reading you want until the moment it is not.
      tip={
        card.endedAt !== undefined
          ? `${card.status} · ${new Date(card.endedAt).toLocaleString()}`
          : onDrill
            ? "double-click to open this run"
            : (card.activeStateId ?? card.status)
      }
      // NOTHING trailing the pill. There was a `↳` here on every drillable card, and it cost more
      // than it said: it is not in the design (SHELL.md §5.3 gives the head row a title and a
      // trailing pill, and nothing else), it repeated for most of a column what "most of a column"
      // already implies, and the width it took came out of the title — which is the one string on
      // the card a person is reading. The affordance is on the tooltip and in the cursor; a glyph
      // announcing that a double-click exists is a manual printed on the machine.
      // The second line: where the task is, and the one thing about that the pill cannot say.
      //
      // It used to repeat the status in words. With the status now a trailing pill carrying that
      // word itself, repeating it put the same fact on a card twice — so this line spends its far
      // end on the DISTINCTION instead (SHELL.md §5.3): which kind of waiting, and when a finished
      // run finished. Merged in the count, distinguished where there is room.
      //
      // A run that is OVER reports WHEN. Where it is stopped being the question the moment it
      // stopped moving, and "which of these four finished runs is the one from this morning" is a
      // question a column of identical cards could not answer at all.
      meta={
        card.endedAt !== undefined ? (
          <>
            <span className="ellip">{card.activeStateId ?? card.status}</span>
            <span className="card-status" title={new Date(card.endedAt).toLocaleString()}>
              {endedLabel(card.endedAt)}
            </span>
          </>
        ) : (
          <>
            <span className="ellip">{card.activeStateId ?? card.status}</span>
            {waitingKindOf(card) !== undefined ? (
              // A holding card names what it holds for in the tooltip; the word is the kind.
              <span className="card-status" {...(holdingLabelOf(card) !== undefined ? { title: holdingLabelOf(card) } : {})}>
                {waitingKindOf(card)}
              </span>
            ) : null}
          </>
        )
      }
      onSelect={onSelect}
      onDrill={onDrill}
      onMenu={onMenu}
      {...(onDragStart !== undefined
        ? {
            onDragStart: (e: ReactDragEvent) => {
              // Something has to be on the transfer or Firefox refuses the drag outright; the task
              // id is the honest payload even though the board reads its own state for the drop.
              e.dataTransfer.setData("text/plain", card.taskId);
              e.dataTransfer.effectAllowed = "move";
              onDragStart();
            },
          }
        : {})}
      {...(onDragEnd !== undefined ? { onDragEnd } : {})}
    />
  );
}

/**
 * A board level.
 *
 * `numbered` is off for the root listing and on everywhere else, because that is exactly where the
 * distinction lies: workflow roots are siblings with no order, while every level below one is a
 * sequence the engine advances through.
 *
 * `trays` is off in the Files view. "At this level" and "Finished" hold tasks that are not in any of
 * the columns, and while authoring, a panel that is meant to show one state should not quietly list
 * work belonging to others.
 */
export function Board({
  board,
  selected,
  selectedSet,
  numbered = true,
  trays = true,
  onSelectTask,
  onSelectColumn,
  selectedColumn = null,
  onDrill,
  onOpenTask,
  onTaskMenu,
  onColumnMenu,
  dragOffers = NO_DRAG_OFFERS,
  onTaskDrop,
}: {
  board: BoardView;
  selected: string | null;
  /**
   * A multi-selection, when the caller keeps one. Takes over from `selected` entirely — the two are
   * one highlight, not two, and the caller that owns a set puts the single selection in it too.
   */
  selectedSet?: ReadonlySet<string> | undefined;
  numbered?: boolean;
  trays?: boolean;
  /** The click event rides along so a caller can read shift/ctrl for range and toggle selection. */
  onSelectTask: (taskId: string, e: ReactMouseEvent) => void;
  /**
   * A COLUMN was clicked — describe the state it stands for.
   *
   * Absent in the Files view, which is already standing on a state and whose right-hand column is
   * already describing one; there, a column heading that swapped the inspector onto a child would be
   * a click that navigates without moving the address.
   */
  onSelectColumn?: ((stateId: string) => void) | undefined;
  /** Which column the panel is describing, by state id. */
  selectedColumn?: string | null;
  onDrill: (stateId: string) => void;
  /**
   * Double-clicking a CARD, where that means something other than drilling its state.
   *
   * The two halves of a drill are different questions. A column is a place and opening one shows
   * every task in it; a card is one run, and opening it should show THAT run — which is what the
   * Tasks view does, by putting it on the address. Absent in the Files view, where a card falls back
   * to following the task's own path down a level.
   */
  onOpenTask?: ((card: BoardCard) => void) | undefined;
  /** Right-clicking a card. The caller owns the menu — the board only says which card, and where. */
  onTaskMenu?: ((card: BoardCard, at: MenuPoint) => void) | undefined;
  /**
   * Right-clicking a COLUMN — the state it stands for, and every task standing in it.
   *
   * Separate from {@link onTaskMenu} because they are menus of different things: a card's verbs act
   * on one run, a column's act on the place and on the group. Absent in the Files view, where a
   * column's tasks belong to boards this panel is not describing.
   */
  onColumnMenu?: ((stateId: string, at: MenuPoint) => void) | undefined;
  /**
   * The moves waiting transitions are offering, by task (`on_user_event`, WORKFLOWS.md §7.4).
   *
   * Empty by default, which is the Files view's answer and the honest one for any board that is not
   * looking at live work: no card is draggable unless something is actually waiting for it to be.
   */
  dragOffers?: DragOffers;
  /** A card was dropped on a column that was offering it a place. The caller answers the wait. */
  onTaskDrop?: ((requestId: string, card: BoardCard) => void) | undefined;
}): JSX.Element {
  /**
   * The card being dragged right now, so the columns can say which of them would take it.
   *
   * Held here rather than per column, because the answer is a property of the PAIR — this card, that
   * column — and only the board sees both.
   */
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  /** What double-clicking this card does: open the run, else follow its path one level down. */
  const drillOf = (card: BoardCard): (() => void) | undefined => {
    if (onOpenTask !== undefined) return () => onOpenTask(card);
    const target = drillTargetOf(board, card);
    return target === undefined ? undefined : () => onDrill(target);
  };
  const isSelected = (card: BoardCard): boolean =>
    selectedSet !== undefined ? selectedSet.has(card.taskId) : card.taskId === selected;
  // The root listing WRAPS. Its columns are whole workflows — siblings with no order, and no task
  // ever moves between them — so there is no left-to-right reading to preserve and a tenth workflow
  // belongs on a second row rather than off the right-hand edge. A level BELOW a root is a sequence
  // the engine advances through, and wrapping that would break the one thing the order means.
  const roots = board.level === "";
  /**
   * What a drop on this column would do, while a card is in the air.
   *
   * `undefined` when nothing is being dragged, so a column that is not part of a gesture in progress
   * carries no drop handlers at all rather than handlers that decline.
   */
  const dropFor = (columnKey: string): { accepts: boolean; onDrop: () => void } | undefined => {
    const card = dragging;
    if (card === null || onTaskDrop === undefined) return undefined;
    const requestId = requestFor(dragOffers, card.taskId, columnKey);
    return {
      accepts: requestId !== undefined,
      onDrop: () => {
        setDragging(null);
        if (requestId !== undefined) onTaskDrop(requestId, card);
      },
    };
  };
  return (
    <div className="board-body">
      <div className={`columns${roots ? " wrap" : ""}`}>
        {board.columns.map((column, index) => (
          <Column
            key={column.key}
            name={column.label ?? column.key}
            {...(numbered ? { seq: index + 1 } : {})}
            count={column.cards.length}
            empty="—"
            tip={
              onSelectColumn === undefined
                ? `double-click to open ${column.stateId}`
                : `click to describe ${column.stateId}, double-click to open it`
            }
            onOpen={() => onDrill(column.stateId)}
            {...(onSelectColumn !== undefined ? { onSelect: () => onSelectColumn(column.stateId) } : {})}
            {...(onColumnMenu !== undefined ? { onMenu: (at: MenuPoint) => onColumnMenu(column.stateId, at) } : {})}
            selected={column.stateId === selectedColumn}
            {...(dropFor(column.key) !== undefined ? { drop: dropFor(column.key)! } : {})}
          >
            <Lanes
              cards={column.cards}
              render={(card) => {
                const drill = drillOf(card);
                return (
                  <Card
                    key={card.taskId}
                    card={card}
                    selected={isSelected(card)}
                    onSelect={(e) => onSelectTask(card.taskId, e)}
                    {...(drill !== undefined ? { onDrill: drill } : {})}
                    {...(onTaskMenu !== undefined ? { onMenu: menuHandler(card, onTaskMenu) } : {})}
                    {...(onTaskDrop !== undefined && canDrag(dragOffers, card.taskId)
                      ? { onDragStart: () => setDragging(card), onDragEnd: () => setDragging(null) }
                      : {})}
                  />
                );
              }}
            />
          </Column>
        ))}
        {board.columns.length === 0 ? <p className="empty">This state has no children.</p> : null}
      </div>

      {/* The one tray left. "Finished / not started" is gone: a task that ended still ran somewhere,
          and the projection now files it in the column it came to rest in — a card belongs under a
          PLACE, and the lane inside that column is what says it is done. See `BoardView.finished`. */}
      {trays && board.atLevel.length > 0 ? (
        <Tray
          label="At this level"
          cards={board.atLevel}
          selected={selected}
          selectedSet={selectedSet}
          onSelectTask={onSelectTask}
          {...(onOpenTask !== undefined ? { onOpenTask } : {})}
          {...(onTaskMenu !== undefined ? { onTaskMenu } : {})}
        />
      ) : null}
    </div>
  );
}

/**
 * A right-click, translated to "this card, at this point" — the shape the menu's owner wants.
 *
 * The point carries the CARD element as well as the coordinates ({@link pointOf}), because the menu
 * has one decision it cannot make without it: which scrolls close it. See `menu.tsx`.
 */
function menuHandler(
  card: BoardCard,
  onTaskMenu: (card: BoardCard, at: MenuPoint) => void,
): (e: ReactMouseEvent) => void {
  return (e) => {
    e.preventDefault();
    onTaskMenu(card, pointOf(e));
  };
}

/** A row of cards that belong to no column, laned like the columns are. */
function Tray({
  label,
  cards,
  selected,
  selectedSet,
  onSelectTask,
  onOpenTask,
  onTaskMenu,
}: {
  label: string;
  cards: readonly BoardCard[];
  selected: string | null;
  selectedSet?: ReadonlySet<string> | undefined;
  onSelectTask: (taskId: string, e: ReactMouseEvent) => void;
  onOpenTask?: ((card: BoardCard) => void) | undefined;
  onTaskMenu?: ((card: BoardCard, at: MenuPoint) => void) | undefined;
}): JSX.Element {
  return (
    <div className="tray">
      <h4>{label}</h4>
      <div className="tray-cards">
        <Lanes
          cards={cards}
          render={(card) => (
            <Card
              key={card.taskId}
              card={card}
              selected={selectedSet !== undefined ? selectedSet.has(card.taskId) : card.taskId === selected}
              onSelect={(e) => onSelectTask(card.taskId, e)}
              {...(onOpenTask !== undefined ? { onDrill: () => onOpenTask(card) } : {})}
              {...(onTaskMenu !== undefined ? { onMenu: menuHandler(card, onTaskMenu) } : {})}
            />
          )}
        />
      </div>
    </div>
  );
}

