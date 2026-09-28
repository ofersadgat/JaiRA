import type { JSX } from "react";
import NativeSvg, { Circle, Path } from "react-native-svg";
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
 * does; on a phone the same shapes through `react-native-svg`, with the same defaults: stroked in the
 * current colour, round caps and joins, no fill unless a shape asks.
 */
export function Svg({ width, height, viewBox = "0 0 24 24", color = "#000", fill = "none", strokeWidth = 1.7, linecap = "round", linejoin = "round", shapes, box }: SvgProps): JSX.Element {
  const paint = (value: string | undefined): string | undefined => (value === "currentColor" ? color : value);
  return (
    <View width={width} height={height} flexShrink={0} {...(box as object)}>
      <NativeSvg width={width} height={height} viewBox={viewBox} preserveAspectRatio="none" fill={paint(fill)} stroke={color} strokeWidth={strokeWidth} strokeLinecap={linecap} strokeLinejoin={linejoin}>
        {shapes.map((s, i) =>
          s.kind === "path" ? (
            <Path
              key={i}
              d={s.d}
              {...(s.fill !== undefined ? { fill: paint(s.fill) } : {})}
              {...(s.stroke !== undefined ? { stroke: paint(s.stroke) } : {})}
              {...(s.strokeWidth !== undefined ? { strokeWidth: s.strokeWidth } : {})}
              {...(s.opacity !== undefined ? { opacity: s.opacity } : {})}
              {...(s.dash !== undefined ? { strokeDasharray: s.dash } : {})}
            />
          ) : (
            <Circle
              key={i}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              {...(s.fill !== undefined ? { fill: paint(s.fill) } : {})}
              {...(s.stroke !== undefined ? { stroke: paint(s.stroke) } : {})}
              {...(s.strokeWidth !== undefined ? { strokeWidth: s.strokeWidth } : {})}
              {...(s.opacity !== undefined ? { opacity: s.opacity } : {})}
            />
          ),
        )}
      </NativeSvg>
    </View>
  );
}
