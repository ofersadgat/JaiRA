/**
 * Settings → Appearance's model: its choices, what its rows are called and say, how a value of the
 * look is spelt, and a row's place in the layers — everything `appearancePane.tsx` draws FROM, in a
 * module of its own so the universal copy (decision 0015) draws from the same.
 */
import { statesPath, type Appearance, type BucketStyle, type ConfigLayer, type ConfigView, type SequentialBatchLayout, type ThemeMode, type UsageFigures, type WorkNotes, type WorkRows } from "@jaira/shared/browser";
import { EDITOR_THEMES, EDITOR_THEME_APP } from "./editorThemes";
import { PALETTE_CARDS } from "./paletteCardsModel";
import { shortValue, type RowLayer } from "./settingsRows";

/**
 * Faces worth offering by name.
 *
 * A short list rather than an enumeration of what is installed: there is no way to enumerate system
 * fonts without a permission prompt, and the answer would be four hundred entries long in an order
 * nobody chose. What CAN be answered is whether a named one is here — measured, the same way the
 * proportional check is — so the menu says `installed` beside the ones that will actually render and
 * greys the rest rather than pretending the list is the machine's.
 *
 * Anything not here is typed in: the menu's last row takes a name, and the chip proves whether it
 * resolved, which is the same feedback a longer list would have given.
 */
export const SUGGESTED_APP = ["DM Sans", "Inter", "Segoe UI", "Helvetica Neue", "IBM Plex Sans", "Roboto"];
export const SUGGESTED_DATA = ["JetBrains Mono", "Cascadia Code", "SF Mono", "Fira Code", "IBM Plex Mono", "Consolas", "Menlo"];

export const MODES: ReadonlyArray<readonly [label: string, mode: ThemeMode]> = [
  ["Light", "light"],
  ["Dark", "dark"],
  ["System", "system"],
];

export const BUCKET_CHOICES: ReadonlyArray<readonly [string, BucketStyle]> = [
  ["Box", "box"],
  ["Line", "line"],
];

export const USAGE_CHOICES: ReadonlyArray<readonly [string, UsageFigures]> = [
  ["Off", "off"],
  ["Number", "number"],
  ["Ring", "ring"],
  ["Both", "both"],
];

export const WORK_ROW_CHOICES: ReadonlyArray<readonly [string, `${WorkRows}`]> = [
  ["None", "0"],
  ["1", "1"],
  ["3", "3"],
  ["5", "5"],
];

export const WORK_NOTE_CHOICES: Array<[string, WorkNotes]> = [
  ["Show", "show"],
  ["Hide phases of only these", "hide-groups"],
  ["Hide phases and stretches of only these", "hide-blocks"],
  ["Hide everywhere", "hide"],
];

export const BATCH_CHOICES: ReadonlyArray<readonly [string, SequentialBatchLayout]> = [
  ["One after another", "stacked"],
  ["Side by side", "band"],
];

/**
 * How the Appearance rows sit in the layers — handed in by the caller, which knows the layer being
 * edited and how to write it. Absent draws the rows as plain controls, with no ↺.
 */
export interface AppearanceLayering {
  /** Whether the layer being edited states a path (`appearance.palette`, …). */
  stated: (path: string) => boolean;
  /** Take paths out of the layer being edited, so they inherit again. */
  inherit: (paths: readonly string[]) => void;
  /** Nothing on the page may be changed — a write in flight, or a layer that cannot be written. */
  locked: boolean;
}

/** A value of the look in the words its row uses — for the "instead of … from …" line. */
export function lookWords(value: unknown, path: string): string {
  const field = path.replace(/^appearance\./, "");
  const own = "the palette's own";
  switch (field) {
    case "mode":
      return MODES.find(([, mode]) => mode === value)?.[0].toLowerCase() ?? shortValue(value, path);
    case "palette":
      return PALETTE_CARDS[value as Appearance["palette"]]?.label ?? shortValue(value, path);
    case "laneColors":
    case "statusWash":
      return value === null || value === undefined ? own : value === true ? "on" : "off";
    case "buckets":
      return value === null || value === undefined ? own : value === "line" ? "a line" : "a box";
    case "conversation.sequentialBatches":
      return BATCH_CHOICES.find(([, layout]) => layout === value)?.[0].toLowerCase() ?? shortValue(value, path);
    case "conversation.usageFigures":
      return USAGE_CHOICES.find(([, figures]) => figures === value)?.[0].toLowerCase() ?? shortValue(value, path);
    case "conversation.workPhases":
    case "conversation.workThinking":
      return value === true ? "on" : value === false ? "off" : shortValue(value, path);
    case "conversation.workNotes":
      return WORK_NOTE_CHOICES.find(([, notes]) => notes === value)?.[0].toLowerCase() ?? shortValue(value, path);
    case "conversation.workRows":
      return value === 0 ? "none" : typeof value === "number" ? `${value} rows` : shortValue(value, path);
    case "appFamily":
    case "dataFamily":
      return Array.isArray(value) && value.length > 0 ? value.join(", ") : "JaiRA's own face";
    case "sizeApp":
    case "sizeData":
    case "sizeEditor":
      return typeof value === "number" ? `${value} px` : shortValue(value, path);
    case "advanced":
      return value === true ? "a size of its own" : "following the data font";
    case "editorTheme":
      return value === EDITOR_THEME_APP ? "following the window" : (EDITOR_THEMES.find((theme) => theme.id === value)?.label ?? shortValue(value, path));
    default:
      return shortValue(value, path);
  }
}

/** One row's place in the layers, from the `appearance.*` fields it writes — absent without `layered`. */
export function appearanceRowLayer(layered: AppearanceLayering | undefined, ...fields: string[]): RowLayer | undefined {
  if (layered === undefined) return undefined;
  const paths = fields.map((field) => `appearance.${field}`);
  return {
    paths,
    stated: paths.some((path) => layered.stated(path)),
    onInherit: () => layered.inherit(paths),
    disabled: layered.locked,
    format: lookWords,
  };
}

/** A row's words: its name, its one sentence, and what did not fit, behind an ⓘ. */
export interface RowWords {
  name: string;
  description: string;
  info?: string;
}

/** What each Appearance row is called and says, in the order the page draws them. */
export const APPEARANCE_ROWS = {
  laneColors: { name: "Lane colours", description: "Tint each column its own colour, so a step of the workflow is recognisable at a glance." },
  buckets: { name: "Columns", description: "A box around each column's cards, or a rule under its heading." },
  statusWash: { name: "Status wash", description: "Colour a whole card by what it is doing — running, waiting or failed. Finished cards fade." },
  sequentialBatches: {
    name: "Batches that ran in turn",
    description: "A fan-out whose elements ran one after another: down the page in the order they ran, or side by side as a band.",
    info: "A band is two columns, or tabs from three elements up — the way elements that ran at the same time are always drawn.",
  },
  batchPreview: { name: "Preview", description: "Two elements of one batch, as a run's conversation will draw them." },
  usageFigures: {
    name: "Usage figures",
    description: "How much of an account is used, after the model chip and in Connections: as a number, a ring, both, or not at all.",
    info: "A subscription shows the percent of its tightest window; an API key whose provider reports its credit, what is spent; any other key, what the conversation cost. The ring draws the same share, so either one alone says it. The conversation's own ring, at the composer's right, is not this setting.",
  },
  usagePreview: { name: "Preview", description: "The composer on a subscription, on a key whose provider reports its credit, and on a key whose provider does not." },
  workPhases: {
    name: "Group work into phases",
    description: "Cut the work between two messages where the agent stopped to think, and give each part a row of its own.",
    info: "A phase is named by what it did: Explored, Changed, Checked or Fixed. Off, the work is one row of chips over the latest steps.",
  },
  workRows: { name: "Rows shown while it works", description: "How many of the latest rows of the phase in progress stay rows while the agent is working. Its older steps are counted in its chips." },
  workThinking: {
    name: "Show thinking",
    description: "When the provider kept the model's reasoning, its first line follows the chips. Hover it to read the whole. Off, neighbouring phases with the same name become one.",
    info: "Most Claude reasoning arrives withheld; a phase with nothing to show simply has no line.",
  },
  workNotes: {
    name: "Rate limits and system notes",
    description: "Lines about the run rather than work: a rate limit waited out, a context injected, a hook that ran. Every step lists them whatever this says.",
    info: "Show: counted in the chips like any work. Hide phases of only these: counted, but a phase that has nothing else is left out, and a stretch that has nothing else shows only Every step. Hide phases and stretches of only these: the same, but such a stretch is not drawn at all. Hide everywhere: left out of the summary, and such a stretch is not drawn.",
  },
  workPreview: { name: "Preview", description: "One request's work, three times: early on, well into it, and when it is done. Hover a chip, a phase or Every step." },
  appFont: { name: "App font", description: "JaiRA's own words: the names of rooms, actions and states." },
  dataFont: { name: "Data font", description: "Everything else: paths, task titles, commands, counts." },
  editorSize: { name: "Editor size", description: "Editors follow the data font until you give them a size of their own." },
  editorTheme: {
    name: "Editor palette",
    description: "What every editor is painted in, where a file type has not been given one of its own.",
    info: "One answer for every editing surface: Monaco paints every editor on the page from one theme, so two palettes side by side would read as a fault. A file type can still be given its own under File types.",
  },
  smoothing: { name: "Smooth text", description: "Grayscale antialiasing, instead of the platform's own rendering." },
  textPreview: { name: "Preview", description: "Both voices side by side, as a file row and a task row draw them." },
} as const satisfies Record<string, RowWords>;

/** The Board section's preview row: what tasks look like in the chosen palette. */
export const boardPreviewWords = (palette: Appearance["palette"]): RowWords => ({ name: "Preview", description: `What tasks look like in ${PALETTE_CARDS[palette].label}, with the options above.` });

/** The Editor palette's choices: following the window, then every editor theme. */
export const editorThemeChoices = (): Array<[string, string]> => [["Follows the window", EDITOR_THEME_APP], ...EDITOR_THEMES.map((theme): [string, string] => [theme.label, theme.id])];

/**
 * Whether nothing on a Settings page may be changed: a write in flight, or "This project" with no
 * project open to write it to.
 */
export function settingsLocked(busy: boolean, layer: ConfigLayer, at: string | null): boolean {
  return busy || !(layer !== "project" || at !== null);
}

/**
 * The Appearance rows' place in the layers, for the page's layer: a row is stated where that layer's
 * document says anything at its path, and ↺ takes its paths out of that layer (`writeLook` with
 * nothing), so it inherits.
 */
export function appearanceLayeringOf(
  config: ConfigView | null,
  layer: ConfigLayer,
  locked: boolean,
  writeLook: (writes: readonly (readonly [string, undefined])[], layer: ConfigLayer) => void,
): AppearanceLayering {
  return {
    stated: (path) => statesPath(config?.[layer], path),
    inherit: (paths) => writeLook(paths.map((path) => [path, undefined] as const), layer),
    locked,
  };
}

/** The Conversation section's preview: two elements of one fan-out, each a file and what was said of it. */
export const BATCH_PREVIEW = [
  { session: "reviewer", file: "auth.ts", text: "The token is refreshed after it is read, so a request can go out with a stale one." },
  { session: "reviewer", file: "session.ts", text: "Nothing to change: the lock is taken before the session is written." },
] as const;

/** The Text section's preview: a file surface's three runs, and a task row's. */
export const TEXT_PREVIEW = {
  band: "Files",
  file: { title: "declarative-ai", path: "prompts/review.md", size: "4.2 kB" },
  task: { title: "tighten the sync lint", word: "running", meta: "40s · 3 turns" },
} as const;
