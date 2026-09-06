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
   * How each editing surface looks — see {@link EditorLook}.
   *
   * This is where `wrapJson` went. It was one boolean for one editor, on the argument that word wrap
   * is "the same KIND of thing as the theme"; that argument was right and it was never only about
   * JSON. Every editor in the app has the same handful of questions to answer — does it number its
   * lines, does it wrap, how far apart are they — and answering them one boolean at a time is how a
   * settings file grows a field per editor per knob. A file written before this existed still says
   * `wrapJson`, and {@link parseEditors} reads it into `editors.json.wrap` once; nothing else needs
   * to know the field ever existed.
   */
  editors: Record<EditorKind, EditorLook>;
  /**
   * Which renderer draws a file type, where more than one can — see `app/renderer/fileTypes.ts`.
   *
   * Keyed `"<mime>:<kind>"` for one type, or `"family:<family>:<kind>"` for a whole family of them,
   * and read in that order: a type's own line, then its family's, then whatever the app registers
   * first. ABSENT is the common case — this map holds DISAGREEMENTS, not the table — which is what
   * keeps a change to the app's own best answer reaching everybody who never had an opinion.
   *
   * A key naming a renderer that no longer exists is ignored rather than repaired, on the same terms
   * as every other value in this file: a preference nobody can satisfy is not a reason to refuse the
   * ones that can be.
   *
   * Here rather than in a project's `settings.json` for the reason the rest of this file is: whether
   * you would rather read markdown rendered or as its source is a fact about you, not about the
   * checkout, and it should not arrive through a pull request.
   */
  renderers: RendererChoices;
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
  /**
   * Which palette the EDITORS are painted in — the id of a theme, or `app` for the window's own.
   *
   * A STRING rather than a union, and the list lives in the renderer (`editorThemes.ts`) where the
   * colours are. This file cannot check an id and should not try: it would mean the palettes moving
   * here, where nothing reads them, so that a preference file could be validated against a list it
   * will outlive anyway. The renderer falls back to the default for an id it does not have, which is
   * the same rule the renderer choices follow one field down.
   *
   * Beside `sizeEditor` and `advanced` rather than in `editors`, and for the same reason those two
   * are here: it is one answer for every editing surface, not one per surface. It has to be. Monaco
   * treats a theme as a global — `setTheme` repaints every editor in the page — and a diff pane and
   * a code pane in the same window painted from different palettes would read as a rendering fault
   * rather than as a preference anyway.
   */
  editorTheme: string;
}

/**
 * What the editors are painted in when nobody has said — Monokai Light.
 *
 * A THEME rather than "follows the window", which is a product decision and worth stating as one:
 * an editor is where code is read, code has been coloured by its own palettes for forty years, and
 * an app whose editors are painted in its chrome's two greys is an app that has decided a person's
 * syntax colours for them by not offering any. `app` remains one of the choices for whoever wants
 * the window to be one palette throughout.
 *
 * Here rather than in the renderer's registry because `defaultAppearance` has to name it, and a
 * default that lives on the other side of the settings boundary is a default the parser cannot state.
 */
export const DEFAULT_EDITOR_THEME = "monokai-light";

/**
 * Which of a file's two views a preference is about.
 *
 * A document is drawn twice and the two are not the same question: `read` is the view that cannot be
 * typed into, `write` is the one that can. Every kind of rendering is therefore picked twice, and a
 * renderer that does not write can only ever answer the first.
 *
 * WHERE those two go is not decided here and deliberately is not decidable here. A surface may show
 * only the reading, only the editor, one control that toggles between them, or both at once; this
 * file says which renderer each view IS, and the surface spends that however it lays itself out.
 */
export type RenderView = "read" | "write";

/** In the order a control asks about them: what you get, then what you can change. */
export const RENDER_VIEWS: readonly RenderView[] = ["read", "write"];

/**
 * One person's answer for one type and one kind of rendering.
 *
 * Every field is an override and every field may be absent, which is the point: a document holding
 * `{}` and a document holding nothing at all mean the same thing, and both mean "whatever this app
 * thinks best". That is what lets the app's own answer improve for everybody who never disagreed.
 */
export interface RendererChoice {
  /** The renderer drawing the view that cannot be typed into, or `null` for the app's own. */
  read: string | null;
  /** The renderer drawing the view that can. Only a renderer that WRITES may be named here. */
  write: string | null;
  /**
   * Renderers taken off this type's menu — not offered, and never resolved to.
   *
   * All of them means the kind is off for this type: the app draws nothing of that kind rather than
   * falling back to one that was refused. An empty list is the normal state and is not written.
   */
  off: string[];
  /**
   * The palette each view is drawn in, where the renderer drawing it has one.
   *
   * Keyed by view rather than by type, because a theme is a property of the RENDERER and the
   * renderer was chosen per view: the reading of a JSON file and its editor are two picks, and two
   * palettes. `null` is the app's default (`DEFAULT_EDITOR_THEME`), and a renderer with no palette
   * of its own — the data tree, a form, a table, a board — ignores this entirely.
   */
  theme: Record<RenderView, string | null>;
}

/**
 * The preferences map: `"<mime>:<kind>"` for a type, `"family:<family>:<kind>"` for a family of them.
 *
 * Two key shapes and one map, rather than two maps, because they are read as one chain — the type's
 * own line, then its family's — and splitting them would put half of one answer in each of two
 * places. The kinds and families are the renderer's vocabulary (`app/renderer/fileTypes.ts`), which
 * is why the key is an opaque string here: this file stores the disagreement, it does not adjudicate
 * what a valid one is.
 */
export type RendererChoices = Record<string, RendererChoice>;

/** Nothing said, about anything — what every unwritten key means. */
export function defaultRendererChoice(): RendererChoice {
  return { read: null, write: null, off: [], theme: { read: null, write: null } };
}

/**
 * A change to one {@link RendererChoice} — one statement at a time.
 *
 * Every field is optional and an absent field means UNTOUCHED, which is the distinction that makes
 * this a patch rather than a value: `null` is a thing a person can say (take my preference back, use
 * the app's own), and the writer must be able to tell it from a field this caller had no opinion
 * about. A control that had to send the whole choice would quietly undo the three settings it was
 * not about.
 */
export interface RendererPatch {
  read?: string | null;
  write?: string | null;
  off?: readonly string[];
  theme?: Partial<Record<RenderView, string | null>>;
}

/**
 * One key and what to do to it — the unit a settings screen changes things in.
 *
 * A LIST of these travels together, because one gesture is routinely several keys: setting a whole
 * family writes the family's line and deletes the per-type lines that disagreed with it, and those
 * have to land as one write. Sent separately they would be several round trips through the settings
 * file, and a failure between two of them would leave a family half-agreed.
 */
export interface RendererEdit {
  key: string;
  /** `null` deletes the key outright — "I have no opinion about this after all". */
  edit: RendererPatch | null;
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
    editorTheme: DEFAULT_EDITOR_THEME,
  };
}

/**
 * The editing surfaces a person can style separately, as the app actually has them.
 *
 * FOUR, and the list is a statement about implementations rather than about file types. There is no
 * "TypeScript editor" and no "YAML editor" — a `.ts` file and a `.yaml` file are the same Monaco
 * pane with a different grammar, and offering to style them apart would be offering a control that
 * writes to one place twice. What genuinely differ are the four components underneath:
 *
 *  - **code** — the Monaco pane, plus the plain box that a type with no grammar falls back to.
 *  - **markdown** — CodeMirror with the live-preview decorations.
 *  - **json** — the schema-aware editor: a textarea over a coloured layer, styled by CSS.
 *  - **diff** — the two-sided Monaco panes a review is read in.
 *
 * They are not equally capable, which is why {@link EDITOR_KNOBS} exists rather than one flat shape
 * that every surface promises to honour. A minimap is a Monaco feature; the JSON editor has no
 * gutter to number. A control that a surface would silently ignore is worse than no control, so the
 * table says which questions each one can actually answer and the pane draws only those.
 */
export type EditorKind = "code" | "markdown" | "json" | "diff";

/** In the order the settings pane lists them: what you edit most, first. */
export const EDITOR_KINDS: readonly EditorKind[] = ["code", "markdown", "json", "diff"];

/**
 * How one editing surface looks.
 *
 * Eight questions, and every one of them was already answered somewhere in the app — hard-coded in
 * an options object, in a CodeMirror theme, or in two lines of CSS. That is the whole change here:
 * the answers move from the components to this file, and the defaults below are exactly what those
 * components did before, so a person who never opens the pane sees no difference at all.
 */
export interface EditorLook {
  /** A numbered gutter. */
  lineNumbers: boolean;
  /** Break a long line at the pane's edge rather than scrolling sideways. */
  wrap: boolean;
  /** Monaco's scaled-down overview of the whole file, down the right-hand edge. */
  minimap: boolean;
  /** The faint vertical rules that mark each level of indentation. */
  indentGuides: boolean;
  /** Mark the line the caret is on. */
  currentLine: boolean;
  /** Draw spaces and tabs as dots and arrows. */
  whitespace: boolean;
  /**
   * Tint matching brackets in rotating colours.
   *
   * OFF, which is not Monaco's default and is the point. Monaco ships this enabled, painting every
   * bracket pair in its own gold / pink / blue — three colours that come from nowhere in the theme
   * the rest of the editor is painted in, and the single most visible way an editor stops looking
   * like the theme it is set to. A person who wants it can have it; what they should not get is a
   * palette they never chose arriving underneath the one they did.
   */
  brackets: boolean;
  /** How many columns a tab occupies — see {@link TAB_SIZES}. */
  tabSize: number;
  /** Line spacing, as a multiple of the editor's font size — see {@link LINE_HEIGHT}. */
  lineHeight: number;
}

export type EditorKnob = keyof EditorLook;

/**
 * Which questions each surface can actually answer.
 *
 * The two Monaco surfaces answer all eight because Monaco has an option for each. CodeMirror has no
 * minimap and no indent guides without an extension this app does not load, and the JSON editor is
 * a textarea over a `<pre>`: it can wrap, and it can be spaced, and that is the honest end of the
 * list. A knob missing here is drawn as `—` in the pane and read by nothing.
 */
export const EDITOR_KNOBS: Record<EditorKind, readonly EditorKnob[]> = {
  code: ["lineNumbers", "wrap", "minimap", "indentGuides", "currentLine", "whitespace", "brackets", "tabSize", "lineHeight"],
  diff: ["lineNumbers", "wrap", "minimap", "indentGuides", "currentLine", "whitespace", "brackets", "tabSize", "lineHeight"],
  markdown: ["lineNumbers", "wrap", "currentLine", "tabSize", "lineHeight"],
  json: ["wrap", "tabSize", "lineHeight"],
};

/** Whether a knob means anything for a surface — the one question {@link EDITOR_KNOBS} is asked. */
export function editorKnobApplies(kind: EditorKind, knob: EditorKnob): boolean {
  return EDITOR_KNOBS[kind].includes(knob);
}

/**
 * The tab widths offered.
 *
 * Three rather than a number field: a tab is 2, 4 or 8 columns wide in every codebase anybody has
 * ever worked in, and a stepper that can land on 7 is a stepper that will.
 */
export const TAB_SIZES: readonly number[] = [2, 4, 8];

/** The bounds line spacing is held inside, as a multiple of the font size. */
export const LINE_HEIGHT = { min: 1.1, max: 2.2, step: 0.05 } as const;

/**
 * What each surface does today, stated as data.
 *
 * Read these against the components and they are a transcript rather than a preference: Monaco is
 * created with `minimap: {enabled: false}` and `renderLineHighlight: "none"`, the markdown editor is
 * created with `EditorView.lineWrapping` and no gutter, and `1.55`/`1.6`/`1.5` are the three line
 * heights the stylesheet and the CodeMirror theme already carried. Changing a default here changes
 * the app for everybody who has not touched the control, which is exactly what a default is for —
 * and the reason none of them was changed while they moved.
 */
export function defaultEditorLook(kind: EditorKind): EditorLook {
  const base: EditorLook = {
    lineNumbers: true,
    wrap: false,
    minimap: false,
    indentGuides: true,
    currentLine: false,
    whitespace: false,
    // See {@link EditorLook.brackets}: Monaco's own default is `true`, and this is one of the two
    // places in this file where a default is a CORRECTION of the component's rather than a
    // transcript of it. It is stated here rather than argued at the call site because the reason is
    // about the theme, and the theme is what this whole block is in service of.
    brackets: false,
    // Two, not Monaco's four: this app colours code with `colorize({tabSize: 2})` everywhere it is
    // read, and an editor that disagreed with the reading of the same file by two columns was a
    // difference nobody chose.
    tabSize: 2,
    lineHeight: 1.5,
  };
  if (kind === "markdown") {
    // A gutter of line numbers beside live-previewed prose is a gutter beside a document, which is
    // not what anybody wants from a markdown editor; wrapping is not optional for prose so much as
    // what prose IS, and it is the one default here that would be strange either way.
    return { ...base, lineNumbers: false, wrap: true, lineHeight: 1.6 };
  }
  // The JSON editor's coloured layer and its textarea have to lay text out identically, so their
  // spacing is one number in the stylesheet — 1.55 — and this is it.
  if (kind === "json") return { ...base, lineNumbers: false, lineHeight: 1.55 };
  return base;
}

export function defaultEditors(): Record<EditorKind, EditorLook> {
  return {
    code: defaultEditorLook("code"),
    markdown: defaultEditorLook("markdown"),
    json: defaultEditorLook("json"),
    diff: defaultEditorLook("diff"),
  };
}

export function defaultSettings(): JairaSettings {
  return {
    theme: "light",
    ui: defaultUiState(),
    appearance: defaultAppearance(),
    editors: defaultEditors(),
    renderers: {},
    projects: [],
    filesHidden: [],
  };
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
    ui: parseUiState(doc["ui"]),
    appearance: parseAppearance(doc["appearance"]),
    // The legacy field travels IN rather than being read beside the new one — see `editors`.
    editors: parseEditors(doc["editors"], doc["wrapJson"] === true),
    renderers: parseRenderers(doc["renderers"]),
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
  // Any non-empty word, checked by whoever draws it — this file has no registry of palettes and an
  // id it refused would be an id a future release could not add. The renderer falls back to the
  // default for anything it does not recognise.
  const editorTheme = doc["editorTheme"];
  if (typeof editorTheme === "string" && editorTheme.length > 0) out.editorTheme = editorTheme;
  return out;
}

/**
 * Parse the per-editor looks, per surface and per knob, keeping whatever is readable.
 *
 * `legacyWrap` is the `wrapJson` boolean this block replaced, and it is applied ONLY where the new
 * document says nothing about the JSON editor's wrapping. That ordering is the whole migration: a
 * person who turned wrap on before the change keeps it, a person who has since turned it off in the
 * new place keeps THAT, and the stale field in their file — which nothing rewrites away, because
 * `writeSettings` merges rather than replaces — cannot come back and overrule them.
 */
function parseEditors(raw: unknown, legacyWrap: boolean): Record<EditorKind, EditorLook> {
  const out = defaultEditors();
  const doc = objectOf(raw);
  const stated = objectOf(doc["json"]);
  if (legacyWrap && typeof stated["wrap"] !== "boolean") out.json.wrap = true;
  for (const kind of EDITOR_KINDS) {
    const look = objectOf(doc[kind]);
    for (const knob of EDITOR_KNOBS[kind]) {
      const value = look[knob];
      if (knob === "tabSize") {
        // Snapped to what the control offers rather than clamped: a hand-written 3 is not a size
        // this app draws, and rounding it to 2 is a choice somebody can see and correct.
        if (typeof value === "number" && TAB_SIZES.includes(value)) out[kind].tabSize = value;
      } else if (knob === "lineHeight") {
        // Clamped, like a font size and for the same reason: a 0.2 line height is an editor whose
        // rows overlap, with no control visible to drag it back.
        if (typeof value === "number" && Number.isFinite(value)) {
          out[kind].lineHeight = Math.min(LINE_HEIGHT.max, Math.max(LINE_HEIGHT.min, value));
        }
      } else if (typeof value === "boolean") {
        out[kind][knob] = value;
      }
    }
  }
  return out;
}

/**
 * Parse the renderer choices, keeping the entries that are plausibly one.
 *
 * Nothing here checks that the key names a type this app knows or that the value names a renderer
 * that exists — neither question is answerable in `shared`, where there is no registry, and both are
 * answered harmlessly at the point of use: an unrecognised choice falls through to the default. What
 * IS checked is the shape, so a hand-edited file cannot put an object where a renderer id goes.
 */
/**
 * The renderer preferences, per key, accepting the shape that came before.
 *
 * The older file said `"application/json:data": "form"` — one renderer for one type and kind, with
 * no way to say that a file READS one way and is WRITTEN another. That value migrates to the read
 * view, which is what it always meant: it was resolved for the half of the panel that shows the
 * document, and the editor was picked by a rule nobody could see or change.
 *
 * Forgiving per ENTRY, like the rest of this file. A malformed line costs its own type rather than
 * the other forty, because this is a document a person may have edited by hand and one bad key is
 * not a reason to hand them back the defaults for everything.
 */
function parseRenderers(raw: unknown): RendererChoices {
  const out: RendererChoices = {};
  for (const [key, value] of Object.entries(objectOf(raw))) {
    if (!key.includes(":")) continue;
    // The value the older file held. Not a special case for long: it becomes the same shape here,
    // and everything downstream only ever sees the new one.
    if (typeof value === "string") {
      if (value.length > 0) out[key] = { ...defaultRendererChoice(), read: value };
      continue;
    }
    const doc = objectOf(value);
    const choice = defaultRendererChoice();
    const read = doc["read"];
    const write = doc["write"];
    if (typeof read === "string" && read.length > 0) choice.read = read;
    if (typeof write === "string" && write.length > 0) choice.write = write;
    if (Array.isArray(doc["off"])) {
      choice.off = [...new Set(doc["off"].filter((id): id is string => typeof id === "string" && id.length > 0))];
    }
    const theme = objectOf(doc["theme"]);
    for (const view of RENDER_VIEWS) {
      const named = theme[view];
      if (typeof named === "string" && named.length > 0) choice.theme[view] = named;
    }
    // A line that says nothing is not a line. Dropping it here is what keeps "unset stays unwritten"
    // true after a round trip through this parser.
    if (choice.read !== null || choice.write !== null || choice.off.length > 0 || choice.theme.read !== null || choice.theme.write !== null) {
      out[key] = choice;
    }
  }
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
