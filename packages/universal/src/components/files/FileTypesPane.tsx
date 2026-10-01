import { Component, useEffect, useState, type ErrorInfo, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { LINE_HEIGHT, PANE_FAMILIES, TAB_SIZES, editorKnobApplies, typeNameOf, type EditorKind, type EditorLook, type FileSource, type PaneFamily, type RendererChoices, type RendererEdit, type RenderView } from "@jaira/shared/browser";
import { takeEditorFront } from "@jaira/ui/editorFront";
import { EDITOR_THEMES, EDITOR_THEME_APP, editorThemeSpec } from "@jaira/ui/editorThemes";
import { EMPTY_CONTEXT } from "@jaira/ui/emptySurfaceContext";
import { KINDS, KNOB_SWITCHES, KNOB_WORDS, VIEWS, fileTypesModel, sampleFor, typeIsSet, type Subject } from "@jaira/ui/fileTypesModel";
import { RENDER_KINDS, type FileRenderer, type RenderKind } from "@jaira/ui/fileTypes";
import { Press, Txt, edge, lengthToken, useHover, viewScrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Chip } from "../form/inputs";
import { Switch } from "../settings/controls";
import { SelectInput, SizeStep } from "../settings/fields";
import { HideEditorActions } from "./EditorActions";
import { SURFACES } from "./surfaces";

/**
 * `fileTypesPane.tsx`'s `FileTypesPane`, universal (decision 0015): the Appearance page's File types
 * workspace — the tree of families and types, the stage with its mode strip, the menu being arranged,
 * the palette, the knobs of the surface chosen, and the preview, which is the REAL surface (the
 * universal one: a Monaco island for code) drawn over a sample. Every answer is `fileTypesModel.ts`'s,
 * asked of the universal registry (`SURFACES`), whose ids and labels are the desktop's. The rules, from
 * `styles.css` (`cascade.mts '.ft' --scene settings-appearance-file-types`):
 *
 *   .ft               two tracks: the tree (178) and the stage; 1px --line, radius --card-radius,
 *                     clipped, at least 320 tall
 *   .ft-tree          --panel-2, 5 in, a --line on its right; groups 1 apart
 *   .ft-row           row, centred, gap 7, padding 4 8, radius --control-radius-sm; hovered
 *                     --fill-ghost-hover, selected --fill-ghost-selected at 500; a family's 500, a
 *                     type's 400 (even selected: `.ft-kids .ft-row` is later) and 3 8
 *   .ft-kids          column, gap 1, 8 in from a --rule on its left, 2 0 5 12 outside
 *   .ft-caret         9 wide, --dim.  .ft-count data-faint, at the end.  .ft-dot 5 round --accent
 *   .ft-stage         column, --panel
 *   .ft-head          row, baseline, gap 8, padding 9 12, a --line under: app-title, app-secondary
 *   .ft-modes         three equal tracks, --panel-2, a --line under
 *   .ft-mode          column, gap 1, padding 6 10 5, a --line right (not the last), 2 transparent
 *                     under; hovered --fill-ghost-hover; chosen --panel and --accent under; disabled
 *                     0.55. Its bulb 6 round --ok (off: --rule), app-label; its reading data 0.92
 *                     --dim (chosen --text), italic where the types disagree
 *   .ft-body          column, gap 9, padding 11 12 13
 *   .ft-arranging     row, centred, gap 9: app-label and `.ft-seg` (--panel-3, radius
 *                     --control-radius, 2 in, gap 2; its buttons app 0.88 --dim, padding 1 8, radius
 *                     --control-radius-sm; pressed --panel, --text, 500)
 *   .ft-menu          1px --rule, radius --control-radius, --panel, --lift, clipped, at most 520
 *   .ft-menu-head     row, baseline, gap 8, padding 5 11, --panel-2, a --line under
 *   .ft-mm-row        leading --fill-ghost-selected, partly leading --accent 6%; hovered
 *                     --fill-ghost-hover. Its pick: row, centred, gap 9, padding 5 4 5 11; tick 13
 *                     wide, --accent, app 0.9; name a column (dimmed rows at 0.45); ✕ padding 0 11,
 *                     --dim (hovered --text), app 0.9
 *   .ft-mm-sep        1 --line, 3 above.  .ft-mm-foot app-label, padding 5 11 2
 *   .ft-theme         row, centred, gap 10, wrapping, padding 8 10, 1px --line, radius
 *                     --control-radius, --panel-2; the select at most 220; swatches 12 square, radius
 *                     3, 1px --line, 3 apart
 *   .ft-knobs         column, gap 2, padding 7 10 8, 1px --line, radius --control-radius; its head a
 *                     row, baseline, gap 9, 5 under a --line, 3 below it; `.ap-toggle` rows (row,
 *                     centred, gap 10, at least 26 tall, at most 560)
 *   .ft-preview       1px --line, radius --control-radius, clipped; its bar row, baseline, gap 8,
 *                     padding 4 9, --panel-2, a --line under; `.ft-tag` data 0.85 --dim on --panel-3,
 *                     round, padding 0 8; its body 190 tall, the surface filling it, no Save row
 *   .ft-preview-note  padding 22 14, centred, line 1.6, app-secondary
 */

const MODEL = fileTypesModel(SURFACES);
const { membersOf, reachOf, anyFor, pickFor, mixedFor, spreadFor, offStateFor, liveFor, editsForPick, editsForOff, resolveTheme, editsForTheme, offeredFor, subjectMimeOf, modeSay, themeCaption } = MODEL;

export function FileTypesPane({
  renderers,
  editorTheme,
  editors,
  busy,
  onRenderer,
  onEditor,
}: {
  renderers: RendererChoices;
  editorTheme: string;
  editors: Record<EditorKind, EditorLook>;
  busy: boolean;
  onRenderer: (edits: readonly RendererEdit[]) => void;
  onEditor: (kind: EditorKind, patch: Partial<EditorLook>) => void;
}): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState<PaneFamily | null>("code");
  const [at, setAt] = useState<Subject>({ family: "code", mime: null });
  const [kind, setKind] = useState<RenderKind>("text");
  const [view, setView] = useState<RenderView>("read");

  const family = PANE_FAMILIES.find((each) => each.id === at.family) ?? PANE_FAMILIES[0]!;
  const list = offeredFor(at, kind);
  const subjectMime = subjectMimeOf(at, kind, view, renderers);
  const named = at.mime === null ? null : typeNameOf(at.mime);
  // The palette in front, as the desktop's pane claims it (`editorFront.ts`) — for the web page's own
  // Monaco; an island's is its own.
  useEffect(() => {
    takeEditorFront({ mime: subjectMime, view, palette: { mime: subjectMime, kind, view } });
  }, [subjectMime, kind, view, renderers]);

  const pick = pickFor(at, kind, view, renderers);
  const mixed = mixedFor(at, kind, view, renderers);
  const spread = spreadFor(at, kind, view, renderers);
  const palette = resolveTheme(at, kind, view, renderers, editorTheme);

  return (
    <View testID="ft" flexDirection="row" minHeight={320} overflow="hidden" borderRadius={lengthToken(t, "card-radius", 12)} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      {/* The tree. */}
      <View width={178} flexShrink={0} backgroundColor={t.v("panel-2") as never} padding={5} minWidth={0} {...(edge(t, { right: 1 }) as object)}>
        {PANE_FAMILIES.map((each, i) => {
          const isOpen = open === each.id;
          return (
            // `.ft-group + .ft-group`'s 1 collapses into the 5 under an open group's kids (blocks, in the DOM).
            <View key={each.id} {...(i > 0 && open !== PANE_FAMILIES[i - 1]!.id ? { marginTop: 1 } : {})}>
              <TreeRow
                label={each.label}
                group
                selected={at.family === each.id && at.mime === null}
                title={each.note}
                lead={
                  <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} width={9} flexShrink={0}>
                    {isOpen ? "▾" : "▸"}
                  </Txt>
                }
                trail={
                  <Txt register="data-faint" marginLeft="auto" flexShrink={0}>
                    {membersOf(each.id).length}
                  </Txt>
                }
                onPress={() => {
                  setOpen(isOpen ? null : each.id);
                  setAt({ family: each.id, mime: null });
                }}
              />
              {isOpen ? (
                <View flexDirection="column" gap={1} paddingLeft={8} marginTop={2} marginBottom={5} marginLeft={12} {...(edge(t, { left: 1 }, "rule") as object)}>
                  <TreeRow
                    label={`All ${each.label.toLowerCase()}`}
                    selected={at.family === each.id && at.mime === null}
                    title="every type in this family — a value shows where they already agree"
                    onPress={() => setAt({ family: each.id, mime: null })}
                  />
                  {membersOf(each.id).map((mime) => (
                    <TreeRow
                      key={mime}
                      label={typeNameOf(mime).label}
                      selected={at.mime === mime}
                      title={mime}
                      trail={typeIsSet(mime, renderers) ? <View marginLeft="auto" width={5} height={5} borderRadius={999} backgroundColor={t.v("accent") as never} flexShrink={0} /> : undefined}
                      onPress={() => setAt({ family: each.id, mime })}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      {/* The stage. */}
      <View flex={1} minWidth={0} flexDirection="column" backgroundColor={t.v("panel") as never}>
        <View flexDirection="row" alignItems="baseline" gap={8} paddingVertical={9} paddingHorizontal={12} {...(edge(t, { bottom: 1 }) as object)}>
          <Txt register="app-title" flexShrink={0} numberOfLines={1}>
            {named === null ? `All ${family.label.toLowerCase()}` : named.label}
          </Txt>
          <View flex={1} minWidth={0} />
          <Txt register="app-secondary" ellip flexShrink={1} {...(at.mime !== null ? { title: at.mime } : {})}>
            {at.mime === null ? `${membersOf(at.family).length} types — a value shows where they agree` : at.mime}
          </Txt>
        </View>

        <View flexDirection="row" backgroundColor={t.v("panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
          {RENDER_KINDS.map((each, i) => {
            const has = anyFor(at, each);
            const live = has && liveFor(at, each, renderers);
            const chosen = kind === each;
            return (
              <Press
                key={each}
                onPress={() => setKind(each)}
                disabled={!has}
                title={has ? KINDS[each].hint : "this type has no rendering of that kind"}
                {...({ "aria-selected": chosen } as object)}
                flex={1}
                flexBasis={0}
                minWidth={0}
                flexDirection="column"
                // A `button`, and the base rule centres a button's content: `.ft-mode` turns it into a column
                // and leaves `align-items: center` standing, so the bulb's row and the reading sit mid-tab.
                alignItems="center"
                gap={1}
                paddingTop={6}
                paddingHorizontal={10}
                paddingBottom={5}
                {...(!has ? { opacity: 0.55 } : {})}
                box={({ hovered }) => ({
                  // The base `button`'s radius, which `.ft-mode` leaves standing: the accent under the chosen tab turns up at its ends.
                  borderRadius: lengthToken(t, "control-radius", 7),
                  ...edge(t, { right: i < RENDER_KINDS.length - 1 ? 1 : 0 }),
                  borderBottomWidth: 2,
                  borderBottomColor: chosen ? t.v("accent") : "transparent",
                  backgroundColor: chosen ? t.v("panel") : hovered && has ? t.v("fill-ghost-hover") : "transparent",
                })}
              >
                <View flexDirection="row" alignItems="center" gap={6} minWidth={0}>
                  <View width={6} height={6} borderRadius={999} backgroundColor={t.v(live ? "ok" : "rule") as never} flexShrink={0} />
                  <Txt register="app-label">{KINDS[each].label}</Txt>
                </View>
                <Txt spec={{ voice: "data", scale: 0.92, color: chosen ? "text" : "dim", italic: mixedFor(at, each, "read", renderers) && has && live }} ellip>
                  {modeSay(at, each, renderers)}
                </Txt>
              </Press>
            );
          })}
        </View>

        <View flexDirection="column" gap={9} paddingTop={11} paddingHorizontal={12} paddingBottom={13}>
          {!anyFor(at, kind) ? (
            <Txt register="app-secondary">This type has no rendering of that kind — a TypeScript file denotes no value, a CSV has nothing to render.</Txt>
          ) : (
            <>
              <View flexDirection="row" alignItems="center" gap={9} flexWrap="wrap">
                <Txt register="app-label">arranging</Txt>
                <View flexDirection="row" flexShrink={0} backgroundColor={t.v("panel-3") as never} borderRadius={lengthToken(t, "control-radius", 7)} padding={2} gap={2}>
                  {([["the read-only view", "read"], ["the editor", "write"]] as const).map(([label, each]) => {
                    const on = view === each;
                    return (
                      <Press key={each} onPress={() => setView(each)} {...({ "aria-pressed": on } as object)} paddingVertical={1} paddingHorizontal={8} borderRadius={lengthToken(t, "control-radius-sm", 5)} backgroundColor={on ? (t.v("panel") as never) : "transparent"}>
                        <Txt spec={{ voice: "app", scale: 0.88, weight: on ? 500 : 400, color: on ? "text" : "dim" }}>{label}</Txt>
                      </Press>
                    );
                  })}
                </View>
              </View>

              <Menu at={at} kind={kind} view={view} list={list} pick={pick} mixed={mixed} spread={spread} renderers={renderers} busy={busy} onRenderer={onRenderer} />

              {mixed ? (
                <Txt register="app-secondary">No row is ticked: the types in this family are set differently. Clicking one sets this view for every type that can take it.</Txt>
              ) : spread !== null ? (
                <Txt register="app-secondary">
                  The tick is hollow: {pick?.label} reaches {spread.reaches} of these {spread.of} types, and the rest keep what they had.
                </Txt>
              ) : null}

              {palette !== null ? (
                <View flexDirection="row" alignItems="center" gap={10} flexWrap="wrap" minWidth={0} paddingVertical={8} paddingHorizontal={10} borderRadius={lengthToken(t, "control-radius", 7)} backgroundColor={t.v("panel-2") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
                  <Txt register="app-label">theme</Txt>
                  {/* `.cfg-input`'s `width: 100%`, which `.ft-theme > select`'s `max-width: 220px` stops at: 220, whatever its options. */}
                  <View flexShrink={0} width={220}>
                    <SelectInput
                      fill
                      value={palette === "mixed" ? "" : palette.theme}
                      disabled={busy}
                      options={[
                        ...(palette === "mixed" ? ([["— types disagree —", ""]] as Array<[string, string]>) : []),
                        ["Follows the app", EDITOR_THEME_APP],
                        ...EDITOR_THEMES.map((one): [string, string] => [one.label, one.id]),
                      ]}
                      onChange={(id) => (id === "" ? undefined : onRenderer(editsForTheme(at, kind, view, id, renderers)))}
                    />
                  </View>
                  <Swatches theme={palette === "mixed" ? null : palette.theme} />
                  <View flex={1} minWidth={0} />
                  <Txt register="app-secondary" ellip flexShrink={1}>
                    {themeCaption(at, kind, view, renderers)}
                    {view === "write" ? <Txt register="app-secondary" spec={{ color: "warn" }}> · editors share one, and the last one you were in wins</Txt> : null}
                  </Txt>
                </View>
              ) : null}

              {!liveFor(at, kind, renderers) ? <Txt register="app-secondary">Every renderer is off, so this kind is off: nothing of it is drawn for this type.</Txt> : null}

              {pick?.look !== undefined ? (
                <View flexDirection="column" gap={2} paddingTop={7} paddingHorizontal={10} paddingBottom={8} borderRadius={lengthToken(t, "control-radius", 7)} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
                  <View flexDirection="row" alignItems="baseline" gap={9} minWidth={0} paddingBottom={5} marginBottom={3} {...(edge(t, { bottom: 1 }) as object)}>
                    <Txt register="app-label">how it is drawn</Txt>
                    <Txt register="app-secondary" ellip flexShrink={1}>
                      every file {pick.label} draws, not only this type
                    </Txt>
                  </View>
                  <EditorLookFields kind={pick.look} look={editors[pick.look]} busy={busy} onChange={(patch) => onEditor(pick.look!, patch)} />
                </View>
              ) : null}

              <View overflow="hidden" borderRadius={lengthToken(t, "control-radius", 7)} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
                <View flexDirection="row" alignItems="baseline" gap={8} paddingVertical={4} paddingHorizontal={9} minWidth={0} backgroundColor={t.v("panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
                  <Txt register="app-label">preview</Txt>
                  <Txt register="data-faint" ellip flexShrink={1}>
                    {typeNameOf(subjectMime).label} · {KINDS[kind].label} · {pick?.label ?? "nothing"}
                  </Txt>
                  <View flexShrink={0} borderRadius={999} paddingHorizontal={8} backgroundColor={t.v("panel-3") as never}>
                    <Txt spec={{ voice: "data", scale: 0.85, color: "dim" }}>{VIEWS[view].label} view</Txt>
                  </View>
                </View>
                {mixed ? (
                  <PreviewNote>The types in this family are set differently, so there is nothing single to show. Choose above to make them agree, or open one type in the tree to see it on its own.</PreviewNote>
                ) : (
                  <RendererPreview key={`${subjectMime}:${kind}:${view}:${pick?.id ?? "none"}`} mime={subjectMime} renderer={pick} view={view} />
                )}
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

/** One row of the tree: a family, or a type inside the open one. */
function TreeRow({ label, selected, title, lead, trail, group = false, onPress }: { label: string; selected: boolean; title?: string; lead?: ReactNode; trail?: ReactNode; group?: boolean; onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      title={title}
      label={label}
      {...({ "aria-selected": selected } as object)}
      flexDirection="row"
      alignItems="center"
      gap={7}
      minWidth={0}
      paddingVertical={group ? 4 : 3}
      paddingHorizontal={8}
      borderRadius={lengthToken(t, "control-radius-sm", 5)}
      box={({ hovered }) => ({ backgroundColor: selected ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {lead}
      {/* A family's row is 500; a type's stays 400 even chosen (`.ft-kids .ft-row` comes later). */}
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: group ? 500 : 400 }} ellip flexShrink={1}>
        {label}
      </Txt>
      {trail}
    </Press>
  );
}

/** The menu being arranged: the rows offered, and the ones taken off it under a rule. */
function Menu({
  at,
  kind,
  view,
  list,
  pick,
  mixed,
  spread,
  renderers,
  busy,
  onRenderer,
}: {
  at: Subject;
  kind: RenderKind;
  view: RenderView;
  list: readonly FileRenderer[];
  pick: FileRenderer | null;
  mixed: boolean;
  spread: { reaches: number; of: number } | null;
  renderers: RendererChoices;
  busy: boolean;
  onRenderer: (edits: readonly RendererEdit[]) => void;
}): JSX.Element {
  const t = useTokens();
  const writing = view === "write";
  const shown = list.filter((one) => offStateFor(at, kind, one.id, renderers) !== "off");
  const hidden = list.filter((one) => offStateFor(at, kind, one.id, renderers) === "off");
  const usable = (one: FileRenderer): boolean => !writing || one.writes === true || (one.surface === null && list.some((each) => each.writes === true));
  return (
    <View maxWidth={520} overflow="hidden" borderRadius={lengthToken(t, "control-radius", 7)} backgroundColor={t.v("panel") as never} boxShadow={t.v("lift") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "rule") as object)}>
      <View flexDirection="row" alignItems="baseline" gap={8} paddingVertical={5} paddingHorizontal={11} minWidth={0} backgroundColor={t.v("panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
        <Txt register="app-label">{KINDS[kind].label}</Txt>
        <Txt register="app-secondary">{writing ? "the view you type into" : "the view you cannot type into"}</Txt>
      </View>
      {shown.map((one) => {
        const leads = !mixed && pick !== null && pick.id === one.id;
        const far = at.mime === null ? reachOf(at.family, kind, one.id) : null;
        return (
          <MenuRow
            key={one.id}
            tone={leads ? (spread === null ? "lead" : "part") : "plain"}
            dim={!usable(one)}
            tick={leads ? "✓" : ""}
            name={one.label}
            ours={list[0]?.id === one.id}
            far={far}
            note={one.note}
            pickTitle={usable(one) ? "make this the one that leads" : "this renderer cannot be typed into, so it is never an editor"}
            pickDisabled={busy || !usable(one)}
            onPick={() => onRenderer(editsForPick(at, kind, view, one.id))}
            x="✕"
            xTitle="take it off this menu"
            busy={busy}
            onX={() => onRenderer(editsForOff(at, kind, one.id, renderers))}
          />
        );
      })}
      {hidden.length === 0 ? null : (
        <>
          <View height={1} marginTop={3} backgroundColor={t.v("line") as never} />
          <Txt register="app-label" paddingTop={5} paddingHorizontal={11} paddingBottom={2}>
            not offered
          </Txt>
          {hidden.map((one) => (
            <MenuRow
              key={one.id}
              tone="plain"
              dim
              tick=""
              name={one.label}
              ours={false}
              far={null}
              note={undefined}
              pickTitle="put it back on the menu"
              pickDisabled={busy}
              onPick={() => onRenderer(editsForOff(at, kind, one.id, renderers))}
              x="+"
              xTitle="put it back on the menu"
              busy={busy}
              onX={() => onRenderer(editsForOff(at, kind, one.id, renderers))}
            />
          ))}
        </>
      )}
    </View>
  );
}

/** `.ft-mm-row`: the pick (tick and name) and the ✕ beside it, sharing one hover. */
function MenuRow({
  tone,
  dim,
  tick,
  name,
  ours,
  far,
  note,
  pickTitle,
  pickDisabled,
  onPick,
  x,
  xTitle,
  busy,
  onX,
}: {
  tone: "plain" | "lead" | "part";
  dim: boolean;
  tick: string;
  name: string;
  ours: boolean;
  far: string | null;
  note: string | undefined;
  pickTitle: string;
  pickDisabled: boolean;
  onPick: () => void;
  x: string;
  xTitle: string;
  busy: boolean;
  onX: () => void;
}): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const ground = tone === "lead" ? t.v("fill-ghost-selected") : tone === "part" ? t.tint("accent", 6) : hovered ? t.v("fill-ghost-hover") : "transparent";
  return (
    <View {...(hover as object)} flexDirection="row" alignItems="stretch" minWidth={0} backgroundColor={ground as never}>
      <Press onPress={onPick} disabled={pickDisabled} title={pickTitle} flex={1} flexBasis="auto" minWidth={0} flexDirection="row" alignItems="center" gap={9} paddingTop={5} paddingRight={4} paddingBottom={5} paddingLeft={11}>
        <Txt spec={{ voice: "app", scale: 0.9, color: "accent" }} width={13} flexShrink={0} {...(tone === "part" ? { opacity: 0.5 } : {})}>
          {tick}
        </Txt>
        <View flexDirection="column" minWidth={0} flexShrink={1} {...(dim ? { opacity: 0.45 } : {})}>
          <Txt register="app-text">
            {name}
            {ours ? <Txt register="app-secondary"> ours</Txt> : null}
            {far === null ? null : <Txt register="data-faint">{"  "}{far}</Txt>}
          </Txt>
          {note === undefined ? null : (
            <Txt register="app-secondary" ellip>
              {note}
            </Txt>
          )}
        </View>
      </Press>
      <Press onPress={onX} disabled={busy} title={xTitle} flexShrink={0} paddingHorizontal={11} justifyContent="center">
        {/* `font: inherit`, then `font-size: calc(var(--size-app) * 0.9)`: 0.9 of the base, not of the body's 13. */}
        {({ hovered: over }) => <Txt spec={{ voice: "app", scale: 0.9, color: over && !busy ? "text" : "dim" }}>{x}</Txt>}
      </Press>
    </View>
  );
}

/** A palette as the colours it is — its ground, then what a reader tells tokens apart by. */
function Swatches({ theme }: { theme: string | null }): JSX.Element | null {
  const t = useTokens();
  const spec = theme === null ? undefined : editorThemeSpec(theme);
  if (spec === undefined) return null;
  return (
    <View flexDirection="row" gap={3} flexShrink={0} {...({ title: spec.source } as object)}>
      {[spec.bg, spec.keyword, spec.string, spec.func, spec.type].map((colour, at) => (
        <View key={at} width={12} height={12} borderRadius={3} backgroundColor={colour as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} />
      ))}
    </View>
  );
}

/** `editorKnobs.tsx`'s `EditorLookFields`: the knobs the surface can answer, as `.ap-toggle` rows. */
function EditorLookFields({ kind, look, busy, onChange }: { kind: EditorKind; look: EditorLook; busy: boolean; onChange: (patch: Partial<EditorLook>) => void }): JSX.Element {
  return (
    <>
      {KNOB_SWITCHES.filter((knob) => editorKnobApplies(kind, knob)).map((knob) => {
        const words = KNOB_WORDS[knob];
        const on = look[knob] === true;
        return (
          <ToggleRow key={knob} lead={<Switch on={on} label={words.label} disabled={busy} onChange={(next) => onChange({ [knob]: next })} />} label={words.label}>
            <Txt register="app-secondary" numberOfLines={1}>
              {on ? words.on : words.off}
            </Txt>
          </ToggleRow>
        );
      })}
      {editorKnobApplies(kind, "tabSize") ? (
        <ToggleRow
          lead={
            <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap" minWidth={0}>
              {TAB_SIZES.map((size) => (
                <Chip key={size} active={look.tabSize === size} disabled={busy} onPress={() => onChange({ tabSize: size })}>
                  {size}
                </Chip>
              ))}
            </View>
          }
          label={KNOB_WORDS.tabSize.label}
        >
          <Txt register="app-secondary" numberOfLines={1}>
            columns
          </Txt>
        </ToggleRow>
      ) : null}
      {editorKnobApplies(kind, "lineHeight") ? (
        <ToggleRow lead={<View />} label={KNOB_WORDS.lineHeight.label}>
          <SizeStep value={look.lineHeight} limits={LINE_HEIGHT} by={LINE_HEIGHT.step} unit="×" disabled={busy} onChange={(lineHeight) => onChange({ lineHeight })} />
        </ToggleRow>
      ) : null}
    </>
  );
}

/** `.ap-toggle`: the control, its name, and what it is worth at the right-hand end. */
function ToggleRow({ lead, label, children }: { lead: ReactNode; label: string; children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={10} minHeight={26} maxWidth={560}>
      {lead}
      <Txt register="app-text" minWidth={0} flexShrink={1}>
        {label}
      </Txt>
      <View marginLeft="auto" flexDirection="row" alignItems="center" minWidth={0} overflow="hidden">
        {children}
      </View>
    </View>
  );
}

/** `.ft-preview-note`. */
function PreviewNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Txt register="app-secondary" spec={{ lineHeight: 1.6 }} paddingVertical={22} paddingHorizontal={14} textAlign="center">
      {children}
    </Txt>
  );
}

/** A surface that threw, said rather than crashed — the desktop's `PreviewBoundary`. */
class PreviewBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  constructor(props: { children: ReactNode; label: string }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <PreviewNote>{this.props.label} needs a file that is actually open — it draws a run, not a sample. Open one to see it.</PreviewNote>;
  }
}

/**
 * The chosen renderer, drawing the chosen type — the REAL surface (the universal one) against the inert
 * context, over the type's sample, 190 tall with no Save row. The text is local and thrown away.
 */
function RendererPreview({ mime, renderer, view }: { mime: string; renderer: FileRenderer | null; view: RenderView }): JSX.Element {
  const t = useTokens();
  const [text, setText] = useState(() => sampleFor(mime));
  const [shown, setShown] = useState(mime);
  if (shown !== mime) {
    setShown(mime);
    setText(sampleFor(mime));
  }
  if (renderer === null || renderer.surface === null) {
    return <PreviewNote>{renderer === null ? "Nothing is drawn here." : "Nothing — this type has no view of that kind."}</PreviewNote>;
  }
  const Surface = renderer.surface;
  const doc: FileSource = { layer: "project", path: "sample", file: "sample", mime, text, exists: true };
  return (
    // `.ft-preview-body` scrolls (`overflow: auto`): an editor is at least 200 tall, ten more than this box,
    // so the desktop's has a scrollbar down its side and the surface is that much narrower. A phone clips.
    <View height={190} flexDirection="column" {...((isWeb ? { overflow: "auto", ...viewScrollbarProps(t) } : { overflow: "hidden" }) as object)}>
      <PreviewBoundary label={renderer.label}>
        <HideEditorActions>
          <Surface doc={doc} busy={false} onSave={view === "write" ? setText : () => undefined} context={{ ...EMPTY_CONTEXT, view }} />
        </HideEditorActions>
      </PreviewBoundary>
    </View>
  );
}
