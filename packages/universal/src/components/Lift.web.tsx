import type { JSX } from "react";
import type { LiftProps } from "./Lift";

/**
 * `Lift` on web: nothing. The page drags by HTML5 drag — the thing held is `draggable` and the places it
 * may land take `dragover` and `drop` — so it needs no wrapper, and a wrapper would put a box in the
 * layout that nothing there accounts for. See `Lift.tsx` for a phone's.
 */
export function Lift({ children }: LiftProps): JSX.Element {
  return <>{children}</>;
}

export const HOLD = 350;
