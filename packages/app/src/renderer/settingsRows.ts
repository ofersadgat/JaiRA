/**
 * What a settings row does in the layers, as pure functions of the layer a page edits — the logic of
 * `controls.tsx`'s `useLayerRow` and `useInheritLabel`, and of a row's hint, in a module of its own so
 * the universal copies (decision 0015) run the same code the DOM rows do.
 */
import { inheritedValue, pathKeys, statesPath, type ConfigLayer, type ConfigPath, type ConfigView } from "@jaira/shared/browser";
import { SOURCE_WORDS } from "./layerLabels";

/**
 * The layer a Settings page is editing, as every row on it needs to know it — see
 * `SettingsLayerContext` in `controls.tsx`.
 */
export interface SettingsLayerView {
  layer: ConfigLayer;
  /** Every layer's own document, for what a row inherits and from where. Null before the first read. */
  view: ConfigView | null;
  /** Draw only the rows this layer states. */
  onlyStated: boolean;
}

/**
 * A value in a few words, for the "instead of …" line: a model id as itself, yes or no, a count of a
 * list's entries ("3 patterns"), a count of an object's settings.
 */
export function shortValue(value: unknown, path = ""): string {
  if (value === undefined) return "nothing";
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value.length === 0 ? "nothing" : value.length > 40 ? `${value.slice(0, 39)}…` : value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const noun = path.endsWith("hidden") ? "pattern" : "entry";
    return `${value.length} ${value.length === 1 ? noun : noun === "entry" ? "entries" : `${noun}s`}`;
  }
  const n = Object.keys(value as object).length;
  return `${n} ${n === 1 ? "setting" : "settings"}`;
}

/**
 * What a row on a layered page does in the Just you view — whether it is drawn, and the line it
 * carries — for the config `paths` it writes, on the layer `at` (null outside a Settings page). See
 * `useLayerRow`.
 */
export function layerRowOf(
  at: SettingsLayerView | null,
  paths: readonly ConfigPath[] | undefined,
  stated?: boolean,
  format?: (value: unknown, path: string) => string,
): { hidden: boolean; instead: string | undefined } {
  if (at === null) return { hidden: false, instead: undefined };
  const doc = at.view?.[at.layer];
  const own = paths?.filter((path) => statesPath(doc, path)) ?? [];
  const here = stated ?? own.length > 0;
  let instead: string | undefined;
  if (here && at.layer === "you" && at.view !== null && own.length > 0) {
    const path = own[0]!;
    const { value, from } = inheritedValue(at.view, path, "you");
    const dotted = pathKeys(path).join(".");
    instead =
      value === undefined && from === "built in"
        ? "set nowhere else"
        : `instead of ${format !== undefined ? format(value, dotted) : shortValue(value, dotted)} from ${SOURCE_WORDS[from]}`;
  }
  return { hidden: at.onlyStated && !here, instead };
}

/** The ↺'s label — see `useInheritLabel`. */
export function inheritLabelOf(at: SettingsLayerView | null, paths: readonly ConfigPath[] | undefined, format?: (value: unknown, path: string) => string): string {
  const path = paths?.[0];
  if (at === null || at.view === null || path === undefined) return "Take this out of this layer, so it inherits";
  const { value, from } = inheritedValue(at.view, path, at.layer);
  const dotted = pathKeys(path).join(".");
  const words = value === undefined ? "not set" : format !== undefined ? format(value, dotted) : shortValue(value, dotted);
  return `Back to ${words}, from ${SOURCE_WORDS[from]}`;
}

/** The first sentence of a hint, and the rest — the split a settings row draws. */
export function splitHint(hint: string): { first: string; rest: string } {
  const at = hint.search(/[.!?](\s|$)/);
  if (at < 0 || at >= hint.length - 1) return { first: hint, rest: "" };
  return { first: hint.slice(0, at + 1), rest: hint.slice(at + 1).trim() };
}

/**
 * A row's (or a section's) place in the layers: the config paths it writes, whether the layer being
 * edited states them, and how to take them out again.
 */
export interface RowLayer {
  /** The config paths the row writes, the first stated one being what its "instead of" line reports. */
  paths: readonly ConfigPath[];
  /** The layer being edited states it — the ↺ is drawn. */
  stated: boolean;
  /** Take the row's paths out of the layer being edited, so it inherits again. */
  onInherit: () => void;
  disabled?: boolean | undefined;
  /** How the row spells a value, for the "instead of" line and the ↺ — a palette's name rather than its id. */
  format?: ((value: unknown, path: string) => string) | undefined;
}
