import { useMemo, useState, type JSX, type ReactNode } from "react";
import { ScrollView, TextInput } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { artifactOf, delimiterOf, mimeOfFenceLang, parseStructured, structuredFormatOf, viewsFor, type ParsedStructure, type ViewHint, type ViewId } from "@jaira/shared/browser";
import { highlightJson } from "@jaira/ui/jsonHighlight";
import { VIEW_META, base64Of, fileNameOf } from "@jaira/ui/valueViewMeta";
import { invoke } from "@jaira/ui/store";
import { useValuePanel } from "@jaira/ui/valuePanel";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { Uncopied } from "../../app/Uncopied";
import { PLAIN_SCROLLER, Press, Txt, edge, font, lengthToken, scrollbarProps } from "../../primitives";
import { Island } from "../../islands";
import { useTokens, type Tokens } from "../../tokens";
import { DataView } from "../files/DataView";
import { Markdown, registerFenceRenderer } from "../Markdown";

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
 *   .vv-more         22 wide, padding 1 0 4, a transparent 1px edge, radius 6, app 12/12.5, line 1,
 *                    --tok-hint (hover: --line edge, --panel-2, --text)
 *   .vv-source       data 11.5/12, line 1.55, --dim, pre-wrap, at most 340 tall, scrolls
 *   .vv-json         the source's box, coloured by token (`.tok-*`); plain text --dim (`.vv-source` wins)
 *   .vv-body > .markdown   app 12.5/12.5
 *   .doc-tree        `DataView`
 *
 * Rendered HTML is the `artifact` island (a page is web content; a WebView on a phone); the editors (with
 * `edit`) are the markdown and code editors' islands. {@link Uncopied}: the Files view of a changeset, a
 * media player, a patch, a table's cells, and the Form view. The ⋯ menu's verbs are the
 * desktop's: Download…, and Open in context panel where a panel is there to open it in (`valuePanel.ts`).
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
}): JSX.Element {
  const t = useTokens();
  const views = viewsFor(value, hint ?? {});
  const [picked, setPicked] = useState<ViewId | null>(null);
  const view = controlled !== undefined && views.includes(controlled) ? controlled : picked !== null && views.includes(picked) ? picked : views[0]!;
  const artifact = artifactOf(value);
  const showing = artifact?.content !== undefined && view !== "json" ? artifact.content : value;
  const mime = (view === "json" ? undefined : artifact?.mime) ?? hint?.mime;
  const wantsParse = view === "data" || view === "table" || view === "form";
  const parsed = useMemo<ParsedStructure | null>(() => {
    if (!wantsParse || typeof showing !== "string") return null;
    const format = structuredFormatOf(mime);
    if (format === undefined) return null;
    return parseStructured(showing, format, delimiterOf(mime));
  }, [wantsParse, showing, mime]);

  const body = ((): ReactNode => {
    if (view === "markdown") {
      // The DOM's `MarkdownDocument`: the reading renderer, unless there is an edit to take or a change
      // to draw — then the editor, which on a phone is the markdown editor's island.
      if (edit === undefined && diff === undefined) return <Markdown text={String(showing)} scale={12.5 / 12.5} {...(softbreak !== undefined ? { softbreak } : {})} />;
      return (
        <Island
          component="markdownEditor"
          props={{ text: String(showing), document: true, readOnly: edit === undefined, ...(diff !== undefined ? { diff } : {}) }}
          onEvent={(name, next) => name === "change" && edit?.(String(next))}
        />
      );
    }
    if (view === "html") {
      // A page, which is web content by nature: the artifact island (a WebView on a phone), static as the
      // desktop's is where no grant to run it was made.
      return <Island component="artifact" props={{ text: String(showing) }} />;
    }
    if (view === "code" && edit !== undefined && typeof showing === "string") {
      return <Island component="code" height={340} props={{ text: showing, mime: mime ?? "text/plain", readOnly: false, view: "write" }} onEvent={(name, next) => name === "change" && edit(String(next))} />;
    }
    if (edit !== undefined && typeof showing === "string" && (view === "text" || view === "json")) {
      // `textarea.code-editor.vv-edit`: the text as written, in the data face, to type into.
      return <EditSource value={showing} onChange={edit} inline={inline} t={t} />;
    }
    if (view === "data") {
      if (parsed !== null && !parsed.ok) return <ParseProblem message={parsed.message} spot={parsed.spot} />;
      return <DataView value={parsed?.ok === true ? parsed.value : showing} />;
    }
    if (view === "json") return <JsonSource value={showing} t={t} />;
    if (view === "code" || view === "text") return <Source value={showing} t={t} />;
    return <Uncopied name={`the ${view} view`} />;
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
                onSelect: () => panel.open({ title: artifact?.path ?? artifact?.name ?? label ?? "Value", value, ...(hint !== undefined ? { hint } : {}), ...(label !== undefined ? { label } : {}) }),
              },
            ]),
      ],
    });
  };

  const head = chrome && (label !== undefined || views.length > 1 || actions !== undefined);
  const lifted = inline ? { position: "absolute", zIndex: 2, top: 3, right: 3 } : { marginBottom: 3 };
  const glass = inline ? t.mix(t.v("panel"), 88, "transparent") : undefined;
  return (
    <View minWidth={0} {...(inline ? { position: "relative" } : {})}>
      {head ? (
        <View flexDirection="row" alignItems="center" gap={6} minWidth={0} {...(lifted as object)}>
          {label !== undefined ? <Txt spec={{ voice: "app", scale: 10 / 12.5, upper: true, ls: 0.07, color: "tok-hint" }}>{label}</Txt> : null}
          {inline ? null : <View flex={1} minWidth={0} />}
          {actions}
          {views.length > 1 ? (
            <View role="group" aria-label="How to show this" flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} overflow="hidden" {...(glass !== undefined ? { backgroundColor: glass as never } : {})}>
              {views.map((id, i) => (
                <Press
                  key={id}
                  onPress={() => setPicked(id)}
                  title={VIEW_META[id].hint}
                  {...({ "aria-pressed": id === view } as object)}
                  paddingVertical={1}
                  paddingHorizontal={7}
                  {...(edge(t, { left: i === 0 ? 0 : 1 }) as object)}
                  box={({ hovered }) => ({ backgroundColor: id === view ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
                >
                  {({ hovered }) => (
                    <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: id === view ? 600 : 400, color: id === view || hovered ? "text" : "tok-hint" }} textAlign="center" numberOfLines={1}>
                      {VIEW_META[id].label}
                    </Txt>
                  )}
                </Press>
              ))}
            </View>
          ) : null}
          <Press
            title="What else can be done with this"
            onPress={(e) => {
              // Under the button and aligned to its right edge, as the desktop's.
              const el = (e as unknown as { currentTarget?: { getBoundingClientRect?: () => DOMRect } }).currentTarget;
              const rect = isWeb && typeof el?.getBoundingClientRect === "function" ? el.getBoundingClientRect() : undefined;
              openMore(rect !== undefined ? rect.right : e.nativeEvent.pageX + 11, rect !== undefined ? rect.bottom + 2 : e.nativeEvent.pageY + 12);
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
      <View minWidth={0}>{body}</View>
      {more !== null ? <ContextMenu anchor={more} onClose={() => setMore(null)} /> : null}
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
    <TextInput
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

/** `.vv-source`'s box: at most 340 tall, scrolling. */
function SourceBox({ children, t }: { children: ReactNode; t: Tokens }): JSX.Element {
  return (
    // `PLAIN_SCROLLER`: the DOM's `pre` scrolls without being composited, and its text is subpixel.
    <ScrollView {...(scrollbarProps(t) as object)} style={{ maxHeight: 340, ...PLAIN_SCROLLER } as never} contentContainerStyle={PLAIN_SCROLLER as never} nestedScrollEnabled>
      {children}
    </ScrollView>
  );
}

/** `Source`: the raw form — text as written, or JSON pretty-printed. */
function Source({ value, t }: { value: unknown; t: Tokens }): JSX.Element {
  return (
    <SourceBox t={t}>
      <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.55, color: "dim" }} {...((isWeb ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: "1.55" } : {}) as object)}>
        {jsonTextOf(value)}
      </Txt>
    </SourceBox>
  );
}

// Plain text is --dim: `.vv-source` (later in the sheet) outranks `.vv-json`'s --text, measured.
const TOKEN_INK: Record<string, string> = { key: "accent", string: "tok-string", number: "tok-number", literal: "tok-number", punct: "dim", comment: "dim", plain: "dim" };

/** `JsonView`: the value as JSON, coloured by the one highlighter (`highlightJson`). */
function JsonSource({ value, t }: { value: unknown; t: Tokens }): JSX.Element {
  const text = useMemo(() => jsonTextOf(value), [value]);
  const lines = useMemo(() => highlightJson(text), [text]);
  const base = { voice: "data" as const, scale: 11.5 / 12, lineHeight: 1.55 };
  return (
    <SourceBox t={t}>
      {/* The line as the stylesheet writes it (unitless) on web: Blink multiplies it out in float. */}
      <Txt spec={{ ...base, color: "dim" }} {...((isWeb ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: "1.55" } : {}) as object)}>
        {lines.map((line, i) => (
          <Text key={i}>
            {line.tokens.map((token, j) => (
              // Each token keeps the line's own height (web: the parent's unitless 1.55), not one of its own.
              <Text key={j} {...(font(t, { ...base, color: TOKEN_INK[token.kind] ?? "text", ...(token.kind === "comment" ? { italic: true } : {}) }) as object)} {...(isWeb ? { lineHeight: "inherit" } : {})}>
                {token.text}
              </Text>
            ))}
            {i < lines.length - 1 ? "\n" : null}
          </Text>
        ))}
      </Txt>
    </SourceBox>
  );
}

/** `ParseProblem`: a structured document that does not parse, and where. */
function ParseProblem({ message, spot }: { message: string; spot?: { line: number; column: number } | undefined }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("tint-bad") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>
        {message}
        {spot !== undefined ? ` — line ${spot.line}, column ${spot.column}` : ""}
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
