/**
 * Monaco's DiffEditor, local and worker-wired (CHANGESETS.md §7.3) — the full-pane half of the
 * reviewer that §8.3 promises: side-by-side is unreadable at conversation width, so the wide view
 * is where it lives.
 *
 * Two decisions §7.3 warned about, and how they landed:
 *
 *  - **No CDN, no loader.** `monaco-editor` is imported as ESM and bundled by Vite;
 *    `MonacoEnvironment.getWorker` hands out the bundled workers (`?worker` imports). The
 *    `@monaco-editor/react` loader — the thing that "hangs on a blank editor with no error" in
 *    Electron — is not involved at all.
 *  - **The alignment question (§10.2) is dissolved, not answered.** Monaco renders only diffs it
 *    computes itself, and that is fine here because nothing of ours is overlaid on it: decisions
 *    are per CHANGE (§4.1), the stored jsdiff/structural hunks remain the record and the
 *    conversation-width rendering, and this pane is a reading-and-editing surface. Its
 *    `diffAlgorithm` is the default 'advanced', free to differ from the stored hunks because the
 *    two never have to line up.
 *
 * The modified side is editable: what the user types is §4.1's `merged.content`, the one part of
 * the outcome that is not derivable — the pane reports edits up and the reviewer folds them into
 * the decision.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { monacoGrammarOf, type EditorKind } from "@jaira/shared/browser";
import { editorLook, onEditorLook } from "./editorLook";
import { EDITOR_THEME_APP, editorThemeSpec, monacoTheme } from "./editorThemes";
import { splitMonacoKeywords } from "./monacoTokens";
import { colorize, ensureTextMate, onTextMate, textmateThemeFor, textmateThemeInUse, textmateThemeName } from "./textmate";
import { onRenderChoice, renderChoicesNow, useRenderChoice } from "./renderChoice";
import { editorFrontNow, onEditorFront, takeEditorFront } from "./editorFront";
import { viewTheme } from "./fileTypes";
import type { RenderView } from "@jaira/shared/browser";
import * as monaco from "monaco-editor";
// Monaco ≥0.53 maps subpaths through its exports table (`./*` → `./esm/vs/*.js`), so the worker
// specifiers are spelled WITHOUT the `esm/vs` prefix the older guides show.
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

// Installed once, before the first editor is created. The label→worker map is the canonical Vite
// arrangement; everything unlisted (yaml, markdown, plain text) runs on the base editor worker,
// which is also where diff computation happens.
if (window.MonacoEnvironment === undefined) {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}

/** Themes already handed to Monaco — `defineTheme` is idempotent, but building one is not free. */
const defined = new Set<string>();

/**
 * The Monaco theme to use: the editors' own palette when one is chosen, the window's otherwise.
 *
 * Read off the root's two attributes rather than passed in, for the reason the font is: this is
 * called from inside an effect that runs once, and the observers below re-read it. `data-editor-theme`
 * carries the chosen palette's id (`editorThemes.ts`); absent means the editors follow the window,
 * which is what they all did before palettes existed.
 *
 * It DEFINES on the way past, which is what makes the whole registry lazy: a theme nobody has chosen
 * is a table of a dozen strings that never becomes a Monaco theme at all.
 *
 * One theme for every Monaco surface, and not by choice: `setTheme` is global in Monaco and even a
 * per-editor `theme` option repaints the page. That constraint is why the preference is one value
 * beside the editor SIZE rather than one per surface — see `Appearance.editorTheme`.
 */
/**
 * The type of the editor most recently made or focused — and the whole of how a per-type palette
 * reaches Monaco.
 *
 * Monaco has ONE theme. `setTheme` repaints every editor on the page, a per-editor `theme` option
 * goes through the same call, and the token classes are indices into a single colour map, so two
 * editors in two palettes is not a thing the mechanism can express (see `textmate.ts`, and
 * `CodeText`, which escapes this entirely by not being an editor).
 *
 * So the honest reading of "a palette per type" for editors is: the one in front wins. This is that
 * one, and every path that asks what theme to use asks through it. A reading never sets it — a
 * fenced block colours itself and has no opinion about the window.
 */

/** Which palette an editor of this type should be in — the preference, before it is made safe. */
function wantedThemeId(): string {
  const inFront = editorFrontNow();
  // The VIEW as well as the type. Hardcoding `write` here was a bug with one visible symptom and a
  // simple cause: the read-only view of a type is a separate pick with a separate palette, and an
  // editor serving it asked for the other one — so choosing a colour scheme for a reading changed
  // nothing at all.
  const perType =
    inFront === undefined ? null : viewTheme(inFront.mime, "text", inFront.view, renderChoicesNow());
  // The Editors section's one value stands behind every type: it is the palette for anything nobody
  // has said anything about, which is almost everything.
  return perType ?? document.documentElement.dataset["editorTheme"] ?? EDITOR_THEME_APP;
}

const themeOf = (): string => {
  // Here because every path that draws code passes through it — both panes and the tokenizer-only
  // reading — and because by the time a theme is being chosen the language is loaded, which is the
  // one thing this has to be later than. See `monacoTokens.ts`.
  splitMonacoKeywords();
  const root = document.documentElement.dataset;
  const dark = root["theme"] === "dark";
  // `app` is not a palette but a statement that the palette follows the window, and it resolves to
  // one of the two VSCode defaults — which is what lets somebody on it have real grammars rather
  // than the Monarch tokenizer and a shrug. Before this it returned `vs` here and stopped.
  const chosen = textmateThemeFor(wantedThemeId(), dark);
  const safe = textmateThemeInUse(textmateThemeName(chosen));
  if (safe !== undefined) return safe;
  const spec = editorThemeSpec(chosen);
  if (spec === undefined) return dark ? "vs-dark" : "vs";
  /**
   * The REAL theme once the TextMate layer has it, and ours until then.
   *
   * Two answers for one preference, and the order is the point. Shiki registers a Monaco theme built
   * from the `.tmTheme` itself, which colours every scope its author wrote; `monacoTheme` builds one
   * from the dozen colours this app maps down to, which is all a Monarch tokenizer can spend anyway.
   * So the second is what an editor opens in — instantly, with no WASM in the way — and the first
   * replaces it a moment later when the grammar and the theme have landed. Same palette either way;
   * what changes is how much of the code is told apart. See `textmate.ts`.
   *
   * ONCE THE BRIDGE IS INSTALLED, OURS IS NO LONGER A LEGAL ANSWER. `shikiToMonaco` replaces
   * `monaco.editor.setTheme` with one that throws for any theme the highlighter has not loaded — so
   * from that moment our fallback names, and Monaco built-ins like `vs`, are names that CRASH the
   * window rather than repaint it. That is not hypothetical: switching palettes threw
   * `Theme jaira-monokai not found` out of the observer below. `textmateThemeInUse` answers safely —
   * the chosen theme when it is loaded, otherwise whichever is (so the editors hold the last palette
   * that worked while the new one arrives), and `undefined` only while `setTheme` is still Monaco own
   * and our names still work.
   */
  // Monaco refuses a name with a dot in it and lowercases nothing for you; the ids here are already
  // kebab-case, and the prefix keeps them out of the way of its own four built-ins.
  const name = `jaira-${spec.id}`;
  if (!defined.has(name)) {
    monaco.editor.defineTheme(name, monacoTheme(spec) as monaco.editor.IStandaloneThemeData);
    defined.add(name);
  }
  return name;
};

/**
 * Ask for the grammar and the theme a surface is about to draw, and repaint when they land.
 *
 * Called from the places that create an editor, from the one that colours text without one, and from
 * every observer that notices the THEME change — that last one is easy to forget and was: switching
 * palettes with an editor already open asked for a repaint in a theme nothing had loaded.
 *
 * `language` may be one this app has no grammar for; the theme is loaded either way, which is what
 * makes it safe to call with nothing in particular in mind.
 */
function wantTextMate(language: string): void {
  ensureTextMate(monaco, language, textmateThemeFor(wantedThemeId(), document.documentElement.dataset["theme"] === "dark"));
}

// One subscription for the window: a palette chosen for a type reaches the editors already open,
// rather than the next ones. Asked FIRST, because a newly chosen theme is one nothing has loaded and
// `themeOf` can only answer with what is safe now.
function repaint(): void {
  const inFront = editorFrontNow();
  if (inFront !== undefined) wantTextMate(monacoGrammarOf(inFront.mime));
  monaco.editor.setTheme(themeOf());
}

// Two subscriptions for the window, and both are needed. A palette chosen for a type has to reach
// the editors already open rather than the next ones; and the palette moving to another type or view
// — which is what `editorFront.ts` is — is the same repaint from the other direction.
onRenderChoice(repaint);
onEditorFront(repaint);

/**
 * This editor is the one in front: take the palette, and repaint.
 *
 * Called when an editor is created and whenever it takes focus, which is what makes a per-type
 * palette visible at all. Two editors of different types on screen together still share one — the
 * one whose text you last clicked into.
 */
function takeFront(mime: string, view: RenderView): void {
  takeEditorFront({ mime, view });
}

// One subscription for the window: when a grammar or a theme lands, repaint in whatever is now safe.
onTextMate(() => monaco.editor.setTheme(themeOf()));

/**
 * The editor's face and size, read off the tokens the rest of the app uses (SHELL.md §6).
 *
 * Monaco draws into a canvas and cannot inherit CSS the way every other surface does, so the two
 * values are read from the computed style and passed as options. Without it the editor kept its own
 * 14px Consolas while the whole window moved around it — the one surface a code-size preference is
 * most obviously about.
 *
 * `--size-editor` rather than `--size-data`: it resolves to the data voice until Advanced separates
 * them, so the simple case needs no special handling here.
 */
function editorFont(): { fontFamily: string; fontSize: number } {
  const style = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(style.getPropertyValue("--size-editor"));
  return {
    fontFamily: style.getPropertyValue("--font-data").trim(),
    // Monaco refuses a NaN by falling back to a default that is not ours — better to state the
    // stylesheet's own base than to let the option through unread.
    fontSize: Number.isFinite(size) && size > 0 ? size : 12,
  };
}

/**
 * The face, the size, and the six questions a person can answer about a Monaco surface.
 *
 * One function for both panes, taking which surface is asking, because the two are the same editor
 * with different content and a preference set per surface — see `EditorKind`. Everything here was a
 * literal in the two `create` calls below; the values it returns for an untouched settings file are
 * those same literals, which is the whole of what {@link defaultEditorLook} is for.
 *
 * `lineHeight` is computed rather than passed through. Monaco reads a small number as a multiplier
 * in some versions and as pixels in others, and a preference that means "one and a half times the
 * font" must not become a fifteen-hundredths-of-a-pixel line on an upgrade — so the multiplication
 * happens here, against the font size this same call is about to set.
 */
function editorOptions(kind: EditorKind): monaco.editor.IEditorOptions {
  const look = editorLook(kind);
  const font = editorFont();
  return {
    ...font,
    lineNumbers: look.lineNumbers ? "on" : "off",
    wordWrap: look.wrap ? "on" : "off",
    minimap: { enabled: look.minimap },
    guides: { indentation: look.indentGuides },
    /**
     * The current line, off by default — see the note that used to live at the `create` call.
     *
     * In Monaco's light theme this is drawn as a BORDER above and below the line rather than as a
     * tint, so what it produces is a grey outline round one row. That reads as a selection, and a
     * caret is not a selection: the thing it marks is where typing would land, which the caret is
     * already saying an inch to the left. It came off in two steps — limiting it to a focused editor
     * cleared the boxes round every unfocused fence and left the outline where it was no more wanted
     * — and it is a preference now rather than a verdict, because somebody who works with a large
     * font and a long line has a use for it that none of that argues against.
     */
    renderLineHighlight: look.currentLine ? "line" : "none",
    renderWhitespace: look.whitespace ? "all" : "none",
    // Monaco ships this ON, in three colours of its own — see `EditorLook.brackets`. Left alone it
    // is the loudest thing in an editor that does not come from the theme.
    bracketPairColorization: { enabled: look.brackets },
    lineHeight: Math.round(font.fontSize * look.lineHeight),
  };
}

/**
 * The two options that belong to the DOCUMENT rather than to the editor over it, kept applied.
 *
 * A tab width is obviously the document's. Bracket colouring is not obviously anything, and it cost
 * an afternoon: `IEditorOptions.bracketPairColorization` exists, is typed, is accepted — and is not
 * what decides. `ITextModelUpdateOptions.bracketColorizationOptions` is. So an editor told to stop
 * colouring brackets went on colouring them in `#0431fa`, which is Monaco's own first bracket colour
 * and appears in none of the themes this app ships.
 *
 * Applied twice over, because setting them once does not hold. Attaching a model to an editor pushes
 * the editor's derived options onto it — `detectIndentation` re-guesses the tab width, and the
 * bracket options come back as Monaco's defaults — and that work lands after the `create` call
 * returns. So the options are written now AND rewritten whenever something else changes them, with a
 * guard so our own write does not bounce.
 */
function keepDocumentOptions(model: monaco.editor.ITextModel, kind: EditorKind): monaco.IDisposable {
  const apply = (): void => {
    const look = editorLook(kind);
    const now = model.getOptions();
    if (now.tabSize === look.tabSize && now.bracketPairColorizationOptions.enabled === look.brackets) return;
    model.updateOptions({
      tabSize: look.tabSize,
      bracketColorizationOptions: { enabled: look.brackets, independentColorPoolPerBracketType: false },
    });
  };
  apply();
  return model.onDidChangeOptions(apply);
}

import type { PendingSelection } from "./reviewNotes";

/**
 * What a host can ask of a diff editor that is already on screen.
 *
 * Imperative on purpose. Reverting a hunk is not a value the host can compute and hand down — it
 * needs the editor's own alignment between the two sides, which is derived from the diff algorithm
 * rather than from the two strings.
 */
export interface DiffActions {
  /**
   * Put the original's text back over the lines the person has selected.
   *
   * Selecting nothing reverts nothing: that case is the CHANGE-level decision, which belongs to the
   * reviewer rather than to the editor, and doing it silently here would make one button mean two
   * very different things depending on where the caret happened to be.
   *
   * Returns the modified text afterwards, or `null` when there was nothing to do.
   */
  revertSelectedLines(): string | null;
  /** Whether the selection currently covers any changed line — what the button's enabled state reads. */
  hasChangedSelection(): boolean;
}

/** The band a diff pane is allowed to occupy before it starts scrolling instead of growing. */
const MIN_DIFF_HEIGHT = 120;
const MAX_DIFF_HEIGHT = 620;

export interface MonacoDiffProps {
  original: string;
  modified: string;
  /** A MIME type — mapped through {@link monacoGrammarOf}. */
  mime: string;
  /** Called with the modified side's full text on every edit — §4.1's `merged.content` feed. */
  onModified?: (text: string) => void;
  /**
   * A selection in the modified side, in the terms a review note anchors to — or `null` when there
   * is none. See the subscription in the body for why this cannot come from the DOM.
   */
  onSelect?: (selection: PendingSelection | null) => void;
  /** Hands the host the actions that only the live editor can perform — see {@link DiffActions}. */
  onReady?: (actions: DiffActions | null) => void;
  readOnly?: boolean;
  /**
   * Two columns, or one with the removals struck through above the additions.
   *
   * Both are worth having and neither is right everywhere, which is why it is a prop rather than the
   * `renderSideBySide: true` this had hard-coded. Side by side is the better reading of a rewrite
   * and needs width; inline is the better reading of a scattered edit and is the only one that
   * survives a narrow panel — which is where most of these are read.
   */
  sideBySide?: boolean;
}

export function MonacoDiffPane({
  original,
  modified,
  mime,
  onModified,
  onSelect,
  onReady,
  readOnly,
  sideBySide,
}: MonacoDiffProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  // The latest callback, without tearing the editor down per render: the editor is created once per
  // (original, mime) and the subscription reads through the ref.
  const report = useRef(onModified);
  report.current = onModified;
  const selected = useRef(onSelect);
  selected.current = onSelect;
  /** The live editor, for the effects and the imperative actions that outlive its creation. */
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    const node = host.current;
    if (node === null) return undefined;
    const language = monacoGrammarOf(mime);
    // The grammar this pane is about to need, and the palette its type asks for — see `textmate.ts`
    // and {@link takeFront}. A pane that has just opened is the one in front. A diff is a reading of
    // two revisions whichever side can be typed in, so it takes the read view's palette.
    takeFront(mime, "read");
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    const editor = monaco.editor.createDiffEditor(node, {
      automaticLayout: true,
      renderSideBySide: sideBySide !== false,
      // Monaco collapses side-by-side to inline on its own below `renderSideBySideInlineBreakpoint`
      // (900px by default). The reviewer's detail pane sits under that in the ordinary gate modal, so
      // the toggle appeared to do nothing at all — the editor was overruling it every time. The
      // person asking for two columns in a narrow pane knows it will be narrow.
      useInlineViewWhenSpaceIsLimited: false,
      originalEditable: false,
      readOnly: readOnly === true,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      // The gutter, trimmed to what a diff actually needs.
      //
      // Monaco's defaults reserve room for a glyph margin, a folding column, a code-lens strip and
      // five digits of line number — sensible in an IDE, and in a review pane it is an inch of empty
      // space between the frame and the first character, doubled because an inline diff draws two
      // line-number columns.
      glyphMargin: false,
      folding: false,
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 2,
      overviewRulerLanes: 0,
      padding: { top: 6, bottom: 6 },
      theme: themeOf(),
      // LAST, so a preference wins over anything above it that names the same option — see
      // {@link editorOptions}. The gutter trim above is about what a diff needs and stays ours.
      ...editorOptions("diff"),
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    // Both models, or the two sides of a diff would indent differently and bracket differently.
    const kept = [keepDocumentOptions(originalModel, "diff"), keepDocumentOptions(modifiedModel, "diff")];
    const documentOptions = (): void => {
      for (const model of [originalModel, modifiedModel]) model.updateOptions({ tabSize: editorLook("diff").tabSize });
    };
    editorRef.current = editor;
    const edits = modifiedModel.onDidChangeContent(() => report.current?.(modifiedModel.getValue()));

    /**
     * Report a selection in the MODIFIED side, in the same terms a DOM selection is reported.
     *
     * Monaco owns its own selection model, so the `selectionchange`/`Range` machinery the rest of
     * the reviewer anchors notes with sees nothing in here. Without this, moving the detail pane to
     * Monaco silently removed the ability to comment on a passage of a diff — the feature would
     * still be there, with nowhere left to use it.
     *
     * Offsets come from `getOffsetAt`, which counts into the modified text — the same thing
     * `ReviewNote.range` means everywhere else. The rect is the editor's own coordinates converted
     * to the viewport, so the composer opens over the words rather than over the pane's corner.
     */
    /**
     * Size the editor to its content, up to a ceiling, then let it scroll.
     *
     * Without this the host is whatever height CSS gave it, so a three-line change sits in a pane
     * of empty grey and a four-hundred-line one is clipped to the same box. `onDidContentSizeChange`
     * is the only honest source for the number: it accounts for wrapped lines and for the diff's own
     * inserted view-zones, which a line count cannot.
     */
    const fit = (): void => {
      const inner = editor.getModifiedEditor();
      const original = editor.getOriginalEditor();
      const content = Math.max(inner.getContentHeight(), original.getContentHeight());
      node.style.height = `${Math.min(Math.max(content + 8, MIN_DIFF_HEIGHT), MAX_DIFF_HEIGHT)}px`;
      editor.layout();
    };
    const sized = [
      editor.getModifiedEditor().onDidContentSizeChange(fit),
      editor.getOriginalEditor().onDidContentSizeChange(fit),
    ];
    fit();

    /** Every diff hunk the modified-side selection touches. */
    const touchedChanges = (): monaco.editor.ILineChange[] => {
      const selection = editor.getModifiedEditor().getSelection();
      // A CURSOR is not a selection. Without this, resting the caret anywhere inside a hunk turned
      // the whole-change Revert into a line revert, so refusing a change quietly became editing it.
      if (selection === null || selection.isEmpty()) return [];
      return (editor.getLineChanges() ?? []).filter((change) => {
        const from = Math.min(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
        const to = Math.max(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
        return selection.startLineNumber <= to + 1 && selection.endLineNumber >= from - 1;
      });
    };

    const picks = editor.getModifiedEditor().onDidChangeCursorSelection((e) => {
      const report = selected.current;
      if (report === undefined) return;
      const model = modifiedModel;
      const start = model.getOffsetAt(e.selection.getStartPosition());
      const end = model.getOffsetAt(e.selection.getEndPosition());
      if (end <= start) {
        report(null);
        return;
      }
      const quote = model.getValueInRange(e.selection);
      if (quote.trim().length === 0) {
        report(null);
        return;
      }
      const inner = editor.getModifiedEditor();
      const top = inner.getTopForPosition(e.selection.endLineNumber, e.selection.endColumn);
      const box = node.getBoundingClientRect();
      const y = box.top + top - inner.getScrollTop();
      const lineHeight = inner.getOption(monaco.editor.EditorOption.lineHeight);
      report({
        quote,
        start,
        end,
        rect: { top: y, bottom: y + lineHeight, left: box.left + 40, right: box.right },
      });
    });

    /**
     * Line-level revert.
     *
     * `getLineChanges()` is the editor's own alignment of the two sides, and it is the only thing
     * that knows which original lines a run of modified lines REPLACED — a pure text diff computed
     * again out here could disagree with what is drawn, and reverting to something other than what
     * the person is pointing at is the worst possible outcome for this control.
     *
     * Applied bottom-up so that earlier line numbers stay valid while later ones are rewritten.
     */
    const actions: DiffActions = {
      hasChangedSelection: () => touchedChanges().length > 0,
      revertSelectedLines: () => {
        const touched = touchedChanges();
        if (touched.length === 0) return null;
        const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
        for (const change of [...touched].reverse()) {
          const insertion = change.originalEndLineNumber < change.originalStartLineNumber;
          const deletion = change.modifiedEndLineNumber < change.modifiedStartLineNumber;
          const text = insertion
            ? ""
            : `${originalModel
                .getValueInRange({
                  startLineNumber: change.originalStartLineNumber,
                  startColumn: 1,
                  endLineNumber: change.originalEndLineNumber,
                  endColumn: originalModel.getLineMaxColumn(change.originalEndLineNumber),
                })}
`;
          // A pure insertion has no modified line to keep, so the whole run goes; a pure deletion has
          // no modified line to overwrite, so the original text is spliced in at that point.
          const range = deletion
            ? new monaco.Range(change.modifiedStartLineNumber + 1, 1, change.modifiedStartLineNumber + 1, 1)
            : new monaco.Range(change.modifiedStartLineNumber, 1, change.modifiedEndLineNumber + 1, 1);
          edits.push({ range, text });
        }
        modifiedModel.pushEditOperations([], edits, () => null);
        return modifiedModel.getValue();
      },
    };
    ready.current?.(actions);

    // Follow the app's theme while the pane is open — the attribute is the one source of truth.
    // Theme AND typography: both are written onto the root — one as a data attribute, the other as
    // inline custom properties — so one observer covers both, and the editor follows a size slider
    // as it moves rather than at the next reopen.
    const themes = new MutationObserver(() => {
      // Ask FIRST: a theme change may name a palette nothing has loaded, and `themeOf` can only
      // answer with what is safe now. Asking is what makes the right answer arrive a moment later.
      wantTextMate(language);
      monaco.editor.setTheme(themeOf());
      editor.updateOptions(editorOptions("diff"));
    });
    // Focus is what "the one in front" means, and it is the only signal that carries it: two editors
    // of different types can be on screen at once, and only one of them can have the window's
    // palette. Both sides of a diff, because either can be clicked into.
    const front = [
      editor.getOriginalEditor().onDidFocusEditorText(() => takeFront(mime, "read")),
      editor.getModifiedEditor().onDidFocusEditorText(() => takeFront(mime, "read")),
    ];
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-editor-theme", "style"] });
    // The looks are typed values rather than custom properties, so they arrive on their own channel
    // — see `editorLook.ts`. Same effect as the observer above: the editor follows a switch as it is
    // flipped instead of at the next time the file is opened.
    const styled = onEditorLook(() => {
      editor.updateOptions(editorOptions("diff"));
      documentOptions();
    });

    return () => {
      ready.current?.(null);
      editorRef.current = null;
      themes.disconnect();
      styled();
      for (const one of kept) one.dispose();
      edits.dispose();
      picks.dispose();
      for (const s of sized) s.dispose();
      for (const one of front) one.dispose();
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
    // `modified` is deliberately absent: the pane OWNS the modified text once open (it is the
    // editing surface), and resetting the model on every keystroke's round-trip would fight the
    // user's cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, mime, readOnly, sideBySide]);

  /**
   * Follow the `modified` prop after creation.
   *
   * It is deliberately NOT in the effect above's dependencies — re-creating the editor on every
   * keystroke would throw away the caret, the scroll position and the undo stack. But that left it
   * unable to follow a change made from OUTSIDE, which is exactly what "Undo my edits" is: the prop
   * went back to the proposal and the editor carried on showing the edit.
   *
   * Guarded on inequality so this never fights the person typing: an edit they just made is already
   * the model's value by the time the prop catches up, and writing it back would move their caret.
   */
  useEffect(() => {
    const model = editorRef.current?.getModel()?.modified;
    if (model === undefined || model === null) return;
    if (model.getValue() !== modified) {
      // `pushEditOperations` rather than `setValue`: it keeps the undo stack, so an outside revert
      // is one more step the person can undo rather than a wall their history stops at.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: modified }], () => null);
    }
  }, [modified]);

  return <div className="monaco-host" ref={host} />;
}

/**
 * One text, coloured — the single-document sibling of the diff pane.
 *
 * Same worker wiring, same theme following, same MIME→grammar map; what differs is that there is
 * nothing to compare against. It exists because "show me the source" and "show me the source I can
 * read" are different requests, and a two-hundred-line state file in a `<pre>` is the second one
 * refused.
 *
 * It used to be read-only throughout, on the reasoning that every surface editing text had an editor
 * of its own. Those editors turned out to be one `<textarea>`, so a `.ts` file — a type Monaco has a
 * grammar for, in an app that already colours it in three other places — was edited with no
 * highlighting at all. Supplying `onChange` makes this the editor for anything with a grammar; see
 * `documents.tsx`, which is what decides between this and the tokenizer.
 */
export function MonacoCodePane({
  text,
  mime,
  onChange,
  autoHeight,
  view,
}: {
  text: string;
  mime: string;
  /** Somewhere for a change to go. ABSENT means read-only — see `documents.tsx` on why it is absence. */
  onChange?: ((text: string) => void) | undefined;
  /**
   * Take the height of the CONTENT rather than of the container.
   *
   * The note on {@link CodeText} lists "it cannot size itself to its content" as one of the three
   * reasons an editor is the wrong tool inside a paragraph, and for a pane that fills a panel that
   * is exactly right: the container is the answer, and asking the text would make the panel jump as
   * you typed. It stops being right the moment the editor is a block INSIDE a document, where there
   * is no container height to take and the pane drew a single line of code in seven hundred pixels
   * of empty grey.
   *
   * So it is an option, not a change of behaviour. Off, this is what it always was.
   */
  autoHeight?: boolean | undefined;
  /**
   * Which of the type's two views this pane is drawing — the palette it should be in.
   *
   * `write` unless told, which is what a pane with somewhere for a change to go is. It matters
   * because the two views are two picks with two palettes, and an editor mounted as the READING of a
   * type — the settings preview does exactly this — must ask for the reading's colours or a person
   * choosing them sees nothing happen.
   */
  view?: RenderView | undefined;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  /** The latest props, read through refs so the editor is created once — see the effect below. */
  const report = useRef(onChange);
  report.current = onChange;
  const viewOf = useRef<RenderView>(view ?? "write");
  viewOf.current = view ?? "write";
  const seed = useRef({ text, mime });
  seed.current = { text, mime };
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const writable = onChange !== undefined;
  /** Read through a ref for the same reason the rest is: the editor is created exactly once. */
  const autoFit = useRef(autoHeight);
  autoFit.current = autoHeight;

  useEffect(() => {
    const node = host.current;
    if (node === null) return undefined;
    takeFront(seed.current.mime, viewOf.current);
    const model = monaco.editor.createModel(seed.current.text, monacoGrammarOf(seed.current.mime));
    const editor = monaco.editor.create(node, {
      model,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      // The gutter, trimmed to what this pane needs — the same trim {@link MonacoDiffPane} makes and
      // for the same reason, which this one simply never got. Monaco's defaults reserve a glyph
      // margin, a folding column and FIVE digits of line number, so a block holding one line drew a
      // single `1` in an inch of empty space, right-aligned against a column sized for `10000`.
      glyphMargin: false,
      folding: false,
      lineNumbersMinChars: 2,
      // The gap between the number and the code. The diff pane can afford 2 because its two number
      // columns already separate themselves; trimmed that far here it read as `1export const`.
      lineDecorationsWidth: 10,
      // Room above the first line and below the last, so the text is not flush against the frame.
      // `getContentHeight` counts it, so the fitted height already allows for it.
      padding: { top: 6, bottom: 6 },
      theme: themeOf(),
      ...editorOptions("code"),
      /**
       * A pane sized to its own text has nothing to scroll, so it must not offer to.
       *
       * Two separate bars were showing. The horizontal one because a long line overflowed, and it
       * costs height that `getContentHeight` does not count — so the pane was a scrollbar taller
       * than it had said it would be, which then made the vertical one appear as well. Wrapping is
       * the honest fix rather than hiding the bar: a code block inside a document should break its
       * lines the way the prose around it does instead of sliding sideways under a rule.
       *
       * Only in the fitted mode. A pane that fills a panel is a viewport onto a file and both bars
       * are exactly right there.
       */
      // AFTER the preference on purpose: this one is a fact about the layout rather than a taste,
      // and everything else the person asked for still stands.
      ...(autoHeight === true
        ? {
            wordWrap: "on" as const,
            scrollBeyondLastColumn: 0,
            scrollbar: {
              vertical: "hidden" as const,
              horizontal: "hidden" as const,
              // The page scrolls, not the block — otherwise a wheel over a fence eats the gesture
              // and the document under the pointer refuses to move.
              alwaysConsumeMouseWheel: false,
            },
          }
        : {}),
    });
    editorRef.current = editor;
    // The document's own options rather than the editor's — see {@link keepDocumentOptions}.
    const kept = keepDocumentOptions(model, "code");
    const documentOptions = (): void => model.updateOptions({ tabSize: editorLook("code").tabSize });
    const typed = model.onDidChangeContent(() => report.current?.(model.getValue()));
    /**
     * The pane's height, taken from the text — see {@link MonacoCodePane}'s `autoHeight`.
     *
     * `getContentHeight` is Monaco's own measurement of the lines it has laid out, and the event
     * fires whenever that changes: a line added, a line wrapped, the font size moved by the
     * appearance slider. Setting the host and re-laying out in the same handler is what keeps the
     * two from disagreeing by a frame, which would show as the block twitching as you type.
     *
     * The width is passed back unchanged. Only the height is ours to decide; the width belongs to
     * whatever the block is sitting in.
     */
    const fit = (): void => {
      if (autoFit.current !== true) return;
      const height = editor.getContentHeight();
      node.style.height = `${height}px`;
      editor.layout({ width: node.clientWidth, height });
    };
    const sized = editor.onDidContentSizeChange(fit);
    const front = editor.onDidFocusEditorText(() => takeFront(seed.current.mime, viewOf.current));
    fit();
    // Theme AND typography: both are written onto the root — one as a data attribute, the other as
    // inline custom properties — so one observer covers both, and the editor follows a size slider
    // as it moves rather than at the next reopen.
    const themes = new MutationObserver(() => {
      wantTextMate(monacoGrammarOf(seed.current.mime));
      monaco.editor.setTheme(themeOf());
      editor.updateOptions(editorOptions("code"));
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-editor-theme", "style"] });
    // The looks arrive on their own channel — see `editorLook.ts`. `fit` afterwards because line
    // spacing and wrapping both change how tall the text is, and a fitted block that did not
    // re-measure would keep the height its old spacing needed.
    const styled = onEditorLook(() => {
      editor.updateOptions(editorOptions("code"));
      documentOptions();
      fit();
    });
    return () => {
      typed.dispose();
      sized.dispose();
      front.dispose();
      kept.dispose();
      themes.disconnect();
      styled();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // Created ONCE, which is what editing requires: this used to key on `[text, mime]`, so every
    // keystroke tore the editor down and built a new one — fine while nothing could be typed, fatal
    // the moment something could, because the caret goes with it. Everything that moves afterwards
    // is followed by the effects below, the same arrangement `markdownEditor.tsx` uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Follow `text` when it moves for a reason that is not this editor — a reload, a revert. */
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model === undefined || model === null || model.getValue() === text) return;
    // `pushEditOperations` rather than `setValue`: it keeps the undo stack, so an outside revert is
    // one more step the person can undo rather than a wall their history stops at.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  }, [text]);

  /** Follow the type — a file whose name changed under it is coloured as what it now is. */
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model !== undefined && model !== null) {
      // A file whose name changed under it is a different TYPE, so it may want a different palette
      // as well as a different grammar.
      takeFront(mime, viewOf.current);
      monaco.editor.setModelLanguage(model, monacoGrammarOf(mime));
    }
  }, [mime]);

  /** Follow writability, rather than re-creating for it. */
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: !writable, domReadOnly: !writable });
  }, [writable]);

  return <div className={autoHeight === true ? "monaco-host monaco-fit" : "monaco-host"} ref={host} />;
}

/**
 * One text, coloured, with NO editor behind it — what a fenced code block in a transcript gets, and
 * what the code view draws a whole file with.
 *
 * {@link MonacoCodePane} is the wrong tool at this size for three separate reasons, and only the
 * first is cost. An editor per fence is an editor per fence, and a thread holds dozens; it cannot
 * size itself to its content, so it needs a container height that a block inside a paragraph does
 * not have; and a Monaco instance is a scroll region, so a selection dragged from the prose above a
 * code block stops dead at its edge — copying an answer whole becomes impossible.
 *
 * ## Why Shiki rather than `monaco.editor.colorize`
 *
 * Because of where the colours end up, which turns out to decide what a theme can MEAN. Monaco emits
 * `.mtkN` classes whose meaning is a global stylesheet — `mtk5` is an index into whichever theme is
 * current — so every coloured thing in the window is in one palette by construction, and asking for
 * two was asking for something the mechanism could not express. Shiki writes the colours INLINE, so
 * each of these is an independent rendering: a JSON reading in Monokai Light beside a TypeScript
 * reading in One Dark is two `<pre>` elements and no conflict at all.
 *
 * That is what makes {@link RendererChoice.theme} honest for readings. Editors are still one palette
 * between them — see `themeOf` — because a Monaco instance genuinely cannot hold its own.
 *
 * It also removes a `setTheme` call. This used to set the window's theme as a side effect of
 * colouring one fence, which is how a transcript full of them once repainted every editor on screen.
 *
 * ## Why this may set innerHTML when `markdown.tsx` may not
 *
 * The rule there is that nothing interpolates markup, and this does not break it. The string here is
 * BUILT from tokens by Shiki's renderer rather than passed through it: the text of every token is
 * escaped as it is appended, so content arrives as text in every case and the only tags present are
 * the `<span style="color:…">` the tokenizer emitted.
 */
export function CodeText({ text, mime, theme }: { text: string; mime: string; theme?: string | undefined }): JSX.Element {
  const chosen = useRenderChoice();
  const [html, setHtml] = useState<string | null>(null);
  /**
   * The palette THIS reading is drawn in.
   *
   * Per type and per view, which is where the preference lives (`fileTypes.ts`): a fenced block is a
   * reading of its language, never a place anybody types, so it takes the `read` answer. `theme` as a
   * prop overrides it for the one caller that is showing a palette rather than using one — the
   * settings preview, which has to draw a theme you have not chosen yet.
   */
  const wanted =
    theme ?? viewTheme(mime, "text", "read", chosen) ?? document.documentElement.dataset["editorTheme"];
  // The window's own light/dark, which the palette folds in for anybody on "Follows the app".
  // Watched rather than read once: that preference means the colours move when the window does.
  const [appDark, setAppDark] = useState(() => document.documentElement.dataset["theme"] === "dark");
  useEffect(() => {
    const watch = new MutationObserver(() => setAppDark(document.documentElement.dataset["theme"] === "dark"));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-editor-theme"] });
    return () => watch.disconnect();
  }, []);
  const palette = textmateThemeFor(wanted, appDark);

  useEffect(() => {
    let live = true;
    void colorize(text, monacoGrammarOf(mime), palette).then((out) => {
      if (live) setHtml(out);
    });
    return () => {
      live = false;
    };
  }, [text, mime, palette]);

  // The source, plainly, until the tokens arrive — the same characters in the same box, so nothing
  // moves when the colour lands.
  if (html === null) {
    return (
      <pre className="code-text">
        <code>{text}</code>
      </pre>
    );
  }
  // A container rather than a `<pre>` of our own: what comes back IS a `<pre>`, carrying the theme's
  // background and foreground inline, and wrapping it in a second one would put this app's ground
  // behind a block that has already stated its own.
  return (
    <div className="code-shiki" style={{ tabSize: editorLook("code").tabSize }} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
