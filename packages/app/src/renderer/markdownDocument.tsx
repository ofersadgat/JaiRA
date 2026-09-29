/**
 * The markdown half of `documents.tsx` — moved out unchanged (see that module's note on why one place
 * decides which component draws a document), so a page that draws only markdown documents (the markdown
 * editor's island, decision 0015) does not carry the code editor behind `CodeDocument`.
 */
import { lazy, Suspense, type JSX } from "react";
import type { RenderView } from "@jaira/shared/browser";
import { editorPaint } from "./editorThemes";
import { viewTheme } from "./fileTypes";
import { Markdown } from "./markdown";
import { useRenderChoice } from "./renderChoice";

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
  /**
   * The EDITOR, and not editable — a reading drawn by a renderer that can write.
   *
   * Distinct from the absence of `onChange`, which asks for the reading RENDERER. A type's two views
   * are two picks, and the live preview is a legitimate answer to both: mounted as the reading it
   * must still be the live preview, with the decorations and the fences, and it must not take a
   * keystroke. Without this, asking for that got the markdown-it rendering instead — a different
   * renderer than the one that was chosen, which is a preference answered with something else.
   */
  readOnly?: boolean | undefined;
  /**
   * Which type this document IS, for the palette — see {@link viewTheme}.
   *
   * Absent means markdown itself, which is what almost every caller has. The one that must say is
   * the file panel: a workflow description is its own type and carries its own palette, and asking
   * under `text/markdown` would read a key its owner never wrote to.
   */
  mime?: string | undefined;
}

/**
 * Draw it.
 *
 * The whole decision is the first line, and it is deliberately the only one in the app: everything
 * above is why, and everything below is delegation.
 */
export function MarkdownDocument({ text, onChange, diff, readOnly, mime }: MarkdownDocumentProps): JSX.Element {
  /**
   * The palette this type asks for, handed to the editor to carry on its own element.
   *
   * Here rather than at each host, because the editor is CodeMirror: it takes its colours from CSS,
   * the root can hold ONE palette (`applyAppearance`), and a theme is per type and per view. Every
   * host that draws a markdown document goes through this function — a file panel, a value in a
   * transcript, a gate's approval document — so this is the one place that can give all of them the
   * palette without each of them learning what a palette is.
   *
   * Handed DOWN rather than wrapped around: the panel gives `.md-editor` its band with a child
   * combinator, so an element in between costs the editor its height and CodeMirror its scroller.
   * See `MarkdownEditor`'s `paint`.
   *
   * The reading needs none: it is markdown-it in the app's own tokens, which is what the `rendered`
   * renderer is and why it declares no theme.
   */
  const chosen = useRenderChoice();
  if (onChange === undefined && diff === undefined && readOnly !== true) return <Markdown text={text} />;
  const view: RenderView = onChange === undefined ? "read" : "write";
  const paint = editorPaint(viewTheme(mime ?? "text/markdown", "text", view, chosen));
  return (
    <Suspense fallback={<Markdown text={text} />}>
      <MarkdownEditor
        text={text}
        {...(onChange === undefined || readOnly === true ? { readOnly: true } : { onChange })}
        {...(diff === undefined ? {} : { diff })}
        {...(paint === null ? {} : { paint })}
      />
    </Suspense>
  );
}

