/**
 * Which cards can be dragged, and into which columns — the board's half of `on_user_event`.
 *
 * A transition guard can wait on a gesture (WORKFLOWS.md §7.4), and when one does, the run publishes
 * a request naming the event and where the card has to land. This turns that list into the question
 * the board actually asks: given the columns on screen, may THIS card be picked up, and would a drop
 * on THAT column mean anything?
 *
 * ## It reads the WAITS, not the workflow
 *
 * The tempting alternative is to read the state file — find the transitions whose guard calls
 * `on_user_event('task_drag')` and light up their targets. It would put a second evaluator for the
 * expression language in the renderer, and it would have to be wrong: a guard is
 * `.inputs.severity > 2 && on_user_event('task_drag')`, so knowing whether the drag is on offer means
 * knowing the run's data, which the board does not have.
 *
 * The engine has already answered. A request EXISTS only because resolution reached the call, which
 * happens only when everything ahead of it in the guard was true — so a wait is an offer that has
 * already had its preconditions checked, by the thing that owns the checking.
 *
 * ## Both ends have to be on screen
 *
 * A `to_state` names a child key of the state whose transition is waiting, which is the same
 * namespace this board keys its columns by — one level down from `board.level`. A wait belonging to a
 * deeper state therefore matches no column here and offers nothing, which is right: dropping a card
 * on a column that is not the one the rule meant would be a gesture the board invented.
 */
import { TASK_DRAG, type BoardView, type PendingUserEvent } from "@jaira/shared/browser";

/**
 * taskId → (column key → the wait a drop there would answer).
 *
 * A card can have more than one target: two rules can offer the same task two different moves, and
 * each is a different wait with a different id. Which one a drop answers is decided by where it
 * lands, which is the whole point of dragging it there.
 */
export type DragOffers = ReadonlyMap<string, ReadonlyMap<string, string>>;

export const NO_DRAG_OFFERS: DragOffers = new Map();

/** Every drag this board can actually offer, from the waits every open project has published. */
export function dragOffersOf(board: BoardView, requests: readonly PendingUserEvent[]): DragOffers {
  const columns = new Set(board.columns.map((c) => c.key));
  // The cards this board is drawing, so a wait belonging to a task shown somewhere else does not
  // quietly make a card draggable on a board that is not about it.
  const shown = new Set([...board.columns.flatMap((c) => c.cards), ...board.atLevel].map((c) => c.taskId));

  const offers = new Map<string, Map<string, string>>();
  for (const request of requests) {
    if (request.event !== TASK_DRAG) continue;
    const taskId = request.taskId;
    if (taskId === undefined || !shown.has(taskId)) continue;
    const to = request.options.to_state;
    if (typeof to !== "string" || !columns.has(to)) continue;
    const forTask = offers.get(taskId) ?? new Map<string, string>();
    // FIRST wins, matching the engine: transitions are evaluated in declared order and the first
    // match is taken, so where two rules offer the same move the earlier one is the one that would
    // fire.
    if (!forTask.has(to)) forTask.set(to, request.requestId);
    offers.set(taskId, forTask);
  }
  return offers;
}

/** Whether this card can be picked up at all — it has somewhere to go. */
export function canDrag(offers: DragOffers, taskId: string): boolean {
  return (offers.get(taskId)?.size ?? 0) > 0;
}

/** The wait a drop of this card on this column would answer, or `undefined` for a column that is
 *  not one of its targets. */
export function requestFor(offers: DragOffers, taskId: string, columnKey: string): string | undefined {
  return offers.get(taskId)?.get(columnKey);
}
