import { useRef, useState, type JSX } from "react";
import { TextInput, View as RNView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { contextFill, formatAge, formatTokens, formatUsd, toneOfContext, type ContextPart, type ContextReading, type LimitAccountView } from "@jaira/shared/browser";
import { colourOf } from "@jaira/ui/contextParts";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { accountFor, refreshAccount, useLimits, useLimitsWatch, useNow } from "@jaira/ui/limitsStore";
import { capital, modelWindowOf, readingAgeOf, routeLeftOf, spentNoticeOf, windowRowsOf } from "@jaira/ui/usageCards";
import { creditPercent, isSpent, toneOfPercent, usedPercentFor } from "@jaira/shared/browser";
import { PLAIN_SCROLLER, ENTER_KEEPS_FOCUS, Press, Txt, edge, font } from "../../primitives";
import { useTokens } from "../../tokens";
import { colorOf } from "../Sidebar";
import { Float } from "../floats/Float";
import { MenuLayer } from "../MenuLayer";
import { Icon } from "../panel/Icon";
import { HoverLayer } from "../panel/HoverLayer";
import { BrandIcon } from "../settings/bits";
import { Button } from "../settings/Button";
import { ChipCard } from "./ComposerCards";
import { Turn } from "../Turn";

/**
 * `usageMeters.tsx`'s composer pieces, universal (decision 0015): the line over the box when the account
 * has nothing left (`SpentNotice`), the account's card (`AccountPopover`), the conversation's context
 * card (`ContextDetail`), and the figures beside a route and a model in the model menu (`RouteLeft`,
 * `ModelWindow`). What each says is `usageCards.ts`'s, the desktop's own. The rules, from `styles.css`:
 *
 *   .um-limitline      row, centred, gap 8, margin 8 8 0, padding 6 10, radius 8, --tint-bad, app 12.5/12.5;
 *                      the clock --bad; `b` 600
 *   .um-pop            no padding; .um-acctpop 370 wide, .um-pop-context 380; its head 10 14 4
 *   .um-sec            column, gap 8, padding 10 14 12; a --line between two
 *   .um-sec-head       row, centred, gap 7; the mark 13; the title app 600 12.5/12.5; the sub pushed
 *                      right, app 11.5/12.5 --dim
 *   .um-big            row, baseline, gap 8; the figure data 600 22/1, −0.02em, tabular; `of` app 12/12.5 --dim
 *   .um-rows           column, gap 7; a row: name (1fr) · bar (≥ 48, .8fr) · value 38 · reset, gap 9,
 *                      app 12/12.5; the value data 500 11.5/1 right, the reset 11px --dim
 *   .um-bar            6 tall, radius 3, --dim 16%; its fill the tone's colour
 *   .um-foot           row, centred, gap 8, 2 above, at least 24; the age 11px --dim
 *   .um-route          row, gap 5, pushed right, 6 before; its bar 22 × 4; the figure data 500 10.5/1, ≥ 28
 */

const TONE: Record<string, string> = { accent: "accent", warn: "warn", bad: "bad", none: "rule" };
const INK: Record<string, string> = { accent: "text", warn: "warn", bad: "bad", none: "dim" };

/** `.um-bar`: how much is used, in the tone's colour. */
export function Bar({ pct, tone, width, height = 6 }: { pct: number | null; tone: string; width?: number | string; height?: number }): JSX.Element {
  const t = useTokens();
  return (
    <View height={height} borderRadius={height / 2} backgroundColor={t.mix(t.v("dim"), 16, "transparent") as never} overflow="hidden" minWidth={0} {...(width !== undefined ? { width } : {})}>
      <View height="100%" borderRadius={height / 2} width={`${Math.max(0, Math.min(100, pct ?? 0))}%`} backgroundColor={t.v(TONE[tone] ?? "rule") as never} />
    </View>
  );
}

/** `.um-route-n`: data 500 10.5px on a line of 1, tabular, at least 28, right. */
function RouteFigure({ text, tone }: { text: string; tone: string }): JSX.Element {
  return (
    <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: INK[tone] ?? "dim", tabular: true, lineHeight: { px: 10.5 } }} fontSize={10.5} minWidth={28} textAlign="right">
      {text}
    </Txt>
  );
}

/** `RouteLeft`: the account behind a route — how much of its tightest window is used. */
export function RouteLeft({ route, after }: { route: string; after?: ((afterFigure: boolean) => JSX.Element) | undefined }): JSX.Element | null {
  const limits = useLimits();
  const now = useNow();
  const left = routeLeftOf(accountFor(limits, route), now);
  // What follows it (the row's ›) takes the edge itself when there is no figure to take it.
  if (left === undefined) return after !== undefined ? after(false) : null;
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={5} marginLeft="auto" paddingLeft={6} flexShrink={0} {...({ title: left.title } as object)}>
        {left.bar === false ? null : <Bar pct={left.bar} tone={left.tone} width={22} height={4} />}
        <RouteFigure text={left.text} tone={left.tone} />
      </View>
      {after?.(true)}
    </>
  );
}

/** `ModelWindow`: on a model row, the window that counts this model alone. */
export function ModelWindow({ route, model }: { route: string; model: string }): JSX.Element | null {
  const limits = useLimits();
  const now = useNow();
  const own = modelWindowOf(accountFor(limits, route), model, now);
  if (own === undefined) return null;
  return (
    <View flexDirection="row" alignItems="center" gap={5} marginLeft="auto" paddingLeft={6} flexShrink={0} {...({ title: own.title } as object)}>
      <Bar pct={own.pct} tone={own.tone} width={22} height={4} />
      <RouteFigure text={own.text} tone={own.tone} />
    </View>
  );
}

/** `SpentNotice`: over the composer while the account behind the route has nothing left. */
export function SpentLine({ route }: { route: string | undefined }): JSX.Element | null {
  const t = useTokens();
  const limits = useLimits();
  const now = useNow();
  const said = spentNoticeOf(accountFor(limits, route), now);
  if (said === undefined) return null;
  const size = Number(t.scaled("size-app", 1)) || 12.5;
  const words = { voice: "app" as const, scale: 1 };
  return (
    <View role="status" flexDirection="row" alignItems="center" gap={8} marginTop={8} marginHorizontal={8} paddingVertical={6} paddingHorizontal={10} borderRadius={8} backgroundColor={t.v("tint-bad") as never}>
      <Icon name="clock" size={size} color={String(t.v("bad"))} />
      <Txt spec={words} flexShrink={1}>
        <Txt spec={{ ...words, weight: 600 }}>{said.bold}</Txt>
        {said.rest}
      </Txt>
    </View>
  );
}

/** `.um-sec`: one section of a usage card. */
function Section({ children, first }: { children: React.ReactNode; first: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="column" gap={8} paddingTop={10} paddingHorizontal={14} paddingBottom={12} position="relative" {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      {children}
    </View>
  );
}

function SecHead({ brand, title, sub }: { brand?: string | undefined; title: string; sub?: string | undefined }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={7} minWidth={0}>
      {brand !== undefined ? <BrandIcon name={brand} size={13} /> : null}
      <Txt spec={{ voice: "app", scale: 1, weight: 600 }} ellip minWidth={0} flexShrink={1}>
        {title}
      </Txt>
      {sub !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} marginLeft="auto" flexShrink={0} numberOfLines={1}>
          {sub}
        </Txt>
      ) : null}
    </View>
  );
}

function Big({ n, of, tone }: { n: string; of: string; tone?: string | undefined }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="baseline" gap={8}>
      <Txt spec={{ voice: "data", scale: 22 / 12, weight: 600, ls: -0.02, tabular: true, lineHeight: 1, color: tone !== undefined ? INK[tone] : "text" }}>{n}</Txt>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim", tabular: true }} flexShrink={1}>
        {of}
      </Txt>
    </View>
  );
}

/** `.um-row`: name · bar · value · reset. */
function WindowLine({ name, sub, pct, tone, value, reset, passed = false, money = false }: { name: string; sub?: string | undefined; pct?: number | null | undefined; tone: string; value: string; reset: string; passed?: boolean; money?: boolean }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={9} opacity={passed ? 0.6 : 1}>
      <View flex={1} minWidth={0} flexDirection="column">
        <Txt spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.25 }} ellip>
          {name}
        </Txt>
        {sub !== undefined ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", lineHeight: 1.25 }} fontSize={11} ellip>
            {sub}
          </Txt>
        ) : null}
      </View>
      <View flex={0.8} minWidth={48} justifyContent="center">
        {pct === undefined ? null : <Bar pct={pct} tone={tone} />}
      </View>
      <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500, color: money && tone === "accent" ? "text" : (INK[tone] ?? "text"), tabular: true, lineHeight: 1 }} fontSize={11.5} width={38} textAlign="right">
        {value}
      </Txt>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} fontSize={11} numberOfLines={1} flexShrink={0}>
        {reset}
      </Txt>
    </View>
  );
}

/**
 * `AccountPopover`: every window of one account, when each resets, how old the reading is — and the
 * other accounts. The composer's is 370 wide from the chip's start; Connections' (`.um-cpop`) 330 from
 * the figure's end.
 */
export function AccountCard({ anchor, account, cost, others, width = 370, align = "start", onClose }: { anchor: FloatRect; account: LimitAccountView; cost?: number | undefined; others: readonly LimitAccountView[]; width?: number; align?: "start" | "end"; onClose: () => void }): JSX.Element {
  useLimitsWatch(true);
  const t = useTokens();
  const now = useNow();
  const reading = account.reading;
  const money = account.kind !== "subscription";
  const windows = windowRowsOf(account, now);
  const week = account.spent7d ?? 0;
  const note = (text: string, warn = false): JSX.Element => <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: warn ? "warn" : "dim" }}>{text}</Txt>;
  let first = true;
  const isFirst = (): boolean => {
    const was = first;
    first = false;
    return was;
  };
  return (
    <ChipCard anchor={anchor} label="Usage" onClose={onClose} width={width} align={align} sections offset={8}>
      {money && cost !== undefined ? (
        <Section first={isFirst()}>
          <SecHead title="This conversation" />
          <Big n={formatUsd(cost)} of={account.kind === "spend" && week > 0 ? `${Math.round(Math.min(100, (cost / week) * 100))}% of the ${formatUsd(week)} spent on this key in the last 7 days` : "so far"} />
        </Section>
      ) : null}
      <Section first={isFirst()}>
        <SecHead brand={account.brand} title={`${account.brand}${account.who !== undefined ? ` · ${account.who}` : ""}`} sub={money ? (account.kind === "credit" ? "Credit" : "API key") : account.plan !== null && account.plan !== undefined ? capital(account.plan) : undefined} />
        {money ? (
          account.kind === "credit" && account.credit !== undefined ? (
            (() => {
              const pct = isSpent(account.reading, now) ? 100 : creditPercent(account.credit);
              return <WindowLine name="Credit used" {...(account.credit.source === "key" ? { sub: "this key's limit" } : {})} pct={pct} tone={toneOfPercent(pct)} value={formatUsd(account.credit.usedUsd)} reset={pct === null ? "" : `${Math.round(pct)}%`} money />;
            })()
          ) : (
            <>
              <WindowLine name="Spent in 7 days" sub="by JaiRA, on this key" tone="accent" value={formatUsd(account.spent7d ?? 0)} reset="rolling" money />
              {note(account.creditRefusedAt !== undefined ? `${account.brand} refused a call because the balance is empty. Add credit, then send again.` : `${account.brand} doesn't report the balance, so what's left isn't known. JaiRA finds out it's empty when a call is refused.`, account.creditRefusedAt !== undefined)}
            </>
          )
        ) : windows.length === 0 ? (
          note(reading === null ? "No reading yet — it arrives with the first reply, or a refresh." : "The last reading named no windows.")
        ) : (
          <View flexDirection="column" gap={7}>
            {windows.map((w) => (
              <WindowLine key={w.id} name={w.name} sub={w.sub} pct={w.pct} tone={w.tone} value={w.value} reset={w.reset} passed={w.passed} />
            ))}
          </View>
        )}
        {reading?.overage === true ? (
          <View paddingVertical={7} paddingHorizontal={9} borderRadius={7} backgroundColor={t.v("tint-accent") as never}>
            <Txt spec={{ voice: "app", scale: 12 / 12.5 }}>
              <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 700 }}>Extra usage</Txt> is on for this account: messages still go through, paid from credits.
            </Txt>
          </View>
        ) : null}
        {account.unavailable !== undefined ? note(account.unavailable, true) : null}
        <View flexDirection="row" alignItems="center" gap={8} marginTop={2} minHeight={24}>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} fontSize={11}>
            {readingAgeOf(account, account.updatedAt === null ? undefined : formatAge(account.updatedAt, now))}
          </Txt>
          <View flex={1} />
          {account.refreshing ? (
            <View flexDirection="row" alignItems="center" gap={6}>
              <UmSpin />
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>refreshing…</Txt>
            </View>
          ) : account.refreshable ? (
            // `.um-refresh`: the icon at the words' size (`1em`), 5 before them.
            <Button kind="ghost" onPress={() => refreshAccount(account.key)} paddingVertical={2} paddingHorizontal={7}>
              <Icon name="refresh" size={Number(t.scaled("size-app", 11.5 / 12.5)) || 11.5} color={String(t.v("text"))} />
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5 }} numberOfLines={1}>
                Refresh
              </Txt>
            </Button>
          ) : null}
        </View>
      </Section>
      {others.length > 0 ? (
        <Section first={false}>
          <SecHead title="Your other accounts" />
          <View flexDirection="column" gap={2} marginHorizontal={-6}>
            {others.map((o) => (
              <OtherAccount key={o.key} account={o} now={now} />
            ))}
          </View>
        </Section>
      ) : null}
    </ChipCard>
  );
}

/** `.um-spin`: a 10 ring of --dim 30%, its top --accent, stroked 1.6, turning. */
function UmSpin(): JSX.Element {
  const t = useTokens();
  return (
    <Turn>
      <View width={10} height={10} borderRadius={999} borderWidth={1.6} borderStyle="solid" borderColor={t.mix(t.v("dim"), 30, "transparent") as never} borderTopColor={t.v("accent") as never} />
    </Turn>
  );
}

/** One line of "Your other accounts": 14 · name · bar 40 · value 34, gap 8, padding 4 6. */
function OtherAccount({ account, now }: { account: LimitAccountView; now: number }): JSX.Element {
  const words = { voice: "app" as const, scale: 12 / 12.5 };
  // `.um-other.is-dim`: a row with no reading is --dim through, its mark's `currentColor` too.
  const head = (dim = false): JSX.Element => (
    <>
      <View width={14} flexShrink={0}>
        <BrandIcon name={account.brand} size={13} ink={dim ? "dim" : "text"} />
      </View>
      <Txt spec={{ ...words, color: dim ? "dim" : "text" }} ellip flex={1} minWidth={0}>
        {account.brand}
        {account.who !== undefined ? ` · ${account.who}` : ""}
      </Txt>
    </>
  );
  const row = (children: JSX.Element): JSX.Element => (
    <View flexDirection="row" alignItems="center" gap={8} paddingVertical={4} paddingHorizontal={6} borderRadius={6}>
      {children}
    </View>
  );
  if (account.kind === "spend") {
    return row(
      <>
        {head()}
        <Txt spec={{ ...words, color: "text" }} fontSize={11} textAlign="right">{`${formatUsd(account.spent7d ?? 0)} in the last 7 days`}</Txt>
      </>,
    );
  }
  const pct = account.kind === "credit" && account.credit !== undefined ? (isSpent(account.reading, now) ? 100 : creditPercent(account.credit)) : usedPercentFor(account.reading, undefined, now);
  if (pct === null) {
    return row(
      <>
        {head(true)}
        <Txt spec={{ ...words, color: "dim" }} fontSize={11} width={82} textAlign="right">
          no reading
        </Txt>
      </>,
    );
  }
  const tone = toneOfPercent(pct);
  return row(
    <>
      {head()}
      <View width={40}>
        <Bar pct={pct} tone={tone} height={5} />
      </View>
      <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 500, color: INK[tone] ?? "text", tabular: true, lineHeight: 1 }} fontSize={11.5} width={34} textAlign="right">
        {account.kind === "credit" && account.credit !== undefined ? formatUsd(account.credit.usedUsd) : `${Math.round(pct)}%`}
      </Txt>
    </>,
  );
}

/** `ContextDetail` in its card: the figure, the breakdown and its detail on hover, and Compact now. */
export function ContextCard({ anchor, context, route, busy, onCompact, onClose }: { anchor: FloatRect; context: ContextReading | null | undefined; route?: string | undefined; busy?: boolean | undefined; onCompact?: ((focus?: string) => void) | undefined; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const [shown, setShown] = useState<string | undefined>(undefined);
  const [focusing, setFocusing] = useState(false);
  const [focus, setFocus] = useState("");
  const section = useRef<RNView | null>(null);
  const [beside, setBeside] = useState<FloatRect | null>(null);
  const body = ((): JSX.Element => {
    if (context === null || context === undefined) {
      return (
        <Section first>
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>No reading yet — it fills after the first reply.</Txt>
        </Section>
      );
    }
    const fill = contextFill(context, route);
    const tone = toneOfContext(fill);
    const window = context.window;
    const parts = context.breakdown ?? [];
    const total = window ?? Math.max(context.used, 1);
    const open = parts.find((p) => p.name === shown);
    return (
      <RNView ref={section} collapsable={false} style={PLAIN_SCROLLER as never}>
        <Section first>
          <View flexDirection="row" alignItems="center" gap={7} minWidth={0}>
            <Txt spec={{ voice: "app", scale: 1, weight: 600 }} flexShrink={0}>
              This conversation
            </Txt>
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} marginLeft="auto" ellip minWidth={0} flexShrink={1}>
              {context.model}
            </Txt>
          </View>
          <Big n={fill === null ? formatTokens(context.used, true) : `${Math.round(fill)}%`} tone={tone} of={window === null ? `${formatTokens(context.used)} tokens · the window is not known` : `${formatTokens(context.used)} of ${formatTokens(window)} tokens`} />
          <View flexDirection="row" height={7} borderRadius={4} gap={1} position="relative" backgroundColor={t.mix(t.v("dim"), 16, "transparent") as never} role="img" aria-label="what the context holds">
            {parts.length > 0 ? (
              parts.map((p, k) => <View key={p.name} height="100%" width={`${(p.tokens / total) * 100}%`} backgroundColor={colorOf(t, colourOf(p.name, k)) as never} {...({ title: `${p.name}: ${formatTokens(p.tokens)}` } as object)} />)
            ) : (
              <View height="100%" width={`${Math.min(100, (context.used / total) * 100)}%`} backgroundColor={t.v(TONE[tone] ?? "rule") as never} />
            )}
            {context.autoCompactAt !== undefined && window !== null ? <View position="absolute" top={-3} bottom={-3} width={2} marginLeft={-1} borderRadius={1} left={`${(context.autoCompactAt / window) * 100}%`} backgroundColor={t.v("dim") as never} /> : null}
          </View>
          {context.autoCompactAt !== undefined || onCompact !== undefined ? (
            <View flexDirection="row" alignItems="center" gap={8} minHeight={26}>
              {context.autoCompactAt !== undefined ? (
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>
                  auto-compacts at {formatTokens(context.autoCompactAt, true)}
                  {window !== null ? ` (${Math.round((context.autoCompactAt / window) * 100)}%)` : ""}
                </Txt>
              ) : null}
              <View flex={1} />
              {onCompact !== undefined ? (
                <View flexDirection="row" alignItems="stretch">
                  <Button kind="ghost" onPress={() => onCompact()} title={busy === true ? "Sent when the answer in progress ends" : "Compact the conversation now"} font={{ scale: 12 / 12.5 }} paddingVertical={3} paddingHorizontal={8} borderTopRightRadius={0} borderBottomRightRadius={0}>
                    <Icon name="fold" size={12} color={String(t.v("text"))} />
                    <Txt spec={{ voice: "app", scale: 12 / 12.5 }}>{busy === true ? "Compact after this turn" : "Compact now"}</Txt>
                  </Button>
                  <Button kind="ghost" onPress={() => setFocusing((v) => !v)} label="Compact with a focus" font={{ scale: 10 / 12.5 }} paddingVertical={3} paddingHorizontal={6} borderTopLeftRadius={0} borderBottomLeftRadius={0} marginLeft={-1}>
                    ▾
                  </Button>
                </View>
              ) : null}
            </View>
          ) : null}
          {focusing && onCompact !== undefined ? (
            <View flexDirection="column" gap={6}>
              <TextInput {...(ENTER_KEEPS_FOCUS as object)}
                multiline
                value={focus}
                onChangeText={setFocus}
                placeholder="What to keep — the decisions, the file names, …"
                style={{ ...(font(t, { voice: "app", scale: 12 / 12.5, lineHeight: 1.45 }) as object), minHeight: 3 * 12 * 1.45 + 12, paddingVertical: 6, paddingHorizontal: 8, borderWidth: 1, borderColor: String(t.v("line")), borderRadius: 7, backgroundColor: String(t.v("panel-2")) } as never}
              />
              <View flexDirection="row" alignItems="center" gap={8}>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} fontSize={11}>
                  sent as the agent&apos;s own /compact, with these words
                </Txt>
                <View flex={1} />
                <Button
                  kind="primary"
                  onPress={() => {
                    onCompact(focus.trim().length > 0 ? focus.trim() : undefined);
                    setFocusing(false);
                    setFocus("");
                  }}
                >
                  Compact
                </Button>
              </View>
            </View>
          ) : null}
          {parts.length > 0 ? (
            <View flexDirection="column" gap={1} marginHorizontal={-6}>
              {parts.map((p, k) => (
                <View
                  key={p.name}
                  flexDirection="row"
                  alignItems="center"
                  gap={8}
                  paddingVertical={4}
                  paddingHorizontal={6}
                  borderRadius={6}
                  backgroundColor={(shown === p.name ? t.v("fill-ghost-selected") : "transparent") as never}
                  {...(isWeb
                    ? {
                        onMouseEnter: () => {
                          setShown(p.name);
                          section.current?.measureInWindow((x, y, w, h) => setBeside({ left: x, top: y, right: x + w, bottom: y + h }));
                        },
                        onMouseLeave: () => setShown((was) => (was === p.name ? undefined : was)),
                      }
                    : {
                        // A phone has no hover: a press opens the breakdown, as a hover card opens on one.
                        onPress: () => {
                          setShown(p.name);
                          section.current?.measureInWindow((x, y, w, h) => setBeside({ left: x, top: y, right: x + w, bottom: y + h }));
                        },
                      })}
                >
                  <View width={8} height={8} borderRadius={2} backgroundColor={colorOf(t, colourOf(p.name, k)) as never} />
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.3 }} ellip flex={1} minWidth={0}>
                    {p.name}
                  </Txt>
                  <Txt spec={{ voice: "data", scale: 11 / 12, weight: 500, tabular: true, lineHeight: 1 }} fontSize={11} width={46} textAlign="right">
                    {formatTokens(p.tokens, true)}
                  </Txt>
                  <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", tabular: true }} fontSize={11} width={40} textAlign="right">
                    {window !== null ? `${((p.tokens / window) * 100).toFixed(1)}%` : ""}
                  </Txt>
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} width={10}>
                    {p.parts !== undefined && p.parts.length > 0 ? "›" : ""}
                  </Txt>
                </View>
              ))}
            </View>
          ) : null}
        </Section>
        {open !== undefined && open.parts !== undefined && open.parts.length > 0 && beside !== null ? (
          isWeb ? (
            <HoverLayer>
              <PartFlyout part={open} window={window} beside={beside} />
            </HoverLayer>
          ) : (
            <MenuLayer onClose={() => setShown(undefined)}>
              <PartFlyout part={open} window={window} beside={beside} />
            </MenuLayer>
          )
        ) : null}
      </RNView>
    );
  })();
  return (
    <ChipCard anchor={anchor} label="Context" onClose={onClose} width={380} sections align="end" offset={8}>
      {body}
    </ChipCard>
  );
}

/** One category opened: what it is made of (`PartFlyout`), beside the card on its left. */
function PartFlyout({ part, window, beside }: { part: ContextPart; window: number | null; beside: FloatRect }): JSX.Element {
  const t = useTokens();
  const max = Math.max(1, ...(part.parts ?? []).flatMap((p) => [p.tokens, ...(p.parts ?? []).map((q) => q.tokens)]));
  const row = (p: ContextPart): JSX.Element => (
    <View key={`${p.name}:${p.tokens}`} flexDirection="row" alignItems="center" gap={7} minHeight={20}>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: p.tokens === 0 ? "dim" : "text" }} ellip flex={1} minWidth={0}>
        {p.name}
      </Txt>
      {p.note !== undefined ? (
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "dim" }} fontSize={10.5} ellip>
          {p.note}
        </Txt>
      ) : null}
      <View width={36} height={4} borderRadius={2} backgroundColor={t.mix(t.v("dim"), 14, "transparent") as never} overflow="hidden">
        <View height="100%" width={`${(p.tokens / max) * 100}%`} backgroundColor={t.v("p2") as never} />
      </View>
      <Txt spec={{ voice: "data", scale: 11 / 12, weight: 500, tabular: true, lineHeight: 1 }} fontSize={11} width={36} textAlign="right">
        {formatTokens(p.tokens, true)}
      </Txt>
    </View>
  );
  return (
    <Float anchor={beside} side="left" align="end" offset={22} width={290} flexDirection="column" gap={4} paddingTop={10} paddingHorizontal={12} paddingBottom={12} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={10} backgroundColor={t.v("panel") as never} role="tooltip" {...({ boxShadow: "0px 6px 18px rgba(18, 21, 48, 0.12)" } as object)}>
      <View flexDirection="row" alignItems="baseline" gap={8} marginBottom={4}>
        <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{part.name}</Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} fontSize={11}>
          {formatTokens(part.tokens, true)}
          {window !== null ? ` · ${((part.tokens / window) * 100).toFixed(1)}%` : ""}
        </Txt>
      </View>
      {(part.parts ?? []).map((p) =>
        p.parts !== undefined && p.parts.length > 0 ? (
          <View key={p.name}>
            <Txt spec={{ voice: "data", scale: 10 / 12, weight: 600, ls: 0.05, upper: true, color: "dim", lineHeight: 1 }} fontSize={10} marginTop={7}>
              {p.name}
            </Txt>
            {p.parts.map(row)}
          </View>
        ) : (
          row(p)
        ),
      )}
    </Float>
  );
}
