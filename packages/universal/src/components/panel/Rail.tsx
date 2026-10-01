import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Pressable, type GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { CAP, MID, bumpPath, centresFor, forkPath, gutterWidth, insideOf, joinPath, lanesOf, lobePath, needsFan, paletteOf, railOf, stackPaint, stacksOf, type RailLane, type RailRow, type RailStep } from "@jaira/ui/rail";
import { hiddenExits, type DisplayItem, type VisibleRow } from "@jaira/ui/stepCompaction";
import { evaluate } from "../../cssTokens";
import { Txt } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { TipLayer } from "../floats/TipLayer";
import { Svg, type Shape } from "./Svg";

/**
 * `railView.tsx`'s `RailedRows`, universal (decision 0015): the conversation with its hierarchy drawn
 * beside it — the same rows (`railOf`), the same spacing (`centresFor`) and the same curves
 * (`forkPath`, `joinPath`, `lobePath`, `bumpPath`), drawn with the universal `Svg`. It carries the
 * index's parts too (`runIndex.tsx`): a state's lobe (`mark`), the halo on the row the reader is on,
 * rolled-up lanes (`shut`, `renderRolled`, else the standing `.rail-rolled` line) and the fitted rows'
 * placeholders and breadcrumb (`compact`); a stacked column is painted in `stackPaint`'s stripes.
 *
 * And the gutter's gestures. What is under the pointer is worked out from the geometry (`hitOf`), not
 * asked of the drawing, so a phone's press finds the same lane a mouse does: a knot or a line pressed
 * folds its lane (`foldable`, else `onPick`), and a right-click — a long press on a phone — is the
 * host's menu about it (`onContext`). On web the lane under the pointer is lit in every row it crosses,
 * its name follows the pointer (`.rail-tip`), and a squeezed gutter fans to full pitch while the
 * pointer is in it. As on the desktop, the pointer is handled once, on the rail, and what is lit is
 * what a click folds (the lanes move when the gutter fans: a fresh aim would fold whichever slid under
 * the pointer). The rows' contents are built once per change of the rows, so lighting and fanning
 * redraw the gutters and nothing else. The rules, from `styles.css`:
 *
 *   .rail            column, full width, at most 1052, centred (--rail-cap 34; .run-index 30, no cap)
 *   .rail-row        row, stretch; .rail-turn is exactly one cap tall
 *   .rail-gut        as wide as its lanes (`gutterWidth`), relative
 *   .rail-seg        2 wide, top to bottom, at the lane's centre − 1, in the lane's colour; its hit area
 *                    6 either side (`::after`); .rail-stack 4 wide, striped
 *   .rail-cap        the row's curves over the gutter, stretched to the row: paths 2 wide whatever the
 *                    stretch (non-scaling), no fill; knots r 4.5 on --bg, 2 wide; a lobe's knot r 3.5;
 *                    the halo r 7.5, 1.5 --accent; a placeholder's lane dots (2.5, round, 0 5); only
 *                    what is painted takes the pointer, and a knot's target (`.rail-hit`) is r 11 (9)
 *   .rail-lit        brightness(1.4) saturate(1.4)
 *   .rail-content    column, flex 1, centred, padding 7 0 7 10 (no top or bottom in a turn)
 *   .rail-rolled     row, centred, gap 9, app 11.5/12.5, --dim; the name 600 --text; the tag 10px,
 *                    0.07em, upper, padding 3 7, radius 3, --panel-2
 *   .rail-tip        a float at the pointer, translate(−50%, −150%): --text ground, --bg ink, data 11px
 *                    500 on a line of 1, padding 5 8, radius 5, one line
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
  shut: held,
  onShut,
  foldable,
  onPick,
  onContext,
  renderRolled,
  compact,
  renderGap,
  renderCrumb,
  rowClass,
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
  /** Folded lanes, controlled. Absent ⇒ the rail remembers them itself. */
  shut?: ReadonlySet<string> | undefined;
  onShut?: ((next: ReadonlySet<string>) => void) | undefined;
  /** Whether a lane can be folded at all. Absent ⇒ all of them can. */
  foldable?: ((key: string) => boolean) | undefined;
  /** A press on a lane `foldable` refused — a lane with nothing under it to fold. */
  onPick?: ((key: string) => void) | undefined;
  /** A right-click (a long press on a phone) on a lane in the gutter: its key and where the pointer was. */
  onContext?: ((key: string, point: { x: number; y: number }) => void) | undefined;
  /** What a rolled-up lane says in place of its contents. Absent ⇒ the standing `.rail-rolled` line. */
  renderRolled?: ((lane: RailLane, held: number) => ReactNode) | undefined;
  /** Fit the rows to a height — see `stepCompaction.ts`. */
  compact?: ((visible: readonly VisibleRow[]) => DisplayItem[]) | undefined;
  renderGap?: ((item: Extract<DisplayItem, { kind: "gap" }>) => ReactNode) | undefined;
  renderCrumb?: ((item: Extract<DisplayItem, { kind: "crumb" }>) => ReactNode) | undefined;
  /**
   * What a row is besides a row (`railView.tsx`'s `rowClass`): `is-cut` rings its knot in --bad (an armed
   * rewind), `doomed` fades it to .35 (`.rail-row.doomed`).
   */
  rowClass?: ((index: number) => string | undefined) | undefined;
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
  const [own, setOwn] = useState<ReadonlySet<string>>(NONE);
  const folded = held ?? own;
  const setShut = useCallback(
    (next: (was: ReadonlySet<string>) => ReadonlySet<string>): void => {
      if (held !== undefined && onShut !== undefined) onShut(next(held));
      else setOwn(next);
    },
    [held, onShut],
  );
  // Spread back to full pitch while the pointer is in a squeezed gutter — a property of the run's depth,
  // not of the centres drawn (asked of those it would un-fan itself).
  const [fan, setFan] = useState(false);
  const compressed = useMemo(() => needsFan(deepest), [deepest]);
  const centres = useMemo(() => centresFor(deepest, fan), [deepest, fan]);
  const columns = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const group of stacksOf(centres)) for (const i of group) map.set(i, group);
    return map;
  }, [centres]);
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

  // Each drawn row: what its gutter is (for `hitOf`) and what stands beside it — built when the rows
  // change, so lighting a lane or fanning the gutter re-renders the gutters and not the conversation.
  const drawn = useMemo(
    () =>
      items.map((item): Drawn | null => {
        if (item.kind === "gap") return { key: item.key, geo: { kind: "gap", lanes: item.lanes }, turn: true, content: renderGap?.(item) ?? null };
        if (item.kind === "crumb") return { key: `crumb:${item.lanes.map((lane) => lane.key).join("|")}`, geo: { kind: "crumb", lanes: item.lanes }, turn: true, content: renderCrumb?.(item) ?? null };
        const row = rows[item.index]!;
        const rolled = row.enter !== undefined && folded.has(row.enter.lane.key) ? row.enter.lane : undefined;
        const orphan = row.exit !== undefined && (folded.has(row.exit.lane.key) || elided.has(row.exit.lane.key));
        if (orphan && row.enter === undefined) return null;
        const lobe = row.step === undefined ? undefined : mark?.(row.step);
        const extra = row.step === undefined ? undefined : rowClass?.(row.step);
        const count = rolled === undefined ? 0 : (inside.get(rolled.key) ?? 0);
        return {
          key: `${row.exit?.lane.key ?? ""}|${row.enter?.lane.key ?? ""}|${row.step ?? ""}`,
          geo: { kind: "row", row, folded: rolled !== undefined, ...(lobe !== undefined ? { mark: lobe } : {}), hideExit: orphan },
          turn: row.turn || lobe !== undefined,
          here: row.step !== undefined && here?.(row.step) === true,
          cut: extra?.includes("is-cut") === true,
          doomed: extra?.includes("doomed") === true,
          content: rolled !== undefined ? (renderRolled !== undefined ? renderRolled(rolled, count) : <Rolled lane={rolled} held={count} />) : row.step === undefined ? null : renderStep(row.step),
        };
      }),
    [items, rows, folded, elided, mark, rowClass, here, inside, renderRolled, renderGap, renderCrumb, renderStep],
  );

  // The lane lit under the pointer, held by IDENTITY — what a click folds (see the header).
  const [hot, setHot] = useState<{ lane: string; stack: boolean } | null>(null);
  const tip = useRef<TipHandle | null>(null);
  const geoAt = (i: number): Geo | undefined => drawn[i]?.geo;

  /** Fold the lane, or hand it to `onPick` when it cannot be. */
  const press = (lane: string): void => {
    if (foldable !== undefined && !foldable(lane)) {
      onPick?.(lane);
      return;
    }
    setShut((was) => {
      const next = new Set(was);
      if (!next.delete(lane)) next.add(lane);
      return next;
    });
  };

  // Web: the pointer on the rail, handled once (`railView.tsx`'s container listeners). The gutter under
  // it is found in the page react-native-web draws, and the lane in its geometry.
  const pointed = (e: WebPointer): { hit: Hit | null; inGutter: boolean } => {
    const gut = (e.target as { closest?: (s: string) => Element | null } | null)?.closest?.("[data-rail-gut]") ?? null;
    if (gut === null) return { hit: null, inGutter: false };
    const geo = geoAt(Number(gut.getAttribute("data-rail-gut")));
    if (geo === undefined) return { hit: null, inGutter: true };
    const box = gut.getBoundingClientRect();
    return { hit: hitOf(geo, centres, columns, e.clientX - box.left, e.clientY - box.top), inGutter: true };
  };
  const web = isWeb
    ? {
        onPointerMove: (e: WebPointer) => {
          const { hit, inGutter } = pointed(e);
          tip.current?.show(hit === null ? null : { name: hit.name, x: e.clientX, y: e.clientY });
          const lane = hit?.lane ?? null;
          if (lane !== (hot?.lane ?? null)) setHot(lane === null ? null : { lane, stack: hit!.stack });
          setFan(inGutter && compressed);
        },
        onPointerLeave: (e: WebPointer & { currentTarget: { getBoundingClientRect: () => DOMRect } }) => {
          // A float laid over the page (a lane's menu) takes the pointer without it having left the rail:
          // the desktop's menu has no such layer, and keeps the lane lit and named under it.
          const box = e.currentTarget.getBoundingClientRect();
          if (e.clientX > box.left && e.clientX < box.right && e.clientY > box.top && e.clientY < box.bottom) return;
          setHot(null);
          tip.current?.show(null);
          setFan(false);
        },
        onClick: (e: WebPointer) => {
          // Still gated on the gutter: `hot` is stale once the pointer leaves without a move to clear it.
          if (!pointed(e).inGutter || hot === null || hot.stack) return;
          press(hot.lane);
        },
        ...(onContext !== undefined
          ? {
              onContextMenu: (e: WebPointer & { preventDefault: () => void }) => {
                const { hit, inGutter } = pointed(e);
                if (!inGutter || hit === null) return;
                e.preventDefault();
                onContext(hit.lane, { x: e.clientX, y: e.clientY });
              },
            }
          : {}),
      }
    : {};
  // A phone: a press on a gutter is on the lane under the finger — its knot or its line.
  const touch = isWeb
    ? undefined
    : {
        onPress: (geo: Geo, e: GestureResponderEvent) => {
          const hit = hitOf(geo, centres, columns, e.nativeEvent.locationX, e.nativeEvent.locationY);
          if (hit !== null && !hit.stack) press(hit.lane);
        },
        onLongPress: (geo: Geo, e: GestureResponderEvent) => {
          const hit = hitOf(geo, centres, columns, e.nativeEvent.locationX, e.nativeEvent.locationY);
          if (hit !== null && onContext !== undefined) onContext(hit.lane, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });
        },
      };

  const lit = hot?.lane ?? null;
  return (
    <View flexDirection="column" width="100%" {...(index ? {} : { maxWidth: wide ? 1472 : 1052 })} alignSelf="center" minWidth={0} {...(web as object)}>
      {drawn.map((one, i) => {
        if (one === null) return null;
        // On web the gutter says which row it is, for the rail's pointer; on a phone it is pressed itself,
        // and takes no touch of its own so the press is placed in its box.
        const gutter = <GutterOf geo={one.geo} centres={centres} columns={columns} palette={palette} t={t} lit={lit} here={one.here === true} cut={one.cut === true} box={isWeb ? { "data-rail-gut": String(i) } : { pointerEvents: "none" }} />;
        return (
          <View key={one.key} flexDirection="row" alignItems="stretch" minWidth={0} {...(one.turn ? { height: cap } : {})} {...(one.doomed === true ? { opacity: 0.35 } : {})}>
            {isWeb ? (
              gutter
            ) : (
              <Pressable onPress={(e) => touch?.onPress(one.geo, e)} onLongPress={(e) => touch?.onLongPress(one.geo, e)} style={{ flexShrink: 0, alignSelf: "stretch", flexDirection: "row" }}>
                {gutter}
              </Pressable>
            )}
            <View flex={1} minWidth={0} flexDirection="column" justifyContent="center" paddingTop={one.turn ? 0 : 7} paddingBottom={one.turn ? 0 : 7} paddingLeft={10}>
              {one.content}
            </View>
          </View>
        );
      })}
      {isWeb ? <RailTip ref={tip} /> : null}
    </View>
  );
}

const NONE: ReadonlySet<string> = new Set();

/** `.rail-seg.rail-lit` and its curves: the lane under the pointer, in every row it crosses. */
const LIT = "brightness(1.4) saturate(1.4)";

/** A row's gutter, as the hit test and the drawing both read it. */
type Geo =
  | { kind: "row"; row: RailRow; folded: boolean; mark?: RailLane; hideExit: boolean }
  | { kind: "gap"; lanes: readonly RailLane[] }
  | { kind: "crumb"; lanes: readonly RailLane[] };

interface Drawn {
  key: string;
  geo: Geo;
  turn: boolean;
  here?: boolean;
  cut?: boolean;
  doomed?: boolean;
  content: ReactNode;
}

type WebPointer = { target: unknown; clientX: number; clientY: number };

/** The lane under a point of a gutter, what `data-name` calls it, and whether it is a stacked column. */
interface Hit {
  lane: string;
  name: string;
  stack: boolean;
}

/**
 * What the desktop's `closest("[data-lane]")` finds at (`x`, `y`) in a gutter — the topmost painted
 * thing with a lane on it, in the DOM's paint order: the cap's pieces over the straights (only what the
 * cap paints takes the pointer), a knot's target over its knot over its curve, and a deeper straight
 * over a shallower one, each straight with its 6px of hit area either side.
 */
function hitOf(geo: Geo, centres: readonly number[], columns: Map<number, number[]>, x: number, y: number): Hit | null {
  const near = (cx: number, r: number): boolean => Math.hypot(x - cx, y - MID) <= r;
  const one = (lane: RailLane): Hit => ({ lane: lane.key, name: lane.stateId, stack: false });
  if (geo.kind === "crumb") {
    for (let i = geo.lanes.length - 1; i >= 0; i--) if (near(centres[i] ?? 0, (i === geo.lanes.length - 1 ? 4.5 : 3.2) + 1)) return one(geo.lanes[i]!);
    for (let i = geo.lanes.length - 1; i >= 0; i--) if (y >= MID && Math.abs(x - (centres[i] ?? 0)) <= 7) return one(geo.lanes[i]!);
    return null;
  }
  if (geo.kind === "gap") {
    for (let i = geo.lanes.length - 2; i >= 0; i--) if (Math.abs(x - (centres[i] ?? 0)) <= 7) return one(geo.lanes[i]!);
    return null;
  }
  const { row, mark } = geo;
  if (row.turn || mark !== undefined) {
    const enter = row.enter;
    if (enter !== undefined) {
      const cx = centres[enter.root ? 0 : enter.depth - 1] ?? 0;
      if (near(cx, 11)) return one(enter.lane);
      if (!enter.root && onStroke(geo.folded ? bumpPath(centres, enter.depth - 1, enter.depth) : forkPath(centres, enter.depth - 1, enter.depth), x, y)) return one(enter.lane);
    }
    const exit = geo.hideExit ? undefined : row.exit;
    if (exit !== undefined && onStroke(joinPath(centres, exit.depth, exit.depth - 1), x, y)) return one(exit.lane);
    if (mark !== undefined) {
      const depth = row.open.length;
      if (near(centres[depth] ?? 0, 9)) return one(mark);
      if (onStroke(lobePath(centres, depth - 1, depth), x, y)) return one(mark);
    }
  }
  const heads: number[] = [];
  for (const i of row.open.keys()) {
    const head = (columns.get(i) ?? [i])[0]!;
    if (!heads.includes(head)) heads.push(head);
  }
  for (let h = heads.length - 1; h >= 0; h--) {
    const head = heads[h]!;
    const mates = (columns.get(head) ?? [head]).filter((j) => j < row.open.length);
    const half = mates.length > 1 ? 2 : 1;
    if (Math.abs(x - (centres[head] ?? 0)) > half + 6) continue;
    if (mates.length > 1) return { lane: row.open[head]!.key, name: `${mates.length} lanes · ${mates.map((j) => row.open[j]!.stateId).join(" · ")}`, stack: true };
    return one(row.open[head]!);
  }
  return null;
}

/** Whether (`x`, `y`) is on a 2px stroke of a path made of `M`, `L` and `C` — the curve sampled finely. */
function onStroke(d: string, x: number, y: number): boolean {
  const tokens = d.match(/[MLC]|-?[\d.]+/g) ?? [];
  let at = 0;
  let cmd = "M";
  let px = 0;
  let py = 0;
  const num = (): number => Number(tokens[at++]);
  const close = (ax: number, ay: number, bx: number, by: number): boolean => {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const k = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len));
    return Math.hypot(x - (ax + k * dx), y - (ay + k * dy)) <= 1;
  };
  while (at < tokens.length) {
    if (/[MLC]/.test(tokens[at]!)) cmd = tokens[at++]!;
    if (cmd === "M") {
      px = num();
      py = num();
    } else if (cmd === "L") {
      const nx = num();
      const ny = num();
      if (close(px, py, nx, ny)) return true;
      px = nx;
      py = ny;
    } else {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      let lx = px;
      let ly = py;
      for (let i = 1; i <= 24; i++) {
        const s = i / 24;
        const u = 1 - s;
        const nx = u * u * u * px + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3;
        const ny = u * u * u * py + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3;
        if (close(lx, ly, nx, ny)) return true;
        lx = nx;
        ly = ny;
      }
      px = x3;
      py = y3;
    }
  }
  return false;
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

/** A straight: 2 wide, top to bottom, at the lane's centre. */
function Straight({ left, colour, width = 2, top = 0, lit = false }: { left: number; colour: string; width?: number; top?: number; lit?: boolean }): JSX.Element {
  return <View position="absolute" top={top} bottom={0} left={left} width={width} backgroundColor={colour as never} {...(isWeb ? ({ cursor: "pointer", ...(lit ? { filter: LIT } : {}) } as object) : {})} />;
}

/**
 * `.rail-seg.rail-stack`: several lanes sharing a column, striped in their colours — `stackPaint`'s
 * repeating gradient on web; on a phone, which has no gradients, the stripes are views laid down the
 * row once its height is known (9 of colour, 3 of nothing, lane after lane).
 */
function Stack({ left, colours, lit }: { left: number; colours: readonly string[]; lit: boolean }): JSX.Element {
  const [height, setHeight] = useState(0);
  if (isWeb) {
    const paint = /^(repeating-linear-gradient\(.*\)) 0 0 \/ 100% ([\d.]+)px$/.exec(stackPaint(colours));
    return (
      <View
        position="absolute"
        top={0}
        bottom={0}
        left={left}
        width={4}
        {...({ cursor: "pointer", backgroundImage: paint?.[1], backgroundSize: `100% ${paint?.[2] ?? 12}px`, backgroundPosition: "0px 0px", ...(lit ? { filter: LIT } : {}) } as object)}
      />
    );
  }
  const period = colours.length * 12;
  const stripes: JSX.Element[] = [];
  for (let at = 0; at < height; at += period) colours.forEach((colour, i) => stripes.push(<View key={`${at}:${i}`} position="absolute" left={0} width={4} top={at + i * 12} height={9} backgroundColor={colour as never} />));
  return (
    <View position="absolute" top={0} bottom={0} left={left} width={4} overflow="hidden" onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {stripes}
    </View>
  );
}

/**
 * `.rail-cap`: the row's curves over the gutter. `inset: 0` on an `<svg>` with no size of its own gives it
 * the gutter's width and its viewBox's aspect — so it is one conversation cap tall (34) whatever the row
 * is, and in the index's 30px rows it runs 4px into the next: drawn so here too.
 */
function Cap({ width, shapes }: { width: number; shapes: readonly Shape[] }): JSX.Element {
  return <Svg width={width} height={CAP} viewBox={`0 0 ${width} ${CAP}`} strokeWidth={2} linecap="butt" linejoin="miter" shapes={shapes} box={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }} />;
}

interface GutterProps {
  centres: readonly number[];
  columns: Map<number, number[]>;
  palette: ReadonlyMap<string, string>;
  t: Tokens;
  /** The lane lit under the pointer. */
  lit: string | null;
  /** Props for the gutter's own box — the web's row mark, a phone's pass-through. */
  box?: Record<string, unknown>;
}

function GutterOf({ geo, here, cut, ...rest }: GutterProps & { geo: Geo; here: boolean; cut: boolean }): JSX.Element {
  if (geo.kind === "gap") return <GapGutter lanes={geo.lanes} {...rest} />;
  if (geo.kind === "crumb") return <CrumbGutter lanes={geo.lanes} {...rest} />;
  return <Gutter row={geo.row} folded={geo.folded} {...(geo.mark !== undefined ? { mark: geo.mark } : {})} hideExit={geo.hideExit} here={here} cut={cut} {...rest} />;
}

/** One row's gutter: the lanes crossing it, and the fork, join or lobe inside it (`RailGutter`). */
function Gutter({
  row,
  centres,
  columns,
  palette,
  t,
  lit,
  box,
  folded,
  mark,
  hideExit,
  here,
  cut = false,
}: GutterProps & {
  row: RailRow;
  folded: boolean;
  mark?: RailLane;
  hideExit: boolean;
  here: boolean;
  /** An armed rewind cuts at this knot: the danger ring round it. */
  cut?: boolean;
}): JSX.Element {
  const width = gutterWidth(centres, Math.max(lanesOf(row), mark === undefined ? 0 : row.open.length + 1));
  const drawn = new Set<number>();
  const straights: JSX.Element[] = [];
  for (const [i, lane] of row.open.entries()) {
    const group = columns.get(i) ?? [i];
    const head = group[0]!;
    if (drawn.has(head)) continue;
    drawn.add(head);
    // Only the lanes open on THIS row: a column stacks by the run's depth, not this row's.
    const mates = group.filter((j) => j < row.open.length);
    const centre = centres[head] ?? 0;
    const on = lit !== null && row.open[head]!.key === lit;
    straights.push(
      mates.length > 1 ? (
        <Stack key={head} left={centre - 2} colours={mates.map((j) => laneColour(t, row.open[j]!, j === 0, palette))} lit={on} />
      ) : (
        <Straight key={head} left={centre - 1} colour={laneColour(t, lane, i === 0, palette)} lit={on} />
      ),
    );
  }
  const shine = (lane: RailLane): { filter?: string } => (lane.key === lit ? { filter: LIT } : {});
  const shapes: Shape[] = [];
  const ground = cssColour(t, "var(--bg)");
  if (mark !== undefined) {
    const depth = row.open.length;
    const colour = laneColour(t, mark, false, palette);
    const cx = centres[depth] ?? 0;
    shapes.push({ kind: "path", d: lobePath(centres, depth - 1, depth), stroke: colour, strokeWidth: 2, nonScaling: true, ...shine(mark) });
    shapes.push({ kind: "circle", cx, cy: MID, r: 3.5, fill: ground, stroke: colour, strokeWidth: 2, ...shine(mark) });
    if (here) shapes.push({ kind: "circle", cx, cy: MID, r: 7.5, fill: "none", stroke: cssColour(t, "var(--accent)"), strokeWidth: 1.5 });
  }
  const exit = hideExit ? undefined : row.exit;
  if (exit !== undefined) shapes.push({ kind: "path", d: joinPath(centres, exit.depth, exit.depth - 1), stroke: laneColour(t, exit.lane, exit.depth === 0, palette), strokeWidth: 2, nonScaling: true, ...shine(exit.lane) });
  if (row.enter !== undefined) {
    const { lane, depth, root } = row.enter;
    const colour = laneColour(t, lane, root, palette);
    const cx = centres[root ? 0 : depth - 1] ?? 0;
    if (!root) shapes.push({ kind: "path", d: folded ? bumpPath(centres, depth - 1, depth) : forkPath(centres, depth - 1, depth), stroke: colour, strokeWidth: 2, nonScaling: true, ...shine(lane) });
    shapes.push({ kind: "circle", cx, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 2, ...shine(lane) });
    if (folded) {
      // A folded state's knot is a STACK — two more rings behind it, fading.
      shapes.push({ kind: "circle", cx: cx + 6, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 1.5, opacity: 0.4 });
      shapes.push({ kind: "circle", cx: cx + 3, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 1.5, opacity: 0.7 });
      shapes.push({ kind: "circle", cx, cy: MID, r: 4.5, fill: ground, stroke: colour, strokeWidth: 2, ...shine(lane) });
    }
    if (cut) shapes.push({ kind: "circle", cx, cy: MID, r: 7.5, fill: "none", stroke: cssColour(t, "var(--bad)"), strokeWidth: 1.5 });
  }
  return (
    <View width={width} flexShrink={0} alignSelf="stretch" position="relative" {...(box as object)}>
      {straights}
      {row.turn || mark !== undefined ? <Cap width={width} shapes={shapes} /> : null}
    </View>
  );
}

/** A placeholder's gutter (`RailGap`): the lanes straight, the innermost a column of dots. */
function GapGutter({ lanes, centres, palette, t, lit, box }: GutterProps & { lanes: readonly RailLane[] }): JSX.Element {
  const width = gutterWidth(centres, Math.max(lanes.length, 1));
  const inner = lanes.length - 1;
  const x = centres[inner] ?? 0;
  return (
    <View width={width} flexShrink={0} alignSelf="stretch" position="relative" {...(box as object)}>
      {lanes.slice(0, -1).map((lane, i) => (
        <Straight key={lane.key} left={(centres[i] ?? 0) - 1} colour={laneColour(t, lane, i === 0, palette)} lit={lane.key === lit} />
      ))}
      {inner >= 0 ? <Cap width={width} shapes={[{ kind: "path", d: `M${x} 2 L${x} ${CAP - 2}`, stroke: laneColour(t, lanes[inner]!, inner === 0, palette), strokeWidth: 2.5, linecap: "round", dash: "0 5", nonScaling: true }]} /> : null}
    </View>
  );
}

/** The breadcrumb's gutter (`RailCrumb`): each folded parent a knot at mid-height, its lane running on down. */
function CrumbGutter({ lanes, centres, palette, t, lit, box }: GutterProps & { lanes: readonly RailLane[] }): JSX.Element {
  const width = gutterWidth(centres, Math.max(lanes.length, 1));
  const ground = cssColour(t, "var(--bg)");
  return (
    <View width={width} flexShrink={0} alignSelf="stretch" position="relative" {...(box as object)}>
      {lanes.map((lane, i) => (
        <Straight key={lane.key} left={(centres[i] ?? 0) - 1} top={MID} colour={laneColour(t, lane, i === 0, palette)} lit={lane.key === lit} />
      ))}
      <Cap
        width={width}
        shapes={lanes.map((lane, i) => ({ kind: "circle" as const, cx: centres[i] ?? 0, cy: MID, r: i === lanes.length - 1 ? 4.5 : 3.2, fill: ground, stroke: laneColour(t, lane, i === 0, palette), strokeWidth: 2, ...(lane.key === lit ? { filter: LIT } : {}) }))}
      />
    </View>
  );
}

/** `.rail-rolled`: what a rolled-up lane says in place of everything it holds — its name, the tag, the count. */
function Rolled({ lane, held }: { lane: RailLane; held: number }): JSX.Element {
  const t = useTokens();
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  return (
    <View flexDirection="row" alignItems="center" gap={9} minWidth={0}>
      <Txt spec={{ ...words, weight: 600, color: "text" }} flexShrink={0}>
        {lane.stateId}
      </Txt>
      <View flexShrink={0} paddingVertical={3} paddingHorizontal={7} borderRadius={3} backgroundColor={t.v("panel-2") as never}>
        <Txt spec={{ voice: "app", scale: 1, upper: true, color: "dim" }} fontSize={10} letterSpacing={0.7} lineHeight={t.replayed ? 15 : undefined} numberOfLines={1}>
          rolled up
        </Txt>
      </View>
      <Txt spec={words} minWidth={0}>
        {held}
        {" state"}
        {held === 1 ? "" : "s"}
      </Txt>
    </View>
  );
}

interface TipHandle {
  show: (at: { name: string; x: number; y: number } | null) => void;
}

/** `.rail-tip`: the lane's name, following the pointer, over everything (web; a phone has no pointer). */
const RailTip = forwardRef<TipHandle>(function RailTip(_props, ref) {
  const [at, setAt] = useState<{ name: string; x: number; y: number } | null>(null);
  useImperativeHandle(ref, () => ({ show: setAt }), []);
  if (at === null) return null;
  return (
    <TipLayer>
      <View position="absolute" left={at.x} top={at.y} {...({ transform: [{ translateX: "-50%" }, { translateY: "-150%" }] } as object)}>
        <TipBox name={at.name} />
      </View>
    </TipLayer>
  );
});

function TipBox({ name }: { name: string }): JSX.Element {
  const t = useTokens();
  return (
    <View paddingVertical={5} paddingHorizontal={8} borderRadius={5} backgroundColor={t.v("text") as never}>
      <Txt spec={{ voice: "data", scale: 1, weight: 500, color: "bg", lineHeight: { px: 11 } }} fontSize={11} numberOfLines={1} {...({ whiteSpace: "nowrap" } as object)}>
        {name}
      </Txt>
    </View>
  );
}
