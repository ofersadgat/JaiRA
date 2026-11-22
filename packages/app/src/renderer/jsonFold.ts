/**
 * A value as the lines of its pretty-printed JSON — walked from the value, not printed and re-read —
 * so that it can be drawn a piece at a time. The JSON view (`ValueView.tsx`'s `JsonSource`) draws these.
 *
 * Measured 2026-11-21: a settled gate's answer of 9.2 MB (a whole conversation, every tool's name, a
 * screenshot in base64), printed whole into its box, took 7.4 s of one layout on every click into the
 * task; printing it at all took 80 ms. Walking the value lets the view draw only what it shows, and
 * three things decide what that is, each of them something a host can turn off (`JsonFolding`):
 *
 *  - `fold`     every object and array can be closed to one line — `"entries": [ … 342 items ]`, its
 *               first members peeking — and a fresh view opens, breadth-first, what fits in `budget`
 *               lines, so the top of the value always shows. Off: everything is open, with no chevron.
 *  - `chunk`    an open array shows its first `items` and an object its first `keys`, then a
 *               `… 322 more items` line whose steps show `items` more, or all. What a step shows
 *               arrives closed (with `fold`), so "all" of 10,000 items costs 10,000 lines.
 *               Off: every member.
 *  - `strings`  a string longer than `at + slack` shows its first `at` characters, then how many are
 *               left, and steps for five times as many and for all of it. Off: whole.
 *
 * With all three off the lines are `JSON.stringify(value, null, 2)` exactly, token for token, coloured
 * as `highlightJson` colours that text and hinted from the schema as it hints it. That is the
 * invariant the tests hold it to. As `JSON.stringify` does: `toJSON` is called, boxed primitives are
 * unboxed, an object's `undefined`, function and symbol members are left out and an array's are `null`,
 * a number that is not finite is `null`. Where it would throw, this draws instead: a bigint as its
 * digits, and a value that contains itself as `"[Circular]"`.
 */
import type { Describe, Token } from "./jsonHighlight";

export interface JsonFolding {
  fold?: false | { budget: number };
  chunk?: false | { items: number; keys: number };
  strings?: false | { at: number; slack: number };
}

/** What the JSON view does unless its host says otherwise: all three, at these sizes. */
export const JSON_FOLDING: Required<JsonFolding> = {
  fold: { budget: 30 },
  chunk: { items: 20, keys: 25 },
  strings: { at: 300, slack: 100 },
};

/** Everything drawn whole: `JSON.stringify(value, null, 2)`, coloured. */
export const JSON_UNFOLDED: Required<JsonFolding> = { fold: false, chunk: false, strings: false };

/** The host's choice over the defaults, part by part. */
export function foldingOf(folding: JsonFolding | undefined): Required<JsonFolding> {
  return { ...JSON_FOLDING, ...folding };
}

/** What a reader did to one object, array or string, by its path (`pathKey`). */
export interface FoldState {
  open?: boolean;
  /** Members shown, past the first chunk. */
  shown?: number;
  /** Characters shown of a string, past the first `at`. */
  chars?: number;
}
export type FoldStates = ReadonlyMap<string, FoldState>;

export type FoldUnit = "items" | "keys";

/** A drawn line of the value, or the line after a chunk that says how many members are left. */
export type FoldRow =
  | {
      kind: "line";
      tokens: Token[];
      /** The schema's description of this line's key. */
      hint?: string;
      /** An object or array opens on this line: whether it is open, and how big it is. */
      fold?: { path: string; open: boolean; size: number; unit: FoldUnit };
      /** Closed: its first members, shortened (`role: "user", content: [1]`), and what follows the summary (`]`, `,`). */
      closed?: { peek: string; after: Token[] };
      /** A string on this line was cut: how many of its characters show, and how many are left. */
      cut?: { path: string; shown: number; rest: number };
    }
  | { kind: "more"; tokens: Token[]; hint?: undefined; path: string; shown: number; rest: number; unit: FoldUnit; step: number };

/** One step into a value: a member's key, or an item's index. */
const ROOT = "$";
export function pathKey(parent: string, key: string | number): string {
  return `${parent}\u0001${key}`;
}

/** A member's value as `JSON.stringify` sees it: after `toJSON`, unboxed. */
function resolved(v: unknown, key: string): unknown {
  if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") v = (v as { toJSON: (k: string) => unknown }).toJSON(key);
  if (v instanceof Number || v instanceof String || v instanceof Boolean) v = v.valueOf();
  return v;
}

/** Left out of an object (`null` in an array). */
const omitted = (v: unknown): boolean => v === undefined || typeof v === "function" || typeof v === "symbol";
const isBox = (v: unknown): v is object => v !== null && typeof v === "object";

/** An object's or array's members as they print: `[key, value]`, resolved, the omitted left out. */
function membersOf(v: object): [string | number, unknown][] {
  if (Array.isArray(v)) return v.map((item, i) => [i, ((r) => (omitted(r) ? null : r))(resolved(item, String(i)))]);
  const out: [string, unknown][] = [];
  for (const k of Object.keys(v)) {
    const r = resolved((v as Record<string, unknown>)[k], k);
    if (!omitted(r)) out.push([k, r]);
  }
  return out;
}

/** A leaf as its JSON token. */
function leafToken(v: unknown): Token {
  if (v === null) return { text: "null", kind: "literal" };
  if (typeof v === "boolean") return { text: String(v), kind: "literal" };
  if (typeof v === "number") return Number.isFinite(v) ? { text: String(v), kind: "number" } : { text: "null", kind: "literal" };
  if (typeof v === "bigint") return { text: String(v), kind: "number" };
  return { text: JSON.stringify(v), kind: "string" };
}

/** A member, short, for a closed container's peek. */
function shortOf(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isBox(v)) return `{${Object.keys(v).length}}`;
  // A string shortened before it is escaped: a peek at a megabyte of base64 costs thirty characters.
  const text = leafToken(typeof v === "string" ? v.slice(0, 30) : v).text;
  return text.length > 26 ? `${text.slice(0, 25)}…${typeof v === "string" ? '"' : ""}` : text;
}

function peekOf(members: [string | number, unknown][], array: boolean): string {
  const first = members.slice(0, 3);
  if (array) return first.every(([, m]) => !isBox(m)) ? first.map(([, m]) => shortOf(m)).join(", ") + (members.length > 3 ? ", …" : "") : "";
  return first.map(([k, m]) => `${String(k)}: ${shortOf(m)}`).join(", ") + (members.length > 3 ? ", …" : "");
}

/**
 * Which containers a fresh view opens: breadth-first, each that fits in what is left of `budget` lines
 * (the root always). With `fold` off there is nothing to decide: every container is open.
 */
export function initialFold(value: unknown, folding: Required<JsonFolding>): Map<string, FoldState> {
  const states = new Map<string, FoldState>();
  if (folding.fold === false) return states;
  const budget = folding.fold.budget;
  let used = 1;
  const queue: [string, unknown][] = [[ROOT, resolved(value, "")]];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const [path, v] = queue.shift()!;
    if (!isBox(v) || seen.has(v)) continue;
    seen.add(v);
    const members = membersOf(v);
    if (members.length === 0) continue;
    const shown = folding.chunk === false ? members.length : Math.min(members.length, Array.isArray(v) ? folding.chunk.items : folding.chunk.keys);
    const cost = shown + 1 + (shown < members.length ? 1 : 0);
    if (path !== ROOT && used + cost > budget) continue;
    used += cost;
    states.set(path, { open: true });
    for (const [k, m] of members.slice(0, shown)) if (isBox(m)) queue.push([pathKey(path, k), m]);
  }
  return states;
}

/** The value's lines, as `states` and `folding` leave them. */
export function foldRows(value: unknown, states: FoldStates, folding: Required<JsonFolding>, describe?: Describe): FoldRow[] {
  const rows: FoldRow[] = [];
  const top = resolved(value, "");
  if (omitted(top)) return [{ kind: "line", tokens: [{ text: "undefined", kind: "plain" }] }];
  const ancestors = new Set<object>();

  /** `prefix` is the line so far (indent, key); `schemaPath` the object keys enclosing it. */
  const walk = (v: unknown, path: string, depth: number, prefix: Token[], hint: string | undefined, comma: boolean, schemaPath: string[]): void => {
    const indent = "  ".repeat(depth);
    const tail: Token[] = comma ? [{ text: ",", kind: "punct" }] : [];
    const withHint = <T extends object>(row: T): T => (hint !== undefined ? { ...row, hint } : row);
    if (!isBox(v)) {
      if (typeof v === "string" && folding.strings !== false) {
        const shown = states.get(path)?.chars ?? folding.strings.at;
        if (v.length > shown + folding.strings.slack) {
          const head = JSON.stringify(v.slice(0, shown));
          rows.push(withHint({ kind: "line" as const, tokens: [...prefix, { text: `${head.slice(0, -1)}…"`, kind: "string" as const }, ...tail], cut: { path, shown, rest: v.length - shown } }));
          return;
        }
      }
      rows.push(withHint({ kind: "line" as const, tokens: [...prefix, leafToken(v), ...tail] }));
      return;
    }
    if (ancestors.has(v)) {
      rows.push(withHint({ kind: "line" as const, tokens: [...prefix, { text: '"[Circular]"', kind: "string" as const }, ...tail] }));
      return;
    }
    const array = Array.isArray(v);
    const [open, close] = array ? ["[", "]"] : ["{", "}"];
    const members = membersOf(v);
    if (members.length === 0) {
      rows.push(withHint({ kind: "line" as const, tokens: [...prefix, { text: open, kind: "punct" as const }, { text: close, kind: "punct" as const }, ...tail] }));
      return;
    }
    const unit: FoldUnit = array ? "items" : "keys";
    const state = states.get(path);
    const isOpen = folding.fold === false || (state?.open ?? path === ROOT);
    const fold = folding.fold === false ? undefined : { path, open: isOpen, size: members.length, unit };
    if (!isOpen) {
      rows.push(withHint({ kind: "line" as const, tokens: [...prefix, { text: open, kind: "punct" as const }], fold: fold!, closed: { peek: peekOf(members, array), after: [{ text: close, kind: "punct" as const }, ...tail] } }));
      return;
    }
    rows.push(withHint({ kind: "line" as const, tokens: [...prefix, { text: open, kind: "punct" as const }], ...(fold !== undefined ? { fold } : {}) }));
    const chunk = folding.chunk === false ? members.length : array ? folding.chunk.items : folding.chunk.keys;
    const shown = Math.min(members.length, state?.shown ?? chunk);
    const inner = `${indent}  `;
    ancestors.add(v);
    for (let i = 0; i < shown; i++) {
      const [k, m] = members[i]!;
      const childPath = pathKey(path, k);
      const memberComma = i < members.length - 1;
      if (array) {
        walk(m, childPath, depth + 1, [{ text: inner, kind: "plain" }], undefined, memberComma, schemaPath);
      } else {
        const key = String(k);
        const keyTokens: Token[] = [
          { text: inner, kind: "plain" },
          { text: JSON.stringify(key), kind: "key" },
          { text: ":", kind: "punct" },
          { text: " ", kind: "plain" },
        ];
        // An array borrows its own key for its items, as `highlightJson`'s path does.
        walk(m, childPath, depth + 1, keyTokens, describe?.(schemaPath, key), memberComma, isBox(m) ? [...schemaPath, key] : schemaPath);
      }
    }
    ancestors.delete(v);
    if (shown < members.length) {
      const rest = members.length - shown;
      rows.push({ kind: "more", tokens: [{ text: inner, kind: "plain" }], path, shown, rest, unit, step: Math.min(chunk, rest) });
    }
    rows.push({ kind: "line", tokens: [{ text: indent, kind: "plain" as const }, { text: close, kind: "punct" as const }, ...tail].filter((tk) => tk.text.length > 0) });
  };
  walk(top, ROOT, 0, [], undefined, false, []);
  return rows;
}

/** The fold state after a reader's step, `states` untouched. */
export function stepped(states: FoldStates, path: string, change: (was: FoldState) => FoldState): Map<string, FoldState> {
  const next = new Map(states);
  next.set(path, change(states.get(path) ?? {}));
  return next;
}
