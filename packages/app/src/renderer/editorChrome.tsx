/**
 * The bar every editing surface ends with.
 *
 * Four editors — plain text, JSON, `config.json`, the state form — ask the same two questions of
 * whoever is looking at them: what am I about to write, and how do I take it back? Each used to
 * answer them its own way. The state form had a lone Save at the bottom of a document-length page,
 * so the button scrolled out of sight exactly when the form was long enough to need it, and there
 * was no Revert beside it at all; the JSON editor kept both under the text where they never moved.
 * This is that second answer, made shared — which is most of what "these two should look like the
 * same app" turns out to mean.
 *
 * ## Sticky, not merely last
 *
 * `position: sticky` in the stylesheet rather than a layout every host has to get right. A surface
 * that already fits its pane is unaffected — the stuck position and the natural one are the same —
 * and one inside something that scrolls (the settings body, a form taller than the panel) keeps its
 * actions against the bottom edge instead of below the fold. The alternative was asking every host
 * to become a three-row flex column with a scrolling middle, and the one that forgot would be the
 * one with the longest form.
 *
 * ## Why `dirty` is allowed to be undefined
 *
 * Not every host tracks it: the workflow editor's JSON tab hands its text to the form rather than
 * to a file, and has nothing to compare against. `undefined` means "unknown", and an unknown draft
 * is savable — refusing to save because nobody counted the keystrokes would be worse than offering
 * a save that writes what is already there.
 */
import type { JSX, ReactNode } from "react";

export function EditorActions({
  dirty,
  busy,
  blocked,
  onSave,
  onRevert,
  children,
}: {
  /** Whether there is anything to save. `undefined` ⇒ the host does not track it — see above. */
  dirty?: boolean | undefined;
  busy?: boolean;
  /**
   * Why saving is refused right now, in the words the author needs — "fix the JSON before saving".
   *
   * Shown beside the button rather than raised when it is pressed. A reason that appears on click
   * describes a rule you have already broken; the same sentence sitting next to a disabled button
   * describes one you can still act on.
   */
  blocked?: string | undefined;
  onSave: () => void;
  /** Absent ⇒ no Revert. A surface with nothing to revert TO should not offer one. */
  onRevert?: (() => void) | undefined;
  /** Anything else that belongs on this row — "new file — saving creates it". */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="pane-actions pinned">
      <button className="primary" onClick={onSave} disabled={busy === true || dirty === false || blocked !== undefined}>
        Save
      </button>
      {onRevert ? (
        <button className="ghost" onClick={onRevert} disabled={dirty === false}>
          Revert
        </button>
      ) : null}
      {blocked !== undefined ? <span className="reason">{blocked}</span> : null}
      {dirty === true && blocked === undefined ? <span className="sub">unsaved changes</span> : null}
      {children}
    </div>
  );
}
