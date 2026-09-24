/**
 * User settings — `~/.jaira/user-settings.json` (the shared base root, DESIGN §3) — and the
 * vocabulary of how the app LOOKS, which the layered `appearance` block (`./appearanceConfig`) is
 * written in.
 *
 * Deliberately NOT `settings.json`. That file describes how a PROJECT runs and is committed with it:
 * models, policy, executors, the search path. This one is the WINDOW's own state on one machine —
 * where its panes were left, what is folded, which conversations have been read, how loudly the log
 * talks, which projects were open — a cache of gestures rather than anything anyone authored.
 *
 * How the app looks used to live here too (the theme, the typography, the editors, the renderer
 * choices, the conversation's layout, a personal Files-tree list), and moved into the layered
 * configuration (2026-09-23): a look is a SETTING a project or the shared root may have an opinion
 * about, and the person's own opinion is the fourth layer, `personal-settings.json` — the same schema
 * as `settings.json`, read after every other layer. It is a file of its own rather than a key in this
 * one because this one has its own whole-file writer, and two writers of one file overwrite each
 * other. `@jaira/persistence` `migrateUserSettings` moved the old fields across.
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
import type { LogLevel, LogOverride, LogPolicy } from "./view";
import type { SecretSource } from "./executors";
import { FORGE_PROVIDERS, type ForgeProviderKind } from "./forge";

export const SETTINGS_FILE_NAME = "settings.json";

/** The file this module is about — see the note above on why the names are a pair. */
export const USER_SETTINGS_FILE_NAME = "user-settings.json";

/**
 * The fourth configuration layer — "Just you" — beside the other two in the shared root.
 *
 * The same schema as {@link SETTINGS_FILE_NAME}, merged after the shared root and the project, so what
 * it says wins everywhere on this machine and nowhere else: it is never in a checkout, and a pull
 * request cannot carry it.
 */
export const PERSONAL_SETTINGS_FILE_NAME = "personal-settings.json";

/** Which palette the renderer paints — light or dark, once `system` has been resolved. */
export type JairaTheme = "light" | "dark";

export const THEMES: readonly JairaTheme[] = ["light", "dark"];

/**
 * What a person CHOSE: light, dark, or `system` — follow the operating system, and follow it again
 * when it changes (the person's pick, 2026-09-23, after t3code's three mode tiles). Resolved to a
 * {@link JairaTheme} at the two places that paint: the renderer's root and main's window frame.
 */
export type ThemeMode = JairaTheme | "system";

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

/** The theme a mode paints, given whether the operating system is dark right now. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): JairaTheme {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

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
   * What the app keeps in its log, and what it drops before writing — see {@link LogPolicy}.
   *
   * A preference, because the right answer changes by the hour: the level that makes a run
   * diagnosable is the level that makes the panel unreadable the rest of the time, and the only
   * person who knows which of those today is, is the one looking at it. The Logs page edits this
   * directly, which is why it is here rather than in a project's `settings.json` — how loudly your
   * machine talks to you is not a property of a checkout.
   */
  logging: LogPolicy;
  /**
   * Where the shared base root lives, when it is not `~/.jaira`.
   *
   * Stored so the choice survives a restart without an environment variable. `JAIRA_HOME` still
   * wins when set: an explicit environment is how tests and one-off invocations point somewhere
   * else, and a saved preference must not silently override the command that launched the process.
   */
  baseDir?: string;
  /**
   * The forge tokens a sign-in through the browser stored, by secret NAME — see {@link ForgeSignInMark}.
   *
   * Here because it is a fact about this machine's secret store, and this is the one file that is
   * this machine's: the token itself is in the keychain (or the shared `.env.local`), which holds
   * values and nothing about them. Absent when there are none, which is almost everybody.
   */
  forgeSignIns?: Record<string, ForgeSignInMark>;
}

/**
 * A forge token that came from OAuth rather than from a paste — what Settings tags the box with,
 * and what renewing it needs.
 *
 * `source` is where it was WRITTEN, and the tag holds only while the secret chain still finds the
 * token there: a token pasted over it in the same place drops the mark, and one put somewhere the
 * chain reads first is simply a different token, so the check says `token` without anyone having to
 * clean up.
 */
export interface ForgeSignInMark {
  provider: ForgeProviderKind;
  host: string;
  source: SecretSource;
  /** Epoch ms of the sign-in. */
  at: number;
  /** Epoch ms the access token dies, when the forge said (GitLab's live two hours). */
  expiresAt?: number;
  /** The secret the refresh token is under, beside the access token and in the same store. */
  refreshCredential?: string;
}

/**
 * How the elements of a fan-out batch whose elements ran ONE AFTER ANOTHER are laid out in a
 * conversation: `"stacked"` draws them down the page in the order they ran, as any sequence of
 * states is drawn; `"band"` draws them across — two columns, or tabs from three up — the way
 * concurrent elements already are. A batch whose elements overlapped is a band either way.
 */
export type SequentialBatchLayout = "stacked" | "band";
export const SEQUENTIAL_BATCH_LAYOUTS: readonly SequentialBatchLayout[] = ["stacked", "band"];

/** The conversation's reading preferences — `appearance.conversation` (`./appearanceConfig`). */
export interface ConversationLook {
  sequentialBatches: SequentialBatchLayout;
}

/** Stacked: a batch reads as the sequence it was, until somebody asks otherwise. */
export function defaultConversationLook(): ConversationLook {
  return { sequentialBatches: "stacked" };
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
  /**
   * Which palette the WINDOW is painted in — see {@link Palette}. Independent of light and dark:
   * every palette has both, and `appearance.mode` still picks between them.
   */
  palette: Palette;
  /**
   * The three surface options, each `null` for "what the palette says" — see {@link surfaceOf}.
   *
   * Null rather than absent so a patch can put one back (`{ buckets: null }`) without an optional
   * field that `exactOptionalPropertyTypes` would refuse to be handed `undefined`. Choosing a palette
   * resets all three, which is what makes a palette arrive looking the way it was designed.
   */
  laneColors: boolean | null;
  buckets: BucketStyle | null;
  statusWash: boolean | null;
}

/**
 * The window's palettes (the person's pick, 2026-09-23, from the palette study).
 *
 * `ink` is the DEFAULT — the person's call — and `classic` is the one the app shipped with, kept byte
 * for byte: its tokens are the stylesheet's own `:root`, and choosing it removes the attribute rather
 * than writing one. The others are a token block and a handful of rules each, keyed on
 * `:root[data-palette]` in `styles.css`. Listed default first, which is the order the pane offers.
 */
export type Palette = "ink" | "classic" | "hairline" | "contrast" | "blueprint" | "pastel" | "pastel-rail" | "zinc";
export const PALETTES: readonly Palette[] = ["ink", "classic", "hairline", "contrast", "blueprint", "pastel", "pastel-rail", "zinc"];
export const DEFAULT_PALETTE: Palette = "ink";

/** A board column drawn as a box around its cards, or as a rule under its heading. */
export type BucketStyle = "box" | "line";
export const BUCKET_STYLES: readonly BucketStyle[] = ["box", "line"];

/** The three surface options with every one decided. */
export interface Surface {
  /** Each board column tinted its own colour, cycling through six. */
  laneColors: boolean;
  buckets: BucketStyle;
  /** A card washed in its status's colour — running, waiting, failed — and a finished one faded. */
  statusWash: boolean;
}

/**
 * What each palette was designed with. Ink rail's columns are rules rather than boxes, and pastel's
 * lanes are coloured; everything else is today's board.
 */
export const PALETTE_SURFACE: Record<Palette, Surface> = {
  classic: { laneColors: false, buckets: "box", statusWash: false },
  ink: { laneColors: false, buckets: "line", statusWash: false },
  hairline: { laneColors: false, buckets: "box", statusWash: false },
  contrast: { laneColors: false, buckets: "box", statusWash: false },
  blueprint: { laneColors: false, buckets: "box", statusWash: false },
  pastel: { laneColors: true, buckets: "box", statusWash: false },
  "pastel-rail": { laneColors: true, buckets: "box", statusWash: false },
  zinc: { laneColors: false, buckets: "box", statusWash: false },
};

/** The options as drawn: the person's choice where there is one, the palette's where there is not. */
export function surfaceOf(a: Appearance): Surface {
  const base = PALETTE_SURFACE[a.palette];
  return {
    laneColors: a.laneColors ?? base.laneColors,
    buckets: a.buckets ?? base.buckets,
    statusWash: a.statusWash ?? base.statusWash,
  };
}

/**
 * The colours Chromium paints the frame in before the document exists, per palette and theme:
 * `ground` is the palette's `--bg`, and `panel` / `dim` are what the OS draws the window controls on
 * and in. Here rather than in `main` because they are a copy of `styles.css`, and the copy should sit
 * beside the list of palettes it has to be kept in step with.
 */
export const PALETTE_FRAME: Record<Palette, Record<JairaTheme, { ground: string; panel: string; dim: string }>> = {
  classic: { light: { ground: "#f5f6f8", panel: "#ffffff", dim: "#5c6779" }, dark: { ground: "#0f1115", panel: "#161922", dim: "#8b93a7" } },
  ink: { light: { ground: "#f5f6fa", panel: "#ffffff", dim: "#5a5f7a" }, dark: { ground: "#0f1017", panel: "#171923", dim: "#8c90ab" } },
  hairline: { light: { ground: "#ffffff", panel: "#ffffff", dim: "#5b6474" }, dark: { ground: "#0d0f13", panel: "#0d0f13", dim: "#8d95a6" } },
  contrast: { light: { ground: "#ffffff", panel: "#ffffff", dim: "#3a3a3a" }, dark: { ground: "#000000", panel: "#000000", dim: "#c4c4c4" } },
  blueprint: { light: { ground: "#f7faff", panel: "#ffffff", dim: "#4e6d98" }, dark: { ground: "#0f3b7a", panel: "#134487", dim: "#b3cae9" } },
  pastel: { light: { ground: "#fbfaff", panel: "#ffffff", dim: "#6e6887" }, dark: { ground: "#1e1e2e", panel: "#24273a", dim: "#a6adc8" } },
  "pastel-rail": { light: { ground: "#fbfaff", panel: "#ffffff", dim: "#6e6887" }, dark: { ground: "#1e1e2e", panel: "#24273a", dim: "#a6adc8" } },
  zinc: { light: { ground: "#fcfcfc", panel: "#ffffff", dim: "#71717a" }, dark: { ground: "#0a0a0a", panel: "#121212", dim: "#8f8f8f" } },
};

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
    palette: DEFAULT_PALETTE,
    laneColors: null,
    buckets: null,
    statusWash: null,
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
    ui: defaultUiState(),
    projects: [],
    logging: defaultLogPolicy(),
  };
}

/**
 * `info` and no overrides — the app's account of itself, without the trace under it.
 *
 * `info` rather than `debug` because `debug` is where a run's state-by-state trace lives, and a
 * default that buries every other entry under it is a default that makes the panel worth less than
 * it was. Turning it up is one control away, and that is the right shape for a knob whose answer
 * depends entirely on what you are doing right now.
 */
export function defaultLogPolicy(): LogPolicy {
  return { minLevel: "info", overrides: [] };
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

const isLogLevel = (value: unknown): value is LogLevel => LOG_LEVELS.includes(value as LogLevel);

/**
 * Read the policy back, forgivingly — like everything else in this file.
 *
 * An override naming a level that does not exist, or a sampling rate outside 0..1, is DROPPED rather
 * than repaired: a rule nobody can satisfy is not a rule, and quietly rounding one into a rule that
 * can be satisfied would mean the app silently disagreeing with what the file says it should do.
 */
export function parseLogPolicy(raw: unknown): LogPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultLogPolicy();
  const doc = raw as { minLevel?: unknown; overrides?: unknown };
  const overrides = Array.isArray(doc.overrides)
    ? doc.overrides.flatMap((entry): LogOverride[] => {
        if (entry === null || typeof entry !== "object") return [];
        const o = entry as { match?: unknown; key?: unknown; minLevel?: unknown; samplingRate?: unknown };
        if (o.match !== "scope" && o.match !== "tag") return [];
        if (typeof o.key !== "string" || o.key.trim() === "") return [];
        if (!isLogLevel(o.minLevel)) return [];
        const rate = typeof o.samplingRate === "number" && o.samplingRate >= 0 && o.samplingRate <= 1 ? o.samplingRate : undefined;
        return [{ match: o.match, key: o.key.trim(), minLevel: o.minLevel, ...(rate === undefined || rate === 1 ? {} : { samplingRate: rate }) }];
      })
    : [];
  return {
    minLevel: isLogLevel(doc.minLevel) ? doc.minLevel : "info",
    // One rule per key per kind. A file with two rules for `run` has no defined answer, and the last
    // one written is the one the editor above would have shown.
    overrides: [...new Map(overrides.map((o) => [`${o.match}:${o.key}`, o])).values()],
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
 * app from opening. An unreadable field falls back to its default rather than throwing.
 */
export function parseSettings(raw: unknown): JairaSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultSettings();
  const doc = raw as Record<string, unknown>;
  const baseDir = doc["baseDir"];
  return {
    ui: parseUiState(doc["ui"]),
    projects: parseProjects(doc["projects"]),
    logging: parseLogPolicy(doc["logging"]),
    ...(typeof baseDir === "string" && baseDir.length > 0 ? { baseDir } : {}),
    ...withForgeSignIns(doc["forgeSignIns"]),
  };
}

/**
 * The marks, each kept only whole: a mark missing where its token went cannot say whether the chain
 * still finds it there, and a wrong "OAuth" tag is worse than a plain "token" one.
 */
function withForgeSignIns(raw: unknown): { forgeSignIns?: Record<string, ForgeSignInMark> } {
  const out: Record<string, ForgeSignInMark> = {};
  for (const [name, entry] of Object.entries(objectOf(raw))) {
    const mark = objectOf(entry);
    const { provider, host, source, at, expiresAt, refreshCredential } = mark;
    if (!(FORGE_PROVIDERS as readonly unknown[]).includes(provider)) continue;
    if (typeof host !== "string" || typeof source !== "string" || typeof at !== "number") continue;
    out[name] = {
      provider: provider as ForgeProviderKind,
      host,
      source: source as SecretSource,
      at,
      ...(typeof expiresAt === "number" ? { expiresAt } : {}),
      ...(typeof refreshCredential === "string" && refreshCredential.length > 0 ? { refreshCredential } : {}),
    };
  }
  return Object.keys(out).length > 0 ? { forgeSignIns: out } : {};
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
