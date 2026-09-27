import type { JSX } from "react";
import { Text, View, isWeb } from "@tamagui/core";
import type { PillSlotProps } from "@jaira/ui/slots";
import { useTokens } from "../tokens";

/**
 * `pill.tsx`'s `Pill`, universal (decision 0013, S3). Read that one for what a pill says; this one
 * only has to look the same. Every value below is the `.pill` rule in `styles.css`, line for line:
 *
 *   .pill          inline-flex, centred, gap 3, padding 1 6 1 5, radius 999, line-height 15px,
 *                  nowrap, flex none, data voice at 0.8 × --size-data, 600, tabular digits
 *   .pill-glyph    0.78 × --size-data, line-height 1
 *   .pill-<kind>   --pill-c: accent | warn | bad | warn | ok
 *   .pill-active   ground: --pill-c at 15% over transparent (running, waiting)
 *   .pill-status   no ground, padding 3 either side
 *
 * The two text runs are separate `Text`s because React Native has no text outside a `Text`; the DOM's
 * inline-flex already makes each run its own flex item, so the geometry is the same.
 */
const INK: Record<PillSlotProps["kind"], string> = {
  running: "accent",
  waiting: "warn",
  error: "bad",
  warning: "warn",
  success: "ok",
};

const GLYPH: Record<PillSlotProps["kind"], string> = {
  running: "▶",
  waiting: "⏸",
  error: "⛔",
  warning: "⚠",
  success: "✓",
};

export function Pill({ kind, n, word, title }: PillSlotProps): JSX.Element {
  const t = useTokens();
  const active = kind === "running" || kind === "waiting";
  const ink = t.v(INK[kind]);
  const run = {
    fontFamily: t.v("font-data"),
    fontSize: t.scaled("size-data", 0.8),
    fontWeight: "600",
    lineHeight: isWeb ? "15px" : 15,
    color: ink,
    ...(isWeb ? { whiteSpace: "nowrap", fontVariant: "tabular-nums" } : { fontVariant: ["tabular-nums"] }),
  } as object; // web values are CSS strings (`var(--x)`, `calc(…)`) that Tamagui's native-shaped types do not admit
  return (
    <View
      render="span"
      {...(isWeb && title !== undefined ? { title } : {})}
      display={isWeb ? ("inline-flex" as "flex") : "flex"}
      flexDirection="row"
      alignItems="center"
      gap={3}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={active ? 5 : 3}
      paddingRight={active ? 6 : 3}
      borderRadius={999}
      flexGrow={0}
      flexShrink={0}
      backgroundColor={(active ? t.tint(INK[kind], 15) : "transparent") as never}
    >
      <Text render="span" {...run} {...({ fontSize: t.scaled("size-data", 0.78), lineHeight: isWeb ? "1" : Number(t.scaled("size-data", 0.78)) } as object)}>
        {GLYPH[kind]}
      </Text>
      {word !== undefined ? (
        <Text render="span" {...run}>
          {word}
        </Text>
      ) : null}
      {n !== undefined ? (
        <Text render="span" {...run}>
          {n}
        </Text>
      ) : null}
    </View>
  );
}
