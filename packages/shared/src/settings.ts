/**
 * User settings — `~/.jaira/user-settings.json` (the shared base root, DESIGN §3).
 *
 * Deliberately NOT `settings.json`. That file describes how a PROJECT runs and is committed with it:
 * models, policy, executors, the search path. This one describes how the app looks to ONE person on
 * ONE machine, so it belongs to the base root and never to a checkout. Keeping the two apart is why
 * a theme preference cannot arrive through a pull request.
 *
 * The pair used to be `config.json` and `settings.json`, and those two words carried no direction —
 * nothing in "config" says it is the shared one, nothing in "settings" says it is the private one.
 * The qualifier does that work now.
 *
 * Everything here is types and pure functions, so the renderer can import it: the file is READ and
 * WRITTEN in the main process, and the parsed value crosses IPC.
 */

/**
 * How a project RUNS: models, executors, policy, artifacts, the search path.
 *
 * Layered — the base's is merged under a project's before parsing — and committed with the project,
 * because it describes the project rather than the person at it.
 *
 * Here rather than beside the rest of the `.jaira/` layout because the renderer needs it and
 * `paths.ts` is Node-only; it is re-exported from there, where the layout lives.
 */
export const SETTINGS_FILE_NAME = "settings.json";

/** The file this module is about — see the note above on why the names are a pair. */
export const USER_SETTINGS_FILE_NAME = "user-settings.json";

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
   * Unfolded branches, by tree id — the POSITIVE twin of {@link shut}, for a tree that defaults to
   * collapsed.
   *
   * A second map rather than a flag on the first, because the two are not the same question and the
   * reasoning behind `shut` is worth keeping intact. That reasoning — store what is folded, so a
   * branch created after the file was written is not hidden by a preference nobody expressed —
   * assumes a tree small enough that expanded is the sane default. The Files tree stopped being one
   * when it was rooted at the checkout: expanding everything by default draws thousands of rows of
   * `packages/`, and a folder appearing collapsed is then exactly right rather than a fault.
   *
   * So which map a tree uses is a statement about what its default IS, and reading the wrong one is
   * impossible: the ids live in different tables (`uiState.ts`), and a settings file written before
   * this existed has no entry here at all.
   */
  unfolded: Record<string, string[]>;
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
   * The projects this window had open when it was last closed, in the order they were opened.
   *
   * A window holds several projects at once (SHELL.md §2.2) and nothing evicts one, so "which
   * projects are open" is a statement a person makes by opening them — and until this existed it was
   * a statement the app forgot on every quit, leaving a window that had been worked in all week
   * opening on nothing.
   *
   * Here rather than in a project's `settings.json` for the reason everything else in this file is:
   * which checkouts one person has open on one machine is not a property of any of them, and a list
   * of absolute paths is the last thing that should arrive through a pull request. Oldest first, so
   * the last entry is the project opened most recently — which is where a restored window stands.
   *
   * Losing it costs a re-open and nothing else, so it is read the way the layout is: entries that no
   * longer name a project are dropped rather than raised (see `AppService.restore`).
   */
  projects: string[];
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
  /**
   * This person's additions to what the Files tree hides (`./hiddenPaths`).
   *
   * Applied AFTER `config.files.hidden`, and last match wins, so this list can do the two things a
   * shared one cannot: hide something only you find noisy, and reveal something the project hid.
   * `!system` is the second case and the reason the rule is ordered rather than a union — wanting to
   * read a run's journal is not a reason to edit a file everybody shares.
   *
   * Empty for almost everybody, and that is the intended shape: the defaults are already right, and
   * this is the escape hatch for when they are not.
   */
  filesHidden: string[];
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
  return { theme: "light", wrapJson: false, ui: defaultUiState(), appearance: defaultAppearance(), projects: [], filesHidden: [] };
}

/** No layout remembered yet — every control opens at its own default. */
export function defaultUiState(): JairaUiState {
  return { panes: {}, open: {}, modes: {}, shut: {}, unfolded: {}, seen: {} };
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
    projects: parseProjects(doc["projects"]),
    // Trimmed and de-duplicated, dropping anything that is not a usable pattern. Forgiving like the
    // rest of this file: one unreadable entry is no reason to reset what a person can see.
    filesHidden: Array.isArray(doc["filesHidden"])
      ? [
          ...new Set(
            (doc["filesHidden"] as unknown[])
              .filter((p): p is string => typeof p === "string")
              .map((p) => p.trim())
              .filter((p) => p.length > 0 && p !== "!"),
          ),
        ]
      : [],
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
  for (const [id, keys] of Object.entries(objectOf(doc["unfolded"]))) {
    // De-duplicated on the way in: the renderer treats these as sets, and a file that grew a
    // duplicate by hand should not make one row take two clicks to unfold.
    if (Array.isArray(keys)) ui.unfolded[id] = [...new Set(keys.filter((key): key is string => typeof key === "string"))];
  }
  for (const [taskId, at] of Object.entries(objectOf(doc["seen"]))) {
    // Finite and positive, like a pane size: this is compared against a task's `updatedAt`, and a
    // NaN or a negative from a hand-edited file would mark a row read forever or never.
    if (typeof at === "number" && Number.isFinite(at) && at > 0) ui.seen[taskId] = at;
  }
  return ui;
}

/**
 * The remembered project list, keeping only entries that are plausibly paths.
 *
 * Order-preserving and de-duplicated: the list is "what was open", and the same directory twice
 * would be one project opened twice — which the service treats as a no-op anyway, so keeping the
 * duplicate would only make the file lie about what happened. Nothing here checks the disk; whether
 * a path still names a project is a question for whoever opens it, and answering it in a pure parser
 * would make reading a preferences file depend on which drives are mounted.
 */
function parseProjects(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((dir): dir is string => typeof dir === "string").map((dir) => dir.trim()).filter((dir) => dir.length > 0))];
}

/** A JSON object as a record, or an empty one for anything else — including arrays and null. */
function objectOf(raw: unknown): Record<string, unknown> {
  return raw === null || typeof raw !== "object" || Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
}
