import type { JSX, ReactNode } from "react";

/**
 * Where a tooltip is drawn: over everything, taking no presses, so what is under it is still hovered.
 * A phone has no hover, and draws none; the web half is `TipLayer.web.tsx`.
 */
export function TipLayer(_props: { children: ReactNode }): JSX.Element | null {
  return null;
}
