import { Fragment, createContext, useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { Linking, Platform, ScrollView } from "react-native";
import { View } from "@tamagui/core";
import { HREF_SCHEMES, SRC_SCHEMES, attr, parseMarkdown, safeUrl, splitFrontMatter, type FenceBlock, type Token } from "@jaira/ui/markdown";
import { InkContext, Press, Txt, edge, type FontSpec } from "../primitives";
import { useTokens } from "../tokens";
import { Picture } from "./Picture";

/**
 * `markdown.tsx`'s `Markdown`, universal (decision 0015): the same parse (`parseMarkdown`, markdown-it
 * with `html: false`), the same allowlist of what may be built, the same `safeUrl` — drawn in native
 * views instead of DOM elements. A phone draws a model's answer, a prompt or a document with this; no
 * WebView (the person, 2026-09-27: "replicate the desktop ui, but not in a webview").
 *
 * The rules it carries, from `styles.css`:
 *
 *   .markdown            padding 2 2 12, app voice at 13/12.5, line-height 1.6; first child 0 on top
 *   h1 h2 h3 h4          16 above, 6 below, line-height 1.3, bold; 18, 15, 13, 13 /12.5
 *   p ul ol blockquote table   10 below
 *   ul ol                20 in; the marker outside it ("• ", "◦ ", "▪ ", "1. "); li 2 above and below
 *   code                 data voice at --size-data/1.5 on --bg, a --line ring, radius 4, padding 0 3
 *   pre                  --bg, a --line ring, radius 6, padding 8 10, scrolls sideways, 10 below
 *   blockquote           a 3px --line on the left, 10 inside it, --dim
 *   table                collapsed --line borders, cells 3 7, left-aligned, headers bold
 *   hr                   a --line on top, 14 above and below
 *   a                    --accent, underlined (the browser's)
 *   img                  at most the width (its own size under it), on its line's baseline
 *
 * **Margins collapse**, as they do between blocks in the DOM: two neighbours are the larger of their
 * margins apart, and a block with no padding on a side shares its first (last) child's margin on that
 * side. `Block` below carries each block's margins out so its parent can do that sum.
 *
 * Context changes some of it — a transcript message is 13.5/12.5 at 1.65 with neither end's margin
 * (`.ts-msg .markdown`), a value view 12.5/12.5 (`.vv-body > .markdown`) — so those are props.
 */
export type FenceRenderer = (block: FenceBlock) => ReactNode | undefined;

let DEFAULT_FENCE: FenceRenderer | undefined;
/** The renderer fenced blocks get unless a caller brings its own — `markdown.tsx`'s registration, here. */
export function registerFenceRenderer(render: FenceRenderer): void {
  DEFAULT_FENCE = render;
}

export interface MarkdownProps {
  text: string;
  fence?: FenceRenderer | undefined;
  /** The body's size, as a multiple of `--size-app` (13/12.5 in a panel, 13.5/12.5 in a transcript). */
  scale?: number;
  lineHeight?: number;
  /** `.ts-msg .markdown > :last-child { margin-bottom: 0 }`. */
  trimEnd?: boolean;
  /** The container's padding: top, right, bottom, left. */
  padding?: readonly [number, number, number, number];
  color?: string;
  /**
   * What a single newline in a paragraph is. In the DOM it is whitespace (`breaks: false`), drawn as a
   * space — unless a container around the markdown says `white-space: pre-wrap`. A native `Text` draws
   * a newline as a line break, so a host whose DOM original collapses it (the Files viewer) says `space`.
   */
  softbreak?: "newline" | "space";
}

// --- the tree -------------------------------------------------------------------------------------

type Node = { tag: string; attrs: Record<string, string>; children: Child[] } | { tag: "fence"; block: FenceBlock };
type Child = Node | string;

const TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "em", "strong", "s", "a", "code"]);

/** markdown-it's flat stream as a tree, as `markdown.tsx`'s `fold` builds elements — same rules, no DOM. */
function treeOf(tokens: readonly Token[], softbreak: "\n" | " " = "\n"): Child[] {
  const root: Child[] = [];
  const stack: Extract<Node, { attrs: unknown }>[] = [];
  const into = (): Child[] => (stack.length > 0 ? stack[stack.length - 1]!.children : root);
  for (const token of tokens) {
    if (token.hidden) continue;
    if (token.nesting === 1) {
      if (!TAGS.has(token.tag)) continue;
      const attrs: Record<string, string> = {};
      if (token.tag === "a") {
        const href = safeUrl(attr(token, "href"), HREF_SCHEMES);
        if (href !== undefined) attrs["href"] = href;
      }
      if (token.tag === "ol") attrs["start"] = attr(token, "start") ?? "1";
      const style = attr(token, "style");
      const align = style === null ? null : /text-align:\s*(left|right|center)/i.exec(style);
      if (align !== null) attrs["align"] = align[1]!.toLowerCase();
      stack.push({ tag: token.tag, attrs, children: [] });
      continue;
    }
    if (token.nesting === -1) {
      if (!TAGS.has(token.tag)) continue;
      const frame = stack.pop();
      if (frame !== undefined) into().push(frame);
      continue;
    }
    const out = into();
    switch (token.type) {
      case "inline":
        out.push(...treeOf(token.children ?? [], softbreak));
        break;
      case "text":
        out.push(token.content);
        break;
      case "fence":
      case "code_block": {
        const info = token.info.trim();
        out.push({ tag: "fence", block: { info, lang: info.split(/\s+/)[0]?.toLowerCase() ?? "", code: token.content } });
        break;
      }
      case "code_inline":
        out.push({ tag: "code", attrs: {}, children: [token.content] });
        break;
      case "hr":
        out.push({ tag: "hr", attrs: {}, children: [] });
        break;
      case "hardbreak":
        out.push("\n");
        break;
      case "softbreak":
        out.push(softbreak);
        break;
      case "image": {
        const src = safeUrl(attr(token, "src"), SRC_SCHEMES);
        if (src !== undefined) out.push({ tag: "img", attrs: { src, alt: token.content }, children: [] });
        break;
      }
      default:
        break;
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    into().push(frame);
  }
  return root;
}

const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "table", "hr", "fence", "img"]);
const isBlock = (c: Child): boolean => typeof c !== "string" && BLOCKS.has(c.tag);

// --- the drawing ----------------------------------------------------------------------------------

/** What text in a block inherits, since nothing inherits into a native Text. */
type Ink = Pick<FontSpec, "scale" | "weight" | "italic" | "color" | "upper" | "ls"> & { lineHeight: number };

/** A block, with its margins carried out for the parent to collapse. */
interface Block {
  top: number;
  bottom: number;
  draw: (marginTop: number, marginBottom: number, key: number) => ReactNode;
}

interface Ctx {
  ink: Ink;
  fence: FenceRenderer | undefined;
  /** How deep in lists, for the marker. */
  depth: number;
}

const HEADING: Record<string, number> = { h1: 18, h2: 15, h3: 13, h4: 13, h5: 13, h6: 13 };

export function Markdown({ text, fence, scale = 13 / 12.5, lineHeight = 1.6, trimEnd = false, padding = [2, 2, 12, 2], color, softbreak = "newline" }: MarkdownProps): JSX.Element {
  const { front, body } = useMemo(() => splitFrontMatter(text), [text]);
  const tree = useMemo(() => treeOf(parseMarkdown(body), softbreak === "space" ? " " : "\n"), [body, softbreak]);
  const drawn = fence ?? DEFAULT_FENCE;
  // `.markdown` sets no colour: its text is what the box round it gives (`InkContext`), else --text.
  const inherited = useContext(InkContext);
  const ctx: Ctx = { ink: { scale, lineHeight, color: color ?? inherited ?? "text", weight: 400 }, fence: drawn, depth: 0 };
  const blocks = blocksOf(tree, ctx);
  return (
    <View paddingTop={padding[0]} paddingRight={padding[1]} paddingBottom={padding[2]} paddingLeft={padding[3]} minWidth={0}>
      {front !== undefined ? <FrontMatter text={front} fence={drawn} /> : null}
      {/* `.markdown > :first-child { margin-top: 0 }`, and in a transcript the last child's bottom too. */}
      {stack(blocks, { firstTop: 0, ...(trimEnd ? { lastBottom: 0 } : {}) })}
    </View>
  );
}

/** Siblings, their margins collapsed pairwise. The first and last may be pinned by the container. */
function stack(blocks: readonly Block[], pin: { firstTop?: number; lastBottom?: number } = {}): ReactNode[] {
  return blocks.map((b, i) => {
    const top = i === 0 ? (pin.firstTop ?? b.top) : Math.max(blocks[i - 1]!.bottom, b.top);
    const bottom = i === blocks.length - 1 ? (pin.lastBottom ?? b.bottom) : 0;
    return b.draw(top, bottom, i);
  });
}

/** A sequence of children as blocks: runs of inline content between blocks become anonymous lines. */
function blocksOf(children: readonly Child[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  let run: Child[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const inline = run;
    run = [];
    // Whitespace alone between two blocks (a newline in a loose list) is no line of its own.
    if (inline.every((c) => typeof c === "string" && c.trim() === "")) return;
    out.push({ top: 0, bottom: 0, draw: (mt, mb, key) => <Line key={key} ctx={ctx} children_={inline} marginTop={mt} marginBottom={mb} /> });
  };
  for (const c of children) {
    if (isBlock(c)) {
      flush();
      out.push(blockOf(c as Node, ctx));
    } else run.push(c);
  }
  flush();
  return out;
}

/** A container whose children's margins pass through it on the sides where it has no padding. */
function container(children: Block[], own: { top: number; bottom: number }, draw: (inner: ReactNode[], mt: number, mb: number, key: number) => ReactNode, collapse = true): Block {
  const first = children[0];
  const last = children[children.length - 1];
  const top = collapse && first !== undefined ? Math.max(own.top, first.top) : own.top;
  const bottom = collapse && last !== undefined ? Math.max(own.bottom, last.bottom) : own.bottom;
  return {
    top,
    bottom,
    draw: (mt, mb, key) => draw(stack(children, collapse ? { firstTop: 0, lastBottom: 0 } : {}), mt, mb, key),
  };
}

function blockOf(node: Node, ctx: Ctx): Block {
  if ("block" in node) return fenceBlock(node.block, ctx);
  const n = node as Extract<Node, { attrs: unknown }>;
  switch (n.tag) {
    case "p":
      // A picture is inline in the DOM, on its paragraph's baseline: the paragraph is its runs of text
      // and its pictures, each picture on a line box of its own (text beside a picture on one line is
      // not drawn beside it here).
      if (n.children.some((c) => typeof c !== "string" && c.tag === "img")) {
        return container(blocksOf(n.children, ctx), { top: 0, bottom: 10 }, (inner, mt, mb, key) => (
          <View key={key} marginTop={mt} marginBottom={mb}>
            {inner}
          </View>
        ));
      }
      return { top: 0, bottom: 10, draw: (mt, mb, key) => <Line key={key} ctx={ctx} children_={n.children} marginTop={mt} marginBottom={mb} /> };
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      // `h3` also takes the app's global heading rule: uppercase, 0.09em apart, --dim.
      const h3 = n.tag === "h3";
      const heading: Ctx = { ...ctx, ink: { ...ctx.ink, scale: HEADING[n.tag]! / 12.5, weight: 700, lineHeight: 1.3, ...(h3 ? { color: "dim" } : {}) } };
      return { top: 16, bottom: 6, draw: (mt, mb, key) => <Line key={key} ctx={heading} children_={n.children} marginTop={mt} marginBottom={mb} {...(h3 ? { upper: true, ls: 0.09 } : {})} /> };
    }
    case "blockquote": {
      const quoted: Ctx = { ...ctx, ink: { ...ctx.ink, color: "dim" } };
      return container(blocksOf(n.children, quoted), { top: 0, bottom: 10 }, (inner, mt, mb, key) => (
        <BlockQuote key={key} marginTop={mt} marginBottom={mb}>
          {inner}
        </BlockQuote>
      ));
    }
    case "ul":
    case "ol": {
      const start = Number(n.attrs["start"] ?? "1");
      const items = n.children
        .filter((c): c is Extract<Node, { attrs: unknown }> => typeof c !== "string" && c.tag === "li")
        .map((li, i) => itemOf(li, { ...ctx, depth: ctx.depth + 1 }, n.tag === "ol" ? `${start + i}. ` : markerOf(ctx.depth)));
      return container(items, { top: 0, bottom: 10 }, (inner, mt, mb, key) => (
        <View key={key} marginTop={mt} marginBottom={mb} paddingLeft={20}>
          {inner}
        </View>
      ));
    }
    case "table":
      return { top: 0, bottom: 10, draw: (mt, mb, key) => <Table key={key} node={n} ctx={ctx} marginTop={mt} marginBottom={mb} /> };
    case "hr":
      return { top: 14, bottom: 14, draw: (mt, mb, key) => <Rule key={key} marginTop={mt} marginBottom={mb} /> };
    case "img":
      return { top: 0, bottom: 0, draw: (mt, mb, key) => <LinePicture key={key} src={n.attrs["src"]!} alt={n.attrs["alt"] ?? ""} ink={ctx.ink} marginTop={mt} marginBottom={mb} /> };
    default:
      return { top: 0, bottom: 0, draw: (mt, mb, key) => <Line key={key} ctx={ctx} children_={n.children} marginTop={mt} marginBottom={mb} /> };
  }
}

/** The marker a nested bullet list takes, as the browser's `disc`, `circle`, `square`. */
const markerOf = (depth: number): string => (depth === 0 ? "• " : depth === 1 ? "◦ " : "▪ ");

function itemOf(li: Extract<Node, { attrs: unknown }>, ctx: Ctx, marker: string): Block {
  return container(blocksOf(li.children, ctx), { top: 2, bottom: 2 }, (children, mt, mb, key) => (
    // An `li` is not positioned, and on web neither is this (its marker is hung in the flow, below): a
    // positioned box is painted after everything that is not, and its marker, painted there, turned the
    // text of a whole track of gallery cards greyscale where the desktop's is subpixel.
    <View key={key} marginTop={mt} marginBottom={mb} {...(Platform.OS === "web" ? {} : { position: "relative" })}>
      <Marker marker={marker} ink={ctx.ink} />
      {children}
    </View>
  ));
}

/**
 * `list-style-position: outside`. A number is text that ends where the item's text begins ("1. ",
 * trailing space and all). A bullet is not a glyph: Chromium DRAWS disc, circle and square, a third of
 * the way up the ascent — measured, 4px across at 13px, its right edge two-thirds of an em short of the
 * text and its middle 0.45px under the line's.
 *
 * On web it is hung in the flow — a box of no size at the item's corner, what it holds running out of it
 * (a number to the left, from its end) — rather than placed absolutely, so the item is not positioned.
 */
function Marker({ marker, ink }: { marker: string; ink: Ink }): JSX.Element {
  const t = useTokens();
  const size = Number(t.scaled("size-app", ink.scale ?? 1));
  const line = ink.lineHeight * size;
  const hung = Platform.OS === "web";
  if (/^\d/.test(marker)) {
    if (hung) {
      return (
        <View width={0} height={0} flexDirection="row" justifyContent="flex-end" alignItems="flex-start">
          <Txt spec={{ voice: "app", ...ink }} {...unitless(ink)} flexShrink={0} whiteSpace="pre">
            {marker}
          </Txt>
        </View>
      );
    }
    return (
      <Txt spec={{ voice: "app", ...ink }} {...unitless(ink)} position="absolute" right="100%" top={0} whiteSpace="pre">
        {marker}
      </Txt>
    );
  }
  // Chromium's own arithmetic (`ListMarker`'s symbol rect), in whole pixels of the font's ascent: the disc
  // is (⌊2A/3⌋ + 1) / 2 across and ⌊3(A − ⌊2A/3⌋) / 2⌋ under the top of the text, which sits half the
  // leading under the top of the line (DM Sans: ascent 0.992 em, descent 0.31 em, each rounded).
  const ascent = Math.round(size * 0.992);
  const third = Math.floor((ascent * 2) / 3);
  const d = Math.floor((third + 1) / 2) > 0 ? Math.floor((third + 1) / 2) : 4;
  const textTop = (line - (ascent + Math.round(size * 0.31))) / 2;
  const color = t.v(ink.color ?? "text");
  const shape = marker.startsWith("◦")
    ? { borderRadius: 999, ...edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, String(color)) }
    : marker.startsWith("▪")
      ? { backgroundColor: color }
      : { borderRadius: 999, backgroundColor: color };
  const [left, top] = [-(size * (2 / 3) + d), textTop + Math.floor((3 * (ascent - third)) / 2)];
  if (hung) {
    return (
      <View width={0} height={0}>
        <View width={d} height={d} flexShrink={0} marginLeft={left} marginTop={top} {...(shape as object)} />
      </View>
    );
  }
  return <View position="absolute" width={d} height={d} left={left} top={top} {...(shape as object)} />;
}

/**
 * The line height a fenced block's viewer inherits: the document's (`.markdown`'s 1.6, a transcript
 * message's 1.65), not the body's 1.5 — its toggles are a pixel taller for it. Undefined outside a fence.
 */
export const FenceLineContext = createContext<number | undefined>(undefined);

function fenceBlock(block: FenceBlock, ctx: Ctx): Block {
  const drawn = ctx.fence?.(block);
  if (drawn !== undefined) {
    return {
      top: 0,
      bottom: 10,
      draw: (mt, mb, key) => (
        <View key={key} marginTop={mt} marginBottom={mb}>
          <FenceLineContext.Provider value={ctx.ink.lineHeight}>{drawn}</FenceLineContext.Provider>
        </View>
      ),
    };
  }
  return { top: 0, bottom: 10, draw: (mt, mb, key) => <Pre key={key} code={block.code} ink={ctx.ink} marginTop={mt} marginBottom={mb} /> };
}

// --- blocks ---------------------------------------------------------------------------------------

/** A line box: inline content as one Text, its runs nested. */
function Line({ ctx, children_, marginTop, marginBottom, upper, ls }: { ctx: Ctx; children_: readonly Child[]; marginTop: number; marginBottom: number; upper?: boolean; ls?: number }): JSX.Element {
  const spec = { voice: "app" as const, ...ctx.ink, ...(upper === true ? { upper } : {}), ...(ls !== undefined ? { ls } : {}) };
  return (
    <Txt spec={spec} marginTop={marginTop} marginBottom={marginBottom} {...unitless(ctx.ink)}>
      {inlines(children_, { ...ctx.ink, ...(upper === true ? { upper } : {}), ...(ls !== undefined ? { ls } : {}) })}
    </Txt>
  );
}

function inlines(children: readonly Child[], ink: Ink): ReactNode[] {
  return children.map((c, i) => {
    if (typeof c === "string") return <Fragment key={i}>{c}</Fragment>;
    if (c.tag === "fence") return null;
    const n = c as Extract<Node, { attrs: unknown }>;
    switch (n.tag) {
      case "strong":
        return <Inline key={i} ink={{ ...ink, weight: 700 }}>{inlines(n.children, { ...ink, weight: 700 })}</Inline>;
      case "em":
        return <Inline key={i} ink={{ ...ink, italic: true }}>{inlines(n.children, { ...ink, italic: true })}</Inline>;
      case "s":
        return (
          <Inline key={i} ink={ink} textDecorationLine="line-through">
            {inlines(n.children, ink)}
          </Inline>
        );
      case "a":
        return <Link key={i} href={n.attrs["href"]} ink={ink}>{inlines(n.children, { ...ink, color: "accent" })}</Link>;
      case "code":
        return <Code key={i}>{n.children.join("")}</Code>;
      default:
        return <Fragment key={i}>{inlines(n.children, ink)}</Fragment>;
    }
  });
}

/**
 * On web, the line as the stylesheet writes it (`.markdown { line-height: 1.6 }`, unitless): Blink
 * multiplies it out in floating point and floors it to its layout unit, where a copy's pixels round to
 * the nearest — a hundredth of a pixel a line, which a page of prose adds up to half a pixel by its foot.
 */
const unitless = (ink: Ink): Record<string, unknown> => (Platform.OS === "web" ? { lineHeight: String(ink.lineHeight) } : {});

function Inline({ ink, children, ...rest }: { ink: Ink; children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice: "app", ...ink }} {...unitless(ink)} {...rest}>
      {children}
    </Txt>
  );
}

function Link({ href, ink, children }: { href: string | undefined; ink: Ink; children: ReactNode }): JSX.Element {
  return (
    <Txt
      spec={{ voice: "app", ...ink, color: "accent" }}
      {...unitless(ink)}
      textDecorationLine="underline"
      // On web a real `<a target="_blank">`, as the desktop's: reached by Tab, opened by Enter, named by the
      // right-click menu ("Copy link"), under a pointing hand — and opened by the anchor itself, which the
      // window hands to the browser, so no press handler opens it a second time. A phone opens it by the press.
      {...(href === undefined ? {} : Platform.OS === "web" ? { render: "a", href, target: "_blank", rel: "noreferrer noopener" } : { onPress: () => void Linking.openURL(href) })}
    >
      {children}
    </Txt>
  );
}

/** Inline code: the data voice at `--size-data`/1.5, on `--bg` in a `--line` ring. */
function Code({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Txt
      spec={{ voice: "data", scale: 1, lineHeight: 1.5 }}
      backgroundColor={t.v("bg") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      borderRadius={4}
      paddingHorizontal={3}
    >
      {children}
    </Txt>
  );
}

/**
 * A fenced block with no renderer: its source in a `--bg` box. The lines are the BLOCK's line height (the
 * `pre`'s strut, 1.6 × the body size), not `code`'s own 1.5 — a line box is never shorter than its block's.
 */
function Pre({ code, ink, marginTop, marginBottom }: { code: string; ink?: Ink; marginTop: number; marginBottom: number }): JSX.Element {
  const t = useTokens();
  const strut = Number(t.scaled("size-app", ink?.scale ?? 13 / 12.5)) * (ink?.lineHeight ?? 1.6);
  // On web the same height as a factor of this font's size: Blink snaps a factor's product DOWN to 1/64 of
  // a device pixel and a length to the nearest, and a block of several lines stood that much taller a line.
  const size = Number(t.scaled("size-data", 1));
  const factor = Platform.OS === "web" && t.replayed && size > 0 ? { lineHeight: String(strut / size) } : {};
  return (
    <View marginTop={marginTop} marginBottom={marginBottom} backgroundColor={t.v("bg") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} borderRadius={6}>
      <ScrollView horizontal contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 10 }}>
        <Txt spec={{ voice: "data", scale: 1, lineHeight: t.replayed ? { px: strut } : 1.5 }} {...factor} whiteSpace="pre">
          {code.replace(/\n$/, "")}
        </Txt>
      </ScrollView>
    </View>
  );
}

function BlockQuote({ children, marginTop, marginBottom }: { children: ReactNode; marginTop: number; marginBottom: number }): JSX.Element {
  const t = useTokens();
  return (
    <View marginTop={marginTop} marginBottom={marginBottom} paddingLeft={10} {...(edge(t, { left: 3 }) as object)}>
      {children}
    </View>
  );
}

function Rule({ marginTop, marginBottom }: { marginTop: number; marginBottom: number }): JSX.Element {
  const t = useTokens();
  // As tall as its one border, which Chromium draws in whole device pixels (0.667 in the studio), not a fixed 1.
  return <View marginTop={marginTop} marginBottom={marginBottom} {...(edge(t, { top: 1 }) as object)} />;
}

/**
 * `.markdown img { max-width: 100% }`: a picture at its own size, no wider than the column. It sits on its
 * line's baseline, so the line box runs on under it by the strut's depth below the baseline — half the
 * line height less half the face's ascent over its descent (DM Sans, measured: 0.656 em).
 */
function LinePicture({ src, alt, ink, marginTop, marginBottom }: { src: string; alt: string; ink: Ink; marginTop: number; marginBottom: number }): JSX.Element {
  const t = useTokens();
  const size = Number(t.scaled("size-app", ink.scale ?? 13 / 12.5)) || 13;
  return (
    <View marginTop={marginTop} marginBottom={marginBottom}>
      <Picture src={src} alt={alt} below={(ink.lineHeight * size - 0.656 * size) / 2} />
    </View>
  );
}

/**
 * A table, `border-collapse: collapse`, every cell a --line box sharing its borders.
 *
 * On web it is laid out as the desktop's is — the browser's automatic table layout (`display: table`),
 * which no flex box does: no wider than the block it stands in, the room shared between its columns by
 * what each holds, cells wrapping, a row as tall as its tallest cell and the others' words at its middle.
 * (Drawn the other way it ran every cell out on one line: a README's table went off the side of its
 * pane, and the document under it stood 353px short of the desktop's.)
 *
 * A phone has no table layout: there it is still drawn column by column, each column as wide as its
 * widest cell and nothing wrapping — TODO, a measured layout of its own.
 */
function Table({ node, ctx, marginTop, marginBottom }: { node: Extract<Node, { attrs: unknown }>; ctx: Ctx; marginTop: number; marginBottom: number }): JSX.Element {
  const t = useTokens();
  const rows: { head: boolean; cells: Extract<Node, { attrs: unknown }>[] }[] = [];
  const walk = (n: Extract<Node, { attrs: unknown }>, head: boolean): void => {
    for (const c of n.children) {
      if (typeof c === "string" || c.tag === "fence") continue;
      const k = c as Extract<Node, { attrs: unknown }>;
      if (k.tag === "thead") walk(k, true);
      else if (k.tag === "tbody") walk(k, false);
      else if (k.tag === "tr") rows.push({ head, cells: k.children.filter((x): x is Extract<Node, { attrs: unknown }> => typeof x !== "string" && (x.tag === "th" || x.tag === "td")) });
    }
  };
  walk(node, false);
  const columns = Math.max(0, ...rows.map((r) => r.cells.length));
  if (Platform.OS === "web") {
    return (
      <View alignSelf="flex-start" marginTop={marginTop} marginBottom={marginBottom} style={{ display: "table", borderCollapse: "collapse" } as never}>
        {rows.map((row, r) => (
          <View key={r} style={{ display: "table-row" } as never}>
            {Array.from({ length: columns }, (_, col) => {
              const cell = row.cells[col];
              const ink = { ...ctx.ink, ...(row.head ? { weight: 700 } : {}) };
              return (
                <View key={col} paddingVertical={3} paddingHorizontal={7} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} style={{ display: "table-cell", verticalAlign: "middle" } as never}>
                  {/* A block, so the cell's lines are of this font and not of the page's own. */}
                  <Txt spec={{ voice: "app", ...ink }} {...unitless(ink)} display="block" textAlign={(cell?.attrs["align"] as never) ?? "left"}>
                    {cell === undefined ? "" : inlines(cell.children, ink)}
                  </Txt>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    );
  }
  return (
    <View flexDirection="row" alignSelf="flex-start" marginTop={marginTop} marginBottom={marginBottom} {...(edge(t, { top: 1, left: 1 }) as object)}>
      {Array.from({ length: columns }, (_, col) => (
        <View key={col} flexDirection="column">
          {rows.map((row, r) => {
            const cell = row.cells[col];
            const ink = { ...ctx.ink, ...(row.head ? { weight: 700 } : {}) };
            return (
              <View key={r} paddingVertical={3} paddingHorizontal={7} {...(edge(t, { right: 1, bottom: 1 }) as object)}>
                <Txt spec={{ voice: "app", ...ink }} {...unitless(ink)} textAlign={(cell?.attrs["align"] as never) ?? "left"}>
                  {cell === undefined ? "" : inlines(cell.children, ink)}
                </Txt>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** Front matter: collapsed under "front matter", opened onto the same renderer a ```yaml fence gets. */
function FrontMatter({ text, fence }: { text: string; fence: FenceRenderer | undefined }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View marginBottom={10}>
      <Press onPress={() => setOpen(!open)} label="front matter" alignSelf="flex-start">
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{`${open ? "▼" : "▶"} front matter`}</Txt>
      </Press>
      {open ? <View marginTop={6}>{fence?.({ info: "yaml", lang: "yaml", code: text }) ?? <Pre code={text} marginTop={0} marginBottom={0} />}</View> : null}
    </View>
  );
}
