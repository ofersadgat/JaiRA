import type { JSX } from "react";
import { View } from "@tamagui/core";
import { settledByLines } from "@jaira/ui/remoteStrip";
import { Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";

/**
 * `remoteStripView.tsx`'s `SettledBy`, universal (decision 0015): how a gate answered on the forge says
 * so — nothing at all for one answered here. What it says is `remoteStrip.ts`'s (`settledByLines`). The
 * rules, from `styles.css`:
 *
 *   .gate-settled-by      row, at the top, gap 8, 8 above, padding 8 10, radius --control-radius;
 *                         --ok 9% into --panel, 1px --ok 35% into --line; app 12.5/12.5 on 1.5
 *   .gate-settled-by svg  14, --ok, flex none, 2 down
 *   ul                    4 above, 16 in, --dim; a disc per line (outside); `.warned` --warn
 */
export function SettledBy({ recorded }: { recorded: Record<string, unknown> }): JSX.Element | null {
  const t = useTokens();
  const said = settledByLines(recorded);
  if (said === undefined) return null;
  const words = { voice: "app", scale: 1 } as const;
  return (
    <View
      testID="gate-settled-by"
      flexDirection="row"
      alignItems="flex-start"
      gap={8}
      marginTop={8}
      paddingVertical={8}
      paddingHorizontal={10}
      borderRadius={lengthToken(t, "control-radius", 7) as never}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.mix(t.v("ok"), 35, t.v("line")) as never}
      backgroundColor={t.mix(t.v("ok"), 9, t.v("panel")) as never}
    >
      <View flexShrink={0} marginTop={2}>
        <Icon name="check" size={14} color={String(t.v("ok"))} />
      </View>
      <View flexShrink={1} minWidth={0}>
        <Txt spec={{ ...words, color: "text" }}>{said.head}</Txt>
        {said.lines.length === 0 ? null : (
          <View marginTop={4} paddingLeft={16}>
            {said.lines.map((line) => (
              <View key={line.text} position="relative">
                <Disc color={line.warned === true ? "warn" : "dim"} />
                <Txt spec={{ ...words, color: line.warned === true ? "warn" : "dim" }}>{line.text}</Txt>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * A `disc` marker, placed by Chromium's arithmetic as `Markdown.tsx`'s `Marker` places one: (⌊2A/3⌋ + 1) / 2
 * across, its right edge two-thirds of an em short of the text, ⌊3(A − ⌊2A/3⌋) / 2⌋ under the top of the
 * text (DM Sans: ascent 0.992 em, descent 0.31 em, each rounded).
 */
function Disc({ color }: { color: string }): JSX.Element {
  const t = useTokens();
  const size = Number(t.scaled("size-app", 1)) || 12.5;
  const ascent = Math.round(size * 0.992);
  const third = Math.floor((ascent * 2) / 3);
  const d = Math.floor((third + 1) / 2) > 0 ? Math.floor((third + 1) / 2) : 4;
  const textTop = (1.5 * size - (ascent + Math.round(size * 0.31))) / 2;
  return <View position="absolute" width={d} height={d} borderRadius={999} backgroundColor={t.v(color) as never} left={-(size * (2 / 3) + d)} top={textTop + Math.floor((3 * (ascent - third)) / 2)} />;
}
