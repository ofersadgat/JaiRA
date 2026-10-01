import { useMemo, useRef, useState, type JSX } from "react";
import { PanResponder, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { clampSplit, splitKey } from "@jaira/ui/splitterModel";
import { NO_STACK, useHover } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * The divider between two panes, dragged to resize the one before it (the size clamped by
 * `clampSplit`, `splitterModel.ts`). How it looks:
 *
 *   the divider            6 wide, a 2px --line down its middle (2 in from each side); --accent hovered,
 *                          dragged or reached by the keyboard (`:focus-visible`), where it draws no outline
 *   horizontal             6 tall, the line across (2 in from above and below)
 *
 * `extent` is the container along the drag, for `reserve` — the parent measures it. A double-press
 * restores `reset`. On web it is a tab stop the arrow keys move (`splitKey`): a divider that can only be
 * dragged is one some people cannot move.
 */
export function Splitter({
  value,
  onChange,
  min = 140,
  max = 720,
  orientation = "vertical",
  reserve,
  extent = 0,
  label,
  reset,
  invert = false,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  orientation?: "vertical" | "horizontal";
  reserve?: number;
  extent?: number;
  label: string;
  reset: number;
  /** The pane AFTER the divider is the one sized: a drag right narrows it. */
  invert?: boolean;
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const [dragging, setDragging] = useState(false);
  // Focused by the keyboard (`:focus-visible`): a press focuses it too, and lights nothing.
  const [keyed, setKeyed] = useState(false);
  const horizontal = orientation === "horizontal";
  // The latest props, for a responder made once.
  const live = useRef({ value, onChange, min, max, reserve, extent, reset, invert });
  live.current = { value, onChange, min, max, reserve, extent, reset, invert };
  const from = useRef(0);
  const lastTap = useRef(0);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          const now = Date.now();
          const l = live.current;
          if (now - lastTap.current < 300) l.onChange(clampSplit(l.reset, l.min, l.max, l.reserve, l.extent));
          lastTap.current = now;
          from.current = l.value;
          setDragging(true);
        },
        onPanResponderMove: (_e, g) => {
          const l = live.current;
          const moved = horizontal ? g.dy : g.dx;
          l.onChange(clampSplit(from.current + (l.invert ? -moved : moved), l.min, l.max, l.reserve, l.extent));
        },
        onPanResponderRelease: () => setDragging(false),
        onPanResponderTerminate: () => setDragging(false),
      }),
    [horizontal],
  );
  const keys = isWeb
    ? {
        tabIndex: 0,
        "aria-orientation": orientation,
        onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
          const l = live.current;
          const next = splitKey(event.key, event.shiftKey, l.value, horizontal, l.invert);
          if (next === undefined) return;
          l.onChange(clampSplit(next, l.min, l.max, l.reserve, l.extent));
          event.preventDefault();
        },
        onFocus: (event: { target: unknown }) => setKeyed((event.target as { matches?: (selector: string) => boolean }).matches?.(":focus-visible") === true),
        onBlur: () => setKeyed(false),
      }
    : {};
  return (
    <RNView
      {...pan.panHandlers}
      {...(keys as object)}
      role="separator"
      accessibilityLabel={label}
      // Positioned and no stacking context (`NO_STACK`).
      style={{ flexShrink: 0, ...NO_STACK, ...(horizontal ? { height: 6 } : { width: 6 }), ...(isWeb ? ({ cursor: horizontal ? "row-resize" : "col-resize", userSelect: "none", touchAction: "none", outlineStyle: "none" } as object) : {}) } as never}
    >
      <View {...(hover as object)} flex={1} {...(horizontal ? { paddingVertical: 2 } : { paddingHorizontal: 2 })}>
        <View flex={1} backgroundColor={t.v(hovered || dragging || keyed ? "accent" : "line") as never} />
      </View>
    </RNView>
  );
}
