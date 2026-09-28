import type { JSX, ReactNode } from "react";
import { View } from "react-native";

/**
 * A picture inside a run of text, as the DOM's inline `<svg>` sits in a line: `size` square, its bottom
 * `drop` below the baseline (`vertical-align`), `after` of room before the next word. React Native lays a
 * `View` inside a `Text` out inline; the web half (`InlineGlyph.web.tsx`) is an inline box Chromium places.
 */
export function InlineGlyph({ size, drop = 0, after = 0, children }: { size: number; drop?: number; after?: number; children: ReactNode }): JSX.Element {
  return <View style={{ width: size, height: size, marginRight: after, transform: [{ translateY: drop }] }}>{children}</View>;
}
