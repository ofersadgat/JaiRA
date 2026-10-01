/**
 * What a card in the air means to the board — the half of `Board.tsx`'s `Board` that is not drawing.
 *
 * The board holds a drag: which card is up, the connect answers asked for it, and what a drop on each
 * column would do. The gesture differs (HTML5 drag on a page, a long press and a pan on a phone); what
 * it MEANS must not, so it is here, once. No React and no DOM.
 *
 * - {@link canPickUp}: whether a card can be lifted at all — a waiting rule offered it a move
 *   (`taskDrag.ts`), or it can be connected somewhere (`connectDrag.ts`).
 * - {@link connectDragOf}: the connect memo made when a card is picked up, already asking about every
 *   column it could go to — every column but its own and the ones a waiting rule offers.
 * - {@link columnDropOf}: what a drop on one column does, and what it says while the card is over it.
 */
import type { BoardCard, BoardColumn, BoardView, MoveConfirm as MoveConfirmKind } from "@jaira/shared/browser";
import { canConnect, ConnectDrag, ownColumnOf, previewOf, type ConnectAsk, type ConnectPreview } from "./connectDrag";
import { canDrag, requestFor, type DragOffers } from "./taskDrag";

/** The yes of each ASK cell, as its button says it. */
export const CONFIRM_YES: Record<MoveConfirmKind, string> = { "stop-and-rewind": "Stop and go back", "pause-and-move": "Pause and move" };

/** A move's question, put in the column the task would land in until the person answers it. */
export type MoveQuestion = { column: string; sentence: string; yes: string; go: () => void };

/** What a drop on a column would do, while a card is in the air (`Board.tsx`'s `Column`'s `drop`). */
export type ColumnDrop = { accepts: boolean; onDrop: () => void; preview?: () => ConnectPreview | "asking" | undefined };

/** The board's connect, as a drag needs it: the dry run and the commit. */
export type ConnectDrop = {
  ask: ConnectAsk;
  /** The commit. `confirmed` once the person said yes to the move table's question, where it asks one. */
  onDrop: (card: BoardCard, column: BoardColumn, confirmed?: boolean) => void;
};

/**
 * Whether a card can be picked up: only where a drop somewhere would mean something. A board with no
 * drop handler moves nothing.
 */
export function canPickUp(card: BoardCard, dragOffers: DragOffers, onTaskDrop: unknown, connect: unknown): boolean {
  return onTaskDrop !== undefined && (canDrag(dragOffers, card.taskId) || (connect !== undefined && canConnect(card)));
}

/**
 * The drag's CONNECT answers, made the moment the card is picked up: one dry run per column, asked at
 * once and never again (`ConnectDrag`). `null` where the card cannot be connected.
 */
export function connectDragOf(board: BoardView, card: BoardCard, dragOffers: DragOffers, connect: Pick<ConnectDrop, "ask"> | undefined, changed: () => void): ConnectDrag | null {
  if (connect === undefined || !canConnect(card)) return null;
  const drag = new ConnectDrag(card, connect.ask, changed);
  const own = ownColumnOf(board.columns, card);
  for (const column of board.columns) {
    // Its own column is where it IS; a column a waiting rule offers is that rule's to answer.
    if (column.key === own || requestFor(dragOffers, card.taskId, column.key) !== undefined) continue;
    drag.resolve(column);
  }
  return drag;
}

/**
 * What a drop on this column would do, while `card` is in the air.
 *
 * `undefined` when nothing is being dragged, so a column that is not part of a gesture in progress
 * carries no drop handlers at all rather than handlers that decline.
 */
export function columnDropOf({
  card,
  column,
  dragOffers,
  drag,
  connect,
  onTaskDrop,
  putDown,
  confirm,
}: {
  card: BoardCard | null;
  column: BoardColumn;
  dragOffers: DragOffers;
  drag: ConnectDrag | null;
  connect: ConnectDrop | undefined;
  onTaskDrop: ((requestId: string, card: BoardCard, columnKey: string) => void) | undefined;
  /** The card was put down: the drag is over, whatever the drop does. */
  putDown: () => void;
  /** Put the move table's question in front of the commit. */
  confirm: (question: MoveQuestion) => void;
}): ColumnDrop | undefined {
  if (card === null || onTaskDrop === undefined) return undefined;
  const columnKey = column.key;
  const requestId = requestFor(dragOffers, card.taskId, columnKey);
  if (requestId !== undefined || drag === null || connect === undefined || drag.answer(columnKey) === undefined) {
    return {
      accepts: requestId !== undefined,
      onDrop: () => {
        putDown();
        if (requestId !== undefined) onTaskDrop(requestId, card, columnKey);
      },
    };
  }
  return {
    accepts: drag.accepts(columnKey),
    // THE DROP IS THE COMMIT: no dialog, no second step — except where the move table ASKS first,
    // and then the question is put in the column the task would land in, and yes is the commit.
    onDrop: () => {
      const accepted = drag.accepts(columnKey);
      const preview = previewOf(drag.answer(columnKey), card, column);
      putDown();
      if (!accepted) return;
      const judgement = (() => {
        const answer = drag.answer(columnKey);
        return answer?.status === "answered" ? answer.result.plan?.judgement : undefined;
      })();
      if (judgement?.confirm !== undefined) {
        confirm({ column: columnKey, sentence: preview?.confirm ?? "Take this move?", yes: CONFIRM_YES[judgement.confirm], go: () => connect.onDrop(card, column, true) });
        return;
      }
      connect.onDrop(card, column);
    },
    preview: () => (drag.answer(columnKey)?.status === "asking" ? "asking" : previewOf(drag.answer(columnKey), card, column)),
  };
}
