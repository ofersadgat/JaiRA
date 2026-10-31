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
