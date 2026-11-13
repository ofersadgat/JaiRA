import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { Place } from "@jaira/ui/splitModel";
import { Press, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon, type IconName } from "./Icon";
import { colourOr, lengthOf } from "./SidePanel";

/** Each place's glyph and name (decision 0025): the window it puts the thing in. */
const PLACE: Record<Place, { icon: IconName; label: string }> = {
  main: { icon: "placeMain", label: "Open in the main view" },
  split: { icon: "placeSplit", label: "Open in a split" },
  panel: { icon: "placePanel", label: "Open in the side panel" },
};

/**
 * The three places as one group (decision 0025, the person's board 02): Main view, Split, Side panel —
 * on an artifact's card in the conversation, and in the head of wherever it is shown, the place it is in
 * lit. Pressing another moves it there. Which are offered is the caller's (no split on a phone, no
 * panel in a room without one), and so is what a press does. How it looks:
 *
 *   the group      row, gap 1, padding 1, 1px --line, radius 7, on --panel
 *   a button       26 wide, 24 tall, radius 5 (--control-radius-sm); the glyph 15, --dim. Hovered:
 *                  --fill-ghost-hover, --text. Lit: --accent on --tint-accent, `aria-pressed`
 */
export function PlaceButtons({ offered, lit, onPlace }: { offered: readonly Place[]; lit: readonly Place[]; onPlace: (place: Place) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View role="group" aria-label="Where to show it" flexDirection="row" gap={1} padding={1} flexShrink={0} borderRadius={7} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      {offered.map((place) => {
        const on = lit.includes(place);
        const { icon, label } = PLACE[place];
        return (
          <Press
            key={place}
            onPress={() => onPlace(place)}
            label={label}
            title={label}
            {...({ "aria-pressed": on } as object)}
            width={26}
            height={24}
            alignItems="center"
            justifyContent="center"
            borderRadius={lengthOf(t, "control-radius-sm", 5)}
            box={({ hovered }) => (on ? { backgroundColor: colourOr(t, "tint-accent", "fill-ghost-selected") } : hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}
          >
            {({ hovered }) => <Icon name={icon} size={15} color={String(on ? t.v("accent") : hovered ? t.v("text") : t.v("dim"))} />}
          </Press>
        );
      })}
    </View>
  );
}
