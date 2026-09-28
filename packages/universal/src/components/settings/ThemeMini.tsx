import { useState, type JSX } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import { PALETTE_SURFACE, type BucketStyle, type JairaTheme, type Palette } from "@jaira/shared/browser";
import { COLUMNS, PALETTE_CARDS, type MiniColors } from "@jaira/ui/paletteCardsModel";
import { useTokens } from "../../tokens";

/**
 * `paletteCards.tsx`'s `ThemeMini`, universal (decision 0015): a palette's task board in miniature, in
 * one theme or split light | dark for `system` — every colour from `paletteCardsModel.ts`'s table, as
 * the DOM's are, and every box placed in percentages of the miniature as the DOM places its spans.
 *
 * Where the DOM needs CSS a phone has not got, the copy draws it: the blueprint's graph paper
 * (`linear-gradient` 8px squares) is its lines, and
 * `system`'s `clip-path` halves are two boxes that clip, 2px apart, measured from the miniature's width.
 */
export function ThemeMini({ palette, theme, ...box }: { palette: Palette; theme: JairaTheme | "system" } & Record<string, unknown>): JSX.Element {
  const card = PALETTE_CARDS[palette];
  const surface = PALETTE_SURFACE[palette];
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <View position="relative" overflow="hidden" aria-hidden {...box}>
      {/* The inside of the miniature's own border: what its percentages, and `system`'s halves, are of. */}
      <View position="absolute" left={0} top={0} right={0} bottom={0} onLayout={(e: LayoutChangeEvent) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} />
      {theme !== "system" ? (
        <Pane c={card[theme]} buckets={surface.buckets} lanes={surface.laneColors} size={size} />
      ) : size !== null ? (
        <>
          <View position="absolute" left={0} top={0} bottom={0} width={size.w / 2 - 1} overflow="hidden">
            <View position="absolute" left={0} top={0} width={size.w} height={size.h}>
              <Pane c={card.light} buckets={surface.buckets} lanes={surface.laneColors} size={size} />
            </View>
          </View>
          <View position="absolute" left={size.w / 2 + 1} top={0} bottom={0} right={0} overflow="hidden">
            <View position="absolute" left={-(size.w / 2 + 1)} top={0} width={size.w} height={size.h}>
              <Pane c={card.dark} buckets={surface.buckets} lanes={surface.laneColors} size={size} />
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

const pct = (n: number): string => `${n}%`;

/** One pane of a miniature: a whole board in one palette and theme. */
function Pane({ c, buckets, lanes, size }: { c: MiniColors; buckets: BucketStyle; lanes: boolean; size: { w: number; h: number } | null }): JSX.Element {
  const t = useTokens();
  const mix = (ink: string, n: number): string => t.mix(ink, n, "transparent");
  const line = buckets === "line";
  const tinted = lanes && c.lanes !== undefined;
  return (
    <View position="absolute" left={0} top={0} right={0} bottom={0} backgroundColor={c.bg as never}>
      {c.grid !== undefined && size !== null ? <Grid color={c.grid} w={size.w} h={size.h} /> : null}
      {/* The sidebar's edge is an inset shadow, as the DOM's is: a 1px border would be snapped to a whole device pixel, a shadow is not. */}
      <View position="absolute" left={0} top={0} bottom={0} width="21%" backgroundColor={c.chrome as never} {...({ boxShadow: `inset -1px 0 0 ${c.sideEdge ?? "transparent"}` } as object)} />
      {[22, 36, 50].map((top, i) => (
        <View
          key={top}
          position="absolute"
          left="3%"
          width="15%"
          top={pct(top)}
          height="8%"
          borderRadius={Math.min(c.r, 3)}
          backgroundColor={(i === 0 ? mix(c.accent, 40) : mix(c.chromeInk, 14)) as never}
        />
      ))}
      {COLUMNS.map((cards, col) => {
        const lane = tinted ? c.lanes![col]! : undefined;
        return (
          <View
            key={col}
            position="absolute"
            top="10%"
            bottom="8%"
            left={pct(25 + col * 25)}
            width="22%"
            borderRadius={c.r}
            {...(!line ? { backgroundColor: lane ?? c.track, borderWidth: 1, borderStyle: c.dash === true ? "dashed" : "solid", borderColor: c.edge } : {})}
          >
            {c.band === true && !line ? (
              <View position="absolute" left={0} right={0} top={0} height="15%" backgroundColor={c.ink as never}>
                <View position="absolute" left="8%" top="35%" width="45%" height="32%" borderRadius={1} backgroundColor={c.bg as never} />
              </View>
            ) : (
              <View position="absolute" left="8%" top="6%" width="45%" height="6%" borderRadius={1} backgroundColor={(tinted ? mix(c.accent, 60) : mix(c.ink, 45)) as never} />
            )}
            {line ? <View position="absolute" left={0} right={0} top="17%" height={2} backgroundColor={(lane ?? c.line ?? c.edge) as never} /> : null}
            {cards.map((mini, i) => {
              const status = mini.kind === "running" ? c.accent : mini.kind === "waiting" ? c.warn : mini.kind === "error" ? c.bad : mini.kind === "success" ? c.ok : null;
              const shadow = mini.selected === true ? `0 0 0 1.5px ${c.accent}` : c.hard === true ? `1.5px 1.5px 0 ${c.tileEdge}` : c.soft === true ? "0 1px 2px rgba(0, 0, 0, 0.12)" : undefined;
              return (
                <View
                  key={i}
                  position="absolute"
                  left="7%"
                  right="7%"
                  top={pct(22 + i * 32)}
                  height="26%"
                  borderRadius={Math.max(0, c.r - 1)}
                  backgroundColor={c.tile as never}
                  borderWidth={1}
                  borderStyle="solid"
                  borderColor={c.tileEdge as never}
                  {...(shadow !== undefined ? ({ boxShadow: shadow } as object) : {})}
                >
                  <View position="absolute" left="9%" top="32%" width="50%" height="22%" borderRadius={1} backgroundColor={mix(c.ink, 42) as never} />
                  {status !== null ? (
                    <View position="absolute" right="8%" top="24%" width="22%" height="40%" borderRadius={6} backgroundColor={mix(status, 26) as never}>
                      <View position="absolute" left="18%" top="28%" width="22%" height="44%" borderRadius={"50%" as never} backgroundColor={status as never} />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

/** The blueprint's graph paper: a 1px line along the top and the left of every 8px square. */
function Grid({ color, w, h }: { color: string; w: number; h: number }): JSX.Element {
  const rows = Array.from({ length: Math.ceil(h / 8) }, (_, i) => i * 8);
  const cols = Array.from({ length: Math.ceil(w / 8) }, (_, i) => i * 8);
  return (
    <>
      {rows.map((y) => (
        <View key={`r${y}`} position="absolute" left={0} right={0} top={y} height={1} backgroundColor={color as never} />
      ))}
      {cols.map((x) => (
        <View key={`c${x}`} position="absolute" top={0} bottom={0} left={x} width={1} backgroundColor={color as never} />
      ))}
    </>
  );
}
