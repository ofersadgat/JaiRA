/**
 * Where a float goes against its anchor — `popover.tsx`'s placement, pure, so the universal copies
 * (decision 0015) place their floats by the same arithmetic: on the side asked for, flipped to the other
 * when that has more room, clamped inside the window, its height capped to the room it has.
 */
/** Room kept between a float and its anchor, and between a float and the window's edge. */
export const FLOAT_GAP = 6;
export const FLOAT_EDGE = 4;
/** The least height a float is squeezed to before it is allowed to overlap its anchor instead. */
export const MIN_HEIGHT = 120;

/** A box in window coordinates — a selection's rect, a caret, a pointer (a rect of no size). */
export interface FloatRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Which side of the anchor a float prefers. It takes the other one when that has more room. */
export type FloatSide = "above" | "below" | "left" | "right";
/**
 * Which edges line up along the other axis: `start` puts the float's left (or top) edge on the
 * anchor's, `end` its right (or bottom) edge, `center` their middles.
 */
export type FloatAlign = "start" | "end" | "center";

/** Where a float of `width` × `height` goes against `a`. Pure, so it can be read on its own. */
export function placeFloat(
  a: FloatRect,
  size: { width: number; height: number },
  view: { width: number; height: number },
  side: FloatSide,
  align: FloatAlign,
  gap: number = FLOAT_GAP,
): { left: number; top: number; maxHeight: number | undefined } {
  const { width, height } = size;
  const clampX = (x: number): number => Math.max(FLOAT_EDGE, Math.min(x, view.width - width - FLOAT_EDGE));
  const clampY = (y: number): number => Math.max(FLOAT_EDGE, Math.min(y, view.height - height - FLOAT_EDGE));
  const along = (start: number, end: number, extent: number): number =>
    align === "start" ? start : align === "end" ? end - extent : (start + end) / 2 - extent / 2;

  if (side === "above" || side === "below") {
    const above = a.top - gap - FLOAT_EDGE;
    const below = view.height - a.bottom - gap - FLOAT_EDGE;
    const wanted = side === "above" ? above : below;
    const other = side === "above" ? below : above;
    const up = height <= wanted || wanted >= other ? side === "above" : side !== "above";
    const room = Math.max(MIN_HEIGHT, up ? above : below);
    const shown = Math.min(height, room);
    const top = up ? a.top - gap - shown : a.bottom + gap;
    return {
      left: clampX(along(a.left, a.right, width)),
      top: Math.max(FLOAT_EDGE, Math.min(top, view.height - shown - FLOAT_EDGE)),
      maxHeight: height > room ? room : undefined,
    };
  }
  const leftRoom = a.left - gap - FLOAT_EDGE;
  const rightRoom = view.width - a.right - gap - FLOAT_EDGE;
  const wanted = side === "left" ? leftRoom : rightRoom;
  const other = side === "left" ? rightRoom : leftRoom;
  const toLeft = width <= wanted || wanted >= other ? side === "left" : side !== "left";
  const roomY = view.height - 2 * FLOAT_EDGE;
  return {
    left: clampX(toLeft ? a.left - gap - width : a.right + gap),
    top: clampY(along(a.top, a.bottom, Math.min(height, roomY))),
    maxHeight: height > roomY ? roomY : undefined,
  };
}
