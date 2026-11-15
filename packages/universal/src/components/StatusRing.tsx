import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import type { PillKind } from "@jaira/ui/pillModel";
import { ringLabel, ringOf, type Ring, type RingItem } from "@jaira/ui/ringModel";
import { Txt } from "../primitives";
import { useTokens } from "../tokens";
import { Breathe } from "./Breathe";
import { Svg, type Shape } from "./panel/Svg";

/** Each kind's colour, as the pills and the rail's badge colour it. */
export const RING_INK: Record<PillKind, string> = { running: "accent", waiting: "warn", error: "bad", warning: "warn", success: "ok" };

/**
 * A clock for a ring: by the second while something on it works, by the half minute while it holds only
 * waits (their number moves by the minute), and still while it is empty.
 */
export function useRingClock(items: readonly RingItem[]): number {
  const running = items.some((i) => i.kind === "running");
  const every = running ? 1000 : items.length > 0 ? 30_000 : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (every === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/**
 * A rounded square from its top-left corner's end, clockwise, and its length. A radius of half the side
 * is a circle starting at its top.
 */
function roundRect(x: number, y: number, side: number, r: number): { d: string; length: number } {
  const e = x + side;
  const b = y + side;
  const d = r * 2 >= side
    ? `M ${x + side / 2} ${y} A ${side / 2} ${side / 2} 0 1 1 ${x + side / 2} ${b} A ${side / 2} ${side / 2} 0 1 1 ${x + side / 2} ${y}`
    : `M ${x + r} ${y} H ${e - r} A ${r} ${r} 0 0 1 ${e} ${y + r} V ${b - r} A ${r} ${r} 0 0 1 ${e - r} ${b} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${b - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
  return { d, length: r * 2 >= side ? Math.PI * side : 4 * (side - 2 * r) + 2 * Math.PI * r };
}

/**
 * The ring as two drawings: what stands still — the track (the dim text faded, which reads on every
 * ground a tile or a row stands on) and every segment but the working ones — and the working segments,
 * which breathe (the mockup, board 11: a segment of work goes from full to a third and back).
 */
function ringShapes(ring: Ring, size: number, radius: number, stroke: number, t: ReturnType<typeof useTokens>): { still: Shape[]; working: Shape[] } {
  const inset = stroke / 2 + 0.5;
  const { d, length } = roundRect(inset, inset, size - inset * 2, Math.max(0, radius - inset));
  const per = length / 100;
  // `0 start length rest`: an empty dash, the gap up to the segment, the segment, the rest of the way round.
  const shape = (s: Ring["segments"][number]): Shape => ({ kind: "path", d, stroke: String(t.v(RING_INK[s.kind])), strokeWidth: stroke, linecap: "butt", dash: `0 ${s.start * per} ${s.length * per} ${length}` });
  return {
    still: [{ kind: "path", d, stroke: String(t.mix(t.v("dim"), 28, "transparent")), strokeWidth: stroke }, ...ring.segments.filter((s) => s.kind !== "running").map(shape)],
    working: ring.segments.filter((s) => s.kind === "running").map(shape),
  };
}

/** The drawn ring, `size` square: its still part, and over it its working part breathing. */
function RingDrawing({ ring, size, radius, stroke }: { ring: Ring; size: number; radius: number; stroke: number }): JSX.Element {
  const t = useTokens();
  const { still, working } = useMemo(() => ringShapes(ring, size, radius, stroke, t), [ring, size, radius, stroke, t]);
  const viewBox = `0 0 ${size} ${size}`;
  return (
    <>
      <Svg width={size} height={size} viewBox={viewBox} shapes={still} />
      {working.length > 0 ? (
        <View position="absolute" top={0} left={0} pointerEvents="none">
          <Breathe>
            <Svg width={size} height={size} viewBox={viewBox} shapes={working} />
          </Breathe>
        </View>
      ) : null}
    </>
  );
}

/** Laid over a ring: what stands in its middle. */
function Middle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" justifyContent="center">
      {children}
    </View>
  );
}

/**
 * The ring round a project's tile (the activity mockups, round 3, board 11): the ring, the tile inside
 * it, and in the tile its two letters over what the ring's middle says — the oldest wait the person owes,
 * or how long the work has run. With nothing to say the tile is its letters alone, as it was.
 */
export function TileRing({ items, size, tile, letters, on }: { items: readonly RingItem[]; size: number; tile: (body: ReactNode) => JSX.Element; letters: string; on: boolean }): JSX.Element {
  const now = useRingClock(items);
  const ring = useMemo(() => ringOf(items, now), [items, now]);
  const body =
    ring.center === null ? (
      <Txt spec={{ voice: "data", scale: 0.875, weight: 600, color: on ? "text" : "dim" }}>{letters}</Txt>
    ) : (
      <View alignItems="center" gap={1}>
        <Txt spec={{ voice: "data", scale: 0.62, weight: 600, color: "dim", lineHeight: { px: 9 } }}>{letters}</Txt>
        <Txt spec={{ voice: "data", scale: 0.8, weight: 700, color: RING_INK[ring.center.kind] as never, lineHeight: { px: 11 }, tabular: true }}>{ring.center.text}</Txt>
      </View>
    );
  return (
    <View width={size} height={size} position="relative" {...((isWeb && items.length > 0 ? { title: ringLabel(items, now) } : {}) as object)}>
      {/* Always drawn: an empty ring is the tile saying nothing is going on (the mockup, board 11). */}
      <RingDrawing ring={ring} size={size} radius={13} stroke={2.5} />
      <Middle>{tile(body)}</Middle>
    </View>
  );
}

/**
 * The same ring, round, at the start of a conversation's row: in its middle the oldest ask's age, the
 * answer's clock, or a ✓ when all it holds is a finish unread; nothing when it is empty.
 */
export function RowRing({ items, size = 22 }: { items: readonly RingItem[]; size?: number }): JSX.Element {
  const now = useRingClock(items);
  const ring = useMemo(() => ringOf(items, now), [items, now]);
  const middle = ring.center !== null ? { kind: ring.center.kind, text: ring.center.text } : ring.done ? { kind: "success" as const, text: "✓" } : null;
  return (
    <View width={size} height={size} flexShrink={0} position="relative" {...((isWeb && items.length > 0 ? { title: ringLabel(items, now) } : {}) as object)}>
      <RingDrawing ring={ring} size={size} radius={size / 2} stroke={2.2} />
      {middle !== null ? (
        <Middle>
          <Txt spec={{ voice: "data", scale: middle.text === "✓" ? 0.75 : 0.56, weight: 700, color: RING_INK[middle.kind] as never, lineHeight: { px: 9 }, tabular: true }}>{middle.text}</Txt>
        </Middle>
      ) : null}
    </View>
  );
}

/**
 * What a row says at its end beside its ring (the mockup, board 11): the work's clock, `▶ 1:30`, when
 * the ring's middle tells a wait instead — so a conversation that asks while it works says both.
 */
export function RowRingClock({ items }: { items: readonly RingItem[] }): JSX.Element | null {
  const now = useRingClock(items);
  const ring = useMemo(() => ringOf(items, now), [items, now]);
  if (ring.also === null) return null;
  return (
    <Txt spec={{ voice: "data", scale: 0.84, weight: 600, color: RING_INK.running as never, tabular: true }} flexShrink={0} whiteSpace="nowrap">
      {`▶ ${ring.also.text}`}
    </Txt>
  );
}
