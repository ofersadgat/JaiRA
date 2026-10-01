import type { JSX, ReactNode } from "react";

/**
 * `motion.tsx` on web: nothing moves. A still picture holds no animation: the reference pictures have a
 * running call's dot whole and the writing caret shown, and the page is held to them (`pair.mts`).
 */
export function Breathing({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

export function Caret(): JSX.Element {
  return <>▍</>;
}
