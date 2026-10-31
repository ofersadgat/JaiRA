/**
 * A small HTML parser that keeps every node's place in the source.
 *
 * The browser's own parser cannot be used for an artboard, for two reasons. The editor needs SOURCE
 * OFFSETS — where an element's start tag, its `style` value and its text sit in the `.dc.html` file —
 * so that a change made on the canvas rewrites those bytes and nothing else, and the DOM keeps no
 * offsets. And the DOM is lossy for this format: it lowercases `onClick`, foster-parents an `<sc-for>`
 * written inside a `<table>` out of it, and drops what it does not expect inside `<select>`. This parser
 * follows the HTML rules that matter for a hand- or model-written file (void elements, raw-text
 * elements, the common implied end tags, SVG's case and self-closing tags, entities) and is otherwise
 * literal: what is written nested is nested.
 *
 * It never fails. Whatever it cannot make sense of is text, as it is to a browser.
 */

export interface Attr {
  /** As written in the source, case kept. */
  readonly name: string;
  /** The name as the browser would know it: lowercased in HTML, lowercased then case-fixed in SVG. */
  readonly key: string;
  /** The value with entities decoded — what `getAttribute` answers — or null for a bare attribute. */
  readonly value: string | null;
  /** The value exactly as written, between its quotes; null for a bare attribute. */
  readonly raw: string | null;
  readonly quote: '"' | "'" | "";
  /** The whole attribute, `name="value"`, as `[start, end)`. */
  readonly start: number;
  readonly end: number;
  /** The value's bytes, inside the quotes; both -1 for a bare attribute. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

export interface ElementNode {
  readonly type: "element";
  /** Lowercased in HTML; SVG's camel-cased names (`linearGradient`) kept as SVG spells them. */
  readonly tag: string;
  readonly attrs: Attr[];
  readonly children: Node[];
  /** In SVG content (the `<svg>` itself included), where case and self-closing tags matter. */
  readonly svg: boolean;
  /** The start tag, `<` to `>` inclusive, as `[start, startTagEnd)`. */
  readonly start: number;
  readonly startTagEnd: number;
  /** Where ` name="value"` would be added to the start tag: after its last attribute. */
  readonly attrInsert: number;
  /** The end tag's `<`, or null when the element was closed implicitly (or is void). */
  closeStart: number | null;
  /** Past the end tag's `>`, or where the element was implicitly closed. */
  end: number;
  /** Document order among the template's elements, given by `parse`; -1 outside the template. */
  n: number;
}

export interface TextNode {
  readonly type: "text";
  /** Exactly as written. */
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  /** False for raw-text content (`<script>`, `<style>`, CDATA), where `&amp;` means itself. */
  readonly decode: boolean;
}

export type Node = ElementNode | TextNode;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Content up to the matching end tag is text, entities and all. */
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
/** Content up to the matching end tag is text, with entities decoded. */
const RCDATA = new Set(["textarea", "title"]);

/**
 * SVG's mixed-case element names, by their lowercase form: an HTML parser lowercases a tag and then
 * puts these back, so `<lineargradient>` and `<linearGradient>` both mean React's `linearGradient`.
 */
const SVG_TAGS: Record<string, string> = Object.fromEntries(
  [
    "altGlyph", "altGlyphDef", "altGlyphItem", "animateColor", "animateMotion", "animateTransform", "clipPath",
    "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
    "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
    "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
    "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "foreignObject", "glyphRef", "linearGradient",
    "radialGradient", "textPath",
  ].map((name) => [name.toLowerCase(), name]),
);

/** The same for SVG's mixed-case attributes (`viewbox` → `viewBox`). */
const SVG_ATTRS: Record<string, string> = Object.fromEntries(
  [
    "attributeName", "attributeType", "baseFrequency", "baseProfile", "calcMode", "clipPathUnits", "diffuseConstant",
    "edgeMode", "filterUnits", "glyphRef", "gradientTransform", "gradientUnits", "kernelMatrix", "kernelUnitLength",
    "keyPoints", "keySplines", "keyTimes", "lengthAdjust", "limitingConeAngle", "markerHeight", "markerUnits",
    "markerWidth", "maskContentUnits", "maskUnits", "numOctaves", "pathLength", "patternContentUnits",
    "patternTransform", "patternUnits", "pointsAtX", "pointsAtY", "pointsAtZ", "preserveAlpha", "preserveAspectRatio",
    "primitiveUnits", "refX", "refY", "repeatCount", "repeatDur", "requiredExtensions", "requiredFeatures",
    "specularConstant", "specularExponent", "spreadMethod", "startOffset", "stdDeviation", "stitchTiles",
    "surfaceScale", "systemLanguage", "tableValues", "targetX", "targetY", "textLength", "viewBox", "viewTarget",
    "xChannelSelector", "yChannelSelector", "zoomAndPan",
  ].map((name) => [name.toLowerCase(), name]),
);

/** Start tags that close an open `<p>` — the block-level ones a file is likely to hold. */
const P_CLOSERS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);

const isSpace = (c: string | undefined): boolean => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c);

/** Parses a whole document (or a fragment) into a root element whose tag is `#root`. */
export function parseHtml(src: string): ElementNode {
  const root = element("#root", [], false, 0, 0, 0);
  root.end = src.length;
  const stack: ElementNode[] = [root];
  const top = (): ElementNode => stack[stack.length - 1]!;
  let textStart = 0;
  let i = 0;

  const flushText = (end: number): void => {
    if (end > textStart) top().children.push({ type: "text", raw: src.slice(textStart, end), start: textStart, end, decode: true });
  };
  /** Pops everything above `index`, which were closed implicitly at `at`; then `index` itself. */
  const popTo = (index: number, at: number): void => {
    while (stack.length - 1 > index) {
      const closed = stack.pop()!;
      closed.end = at;
    }
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    const next = src[lt + 1];

    if (src.startsWith("<!--", lt)) {
      flushText(lt);
      const close = src.indexOf("-->", lt + 4);
      i = textStart = close < 0 ? src.length : close + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      flushText(lt);
      const close = src.indexOf("]]>", lt + 9);
      const end = close < 0 ? src.length : close;
      top().children.push({ type: "text", raw: src.slice(lt + 9, end), start: lt + 9, end, decode: false });
      i = textStart = close < 0 ? src.length : close + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      // A doctype or a processing instruction: neither is content.
      flushText(lt);
      const close = src.indexOf(">", lt);
      i = textStart = close < 0 ? src.length : close + 1;
      continue;
    }
    if (next === "/" && isLetter(src[lt + 2])) {
      flushText(lt);
      let j = lt + 2;
      while (j < src.length && !isSpace(src[j]) && src[j] !== ">" && src[j] !== "/") j++;
      const name = src.slice(lt + 2, j).toLowerCase();
      const close = src.indexOf(">", j);
      const after = close < 0 ? src.length : close + 1;
      for (let k = stack.length - 1; k > 0; k--) {
        const open = stack[k]!;
        if (open.tag.toLowerCase() !== name) continue;
        popTo(k, lt);
        stack.pop();
        open.closeStart = lt;
        open.end = after;
        break;
      }
      // An end tag with nothing open to close is dropped, as a browser drops it.
      i = textStart = after;
      continue;
    }
    if (!isLetter(next)) {
      // A lone `<` is text.
      i = lt + 1;
      continue;
    }

    flushText(lt);
    const parent = top();
    const inSvg = parent.svg && parent.tag !== "foreignObject";
    const tag = readStartTag(src, lt, inSvg);
    const lower = tag.name.toLowerCase();
    const svg = inSvg || lower === "svg";
    const name = svg ? (SVG_TAGS[lower] ?? lower) : lower;
    if (!svg) closeImplied(stack, name, lt, popTo);
    const el = element(name, tag.attrs, svg, lt, tag.end, tag.attrInsert);
    top().children.push(el);
    i = textStart = tag.end;

    if (VOID.has(name) && !svg) {
      el.end = tag.end;
      continue;
    }
    if (tag.selfClosing && svg) {
      el.end = tag.end;
      continue;
    }
    if (RAW_TEXT.has(name) || RCDATA.has(name)) {
      const pattern = new RegExp(`</${name}[\\s/>]`, "ig");
      pattern.lastIndex = tag.end;
      const match = pattern.exec(src);
      const contentEnd = match ? match.index : src.length;
      if (contentEnd > tag.end) {
        el.children.push({ type: "text", raw: src.slice(tag.end, contentEnd), start: tag.end, end: contentEnd, decode: RCDATA.has(name) });
      }
      const close = match ? src.indexOf(">", contentEnd) : -1;
      el.closeStart = match ? contentEnd : null;
      el.end = close < 0 ? src.length : close + 1;
      i = textStart = el.end;
      continue;
    }
    stack.push(el);
  }
  flushText(src.length);
  popTo(0, src.length);
  return root;
}

function element(tag: string, attrs: Attr[], svg: boolean, start: number, startTagEnd: number, attrInsert: number): ElementNode {
  return { type: "element", tag, attrs, children: [], svg, start, startTagEnd, attrInsert, closeStart: null, end: startTagEnd, n: -1 };
}

/** The end tags HTML implies when a start tag arrives, for the elements a design is made of. */
function closeImplied(stack: ElementNode[], tag: string, at: number, popTo: (index: number, at: number) => void): void {
  const nearest = (wanted: ReadonlySet<string>, boundary: ReadonlySet<string>): number => {
    for (let k = stack.length - 1; k > 0; k--) {
      const open = stack[k]!.tag;
      if (wanted.has(open)) return k;
      if (boundary.has(open)) return -1;
    }
    return -1;
  };
  const close = (index: number): void => {
    if (index <= 0) return;
    popTo(index, at);
    stack.pop()!.end = at;
  };
  if (P_CLOSERS.has(tag) && stack[stack.length - 1]!.tag === "p") close(stack.length - 1);
  if (tag === "li") close(nearest(new Set(["li"]), new Set(["ul", "ol", "menu"])));
  if (tag === "dt" || tag === "dd") close(nearest(new Set(["dt", "dd"]), new Set(["dl"])));
  if (tag === "option" || tag === "optgroup") {
    if (stack[stack.length - 1]!.tag === "option") close(stack.length - 1);
    if (tag === "optgroup" && stack[stack.length - 1]!.tag === "optgroup") close(stack.length - 1);
  }
  if (tag === "tr") close(nearest(new Set(["tr"]), new Set(["table", "thead", "tbody", "tfoot"])));
  if (tag === "td" || tag === "th") close(nearest(new Set(["td", "th"]), new Set(["tr", "table"])));
  if (tag === "thead" || tag === "tbody" || tag === "tfoot") close(nearest(new Set(["thead", "tbody", "tfoot"]), new Set(["table"])));
}

interface StartTag {
  readonly name: string;
  readonly attrs: Attr[];
  readonly end: number;
  readonly attrInsert: number;
  readonly selfClosing: boolean;
}

function readStartTag(src: string, lt: number, inSvg: boolean): StartTag {
  let j = lt + 1;
  while (j < src.length && !isSpace(src[j]) && src[j] !== "/" && src[j] !== ">") j++;
  const name = src.slice(lt + 1, j);
  const svg = inSvg || name.toLowerCase() === "svg";
  const attrs: Attr[] = [];
  const seen = new Set<string>();
  let attrInsert = j;
  for (;;) {
    while (isSpace(src[j])) j++;
    if (j >= src.length) return { name, attrs, end: src.length, attrInsert, selfClosing: false };
    if (src[j] === ">") return { name, attrs, end: j + 1, attrInsert, selfClosing: false };
    if (src.startsWith("/>", j)) return { name, attrs, end: j + 2, attrInsert, selfClosing: true };
    if (src[j] === "/") {
      j++;
      continue;
    }
    const start = j;
    // The first character may be `=`, which the HTML tokenizer takes as part of the name.
    j++;
    while (j < src.length && !isSpace(src[j]) && src[j] !== "/" && src[j] !== ">" && src[j] !== "=") j++;
    const attrName = src.slice(start, j);
    let k = j;
    while (isSpace(src[k])) k++;
    let value: string | null = null;
    let raw: string | null = null;
    let quote: Attr["quote"] = "";
    let valueStart = -1;
    let valueEnd = -1;
    if (src[k] === "=") {
      k++;
      while (isSpace(src[k])) k++;
      const q = src[k];
      if (q === '"' || q === "'") {
        quote = q;
        valueStart = k + 1;
        const close = src.indexOf(q, valueStart);
        valueEnd = close < 0 ? src.length : close;
        j = close < 0 ? src.length : close + 1;
      } else {
        valueStart = k;
        while (k < src.length && !isSpace(src[k]) && src[k] !== ">") k++;
        valueEnd = j = k;
      }
      raw = src.slice(valueStart, valueEnd);
      value = decodeEntities(raw);
    }
    const lower = attrName.toLowerCase();
    const key = svg ? (SVG_ATTRS[lower] ?? lower) : lower;
    // A repeated attribute is ignored: the first one wins, as in the DOM.
    if (!seen.has(key)) {
      seen.add(key);
      attrs.push({ name: attrName, key, value, raw, quote, start, end: j, valueStart, valueEnd });
    }
    attrInsert = j;
  }
}

/** The text of a node's subtree, entities decoded where the content is not raw. */
export function textContent(node: Node): string {
  if (node.type === "text") return node.decode ? decodeEntities(node.raw) : node.raw;
  return node.children.map(textContent).join("");
}

export function attr(el: ElementNode, key: string): Attr | undefined {
  return el.attrs.find((a) => a.key === key);
}

/**
 * Named character references a design is likely to hold. The full HTML table is two thousand names; a
 * browser fills in the rest through `setEntityFallback`, and an unknown name stays as written, which is
 * what a browser does with one it does not know either.
 */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  hairsp: " ", zwj: "‍", zwnj: "‌", shy: "­", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", minus: "−", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  bull: "•", middot: "·", centerdot: "·", times: "×", divide: "÷", deg: "°", plusmn: "±",
  micro: "µ", para: "¶", sect: "§", dagger: "†", Dagger: "‡", prime: "′", Prime: "″",
  permil: "‰", euro: "€", pound: "£", yen: "¥", cent: "¢", curren: "¤", larr: "←",
  uarr: "↑", rarr: "→", darr: "↓", harr: "↔", lArr: "⇐", rArr: "⇒", hArr: "⇔",
  le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", sum: "∑", radic: "√",
  frac12: "½", frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", ordf: "ª",
  ordm: "º", iexcl: "¡", iquest: "¿", star: "☆", starf: "★", check: "✓", cross: "✗",
  hearts: "♥", spades: "♠", clubs: "♣", diams: "♦", loz: "◊", larrhk: "↩", crarr: "↵",
  quest: "?", excl: "!", num: "#", dollar: "$", percnt: "%", lpar: "(", rpar: ")", ast: "*", plus: "+", comma: ",",
  period: ".", sol: "/", colon: ":", semi: ";", equals: "=", commat: "@", lsqb: "[", rsqb: "]", bsol: "\\",
  lowbar: "_", grave: "`", lcub: "{", rcub: "}", verbar: "|", vert: "|", tilde: "˜", circ: "ˆ",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ",
  Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í",
  Icirc: "Î", Iuml: "Ï", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ",
  Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý",
  szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å",
  aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì",
  iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô",
  otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü",
  yacute: "ý", yuml: "ÿ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π",
  mu: "μ", sigma: "σ", omega: "ω", Delta: "Δ", Omega: "Ω",
};
/** The names HTML still decodes without their semicolon. */
const LEGACY = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"]);

let entityFallback: ((name: string) => string | undefined) | null = null;

/** Lets a browser decode the named references this module's table lacks. */
export function setEntityFallback(fallback: ((name: string) => string | undefined) | null): void {
  entityFallback = fallback;
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*)(;?)/g, (whole, body: string, semi: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // NUL, surrogates and anything past Unicode are the replacement character in HTML.
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    if (!semi && !LEGACY.has(body)) return whole;
    const known = ENTITIES[body] ?? (semi ? entityFallback?.(body) : undefined);
    return known === undefined ? whole : known;
  });
}
