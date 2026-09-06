/**
 * How each editing surface looks — the preference, and the channel it reaches a live editor on.
 *
 * Three properties carry this feature and none of them is visible from reading the type:
 *
 *  - **The defaults are a transcript, not a taste.** Every value in `defaultEditorLook` was a
 *    literal in a component before it was a setting, so an app nobody has configured must draw
 *    exactly what it drew before. A test that only checked the parser would let a default drift and
 *    change the app for everybody who never opened the pane.
 *  - **A knob a surface cannot honour is not offered.** `EDITOR_KNOBS` is what the pane draws from,
 *    so a mistake there is a switch that does nothing — the one failure a settings screen must not
 *    have, because it is invisible.
 *  - **The looks are pushed, not polled.** Monaco and CodeMirror are created once inside an effect
 *    that never re-runs, so a preference can only reach them as a notification. If the subscription
 *    breaks, nothing throws: the editors simply keep the look they were born with until the file is
 *    reopened, which is exactly the bug this feature was written to remove.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EDITOR_THEME,
  EDITOR_KINDS,
  EDITOR_KNOBS,
  LINE_HEIGHT,
  TAB_SIZES,
  defaultEditorLook,
  defaultAppearance,
  defaultEditors,
  editorKnobApplies,
  parseSettings,
  type EditorKind,
  type EditorLook,
} from "@jaira/shared";
import { applyAppearance } from "../src/renderer/appearance";
import { EDITOR_THEMES, EDITOR_THEME_APP, editorThemeSpec, monacoTheme } from "../src/renderer/editorThemes";
import { textmateThemeName } from "../src/renderer/textmate";
import { MONOKAI_LIGHT_TM } from "../src/renderer/themes/monokaiLight";
import { applyEditors, editorLook, onEditorLook } from "../src/renderer/editorLook";

const looksOf = (patch: Record<string, unknown>): Record<EditorKind, EditorLook> =>
  parseSettings({ editors: patch }).editors;

describe("what an untouched app is set in", () => {
  it("keeps the values the components had before they were settings", () => {
    // Read against the code they came out of: Monaco is created with the minimap off and no
    // current-line rule, and 1.55 / 1.6 / 1.5 are the three line heights the stylesheet and the
    // CodeMirror theme already carried. Changing one of these changes the app for everybody who
    // has never opened the pane, which is what a default is for — and why it is pinned here.
    expect(defaultEditorLook("code")).toMatchObject({ minimap: false, currentLine: false, lineNumbers: true, lineHeight: 1.5 });
    expect(defaultEditorLook("json")).toMatchObject({ wrap: false, lineHeight: 1.55 });
    // Prose wraps and is not numbered — the one surface whose defaults would be strange either way.
    expect(defaultEditorLook("markdown")).toMatchObject({ wrap: true, lineNumbers: false, lineHeight: 1.6 });
    // Two columns everywhere, because the app colours code with `colorize({tabSize: 2})` wherever it
    // is READ, and an editor that indented by four was disagreeing with the reading of the same file.
    for (const kind of EDITOR_KINDS) expect(defaultEditorLook(kind).tabSize).toBe(2);
  });

  it("offers a surface only the knobs it can actually honour", () => {
    // A minimap is Monaco's; the JSON editor is a textarea over a `<pre>` and has no gutter to
    // number. A switch the surface would ignore is worse than an absent one — an absence is a fact
    // about the editor, and a dead switch is a bug nobody can see.
    expect(editorKnobApplies("json", "minimap")).toBe(false);
    expect(editorKnobApplies("json", "lineNumbers")).toBe(false);
    expect(editorKnobApplies("markdown", "minimap")).toBe(false);
    expect(editorKnobApplies("code", "minimap")).toBe(true);
    expect(editorKnobApplies("diff", "whitespace")).toBe(true);
    // Every surface can be spaced and can be told how wide a tab is: those are the two the
    // stylesheet answers, so they hold even where the component is a textarea.
    for (const kind of EDITOR_KINDS) {
      expect(editorKnobApplies(kind, "tabSize"), kind).toBe(true);
      expect(editorKnobApplies(kind, "lineHeight"), kind).toBe(true);
    }
  });
});

describe("reading the preference back", () => {
  it("keeps the readable knobs of a half-broken document", () => {
    // Per KNOB, like the typography parser and the remembered layout: this is a preference file
    // rather than something anyone authored, and one bad value is no reason to reset an editor.
    const looks = looksOf({ code: { minimap: true, wrap: "yes", tabSize: 4 } });
    expect(looks.code.minimap).toBe(true);
    expect(looks.code.wrap).toBe(false);
    expect(looks.code.tabSize).toBe(4);
    // …and the three surfaces the document said nothing about are untouched.
    expect(looks.markdown).toEqual(defaultEditorLook("markdown"));
  });

  it("snaps a tab width to one the control offers, rather than clamping it", () => {
    // A hand-written 3 is not a width this app draws. Falling back to the default is a state
    // somebody can see and correct; drawing a 3-column tab nothing can set would not be.
    expect(looksOf({ code: { tabSize: 3 } }).code.tabSize).toBe(2);
    for (const size of TAB_SIZES) expect(looksOf({ code: { tabSize: size } }).code.tabSize).toBe(size);
  });

  it("clamps line spacing instead of dropping it", () => {
    // A 0.2 line height is an editor whose rows overlap, with no control on screen to drag it back
    // — the same argument that clamps a font size rather than refusing it.
    expect(looksOf({ code: { lineHeight: 0.2 } }).code.lineHeight).toBe(LINE_HEIGHT.min);
    expect(looksOf({ code: { lineHeight: 40 } }).code.lineHeight).toBe(LINE_HEIGHT.max);
    expect(looksOf({ code: { lineHeight: 1.8 } }).code.lineHeight).toBe(1.8);
  });

  it("ignores a knob the surface does not have, however the file spells it", () => {
    // The document may say anything; what is READ is `EDITOR_KNOBS`. A minimap written against the
    // JSON editor is a setting nothing could spend, and it must not come back out of the parser as
    // one — the pane derives its controls from the same table.
    expect(looksOf({ json: { minimap: true } }).json).toEqual(defaultEditorLook("json"));
    expect(EDITOR_KNOBS.json).not.toContain("minimap");
  });

  it("reads a settings file written before any of this existed", () => {
    expect(parseSettings({ theme: "dark" }).editors).toEqual(defaultEditors());
  });
});

describe("publishing a look to the editors already on screen", () => {
  /** A root to write onto, standing in for `document.documentElement`. */
  const root = (): HTMLElement => {
    const el = { style: new Map<string, string>() };
    return {
      style: {
        setProperty: (name: string, value: string) => el.style.set(name, value),
        getPropertyValue: (name: string) => el.style.get(name) ?? "",
      },
    } as unknown as HTMLElement;
  };

  it("publishes the two knobs the stylesheet has to know about, per surface", () => {
    // Spacing and tab width reach the two editors made of DOM as custom properties, because those
    // two are drawn by CSS rather than by an options object. Per KIND rather than one pair for the
    // app: the JSON editor's two layers have to lay text out identically to each other and to
    // nothing else, and the markdown editor's spacing is a decision about prose.
    const el = root();
    const looks = defaultEditors();
    looks.json = { ...looks.json, lineHeight: 1.9, tabSize: 8 };
    applyEditors(el, looks);
    expect(el.style.getPropertyValue("--ed-json-lh")).toBe("1.9");
    expect(el.style.getPropertyValue("--ed-json-tab")).toBe("8");
    expect(el.style.getPropertyValue("--ed-markdown-lh")).toBe("1.6");
  });

  it("tells the live editors, which is the only way a preference can reach one", () => {
    // Monaco and CodeMirror are created once, inside an effect with an empty dependency list, and
    // re-creating either would throw away the caret and the undo history. So there is no prop this
    // could arrive as: a look that is not pushed is a look that lands at the next reopen.
    const told = vi.fn();
    const stop = onEditorLook(told);
    const looks = defaultEditors();
    looks.code = { ...looks.code, minimap: true };
    applyEditors(root(), looks);
    expect(told).toHaveBeenCalledTimes(1);
    expect(editorLook("code").minimap).toBe(true);

    // And stops when the editor goes — a notification into a disposed editor is an exception thrown
    // from a settings change, which would leave the whole pane feeling broken.
    stop();
    applyEditors(root(), defaultEditors());
    expect(told).toHaveBeenCalledTimes(1);
    expect(editorLook("code").minimap).toBe(false);
  });

  it("survives a watcher that unsubscribes while being told", () => {
    // Which a React effect cleanup running mid-update does. Iterating the live set would skip the
    // watcher after it — so half the editors on screen would follow the change and half would not.
    const second = vi.fn();
    const stop = onEditorLook(() => stop());
    const alsoStop = onEditorLook(second);
    applyEditors(root(), defaultEditors());
    expect(second).toHaveBeenCalledTimes(1);
    alsoStop();
  });
});

/**
 * The palette the editors are painted in — a named theme, or the window's own.
 *
 * One value for every surface rather than one per surface, and that is a constraint rather than a
 * simplification: Monaco's `setTheme` is global, so four controls would be four switches writing to
 * one place and three of them would appear not to work.
 *
 * The ID is checked HERE and nowhere in `shared`, which cannot know the palettes: a settings file
 * outlives a release, and a parser that refused an unknown id would be a parser a future theme could
 * not be added past.
 */
describe("which palette the editors are painted in", () => {
  const root = (): HTMLElement => {
    const style = new Map<string, string>();
    const data: Record<string, string> = {};
    return {
      style: {
        setProperty: (n: string, v: string) => style.set(n, v),
        removeProperty: (n: string) => style.delete(n),
        getPropertyValue: (n: string) => style.get(n) ?? "",
      },
      dataset: data,
    } as unknown as HTMLElement;
  };

  it("is a theme by default, and the one the product chose", () => {
    // A statement rather than a detail: an editor is where code is read, and an app whose editors are
    // painted in its chrome's two greys has decided somebody's syntax colours by not offering any.
    expect(defaultAppearance().editorTheme).toBe(DEFAULT_EDITOR_THEME);
    expect(editorThemeSpec(DEFAULT_EDITOR_THEME)?.label).toBe("Monokai Light");
  });

  it("states the theme on the root, with the colours the stylesheet maps", () => {
    const el = root();
    applyAppearance(el, { ...defaultAppearance(), editorTheme: "monokai" });
    expect(el.dataset["editorTheme"]).toBe("monokai");
    // The colours travel as custom properties because they are values rather than a switch — the
    // attribute only selects the rule that maps them onto the app's own token names.
    expect(el.style.getPropertyValue("--ed-bg")).toBe("#272822");
    expect(el.style.getPropertyValue("--ed-tok-keyword")).toBe("#f92672");
    expect(el.style.getPropertyValue("--ed-scheme")).toBe("dark");
  });

  it("takes the attribute and the colours back for `app`", () => {
    // ABSENT, not "app": no attribute means the rule does not match and every editor inherits the
    // window's own theme — the same "unset means unset" the font stack is built on. The properties
    // go with it, or an editor would be reading a palette nothing is painting from.
    const el = root();
    applyAppearance(el, { ...defaultAppearance(), editorTheme: "monokai" });
    applyAppearance(el, { ...defaultAppearance(), editorTheme: EDITOR_THEME_APP });
    expect(el.dataset["editorTheme"]).toBeUndefined();
    expect(el.style.getPropertyValue("--ed-bg")).toBe("");
  });

  it("keeps an id it does not know, and falls back at the point of use", () => {
    // The parser keeps it: a settings file outlives a release, and a theme that comes back should
    // find its preference where it was left. The RENDERER decides what to draw, and draws the
    // default — a state somebody can see and correct — rather than turning the setting off.
    expect(parseSettings({ appearance: { editorTheme: "gruvbox" } }).appearance.editorTheme).toBe("gruvbox");
    expect(editorThemeSpec("gruvbox")?.id).toBe(DEFAULT_EDITOR_THEME);
    // …except the one id that is not a theme, which means exactly what it says.
    expect(editorThemeSpec(EDITOR_THEME_APP)).toBeUndefined();
  });

  it("gives Monaco rules for the tokens its own tokenizers emit", () => {
    // The mapping this file is really about: a `.tmTheme` colours SCOPES, and Monaco's bundled
    // tokenizers emit Monarch's short names. A theme with no rule for `keyword` is a theme that
    // renders as the base's.
    const theme = monacoTheme(editorThemeSpec("monokai-light")!);
    const tokens = new Set(theme.rules.map((rule) => rule.token));
    for (const token of ["comment", "string", "number", "keyword", "type"]) expect(tokens).toContain(token);
    // No `#`, which Monaco rejects in a rule's colour while requiring it in `colors`.
    for (const rule of theme.rules) expect(rule.foreground?.startsWith("#")).not.toBe(true);
    expect(theme.colors["editor.background"]).toBe("#ffffff");
  });
});

/**
 * The TextMate layer, as far as a node test can see it.
 *
 * The engine is WASM and the grammars are megabytes, so what is checked here is the WIRING: that
 * every palette a person can choose has a real TextMate theme behind it, and that the two names for
 * one theme — ours and Shiki's — are mapped rather than assumed equal. Whether Oniguruma
 * instantiates is a question for a browser, and the snapshot figures are where it is answered.
 */
describe("the palettes have a real theme behind them", () => {
  it("maps every offered theme to a TextMate theme", () => {
    // The failure this prevents is silent: a theme with no TextMate counterpart still draws, in the
    // hand-mapped colours, and looks almost right — so nothing would ever report it.
    for (const theme of EDITOR_THEMES) expect(textmateThemeName(theme.id), theme.id).toBeTruthy();
  });

  it("keeps Shiki's name for a theme separate from ours", () => {
    // One Dark is `one-dark-pro` to Shiki, and asking Monaco for a theme by the wrong name throws.
    expect(textmateThemeName("one-dark")).toBe("one-dark-pro");
    expect(textmateThemeName("monokai-light")).toBe("monokai-light");
    expect(textmateThemeName(EDITOR_THEME_APP)).toBeUndefined();
  });

  it("embeds the file's own scopes rather than a reading of them", () => {
    // The theme the default is, as published: 35 scopes including the twenty this app's own palette
    // has no field for. A conversion that dropped them would be exactly the mapping-down the
    // TextMate layer exists to stop doing.
    const scopes = MONOKAI_LIGHT_TM.settings ?? [];
    expect(scopes.length).toBeGreaterThan(30);
    expect(scopes.some((s) => s.scope === "variable.parameter")).toBe(true);
    expect(scopes.some((s) => s.scope === "entity.name.function")).toBe(true);
    // The global block, which is where an editor's own background and caret come from.
    expect(scopes[0]?.settings?.background).toBe("#FFFFFF");
  });
});
