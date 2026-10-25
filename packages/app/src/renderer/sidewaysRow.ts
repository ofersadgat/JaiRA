/**
 * A row that scrolls sideways — a work summary phase's chips (the chip carousel mockups, 2026-10-24,
 * design C) — as numbers: which of its pieces are out of view on each side, where a press on a side's
 * count takes it, and what a mouse wheel turned over it does. The row draws and listens
 * (`packages/universal/src/components/panel/WorkSummary.tsx`); this decides.
 */

/** Where a piece of the row lies along it: its left edge and its width, in the row's own coordinates. */
export interface Spot {
  x: number;
  w: number;
}

/** The stretch of the row in view: how far along it is scrolled, how wide it is drawn, and how far it can go. */
export interface Viewport {
  x: number;
  width: number;
  max: number;
}

/** How many pieces are wholly or partly out of view on each side. A row not yet measured hides none. */
export function outOfView(spots: readonly Spot[], view: Pick<Viewport, "x" | "width">): { before: number; after: number } {
  if (view.width <= 0) return { before: 0, after: 0 };
  let before = 0;
  let after = 0;
  for (const s of spots) {
    if (s.x < view.x - 1) before++;
    if (s.x + s.w > view.x + view.width + 1) after++;
  }
  return { before, after };
}

/**
 * Where a press on a side's count scrolls the row: a screenful that way. The first piece cut off on that
 * side is brought to the other edge, `fade` in from it so the fade does not cover it — and a piece wider
 * than the view still moves the row along by the view, less a fade at each edge.
 */
export function pageTo(spots: readonly Spot[], view: Viewport, dir: 1 | -1, fade: number): number {
  const stride = Math.max(1, view.width - 2 * fade);
  let to: number;
  if (dir > 0) {
    const cut = spots.find((s) => s.x + s.w > view.x + view.width - fade + 1);
    to = cut === undefined ? view.max : cut.x - fade;
    if (to <= view.x) to = view.x + stride;
  } else {
    const cut = spots.filter((s) => s.x < view.x + fade - 1).pop();
    to = cut === undefined ? 0 : cut.x + cut.w - view.width + fade;
    if (to >= view.x) to = view.x - stride;
  }
  return Math.min(view.max, Math.max(0, to));
}

/** A mouse wheel turn, as the browser reports it. */
export interface Wheel {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  shiftKey: boolean;
}

/** How long after the page last took a wheel turn a turn over the row is still the page's. */
export const PAGE_WHEEL_HOLD_MS = 350;

/** A line of a wheel that turns by lines, in pixels. */
const LINE = 16;

/**
 * Whose a wheel turn over the row is:
 *  - `own`: a sideways turn (a trackpad, a tilting wheel, Shift and the wheel, which the browser turns
 *    sideways itself) — the row's own scrolling takes it;
 *  - `row`: up and down move the row along by `by` pixels, until it reaches that end;
 *  - `page`: then the page scrolls as before; so does a row with nothing out of view, and a turn that
 *    comes within PAGE_WHEEL_HOLD_MS of the page taking one — a page scroll already under way is not
 *    stopped by a row passing under the pointer.
 */
export function wheelOver(wheel: Wheel, view: Viewport, sincePage: number): { to: "own" } | { to: "page" } | { to: "row"; by: number } {
  if (wheel.shiftKey || Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)) return { to: "own" };
  if (wheel.deltaY === 0 || view.max <= 0 || sincePage < PAGE_WHEEL_HOLD_MS) return { to: "page" };
  const by = wheel.deltaY * (wheel.deltaMode === 1 ? LINE : wheel.deltaMode === 2 ? view.width : 1);
  if (by > 0 ? view.x >= view.max - 1 : view.x <= 1) return { to: "page" };
  return { to: "row", by };
}
