import type { JSX } from "react";
import type { LiftProps } from "./Lift";

/**
 * `Lift` on web: nothing. The page drags as the desktop's does — the thing held is `draggable` and the
 * places it may land take `dragover` and `drop` (HTML5 drag), so it needs no wrapper; a wrapper would
 * put a box in the layout the DOM does not have. See `Lift.tsx` for a phone's.
 */
export function Lift({ children }: LiftProps): JSX.Element {
  return <>{children}</>;
}

export const HOLD = 350;
