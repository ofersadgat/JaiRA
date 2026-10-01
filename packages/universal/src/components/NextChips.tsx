import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { Text, View, isWeb } from "@tamagui/core";
import type { NextMove } from "@jaira/shared/browser";
import { faceOf } from "../primitives";
import { useTokens } from "../tokens";

/**
 * A card's NEXT TRANSITIONS (decision 0005): one chip per move the task's workflow defines out of where
 * it stands, each a legal move — pressing one takes it, as a drop on that column would. Each chip is a
 * `<button>` on web. How it looks:
 *
 *   a chip                              inline-flex, centred, nowrap, pointer; gap 3, padding 1 7 1 5, 1px
 *                                       --line, radius 999, --panel ground, --text ink, 500 at 10.5/12.5
 *                                       of --size-app, line-height 1.5
 *   hovered                             ground --panel-3, border and ink --accent
 *   a move a rule is waiting on         border accent 60% over --line, ground --tint-accent
 *   blocked                             --dim ink, dashed, half opacity, and no hover
 *   its arrow                           --accent (--dim when back or blocked), data voice
 *   the row of chips                    wrap, gap 4, margin 5 0 1; swallows clicks so the card is not selected
 */
export function NextChips({
  moves,
  onMove,
  tip,
  collapsesInto = 0,
}: {
  moves: readonly NextMove[];
  onMove: (move: NextMove) => void;
  tip: (move: NextMove, name: string) => string;
  /**
   * The top margin of what follows. The row's 1px bottom margin is to COLLAPSE into it, as block margins
   * do; a flex column adds the two instead, so the row keeps only what its own exceeds the other by.
   */
  collapsesInto?: number;
}): JSX.Element {
  const t = useTokens();
  const size = t.scaled("size-app", 10.5 / 12.5);
  const lineHeight = isWeb ? "1.5" : Number(size) * 1.5;
  const stop = isWeb ? { onClick: (e: ReactMouseEvent) => e.stopPropagation(), onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation() } : {};
  return (
    <View {...(stop as object)} flexDirection="row" flexWrap="wrap" gap={4} marginTop={5} marginBottom={Math.max(1, collapsesInto) - collapsesInto}>
      {moves.map((move) => {
        const name = move.label ?? move.path.at(-1) ?? move.target;
        const disabled = move.blocked !== undefined;
        const event = move.event === true;
        const arrowInk = move.way === "back" || disabled ? t.v("dim") : t.v("accent");
        const ink = disabled ? t.v("dim") : t.v("text");
        return (
          <View
            key={move.path.join("/")}
            render="button"
            {...((isWeb ? { type: "button", disabled, title: tip(move, name), onClick: () => onMove(move) } : { onPress: () => onMove(move), disabled }) as object)}
            display={isWeb ? ("inline-flex" as "flex") : "flex"}
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            gap={3}
            maxWidth="100%"
            minWidth={0}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={5}
            paddingRight={7}
            borderWidth={1}
            borderStyle={disabled ? "dashed" : "solid"}
            borderColor={(event ? t.mix(t.v("accent"), 60, t.v("line")) : t.v("line")) as never}
            borderRadius={999}
            backgroundColor={(event ? t.v("tint-accent") : t.v("panel")) as never}
            {...((disabled ? { opacity: 0.5 } : {}) as object)}
            {...((isWeb ? { cursor: disabled ? "default" : "pointer", style: { whiteSpace: "nowrap", color: ink } } : {}) as object)}
            {...((disabled ? {} : { hoverStyle: { backgroundColor: t.v("panel-3"), borderColor: t.v("accent"), ...(isWeb ? { color: t.v("accent") } : {}) } }) as object)}
          >
            <Text
              {...({ ...faceOf(t, "data", 500, size), fontSize: size, lineHeight, fontWeight: "500" } as object)}
              color={arrowInk as never}
              {...(isWeb ? { "aria-hidden": true } : {})}
            >
              {move.way === "back" ? "↩" : "→"}
            </Text>
            <Text
              {...({ ...faceOf(t, "app", 500, size), fontSize: size, lineHeight, fontWeight: "500" } as object)}
              {...((isWeb ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : { numberOfLines: 1 }) as object)}
              minWidth={0}
              // The name's ink is the chip's on web, inherited, so the chip's hover reaches it. Not
              // `group`/`$group-hover`: a Tamagui group is a size-contained container
              // (`container-type: inline-size`), and the chip then sizes as if it had no name.
              {...((isWeb ? {} : { color: ink }) as object)}
            >
              {name}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
