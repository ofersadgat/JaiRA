import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Animated, Easing, Text } from "react-native";
import { useMoves } from "../../useMoves";

/**
 * What moves in the Debug session panel, on a phone (`SessionPanel.tsx`): a running call's dot breathing
 * and the caret after an answer still being written. On web neither moves (`motion.web.tsx`): a still
 * picture holds no animation, and the page is held to its reference pictures (`pair.mts`). How they move:
 *
 *   a running call's dot      1.4s ease-in-out, for ever: opacity 0.2 → 1 → 0.2; with less motion
 *                             asked for, still at 0.7
 *   the caret "▍"             1s in two steps, for ever: shown for half a second, gone for half
 *
 * Both stand still under a test that reads the screen (`motion.ts`, asked through `useMoves`).
 */

/** The pulse on what it holds, on the native driver. */
export function Breathing({ children }: { children: ReactNode }): JSX.Element {
  const { moves, reduced } = useMoves();
  const breath = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!moves) return undefined;
    breath.setValue(0.2);
    const half = (toValue: number): Animated.CompositeAnimation => Animated.timing(breath, { toValue, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([half(1), half(0.2)]));
    loop.start();
    return () => {
      loop.stop();
      breath.setValue(1);
    };
  }, [moves, breath]);
  return <Animated.View style={{ opacity: reduced ? 0.7 : breath }}>{children}</Animated.View>;
}

/** The writing caret, inside the text it follows: there half a second, gone half a second. */
export function Caret(): JSX.Element {
  const { moves } = useMoves();
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (!moves) return undefined;
    const timer = setInterval(() => setShown((was) => !was), 500);
    return () => {
      clearInterval(timer);
      setShown(true);
    };
  }, [moves]);
  // A span inside a `Text` takes no opacity on Android, so its ink goes instead — to all but nothing:
  // `transparent` itself reads there as no colour set, and the span kept the text's.
  return <Text style={shown ? undefined : { color: "rgba(0, 0, 0, 0.01)" }}>▍</Text>;
}
