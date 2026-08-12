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
 */
export interface JairaUiState {
  /** Pane sizes in px, by splitter id — a width, or a height for the one horizontal divider. */
  panes: Record<string, number>;
  /** Disclosures by id: `true` is open. Absent ⇒ whatever the control opens as. */
  open: Record<string, boolean>;
  /** Folded branches, by tree id, each the list of row keys that are SHUT. */
  shut: Record<string, string[]>;
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
}

export function defaultSettings(): JairaSettings {
  return { theme: "light", wrapJson: false, ui: defaultUiState() };
}

/** No layout remembered yet — every control opens at its own default. */
export function defaultUiState(): JairaUiState {
  return { panes: {}, open: {}, shut: {} };
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
    ...(typeof baseDir === "string" && baseDir.length > 0 ? { baseDir } : {}),
  };
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
  for (const [id, keys] of Object.entries(objectOf(doc["shut"]))) {
    // De-duplicated on the way in: the renderer treats these as sets, and a file that grew a
    // duplicate by hand should not make one row take two clicks to unfold.
    if (Array.isArray(keys)) ui.shut[id] = [...new Set(keys.filter((key): key is string => typeof key === "string"))];
  }
  return ui;
}

/** A JSON object as a record, or an empty one for anything else — including arrays and null. */
function objectOf(raw: unknown): Record<string, unknown> {
  return raw === null || typeof raw !== "object" || Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
}
