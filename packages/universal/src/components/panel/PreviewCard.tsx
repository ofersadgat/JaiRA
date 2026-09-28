import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { PinnedValue } from "@jaira/ui/valuePanel";
import { ValueView } from "./ValueView";

/**
 * `panelViews.tsx`'s `PreviewCard`, universal (decision 0015): a value on its own, in the panel — the one
 * value view (`ValueView`) — or a pinned SURFACE (`item.node`), drawn as it came, as the desktop draws
 * it. In the universal tree whoever pins one pins a universal node (the graph pins its `StatePanel`).
 *
 *   .pv-preview      flex 1
 */
export function PreviewCard({ item }: { item: PinnedValue }): JSX.Element {
  if (item.node !== undefined) {
    return (
      // `.pinned-surface`: a column, clipped.
      <View flex={1} minHeight={0} overflow="hidden">
        {item.node}
      </View>
    );
  }
  return (
    <View flex={1} minHeight={0}>
      <ValueView value={item.value} {...(item.label !== undefined ? { label: item.label } : {})} />
    </View>
  );
}
