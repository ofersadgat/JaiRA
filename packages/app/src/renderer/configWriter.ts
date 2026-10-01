/**
 * How a settings form writes into ONE layer's document — the writers the Settings pages save through.
 */
import { withPaths, type ConfigLayer, type ConfigView } from "@jaira/shared/browser";

/**
 * A setting's place in the layer a Settings page edits — the person's rule (2026-09-25): no switch.
 * The control always shows what is in effect and always edits it (a change is written to this layer
 * and taken out of the stronger ones, `clearedAbove`); `stated` draws the ↺ that takes the layer's
 * own statement out again, so the setting inherits.
 */
export interface LayerState {
  stated: boolean;
  onInherit: () => void;
  disabled?: boolean | undefined;
  /** What the ↺ says, where "Back to <what the layers below say>" is not what taking it out does. */
  label?: string | undefined;
}

/**
 * Write into ONE layer's document, a dotted path at a time — what every form on a settings screen
 * saves through.
 *
 * `set` writes one path; `undefined` removes it, so the field inherits again, and a container the
 * removal emptied goes with it. `stated` says whether THIS layer says anything at a path, which is
 * what a field's set/not-set switch shows. Both read the layer's own document and never the merged
 * one: saving in a project must not copy the shared root's settings out of it.
 */
export function layerWriter(
  doc: Record<string, unknown> | null,
  layer: ConfigLayer,
  onSave: (layer: ConfigLayer, doc: unknown, written?: readonly string[]) => void,
): { set: (path: string, value: unknown) => void; stated: (path: string) => boolean } {
  // A container the removal emptied goes with it, so an untouched section leaves no trace. The path
  // goes with the document, so the stronger layers lose it even when this layer already said the same
  // (`clearedAbove`'s `written`).
  const set = (path: string, value: unknown): void => onSave(layer, withPaths(doc, [[path, value]]), [path]);

  const stated = (path: string): boolean => {
    let cursor: unknown = doc;
    for (const part of path.split(".")) {
      if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
      cursor = (cursor as Record<string, unknown>)[part];
      if (cursor === undefined) return false;
    }
    return true;
  };
  return { set, stated };
}

export interface Writer {
  effective: Record<string, unknown>;
  locked: boolean;
  stated: (path: string) => boolean;
  set: (path: string, value: unknown) => void;
  layer: (path: string) => LayerState;
}

/**
 * What every section here writes through: the layer's own document, the merged one it inherits from,
 * and a row's place in the layer for one path — its ↺ while this layer states it, which removes it so
 * the row inherits again (see `Field.layer`).
 */
export function configWriter(
  config: ConfigView,
  layer: ConfigLayer,
  locked: boolean,
  onSave: (layer: ConfigLayer, doc: unknown, written?: readonly string[]) => void,
): Writer {
  const doc = config[layer] as Record<string, unknown> | null;
  const effective = config.effective as Record<string, unknown>;
  const { set, stated } = layerWriter(doc, layer, onSave);
  const layerOf = (path: string): LayerState => ({ stated: stated(path), disabled: locked, onInherit: () => set(path, undefined) });
  return { effective, locked, stated, set, layer: layerOf };
}

/**
 * The presets a merged document states, by name — what a model field may name instead of a model id
 * (`resolveModelField`): the built-in ones and every layer's own.
 */
export function presetNamesOf(effective: Record<string, unknown>): string[] {
  const models = effective["models"];
  const presets = models !== null && typeof models === "object" ? (models as Record<string, unknown>)["presets"] : undefined;
  return presets !== null && typeof presets === "object" && !Array.isArray(presets) ? Object.keys(presets) : [];
}

/** `execEnvironment` (`"windows" | { wsl }`) as the Where commands run section reads it: the distro, or "". */
export function execDistroOf(effective: Record<string, unknown>): { value: unknown; distro: string } {
  const value = effective["execEnvironment"];
  const distro = value !== null && typeof value === "object" ? String((value as { wsl?: string }).wsl ?? "") : "";
  return { value, distro };
}
