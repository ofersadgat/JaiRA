import { useMemo, useRef, useState, type JSX } from "react";
import { PanResponder, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { clampSplit } from "@jaira/ui/splitter";
import { useHover } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * `splitter.tsx`'s `Splitter`, universal (decision 0015): the divider between two panes, dragged to
 * resize the one before it (the size clamped by `clampSplit`, the desktop's own). The rules, from
 * `styles.css`:
 *
 *   .splitter              6 wide, a 2px --line down its middle (`::before`, inset 0 2px); hovered --accent
 *   .splitter.horizontal   6 tall, the line across (inset 2px 0)
 *
 * `extent` is the container along the drag, for `reserve` — the parent measures it (the DOM one reads
 * its parent element). A double-press restores `reset`, as a double-click does on the desktop.
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
  /** The pane AFTER the divider is the one sized (the DOM's `invert`): a drag right narrows it. */
  invert?: boolean;
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const [dragging, setDragging] = useState(false);
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
          if (now - lastTap.current < 300) l.onChange(l.reset);
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
  return (
    <RNView {...pan.panHandlers} accessibilityRole={"separator" as never} accessibilityLabel={label} style={{ flexShrink: 0, ...(horizontal ? { height: 6 } : { width: 6 }), ...(isWeb ? ({ cursor: horizontal ? "row-resize" : "col-resize", userSelect: "none", touchAction: "none" } as object) : {}) }}>
      <View {...(hover as object)} flex={1} {...(horizontal ? { paddingVertical: 2 } : { paddingHorizontal: 2 })}>
        <View flex={1} backgroundColor={t.v(hovered || dragging ? "accent" : "line") as never} />
      </View>
    </RNView>
  );
}
