import type { JSX } from "react";
import { View } from "react-native";
import { forgeName } from "@jaira/ui/remoteStrip";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { BrandIcon } from "../settings/bits";

/**
 * `reviewNotes.tsx`'s `SourceMark`, universal (decision 0015): where a message was written, beside its
 * author — the forge's mark and name in a pill. The rules:
 *
 *   .note-src      inline-flex, centred, gap 4, 6 after the author, padding 1 6, round, 1px --line;
 *                  data 500 at --size-data × 10.5/12, line 1.5, --dim; its mark 10
 *
 * On a phone a `View` inside the line's `Text`; `SourceMark.web.tsx` is the inline box the DOM draws.
 */
export function SourceMark({ source }: { source: string }): JSX.Element {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: 6, paddingVertical: 1, paddingHorizontal: 6, borderRadius: 999, borderWidth: 1, borderColor: String(t.v("line")) }}>
      <BrandIcon name={source} size={10} ink="dim" />
      <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: "dim" }}>{forgeName(source)}</Txt>
    </View>
  );
}
