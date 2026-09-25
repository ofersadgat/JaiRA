/**
 * How the app looks, read from and written to the LAYERED configuration (2026-09-23).
 *
 * The look was the preferences file's until it became the `appearance` block of `settings.json`:
 * the shared root, a project, and `personal-settings.json` ("Just you") over both. So what the window
 * paints is the EFFECTIVE block of the address it stands on — `lookOf` — and a change is a write of
 * a few paths into ONE layer's document, never the merged one (which would pin every inherited
 * sibling into that layer with a single click).
 *
 * Pure, so the rules are testable without a store: which paths an edit writes, what a renderer edit
 * does to one layer's own entry, and which layer a change made OUTSIDE Settings lands in.
 */
import {
  defaultAppearanceConfig,
  pathKeys,
  statingLayer,
  withPaths,
  type ConfigLayer,
  type ConfigPath,
  type ConfigView,
  type JairaAppearanceConfig,
  type PathWrite,
  type RendererEdit,
} from "@jaira/shared/browser";

/** The look the window paints: the effective block, or the defaults before the first read. */
export function lookOf(config: ConfigView | null): JairaAppearanceConfig {
  const block = (config?.effective as { appearance?: JairaAppearanceConfig } | undefined)?.appearance;
  return block ?? defaultAppearanceConfig();
}

/**
 * Where a change made OUTSIDE Settings lands — the sidebar's theme switch, a JSON editor's wrap
 * toggle: the strongest layer that already states the key, so the change is one the window will
 * show, or the personal layer when none does. Writing the page's layer instead could land a flip
 * under a stronger layer that says otherwise, which reads as a switch that does nothing.
 */
export function targetLayerOf(config: ConfigView | null, path: ConfigPath): ConfigLayer {
  if (config === null) return "you";
  const from = statingLayer(config, path);
  return from === "built in" ? "you" : from;
}

/**
 * The writes one layer's renderer entries take from a list of edits — `fileTypes.ts`'s vocabulary.
 *
 * Per FIELD of the layer's own entry: a value states it, `null` takes the statement back so the field
 * inherits (the layers below, or the app's own answer), and an edit of `null` takes the whole key
 * back. An entry left saying nothing is removed.
 */
export function rendererWrites(layerDoc: unknown, edits: readonly RendererEdit[]): PathWrite[] {
  const own = ((layerDoc as { appearance?: { renderers?: Record<string, Record<string, unknown>> } } | null)?.appearance?.renderers ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const entries: Record<string, Record<string, unknown> | undefined> = Object.fromEntries(Object.entries(own).map(([key, entry]) => [key, { ...entry }]));
  for (const { key, edit } of edits) {
    if (edit === null) {
      entries[key] = undefined;
      continue;
    }
    const line: Record<string, unknown> = { ...(entries[key] ?? {}) };
    const say = (field: string, value: unknown): void => {
      if (value === undefined) return;
      if (value === null || (Array.isArray(value) && value.length === 0)) delete line[field];
      else line[field] = value;
    };
    say("read", edit.read);
    say("write", edit.write);
    say("off", edit.off === undefined ? undefined : [...new Set(edit.off)]);
    if (edit.theme !== undefined) {
      const theme: Record<string, unknown> = { ...((line["theme"] as Record<string, unknown> | undefined) ?? {}) };
      for (const view of ["read", "write"] as const) {
        const value = edit.theme[view];
        if (value === undefined) continue;
        if (value === null) delete theme[view];
        else theme[view] = value;
      }
      if (Object.keys(theme).length > 0) line["theme"] = theme;
      else delete line["theme"];
    }
    entries[key] = Object.keys(line).length > 0 ? line : undefined;
  }
  // Keyed by `appearance.renderers.<key>` would split a key on its own dots (`family:image/svg+xml`
  // has none, but a MIME type may), so the whole block is written as one value.
  const block = Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined));
  return [["appearance.renderers", Object.keys(block).length > 0 ? block : undefined]];
}

/** The effective look with some writes applied at once — the window moves on the click, not the round trip. */
export function lookWith(look: JairaAppearanceConfig, writes: readonly PathWrite[]): JairaAppearanceConfig {
  // Only statements: a removal's answer is whatever the layers below say, which is main's to work out.
  // Nor the renderer choices, which a layer writes as partial lines that only the merge completes.
  const stated = writes.filter(([path, value]) => {
    const [block, field] = pathKeys(path);
    return value !== undefined && block === "appearance" && field !== undefined && field !== "renderers";
  });
  if (stated.length === 0) return look;
  const next = withPaths({ appearance: look }, stated.map(([path, value]) => [path, value] as const));
  return next["appearance"] as JairaAppearanceConfig;
}
