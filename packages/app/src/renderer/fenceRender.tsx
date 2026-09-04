/**
 * How a fenced code block is drawn, and the markdown surfaces that draw one.
 *
 * Its own module because of a cycle. `markdown.tsx` builds the document and offers a seam;
 * `valueView.tsx` draws whatever the seam returns and therefore imports markdown; a renderer that
 * lived in either would close the loop. So it lives here, above both — and INSTALLS itself at the
 * bottom of this file rather than waiting to be passed down.
 *
 * That last part is the fix, not a flourish. The renderer used to live in `transcriptView` and reach
 * every surface as an optional prop, so a ```yaml block was a full reading in a model's answer and a
 * grey box in the `.md` file three feet away — the same fence, two answers, decided by which pane it
 * happened to be in. Three of the four callers simply did not pass the prop, and nothing said so,
 * because "no renderer" and "renderer declined" draw the same `<pre>`. A workflow description is
 * prose wrapped around fenced YAML, so that grey box was most of the document.
 */
import type { JSX } from "react";
import { mimeOfFenceLang } from "@jaira/shared/browser";
import { registerFenceRenderer, type FenceRenderer } from "./markdown";
import { MarkdownDocument } from "./documents";
import type { FileSurfaceProps } from "./fileTypes";
import { ValueView } from "./valueView";

/**
 * A fenced block, drawn rather than quoted — the answer's half of the artifact story.
 *
 * A model that wants to hand over a page has two routes: `show_artifact`, which produces a real
 * artifact with a real viewer, and pasting the page into its answer. The second used to arrive as a
 * grey box of source with no way to look at it, which is what a transcript full of `<!DOCTYPE html>`
 * looks like — 29,000 characters nobody can see. This closes that: the SAME {@link ValueView} the
 * artifacts pane and the payload blocks use, so one page looks identical wherever it turns up, and
 * the Rendered / Code / Text toggle comes with it rather than being built a second time here.
 *
 * ## It holds no map of its own
 *
 * It used to, and the map was the bug. A table here from ` ```html ` to a viewer is a third opinion
 * about what a type is worth showing as — beside `mimeOfPath`, which answers it for files, and
 * `viewsFor`, which answers it for values — and a third opinion is a thing that can disagree. It
 * did: `markdown` was missing, so a model quoting a document had the whole subject of the message
 * rendered as a grey wall of `#` and `---`, one level below an answer that was being rendered.
 *
 * So the only new thing is the one piece neither existing map had — {@link mimeOfFenceLang}, a
 * NAME to a type — and everything after it is the machinery that was already there. A language
 * nothing recognises returns `undefined` and the fold shows the source, which is the same answer
 * this gave before for everything that was not a page.
 *
 * Static, and that is the difference from an artifact rather than an oversight. `Html` is a `srcdoc`
 * frame with an empty `sandbox`, so scripts do not run — the interactive path needs a served
 * `jaira-artifact:` URL, and a fence has no artifact behind it to serve. A model that wants its
 * mockup to MOVE has a tool for that, and this is the fallback, not a second way in.
 *
 * Module-level so the reference is stable: `Markdown` memoises on it.
 */
export const drawFence: FenceRenderer = ({ lang, code, edit }) => {
  const mime = mimeOfFenceLang(lang);
  if (mime === undefined) return undefined;
  // RECURSION needs nothing handed down any more. A document quoted inside a document is still a
  // document, and the fence renderer it reaches for is the registered one — which is this. Nor does
  // anything have to ask `ValueView` for the reading renderers rather than the editors: it gives a
  // reading to anything it cannot be typed into, which a quoted block never can.
  //
  // It terminates on the nesting of the text: each level renders the CONTENTS of a fence, which is
  // strictly shorter than the document holding it.
  //
  // `edit` is passed straight through, which is the whole of the editing story here: `ValueView`
  // already answers "may this be changed" by whether it was given somewhere to put the change, and
  // already routes a writable block to the editor its type deserves. A fence in a transcript hands
  // over nothing and stays a reading; the live-preview editor hands over a callback and the same
  // block becomes a Monaco editor for its language.
  //
  // `inline` is what stops an editable block drawing one line of code in a screenful of grey: a
  // fence is a document inside a document, so it takes its height from its text rather than from a
  // container it does not have. See `ValueView`'s prop, and `MonacoCodePane`'s `autoHeight`.
  return <ValueView value={code} hint={{ mime }} inline {...(edit === undefined ? {} : { edit })} />;
};

/**
 * A markdown document, rendered, with its fenced blocks drawn as what they are.
 *
 * Replaces the bare `MarkdownView` that `markdown.tsx` used to export. Nothing else about it
 * changed: it is the same parser and the same fold, handed the seam it always had a slot for.
 */
export function MarkdownView(props: FileSurfaceProps): JSX.Element {
  if (props.doc.text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  // Read-only, said by omission: no `onChange`. Which renderer that reaches is not this file's
  // business — see `markdownDocument.tsx`.
  return <MarkdownDocument text={props.doc.text} />;
}

/**
 * Installed at import time — see `markdown.tsx`'s {@link registerFenceRenderer}.
 *
 * This line is why no surface has to remember the prop: importing this module is what gives every
 * `<Markdown>` in the app its fenced blocks, in the same way importing `fileSurfaces.tsx` is what
 * populates the surface registry. `App.tsx` reaches both through the Files view.
 */
registerFenceRenderer(drawFence);
