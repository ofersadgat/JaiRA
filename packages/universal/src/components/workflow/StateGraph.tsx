import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { PixelRatio, View as RNView, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { ExecutorInfo, FileTree, StateSlots, ValidateSchemaResult, WorkflowLayer, WorkflowSource } from "@jaira/shared/browser";
import type { UiSurface } from "@jaira/ui/fileTypes";
import { push } from "@jaira/ui/panelStack";
import {
  focusOf,
  graphOf,
  idOf,
  layoutOf,
  samples,
  unconditional,
  type Focus,
  type GraphChip,
  type GraphEdge,
  type GraphPort,
  type PlacedEdge,
  type PlacedNode,
  type PlacedWire,
} from "@jaira/ui/stateGraph";
import {
  GESTURES,
  MAX_ZOOM,
  MIN_ZOOM,
  SLOP,
  WORDS_OF_OURS,
  ZOOM_STEP,
  askAbout,
  edgeTitle,
  fitOf,
  frameTitle,
  headOf,
  hint,
  legendOf,
  markerTitle,
  nodeSessionTitle,
  paintOrder,
  portTitle,
  shownNames,
  sightlines,
  tierOf,
  zoomedAt,
  type Attention,
  type Camera,
  type LegendKey,
  type Tier,
} from "@jaira/ui/stateGraphViewModel";
import { NO_STACK, Press, Txt, edge, lengthToken, type FontSpec } from "../../primitives";
import { TokenScope, useLook, useTokens, type Tokens } from "../../tokens";
import { panelOnStack } from "../panel/panelBridge";
import { Svg, type Shape } from "../panel/Svg";
import { Reason, Sub, hairline } from "./controls";
import { StatePanel } from "./StatePanel";
import { Chip, SegTabs } from "./WorkflowEditor";

/**
 * `stateGraphView.tsx`, universal (decision 0015): the graph tab — the state's children as boxes, the
 * values between them as wires and its moves as arrows, on a map you pan and zoom — drawn NATIVELY:
 * the boxes are views and the lines `react-native-svg` paths (`components/panel/Svg.tsx`). What the
 * picture says is `stateGraph.ts`'s (the graph, its layout and the attention model) and
 * `stateGraphViewModel.ts`'s (the camera, the tiers, the pills at the pane's edge), the desktop's own.
 * An arrowhead is drawn as its own filled path where the desktop's `<marker>` puts it (`orient="auto"`,
 * sized by the stroke), and pointing at a line is found by distance to it, since a stroke is not a
 * target. The rules (`styles.css` `.sg*`, in the `.sg` token scope):
 *
 *   .sg               column, the rest, gap 6
 *   .sg-bar           the bar, wrapping, gap 10; `.sg-key` app 11/12.5 --dim, gap 5, its swatch 20 × 2
 *   .sg-map           the rest, clipped, --bg, 1px --line, radius --card-radius
 *   .sg-canvas        absolutely at 0 0, scaled from its corner
 *   .sg-frame         a 2px dashed --rule, radius 10, --dim 7%, padding 3 10; its name app 11, scope 10
 *   .sg-flow          --wire-idle 1.7 round at 0.62; expr dashed 7 4, produced/guard 1.5 4 (a guard
 *                     1.5 at 0.35); `.sg-step` 2 in --go-onward/back/abort, `state` dashed 7 5, the
 *                     sequence --go-spine 2.5, nowait 2 5; lit 3.2 at 1, near 0.6, dim 0.07
 *   .sg-node          padding 9 10, --panel, 1px --line, radius --card-radius (entry --panel-2, exit
 *                     --tint-ok, operation --rule on --tint-accent, aside/any dashed on nothing,
 *                     outcome/missing --go-abort on --tint-bad); lit --accent and --lift, near 0.45,
 *                     dim 0.12
 *   .sg-title 20, .sg-subtitle 15, .sg-node-session / .sg-row / .sg-port 17, .sg-node-chips 21 tall
 *   .sg-port          row (out reversed), gap 5, radius 4; its dot 8 round, 1.5 --rule on --panel with a
 *                     2px --panel ring, 15 out past the box's edge (lit 1.35 ×)
 *   .sg-label         translated to its centre, at most 460, padding 6 8, --panel, 1px --go-* with a
 *                     3px left, radius --control-radius, data × 0.86 on a 15 line
 *   .sg-edge-mark     a pill at the pane's edge: 22 tall, padding 1 8, --panel, 1px --line, round,
 *                     --lift, gap 6, at most 56% wide; its names data-text, `+`-separated by a --line
 */

// --- colour ---------------------------------------------------------------------------

/** `oklab(L a b)` in sRGB, clipped. */
function oklab(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const C = Math.hypot(a, b);
  const H = (Math.atan2(b, a) * 180) / Math.PI;
  return oklch(L, C, H);
}

/** Whether a device pixel of `[x0, x1]` is on a dash of `5px on, 4px off` — a gradient's hard stop is sampled at the pixel's centre. */
function dashCover(x0: number, x1: number): number {
  return ((x0 + x1) / 2) % 9 < 5 ? 1 : 0;
}

/**
 * A 20 × 2 swatch painted a device pixel at a time — what a CSS gradient comes to — so its stops fall where
 * the desktop's do at any pixel ratio.
 */
function Strip({ paint, radius }: { paint: (x0: number, x1: number) => { color: string; alpha: number }; radius: number }): JSX.Element {
  const ratio = PixelRatio.get();
  const n = Math.round(20 * ratio);
  return (
    <View width={20} height={2} flexDirection="row" borderRadius={radius} overflow="hidden">
      {Array.from({ length: n }, (_, i) => {
        const x0 = i / ratio;
        const x1 = Math.min(20, (i + 1) / ratio);
        const { color, alpha } = paint(x0, x1);
        return <View key={i} width={x1 - x0} height={2} backgroundColor={color as never} opacity={alpha} />;
      })}
    </View>
  );
}

/** `oklch(L C H)` in sRGB, clipped — what Chromium draws for a wire's hue. `L` 0–1. */
function oklch(L: number, C: number, H: number): { r: number; g: number; b: number } {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const [r, g, bb] = lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  }) as [number, number, number];
  return { r, g, b: bb };
}
const rgb = (c: { r: number; g: number; b: number }): string => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
const pct = (v: string | number): number => (typeof v === "number" ? v : String(v).trim().endsWith("%") ? parseFloat(String(v)) / 100 : parseFloat(String(v)));

/** The drawing's inks, from the `.sg` scope: a value's colour by hue, the idle grey and the moves'. */
interface Inks {
  hue: (h: number) => string;
  idle: string;
  go: Record<"spine" | "onward" | "back" | "abort", string>;
}
function inksOf(t: Tokens): Inks {
  const go = { spine: String(t.v("go-spine")), onward: String(t.v("go-onward")), back: String(t.v("go-back")), abort: String(t.v("go-abort")) };
  if (!t.replayed) return { hue: (h) => `oklch(var(--wire-l) var(--wire-c) ${h})`, idle: "var(--wire-idle)", go };
  const L = pct(t.v("wire-l"));
  const C = pct(t.v("wire-c"));
  return { hue: (h) => rgb(oklch(L, C, h)), idle: rgb(oklch(L, 0, 0)), go };
}

// --- the drawing's pieces ----------------------------------------------------------------

const DATA_TEXT: FontSpec = { voice: "data", scale: 0.96, ls: -0.01, color: "text" };
const DATA_SECONDARY: FontSpec = { voice: "data", scale: 0.84, color: "dim" };
const DATA_FAINT: FontSpec = { voice: "data", scale: 0.84, color: "tok-hint" };
const tierOpacity = (tier: Tier, lit: number, near: number, dim: number, rest = 1): number => (tier === "lit" ? lit : tier === "near" ? near : tier === "dim" ? dim : rest);

/** A web tooltip on a box. */
const tip = (title: string | undefined): Record<string, unknown> => (isWeb && title !== undefined ? { title } : {});
/** Hover handlers on web (a phone has no pointer). */
const hover = (enter: () => void, leave: () => void): Record<string, unknown> => (isWeb ? { onMouseEnter: enter, onMouseLeave: leave } : {});

/** One legend entry's swatch, 20 × 2 (the session's 20 × 11 frame). */
function Swatch({ kind, inks }: { kind: LegendKey["swatch"]; inks: Inks }): JSX.Element {
  const t = useTokens();
  if (kind === "session") {
    return <View width={20} height={11} borderRadius={3} backgroundColor={t.tint("dim", 7) as never} {...(edge(t, { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, "rule", "dashed") as object)} />;
  }
  if (kind === "any") {
    // `repeating-linear-gradient(90deg, onward 0 5px, transparent 5px 9px)`, a device pixel at a time.
    return <Strip radius={0} paint={(x0, x1) => ({ color: inks.go.onward, alpha: dashCover(x0, x1) })} />;
  }
  if (kind === "data") {
    // idle, idle at 40%, a hue at 70% and another at 100% — interpolated in Oklab, as a gradient with an
    // `oklch()` stop is, a device pixel at a time.
    if (!t.replayed) return <View width={20} height={2} borderRadius={1} backgroundColor={inks.idle as never} />;
    const L = pct(t.v("wire-l"));
    const C = pct(t.v("wire-c"));
    const lab = (c: number, h: number): [number, number, number] => [L, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
    const stops: [number, [number, number, number]][] = [
      [0, lab(0, 0)],
      [0.4, lab(0, 0)],
      [0.7, lab(C, 170)],
      [1, lab(C, 300)],
    ];
    return (
      <Strip
        radius={1}
        paint={(x0, x1) => {
          const x = (x0 + x1) / 2 / 20;
          let i = 0;
          while (i < stops.length - 2 && x > stops[i + 1]![0]) i++;
          const [p0, a0] = stops[i]!;
          const [p1, a1] = stops[i + 1]!;
          const f = Math.min(1, Math.max(0, (x - p0) / (p1 - p0 || 1)));
          const m = a0.map((v, k) => v + (a1[k]! - v) * f) as [number, number, number];
          return { color: rgb(oklab(m[0], m[1], m[2])), alpha: 1 };
        }}
      />
    );
  }
  return <View width={20} height={2} borderRadius={1} backgroundColor={inks.go[kind] as never} />;
}

/** `.chip` with the graph's tones (`sg-chip-on` in --accent). */
function GraphChipView({ chip, last }: { chip: GraphChip; last: boolean }): JSX.Element {
  return (
    <View {...(last ? { flexShrink: 1, minWidth: 0 } : { flexShrink: 0 })}>
      <Chip tone={chip.tone === "plain" ? "plain" : chip.tone} title={chip.title}>
        {chip.text}
      </Chip>
    </View>
  );
}

/** One port: a dot on the box's edge, the slot's name, and whatever the wire cannot say. */
function Port({ port, tier, hot, inks, onEnter, onLeave }: { port: GraphPort; tier: Tier; hot: boolean; inks: Inks; onEnter: () => void; onLeave: () => void }): JSX.Element {
  const t = useTokens();
  const [hovered, setHovered] = useState(false);
  const ink = port.hue === null || !hot ? undefined : inks.hue(port.hue);
  const out = port.side === "out";
  const lit = tier === "lit";
  const ring = port.inferred ? inks.go.abort : ink ?? String(t.v("rule"));
  const ground = port.inferred ? String(t.v("panel")) : port.wired ? (ink ?? inks.idle) : String(t.v("panel"));
  return (
    <View
      position="relative"
      flexDirection={out ? "row-reverse" : "row"}
      alignItems="center"
      gap={5}
      height={17}
      maxWidth="100%"
      borderRadius={4}
      backgroundColor={(hovered || lit ? t.v("fill-ghost-hover") : "transparent") as never}
      {...tip(portTitle(port))}
      {...hover(
        () => {
          setHovered(true);
          onEnter();
        },
        () => {
          setHovered(false);
          onLeave();
        },
      )}
    >
      <View
        position="absolute"
        top="50%"
        marginTop={-4}
        {...(out ? { right: -15 } : { left: -15 })}
        width={8}
        height={8}
        borderRadius={4}
        borderWidth={1.5}
        borderStyle={port.inferred ? "dashed" : "solid"}
        borderColor={ring as never}
        backgroundColor={ground as never}
        {...({ boxShadow: `0 0 0 2px ${String(t.v("panel"))}` } as object)}
        {...(lit ? { transform: [{ scale: 1.35 }] } : {})}
      />
      <Txt spec={{ ...DATA_TEXT, lineHeight: { px: 17 } }} numberOfLines={1} flexGrow={0} flexShrink={1} minWidth={0}>
        {port.name}
      </Txt>
      {port.note.length > 0 ? (
        <Txt spec={{ ...DATA_FAINT, lineHeight: { px: 17 } }} numberOfLines={1} flexGrow={0} flexShrink={5} minWidth={0}>
          {port.note}
        </Txt>
      ) : null}
    </View>
  );
}

/** How a box's kind grounds and rings it. */
function boxLook(t: Tokens, box: PlacedNode, inks: Inks): { ground: string; ring: string; dashed: boolean } {
  const { node } = box;
  const aside = (node.kind === "child" && node.offSpine) || node.kind === "any";
  if (node.kind === "outcome" || node.kind === "missing") return { ground: String(t.v("tint-bad")), ring: inks.go.abort, dashed: false };
  if (aside) return { ground: "transparent", ring: String(t.v("line")), dashed: true };
  if (node.kind === "operation") return { ground: String(t.v("tint-accent")), ring: String(t.v("rule")), dashed: false };
  if (node.kind === "entry") return { ground: String(t.v("panel-2")), ring: String(t.v("line")), dashed: false };
  if (node.kind === "exit") return { ground: String(t.v("tint-ok")), ring: String(t.v("line")), dashed: false };
  return { ground: String(t.v("panel")), ring: String(t.v("line")), dashed: false };
}

function Box({
  box,
  tier,
  inks,
  onFocus,
  onOpen,
  onShow,
  portTier,
  portHot,
}: {
  box: PlacedNode;
  tier: Tier;
  inks: Inks;
  onFocus: (focus: Focus | null) => void;
  onOpen: (() => void) | null;
  onShow: (() => void) | null;
  portTier: (port: GraphPort) => Tier;
  portHot: (port: GraphPort) => boolean;
}): JSX.Element {
  const t = useTokens();
  const { node } = box;
  const look = boxLook(t, box, inks);
  const last = useRef(0);
  const self = (): void => onFocus({ kind: "node", id: node.id });
  const ins = node.ports.filter((p) => p.side === "in");
  const outs = node.ports.filter((p) => p.side === "out");
  const side = (ports: GraphPort[], out: boolean): JSX.Element => (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} paddingLeft={out ? 6 : 10} {...(out ? { paddingRight: 10, alignItems: "flex-end" } : {})}>
      {ports.map((port) => (
        <Port key={port.key} port={port} tier={portTier(port)} hot={portHot(port)} inks={inks} onEnter={() => onFocus({ kind: "port", node: node.id, port: port.key })} onLeave={self} />
      ))}
    </View>
  );
  // Click asks what this box IS; a second click straight after goes to it (the desktop's double-click).
  const press = (): void => {
    const now = Date.now();
    const twice = now - last.current < 400;
    last.current = now;
    if (twice && onOpen !== null) onOpen();
    else onShow?.();
  };
  const content = (
    <>
      <Txt register={WORDS_OF_OURS.has(node.kind) ? "app-text" : "data-title"} spec={{ lineHeight: { px: 20 } }} height={20} numberOfLines={1}>
        {node.title}
      </Txt>
      {node.subtitle.length > 0 ? (
        <Txt spec={{ ...DATA_SECONDARY, lineHeight: { px: 15 } }} height={15} numberOfLines={1} {...tip(node.subtitle)}>
          {node.subtitle}
        </Txt>
      ) : null}
      {node.session !== null ? (
        <View flexDirection="row" alignItems="center" gap={5} height={17} overflow="hidden" {...tip(nodeSessionTitle(node.session))}>
          <View flexShrink={0} width={9} height={9} borderRadius={3} {...(edge(t, { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, "rule", "dashed") as object)} />
          <Txt spec={{ ...DATA_TEXT, lineHeight: { px: 17 } }} numberOfLines={1} flexShrink={1}>
            {node.session.name}
          </Txt>
        </View>
      ) : null}
      {node.chips.length > 0 ? (
        <View flexDirection="row" alignItems="center" gap={4} height={21} overflow="hidden">
          {node.chips.map((chip, i) => (
            <GraphChipView key={`${chip.text}:${chip.title ?? ""}`} chip={chip} last={i === node.chips.length - 1} />
          ))}
        </View>
      ) : null}
      {node.rows.map((row) => (
        <View key={row.label} flexDirection="row" alignItems="center" gap={6} height={17} minWidth={0} {...tip(`${row.label} — ${row.value}`)}>
          <Txt spec={{ ...DATA_TEXT, lineHeight: { px: 17 } }} numberOfLines={1} flexShrink={0} maxWidth="48%">
            {row.label}
          </Txt>
          <Txt spec={{ ...DATA_SECONDARY, lineHeight: { px: 17 } }} numberOfLines={1} flexGrow={1} flexShrink={1} minWidth={0}>
            {row.value}
          </Txt>
        </View>
      ))}
      {node.ports.length > 0 ? (
        <View flexDirection="row" marginTop={5} marginHorizontal={-10} minWidth={0}>
          {ins.length > 0 ? side(ins, false) : null}
          {outs.length > 0 ? side(outs, true) : null}
        </View>
      ) : null}
    </>
  );
  return (
    <View
      position="absolute"
      left={box.x}
      top={box.y}
      width={box.w}
      height={box.h}
      zIndex={tier === "lit" ? 6 : 2}
      opacity={tierOpacity(tier, 1, 0.45, 0.12)}
      {...({ dataSet: { node: node.id } } as object)}
      {...tip(hint(node, onShow !== null, onOpen !== null))}
      {...hover(self, () => onFocus(null))}
    >
      <Press
        {...(onShow !== null || onOpen !== null ? { onPress: press } : {})}
        flex={1}
        flexDirection="column"
        paddingVertical={9}
        paddingHorizontal={10}
        borderRadius={lengthToken(t, "card-radius", 10)}
        backgroundColor={look.ground as never}
        overflow="visible"
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, tier === "lit" ? "accent" : look.ring, look.dashed ? "dashed" : "solid") as object)}
        {...(tier === "lit" ? { boxShadow: t.v("lift") } : {})}
        {...(isWeb ? { cursor: "inherit" } : {})}
      >
        {content}
      </Press>
    </View>
  );
}

/** A guard, whole: a line per clause, the operator leading, every runtime path a term that can be pointed at. */
function Guard({ edge: e, tierOf: wireTier, onFocus }: { edge: GraphEdge; tierOf: (id: string) => Tier; onFocus: (focus: Focus | null) => void }): JSX.Element {
  const t = useTokens();
  let read = -1;
  if (e.lines.length === 0) {
    return (
      <Txt register="app-secondary" spec={{ italic: true, lineHeight: { px: 15 } }}>
        {unconditional(e)}
      </Txt>
    );
  }
  return (
    <>
      {e.lines.map((line, i) => (
        <Txt key={`${i}:${line.op}`} spec={{ ...(e.structured ? DATA_FAINT : DATA_TEXT), lineHeight: { px: 15 } }} {...({ style: { overflowWrap: "anywhere" } } as object)}>
          {line.op === "" ? null : (
            <Text style={{ color: t.v("dim") as never, marginRight: 4 }}>
              {line.op}
              {isWeb ? "" : " "}
            </Text>
          )}
          {line.terms.map((term, j) => {
            if (term.read === null) return <Text key={j}>{term.text}</Text>;
            read++;
            const wire = `g:${e.id}:${read}`;
            const lit = wireTier(idOf.wire(wire)) === "lit";
            return (
              <Text
                key={j}
                style={{ borderBottomWidth: 1, borderBottomStyle: "dotted", borderBottomColor: t.v(lit ? "accent" : "dim") as never, ...(lit ? { backgroundColor: t.v("tint-accent") as never } : {}) } as never}
                {...(tip(`reads ${term.text}`) as object)}
                {...(hover(
                  () => onFocus({ kind: "wire", id: wire }),
                  () => onFocus({ kind: "edge", id: e.id }),
                ) as object)}
              >
                {term.text}
              </Text>
            );
          })}
        </Txt>
      ))}
    </>
  );
}

/**
 * Something drawn centred on a point — the desktop's `transform: translate(-50%, -50%)`, which a
 * transform's percentages still say (of the box's own size, whatever scale the canvas is drawn at).
 */
function Centred({ x, y, children, ...box }: { x: number; y: number; children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <View position="absolute" left={x} top={y} {...({ transform: [{ translateX: "-50%" }, { translateY: "-50%" }] } as object)} {...box}>
      {children}
    </View>
  );
}

// --- the arrowhead and the line's paint ---------------------------------------------------

/** The desktop's `<marker>` (viewBox 0 0 8 8, ref 7 4, 7 × 7 stroke widths, orient auto), as a filled path. */
function headPath(placed: PlacedEdge, width: number): string | null {
  const c = placed.curves.at(-1);
  if (c === undefined) return null;
  let dx = c.x2 - c.c2x;
  let dy = c.y2 - c.c2y;
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = c.x2 - c.c1x;
    dy = c.y2 - c.c1y;
  }
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = c.x2 - c.x1;
    dy = c.y2 - c.y1;
  }
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const s = (7 * width) / 8;
  const at = (mx: number, my: number): string => {
    const px = c.x2 + (mx - 7) * s * ux - (my - 4) * s * uy;
    const py = c.y2 + (mx - 7) * s * uy + (my - 4) * s * ux;
    return `${Math.round(px * 1000) / 1000} ${Math.round(py * 1000) / 1000}`;
  };
  return `M ${at(0, 0)} L ${at(8, 4)} L ${at(0, 8)} Z`;
}

function lineShapes(placed: PlacedEdge | PlacedWire, tier: Tier, inks: Inks): Shape[] {
  const lit = tier === "lit";
  if ("wire" in placed) {
    const kind = placed.wire.kind;
    const guard = kind === "guard";
    const width = lit ? 3.2 : guard ? 1.5 : 1.7;
    const opacity = tierOpacity(tier, 1, 0.6, 0.07, guard ? 0.35 : 0.62);
    const dash = kind === "expr" ? "7 4" : kind === "produced" || guard ? "1.5 4" : undefined;
    return [{ kind: "path", d: placed.d, stroke: lit ? inks.hue(placed.wire.hue) : inks.idle, strokeWidth: width, opacity, ...(dash !== undefined ? { dash } : {}), linecap: "round" }];
  }
  const { edge: e, flow } = placed;
  const sequence = e.kind === "sequence";
  const width = lit ? 3.2 : sequence ? 2.5 : 2;
  const stroke = sequence ? inks.go.spine : inks.go[flow];
  const dash = e.nowait ? "2 5" : e.kind === "state" ? "7 5" : undefined;
  const opacity = tierOpacity(tier, 1, 0.6, 0.07);
  const head = headPath(placed, width);
  return [
    { kind: "path", d: placed.d, stroke, strokeWidth: width, opacity, ...(dash !== undefined ? { dash } : {}), linecap: "butt" },
    ...(head !== null ? [{ kind: "path" as const, d: head, fill: inks.go[headOf(placed)], stroke: "none", opacity }] : []),
  ];
}

/** How near a point is to a line, in canvas units — what the desktop's 14-wide invisible stroke answers. */
function nearest(lines: readonly { id: string; placed: PlacedEdge | PlacedWire }[], x: number, y: number): { placed: PlacedEdge | PlacedWire } | null {
  let best: { placed: PlacedEdge | PlacedWire } | null = null;
  let score = 7;
  for (const line of lines) {
    const pts = samples(line.placed.curves, 64);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const l2 = vx * vx + vy * vy || 1;
      const k = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l2));
      const d = Math.hypot(x - (a.x + k * vx), y - (a.y + k * vy));
      if (d <= score) {
        score = d;
        best = line;
      }
    }
  }
  return best;
}

// --- the view ---------------------------------------------------------------------------------

export function StateGraphView(props: {
  text: string;
  stateId: string;
  declared?: Record<string, StateSlots> | undefined;
  onOpenState?: ((stateId: string) => void) | undefined;
  readState?: ((id: string) => Promise<WorkflowSource | null>) | undefined;
  saveState?: ((source: WorkflowSource, text: string) => void) | undefined;
  tree?: FileTree | null;
  executors?: ExecutorInfo[];
  busy?: boolean;
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  loadStateSlots?: ((stateIds: string[]) => Promise<Record<string, StateSlots> | null>) | undefined;
  wrapJson?: boolean | undefined;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
  ui?: UiSurface | undefined;
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
}): JSX.Element {
  return (
    <TokenScope scope="sg">
      <Graph {...props} />
    </TokenScope>
  );
}

function Graph({
  text,
  stateId,
  declared,
  onOpenState,
  readState,
  saveState,
  tree = null,
  executors = [],
  busy = false,
  validateSchema,
  loadStateSlots,
  wrapJson,
  onWrapJson,
  ui,
  readFile,
}: Parameters<typeof StateGraphView>[0]): JSX.Element {
  const t = useTokens();
  const look = useLook();
  void look;
  const inks = inksOf(t);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const [focus, setFocus] = useState<Focus | null>(null);
  const map = useRef<RNView | null>(null);
  const drag = useRef<{ x: number; y: number; from: Camera; panning: boolean } | null>(null);
  const onStack = panelOnStack.use();

  const parsed = useMemo<{ doc: unknown; error: string | null }>(() => {
    try {
      return { doc: JSON.parse(text.length > 0 ? text : "{}"), error: null };
    } catch (e) {
      return { doc: null, error: (e as Error).message };
    }
  }, [text]);
  const graph = useMemo(() => graphOf(parsed.doc, stateId, declared ?? {}), [parsed.doc, stateId, declared]);
  const layout = useMemo(() => layoutOf(graph), [graph]);
  const attention = useMemo<Attention>(() => ({ ...focusOf(graph, focus), on: focus !== null }), [graph, focus]);
  const fit = useMemo<Camera>(() => fitOf(room, layout), [room, layout]);
  const shown = camera ?? fit;
  const held = useRef(shown);
  held.current = shown;
  const move = (next: Camera): void => {
    held.current = next;
    setCamera(next);
  };
  const zoomAt = useCallback((px: number, py: number, ratio: number): void => move(zoomedAt(held.current, px, py, ratio)), []);

  // The wheel, on web: zoom about the pointer, and keep the panel from scrolling under it.
  useEffect(() => {
    const node = map.current as unknown as HTMLElement | null;
    if (!isWeb || node === null || typeof node.addEventListener !== "function") return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomAt(e.clientX - rect.left - 1, e.clientY - rect.top - 1, Math.exp(-e.deltaY * 0.0015));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [zoomAt, parsed.error]);

  if (parsed.error !== null) return <Reason>This file is not valid JSON ({parsed.error}) — fix it on the JSON tab to see the graph.</Reason>;

  const has = (kind: GraphEdge["kind"]): boolean => graph.edges.some((e) => e.kind === kind);
  const flows = new Set(layout.edges.map((e) => e.flow));
  const tierFor = (id: string): Tier => tierOf(attention, id);
  const isLit = (id: string): boolean => attention.on && attention.lit.has(id);
  const inkFor = (line: PlacedEdge | PlacedWire): string | undefined =>
    "wire" in line ? (isLit(idOf.wire(line.wire.id)) ? inks.hue(line.wire.hue) : undefined) : line.edge.kind === "sequence" ? undefined : inks.go[line.flow];
  const sight = sightlines(
    layout,
    shown,
    room,
    new Map(layout.nodes.map((n) => [n.node.id, n.node.title])),
    inkFor,
    (id) => !attention.on || attention.lit.has(id) || attention.near.has(id),
  );
  const lines = paintOrder(layout, attention);

  /** Put what a box IS in the side panel: a child's state in the state panel's form, anything else its slice. */
  const show = (node: PlacedNode["node"]): void => {
    if (onStack === null) return;
    const preview =
      node.stateId.length > 0 && readState !== undefined
        ? {
            title: node.stateId,
            value: node.config,
            node: (
              <StatePanel
                stateId={node.stateId}
                read={readState}
                save={saveState ?? (() => undefined)}
                tree={tree}
                executors={executors}
                busy={busy}
                {...(validateSchema !== undefined ? { validateSchema } : {})}
                {...(loadStateSlots !== undefined ? { loadStateSlots } : {})}
                {...(wrapJson !== undefined ? { wrapJson } : {})}
                onWrapJson={onWrapJson}
                ui={ui}
                {...(readFile !== undefined ? { readFile } : {})}
                onOpenState={onOpenState}
              />
            ),
          }
        : { title: node.title, value: node.config };
    onStack((was) => push(was, { kind: "preview", key: `preview:${preview.title}`, preview }));
  };

  // Panning: a press that travels past the slop, anywhere on the map — even one that began on a box.
  const start = (e: GestureResponderEvent): void => {
    drag.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, from: held.current, panning: false };
  };
  const travelled = (e: GestureResponderEvent): boolean => {
    const from = drag.current;
    if (from === null) return false;
    return Math.abs(e.nativeEvent.pageX - from.x) >= SLOP || Math.abs(e.nativeEvent.pageY - from.y) >= SLOP;
  };
  const pan = (e: GestureResponderEvent): void => {
    const from = drag.current;
    if (from === null) return;
    from.panning = true;
    move({ k: from.from.k, x: from.from.x + e.nativeEvent.pageX - from.x, y: from.from.y + e.nativeEvent.pageY - from.y });
  };
  const end = (): void => {
    drag.current = null;
  };

  // Pointing at a line (web): the nearest within the desktop's 14-wide target, in canvas units.
  const lineUnder = (e: { nativeEvent: { offsetX?: number; offsetY?: number; clientX?: number; clientY?: number } }, target: HTMLElement | null): void => {
    if (target === null) return;
    const rect = target.getBoundingClientRect();
    const cx = ((e.nativeEvent.clientX ?? 0) - rect.left - 1 - shown.x) / shown.k;
    const cy = ((e.nativeEvent.clientY ?? 0) - rect.top - 1 - shown.y) / shown.k;
    const hit = nearest(lines, cx, cy);
    if (hit !== null) setFocus(askAbout(hit.placed));
    else if (focus !== null && (focus.kind === "edge" || focus.kind === "wire" || (focus.kind === "port" && lines.some((l) => "wire" in l.placed && l.placed.bundle !== null)))) setFocus(null);
  };

  const legend = legendOf(flows, has("state"), graph.sessions.length > 0);
  const svgShapes = lines.flatMap(({ id, placed }) => lineShapes(placed, tierFor(id), inks));

  return (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} gap={6}>
      <View flexDirection="row" alignItems="center" flexWrap="wrap" gap={10} flexShrink={0} minWidth={0}>
        {legend.map((key) => (
          <View key={key.swatch} flexDirection="row" alignItems="center" gap={5} flexShrink={0} {...tip(key.title)}>
            <Swatch kind={key.swatch} inks={inks} />
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1}>
              {key.word}
            </Txt>
          </View>
        ))}
        {graph.limits.map((limit) => (
          <Chip key={limit}>{limit}</Chip>
        ))}
        <View flexGrow={1} />
        <Sub>{GESTURES}</Sub>
        <ZoomSeg
          k={shown.k}
          fitted={camera === null}
          onOut={() => zoomAt(room.w / 2, room.h / 2, 1 / ZOOM_STEP)}
          onFit={() => setCamera(null)}
          onIn={() => zoomAt(room.w / 2, room.h / 2, ZOOM_STEP)}
        />
      </View>

      <RNView
        ref={map}
        collapsable={false}
        style={
          {
            position: "relative",
            // Positioned and no stacking context, as `.sg-map` is.
            ...NO_STACK,
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
            minHeight: 0,
            overflow: "hidden",
            backgroundColor: t.v("bg"),
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: t.v("line"),
            borderRadius: lengthToken(t, "card-radius", 10),
            ...(isWeb ? { cursor: drag.current?.panning === true ? "grabbing" : "grab", touchAction: "none" } : {}),
          } as never
        }
        onLayout={(e: LayoutChangeEvent) => {
          const { width, height } = e.nativeEvent.layout;
          // The desktop's `clientWidth`/`clientHeight`: inside the border (a device pixel), rounded to whole pixels.
          const node = map.current as unknown as { clientWidth?: number; clientHeight?: number } | null;
          if (isWeb && typeof node?.clientWidth === "number" && typeof node.clientHeight === "number") setRoom({ w: node.clientWidth, h: node.clientHeight });
          else setRoom({ w: Math.max(0, Math.round(width - 2 * hairline())), h: Math.max(0, Math.round(height - 2 * hairline())) });
        }}
        onStartShouldSetResponderCapture={(e) => {
          start(e);
          return false;
        }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponderCapture={travelled}
        onResponderMove={pan}
        onResponderRelease={end}
        onResponderTerminate={end}
        {...((isWeb ? { onMouseMove: (e: { nativeEvent: MouseEvent }) => lineUnder(e as never, map.current as unknown as HTMLElement), onMouseLeave: () => setFocus(null) } : {}) as object)}
      >
        <RNView
          style={
            {
              position: "absolute",
              left: 0,
              top: 0,
              width: layout.width,
              height: layout.height,
              transformOrigin: "0 0",
              // The desktop's own transform and no more (`translate(…) scale(…)`): it is no layer of its
              // own there, and its text is greyscale by the layer the page puts it in — as here.
              transform: [{ translateX: shown.x }, { translateY: shown.y }, { scale: shown.k }],
              ...(isWeb ? { userSelect: "none" } : {}),
            } as never
          }
        >
          {layout.frames.map((frame) => {
            const tier = tierFor(idOf.session(frame.session.id));
            return (
              <View
                key={frame.session.id}
                position="absolute"
                left={frame.x}
                top={frame.y}
                width={frame.w}
                height={frame.h}
                zIndex={0}
                flexDirection="row"
                alignItems="baseline"
                gap={7}
                paddingVertical={3}
                paddingHorizontal={10}
                borderRadius={10}
                overflow="hidden"
                opacity={tier === "dim" ? 0.25 : 1}
                backgroundColor={(tier === "lit" ? t.tint("accent", 9) : t.tint("dim", 7)) as never}
                {...(edge(t, { top: 2, right: 2, bottom: 2, left: 2 }, tier === "lit" ? "accent" : "rule", tier === "lit" ? "solid" : "dashed") as object)}
                {...({ dataSet: { session: frame.session.id } } as object)}
                {...tip(frameTitle(frame.session))}
                {...hover(
                  () => setFocus({ kind: "session", id: frame.session.id }),
                  () => setFocus(null),
                )}
              >
                <Txt spec={{ ...DATA_TEXT, voice: "data", scale: (11 / 12.5) * (12.5 / 12) }} numberOfLines={1}>
                  {frame.session.name}
                </Txt>
                <Sub fontSize={t.scaled("size-app", 10 / 12.5) as never} numberOfLines={1}>
                  {frame.session.scope}
                </Sub>
              </View>
            );
          })}
          <View position="absolute" left={0} top={0} zIndex={1} pointerEvents="none">
            <Svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} color={inks.idle} strokeWidth={1.7} linejoin="round" shapes={svgShapes} />
          </View>
          {layout.edges.map((placed) => {
            if (placed.label === null) return null;
            const spot = sight.labels.get(placed.edge.id) ?? placed.label;
            if (spot === null) return null;
            const tier = tierFor(idOf.edge(placed.edge.id));
            const ring = placed.flow === "back" ? inks.go.back : placed.flow === "abort" ? inks.go.abort : inks.go.onward;
            const dashed = placed.edge.kind === "state";
            return (
              <Centred
                key={`label:${placed.edge.id}`}
                x={spot.x}
                y={spot.y}
                zIndex={tier === "lit" ? 6 : 3}
                opacity={tierOpacity(tier, 1, 1, 0.12)}
                minWidth={placed.label.w}
                maxWidth={460}
                paddingVertical={6}
                paddingHorizontal={8}
                backgroundColor={t.v("panel") as never}
                borderRadius={lengthToken(t, "control-radius", 7)}
                {...(edge(t, { top: 1, right: 1, bottom: 1, left: 3 }, ring, dashed ? "dashed" : "solid") as object)}
                {...(dashed ? { borderLeftStyle: "solid" } : {})}
                {...(tier === "lit" ? { boxShadow: t.v("lift") } : {})}
                {...({ dataSet: { edge: placed.edge.id } } as object)}
                {...tip(edgeTitle(placed.edge))}
                {...hover(
                  () => setFocus({ kind: "edge", id: placed.edge.id }),
                  () => setFocus(null),
                )}
              >
                <Guard edge={placed.edge} tierOf={tierFor} onFocus={setFocus} />
                {placed.edge.dangling ? <Chip tone="bad">no such target</Chip> : null}
              </Centred>
            );
          })}
          {layout.nodes.map((box) => (
            <Box
              key={box.node.id}
              box={box}
              tier={tierFor(idOf.node(box.node.id))}
              inks={inks}
              onFocus={setFocus}
              portTier={(port) => tierFor(idOf.port(box.node.id, port.key))}
              portHot={(port) => isLit(idOf.port(box.node.id, port.key))}
              onOpen={onOpenState !== undefined && box.node.stateId.length > 0 ? () => onOpenState(box.node.stateId) : null}
              onShow={onStack === null || box.node.config === undefined ? null : () => show(box.node)}
            />
          ))}
        </RNView>
        <View position="absolute" left={0} top={0} right={0} bottom={0} zIndex={8} pointerEvents="box-none">
          {sight.markers.map((marker) => {
            const { names, rest } = shownNames(marker);
            return (
              <Centred
                key={marker.key}
                x={marker.x}
                y={marker.y}
                flexDirection="row"
                alignItems="center"
                gap={6}
                maxWidth="56%"
                height={22}
                paddingVertical={1}
                paddingHorizontal={8}
                backgroundColor={t.v("panel") as never}
                borderRadius={999}
                {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
                {...({ boxShadow: t.v("lift") } as object)}
                {...tip(markerTitle(marker))}
              >
                {marker.into ? <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} flexShrink={0}>→</Txt> : null}
                {names.map((name, i) => (
                  <View key={`${name.node}/${name.port ?? ""}`} flexShrink={1} minWidth={0} {...(i > 0 ? { paddingLeft: 6, ...edge(t, { left: 1 }) } : {})}>
                    <Txt
                      spec={{ ...DATA_TEXT, ...(name.ink !== undefined ? { color: name.ink } : {}) }}
                      numberOfLines={1}
                      {...hover(
                        () => setFocus(name.port === null ? { kind: "node", id: name.node } : { kind: "port", node: name.node, port: name.port }),
                        () => setFocus(null),
                      )}
                    >
                      {name.label}
                    </Txt>
                  </View>
                ))}
                {rest > 0 ? (
                  <View flexShrink={0} paddingLeft={6} {...(edge(t, { left: 1 }) as object)}>
                    <Sub>+{rest}</Sub>
                  </View>
                ) : null}
                {marker.into ? null : <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} flexShrink={0}>→</Txt>}
              </Centred>
            );
          })}
        </View>
      </RNView>
    </View>
  );
}

/** The zoom's three: out, the scale (filled while fitted — pressing it fits again), in. */
function ZoomSeg({ k, fitted, onOut, onFit, onIn }: { k: number; fitted: boolean; onOut: () => void; onFit: () => void; onIn: () => void }): JSX.Element {
  const words = { out: "−", fit: `${Math.round(k * 100)}%`, in: "+" } as const;
  const act = { out: onOut, fit: onFit, in: onIn } as const;
  const disabled = { out: k <= MIN_ZOOM, fit: false, in: k >= MAX_ZOOM } as const;
  return (
    <SegTabs
      tabs={["out", "fit", "in"] as const}
      value={fitted ? "fit" : ("none" as never)}
      words={words}
      titles={{ out: "zoom out", fit: "fit the whole state in the pane", in: "zoom in" }}
      onPick={(one) => !disabled[one] && act[one]()}
    />
  );
}
