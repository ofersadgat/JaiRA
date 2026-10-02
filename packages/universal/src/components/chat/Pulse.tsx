import { useEffect, useRef, type JSX } from "react";
import { Animated, Easing } from "react-native";
import { View } from "@tamagui/core";
import { useTokens } from "../../tokens";
import { useMoves } from "../../useMoves";

/**
 * `Pulse`: three dots in the colour given, breathing one after another — what says something is
 * happening NOW (a step in flight, the phase in progress, an answer being written, the status bar). It
 * is drawn only where that is true (`stillRunning.ts`), so that it moves is part of what it says.
 *
 *   the dots       4 round, 3 apart
 *   each           1.25s ease-in-out, for ever: opacity 0.2 → 1 → 0.2; the second 0.18s after the first,
 *                  the third 0.36s
 *   held           still at 0.55 — with less motion asked for, and under a test that reads the screen
 *                  (web: a still PICTURE holds the dots whole, as the reference pictures have them)
 *
 * On a phone the native driver moves them (this file); `Pulse.web.tsx` is a CSS animation, which a still
 * picture's `animation: none` holds.
 */
export function Pulse({ color = "accent" }: { color?: string }): JSX.Element {
  const t = useTokens();
  const { moves } = useMoves();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(HELD))).current;
  useEffect(() => {
    if (!moves) return undefined;
    const loops = dots.map((dot, i) => {
      dot.setValue(0.2);
      const half = (toValue: number): Animated.CompositeAnimation => Animated.timing(dot, { toValue, duration: 625, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
      const loop = Animated.sequence([Animated.delay(i * 180), Animated.loop(Animated.sequence([half(1), half(0.2)]))]);
      loop.start();
      return loop;
    });
    return () => {
      for (const loop of loops) loop.stop();
      for (const dot of dots) dot.setValue(HELD);
    };
  }, [moves, dots]);
  return (
    <View flexDirection="row" alignItems="center" gap={3} flexShrink={0}>
      {dots.map((opacity, i) => (
        <Animated.View key={i} style={{ width: 4, height: 4, borderRadius: 999, opacity, backgroundColor: t.v(color) as never }} />
      ))}
    </View>
  );
}

/** A dot's opacity while it does not move. */
const HELD = 0.55;
