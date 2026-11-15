import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Pressable, type GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { LANE_PITCH, agentRailOf, gutterOf, laneHueOf, leftLaneXOf, runningCallsOf, trunkXOf, type AgentLane, type AgentRail, type LaneMark } from "@jaira/ui/agentRail";
import type { RunWait } from "@jaira/ui/childRunModel";
import { subagentLineOf } from "@jaira/ui/subagentModel";
import type { ToolEntry, TranscriptEntry } from "@jaira/ui/transcript";
import { shownInChain } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { secondsOf } from "@jaira/ui/workSummary";
import { useNow } from "@jaira/ui/workSummaryContext";
import { useCanHover } from "../../canHover";
import { Press, Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { ChildRunLine } from "../chat/ChildRun";
import { Pulse } from "../chat/Pulse";
import { Float } from "../floats/Float";
import { HoverFloatLayer } from "../floats/hoverFloat";
import { Icon, type IconName } from "./Icon";
import { ShownFilesView } from "./ShownFiles";
import { Svg, type Shape } from "./Svg";
import { cssColour } from "./Rail";

/**
 * The agents a conversation started, drawn on a rail beside it (`agentRail.ts` says which lane is what;
 * the person's rulings, 2026-11-14, rounds 1–5):
 *
 *   the trunk            the conversation: a 2px line at the gutter's `trunkXOf`, --rule (a nested
 *                        agent's conversation: the agent's own hue, being its lane)
 *   a waited-for agent   its line on a knot on the trunk; folded, the rail's bump with a plus; opened,
 *                        a curve to the right into its conversation, nested, and a join back under it
 *   a background agent   its knot curves to the LEFT into its column and runs down the gutter beside the
 *                        conversation — to its live end (a dot, level with the foot) while it runs, and
 *                        back into the trunk where it returned or where the conversation began to wait
 *                        for it (the crossover: on through the trunk to the right)
 *   brought here         a background agent opened in this conversation: its lane on the right, its knot
 *                        filled; pressing its lane sends it back
 *
 * Hovering a lane lights it and brings out a stack of four round buttons ON the lane at the pointer
 * (4C, with the square, round 5): the lane's own click (bring here, send back, fold or show here), the
 * main window (enter it, as a substate), beside (a split pane), the side panel. Under a finger the lane
 * is pressed for them instead, and they come with their words.
 *
 * The rows say what happened in words (`AgentLaneRow`); the rail is drawn over the column from where
 * those rows are measured to be (`useRailFrame`), so a lane can run past any number of rows in between.
 * A phone keeps only the rows near its window drawn (`Virtual.tsx`): a lane whose rows are not drawn
 * is not drawn either.
 */

/** Where an agent can be opened besides in place — the host's (the Chat view's) to say. */
export interface AgentHost {
  /** What its line says, when the host knows more than the record (its waits, what it runs). */
  info?: (call: string) => { name: string; kind?: string; waits: readonly RunWait[]; running?: { step: string; path: string[] }; steps: number; took: string } | undefined;
  /** Make its conversation the main view — entering it, as a substate. */
  walkIn?: (call: string, name: string) => void;
  /** A split pane beside this one. */
  beside?: (call: string, name: string) => void;
  /** The side panel. */
  panel?: (call: string, name: string) => void;
  /** Where it is open now, besides here. */
  litOf?: (call: string) => { beside: boolean; panel: boolean };
}

export const AgentHostContext = createContext<AgentHost | undefined>(undefined);

/** A part of a lane's row the rail is drawn against. */
type Part = "head" | "nest" | "foot";
type Rect = { x: number; y: number; w: number; h: number };

interface RailCtx {
  rail: AgentRail;
  hueOf: (call: string) => string;
  open: ReadonlySet<string>;
  toggle: (key: string) => void;
  register: (key: string, extra?: { trunk: number }) => (el: unknown) => void;
  forkOf: (call: string) => ToolEntry | undefined;
  sidechainOf: ((call: string) => TranscriptEntry[]) | undefined;
  streaming: ReadonlySet<string>;
  working: boolean;
  onOpenSidechain: ((call: string, name: string) => void) | undefined;
  artifacts: ArtifactSurface | undefined;
  /** An agent's conversation, nested beside its lane, with its lane as its trunk. */
  nested: (entries: TranscriptEntry[], working: boolean, hue: string) => ReactNode;
}

const RailContext = createContext<RailCtx | null>(null);

/** The key a lane's rows are measured and opened under: its call, and `@cross` for its crossover's nest. */
const keyOf = (call: string, mark: LaneMark, part: Part): string => `${call}:${mark}:${part}`;
const openKey = (call: string, mark: LaneMark): string => (mark === "cross" ? `${call}@cross` : call);

/** How a nested conversation stands inside its row: its trunk under the parent's lane, 18 out. */
const NEST_LEFT = -4;

/**
 * The rail around a conversation's column: its context, the props its column takes (a ref, and a layout
 * listener), the padding its gutter needs, and the drawing over it. `lane`: this conversation is an
 * agent's, nested — its trunk is drawn in that agent's hue.
 */
export function useRailFrame({
  entries,
  working,
  streaming,
  sidechainOf,
  onOpenSidechain,
  lane,
  artifacts,
  nested,
}: {
  entries: readonly TranscriptEntry[];
  working: boolean;
  streaming: ReadonlySet<string>;
  sidechainOf: ((call: string) => TranscriptEntry[]) | undefined;
  onOpenSidechain: ((call: string, name: string) => void) | undefined;
  lane: string | undefined;
  artifacts: ArtifactSurface | undefined;
  nested: RailCtx["nested"];
}): { on: boolean; ctx: RailCtx; gutter: number; columnProps: Record<string, unknown>; overlay: ReactNode } {
  const running = useMemo(() => runningCallsOf(entries, streaming, working), [entries, streaming, working]);
  const rail = useMemo(() => agentRailOf(entries, running), [entries, running]);
  const on = rail.lanes.length > 0 || lane !== undefined;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setOpen((was) => {
    const next = new Set(was);
    if (!next.delete(key)) next.add(key);
    return next;
  }), []);
  // What the rows registered, and where each was last measured against the column.
  const els = useRef(new Map<string, { el: unknown; trunk?: number }>()).current;
  const column = useRef<unknown>(null);
  const [geo, setGeo] = useState<{ size: { w: number; h: number }; rects: Map<string, Rect>; trunks: Map<string, number> }>(() => ({ size: { w: 0, h: 0 }, rects: new Map(), trunks: new Map() }));
  const frame = useRef<number | undefined>(undefined);
  const measure = useCallback(() => {
    if (frame.current !== undefined) return;
    const run = (): void => {
      frame.current = undefined;
      const col = column.current as Measurable | null;
      if (col === null) return;
      measureAll(col, els, (size, rects) => {
        const trunks = new Map<string, number>();
        for (const [key, one] of els) if (one.trunk !== undefined) trunks.set(key, one.trunk);
        setGeo((was) => (sameGeo(was, size, rects) ? was : { size, rects, trunks }));
      });
    };
    frame.current = typeof requestAnimationFrame === "function" ? (requestAnimationFrame(run) as unknown as number) : (setTimeout(run, 16) as unknown as number);
  }, [els]);
  const register = useCallback(
    (key: string, extra?: { trunk: number }) => (el: unknown) => {
      if (el === null) els.delete(key);
      else els.set(key, { el, ...(extra !== undefined ? { trunk: extra.trunk } : {}) });
      measure();
    },
    [els, measure],
  );
  // Measured after every draw, and whenever the column changes size under it (a row opened inside).
  useLayoutEffect(() => {
    if (on) measure();
  });
  useEffect(() => {
    if (!on || !isWeb) return undefined;
    const el = column.current as Element | null;
    if (el === null || typeof ResizeObserver === "undefined") return undefined;
    const seen = new ResizeObserver(() => measure());
    seen.observe(el);
    return () => seen.disconnect();
  }, [on, measure]);
  const forks = useMemo(() => {
    const map = new Map<string, ToolEntry>();
    for (const [entry, at] of rail.marks) if (at.mark === "fork" && entry.kind === "tool") map.set(at.lane.call, entry);
    return map;
  }, [rail]);
  const ctx = useMemo<RailCtx>(
    () => ({ rail, hueOf: (call) => laneHueOf(rail, call), open, toggle, register, forkOf: (call) => forks.get(call), sidechainOf, streaming, working, onOpenSidechain, artifacts, nested }),
    [rail, open, toggle, register, forks, sidechainOf, streaming, working, onOpenSidechain, artifacts, nested],
  );
  const columnProps = on ? { ref: (el: unknown) => void (column.current = el), onLayout: () => measure(), position: "relative" } : {};
  const overlay = on ? <RailOverlay ctx={ctx} geo={geo} trunkColour={lane} /> : null;
  return { on, ctx, gutter: gutterOf(rail.columns), columnProps, overlay };
}

type Measurable = {
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
  measureLayout?: (relativeTo: unknown, ok: (x: number, y: number, w: number, h: number) => void, fail?: () => void) => void;
};

/** Every registered row against the column: from the page on web, by `measureLayout` on a phone. */
function measureAll(col: Measurable, els: Map<string, { el: unknown }>, then: (size: { w: number; h: number }, rects: Map<string, Rect>) => void): void {
  const rects = new Map<string, Rect>();
  if (typeof col.getBoundingClientRect === "function") {
    const c = col.getBoundingClientRect();
    for (const [key, { el }] of els) {
      const r = (el as Measurable).getBoundingClientRect?.();
      if (r !== undefined) rects.set(key, { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
    }
    then({ w: c.width, h: c.height }, rects);
    return;
  }
  let pending = els.size + 1;
  let size = { w: 0, h: 0 };
  const done = (): void => {
    pending -= 1;
    if (pending === 0) then(size, rects);
  };
  (col as Measurable).measureLayout?.(col, (_x, _y, w, h) => {
    size = { w, h };
    done();
  }, done);
  for (const [key, { el }] of els) {
    const m = el as Measurable;
    if (typeof m.measureLayout !== "function") {
      done();
      continue;
    }
    m.measureLayout(col, (x, y, w, h) => {
      rects.set(key, { x, y, w, h });
      done();
    }, done);
  }
}

function sameGeo(was: { size: { w: number; h: number }; rects: Map<string, Rect> }, size: { w: number; h: number }, rects: Map<string, Rect>): boolean {
  if (Math.abs(was.size.w - size.w) > 0.5 || Math.abs(was.size.h - size.h) > 0.5 || was.rects.size !== rects.size) return false;
  for (const [key, r] of rects) {
    const o = was.rects.get(key);
    if (o === undefined || Math.abs(o.x - r.x) > 0.5 || Math.abs(o.y - r.y) > 0.5 || Math.abs(o.w - r.w) > 0.5 || Math.abs(o.h - r.h) > 0.5) return false;
  }
  return true;
}

export function RailProvider({ ctx, children }: { ctx: RailCtx; children: ReactNode }): JSX.Element {
  return <RailContext.Provider value={ctx}>{children}</RailContext.Provider>;
}

/** Whether a row of this rail is a lane's mark — and so drawn by {@link AgentLaneRow}. */
export function useLaneMark(entry: TranscriptEntry): { lane: AgentLane; mark: LaneMark } | undefined {
  return useContext(RailContext)?.rail.marks.get(entry);
}

/** Every lane mark in a rail, for the rows a summary must keep drawn. */
export function useLaneMarks(): ReadonlyMap<TranscriptEntry, { lane: AgentLane; mark: LaneMark }> | undefined {
  return useContext(RailContext)?.rail.marks;
}

/** One of the rows that marks an agent's lane: where it started, where the conversation began to wait for it, where it came back. */
export function AgentLaneRow({ entry, mark }: { entry: TranscriptEntry; mark: { lane: AgentLane; mark: LaneMark } }): JSX.Element | null {
  const ctx = useContext(RailContext);
  const host = useContext(AgentHostContext);
  const t = useTokens();
  const lane = mark.lane;
  const call = lane.call;
  const fork = ctx?.forkOf(call);
  const chain = useMemo(() => (ctx?.sidechainOf !== undefined ? ctx.sidechainOf(call) : []), [ctx, call]);
  const ended = lane.back !== undefined;
  const running = ctx !== null && !ended && (ctx.streaming.has(call) || (ctx.working && (fork?.result === undefined || lane.background)));
  const now = useNow(running);
  const local = useMemo(() => (fork !== undefined ? subagentLineOf(fork, chain, ctx?.sidechainOf, running) : undefined), [fork, chain, ctx, running]);
  const streaming = ctx?.streaming;
  const innerColumns = useMemo(() => agentRailOf(chain, runningCallsOf(chain, streaming ?? new Set(), running)).columns, [chain, streaming, running]);
  // Waited for from its crossover on: what it said from that point.
  const since = entry.kind === "tool" ? entry.at : undefined;
  const files = useMemo(() => (mark.mark === "fork" ? shownInChain(chain, ctx?.sidechainOf) : undefined), [mark.mark, chain, ctx]);
  const fromCross = useMemo(() => (mark.mark !== "cross" || since === undefined ? chain : chain.filter((one) => ((one as { at?: number }).at ?? since) >= since)), [chain, mark.mark, since]);
  if (ctx === null || fork === undefined) return null;
  const known = host?.info?.(call);
  const sub = local?.sub;
  const name = known?.name ?? sub?.name ?? "agent";
  const kind = known?.kind ?? sub?.kind ?? "agent";
  const took = known?.took ?? (sub?.startedAt === undefined ? "" : `${secondsOf(Math.max(0, (running ? now : (sub.lastAt ?? sub.startedAt)) - sub.startedAt))}${running ? " so far" : ""}`);
  const waits = known?.waits ?? local?.waits ?? [];
  const doing = known?.running ?? (waits.length === 0 && sub?.step !== undefined ? { step: sub.step.step, path: sub.step.path } : undefined);
  const steps = known?.steps ?? sub?.steps ?? 0;
  const walkIn = host?.walkIn !== undefined ? () => host.walkIn!(call, name) : ctx.onOpenSidechain !== undefined ? () => ctx.onOpenSidechain!(call, name) : undefined;
  const hue = ctx.hueOf(call);
  const key = openKey(call, mark.mark);
  const isOpen = ctx.open.has(key);
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };

  if (mark.mark === "back") {
    return (
      <View ref={ctx.register(keyOf(call, "back", "head")) as never} role="note" flexDirection="row" alignItems="center" gap={8} padding={4} minHeight={30} minWidth={0}>
        <Icon name="check" size={13} color={String(t.v("ok"))} />
        <Txt spec={{ ...words, weight: 600, color: "text" }} flexShrink={1} ellip>
          {name}
        </Txt>
        <Txt spec={words} flexShrink={0}>
          returned
        </Txt>
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim", tabular: true }} marginLeft="auto" paddingHorizontal={3} flexShrink={0}>
          {steps} {steps === 1 ? "step" : "steps"} · {took}
        </Txt>
      </View>
    );
  }

  const nest = isOpen ? (
    <>
      <View ref={ctx.register(keyOf(call, mark.mark, "nest"), { trunk: trunkXOf(innerColumns) }) as never} marginLeft={NEST_LEFT - innerColumns * LANE_PITCH} minWidth={0}>
        {ctx.nested(fromCross, running, hue)}
      </View>
      <View ref={ctx.register(keyOf(call, mark.mark, "foot")) as never} role="note" flexDirection="row" alignItems="center" gap={8} padding={4} minHeight={30} minWidth={0}>
        {running ? <Pulse /> : <Icon name="check" size={13} color={String(t.v("ok"))} />}
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "text" }} flexShrink={1} ellip>
          {name}
        </Txt>
        <Txt spec={words} flexShrink={0}>
          {running ? "still running" : "returned"}
        </Txt>
        <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim", tabular: true }} marginLeft="auto" paddingHorizontal={3} flexShrink={0}>
          {took}
        </Txt>
      </View>
    </>
  ) : null;

  return (
    <View flexDirection="column" minWidth={0}>
      <View ref={ctx.register(keyOf(call, mark.mark, "head")) as never} minWidth={0}>
        <ChildRunLine
          verb={mark.mark === "cross" ? "waiting for" : kind}
          name={name}
          goTitle={`open ${name} as the main view`}
          waits={waits}
          running={doing}
          steps={steps}
          took={took}
          open={isOpen}
          onToggle={() => ctx.toggle(key)}
          {...(walkIn !== undefined ? { onWalkIn: walkIn } : {})}
          nest={false}
        >
          {null}
        </ChildRunLine>
      </View>
      {nest}
      {/* What it showed the person, under its line while it is folded (2026-11-13). */}
      {!isOpen && files !== undefined ? (
        <View paddingLeft={34} paddingTop={4} paddingBottom={4} minWidth={0}>
          <ShownFilesView shown={files} artifacts={ctx.artifacts} />
        </View>
      ) : null}
    </View>
  );
}

// --- the drawing --------------------------------------------------------------

/** The lit lane: brighter, the rail's own light (`Rail.tsx`). */
const LIT = "brightness(1.4) saturate(1.4)";

/** A row's middle, as the rail's knots sit: in its first 34, however tall it wrapped. */
const midOf = (r: Rect): number => r.y + Math.min(r.h, 34) / 2;

interface Hit {
  call: string;
  x: number;
  top: number;
  bottom: number;
}

function RailOverlay({ ctx, geo, trunkColour }: { ctx: RailCtx; geo: { size: { w: number; h: number }; rects: Map<string, Rect>; trunks: Map<string, number> }; trunkColour: string | undefined }): JSX.Element | null {
  const t = useTokens();
  const hovers = useCanHover();
  const [hot, setHot] = useState<{ call: string; sx: number; sy: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const { rail, open } = ctx;
  const { w, h } = geo.size;
  const X = trunkXOf(rail.columns);
  const rule = cssColour(t, trunkColour ?? "var(--rule)");
  const bg = cssColour(t, "var(--bg)");
  const shapes: Shape[] = [];
  const hits: Hit[] = [];
  const knot = (cx: number, cy: number, colour: string, lit: boolean, filled = false): void => {
    shapes.push({ kind: "circle", cx, cy, r: 4.5, fill: bg, stroke: colour, strokeWidth: 2, ...(lit ? { filter: LIT } : {}) });
    if (filled) shapes.push({ kind: "circle", cx, cy, r: 2.2, fill: colour, ...(lit ? { filter: LIT } : {}) });
  };
  if (h > 0) shapes.push({ kind: "path", d: `M${X} 0 V ${h}`, stroke: rule, strokeWidth: 2, linecap: "butt" });

  /** The right side of a lane: into its nest and back out under it, or the bump of a folded one. */
  const rightOf = (lane: AgentLane, mark: LaneMark, head: Rect, colour: string, lit: boolean, from: number): void => {
    const nest = geo.rects.get(keyOf(lane.call, mark, "nest"));
    const foot = geo.rects.get(keyOf(lane.call, mark, "foot"));
    const mid = midOf(head);
    if (open.has(openKey(lane.call, mark)) && nest !== undefined) {
      const inner = nest.x + (geo.trunks.get(keyOf(lane.call, mark, "nest")) ?? 9);
      shapes.push({ kind: "path", d: `M${from} ${mid} C ${from} ${mid + 7}, ${inner} ${nest.y - 6}, ${inner} ${nest.y}`, stroke: colour, strokeWidth: 2, ...(lit ? { filter: LIT } : {}) });
      hits.push({ call: lane.call, x: inner, top: nest.y, bottom: nest.y + nest.h });
      if (foot !== undefined) {
        const fm = midOf(foot);
        shapes.push({ kind: "path", d: `M${inner} ${nest.y + nest.h} C ${inner} ${fm - 5}, ${X} ${fm - 7}, ${X} ${fm}`, stroke: colour, strokeWidth: 2, ...(lit ? { filter: LIT } : {}) });
      }
      return;
    }
    // Folded: out and straight back in, under the knot (`rail.ts` bumpPath).
    const b = X + LANE_PITCH;
    shapes.push({ kind: "path", d: `M${X} ${mid} C ${X} ${mid + 5}, ${b} ${mid + 4}, ${b} ${mid + 9} C ${b} ${mid + 14}, ${X} ${mid + 13}, ${X} ${mid + 17}`, stroke: colour, strokeWidth: 2, ...(lit ? { filter: LIT } : {}) });
    hits.push({ call: lane.call, x: X + 9, top: mid - 6, bottom: mid + 17 });
  };

  for (const lane of rail.lanes) {
    const colour = cssColour(t, ctx.hueOf(lane.call));
    const lit = hot?.call === lane.call;
    const head = geo.rects.get(keyOf(lane.call, "fork", "head"));
    if (head === undefined) continue;
    const mid = midOf(head);
    const brought = lane.background && open.has(lane.call);
    if (!lane.background || brought) {
      rightOf(lane, "fork", head, colour, lit, X);
      knot(X, mid, colour, lit, brought);
      if (!brought) {
        if (!open.has(lane.call)) shapes.push({ kind: "path", d: `M${X - 2.2} ${mid} H ${X + 2.2} M${X} ${mid - 2.2} V ${mid + 2.2}`, stroke: colour, strokeWidth: 1.5 });
      }
    } else if (lane.column > 0) {
      const lx = leftLaneXOf(rail.columns, lane.column);
      const bottom = head.y + head.h;
      const endMark: LaneMark | undefined = lane.cross !== undefined ? "cross" : lane.back !== undefined ? "back" : undefined;
      const end = endMark !== undefined ? geo.rects.get(keyOf(lane.call, endMark, "head")) : undefined;
      shapes.push({ kind: "path", d: `M${X} ${mid} C ${X} ${mid + 7}, ${lx} ${Math.min(mid + 9, bottom - 4)}, ${lx} ${bottom}`, stroke: colour, strokeWidth: 2, ...(lit ? { filter: LIT } : {}) });
      const stop = end !== undefined ? end.y : endMark === undefined ? h - 14 : undefined;
      if (stop !== undefined && stop > bottom) {
        shapes.push({ kind: "path", d: `M${lx} ${bottom} V ${stop}`, stroke: colour, strokeWidth: 2, linecap: "butt", ...(lit ? { filter: LIT } : {}) });
        hits.push({ call: lane.call, x: lx, top: bottom, bottom: stop });
      }
      if (end !== undefined) {
        const em = midOf(end);
        shapes.push({ kind: "path", d: `M${lx} ${end.y} C ${lx} ${em - 5}, ${X} ${em - 7}, ${X} ${em}`, stroke: colour, strokeWidth: 2, ...(lit ? { filter: LIT } : {}) });
        if (endMark === "cross") rightOf(lane, "cross", end, colour, lit, X);
        knot(X, em, colour, lit);
      } else if (endMark === undefined && stop !== undefined) {
        // Still running: its live end, level with the conversation's foot.
        shapes.push({ kind: "circle", cx: lx, cy: stop, r: 7, fill: colour, opacity: 0.18 });
        shapes.push({ kind: "circle", cx: lx, cy: stop, r: 3.5, fill: colour });
      }
      knot(X, mid, colour, lit);
    } else {
      knot(X, mid, colour, lit);
    }
    // A brought-here agent's crossover and return still say where they were.
    if (brought) {
      for (const m of ["cross", "back"] as const) {
        const r = geo.rects.get(keyOf(lane.call, m, "head"));
        if (r !== undefined) knot(X, midOf(r), colour, lit);
        if (r !== undefined && m === "cross") rightOf(lane, "cross", r, colour, lit, X);
      }
    }
  }

  const hovered = hot !== null ? rail.lanes.find((lane) => lane.call === hot.call) : undefined;
  const leave = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHot(null), 200);
  };
  const stay = (): void => clearTimeout(timer.current);
  if (w <= 0 || h <= 0) return null;
  return (
    <View position="absolute" left={0} top={0} width={w} height={h} pointerEvents="box-none">
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} strokeWidth={2} linecap="round" shapes={shapes} box={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} />
      {hits.map((hit, i) => (
        <LaneHit
          key={`${hit.call}:${i}`}
          hit={hit}
          hovers={hovers}
          onPoint={(sx, sy) => {
            stay();
            setHot({ call: hit.call, sx, sy });
          }}
          onLeave={leave}
          onPress={() => {
            const lane = rail.lanes.find((one) => one.call === hit.call);
            if (lane !== undefined && hovers) ctx.toggle(lane.call);
          }}
        />
      ))}
      {hot !== null && hovered !== undefined ? (
        <HoverFloatLayer hover={{ hovers, close: () => setHot(null) }}>
          <Float
            anchor={{ left: hot.sx - 17, right: hot.sx - 17, top: hot.sy, bottom: hot.sy }}
            side="right"
            align="center"
            offset={0}
            pointerEvents="auto"
            {...(hovers ? ({ onMouseEnter: stay, onMouseLeave: leave } as object) : {})}
          >
            <LaneStack lane={hovered} ctx={ctx} words={!hovers} done={() => setHot(null)} />
          </Float>
        </HoverFloatLayer>
      ) : null}
    </View>
  );
}

/** Where a lane takes the pointer: 6 either side of it. */
function LaneHit({ hit, hovers, onPoint, onLeave, onPress }: { hit: Hit; hovers: boolean; onPoint: (sx: number, sy: number) => void; onLeave: () => void; onPress: () => void }): JSX.Element {
  const box = { position: "absolute" as const, left: hit.x - 6, top: hit.top, width: 12, height: Math.max(8, hit.bottom - hit.top) };
  const centre = (e: { currentTarget?: unknown; clientY?: number; nativeEvent?: { clientY?: number; pageX?: number; pageY?: number } }): { sx: number; sy: number } => {
    const el = e.currentTarget as { getBoundingClientRect?: () => { left: number; width: number } } | undefined;
    const r = el?.getBoundingClientRect?.();
    const y = e.clientY ?? e.nativeEvent?.clientY ?? e.nativeEvent?.pageY ?? 0;
    return { sx: r !== undefined ? r.left + r.width / 2 : (e.nativeEvent?.pageX ?? 0), sy: y };
  };
  if (hovers) {
    return (
      <View
        {...box}
        {...({
          style: { cursor: "pointer" },
          onMouseEnter: (e: never) => {
            const at = centre(e);
            onPoint(at.sx, at.sy);
          },
          onMouseMove: (e: never) => {
            const at = centre(e);
            onPoint(at.sx, at.sy);
          },
          onMouseLeave: onLeave,
          onClick: onPress,
        } as object)}
      />
    );
  }
  return (
    <Pressable
      style={box}
      onPress={(e: GestureResponderEvent) => onPoint(e.nativeEvent.pageX, e.nativeEvent.pageY)}
      accessibilityLabel="this agent's lane"
    />
  );
}

/** The four buttons on a lane: its own click, the main window, beside, the side panel. */
function LaneStack({ lane, ctx, words, done }: { lane: AgentLane; ctx: RailCtx; words: boolean; done: () => void }): JSX.Element {
  const t = useTokens();
  const host = useContext(AgentHostContext);
  const fork = ctx.forkOf(lane.call);
  const name = fork !== undefined ? (subagentNameOf(fork) ?? "agent") : "agent";
  const open = ctx.open.has(lane.call);
  const lit = host?.litOf?.(lane.call) ?? { beside: false, panel: false };
  const first: { icon: IconName; say: string } = lane.background
    ? open
      ? { icon: "flip", say: "Send back to the background" }
      : { icon: "flip", say: "Bring into this conversation" }
    : open
      ? { icon: "fold", say: "Fold it" }
      : { icon: "unfold", say: "Show it here" };
  const walkIn = host?.walkIn ?? ctx.onOpenSidechain;
  const buttons: { icon: IconName; say: string; on: boolean; go: (() => void) | undefined }[] = [
    { icon: first.icon, say: first.say, on: false, go: () => ctx.toggle(lane.call) },
    { icon: "placeMain", say: "Open as the main view", on: false, go: walkIn !== undefined ? () => walkIn(lane.call, name) : undefined },
    { icon: "placeSplit", say: "Open beside", on: lit.beside, go: host?.beside !== undefined ? () => host.beside!(lane.call, name) : undefined },
    { icon: "placePanel", say: "Open in the side panel", on: lit.panel, go: host?.panel !== undefined ? () => host.panel!(lane.call, name) : undefined },
  ];
  return (
    <View
      flexDirection="column"
      gap={2}
      padding={4}
      borderRadius={words ? 12 : 18}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v("line") as never}
      backgroundColor={t.v("panel") as never}
      {...({ boxShadow: "0px 6px 18px rgba(15, 20, 30, 0.16)" } as object)}
    >
      {buttons
        .filter((b) => b.go !== undefined)
        .map((b) => (
          <Press
            key={b.icon}
            onPress={() => {
              b.go?.();
              done();
            }}
            label={b.say}
            title={b.say}
            flexDirection="row"
            alignItems="center"
            gap={8}
            {...(words ? { paddingVertical: 7, paddingHorizontal: 10 } : { width: 28, height: 28, justifyContent: "center" })}
            borderRadius={words ? 8 : 14}
            box={({ hovered }) => ({ backgroundColor: b.on ? t.mix(t.v("accent"), 14, t.v("panel")) : hovered ? t.v("panel-2") : "transparent" })}
          >
            {({ hovered }) => (
              <>
                <Icon name={b.icon} size={14} color={String(t.v(b.on ? "accent" : hovered ? "text" : "dim"))} />
                {words ? <Txt spec={{ voice: "app", scale: 12.5 / 12.5, color: "text" }}>{b.say}</Txt> : null}
              </>
            )}
          </Press>
        ))}
    </View>
  );
}

function subagentNameOf(entry: ToolEntry): string | undefined {
  const args = entry.args as Record<string, unknown> | null | undefined;
  const d = args !== null && typeof args === "object" ? args["description"] : undefined;
  return typeof d === "string" && d.trim().length > 0 ? d.trim() : entry.summary.length > 0 ? entry.summary : undefined;
}
