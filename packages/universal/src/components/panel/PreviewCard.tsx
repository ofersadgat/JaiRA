import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { PinnedValue } from "@jaira/ui/valuePanel";
import { Uncopied } from "../../app/Uncopied";
import { ValueView } from "./ValueView";

/**
 * `panelViews.tsx`'s `PreviewCard`, universal (decision 0015): a value on its own, in the panel — the one
 * value view (`ValueView`). A pinned SURFACE (`item.node`, a DOM element the desktop pins) has no
 * universal form, and is {@link Uncopied}.
 *
 *   .pv-preview      flex 1
 */
export function PreviewCard({ item }: { item: PinnedValue }): JSX.Element {
  if (item.node !== undefined) return <Uncopied name="a pinned surface" flex={1} />;
  return (
    <View flex={1} minHeight={0}>
      <ValueView value={item.value} {...(item.label !== undefined ? { label: item.label } : {})} />
    </View>
  );
}
