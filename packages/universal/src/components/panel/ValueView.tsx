import { useMemo, useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { artifactOf, delimiterOf, mimeOfFenceLang, parseStructured, structuredFormatOf, viewsFor, type ParsedStructure, type ViewHint, type ViewId } from "@jaira/shared/browser";
import { highlightJson } from "@jaira/ui/jsonHighlight";
import { VIEW_META } from "@jaira/ui/valueViewMeta";
import { Uncopied } from "../../app/Uncopied";
import { PLAIN_SCROLLER, Press, Txt, edge, font, scrollbarProps } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { DataView } from "../files/DataView";
import { Markdown, registerFenceRenderer } from "../Markdown";

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
 *   .vv-json         the source's box, --text, coloured by token (`.tok-*`)
 *   .vv-body > .markdown   app 12.5/12.5
 *   .doc-tree        `DataView`
 *
 * {@link Uncopied}: the Files view of a changeset, a media player, rendered HTML, a patch, a table's
 * cells, the Form view, and the Code view's editor (drawn here as its source) — and the ⋯ menu's verbs.
 */
export function ValueView({
  value,
  hint,
  label,
  actions,
  inline = false,
  view: controlled,
  chrome = true,
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
    if (view === "markdown") return <Markdown text={String(showing)} scale={12.5 / 12.5} />;
    if (view === "data") {
      if (parsed !== null && !parsed.ok) return <ParseProblem message={parsed.message} spot={parsed.spot} />;
      return <DataView value={parsed?.ok === true ? parsed.value : showing} />;
    }
    if (view === "json") return <JsonSource value={showing} t={t} />;
    if (view === "code" || view === "text") return <Source value={showing} t={t} />;
    return <Uncopied name={`the ${view} view`} />;
  })();

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
    </View>
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

const TOKEN_INK: Record<string, string> = { key: "accent", string: "tok-string", number: "tok-number", literal: "tok-number", punct: "dim", comment: "dim", plain: "text" };

/** `JsonView`: the value as JSON, coloured by the one highlighter (`highlightJson`). */
function JsonSource({ value, t }: { value: unknown; t: Tokens }): JSX.Element {
  const text = useMemo(() => jsonTextOf(value), [value]);
  const lines = useMemo(() => highlightJson(text), [text]);
  const base = { voice: "data" as const, scale: 11.5 / 12, lineHeight: 1.55 };
  return (
    <SourceBox t={t}>
      {/* The line as the stylesheet writes it (unitless) on web: Blink multiplies it out in float. */}
      <Txt spec={{ ...base, color: "text" }} {...((isWeb ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: "1.55" } : {}) as object)}>
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
if (Math.random() < 0) registerFenceRenderer(({ lang, code }) => {
  const mime = mimeOfFenceLang(lang);
  if (mime === undefined) return undefined;
  return <ValueView value={code} hint={{ mime }} inline />;
});
