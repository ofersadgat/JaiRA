/**
 * A draggable divider between two panes.
 *
 * Every multi-pane surface in the app was a CSS grid with widths written into the stylesheet, which
 * is fine until the thing you are reading does not fit one of them — a long state id in a 250px
 * tree, a schema reference squeezed beside an editor. The columns are the same grids; what changes
 * is that one track is now a variable this control writes.
 *
 * It divides ROWS as well, which is the same control with `clientY` where `clientX` was: the Files
 * view stacks a viewer over an editor, and a fixed 46/54 split is the same problem one axis over —
 * a board you cannot enlarge to read, above a form you cannot enlarge to fill in.
 *
 * ## Why pointer capture rather than window listeners
 *
 * A drag that leaves the element — and this one always does, that is the point — stops receiving
 * `pointermove` unless the element captures the pointer. `setPointerCapture` also survives the
 * cursor crossing an iframe or leaving the window, and releases automatically if the pointer is
 * lost, which a hand-rolled `mousemove` + `mouseup` pair on `window` does not.
 *
 * ## Why a callback rather than internal state
 *
 * The width belongs to the layout that owns the grid: it has to survive this component unmounting
 * (switching views), and two splitters in one grid have to be clamped against each other. So the
 * value is passed in and the new one handed back — this holds only the gesture.
 */
import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from "react";

export interface SplitterProps {
  /** The current size of the pane this divider sizes, in px — its width, or its height. */
  value: number;
  onChange: (value: number) => void;
  /** Clamp. A pane that can reach zero is a pane you cannot get back. */
  min?: number;
  max?: number;
  /**
   * Which way the panes are stacked: side by side (the default) or one above the other.
   *
   * The gesture is the same in both — an origin, a delta, a clamp — and only the axis differs, so
   * this is one prop rather than a second component. The name follows ARIA's: a `horizontal`
   * separator is a horizontal LINE, and it therefore moves up and down.
   */
  orientation?: "vertical" | "horizontal";
  /**
   * True when the pane being sized is to the RIGHT of the divider (or BELOW it, when horizontal).
   *
   * Dragging left then makes it wider, not narrower. Getting this backwards produces a control that
   * moves the correct distance in the wrong direction, which reads as a bug in the drag rather than
   * in the sign.
   */
  invert?: boolean;
  /**
   * How much room everything else in the container must keep, in px.
   *
   * `max` alone is a constant, and a constant cannot know how tall the window is. Without this a
   * pane dragged past the far edge keeps growing as a NUMBER while the layout clamps it visually —
   * so the drag back does nothing until the number falls under the real limit, which reads as the
   * divider having stuck. Measured against the container at the moment of the gesture, so it
   * follows a resized window rather than a value written at mount.
   */
  reserve?: number;
  /** Accessible name — "Resize file tree". Two splitters in one view are otherwise identical. */
  label: string;
  /** What a double-click restores — the width the stylesheet used to hard-code. */
  reset: number;
}

const DEFAULT_MIN = 140;
const DEFAULT_MAX = 720;

export function Splitter({
  value,
  onChange,
  min = DEFAULT_MIN,
  max = DEFAULT_MAX,
  orientation = "vertical",
  invert,
  reserve,
  label,
  reset,
}: SplitterProps): JSX.Element {
  /** Where the gesture started, so the size is computed from the ORIGIN and never accumulated. */
  const from = useRef<{ at: number; value: number } | null>(null);
  /** This divider, for {@link SplitterProps.reserve} to measure the container through. */
  const self = useRef<HTMLDivElement | null>(null);

  const horizontal = orientation === "horizontal";
  /** The coordinate this divider moves along. */
  const along = (event: ReactPointerEvent<HTMLDivElement>): number =>
    horizontal ? event.clientY : event.clientX;

  const clamp = (next: number): number => {
    let ceiling = max;
    const container = self.current?.parentElement;
    if (reserve !== undefined && container) {
      const extent = horizontal ? container.clientHeight : container.clientWidth;
      // A container that has not been laid out yet measures 0, and clamping to `min` on the
      // strength of that would collapse the pane on the first frame.
      if (extent > 0) ceiling = Math.min(ceiling, Math.max(min, extent - reserve));
    }
    return Math.min(ceiling, Math.max(min, next));
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = from.current;
    if (start === null) return;
    const delta = along(event) - start.at;
    onChange(clamp(start.value + (invert === true ? -delta : delta)));
  };

  return (
    <div
      ref={self}
      className={`splitter${horizontal ? " horizontal" : ""}`}
      role="separator"
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-label={label}
      tabIndex={0}
      onPointerDown={(event) => {
        // Left button only: a right-drag would start a resize and then open a context menu on top
        // of it.
        if (event.button !== 0) return;
        from.current = { at: along(event), value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        from.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        from.current = null;
      }}
      // Keyboard, because a divider that can only be dragged is a divider some people cannot move.
      // The pair of keys follows the axis: arrows across a divider that only moves up and down are
      // arrows that appear to do nothing.
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 12;
        const towards = invert === true ? -1 : 1;
        const [less, more] = horizontal ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
        if (event.key === less) onChange(clamp(value - step * towards));
        else if (event.key === more) onChange(clamp(value + step * towards));
        else return;
        event.preventDefault();
      }}
      // A double-click restores the default, which is the cheapest way out of a pane dragged to a
      // width that turned out to be useless.
      onDoubleClick={() => onChange(clamp(reset))}
    />
  );
}
