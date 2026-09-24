/**
 * The one-shot migration that moves how the app LOOKS out of `user-settings.json` and into the
 * fourth configuration layer, `personal-settings.json` (2026-09-23), run on every start until there
 * is nothing left to move.
 *
 * The preferences file held the theme, the typography, the editors, the renderer choices, the
 * conversation's layout and a personal Files-tree list. Each is now a key of the layered settings —
 * `appearance.mode`, `appearance.*`, `appearance.conversation`, `appearance.editors`,
 * `appearance.renderers`, `files.hidden` — and the person's own answer is the layer read after every
 * other one, so moving it there changes nothing anybody sees. It:
 *
 *  - reads the old fields the way the old file was read — FORGIVINGLY, per field, a size clamped and
 *    an unreadable value dropped — so what arrives in the strict layer is always something it accepts;
 *  - writes only what DIFFERS from the default, so the personal layer states what the person chose
 *    rather than pinning every default above the shared root and the project;
 *  - appends the personal Files-tree patterns to the personal layer's `files.hidden`;
 *  - keeps whatever the personal layer already says over what it moves (a person who has since set
 *    something there said it later), and writes that file BEFORE taking the fields out of the old one,
 *    so a stop between the two re-runs to the same answer;
 *  - removes the fields from `user-settings.json`, leaving every other key exactly as it was.
 *
 * A file with none of the fields is not touched, which is what makes it idempotent. Before anything
 * reads the look: the app runs it as its service is constructed, which is before a window exists, and
 * every open of a project runs it too, so the CLI's first open moves the file as well. Once every
 * machine has started once, this module and its calls go (the standing rule: migrate the data, then
 * delete the reader of the old form).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "@declarative-ai/log";
import {
  BUCKET_STYLES,
  EDITOR_KINDS,
  EDITOR_KNOBS,
  LINE_HEIGHT,
  PALETTES,
  RENDER_VIEWS,
  SEQUENTIAL_BATCH_LAYOUTS,
  TAB_SIZES,
  THEME_MODES,
  clampSize,
  defaultAppearance,
  defaultConversationLook,
  defaultEditorLook,
  defaultEditors,
  defaultRendererChoice,
  mergeConfigDocuments,
  readJsonFile,
  type Appearance,
  type BucketStyle,
  type ConversationLook,
  type EditorKind,
  type EditorLook,
  type JairaBasePaths,
  type Palette,
  type RendererChoices,
  type SequentialBatchLayout,
  type ThemeMode,
} from "@jaira/shared";

const log = createLogger("jaira.persistence.user-settings-migration");

/** The fields of `user-settings.json` that moved, and nothing else in that file is touched. */
export const MOVED_USER_SETTINGS = ["theme", "appearance", "conversation", "editors", "renderers", "filesHidden"] as const;

/** What one run moved: the keys it wrote into the personal layer, and the fields it took out. */
export interface UserSettingsMigrationReport {
  personalFile: string;
  /** Dotted paths written into `personal-settings.json` — only what differed from the default. */
  wrote: string[];
  /** The fields removed from `user-settings.json`. */
  removed: string[];
}

/**
 * Move the look out of `user-settings.json`. Returns what it did, or `undefined` when there was nothing
 * to move — no file, an unreadable one (which the app already reads as the defaults), or none of the
 * fields.
 */
export function migrateUserSettings(base: Pick<JairaBasePaths, "userSettingsFile" | "personalSettingsFile">): UserSettingsMigrationReport | undefined {
  if (!existsSync(base.userSettingsFile)) return undefined;
  let raw: unknown;
  try {
    raw = readJsonFile(base.userSettingsFile);
  } catch {
    return undefined;
  }
  const old = objectOf(raw);
  const removed = MOVED_USER_SETTINGS.filter((key) => old[key] !== undefined);
  if (removed.length === 0) return undefined;

  const appearance = movedAppearance(old);
  const hidden = movedHidden(old["filesHidden"]);
  const wrote = [
    ...Object.keys(appearance).flatMap((key) => {
      const value = appearance[key];
      return key === "editors" || key === "renderers" || key === "conversation"
        ? Object.keys(objectOf(value)).map((inner) => `appearance.${key}.${inner}`)
        : [`appearance.${key}`];
    }),
    ...(hidden.length > 0 ? ["files.hidden"] : []),
  ];

  if (wrote.length > 0) {
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(base.personalSettingsFile)) existing = objectOf(readJsonFile(base.personalSettingsFile));
    } catch (e) {
      // Left as it is, and so is the old file: writing over a layer nobody can read would lose it, and
      // the open that reads it next says what is wrong with it.
      log.warn(`not moving the look out of ${base.userSettingsFile}: ${base.personalSettingsFile} cannot be read — ${(e as Error).message}`);
      return undefined;
    }
    // What the layer already says wins: it was said later than anything in the old file.
    const next = objectOf(mergeConfigDocuments(Object.keys(appearance).length > 0 ? { appearance } : {}, existing));
    if (hidden.length > 0) {
      const files = objectOf(existing["files"]);
      const had = Array.isArray(files["hidden"]) ? (files["hidden"] as unknown[]).filter((p): p is string => typeof p === "string") : [];
      next["files"] = { ...files, hidden: [...had, ...hidden.filter((p) => !had.includes(p))] };
    }
    mkdirSync(dirname(base.personalSettingsFile), { recursive: true });
    writeFileSync(base.personalSettingsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  const kept = Object.fromEntries(Object.entries(old).filter(([key]) => !(MOVED_USER_SETTINGS as readonly string[]).includes(key)));
  writeFileSync(base.userSettingsFile, `${JSON.stringify(kept, null, 2)}\n`, "utf8");
  log.info(`moved the look out of ${base.userSettingsFile} into ${base.personalSettingsFile}`, { wrote, removed });
  return { personalFile: base.personalSettingsFile, wrote, removed: [...removed] };
}

/** The `appearance` block the old fields add up to — only what differs from the default. */
function movedAppearance(old: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const theme = old["theme"];
  if (THEME_MODES.includes(theme as ThemeMode) && theme !== "light") out["mode"] = theme;

  if (old["appearance"] !== undefined) {
    const read = readAppearance(old["appearance"]);
    const fresh = defaultAppearance();
    for (const key of Object.keys(fresh) as Array<keyof Appearance>) {
      if (JSON.stringify(read[key]) !== JSON.stringify(fresh[key])) out[key] = read[key];
    }
  }

  if (old["conversation"] !== undefined) {
    const read = readConversationLook(old["conversation"]);
    if (read.sequentialBatches !== defaultConversationLook().sequentialBatches) out["conversation"] = { sequentialBatches: read.sequentialBatches };
  }

  if (old["editors"] !== undefined) {
    const read = readEditors(old["editors"]);
    const editors: Record<string, Record<string, unknown>> = {};
    for (const kind of EDITOR_KINDS) {
      const fresh = defaultEditorLook(kind);
      // Only the knobs the surface honours: the strict layer refuses the others by name.
      for (const knob of EDITOR_KNOBS[kind]) {
        if (read[kind][knob] !== fresh[knob]) (editors[kind] ??= {})[knob] = read[kind][knob];
      }
    }
    if (Object.keys(editors).length > 0) out["editors"] = editors;
  }

  if (old["renderers"] !== undefined) {
    const renderers: Record<string, Record<string, unknown>> = {};
    for (const [key, choice] of Object.entries(readRenderers(old["renderers"]))) {
      // Written the way a person would write it: a field only where it says something.
      const line: Record<string, unknown> = {};
      if (choice.read !== null) line["read"] = choice.read;
      if (choice.write !== null) line["write"] = choice.write;
      if (choice.off.length > 0) line["off"] = choice.off;
      const theme = Object.fromEntries(RENDER_VIEWS.filter((view) => choice.theme[view] !== null).map((view) => [view, choice.theme[view]]));
      if (Object.keys(theme).length > 0) line["theme"] = theme;
      renderers[key] = line;
    }
    if (Object.keys(renderers).length > 0) out["renderers"] = renderers;
  }
  return out;
}

/** The personal Files-tree patterns, trimmed and de-duplicated, as the old reader kept them. */
function movedHidden(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && p !== "!"),
    ),
  ];
}

// --- the old file's readers, kept only for this migration ------------------------------------------

/** Per field, keeping whatever is readable. */
function readConversationLook(raw: unknown): ConversationLook {
  const out = defaultConversationLook();
  const batches = objectOf(raw)["sequentialBatches"];
  if (SEQUENTIAL_BATCH_LAYOUTS.includes(batches as SequentialBatchLayout)) out.sequentialBatches = batches as SequentialBatchLayout;
  return out;
}

/**
 * The typography and palette, per field, keeping whatever is readable. A size out of range is CLAMPED
 * rather than dropped, as the old reader did — the strict layer then accepts it.
 */
function readAppearance(raw: unknown): Appearance {
  const out = defaultAppearance();
  const doc = objectOf(raw);
  const families = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? [...new Set(value.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter((f) => f.length > 0))]
      : undefined;
  out.appFamily = families(doc["appFamily"]) ?? out.appFamily;
  out.dataFamily = families(doc["dataFamily"]) ?? out.dataFamily;
  for (const key of ["sizeApp", "sizeData", "sizeEditor"] as const) {
    const size = doc[key];
    if (typeof size === "number" && Number.isFinite(size)) out[key] = clampSize(key, size);
  }
  out.advanced = doc["advanced"] === true;
  out.smoothing = doc["smoothing"] === true;
  const editorTheme = doc["editorTheme"];
  if (typeof editorTheme === "string" && editorTheme.length > 0) out.editorTheme = editorTheme;
  const palette = doc["palette"];
  if (PALETTES.includes(palette as Palette)) out.palette = palette as Palette;
  const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  out.laneColors = flag(doc["laneColors"]);
  out.statusWash = flag(doc["statusWash"]);
  const buckets = doc["buckets"];
  out.buckets = BUCKET_STYLES.includes(buckets as BucketStyle) ? (buckets as BucketStyle) : null;
  return out;
}

/** The per-editor looks, per surface and per knob; a tab size snapped, a line height clamped. */
function readEditors(raw: unknown): Record<EditorKind, EditorLook> {
  const out = defaultEditors();
  const doc = objectOf(raw);
  for (const kind of EDITOR_KINDS) {
    const look = objectOf(doc[kind]);
    for (const knob of EDITOR_KNOBS[kind]) {
      const value = look[knob];
      if (knob === "tabSize") {
        if (typeof value === "number" && TAB_SIZES.includes(value)) out[kind].tabSize = value;
      } else if (knob === "lineHeight") {
        if (typeof value === "number" && Number.isFinite(value)) out[kind].lineHeight = Math.min(LINE_HEIGHT.max, Math.max(LINE_HEIGHT.min, value));
      } else if (typeof value === "boolean") {
        out[kind][knob] = value;
      }
    }
  }
  return out;
}

/** The renderer choices, per entry; a line that says nothing is dropped. */
function readRenderers(raw: unknown): RendererChoices {
  const out: RendererChoices = {};
  for (const [key, value] of Object.entries(objectOf(raw))) {
    if (!key.includes(":")) continue;
    const doc = objectOf(value);
    const choice = defaultRendererChoice();
    const read = doc["read"];
    const write = doc["write"];
    if (typeof read === "string" && read.length > 0) choice.read = read;
    if (typeof write === "string" && write.length > 0) choice.write = write;
    if (Array.isArray(doc["off"])) choice.off = [...new Set(doc["off"].filter((id): id is string => typeof id === "string" && id.length > 0))];
    const theme = objectOf(doc["theme"]);
    for (const view of RENDER_VIEWS) {
      const named = theme[view];
      if (typeof named === "string" && named.length > 0) choice.theme[view] = named;
    }
    if (choice.read !== null || choice.write !== null || choice.off.length > 0 || choice.theme.read !== null || choice.theme.write !== null) out[key] = choice;
  }
  return out;
}

function objectOf(raw: unknown): Record<string, unknown> {
  return raw === null || typeof raw !== "object" || Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
}
