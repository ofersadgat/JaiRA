import type { JSX } from "react";
import { View } from "@tamagui/core";
import { ago, offlinePeerOf, useMachines } from "@jaira/ui/machinesModel";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { lengthOf } from "./SidePanel";

/**
 * `offline.tsx`'s `OfflineBanner`, universal (decision 0015): at the foot of a conversation whose machine
 * is away, that it is, since when, and that what is shown is this machine's copy. Which machine, and
 * whether it is away, is `machinesModel.ts`'s `offlinePeerOf`, shared. Nothing for this machine's own. The
 * rules (a `.run-doing` strip in its `.cx-doing`, as `RunActivity.tsx` draws one):
 *
 *   .cx-doing    padding 10 16 14, --bg
 *   .run-doing   row, centred, gap 9, padding 6 8 6 13, 1px --line, radius --card-radius, --panel, --dim
 *                at app 11.5/12.5, at most 900 wide, centred; the words `.ellip`, then a `.grow`
 */
export function OfflineBanner({ project }: { project: string | undefined }): JSX.Element | null {
  const t = useTokens();
  const [view] = useMachines();
  const peer = offlinePeerOf(view, project);
  if (peer === undefined) return null;
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  return (
    <View paddingTop={10} paddingHorizontal={16} paddingBottom={14} backgroundColor={t.v("bg") as never} flexShrink={0}>
      <View
        flexDirection="row"
        alignItems="center"
        gap={9}
        maxWidth={900}
        width="100%"
        alignSelf="center"
        paddingTop={6}
        paddingRight={8}
        paddingBottom={6}
        paddingLeft={13}
        borderWidth={1}
        borderStyle="solid"
        borderRadius={lengthOf(t, "card-radius", 10)}
        borderColor={t.v("line") as never}
        backgroundColor={t.v("panel") as never}
      >
        {/* The words as the JSX writes them — the label, then the rest — so each shapes as the DOM's. */}
        <Txt spec={words} ellip flexShrink={1} minWidth={0}>
          {peer.label}
          {" is offline · "}
          {ago(peer.lastSeenAt)}
          {". What it did until then is here."}
        </Txt>
        <View flex={1} minWidth={0} />
      </View>
    </View>
  );
}
