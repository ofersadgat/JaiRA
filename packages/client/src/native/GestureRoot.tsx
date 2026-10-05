import type { JSX, ReactNode } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";

/**
 * The root `react-native-gesture-handler` needs above any gesture (a card lifted on the board, `Lift`). The
 * desktop's fitted frame is one (`DesktopFrame`); the phone's own layout stands in this (decision 0015,
 * amended 2026-10-04). `GestureRoot.web.tsx` is a plain box: on web the library brings Reanimated's
 * worklets, which break `one build`, and nothing there lifts a card this way.
 */
export function GestureRoot({ children }: { children: ReactNode }): JSX.Element {
  return <GestureHandlerRootView style={{ flex: 1 }}>{children}</GestureHandlerRootView>;
}
