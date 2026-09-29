import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";

/** The web half of `HoverLayer.tsx`: a fixed layer in `<body>` that passes the pointer through except to the card, as `.float` is. */
export function HoverLayer({ children }: { children: ReactNode }): JSX.Element {
  return createPortal(
    <View style={{ position: "fixed" as never, top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }} pointerEvents="box-none">
      {children}
    </View>,
    document.body,
  );
}
