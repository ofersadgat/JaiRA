import type { JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { layoutPills, type PillCounts } from "@jaira/ui/pill";
import { Press, Txt } from "../primitives";
import { useTokens } from "../tokens";
import { Pill } from "./Pill";

/**
 * `pill.tsx`'s `Pills`, universal (decision 0015): as many pills as `budget` pixels hold, most urgent
 * first, and a `+N` for the rest tinted to the worst thing it hides. The same `layoutPills` decides.
 *
 *   .pills             inline-flex, centred, gap 3, flex none; a button when it clears (`onClear`)
 *   .pill.pill-more    flat: no ground, padding 1 3, weight 500, colour --pill-c (the worst kind)
 *                      or --tok-hint, line-height 15px, data voice at 0.8, tabular digits
 */
const INK: Record<string, string> = { running: "accent", waiting: "warn", error: "bad", warning: "warn", success: "ok" };

export function Pills({
  counts,
  budget,
  onClear,
  clearTitle = "mark these seen",
}: {
  counts: PillCounts;
  budget: number;
  /** Handed the pills' own element on web (a card is placed against it); a phone has none to hand. */
  onClear?: ((from?: HTMLElement) => void) | undefined;
  clearTitle?: string;
}): JSX.Element | null {
  const t = useTokens();
  const { fit, rest, worst } = layoutPills(counts, budget);
  if (fit.length === 0) return null;
  const inner = (
    <>
      {fit.map(({ kind, n }) => (
        <Pill key={kind} kind={kind} n={n} title={`${n} ${kind}`} />
      ))}
      {rest > 0 ? (
        <View flexDirection="row" alignItems="center" paddingVertical={1} paddingHorizontal={3} flexShrink={0}>
          <Txt spec={{ voice: "data", scale: 0.8, weight: 500, lineHeight: { px: 15 }, tabular: true, color: worst === null ? "tok-hint" : INK[worst] }} whiteSpace="nowrap" {...({ title: `${rest} more` } as object)}>
            +{rest}
          </Txt>
        </View>
      ) : null}
    </>
  );
  const row = { flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 } as const;
  if (onClear === undefined) return <View {...row}>{inner}</View>;
  void t;
  return (
    <Press onPress={(e) => onClear(isWeb ? (e as unknown as { currentTarget: HTMLElement }).currentTarget : undefined)} title={clearTitle} label={clearTitle} {...row}>
      {inner}
    </Press>
  );
}
