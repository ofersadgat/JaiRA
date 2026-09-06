/**
 * Real TextMate grammars for Monaco — the layer VSCode adds and the standalone editor does not.
 *
 * Monaco IS VSCode's editor, and it renders exactly what VSCode renders. What the npm package does
 * not ship is VSCode's TOKEN SOURCE: it comes with Monarch tokenizers, which are small regex state
 * machines, where VSCode runs `.tmLanguage` grammars through Oniguruma and layers the language
 * service's semantic tokens on top. Measured, for `function f(x: boolean): string { const y = true; if (y) return x; }`,
 * Monarch's answer is:
 *
 * ```
 * function=keyword  boolean=keyword  string=keyword  const=keyword  true=keyword  if=keyword
 * f=identifier      x=identifier
 * ```
 *
 * Seven words, one class — so a theme that colours `storage.type`, `support.type.primitive`,
 * `constant.language` and `keyword.control` four different ways paints them all one way, and a
 * parameter cannot be told from any other identifier at all. That is the whole of why an editor
 * painted in a theme's exact colours still did not look like that theme.
 *
 * This module closes it. Shiki carries the grammars and an inlined Oniguruma WASM build — inlined
 * matters: nothing is fetched, which is what makes it work under Electron's `file://` origin — and
 * `shikiToMonaco` hands Monaco a tokenizer that speaks scopes. The themes stop being a mapping and
 * become the theme: `monokaiLight.ts` is the `.tmTheme` file's own settings, and the other three are
 * Shiki's copies of their VSCode themes.
 *
 * ## Everything here is late and optional, on purpose
 *
 * The highlighter is a megabyte of grammar and a WASM module, and it is asynchronous. So:
 *
 *  - Nothing waits for it. An editor opens on the Monarch tokenizer with the hand-mapped palette
 *    (`editorThemes.ts`, `monacoTokens.ts`) — the right colours, coarser classes — and re-tokenizes
 *    when this arrives. What a person sees is the same code twice, the second time with more of it
 *    coloured, rather than a blank pane while a WASM module loads.
 *  - A failure is a shrug. No grammar for a language, a WASM build that will not instantiate, a
 *    theme that will not parse: the editor keeps the tokenizer it already had. An app that refused
 *    to open a file because a syntax colouring was unavailable would be a much worse trade.
 *  - Languages load ONE AT A TIME, as files are opened. The alternative is every grammar this app
 *    can colour, in one chunk, for a person who only ever opens TypeScript.
 */
import type * as monacoNs from "monaco-editor";

/** Which Shiki grammar answers for a Monaco language id — the ids differ in two places, so this maps. */
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  // Monaco calls it `shell`; every grammar in the world calls it `shellscript`.
  shell: () => import("shiki/langs/shellscript.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  dockerfile: () => import("shiki/langs/docker.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
};

/**
 * Which TextMate theme each of our ids is, and where it comes from.
 *
 * Three are Shiki's bundled copies of the VSCode themes, under the names Shiki gives them — which is
 * why the map exists at all, since `one-dark-pro` is what it calls the theme we call `one-dark`. The
 * fourth has no bundled copy and is the file itself (see `themes/monokaiLight.ts`), named to match
 * our id so nothing has to translate it back.
 */
const THEMES: Record<string, { name: string; load: () => Promise<unknown> }> = {
  "monokai-light": {
    name: "monokai-light",
    load: () => import("./themes/monokaiLight").then((m) => m.MONOKAI_LIGHT_TM),
  },
  monokai: { name: "monokai", load: () => import("shiki/themes/monokai.mjs") },
  "solarized-light": { name: "solarized-light", load: () => import("shiki/themes/solarized-light.mjs") },
  "one-dark": { name: "one-dark-pro", load: () => import("shiki/themes/one-dark-pro.mjs") },
  /**
   * "Follows the app", as a real theme rather than an absence.
   *
   * Monaco answers that preference with its built-in `vs` / `vs-dark`, which are its renditions of
   * VSCode's Light+ and Dark+ — so these are the same two palettes under the names Shiki publishes
   * them by, and a person on "Follows the app" gets the colours they already had rather than losing
   * colouring altogether. Resolved from the window's theme, not chosen directly: see
   * {@link textmateThemeFor}.
   */
  "app-light": { name: "light-plus", load: () => import("shiki/themes/light-plus.mjs") },
  "app-dark": { name: "dark-plus", load: () => import("shiki/themes/dark-plus.mjs") },
};

/**
 * What Shiki calls a grammar this app knows by a Monaco language id.
 *
 * Two disagreements, both in the same direction: Monaco names the language after the file and the
 * grammar world names it after the syntax. Everything not here is the same word in both vocabularies.
 */
const LANG_NAMES: Record<string, string> = { shell: "shellscript", dockerfile: "docker" };

/**
 * The theme id to actually draw in, given what a person chose.
 *
 * One indirection, for one preference: `app` is not a palette, it is a statement that the palette
 * should follow the window — so it resolves to one of the two above, and everything else is already
 * a theme and answers for itself.
 */
export function textmateThemeFor(chosen: string | undefined, dark: boolean): string {
  // `dark` is passed rather than read off the document, which keeps this a mapping: the window's
  // theme is a fact the caller already has, and a pure function of two words is one a test can ask
  // about without a DOM to stand it in.
  if (chosen === undefined || chosen === "" || chosen === "app") return dark ? "app-dark" : "app-light";
  return chosen;
}

/** The Shiki theme name a chosen id resolves to, or `undefined` for one with no TextMate theme. */
export function textmateThemeName(id: string): string | undefined {
  return THEMES[id]?.name;
}

/**
 * The highlighter, once, and the two things it has to be asked about.
 *
 * A single instance for the whole window: it carries the WASM engine and every grammar loaded so
 * far, and a second one would be a second megabyte for nothing.
 */
let highlighter: {
  loadTheme: (t: unknown) => Promise<void>;
  loadLanguage: (l: unknown) => Promise<void>;
  getLoadedLanguages: () => string[];
  getLoadedThemes: () => string[];
  /** Coloured HTML with the colours INLINE — the whole reason a read-only view needs no editor. */
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
} | null = null;
let starting: Promise<void> | null = null;
const asked = new Set<string>();
const watchers = new Set<() => void>();

/**
 * Themes the highlighter has actually loaded — and the reason this is tracked rather than asked.
 *
 * `shikiToMonaco` REPLACES `monaco.editor.setTheme` with one that looks the name up in the
 * highlighter and throws for anything it does not have. That is a bigger claim than it sounds: from
 * the moment the bridge installs, the only legal argument to `setTheme` anywhere in this app is a
 * theme Shiki has loaded — not our own pre-TextMate fallbacks, and not Monaco's built-in `vs`.
 * Passing one throws, which is exactly what it did: `Theme 'jaira-monokai' not found`, from the
 * observer that repaints on a theme change.
 *
 * So the name to use has to be answerable before it is used, which is {@link textmateThemeInUse}.
 */
const loadedThemes = new Set<string>();

/**
 * Monaco's own `setTheme`, kept so the bridge is always installed over IT.
 *
 * `shikiToMonaco` binds whatever it finds and replaces it, and this runs again every time a grammar
 * is added — so without this the patches would nest, each one calling the last, and a theme change
 * would walk a chain of wrappers that grew with every file opened.
 */
let plainSetTheme: ((name: string) => void) | undefined;

/**
 * The theme name Monaco can safely be put on right now.
 *
 * `preferred` when the highlighter has it; otherwise any theme it does have, which keeps the editors
 * on the last palette that worked while a newly chosen one loads. `undefined` means the bridge is
 * not installed yet — and only then may a caller use a name of its own, because `setTheme` is still
 * Monaco's own and knows them.
 */
export function textmateThemeInUse(preferred: string | undefined): string | undefined {
  if (preferred !== undefined && loadedThemes.has(preferred)) return preferred;
  for (const name of loadedThemes) return name;
  return undefined;
}

/** Be told when a grammar or a theme has landed, so a live editor can re-apply its theme. */
export function onTextMate(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

function announce(): void {
  for (const watch of [...watchers]) watch();
}

/**
 * Make sure a language and a theme are available to Monaco, loading whatever is missing.
 *
 * Idempotent and fire-and-forget: callers state what they are about to draw and carry on drawing it.
 * Everything below is guarded by `asked`, so a hundred fenced blocks in one transcript produce one
 * grammar load between them.
 */
export function ensureTextMate(monaco: typeof monacoNs, language: string, themeId: string): void {
  if (THEMES[themeId] === undefined && GRAMMARS[language] === undefined) return;
  const key = `${language}|${themeId}`;
  if (asked.has(key)) return;
  asked.add(key);
  void load(monaco, language, themeId).catch(complain);
}

/**
 * Say it once, out loud, and then stop.
 *
 * The failure this exists for cost a round trip: a bare `catch(() => undefined)` swallowed a CSP
 * refusal, so the app fell back to Monaco's own tokenizer and looked subtly wrong with nothing
 * anywhere saying why — while the snapshot harness, which had no CSP, showed the real grammars and
 * certified a rendering the app could not produce.
 *
 * Degrading quietly is still right for the PERSON: an editor that opens in slightly coarser colours
 * is not worth a dialog. Degrading quietly for the DEVELOPER is what made this invisible, so the
 * console gets the reason, once per session, with the two things worth checking first.
 */
let complained = false;
function complain(reason: unknown): void {
  if (complained) return;
  complained = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[jaira] TextMate highlighting is unavailable; editors will use Monaco's own tokenizer. " +
      "Most likely the Content-Security-Policy is missing 'wasm-unsafe-eval' (index.html), " +
      "which WebAssembly instantiation needs.",
    reason,
  );
}

/**
 * One load per thing, however many callers ask for it.
 *
 * Keyed rather than guarded by a boolean, because the answer a caller needs is "it is there NOW" and
 * two blocks of the same language in one transcript arrive within a frame of each other. Without the
 * shared promise the second would start a second load of the same megabyte and colour itself from a
 * half-built highlighter.
 */
const loads = new Map<string, Promise<void>>();
function once(key: string, run: () => Promise<void>): Promise<void> {
  const already = loads.get(key);
  if (already !== undefined) return already;
  const started = run();
  loads.set(key, started);
  return started;
}

/** The highlighter, with a grammar and a theme in it — or null where it could not be built. */
async function ready(
  language: string | undefined,
  themeId: string | undefined,
): Promise<NonNullable<typeof highlighter> | null> {
  // One creation, however many callers arrive while it is happening — `starting` is the lock.
  if (highlighter === null) {
    starting ??= start();
    await starting;
  }
  const live = highlighter;
  if (live === null) return null;
  const theme = themeId === undefined ? undefined : THEMES[themeId];
  const grammar = language === undefined ? undefined : GRAMMARS[language];
  if (theme !== undefined) await once(`theme:${theme.name}`, async () => live.loadTheme(await theme.load()));
  if (grammar !== undefined && language !== undefined) {
    await once(`lang:${language}`, async () => live.loadLanguage(await grammar()));
  }
  return live;
}

/**
 * Colour a block of source, in ONE palette, without an editor anywhere near it.
 *
 * The point of this over `monaco.editor.colorize` is where the colours end up. Monaco emits `.mtkN`
 * classes whose meaning is a global stylesheet — one theme for the whole window, and changing it
 * repaints everything — where this emits the colours INLINE. So ten readings of ten types in ten
 * different palettes are ten independent renderings, which is exactly what a per-type theme has to
 * be able to mean.
 *
 * Null for a language with no grammar or a theme with no file, and null when the highlighter cannot
 * be built at all: the caller shows the same characters uncoloured, which is a rendering.
 */
export async function colorize(text: string, language: string, themeId: string): Promise<string | null> {
  if (GRAMMARS[language] === undefined || THEMES[themeId] === undefined) return null;
  try {
    const live = await ready(language, themeId);
    if (live === null) return null;
    return live.codeToHtml(text, { lang: LANG_NAMES[language] ?? language, theme: THEMES[themeId]!.name });
  } catch (reason) {
    complain(reason);
    return null;
  }
}

async function load(monaco: typeof monacoNs, language: string, themeId: string): Promise<void> {
  const live = await ready(language, themeId);
  if (live === null) return;
  // AFTER each load rather than once at the end: `shikiToMonaco` registers a tokenizer for every
  // language the highlighter currently has, so it has to be re-run as the set grows. Over Monaco's
  // OWN `setTheme` each time — see {@link plainSetTheme}.
  const { shikiToMonaco } = await import("@shikijs/monaco");
  plainSetTheme ??= monaco.editor.setTheme.bind(monaco.editor);
  monaco.editor.setTheme = plainSetTheme;
  shikiToMonaco(live as never, monaco as never);
  // Only now: a name is safe to pass to `setTheme` once the bridge that will be asked about it has
  // been told about the theme. Recording it earlier would be a window in which the answer is wrong.
  for (const name of live.getLoadedThemes()) loadedThemes.add(name);
  announce();
}

/** Create the highlighter with nothing in it — the theme and the grammar follow, per caller. */
async function start(): Promise<void> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
  ]);
  highlighter = (await createHighlighterCore({
    themes: [],
    langs: [],
    // The INLINED build. The alternative fetches `onig.wasm` at runtime, which is a request this app
    // cannot make: the renderer is loaded from `file://`, and a packaged Electron app has no origin
    // to resolve it against.
    engine: createOnigurumaEngine(import("shiki/wasm")),
  })) as unknown as typeof highlighter;
}
