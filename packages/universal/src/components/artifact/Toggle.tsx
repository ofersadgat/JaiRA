import type { JSX } from "react";
import { View } from "@tamagui/core";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * A ringed row of buttons, the one that is on at 600 on --fill-ghost-selected — the changeset
 * reviewer's Inline / Side by side, and `ImageDiff`'s Overlay / Side by side. How it looks:
 *
 *   the row             never shrinking, 1px --line, radius 6, clipped; stretched in a row that
 *                       stretches it, its buttons' words centred
 *   a button            padding 1 7, a --line on its left (not the first), app 10.5/12.5, --tok-hint;
 *                       hovered --text on --fill-ghost-hover; on, --text on --fill-ghost-selected, 600
 *
 * An option is `[id, words]`, or `[id, words, title]` for one with a tooltip.
 */
export function Toggle({ label, options, value, onPick }: { label: string; options: ReadonlyArray<readonly [string, string] | readonly [string, string, string]>; value: string; onPick: (next: string) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View role="group" aria-label={label} flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} overflow="hidden">
      {options.map(([id, words, title], i) => (
        // A `button` centres its words: stretched by its row (`ImageDiff`'s bar), they stay in the middle.
        <Press key={id} onPress={() => onPick(id)} {...(title !== undefined ? { title } : {})} {...({ "aria-pressed": id === value } as object)} justifyContent="center" paddingVertical={1} paddingHorizontal={7} {...(edge(t, { left: i === 0 ? 0 : 1 }) as object)} box={({ hovered }) => ({ backgroundColor: id === value ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}>
          {({ hovered }) => (
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: id === value ? 600 : 400, color: id === value || hovered ? "text" : "tok-hint" }} textAlign="center" numberOfLines={1}>
              {words}
            </Txt>
          )}
        </Press>
      ))}
    </View>
  );
}
