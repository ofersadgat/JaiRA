import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import { isStill } from "../motion";

/**
 * What breathes — the ring's working segments (`StatusRing.tsx`): full, a third, full again, every `ms`,
 * and still when the person asks for less motion. On a phone the native driver moves it; `Breathe.web.tsx`
 * is a CSS animation, which a still picture's `animation: none` holds (`motion.ts`).
 */
export function Breathe({ ms = 1800, children }: { ms?: number; children: ReactNode }): JSX.Element {
  const level = useRef(new Animated.Value(1)).current;
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
    if (still || isStill()) return;
    const half = (toValue: number): Animated.CompositeAnimation => Animated.timing(level, { toValue, duration: ms / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([half(0.35), half(1)]));
    loop.start();
    return () => {
      loop.stop();
      level.setValue(1);
    };
  }, [still, ms, level]);
  return <Animated.View style={{ opacity: level }}>{children}</Animated.View>;
}
