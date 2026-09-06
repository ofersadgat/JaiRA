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
import { createElement, useEffect, useMemo, useRef, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { HighlightStyle, LanguageDescription, syntaxHighlighting, syntaxTree, type LanguageSupport } from "@codemirror/language";
import { codeMirrorGrammarOf, mimeOfFenceLang } from "@jaira/shared/browser";
import { fenceRenderer } from "./markdown";
import MarkdownIt from "markdown-it";
import { Compartment, EditorState, Facet, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorLook, onEditorLook } from "./editorLook";
import { tags } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";

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
 * The characters the widgets draw, named once.
 *
 * Up here rather than inline in each `toDOM` so that a widget can also SAY what it draws — see
 * {@link SoftBreak.text}. The reading tests assemble a document out of those, which is the only
 * way to check the rendering in a package with no DOM to render into.
 */
const BULLET_CHAR = "\u2022";
const EMPTY_CHAR = "\u2610";
const TICKED_CHAR = "\u2611";

/**
 * The single space a wrapped line becomes.
 *
 * A widget rather than an empty replacement because joining two lines with nothing between them
 * runs the last word of one into the first of the next: "the formalism isnormative in".
 */
class SoftBreak extends WidgetType {
  /**
   * What it draws.
   *
   * Read by `toDOM` AND by the reading tests, which assemble a document out of what the widgets
   * say they show — the only way to check a rendering in a package with no DOM to render into. One
   * field means the picture and the assertion cannot drift apart.
   */
  readonly text = " ";
  eq(): boolean {
    // Every soft break is the same soft break, so CodeMirror never rebuilds one.
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-softbreak";
    span.textContent = this.text;
    return span;
  }
}

/**
 * The bullet a `-` becomes.
 *
 * `ListMark` was the one mark deliberately left visible, on the reasoning that a bullet is not
 * decoration — take it away and the list stops looking like one. That reasoning was right about what
 * must not happen and wrong about the remedy: the mark does not have to be HIDDEN to stop being
 * source, it has to be DRAWN. A rendered list has a bullet, and `-` is the way markdown spells one.
 *
 * Only for an unordered list. An ordered list's mark is `1.`, which is not notation for a number —
 * it is the number, and it is the content.
 */
class Bullet extends WidgetType {
  /** What it draws — see {@link SoftBreak.text}. */
  readonly text = BULLET_CHAR;
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const dot = document.createElement("span");
    dot.className = "cm-bullet";
    dot.textContent = this.text;
    return dot;
  }
}

/** The bullet, as a replacement for the character that asked for it. */
const BULLET = Decoration.replace({ widget: new Bullet() });

/**
 * The box a `[ ]` becomes.
 *
 * GFM's task list, drawn. `TaskMarker` carried `tags.atom` and no rule painted it, so a checklist
 * came out as literal brackets — the one construct in the language whose whole point is a control
 * you can see the state of at a glance.
 *
 * Drawn, not interactive: this is a document, and the way to tick a box in a document is to type an
 * `x` in it. A widget you can click would be a second way to make an edit, with its own undo entry
 * and its own disagreement with the text.
 */
class Task extends WidgetType {
  constructor(private readonly done: boolean) {
    super();
  }
  /** What it draws — see {@link SoftBreak.text}. */
  get text(): string {
    return this.done ? TICKED_CHAR : EMPTY_CHAR;
  }
  eq(other: Task): boolean {
    return other.done === this.done;
  }
  toDOM(): HTMLElement {
    const box = document.createElement("span");
    box.className = this.done ? "cm-task cm-task-done" : "cm-task";
    box.textContent = this.text;
    return box;
  }
}

/**
 * A hard-wrapped paragraph, drawn as the one paragraph it is.
 *
 * Markdown joins lines inside a paragraph — a single newline is a space, which is why the reading
 * renderer shows a wrapped list item as one flowing sentence. The editor showed the document's own
 * lines instead, so every hard-wrapped file came out full of breaks that are not in the rendering
 * and are not in the meaning. This replaces the newline, and the continuation indent after it, with
 * that space.
 *
 * Only where neither line is revealed. With the caret on either side the source comes back, and you
 * are editing the lines you actually have.
 */
const JOIN = Decoration.replace({ widget: new SoftBreak() });

// --- a fenced block, drawn by the pipeline that draws every other document ----

/**
 * How the editor reaches the view layer, and why it is a facet rather than an import.
 *
 * A fence is a document embedded in a document: it has a language, that language has a MIME type,
 * and this app already has exactly one place that turns a MIME type into a component — the same
 * route a `.ts` file in the tree takes. Drawing a fence any other way is a second opinion about what
 * a type is worth showing as, which is the mistake `fenceRender.tsx`'s header is written about.
 *
 * So this module holds no map. It asks {@link fenceRenderer} for whatever was registered, which is
 * `ValueView` behind a MIME hint — Monaco where Monaco has a grammar, the rendered reading where the
 * type has one, and the source box where it has neither. The toggle comes with it, which is the
 * other thing the editor was missing beside the languages.
 *
 * The facet carries the live {@link EditorView}, because {@link marks} is a pure function of state
 * and a widget built there still has to be able to write back. Set once, when the editor is created.
 */
interface FenceHost {
  view: EditorView | null;
}

const fenceHost = Facet.define<FenceHost, FenceHost | null>({
  combine: (values) => values[0] ?? null,
});

/** The contents of a fence, and where they sit. */
interface FenceBody {
  /** Where the contents start and end, EXCLUDING the delimiter lines. */
  from: number;
  to: number;
  /** The first word of the info string, lowercased: the part anybody dispatches on. */
  lang: string;
}

/**
 * Find a fence's contents, given its node.
 *
 * The delimiter lines are the fence's own punctuation and are not part of what it holds, so the body
 * is what lies between them — which is also why replacing the whole node with a widget is what makes
 * the blank first and last lines go away. They were the delimiters, drawn with their text hidden.
 *
 * A fence with no `CodeText` at all is an empty one, and both ends collapse onto the line after the
 * opening delimiter.
 */
function fenceBody(state: EditorState, node: SyntaxNode): FenceBody {
  const info = node.getChild("CodeInfo");
  const named = info === null ? "" : state.doc.sliceString(info.from, info.to).trim();
  const lang = named.split(/\s+/u)[0]?.toLowerCase() ?? "";
  const text = node.getChild("CodeText");
  if (text !== null) return { from: text.from, to: text.to, lang };
  const open = state.doc.lineAt(node.from);
  const start = Math.min(open.to + 1, node.to);
  return { from: start, to: start, lang };
}

/**
 * Roughly how tall a fence holding this text will be.
 *
 * Deliberately arithmetic rather than a measurement: it is asked before anything exists to measure,
 * which is the whole point of it. The numbers are the data font's line height and the chrome
 * `ValueView` puts above a block — a header row and the block's own padding — and being a few pixels
 * out costs nothing, because the observer corrects it on the next frame. Being ZERO out is what
 * costs, and that is what this exists to avoid.
 */
function fenceHeight(source: string): number {
  const lines = source === "" ? 1 : source.split(/\r?\n/u).length;
  return lines * 19 + 46;
}

/**
 * A fenced block, replaced by whatever the pipeline says draws that type.
 *
 * ## Why this may mount a component at all
 *
 * `documents.tsx` used to say an editor cannot host one — "its document is text with decorations
 * over it, not a place to mount a component" — and the same file contradicted it twelve lines later.
 * A block widget IS a place to mount a component. What it costs is the three things below, and each
 * of them is a real defect if it is skipped rather than a tidiness point.
 *
 * **1. It must not remount.** {@link eq} compares the source, the language and the writability, so
 * typing in a paragraph elsewhere leaves every fence's DOM — and every Monaco instance inside one —
 * exactly where it was. Without that, each keystroke tears down and rebuilds every editor on screen.
 *
 * **2. Its height arrives late.** Monaco is lazily imported, so the widget is one height at mount and
 * another a moment later, by which time CodeMirror has already placed everything below it. The
 * `ResizeObserver` is what asks the editor to measure again; without it the text below a fence sits
 * at the wrong offset until something unrelated forces a reflow.
 *
 * **3. Its events are its own.** {@link ignoreEvent} returns true, so a click inside Monaco does not
 * move the outer selection. That is also what keeps the block on screen at all: a fence swaps back to
 * raw source when the outer caret is inside its range, so without this, clicking the block to edit it
 * would be the very gesture that replaced it with text.
 */
export class CodeFence extends WidgetType {
  private root: Root | null = null;
  private watching: ResizeObserver | null = null;
  private dom: HTMLElement | null = null;

  constructor(
    /** The block's CONTENTS — no delimiter lines, and no trailing newline of the closing one. */
    readonly source: string,
    /** The first word of the info string, lowercased. Empty for a fence with none. */
    readonly lang: string,
    private readonly writable: boolean,
    private readonly host: FenceHost | null,
  ) {
    super();
  }

  eq(other: CodeFence): boolean {
    return other.source === this.source && other.lang === this.lang && other.writable === this.writable;
  }

  /**
   * How tall this will be, told to CodeMirror BEFORE anything is drawn.
   *
   * The default is `-1` — "I don't know" — and for a widget whose DOM is built synchronously that
   * costs nothing, because the real height is available the moment `toDOM` returns. This one is not
   * that widget. `createRoot().render()` schedules React work rather than performing it, so `toDOM`
   * returns an EMPTY div, and the first thing CodeMirror measures is a fence zero pixels tall. Every
   * line below it is then laid out against a height that is wrong, and stays wrong until the
   * observer fires and asks for a re-measure — which is a document that assembles itself on screen
   * instead of appearing.
   *
   * An estimate does not have to be right to help; it has to be CLOSE, so the first layout is near
   * enough that the correction is invisible. Line count times the line height, plus the block's own
   * chrome, is close for every fence that is not doing something strange.
   *
   * MEASURED, not assumed. A floor on the element itself was tried alongside this and backed out:
   * the harness's first-render probe reports the fences at 32 and 54 pixels the moment they are
   * built, not at zero, so React had already filled them — and a floor of 65 was making two blocks
   * the wrong height to fix something that was not happening. This getter is kept because it is
   * consulted only for content CodeMirror has NOT drawn, where the honest alternative is `-1`.
   */
  override get estimatedHeight(): number {
    return fenceHeight(this.source);
  }

  /**
   * Where this widget's contents are NOW.
   *
   * Asked of the DOM rather than remembered from construction, because a widget built at one offset
   * outlives edits made above it, and a stale range would write the block's own text over somebody
   * else's paragraph. `posAtDOM` is CodeMirror's answer to "where is this element in the document";
   * resolving the fence from there keeps the range right however much the text above it has moved.
   */
  private where(view: EditorView): FenceBody | null {
    if (this.dom === null) return null;
    const at = view.posAtDOM(this.dom);
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(at, 1);
    while (node !== null) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return fenceBody(view.state, node);
      node = node.parent;
    }
    return null;
  }

  /**
   * Draw this widget's contents into whatever root it currently owns.
   *
   * Split out of {@link toDOM} because {@link updateDOM} has to do exactly the same thing to a root
   * it inherited, and the two drifting apart would mean a fence that renders one way when it appears
   * and another way when it changes.
   */
  private paint(view: EditorView): void {
    const edit = (next: string): void => {
      const live = this.host?.view ?? view;
      const at = this.where(live);
      // Identical text is not a change. Dispatching it anyway would rebuild this widget from its own
      // output on every render React happens to run, which is a loop with no edit in it.
      if (at === null || next === live.state.doc.sliceString(at.from, at.to)) return;
      live.dispatch({ changes: { from: at.from, to: at.to, insert: next } });
    };

    const draw = fenceRenderer();
    const node = draw?.({
      info: this.lang,
      lang: this.lang,
      code: this.source,
      ...(this.writable ? { edit } : {}),
    });
    // A type the pipeline has nothing for. Showing the source keeps the block visible and keeps it a
    // block, which is the same answer the reading fold gives for an unrecognised language.
    this.root?.render(node ?? createElement("pre", { className: "vv-source" }, this.source));
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-fence-block";
    this.dom = wrap;
    this.root = createRoot(wrap);
    this.paint(view);

    // See (2). Observing the wrapper rather than the editor inside it catches every reason the height
    // moves: the lazy import landing, the view toggle being flipped, the window being resized.
    this.watching = new ResizeObserver(() => (this.host?.view ?? view).requestMeasure());
    this.watching.observe(wrap);
    return wrap;
  }

  /**
   * Adopt the previous widget's DOM instead of getting a new one — the whole reason this is usable.
   *
   * {@link eq} compares the source, and the source changes on EVERY keystroke typed into the block.
   * Without this, each of those keystrokes is a widget CodeMirror considers different: it destroys
   * the old one, builds a new one, and mounts a second Monaco — which means the editor you are
   * typing into is torn down between one character and the next, taking the caret, the undo history
   * and the scroll position with it.
   *
   * CodeMirror hands the previous widget as the third argument, so the root and the observer move
   * across directly rather than being fished off the DOM node. Returning true is what tells it the
   * element was updated in place and must not be replaced.
   */
  updateDOM(dom: HTMLElement, view: EditorView, previous: CodeFence): boolean {
    this.dom = dom;
    this.root = previous.root;
    this.watching = previous.watching;
    // The old instance no longer owns any of it, so its `destroy` must not unmount a root that this
    // one is now drawing into.
    previous.root = null;
    previous.watching = null;
    previous.dom = null;
    if (this.root === null) return false;
    this.paint(view);
    return true;
  }

  /**
   * Torn down explicitly, because React and `ResizeObserver` both outlive the DOM node otherwise.
   *
   * The unmount is DEFERRED. CodeMirror calls this synchronously from inside its own update, and
   * unmounting a React root while React is rendering throws; a microtask is late enough to be outside
   * both and early enough that nothing else can reach the root in between.
   */
  destroy(): void {
    this.watching?.disconnect();
    this.watching = null;
    const root = this.root;
    this.root = null;
    this.dom = null;
    if (root !== null) queueMicrotask(() => root.unmount());
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// --- a table, actually drawn ------------------------------------------------

/**
 * Why a table is the one construct that needs a WIDGET.
 *
 * Everything else the live preview does is a property some run of characters has: bold is a weight,
 * a heading is a size, a quote is a border on a line. A table is none of those — it is an agreement
 * about width BETWEEN lines, and CodeMirror draws each line in its own element. No amount of styling
 * one line can tell it how wide the second column is in the next one.
 *
 * The first attempt at this banded the rows in a monospaced font, on the theory that equal character
 * widths would stack the pipes into columns. That works only for a table whose source is already
 * padded to a rectangle, which almost none are, so `| a | b |` over `| longer | b |` still came out
 * ragged. Aligning was never going to be laying out.
 *
 * So the table's lines are replaced — block-level, whole lines, an honest `<table>` in their place —
 * and the source comes back the moment the caret is inside it. That swap is the same rule the rest
 * of the editor already follows, applied to a block instead of a line.
 */

/** Inline markdown inside a cell, folded to DOM. */
const CELL = new MarkdownIt({ html: false, linkify: false, breaks: false });

/**
 * A cell's text, with its inline marks drawn.
 *
 * Built from markdown-it's TOKENS rather than from its HTML, and appended as nodes rather than
 * assigned to `innerHTML`. That is the same rule `markdown.tsx` states at length: this renderer runs
 * in a privileged process, so nothing here interpolates markup and every element is one this module
 * chose by name. A cell holding `<img onerror=…>` is text, because `html: false` made it text and
 * `textContent` keeps it that way.
 *
 * Only the marks that appear in a table cell are handled. Anything else — a nested fence, an image —
 * arrives as its own text, which is what the source said and is legible.
 */
function cellContent(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const stack: Node[] = [out];
  const top = (): Node => stack[stack.length - 1]!;
  const open = (tag: string, className?: string): void => {
    const el = document.createElement(tag);
    if (className !== undefined) el.className = className;
    top().appendChild(el);
    stack.push(el);
  };
  for (const token of CELL.parseInline(text, {})[0]?.children ?? []) {
    switch (token.type) {
      case "text":
        top().appendChild(document.createTextNode(token.content));
        break;
      case "code_inline": {
        const el = document.createElement("code");
        el.textContent = token.content;
        top().appendChild(el);
        break;
      }
      case "strong_open":
        open("strong");
        break;
      case "em_open":
        open("em");
        break;
      case "s_open":
        open("s");
        break;
      case "link_open": {
        // Drawn as a link, not wired as one: a click inside the widget belongs to the editor, and a
        // renderer process that follows an href out of a document is a navigation nobody asked for.
        open("span", "cm-table-link");
        break;
      }
      case "strong_close":
      case "em_close":
      case "s_close":
      case "link_close":
        if (stack.length > 1) stack.pop();
        break;
      case "softbreak":
      case "hardbreak":
        top().appendChild(document.createTextNode(" "));
        break;
      default:
        top().appendChild(document.createTextNode(token.content));
    }
  }
  return out;
}

/** Split one table row into its cells, respecting `\|` and the optional outer pipes. */
export function rowCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  // A leading and a trailing pipe are optional in GFM, and produce an empty cell on each end when
  // present. Dropping them here is what lets both spellings render as the same table.
  if (cells.length > 0 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((text) => text.trim());
}

/** `:---`, `:---:`, `---:` — the only thing the delimiter row carries besides its own shape. */
export function columnAlign(spec: string): "left" | "center" | "right" | null {
  const text = spec.trim();
  const left = text.startsWith(":");
  const right = text.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/**
 * The table, as a table.
 *
 * `eq` compares the SOURCE, so typing anywhere else in the document leaves this widget's DOM in
 * place — CodeMirror only rebuilds it when the table's own text changes. That matters more than it
 * looks: a widget rebuilt on every keystroke would re-measure its own height on every keystroke, and
 * the editor would scroll under the caret while you typed a paragraph three screens below.
 */
export class TableBlock extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }

  eq(other: TableBlock): boolean {
    return other.source === this.source;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-block";
    const table = document.createElement("table");
    const lines = this.source.split(/\r?\n/);
    const align = (lines[1] === undefined ? [] : rowCells(lines[1])).map(columnAlign);
    const head = document.createElement("thead");
    const body = document.createElement("tbody");

    lines.forEach((line, index) => {
      // Row 1 is the `---|---` rule: it says how the columns line up and is not itself a row.
      if (index === 1 || line.trim() === "") return;
      const tr = document.createElement("tr");
      rowCells(line).forEach((text, column) => {
        const cell = document.createElement(index === 0 ? "th" : "td");
        const how = align[column] ?? null;
        if (how !== null) cell.style.textAlign = how;
        cell.appendChild(cellContent(text));
        tr.appendChild(cell);
      });
      (index === 0 ? head : body).appendChild(tr);
    });

    table.appendChild(head);
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  /**
   * Events reach the editor, so clicking the table puts the caret next to it and the source appears.
   *
   * That is the whole way in and out: there is no separate "edit this table" affordance to discover,
   * because the rule is the one every other construct here already taught you.
   */
  ignoreEvent(): boolean {
    return false;
  }
}

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

/**
 * A band across whole lines — what a border, an indent or a background needs.
 *
 * The inline decorations above can only style CHARACTERS, which is why three constructs came out
 * looking like their own source. A blockquote is a rule down the left margin; a fenced block is a
 * panel behind several lines; a table is a grid. None of those is a property any run of text has,
 * so none of them could be drawn until the fold started emitting LINE decorations too.
 *
 * A view plugin may provide these. The restriction people remember — that decorations changing the
 * vertical layout must come from a state field — is about BLOCK widgets and replaced line breaks;
 * a line decoration only puts a class on the line's own element, and the layout is whatever CSS
 * then does with it.
 */
const LINE = {
  quote: Decoration.line({ class: "cm-quote-line" }),
  code: Decoration.line({ class: "cm-code-line" }),
  codeClose: Decoration.line({ class: "cm-code-line cm-code-close" }),
  table: Decoration.line({ class: "cm-table-line" }),
  /** A thematic break, drawn as the line it means rather than as the dashes that ask for it. */
  rule: Decoration.line({ class: "cm-hr-line" }),
  /** A link definition — machinery, left as written and dimmed. */
  linkref: Decoration.line({ class: "cm-linkref-line" }),
  tableHead: Decoration.line({ class: "cm-table-line cm-table-head" }),
  tableRule: Decoration.line({ class: "cm-table-line cm-table-rule" }),
};

/** The opening line of a fence, carrying its language so CSS can label the block. */
function codeOpen(lang: string): Decoration {
  return Decoration.line({
    class: "cm-code-line cm-code-open",
    ...(lang === "" ? {} : { attributes: { "data-lang": lang } }),
  });
}

/** The pipes in a table row, dimmed — by NAME, because their tag is every other mark's tag too. */
const TABLE_DELIM = Decoration.mark({ class: "cm-table-delim" });

/**
 * An image's alt text, marked as an image.
 *
 * `@lezer/markdown` gives `Image/...` the same `tags.link` a link gets, so with the `![` and the URL
 * hidden an image was drawn as an underlined link to nowhere — a claim about what clicking it would
 * do, on the one construct that is not a destination at all. There is no picture to put here (the
 * file is a path this editor cannot resolve), so the alt text is what there is, and this says that
 * is what you are reading.
 */
const IMAGE = Decoration.mark({ class: "cm-image" });

/**
 * Hide every syntax mark whose line is not revealed, and band the blocks that need one.
 *
 * The two halves are one pass because they answer to the same reveal set: a line you are editing
 * shows its source, and that has to mean the same thing for a fence as it does for `**bold**`.
 */
export function marks(state: EditorState, focused: boolean): DecorationSet {
  const reveal = revealedLines(state, focused);
  const found: Range<Decoration>[] = [];

  /**
   * The breaks this pass has already closed, so nothing hides a character twice.
   *
   * CodeMirror rejects two replacements that overlap, and a joined line's `> ` is inside the join.
   * Collected rather than looked up on the tree because the paragraph is what knows where its own
   * continuations are.
   */
  const joined: Array<[number, number]> = [];
  const isJoined = (from: number, to: number): boolean =>
    joined.some(([start, end]) => from >= start && to <= end);

  /** Put a line decoration on every line a node covers. `pick` sees where in the run it is. */
  const band = (from: number, to: number, pick: (index: number, last: boolean) => Decoration): void => {
    let pos = from;
    for (let index = 0; pos <= to; index++) {
      const line = state.doc.lineAt(pos);
      found.push(pick(index, line.to >= to).range(line.from));
      if (line.to >= to) return;
      pos = line.to + 1;
    }
  };

  syntaxTree(state).iterate({
    enter: (node) => {
      /**
       * A quote is a rule down the margin, so the `>` finally has something to become.
       *
       * It was exempted from hiding along with `ListMark`, and for `ListMark` that is still right:
       * take away a bullet and the list stops looking like one, because nothing replaces it. A
       * blockquote is not in that position any more — the border says "quoted" better than the
       * character does — so the exemption below now names only the bullet.
       */
      if (node.name === "Blockquote") {
        band(node.from, node.to, () => LINE.quote);
        return;
      }
      /**
       * A link DEFINITION is not prose, so nothing here rewrites it.
       *
       * `[ref]: https://example.com/ref` parses as `LinkLabel`, a `LinkMark` for the colon, and a
       * `URL`. The generic mark rule hid the colon and nothing else, which left `[ref]
       * https://example.com/ref` — a line that is neither the source nor a rendering of it. A
       * definition has no rendered form: it is machinery, referred to from somewhere else on the
       * page. So it stays exactly as written and is merely dimmed, which is the honest drawing of
       * something that is there for the document rather than for the reader.
       */
      if (node.name === "LinkReference") {
        band(node.from, node.to, () => LINE.linkref);
        return false;
      }
      /**
       * A Setext underline is NOTATION, not a line of the document.
       *
       * `======` under a title is how the heading says it is a heading, and hiding the characters
       * left the row they were on — an empty line the height of a paragraph under every Setext
       * heading in the file. The row goes with them: the replacement starts at the end of the title
       * and takes the line break with it, which is a thing only a state field may do.
       */
      if (node.name === "SetextHeading1" || node.name === "SetextHeading2") {
        const mark = node.node.getChild("HeaderMark");
        if (mark === null) return;
        const rule = state.doc.lineAt(mark.from);
        // `false` either way: revealed, the children must NOT be visited, or the generic mark rule
        // would hide the underline that revealing is supposed to bring back.
        if (reveal.has(rule.number) || reveal.has(rule.number - 1)) return false;
        found.push(HIDDEN.range(state.doc.line(rule.number - 1).to, rule.to));
        return false;
      }
      /**
       * A thematic break is a LINE, and `---` is only how you ask for one.
       *
       * It had `tags.contentSeparator` and a colour, which draws three dim hyphens — the source, in
       * a quieter grey. The characters go and the line is drawn across the row they were on; see
       * `.cm-hr-line`, which centres a rule in a row that is now empty.
       */
      if (node.name === "HorizontalRule") {
        const line = state.doc.lineAt(node.from);
        found.push(LINE.rule.range(line.from));
        if (!reveal.has(line.number) && node.to > node.from) found.push(HIDDEN.range(node.from, node.to));
        return false;
      }
      /**
       * A list item's wrapped lines hang under its text, not under its bullet.
       *
       * `EditorView.lineWrapping` breaks a long line at the pane's edge and starts the next one at
       * the margin, so a two-line bullet came back to the far left and read as a new paragraph
       * rather than as more of the same item. A hanging indent is the fix: pad the whole line by the
       * width of the marker, then pull the first line back out by the same amount.
       *
       * Measured from the START of the line rather than from the mark, so a nested item's leading
       * spaces are inside the indent and each level hangs under its own text. `ch` is the width of a
       * `0`, which is exact in the data font and close in the prose one — close is what this needs,
       * since being a few pixels out moves a wrap point and nothing else.
       */
      if (node.name === "ListItem") {
        const mark = node.node.getChild("ListMark");
        if (mark === null) return;
        const line = state.doc.lineAt(node.from);
        /**
         * The width to hang by is what is DRAWN before the text, not what is written before it.
         *
         * Measured from the line start, a list inside a blockquote counted the `> ` as well — and
         * that prefix is hidden, so the negative indent pulled the item two characters further left
         * than the rendering begins and every bullet in the quote went off the edge of the pane.
         *
         * A nested item's leading spaces DO count: they are still drawn, and its wrapped lines
         * should hang under its own text rather than under the outer list's. So only the quote
         * markers come off, which are exactly the characters this fold hides.
         */
        const before = line.text.slice(0, mark.to - line.from);
        const indent = before.replace(/^(?:[ \t]*>[ \t]?)+/u, "").length + 1;
        /**
         * An item's OWN lines stop where its nested list starts.
         *
         * A `ListItem` spans everything under it, the sub-list included, so banding the whole
         * node put the outer item's indent on the inner item's lines too — two decorations on
         * one line, each with its own inline `style`, and no rule saying which wins. Each item
         * hangs by its own marker, so each must own only the lines that marker is in front of.
         */
        let last = node.to;
        for (let kid = node.node.firstChild; kid !== null; kid = kid.nextSibling) {
          if (kid.name === "BulletList" || kid.name === "OrderedList") {
            // The end of the line BEFORE the nested list's line. `kid.from - 1` is not that: a
            // nested list starts after its own indentation, so one character back is still its own
            // line, and the outer item went on claiming it.
            const above = state.doc.lineAt(kid.from).number - 1;
            last = above >= 1 ? Math.max(node.from, state.doc.line(above).to) : node.from;
            break;
          }
        }
        band(node.from, last, () =>
          Decoration.line({
            class: "cm-item-line",
            // ADDS to whatever inset the line already has rather than replacing it: a quote publishes
            // its own as `--md-inset`, and an item inside one has to sit past the rule instead of
            // on top of it. `!important` because the quote's padding carries one too, to beat the
            // editor theme — and an inline `!important` is the only thing that outranks that.
            attributes: {
              style: `padding-left:calc(var(--md-inset, 0px) + ${indent}ch) !important;text-indent:-${indent}ch`,
            },
          }),
        );
        return;
      }
      /**
       * A fenced block, handed to the pipeline — unless you are inside it.
       *
       * The whole node goes, delimiters included, which is what removes the blank line that used to
       * sit above and below every block: those lines were the ``` themselves, drawn with their text
       * hidden and their height kept. A widget replacing whole lines has no such remainder.
       *
       * Every fence gets one, not only the ones with a language. A block with no info string is a
       * `text/plain` document, and the pipeline has an answer for that like it has for any other
       * type; sending it down the same route is the point, and it is what makes the untyped fence
       * stop being the one case with special behaviour.
       *
       * Revealed — the outer caret arrowed into its range — it falls through to the banding below and
       * is raw source again. That is the only way to reach the ``` line, so it is how the language of
       * a block is changed and how the block is deleted. Clicking inside does NOT do it: the widget
       * swallows its own events, so a click lands in Monaco, which is where you wanted it.
       */
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        const body = fenceBody(state, node.node);
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        let inside = false;
        for (let line = first.number; line <= last.number; line++) inside ||= reveal.has(line);
        if (!inside) {
          found.push(
            Decoration.replace({
              widget: new CodeFence(
                state.doc.sliceString(body.from, body.to),
                body.lang,
                state.facet(EditorView.editable),
                state.facet(fenceHost),
              ),
              block: true,
            }).range(first.from, last.to),
          );
          return false;
        }
        // Inside a fence, the WHOLE fence is source — the delimiter lines included, which the reveal
        // set would otherwise leave hidden because the caret is only on one of them. That is what
        // makes the language of a block editable once you have arrowed into it.
        for (let line = first.number; line <= last.number; line++) reveal.add(line);
        /**
         * The source, banded — what a fence looks like while you are editing the fence itself.
         *
         * `@lezer/markdown` styles `"InlineCode CodeText"` with the same `tags.monospace`, so without
         * a band an untyped block was drawn with the INLINE code rule: a rounded, padded background
         * around each run on each line, ragged down the block. The band is what makes it read as one
         * panel, and the CSS neutralises the inline pill inside it.
         */
        band(node.from, node.to, (index, last2) =>
          index === 0 ? codeOpen(body.lang) : last2 ? LINE.codeClose : LINE.code,
        );
        return;
      }
      /**
       * A table, DRAWN — replaced by a real one, unless you are inside it.
       *
       * Whole lines, because a block replacement has to start where a line starts and end where one
       * ends; `false` because nothing inside a replaced range needs visiting.
       *
       * Revealed, it falls through to the banding below, which is a table's source shown as source:
       * bold header, dimmed rule, dimmed pipes. That is the pair — read it as a table, edit it as
       * the text it is — and it is the same rule a heading follows one line at a time.
       */
      if (node.name === "Table") {
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        let inside = false;
        for (let line = first.number; line <= last.number; line++) inside ||= reveal.has(line);
        if (!inside) {
          found.push(
            Decoration.replace({
              widget: new TableBlock(state.doc.sliceString(first.from, last.to)),
              block: true,
            }).range(first.from, last.to),
          );
          return false;
        }
        band(node.from, node.to, (index) => (index === 0 ? LINE.tableHead : index === 1 ? LINE.tableRule : LINE.table));
        return;
      }
      if (node.name === "TableDelimiter") {
        // The single `|` between cells, not the `---|---` line: that one is a whole row of its own
        // and is already dimmed by its band.
        if (node.to - node.from === 1) found.push(TABLE_DELIM.range(node.from, node.to));
        return;
      }
      /**
       * The language after the backticks, which the band now shows as a label.
       *
       * Hidden here because the ``` around it is hidden: leaving it drew the bare word `typescript`
       * floating above the block as if it were a line of prose. It comes back with everything else
       * when the caret is on the line, and until then `data-lang` on the opening line says it.
       */
      if (node.name === "CodeInfo") {
        if (!reveal.has(state.doc.lineAt(node.from).number) && node.to > node.from) {
          found.push(HIDDEN.range(node.from, node.to));
        }
        return;
      }
      /**
       * A paragraph's own line breaks, which are not breaks.
       *
       * The node spans every line of the paragraph — lazy continuation and all — so the breaks to
       * close are simply the ends of all but its last line. See {@link JOIN}.
       */
      if (node.name === "Paragraph") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n < last; n++) {
          if (reveal.has(n) || reveal.has(n + 1)) continue;
          const line = state.doc.line(n);
          const next = state.doc.line(n + 1);
          // Two trailing spaces are a HARD break: markdown's one way of asking for a line break
          // inside a paragraph, and the one case where the break must stay.
          if (line.text.endsWith("  ")) continue;
          /**
           * The continuation PREFIX, not just the indent.
           *
           * Inside a blockquote each wrapped line begins `> `, and swallowing only the whitespace
           * left two things behind: the space after the marker, and a `QuoteMark` that the fold
           * would separately hide — so the joined sentence came out with a double space in it where
           * every wrap had been. Taking the marker as part of the break is what makes one space.
           *
           * Consuming it here also settles who hides it. Two replacements may not overlap, and the
           * mark is now inside this range, so {@link joined} below is what keeps the `QuoteMark`
           * branch from claiming it a second time.
           */
          const prefix = /^[ \t]*(?:>[ \t]*)*/u.exec(next.text)?.[0].length ?? 0;
          if (next.text.slice(prefix).trim() === "") continue;
          found.push(JOIN.range(line.to, next.from + prefix));
          joined.push([line.to, next.from + prefix]);
        }
        return;
      }
      /**
       * A link's TARGET, which is not its text.
       *
       * `@lezer/markdown` marks the brackets and parentheses of `[SPEC.md](SPEC.md)` as `LinkMark`
       * and nothing else — the label and the URL are both just content. So hiding the marks alone
       * left the two of them adjacent, and every link in the document rendered its own name twice.
       * The target is the half that has to go.
       *
       * Guarded on the parent, because a bare `<https://…>` is an `Autolink` whose URL IS its text;
       * hiding that would erase the link rather than tidy it.
       */
      /**
       * A link keeps its LABEL and loses everything else, in two ranges rather than five.
       *
       * `@lezer/markdown` marks only the brackets and parentheses, so the label and the target are
       * both plain content and hiding the marks alone drew `[SPEC.md](SPEC.md)` as its own name
       * twice. Hiding the pieces one at a time — `URL`, then `LinkTitle`, then `LinkLabel` — fixed
       * that and left the gaps BETWEEN them: `[text](target.md "title")` came out as `text  here`,
       * with the space that had separated the path from the title still in the document.
       *
       * So the span is what is hidden, not the parts. Everything up to the label's opening bracket,
       * and everything from its closing one to the end of the node — which is `](…)` for an inline
       * link, `][ref]` for a reference, and `](…)` again for an image. Whatever the grammar puts in
       * between goes with it, including the spaces.
       *
       * `Autolink` is a different node and never reaches here, which is what keeps `<https://…>` —
       * whose URL IS its text — from being erased.
       */
      if (node.name === "Link" || node.name === "Image") {
        if (node.name === "Image" && !reveal.has(state.doc.lineAt(node.from).number)) {
          found.push(IMAGE.range(node.from, node.to));
        }
        if (reveal.has(state.doc.lineAt(node.from).number)) return false;
        const marks: SyntaxNode[] = [];
        for (let kid = node.node.firstChild; kid !== null; kid = kid.nextSibling) {
          if (kid.name === "LinkMark") marks.push(kid);
        }
        const open = marks[0];
        const close = marks[1];
        // A link the grammar could not finish — `[text` with no bracket. Left as written.
        if (open === undefined || close === undefined) return false;
        if (open.to > node.from) found.push(HIDDEN.range(node.from, open.to));
        if (node.to > close.from) found.push(HIDDEN.range(close.from, node.to));
        return false;
      }
      /**
       * `[ ]` and `[x]`, drawn as the boxes they mean — see {@link Task}.
       *
       * ABOVE the `…Mark` guard, and that is the whole of why the first attempt did nothing:
       * `TaskMarker` ends in `Marker`, not `Mark`, so the guard sent it away one line before the
       * branch that wanted it. Every other marker in this grammar is spelled `…Mark`; this is the
       * one that is not.
       */
      if (node.name === "TaskMarker") {
        if (reveal.has(state.doc.lineAt(node.from).number)) return;
        const done = state.doc.sliceString(node.from, node.to).toLowerCase().includes("x");
        found.push(Decoration.replace({ widget: new Task(done) }).range(node.from, node.to));
        return false;
      }
      // Every syntax mark in `@lezer/markdown` is named `…Mark` — `EmphasisMark`, `HeaderMark`,
      // `LinkMark`, `CodeMark`, `QuoteMark`, `ListMark`. Asking the grammar rather than matching
      // characters is what keeps `2 * 3 * 4` from losing its asterisks.
      if (!node.name.endsWith("Mark")) return;
      /**
       * A bullet is DRAWN rather than hidden — see {@link Bullet}.
       *
       * `BulletList` and `OrderedList` are told apart by the parent, not by the character: a list
       * item's mark can be `-`, `*` or `+`, and matching on those would also catch a `*` that the
       * grammar had already decided was emphasis.
       */
      if (node.name === "ListMark") {
        if (reveal.has(state.doc.lineAt(node.from).number)) return;
        if (node.node.parent?.parent?.name !== "BulletList") return;
        found.push(BULLET.range(node.from, node.to));
        return;
      }
      if (node.from === node.to) return;
      if (reveal.has(state.doc.lineAt(node.from).number)) return;
      // Already inside a join — see {@link joined}. Hiding it again would be an overlap, which
      // CodeMirror throws on rather than resolves.
      if (isJoined(node.from, node.to)) return;
      /**
       * A block marker takes the space after it with it.
       *
       * `QuoteMark` is the `>` alone and `HeaderMark` is the `###` alone; the space that follows is
       * content as far as the grammar is concerned. Hiding the marker by itself therefore indented
       * every quoted line and every heading by one character — a nested `> > ` by two — which reads
       * as a stray margin nobody asked for. Markdown itself treats that one space as part of the
       * marker, so removing it is a truer reading rather than a cosmetic trim.
       *
       * Exactly one, never a run: `>     indented` inside a quote is indented on purpose. And only
       * where a space actually follows, which is what leaves a Setext underline and a closing `###`
       * at the end of a line alone.
       */
      const marker = node.name === "QuoteMark" || node.name === "HeaderMark";
      const pad = marker && state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
      found.push(HIDDEN.range(node.from, node.to + pad));
    },
  });
  return Decoration.set(found, true);
}

/**
 * Focus, moved INTO the state so a field can see it.
 *
 * This used to be a view plugin, and the reason was sound: an editor nobody is typing in still has a
 * selection — a cursor at offset 0 — so a field that knew only about the document revealed the first
 * line's markup permanently, and every document opened with a bare `#` in front of its title. Focus
 * is a property of the view, not of the document.
 *
 * What changed is that a plugin may not produce BLOCK decorations. CodeMirror computes the height of
 * every line before it asks a plugin anything, so a decoration that replaces line breaks or inserts
 * a block widget has to be knowable from the state alone — otherwise the measurement it invalidates
 * has already been used. That is a hard rule, not a preference, and drawing a table needs exactly
 * that kind of decoration.
 *
 * So focus becomes state. `focusChangeEffect` is CodeMirror's own seam for this: the view reports
 * the change as a transaction effect, the field stores it, and the decorations are a pure function
 * of the state again — with the focus rule above preserved exactly as it was.
 */
const setFocus = StateEffect.define<boolean>();

const focusState = StateField.define<boolean>({
  create: () => false,
  update: (current, tr) => {
    for (const effect of tr.effects) if (effect.is(setFocus)) return effect.value;
    return current;
  },
});

/**
 * The decorations, as a field.
 *
 * Recomputed on any transaction that could move the answer: the document, the selection, the focus,
 * or the parse reaching further into the file. That last one is not an optimisation — see the note
 * in `update`, where leaving it out is what made every document longer than a few thousand
 * characters stop being live-previewed halfway down.
 *
 * A field is computed for the whole document, which is the price of being allowed to change the
 * layout, and the reason block widgets have to be cheap to build. {@link TableBlock.eq} and
 * {@link CodeFence.eq} are what keep that price down.
 */
const livePreview = StateField.define<DecorationSet>({
  create: (state) => marks(state, state.field(focusState)),
  update: (current, tr) => {
    /**
     * The PARSE moving is a reason to recompute, and forgetting it broke every long document.
     *
     * `syntaxTree(state)` is not the tree of the document; it is the tree PARSED SO FAR. CodeMirror
     * parses a few thousand characters up front and extends lazily as the viewport moves, so a fold
     * that walks it sees a document that stops. On a 17,000-character file it stopped at 3,024: the
     * first screen live-previewed correctly and everything below it was raw markdown — every `**`,
     * every backtick, every fence shown as source — because the tree that would have told the fold
     * they were there had not been built yet.
     *
     * The view plugin this replaced never had the bug, and not by design: it listed `viewportChanged`
     * among its reasons to recompute, and scrolling is what makes the parser advance. Moving to a
     * field to get block decorations dropped that, and dropped the only thing standing in for "the
     * tree grew".
     *
     * Comparing tree IDENTITY is the direct statement of it. The parser publishes each extension
     * through a transaction, so this fires exactly when there is more tree to walk — no polling, and
     * nothing recomputed for a transaction that only moved the viewport over already-parsed text.
     */
    const grew = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!grew && !tr.docChanged && !tr.selection && !tr.effects.some((effect) => effect.is(setFocus))) {
      return current.map(tr.changes);
    }
    return marks(tr.state, tr.state.field(focusState));
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Report focus into the state, so {@link focusState} has something to store. */
const reportFocus = EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing));

/** Everything the live preview needs, in the order the fields depend on each other. */
const LIVE_PREVIEW: Extension = [focusState, livePreview, reportFocus];

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
  // The spacing is a preference now (`editors.markdown.lineHeight`), published as a custom property
  // by `applyEditors`. The literal stays as the fallback rather than being deleted: it is what this
  // editor is set in before any settings file has been read, and it is the value the preference
  // defaults to — so the two can never disagree about what "untouched" looks like.
  ".cm-content": { fontFamily: "inherit", padding: "8px 2px", lineHeight: "var(--ed-markdown-lh, 1.6)" },
  ".cm-line": { padding: "0 2px" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "var(--ed-markdown-lh, 1.6)" },
});

/**
 * The look, as extensions — swapped in a compartment rather than rebuilt with the editor.
 *
 * Three of the five knobs this surface answers are extensions (`lineNumbers`, `lineWrapping`,
 * `highlightActiveLine`) and one is a facet (`tabSize`); the fifth, spacing, is CSS and reaches the
 * theme above on its own. Wrapping used to be unconditional here, which was a defensible default
 * for prose and an odd thing to have decided on somebody else's behalf.
 */
function lookExtensions(): Extension[] {
  const look = editorLook("markdown");
  return [
    EditorState.tabSize.of(look.tabSize),
    ...(look.lineNumbers ? [lineNumbers()] : []),
    ...(look.wrap ? [EditorView.lineWrapping] : []),
    ...(look.currentLine ? [highlightActiveLine()] : []),
  ];
}

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
  /** The same trick for the appearance preferences — see {@link lookExtensions}. */
  const look = useRef(new Compartment());

  useEffect(() => {
    const node = host.current;
    if (node === null) return undefined;
    /**
     * The box the widgets reach the editor through.
     *
     * A fence widget is built by {@link marks}, which is a pure function of the state and so has no
     * view to dispatch against; this is filled in the moment the view exists, one line below. A
     * mutable box rather than the view itself because the facet's value has to be settled before the
     * state is created, and the view cannot exist before its state does.
     */
    const fences: FenceHost = { view: null };
    const extensions: Extension[] = [
      fenceHost.of(fences),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
      syntaxHighlighting(LOOK),
      LIVE_PREVIEW,
      look.current.of(lookExtensions()),
      THEME,
      editable.current.of(EditorView.editable.of(writable)),
      diffs.current.of(spans === null ? [] : diffDecorations(spans, text.length)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) report.current?.(update.state.doc.toString());
      }),
    ];
    const editor = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: node });
    fences.view = editor;
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

  /**
   * Follow the appearance preferences while the editor is open.
   *
   * A subscription rather than a prop, for the reason `editorLook.ts` exists: this editor is created
   * once and never re-created, so a value read in that effect is a value frozen at mount. The
   * compartment is what lets the answer change without the document, the caret or the undo history
   * going with it.
   */
  useEffect(() => onEditorLook(() => {
    view.current?.dispatch({ effects: look.current.reconfigure(lookExtensions()) });
  }), []);

  return <div className={writable ? "md-editor" : "md-editor read-only"} ref={host} />;
}
