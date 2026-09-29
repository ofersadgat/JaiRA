import { useState, type JSX, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";
import { View } from "@tamagui/core";
import type { LimitAccountView, UsageFigures } from "@jaira/shared/browser";
import { formatResetAt, formatUntil } from "@jaira/shared/browser";
import { useNow, useUsageFigures } from "@jaira/ui/limitsStore";
import { USAGE_PREVIEW_EXAMPLES, keyFigureOf, weeklyFigureOf, weeklyTitleOf, type UsageFigure } from "@jaira/ui/usageFigure";
import { Uncopied } from "../../app/Uncopied";
import { Press, Txt, edge } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { BrandMark } from "../chat/Composer";
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

/**
 * The setting's preview (`UsageFiguresPreview`): the composer's model chip and its figure, on a
 * subscription, a key whose provider reports its credit, and a key whose provider does not — drawn in
 * the mode being chosen. The examples are `usageFigure.ts`'s. The rules:
 *
 *   .um-preview          a `.set-preview`: three equal columns, gap 10, padding 12
 *   .um-preview-cell     column, gap 6 — the cell grows past its column to its content (a grid track
 *                        of `auto`), as the DOM's does
 *   .um-preview-n        app 11.5/12.5 --dim
 *   .cx.um-mini          the composer's frame: --bg, padding 10 16 14; `.cx-frame` padding 1 on --line,
 *                        radius 22; `.cx-shell` --panel, radius 21; `.cx-foot` row, centred, gap 5,
 *                        padding 5 7 7 8
 *   .cx-chip             padding 3 9, 1px transparent, round, gap 5, app 11.5/12.5 --dim; its icon 13;
 *                        its words at most 96 (`.um-preview .cx-chip .ellip`)
 *   .um-num              data 500 11/12 on a line of 1, padding 2 5, 2 out on the left, on the body's
 *                        19.5 line (`.um-numwrap`); --dim for the accent tone (money: --text)
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
  // `.um-num.um-t-accent` is --dim; money's accent `--text`, and `none` --dim.
  const ink = figure.tone === "accent" ? (figure.money ? "text" : "dim") : INK[figure.tone];
  const face = { voice: "data" as const, scale: 11 / 12, weight: 500, color: ink, tabular: true, lineHeight: 1 };
  return (
    <View backgroundColor={t.v("bg") as never} paddingTop={10} paddingHorizontal={16} paddingBottom={14}>
      <View width="100%" padding={1} borderRadius={22} backgroundColor={t.v("line") as never}>
        <View flexDirection="column" borderRadius={21} backgroundColor={t.v("panel") as never}>
          <View flexDirection="row" alignItems="center" gap={5} paddingTop={5} paddingRight={7} paddingBottom={7} paddingLeft={8} minWidth={0}>
            <View flexDirection="row" alignItems="center" gap={5} paddingVertical={3} paddingHorizontal={9} borderRadius={999} borderWidth={1} borderStyle="solid" borderColor="transparent" maxWidth={210} minWidth={0} flexShrink={0}>
              <BrandMark t={t} name={brand} />
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
