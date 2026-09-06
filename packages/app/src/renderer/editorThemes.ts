/**
 * The palettes an editor can be painted in (SHELL.md §6.2).
 *
 * A theme reaches two renderers that share nothing, which is what decides the shape of this file. A
 * spec is a small set of NAMED colours rather than a Monaco theme or a stylesheet, and each side
 * takes what it can use:
 *
 *  - **Monaco** is handed `defineTheme` rules built from it — see {@link monacoTheme}. It draws into
 *    a canvas from its own theme registry and can inherit nothing from CSS.
 *  - **The DOM editors** — CodeMirror's live preview, the JSON editor's two layers, the plain box —
 *    take the same colours as custom properties written onto the root by `applyAppearance`, which
 *    the stylesheet maps onto the app's own tokens inside those three containers and nowhere else.
 *
 * ## This is the SMALL half of a theme, and the reason it still exists
 *
 * A TextMate theme colours *scopes* — `entity.other.attribute-name`, `variable.parameter`,
 * `punctuation.definition.string.begin` — and the real thing is honoured scope for scope by the
 * TextMate layer (`textmate.ts`), which hands Monaco a tokenizer that speaks them and the theme file
 * itself to colour them with. That is what an editor here is painted by once it has loaded.
 *
 * A dozen colours are still needed, twice over, and neither has a TextMate engine to ask:
 *
 *  - **The DOM editors** are CSS. CodeMirror's markdown preview, the JSON editor's two layers and
 *    the plain box are painted from this app's `--tok-*` tokens, and a stylesheet cannot consult a
 *    grammar. They get these colours, mapped in one rule (`applyAppearance`, `styles.css`).
 *  - **Monaco, for the moment before the grammar lands.** The TextMate layer is a WASM module and a
 *    grammar per language, loaded on demand. An editor opens now, in these colours with Monaco's own
 *    tokenizer, and re-tokenizes when the real thing arrives — the same palette either way, with
 *    more of the code told apart the second time. It is also what stands permanently if the WASM
 *    will not instantiate at all.
 *
 * ## Provenance
 *
 * Stated per theme, and worth stating, because "why is this green slightly off" is a question with
 * two very different answers depending on where a value came from.
 */

/**
 * One palette. Ten colours, which is what both renderers can honestly use.
 *
 * Deliberately not a superset of everything a theme file states. `punctuation`, `invalid`,
 * `markup.deleted` and forty other scopes have no counterpart in a Monarch tokenizer or in this
 * app's `--tok-*` set, so a field for them would be a value nothing spends — and the next person
 * would reasonably assume it was being honoured.
 */
export interface EditorThemeSpec {
  /** Stable across builds: this is what `user-settings.json` stores. */
  id: string;
  label: string;
  /** Where these colours came from — a URL for the two that were read out of a theme file. */
  source: string;
  /** Which Monaco built-in it extends; also which `color-scheme` the DOM editors declare. */
  base: "vs" | "vs-dark";
  /** The editor's ground and its ink. */
  bg: string;
  text: string;
  /** A ground one step off the background: the JSON editor's gutter, a fold's fill. */
  panel: string;
  /** A rule, and the colour of a line number — the two pieces of chrome inside an editor. */
  line: string;
  dim: string;
  /** The tokens. `func` and `variable` are Monaco's alone; the DOM editors have no such class. */
  comment: string;
  string: string;
  number: string;
  keyword: string;
  type: string;
  func: string;
  variable: string;
  /** The selection, and the tint on the line holding the caret (which may carry alpha). */
  selection: string;
  lineHighlight: string;
  /**
   * Whether types and declaring words are italic, which most of these themes say and one does not.
   *
   * A flag rather than a `fontStyle` per token, because that is the whole of what these four themes
   * differ on: Monokai and its light twin italicise `storage.type` and `support.type`, One Dark
   * italicises the same, and Solarized italicises nothing. A theme that wanted italic strings would
   * need a field; none does, and inventing one now would be inventing a shape from one example.
   */
  italicTypes: boolean;
}

/**
 * The reserved id that is not a theme: the editors follow the window.
 *
 * What every editor in this app did before palettes existed, and still the right answer for somebody
 * who wants one palette everywhere. It writes no attribute, so no rule matches and the tokens the
 * editors inherit are the app's own — see `applyAppearance`.
 */
export const EDITOR_THEME_APP = "app";

/**
 * Monokai Light, read out of the file it is published as.
 *
 * `storage.type`, `support.type` and `support.class` share one colour there and are what a Monarch
 * `type` token stands for; `entity.name.function` and `entity.other.attribute-name` share another,
 * which is `func`. `variable.parameter` is the italic orange. The greys are the theme's own
 * `invisibles` and its comment colour rather than anything invented here.
 */
const MONOKAI_LIGHT: EditorThemeSpec = {
  id: "monokai-light",
  label: "Monokai Light",
  source: "github.com/anoff/vscode-monokai-light — themes/Monokai%20Light.tmTheme",
  base: "vs",
  bg: "#ffffff",
  text: "#000000",
  panel: "#f4f4f2",
  line: "#e0e0e0",
  dim: "#9f9f8f",
  comment: "#9f9f8f",
  string: "#f25a00",
  number: "#ae81ff",
  keyword: "#f92672",
  type: "#28c6e4",
  func: "#6aaf19",
  variable: "#fd971f",
  selection: "#c2e8ff",
  lineHighlight: "#a5a5a526",
  italicTypes: true,
};

/** Monokai, read out of the TextMate bundle it has been published in since 2007. */
const MONOKAI: EditorThemeSpec = {
  id: "monokai",
  label: "Monokai",
  source: "github.com/textmate/monokai.tmbundle — Themes/Monokai.tmTheme",
  base: "vs-dark",
  bg: "#272822",
  text: "#f8f8f2",
  panel: "#2f302a",
  line: "#49483e",
  dim: "#75715e",
  comment: "#75715e",
  string: "#e6db74",
  number: "#ae81ff",
  keyword: "#f92672",
  type: "#66d9ef",
  func: "#a6e22e",
  variable: "#fd971f",
  selection: "#49483e",
  lineHighlight: "#3e3d32",
  italicTypes: true,
};

/**
 * Solarized Light, from the palette its author publishes as the definition of it.
 *
 * The one theme here whose colours are a specification rather than a file: Solarized is sixteen
 * named values (`base03`…`base3`, and eight accents) and every implementation is a mapping of those
 * onto whatever it is colouring. This is that mapping for the tokens we have.
 */
const SOLARIZED_LIGHT: EditorThemeSpec = {
  id: "solarized-light",
  label: "Solarized Light",
  source: "ethanschoonover.com/solarized — the published sixteen-colour palette",
  base: "vs",
  bg: "#fdf6e3",
  text: "#657b83",
  panel: "#eee8d5",
  line: "#eee8d5",
  dim: "#93a1a1",
  comment: "#93a1a1",
  string: "#2aa198",
  number: "#d33682",
  keyword: "#859900",
  type: "#b58900",
  func: "#268bd2",
  variable: "#268bd2",
  selection: "#eee8d5",
  lineHighlight: "#eee8d5",
  italicTypes: false,
};

/** One Dark, from Atom's published palette — the dark counterpart most people already recognise. */
const ONE_DARK: EditorThemeSpec = {
  id: "one-dark",
  label: "One Dark",
  source: "Atom's One Dark — its published syntax palette",
  base: "vs-dark",
  bg: "#282c34",
  text: "#abb2bf",
  panel: "#21252b",
  line: "#3b4048",
  dim: "#5c6370",
  comment: "#5c6370",
  string: "#98c379",
  number: "#d19a66",
  keyword: "#c678dd",
  type: "#e5c07b",
  func: "#61afef",
  variable: "#e06c75",
  selection: "#3e4451",
  lineHighlight: "#2c313c",
  italicTypes: true,
};

/**
 * What the pane offers, in the order it offers them.
 *
 * Monokai Light leads because it is the default; the rest alternate light and dark so the list is
 * not two blocks. "Follows the app" is not in here — it is the absence of a theme, and the pane
 * states it as its own row above these.
 */
export const EDITOR_THEMES: readonly EditorThemeSpec[] = [MONOKAI_LIGHT, MONOKAI, SOLARIZED_LIGHT, ONE_DARK];

/**
 * The theme an id names, or the default — and `undefined` for the one id that is not a theme.
 *
 * A stored id this build does not have falls back to the DEFAULT rather than to "follow the app",
 * which is the same rule the renderer choices follow: a person is left looking at what a fresh
 * install looks like, which is a state they can see and correct, rather than at something that looks
 * like the setting was silently turned off.
 */
export function editorThemeSpec(id: string): EditorThemeSpec | undefined {
  if (id === EDITOR_THEME_APP) return undefined;
  return EDITOR_THEMES.find((theme) => theme.id === id) ?? EDITOR_THEMES[0];
}

/**
 * The Monaco theme a spec makes.
 *
 * The rules are the mapping described at the head of this file: TextMate scopes on the left of the
 * author's intent, Monarch's token names on the right of what this app's tokenizers emit. A rule's
 * token is matched by PREFIX, so `string` catches `string.escape` and `string.key.json` with it —
 * which is why the list is short and why the few places a longer name is wanted (a JSON key, an
 * attribute) state it explicitly after the shorter one.
 *
 * `inherit: true` so everything unstated comes from `vs` or `vs-dark`. A theme file colours forty
 * scopes and this maps ten; inheriting is what keeps the other thirty from falling back to black.
 */
export function monacoTheme(spec: EditorThemeSpec): {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
  colors: Record<string, string>;
} {
  const hex = (colour: string): string => colour.replace("#", "");
  return {
    base: spec.base,
    inherit: true,
    rules: [
      { token: "", foreground: hex(spec.text) },
      { token: "comment", foreground: hex(spec.comment) },
      { token: "string", foreground: hex(spec.string) },
      { token: "regexp", foreground: hex(spec.string) },
      { token: "number", foreground: hex(spec.number) },
      { token: "constant", foreground: hex(spec.number) },
      { token: "keyword", foreground: hex(spec.keyword) },
      { token: "operator", foreground: hex(spec.keyword) },
      /**
       * The three classes `monacoTokens.ts` splits out of `keyword`, without which they are all one
       * colour — which is the single biggest reason an editor painted in a theme's exact colours
       * still does not look like that theme in VSCode.
       *
       * `storage` and a primitive type share the type colour and the italics, because that is what
       * every one of these themes does with `storage.type` and `support.type`; a language constant
       * takes the number colour, which is `constant.language` in all four.
       */
      { token: "keyword.storage", foreground: hex(spec.type), ...(spec.italicTypes ? { fontStyle: "italic" } : {}) },
      { token: "type.primitive", foreground: hex(spec.type), ...(spec.italicTypes ? { fontStyle: "italic" } : {}) },
      { token: "constant.language", foreground: hex(spec.number) },
      // A tag is a keyword in every theme here: `<div>` and `if` are the same kind of word.
      { token: "tag", foreground: hex(spec.keyword) },
      { token: "type", foreground: hex(spec.type), ...(spec.italicTypes ? { fontStyle: "italic" } : {}) },
      { token: "predefined", foreground: hex(spec.type) },
      { token: "namespace", foreground: hex(spec.type) },
      { token: "function", foreground: hex(spec.func) },
      { token: "attribute.name", foreground: hex(spec.func) },
      { token: "annotation", foreground: hex(spec.func) },
      { token: "metatag", foreground: hex(spec.func) },
      { token: "variable", foreground: hex(spec.variable) },
      // The key of a JSON object, which is the one token this app draws more of than any other.
      // After `string`, because a longer name wins and a key is not a value.
      { token: "string.key", foreground: hex(spec.func) },
      { token: "type.identifier", foreground: hex(spec.type) },
      { token: "delimiter", foreground: hex(spec.text) },
    ],
    colors: {
      "editor.background": spec.bg,
      "editor.foreground": spec.text,
      "editor.lineHighlightBackground": spec.lineHighlight,
      "editor.selectionBackground": spec.selection,
      "editorCursor.foreground": spec.text,
      "editorLineNumber.foreground": spec.dim,
      "editorLineNumber.activeForeground": spec.text,
      "editorIndentGuide.background": spec.line,
      "editorIndentGuide.activeBackground": spec.dim,
      "editorWhitespace.foreground": spec.line,
      // The diff panes' own two grounds. Left to the base theme they are tuned for the base's
      // background, which is the one colour a theme always replaces.
      "diffEditor.insertedTextBackground": `${spec.func}22`,
      "diffEditor.removedTextBackground": `${spec.keyword}22`,
    },
  };
}

/**
 * The custom properties a theme publishes for the DOM editors, by the names the stylesheet reads.
 *
 * The mapping onto the app's own tokens (`--bg`, `--tok-string`) happens in CSS rather than here, so
 * that it happens INSIDE the three editor containers and nowhere else — a theme must not repaint the
 * window. See the `[data-editor-theme]` rule in `styles.css`.
 */
export function editorThemeVars(spec: EditorThemeSpec): Record<string, string> {
  return {
    "--ed-scheme": spec.base === "vs-dark" ? "dark" : "light",
    "--ed-bg": spec.bg,
    "--ed-panel": spec.panel,
    "--ed-text": spec.text,
    "--ed-dim": spec.dim,
    "--ed-line": spec.line,
    "--ed-tok-string": spec.string,
    "--ed-tok-number": spec.number,
    "--ed-tok-keyword": spec.keyword,
    "--ed-tok-type": spec.type,
    "--ed-tok-hint": spec.comment,
    "--ed-selection": spec.selection,
  };
}
