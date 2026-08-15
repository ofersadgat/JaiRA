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
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { BoardCard, BoardView } from "@jaira/shared/browser";

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
  if (card.status === "queued") return "not-started";
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
 * around it — the raised tile, the status stripe down the edge, the head row, the footer under a
 * rule — is the same in both, and was duplicated instead of shared until restyling one of them
 * left the other behind.
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
}): JSX.Element {
  return (
    <div
      className={`card${status !== undefined ? ` card-${status}` : ""}${selected === true ? " card-selected" : ""}`}
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
        {status !== undefined ? <Badge status={status} /> : null}
        <span className="card-title">{title}</span>
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
 */
export function Column({
  name,
  seq,
  count,
  empty,
  tip,
  onOpen,
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
  children?: ReactNode;
}): JSX.Element {
  return (
    <section className="column" {...(onOpen !== undefined ? { onDoubleClick: onOpen } : {})} {...(tip !== undefined ? { title: tip } : {})}>
      <h4>
        {seq !== undefined ? <span className="seq">{seq}</span> : null}
        <span className="col-name">{name}</span>
        <span className="count">{count}</span>
      </h4>
      {children}
      {count === 0 ? <div className="empty">{empty}</div> : null}
    </section>
  );
}

/**
 * A column's cards, under a heading per lane.
 *
 * Headings only where there is something under them, and none at all when every card in the column
 * is in the same lane — a "Running" rule over a column of four running tasks is a line that says
 * what the four badges below it already say. The sections earn their space by being a DIVISION, so
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
  // cards says what every badge under it says. The lane's OWN cards, not the ones passed in — a
  // column that is all finished is the commonest case there is, and it is the one whose order the
  // lane fixed.
  if (lanes.length <= 1) return <>{(lanes[0]?.cards ?? []).map(render)}</>;
  return (
    <>
      {lanes.map(({ lane, cards: inLane }) => (
        <div key={lane} className={`lane lane-${lane}`}>
          <h5>
            <span className="grow">{LANE_LABEL[lane]}</span>
            <span className="count">{inLane.length}</span>
          </h5>
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

export function Card({
  card,
  selected,
  onSelect,
  onDrill,
  onMenu,
}: {
  card: BoardCard;
  selected: boolean;
  onSelect: (e: ReactMouseEvent) => void;
  onDrill?: () => void;
  onMenu?: (e: ReactMouseEvent) => void;
}): JSX.Element {
  // The card's own status — the one the board is actually about, which for a task inside a workflow
  // is where it is NOW rather than what the task as a whole is doing.
  const status = card.activeStatus ?? card.status;
  return (
    <Tile
      status={status}
      title={card.title}
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
      trailing={onDrill ? <span className="drill">↳</span> : undefined}
      // The status in words as well as in the stripe: a colour is a reminder, not a label, and the
      // state a task is sitting in is the thing you came to the board to read.
      //
      // A run that is OVER reports WHEN instead. Where it is stopped being the question the moment it
      // stopped moving, and "which of these four finished runs is the one from this morning" is a
      // question a column of identical grey cards could not answer at all.
      meta={
        card.endedAt !== undefined ? (
          <>
            <span className="ellip">{card.status}</span>
            <span className="card-status" title={new Date(card.endedAt).toLocaleString()}>
              {endedLabel(card.endedAt)}
            </span>
          </>
        ) : (
          <>
            <span className="ellip">{card.activeStateId ?? card.status}</span>
            {card.activeStateId !== undefined ? <span className="card-status">{status.replace(/_/g, " ")}</span> : null}
          </>
        )
      }
      onSelect={onSelect}
      onDrill={onDrill}
      onMenu={onMenu}
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
  onDrill,
  onOpenTask,
  onTaskMenu,
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
  onTaskMenu?: ((card: BoardCard, x: number, y: number) => void) | undefined;
}): JSX.Element {
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
            tip={`double-click to open ${column.stateId}`}
            onOpen={() => onDrill(column.stateId)}
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

/** A right-click, translated to "this card, at this point" — the shape the menu's owner wants. */
function menuHandler(
  card: BoardCard,
  onTaskMenu: (card: BoardCard, x: number, y: number) => void,
): (e: ReactMouseEvent) => void {
  return (e) => {
    e.preventDefault();
    onTaskMenu(card, e.clientX, e.clientY);
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
  onTaskMenu?: ((card: BoardCard, x: number, y: number) => void) | undefined;
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

