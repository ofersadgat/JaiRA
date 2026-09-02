/**
 * Rendered markdown, in its own module because two surfaces need it.
 *
 * It was part of the built-in surface table until the workflow description grew a viewer of its own
 * (`syncPanel.tsx`) that shows the same preview behind a toggle. Importing it from there would have
 * made the table import the panel and the panel import the table — a cycle that happens to work in
 * ES modules and is a poor thing to depend on. One parser, one component, one file.
 *
 * ## Why this builds ELEMENTS rather than a string
 *
 * It used to render to HTML, sanitize it, and hand the result to `dangerouslySetInnerHTML`. That
 * works right up until you want your own component *inside* the document — which is exactly what a
 * fenced ```html block needs, because a model asked for a mockup that cannot reach `show_artifact`
 * pastes the page into its answer, and a grey box of source is not what anybody asked to see.
 *
 * A string has no seam. The trick it forces — render a placeholder element, then split the sanitized
 * HTML on it and interleave React children — is string surgery over output a sanitizer is free to
 * restructure, and it fails outright the moment the fence is nested in a list or a quote, because
 * then the placeholder is not at the top level to split on. So the fold builds React nodes from
 * markdown-it's TOKENS, and {@link Markdown.fence} is an ordinary prop.
 *
 * ## What happened to the sanitizer
 *
 * DOMPurify is gone, and the safety story is stronger for it rather than weaker. It was doing two
 * jobs. Stripping tags is now structural: nothing here interpolates markup, every element is one this
 * module chose by name, and React escapes text — so there is no parse for an injection to survive.
 * Scrubbing `javascript:` URLs is now {@link safeUrl}, which is explicit and testable instead of
 * incidental. `html: false` stays as it was: raw HTML in the source arrives as TEXT, so there is no
 * tag to strip in the first place.
 */
import { createElement, useMemo, type CSSProperties, type JSX, type ReactNode } from "react";
import MarkdownIt from "markdown-it";
import { highlightYaml } from "./yamlHighlight";

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
type Token = ReturnType<typeof MARKDOWN.parse>[number];

// --- the seam ----------------------------------------------------------------

/** A fenced block, as the thing that decides how to draw it wants to read it. */
export interface FenceBlock {
  /** The info string exactly as written after the backticks — `html`, or `js title=foo`. */
  info: string;
  /** The first word of it, lowercased: the part anybody actually dispatches on. */
  lang: string;
  /** The contents, verbatim. */
  code: string;
}

/**
 * What to draw for a fenced block, when the default grey box is not the answer.
 *
 * Returning `undefined` — not null, not an empty fragment — is how a renderer declines, and it is a
 * distinct answer on purpose: "I have nothing for `python`" has to fall back to the source view,
 * whereas a renderer that returned nothing at all would silently swallow the block.
 */
export type FenceRenderer = (block: FenceBlock) => ReactNode | undefined;

/**
 * The renderer every markdown surface gets unless it says otherwise.
 *
 * A REGISTRATION rather than a required prop, and the reason is the cycle this module's header is
 * about: the thing that knows how to draw a fenced block is `ValueView`, `ValueView` draws markdown
 * and therefore imports this file, so the renderer cannot be imported from here. Injection is the
 * only way round that — and injection through an optional prop is injection a caller can silently
 * skip.
 *
 * Which is exactly what happened. Four surfaces rendered markdown, one passed the prop, and the
 * other three showed a grey `<pre>` where the transcript showed a full reading. Nothing failed:
 * {@link fold} has a legitimate fallback for "no renderer supplied", and it is byte-identical to
 * "renderer supplied and declined this language", so the difference was invisible. A workflow
 * description is prose wrapped around fenced YAML, which made the grey box most of the document.
 *
 * With a default there is nothing to forget. The same shape `fileTypes.ts` uses for surfaces:
 * importing the module that owns the renderer is what installs it, and a module graph that never
 * reaches `fenceRender.tsx` — the parser's own tests, say — gets the bare fold, which is the honest
 * behaviour for a caller that has no value viewer in it.
 */
let DEFAULT_FENCE: FenceRenderer | undefined;

/** Install the renderer fenced blocks are drawn with. Last call wins; see {@link DEFAULT_FENCE}. */
export function registerFenceRenderer(render: FenceRenderer): void {
  DEFAULT_FENCE = render;
}

// --- urls --------------------------------------------------------------------

/**
 * Built from a string rather than written as a literal, so no control character appears in this file.
 *
 * A source file with a raw NUL in it is one every tool downstream — grep, diffs, review — treats
 * as binary, which is a high price for four characters of notation.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** A scheme, if the URL has one at all. */
const SCHEME = /^([a-z][a-z0-9+.\-]*):/i;
const HREF_SCHEMES = new Set(["http", "https", "mailto"]);
/** Images may also be inline: markdown-it's own `validateLink` already bounds `data:` to picture types. */
const SRC_SCHEMES = new Set(["http", "https", "data"]);

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
function safeUrl(raw: string | null, allowed: ReadonlySet<string>): string | undefined {
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
function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null || value === undefined ? null : String(value);
}

/**
 * The only inline style markdown-it ever emits, translated.
 *
 * A table's column alignment, and nothing else. Passing the attribute through as a string would
 * mean accepting a `style` React does not parse; naming the one property that arrives keeps this a
 * translation rather than a channel.
 */
function styleOf(token: Token): CSSProperties | undefined {
  const style = attr(token, "style");
  const align = style === null ? null : /text-align:\s*(left|right|center)/i.exec(style);
  return align === null ? undefined : { textAlign: align[1]!.toLowerCase() as CSSProperties["textAlign"] };
}

/** What an element carries, by tag — an allowlist, because anything not named here is dropped. */
function propsOf(token: Token, key: number): Record<string, unknown> {
  const props: Record<string, unknown> = { key };
  const style = styleOf(token);
  if (style !== undefined) props["style"] = style;
  if (token.tag === "a") {
    const href = safeUrl(attr(token, "href"), HREF_SCHEMES);
    // A link with nothing safe behind it is still rendered — as an `<a>` with no `href`, which is
    // inert and still shows its text. Dropping the element would silently delete words the model
    // wrote, and the reader would never know a link had been there.
    if (href !== undefined) Object.assign(props, { href, target: "_blank", rel: "noreferrer noopener" });
    const title = attr(token, "title");
    if (title !== null) props["title"] = title;
  }
  if (token.tag === "ol") {
    const start = attr(token, "start");
    if (start !== null) props["start"] = Number(start);
  }
  return props;
}

// --- the fold ----------------------------------------------------------------

/**
 * Tags this module will build. Everything else falls through as its children.
 *
 * An allowlist rather than "whatever `token.tag` says", because `token.tag` is a string from a parser
 * and `React.createElement` takes one — so the unguarded version would build whatever a future rule
 * or plugin named, which is the shape of the bug this file exists to not have.
 */
const TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  "em", "strong", "s", "a", "code", "pre",
]);

/**
 * markdown-it's flat token stream, folded into a tree of elements.
 *
 * The stream is flat and nesting is carried by `token.nesting` (`1` opens, `-1` closes, `0` stands
 * alone), so this is a stack: an opener pushes a frame, a closer pops it and appends the finished
 * element to its parent. `inline` tokens hold their own child stream and recurse.
 */
interface Frame {
  tag: string;
  props: Record<string, unknown>;
  children: ReactNode[];
}

/**
 * A finished frame, as an element.
 *
 * `createElement` rather than JSX with a variable tag: `<frame.tag>` reads as a component reference
 * and only works here by accident of the tag being a string. Spelling it out is also where the
 * allowlist pays off — this is the call that would otherwise build whatever the parser named.
 */
function element(frame: Frame): ReactNode {
  return createElement(frame.tag, frame.props, ...frame.children);
}

function fold(tokens: readonly Token[], fence: FenceRenderer | undefined): ReactNode[] {
  const root: ReactNode[] = [];
  const stack: Frame[] = [];
  const into = (): ReactNode[] => (stack.length > 0 ? stack[stack.length - 1]!.children : root);

  tokens.forEach((token, i) => {
    // A TIGHT list's item paragraphs — `- one` rather than `- one\n\n- two` — are marked hidden by
    // the parser and skipped by its own renderer, which is how a tight list comes out as `<li>one`
    // instead of `<li><p>one</p>`. The flag is the only thing carrying that: the tokens are there
    // either way. Missed once, and every bullet in the app gained a paragraph's worth of margin.
    if (token.hidden) return;
    if (token.nesting === 1) {
      if (TAGS.has(token.tag)) stack.push({ tag: token.tag, props: propsOf(token, i), children: [] });
      return;
    }
    if (token.nesting === -1) {
      if (!TAGS.has(token.tag)) return;
      const frame = stack.pop();
      if (frame === undefined) return;
      into().push(element(frame));
      return;
    }
    const out = into();
    switch (token.type) {
      case "inline":
        // The child stream, appended into whatever block is open — an inline run is not an element.
        out.push(...fold(token.children ?? [], fence));
        return;
      case "text":
        out.push(token.content);
        return;
      case "fence":
      case "code_block": {
        const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const drawn = fence?.({ info: token.info.trim(), lang, code: token.content });
        // THE SEAM. `undefined` means the renderer declined and the source is what to show; anything
        // else is what it wanted drawn, wrapped so a block always occupies a block.
        out.push(
          drawn === undefined ? (
            <pre key={i} className={lang === "" ? undefined : `language-${lang}`}>
              <code>{token.content}</code>
            </pre>
          ) : (
            <div key={i} className="md-block">
              {drawn}
            </div>
          ),
        );
        return;
      }
      case "code_inline":
        out.push(<code key={i}>{token.content}</code>);
        return;
      case "hr":
        out.push(<hr key={i} />);
        return;
      case "hardbreak":
        out.push(<br key={i} />);
        return;
      case "softbreak":
        // A newline, not a break: `breaks: false` says a single newline is whitespace, and dropping
        // it entirely would run the last word of one line into the first of the next.
        out.push("\n");
        return;
      case "image": {
        const src = safeUrl(attr(token, "src"), SRC_SCHEMES);
        if (src === undefined) return;
        const title = attr(token, "title");
        out.push(<img key={i} src={src} alt={token.content} {...(title !== null ? { title } : {})} />);
        return;
      }
      default:
        // Unknown, and silently so. A token this fold has no case for is a rule nobody enabled or a
        // marker with no rendering of its own; drawing its `content` raw would put parser internals
        // on screen.
        return;
    }
  });
  // An unclosed frame is a truncated stream — a half-arrived answer, which is the ordinary case here
  // rather than an error. Close what is open, outermost last, so the partial document still renders.
  while (stack.length > 0) {
    const frame = stack.pop()!;
    into().push(element(frame));
  }
  return root;
}

// --- front matter ------------------------------------------------------------

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
function splitFrontMatter(text: string): { front: string | undefined; body: string } {
  const found = FRONT_MATTER.exec(text);
  // An EMPTY header is not one: `---\n---` at the top of a page is two thematic breaks somebody
  // typed, and swallowing them would be the renderer deciding it knew better.
  if (found === null || found[1]!.trim() === "") return { front: undefined, body: text };
  return { front: found[1]!, body: text.slice(found[0].length) };
}

// --- the components ----------------------------------------------------------

/**
 * A YAML block, coloured — front matter, and nothing else so far.
 *
 * Front matter is YAML and was drawn as a grey `<pre>`, which made the header of every prompt, skill
 * and workflow description in the shared root the least readable part of the document it opens. It
 * is coloured HERE rather than through the value viewer for the reason `yamlHighlight.ts` opens
 * with: this module renders once per message down a transcript, and the app's other YAML colourer
 * is a lazily-loaded Monaco. Same token classes as the JSON one, so the two never drift apart.
 */
function YamlLines({ text }: { text: string }): JSX.Element {
  const lines = useMemo(() => highlightYaml(text), [text]);
  return (
    <pre className="md-front-body">
      <code>
        {lines.map((line, i) => (
          <span className="code-line" key={i}>
            {line.tokens.map((token, j) => (
              <span key={j} className={`tok tok-${token.kind}`}>
                {token.text}
              </span>
            ))}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

/**
 * The markdown preview lives in `fenceRender.tsx`, not here.
 *
 * It has to: a preview worth having draws its fenced blocks as what they are, the thing that knows
 * how to draw one is `ValueView`, and `ValueView` imports this module. The seam below is this
 * module's whole contribution to that — see {@link FenceRenderer}.
 */

/**
 * The same rendering, for text that is not a file.
 *
 * A model's answer is markdown and was being shown as preformatted text, so a plan came back as one
 * long line with literal `#` and `-` in it. Split out rather than duplicated because the parser
 * configuration and the fold are the safety story, and a second copy of a renderer is a second copy
 * to get wrong.
 *
 * `fence` is how a caller takes over a fenced block — see {@link FenceRenderer}. It is a prop rather
 * than something this module decides, because the module that knows what to DO with a page of HTML
 * is the one drawing the transcript, and having markdown reach for the value viewer would put the
 * cycle back that the header opens by explaining.
 */
export function Markdown({ text, fence }: { text: string; fence?: FenceRenderer | undefined }): JSX.Element {
  const { front, body } = useMemo(() => splitFrontMatter(text), [text]);
  // The registered renderer unless this caller brought its own — see {@link registerFenceRenderer}.
  // Both are module-level references, so the memo below is still stable across renders.
  const drawn = fence ?? DEFAULT_FENCE;
  const nodes = useMemo(() => fold(MARKDOWN.parse(body, {}), drawn), [body, drawn]);
  return (
    <div className="markdown">
      {front === undefined ? null : (
        <details className="md-front">
          <summary>front matter</summary>
          {/* Front matter IS a YAML document, so it gets exactly what a ```yaml fence gets — the
              value viewer, with its Code / Data / Source toggle and its parse. It reaches it by
              being handed to the same renderer under the same name, rather than by this module
              learning a second way to draw YAML: a header and a fence are the same content in the
              same file, and two paths to draw them is two things to keep in agreement.

              {@link YamlLines} stays as the fallback for a graph with no renderer registered — the
              parser's own tests — which is the same honest degradation the fenced blocks get. */}
          {drawn?.({ info: "yaml", lang: "yaml", code: front }) ?? <YamlLines text={front} />}
        </details>
      )}
      {nodes}
    </div>
  );
}
