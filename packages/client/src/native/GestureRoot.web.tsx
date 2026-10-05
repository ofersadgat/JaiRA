import type { JSX, ReactNode } from "react";
import { View } from "react-native";

/** `GestureRoot.tsx` in a browser: a box, since nothing on a page lifts a card with the gesture handler. */
export function GestureRoot({ children }: { children: ReactNode }): JSX.Element {
  return <View style={{ flex: 1 }}>{children}</View>;
}
