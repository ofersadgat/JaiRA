import { createElement, type JSX } from "react";
import { View } from "@tamagui/core";
import type { SvgProps } from "./Svg";

export type { Shape, SvgProps } from "./Svg";

/** On web, the `<svg>` itself — see `Svg.tsx`; a shape's `filter` is its style. */
export function Svg({ width, height, viewBox = "0 0 24 24", color, fill = "none", strokeWidth = 1.7, linecap = "round", linejoin = "round", shapes, box }: SvgProps): JSX.Element {
  const drawn = createElement(
    "svg",
    {
      width,
      height,
      viewBox,
      fill,
      stroke: "currentColor",
      strokeWidth,
      strokeLinecap: linecap,
      strokeLinejoin: linejoin,
      preserveAspectRatio: "none",
      "aria-hidden": true,
      style: { display: "block", overflow: "visible", ...(color !== undefined ? { color } : {}) },
    },
    shapes.map((s, i) =>
      s.kind === "path"
        ? createElement("path", {
            key: i,
            d: s.d,
            ...(s.fill !== undefined ? { fill: s.fill } : {}),
            ...(s.stroke !== undefined ? { stroke: s.stroke } : {}),
            ...(s.strokeWidth !== undefined ? { strokeWidth: s.strokeWidth } : {}),
            ...(s.opacity !== undefined ? { opacity: s.opacity } : {}),
            ...(s.dash !== undefined ? { strokeDasharray: s.dash } : {}),
            ...(s.linecap !== undefined ? { strokeLinecap: s.linecap } : {}),
            ...(s.nonScaling === true ? { vectorEffect: "non-scaling-stroke" } : {}),
            ...(s.filter !== undefined ? { style: { filter: s.filter } } : {}),
          })
        : createElement("circle", {
            key: i,
            cx: s.cx,
            cy: s.cy,
            r: s.r,
            ...(s.fill !== undefined ? { fill: s.fill } : {}),
            ...(s.stroke !== undefined ? { stroke: s.stroke } : {}),
            ...(s.strokeWidth !== undefined ? { strokeWidth: s.strokeWidth } : {}),
            ...(s.opacity !== undefined ? { opacity: s.opacity } : {}),
            ...(s.filter !== undefined ? { style: { filter: s.filter } } : {}),
          }),
    ),
  );
  return (
    <View width={width} height={height} flexShrink={0} {...(box as object)}>
      {drawn}
    </View>
  );
}
