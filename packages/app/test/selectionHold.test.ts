/**
 * When a surface lets go of a passage — see `maySurrenderSelection` and `selectionForMenu`.
 *
 * Two functions, one gesture, and they are tested together because the bug was the seam between
 * them: the menu asked the pane what it was holding, and the pane had already let go.
 *
 * The sequence, on Windows, for a right-click inside an artifact with a comment composer open:
 *
 *   1. the composer's textarea has the focus, so the DOCUMENT's selection is collapsed — the passage
 *      is on screen only because the pane paints it, and `window.getSelection()` says nothing;
 *   2. `mousedown` fires first and moves the focus out of the composer;
 *   3. a `selectionchange` follows for the moved caret, and the pane — seeing focus outside itself
 *      and an empty selection — reads that as "the person clicked the words away" and clears;
 *   4. `contextmenu` fires last, asks what is selected, and is told nothing.
 *
 * So the gesture whose whole purpose is to ask a question ABOUT a selection was the gesture that
 * threw it away. The fix is that a secondary click is never a dismissal.
 */
import { describe, expect, it } from "vitest";
import { maySurrenderSelection } from "../src/renderer/reviewNotes";
import { selectionForMenu } from "../src/renderer/pointerMenu";

describe("when a held passage is let go of", () => {
  it("keeps it while the focus is inside a surface that declared it keeps selections", () => {
    // The original rule: focusing the composer collapses the document's selection, which is
    // indistinguishable from a click on empty space unless somebody says so.
    expect(maySurrenderSelection(true, false)).toBe(false);
  });

  it("keeps it through a RIGHT-CLICK, which asks about a selection rather than ending one", () => {
    // Step 3 above. Focus has already left the composer, so the first argument is false and the old
    // rule surrendered here — a full beat before the menu got to ask.
    expect(maySurrenderSelection(false, true)).toBe(false);
  });

  it("still lets go when the person clicks back into the words with the primary button", () => {
    // The behaviour the composer is supposed to have, and the reason this is not simply "never
    // clear": clicking away from a comment you are not going to write closes it.
    expect(maySurrenderSelection(false, false)).toBe(true);
  });
});

describe("the passage a right-click menu is handed", () => {
  it("is the held one once the composer has taken the focus", () => {
    // The other half of the seam: with the pane still holding, the menu has something to offer.
    expect(selectionForMenu("", "the held passage").text).toBe("the held passage");
  });

  it("is nothing at all if the pane let go first — the failure this pair prevents", () => {
    // What the menu saw before the fix. Both halves have to hold for the gesture to work, which is
    // why they are asserted in one file.
    expect(selectionForMenu("", null).text).toBe("");
  });
});
