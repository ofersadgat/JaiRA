import { createContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { ScrollView, type LayoutChangeEvent } from "react-native";
import type { PanelTabSpec, PanelVerb } from "@jaira/ui/panelFaceModel";
import { acceptOffer, close, crumbOf, forward, historyButton, historyKey, kindWordOf, pin, pop, popTo, setTab, topOf, type PanelEntry, type PanelStack } from "@jaira/ui/panelStack";
import { labelPlan } from "@jaira/ui/panelTabs";
import { PLAIN_SCROLLER, Press, Txt, edge, scrollbarProps } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Icon } from "./Icon";
import { bodyMotion } from "./panelMotion";

/**
 * `sidePanel.tsx`'s `SidePanel`, universal (decision 0015): the frame every panel entry is drawn in —
 * the head, the offer bar, the tabs, the body, and the folded rail. What each entry says is its FACE,
 * handed in (`PanelColumn.tsx` builds it from `panelFaceModel.ts`, as `panelFaces.tsx` does for the DOM).
 * The rules it carries, from `styles.css`:
 *
 *   .sp                  column, the column's height
 *   .sp-head             row, centred, gap 8, at least 44 tall, padding 7 8 7 12, a --line under
 *   .sp-glyph            --dim at 15px, inline-flex
 *   .sp-titles           column, gap 1, flex 1; .sp-name-line row, baseline, gap 8
 *   .sp-name             600, --size-app × 1.08, line 1.3, --text, ellipsed
 *   .sp-kind, .sp-sub    --size-app × 0.92, --dim (the body's 1.5 line)
 *   .sp-sub-pushed       padding 4 12, a --line under
 *   .sp-trail            row, baseline, gap 3, --size-app × 0.9; crumbs --dim (--accent underlined on
 *                        hover), at most 140, padding 0 2; the › --tok-hint
 *   .sp-verbs            row, gap 1; .sp-controls the same after a --line, padding-left 6, margin-left 2
 *   .sp-icon             26 square, radius --control-radius-sm (5), --dim; the glyph 15. Hover:
 *                        --fill-ghost-hover, --text. .on --accent over --tint-accent; .primary
 *                        --on-accent over --accent (hover --fill-accent-hover); :disabled at 0.4
 *   .sp-offer            row, gap 8, padding 6 8 6 12, --tint-accent, a --line under, --size-app × 0.95
 *   .sp-guard            padding 6 12, --tint-warn, a --line under
 *   .sp-tabs             row, stretch, gap 2, padding 0 8, a --line under, clipped
 *   .sp-tab              row, centred, gap 6, padding 8 8 7, 2px transparent under (--accent when
 *                        open), margin-bottom -1; 500 --size-app × 0.98 / 1.2, --dim (--text open or
 *                        hovered). The icon 15.
 *   .sp-tab-count        at least 16, padding 0 5, radius 8, --panel-2; 600 10px/16px data, centred,
 *                        --dim; amber --warn on --tint-warn, accent --accent on --tint-accent, red
 *                        --bad on --tint-bad
 *   .sp-body             flex 1, column; .scroll pads 12 12 18 and scrolls; .fill clips; it comes in as
 *                        the stack moved (`.sp-motion-*`, `panelMotion.web.ts`)
 *   .sp-rail             column, spaced, padding 10 6, --panel-2; its tabs 17px icons over 9.5px names
 */

/** What an entry says: the frame asks for it and draws the rest (`sidePanel.tsx`'s `PanelFace`). */
export interface PanelFace {
  glyph?: ReactNode;
  title: ReactNode;
  titleText: string;
  sub?: ReactNode;
  verbs?: readonly PanelVerb[] | undefined;
  tabs?: readonly PanelTabSpec[] | undefined;
  tab?: string | undefined;
  body: ReactNode;
  scroll?: boolean;
  guard?: ReactNode;
}

type OnStack = (next: (stack: PanelStack) => PanelStack) => void;

/**
 * The size a face's glyph is drawn at: the head's `.sp-glyph` sets 15px, the rail's `.sp-rail-glyph` sets
 * none, so a badge there is the page's 13 on its 1.5 line, and an icon (1em) 13 square.
 */
export const GlyphSizeContext = createContext(15);

/** A length token, as the stylesheet writes `var(--name, fallback)`. */
export function lengthOf(t: Tokens, name: string, fallback: number): number | string {
  if (!t.replayed) return `var(--${name}, ${fallback}px)`;
  const v = t.v(name);
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/** A colour token with a fallback, as the stylesheet writes `var(--name, var(--other))`. */
export function colourOr(t: Tokens, name: string, fallback: string): string {
  if (!t.replayed) return `var(--${name}, var(--${fallback}))`;
  const v = t.v(name);
  return v === "" || v === undefined ? String(t.v(fallback)) : String(v);
}

/** `.sp-icon`: a 26px target, the glyph at 15. */
export function SpIcon({ icon, label, onPress, on = false, toggle = false, primary = false, danger = false, disabled = false, flip = false }: { icon: PanelVerb["icon"]; label: string; onPress: () => void; on?: boolean; /** A toggle (the pin): says `aria-pressed`, as the desktop's does. */ toggle?: boolean; primary?: boolean; danger?: boolean; disabled?: boolean; flip?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      label={label}
      title={label}
      {...((toggle ? { "aria-pressed": on } : {}) as object)}
      width={26}
      height={26}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={lengthOf(t, "control-radius-sm", 5)}
      {...(disabled ? { opacity: 0.4 } : {})}
      box={({ hovered }) => {
        const hot = hovered && !disabled;
        if (primary) return { backgroundColor: hot ? colourOr(t, "fill-accent-hover", "accent") : t.v("accent") };
        if (on) return { backgroundColor: colourOr(t, "tint-accent", "fill-ghost-selected") };
        return hot ? { backgroundColor: t.v("fill-ghost-hover") } : {};
      }}
    >
      {({ hovered }) => {
        const hot = hovered && !disabled;
        const color = primary ? colourOr(t, "on-accent", "text") : on ? t.v("accent") : hot ? (danger ? t.v("bad") : t.v("text")) : t.v("dim");
        return <Icon name={icon} size={15} color={String(color)} {...(flip ? { box: { transform: [{ scaleX: -1 }] } } : {})} />;
      }}
    </Press>
  );
}

/** `.sp-tab-count`: a count or a short figure after a tab's label. */
function TabCount({ tab }: { tab: PanelTabSpec }): JSX.Element | null {
  const t = useTokens();
  if (tab.count === undefined || tab.count === 0 || tab.count === "") return null;
  const ground = tab.tone === "amber" ? colourOr(t, "tint-warn", "panel-2") : tab.tone === "accent" ? colourOr(t, "tint-accent", "panel-2") : tab.tone === "red" ? colourOr(t, "tint-bad", "panel-2") : t.v("panel-2");
  const ink = tab.tone === "amber" ? "warn" : tab.tone === "accent" ? "accent" : tab.tone === "red" ? "bad" : "dim";
  return (
    <View minWidth={16} paddingHorizontal={5} borderRadius={8} backgroundColor={ground as never} flexShrink={0}>
      <Txt spec={{ voice: "data", scale: 1, weight: 600, color: ink, lineHeight: { px: 16 } }} fontSize={10} textAlign="center">
        {String(tab.count)}
      </Txt>
    </View>
  );
}

/** One `.sp-tab`'s insides: icon, label while it fits, count. */
function TabInside({ tab, labelled, color }: { tab: PanelTabSpec; labelled: boolean; color: string }): JSX.Element {
  return (
    <>
      <Icon name={tab.icon} size={15} color={color} />
      {labelled ? (
        <Txt spec={{ voice: "app", scale: 0.98, weight: 500, color, lineHeight: 1.2 }} numberOfLines={1} flexShrink={0}>
          {tab.label}
        </Txt>
      ) : null}
      <TabCount tab={tab} />
    </>
  );
}

/** The box of an `.sp-tab`, for the strip and the ruler alike. */
const TAB_BOX = { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 8, paddingHorizontal: 8, paddingBottom: 7, flexShrink: 0 } as const;

/**
 * The tab strip, labelled as far as the width allows ({@link labelPlan}). Measured, as the DOM's is: a
 * hidden ruler draws each tab bare and labelled, and the strip's own width decides. Widths are rounded
 * as `offsetWidth` and `clientWidth` round them, so both plans agree to the pixel.
 */
function PanelTabs({ tabs, open, onTab }: { tabs: readonly PanelTabSpec[]; open: string | undefined; onTab: (id: string) => void }): JSX.Element {
  const t = useTokens();
  const [strip, setStrip] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const openAt = tabs.findIndex((tab) => tab.id === open);
  const plan = useMemo(() => {
    const all = tabs.map((tab) => ({ bare: widths[`${tab.id}:bare`], full: widths[`${tab.id}:full`] }));
    if (strip === 0 || all.some((w) => w.bare === undefined || w.full === undefined)) return tabs.map(() => true);
    return labelPlan(
      all.map((w) => ({ bare: w.bare!, label: Math.max(0, w.full! - w.bare!) })),
      openAt,
      strip - 2,
    );
  }, [tabs, widths, strip, openAt]);
  const measure = (key: string) => (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidths((was) => (was[key] === w ? was : { ...was, [key]: w }));
  };
  return (
    <View
      role="tablist"
      flexDirection="row"
      alignItems="stretch"
      gap={2}
      paddingHorizontal={8}
      flexShrink={0}
      overflow="hidden"
      // Positioned, as `.sp-tabs` is, and no more: painted after the conversation's scroller, which it
      // touches, Chromium gives it a layer by overlap (greyscale text) as it gives the desktop's.
      position="relative"
      {...(edge(t, { bottom: 1 }) as object)}
      onLayout={(e: LayoutChangeEvent) => setStrip(Math.round(e.nativeEvent.layout.width))}
    >
      {tabs.map((tab, i) => {
        const on = tab.id === open;
        return (
          <Press
            key={tab.id}
            onPress={() => onTab(tab.id)}
            title={tab.label}
            label={tab.label}
            marginBottom={-1}
            role="tab"
            aria-selected={on}
            {...TAB_BOX}
            {...(edge(t, { bottom: 2 }, on ? String(t.v("accent")) : "rgba(0, 0, 0, 0)") as object)}
          >
            {({ hovered }) => <TabInside tab={tab} labelled={plan[i] ?? true} color={String(on || hovered ? t.v("text") : t.v("dim"))} />}
          </Press>
        );
      })}
      {/* The ruler: every tab twice, bare and labelled, out of sight. */}
      <View position="absolute" left={0} top={0} flexDirection="row" opacity={0} pointerEvents="none" aria-hidden>
        {tabs.map((tab) => (
          <View key={tab.id} flexDirection="row">
            <View {...TAB_BOX} onLayout={measure(`${tab.id}:bare`)}>
              <TabInside tab={tab} labelled={false} color={String(t.v("dim"))} />
            </View>
            <View {...TAB_BOX} onLayout={measure(`${tab.id}:full`)}>
              <TabInside tab={tab} labelled color={String(t.v("dim"))} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** pin, fold, close — or pin and ✕-that-folds beside a conversation (`FrameControls`). */
function FrameControls({ stack, onStack, onFold, closeFolds }: { stack: PanelStack; onStack: OnStack; onFold: () => void; closeFolds: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={1} flexShrink={0} paddingLeft={6} marginLeft={2} {...(edge(t, { left: 1 }) as object)}>
      <SpIcon
        icon="pin"
        on={stack.pinned}
        toggle
        label={stack.pinned ? "Unpin — let a new selection replace this" : "Pin — keep this while you select other things"}
        onPress={() => onStack((was) => pin(was, !was.pinned))}
      />
      {closeFolds ? (
        <SpIcon icon="cross" label="Collapse the panel to a rail" onPress={onFold} />
      ) : (
        <>
          <SpIcon icon="fold" label="Fold the panel to a rail" onPress={onFold} />
          <SpIcon icon="cross" label="Close the panel" onPress={() => onStack(close)} />
        </>
      )}
    </View>
  );
}

/** `.sp-rail`: the root's tabs as a column of icons, each named, and pin and unfold at the foot. */
function PanelRail({ stack, face, onStack, onUnfold }: { stack: PanelStack; face: PanelFace | undefined; onStack: OnStack; onUnfold: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flex={1} flexDirection="column" justifyContent="space-between" paddingVertical={10} paddingHorizontal={6} backgroundColor={t.v("panel-2") as never} aria-label="Side panel, folded">
      <View flexDirection="column" alignItems="center" gap={4}>
        {face?.glyph !== undefined ? (
          <View paddingTop={4} paddingBottom={8}>
            <GlyphSizeContext.Provider value={13}>{face.glyph}</GlyphSizeContext.Provider>
          </View>
        ) : null}
        {(face?.tabs ?? []).map((tab) => {
          const on = tab.id === face?.tab;
          const shown = tab.count !== undefined && tab.count !== 0 && tab.count !== "";
          return (
            <Press
              key={tab.id}
              title={tab.label}
              alignSelf="stretch"
              flexDirection="column"
              alignItems="center"
              gap={3}
              paddingTop={7}
              paddingBottom={5}
              borderRadius={7}
              onPress={() => {
                onStack((was) => setTab(was, tab.id));
                onUnfold();
              }}
              box={({ hovered }) => (on ? { backgroundColor: t.v("fill-ghost-selected") } : hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}
            >
              <View position="relative">
                <Icon name={tab.icon} size={17} color={String(on ? t.v("accent") : t.v("text"))} />
                {shown ? (
                  <View position="absolute" top={-5} right={-9} minWidth={14} paddingHorizontal={3} borderRadius={7} backgroundColor={colourOr(t, "panel-3", "panel") as never} {...({ boxShadow: `0 0 0 1px ${String(t.v("line"))}` } as object)}>
                    <Txt spec={{ voice: "data", scale: 1, weight: 600, color: tab.tone === "amber" ? "warn" : tab.tone === "accent" ? "accent" : tab.tone === "red" ? "bad" : "dim", lineHeight: { px: 14 } }} fontSize={9} textAlign="center">
                      {String(tab.count)}
                    </Txt>
                  </View>
                ) : null}
              </View>
              <Txt spec={{ voice: "app", scale: 1, weight: 500, lineHeight: { px: 11.4 }, color: t.mix(t.v("text"), 80, "transparent") }} fontSize={9.5} ellip maxWidth="100%">
                {tab.label}
              </Txt>
            </Press>
          );
        })}
      </View>
      <View flexDirection="column" alignItems="center" gap={4}>
        <SpIcon icon="pin" on={stack.pinned} toggle label={stack.pinned ? "Unpin" : "Pin"} onPress={() => onStack((was) => pin(was, !was.pinned))} />
        <SpIcon icon="unfold" label="Unfold the panel" onPress={onUnfold} />
      </View>
    </View>
  );
}

/**
 * One side panel. `face` answers for any entry in the stack; the frame asks for the top one, the
 * nearest tabbed one (whose tabs are drawn), and the root (which the rail draws).
 */
export function SidePanel({
  stack,
  onStack,
  face,
  folded,
  onFold,
  closeFolds = false,
}: {
  stack: PanelStack;
  onStack: OnStack;
  face: (entry: PanelEntry) => PanelFace;
  folded: boolean;
  onFold: (folded: boolean) => void;
  closeFolds?: boolean;
}): JSX.Element | null {
  const t = useTokens();
  /**
   * The mouse's own back and forward buttons, and Alt+← / Alt+→, while the pointer or the focus is in the
   * panel (`panelStack.ts`' `historyButton` and `historyKey`, the desktop's). Listened for on the element
   * itself: react-native-web's text boxes stop a key from reaching a React handler above them, and Alt+←
   * in a box in the panel goes back on the desktop.
   */
  const frame = useRef<unknown>(null);
  const live = useRef(onStack);
  live.current = onStack;
  const framed = !folded && topOf(stack) !== undefined;
  useEffect(() => {
    const el = frame.current as HTMLElement | null;
    if (!isWeb || el === null || typeof el.addEventListener !== "function") return undefined;
    const take = (event: Event, step: ((stack: PanelStack) => PanelStack) | undefined): void => {
      if (step === undefined) return;
      event.preventDefault();
      live.current(step);
    };
    const onMouseUp = (event: MouseEvent): void => take(event, historyButton(event.button));
    const onKeyDown = (event: KeyboardEvent): void => take(event, historyKey(event));
    el.addEventListener("mouseup", onMouseUp);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("keydown", onKeyDown);
    };
    // Attached again when the frame is drawn again (unfolded, or a stack that was empty).
  }, [framed]);
  const offerName = stack.offer === null ? undefined : face(stack.offer).titleText;
  const top = topOf(stack);
  const root = stack.entries[0];
  const topFace = useMemo(() => (top === undefined ? undefined : face(top)), [top, face]);
  const tabbedAt = useMemo(() => {
    for (let i = stack.entries.length - 1; i >= 0; i--) if ("tab" in stack.entries[i]!) return i;
    return -1;
  }, [stack.entries]);
  const tabbed = tabbedAt < 0 ? undefined : tabbedAt === stack.entries.length - 1 ? topFace : face(stack.entries[tabbedAt]!);
  const rootFace = root === undefined ? undefined : root === top ? topFace : face(root);

  if (top === undefined || topFace === undefined) return null;
  if (folded) return <PanelRail stack={stack} face={rootFace} onStack={onStack} onUnfold={() => onFold(false)} />;

  const pushed = stack.entries.length > 1;
  const verbs = topFace.verbs ?? [];
  const next = stack.ahead[0];
  const ahead = next !== undefined ? <SpIcon icon="back" flip label={`Forward to ${crumbOf(next)}`} onPress={() => onStack(forward)} /> : null;
  const sub = (words: ReactNode, extra: Record<string, unknown> = {}): JSX.Element => (
    <Txt spec={{ voice: "app", scale: 0.92, color: "dim" }} ellip {...extra}>
      {words}
    </Txt>
  );
  const name = (
    <View flexDirection="row" alignItems="baseline" gap={8} minWidth={0}>
      <Txt spec={{ voice: "app", scale: 1.08, weight: 600, lineHeight: 1.3 }} ellip minWidth={0} flexShrink={1} title={topFace.titleText}>
        {topFace.title}
      </Txt>
      {pushed ? (
        <Txt spec={{ voice: "app", scale: 0.92, color: "dim" }} flexShrink={0}>
          {kindWordOf(top)}
        </Txt>
      ) : null}
    </View>
  );
  return (
    <View ref={frame as never} flex={1} flexDirection="column" minHeight={0}>
      <View flexDirection="row" alignItems="center" gap={8} minHeight={44} paddingTop={7} paddingRight={8} paddingBottom={7} paddingLeft={12} flexShrink={0} {...(edge(t, { bottom: 1 }) as object)}>
        {pushed ? (
          <>
            <SpIcon icon="back" label="Back" onPress={() => onStack(pop)} />
            {ahead}
            <View flex={1} minWidth={0} flexDirection="column" gap={1}>
              <View flexDirection="row" alignItems="baseline" gap={3} minWidth={0} overflow="hidden">
                {stack.entries.slice(0, -1).map((entry, i) => (
                  <View key={entry.key} flexDirection="row" alignItems="baseline" gap={3} minWidth={0}>
                    {i > 0 ? <Txt spec={{ voice: "app", scale: 0.9, color: "tok-hint" }}>›</Txt> : null}
                    <Press title={`Back to ${crumbOf(entry)}`} onPress={() => onStack((was) => popTo(was, i))} maxWidth={140} paddingHorizontal={2} borderRadius={3}>
                      {({ hovered }) => (
                        <Txt spec={{ voice: "app", scale: 0.9, color: hovered ? "accent" : "dim" }} ellip {...(hovered ? { textDecorationLine: "underline" } : {})}>
                          {i === 0 ? (rootFace?.titleText ?? crumbOf(entry)) : crumbOf(entry)}
                        </Txt>
                      )}
                    </Press>
                  </View>
                ))}
              </View>
              {name}
            </View>
          </>
        ) : (
          <>
            {ahead}
            {topFace.glyph !== undefined ? <View flexShrink={0}>{topFace.glyph}</View> : null}
            <View flex={1} minWidth={0} flexDirection="column" gap={1}>
              {name}
              {topFace.sub !== undefined ? sub(topFace.sub) : null}
            </View>
          </>
        )}
        {verbs.length > 0 ? (
          <View flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
            {verbs.map((verb) => (
              <SpIcon key={verb.label} icon={verb.icon} label={verb.label} primary={verb.primary === true} danger={verb.danger === true} disabled={verb.disabled === true} onPress={verb.onClick} />
            ))}
          </View>
        ) : null}
        <FrameControls stack={stack} onStack={onStack} onFold={() => onFold(true)} closeFolds={closeFolds} />
      </View>

      {pushed && topFace.sub !== undefined ? sub(topFace.sub, { flexShrink: 0, paddingVertical: 4, paddingHorizontal: 12, ...edge(t, { bottom: 1 }) }) : null}

      {stack.offer !== null ? (
        <View role="status" flexDirection="row" alignItems="center" gap={8} paddingTop={6} paddingRight={8} paddingBottom={6} paddingLeft={12} flexShrink={0} backgroundColor={colourOr(t, "tint-accent", "panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
          <Icon name="pin" size={t.replayed ? Number(t.scaled("size-app", 0.95)) : 12} color={String(t.v("accent"))} />
          <Txt spec={{ voice: "app", scale: 0.95 }} ellip flex={1} minWidth={0}>
            <Txt spec={{ voice: "app", scale: 0.95, weight: 700 }}>{offerName ?? crumbOf(stack.offer)}</Txt> is selected
          </Txt>
          {/* `button.link`: data at --size-data × 11/12, --accent, underlined under the pointer. */}
          <Press onPress={() => onStack(acceptOffer)} flexShrink={0}>
            {({ hovered }) => (
              <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} numberOfLines={1} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                Show it here
              </Txt>
            )}
          </Press>
          <SpIcon icon="cross" label="Dismiss" onPress={() => onStack((was) => ({ ...was, offer: null, motion: "none" }))} />
        </View>
      ) : null}

      {topFace.guard !== undefined ? (
        <View flexShrink={0} paddingVertical={6} paddingHorizontal={12} backgroundColor={colourOr(t, "tint-warn", "panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
          {topFace.guard}
        </View>
      ) : null}

      {tabbed?.tabs !== undefined && tabbed.tabs.length > 0 ? (
        <PanelTabs tabs={tabbed.tabs} open={tabbedAt === stack.entries.length - 1 ? tabbed.tab : undefined} onTab={(id) => onStack((was) => setTab(was, id))} />
      ) : null}

      {topFace.scroll === false ? (
        <View key={`${top.key}|${"tab" in top ? top.tab : ""}`} flex={1} minHeight={0} flexDirection="column" overflow="hidden" {...((isWeb ? { "data-spmotion": bodyMotion(stack.motion) } : {}) as object)}>
          {topFace.body}
        </View>
      ) : (
        <ScrollView
          key={`${top.key}|${"tab" in top ? top.tab : ""}`}
          {...(scrollbarProps(t) as object)}
          {...((isWeb ? { dataSet: { ...(scrollbarProps(t) as { dataSet?: object }).dataSet, spmotion: bodyMotion(stack.motion) } } : {}) as object)}
          // `PLAIN_SCROLLER`: the DOM's `.sp-body.scroll` is not composited, and its text is subpixel.
          style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never}
          // `.sp-body.scroll`: a column the scroller's height at least (a body that fills it, as Changes
          // does, grows into it), padded 12 12 18, 14 between its blocks.
          contentContainerStyle={{ flexGrow: 1, flexDirection: "column", gap: 14, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 18, ...PLAIN_SCROLLER } as never}
        >
          {topFace.body}
        </ScrollView>
      )}
    </View>
  );
}
