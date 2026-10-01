/**
 * The CSS cascade of `styles.css`'s custom properties, replayed without a browser (decision 0015).
 *
 * The declarations come from `cssTokens.generated.ts` (see `scripts/tokens.mjs`). Given where a
 * component stands — a palette, a scheme, and the subtrees around it (`sidebar`, …) — this picks the
 * declarations that would apply, in specificity-then-source order as a browser would, and evaluates
 * what React Native cannot: `var()` references, `color-mix(in srgb, …)` and `calc()`.
 *
 * Native reads this, and so does a web page under `Replayed` (`tokens.tsx`), which carries no stylesheet
 * for a browser to resolve `var(--name)` against.
 */
import { BLOCKS } from "./cssTokens.generated";

export interface TokenBlock {
  /** Named palettes this block applies to; `"*"` is every named one (not `classic`). Absent: all. */
  readonly palette?: readonly string[] | "*";
  readonly scheme?: "dark";
  /** The class of the subtree it is scoped to (`.sidebar`), if any. */
  readonly scope?: string;
  readonly specificity: number;
  readonly order: number;
  readonly vars: Readonly<Record<string, string>>;
}

export interface Where {
  readonly palette: string;
  readonly scheme: "light" | "dark";
  /** Enclosing subtrees, outermost first. */
  readonly scopes?: readonly string[];
}

/** Every custom property in force at `where`, unevaluated (as the browser holds them before use). */
export function declarationsAt(where: Where, blocks: readonly TokenBlock[] = BLOCKS): Record<string, string> {
  const scopes = where.scopes ?? [];
  const applies = (b: TokenBlock): boolean => {
    if (b.scheme === "dark" && where.scheme !== "dark") return false;
    if (b.palette === "*" && where.palette === "classic") return false;
    if (Array.isArray(b.palette) && !b.palette.includes(where.palette)) return false;
    if (b.scope !== undefined && !scopes.includes(b.scope)) return false;
    return true;
  };
  // Inherited first: a scope's variables override the root's for everything inside it, whatever the
  // root rule's specificity, because a custom property inherits from the nearest element that sets it.
  const depth = (b: TokenBlock): number => (b.scope === undefined ? -1 : scopes.indexOf(b.scope));
  const ordered = blocks
    .filter(applies)
    .sort((a, b) => depth(a) - depth(b) || a.specificity - b.specificity || a.order - b.order);
  const out: Record<string, string> = {};
  for (const block of ordered) Object.assign(out, block.vars);
  return out;
}

/** A resolved value: a number for a length in px or a bare number, a string for anything else. */
export type TokenValue = string | number;

/**
 * Every custom property at `where`, evaluated as far as native can use it.
 *
 * Level by level, as the browser does it: a custom property INHERITS ITS COMPUTED VALUE, so a
 * reference is resolved on the element that declares it, not where it is used. `--focus-ring:
 * color-mix(… var(--accent) …)` is computed on the root, and the sidebar redefining `--accent` does not
 * change the ring the sidebar inherits. So the root's declarations are evaluated first, and each scope's
 * over what it inherits from the level above.
 */
export function resolveAt(where: Where, blocks: readonly TokenBlock[] = BLOCKS, overrides: Readonly<Record<string, string>> = {}): Record<string, TokenValue> {
  const scopes = where.scopes ?? [];
  let inherited: Record<string, TokenValue> = {};
  for (let level = 0; level <= scopes.length; level++) {
    const here = { ...where, scopes: scopes.slice(0, level) };
    const all = declarationsAt(here, blocks);
    // Only what THIS level declares; everything else arrives computed from the level above.
    // The root's inline style (`applyAppearance`'s fonts and sizes) beats every `:root` rule.
    const declared = level === 0 ? { ...all, ...overrides } : declaredOnlyAt(here, scopes[level - 1]!, blocks);
    inherited = computeLevel(declared, inherited);
  }
  return inherited;
}

/** The declarations the innermost scope `scope` adds at `where`. */
function declaredOnlyAt(where: Where, scope: string, blocks: readonly TokenBlock[]): Record<string, string> {
  return declarationsAt(where, blocks.filter((b) => b.scope === scope));
}

function computeLevel(declared: Record<string, string>, inherited: Record<string, TokenValue>): Record<string, TokenValue> {
  const done: Record<string, TokenValue> = {};
  const busy = new Set<string>();
  const get = (name: string): TokenValue | undefined => {
    if (name in done) return done[name];
    const value = declared[name];
    if (value === undefined) return inherited[name];
    if (busy.has(name)) return undefined;
    busy.add(name);
    const out = evaluate(value, get);
    busy.delete(name);
    done[name] = out;
    return out;
  };
  for (const name of Object.keys(declared)) get(name);
  return { ...inherited, ...done };
}

/** Substitute `var()`s, then evaluate a whole-value `color-mix()` or `calc()`. */
export function evaluate(value: string, get: (name: string) => TokenValue | undefined): TokenValue {
  const substituted = substitute(value.trim(), get);
  const mixed = /^color-mix\(\s*in srgb\s*,(.*)\)$/i.exec(substituted);
  if (mixed) return colorMix(mixed[1] ?? "") ?? substituted;
  const calc = /^calc\((.*)\)$/i.exec(substituted);
  if (calc) {
    const n = arithmetic(calc[1] ?? "");
    return n ?? substituted;
  }
  const px = /^(-?[\d.]+)(px)?$/.exec(substituted);
  if (px) return Number(px[1]);
  return substituted;
}

function substitute(value: string, get: (name: string) => TokenValue | undefined): string {
  let out = value;
  // Innermost first, so `var(--a, var(--b))` resolves its fallback before its reference.
  for (let guard = 0; guard < 50 && out.includes("var("); guard++) {
    out = out.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/, (_whole, name: string, fallback?: string) => {
      const v = get(name);
      if (v !== undefined) return typeof v === "number" ? `${v}px` : v;
      return fallback?.trim() ?? "";
    });
  }
  return out;
}

// --- colour -----------------------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

export function parseColor(text: string): Rgba | undefined {
  const t = text.trim().toLowerCase();
  if (t in NAMED) return NAMED[t];
  const hex = /^#([0-9a-f]{3,8})$/.exec(t)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const n = (i: number): number => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  // What Chromium reports for a `color-mix()` result: `color(srgb 0.14 0.38 0.78 / 0.1)`, channels 0–1.
  const srgb = /^color\(srgb\s+([^)]*)\)$/.exec(t)?.[1];
  if (srgb !== undefined) {
    const [rgb = "", alpha] = srgb.split("/");
    const [r = 0, g = 0, b = 0] = rgb.trim().split(/\s+/).map(Number);
    return { r: r * 255, g: g * 255, b: b * 255, a: alpha === undefined ? 1 : Number(alpha.trim()) };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(t)?.[1];
  if (fn !== undefined) {
    // `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)` alike: three channels, then alpha.
    const parts = fn.split(/[\s,/]+/).filter(Boolean);
    const channel = (p = "0"): number => (p.endsWith("%") ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p));
    const alpha = (p?: string): number => (p === undefined ? 1 : p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p));
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha(parts[3]) };
  }
  return undefined;
}

export function formatColor({ r, g, b, a }: Rgba): string {
  const c = (v: number): number => Math.round(Math.min(255, Math.max(0, v)));
  return a >= 1 ? `rgb(${c(r)}, ${c(g)}, ${c(b)})` : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(a * 1000) / 1000})`;
}

/**
 * `color-mix(in srgb, A p%, B q%)`, as CSS Color 5 defines it: percentages normalised to sum to 100
 * (a missing one is the remainder), and the mix interpolated in PREMULTIPLIED alpha — which is why
 * mixing a colour with `transparent` keeps its hue and only thins it.
 */
function colorMix(args: string): string | undefined {
  const parts = splitTop(args);
  if (parts.length !== 2) return undefined;
  const parse = (part: string): { color: Rgba; pct?: number } | undefined => {
    const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(part.trim());
    const color = m ? parseColor(m[1] ?? "") : undefined;
    return color === undefined ? undefined : { color, ...(m?.[2] !== undefined ? { pct: Number(m[2]) / 100 } : {}) };
  };
  const a = parse(parts[0] ?? "");
  const b = parse(parts[1] ?? "");
  if (a === undefined || b === undefined) return undefined;
  let p1 = a.pct ?? (b.pct !== undefined ? 1 - b.pct : 0.5);
  let p2 = b.pct ?? 1 - p1;
  const sum = p1 + p2;
  const scale = sum > 1 ? 1 : sum; // a sum under 100% thins the result's alpha
  p1 /= sum;
  p2 /= sum;
  const alpha = a.color.a * p1 + b.color.a * p2;
  const channel = (k: "r" | "g" | "b"): number => (alpha === 0 ? 0 : (a.color[k] * a.color.a * p1 + b.color[k] * b.color.a * p2) / alpha);
  return formatColor({ r: channel("r"), g: channel("g"), b: channel("b"), a: alpha * scale });
}

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out;
}

// --- calc ---------------------------------------------------------------------------------------------

/** `calc()` over px lengths and bare numbers; anything else (`vw`, `env()`, `%`) is left to the caller. */
function arithmetic(expression: string): number | undefined {
  const tokens = expression.match(/-?[\d.]+(?:px)?|[()*/+-]/g);
  if (tokens === null || tokens.join("").replace(/px/g, "") !== expression.replace(/\s+|px/g, "")) return undefined;
  let i = 0;
  const num = (): number | undefined => {
    const t = tokens[i++];
    if (t === "(") {
      const v = sum();
      i++;
      return v;
    }
    return t === undefined ? undefined : Number(t.replace("px", ""));
  };
  const product = (): number | undefined => {
    let v = num();
    while (v !== undefined && (tokens[i] === "*" || tokens[i] === "/")) {
      const op = tokens[i++];
      const r = num();
      if (r === undefined) return undefined;
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number | undefined => {
    let v = product();
    while (v !== undefined && (tokens[i] === "+" || tokens[i] === "-")) {
      const op = tokens[i++];
      const r = product();
      if (r === undefined) return undefined;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return v !== undefined && i === tokens.length && Number.isFinite(v) ? v : undefined;
}
