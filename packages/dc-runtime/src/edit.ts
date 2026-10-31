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
