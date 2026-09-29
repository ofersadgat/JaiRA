import { Children, createContext, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View } from "@tamagui/core";
import type { ConfigPath } from "@jaira/shared/browser";
import type { LayerState } from "@jaira/ui/configWriter";
import { partIdOf, splitHint } from "@jaira/ui/settingsRows";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { SettingsLayerContext, useInheritLabel, useLayerRow } from "../settings/layers";
import { InfoIcon, InheritButton, SettingsSection, chOf, useDrawnRow } from "../settings/SettingsPage";

/**
 * `controls.tsx`'s `Field`, `FieldGrid`, `Level` and `Disclosure`, universal (decision 0015): the one
 * shape every typed value in the app is filled in through. On a Settings page (`FormRowsContext`) a
 * field is a settings row; everywhere else (a run's inputs, a gate) it keeps its own, smaller shape.
 * The rules, from `styles.css` (`cascade.mts '.cfg-field' --scene settings-runs`):
 *
 *   .cfg-fields          column; a container: at most 380 wide, its fields stack
 *   .cfg-field           grid: minmax(0,1fr) minmax(140px,15rem), centred, gap 6 22, padding 7 0;
 *                        after another, a 1px rule of --line at 60%
 *   .set-field           (on a page) minmax(0,1fr) minmax(170px,17rem), gap 10 32, padding 13 16;
 *                        after another in its list, a 1px --line
 *   .set-field.wide,     one column (the control under the name, across the row)
 *   .cfg-block > .cfg-field
 *   .cfg-control .set-field   padding 9 0 (a field inside a field's control)
 *   .cfg-field-say       column, gap 2 (3 on a page)
 *   .cfg-field-head      row, wraps, centred, gap 6
 *   .cfg-label           app 550 at 12/12.5 (on a page 1.1×, line 1.3, first letter up); .mono: data
 *                        11/12 at 500 (on a page data 1.02× at 550)
 *   .cfg-hint            app 11/12.5, line 1.4, --dim (on a page 1.03×, line 1.45, at most 62ch)
 *   .cfg-param           data 10/12, --dim, 6 after the hint, one line
 *   .cfg-set             app 9.5/12.5, 0.04em, upper, --accent on --tint-accent, radius 4, padding 1 5
 *   .cfg-control         row, wraps, 3 between lines, min 0; `.off` half opacity and out of reach
 *   .cfg-control > .cfg-fields   a nested form: 2px --line on its left, 11 in, 3 out
 *   .reason.cfg-error    --bad, app 11/12.5, a line of its own
 *   .cfg-level           column, gap 8; at depth 1–2 a 2px --line on its left, 12 in, 3 out (4 above
 *                        and below on a page)
 *   .cfg-level-title     app 600 at 11/12.5, 0.06em, upper, --dim; its hint under it (gap 2)
 *   .cfg-level-body      column, gap 10 (0 on a page, where the card's padding is 13 16 and the fields
 *                        take no inset of their own)
 */

/** Whether a {@link Field} is drawn on a Settings page — `SettingsRowsContext`. */
export const FormRowsContext = createContext(false);

/** Where a field stands: inside another field's control (`.cfg-control .set-field`), or in a level's card body. */
const PlaceContext = createContext<{ nested: boolean; inset: boolean; direct?: boolean }>({ nested: false, inset: false });

/**
 * Around a form that sits deeper in a field's control than its own list (a call-settings pane): its
 * fields are still a field's (`.cfg-control .set-field`), but its list is not the control's own child,
 * so it takes no rule on its left (`.cfg-control > .cfg-fields`).
 */
export function Deeper({ children }: { children: ReactNode }): JSX.Element {
  const place = useContext(PlaceContext);
  return <PlaceContext.Provider value={place.nested ? DEEPER : place}>{children}</PlaceContext.Provider>;
}

/** What a list says about each direct child: drawn or not, and whether it is a field (a rule goes between two). */
type SlotReport = (hidden: boolean, field: boolean) => void;
const SlotContext = createContext<SlotReport | null>(null);
/** A child wrapped as `.cfg-span` is not a `.cfg-field` of the list, so no rule is drawn beside it. */
const SpanContext = createContext(false);

/** A block that takes the whole row (`.cfg-span`); `block` makes a field in it one column (`.cfg-block`). */
export function Span({ block = false, children }: { block?: boolean; children: ReactNode }): JSX.Element {
  return (
    <SpanContext.Provider value={true}>
      <BlockContext.Provider value={block}>{children}</BlockContext.Provider>
    </SpanContext.Provider>
  );
}
const BlockContext = createContext(false);

/** A child of a list that draws something other than a field (a map, a note) tells its slot so. */
export function useFormSlot(hidden: boolean, field: boolean): void {
  const slot = useContext(SlotContext);
  const span = useContext(SpanContext);
  const isField = field && !span;
  useEffect(() => {
    slot?.(hidden, isField);
  }, [slot, hidden, isField]);
}

/**
 * `FieldGrid`: fields one under another, a rule between two. A child that draws nothing tells its slot,
 * so no rule is drawn for it — the DOM's `.set-field + .set-field`. At most 380 wide (or `min` 180 and
 * under) every field in it stacks.
 */
export function FieldGrid({ children, min = 210 }: { children: ReactNode; min?: number }): JSX.Element {
  const t = useTokens();
  const row = useContext(FormRowsContext);
  const place = useContext(PlaceContext);
  const items = Children.toArray(children);
  const [kinds, setKinds] = useState<ReadonlyArray<{ hidden: boolean; field: boolean } | undefined>>([]);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const narrow = min <= 180 || (width !== undefined && width <= 380);
  const setters = useMemo(
    () =>
      items.map((_, i): SlotReport => (hidden, field) =>
        setKinds((prev) => {
          if (prev[i]?.hidden === hidden && prev[i]?.field === field) return prev;
          const next = [...prev];
          next[i] = { hidden, field };
          return next;
        }),
      ),
    [items.length],
  );
  let before: boolean | undefined;
  const grid = useMemo(() => ({ narrow }), [narrow]);
  return (
    <GridContext.Provider value={grid}>
      <View
        flexDirection="column"
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        {...(place.nested && place.direct !== false ? { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0, marginLeft: 3, paddingLeft: 11, ...edge(t, { left: 2 }) } : {})}
        {...(place.inset ? { marginVertical: -13 } : {})}
      >
        {items.map((item, i) => {
          const kind = kinds[i] ?? { hidden: false, field: true };
          const line = !kind.hidden && kind.field && before === true;
          if (!kind.hidden) before = kind.field;
          return (
            <SlotContext.Provider key={i} value={setters[i]!}>
              {line ? <View height={0} {...(edge(t, { top: 1 }, row ? "line" : t.mix(t.v("line"), 60, "transparent")) as object)} /> : null}
              {item}
            </SlotContext.Provider>
          );
        })}
      </View>
    </GridContext.Provider>
  );
}
const GridContext = createContext<{ narrow: boolean }>({ narrow: false });

/**
 * One setting: its name, the key it writes, what it means, and its control — `controls.tsx`'s `Field`.
 * On a Settings page the hint is one sentence under the name, and the rest with the key behind an ⓘ.
 */
export function Field({
  label,
  param,
  hint,
  set = false,
  layer,
  off = false,
  wide = false,
  lead,
  after,
  mono = false,
  error,
  children,
}: {
  label: string;
  param?: string | undefined;
  hint?: ReactNode;
  set?: boolean;
  layer?: LayerState | undefined;
  off?: boolean;
  wide?: boolean;
  lead?: ReactNode;
  after?: ReactNode;
  mono?: boolean;
  error?: string | undefined;
  children: ReactNode;
}): JSX.Element | null {
  const t = useTokens();
  const row = useContext(FormRowsContext);
  const place = useContext(PlaceContext);
  const { narrow } = useContext(GridContext);
  const block = useContext(BlockContext);
  const paths: readonly ConfigPath[] | undefined = param !== undefined ? [param] : undefined;
  const layered = useLayerRow(paths, layer?.stated);
  const inherit = useInheritLabel(paths);
  useFormSlot(layered.hidden, true);
  useDrawnRow(!layered.hidden);
  if (layered.hidden) return null;
  const split = row && typeof hint === "string" ? splitHint(hint) : undefined;
  const more = split !== undefined ? [split.rest, param !== undefined ? `Writes ${param}.` : ""].filter((s) => s.length > 0).join(" ") : "";
  // Only a settings row goes one column when `wide` (`.set-field.wide`); a plain field keeps its two.
  const stack = (row && wide) || block || narrow;
  const hintSpec = row ? ({ voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim" } as const) : ({ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" } as const);
  const hintBox = row ? { maxWidth: chOf(t, 62, 1.03) } : {};
  const labelText = row && !mono && label.length > 0 ? label.charAt(0).toUpperCase() + label.slice(1) : label;
  const labelSpec = mono
    ? row
      ? ({ voice: "data", scale: 1.02, weight: 550, lineHeight: 1.3 } as const)
      : ({ voice: "data", scale: 11 / 12, weight: 500 } as const)
    : row
      ? ({ voice: "app", scale: 1.1, weight: 550, lineHeight: 1.3 } as const)
      : ({ voice: "app", scale: 12 / 12.5, weight: 550 } as const);
  const pad = row ? (place.nested ? { paddingVertical: 9, paddingHorizontal: 0 } : { paddingVertical: 13, paddingHorizontal: place.inset ? 0 : 16 }) : { paddingVertical: 7, paddingHorizontal: 0 };
  const controlWidth = row ? 272 : 240;
  return (
    <View
      {...pad}
      flexDirection={stack ? "column" : "row"}
      alignItems={stack ? "stretch" : "center"}
      gap={stack ? (row ? 10 : 6) : row ? 32 : 22}
      minWidth={0}
    >
      <View flexDirection="column" gap={row ? 3 : 2} minWidth={0} {...(stack ? {} : { flexGrow: 1, flexShrink: 1, flexBasis: 0 })}>
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6}>
          {lead}
          <Txt spec={{ ...labelSpec, color: off && row ? "dim" : "text" }}>
            {row && !mono && labelText.length > 1 ? (
              // `::first-letter` is a box of its own in the DOM, so the first letter is not kerned with the next.
              <>
                <Txt spec={{ ...labelSpec, color: off && row ? "dim" : "text" }}>{labelText.charAt(0)}</Txt>
                {labelText.slice(1)}
              </>
            ) : (
              labelText
            )}
          </Txt>
          {layer?.stated === true ? <InheritButton label={layer.label ?? inherit} onInherit={layer.onInherit} disabled={layer.disabled} /> : null}
          {set && layer === undefined ? (
            <Txt
              spec={{ voice: "app", scale: 9.5 / 12.5, ls: 0.04, upper: true, color: "accent" }}
              title="set in the layer you are editing"
              backgroundColor={t.v("tint-accent") as never}
              borderRadius={4}
              paddingVertical={1}
              paddingHorizontal={5}
            >
              set here
            </Txt>
          ) : null}
          {after}
          {more.length > 0 ? <InfoIcon info={more} /> : null}
        </View>
        {split !== undefined ? (
          split.first.length > 0 ? (
            <Txt spec={hintSpec} {...hintBox}>
              {split.first}
            </Txt>
          ) : null
        ) : hint !== undefined || param !== undefined ? (
          <Txt spec={hintSpec} {...hintBox}>
            {hint}
            {param !== undefined && !row ? (
              <Txt spec={{ voice: "data", scale: 10 / 12, lineHeight: 1.4, color: "dim" }} marginLeft={6} {...({ whiteSpace: "nowrap" } as object)}>
                {param}
              </Txt>
            ) : null}
          </Txt>
        ) : null}
        {layered.instead !== undefined ? (
          <Txt spec={{ ...hintSpec, italic: true }} {...hintBox}>
            {layered.instead}
          </Txt>
        ) : null}
      </View>
      <View
        flexDirection="row"
        flexWrap="wrap"
        rowGap={3}
        minWidth={0}
        {...(stack ? {} : { width: controlWidth, flexShrink: 0 })}
        {...(off ? { opacity: row ? 0.5 : 1, pointerEvents: "none" } : {})}
      >
        <SettingsLayerContext.Provider value={null}>
          <PlaceContext.Provider value={NESTED}>
            {/* What is inside a field's control is a form of its own: not a span of the list around it. */}
            <SpanContext.Provider value={false}>
              <BlockContext.Provider value={false}>{children}</BlockContext.Provider>
            </SpanContext.Provider>
          </PlaceContext.Provider>
        </SettingsLayerContext.Provider>
        {error !== undefined ? <ErrorLine>{error}</ErrorLine> : null}
      </View>
    </View>
  );
}
const NESTED = { nested: true, inset: false };
const DEEPER = { nested: true, inset: false, direct: false };
const INSET = { nested: false, inset: true };

/** `.reason.cfg-error`: what is wrong, on a line of its own under the control. */
export function ErrorLine({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} flexBasis="100%" width="100%">
      {children}
    </Txt>
  );
}

/**
 * One level of a configuration's type hierarchy — `controls.tsx`'s `Level`. At depth 0 it is a section
 * of its Settings page (a heading over one card, listed in the sidebar's accordion); below that a band
 * with an uppercase title, ruled on its left.
 */
export function Level({ title, hint, depth = 0, children }: { title: string; hint?: ReactNode; depth?: number; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const row = useContext(FormRowsContext);
  if (depth === 0) {
    const info = typeof hint === "string" ? hint : undefined;
    return (
      <SettingsSection id={partIdOf(title)} title={title} info={info} lead={hint !== undefined && info === undefined ? hint : undefined}>
        <View flexDirection="column" paddingVertical={13} paddingHorizontal={16}>
          <PlaceContext.Provider value={INSET}>{children}</PlaceContext.Provider>
        </View>
      </SettingsSection>
    );
  }
  return (
    <View
      flexDirection="column"
      gap={8}
      {...(depth <= 2 ? { paddingLeft: 12, marginLeft: 3, ...edge(t, { left: 2 }) } : {})}
      {...(row && depth <= 3 ? { marginVertical: 4 } : {})}
    >
      <View flexDirection="column" gap={2}>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, ls: 0.06, upper: true, color: "dim" }}>{title}</Txt>
        {hint !== undefined && hint !== "" ? <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" }}>{hint}</Txt> : null}
      </View>
      <View flexDirection="column" gap={10}>
        {children}
      </View>
    </View>
  );
}

/**
 * `Disclosure`: a rule and a caret over the settings most projects never touch.
 *
 *   .cfg-disclosure        1px --line above, 2 in
 *   .cfg-disclosure-head   row, centred, gap 8, padding 7 4, --dim (hovered --text); the caret app
 *                          9/12.5 turned a quarter when open; the title app 600 at 12/12.5; its desc a
 *                          `.cfg-hint` after "· "
 *   .cfg-disclosure-body   padding 4 4 11 17
 */
export function Disclosure({
  summary,
  desc,
  children,
  defaultOpen = false,
  card = false,
}: {
  summary: string;
  desc?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Straight in a card (`.set-group > .cfg-disclosure`): padding 13 16, its rule still at its top. */
  card?: boolean;
}): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View {...(card ? { paddingVertical: 13, paddingHorizontal: 16 } : { paddingTop: 2 })} {...(edge(t, { top: 1 }) as object)}>
      <Press onPress={() => setOpen((o) => !o)} {...({ "aria-expanded": open } as object)} flexDirection="row" alignItems="center" gap={8} paddingVertical={7} paddingHorizontal={4} borderRadius={5}>
        {({ hovered }) => (
          <>
            <Txt spec={{ voice: "app", scale: 9 / 12.5, color: hovered ? "text" : "dim" }} transform={[{ rotate: open ? "90deg" : "0deg" }]}>
              ▶
            </Txt>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: hovered ? "text" : "dim" }}>{summary}</Txt>
            {desc !== undefined && desc !== "" ? <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" }}>
              {/* Two text runs, as the DOM writes them: Blink shapes "· " and the words apart. */}
              {"· "}
              {desc}
            </Txt> : null}
          </>
        )}
      </Press>
      {open ? (
        <View paddingTop={4} paddingRight={4} paddingBottom={11} paddingLeft={17}>
          {children}
        </View>
      ) : null}
    </View>
  );
}
