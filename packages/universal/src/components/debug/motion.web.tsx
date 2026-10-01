import type { JSX, ReactNode } from "react";

/**
 * `motion.tsx` on web: nothing moves. The desktop breathes a running call's dot and blinks the writing
 * caret with CSS animations, which a still picture holds at their first frame — the dot whole, the caret
 * shown — and the copy is drawn as that picture is.
 */
export function Breathing({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

export function Caret(): JSX.Element {
  return <>▍</>;
}
