/**
 * A document on screen — the ONE place that decides which component draws one.
 *
 * Callers say what they have and what may be done with it: here is the text, here is where a change
 * comes back if one is allowed, here is a change to draw over it. Which renderer answers that is
 * this module's business and nobody else's.
 *
 * ## Editability is a property of the TYPE, not of the request
 *
 * Each document type gets its own component here because each has its own pair, and the pairs are
 * not alike. Markdown reads through markdown-it and edits through CodeMirror. Code reads through
 * Monaco's tokenizer — no editor instance, so a transcript can hold forty of them — and edits
 * through a Monaco editor. What is shared is only the question the caller answers: may this be
 * changed, and where does the change go.
 *
 * That is the distinction a single shared flag got wrong twice. First `ValueView` had one rule for
 * both types, so an editable YAML document landed on a pane that dropped every keystroke. Then the
 * code view had no editing renderer at all, so a `.ts` file was edited in a bare `<textarea>` with
 * no highlighting, in an app that colours TypeScript in three other places. A type's answer to
 * "can this be edited" belongs to the type, and the shape of its props is where it says it.
 *
 * ## Why a facade rather than one renderer
 *
 * There are two implementations underneath and they are not one thing with a flag. Reading goes
 * through `markdown.tsx` — markdown-it, folded into React nodes, with fenced blocks drawn as the
 * value viewer, so a ```yaml block inside a document is the same reading it is anywhere else, toggle
 * and parse included. Editing goes through `markdownEditor.tsx` — CodeMirror with live-preview
 * decorations, where a fence is coloured by a nested grammar. An editor cannot host the first: its
 * document is text with decorations over it, not a place to mount a component. A reader cannot
 * provide the second: it produces no editable buffer.
 *
 * So the split is real and follows from what each can do. What was wrong was that it leaked: four
 * call sites each reached for a renderer directly, and the one that reached for the wrong one — a
 * gate's approval document, read-only, sent to the editor — showed coloured YAML with no reading
 * behind it while the same block in a model's answer three inches away had the full toggle. Nobody
 * chose that; it fell out of a condition several files away.
 *
 * ## What the split costs, stated once
 *
 * The two do not look identical, and cannot: front matter is a fold holding a value viewer in one
 * and raw `---` lines in the other. That is the price of the capability difference, and this comment
 * is where it is recorded rather than being rediscovered at each call site. Closing it would mean
 * hosting the value viewer inside a CodeMirror widget — possible, and a project rather than a tidy.
 */
import { lazy, Suspense, type JSX } from "react";
import { Markdown } from "./markdown";

/**
 * Loaded on first sight of an EDITABLE document, never with the view.
 *
 * CodeMirror plus the markdown grammar and its nested languages is half a megabyte, and a transcript
 * that shows forty read-only documents should not pay for an editor it will never draw. The fallback
 * is the reading renderer, so the words — and their fenced blocks — are on screen while it arrives.
 */
const MarkdownEditor = lazy(() => import("./markdownEditor").then((m) => ({ default: m.MarkdownEditor })));
type MarkdownDiff = import("./markdownEditor").MarkdownDiff;

export interface MarkdownDocumentProps {
  text: string;
  /**
   * How a change comes back. ABSENT means read-only — the one thing a caller has to decide.
   *
   * Absence rather than a boolean because the two facts are the same fact: a document you may change
   * needs somewhere to put the change, and one you may not has nowhere to put it. A `readOnly` flag
   * beside an `onChange` lets a caller state them contradictorily.
   */
  onChange?: ((text: string) => void) | undefined;
  /**
   * A change to draw over the document, when there is one.
   *
   * It forces the editing renderer even with no `onChange`, because drawing a change in place is the
   * one thing the live preview does that the reading renderer cannot — a caller that wants to show
   * an edit without permitting one gets exactly that.
   */
  diff?: MarkdownDiff | undefined;
}

/**
 * Draw it.
 *
 * The whole decision is the first line, and it is deliberately the only one in the app: everything
 * above is why, and everything below is delegation.
 */
export function MarkdownDocument({ text, onChange, diff }: MarkdownDocumentProps): JSX.Element {
  if (onChange === undefined && diff === undefined) return <Markdown text={text} />;
  return (
    <Suspense fallback={<Markdown text={text} />}>
      <MarkdownEditor
        text={text}
        {...(onChange === undefined ? { readOnly: true } : { onChange })}
        {...(diff === undefined ? {} : { diff })}
      />
    </Suspense>
  );
}

/**
 * Loaded on first sight of code, never with the view — Monaco is megabytes and touches `window` at
 * module scope, so a static import would drag a browser global into every node-side test.
 */
const CodeText = lazy(() => import("./monacoDiff").then((m) => ({ default: m.CodeText })));
const MonacoCodePane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoCodePane })));

export interface CodeDocumentProps {
  text: string;
  /** What grammar to colour it with — resolved through `shared/grammars.ts`, like everything else. */
  mime: string;
  /** How a change comes back. ABSENT means read-only, exactly as in {@link MarkdownDocumentProps}. */
  onChange?: ((text: string) => void) | undefined;
}

/**
 * Source, coloured — read with the tokenizer, edited with the editor.
 *
 * The split is weight, and it matters at the scale a transcript works at. `CodeText` is Monaco's
 * `colorize` with no editor under it: it colours anything Monaco has a grammar for, costs no editor
 * instance, and lets a selection be dragged across it and the page around it — which forty fenced
 * blocks in a conversation need and forty mounted editors would break. An editor buys scrolling,
 * folding, a caret, and the ability to type; nothing that is only being read wants any of it.
 */
export function CodeDocument({ text, mime, onChange }: CodeDocumentProps): JSX.Element {
  if (onChange === undefined) {
    return (
      <Suspense fallback={<pre className="vv-source">{text}</pre>}>
        <CodeText text={text} mime={mime} />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<pre className="vv-source">{text}</pre>}>
      <MonacoCodePane text={text} mime={mime} onChange={onChange} />
    </Suspense>
  );
}
