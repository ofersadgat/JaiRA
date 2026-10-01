import { galleryServices } from "@jaira/ui/galleryRemote";
import { useRef, useState, type JSX, type ReactNode } from "react";
import { ScrollView, type LayoutChangeEvent, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { GALLERY_GROUPS, schemaById, surfacesOfGroups, type GalleryGroup, type GallerySurface, type ValidateSchemaResult } from "@jaira/shared/browser";
import {
  approvalOf,
  clampSlide,
  configCaption,
  initialState,
  interactionOf,
  interactionResult,
  parsedDoc,
  questionOf,
  slideAllTitle,
  slideAt,
  slidesFor,
  variantsAcross,
  type CardState,
  type Editor,
} from "@jaira/ui/galleryModel";
import { PLAIN_SCROLLER, Press, Txt, appCh, edge, lengthToken, scrollbarProps, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { SchemaJsonEditor } from "../files/SchemaEdit";
import { Button } from "../settings/Button";
import { GateSurface } from "../panel/Gate";
import { Outputs } from "../debug/DebugPane";
import { SchemaForm } from "../form/SchemaForm";
import { ApprovalSurface } from "../floats/ApprovalSurface";
import { QuestionSurface } from "../floats/QuestionSurface";
import type { Schema } from "@jaira/ui/schemaForm/types";

/**
 * The Components room's page (`GalleryPane`) and its gallery (`ComponentGallery`): the page's heading,
 * the bar that slides every row to one variant, and a row per surface — its heading, its tabs and
 * arrows, and a carousel of cards. What it derives is `galleryModel.ts`. In a card, an interaction's
 * dialog is the gate's own surface (`GateSurface`, the side panel's) and its config's form the one form
 * (`form/SchemaForm`); an approval and a question are their surfaces (`floats/ApprovalSurface`,
 * `floats/QuestionSurface`) under an accent rule (`InlineGateBox`); a review, an edit and a changeset
 * review are `artifact/`'s, wired to the gallery's own services (`galleryServices`, which reach
 * nothing); its JSON view the schema editor (`files/SchemaEdit`'s `SchemaJsonEditor`, the schema
 * locked), checked by the store's `validateSchema`. How it looks:
 *
 *   the page             --bg, scrolls, padding 12 14, column, gap 18
 *   its head             column, gap 8; the heading 700 app at 15/12.5; the words ≤ 80ch, line 1.5
 *   the gallery          column, gap 14
 *   the bar              sticky, row, wrapping, centred, gap 6, padding 8 0, --bg, a --line under it
 *   a bar button         a chip that is a button: app at 10/12.5, --dim, 1px --line, radius 999,
 *                        padding 0 6, --panel-2 (hovered --panel-3, --rule, --text), gap 5; the
 *                        variant data 11/12, its count of rows data 10/12 --dim
 *   a row                column, gap 10;  its head column, gap 8, padding-top 8, a --line above
 *   a row's title        column, gap 4; the heading (700, app 14/12.5, 0.09em, uppercase, --dim, a row
 *                        spread apart, gap 8) holding the title, a chip and the component's name
 *                        (the data face, --dim)
 *   a row's controls     row, centred, spread apart, gap 10, wrapping
 *   a tab                padding 2 11, app 11/12.5, the first radius 5 0 0 5, the last 0 5 5 0 and −1
 *                        left; the one showing filled (--fill-accent, --on-accent 600, --sheen), the
 *                        rest ghost
 *   the arrows           row, centred, gap 4; buttons (ghost) ≥ 28 wide, padding 2 8, app 14/12.5 on a
 *                        line of 1; the counter data 11/12 --dim, ≥ 3ch, centred
 *   the track            a row that scrolls sideways, a slide per variant, each the track's width
 *   a card               column, gap 10, padding 12, 1px --line, radius --card-radius, --panel
 *   a card's head        column, gap 3; the title 700 app 12.5/12.5; the note ≤ 80ch, line 1.5
 *   a card's body        the stage (the rest) and the side (≥ 280, 34%), gap 10, stretched; stacked
 *                        when the card is 720 or narrower
 *   the stage            padding 12, 1px dashed --line, radius 8, --bg
 *   the side             at least 320 tall; the config box fills it: column, gap 8, padding 8, 1px
 *                        --line, radius 8, --panel-2, scrolls; its head a row, centred, gap 10
 */
/** The schema check, over the bridge — the store's, the same one every JSON editor in the app uses. */
type Validate = (schemaId: string, text: string) => Promise<ValidateSchemaResult | null>;

export function GalleryPane({ validateSchema }: { validateSchema: Validate }): JSX.Element {
  const t = useTokens();
  return (
    <ScrollView
      // On web it scrolls both ways (`overflow: auto`): a row of tabs wider than the page widens it.
      style={{ flex: 1, minWidth: 0, backgroundColor: t.v("bg") as string, ...PLAIN_SCROLLER, ...(isWeb ? { overflowX: "auto" } : {}) } as never}
      contentContainerStyle={{ paddingVertical: 12, paddingHorizontal: 14, ...PLAIN_SCROLLER } as never}
      {...scrollbarProps(t)}
    >
      <View flexDirection="column" gap={8} marginBottom={18}>
        <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 700 }}>Components</Txt>
        <Txt spec={{ ...SUB, lineHeight: 1.5 }} maxWidth={appCh(t, 11 / 12.5, 80) as number}>
          Every surface a run can put in front of you, with nothing behind it: the six built-in UI components a state&apos;s <Code>operation.function</Code> may name, the fallback for one it may not, and the two dialogs JaiRA raises on its own — a
          command approval and an agent&apos;s question. One row each; flip through the variations its config can express, or use the bar to send every row to the same one. Each card renders the REAL dialog from the config beside it — so
          editing the config is editing what you see, and answering it shows what a state&apos;s declared outputs would receive.
        </Txt>
      </View>
      <ComponentGallery validateSchema={validateSchema} />
    </ScrollView>
  );
}

const SUB: FontSpec = { voice: "app", scale: 11 / 12.5, color: "dim" };


/** Code in the page's words: the data face at 11/12. */
function Code({ children }: { children: ReactNode }): JSX.Element {
  return <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim", lineHeight: 1.5 }}>{children}</Txt>;
}

/** `ComponentGallery`: the bar, then a row per group. */
function ComponentGallery({ groups = GALLERY_GROUPS, validateSchema }: { groups?: readonly GalleryGroup[]; validateSchema: Validate }): JSX.Element {
  const t = useTokens();
  const surfaces = surfacesOfGroups(groups);
  const [cards, setCards] = useState<Record<string, CardState>>(() => Object.fromEntries(surfaces.map((s) => [s.id, initialState(s)])));
  const patch = (id: string, next: Partial<CardState>): void =>
    setCards((held) => {
      const seed = held[id] ?? initialState(surfaces.find((s) => s.id === id)!);
      return { ...held, [id]: { ...seed, ...next } };
    });
  // Each row's track, and its width: which slide a row shows is the track's own scroll (`slideAt`).
  const tracks = useRef<Record<string, { scroll: ScrollView | null; width: number }>>({});
  const [showing, setShowing] = useState<Record<string, number>>({});
  const slideTo = (group: GalleryGroup, index: number): void => {
    const track = tracks.current[group.id];
    if (track?.scroll === null || track === undefined) return;
    track.scroll.scrollTo({ x: clampSlide(group, index) * track.width, animated: true });
  };
  const across = variantsAcross(groups);
  return (
    <View flexDirection="column" gap={14}>
      <View
        // Sticky on web, over the rows (z-index 2); a phone has no sticky. A sticky box is held under its
        // SCROLLER's padding, and the page's 12 is the content's here: the same place is 12 down.
        {...((isWeb ? { position: "sticky", top: 12, zIndex: 2 } : {}) as object)}
        flexDirection="row"
        flexWrap="wrap"
        alignItems="center"
        gap={6}
        paddingVertical={8}
        backgroundColor={t.v("bg") as never}
        {...(edge(t, { bottom: 1 }) as object)}
        role="toolbar"
        aria-label="Show every row's variant"
      >
        <Txt spec={SUB}>Every row to</Txt>
        {across.map(({ id, rows }) => (
          <Press
            key={id}
            title={slideAllTitle(id, rows)}
            onPress={() => {
              for (const [group, at] of slidesFor(groups, id)) slideTo(group, at);
            }}
            flexDirection="row"
            alignItems="center"
            gap={5}
            paddingHorizontal={6}
            borderRadius={999}
            flexShrink={0}
            box={({ hovered }) => ({ ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, hovered ? "rule" : "line"), borderRadius: 999, backgroundColor: t.v(hovered ? "panel-3" : "panel-2") })}
          >
            {({ hovered }) => (
              <>
                <Txt spec={{ voice: "data", scale: 11 / 12, color: hovered ? "text" : "dim" }}>{id}</Txt>
                <Txt spec={{ voice: "data", scale: 10 / 12, color: "dim" }}>{String(rows)}</Txt>
              </>
            )}
          </Press>
        ))}
      </View>
      {groups.map((group) => {
        const at = Math.min(showing[group.id] ?? 0, group.variants.length - 1);
        return (
          <View key={group.id} flexDirection="column" gap={10}>
            <RowHead group={group} at={at} onSlide={(i) => slideTo(group, i)} />
            <ScrollView
              horizontal
              // On web the snapping is written here (the track's `scrollSnapType`, a slide's
              // `scrollSnapAlign`): react-native-web's `pagingEnabled` wraps each slide in a view of its own,
              // which is a stacking context — and a card's pinned Save row (z-index 2) then stood UNDER the
              // sticky bar (z-index 2 as well); unwrapped, it comes later in the page and is drawn over it.
              pagingEnabled={!isWeb}
              showsHorizontalScrollIndicator={false}
              ref={(el) => {
                tracks.current[group.id] = { scroll: el, width: tracks.current[group.id]?.width ?? 0 };
              }}
              onLayout={(e: LayoutChangeEvent) => {
                const width = e.nativeEvent.layout.width;
                tracks.current[group.id] = { scroll: tracks.current[group.id]?.scroll ?? null, width };
                setShowing((held) => ({ ...held, [`${group.id}#w`]: width }));
              }}
              onScroll={(e) => {
                const i = slideAt(e.nativeEvent.contentOffset.x, e.nativeEvent.layoutMeasurement.width);
                if (i !== (showing[group.id] ?? 0)) setShowing((held) => ({ ...held, [group.id]: i }));
              }}
              scrollEventThrottle={16}
              style={{ flexGrow: 0, ...PLAIN_SCROLLER, ...(isWeb ? { scrollSnapType: "x mandatory" } : {}) } as never}
              contentContainerStyle={{ alignItems: "flex-start", ...PLAIN_SCROLLER } as never}
            >
              {/* A slide is the track's width, so none is drawn before the track has one: a percentage of a
                  sideways scroller's content is of nothing, and a card laid out that wide first would have
                  its form measure itself wide. */}
              {(showing[`${group.id}#w`] ?? 0) <= 0 ? null : group.variants.map((variant) => {
                const surface = surfaces.find((s) => s.group === group.id && s.variant === variant.id)!;
                const width = showing[`${group.id}#w`];
                return (
                  <View key={surface.id} width={width} minWidth={0} {...((isWeb ? { style: { scrollSnapAlign: "start" } } : {}) as object)}>
                    <GalleryCard
                      surface={surface}
                      state={cards[surface.id] ?? initialState(surface)}
                      validateSchema={validateSchema}
                      onText={(text) => patch(surface.id, { text })}
                      onEditor={(editor) => patch(surface.id, { editor })}
                      onReset={() => patch(surface.id, { ...initialState(surface), result: undefined })}
                      onResult={(result) => patch(surface.id, { result })}
                    />
                  </View>
                );
              })}
            </ScrollView>
          </View>
        );
      })}
    </View>
  );
}

/** A row's head: what the surface is, and the row's own controls. */
function RowHead({ group, at, onSlide }: { group: GalleryGroup; at: number; onSlide: (index: number) => void }): JSX.Element {
  const t = useTokens();
  const many = group.variants.length > 1;
  return (
    <View flexDirection="column" gap={8} paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
      <View flexDirection="column" gap={4}>
        {/* The heading is a row spread apart, and what is inside it takes its weight, its capitals and its
            spacing — 0.09em of 14px, as that length whatever its own size. */}
        <View flexDirection="row" alignItems="center" justifyContent="space-between" gap={8}>
          <Txt spec={{ voice: "app", scale: 14 / 12.5, weight: 700, ls: 0.09, upper: true, color: "dim" }}>{group.title}</Txt>
          <Chip spec={{ weight: 700, upper: true, ls: (0.09 * 14) / 10 }}>{group.kind}</Chip>
          {group.component !== undefined ? <Txt spec={{ voice: "data", scale: 11 / 12, weight: 700, upper: true, ls: (0.09 * 14) / 11, color: "dim" }}>{group.component}</Txt> : null}
        </View>
        <Txt spec={{ ...SUB, lineHeight: 1.5 }} maxWidth={appCh(t, 11 / 12.5, 80) as number}>
          {group.blurb}
        </Txt>
      </View>
      <View flexDirection="row" alignItems="center" justifyContent="space-between" gap={10} flexWrap="wrap">
        {/* The tabs neither shrink nor wrap: the row is as wide as all of them, the arrows wrap under it,
            and a row wider than the page scrolls the page sideways. */}
        <Seg options={group.variants.map((v, i) => ({ label: v.title, on: i === at, title: v.note, onPress: () => onSlide(i) }))} />
        {many ? (
          <View flexDirection="row" alignItems="center" gap={4} flexShrink={0}>
            <Arrow glyph="‹" label="Previous variant" disabled={at === 0} onPress={() => onSlide(at - 1)} />
            <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} minWidth={monoCh(t, 3)} textAlign="center">
              {`${at + 1}/${group.variants.length}`}
            </Txt>
            <Arrow glyph="›" label="Next variant" disabled={at === group.variants.length - 1} onPress={() => onSlide(at + 1)} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** `3ch` of the data face at 11/12. */
function monoCh(t: Tokens, n: number): number {
  const size = t.scaled("size-data", 11 / 12);
  return typeof size === "number" ? n * 0.6 * size : n * 6.6;
}

/** An arrow button: ghost, ≥ 28 wide, padding 2 8, the glyph at 14/12.5 on a line of 1. */
function Arrow({ glyph, label, disabled, onPress }: { glyph: string; label: string; disabled: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  const size = t.scaled("size-app", 14 / 12.5);
  return (
    <Button kind="ghost" label={label} disabled={disabled} onPress={onPress} minWidth={28} paddingVertical={2} paddingHorizontal={8}>
      <Txt spec={{ voice: "app", scale: 14 / 12.5, lineHeight: typeof size === "number" ? { px: size } : 1 }}>{glyph}</Txt>
    </Button>
  );
}

/**
 * Segmented tabs: buttons side by side with no gap, the first rounded on the left, the last on the right
 * and pulled 1 over its neighbour's edge; the one showing is filled with the accent, the rest ghost.
 */
function Seg({ options }: { options: { label: string; on: boolean; title?: string; disabled?: boolean; onPress: () => void }[] }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexShrink={0}>
      {options.map((o, i) => {
        const first = i === 0;
        const last = i === options.length - 1;
        const r = 5;
        return (
          <Press
            key={`${o.label}-${i}`}
            onPress={o.onPress}
            {...(o.title !== undefined ? { title: o.title } : {})}
            disabled={o.disabled === true}
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            paddingVertical={2}
            paddingHorizontal={11}
            flexShrink={0}
            {...(last ? { marginLeft: -1 } : {})}
            {...(o.disabled === true ? { opacity: 0.5 } : {})}
            box={({ hovered }) => {
              const hover = hovered && o.disabled !== true;
              const ring = o.on ? t.v(hover ? "fill-accent-hover" : "fill-accent") : t.v(hover ? "rule" : "line");
              return {
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: ring,
                borderTopLeftRadius: last ? 0 : first ? r : 0,
                borderBottomLeftRadius: last ? 0 : first ? r : 0,
                borderTopRightRadius: last ? r : 0,
                borderBottomRightRadius: last ? r : 0,
                backgroundColor: o.on ? t.v(hover ? "fill-accent-hover" : "fill-accent") : hover ? t.v("fill-ghost-hover") : "transparent",
                ...(o.on && o.disabled !== true ? { boxShadow: t.v("sheen") } : {}),
              };
            }}
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: o.on ? 600 : 400, color: o.on ? "on-accent" : "text" }} numberOfLines={1}>
              {o.label}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

/** A chip: app at 10/12.5, --dim, a 1px --line pill, padding 0 6. */
function Chip({ children, tone, spec }: { children: ReactNode; tone?: "ok" | "bad"; spec?: Partial<FontSpec> }): JSX.Element {
  const t = useTokens();
  return (
    <View flexShrink={0} paddingHorizontal={6} borderRadius={999} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, tone ?? "line") as object)}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: tone ?? "dim", ...spec }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

/** `GalleryCard`: the variation's heading, its stage and its config, and what it last submitted. */
function GalleryCard({
  surface,
  state,
  validateSchema,
  onText,
  onEditor,
  onReset,
  onResult,
}: {
  surface: GallerySurface;
  state: CardState;
  validateSchema: Validate;
  onText: (text: string) => void;
  onEditor: (editor: Editor) => void;
  onReset: () => void;
  onResult: (result: CardState["result"]) => void;
}): JSX.Element {
  const t = useTokens();
  const entry = surface.schemaId === null ? undefined : schemaById(surface.schemaId);
  const parsed = parsedDoc(state.text);
  // The body's width, in place of a container query: two columns while the card's content (the body) is
  // wider than 720, stacked below that.
  const [width, setWidth] = useState(0);
  const stacked = width > 0 && width <= 720;
  // The config box's inside height, beside the stage: in the JSON view its content is held to it, so the
  // editor takes what the head leaves (flex 1 1 auto) and shrinks to it; a scroller's content, left to
  // itself, would only grow.
  const [sideHeight, setSideHeight] = useState(0);
  const heldToBox = state.editor !== "form" && !stacked && sideHeight > 0;
  return (
    <View
      flexDirection="column"
      gap={10}
      padding={12}
      borderRadius={lengthToken(t, "card-radius", 10)}
      backgroundColor={t.v("panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      testID={`gallery-${surface.id}`}
    >
      <View flexDirection="column" gap={3}>
        <Txt spec={{ voice: "app", scale: 12.5 / 12.5, weight: 700 }}>{surface.title}</Txt>
        <Txt spec={{ ...SUB, lineHeight: 1.5 }} maxWidth={appCh(t, 11 / 12.5, 80) as number}>
          {surface.note}
        </Txt>
      </View>
      <View flexDirection={stacked ? "column" : "row"} gap={10} alignItems="stretch" onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {/* The stage scrolls sideways (`overflow-x: auto`): a box that clips, whether or not it ever
            does — and Chromium layers what a clip holds apart, which is what keeps a card's words subpixel
            beside its neighbours'. Sideways only here: a dialog's hidden probes stand below it, and would
            give the stage a scrollbar of their own. */}
        <View flex={stacked ? undefined : 1} minWidth={0} padding={12} borderRadius={8} backgroundColor={t.v("bg") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", "dashed") as object)} {...((isWeb ? { overflowX: "auto", overflowY: "hidden" } : {}) as object)}>
          <Stage surface={surface} text={state.text} onResult={onResult} />
        </View>
        <View {...(stacked ? {} : { width: "34%", minWidth: 280, flexShrink: 0 })} minHeight={stacked ? 0 : 320} position="relative">
          {/* The config box: the box that scrolls beside the dialog, its head held at the top — out of flow
              over the side (a box of its own around the scroller, whose plain style keeps it in flow). */}
          <View {...(stacked ? { maxHeight: 420 } : { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 })} flexDirection="column">
          <ScrollView
            style={
              {
                flex: 1,
                borderRadius: 8,
                backgroundColor: t.v("panel-2"),
                ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object),
                ...PLAIN_SCROLLER,
              } as never
            }
            onLayout={(e: LayoutChangeEvent) => setSideHeight(e.nativeEvent.layout.height - 2)}
            contentContainerStyle={{ flexDirection: "column", flexGrow: 1, gap: 8, padding: 8, ...(heldToBox ? { height: sideHeight } : {}), ...PLAIN_SCROLLER } as never}
            // On web the head sticks by itself (`sticky`, `z-index: 1`, and 8 down: under the scroller's
            // padding, which here is the content's): react-native-web's sticky header is a box of its own
            // at `z-index: 10`, painted after the page's bar and pinned rows (2) where this one is painted
            // before them — and its words then stood in another layer.
            {...(isWeb ? {} : { stickyHeaderIndices: [0] })}
            {...scrollbarProps(t)}
          >
            <View flexDirection="row" alignItems="center" gap={10} backgroundColor={t.v("panel-2") as never} zIndex={1} {...((isWeb ? { position: "sticky", top: 8 } : {}) as object)}>
              <Seg
                options={[
                  { label: "Form", on: state.editor === "form", disabled: entry === undefined, title: entry === undefined ? "no schema declares this document's shape" : "edit it as a form", onPress: () => onEditor("form") },
                  { label: "JSON", on: state.editor === "json", onPress: () => onEditor("json") },
                ]}
              />
              <Txt spec={SUB} flex={1} minWidth={0} ellip>
                {configCaption(surface)}
              </Txt>
              <Press onPress={onReset} flexShrink={0}>
                {({ hovered }) => (
                  <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                    reset
                  </Txt>
                )}
              </Press>
            </View>
            {state.editor === "form" && entry !== undefined ? (
              parsed.doc === undefined ? (
                // The form edits a parsed document; a broken one is repaired in the JSON view.
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>This is not JSON yet: {parsed.error}. Fix it in the JSON view — the form edits a parsed document.</Txt>
              ) : (
                <SchemaForm schema={entry.document as Schema} value={parsed.doc} onChange={(next) => onText(JSON.stringify(next, null, 2))} ctx={{ path: "" }} />
              )
            ) : (
              // The JSON view: the editor takes what the column has left, never less than 240 — the schema
              // shown and not offered, since it is the SURFACE's (`fill_form`'s contract or nothing).
              <View flexDirection="row" flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={240}>
                <SchemaJsonEditor text={state.text} busy={false} onChange={onText} validate={validateSchema} schemaId={surface.schemaId} lockedSchema onSchema={() => undefined} />
              </View>
            )}
          </ScrollView>
          </View>
        </View>
      </View>
      {state.result !== undefined ? (
        <View flexDirection="column" gap={6}>
          <View flexDirection="row" alignItems="center" gap={8}>
            <Txt spec={SUB}>what it submitted</Txt>
            {state.result.check !== undefined ? <Chip tone={state.result.check.ok ? "ok" : "bad"}>{state.result.check.ok ? "contract ok" : "rejected"}</Chip> : null}
          </View>
          <Outputs>{JSON.stringify(state.result.value, null, 2)}</Outputs>
          {state.result.check?.ok === false ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>{state.result.check.errors}</Txt> : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * `Stage`: the dialog itself, built from the edited document as main builds it from a run
 * (`galleryModel.ts`). An interaction is the gate's own surface (`GateSurface`, the side panel's) in a
 * dialog's box with no backdrop — as wide as what is in it, since nothing stretches it. An approval
 * and an agent's question are their surfaces under an accent rule (`InlineGateBox`).
 *
 *   the dialog's box     --panel, 1px --line, radius 12, padding 18; in the stage no shadow, at most
 *                        the stage's width. Wide (a review or an edit): the stage's width.
 *   a reason             --bad, app at 11/12.5
 */
export function Stage({ surface, text, onResult }: { surface: GallerySurface; text: string; onResult: (result: CardState["result"]) => void }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const parsed = parsedDoc(text);
  const reason = (words: string): JSX.Element => <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>{words}</Txt>;
  if (parsed.doc === undefined) return reason(`Not JSON yet: ${parsed.error ?? ""}`);
  if (surface.kind === "approval") {
    const pending = approvalOf(surface, parsed.doc);
    return (
      <InlineGateBox t={t}>
        <ApprovalSurface pending={pending} onDecide={(decision, scope, extras) => onResult({ value: { decision, scope, ...(extras ?? {}) } as never })} />
      </InlineGateBox>
    );
  }
  if (surface.kind === "question") {
    const pending = questionOf(surface, parsed.doc);
    if (pending === null) return reason("A question request needs at least one question.");
    return (
      <InlineGateBox t={t}>
        {/* The dismissal is an answer the agent receives, so it is shown as itself. */}
        <QuestionSurface pending={pending} onSubmit={(answers) => onResult({ value: answers === undefined ? { dismissed: true } : { answers } } as never)} />
      </InlineGateBox>
    );
  }
  const { pending, config, inputs } = interactionOf(surface, parsed.doc);
  const component = pending.config?.component;
  const wide = component === "review_artifacts" || component === "edit_artifact" || component === "review_artifact";
  return (
    <View
      {...(wide ? { alignSelf: "stretch", maxHeight: win.height * 0.9, flexDirection: "column" } : { alignSelf: "flex-start" })}
      maxWidth="100%"
      padding={18}
      borderRadius={12}
      backgroundColor={t.v("panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      testID="interaction"
    >
      {/* The wide box is a flex column: nothing in it collapses (`GateSurface`'s `flex`). */}
      <GateSurface pending={pending} flex={wide} services={galleryServices(surface, config)} onSubmit={(value) => onResult(interactionResult(config, value, inputs))} />
    </View>
  );
}

/** The box round a surface the stage draws in place: a 2px --accent rule on top, 12 above, 8 under it. */
function InlineGateBox({ t, children }: { t: Tokens; children: ReactNode }): JSX.Element {
  return (
    <View marginTop={12} paddingTop={8} {...(edge(t, { top: 2 }, "accent") as object)}>
      {children}
    </View>
  );
}
