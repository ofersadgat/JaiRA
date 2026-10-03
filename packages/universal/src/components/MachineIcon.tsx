import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { MachineFace } from "@jaira/ui/environmentModel";
import { MACHINE_ANCHORS, MACHINE_MARKS, MACHINE_SHAPES, WORK_RING, machineIconAt, machineIconSizes } from "@jaira/ui/machineIcons";
import { Txt } from "../primitives";
import { useTokens } from "../tokens";
import { Svg } from "./panel/Svg";

/**
 * A machine, wherever one is named (decision 0013 §5): the bar under the composer, the chip beside the
 * title, the list of where a conversation can run, a placement's rows. What it is — a desktop, a laptop,
 * a mini, a server, a phone — is the shape; what it runs is a mark on the shape's bottom-right corner;
 * whether it can be reached is a dot on its top-right one. The data is `machineIcons.ts`'s. How it looks:
 *
 *   the shape        `size` square, stroked 1.7 on a 24 grid in the colour given (--text); dashed while
 *                    nothing is decided
 *   the mark         0.44 of the size (7 at least), centred on the shape's bottom-right corner, --dim,
 *                    with no ground of its own: the shape shows through it
 *   the dot          0.3 of the size (5 at least), centred on the shape's top-right corner; --ok
 *                    connected, --warn connecting, --bad not; ringed in the ground it stands on
 *   its room         the mark runs past the shape's right edge: half its width is kept clear there
 */
export function MachineIcon({ face, size = 16, color, ground = "panel" }: { face: MachineFace; size?: number; color?: string; /** The colour under the icon, by token or value: the dot's ring. */ ground?: string }): JSX.Element {
  const t = useTokens();
  const shape = MACHINE_SHAPES[face.shape];
  const [dotX, dotY, markX, markY] = MACHINE_ANCHORS[face.shape];
  const sizes = machineIconSizes(size);
  const ink = color ?? String(t.v(face.shape === "auto" ? "dim" : "text"));
  const mark = face.mark !== undefined ? MACHINE_MARKS[face.mark] : undefined;
  const under = /^[a-z][a-z0-9-]*$/.test(ground) ? String(t.v(ground)) : ground;
  return (
    <View position="relative" width={size} height={size} flexShrink={0} marginRight={mark !== undefined ? sizes.room : 1}>
      <Svg width={size} height={size} color={ink} shapes={shape.paths.map((d) => ({ kind: "path" as const, d, ...(shape.dash !== undefined ? { dash: shape.dash } : {}) }))} />
      {mark !== undefined ? (
        <View position="absolute" {...machineIconAt(size, markX, markY, sizes.mark)} width={sizes.mark} height={sizes.mark}>
          <Svg
            width={sizes.mark}
            height={sizes.mark}
            color={String(t.v("dim"))}
            {...(mark.viewBox !== undefined ? { viewBox: mark.viewBox } : {})}
            {...(mark.stroked === true ? { strokeWidth: 2.2 } : { fill: "currentColor", strokeWidth: 0 })}
            shapes={mark.paths.map((d) => ({ kind: "path" as const, d }))}
          />
        </View>
      ) : null}
      {face.dot !== undefined ? (
        <View
          position="absolute"
          {...machineIconAt(size, dotX, dotY, sizes.dot)}
          width={sizes.dot}
          height={sizes.dot}
          borderRadius={999}
          backgroundColor={t.v(face.dot === "on" ? "ok" : face.dot === "slow" ? "warn" : "bad") as never}
          {...({ boxShadow: `0px 0px 0px ${sizes.ring}px ${under}` } as object)}
        />
      ) : null}
    </View>
  );
}

/**
 * Work in progress (`WORK_RING`): an open ring in --accent with the number of tasks inside it — the ones
 * at work and the ones waiting, together. How it looks:
 *
 *   the ring         `size` square (18), stroked 2.6 on a 24 grid, --accent; the short stroke in its gap at .25
 *   the number       centred, app 700 at 0.48 of the size, --text, tabular
 */
export function WorkRing({ count, size = 18, title }: { count: number; size?: number; title?: string }): JSX.Element {
  const t = useTokens();
  const px = Math.round(size * 0.48 * 10) / 10;
  return (
    <View position="relative" width={size} height={size} flexShrink={0} alignItems="center" justifyContent="center" {...((title !== undefined ? { title } : {}) as object)}>
      <View position="absolute" left={0} top={0}>
        <Svg width={size} height={size} color={String(t.v("accent"))} strokeWidth={2.6} shapes={WORK_RING.map((s) => ({ kind: "path" as const, d: s.d, ...(s.opacity !== undefined ? { opacity: s.opacity } : {}) }))} />
      </View>
      <Txt spec={{ voice: "app", scale: 1, weight: 700, color: "text", tabular: true, lineHeight: { px: size } }} fontSize={px} textAlign="center">
        {String(count)}
      </Txt>
    </View>
  );
}
