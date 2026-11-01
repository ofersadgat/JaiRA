import type { JSX } from "react";
import { View } from "@tamagui/core";
import { ValuePanelContext, type PinnedValue } from "@jaira/ui/valuePanel";
import { PublishedView, surfaceOf } from "./PublishedView";
import { ValueView } from "./ValueView";

/**
 * A value on its own, in the panel — the one value view (`ValueView`) — or a pinned SURFACE
 * (`item.node`), drawn as it came (the graph pins its `StatePanel`). A live artifact brought here brought
 * its grant (`serve`, `onPrompt`), and runs here too.
 *
 *   the card         flex 1
 *   a value          flex 1; the value owns the column (`ValueView`'s `pinned`)
 *   an artifact      flex 1; the whole of `PublishedView`, filling the panel. It goes back by the panel's
 *                    own ‹, as anything on the stack does
 */
export function PreviewCard({ item }: { item: PinnedValue }): JSX.Element {
  if (item.published !== undefined) {
    const { ref, project } = item.published;
    return (
      <View flex={1} minHeight={0}>
        {/* Already here, so it offers no way to come here (the provider is cleared). */}
        <ValuePanelContext.Provider value={null}>
          <PublishedView key={`${ref.id}@${String(ref.version)}`} published={ref} artifacts={surfaceOf(ref.taskId, project)} fill />
        </ValuePanelContext.Provider>
      </View>
    );
  }
  if (item.node !== undefined) {
    return (
      // A pinned surface: a column, clipped.
      <View flex={1} minHeight={0} overflow="hidden">
        {item.node}
      </View>
    );
  }
  return (
    <View flex={1} minHeight={0}>
      {/* The viewer inside has no panel to open itself in (the provider is cleared). */}
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
