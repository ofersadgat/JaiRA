/**
 * What a linked property actually says, shown under the link.
 *
 * A reference is a one-line path where a value used to be — `"prompt": {"$ref": "$/prompts/draft.md"}`
 * — and that is the whole point of it (§2.2: the document is spliced in where it is referenced). The
 * cost is that the form then shows you a PATH where the substance was: six lines of prompt become a
 * filename, and reading what a state actually does means opening another file and losing the one you
 * were editing.
 *
 * So the target is rendered underneath, read-only, in whatever the app uses to show that kind of
 * file. Open by default, because the reason to look at a linked field is almost always to read what
 * is behind it; collapsible, because once you know, it is a filename again.
 *
 * ## Why a context rather than props
 *
 * A link control appears in four places nested three deep — an operation's fields, the environment's
 * copy of the same fields, a slot's `schema`, the operation block itself — and none of the
 * components between them has any interest in file reading. Threading a reader and a resolver
 * through all of them would put the shell's plumbing into every one, and each new link site would
 * have to remember to pass it along. The same argument `valuePanel.ts` makes, for the same shape of
 * problem: a component that is not inside a provider simply shows nothing, which is exactly right
 * for a form rendered in a test or outside the shell.
 */
import { createContext, useContext, useEffect, useState, type JSX } from "react";
import { mimeOfPath, type WorkflowLayer } from "@jaira/shared/browser";
import type { UiSurface } from "./fileTypes";
import { ValueView } from "./valueView";

export interface LinkReader {
  /** The file a reference names, or `null` when this window cannot see one. */
  resolve: (ref: string) => { layer: WorkflowLayer; path: string } | null;
  /** That file's text. `null` for anything unreadable — a preview is never worth an error. */
  read: (layer: WorkflowLayer, path: string) => Promise<string | null>;
  /** Where the disclosure's state is remembered, so a fold survives clicking another file. */
  ui?: UiSurface | undefined;
}

const LinkReaderContext = createContext<LinkReader | null>(null);

export const LinkReaderProvider = LinkReaderContext.Provider;

/**
 * The target of one link, read-only, under the control that names it.
 *
 * Nothing here is editable and nothing offers to be: the file has its own place in the tree, and an
 * editor in a preview would be a second writer for a document this form does not own. `ValueView` is
 * what the rest of the app shows a value with — a markdown prompt renders as markdown, a JSON
 * fragment as a tree, an HTML mockup as a page — so a linked prompt looks here exactly as it looks
 * anywhere else it is shown.
 */
export function LinkPreview({ reference }: { reference: string }): JSX.Element | null {
  const reader = useContext(LinkReaderContext);
  const at = reader === null ? null : reader.resolve(reference);
  const [text, setText] = useState<string | null | "reading">("reading");

  useEffect(() => {
    if (reader === null || at === null) return;
    let live = true;
    setText("reading");
    void reader.read(at.layer, at.path).then((found) => {
      if (live) setText(found);
    });
    return () => {
      live = false;
    };
    // `at` is a fresh object every render; the two strings in it are what identify the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, at?.layer, at?.path]);

  if (reader === null) return null;
  // A reference this window cannot place says nothing here. The linter is what reports it — a
  // preview that announced "not found" would be a second, worse diagnostic in a smaller typeface.
  if (at === null) return null;

  const open = reader.ui?.open(`link:${at.layer}:${at.path}`, true) ?? true;
  return (
    <div className="link-preview">
      <button
        type="button"
        className="link-preview-bar"
        onClick={() => reader.ui?.setOpen(`link:${at.layer}:${at.path}`, !open)}
        disabled={reader.ui === undefined}
        title={at.path}
      >
        <span className="half-caret">{open ? "▾" : "▸"}</span>
        <span className="sub">what {reference} says</span>
      </button>
      {open ? (
        <div className="link-preview-body">
          {text === "reading" ? (
            <p className="empty">Reading…</p>
          ) : text === null ? (
            <p className="empty">Nothing readable at {at.path}.</p>
          ) : (
            <ValueView value={text} hint={{ mime: mimeOfPath(at.path) }} />
          )}
        </div>
      ) : null}
    </div>
  );
}
