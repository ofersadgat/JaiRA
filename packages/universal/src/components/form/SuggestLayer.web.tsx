import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";
import { FLOATS } from "../MenuLayer.web";

/**
 * The web half of `SuggestLayer.tsx`: the box as it stands, and the popup in a fixed layer in `<body>`
 * that takes the pointer only where the popup is — out of every scroller and stacking context round the
 * box, as Electron's popup (a window of its own) is. Nothing wraps the box, so its layout is its own.
 */
export function SuggestLayer({ box, popup }: { box: ReactNode; popup: ReactNode | null; layout?: Record<string, unknown> }): JSX.Element {
  return (
    <>
      {box}
      {popup === null
        ? null
        : createPortal(
            <View style={{ position: "fixed" as never, top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000 }} pointerEvents="box-none">
              <View style={FLOATS as never}>{popup}</View>
            </View>,
            document.body,
          )}
    </>
  );
}

/** A phone's layer for the popup (`SuggestLayer.tsx`); on web each popup is portalled into `<body>` itself. */
export function SuggestHost(): null {
  return null;
}

/** On web the popup is placed in the window (`placeSuggestions`), from the box's rect. */
export const PLACED_IN_WINDOW = true;
