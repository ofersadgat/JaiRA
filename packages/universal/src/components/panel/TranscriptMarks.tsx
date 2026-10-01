import type { JSX } from "react";
import { View } from "@tamagui/core";
import { formatTokens } from "@jaira/shared/browser";
import type { Gap } from "@jaira/ui/transcript";
import { Txt, edge } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { Icon } from "./Icon";

/**
 * The marks between a transcript's blocks: the pause before a block (`GapMark`), a compaction
 * (`CompactionLine`) and the day chip over the scroller (`DayChip`). How they look:
 *
 *   a gap            centred, data 10/12, 0.05em, --dim at .66;  minutes margin 20 0 16;  hours 34 0 28;
 *                    a day 52 0 44, .82, 500, 0.09em, upper
 *   a compaction     row, wrapping, centred, gap 8, margin 6 0, padding 6 10, dashed --rule over and
 *                    under, app 12/12.5 --dim; the fold 1em; the figures data 500 11.5px --text; the
 *                    sub 11.5px
 *   the day chip     padding 3 12, 1px --line, round, --panel 88% (blurred behind), data 10/12, tabular,
 *                    0.05em, --dim, 0 2 10 rgba(20,26,38,.08) (dark 0 2 12 rgba(0,0,0,.45)), 4 down;
 *                    at .34 at rest, whole while the reader scrolls
 */
export function GapMark({ gap }: { gap: Gap }): JSX.Element {
  const day = gap.size === "day";
  const margin = gap.size === "mins" ? [20, 16] : gap.size === "hours" ? [34, 28] : [52, 44];
  return (
    <Txt
      spec={{ voice: "data", scale: 10 / 12, ls: day ? 0.09 : 0.05, color: "dim", ...(day ? { weight: 500, upper: true } : {}) }}
      alignSelf="center"
      marginTop={margin[0]}
      marginBottom={margin[1]}
      opacity={day ? 0.82 : 0.66}
      userSelect="none"
    >
      {gap.label}
    </Txt>
  );
}

/**
 * `CompactionLine`: a compaction, as a line of its own — what the context went from and to, and what
 * caused it (the agent's own report, or only that the context got smaller).
 */
export function CompactionLine({
  trigger,
  before,
  after,
  durationMs,
  window,
  derived,
}: {
  trigger?: string | undefined;
  before?: number | undefined;
  after?: number | undefined;
  durationMs?: number | undefined;
  window?: number | null | undefined;
  derived?: boolean | undefined;
}): JSX.Element {
  const t = useTokens();
  const round = Math.round;
  const pct = (n: number | undefined): string | undefined => (n === undefined ? undefined : window !== null && window !== undefined && window > 0 ? `${round((n / window) * 100)}%` : formatTokens(n, true));
  const from = pct(before);
  const to = pct(after);
  const sub =
    derived === true
      ? "the context got smaller — the agent didn't say why"
      : trigger === "manual"
        ? "compacted at your request"
        : `compacted automatically${before !== undefined ? ` at ${formatTokens(before, true)}` : ""}${durationMs !== undefined ? ` · took ${round(durationMs / 1000)} s` : ""}`;
  const size = Number(t.scaled("size-app", 12 / 12.5)) || 12;
  const words = { voice: "app" as const, scale: 12 / 12.5, color: "dim" };
  // A fixed 11.5px, not a scale of the app's size.
  const px = 11.5 / (Number(t.scaled("size-app", 1)) || 12.5);
  return (
    <View
      role="note"
      flexDirection="row"
      flexWrap="wrap"
      alignItems="center"
      gap={8}
      marginVertical={6}
      paddingVertical={6}
      paddingHorizontal={10}
      {...(edge(t, { top: 1, bottom: 1 }, "rule", "dashed") as object)}
    >
      <Icon name="fold" size={size} color={String(t.v("dim"))} />
      <Txt spec={words}>
        context{" "}
        <Txt spec={{ voice: "data", scale: 11.5 / (Number(t.scaled("size-data", 1)) || 12), weight: 500, color: "text" }}>
          {from ?? "?"} → {to ?? "?"}
        </Txt>
      </Txt>
      <Txt spec={{ ...words, scale: px }}>
        {sub}
      </Txt>
    </View>
  );
}

/** `DayChip`: which day the reader is looking at, floating over the top of the transcript. */
export function DayChip({ day, moving }: { day: string | null; moving: boolean }): JSX.Element | null {
  const t = useTokens();
  const look = useLook();
  if (day === null) return null;
  return (
    <View {...({ position: "sticky" } as object)} top={0} zIndex={3} height={0} flexShrink={0} flexDirection="row" justifyContent="center" alignItems="flex-start" pointerEvents="none" aria-hidden>
      <View
        transform={[{ translateY: 4 }]}
        paddingVertical={3}
        paddingHorizontal={12}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.v("line") as never}
        borderRadius={999}
        backgroundColor={t.mix(t.v("panel"), 88, "transparent") as never}
        opacity={moving ? 1 : 0.34}
        {...({ boxShadow: look.scheme === "dark" ? "0px 2px 12px rgba(0, 0, 0, 0.45)" : "0px 2px 10px rgba(20, 26, 38, 0.08)", backdropFilter: "blur(6px)", transition: "opacity 0.25s ease" } as object)}
      >
        <Txt spec={{ voice: "data", scale: 10 / 12, ls: 0.05, color: "dim", tabular: true }} numberOfLines={1}>
          {day}
        </Txt>
      </View>
    </View>
  );
}
