import type { JSX } from "react";
import { Svg } from "../panel/Svg";

/**
 * `icons.tsx`'s `Spinner`, universal (decision 0015): a faint ring and a quarter of it, stroked 2.6 on a
 * 24 grid in the colour given. Drawn still: the desktop turns it (`.spinner`, 900ms a turn), and the
 * pictures a copy is checked against are taken with animation off.
 */
export function Spinner({ size, color }: { size: number; color: string }): JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      color={color}
      strokeWidth={2.6}
      shapes={[
        { kind: "circle", cx: 12, cy: 12, r: 9, opacity: 0.25 },
        { kind: "path", d: "M21 12a9 9 0 0 0-9-9" },
      ]}
    />
  );
}
