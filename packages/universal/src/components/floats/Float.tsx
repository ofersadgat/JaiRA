import { useRef, useState, type JSX, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { FLOAT_GAP, placeFloat, type FloatAlign, type FloatRect, type FloatSide } from "@jaira/ui/floatPlace";
import { useKeyboardInset } from "./keyboard";

/**
 * A box placed against an anchor by `floatPlace.ts`'s arithmetic — on the side asked for, flipped when
 * the other has more room, clamped inside the window, capped to the room it has and scrolling inside
 * past that. Drawn inside a `MenuLayer` (one layer over everything: portalled into `<body>` on web, a
 * transparent `Modal` on a phone), so its left and top are the window's.
 *
 * Its size is MEASURED: until it is known the box is drawn where it will not be seen (opacity 0 at the
 * window's corner). On web the size is read from the element in whole pixels (`offsetWidth`,
 * `offsetHeight`, `scrollHeight`), so a float placed by its bottom edge (`align: "end"`) lands where the
 * reference pictures have it.
 */
export function Float({
  anchor,
  side = "below",
  align = "start",
  offset = FLOAT_GAP,
  children,
  ...box
}: {
  anchor: FloatRect;
  side?: FloatSide;
  align?: FloatAlign;
  /** Room between the float and its anchor (not `gap`: the box's own `gap` is its children's). */
  offset?: number;
  children?: ReactNode;
} & Record<string, unknown>): JSX.Element {
  const whole = useWindowDimensions();
  // A phone's keyboard covers the window's foot: the float is placed in what it leaves (nothing on web).
  const covered = useKeyboardInset();
  const win = covered > 0 ? { width: whole.width, height: whole.height - covered } : whole;
  const ref = useRef<unknown>(null);
  // The size it WANTS: taken while it is not capped, so a cap does not shrink what it asks for.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const placed = size === null ? null : placeFloat(anchor, size, win, side, align, offset);
  return (
    <View
      ref={ref as never}
      position="absolute"
      left={placed?.left ?? 0}
      top={placed?.top ?? 0}
      {...(placed === null ? { opacity: 0, pointerEvents: "none" } : {})}
      {...((placed?.maxHeight !== undefined ? { maxHeight: placed.maxHeight, ...(isWeb ? { overflowY: "auto" } : { overflow: "hidden" }) } : {}) as object)}
      onLayout={(e: { nativeEvent: { layout: { width: number; height: number } } }) => {
        if (placed?.maxHeight !== undefined) return;
        // On web, measured off the element: `offsetWidth`, and the height it wants (`scrollHeight`
        // past what a cap left it), in whole pixels.
        const el = isWeb ? (ref.current as HTMLElement | null) : null;
        const next =
          el !== null && typeof el.offsetHeight === "number"
            ? { width: el.offsetWidth, height: Math.max(el.offsetHeight, el.scrollHeight + (el.offsetHeight - el.clientHeight)) }
            : { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
        setSize((was) => (was !== null && Math.abs(was.width - next.width) < 0.01 && Math.abs(was.height - next.height) < 0.01 ? was : next));
      }}
      {...(box as object)}
    >
      {children}
    </View>
  );
}

/** A point, as the rect of no size a menu is placed against. */
export const pointRect = (x: number, y: number): FloatRect => ({ left: x, top: y, right: x, bottom: y });
