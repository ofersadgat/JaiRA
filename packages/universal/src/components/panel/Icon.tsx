import type { JSX } from "react";
import { PATHS } from "@jaira/ui/iconPaths";
import { Svg } from "./Svg";

export type IconName = keyof typeof PATHS;

/**
 * An icon: `iconPaths.ts`'s path data, stroked with the colour given at 1.7 on a 24 grid, at `size`
 * (each caller states its own). Brand marks are filled.
 */
export function Icon({ name, size, color, box }: { name: IconName; size: number; color?: string; box?: Record<string, unknown> }): JSX.Element {
  const brand = name === "anthropic" || name === "openai";
  return (
    <Svg
      width={size}
      height={size}
      {...(color !== undefined ? { color } : {})}
      fill={brand ? "currentColor" : "none"}
      strokeWidth={brand ? 0 : 1.7}
      shapes={PATHS[name].map((d) => ({ kind: "path" as const, d }))}
      {...(box !== undefined ? { box } : {})}
    />
  );
}
