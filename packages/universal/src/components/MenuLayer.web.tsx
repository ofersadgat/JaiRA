import { useEffect, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pressable, View } from "react-native";

/**
 * The web half of `MenuLayer.tsx`: a fixed layer in `<body>`, out of every stacking context and
 * `overflow` round the row it was opened from (the desktop's `Popover` does the same). Closed by a press
 * outside the menu, Escape, or the window resizing — the desktop menu's rules.
 */
export function MenuLayer({ onClose, children }: { onClose: () => void; children: ReactNode }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <View style={{ position: "fixed" as never, top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }}>
      <Pressable onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, cursor: "default" as never }} accessibilityLabel="close the menu" />
      {children}
    </View>,
    document.body,
  );
}
