/**
 * A draggable divider's arithmetic: the size a drag or a key asks for, held between the pane's
 * limits. The gesture is `Splitter`'s (`packages/universal/src/components/files/Splitter.tsx`).
 */

/**
 * A dragged size, held between `min` and `max` — and, with a `reserve`, to what leaves the rest of the
 * container that much (`extent` is the container along the drag).
 */
export function clampSplit(next: number, min: number, max: number, reserve: number | undefined, extent: number): number {
  let ceiling = max;
  // A container that has not been laid out yet measures 0, and clamping to `min` on the
  // strength of that would collapse the pane on the first frame.
  if (reserve !== undefined && extent > 0) ceiling = Math.min(ceiling, Math.max(min, extent - reserve));
  return Math.min(ceiling, Math.max(min, next));
}

/**
 * Where a key moves a divider from `value`, unclamped — or `undefined` for a key that is not its to take.
 * The pair of keys follows the axis: arrows across a divider that only moves up and down are arrows that
 * appear to do nothing. Shift moves it four times as far.
 */
export function splitKey(key: string, shift: boolean, value: number, horizontal: boolean, invert: boolean): number | undefined {
  const step = shift ? 48 : 12;
  const towards = invert ? -1 : 1;
  const [less, more] = horizontal ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  if (key === less) return value - step * towards;
  if (key === more) return value + step * towards;
  return undefined;
}
