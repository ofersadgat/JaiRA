/**
 * The editor's two writes into a `.dc.html` file: an element's inline `style`, and its literal text.
 *
 * Both are string splices at the offsets `parse` reports, so a change made on the canvas touches the
 * bytes it changes and nothing else — the file stays the model's file, formatting and all, and its
 * next read of it sees a small diff. Each re-parses the source it is given rather than trusting a
 * table from an earlier parse, because an editor applies edits one after another.
 */

import { parse, type DCElement } from "./parse.js";

/**
 * Sets element `n`'s inline style to `styleText`, verbatim (holes such as `{{accent}}` included). An
 * empty or blank `styleText` removes the attribute; an element with no `style` gains one after its last
 * attribute, double-quoted.
 */
export function editStyle(source: string, n: number, styleText: string): string {
  const el = elementAt(source, n);
  const value = styleText.trim();
  const range = el.style;
  if (range) {
    const quote = source[range.start - 1];
    if (value === "") return removeAttribute(source, el, range);
    if (quote === '"' || quote === "'") return splice(source, range.start, range.end, escapeAttribute(value, quote));
    // Unquoted: rewritten quoted, since the new value may hold a space.
    return splice(source, range.start, range.end, `"${escapeAttribute(value, '"')}"`);
  }
  if (value === "") return source;
  return splice(source, el.styleInsert, el.styleInsert, ` style="${escapeAttribute(value, '"')}"`);
}

/**
 * Sets element `n`'s text to `text`, escaped so it reads back as exactly that: `&`, `<` and a `{{` that
 * would otherwise become a hole. Only an element whose content is one literal text node (or nothing)
 * can be retyped; anything else throws.
 */
export function editText(source: string, n: number, text: string): string {
  const el = elementAt(source, n);
  if (!el.text) throw new Error(`Element ${String(n)} <${el.tag}> does not hold one literal text, so its text cannot be set.`);
  return splice(source, el.text.start, el.text.end, escapeText(text));
}

/**
 * Removes element `n` from the file — its start tag through its end tag. When it stood alone on its
 * line, the line goes with it, so the file keeps no blank line where the element was.
 */
export function removeElement(source: string, n: number): string {
  const el = elementAt(source, n);
  let start = el.outer.start;
  let end = el.outer.end;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", end);
  if (/^[ \t]*$/.test(source.slice(lineStart, start)) && /^[ \t]*$/.test(source.slice(end, lineEnd < 0 ? source.length : lineEnd))) {
    start = lineStart;
    end = lineEnd < 0 ? source.length : lineEnd + 1;
  }
  return splice(source, start, end, "");
}

/**
 * Inserts `html` as a child of element `parent` (or of the template itself, `null`), before its child
 * at `index` (among its element children), or after the last. The markup is put on a line of its own,
 * indented as the child it goes before (or one step in from its parent), when the file is laid out in
 * lines; inline otherwise.
 */
export function insertElement(source: string, parent: number | null, html: string, index?: number): string {
  const doc = parse(source);
  const children = doc.elements.filter((e) => e.parent === parent);
  const before = index !== undefined ? children[index] : undefined;
  let at: number;
  if (before) {
    at = before.outer.start;
  } else if (parent === null) {
    at = source.search(/<\/x-dc\s*>/i);
    if (at < 0) throw new Error("The file has no </x-dc> to insert before.");
  } else {
    const el = elementAt(source, parent);
    // Searched back from the element's last character: from `outer.end` itself would find a closing tag
    // that begins right after it.
    at = source.lastIndexOf("</", el.outer.end - 1);
    if (at < el.startTag.end) throw new Error(`Element ${String(parent)} <${el.tag}> has no end tag to insert before.`);
  }
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const lead = source.slice(lineStart, at);
  if (!/^[ \t]*$/.test(lead)) return splice(source, at, at, html);
  // On a line of its own: indented as what it goes before, or a step in from a closing tag.
  const indent = before ? lead : `${lead}  `;
  return splice(source, lineStart, lineStart, `${indent}${html}\n`);
}

/**
 * An inline style's declarations by their CSS names, values verbatim — holes, `!important` and all:
 * what the editor's properties panel reads and writes back with {@link formatStyle}. (`parseStyle` is
 * React's view of the same text, and loses `!important`.)
 */
export function readStyle(text: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const declaration of splitOutside(text, ";")) {
    const colon = indexOutside(declaration, ":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) style[property] = value;
  }
  return style;
}

/** Declarations back to inline style text, in the order given: `a: 1; b: 2`. */
export function formatStyle(style: Record<string, string>): string {
  return Object.entries(style)
    .filter(([, value]) => value.trim() !== "")
    .map(([property, value]) => `${property}: ${value.trim()}`)
    .join("; ");
}

/**
 * Wraps element `n` in a new container (format.md: viewers create stacks and grids with "Wrap in flex" /
 * "Wrap in grid"): `<div style="…">` before it, `</div>` after it, the element itself untouched. A grid
 * is written in exactly the `repeat(N, minmax(0, 1fr))` shape the properties panel reads back.
 */
export function wrapElement(source: string, n: number, as: "stack" | "grid"): string {
  const el = elementAt(source, n);
  const style = as === "stack" ? "display: flex; flex-direction: column; gap: 8px" : "display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px";
  return `${source.slice(0, el.outer.start)}<div style="${style}">${source.slice(el.outer.start, el.outer.end)}</div>${source.slice(el.outer.end)}`;
}

/**
 * Keeps a tweak: sets prop `name`'s `default` in the logic script's `data-props` (the runtime draws a
 * declared default as the prop's value), leaving the rest of the declaration, and of the file, as written.
 * The attribute is single-quoted JSON read the way `getAttribute` reads it (format.md, "`data-props`
 * escaping"), so it is decoded, changed and escaped back in those three escapes. A file with no
 * `data-props`, or one whose JSON does not parse, is returned unchanged.
 */
export function setPropDefault(source: string, name: string, value: unknown): string {
  const tag = /<script\b[^>]*\bdata-dc-script\b[^>]*>/i.exec(source);
  if (!tag) return source;
  const attr = /\bdata-props\s*=\s*'([^']*)'/i.exec(tag[0]);
  if (!attr) return source;
  let props: Record<string, Record<string, unknown>>;
  try {
    props = JSON.parse(attr[1]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Record<string, Record<string, unknown>>;
  } catch {
    return source;
  }
  props[name] = { ...(props[name] ?? {}), default: value };
  const written = JSON.stringify(props).replace(/&/g, "&amp;").replace(/'/g, "&#39;");
  const start = tag.index + attr.index + attr[0].indexOf("'") + 1;
  return splice(source, start, start + attr[1]!.length, written);
}

/** A box, in the frame's CSS pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the page reports when a drag of an element ends (`dc:moved`): enough to write it. */
export interface Moved {
  id: number;
  /** How far it was dragged. */
  dx: number;
  dy: number;
  /** Where it stood before, and its inline style as the source has it. */
  rect: Box;
  style: string;
  /** Its box parent (the nearest element the template names), or `null` for a top element. */
  parent: { id: number; rect: Box; style: string } | null;
  siblings: Array<{ id: number; rect: Box; style: string }>;
}

/**
 * A drag written into the source, as the format describes it: an item dragged OUT of a stack or a grid
 * makes "the editor … freeze the remaining siblings and the parent's size so nothing else on the page
 * moves" (format.md). So, for an element in the flow: its parent keeps its size and becomes the
 * positioning box, each sibling is pinned where it stands, and the element is placed where it was
 * dropped — every one of them by its inline style, which is what the properties panel edits too. An
 * element already placed absolutely only moves. A top element, with nothing to be placed in, is offset.
 */
export function applyMove(source: string, m: Moved): string {
  const px = (v: number): string => `${String(Math.round(v))}px`;
  const own = readStyle(m.style);
  if (m.parent === null) {
    const left = parseFloat(own["left"] ?? "0") || 0;
    const top = parseFloat(own["top"] ?? "0") || 0;
    return editStyle(source, m.id, formatStyle({ ...own, position: own["position"] ?? "relative", left: px(left + m.dx), top: px(top + m.dy) }));
  }
  const base = m.parent.rect;
  const at = { left: px(m.rect.x - base.x + m.dx), top: px(m.rect.y - base.y + m.dy) };
  if (own["position"] === "absolute") return editStyle(source, m.id, formatStyle({ ...own, ...at }));

  let out = source;
  const parent = readStyle(m.parent.style);
  out = editStyle(
    out,
    m.parent.id,
    formatStyle({
      ...parent,
      position: parent["position"] !== undefined && parent["position"] !== "static" ? parent["position"] : "relative",
      width: parent["width"] ?? px(base.width),
      height: parent["height"] ?? px(base.height),
    }),
  );
  for (const s of m.siblings) {
    const style = readStyle(s.style);
    if (style["position"] === "absolute") continue;
    out = editStyle(out, s.id, formatStyle({ ...style, position: "absolute", left: px(s.rect.x - base.x), top: px(s.rect.y - base.y), width: px(s.rect.width), height: px(s.rect.height), margin: "0" }));
  }
  return editStyle(out, m.id, formatStyle({ ...own, position: "absolute", ...at, width: px(m.rect.width), height: px(m.rect.height), margin: "0" }));
}

/** `text` split on `separator` outside parentheses, quotes and holes — `url(a;b)`, `content: "a;b"`, `{{a;b}}`. */
function splitOutside(text: string, separator: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = indexOutside(text, separator); i >= 0; i = indexOutside(text, separator, from)) {
    parts.push(text.slice(from, i));
    from = i + 1;
  }
  parts.push(text.slice(from));
  return parts;
}

function indexOutside(text: string, char: string, from = 0): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || (c === "{" && text[i + 1] === "{")) depth++;
    else if ((c === ")" || (c === "}" && text[i + 1] === "}")) && depth > 0) depth--;
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

function elementAt(source: string, n: number): DCElement {
  const el = parse(source).elements[n];
  if (!el) throw new Error(`The template has no element ${String(n)}.`);
  return el;
}

function removeAttribute(source: string, el: DCElement, value: { start: number; end: number }): string {
  // From the whitespace before `style` to the closing quote.
  const tag = source.slice(el.startTag.start, el.startTag.end);
  const valueEndInTag = value.end - el.startTag.start;
  const nameAt = tag.slice(0, value.start - el.startTag.start).search(/\s+style\s*=\s*["']?$/i);
  if (nameAt < 0) return source;
  const closeQuote = tag[valueEndInTag] === '"' || tag[valueEndInTag] === "'" ? 1 : 0;
  return splice(source, el.startTag.start + nameAt, value.end + closeQuote, "");
}

const splice = (source: string, start: number, end: number, insert: string): string => source.slice(0, start) + insert + source.slice(end);

function escapeAttribute(value: string, quote: '"' | "'"): string {
  const escaped = value.replace(/&(?=[#A-Za-z])/g, "&amp;");
  return quote === '"' ? escaped.replace(/"/g, "&quot;") : escaped.replace(/'/g, "&#39;");
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\{\{/g, "&#123;{");
}
