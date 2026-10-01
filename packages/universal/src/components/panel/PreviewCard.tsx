import type { JSX } from "react";
import { View } from "@tamagui/core";
import { ValuePanelContext, type PinnedValue } from "@jaira/ui/valuePanel";
import { ValueView } from "./ValueView";

/**
 * `panelViews.tsx`'s `PreviewCard`, universal (decision 0015): a value on its own, in the panel — the one
 * value view (`ValueView`) — or a pinned SURFACE (`item.node`), drawn as it came, as the desktop draws
 * it. In the universal tree whoever pins one pins a universal node (the graph pins its `StatePanel`). A
 * live artifact brought here brought its grant (`serve`, `onPrompt`), and runs here too.
 *
 *   .pv-preview      flex 1
 *   .pinned-body     flex 1; the value owns the column (`ValueView`'s `pinned`)
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
      {/* The viewer inside has no panel to open itself in (the provider is cleared), as the desktop's. */}
      <ValuePanelContext.Provider value={null}>
        <ValueView
          value={item.value}
          pinned
          {...(item.hint !== undefined ? { hint: item.hint } : {})}
          {...(item.label !== undefined ? { label: item.label } : {})}
          {...(item.serve !== undefined ? { serve: item.serve } : {})}
          {...(item.onPrompt !== undefined ? { onPrompt: item.onPrompt } : {})}
        />
      </ValuePanelContext.Provider>
    </View>
  );
}
