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

/** The Monaco language id for a MIME type — display only, so unknown safely means plain text. */
export function monacoLanguageOf(mime: string): string {
  if (mime.endsWith("+json") || mime === "application/json") return "json";
  if (mime.endsWith("+yaml") || mime === "application/yaml") return "yaml";
  if (mime.endsWith("+markdown") || mime === "text/markdown") return "markdown";
  switch (mime) {
    case "text/x-typescript":
      return "typescript";
    case "text/javascript":
      return "javascript";
    case "text/x-python":
      return "python";
    case "text/html":
      return "html";
    case "text/css":
      return "css";
    case "application/x-sh":
      return "shell";
    case "application/xml":
    case "image/svg+xml":
      return "xml";
    // The rest of `shared/mime.ts`'s TEXT table. Monaco's own language ids, which mostly are not
    // the subtype: `text/x-c++src` is `cpp`, `text/x-csharp` is `csharp`. A type with no entry is
    // plain text and shows uncoloured, which is the correct failure — never a wrong grammar.
    case "text/x-c":
      return "c";
    case "text/x-c++src":
      return "cpp";
    case "text/x-csharp":
      return "csharp";
    case "text/x-java":
      return "java";
    case "text/x-go":
      return "go";
    case "text/x-rust":
      return "rust";
    case "text/x-ruby":
      return "ruby";
    case "text/x-php":
      return "php";
    case "text/x-swift":
      return "swift";
    case "text/x-kotlin":
      return "kotlin";
    case "text/x-scala":
      return "scala";
    case "text/x-lua":
      return "lua";
    case "text/x-r":
      return "r";
    case "text/x-perl":
      return "perl";
    case "text/x-dart":
      return "dart";
    case "text/x-sql":
      return "sql";
    case "application/graphql":
      return "graphql";
    case "text/x-scss":
      return "scss";
    case "text/x-less":
      return "less";
    case "text/x-ini":
      return "ini";
    case "text/x-dockerfile":
      return "dockerfile";
    case "application/x-powershell":
      return "powershell";
    case "application/x-bat":
      return "bat";
    default:
      return "plaintext";
  }
}

/** The Monaco theme for the app's `data-theme` attribute. */
const themeOf = (): string => (document.documentElement.dataset["theme"] === "dark" ? "vs-dark" : "vs");

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
  /** A MIME type — mapped through {@link monacoLanguageOf}. */
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
    const language = monacoLanguageOf(mime);
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
      minimap: { enabled: false },
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
      ...editorFont(),
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
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
      monaco.editor.setTheme(themeOf());
      editor.updateOptions(editorFont());
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });

    return () => {
      ready.current?.(null);
      editorRef.current = null;
      themes.disconnect();
      edits.dispose();
      picks.dispose();
      for (const s of sized) s.dispose();
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
 * One text, coloured — the read-only sibling of the diff pane.
 *
 * Same worker wiring, same theme following, same MIME→language map; what differs is that there is
 * nothing to compare against. It exists because "show me the source" and "show me the source I can
 * read" are different requests, and a two-hundred-line state file in a `<pre>` is the second one
 * refused. Read-only throughout: this is a VIEW, and every surface that edits text in this app has
 * an editor of its own.
 */
export function MonacoCodePane({ text, mime }: { text: string; mime: string }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (node === null) return undefined;
    const model = monaco.editor.createModel(text, monacoLanguageOf(mime));
    const editor = monaco.editor.create(node, {
      model,
      automaticLayout: true,
      readOnly: true,
      // No cursor and no current-line highlight: those say "you are editing here", and nobody is.
      renderLineHighlight: "none",
      domReadOnly: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      theme: themeOf(),
      ...editorFont(),
    });
    // Theme AND typography: both are written onto the root — one as a data attribute, the other as
    // inline custom properties — so one observer covers both, and the editor follows a size slider
    // as it moves rather than at the next reopen.
    const themes = new MutationObserver(() => {
      monaco.editor.setTheme(themeOf());
      editor.updateOptions(editorFont());
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => {
      themes.disconnect();
      editor.dispose();
      model.dispose();
    };
  }, [text, mime]);

  return <div className="monaco-host" ref={host} />;
}

/**
 * One text, coloured, with NO editor behind it — what a fenced code block in a transcript gets.
 *
 * {@link MonacoCodePane} is the wrong tool at this size for three separate reasons, and only the
 * first is cost. An editor per fence is an editor per fence, and a thread holds dozens; it cannot
 * size itself to its content, so it needs a container height that a block inside a paragraph does
 * not have; and a Monaco instance is a scroll region, so a selection dragged from the prose above a
 * code block stops dead at its edge — copying an answer whole becomes impossible.
 *
 * `monaco.editor.colorize` is the tokenizer on its own. It returns the same spans the editor would
 * draw, and it registers the theme's stylesheet as a side effect, so the `.mtk*` classes resolve
 * with no editor anywhere on the page.
 *
 * ## Why this may set innerHTML when `markdown.tsx` may not
 *
 * The rule there is that nothing interpolates markup, and this does not break it. The string here
 * is BUILT by Monaco's line renderer from tokens, not passed through it: the renderer escapes `<`,
 * `>` and `&` as it appends each character, so the content arrives as text in every case and the
 * only tags present are the `<span class="mtkN">` the tokenizer emitted. An unregistered language
 * takes Monaco's own `_fakeColorize` path, which escapes identically and colours nothing.
 */
export function CodeText({ text, mime }: { text: string; mime: string }): JSX.Element {
  const [theme, setTheme] = useState(themeOf);
  const [html, setHtml] = useState<string | null>(null);

  // The colour of a class is theme-dependent, and so is which class a token gets — so a theme
  // change is a re-colorize, not just a restyle.
  useEffect(() => {
    const themes = new MutationObserver(() => setTheme(themeOf()));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => themes.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    monaco.editor.setTheme(theme);
    void monaco.editor
      .colorize(text, monacoLanguageOf(mime), { tabSize: 2 })
      .then((out) => {
        if (live) setHtml(out);
      })
      // Uncoloured is a rendering; a thrown grammar is not. The plain text below stands.
      .catch(() => {
        if (live) setHtml(null);
      });
    return () => {
      live = false;
    };
  }, [text, mime, theme]);

  // The source, plainly, until the tokens arrive — the same characters in the same box, so nothing
  // moves when the colour lands.
  if (html === null) {
    return (
      <pre className="code-text">
        <code>{text}</code>
      </pre>
    );
  }
  return (
    <pre className="code-text">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
