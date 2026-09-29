import type { JSX, ReactNode } from "react";

/**
 * Where a hover card is drawn: over everything, taking the pointer only where the card is, so what is
 * under the rest of it is still hovered. A phone has no hover (a card there opens on a press, in a
 * `MenuLayer`); the web half is `HoverLayer.web.tsx`.
 */
export function HoverLayer(_props: { children: ReactNode }): JSX.Element | null {
  return null;
}
