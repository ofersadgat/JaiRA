import { useState, type JSX, type ReactNode } from "react";
import { Platform, TextInput, useWindowDimensions, type GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { contextFill, formatTokens, isSpent, toneOfContext, type ChatPlanView, type ChatSettings, type ContextReading } from "@jaira/shared/browser";
import { brandHex, brandMark, brandOf } from "@jaira/ui/brands";
import { useKeptDraft } from "@jaira/ui/composerDrafts";
import { canSendOf, chipValuesOf, composerFactsOf, routeOf, sendTitleOf } from "@jaira/ui/composerModel";
import { accountFor, useLimits, useNow, useUsageFigures } from "@jaira/ui/limitsStore";
import { useModelParameters } from "@jaira/ui/modelParameters";
import { figureOf, type UsageFigure } from "@jaira/ui/usageFigure";
import { Uncopied } from "../../app/Uncopied";
import { Press, Txt, font } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Icon, type IconName } from "../panel/Icon";
import { Svg } from "../panel/Svg";
import { INK, Ring } from "../usage/Ring";
import { Pulse } from "./Paper";

/**
 * `composer.tsx`'s `Composer`, universal (decision 0015): the box a message is typed into, what it will
 * run as, and the button that sends it. What the chips say and whether Enter sends are
 * `composerModel.ts`'s; the account's figure is `usageFigure.ts`'s (the desktop's own code). Typing is
 * a native `TextInput`; Enter sends on a keyboard (Shift+Enter breaks the line), the button everywhere.
 *
 *   .cx               padding 10 16 14, --bg
 *   .cx-frame         900 at most, centred, padding 1, radius 22, --line (focused: --accent 55% into
 *                     --line) — a ring rather than a border
 *   .cx-shell         column, radius 21, --panel (.cx.off: --panel-2)
 *   .cx-text          app 13.5/12.5, line 1.55, padding 13 15 6, --text, at least 54 tall, at most
 *                     40% of the window, growing with what is typed; the placeholder --tok-hint
 *   .cx-foot          row, centred, gap 5, padding 5 7 7 8
 *   .cx-chip          pill, padding 3 9, 1px transparent, gap 5, at most 210, app 11.5/12.5, --dim;
 *                     hovered --fill-ghost-hover and --text; .own --accent; the icon 13, --tok-hint
 *   .um-num           the account's figure: data 500 11/12, line 1, padding 2 5, radius 6, 2 in on
 *                     the left; its tone's colour (--dim for the accent tone)
 *   .um-meter         the context ring: 26 tall, padding 0 5, radius 13, gap 6; the ring 16
 *   .cx-live          row, gap 6, app 11/12.5, --accent (waiting: --dim)
 *   .cx-clip          26 round, the paperclip 15, --dim; hovered --panel-2 and --text
 *   .cx-send          30 round, --accent, the arrow 16 in --panel; disabled --panel-2, --tok-hint, at
 *                     half opacity; .cx-stop --bad, a 10 square (radius 2) of --panel
 *
 * {@link Uncopied}: the cards each chip opens (the route cascade, the levels, the permission sets, the
 * tools), the account's and the context's cards, `@` completion, attaching files, and the spent line.
 */
export function Composer({
  plan,
  busy,
  joinable,
  overrides: _overrides,
  onOverrides: _onOverrides,
  onSend,
  onStop,
  disabled,
  placeholder,
  value,
  onValue,
  draftKey,
  usage,
}: {
  plan: ChatPlanView | null;
  busy?: boolean;
  joinable?: boolean;
  overrides: ChatSettings;
  onOverrides: (next: ChatSettings) => void;
  onSend: (message: string) => void;
  onStop?: (() => void) | undefined;
  disabled?: string;
  placeholder?: string;
  value?: string;
  onValue?: (next: string) => void;
  draftKey?: string | undefined;
  usage?: { context: ContextReading | null | undefined; onCompact?: ((focus?: string) => void) | undefined; cost?: number | undefined } | undefined;
}): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const [own, setOwn] = useKeptDraft(value === undefined ? draftKey : undefined);
  const draft = value ?? own;
  const setDraft = (next: string): void => (onValue !== undefined ? onValue(next) : setOwn(next));
  const [focused, setFocused] = useState(false);
  const [height, setHeight] = useState(54);
  const facts = composerFactsOf(plan, undefined);
  const { origin, effective, route, permissionsOrigin, toolsOrigin } = facts;
  const thinking = useModelParameters(effective.model);
  const chips = chipValuesOf(plan, facts, thinking);
  const limits = useLimits();
  const now = useNow();
  const account = accountFor(limits, route);
  const spent = account !== undefined && isSpent(account.reading, now);
  const canSend = canSendOf(disabled, busy, joinable);
  const off = disabled !== undefined;
  /** A card a chip would open — not copied: a note where it would stand. */
  const [card, setCard] = useState<{ name: string; x: number; y: number } | null>(null);
  const openCard = (name: string) => (e: GestureResponderEvent) => setCard({ name, x: e.nativeEvent.pageX, y: e.nativeEvent.pageY });

  const send = (): void => {
    const message = draft.trim();
    if (message === "" || !canSend) return;
    onSend(message);
    setDraft("");
  };

  return (
    <View paddingTop={10} paddingHorizontal={16} paddingBottom={14} backgroundColor={t.v("bg") as never}>
      <View
        width="100%"
        maxWidth={900}
        alignSelf="center"
        padding={1}
        borderRadius={22}
        backgroundColor={(focused ? t.mix(t.v("accent"), 55, t.v("line")) : t.v("line")) as never}
      >
        <View flexDirection="column" borderRadius={21} backgroundColor={t.v(off ? "panel-2" : "panel") as never}>
          {!off && spent ? <Uncopied name="the spent line" /> : null}
          <TextInput
            multiline
            value={draft}
            editable={!off}
            placeholder={disabled ?? placeholder ?? "Ask for more changes…"}
            placeholderTextColor={String(t.v("tok-hint"))}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onContentSizeChange={(e) => setHeight(e.nativeEvent.contentSize.height)}
            // Enter sends and Shift+Enter breaks the line, as every chat client does — on a keyboard. A
            // phone's return key is a newline, and the button sends.
            onKeyPress={(e) => {
              const key = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
              if (key.key === "Enter" && key.shiftKey !== true && Platform.OS === "web") {
                (e as unknown as { preventDefault: () => void }).preventDefault();
                send();
              }
            }}
            {...(Platform.OS === "web" ? {} : { textAlignVertical: "top" as const })}
            style={{
              ...(font(t, { voice: "app", scale: 13.5 / 12.5, color: "text", lineHeight: 1.55 }) as object),
              paddingTop: 13,
              paddingHorizontal: 15,
              paddingBottom: 6,
              minHeight: 54,
              maxHeight: win.height * 0.4,
              height: Math.max(54, Math.min(height, win.height * 0.4)),
              backgroundColor: "transparent",
              borderWidth: 0,
              ...(isWeb ? { outlineStyle: "none", resize: "none" } : {}),
            } as never}
          />
          <View flexDirection="row" alignItems="center" gap={5} paddingTop={5} paddingRight={7} paddingBottom={7} paddingLeft={8} minWidth={0}>
            <Chip t={t} lead={<BrandMark t={t} name={routeOf(effective.model ?? "")} />} label="Model" value={chips.model} own={origin.model === "override"} onPress={openCard("the Model card")} />
            <Allowance t={t} route={route} model={effective.model} cost={usage?.cost} onPress={openCard("the account card")} />
            <Chip t={t} icon="think" label="Thinking" value={chips.thinking} own={origin.reasoning === "override"} onPress={openCard("the Thinking card")} />
            <Chip t={t} icon="shield" label="Permissions" value={chips.permissions} own={permissionsOrigin === "override"} onPress={openCard("the Permissions card")} />
            <Chip t={t} icon="tool" label="Tools" value={chips.tools} own={toolsOrigin === "override"} onPress={openCard("the Tools card")} />
            {plan !== null && plan.unresolved.length > 0 ? (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }} ellip minWidth={0} paddingLeft={4}>
                {plan.unresolved.map((u) => u.field).join(", ")} {plan.unresolved.length === 1 ? "is" : "are"} an expression here
              </Txt>
            ) : null}
            <View flex={1} minWidth={0} />
            {plan?.live === "steerable" || plan?.live === "busy" ? (
              <View flexDirection="row" alignItems="center" gap={6} flexShrink={0}>
                <Pulse color={plan.live === "busy" ? "dim" : "accent"} />
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: plan.live === "busy" ? "dim" : "accent" }} numberOfLines={1}>
                  {plan.live === "steerable" ? "joins this turn" : "waits for this turn"}
                </Txt>
              </View>
            ) : null}
            {usage !== undefined ? <ContextMeter t={t} context={usage.context} route={route} onPress={openCard("the context card")} /> : null}
            <Press
              onPress={openCard("attaching files")}
              title="Attach files"
              label="Attach files"
              width={26}
              height={26}
              flexShrink={0}
              alignItems="center"
              justifyContent="center"
              borderRadius={999}
              box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}
            >
              {({ hovered }) => <Icon name="clip" size={15} color={String(t.v(hovered ? "text" : "dim"))} />}
            </Press>
            {busy === true && onStop !== undefined ? (
              <Press onPress={onStop} label="Stop" title="Stop this turn" width={30} height={30} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={999} backgroundColor={t.v("bad") as never}>
                <View width={10} height={10} borderRadius={2} backgroundColor={t.v("panel") as never} />
              </Press>
            ) : null}
            {busy === true && onStop !== undefined && !canSend ? null : (
              <SendButton t={t} spent={spent} title={sendTitleOf(spent, busy)} disabled={draft.trim() === "" || !canSend} onPress={send} />
            )}
          </View>
        </View>
      </View>
      {card !== null ? (
        <MenuLayer onClose={() => setCard(null)}>
          <View position="absolute" left={Math.max(4, card.x - 120)} top={Math.max(4, card.y - 80)} width={240} backgroundColor={t.v("panel") as never}>
            <Uncopied name={card.name} height={60} />
          </View>
        </MenuLayer>
      ) : null}
    </View>
  );
}

/** `.cx-chip`: one question, its icon and its answer. */
function Chip({ t, icon, lead, label, value, own, onPress }: { t: Tokens; icon?: IconName; lead?: ReactNode; label: string; value: string; own: boolean; onPress: (e: GestureResponderEvent) => void }): JSX.Element {
  return (
    <Press
      onPress={onPress}
      title={`${label}: ${value}`}
      label={label}
      minWidth={0}
      flexShrink={1}
      maxWidth={210}
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingVertical={3}
      paddingHorizontal={9}
      borderRadius={999}
      borderWidth={1}
      borderStyle="solid"
      borderColor="transparent"
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {({ hovered }) => (
        <>
          {lead ?? (icon !== undefined ? <Icon name={icon} size={13} color={String(t.v(own ? "accent" : "tok-hint"))} /> : null)}
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: own ? "accent" : hovered ? "text" : "dim" }} ellip minWidth={0} flexShrink={1}>
            {value}
          </Txt>
        </>
      )}
    </Press>
  );
}

/** `BrandIcon`: the company's mark (its path, in its colour or the chip's), or its initial on its colour. */
export function BrandMark({ t, name }: { t: Tokens; name: string }): JSX.Element {
  const company = brandOf(name);
  const mark = brandMark(company);
  const ink = String(t.v("tok-hint"));
  if (mark !== undefined) {
    return <Svg width={13} height={13} color={ink} fill={mark.onGround === true ? "currentColor" : mark.hex} strokeWidth={0} shapes={[{ kind: "path", d: mark.path }]} />;
  }
  const hex = brandHex(company);
  return (
    <View width={13} height={13} borderRadius={3} alignItems="center" justifyContent="center" backgroundColor={(hex ?? t.mix(ink, 18, "transparent")) as never}>
      <Txt spec={{ voice: "app", scale: 1, weight: 600, color: hex === undefined ? ink : "#fff", lineHeight: { px: 13 } }} fontSize={7}>
        {company.charAt(0).toUpperCase()}
      </Txt>
    </View>
  );
}

/** `AllowanceNumber`: the account's figure after the model chip — as a number, a ring, or both. */
function Allowance({ t, route, model, cost, onPress }: { t: Tokens; route: string | undefined; model: string | undefined; cost: number | undefined; onPress: (e: GestureResponderEvent) => void }): JSX.Element | null {
  const limits = useLimits();
  const mode = useUsageFigures();
  const now = useNow();
  const account = accountFor(limits, route);
  if (account === undefined || mode === "off") return null;
  const figure = figureOf(account, { model, cost, now });
  // `.um-num.um-t-accent` wins over `.um-t-accent`: the accent tone's number is --dim, not --text.
  const ink = figure.tone === "accent" ? "dim" : INK[figure.tone];
  const face = { voice: "data" as const, scale: 11 / 12, weight: 500, color: ink, tabular: true, lineHeight: 1 };
  // `.um-numwrap` is a block whose line (the body's 13/12.5 at 1.5) holds the button as an inline box on
  // its baseline — 19.5 tall, the button 3 below its top — and it is the WRAP the row centres.
  const line = Number(t.scaled("size-app", (13 / 12.5) * 1.5));
  return (
    <View flexShrink={0} marginLeft={-2} {...(Number.isFinite(line) ? { height: line } : {})}>
    <Press
      onPress={onPress}
      title={figure.title}
      flexShrink={0}
      marginTop={3}
      flexDirection="row"
      alignItems="center"
      gap={5}
      paddingVertical={2}
      paddingHorizontal={5}
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {mode !== "number" ? <Ring t={t} pct={figure.pct} tone={figure.tone} size={16} /> : null}
      {mode !== "ring" ? <Txt spec={face}>{figure.text}</Txt> : null}
    </Press>
    </View>
  );
}

/** `ContextMeter`: how full the conversation is — the ring, and its number from 80%. */
function ContextMeter({ t, context, route, onPress }: { t: Tokens; context: ContextReading | null | undefined; route: string | undefined; onPress: (e: GestureResponderEvent) => void }): JSX.Element {
  const fill = context ? contextFill(context, route) : null;
  const tone = context ? toneOfContext(fill) : "none";
  const text = context === null || context === undefined ? null : fill === null ? formatTokens(context.used, true) : fill >= 80 ? `${Math.round(fill)}%` : null;
  const title =
    context === null || context === undefined
      ? "No reading yet — it fills after the first reply"
      : fill === null
        ? `This conversation holds ${formatTokens(context.used)} tokens`
        : `This conversation: ${Math.round(fill)}% of the context (${formatTokens(context.used)} of ${formatTokens(context.window ?? 0)} tokens)`;
  // `.um-wrap` is a block whose line holds the 26px button on its baseline, half a pixel of the line's
  // descent under it: 26.5 tall, the button at its top — and it is the wrap the row centres.
  return (
    <View flexShrink={0} height={26.5}>
    <Press
      onPress={onPress}
      title={title}
      flexShrink={0}
      height={26}
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingHorizontal={5}
      borderRadius={13}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Ring t={t} pct={fill} tone={tone} size={16} />
      {text !== null ? <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: INK[tone], tabular: true, lineHeight: 1 }}>{text}</Txt> : null}
    </Press>
    </View>
  );
}

/** `.cx-send`: the arrow (a clock while the account has nothing left). */
function SendButton({ t, spent, title, disabled, onPress }: { t: Tokens; spent: boolean; title: string; disabled: boolean; onPress: () => void }): JSX.Element {
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      label="Send"
      title={title}
      width={30}
      height={30}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={999}
      opacity={disabled ? 0.5 : 1}
      backgroundColor={t.v(disabled ? "panel-2" : "accent") as never}
    >
      <Icon name={spent ? "clock" : "send"} size={16} color={String(t.v(disabled ? "tok-hint" : "panel"))} />
    </Press>
  );
}
