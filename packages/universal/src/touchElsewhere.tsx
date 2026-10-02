import type { JSX, ReactNode } from "react";
import { View as RNView } from "react-native";
import { isWeb } from "@tamagui/core";

/**
 * A touch landing anywhere in the shell, for what a press opened IN PLACE and a press elsewhere puts
 * away — a message's rail, with no pointer that hovers (`SessionTranscript.tsx`). A float needs none of
 * this: it is drawn in a `MenuLayer`, whose own ground takes the press outside it.
 *
 * The shell's root hears every touch: a touch bubbles to it whatever is under the finger and whoever
 * takes the press, after the boxes nearer the finger have heard it — so a listener can tell a touch on
 * its own thing (which heard it first) from one elsewhere.
 */
const listeners = new Set<() => void>();

/** Hear every touch in the shell until the returned function is called. */
export function onTouchElsewhere(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const heard = (): void => {
  for (const listener of [...listeners]) listener();
};

/** For the shell's root box on web, where a Tamagui box hands a touch's event to its element. */
export const shellTouch: Record<string, unknown> = isWeb ? { onTouchStart: heard } : {};

/**
 * Round the shell on a phone: a Tamagui box does not hand `onTouchStart` on there (it keeps its own
 * press handling), so the touch is heard on a React Native box around the shell. On web the shell's own
 * root hears it (`shellTouch`) and this is nothing.
 */
export function TouchRoot({ children }: { children: ReactNode }): JSX.Element {
  if (isWeb) return <>{children}</>;
  return (
    <RNView style={{ flex: 1 }} onTouchStart={heard}>
      {children}
    </RNView>
  );
}
