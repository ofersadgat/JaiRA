/**
 * The configuration's layers, as one ordered list — and the two questions a settings screen asks of
 * them about one key: what would it be WITHOUT this layer, and which layer says so.
 *
 * Four layers, weakest first: what JaiRA ships (the built-in defaults, and whatever a built-in
 * document states), the shared root's `settings.json`, the project's `.jaira/settings.json`, and the
 * person's own `personal-settings.json` ("Just you"). Every document has the same schema; objects
 * merge key by key and the stronger layer wins (`mergeConfigDocuments`). The personal layer is last
 * so that what one person chose wins for that person everywhere on this machine — and reaches nobody
 * else, because it is never in a checkout.
 *
 * Pure, and browser-safe: the renderer asks these to draw a row's "instead of … from …" line, and main
 * uses the merge to read and validate what it writes.
 */
import type { JsonValue } from "@declarative-ai/json";
import { defaultConfig, mergeConfigLayers } from "./config";
import { CONFIG_LAYERS, type ConfigLayer, type ConfigView } from "./ipc";

/** Where a key's value comes from when no layer states it: the defaults JaiRA ships. */
export const BUILT_IN_SOURCE = "built in";

/** A layer that states a key, or the built-in defaults when none does. */
export type ConfigSource = ConfigLayer | typeof BUILT_IN_SOURCE;

/** One layer's own document as the view holds it — what that layer's rows edit. */
export function layerDocument(view: ConfigView, layer: ConfigLayer): JsonValue | null {
  return view[layer];
}

/** The layers weaker than `layer`, weakest first. */
export function layersBelow(layer: ConfigLayer): ConfigLayer[] {
  return CONFIG_LAYERS.slice(0, CONFIG_LAYERS.indexOf(layer));
}

/**
 * What a layer would see if it said nothing: what JaiRA ships (`$SYSTEM/settings.json`) and every
 * weaker layer merged, as raw documents (the parser's defaults are not filled in — a key absent here is
 * one nothing below states).
 */
export function inheritedDoc(view: ConfigView, layer: ConfigLayer): Record<string, unknown> {
  const merged = mergeConfigLayers([view.system, ...layersBelow(layer).map((below) => view[below])]);
  return merged !== null && typeof merged === "object" && !Array.isArray(merged) ? (merged as Record<string, unknown>) : {};
}

/** The value at a dotted path of a document, or `undefined` where any step is missing. */
export function valueAtPath(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Whether a document says anything at a dotted path — `null` counts, since `null` is a statement. */
export function statesPath(doc: unknown, path: string): boolean {
  return valueAtPath(doc, path) !== undefined;
}

/**
 * The strongest layer that states `path` — among the layers weaker than `below` when it is given —
 * or {@link BUILT_IN_SOURCE} when none does and the value is what ships: the built-in document's, or
 * the parser's default.
 */
export function statingLayer(view: ConfigView, path: string, below?: ConfigLayer): ConfigSource {
  const candidates = below === undefined ? [...CONFIG_LAYERS] : layersBelow(below);
  for (const layer of candidates.reverse()) {
    if (statesPath(view[layer], path)) return layer;
  }
  return BUILT_IN_SOURCE;
}

/** The layers stronger than `layer`, weakest first. */
export function layersAbove(layer: ConfigLayer): ConfigLayer[] {
  return CONFIG_LAYERS.slice(CONFIG_LAYERS.indexOf(layer) + 1);
}

/** One path of a layer's document and its new value — `undefined` removes it, and it inherits again. */
export type PathWrite = readonly [path: string, value: unknown];

const isPlainRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A layer's document with some paths written. A container a removal empties goes with it, so an
 * untouched section leaves no trace in a file people read.
 */
export function withPaths(doc: unknown, writes: readonly PathWrite[]): Record<string, unknown> {
  const next = structuredClone(isPlainRecord(doc) ? doc : {});
  for (const [path, value] of writes) {
    const parts = path.split(".");
    const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
    let cursor = next;
    for (const part of parts.slice(0, -1)) {
      const held = cursor[part];
      cursor[part] = isPlainRecord(held) ? { ...held } : {};
      chain.push({ parent: cursor, key: part });
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    if (value === undefined) delete cursor[leaf];
    else cursor[leaf] = value;
    for (const { parent, key } of chain.reverse()) {
      const block = parent[key];
      if (isPlainRecord(block) && Object.keys(block).length === 0) delete parent[key];
    }
  }
  return next;
}

/**
 * Keys a stronger layer ADDS to rather than replaces (`mergeConfigDocuments`): `files.hidden` appends
 * layer by layer and `agents.genericCli` merges by name, so a weaker layer's change to them is not
 * shadowed by a stronger one and nothing there is taken out.
 */
const ADDITIVE_PATHS = ["files.hidden", "agents.genericCli"];

/**
 * Every leaf path `after` states differently from `before` — objects are walked, anything else (a
 * list, a scalar, `null`) is one value. A path `after` no longer states is not a change here: taking a
 * statement out is how a layer inherits, and it never reaches past its own document.
 */
export function statedChanges(before: unknown, after: unknown, prefix = ""): string[] {
  if (isPlainRecord(after)) {
    const under = isPlainRecord(before) ? before : {};
    return Object.entries(after).flatMap(([key, value]) => statedChanges(under[key], value, prefix === "" ? key : `${prefix}.${key}`));
  }
  if (after === undefined || prefix === "") return [];
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

/**
 * The stronger layers' documents once a change to `layer` is made to SHOW — the person's rule for
 * Settings (2026-09-25): a change is written to the layer the page is editing, and every stronger
 * layer that states the same setting has it taken out, so what was picked is what the window uses.
 *
 * `next` is `layer`'s whole new document; only what it newly states is carried up. A stronger layer
 * that holds something that is not an object at a parent of a changed path (a `null` where a block
 * would be) loses that parent, since it would cover the change as surely as the path itself. Only the
 * layers whose documents change are returned, weakest first.
 */
export function clearedAbove(view: ConfigView, layer: ConfigLayer, next: unknown): Array<{ layer: ConfigLayer; doc: Record<string, unknown> }> {
  const changed = statedChanges(view[layer], next).filter((path) => !ADDITIVE_PATHS.some((additive) => path === additive || path.startsWith(`${additive}.`)));
  if (changed.length === 0) return [];
  const out: Array<{ layer: ConfigLayer; doc: Record<string, unknown> }> = [];
  for (const above of layersAbove(layer)) {
    const doc = view[above];
    if (!isPlainRecord(doc)) continue;
    const removals = new Set<string>();
    for (const path of changed) {
      const parts = path.split(".");
      for (let depth = 1; depth <= parts.length; depth++) {
        const at = parts.slice(0, depth).join(".");
        const value = valueAtPath(doc, at);
        if (value === undefined) break;
        if (depth === parts.length || !isPlainRecord(value)) {
          removals.add(at);
          break;
        }
      }
    }
    if (removals.size > 0) out.push({ layer: above, doc: withPaths(doc, [...removals].map((path) => [path, undefined] as const)) });
  }
  return out;
}

/**
 * What `path` would be if `layer` said nothing, and where that comes from — the weaker layers' value,
 * or the shipped default (`undefined` for a key with none, such as a model left to the state).
 */
export function inheritedValue(view: ConfigView, path: string, layer: ConfigLayer): { value: unknown; from: ConfigSource } {
  const from = statingLayer(view, path, layer);
  return {
    value:
      from === BUILT_IN_SOURCE
        ? (valueAtPath(view.system, path) ?? valueAtPath(defaultConfig(), path))
        : valueAtPath(inheritedDoc(view, layer), path),
    from,
  };
}
