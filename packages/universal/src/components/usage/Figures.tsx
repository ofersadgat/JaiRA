import { useRef, useState, type JSX, type ReactNode } from "react";
import { View as RNView } from "react-native";
import { View } from "@tamagui/core";
import type { LimitAccountView, UsageFigures } from "@jaira/shared/browser";
import { formatResetAt, formatUntil } from "@jaira/shared/browser";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { useLimits, useNow, useUsageFigures } from "@jaira/ui/limitsStore";
import { USAGE_PREVIEW_EXAMPLES, keyFigureOf, weeklyFigureOf, weeklyTitleOf, type UsageFigure } from "@jaira/ui/usageFigure";
import { NO_STACK, Press, Txt, edge } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { AccountCard } from "../chat/UsageCards";
import { BrandIcon } from "../settings/bits";
import { INK, MoneyRing, Ring } from "./Ring";

/**
 * The usage figures on Connections: {@link AccountAllowance} (a sign-in card's weekly figure and when
 * it resets) and {@link KeyUsage} (what an API key has spent). What each says is `usageFigure.ts`'s;
 * the ring is the composer's (`Ring.tsx`). How they look:
 *
 *   the line          row, centred, gap 6, at least 22 tall, 32 in, app 11/12.5
 *   the line under    0 in, to the right, 3 closer, no least height
 *   the plan          --dim, one line
 *   the ring's wrap   to the right (`margin-left: auto`)
 *   the ring button   row, centred, gap 5, padding 2 5, radius 11, data 500 10.5px/1, tabular; hovered
 *                     --fill-ghost-selected; the tone's colour (`INK`; accent --text); money with
 *                     the accent tone --text, `none` --dim
 *   the reset words   data 10.5px/1.3 --dim, one line; used up --bad at 500
 *   a key's line      4 apart, the button 5 out to the left; "in the last 7 days" app 10.5/12.5 --dim
 *
 * The figure opens the account's card (330 wide, its end on the button's), the composer's own
 * {@link AccountCard}.
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

/** The account's card, opened from its figure's button: measured where the button stands when pressed. */
function useAccountCard(account: LimitAccountView | undefined): { at: React.RefObject<RNView | null>; open: () => void; shown: boolean; layer: JSX.Element | null } {
  const limits = useLimits();
  const at = useRef<RNView>(null);
  const [anchor, setAnchor] = useState<FloatRect | null>(null);
  return {
    at,
    open: () => at.current?.measureInWindow((x, y, w, h) => setAnchor({ left: x, top: y, right: x + w, bottom: y + h })),
    shown: anchor !== null && account !== undefined,
    layer:
      anchor === null || account === undefined ? null : (
        <AccountCard anchor={anchor} account={account} others={limits.accounts.filter((a) => a.key !== account.key)} width={330} align="end" onClose={() => setAnchor(null)} />
      ),
  };
}

/** The colour of a ring button's number: the tone's (`INK`), with the accent tone (and money's) --text. */
function inkOf(figure: UsageFigure): string {
  return figure.tone === "accent" ? "text" : INK[figure.tone];
}

/** The ring button: the figure, pressed to open the account; hovered or open its ground lit. */
function RingButton({ figure, mode, title, at, on, onPress, marginLeft }: { figure: UsageFigure; mode: UsageFigures; title: string; at: React.RefObject<RNView | null>; on: boolean; onPress: () => void; marginLeft?: number }): JSX.Element {
  const t = useTokens();
  const face = { voice: "data" as const, scale: 10.5 / 12, weight: 500, color: inkOf(figure), tabular: true, lineHeight: { px: 10.5 } };
  return (
    <RNView ref={at} collapsable={false} style={{ flexShrink: 0, ...NO_STACK, ...(marginLeft !== undefined ? { marginLeft } : {}) } as never}>
    <Press
      onPress={onPress}
      title={title}
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingVertical={2}
      paddingHorizontal={5}
      borderRadius={11}
      {...({ "aria-expanded": on } as object)}
      box={({ hovered }) => ({ backgroundColor: hovered || on ? t.v("fill-ghost-selected") : "transparent" })}
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
    </RNView>
  );
}

/**
 * The ring button's wrap: a block on the line's baseline — its height the line of the app face at 11/12.5,
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

/** The line under a figure: when the week resets, or what a key's figure is. */
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
  const card = useAccountCard(account);
  const { week, spent, pct, figure } = weeklyFigureOf(account);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={6} minHeight={22} paddingLeft={32}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={0}>
          {plan}
        </Txt>
        {account !== undefined && mode !== "off" ? (
          <RingWrap>
            <RingButton figure={figure} mode={mode} title={weeklyTitleOf(week, pct)} at={card.at} on={card.shown} onPress={card.open} />
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
  const card = useAccountCard(account);
  if (account === undefined || account.kind === "subscription" || mode === "off") return null;
  const { credit, figure, under, refused } = keyFigureOf(account, now);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={4} minHeight={22} paddingLeft={32}>
        <RingWrap>
          <RingButton figure={figure} mode={credit ? mode : "number"} title={`${figure.title} — click for more`} at={card.at} on={card.shown} onPress={card.open} marginLeft={-5} />
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

/**
 * The setting's preview (`UsageFiguresPreview`): the composer's model chip and its figure, on a
 * subscription, a key whose provider reports its credit, and a key whose provider does not — drawn in
 * the mode being chosen. The examples are `usageFigure.ts`'s. How it looks:
 *
 *   the preview          --bg, 1px --line, radius 10, 10 above it: three equal columns, gap 10,
 *                        padding 12
 *   a cell               column, gap 6 — at least its column wide, and past it to its content
 *   its name             app 11.5/12.5 --dim
 *   the mini composer    the composer's frame: --bg, padding 10 16 14; the frame padding 1 on --line,
 *                        radius 22; the shell --panel, radius 21; the foot a row, centred, gap 5,
 *                        padding 5 7 7 8
 *   the model chip       padding 3 9, 1px transparent, round, gap 5, app 11.5/12.5 --dim; its icon 13;
 *                        its words at most 96
 *   the number           data 500 11/12 on a line of 1, padding 2 5, 2 out on the left, on the body's
 *                        19.5 line; --dim for the accent tone (money: --text)
 */
export function UsageFiguresPreview({ mode }: { mode: UsageFigures }): JSX.Element {
  const t = useTokens();
  return (
    <View
      marginTop={10}
      flexDirection="row"
      gap={10}
      padding={12}
      borderRadius={10}
      overflow="hidden"
      backgroundColor={t.v("bg") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      pointerEvents="none"
      aria-hidden
    >
      {USAGE_PREVIEW_EXAMPLES.map((e) => (
        <View key={e.brand} flex={1} flexBasis={0} minWidth={0} flexDirection="row">
          <View flexDirection="column" gap={6} minWidth="100%" flexShrink={0}>
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{`${e.brand} · ${e.label}`}</Txt>
            <MiniComposer brand={e.brand} model={e.model} figure={e.figure} mode={mode} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The composer's frame around its foot: the model chip and the figure, and nothing else. */
function MiniComposer({ brand, model, figure, mode }: { brand: string; model: string; figure: UsageFigure; mode: UsageFigures }): JSX.Element {
  const t = useTokens();
  const line = Number(t.scaled("size-app", (13 / 12.5) * 1.5));
  // The number in the accent tone is --dim; money's accent --text, and `none` --dim.
  const ink = figure.tone === "accent" ? (figure.money ? "text" : "dim") : INK[figure.tone];
  const face = { voice: "data" as const, scale: 11 / 12, weight: 500, color: ink, tabular: true, lineHeight: 1 };
  return (
    <View backgroundColor={t.v("bg") as never} paddingTop={10} paddingHorizontal={16} paddingBottom={14}>
      <View width="100%" padding={1} borderRadius={22} backgroundColor={t.v("line") as never}>
        <View flexDirection="column" borderRadius={21} backgroundColor={t.v("panel") as never}>
          <View flexDirection="row" alignItems="center" gap={5} paddingTop={5} paddingRight={7} paddingBottom={7} paddingLeft={8} minWidth={0}>
            <View flexDirection="row" alignItems="center" gap={5} paddingVertical={3} paddingHorizontal={9} borderRadius={999} borderWidth={1} borderStyle="solid" borderColor="transparent" maxWidth={210} minWidth={0} flexShrink={0}>
              <BrandIcon name={brand} size={13} ink="tok-hint" />
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} ellip maxWidth={96}>
                {model}
              </Txt>
            </View>
            {mode !== "off" ? (
              <View flexShrink={0} marginLeft={-2} {...(Number.isFinite(line) ? { height: line } : {})}>
                <View marginTop={3} flexDirection="row" alignItems="center" gap={5} paddingVertical={2} paddingHorizontal={5}>
                  <FigureFace t={t} figure={figure} mode={mode} text={<Txt spec={face}>{figure.text}</Txt>} />
                </View>
              </View>
            ) : null}
            <View flex={1} minWidth={0} />
          </View>
        </View>
      </View>
    </View>
  );
}
