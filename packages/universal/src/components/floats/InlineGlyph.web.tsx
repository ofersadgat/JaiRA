import { createElement, type JSX, type ReactNode } from "react";

/** The web half of `InlineGlyph.tsx`: an inline box in the line, placed by Chromium as an inline `<svg>` is. */
export function InlineGlyph({ size, drop = 0, after = 0, children }: { size: number; drop?: number; after?: number; children: ReactNode }): JSX.Element {
  return createElement("span", { style: { display: "inline-block", width: size, height: size, verticalAlign: -drop, marginRight: after, lineHeight: 0 } }, children);
}
