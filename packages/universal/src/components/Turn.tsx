import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";

/**
 * What turns, as the desktop's spinners do (`.spinner` and `.um-spin`: a turn every 900ms, linear, and
 * still when the person asks for less motion). On a phone the native driver turns it; `Turn.web.tsx`
 * is a CSS animation, which a still picture's `animation: none` holds.
 */
export function Turn({ ms = 900, children }: { ms?: number; children: ReactNode }): JSX.Element {
  const turn = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(true);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduced) => live && setStill(reduced));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  useEffect(() => {
    if (still) return;
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      turn.setValue(0);
    };
  }, [still, ms, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return <Animated.View style={{ transform: [{ rotate }] }}>{children}</Animated.View>;
}
