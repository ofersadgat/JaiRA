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
