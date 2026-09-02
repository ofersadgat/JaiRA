/**
 * Markdown edited the way Obsidian edits it — one representation, no preview panel.
 *
 * The block-swap version this replaced turned a paragraph into a monospace textarea when you
 * clicked it. That is a mode change you can see, which is the one thing "seamless" rules out.
 *
 * ## How a live preview actually works
 *
 * CodeMirror 6 with DECORATIONS. The document in the editor is always the markdown source — nothing
 * is ever re-serialized, so there is no round trip to get wrong — and decorations do two things over
 * the top of it:
 *
 *  - **Style the content**: a heading is drawn large, `**bold**` is drawn bold, a link is drawn as a
 *    link. `syntaxHighlighting` with a tag→class map does this from the Lezer tree.
 *  - **Hide the syntax**: the `**`, the `#`, the `[](…)` are replaced with nothing — EXCEPT on the
 *    lines the cursor or selection touches, where they come back so the markup can be edited.
 *
 * That second rule is the whole illusion, and it is why this needs a parser rather than a regex: to
 * hide exactly the mark and not the word, you have to know which characters the grammar called a
 * mark. `@lezer/markdown` already tells us — every syntax mark is a node whose name ends in `Mark`.
 *
 * ## Why the cursor's line is the exception
 *
 * Because you cannot edit what you cannot see. Obsidian reveals per line; so does this. The
 * alternative — never showing the marks — is a WYSIWYG editor, which needs an inverse
 * transformation from rendered text back to markdown and is a different, much larger, and much
 * lossier program.
 */
import { useEffect, useMemo, useRef, type JSX } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { HighlightStyle, LanguageDescription, syntaxHighlighting, syntaxTree, type LanguageSupport } from "@codemirror/language";
import { codeMirrorGrammarOf, mimeOfFenceLang } from "@jaira/shared/browser";
import { Compartment, EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/**
 * The CodeMirror parser behind each grammar this app names — the loaders, and nothing else.
 *
 * The DECISION of which grammar a fence wants is not made here: it is `shared/grammars.ts`, keyed by MIME
 * type, and reached through `mimeOfFenceLang` like every other question about a format. This table
 * only says how to obtain the parser once that route has named one, which is why it is keyed by the
 * engine's own grammar name rather than by anything a document says.
 *
 * The split is about bundling as much as tidiness. Naming a grammar is a fact and costs nothing;
 * importing one drags a package into the chunk, and the table is read by every surface in the app,
 * most of which have no use for CodeMirror's parsers.
 *
 * YAML and JSON are the two that genuinely split into chunks of their own. The rest are already in
 * this module's bundle whether asked for or not — `lang-markdown` statically imports `lang-html`,
 * which statically imports `lang-css` and `lang-javascript` — so writing them as `import()` bought
 * nothing but four bundler warnings per build, and a build that always warns is one where a real
 * warning goes unread.
 */
const PARSERS: Record<string, () => Promise<LanguageSupport>> = {
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  javascript: async () => javascript(),
  typescript: async () => javascript({ typescript: true }),
  html: async () => html(),
  css: async () => css(),
};

/**
 * Which grammar to colour a fenced block with — `markdown()`'s own hook, routed the long way round.
 *
 * A FUNCTION rather than a list, which is what makes the single route possible: `codeLanguages` hands
 * over the fence's info string, and the answer comes back through exactly the pipeline a file path
 * takes — name → MIME → grammar. So ` ```yml `, `notes.yaml` and a tool result declared
 * `application/yaml` cannot disagree, and adding a format is one row in `shared/mime.ts` plus one in
 * `shared/grammars.ts`, with no surface to remember.
 *
 * `null` is the honest answer for a language nothing here has a parser for: the fence keeps its
 * background and its text, which is what an uncoloured block should look like.
 */
export function fenceLanguage(info: string): LanguageDescription | null {
  const name = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (name === "") return null;
  const mime = mimeOfFenceLang(name);
  const grammar = mime === undefined ? null : codeMirrorGrammarOf(mime);
  return grammar === null ? null : describe(grammar);
}

/**
 * One {@link LanguageDescription} per grammar, for the life of the module.
 *
 * MEMOISED, and the memo is load-bearing rather than a saving. A `LanguageDescription` caches its
 * parser on itself once `load()` resolves, and that is how `parseCode` knows on the next parse that
 * the nested grammar is ready to use. Minting a fresh description per call — which is what this did
 * — hands the parser an object that has never been loaded, every single time: the fence is left
 * unparsed, another load is started, and the result is thrown away. The block stays plain text
 * forever, and nothing anywhere reports a problem.
 *
 * That is why colouring a fenced block needs THREE things and looks broken with any two: the grammar
 * (`shared/grammars.ts`), a style that paints its tags ({@link LOOK}), and a description stable
 * enough to finish loading.
 */
const DESCRIPTIONS = new Map<string, LanguageDescription>();

function describe(grammar: string): LanguageDescription | null {
  const load = PARSERS[grammar];
  if (load === undefined) return null;
  const found = DESCRIPTIONS.get(grammar) ?? LanguageDescription.of({ name: grammar, load });
  DESCRIPTIONS.set(grammar, found);
  return found;
}

/**
 * How each markdown construct is drawn.
 *
 * Classes rather than inline styles, so the palette lives in `styles.css` with every other colour
 * and follows the theme without this file knowing there is one.
 */
export const LOOK = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-h1" },
  { tag: tags.heading2, class: "cm-h2" },
  { tag: tags.heading3, class: "cm-h3" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: "cm-h4" },
  { tag: tags.strong, class: "cm-strong" },
  { tag: tags.emphasis, class: "cm-em" },
  { tag: tags.strikethrough, class: "cm-strike" },
  { tag: [tags.monospace], class: "cm-code" },
  { tag: [tags.link, tags.url], class: "cm-link" },
  { tag: tags.quote, class: "cm-quote" },
  { tag: tags.list, class: "cm-list" },
  { tag: tags.contentSeparator, class: "cm-rule" },

  /**
   * …and the languages INSIDE the document, in the app's own palette.
   *
   * A `HighlightStyle` paints only the tags it lists, and this listed markdown's and nothing else —
   * so handing `markdown()` the nested grammars made a ```yaml block PARSE as YAML and left every
   * token of it unpainted. Two halves of one feature, and the first half on its own looks exactly
   * like no feature at all.
   *
   * The classes are `tok-*`, which is the same palette `jsonHighlight.ts` and `yamlHighlight.ts`
   * paint with. That is the point rather than a convenience: the same YAML shown in a transcript, in
   * a file's front matter and inside a fenced block in a document is now the same colours, because
   * all three name the same handful of CSS rules instead of each bringing a theme.
   */
  { tag: [tags.propertyName, tags.attributeName, tags.tagName], class: "tok-key" },
  { tag: [tags.string, tags.special(tags.string), tags.attributeValue], class: "tok-string" },
  { tag: [tags.number, tags.integer, tags.float], class: "tok-number" },
  { tag: [tags.bool, tags.null, tags.atom], class: "tok-literal" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "tok-comment" },
  { tag: [tags.punctuation, tags.separator, tags.bracket, tags.operator], class: "tok-punct" },
  {
    tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword, tags.moduleKeyword],
    class: "tok-keyword",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], class: "tok-type" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "tok-fn" },
  // Anchors and aliases — the parts of YAML that JSON has no word for, which `yamlHighlight` also
  // singles out. Same reasoning, same colour.
  //
  // `tags.meta` is deliberately NOT here, though it looks like it belongs: markdown's own syntax
  // marks carry it, so listing it painted every `#` and every ``` in the document as a literal.
  { tag: tags.labelName, class: "tok-literal" },
]);

/** Collapse a range to nothing. The marks are still in the document; they are just not drawn. */
const HIDDEN = Decoration.replace({});

/**
 * Which lines must show their markup: every line the selection touches.
 *
 * Lines rather than nodes, because a cursor inside `**bold**` should reveal the whole construct
 * rather than half of it, and because "the line I am on looks like source" is a rule a person can
 * hold in their head after seeing it once.
 */
function revealedLines(state: EditorState, focused: boolean): Set<number> {
  const lines = new Set<number>();
  // Nothing is being edited, so nothing needs its markup: an unfocused editor is a rendered
  // document, which is exactly what a read-only one has to be.
  if (!focused) return lines;
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let line = from; line <= to; line++) lines.add(line);
  }
  return lines;
}

/** Hide every syntax mark whose line is not revealed. */
function marks(state: EditorState, focused: boolean): DecorationSet {
  const reveal = revealedLines(state, focused);
  const found: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      // Every syntax mark in `@lezer/markdown` is named `…Mark` — `EmphasisMark`, `HeaderMark`,
      // `LinkMark`, `CodeMark`, `QuoteMark`, `ListMark`. Asking the grammar rather than matching
      // characters is what keeps `2 * 3 * 4` from losing its asterisks.
      if (!node.name.endsWith("Mark")) return;
      // A list bullet is not decoration — remove it and the list stops looking like one.
      if (node.name === "ListMark" || node.name === "QuoteMark") return;
      if (node.from === node.to) return;
      if (reveal.has(state.doc.lineAt(node.from).number)) return;
      found.push(HIDDEN.range(node.from, node.to));
    },
  });
  return Decoration.set(found, true);
}

/**
 * A view plugin rather than a state field, because the answer depends on FOCUS.
 *
 * An editor nobody is typing in still has a selection — a cursor at offset 0 — so a field that knew
 * only about state revealed the first line's markup permanently, and every document opened with a
 * bare `#` sitting in front of its title. Focus is a property of the view, not of the document,
 * which is what puts this here.
 */
const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = marks(view.state, view.hasFocus);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
        this.decorations = marks(update.state, update.view.hasFocus);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// --- showing a diff in the same editor ---------------------------------------

/**
 * Render a change WITHOUT leaving the document, and without giving up editing it.
 *
 * Two things this has to get right, and the first version got both wrong.
 *
 * **The document stays the new text.** An earlier version built a merged string with both versions
 * in it and showed that — which meant the moment you typed one character the artifact turned into a
 * read-only diff and you could not carry on writing. Here the document is exactly what you are
 * writing, always editable, and the REMOVED text is drawn as widgets that are not in the document at
 * all. Nothing about reading the change interrupts making it.
 *
 * **The granularity is words, not lines.** The stored hunks are line-ranges — the right unit for
 * APPLYING a change, since applying them has to reproduce the new text byte for byte — and the
 * wrong unit for reading prose, where a one-word fix showed the whole paragraph struck through and
 * then again intact. So each hunk is refined into word-level pieces for display only. This never
 * feeds back into what gets applied; it is a reading of a decision already made.
 */
export interface MarkdownDiff {
  before: string;
  after: string;
  hunks: readonly { start: number; end: number; text: string }[];
}

/** Where the change shows in the NEW text: ranges that were added, and points where text was cut. */
export interface DiffSpans {
  added: [number, number][];
  removed: { at: number; text: string }[];
}

/**
 * Split for diffing: words, runs of whitespace, and single punctuation.
 *
 * Whitespace is its own token rather than being glued to a word, so changing `probe` to `probes`
 * marks four characters instead of swallowing the space on either side — which is the difference
 * between a mark that points at a word and one that points at a phrase.
 */
function tokens(text: string): string[] {
  return text.match(/\s+|[A-Za-z0-9_'’-]+|[^\s]/gu) ?? [];
}

/**
 * A word-level diff of two token runs, as a flat script.
 *
 * Common prefix and suffix are trimmed first — for an edit inside a paragraph that is nearly all of
 * it — and the remainder goes through a plain LCS table. Bounded because the remainder after
 * trimming is small in the case this exists for; a pathological pair falls back to "all removed,
 * all added", which is exactly what the line strategy would have said anyway.
 */
function wordScript(before: string, after: string): Array<{ kind: "same" | "del" | "add"; text: string }> {
  const a = tokens(before);
  const b = tokens(after);
  const script: Array<{ kind: "same" | "del" | "add"; text: string }> = [];

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (head > 0) script.push({ kind: "same", text: a.slice(0, head).join("") });

  const CAP = 400;
  if (midA.length > CAP || midB.length > CAP) {
    if (midA.length > 0) script.push({ kind: "del", text: midA.join("") });
    if (midB.length > 0) script.push({ kind: "add", text: midB.join("") });
  } else {
    // Longest common subsequence, then walked back into a script.
    const table: number[][] = Array.from({ length: midA.length + 1 }, () => new Array<number>(midB.length + 1).fill(0));
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    const push = (kind: "same" | "del" | "add", text: string): void => {
      const last = script[script.length - 1];
      if (last !== undefined && last.kind === kind) last.text += text;
      else script.push({ kind, text });
    };
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        push("same", midA[i]!);
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        push("del", midA[i]!);
        i++;
      } else {
        push("add", midB[j]!);
        j++;
      }
    }
    if (i < midA.length) push("del", midA.slice(i).join(""));
    if (j < midB.length) push("add", midB.slice(j).join(""));
  }

  if (tail > 0) script.push({ kind: "same", text: a.slice(a.length - tail).join("") });
  return script;
}

/** Turn the stored hunks into positions in the NEW text. */
export function diffSpans(diff: MarkdownDiff): DiffSpans {
  const added: [number, number][] = [];
  const removed: { at: number; text: string }[] = [];
  const ordered = [...diff.hunks].sort((a, b) => a.start - b.start || a.end - b.end);
  // How far the new text has drifted from the old one at this point — the sum of every earlier
  // hunk's growth. It is what converts a `before` offset into an `after` offset.
  let drift = 0;
  for (const hunk of ordered) {
    let at = hunk.start + drift;
    for (const piece of wordScript(diff.before.slice(hunk.start, hunk.end), hunk.text)) {
      if (piece.kind === "same") at += piece.text.length;
      else if (piece.kind === "add") {
        added.push([at, at + piece.text.length]);
        at += piece.text.length;
      } else {
        removed.push({ at, text: piece.text });
      }
    }
    drift += hunk.text.length - (hunk.end - hunk.start);
  }
  return { added, removed };
}

/**
 * Text that is no longer in the document, drawn where it used to be.
 *
 * A widget rather than content, which is the whole reason the editor stays usable: the removed
 * words are painted into the line without being part of the document, so typing, selecting and
 * saving all behave as though they are not there — because they are not.
 */
class RemovedText extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: RemovedText): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-del";
    /**
     * A newline inside the widget must not BE a newline.
     *
     * CodeMirror's content is `white-space: pre-wrap`, so a literal `
` in here renders as a real
     * line break inside a line the editor believes is one line — which is why typing a single space
     * as the first edit drew a line break instead: the hunk's removed run was the old line ending,
     * and the widget rendered it. Shown as a pilcrow instead, which is both layout-safe and the more
     * honest picture: a line break was removed, and here is where it was.
     */
    span.textContent = this.text.replace(/\n/gu, "¶");
    // Never a caret target: it is a record of what was cut, not somewhere to type.
    span.contentEditable = "false";
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

function diffDecorations(spans: DiffSpans, length: number): Extension {
  const found: Range<Decoration>[] = [];
  for (const [from, to] of spans.added) {
    if (from >= 0 && to <= length && to > from) found.push(Decoration.mark({ class: "cm-add" }).range(from, to));
  }
  for (const cut of spans.removed) {
    if (cut.at >= 0 && cut.at <= length) {
      found.push(Decoration.widget({ widget: new RemovedText(cut.text), side: -1 }).range(cut.at));
    }
  }
  return EditorView.decorations.of(
    Decoration.set(
      found.sort((a, b) => a.from - b.from || a.to - b.to),
      true,
    ),
  );
}

/** Typography and spacing that belong to the editor rather than to a token. */
const THEME = EditorView.theme({
  "&": { fontSize: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "inherit", padding: "8px 2px", lineHeight: "1.6" },
  ".cm-line": { padding: "0 2px" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6" },
});

/**
 * The editor.
 *
 * `readOnly` gives a markdown VIEW: the same decorations with nothing editable, so what a reader
 * sees and what a writer sees are one component rather than two that drift.
 */
export function MarkdownEditor({
  text,
  onChange,
  readOnly,
  diff,
}: {
  text: string;
  onChange?: ((next: string) => void) | undefined;
  readOnly?: boolean;
  /**
   * Show a change ALONGSIDE the document, rather than instead of it.
   *
   * The document stays what you are writing and stays editable; the removed text is drawn as
   * widgets beside it. Reading the change and making it are the same activity here.
   */
  diff?: MarkdownDiff | undefined;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const report = useRef(onChange);
  report.current = onChange;
  /** Swapped when the change moves, so the editor is never re-created for it. */
  const diffs = useRef(new Compartment());
  const spans = useMemo(() => (diff === undefined ? null : diffSpans(diff)), [diff?.before, diff?.after, diff?.hunks]);
  const writable = readOnly !== true;
  /** Swapped rather than re-created, so toggling read-only keeps the caret and the undo history. */
  const editable = useRef(new Compartment());

  useEffect(() => {
    const node = host.current;
    if (node === null) return undefined;
    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
      syntaxHighlighting(LOOK),
      livePreview,
      EditorView.lineWrapping,
      THEME,
      editable.current.of(EditorView.editable.of(writable)),
      diffs.current.of(spans === null ? [] : diffDecorations(spans, text.length)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) report.current?.(update.state.doc.toString());
      }),
    ];
    const editor = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: node });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
    // Created ONCE. Everything that moves afterwards — the text, the diff, whether it is writable —
    // is followed by the effects below, because re-creating would discard the caret on every
    // keystroke and there is no keystroke that should cost you your place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Follow the `text` prop when it moves for a reason that is not this editor.
   *
   * Guarded on inequality: text the person just typed is already the document by the time the prop
   * catches up, and writing it back would collapse their selection to the end on every keystroke.
   */
  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    const current = editor.state.doc.toString();
    if (current !== text) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: text } });
    }
  }, [text]);

  /** Follow the change itself, without touching the document or the caret. */
  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    editor.dispatch({
      effects: diffs.current.reconfigure(spans === null ? [] : diffDecorations(spans, editor.state.doc.length)),
    });
  }, [spans]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure(EditorView.editable.of(writable)) });
  }, [writable]);

  return <div className={writable ? "md-editor" : "md-editor read-only"} ref={host} />;
}
