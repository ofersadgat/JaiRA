/**
 * Markdown, read: the one parser for the whole app, its token type, what a fenced block is handed to
 * its renderer as, the URL rules, and a document's front matter split from its body.
 *
 * Both markdown components fold the same tokens — the DOM one (`markdown.tsx`, an island now: decision
 * 0015) and the universal copy (`packages/universal/src/components/Markdown.tsx`) — so the parse and
 * the safety rules are here once, and nothing here draws.
 *
 * ## What happened to the sanitizer
 *
 * DOMPurify is gone, and the safety story is stronger for it rather than weaker. It was doing two
 * jobs. Stripping tags is now structural: neither component interpolates markup, every element is one
 * it chose by name, and text is escaped — so there is no parse for an injection to survive. Scrubbing
 * `javascript:` URLs is now {@link safeUrl}, which is explicit and testable instead of incidental.
 * `html: false` stays as it was: raw HTML in the source arrives as TEXT, so there is no tag to strip in
 * the first place.
 */
import MarkdownIt from "markdown-it";

/**
 * One parser for the whole app.
 *
 * `html: false` is load-bearing, not tidy: markdown files here come from the shared root and from
 * skills someone else authored, and a model's answer is less trusted still, so the content is no
 * more trusted than the path it arrived on — and this renderer is inside a privileged process.
 */
const MARKDOWN = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * The parser's own token type, derived from the parser.
 *
 * `markdown-it` ships types AND `@types/markdown-it` is installed, and the two disagree about
 * `attrs` — one says `[string, string][]`, the other allows a number in the value. Importing either
 * by path picks a side that the next `npm install` can move; reading it off `parse` cannot be wrong
 * about the tokens `parse` returns.
 */
export type Token = ReturnType<typeof MARKDOWN.parse>[number];

/** The one parse, for the universal copy (`packages/universal/src/components/Markdown.tsx`, decision 0015). */
export function parseMarkdown(text: string): Token[] {
  return MARKDOWN.parse(text, {});
}

/** A fenced block, as the thing that decides how to draw it wants to read it. */
export interface FenceBlock {
  /** The info string exactly as written after the backticks — `html`, or `js title=foo`. */
  info: string;
  /** The first word of it, lowercased: the part anybody actually dispatches on. */
  lang: string;
  /** The contents, verbatim. */
  code: string;
  /**
   * Where a change to the block's contents goes, when the surface drawing it permits one.
   *
   * ABSENT means read-only, which is the same way every other document in this app says it — see
   * `documents.tsx`. A reading surface never supplies it, so a fence in a transcript is exactly what
   * it always was; the live-preview editor does, which is what lets a ```ts block inside a markdown
   * file be edited by the same Monaco that would edit the `.ts` file itself.
   */
  edit?: ((next: string) => void) | undefined;
}

/**
 * Built from a string rather than written as a literal, so no control character appears in this file.
 *
 * A source file with a raw NUL in it is one every tool downstream — grep, diffs, review — treats
 * as binary, which is a high price for four characters of notation.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** A scheme, if the URL has one at all. */
const SCHEME = /^([a-z][a-z0-9+.\-]*):/i;
export const HREF_SCHEMES = new Set(["http", "https", "mailto"]);
/** Images may also be inline: markdown-it's own `validateLink` already bounds `data:` to picture types. */
export const SRC_SCHEMES = new Set(["http", "https", "data"]);

/**
 * A URL, or nothing.
 *
 * The second layer, and deliberately a duplicate of one: markdown-it's `validateLink` already refuses
 * `javascript:` and friends while parsing. That guard belongs to the parser's configuration, though,
 * and this belongs to the renderer — the place that would be handing a live `href` to a privileged
 * window. A relative URL has no scheme to abuse and passes.
 *
 * Control characters are stripped BEFORE the scheme is read, because `java\tscript:alert(1)` is a
 * URL the browser will happily normalise back into one and a naive prefix test will not.
 */
export function safeUrl(raw: string | null, allowed: ReadonlySet<string>): string | undefined {
  if (raw === null) return undefined;
  const url = raw.replace(CONTROL_CHARS, "").trim();
  if (url === "") return undefined;
  const scheme = SCHEME.exec(url);
  if (scheme === null) return url;
  return allowed.has(scheme[1]!.toLowerCase()) ? url : undefined;
}

// --- attributes --------------------------------------------------------------

/**
 * One attribute, as a string or not at all.
 *
 * `attrGet` is typed `string | number | null` — a plugin may set a numeric attribute — and every
 * consumer below wants text. Narrowed once here rather than at four call sites.
 */
export function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null || value === undefined ? null : String(value);
}

/**
 * The YAML block a document opens with, matched only at position 0.
 *
 * Not a markdown construct, which is exactly the problem: to the parser `---` is a thematic break,
 * and `---` UNDER a paragraph is a setext underline — so `id: …\ntype: …\nstatus: proposed\n---`
 * comes out as a rule followed by a three-line `<h2>`. That is not a near miss. It is the loudest
 * thing on the page, it says something the document does not, and it lands on the first screen of
 * every doc in `docs/` — which is what made it worth a rule of its own rather than a shrug.
 *
 * Kept rather than dropped, and collapsed rather than shown: the header is metadata about the
 * document, so it is not part of the reading, but a renderer that silently deletes lines is one you
 * cannot trust about the lines it kept.
 */
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A document, as its header and its body. `front` is absent when it has none. */
export function splitFrontMatter(text: string): { front: string | undefined; body: string } {
  const found = FRONT_MATTER.exec(text);
  // An EMPTY header is not one: `---\n---` at the top of a page is two thematic breaks somebody
  // typed, and swallowing them would be the renderer deciding it knew better.
  if (found === null || found[1]!.trim() === "") return { front: undefined, body: text };
  return { front: found[1]!, body: text.slice(found[0].length) };
}
