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
import type { JSX, ReactNode } from "react";
import type { BoardCard, BoardView } from "@jaira/shared/browser";

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
  onSelect: () => void;
  onDrill?: (() => void) | undefined;
}): JSX.Element {
  return (
    <div
      className={`card${status !== undefined ? ` card-${status}` : ""}${selected === true ? " card-selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onDrill}
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

export function Card({
  card,
  selected,
  onSelect,
  onDrill,
}: {
  card: BoardCard;
  selected: boolean;
  onSelect: () => void;
  onDrill?: () => void;
}): JSX.Element {
  // The card's own status — the one the board is actually about, which for a task inside a workflow
  // is where it is NOW rather than what the task as a whole is doing.
  const status = card.activeStatus ?? card.status;
  return (
    <Tile
      status={status}
      title={card.title}
      selected={selected}
      tip={onDrill ? "double-click to walk into this state" : (card.activeStateId ?? card.status)}
      trailing={onDrill ? <span className="drill">↳</span> : undefined}
      // The status in words as well as in the stripe: a colour is a reminder, not a label, and the
      // state a task is sitting in is the thing you came to the board to read.
      meta={
        <>
          <span className="ellip">{card.activeStateId ?? card.status}</span>
          {card.activeStateId !== undefined ? <span className="card-status">{status.replace(/_/g, " ")}</span> : null}
        </>
      }
      onSelect={onSelect}
      onDrill={onDrill}
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
  numbered = true,
  trays = true,
  onSelectTask,
  onDrill,
}: {
  board: BoardView;
  selected: string | null;
  numbered?: boolean;
  trays?: boolean;
  onSelectTask: (taskId: string) => void;
  onDrill: (stateId: string) => void;
}): JSX.Element {
  return (
    <div className="board-body">
      <div className="columns">
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
            {column.cards.map((card) => (
              <Card
                key={card.taskId}
                card={card}
                selected={card.taskId === selected}
                onSelect={() => onSelectTask(card.taskId)}
                {...(drillTargetOf(board, card) !== undefined
                  ? { onDrill: () => onDrill(drillTargetOf(board, card)!) }
                  : {})}
              />
            ))}
          </Column>
        ))}
        {board.columns.length === 0 ? <p className="empty">This state has no children.</p> : null}
      </div>

      {trays && board.atLevel.length > 0 ? (
        <div className="tray">
          <h4>At this level</h4>
          <div className="tray-cards">
            {board.atLevel.map((card) => (
              <Card
                key={card.taskId}
                card={card}
                selected={card.taskId === selected}
                onSelect={() => onSelectTask(card.taskId)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {trays && board.finished.length > 0 ? (
        <div className="tray">
          <h4>Finished / not started</h4>
          <div className="tray-cards">
            {board.finished.map((card) => (
              <Card
                key={card.taskId}
                card={card}
                selected={card.taskId === selected}
                onSelect={() => onSelectTask(card.taskId)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The path bar.
 *
 * A file-explorer path, not a label: every segment but the last is a way back out, and the root
 * entry is always reachable because a board you cannot leave is a trap.
 */
export function PathBar({
  breadcrumb,
  onGo,
  children,
}: {
  breadcrumb: string[];
  onGo: (level: string | null) => void;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <header className="path-bar">
      <button className="crumb" onClick={() => onGo(null)} title="every workflow root">
        ⌂ all workflows
      </button>
      {breadcrumb.map((crumb, i) => {
        const last = i === breadcrumb.length - 1;
        return (
          <span key={crumb} className="crumb-part">
            <span className="crumb-sep">›</span>
            <button className={last ? "crumb last" : "crumb"} onClick={last ? undefined : () => onGo(crumb)}>
              {crumb.split("/").pop()}
            </button>
          </span>
        );
      })}
      <span className="spacer" />
      {children}
    </header>
  );
}
