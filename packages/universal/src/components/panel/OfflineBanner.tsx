import type { JSX } from "react";
import { View } from "@tamagui/core";
import { ago, offlinePeerOf, useMachines } from "@jaira/ui/machinesModel";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { lengthOf } from "./SidePanel";

/**
 * At the foot of a conversation whose machine is away: that it is, since when, and that what is shown is
 * this machine's copy. Which machine, and whether it is away, is `machinesModel.ts`'s `offlinePeerOf`.
 * Nothing for this machine's own. It is a strip in the composer's band, as `RunActivity.tsx` draws one:
 *
 *   the band     padding 10 16 14, --bg
 *   the strip    row, centred, gap 9, padding 6 8 6 13, 1px --line, radius --card-radius, --panel, --dim
 *                at app 11.5/12.5, at most 900 wide, centred; the words ellipsed, then a spacer
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
        {/* The words in pieces — the label, then the rest — each shaped on its own, as the goldens have it. */}
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
