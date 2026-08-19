/**
 * User settings — `~/.jaira/settings.json` (the shared base root, DESIGN §3).
 *
 * Deliberately NOT `config.json`. Project config describes how a project runs and is committed with
 * it: models, policy, executors, the search path. This file describes how the app looks to ONE
 * person on ONE machine, so it belongs to the base root and never to a checkout. Keeping the two
 * apart is why a theme preference cannot arrive through a pull request.
 *
 * Everything here is types and pure functions, so the renderer can import it: the file is READ and
 * WRITTEN in the main process, and the parsed value crosses IPC.
 */

/** Which palette the renderer paints. */
export type JairaTheme = "light" | "dark";

export const THEMES: readonly JairaTheme[] = ["light", "dark"];

/**
 * The window's layout, as this person last left it.
 *
 * Three maps rather than a field per control, and that is the whole design. A named field would mean
 * touching this file, `parseSettings`, and its tests every time a divider or a fold is added — which
 * is the cost that kept every one of them session-scoped in the first place. What a layout preference
 * actually is, in every case, is one of three things: how big a pane is, whether a disclosure is
 * open, or which branches of a tree are folded. So there are three maps, keyed by an id the renderer
 * owns (`uiState.ts`), and a new divider is a new constant and nothing else.
 *
 * `shut` is NEGATIVE — it lists what is folded, not what is open — because everything in this app
 * that has branches defaults to expanded. Storing the open ones would mean a branch created after
 * the file was written showed up collapsed, which is the one thing a remembered layout must never do
 * to something the person has not seen yet.
 *
 * Nothing here is required for the app to work: an absent id means the control's own default, so a
 * settings file from before this existed, or one hand-edited into nonsense, opens the app the way a
 * fresh install does.
 *
 * ## The fourth map is not a layout, and lives here anyway
 *
 * `seen` records which conversations have been read. That is plainly not "how big is this pane", so
 * it breaks the vocabulary above — but it is the same KIND of fact in every way that decides where a
 * value is stored: it belongs to one person on one machine, it is a cache of gestures rather than
 * anything anyone authored, and losing it costs a dot rather than a document. Putting it here also
 * gets it the renderer's two rules for free, and read-state needs both: the debounced write, so
 * scrolling a list is not a write per row, and "the window owns it after hydration", so a
 * `settings:read` from a project open cannot resurrect a mark somebody just cleared.
 */
export interface JairaUiState {
  /** Pane sizes in px, by splitter id — a width, or a height for the one horizontal divider. */
  panes: Record<string, number>;
  /** Disclosures by id: `true` is open. Absent ⇒ whatever the control opens as. */
  open: Record<string, boolean>;
  /**
   * Controls with more than two positions, by id — the chosen position as a plain word.
   *
   * Beside {@link open} rather than instead of it: most folds are a fold, and widening every one of
   * them to a string would cost every reader a comparison it does not need. A control that grew a
   * third position moves here and keeps its own id, so a settings file written before the change
   * carries an `open` entry this simply ignores — see `modeOf`.
   */
  modes: Record<string, string>;
  /** Folded branches, by tree id, each the list of row keys that are SHUT. */
  shut: Record<string, string[]>;
  /**
   * How far each conversation has been READ, by task id: the `updatedAt` of the newest turn the
   * person has actually had on screen.
   *
   * A timestamp rather than a boolean, because "read" is not a property of the conversation but of a
   * POSITION in it — a thread marked read stops being read the moment the agent says something else,
   * and a flag would have to be cleared by whatever noticed that, from wherever it noticed it.
   * Comparing against the row's own `updatedAt` needs nobody to clear anything.
   *
   * Absent ⇒ never opened, which reads as unread. That is the right default for a conversation
   * somebody started before this existed: it is a mark to clear, not a claim about the past.
   */
  seen: Record<string, number>;
}

export interface JairaSettings {
  /**
   * Light by default — an explicit product decision, not an inherited one. The window's own
   * background colour is set from this too, so a cold start does not flash the wrong palette.
   */
  theme: JairaTheme;
  /**
   * Where the window's panes and folds were left — see {@link JairaUiState}.
   *
   * Written WHOLE. `writeSettings` merges one level deep, so a partial `ui` would replace the maps
   * it omitted rather than adding to them; the renderer therefore always sends the complete object,
   * which it can, because it holds the live copy anyway.
   */
  ui: JairaUiState;
  /**
   * Where the shared base root lives, when it is not `~/.jaira`.
   *
   * Stored so the choice survives a restart without an environment variable. `JAIRA_HOME` still
   * wins when set: an explicit environment is how tests and one-off invocations point somewhere
   * else, and a saved preference must not silently override the command that launched the process.
   */
  baseDir?: string;
  /**
   * Whether the JSON editor wraps long lines.
   *
   * Here rather than in component state because it is the same KIND of thing as the theme: a display
   * preference belonging to one person on one machine, and one that would be irritating to re-set on
   * every file you opened. Off by default — an unwrapped editor keeps line numbers meaningful and
   * gives the end-of-line schema hints somewhere to sit.
   */
  wrapJson: boolean;
  /**
   * The two voices' faces and sizes — see {@link Appearance} and SHELL.md §6.
   *
   * Beside `theme` rather than inside `ui`, because it is the same kind of thing: a display
   * preference belonging to one person on one machine, and not a cache of gestures the way panes,
   * folds and read-marks are. It also has NAMED fields, which is exactly what `ui`'s three maps
   * exist to avoid — a font stack is not "how big is this pane".
   */
  appearance: Appearance;
}

/**
 * How the two voices are set, per person (SHELL.md §6).
 *
 * One family and one size per voice, because that is what the register system makes possible: every
 * register is a multiple of its voice's base, so one control moves a whole voice with every ratio
 * intact. A per-register control would be eleven sliders and no coherence.
 */
export interface Appearance {
  /**
   * Families to try BEFORE the default stack, in order.
   *
   * Prepend, never replace. A chosen face that lacks `⛔`, or box-drawing glyphs, or a script the
   * person reads, falls through to the platform stack instead of showing tofu — which is the failure
   * a text field for "font family" produces and cannot warn about. Empty ⇒ the default stack alone.
   */
  appFamily: string[];
  dataFamily: string[];
  /** The app voice's base, in px. Every `.app-*` register is a ratio of it. */
  sizeApp: number;
  /** The data voice's base, in px. Every `.data-*` register is a ratio of it. */
  sizeData: number;
  /**
   * The editor's own size, read ONLY when {@link advanced} is set.
   *
   * The simple/advanced split borrowed from t3code, where a terminal follows the code font until it
   * is told not to. Ours is the editor: Monaco, the diff panes and the JSON editor follow
   * `--size-data` until somebody separates them, because wanting bigger code and the same chrome is
   * a real want and wanting them to disagree by accident is not.
   */
  sizeEditor: number;
  advanced: boolean;
  /**
   * Grayscale antialiasing. Off by default — the platform's own rendering is the one a person's
   * other applications use, and matching it is worth more than any opinion we have about stem
   * darkening.
   */
  smoothing: boolean;
}

/** The bounds each size is clamped to, in px. See {@link clampAppearance}. */
export const SIZE_LIMITS = {
  sizeApp: { min: 11, max: 17, default: 12.5 },
  sizeData: { min: 10, max: 16, default: 12 },
  sizeEditor: { min: 10, max: 20, default: 13 },
} as const;

export function defaultAppearance(): Appearance {
  return {
    appFamily: [],
    dataFamily: [],
    sizeApp: SIZE_LIMITS.sizeApp.default,
    sizeData: SIZE_LIMITS.sizeData.default,
    sizeEditor: SIZE_LIMITS.sizeEditor.default,
    advanced: false,
    smoothing: false,
  };
}

export function defaultSettings(): JairaSettings {
  return { theme: "light", wrapJson: false, ui: defaultUiState(), appearance: defaultAppearance() };
}

/** No layout remembered yet — every control opens at its own default. */
export function defaultUiState(): JairaUiState {
  return { panes: {}, open: {}, modes: {}, shut: {}, seen: {} };
}

/**
 * The largest pane size that will be read back, in px.
 *
 * A stored size goes straight into a CSS custom property, so a corrupt or absurd number is a column
 * that has swallowed the window with no divider left on screen to drag it back. The splitters clamp
 * during a drag; this is the same guard for a value that arrived from a file rather than a gesture.
 */
const PANE_LIMIT = 4000;

/**
 * Parse the settings document.
 *
 * Forgiving where `parseConfig` is strict, and for a reason: a malformed *project* config is an
 * authoring error worth failing on, whereas an unreadable preferences file should never stop the
 * app from opening. An unknown theme falls back to the default rather than throwing.
 */
export function parseSettings(raw: unknown): JairaSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultSettings();
  const doc = raw as Record<string, unknown>;
  const theme = doc["theme"];
  const baseDir = doc["baseDir"];
  return {
    theme: THEMES.includes(theme as JairaTheme) ? (theme as JairaTheme) : "light",
    wrapJson: doc["wrapJson"] === true,
    ui: parseUiState(doc["ui"]),
    appearance: parseAppearance(doc["appearance"]),
    ...(typeof baseDir === "string" && baseDir.length > 0 ? { baseDir } : {}),
  };
}

/**
 * Parse the appearance preferences, per field, keeping whatever is readable.
 *
 * Same forgiveness as {@link parseUiState} and for the same reason: this is a preference file, not
 * something anyone authored, and one unreadable field is no reason to reset a person's whole
 * typography. A size out of range is CLAMPED rather than dropped — an 80px chrome is a window with
 * no visible controls, and a 2px one is the same window from the other direction.
 */
function parseAppearance(raw: unknown): Appearance {
  const out = defaultAppearance();
  const doc = objectOf(raw);
  const families = (value: unknown): string[] | undefined =>
    Array.isArray(value)
      ? // Trimmed, non-empty and de-duplicated: a stack is an ORDERED LIST of alternatives, and the
        // same family twice means the second entry can never be reached.
        [...new Set(value.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter((f) => f.length > 0))]
      : undefined;
  out.appFamily = families(doc["appFamily"]) ?? out.appFamily;
  out.dataFamily = families(doc["dataFamily"]) ?? out.dataFamily;
  for (const key of ["sizeApp", "sizeData", "sizeEditor"] as const) {
    const size = doc[key];
    if (typeof size === "number" && Number.isFinite(size)) out[key] = clampSize(key, size);
  }
  out.advanced = doc["advanced"] === true;
  out.smoothing = doc["smoothing"] === true;
  return out;
}

/** One size, held inside the bounds its control offers. */
export function clampSize(key: keyof typeof SIZE_LIMITS, size: number): number {
  const { min, max } = SIZE_LIMITS[key];
  return Math.min(max, Math.max(min, size));
}

/**
 * Parse the remembered layout, keeping only entries of the right shape.
 *
 * Per ENTRY rather than per map, deliberately. This document is a cache of gestures, not a
 * configuration anyone authored, so one unreadable value is not a reason to throw away the other
 * forty — an id whose meaning changed between versions should cost its own pane and nothing else.
 */
function parseUiState(raw: unknown): JairaUiState {
  const ui = defaultUiState();
  const doc = objectOf(raw);
  for (const [id, size] of Object.entries(objectOf(doc["panes"]))) {
    if (typeof size === "number" && Number.isFinite(size) && size > 0) ui.panes[id] = Math.min(size, PANE_LIMIT);
  }
  for (const [id, open] of Object.entries(objectOf(doc["open"]))) {
    if (typeof open === "boolean") ui.open[id] = open;
  }
  for (const [id, mode] of Object.entries(objectOf(doc["modes"]))) {
    // Any word, checked by whoever reads it: this file cannot know the positions a control has, and
    // an unknown one falls back to that control's default rather than being dropped here.
    if (typeof mode === "string") ui.modes[id] = mode;
  }
  for (const [id, keys] of Object.entries(objectOf(doc["shut"]))) {
    // De-duplicated on the way in: the renderer treats these as sets, and a file that grew a
    // duplicate by hand should not make one row take two clicks to unfold.
    if (Array.isArray(keys)) ui.shut[id] = [...new Set(keys.filter((key): key is string => typeof key === "string"))];
  }
  for (const [taskId, at] of Object.entries(objectOf(doc["seen"]))) {
    // Finite and positive, like a pane size: this is compared against a task's `updatedAt`, and a
    // NaN or a negative from a hand-edited file would mark a row read forever or never.
    if (typeof at === "number" && Number.isFinite(at) && at > 0) ui.seen[taskId] = at;
  }
  return ui;
}

/** A JSON object as a record, or an empty one for anything else — including arrays and null. */
function objectOf(raw: unknown): Record<string, unknown> {
  return raw === null || typeof raw !== "object" || Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
}
