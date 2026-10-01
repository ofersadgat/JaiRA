import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon, type IconName } from "../panel/Icon";
import { InlineGlyph } from "./InlineGlyph";

/** DM Sans' ascent and descent, as fractions of the size. */
const ASCENT = 0.992;
const DESCENT = 0.31;

/**
 * A dialog's heading (a modal's, an inline gate's): app 17/12.5 at 700 on a line of 1.35, --text, 8
 * below, with its glyph first — 16 square, --dim, 4 right, 2 below the baseline — then a space: the
 * glyph is a word of the heading, and a heading that wraps runs its second line under the glyph.
 *
 * On web the glyph is inline in the words, so Chromium places both. On a phone a `Text`
 * cannot hold a picture: the glyph stands in a row beside the words, its top where the baseline puts it
 * (half the leading plus the ascent into the line, less 14), and a second line starts beside it.
 */
export function GateTitle({ icon, children }: { icon?: IconName | undefined; children: string }): JSX.Element {
  const t = useTokens();
  const spec = { voice: "app", scale: 17 / 12.5, weight: 700, lineHeight: 1.35 } as const;
  if (isWeb) {
    return (
      <Txt spec={spec} marginBottom={8}>
        {icon !== undefined ? (
          <>
            <InlineGlyph size={16} drop={2} after={4}>
              <Icon name={icon} size={16} color={String(t.v("dim"))} />
            </InlineGlyph>{" "}
          </>
        ) : null}
        {children}
      </Txt>
    );
  }
  const size = Number(t.scaled("size-app", spec.scale)) || 17;
  const baseline = (1.35 * size - (ASCENT + DESCENT) * size) / 2 + ASCENT * size;
  return (
    <View flexDirection="row" alignItems="flex-start" marginBottom={8}>
      {icon !== undefined ? <Icon name={icon} size={16} color={String(t.v("dim"))} box={{ marginTop: baseline + 2 - 16, marginRight: 4 }} /> : null}
      {/* It shrinks from its own width, not grows from none: a dialog as wide as what is in it (the
          Components room's stage) asks its words how wide they are, and a basis of 0 answers "nothing" —
          the heading then wrapped inside whatever the buttons under it made the box. */}
      <Txt spec={spec} flexShrink={1} minWidth={0}>
        {icon !== undefined ? ` ${children}` : children}
      </Txt>
    </View>
  );
}
