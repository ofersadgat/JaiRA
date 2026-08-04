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
import type { JSX } from "react";
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
  return (
    <div
      className={`card${selected ? " card-selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onDrill}
      title={onDrill ? "double-click to walk into this state" : (card.activeStateId ?? card.status)}
    >
      <div className="card-head">
        <Badge status={card.activeStatus ?? card.status} />
        <span className="card-title">{card.title}</span>
        {onDrill ? <span className="drill">↳</span> : null}
      </div>
      <div className="card-meta">{card.activeStateId ?? card.status}</div>
    </div>
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
          <section
            key={column.key}
            className="column"
            onDoubleClick={() => onDrill(column.stateId)}
            title={`double-click to open ${column.stateId}`}
          >
            <h4>
              {numbered ? <span className="seq">{index + 1}</span> : null}
              <span className="col-name">{column.label ?? column.key}</span>
              <span className="count">{column.cards.length}</span>
            </h4>
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
            {column.cards.length === 0 ? <div className="empty">—</div> : null}
          </section>
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
