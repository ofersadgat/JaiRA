import { useEffect, useState } from "react";
import { Keyboard, Platform, TextInput } from "react-native";

/**
 * How much of the window's foot the on-screen keyboard covers, as it comes up and goes. A float with a
 * box in it (the reviewer's note composer) is placed in what is left: put under its anchor by the
 * window's whole height, it stood behind the keyboard its own box had raised.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(() => (Keyboard.isVisible() ? (Keyboard.metrics()?.height ?? 0) : 0));
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", (e) => setInset(e.endCoordinates.height));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setInset(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return inset;
}

/** Whether the on-screen keyboard is up. */
export function useKeyboardShown(): boolean {
  return useKeyboardInset() > 0;
}

/**
 * Where the keyboard's top edge stands on the screen, or null while it is down — as it STARTS to move on
 * iOS (so what rides on it moves with it), as it has arrived on Android. A box measures itself against it
 * (`PhoneFrame`): on Android a resized window leaves nothing to cover, and the same sum says so.
 */
export function useKeyboardTop(): number | null {
  const [top, setTop] = useState<number | null>(() => {
    const m = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    return m === undefined ? null : m.screenY;
  });
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => setTop(e.endCoordinates.screenY));
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setTop(null));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return top;
}

/** Where the text box being typed into stands on the screen (its top), or null when none is. */
export function focusedInputTop(done: (top: number | null) => void): void {
  const focused = TextInput.State.currentlyFocusedInput() as unknown as { measureInWindow?: (to: (x: number, y: number) => void) => void } | null;
  if (focused?.measureInWindow === undefined) return done(null);
  focused.measureInWindow((_x, y) => done(y));
}
