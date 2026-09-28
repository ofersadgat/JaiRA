import { useMemo, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { CAP, MID, centresFor, forkPath, gutterWidth, joinPath, lanesOf, paletteOf, railOf, stacksOf, type RailLane, type RailRow, type RailStep } from "@jaira/ui/rail";
import { evaluate } from "../../cssTokens";
import { useTokens, type Tokens } from "../../tokens";
import { Svg, type Shape } from "./Svg";

/**
 * `railView.tsx`'s `RailedRows`, universal (decision 0015): the conversation with its hierarchy drawn
 * beside it — the same rows (`railOf`), the same spacing (`centresFor`) and the same curves
 * (`forkPath`, `joinPath`, `lobePath`), drawn with the universal `Svg`. What it does not carry yet: the
 * hover highlight, the fan of a squeezed gutter, folding a lane from its knot, placeholders and
 * breadcrumbs (`compact`) — and a stacked column is painted in its first lane's colour rather than
 * `stackPaint`'s stripes. The rules, from `styles.css`:
 *
 *   .rail            column, full width, at most 1052, centred (--rail-cap 34)
 *   .rail-row        row, stretch; .rail-turn is exactly one cap tall
 *   .rail-gut        as wide as its lanes (`gutterWidth`), relative
 *   .rail-seg        2 wide, top to bottom, at the lane's centre − 1, in the lane's colour
 *   .rail-cap        the row's curves, one cap tall: paths 2 wide, no fill; knots r 4.5 on --bg, 2 wide
 *   .rail-content    column, flex 1, centred, padding 7 0 7 10 (no top or bottom in a turn)
 */
export function RailedRows({ steps, renderStep, palette: given, wide = false }: { steps: readonly RailStep[]; renderStep: (index: number) => ReactNode; palette?: ReadonlyMap<string, string> | undefined; wide?: boolean }): JSX.Element {
  const t = useTokens();
  const { rows, deepest } = useMemo(() => railOf(steps), [steps]);
  const derived = useMemo(() => paletteOf(steps), [steps]);
  const palette = given ?? derived;
  const centres = useMemo(() => centresFor(deepest, false), [deepest]);
  const columns = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const group of stacksOf(centres)) for (const i of group) map.set(i, group);
    return map;
  }, [centres]);
  return (
    <View flexDirection="column" width="100%" maxWidth={wide ? 1472 : 1052} alignSelf="center" minWidth={0}>
      {rows.map((row) => (
        <View
          key={`${row.exit?.lane.key ?? ""}|${row.enter?.lane.key ?? ""}|${row.step ?? ""}`}
          flexDirection="row"
          alignItems="stretch"
          minWidth={0}
          {...(row.turn ? { height: CAP } : {})}
        >
          <Gutter row={row} centres={centres} columns={columns} palette={palette} t={t} />
          <View flex={1} minWidth={0} flexDirection="column" justifyContent="center" paddingTop={row.turn ? 0 : 7} paddingBottom={row.turn ? 0 : 7} paddingLeft={10}>
            {row.step === undefined ? null : renderStep(row.step)}
          </View>
        </View>
      ))}
    </View>
  );
}

/** A lane's colour: the trunk in --rule, every other lane its state's hue (`laneColour`). */
function laneColour(t: Tokens, lane: RailLane, root: boolean, palette: ReadonlyMap<string, string>): string {
  return cssColour(t, root ? "var(--rule)" : (palette.get(lane.stateId) ?? "var(--rule)"));
}

/**
 * A colour the stylesheet would resolve — `var(--rule)`, `hsl(208 var(--rail-s) var(--rail-l))` — as
 * the replayed tokens give it, in `rgb()`. On the desktop's page (not replayed) it is left to CSS.
 */
export function cssColour(t: Tokens, css: string): string {
  if (!t.replayed) return css;
  const value = String(evaluate(css, (name) => {
    const v = t.v(name);
    return v === "" ? undefined : v;
  }));
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i.exec(value);
  if (hsl === null) return value;
  const h = Number(hsl[1]) / 360;
  const s = Number(hsl[2]) / 100;
  const l = Number(hsl[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (x: number): number => {
    const k = x < 0 ? x + 1 : x > 1 ? x - 1 : x;
    const v = k < 1 / 6 ? p + (q - p) * 6 * k : k < 1 / 2 ? q : k < 2 / 3 ? p + (q - p) * (2 / 3 - k) * 6 : p;
    return Math.round(v * 255);
  };
  return `rgb(${channel(h + 1 / 3)}, ${channel(h)}, ${channel(h - 1 / 3)})`;
}

/** One row's gutter: the lanes crossing it, and the fork or join inside it (`RailGutter`). */
function Gutter({ row, centres, columns, palette, t }: { row: RailRow; centres: readonly number[]; columns: Map<number, number[]>; palette: ReadonlyMap<string, string>; t: Tokens }): JSX.Element {
  const width = gutterWidth(centres, lanesOf(row));
  const drawn = new Set<number>();
  const straights: JSX.Element[] = [];
  for (const [i, lane] of row.open.entries()) {
    const group = columns.get(i) ?? [i];
    const head = group[0]!;
    if (drawn.has(head)) continue;
    drawn.add(head);
    const mates = group.filter((j) => j < row.open.length);
    const centre = centres[head] ?? 0;
    straights.push(
      <View
        key={head}
        position="absolute"
        top={0}
        bottom={0}
        left={mates.length > 1 ? centre - 2 : centre - 1}
        width={mates.length > 1 ? 4 : 2}
        backgroundColor={laneColour(t, mates.length > 1 ? row.open[head]! : lane, head === 0, palette) as never}
      />,
    );
  }
  const shapes: Shape[] = [];
  const ground = cssColour(t, "var(--bg)");
  if (row.exit !== undefined) {
    shapes.push({ kind: "path", d: joinPath(centres, row.exit.depth, row.exit.depth - 1), stroke: laneColour(t, row.exit.lane, row.exit.depth === 0, palette), strokeWidth: 2 });
  }
  if (row.enter !== undefined) {
    const { lane, depth, root } = row.enter;
    const colour = laneColour(t, lane, root, palette);
    const cx = centres[root ? 0 : depth - 1] ?? 0;
    if (!root) shapes.push({ kind: "path", d: forkPath(centres, depth - 1, depth), stroke: colour, strokeWidth: 2 });
    shapes.push({ kind: "circle", cx, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 2 });
  }
  return (
    <View width={width} flexShrink={0} alignSelf="stretch" position="relative">
      {straights}
      {row.turn ? <Svg width={width} height={CAP} viewBox={`0 0 ${width} ${CAP}`} strokeWidth={2} linecap="butt" linejoin="miter" shapes={shapes} box={{ position: "absolute", top: 0, left: 0 }} /> : null}
    </View>
  );
}
