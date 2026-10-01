import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

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
