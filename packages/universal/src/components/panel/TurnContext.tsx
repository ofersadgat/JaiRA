import { useRef, useState, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { contextFill, formatTokens, toneOfContext, type ContextReading } from "@jaira/shared/browser";
import { colourOf } from "@jaira/ui/contextParts";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { colorOf } from "../Sidebar";
import { Float } from "../floats/Float";
import { MenuLayer } from "../MenuLayer";
import { Ring } from "../usage/Ring";
import { HoverLayer } from "./HoverLayer";

/**
 * `usageMeters.tsx`'s `TurnContext`, universal (decision 0015): on an answer's rail, how full the
 * conversation was after it — the ring and its figure, and the breakdown on hover (a press on a phone).
 * The colours of the breakdown are `contextParts.ts`'s, the desktop's own. The rules:
 *
 *   .um-turn        row, centred, gap 4, padding 3 4, radius 5, data 500 10.5/12 on 1, tabular, --dim
 *                   (warn: the figure --warn); hovered --fill-ghost-hover. The ring 12, 3.2 wide.
 *   .um-tip         280 wide, column, gap 7, padding 10 12, --panel, 1px --line, radius 9,
 *                   0 6 18 rgba(18,21,48,.14), app 12/12.5 on 1.4, --text; above the badge, at its end
 *   .um-stack       7 tall, radius 4, clipped, --dim 16%, gap 1
 *   .um-tip-row     --dim, 11.5px (.mono data 10.5px)
 */
export function TurnContext({ context, before, route }: { context: ContextReading; before?: ContextReading | undefined; route?: string | undefined }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<FloatRect | null>(null);
  const anchor = useRef<unknown>(null);
  const fill = contextFill(context, route);
  const tone = toneOfContext(fill);
  const prior = before !== undefined ? contextFill(before, route) : null;
  const window = context.window;
  const parts = context.breakdown ?? [];
  const figure = fill === null ? formatTokens(context.used, true) : `${Math.round(fill)}%`;
  const show = (): void => {
    const el = anchor.current as { getBoundingClientRect?: () => DOMRect } | null;
    if (el?.getBoundingClientRect !== undefined) {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    setOpen(true);
  };
  const face = { voice: "data" as const, scale: 10.5 / 12, weight: 500, tabular: true, lineHeight: 1 };
  const words = { voice: "app" as const, scale: 12 / 12.5, color: "text", lineHeight: 1.4 };
  const px = (n: number, voice: "app" | "data"): number => n / (Number(t.scaled(`size-${voice}`, 1)) || (voice === "app" ? 12.5 : 12));
  const tip = (
    <Float
      anchor={rect ?? { left: 0, top: 0, right: 0, bottom: 0 }}
      side="above"
      align="end"
      width={280}
      flexDirection="column"
      gap={7}
      paddingVertical={10}
      paddingHorizontal={12}
      backgroundColor={t.v("panel") as never}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.v("line") as never}
      borderRadius={9}
      pointerEvents="none"
      {...({ boxShadow: "0px 6px 18px rgba(18, 21, 48, 0.14)" } as object)}
    >
      <Txt spec={words}>
        <Txt spec={{ ...words, voice: "data", scale: px(Number(t.scaled("size-app", 12 / 12.5)) || 12, "data"), weight: 700, color: tone === "warn" ? "warn" : "text" }}>{figure}</Txt> after this reply ·{" "}
        {window !== null ? `${formatTokens(context.used)} of ${formatTokens(window)}` : `${formatTokens(context.used)} tokens`}
      </Txt>
      {window !== null ? (
        <View flexDirection="row" height={7} borderRadius={4} overflow="hidden" gap={1} backgroundColor={t.mix(t.v("dim"), 16, "transparent") as never}>
          {parts.length > 0 ? (
            parts.map((p, k) => <View key={p.name} width={`${(p.tokens / window) * 100}%`} backgroundColor={colorOf(t, colourOf(p.name, k)) as never} />)
          ) : (
            <View width={`${(context.used / window) * 100}%`} backgroundColor={t.v("accent") as never} />
          )}
        </View>
      ) : null}
      {fill !== null && prior !== null ? (
        <Txt spec={{ ...words, scale: px(11.5, "app"), color: "dim" }}>
          {fill >= prior ? "+" : "−"}
          {Math.round(Math.abs(fill - prior))}% since the reply before
        </Txt>
      ) : null}
      <Txt spec={{ ...words, voice: "data", scale: px(10.5, "data"), color: "dim" }}>{context.model}</Txt>
    </Float>
  );
  return (
    <>
      <View
        ref={anchor as never}
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        gap={4}
        paddingVertical={3}
        paddingHorizontal={4}
        borderRadius={5}
        backgroundColor={(open ? t.v("fill-ghost-hover") : "transparent") as never}
        aria-label={fill === null ? `${formatTokens(context.used)} tokens in context after this reply` : `${Math.round(fill)}% of the context after this reply`}
        {...(isWeb ? { onMouseEnter: show, onMouseLeave: () => setOpen(false) } : { onPress: show })}
      >
        <Ring t={t} pct={fill} tone={tone} size={12} width={3.2} />
        <Txt spec={{ ...face, color: tone === "warn" ? "warn" : "dim" }} numberOfLines={1}>
          {figure}
        </Txt>
      </View>
      {open ? isWeb ? <HoverLayer>{tip}</HoverLayer> : <MenuLayer onClose={() => setOpen(false)}>{tip}</MenuLayer> : null}
    </>
  );
}
