import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { isStill } from "./motion";

/**
 * Whether what moves on its own may move, on a phone: not while the person asks for less motion
 * (`reduced`), and not under a test that reads the screen (`motion.ts`). Until the phone has said which,
 * nothing moves. An endless `Animated` loop asks it before it starts — the pulse (`chat/Pulse.tsx`), the
 * Debug session's breathing dot and caret (`debug/motion.tsx`).
 */
export function useMoves(): { moves: boolean; reduced: boolean } {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((on) => live && setReduced(on));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return { moves: reduced === false && !isStill(), reduced: reduced === true };
}
