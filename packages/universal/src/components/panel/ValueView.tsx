import { useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { ScrollView, TextInput, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import {
  artifactOf,
  changesOf,
  delimiterOf,
  mediaKindOf,
  mediaSrcOf,
  mimeOfFenceLang,
  parseStructured,
  parseUnifiedDiff,
  renderersFor,
  structuredFormatOf,
  viewsFor,
  type ParsedStructure,
  type PatchFile,
  type RendererId,
  type ServedArtifact,
  type ViewHint,
  type ViewId,
} from "@jaira/shared/browser";
import { editorLook } from "@jaira/ui/editorLook";
import { highlightJson } from "@jaira/ui/jsonHighlight";
import { textRendererFor, useRenderChoice } from "@jaira/ui/renderChoice";
import { useArtifactFrame } from "@jaira/ui/artifactFrame";
import type { Schema } from "@jaira/ui/schemaForm/types";
import { RENDERER_META, VIEW_META, base64Of, fileNameOf, hintText, schemaDescriber } from "@jaira/ui/valueViewMeta";
import { invoke } from "@jaira/ui/store";
import { useValuePanel } from "@jaira/ui/valuePanel";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { ENTER_KEEPS_FOCUS, Press, Txt, edge, font, lengthToken, viewScrollbarProps } from "../../primitives";
import { Island } from "../../islands";
import { useTokens, type Tokens } from "../../tokens";
import { DataView } from "../files/DataView";
import { ReadingForm } from "../form/Field";
import { SchemaForm } from "../form/SchemaForm";
import { FenceLineContext, Markdown, registerFenceRenderer } from "../Markdown";
import { Icon } from "./Icon";
import { ChangesView, EmptyNote, Media, PatchView, Scroll, TableView, type ChangeOutcome } from "./ValueReadings";

/** A change over a markdown document (`markdownEditor.tsx`'s `MarkdownDiff`, which a phone cannot import). */
export interface MarkdownDiff {
  before: string;
  after: string;
  hunks: readonly { start: number; end: number; text: string }[];
}

/**
 * `valueView.tsx`'s `ValueView`, universal (decision 0015) — the one value view: a value in the best
 * view that applies, the others a press away. Which views apply is `viewsFor` (`shared/valueViews.ts`),
 * the DOM's own; this draws them. It is also what a fenced block in markdown draws (`drawFence`, below,
 * registered as `fenceRender.tsx` registers the DOM's). The rules:
 *
 *   .vv-head         row, centred, gap 6, 3 under; inline (a fence), lifted into the block's top-right
 *                    corner (3 3), the toggle and ⋯ on --panel at 88%
 *   .vv-label        app 10/12.5, upper, 0.07em, --tok-hint
 *   .vv-toggle       a 1px --line box, radius 6, clipped; its buttons padding 1 7, a --line between,
 *                    app 10.5/12.5 --tok-hint (hover --text on --fill-ghost-hover; on: --text on
 *                    --fill-ghost-selected, 600)
 *   .vv-arrow        the ▾ of a view with a second renderer: no rule before it, padding 1 4 1 1,
 *                    app 8/12.5, line 1 (and `.on` as its view's)
 *   .vv-more         22 wide, padding 1 0 4, a transparent 1px edge, radius 6, app 12/12.5, line 1,
 *                    --tok-hint (hover: --line edge, --panel-2, --text)
 *   .vv-source       data 11.5/12, line 1.55, --dim, pre-wrap, at most 340 tall, scrolls
 *   .vv-json         the source's box, coloured by token (`.tok-*`), scrolling sideways too; plain text
 *                    --dim (`.vv-source` wins); `.line-hint-slot` no width, the hint overflowing it:
 *                    `.line-hint` --tok-hint, italic, 1.6em before it
 *   .vv-body > .markdown   app 12.5/12.5
 *   .vv-body > .monaco-host   an editor 320 tall (`.monaco-fit`, inline: as tall as its text)
 *   .code-text       the tokenizer's reading before its colours land: data --size-data on 1.5, on --bg,
 *                    a 1px --line, radius 6, padding 8 10, `pre`, scrolls sideways
 *   .vv-form         a `ReadingForm` (form/Field.tsx)
 *   .doc-tree        `DataView`; `.vv-patch`, `.vv-table`, `.vv-media` `ValueReadings.tsx`
 *
 * Rendered HTML is the `artifact` island (a page is web content; a WebView on a phone) — on web the frame
 * an interactive artifact RUNS in, where the surface lends a `serve` and the record grants it one, its
 * messages filling the composer through `onPrompt` (`PageFrame`, below); the editors (with
 * `edit`) are the markdown and code editors' islands, and so is code's coloured reading on web (the
 * `code` island's `reading`, the desktop's `CodeText`). On a phone that reading is the plain box the
 * DOM draws before its colours arrive: colouring is Monaco's tokenizer, and a WebView per fenced block is
 * too heavy — the one place a phone's code differs, as its editors do. A changeset's Files view opens a
 * file's diff in the `diff` island. The ⋯ menu's verbs are the desktop's: Download…, and Open in context panel where a
 * panel is there to open it in (`valuePanel.ts`); the ▾ beside an editable view with a grammar picks
 * what draws it ("Drawn by": the editor, or the code view), behind the person's Appearance default
 * (`textRendererFor`).
 */
export function ValueView({
  value,
  hint,
  label,
  actions,
  inline = false,
  view: controlled,
  chrome = true,
  edit,
  diff,
  softbreak,
  outcomes,
  serve,
  onPrompt,
  pinned = false,
}: {
  value: unknown;
  hint?: ViewHint | undefined;
  label?: string | undefined;
  actions?: ReactNode;
  inline?: boolean;
  /** Which view to show, decided by the caller — the transcript's rail owns the choice. */
  view?: ViewId | undefined;
  /** `false` ⇒ no header at all, for a caller that has somewhere better for the controls. */
  chrome?: boolean;
  /**
   * The views made WRITABLE (the desktop's `edit`): markdown becomes the live-preview editor and code
   * the code editor — both islands, the editors being the one place a phone may differ — and source a
   * text box.
   */
  edit?: ((next: string) => void) | undefined;
  /** A change drawn over the markdown document (the desktop's `diff`), which takes the editor too. */
  diff?: MarkdownDiff | undefined;
  /** What a single newline in a markdown paragraph is (`Markdown`'s): a space where the host collapses white space. */
  softbreak?: "newline" | "space";
  /** How each change fared, by path, when the value is a set of files (the desktop's `outcomes`). */
  outcomes?: Record<string, ChangeOutcome> | undefined;
  /**
   * How to have an artifact SERVED to a frame, for the interactive case (the desktop's `serve`): supplied
   * by the surface, which knows the task and project a grant takes. Absent ⇒ an interactive artifact is
   * the static page, its scripts inert. Asked only on web — a phone's WebView cannot load the address.
   */
  serve?: ((path: string) => Promise<ServedArtifact>) | undefined;
  /** Where a message from an interactive artifact goes (the composer, filled, never sent). Absent ⇒ nowhere. */
  onPrompt?: ((text: string) => void) | undefined;
  /**
   * The value owns its column (`.pinned-body > .vv`, the panel's Preview card): the head padded 7 10 0
   * and 5 over the body, the body taking what is left and scrolling, a page in it full bleed.
   */
  pinned?: boolean;
}): JSX.Element {
  const t = useTokens();
  const views = viewsFor(value, hint ?? {});
  const [picked, setPicked] = useState<ViewId | null>(null);
  const view = controlled !== undefined && views.includes(controlled) ? controlled : picked !== null && views.includes(picked) ? picked : views[0]!;
  const artifact = artifactOf(value);
  const showing = artifact?.content !== undefined && view !== "json" ? artifact.content : value;
  const mime = (view === "json" ? undefined : artifact?.mime) ?? hint?.mime;

  // Which renderer draws each view that has two (the DOM's `drawnBy`), behind this person's standing
  // answer for the type (Appearance's text renderer): the code view is choosing not to edit.
  const [drawnBy, setDrawnBy] = useState<Partial<Record<ViewId, RendererId>>>({});
  const [rendMenu, setRendMenu] = useState<MenuAt | null>(null);
  const editable = edit !== undefined;
  const preferred = textRendererFor(mime, useRenderChoice());
  const renderer: RendererId = drawnBy[view] ?? preferred ?? "monaco";
  const plainly = renderer === "codeview" && renderersFor(view, mime, editable).length > 1;
  const writing = plainly ? undefined : edit;

  // The address an interactive artifact runs from, once the record granted one (`artifactFrame.ts`, the
  // desktop's own grant). On web only: the frame is the window's `jaira-artifact:` protocol, which a
  // phone's WebView cannot load, so a phone asks for nothing and draws the page inert.
  const frameUrl = useArtifactFrame(artifact, isWeb ? serve : undefined);
  // `.vv-source`'s 340 ceiling, which a value that owns its column does without (`.pinned-body .vv-source`).
  const ceiling = pinned ? 1e9 : 340;

  const wantsParse = view === "data" || view === "table" || view === "form";
  const parsed = useMemo<ParsedStructure | null>(() => {
    if (!wantsParse || typeof showing !== "string") return null;
    const format = structuredFormatOf(mime);
    if (format === undefined) return null;
    return parseStructured(showing, format, delimiterOf(mime));
  }, [wantsParse, showing, mime]);
  const patch = useMemo<PatchFile[]>(() => (view === "patch" && typeof showing === "string" ? parseUnifiedDiff(showing) : []), [view, showing]);

  const body = ((): ReactNode => {
    // `value`, not `showing`: a set of changes is never an artifact's payload.
    if (view === "changes") return <ChangesView changes={changesOf(value) ?? []} outcomes={outcomes} />;
    if (view === "media") {
      const src = mediaSrcOf(showing, mime);
      const kind = mediaKindOf(mime);
      if (src !== undefined && kind !== undefined) return <Media src={src} kind={kind} />;
      return <Source value={showing} ceiling={ceiling} t={t} />;
    }
    if (view === "markdown") {
      // The DOM's `MarkdownDocument`: the reading renderer, unless there is an edit to take or a change
      // to draw — then the editor, which on a phone is the markdown editor's island.
      if (writing === undefined && (diff === undefined || plainly)) return <Markdown text={String(showing)} scale={12.5 / 12.5} {...(softbreak !== undefined ? { softbreak } : {})} />;
      return (
        <Island
          component="markdownEditor"
          props={{ text: String(showing), document: true, readOnly: writing === undefined, ...(diff !== undefined && !plainly ? { diff } : {}) }}
          onEvent={(name, next) => name === "change" && writing?.(String(next))}
        />
      );
    }
    if (view === "html") {
      // A page, which is web content by nature: the artifact island (a WebView on a phone) — the frame
      // it runs in where one was granted, otherwise the same page, inert, as the desktop's.
      const onEvent = onPrompt === undefined ? undefined : (name: string, text: unknown): void => void (name === "prompt" && typeof text === "string" && onPrompt(text));
      return <PageFrame text={String(showing)} url={frameUrl} pinned={pinned} {...(onEvent !== undefined ? { onEvent } : {})} t={t} />;
    }
    if (view === "code") {
      // The DOM's `CodeDocument`: read with the tokenizer, edited with the editor (320 tall in a panel,
      // as tall as its text in a document).
      const text = String(showing);
      if (writing === undefined) return <CodeReading text={text} mime={mime ?? "text/plain"} inline={inline} t={t} />;
      const change = writing;
      return (
        <Island
          component="code"
          {...(inline ? {} : { height: 320 })}
          props={{ text, mime: mime ?? "text/plain", view: "write", ...(inline ? { autoHeight: true } : {}) }}
          onEvent={(name, next) => name === "change" && change(String(next))}
        />
      );
    }
    if (view === "patch") {
      if (patch.length === 0) return <EmptyNote marginVertical={13}>No hunks in this patch.</EmptyNote>;
      return <PatchView files={patch} />;
    }
    if (view === "table") {
      if (parsed !== null && !parsed.ok) return <ParseProblem message={parsed.message} spot={parsed.spot} />;
      return <TableView rows={parsed?.ok === true && Array.isArray(parsed.value) ? (parsed.value as string[][]) : []} />;
    }
    if (view === "data") {
      if (parsed !== null && !parsed.ok) return <ParseProblem message={parsed.message} spot={parsed.spot} />;
      return <DataView value={parsed?.ok === true ? parsed.value : showing} />;
    }
    if (view === "form") {
      // A structured document is filled in from its parse; read-only (`disabled`, `reading`, and
      // nothing "set here"), as the desktop's.
      if (parsed !== null && !parsed.ok) return <ParseProblem message={parsed.message} spot={parsed.spot} />;
      return (
        <ReadingForm>
          <SchemaForm schema={(hint?.schema ?? {}) as Schema} value={parsed?.ok === true ? parsed.value : showing} onChange={() => undefined} ctx={{ path: "", disabled: true, reading: true, isSet: () => false }} />
        </ReadingForm>
      );
    }
    // The coloured reading whether or not it may be changed: the DOM's `JsonView` comes before its edit.
    if (view === "json") return <JsonSource value={showing} schema={hint?.schema} ceiling={ceiling} t={t} />;
    if (writing !== undefined && typeof showing === "string") {
      // `textarea.code-editor.vv-edit`: the text as written, in the data face, to type into.
      return <EditSource value={showing} onChange={writing} inline={inline} t={t} />;
    }
    return <Source value={showing} ceiling={ceiling} t={t} />;
  })();

  // The ⋯ menu (`valueView.tsx`'s `openMore`): save it, and — where there is a panel — open it there.
  const panel = useValuePanel();
  const [more, setMore] = useState<MenuAt | null>(null);
  const openMore = (x: number, y: number): void => {
    const downloadName = fileNameOf(artifact?.path, mime, typeof showing === "string");
    setMore({
      x: x - MENU_WIDTH,
      y,
      items: [
        {
          label: "Download…",
          note: downloadName,
          onSelect: () => void invoke("shell:saveFile", { name: downloadName, data: base64Of(jsonTextOf(showing)) }).catch(() => undefined),
        },
        ...(panel === null
          ? []
          : [
              {
                label: "Open in context panel",
                separator: true,
                note: "keeps it on screen while you carry on",
                onSelect: () =>
                  panel.open({
                    title: artifact?.path ?? artifact?.name ?? label ?? "Value",
                    value,
                    ...(hint !== undefined ? { hint } : {}),
                    ...(label !== undefined ? { label } : {}),
                    // A live artifact keeps running where it goes: the grant travels with the value.
                    ...(serve !== undefined ? { serve } : {}),
                    ...(onPrompt !== undefined ? { onPrompt } : {}),
                  }),
              },
            ]),
      ],
    });
  };
  /** Where a press was: on web the element's box (its `side`, and under it by `dy`); on a phone the finger. */
  const pressedAt = (e: GestureResponderEvent, side: "left" | "right", dx: number, dy: number): { x: number; y: number } => {
    const el = (e as unknown as { currentTarget?: { getBoundingClientRect?: () => DOMRect } }).currentTarget;
    const rect = isWeb && typeof el?.getBoundingClientRect === "function" ? el.getBoundingClientRect() : undefined;
    return rect !== undefined ? { x: rect[side], y: rect.bottom + dy } : { x: e.nativeEvent.pageX + dx, y: e.nativeEvent.pageY + 12 };
  };

  const head = chrome && (label !== undefined || views.length > 1 || actions !== undefined);
  // `.pinned-body > .vv > .vv-head`: padded 7 10 0, 5 over the body.
  const fenceLine = useContext(FenceLineContext);
  const lifted = inline ? { position: "absolute", zIndex: 2, top: 3, right: 3 } : pinned ? { flexShrink: 0, paddingTop: 7, paddingHorizontal: 10, marginBottom: 5 } : { marginBottom: 3 };
  const glass = inline ? t.mix(t.v("panel"), 88, "transparent") : undefined;
  /** A toggle button's ground and ink: on, under the pointer, or neither. */
  const toggleInk = (on: boolean, hovered: boolean): { box: Record<string, unknown>; color: string } => ({
    box: { backgroundColor: on ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" },
    color: on || hovered ? "text" : "tok-hint",
  });
  return (
    <View minWidth={0} {...(inline ? { position: "relative" } : {})} {...(pinned ? { flex: 1, flexDirection: "column" } : {})}>
      {head ? (
        <View flexDirection="row" alignItems="center" gap={6} minWidth={0} {...(lifted as object)}>
          {label !== undefined ? <Txt spec={{ voice: "app", scale: 10 / 12.5, upper: true, ls: 0.07, color: "tok-hint" }}>{label}</Txt> : null}
          {inline ? null : <View flex={1} minWidth={0} />}
          {actions}
          {views.length > 1 ? (
            <View role="group" aria-label="How to show this" flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} overflow="hidden" {...(glass !== undefined ? { backgroundColor: glass as never } : {})}>
              {views.flatMap((id, i) => {
                const choices = renderersFor(id, mime, editable);
                const button = (
                  <Press
                    key={id}
                    onPress={() => {
                      setPicked(id);
                      setRendMenu(null);
                    }}
                    title={VIEW_META[id].hint}
                    {...({ "aria-pressed": id === view } as object)}
                    paddingVertical={1}
                    paddingHorizontal={7}
                    {...(edge(t, { left: i === 0 ? 0 : 1 }) as object)}
                    box={({ hovered }) => toggleInk(id === view, hovered).box}
                  >
                    {({ hovered }) => (
                      // In a fence the toggle's line is the document's (inherited, unitless), not the body's 1.5.
                      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: id === view ? 600 : 400, color: toggleInk(id === view, hovered).color, ...(fenceLine !== undefined ? { lineHeight: fenceLine } : {}) }} {...(fenceLine !== undefined && isWeb ? { lineHeight: String(fenceLine) } : {})} textAlign="center" numberOfLines={1}>
                        {VIEW_META[id].label}
                      </Txt>
                    )}
                  </Press>
                );
                // Only where there is a second renderer to pick (`renderersFor`).
                if (choices.length < 2) return [button];
                return [
                  button,
                  <Press
                    key={`${id}-arrow`}
                    title="Which renderer draws this"
                    label={`Renderer for ${VIEW_META[id].label}`}
                    {...({ "aria-haspopup": "menu" } as object)}
                    onPress={(e) => {
                      // Opening the menu also selects the view: a choice about something not on screen
                      // is a choice whose result cannot be seen.
                      setPicked(id);
                      const chosen = drawnBy[id] ?? preferred ?? "monaco";
                      const p = pressedAt(e, "left", -8, 3);
                      setRendMenu({
                        x: p.x,
                        y: p.y,
                        title: "Drawn by",
                        items: choices.map((how) => ({ label: RENDERER_META[how].label, checked: chosen === how, onSelect: () => setDrawnBy((was) => ({ ...was, [id]: how })) })),
                      });
                    }}
                    justifyContent="center"
                    paddingTop={1}
                    paddingRight={4}
                    paddingBottom={1}
                    paddingLeft={1}
                    box={({ hovered }) => toggleInk(id === view, hovered).box}
                  >
                    {({ hovered }) => (
                      <Txt spec={{ voice: "app", scale: 8 / 12.5, weight: id === view ? 600 : 400, color: toggleInk(id === view, hovered).color, lineHeight: 1 }} textAlign="center">
                        ▾
                      </Txt>
                    )}
                  </Press>,
                ];
              })}
            </View>
          ) : null}
          <Press
            title="What else can be done with this"
            {...({ "aria-haspopup": "menu", "aria-expanded": more !== null } as object)}
            onPress={(e) => {
              // Under the button and aligned to its right edge, as the desktop's.
              const p = pressedAt(e, "right", 11, 2);
              openMore(p.x, p.y);
            }}
            width={22}
            flexShrink={0}
            paddingTop={1}
            paddingBottom={4}
            borderWidth={1}
            borderStyle="solid"
            borderRadius={6}
            alignItems="center"
            box={({ hovered }) => ({ borderColor: hovered || inline ? t.v("line") : "transparent", backgroundColor: hovered ? t.v("panel-2") : (glass ?? "transparent") })}
          >
            {({ hovered }) => (
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: hovered ? "text" : "tok-hint", lineHeight: 1 }} textAlign="center">
                …
              </Txt>
            )}
          </Press>
        </View>
      ) : null}
      <View minWidth={0} {...(pinned ? pinnedBody(view === "html", t) : {})}>
        {body}
      </View>
      {more !== null ? <ContextMenu anchor={more} onClose={() => setMore(null)} /> : null}
      {rendMenu !== null ? <ContextMenu anchor={rendMenu} onClose={() => setRendMenu(null)} /> : null}
    </View>
  );
}

/** What a 1px border is laid out as on this page (in whole device pixels, under the zoom), asked of Chromium once. */
let HAIRLINE: number | undefined;
function hairline(): number {
  if (HAIRLINE !== undefined) return HAIRLINE;
  if (typeof document === "undefined") return 1;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;border-top:1px solid;";
  document.body.appendChild(probe);
  HAIRLINE = parseFloat(getComputedStyle(probe).borderTopWidth) || 1;
  probe.remove();
  return HAIRLINE;
}

/**
 * `CodeDocument`'s reading (`CodeText`). On web the tokenizer's coloured text, in the `code` island; on a
 * phone the box the DOM draws until its colours arrive (`pre.code-text`): the text in --text, not
 * coloured — Monaco's tokenizer is an island, and a WebView per fenced block is too heavy.
 *
 * The web island is given the height of the DOM's box, since on `/rn` it stands without the stylesheet
 * that draws it: `.code-shiki` (a 1px --line) round `.shiki` (padding 8 10, a line of `code`'s size × 1.5
 * each, the last one too), inside markdown also `.markdown pre`'s 1px ring, and a 10px scrollbar under
 * a line wider than the box (`overflow-x: auto`) — a monospace line is its characters × 0.6em.
 */
const FENCE_UNDER = ["markdown", "md-block", "vv vv-inline", "vv-body"] as const;
const READING_UNDER = ["vv", "vv-body"] as const;

function CodeReading({ text, mime, inline, t }: { text: string; mime: string; inline: boolean; t: Tokens }): JSX.Element {
  const [room, setRoom] = useState<number | null>(null);
  // Its lines are `code`'s face: data 11/12 (the global `code` rule), inside markdown `.markdown code`'s 12/12.
  const face = inline ? 1 : 11 / 12;
  if (isWeb) {
    const size = Number(t.scaled("size-data", face)) || 12 * face;
    const px = hairline();
    const rings = inline ? 2 : 1;
    const rows = text.split("\n");
    const tab = editorLook("code").tabSize;
    const widest = Math.max(0, ...rows.map((row) => row.replace(/\t/g," ".repeat(tab)).length)) * 0.6 * size;
    const scroll = room !== null && widest > room - 2 * rings * px - 20 ? 10 : 0;
    const height = rows.length * size * 1.5 + 16 + 2 * rings * px + scroll;
    return (
      <View onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)}>
        {/* Under what the desktop's reading stands under: `.markdown pre`'s ring and `.markdown code`'s size are written for those ancestors. */}
        <Island component="code" height={height} under={inline ? FENCE_UNDER : READING_UNDER} props={{ text, mime, reading: true }} />
      </View>
    );
  }
  return (
    <View backgroundColor={t.v("bg") as never} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6}>
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }}>
        <Txt spec={{ voice: "data", scale: face, lineHeight: 1.5 }}>{text}</Txt>
      </ScrollView>
    </View>
  );
}

/**
 * `.pinned-body > .vv > .vv-body`: what the column leaves, scrolling inside itself (on web; a phone's
 * panel scrolls round it), padded 0 10 10 — and, for a page, full bleed and clipped (`:has(> .vv-html)`).
 */
function pinnedBody(page: boolean, t: Tokens): Record<string, unknown> {
  if (page) return { flex: 1, minHeight: 0, overflow: "hidden" };
  return { flex: 1, minHeight: 0, paddingHorizontal: 10, paddingBottom: 10, ...(isWeb ? { overflow: "auto", ...viewScrollbarProps(t) } : {}) };
}

/**
 * The html view's page: the `artifact` island — `iframe.vv-html`, the static page (`Html`, `sandbox=""`)
 * or, with a granted `url`, the frame it runs in (`InteractiveArtifact`, `sandbox="allow-scripts"`), both
 * the desktop's own. On web the frame stands without the stylesheet, so its box is given inline:
 *
 *   .vv-html                          100% wide, 360 tall, a 1px --line, radius 6, on #fff
 *   .pinned-body .vv-html             (the Preview card) full bleed: what the column leaves, no edge
 *
 * A pinned frame is as tall as the room measured for it (a `flex: 1` box round the island). On a phone
 * the island page draws the page inert and as tall as its content: `style` and `strut` are web's.
 */
function PageFrame({ text, url, pinned, onEvent, t }: { text: string; url: string | null; pinned: boolean; onEvent?: (name: string, value: unknown) => void; t: Tokens }): JSX.Element {
  const [room, setRoom] = useState<number | null>(null);
  // Pinned, the body is a flex box and the frame an item of it (`display: flex` on `.vv-body`): no line.
  const box = pinned
    ? { width: "100%", height: room ?? 0, border: 0, borderRadius: 0, display: "block" }
    : { width: "100%", height: 360, border: `1px solid ${String(t.v("line"))}`, borderRadius: 6 };
  const style = { ...box, background: "#fff", boxSizing: "border-box" };
  // The line the inline frame sits on: `.vv-body`'s font, the body's 13/12.5 on 1.5.
  const face = font(t, { voice: "app", scale: 13 / 12.5 });
  const px = (v: unknown): unknown => (typeof v === "number" ? `${v}px` : v);
  const strut = pinned ? undefined : { fontFamily: face["fontFamily"], fontSize: px(face["fontSize"]), lineHeight: px(face["lineHeight"]) };
  const island = <Island component="artifact" props={{ text, ...(url !== null ? { url } : {}), style, ...(strut !== undefined ? { strut } : {}) }} {...(onEvent !== undefined ? { onEvent } : {})} />;
  if (!pinned) return island;
  return (
    <View flex={1} minHeight={0} onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.height)}>
      {island}
    </View>
  );
}

/**
 * `textarea.code-editor.vv-edit`: the source to type into — data 12/12 on a 1.5 line, --text on --bg, a
 * 1px --line, radius --control-radius, padding 8 10, at least 40vh tall (inline: as tall as its lines,
 * at most 24).
 */
function EditSource({ value, onChange, inline, t }: { value: string; onChange: (next: string) => void; inline: boolean; t: Tokens }): JSX.Element {
  const rows = inline ? Math.min(Math.max(value.split("\n").length, 1), 24) : undefined;
  const size = Number(t.scaled("size-data", 1)) || 12;
  return (
    <TextInput {...(ENTER_KEEPS_FOCUS as object)}
      value={value}
      onChangeText={onChange}
      multiline
      spellCheck={false}
      {...((rows !== undefined ? { rows, numberOfLines: rows } : {}) as object)}
      style={
        {
          ...(font(t, { voice: "data", scale: 1, color: "text" }) as object),
          width: "100%",
          ...(rows !== undefined ? { height: rows * size * 1.5 + 18 } : { minHeight: 240 }),
          paddingVertical: 8,
          paddingHorizontal: 10,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: t.v("line"),
          borderRadius: lengthToken(t, "control-radius", 7),
          backgroundColor: t.v("bg"),
          textAlignVertical: "top",
        } as never
      }
    />
  );
}

/** The value as text, and never `undefined` (`jsonTextOf`). */
function jsonTextOf(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "undefined";
}

/** `Source`: the raw form — text as written, or JSON pretty-printed. */
function Source({ value, ceiling, t }: { value: unknown; ceiling: number; t: Tokens }): JSX.Element {
  return (
    <Scroll maxHeight={ceiling} t={t}>
      <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.55, color: "dim" }} {...((isWeb ? { whiteSpace: "pre-wrap", lineHeight: "1.55", style: { overflowWrap: "anywhere" } } : {}) as object)}>
        {jsonTextOf(value)}
      </Txt>
    </Scroll>
  );
}

// Plain text is --dim: `.vv-source` (later in the sheet) outranks `.vv-json`'s --text, measured.
const TOKEN_INK: Record<string, string> = { key: "accent", string: "tok-string", number: "tok-number", literal: "tok-number", punct: "dim", comment: "dim", plain: "dim" };

/**
 * `JsonView`: the value as JSON, coloured by the one highlighter (`highlightJson`), each key's description
 * from the schema (`schemaDescriber`) ghosted at the end of its line. On web the hint is the DOM's
 * zero-width slot, so it never moves where a line breaks and runs past the box's edge, which scrolls. On
 * a phone a native text cannot hold a box of no width, so the hint follows its line after the gap, and a
 * long one can wrap it.
 */
function JsonSource({ value, schema, ceiling, t }: { value: unknown; schema: unknown; ceiling: number; t: Tokens }): JSX.Element {
  const text = useMemo(() => jsonTextOf(value), [value]);
  const describe = useMemo(() => schemaDescriber(schema), [schema]);
  const lines = useMemo(() => highlightJson(text, describe), [text, describe]);
  const base = { voice: "data" as const, scale: 11.5 / 12, lineHeight: 1.55 };
  const ghost = font(t, { ...base, color: "tok-hint", italic: true });
  return (
    <Scroll maxHeight={ceiling} both t={t}>
      {/* The line as the stylesheet writes it (unitless) on web: Blink multiplies it out in float. */}
      <Txt spec={{ ...base, color: "dim" }} {...((isWeb ? { whiteSpace: "pre-wrap", lineHeight: "1.55", style: { overflowWrap: "anywhere" } } : {}) as object)}>
        {lines.map((line, i) => (
          <Text key={i}>
            {line.tokens.map((token, j) => (
              // Each token keeps the line's own height (web: the parent's unitless 1.55), not one of its own.
              <Text key={j} {...(font(t, { ...base, color: TOKEN_INK[token.kind] ?? "text", ...(token.kind === "comment" ? { italic: true } : {}) }) as object)} {...(isWeb ? { lineHeight: "inherit" } : {})}>
                {token.text}
              </Text>
            ))}
            {line.hint === undefined ? null : isWeb ? (
              // `.line-hint-slot`: an inline block of no width whose text overflows it, `pre`.
              <Text style={{ display: "inline-block", width: 0, overflow: "visible", whiteSpace: "pre" } as never}>
                <Text {...(ghost as object)} lineHeight="inherit" style={{ paddingLeft: "1.6em" } as never}>
                  {hintText(line.hint)}
                </Text>
              </Text>
            ) : (
              <Text {...(ghost as object)}>
                {"   "}
                {hintText(line.hint)}
              </Text>
            )}
            {i < lines.length - 1 ? "\n" : null}
          </Text>
        ))}
      </Txt>
    </Scroll>
  );
}

/**
 * `ParseProblem`: a structured document that does not parse, and where (`.vv-parse-error`: a row, gap 7,
 * baseline, padding 8 10, a 1px --line, radius 6, --warn in the data face at 11.5/12; the ⚠ 1em, centred;
 * where, `.sub`).
 */
function ParseProblem({ message, spot }: { message: string; spot?: { line: number; column: number } | undefined }): JSX.Element {
  const t = useTokens();
  const size = Number(t.scaled("size-data", 11.5 / 12)) || 11.5;
  return (
    <View flexDirection="row" alignItems="baseline" gap={7} paddingVertical={8} paddingHorizontal={10} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6}>
      <View flexShrink={0} alignSelf="center">
        <Icon name="alert" size={size} color={String(t.v("warn"))} />
      </View>
      <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "warn" }} flexShrink={1} minWidth={0}>
        {message}
        {spot !== undefined ? (
          <Txt {...(font(t, { voice: "data", scale: 1, color: "dim" }) as object)} fontSize={t.scaled("size-app", 11 / 12.5) as never}>
            {" "}— line {spot.line}, column {spot.column}
          </Txt>
        ) : null}
      </Txt>
    </View>
  );
}

/**
 * `fenceRender.tsx`'s `drawFence`: a fenced block, drawn as what it is — the same `ValueView`, inline. A
 * language nothing recognises returns `undefined`, and the block is its source. Installed at import
 * time, as the DOM's is: importing this module gives every universal `Markdown` its fenced blocks.
 */
registerFenceRenderer(({ lang, code }) => {
  const mime = mimeOfFenceLang(lang);
  if (mime === undefined) return undefined;
  return <ValueView value={code} hint={{ mime }} inline />;
});
