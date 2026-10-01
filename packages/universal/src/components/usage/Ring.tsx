import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { UsageFigure } from "@jaira/ui/usageFigure";
import { Txt } from "../../primitives";
import type { Tokens } from "../../tokens";
import { Svg, type Shape } from "../panel/Svg";

/**
 * The usage ring (`Ring`) and its money form (`MoneyRing`) — the one ring the composer's figure, a
 * sign-in card's and an API key's box draw. How they look:
 *
 *   the ring          r 7 on a 20 grid (sm 12, md 16, lg 22); the track --dim 28%, 2.6 wide (sm 3.2);
 *                     the arc the tone's colour (`RING`), round-capped. With no figure the track
 *                     alone, dashed 2.2, 1.6 wide, --dim at .6.
 *   the money ring    18 square, r 7.6, 2.2 wide; a $ at app 700 9.5 on the grid (x 10, baseline
 *                     13.1) in the tone's colour (--dim for `none`)
 */

/** The colour a usage tone's number draws in, and its ring's. */
export const INK: Record<UsageFigure["tone"], string> = { accent: "text", warn: "warn", bad: "bad", none: "dim" };
export const RING: Record<UsageFigure["tone"], string> = { accent: "accent", warn: "warn", bad: "bad", none: "rule" };

/** A ring `pct` of the way round, in a tone; an empty dashed ring when there is no figure. */
export function Ring({ t, pct, tone, size, r = 7, width = 2.6 }: { t: Tokens; pct: number | null; tone: UsageFigure["tone"]; size: number; r?: number; width?: number }): JSX.Element {
  const shapes: Shape[] =
    pct === null
      ? [{ kind: "path", d: circleOf(r), dash: "2.2 2.2", stroke: String(t.v("dim")), strokeWidth: 1.6, opacity: 0.6 }]
      : [{ kind: "circle", cx: 10, cy: 10, r, stroke: String(t.mix(t.v("dim"), 28, "transparent")), strokeWidth: width }, ...arcOf(Math.max(0, Math.min(100, pct)), String(t.v(RING[tone])), r, width)];
  // Butt ends for the track (its dashes would grow by half a stroke each way rounded);
  // the arc's round ends are dots of their own (`arcOf`).
  return <Svg width={size} height={size} viewBox="0 0 20 20" color={String(t.v("dim"))} strokeWidth={width} linecap="butt" shapes={shapes} />;
}

/** `MoneyRing`: the same ring for money, a $ inside. */
export function MoneyRing({ t, pct, tone }: { t: Tokens; pct: number | null; tone: UsageFigure["tone"] }): JSX.Element {
  const k = 18 / 20;
  const size = 9.5 * k;
  return (
    <View width={18} height={18} flexShrink={0} position="relative">
      <Ring t={t} pct={pct} tone={tone} size={18} r={7.6} width={2.2} />
      {/* The $ on its baseline at 13.1 of the grid: a line of the font's own size, its baseline ~0.94 down. */}
      <View position="absolute" left={0} right={0} top={13.1 * k - size * 0.94} alignItems="center">
        <Txt spec={{ voice: "app", scale: 1, weight: 700, color: tone === "none" ? "dim" : RING[tone], lineHeight: { px: size } }} fontSize={size} textAlign="center">
          $
        </Txt>
      </View>
    </View>
  );
}

/** The track as a path, so a dash can be laid on it (a circle about 10,10, from the right, as SVG's circle starts). */
function circleOf(r: number): string {
  return `M${10 + r} 10a${r} ${r} 0 1 1-${2 * r} 0a${r} ${r} 0 1 1 ${2 * r} 0`;
}

/** The arc `pct` of the way round from the top, clockwise. */
function arcOf(pct: number, stroke: string, r: number, width: number): Shape[] {
  if (pct <= 0) return [];
  if (pct >= 100) return [{ kind: "path", d: `M10 ${10 - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0-${2 * r}`, stroke, strokeWidth: width }];
  const a = (pct / 100) * 2 * Math.PI;
  const x = 10 + r * Math.sin(a);
  const y = 10 - r * Math.cos(a);
  // `stroke-linecap: round`: a dot of half the stroke at each end.
  const cap = (cx: number, cy: number): Shape => ({ kind: "circle", cx, cy, r: width / 2, fill: stroke, strokeWidth: 0 });
  return [{ kind: "path", d: `M10 ${10 - r}A${r} ${r} 0 ${pct > 50 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}`, stroke, strokeWidth: width }, cap(10, 10 - r), cap(x, y)];
}
