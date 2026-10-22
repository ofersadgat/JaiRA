/**
 * A large value left where it is and fetched when read (decision 0018 §6).
 *
 * The engine answers a view with any string over the reader's threshold replaced, in place, by
 * `{"$lazy": {size, preview, hash}}`; the reader asks `lazy:value` for the string by its hash when it
 * draws it. An object with one reserved key, like the records' `$blob`, so no real value can be taken
 * for one. The hash is the SHA-256 of the string — the same as its blob's, where it is one.
 */
import type { JsonValue } from "@declarative-ai/json";

export const LAZY_KEY = "$lazy";

export interface LazyValue {
  [LAZY_KEY]: {
    /** The string's length, in characters. */
    size: number;
    /** Its start, to draw while the rest is fetched. */
    preview: string;
    hash: string;
  };
}

export function isLazy(value: unknown): value is LazyValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const inner = (value as Record<string, unknown>)[LAZY_KEY];
  return inner !== null && typeof inner === "object" && typeof (inner as { hash?: unknown }).hash === "string";
}

/** The text a value stands for as far as it is known: the string itself, or a placeholder's preview. */
export function knownText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isLazy(value)) return value[LAZY_KEY].preview;
  return undefined;
}

/** Every placeholder's hash in a value. */
export function lazyHashes(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (isLazy(value)) into.add(value[LAZY_KEY].hash);
  else if (Array.isArray(value)) for (const item of value) lazyHashes(item, into);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) lazyHashes(item, into);
  return into;
}

/** The value with every placeholder whose string is known put back; the rest left as they are. */
export function withLazyFilled(value: JsonValue, known: ReadonlyMap<string, string>): JsonValue {
  if (known.size === 0) return value;
  if (isLazy(value)) return known.get(value[LAZY_KEY].hash) ?? value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = withLazyFilled(item, known);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = withLazyFilled(item as JsonValue, known);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}
