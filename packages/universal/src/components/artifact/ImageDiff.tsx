import { useEffect, useState, type JSX } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { Txt } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Range } from "../form/Range";
import { Img, naturalSizeOf } from "../Img";
import { ringWidth } from "./ring";
import { Toggle } from "./Toggle";

/**
 * Two versions of a picture, compared — side by side (what each IS) or stacked with the new one fading
 * in over the old (WHERE they differ). How it looks:
 *
 *   the bar            row, at its end, 4 under: the toggle (`Toggle`) and, stacked, the fader
 *   the fader          row, centred, gap 6: "before" and "after" (--dim, app 11/12.5) round a `Range`,
 *                      140 wide
 *   side by side       two equal columns, gap 10
 *   a figure           a column, gap 4, at its start; its caption --dim in the body's font
 *   a picture          at most as wide as its box, 1px --line, radius 4 (border-box: the ring is inside
 *                      the 100%)
 *   stacked            over a checkerboard: 8 squares of --panel-2 tiled at 16 (four 45° gradients).
 *                      The box is the line an inline picture stands in: as tall as the old picture PLUS
 *                      the strut's descent under the baseline; the new one lies over the whole box,
 *                      stretched to that height (as the reference pictures have it).
 *
 * On web the checkerboard is the gradients themselves; on a phone, which has no background images, the
 * squares are views — and a picture that is an SVG is drawn by `react-native-svg` (`Img.native.tsx`).
 */
export type ImageLayout = "overlay" | "split";

/** DM Sans' ascent and descent, as fractions of the size (each rounded to whole pixels, as Chromium does). */
const ASCENT = 0.992;
const DESCENT = 0.31;

export function ImageDiff({ before, after, layout, onLayout }: { before?: string | undefined; after?: string | undefined; layout: ImageLayout; onLayout: (next: ImageLayout) => void }): JSX.Element {
  const t = useTokens();
  const [mix, setMix] = useState(0.5);
  const [room, setRoom] = useState<number | null>(null);
  const measure = (e: LayoutChangeEvent): void => setRoom(e.nativeEvent.layout.width);
  const body = { voice: "app", scale: 13 / 12.5, color: "dim" } as const;

  // Only one side exists: a create or a delete. Nothing to compare, so nothing to toggle.
  if (before === undefined || after === undefined) {
    const only = after ?? before;
    if (only === undefined) {
      return (
        <Txt spec={body} marginVertical={Number(t.scaled("size-app", 13 / 12.5)) || 13} paddingVertical={8}>
          Neither version of this image is available to show.
        </Txt>
      );
    }
    return (
      <View onLayout={measure}>
        <Figure src={only} alt={after !== undefined ? "the new image" : "the removed image"} caption={after !== undefined ? "added" : "removed"} room={room} />
      </View>
    );
  }

  return (
    <View onLayout={measure}>
      <View flexDirection="row" justifyContent="flex-end" paddingBottom={4}>
        <Toggle
          label="How to compare the images"
          options={[
            ["overlay", "Overlay", "Stacked, with the new one fading in — shows WHERE they differ"],
            ["split", "Side by side", "Two columns — shows what each version is"],
          ]}
          value={layout}
          onPick={(next) => onLayout(next as ImageLayout)}
        />
        {layout === "overlay" ? (
          <View flexDirection="row" alignItems="center" gap={6}>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>before</Txt>
            <Range min={0} max={1} step={0.01} value={mix} label="Fade between the two versions" onChange={setMix} width={140} />
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>after</Txt>
          </View>
        ) : null}
      </View>
      {layout === "split" ? (
        <View flexDirection="row" gap={10}>
          <Column src={before} caption="before" />
          <Column src={after} caption="after" />
        </View>
      ) : (
        <Stack before={before} after={after} mix={mix} room={room} t={t} />
      )}
    </View>
  );
}

/** One of the split's two equal columns, measured so its picture knows the room it has. */
function Column({ src, caption }: { src: string; caption: string }): JSX.Element {
  const [room, setRoom] = useState<number | null>(null);
  return (
    <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)}>
      <Figure src={src} alt={caption} caption={caption} room={room} />
    </View>
  );
}

/** A figure: the picture over its caption, 4 apart, both at the start. */
function Figure({ src, alt, caption, room }: { src: string; alt: string; caption: string; room: number | null }): JSX.Element {
  const natural = useNatural(src);
  const size = natural === null || room === null ? null : fitted(natural, room);
  return (
    <View flexDirection="column" gap={4} alignItems="flex-start">
      {size === null ? null : <Framed src={src} alt={alt} width={size.width} height={size.height} />}
      <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>{caption}</Txt>
    </View>
  );
}

/** The stack: the old picture in its line over the checkerboard, the new one over it at `mix`. */
function Stack({ before, after, mix, room, t }: { before: string; after: string; mix: number; room: number | null; t: Tokens }): JSX.Element {
  const natural = useNatural(before);
  if (natural === null || room === null) return <View />;
  const img = fitted(natural, room);
  // The line an inline picture sits in: its bottom on the baseline, the strut's half-leading and descent
  // under it, and the strut's top over it when the picture is shorter than that.
  // Chromium gives the ascent the leading's half floored to a whole pixel and the descent the rest.
  const s = Number(t.scaled("size-app", 13 / 12.5)) || 13;
  const line = 1.5 * s;
  const above = Math.round(s * ASCENT) + Math.floor((line - (Math.round(s * ASCENT) + Math.round(s * DESCENT))) / 2);
  const top = Math.max(0, above - img.height);
  const height = top + img.height + (line - above);
  return (
    <View position="relative" width={img.width} height={height} overflow="hidden" {...(isWeb ? (checkerWeb(t) as object) : {})}>
      {isWeb ? null : <Checker width={img.width} height={height} ink={String(t.v("panel-2"))} />}
      <View position="absolute" left={0} top={top}>
        <Framed src={before} alt="before" width={img.width} height={img.height} />
      </View>
      <View position="absolute" left={0} top={0} opacity={mix}>
        <Framed src={after} alt="after" width={img.width} height={height} />
      </View>
    </View>
  );
}

/** The four 45° gradients, tiled at 16 (web). */
function checkerWeb(t: Tokens): Record<string, unknown> {
  const p = String(t.v("panel-2"));
  return {
    backgroundImage: `linear-gradient(45deg, ${p} 25%, transparent 25%), linear-gradient(-45deg, ${p} 25%, transparent 25%), linear-gradient(45deg, transparent 75%, ${p} 75%), linear-gradient(-45deg, transparent 75%, ${p} 75%)`,
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
  };
}

/** The same checkerboard as views (a phone): an 8-square of --panel-2 wherever its row and column differ in parity. */
function Checker({ width, height, ink }: { width: number; height: number; ink: string }): JSX.Element {
  const squares: JSX.Element[] = [];
  for (let y = 0; y * 8 < height; y += 1) {
    for (let x = 0; x * 8 < width; x += 1) {
      if ((x + y) % 2 === 1) squares.push(<View key={`${x}-${y}`} position="absolute" left={x * 8} top={y * 8} width={8} height={8} backgroundColor={ink as never} />);
    }
  }
  return (
    <View position="absolute" left={0} top={0} width={width} height={height} pointerEvents="none">
      {squares}
    </View>
  );
}

/** An `img` with its ring: `width` × `height` border-box, the picture stretched to the inside of it. */
function Framed({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }): JSX.Element {
  const t = useTokens();
  return (
    <View width={width} height={height} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={4} overflow="hidden">
      <Img src={src} alt={alt} style={{ width: "100%", height: "100%" }} />
    </View>
  );
}

/** A picture's box: its natural size and ring, no wider than the room. */
function fitted(natural: { width: number; height: number }, room: number): { width: number; height: number } {
  // The ring as Chromium lays it out (whole device pixels: 0.667 at 1.5×), not the 1 it was asked for.
  const ring = ringWidth();
  const width = Math.min(natural.width + 2 * ring, room);
  const inner = Math.max(0, width - 2 * ring);
  return { width, height: (natural.width > 0 ? (inner * natural.height) / natural.width : 0) + 2 * ring };
}

/** A picture's natural size, once it is known — nothing before, as an `img` still decoding. */
function useNatural(src: string): { width: number; height: number } | null {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let live = true;
    naturalSizeOf(
      src,
      (width, height) => live && setNatural({ width, height }),
      () => live && setNatural(null),
    );
    return () => {
      live = false;
    };
  }, [src]);
  return natural;
}
