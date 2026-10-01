import { useMemo, useRef, useState, type JSX } from "react";
import { PanResponder, type LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import { lengthToken } from "../../primitives";
import { useLook, useTokens } from "../../tokens";

/**
 * `input[type="range"]` on a phone: there is no such control, so it is drawn — a plain input's
 * box (--bg, 1px --line, radius --control-radius, padding 5 9, the UA's 2 round it) holding Chromium's
 * slider as it draws one with no `accent-color`, in the look's scheme (measured off the element on web):
 * a 16 thumb on an 8 track, the thumb's colour up to it and the rest past it under a 1px ring — light
 * #0075ff, #efefef, #767676; dark #99c8ff, #3b3b3b, #858585. A press on the track
 * jumps the thumb there and a drag moves it, snapped to `step`, as the element's own. The web's is the
 * element (`Range.web.tsx`).
 */
const THUMB = 16;
const TRACK = 8;
const INKS = { light: { fill: "#0075ff", rest: "#efefef", ring: "#767676" }, dark: { fill: "#99c8ff", rest: "#3b3b3b", ring: "#858585" } } as const;

export function Range({ min = 0, max = 1, step = 0.01, value, onChange, label, width }: { min?: number; max?: number; step?: number; value: number; onChange: (next: number) => void; label?: string; width?: number }): JSX.Element {
  const t = useTokens();
  const ink = INKS[useLook().scheme];
  const [room, setRoom] = useState(0);
  // Read through refs: the responder is made once, and a drag outlives the render it started in.
  const live = useRef({ min, max, step, room, onChange });
  live.current = { min, max, step, room, onChange };
  const responder = useMemo(
    () => {
      const at = (x: number): void => {
        const { min: lo, max: hi, step: by, room: w, onChange: set } = live.current;
        if (w <= THUMB) return;
        const f = Math.min(1, Math.max(0, (x - THUMB / 2) / (w - THUMB)));
        const snapped = Math.round((f * (hi - lo)) / by) * by + lo;
        set(Math.min(hi, Math.max(lo, Number(snapped.toFixed(6)))));
      };
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => at(e.nativeEvent.locationX),
        onPanResponderMove: (e) => at(e.nativeEvent.locationX),
      });
    },
    [],
  );
  const f = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const x = f * Math.max(0, room - THUMB);
  return (
    <View
      margin={2}
      {...(width !== undefined ? { width } : { alignSelf: "stretch" })}
      paddingVertical={5}
      paddingHorizontal={9}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v("line") as never}
      borderRadius={lengthToken(t, "control-radius", 7) as never}
      backgroundColor={t.v("bg") as never}
      role="slider"
      {...({ "aria-label": label, "aria-valuemin": min, "aria-valuemax": max, "aria-valuenow": value } as object)}
    >
      {/* The touch target is the whole track: its children take no touches, so `locationX` is the track's. */}
      <View height={THUMB} justifyContent="center" onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)} {...responder.panHandlers}>
        <View pointerEvents="none" height={TRACK} borderRadius={TRACK / 2} backgroundColor={ink.rest} borderWidth={1} borderStyle="solid" borderColor={ink.ring} overflow="hidden">
          <View width={x + THUMB / 2} height="100%" backgroundColor={ink.fill} />
        </View>
        <View pointerEvents="none" position="absolute" left={x} top={0} width={THUMB} height={THUMB} borderRadius={THUMB / 2} backgroundColor={ink.fill} />
      </View>
    </View>
  );
}
