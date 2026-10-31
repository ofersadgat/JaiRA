/**
 * `.dc.html` source → a Design Component: its template, its logic, its declared props, and a table of
 * its elements with their places in the source.
 *
 * The shape of the file is format.md's "Authoring an artboard": a page whose body holds one `<x-dc>`
 * (the template, `<helmet>` included) and one `<script type="text/x-dc" data-dc-script data-props='…'>`
 * (the logic class, and the props it declares). Everything else in the file — `<head>`, the
 * `support.js` line — is the page around the component.
 */

import { attr, parseHtml, textContent, type ElementNode, type Node } from "./html.js";
import { hasHole } from "./holes.js";

/** One `data-props` entry: the Tweaks control a prop gets, and the value that seeds it. */
export interface DCPropSpec {
  readonly editor?: "text" | "color" | "int" | "float" | "range" | "boolean" | "enum" | null;
  readonly default?: unknown;
  readonly tsType?: string;
  readonly options?: readonly unknown[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly section?: string;
  readonly [key: string]: unknown;
}

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** One element of the template, in document order. Every offset is into the source `parse` was given. */
export interface DCElement {
  /** Its index in `elements`; the `data-dc-id` its rendered DOM elements carry. */
  readonly n: number;
  readonly tag: string;
  /** The enclosing template element's `n`, or null at the top of `<x-dc>`. */
  readonly parent: number | null;
  /** The start tag, `<` through `>`. */
  readonly startTag: SourceRange;
  /** The whole element, start tag through end tag (or where it was implicitly closed). */
  readonly outer: SourceRange;
  /** The `style` attribute's value, inside its quotes; null when it has none. */
  readonly style: SourceRange | null;
  /** Where a ` style="…"` is inserted when it has none: after its last attribute. */
  readonly styleInsert: number;
  /**
   * Its text when that is one literal text node — no holes, no child elements — trimmed of the
   * whitespace around it; an empty range between the tags for an element with no content. Null
   * otherwise, and for void and raw-text elements.
   */
  readonly text: SourceRange | null;
}

export interface DCDocument {
  /** The `<title>`'s text, or null. */
  readonly title: string | null;
  /** `<html lang>`, or null. */
  readonly lang: string | null;
  /** The `<helmet>`'s inner source, verbatim; "" when there is none. */
  readonly helmet: string;
  /** The `<x-dc>`'s inner source, verbatim (the helmet included). */
  readonly template: string;
  /** The logic script's body, verbatim; null when the file has none (yet). */
  readonly script: string | null;
  /** The declared props, `$preview` and any other `$`-key left out. */
  readonly props: Readonly<Record<string, DCPropSpec>>;
  /** `$preview`: the size the artboard prefers. */
  readonly preview: { readonly width: number; readonly height: number } | undefined;
  readonly elements: readonly DCElement[];
  /** What makes the file undrawable (no `<x-dc>`, `data-props` that is not JSON), or null. */
  readonly error: string | null;
  /** The template's nodes, the `<x-dc>`'s children: what the renderer walks. */
  readonly nodes: readonly Node[];
}

const NO_TEXT = new Set(["script", "style", "textarea", "xmp", "iframe", "noembed", "noframes"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export function parse(source: string): DCDocument {
  const root = parseHtml(source);
  const xdc = find(root, (el) => el.tag === "x-dc");
  const scriptEl = find(root, (el) => el.tag === "script" && (attr(el, "data-dc-script") !== undefined || attr(el, "type")?.value?.trim().toLowerCase() === "text/x-dc"));
  const titleEl = find(root, (el) => el.tag === "title" && !el.svg);
  const htmlEl = find(root, (el) => el.tag === "html");

  const elements: DCElement[] = [];
  if (xdc) number(xdc.children, null, elements);
  const helmetEl = xdc?.children.find((node): node is ElementNode => node.type === "element" && node.tag === "helmet");

  let error: string | null = xdc ? null : "The file has no <x-dc> template.";
  let declared: Record<string, unknown> = {};
  const propsAttr = scriptEl ? attr(scriptEl, "data-props") : undefined;
  if (propsAttr?.value) {
    try {
      const value = JSON.parse(propsAttr.value) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) declared = value as Record<string, unknown>;
      else error ??= "data-props is not a JSON object.";
    } catch (cause) {
      error ??= `data-props is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  const props: Record<string, DCPropSpec> = {};
  for (const [key, spec] of Object.entries(declared)) {
    if (key.startsWith("$")) continue;
    props[key] = spec !== null && typeof spec === "object" ? (spec as DCPropSpec) : {};
  }

  return {
    title: titleEl ? textContent(titleEl).trim() : null,
    lang: htmlEl ? (attr(htmlEl, "lang")?.value ?? null) : null,
    helmet: helmetEl ? inner(source, helmetEl) : "",
    template: xdc ? inner(source, xdc) : "",
    script: scriptEl ? textContent(scriptEl) : null,
    props,
    preview: previewOf(declared["$preview"]),
    elements,
    error,
    nodes: xdc ? xdc.children : [],
  };
}

function previewOf(value: unknown): DCDocument["preview"] {
  if (value === null || typeof value !== "object") return undefined;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" ? { width, height } : undefined;
}

function inner(source: string, el: ElementNode): string {
  return source.slice(el.startTagEnd, el.closeStart ?? el.end);
}

function find(node: ElementNode, test: (el: ElementNode) => boolean): ElementNode | undefined {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (test(child)) return child;
    const found = find(child, test);
    if (found) return found;
  }
  return undefined;
}

/** Gives every template element its `n` and its row in the table, in document order. */
function number(nodes: readonly Node[], parent: number | null, out: DCElement[]): void {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    node.n = out.length;
    const style = node.attrs.find((a) => a.key === "style");
    out.push({
      n: node.n,
      tag: node.tag,
      parent,
      startTag: { start: node.start, end: node.startTagEnd },
      outer: { start: node.start, end: node.end },
      style: style && style.valueStart >= 0 ? { start: style.valueStart, end: style.valueEnd } : null,
      styleInsert: node.attrInsert,
      text: textRange(node),
    });
    number(node.children, node.n, out);
  }
}

function textRange(el: ElementNode): SourceRange | null {
  if (NO_TEXT.has(el.tag) || (VOID.has(el.tag) && !el.svg) || el.closeStart === null) return null;
  if (el.children.length === 0) return { start: el.startTagEnd, end: el.startTagEnd };
  const only = el.children[0]!;
  if (el.children.length !== 1 || only.type !== "text" || hasHole(only.raw)) return null;
  const lead = only.raw.length - only.raw.trimStart().length;
  const trimmed = only.raw.trim();
  if (trimmed === "") return { start: only.start, end: only.end };
  return { start: only.start + lead, end: only.start + lead + trimmed.length };
}
