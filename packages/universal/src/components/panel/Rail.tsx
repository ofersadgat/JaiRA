import { useMemo, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { CAP, MID, bumpPath, centresFor, forkPath, gutterWidth, insideOf, joinPath, lanesOf, lobePath, paletteOf, railOf, stacksOf, type RailLane, type RailRow, type RailStep } from "@jaira/ui/rail";
import { hiddenExits, type DisplayItem, type VisibleRow } from "@jaira/ui/stepCompaction";
import { evaluate } from "../../cssTokens";
import { useTokens, type Tokens } from "../../tokens";
import { Svg, type Shape } from "./Svg";

/**
 * `railView.tsx`'s `RailedRows`, universal (decision 0015): the conversation with its hierarchy drawn
 * beside it — the same rows (`railOf`), the same spacing (`centresFor`) and the same curves
 * (`forkPath`, `joinPath`, `lobePath`, `bumpPath`), drawn with the universal `Svg`. It carries the
 * index's parts too (`runIndex.tsx`): a state's lobe (`mark`), the halo on the row the reader is on,
 * rolled-up lanes (`shut`, `renderRolled`) and the fitted rows' placeholders and breadcrumb (`compact`).
 * What it does not carry yet: the hover highlight and its name tip, the fan of a squeezed gutter, and
 * folding a lane by clicking its knot — and a stacked column is painted in its first lane's colour
 * rather than `stackPaint`'s stripes. The rules, from `styles.css`:
 *
 *   .rail            column, full width, at most 1052, centred (--rail-cap 34; .run-index 30, no cap)
 *   .rail-row        row, stretch; .rail-turn is exactly one cap tall
 *   .rail-gut        as wide as its lanes (`gutterWidth`), relative
 *   .rail-seg        2 wide, top to bottom, at the lane's centre − 1, in the lane's colour
 *   .rail-cap        the row's curves over the gutter, stretched to the row: paths 2 wide whatever the
 *                    stretch (non-scaling), no fill; knots r 4.5 on --bg, 2 wide; a lobe's knot r 3.5;
 *                    the halo r 7.5, 1.5 --accent; a placeholder's lane dots (2.5, round, 0 5)
 *   .rail-content    column, flex 1, centred, padding 7 0 7 10 (no top or bottom in a turn)
 */
export function RailedRows({
  steps,
  renderStep,
  palette: given,
  wide = false,
  cap = CAP,
  index = false,
  mark,
  here,
  shut,
  renderRolled,
  compact,
  renderGap,
  renderCrumb,
}: {
  steps: readonly RailStep[];
  renderStep: (index: number) => ReactNode;
  palette?: ReadonlyMap<string, string> | undefined;
  wide?: boolean;
  /** `--rail-cap`: 34 in a conversation, 30 in the run index. */
  cap?: number;
  /** `.rail.run-index`: no measure, the column's whole width. */
  index?: boolean;
  /** A step that opens a lane and closes it again in its own row, drawn as a lobe. */
  mark?: ((index: number) => RailLane | undefined) | undefined;
  /** Whether step `index` is the row the reader is on (its lobe gets the halo). */
  here?: ((index: number) => boolean) | undefined;
  /** Folded lanes. */
  shut?: ReadonlySet<string> | undefined;
  /** What a rolled-up lane says in place of its contents. */
  renderRolled?: ((lane: RailLane, held: number) => ReactNode) | undefined;
  /** Fit the rows to a height — see `stepCompaction.ts`. */
  compact?: ((visible: readonly VisibleRow[]) => DisplayItem[]) | undefined;
  renderGap?: ((item: Extract<DisplayItem, { kind: "gap" }>) => ReactNode) | undefined;
  renderCrumb?: ((item: Extract<DisplayItem, { kind: "crumb" }>) => ReactNode) | undefined;
}): JSX.Element {
  const t = useTokens();
  const { rows, deepest: reached } = useMemo(() => railOf(steps), [steps]);
  // A lobe reaches one column past the lanes open on its row, asked once over the whole run.
  const deepest = useMemo(
    () => (mark === undefined ? reached : rows.reduce((most, row) => (row.step !== undefined && mark(row.step) !== undefined ? Math.max(most, row.open.length + 1) : most), reached)),
    [rows, reached, mark],
  );
  const derived = useMemo(() => paletteOf(steps), [steps]);
  const palette = given ?? derived;
  const inside = useMemo(() => insideOf(rows), [rows]);
  const centres = useMemo(() => centresFor(deepest, false), [deepest]);
  const columns = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const group of stacksOf(centres)) for (const i of group) map.set(i, group);
    return map;
  }, [centres]);
  const folded = shut ?? NONE;
  const visible = useMemo(() => {
    const out: VisibleRow[] = [];
    for (const [i, row] of rows.entries()) {
      if (row.open.some((lane) => folded.has(lane.key))) continue;
      if (row.exit !== undefined && folded.has(row.exit.lane.key) && row.enter === undefined) continue;
      out.push({ row, index: i });
    }
    return out;
  }, [rows, folded]);
  const items = useMemo<DisplayItem[]>(() => (compact === undefined ? visible.map((one) => ({ kind: "row", index: one.index })) : compact(visible)), [compact, visible]);
  const elided = useMemo(() => hiddenExits(items, rows), [items, rows]);
  const content = (turn: boolean, children: ReactNode): JSX.Element => (
    <View flex={1} minWidth={0} flexDirection="column" justifyContent="center" paddingTop={turn ? 0 : 7} paddingBottom={turn ? 0 : 7} paddingLeft={10}>
      {children}
    </View>
  );
  return (
    <View flexDirection="column" width="100%" {...(index ? {} : { maxWidth: wide ? 1472 : 1052 })} alignSelf="center" minWidth={0}>
      {items.map((item) => {
        if (item.kind === "gap") {
          return (
            <View key={item.key} flexDirection="row" alignItems="stretch" minWidth={0} height={cap}>
              <GapGutter lanes={item.lanes} centres={centres} palette={palette} cap={cap} t={t} />
              {content(true, renderGap?.(item))}
            </View>
          );
        }
        if (item.kind === "crumb") {
          return (
            <View key={`crumb:${item.lanes.map((lane) => lane.key).join("|")}`} flexDirection="row" alignItems="stretch" minWidth={0} height={cap}>
              <CrumbGutter lanes={item.lanes} centres={centres} palette={palette} cap={cap} t={t} />
              {content(true, renderCrumb?.(item))}
            </View>
          );
        }
        const row = rows[item.index]!;
        const rolled = row.enter !== undefined && folded.has(row.enter.lane.key) ? row.enter.lane : undefined;
        const orphan = row.exit !== undefined && (folded.has(row.exit.lane.key) || elided.has(row.exit.lane.key));
        if (orphan && row.enter === undefined) return null;
        const lobe = row.step === undefined ? undefined : mark?.(row.step);
        const turn = row.turn || lobe !== undefined;
        return (
          <View key={`${row.exit?.lane.key ?? ""}|${row.enter?.lane.key ?? ""}|${row.step ?? ""}`} flexDirection="row" alignItems="stretch" minWidth={0} {...(turn ? { height: cap } : {})}>
            <Gutter
              row={row}
              centres={centres}
              columns={columns}
              palette={palette}
              t={t}
              cap={cap}
              folded={rolled !== undefined}
              {...(lobe !== undefined ? { mark: lobe } : {})}
              hideExit={orphan}
              here={row.step !== undefined && here?.(row.step) === true}
            />
            {content(turn, rolled !== undefined ? (renderRolled?.(rolled, inside.get(rolled.key) ?? 0) ?? null) : row.step === undefined ? null : renderStep(row.step))}
          </View>
        );
      })}
    </View>
  );
}

const NONE: ReadonlySet<string> = new Set();

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

/** A straight: 2 wide, top to bottom, at the lane's centre. */
function Straight({ left, colour, width = 2, top = 0 }: { left: number; colour: string; width?: number; top?: number }): JSX.Element {
  return <View position="absolute" top={top} bottom={0} left={left} width={width} backgroundColor={colour as never} />;
}

/**
 * `.rail-cap`: the row's curves over the gutter. `inset: 0` on an `<svg>` with no size of its own gives it
 * the gutter's width and its viewBox's aspect — so it is one conversation cap tall (34) whatever the row
 * is, and in the index's 30px rows it runs 4px into the next: drawn so here too.
 */
function Cap({ width, shapes }: { width: number; shapes: readonly Shape[] }): JSX.Element {
  return <Svg width={width} height={CAP} viewBox={`0 0 ${width} ${CAP}`} strokeWidth={2} linecap="butt" linejoin="miter" shapes={shapes} box={{ position: "absolute", top: 0, left: 0 }} />;
}

/** One row's gutter: the lanes crossing it, and the fork, join or lobe inside it (`RailGutter`). */
function Gutter({
  row,
  centres,
  columns,
  palette,
  t,
  cap,
  folded,
  mark,
  hideExit,
  here,
}: {
  row: RailRow;
  centres: readonly number[];
  columns: Map<number, number[]>;
  palette: ReadonlyMap<string, string>;
  t: Tokens;
  cap: number;
  folded: boolean;
  mark?: RailLane;
  hideExit: boolean;
  here: boolean;
}): JSX.Element {
  const width = gutterWidth(centres, Math.max(lanesOf(row), mark === undefined ? 0 : row.open.length + 1));
  const drawn = new Set<number>();
  const straights: JSX.Element[] = [];
  for (const [i, lane] of row.open.entries()) {
    const group = columns.get(i) ?? [i];
    const head = group[0]!;
    if (drawn.has(head)) continue;
    drawn.add(head);
    const mates = group.filter((j) => j < row.open.length);
    const centre = centres[head] ?? 0;
    straights.push(<Straight key={head} left={mates.length > 1 ? centre - 2 : centre - 1} width={mates.length > 1 ? 4 : 2} colour={laneColour(t, mates.length > 1 ? row.open[head]! : lane, head === 0, palette)} />);
  }
  const shapes: Shape[] = [];
  const ground = cssColour(t, "var(--bg)");
  if (mark !== undefined) {
    const depth = row.open.length;
    const colour = laneColour(t, mark, false, palette);
    const cx = centres[depth] ?? 0;
    shapes.push({ kind: "path", d: lobePath(centres, depth - 1, depth), stroke: colour, strokeWidth: 2, nonScaling: true });
    shapes.push({ kind: "circle", cx, cy: MID, r: 3.5, fill: ground, stroke: colour, strokeWidth: 2 });
    if (here) shapes.push({ kind: "circle", cx, cy: MID, r: 7.5, fill: "none", stroke: cssColour(t, "var(--accent)"), strokeWidth: 1.5 });
  }
  const exit = hideExit ? undefined : row.exit;
  if (exit !== undefined) shapes.push({ kind: "path", d: joinPath(centres, exit.depth, exit.depth - 1), stroke: laneColour(t, exit.lane, exit.depth === 0, palette), strokeWidth: 2, nonScaling: true });
  if (row.enter !== undefined) {
    const { lane, depth, root } = row.enter;
    const colour = laneColour(t, lane, root, palette);
    const cx = centres[root ? 0 : depth - 1] ?? 0;
    if (!root) shapes.push({ kind: "path", d: folded ? bumpPath(centres, depth - 1, depth) : forkPath(centres, depth - 1, depth), stroke: colour, strokeWidth: 2, nonScaling: true });
    shapes.push({ kind: "circle", cx, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 2 });
    if (folded) {
      // A folded state's knot is a STACK — two more rings behind it, fading.
      shapes.push({ kind: "circle", cx: cx + 6, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 1.5, opacity: 0.4 });
      shapes.push({ kind: "circle", cx: cx + 3, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 1.5, opacity: 0.7 });
      shapes.push({ kind: "circle", cx, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 2 });
    }
  }
  return (
    <View width={width} flexShrink={0} alignSelf="stretch" position="relative">
      {straights}
      {row.turn || mark !== undefined ? <Cap width={width} shapes={shapes} /> : null}
    </View>
  );
}

/** A placeholder's gutter (`RailGap`): the lanes straight, the innermost a column of dots. */
function GapGutter({ lanes, centres, palette, cap, t }: { lanes: readonly RailLane[]; centres: readonly number[]; palette: ReadonlyMap<string, string>; cap: number; t: Tokens }): JSX.Element {
  const width = gutterWidth(centres, Math.max(lanes.length, 1));
  const inner = lanes.length - 1;
  const x = centres[inner] ?? 0;
  return (
    <View width={width} flexShrink={0} alignSelf="stretch" position="relative">
      {lanes.slice(0, -1).map((lane, i) => (
        <Straight key={lane.key} left={(centres[i] ?? 0) - 1} colour={laneColour(t, lane, i === 0, palette)} />
      ))}
      {inner >= 0 ? <Cap width={width} shapes={[{ kind: "path", d: `M${x} 2 L${x} ${CAP - 2}`, stroke: laneColour(t, lanes[inner]!, inner === 0, palette), strokeWidth: 2.5, linecap: "round", dash: "0 5", nonScaling: true }]} /> : null}
    </View>
  );
}

/** The breadcrumb's gutter (`RailCrumb`): each folded parent a knot at mid-height, its lane running on down. */
function CrumbGutter({ lanes, centres, palette, cap, t }: { lanes: readonly RailLane[]; centres: readonly number[]; palette: ReadonlyMap<string, string>; cap: number; t: Tokens }): JSX.Element {
  const width = gutterWidth(centres, Math.max(lanes.length, 1));
  const ground = cssColour(t, "var(--bg)");
  return (
    <View width={width} flexShrink={0} alignSelf="stretch" position="relative">
      {lanes.map((lane, i) => (
        <Straight key={lane.key} left={(centres[i] ?? 0) - 1} top={MID} colour={laneColour(t, lane, i === 0, palette)} />
      ))}
      <Cap width={width} shapes={lanes.map((lane, i) => ({ kind: "circle" as const, cx: centres[i] ?? 0, cy: MID, r: i === lanes.length - 1 ? 4.5 : 3.2, fill: ground, stroke: laneColour(t, lane, i === 0, palette), strokeWidth: 2 }))} />
    </View>
  );
}
