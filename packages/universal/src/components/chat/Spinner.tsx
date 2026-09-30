import type { JSX } from "react";
import { Svg } from "../panel/Svg";
import { Turn } from "../Turn";

/**
 * `icons.tsx`'s `Spinner`, universal (decision 0015): a faint ring and a quarter of it, stroked 2.6 on a
 * 24 grid in the colour given, turning (`.spinner`, 900ms a turn).
 */
export function Spinner({ size, color }: { size: number; color: string }): JSX.Element {
  return (
    <Turn>
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
    </Turn>
  );
}
