import type { JSX, ReactNode } from "react";
import { Modal, Pressable } from "react-native";

/**
 * Where a menu is drawn: over everything, closed by a press anywhere outside it. On NATIVE a transparent
 * `Modal` — nothing else is drawn over the rest of the window, or gets the touches outside a row. On web,
 * `MenuLayer.web.tsx`: react-native-web's `Modal` took two to six seconds to put its portal on the page
 * (measured on `/rn`: the menu rendered at once and appeared seconds later), so the web half portals
 * into `<body>` itself, as the desktop's `Popover` does.
 */
export function MenuLayer({ onClose, children }: { onClose: () => void; children: ReactNode }): JSX.Element {
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} accessibilityLabel="close the menu" />
      {children}
    </Modal>
  );
}
