/**
 * The `appearance` block of the layered configuration — how the app LOOKS (SHELL.md §6).
 *
 * It was the private half of `user-settings.json` (the theme, the typography, the editors, the
 * renderer choices, the conversation's layout) and became a block of `settings.json` on 2026-09-23,
 * layered like every other: the shared root, a project, and the person's own `personal-settings.json`
 * over both. A project may now say "this checkout is read in the pastel palette", the shared root may
 * set a machine's fonts, and what one person chose still wins for that person — which is the fourth
 * layer's whole job.
 *
 * One flat block for the window's own look, with three nested ones for the things that already had
 * a shape of their own: `conversation`, `editors` (per editing surface) and `renderers` (per file
 * type). A layer states only what it changes; objects merge key by key (`mergeConfigDocuments`), so
 * a project that sets `palette` keeps the shared root's fonts.
 *
 * STRICT, like every other block of `settings.json` and unlike the forgiving preferences file it
 * replaced: an unknown key, a palette this release does not have, a size outside the range its
 * control offers, or an editor knob a surface cannot honour is refused with the key named. A layer is
 * a document a person may edit by hand, and a look that silently reads as the default is exactly the
 * kind of setting-that-is-not-there this file refuses everywhere else. What a person could not have
 * typed — an old preferences file — was cleaned on its way in (`migrateUserSettings`).
 *
 * The parsed block always carries every default, so a reader never asks "is this set?" — that is a
 * question about ONE layer, and `./configLayers` answers it.
 */
import {
  BUCKET_STYLES,
  EDITOR_KINDS,
  EDITOR_KNOBS,
  LINE_HEIGHT,
  PALETTES,
  RENDER_VIEWS,
  SEQUENTIAL_BATCH_LAYOUTS,
  SIZE_LIMITS,
  TAB_SIZES,
  THEME_MODES,
  USAGE_FIGURES,
  defaultAppearance,
  defaultConversationLook,
  defaultEditors,
  defaultRendererChoice,
  type Appearance,
  type BucketStyle,
  type ConversationLook,
  type EditorKind,
  type EditorLook,
  type Palette,
  type RendererChoice,
  type RendererChoices,
  type SequentialBatchLayout,
  type ThemeMode,
  type UsageFigures,
} from "./settings";

/**
 * The whole look, every field decided: the window's typography and palette ({@link Appearance}), the
 * mode, and the three nested blocks.
 */
export interface JairaAppearanceConfig extends Appearance {
  /** Light, dark, or follow the operating system. Light by default — an explicit product decision. */
  mode: ThemeMode;
  /** How a run's conversation is drawn — see {@link ConversationLook}. */
  conversation: ConversationLook;
  /** How each editing surface looks — see `EditorLook`. */
  editors: Record<EditorKind, EditorLook>;
  /**
   * Which renderer draws a file type, where more than one can — see `RendererChoices`. Holds
   * DISAGREEMENTS, not the table: absent is the common case, and the app's own best answer reaches
   * everybody who never had an opinion.
   */
  renderers: RendererChoices;
}

/** The look a fresh install has — exactly what the preferences file used to default to. */
export function defaultAppearanceConfig(): JairaAppearanceConfig {
  return {
    ...defaultAppearance(),
    mode: "light",
    conversation: defaultConversationLook(),
    editors: defaultEditors(),
    renderers: {},
  };
}

/** The flat fields of the block, in the order a reader meets them on the Appearance page. */
export const APPEARANCE_FIELDS = [
  "mode",
  "palette",
  "laneColors",
  "buckets",
  "statusWash",
  "appFamily",
  "dataFamily",
  "sizeApp",
  "sizeData",
  "sizeEditor",
  "advanced",
  "smoothing",
  "editorTheme",
  "conversation",
  "editors",
  "renderers",
] as const;

const WHERE = "config.appearance";

function plain(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function onlyFields(spec: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const field of Object.keys(spec)) {
    if (!allowed.includes(field)) throw new Error(`${where}.${field} is not a setting — it takes ${allowed.join(", ")}`);
  }
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (!options.includes(value as T)) throw new Error(`${where} must be one of ${options.join(", ")}`);
  return value as T;
}

/** `true`, `false`, or `null` for "what the palette says" — see `surfaceOf`. */
function flagOrNull(value: unknown, where: string): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new Error(`${where} must be true, false or null (the palette's own)`);
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${where} must be true or false`);
  return value;
}

/**
 * A font stack: families tried in order before the default stack. Each a non-empty name, and none
 * twice — the second copy of a family could never be reached, and saying so beats keeping it.
 */
function families(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list of font families`);
  const out = value.map((entry, i) => {
    if (typeof entry !== "string" || entry.trim().length === 0) throw new Error(`${where}[${i}] must be a font family's name`);
    return entry.trim();
  });
  const twice = out.find((family, i) => out.indexOf(family) !== i);
  if (twice !== undefined) throw new Error(`${where} names '${twice}' twice — the second can never be reached`);
  return out;
}

/** A size inside the bounds its control offers. Refused, not clamped: see the module note. */
function size(value: unknown, key: keyof typeof SIZE_LIMITS, where: string): number {
  const { min, max } = SIZE_LIMITS[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${where} must be a size from ${min} to ${max} px`);
  }
  return value;
}

function parseConversation(raw: unknown, where: string): ConversationLook {
  const out = defaultConversationLook();
  if (raw === undefined) return out;
  const spec = plain(raw, where);
  onlyFields(spec, ["sequentialBatches", "usageFigures"], where);
  if (spec["sequentialBatches"] !== undefined) {
    out.sequentialBatches = oneOf<SequentialBatchLayout>(spec["sequentialBatches"], SEQUENTIAL_BATCH_LAYOUTS, `${where}.sequentialBatches`);
  }
  if (spec["usageFigures"] !== undefined) {
    out.usageFigures = oneOf<UsageFigures>(spec["usageFigures"], USAGE_FIGURES, `${where}.usageFigures`);
  }
  return out;
}

/**
 * The per-surface looks. A knob a surface cannot honour (`EDITOR_KNOBS`) is refused by name: the
 * JSON editor has no minimap, and a setting that it silently ignores is somebody believing it does.
 */
function parseEditors(raw: unknown, where: string): Record<EditorKind, EditorLook> {
  const out = defaultEditors();
  if (raw === undefined) return out;
  const spec = plain(raw, where);
  onlyFields(spec, EDITOR_KINDS, where);
  for (const kind of EDITOR_KINDS) {
    if (spec[kind] === undefined) continue;
    const at = `${where}.${kind}`;
    const look = plain(spec[kind], at);
    onlyFields(look, EDITOR_KNOBS[kind], at);
    for (const knob of EDITOR_KNOBS[kind]) {
      const value = look[knob];
      if (value === undefined) continue;
      if (knob === "tabSize") {
        if (typeof value !== "number" || !TAB_SIZES.includes(value)) throw new Error(`${at}.tabSize must be one of ${TAB_SIZES.join(", ")}`);
        out[kind].tabSize = value;
      } else if (knob === "lineHeight") {
        if (typeof value !== "number" || !Number.isFinite(value) || value < LINE_HEIGHT.min || value > LINE_HEIGHT.max) {
          throw new Error(`${at}.lineHeight must be a number from ${LINE_HEIGHT.min} to ${LINE_HEIGHT.max}`);
        }
        out[kind].lineHeight = value;
      } else {
        out[kind][knob] = bool(value, `${at}.${knob}`);
      }
    }
  }
  return out;
}

/**
 * The renderer choices, per key — `"<mime>:<kind>"` or `"family:<family>:<kind>"`. Whether a key names
 * a type this app knows, or a value a renderer that exists, is not answerable here (the registry is
 * the renderer's) and is answered harmlessly where it is read; the SHAPE is checked, so a hand-edited
 * layer cannot put an object where a renderer id goes.
 */
function parseRenderers(raw: unknown, where: string): RendererChoices {
  const out: RendererChoices = {};
  if (raw === undefined) return out;
  for (const [key, entry] of Object.entries(plain(raw, where))) {
    const at = `${where}.${key}`;
    if (!key.includes(":")) throw new Error(`${at} is not a renderer key — it is "<mime>:<kind>" or "family:<family>:<kind>"`);
    const spec = plain(entry, at);
    onlyFields(spec, ["read", "write", "off", "theme"], at);
    const choice: RendererChoice = defaultRendererChoice();
    const named = (value: unknown, field: string): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a renderer's id, or null for the app's own`);
      return value;
    };
    choice.read = named(spec["read"], `${at}.read`);
    choice.write = named(spec["write"], `${at}.write`);
    if (spec["off"] !== undefined) {
      if (!Array.isArray(spec["off"]) || spec["off"].some((id) => typeof id !== "string" || id.length === 0)) {
        throw new Error(`${at}.off must be a list of renderer ids`);
      }
      choice.off = [...new Set(spec["off"] as string[])];
    }
    if (spec["theme"] !== undefined) {
      const theme = plain(spec["theme"], `${at}.theme`);
      onlyFields(theme, RENDER_VIEWS, `${at}.theme`);
      for (const view of RENDER_VIEWS) choice.theme[view] = named(theme[view], `${at}.theme.${view}`);
    }
    // A line that says nothing is not a line — what keeps "unset stays unwritten" true after the merge,
    // where a layer's `null`s take back what a weaker layer said.
    if (choice.read !== null || choice.write !== null || choice.off.length > 0 || choice.theme.read !== null || choice.theme.write !== null) {
      out[key] = choice;
    }
  }
  return out;
}

/**
 * Parse the MERGED `appearance` block. Absent ⇒ every default. See the module note on strictness.
 */
export function parseAppearanceConfig(raw: unknown): JairaAppearanceConfig {
  const out = defaultAppearanceConfig();
  if (raw === undefined) return out;
  const spec = plain(raw, WHERE);
  onlyFields(spec, APPEARANCE_FIELDS, WHERE);
  const at = (key: string): string => `${WHERE}.${key}`;
  if (spec["mode"] !== undefined) out.mode = oneOf<ThemeMode>(spec["mode"], THEME_MODES, at("mode"));
  if (spec["palette"] !== undefined) out.palette = oneOf<Palette>(spec["palette"], PALETTES, at("palette"));
  if (spec["laneColors"] !== undefined) out.laneColors = flagOrNull(spec["laneColors"], at("laneColors"));
  if (spec["statusWash"] !== undefined) out.statusWash = flagOrNull(spec["statusWash"], at("statusWash"));
  if (spec["buckets"] !== undefined) {
    out.buckets = spec["buckets"] === null ? null : oneOf<BucketStyle>(spec["buckets"], BUCKET_STYLES, at("buckets"));
  }
  if (spec["appFamily"] !== undefined) out.appFamily = families(spec["appFamily"], at("appFamily"));
  if (spec["dataFamily"] !== undefined) out.dataFamily = families(spec["dataFamily"], at("dataFamily"));
  for (const key of ["sizeApp", "sizeData", "sizeEditor"] as const) {
    if (spec[key] !== undefined) out[key] = size(spec[key], key, at(key));
  }
  if (spec["advanced"] !== undefined) out.advanced = bool(spec["advanced"], at("advanced"));
  if (spec["smoothing"] !== undefined) out.smoothing = bool(spec["smoothing"], at("smoothing"));
  // Any non-empty id: the editor palettes live in the renderer (`editorThemes.ts`), which falls back
  // to the default for one it does not have — the rule the renderer choices follow one field down.
  if (spec["editorTheme"] !== undefined) {
    if (typeof spec["editorTheme"] !== "string" || spec["editorTheme"].length === 0) throw new Error(`${at("editorTheme")} must be an editor theme's id`);
    out.editorTheme = spec["editorTheme"];
  }
  out.conversation = parseConversation(spec["conversation"], at("conversation"));
  out.editors = parseEditors(spec["editors"], at("editors"));
  out.renderers = parseRenderers(spec["renderers"], at("renderers"));
  return out;
}
