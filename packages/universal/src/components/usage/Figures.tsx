import { useState, type JSX, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";
import { View } from "@tamagui/core";
import type { LimitAccountView, UsageFigures } from "@jaira/shared/browser";
import { formatResetAt, formatUntil } from "@jaira/shared/browser";
import { useNow, useUsageFigures } from "@jaira/ui/limitsStore";
import { keyFigureOf, weeklyFigureOf, weeklyTitleOf, type UsageFigure } from "@jaira/ui/usageFigure";
import { Uncopied } from "../../app/Uncopied";
import { Press, Txt } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { INK, MoneyRing, Ring } from "./Ring";

/**
 * `usageMeters.tsx`'s figures on Connections, universal (decision 0015): {@link AccountAllowance} (a
 * sign-in card's weekly figure and when it resets) and {@link KeyUsage} (what an API key has spent).
 * What each says is `usageFigure.ts`'s, as the desktop's is; the ring is the composer's (`Ring.tsx`).
 * The rules:
 *
 *   .um-c-line        row, centred, gap 6, at least 22 tall, 32 in, app 11/12.5
 *   .um-c-line2       0 in, to the right, 3 closer, no least height
 *   .um-c-plan        --dim, one line
 *   .um-c-ringwrap    to the right (`margin-left: auto`)
 *   .um-c-ringbtn     row, centred, gap 5, padding 2 5, radius 11, data 500 10.5px/1, tabular; hovered
 *                     --fill-ghost-selected; the tone's colour (`.um-t-*`; accent --text); money with
 *                     the accent tone --text, `none` --dim
 *   .um-rs            data 10.5px/1.3 --dim, one line; used up --bad at 500
 *   .um-k-line        4 apart, the button 5 out to the left; `.um-k-when` app 10.5/12.5 --dim
 *
 * The account's card the figure opens (`AccountPopover`) is {@link Uncopied}: a note where it would stand.
 */

/** The figure's face, in the mode the setting says: the number, the ring, or both. */
export function FigureFace({ t, figure, mode, text }: { t: Tokens; figure: UsageFigure; mode: UsageFigures; text: ReactNode }): JSX.Element {
  const ring = figure.money ? <MoneyRing t={t} pct={figure.pct} tone={figure.tone} /> : <Ring t={t} pct={figure.pct} tone={figure.tone} size={16} />;
  if (mode === "ring") return ring;
  if (mode === "both")
    return (
      <>
        {ring}
        {text}
      </>
    );
  return <>{text}</>;
}

/** Where an uncopied card would open, and the note that stands there — the composer's way (`Composer.tsx`). */
export function useUncopiedCard(name: string): { open: (e: GestureResponderEvent) => void; layer: JSX.Element | null } {
  const t = useTokens();
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return {
    open: (e) => setAt({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }),
    layer:
      at === null ? null : (
        <MenuLayer onClose={() => setAt(null)}>
          <View position="absolute" left={Math.max(4, at.x - 120)} top={Math.max(4, at.y - 80)} width={240} backgroundColor={t.v("panel") as never}>
            <Uncopied name={name} height={60} />
          </View>
        </MenuLayer>
      ),
  };
}

/** The colour of a ring button's number: `.um-t-*`, with `.um-c-ringbtn.um-t-accent` (and money's) --text. */
function inkOf(figure: UsageFigure): string {
  return figure.tone === "accent" ? "text" : INK[figure.tone];
}

/** `.um-c-ringbtn`: the figure, pressed to open the account. */
function RingButton({ figure, mode, title, onPress, marginLeft }: { figure: UsageFigure; mode: UsageFigures; title: string; onPress: (e: GestureResponderEvent) => void; marginLeft?: number }): JSX.Element {
  const t = useTokens();
  const face = { voice: "data" as const, scale: 10.5 / 12, weight: 500, color: inkOf(figure), tabular: true, lineHeight: { px: 10.5 } };
  return (
    <Press
      onPress={onPress}
      title={title}
      flexShrink={0}
      {...(marginLeft !== undefined ? { marginLeft } : {})}
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingVertical={2}
      paddingHorizontal={5}
      borderRadius={11}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-selected") : "transparent" })}
    >
      <FigureFace
        t={t}
        figure={figure}
        mode={mode}
        text={
          <Txt spec={face} fontSize={10.5} numberOfLines={1}>
            {figure.text}
          </Txt>
        }
      />
    </Press>
  );
}

/**
 * `.um-c-ringwrap`: a block on the line's baseline — its height the line of the app face at 11/12.5,
 * the button 0.65 down in it, where the mono number's baseline meets the line's (measured).
 */
function RingWrap({ children, auto = true }: { children: ReactNode; auto?: boolean }): JSX.Element {
  const t = useTokens();
  const line = Number(t.scaled("size-app", (11 / 12.5) * 1.5));
  return (
    <View flexShrink={0} {...(auto ? { marginLeft: "auto" } : {})} {...(Number.isFinite(line) ? { height: line } : {})}>
      <View marginTop={0.65}>{children}</View>
    </View>
  );
}

/** `.um-rs`: when the week resets, or what a key's figure is. */
function ResetLine({ children, spent, title }: { children: ReactNode; spent: boolean; title?: string | undefined }): JSX.Element {
  return (
    <View flexDirection="row" justifyContent="flex-end" alignItems="center" marginTop={-3}>
      <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: spent ? 500 : 400, color: spent ? "bad" : "dim", tabular: true, lineHeight: { px: 13.65 } }} fontSize={10.5} numberOfLines={1} {...(title !== undefined ? { title } : {})}>
        {children}
      </Txt>
    </View>
  );
}

/**
 * A sign-in card's allowance: the plan, the WEEKLY window's figure — a number, a ring or both, as
 * `appearance.conversation.usageFigures` says, nothing when it says `off` — and when that week resets.
 */
export function AccountAllowance({ account, plan }: { account: LimitAccountView | undefined; plan?: ReactNode }): JSX.Element {
  const mode = useUsageFigures();
  const now = useNow();
  const card = useUncopiedCard("the account card");
  const { week, spent, pct, figure } = weeklyFigureOf(account);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={6} minHeight={22} paddingLeft={32}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={0}>
          {plan}
        </Txt>
        {account !== undefined && mode !== "off" ? (
          <RingWrap>
            <RingButton figure={figure} mode={mode} title={weeklyTitleOf(week, pct)} onPress={card.open} />
          </RingWrap>
        ) : null}
      </View>
      {mode !== "off" && week !== undefined && week.resetsAt !== null ? (
        <ResetLine spent={spent} title={formatUntil(week.resetsAt, now)}>{`Weekly · resets ${formatResetAt(week.resetsAt, now)}`}</ResetLine>
      ) : null}
      {card.layer}
    </>
  );
}

/**
 * An API key's box: what is spent — the credit used, in the tone of its share, or what JaiRA's calls
 * on the key cost in the last seven days, grey — and on the line under it what that is.
 */
export function KeyUsage({ account }: { account: LimitAccountView | undefined }): JSX.Element | null {
  const mode = useUsageFigures();
  const now = useNow();
  const card = useUncopiedCard("the account card");
  if (account === undefined || account.kind === "subscription" || mode === "off") return null;
  const { credit, figure, under, refused } = keyFigureOf(account, now);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={4} minHeight={22} paddingLeft={32}>
        <RingWrap>
          <RingButton figure={figure} mode={credit ? mode : "number"} title={`${figure.title} — click for more`} onPress={card.open} marginLeft={-5} />
        </RingWrap>
        {credit ? null : (
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={0}>
            in the last 7 days
          </Txt>
        )}
      </View>
      <ResetLine spent={refused}>{under}</ResetLine>
      {card.layer}
    </>
  );
}
