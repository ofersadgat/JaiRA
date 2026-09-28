import type { JSX } from "react";
import { View } from "@tamagui/core";

/** One shape of a drawing: a path, a circle or a line, with its own paint where it differs. */
export type Shape =
  | { kind: "path"; d: string; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; dash?: string }
  | { kind: "circle"; cx: number; cy: number; r: number; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number };

export interface SvgProps {
  width: number;
  height: number;
  viewBox?: string;
  /** `currentColor`: the stroke, and a fill that says `currentColor`. */
  color?: string;
  fill?: string;
  strokeWidth?: number;
  linecap?: "round" | "butt" | "square";
  /** `round` (the icons) or the SVG default `miter` (the rail's curves say nothing, so they get it). */
  linejoin?: "round" | "miter";
  shapes: readonly Shape[];
  /** Box props for where the drawing stands (margins, alignment). */
  box?: Record<string, unknown>;
}

/**
 * A line drawing — the renderer's inline SVGs (`icons.tsx`'s `Icon`, the rail's caps), universal
 * (decision 0015). On web it is the `<svg>` itself (`Svg.web.tsx`), so it draws exactly as the DOM's
 * does. NATIVE has no SVG without `react-native-svg`, which is not a dependency yet: there it keeps the
 * drawing's box, empty, so everything around it lays out the same — adding `react-native-svg` to the
 * client and drawing `shapes` with it here is the whole of what is left.
 */
export function Svg({ width, height, box }: SvgProps): JSX.Element {
  return <View width={width} height={height} flexShrink={0} {...(box as object)} />;
}
