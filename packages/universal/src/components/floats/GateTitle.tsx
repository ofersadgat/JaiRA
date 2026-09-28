import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon, type IconName } from "../panel/Icon";

/** DM Sans' ascent and descent, as fractions of the size. */
const ASCENT = 0.992;
const DESCENT = 0.31;

/**
 * A dialog's heading (`.modal h3`, `.inline-gate h3`): app 17/12.5 at 700 on a line of 1.35, --text, 8
 * below, with its glyph first — `.gate-icon`, 16 square, --dim, 4 right, 2 below the baseline (`vertical-
 * align: -2px`), then a space: the DOM writes `<Icon/> words`, and a heading that wraps runs its second
 * line under the glyph.
 *
 * On web the glyph is inline in the words, as the DOM's is, so Chromium places both. On a phone a `Text`
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
            <View display={"inline-block" as never} width={16} height={16} marginRight={4} {...({ verticalAlign: -2 } as object)}>
              <Icon name={icon} size={16} color={String(t.v("dim"))} />
            </View>{" "}
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
      <Txt spec={spec} flex={1} minWidth={0}>
        {icon !== undefined ? ` ${children}` : children}
      </Txt>
    </View>
  );
}
