/**
 * `{{ holes }}`: where a template reads the values `renderVals()` returned.
 *
 * A hole is a dotted lookup and nothing else (format.md: "never an expression — `{{ a + b }}`,
 * `{{ !x }}`, `{{ fn() }}` fail silently"). So this is not an evaluator: a hole is a path, one of the
 * four literal forms, or it is undefined, which renders as nothing. Accepting more than the format
 * allows would draw a file here that Claude Design draws empty, and the point is to draw the same.
 */

import { decodeEntities } from "./html.js";

export type Segment = string | { readonly hole: string };

/** A scope: the loop variables of the `<sc-for>`s around a node, over `renderVals()`'s object. */
export interface Scope {
  readonly vars: Readonly<Record<string, unknown>>;
  readonly parent: Scope | null;
}

const HOLE = /\{\{([\s\S]*?)\}\}/g;
const PATH = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Splits text into literal runs and holes. Holes are found in the text AS WRITTEN, before entities
 * are decoded, so `&#123;{` is a literal `{{` — which is how `editText` writes one.
 */
export function segments(raw: string, decode: boolean): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of raw.matchAll(HOLE)) {
    if (match.index > last) out.push(literal(raw.slice(last, match.index), decode));
    out.push({ hole: decode ? decodeEntities(match[1]!) : match[1]! });
    last = match.index + match[0].length;
  }
  if (last < raw.length) out.push(literal(raw.slice(last), decode));
  return out;
}

const literal = (text: string, decode: boolean): string => (decode ? decodeEntities(text) : text);

export function hasHole(raw: string): boolean {
  return /\{\{[\s\S]*?\}\}/.test(raw);
}

/** The single hole an attribute value is made of, `"{{ path }}"`, or null when it is anything else. */
export function wholeHole(raw: string): string | null {
  const parts = segments(raw.trim(), true);
  const only = parts[0];
  return parts.length === 1 && only !== undefined && typeof only !== "string" ? only.hole : null;
}

export function scope(vars: Readonly<Record<string, unknown>>, parent: Scope | null = null): Scope {
  return { vars, parent };
}

/** What a hole stands for: a literal, a path's value, or undefined for anything the format does not allow. */
export function evaluate(expr: string, at: Scope): unknown {
  const text = expr.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (text === "undefined") return undefined;
  if (NUMBER.test(text)) return Number(text);
  const quoted = /^'([^'\\]*)'$|^"([^"\\]*)"$/.exec(text);
  if (quoted) return quoted[1] ?? quoted[2];
  if (!PATH.test(text)) return undefined;
  const [first, ...rest] = text.split(".");
  let value = lookup(first!, at);
  for (const key of rest) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function lookup(name: string, at: Scope): unknown {
  for (let s: Scope | null = at; s; s = s.parent) {
    if (Object.prototype.hasOwnProperty.call(s.vars, name)) return s.vars[name];
  }
  return undefined;
}

/** Text with its holes filled in as strings: nothing for null and undefined, `String()` for the rest. */
export function interpolate(parts: readonly Segment[], at: Scope): string {
  return parts.map((part) => (typeof part === "string" ? part : stringify(evaluate(part.hole, at)))).join("");
}

export function stringify(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
