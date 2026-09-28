import { Children, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { LayoutChangeEvent, View as RNView } from "react-native";
import { View } from "@tamagui/core";
import type { LeadPart } from "@jaira/ui/settingsSections";
import type { RowLayer } from "@jaira/ui/settingsRows";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { SettingsLayerContext, useInheritLabel, useLayerRow } from "./layers";
import { dropPart, partsMoved, placePart } from "./parts";

/**
 * `settingsLayout.tsx`'s page, section and row, universal (decision 0015): the shape every Settings page
 * is built from. Read that file for what each is for; the rules they carry, from `styles.css`
 * (`cascade.mts '.set-page' --scene settings-appearance` prints them as Chromium applies them):
 *
 *   .set-page            column, gap 26, at most 1040 wide, padding 6 4 36
 *   .set-head            row, space-between, top-aligned, gap 16, never wraps; at most 740 wide
 *   .set-title           app 650 at 1.5×, line 1.2, -0.015em, --text
 *   .set-lead            app 400 at 1.04×, line 1.5, --dim, 5 above; its <b>: 600, --text
 *   .set-under           10 above (the Just you view's "Which rows")
 *   .set-head-aside      flex none, 2 down (the layer switch)
 *   .set-nothing         shown only when "What you changed" leaves nothing: 18 16 inside a dashed
 *                        --line, radius 12, --dim, at most 740 wide
 *   .set-section         column, gap 10, at most 740 wide (not `wide`); hidden under "What you changed"
 *                        when it is not stated and none of its rows are drawn
 *   .set-section-title   row, centred, space-between, gap 12, at least 26 tall, 16 in; app 450 at 1.1×,
 *                        line 1.3, -0.005em, --text at 68%; the name a row with its ↺ and ⓘ, gap 6
 *   .set-section-lead    a `.cfg-hint` (app 11/12.5, line 1.4, --dim) 16 in, at most 72ch, 4 closer
 *   .set-group           1px --line, radius 12, --panel, a 0 1 2 shadow at 3%; a --line between its
 *                        children; under 540 wide its rows stack
 *   .set-row             padding 13 16; the line a row: the words (flex, min 0) and the control
 *                        (its own width), centred, 32 apart
 *   .set-name            row, centred, gap 6, at least 20 tall; app 550 at 1.1×, line 1.3, --text
 *   .set-desc            app at 1.03×, line 1.45, --dim, 3 above, at most 62ch
 *   .set-instead         italic, --dim
 *   .set-ctl             row, centred, right-aligned, gap 8
 *   .set-icon            ↺ and ⓘ: 20 square, centred, radius 5, --dim at 0.96×, line 1; ↺ hovered
 *                        --fill-ghost-hover and --text
 */

/** `ch` in the app face (DM Sans: the advance of its "0"), as a fraction of the size — measured in Chromium. */
const CH = 541.1354 / 62 / 12.875;

/** `n`ch at the app size times `scale`: a number where sizes are, the CSS length where they are not. */
function chOf(t: ReturnType<typeof useTokens>, n: number, scale: number): number | string {
  const size = t.scaled("size-app", scale);
  return typeof size === "number" ? n * CH * size : `${n}ch`;
}

/** Whether "What you changed" left anything on the page: every row and stated section drawn says so. */
const PageContext = createContext<{ mark: (key: object, drawn: boolean) => void } | null>(null);

/** A row of the page that counts as drawn — `.cfg-field`, `.set-row:not(.full)`, `.cfg-row` in the CSS's `:has()`. */
function useDrawnRow(drawn: boolean): void {
  const page = useContext(PageContext);
  const section = useContext(SectionContext);
  const key = useRef({}).current;
  useEffect(() => {
    page?.mark(key, drawn);
    section?.mark(key, drawn);
    return () => {
      page?.mark(key, false);
      section?.mark(key, false);
    };
  }, [page, section, key, drawn]);
}

/** Children marked drawn, with how many — for the page's "nothing here" line and a section's hiding. */
function useMarks(): { count: number; mark: (key: object, drawn: boolean) => void } {
  const marks = useRef(new Set<object>()).current;
  const [count, setCount] = useState(0);
  const mark = useCallback(
    (key: object, drawn: boolean) => {
      if (drawn) marks.add(key);
      else marks.delete(key);
      setCount(marks.size);
    },
    [marks],
  );
  return { count, mark };
}

/** A Settings page: its title, whose settings these are, and its sections. */
export function SettingsPage({
  title,
  lead,
  under,
  aside,
  onlyStated = false,
  children,
}: {
  title: string;
  lead?: readonly LeadPart[] | undefined;
  under?: ReactNode;
  aside?: ReactNode;
  onlyStated?: boolean;
  children: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const { count, mark } = useMarks();
  const page = useMemo(() => ({ mark }), [mark]);
  return (
    <PageContext.Provider value={page}>
      <View flexDirection="column" gap={26} maxWidth={1040} paddingTop={6} paddingHorizontal={4} paddingBottom={36} onLayout={partsMoved}>
        <View flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={16} maxWidth={740}>
          <View flexShrink={1} minWidth={0}>
            <Txt spec={{ voice: "app", scale: 1.5, weight: 650, ls: -0.015, lineHeight: 1.2 }} role="heading" aria-level={1}>
              {title}
            </Txt>
            {lead !== undefined ? (
              <Txt spec={{ voice: "app", scale: 1.04, color: "dim" }} marginTop={5}>
                {lead.map((part, i) =>
                  part.bold === true ? (
                    <Txt key={i} spec={{ voice: "app", scale: 1.04, weight: 600 }}>
                      {part.text}
                    </Txt>
                  ) : (
                    part.text
                  ),
                )}
              </Txt>
            ) : null}
            {under !== undefined ? (
              <View marginTop={10} flexDirection="row">
                {under}
              </View>
            ) : null}
          </View>
          {aside !== undefined ? (
            <View flexShrink={0} marginTop={2}>
              {aside}
            </View>
          ) : null}
        </View>
        {onlyStated && count === 0 ? (
          <View maxWidth={740} paddingVertical={18} paddingHorizontal={16} borderRadius={12} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", "dashed") as object)}>
            <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>Nothing is set just for you on this page. Choose Every row to set something.</Txt>
          </View>
        ) : null}
        {children}
      </View>
    </PageContext.Provider>
  );
}

const SectionContext = createContext<{ mark: (key: object, drawn: boolean) => void } | null>(null);

/** The ↺ beside a stated row's or section's name: take it out of this layer, so it inherits. */
export function InheritButton({ label, onInherit, disabled }: { label: string; onInherit: () => void; disabled?: boolean | undefined }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onInherit}
      disabled={disabled}
      label={label}
      title={label}
      width={20}
      height={20}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      borderRadius={5}
      {...(disabled === true ? { opacity: 0.5 } : {})}
      box={({ hovered }) => ({ backgroundColor: hovered && disabled !== true ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: 0.96, color: hovered && disabled !== true ? "text" : "dim", lineHeight: 1 }} textAlign="center">
          ↺
        </Txt>
      )}
    </Press>
  );
}

/** `ResetButton`: ↺ — put this setting back to what it would be untouched. */
export function ResetButton({ label, onReset, disabled }: { label: string; onReset: () => void; disabled?: boolean | undefined }): JSX.Element {
  return <InheritButton label={label} onInherit={onReset} disabled={disabled} />;
}

/** ⓘ beside a name: the rest of the explanation, on hover. */
export function InfoIcon({ info }: { info: string }): JSX.Element {
  return (
    <View width={20} height={20} flexShrink={0} alignItems="center" justifyContent="center" borderRadius={5} role="img" aria-label={info} {...({ title: info } as object)}>
      <Txt spec={{ voice: "app", scale: 0.96, color: "dim", lineHeight: 1 }} textAlign="center">
        ⓘ
      </Txt>
    </View>
  );
}

/** ↺ beside a layered row's or section's name, while the page's layer states it. */
function LayerInherit({ layer }: { layer: RowLayer }): JSX.Element | null {
  const label = useInheritLabel(layer.paths, layer.format);
  return layer.stated ? <InheritButton label={label} onInherit={layer.onInherit} disabled={layer.disabled} /> : null;
}

/** A section's heading and its `.set-section-lead` lines. */
function SectionTitle({ title, info, action, layer }: { title: string; info?: string | undefined; action?: ReactNode; layer?: RowLayer | undefined }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" justifyContent="space-between" gap={12} minHeight={26} paddingHorizontal={16} role="heading" aria-level={2}>
      <View flexDirection="row" alignItems="center" gap={6} flexShrink={1} minWidth={0}>
        <Txt spec={{ voice: "app", scale: 1.1, weight: 450, lineHeight: 1.3, ls: -0.005, color: t.mix(t.v("text"), 68, "transparent") }}>{title}</Txt>
        {layer !== undefined ? <LayerInherit layer={layer} /> : null}
        {info !== undefined ? <InfoIcon info={info} /> : null}
      </View>
      {action}
    </View>
  );
}

/** A `.set-section-lead cfg-hint` line under a heading. */
function SectionLead({ children, italic = false }: { children: ReactNode; italic?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim", italic }} marginTop={-4} paddingHorizontal={16} maxWidth={chOf(t, 72, 11 / 12.5)}>
      {children}
    </Txt>
  );
}

/**
 * One section: a heading over one card of rows — and a place the sidebar's accordion lists and scrolls
 * to (`parts.ts`). `plain` drops the card, `wide` lets it take the page's full width.
 */
export function SettingsSection({
  id,
  title,
  info,
  lead,
  action,
  plain = false,
  wide = false,
  layer,
  children,
}: {
  id: string;
  title: string;
  info?: string | undefined;
  lead?: ReactNode;
  action?: ReactNode;
  plain?: boolean;
  wide?: boolean;
  layer?: RowLayer | undefined;
  children: ReactNode;
}): JSX.Element | null {
  const layered = useLayerRow(layer?.paths, layer?.stated, layer?.format);
  const at = useContext(SettingsLayerContext);
  const page = useContext(PageContext);
  const { count, mark } = useMarks();
  const section = useMemo(() => ({ mark }), [mark]);
  // A stated section counts as drawn on its own; otherwise it is drawn while one of its rows is.
  useDrawnRow(layer?.stated === true && !layered.hidden);
  const hidden = at?.onlyStated === true && layer?.stated !== true && count === 0;
  const view = useRef<RNView | null>(null);
  const gone = hidden || (layer !== undefined && layered.hidden);
  useEffect(() => {
    if (gone || view.current === null) return undefined;
    placePart(id, title, view.current);
    return () => dropPart(id);
  }, [id, title, gone]);
  if (layer !== undefined && layered.hidden) return null;
  const body = plain ? children : <SettingsGroup>{children}</SettingsGroup>;
  return (
    <SectionContext.Provider value={section}>
      <View
        flexDirection="column"
        gap={10}
        {...(wide ? {} : { maxWidth: 740 })}
        {...(hidden ? { display: "none" } : {})}
        ref={view as never}
        onLayout={partsMoved}
      >
        <SectionTitle title={title} info={info} action={action} layer={layer} />
        {lead !== undefined ? <SectionLead>{lead}</SectionLead> : null}
        {layered.instead !== undefined ? <SectionLead italic>{layered.instead}</SectionLead> : null}
        {layer === undefined ? body : <SettingsLayerContext.Provider value={null}>{body}</SettingsLayerContext.Provider>}
      </View>
    </SectionContext.Provider>
  );
}

/** Whether a card's rows stack (the card under 540 wide), and each slot's say in whether it is drawn. */
const GroupContext = createContext<{ narrow: boolean }>({ narrow: false });
const SlotContext = createContext<((hidden: boolean) => void) | null>(null);

/**
 * `.set-group`: one card, a --line between whatever it holds. A child that draws nothing (a row the
 * Just you view leaves out) says so through its slot, so no line is drawn for it — the DOM's `* + *`.
 */
export function SettingsGroup({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  const items = Children.toArray(children);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [narrow, setNarrow] = useState(false);
  const group = useMemo(() => ({ narrow }), [narrow]);
  const setters = useMemo(
    () =>
      items.map((_, i) => (off: boolean) =>
        setHidden((prev) => {
          if (prev.has(i) === off) return prev;
          const next = new Set(prev);
          if (off) next.add(i);
          else next.delete(i);
          return next;
        }),
      ),
    [items.length],
  );
  let before = false;
  return (
    <GroupContext.Provider value={group}>
      <View
        borderRadius={12}
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        {...({ boxShadow: "0 1px 2px rgba(0, 0, 0, 0.03)" } as object)}
        onLayout={(e: LayoutChangeEvent) => setNarrow(e.nativeEvent.layout.width <= 540)}
      >
        {items.map((item, i) => {
          const line = before && !hidden.has(i);
          if (!hidden.has(i)) before = true;
          return (
            <SlotContext.Provider key={i} value={setters[i]!}>
              {/* A border, not a 1px box: Chromium draws a 1px border a whole device pixel wide (⅔ of a px at 1.5×), as the DOM's `border-top` is. */}
              {line ? <View height={0} {...(edge(t, { top: 1 }) as object)} /> : null}
              {item}
            </SlotContext.Provider>
          );
        })}
      </View>
    </GroupContext.Provider>
  );
}

/** A child of a card that may draw nothing tells its slot. */
function useSlot(hidden: boolean): void {
  const slot = useContext(SlotContext);
  useEffect(() => {
    slot?.(hidden);
  }, [slot, hidden]);
  useEffect(() => () => slot?.(false), [slot]);
}

/**
 * One setting: its name, one sentence under it, and its control at the right edge. `children` go
 * UNDER the row across its whole width (a preview); `full` drops the control for a row that is only a
 * heading over them.
 */
export function SettingsRow({
  name,
  description,
  info,
  reset,
  control,
  full = false,
  layer,
  children,
}: {
  name: ReactNode;
  description?: ReactNode;
  info?: string | undefined;
  reset?: { label: string; onReset: () => void; disabled?: boolean } | undefined;
  control?: ReactNode;
  full?: boolean;
  layer?: RowLayer | undefined;
  children?: ReactNode;
}): JSX.Element | null {
  const t = useTokens();
  const layered = useLayerRow(layer?.paths, layer?.stated, layer?.format);
  const { narrow } = useContext(GroupContext);
  const hidden = layered.hidden && (layer !== undefined || !full);
  useSlot(hidden);
  useDrawnRow(!hidden && !full);
  if (hidden) return null;
  const desc = (text: ReactNode, italic = false): JSX.Element => (
    <Txt spec={{ voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim", italic }} marginTop={3} maxWidth={chOf(t, 62, 1.03)}>
      {text}
    </Txt>
  );
  const stack = narrow && !full;
  return (
    <View paddingVertical={13} paddingHorizontal={16}>
      <View flexDirection={stack ? "column" : "row"} alignItems={stack ? "stretch" : "center"} gap={stack ? 10 : 32}>
        <View flex={stack ? undefined : 1} flexBasis={stack ? undefined : 0} minWidth={0}>
          <View flexDirection="row" alignItems="center" gap={6} minHeight={20} role="heading" aria-level={3}>
            {typeof name === "string" ? <Txt spec={{ voice: "app", scale: 1.1, weight: 550, lineHeight: 1.3 }}>{name}</Txt> : name}
            {layer !== undefined ? <LayerInherit layer={layer} /> : null}
            {reset !== undefined ? <ResetButton {...reset} /> : null}
            {info !== undefined ? <InfoIcon info={info} /> : null}
          </View>
          {description === undefined ? null : typeof description === "string" ? (
            desc(description)
          ) : (
            // Words and a block under them (a font row's resolved stack): the row lays them out.
            <View marginTop={3} maxWidth={chOf(t, 62, 1.03)}>
              {description}
            </View>
          )}
          {layered.instead !== undefined ? desc(layered.instead, true) : null}
        </View>
        {control !== undefined && !full ? (
          <View flexDirection="row" alignItems="center" justifyContent={stack ? "flex-start" : "flex-end"} gap={8} minWidth={0} flexShrink={0}>
            {control}
          </View>
        ) : null}
      </View>
      {children}
    </View>
  );
}
