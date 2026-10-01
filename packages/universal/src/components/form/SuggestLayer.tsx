import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";

/**
 * Where a box's suggestions are drawn. On a phone there is no layer over everything that leaves the
 * keyboard up (a `Modal` would take the focus from the box), so the popup hangs from the box itself:
 * absolute under it, over what follows — clipped by a scroller round the box, which the desktop's
 * window-sized popup never is. The box is wrapped for that, taking the layout it was given
 * (`layout`). The web half (`SuggestLayer.web.tsx`) portals the popup into `<body>` instead.
 */
export function SuggestLayer({ box, popup, layout }: { box: ReactNode; popup: ReactNode | null; layout?: Record<string, unknown> }): JSX.Element {
  return (
    <View position="relative" width="100%" minWidth={0} {...(popup !== null ? { zIndex: 1000 } : {})} {...(layout as object)}>
      {box}
      {popup === null ? null : (
        <View position="absolute" top="100%" left={0} zIndex={1000} {...({ elevation: 4 } as object)}>
          {popup}
        </View>
      )}
    </View>
  );
}

/** On a phone the popup hangs from the box, and is not placed in the window. */
export const PLACED_IN_WINDOW = false;
