/**
 * Anchored review notes, the part that is not drawing
 * ([decision 0002](../../../../docs/engineering/decisions/0002-one-gate-vocabulary.md)): reading a
 * selection inside an artifact in flattened-text offsets, painting the notes over it, hit-testing the
 * pointer against them, and who a note is signed as. It runs over the DOM react-native-web draws
 * (`ArtifactPane.tsx`, through `noteSelection.web.ts`): no DOM COMPONENTS here, and the document is
 * touched only in effects.
 *
 * Offsets count into the rendered `textContent`, not the source: a person selects words on the page,
 * whatever produced them. A view that reformats (JSON re-indented) moves them, which is what a note's
 * quote is for.
 *
 * The marks are painted with the Custom Highlight API. Wrapping ranges in `<mark>` would mutate a
 * subtree React owns; `CSS.highlights` paints the same ranges without touching the DOM, so it can sit
 * over any rendered content. Where it is absent nothing is painted and nothing else is lost. A highlight
 * is not hit-testable, so the notes list is the way in: clicking a row re-selects the passage.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { anchorNotes, type ReviewNote } from "@jaira/shared/browser";
import { invoke } from "./store";

/** A live selection inside the artifact, in the terms a note is written in. */
export interface PendingSelection {
  quote: string;
  start: number;
  end: number;
  /** Viewport rect of the selection, for placing the composer. */
  rect: { top: number; bottom: number; left: number; right: number };
}

// --- reading a selection -----------------------------------------------------

/**
 * Walk `root`'s text nodes, returning each with the offset at which it starts.
 *
 * The whole anchoring scheme rests on this walk agreeing with `root.textContent` — the same nodes
 * in the same order — which is exactly what `TreeWalker` with `SHOW_TEXT` gives, and why the offset
 * is accumulated here rather than searched for later.
 */
function textRuns(root: Node): Array<{ node: Text; start: number }> {
  const runs: Array<{ node: Text; start: number }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    runs.push({ node: text, start: at });
    at += text.data.length;
  }
  return runs;
}

/** Where a (node, offset) boundary sits in `root`'s flattened text. */
function offsetOf(runs: ReadonlyArray<{ node: Text; start: number }>, node: Node, offset: number): number | undefined {
  for (const run of runs) {
    if (run.node === node) return run.start + offset;
  }
  return undefined;
}

/** The reverse: a DOM range covering `[start, end)` of the flattened text. */
function rangeAt(runs: ReadonlyArray<{ node: Text; start: number }>, start: number, end: number): Range | undefined {
  let from: { node: Text; offset: number } | undefined;
  let to: { node: Text; offset: number } | undefined;
  for (const run of runs) {
    const runEnd = run.start + run.node.data.length;
    if (from === undefined && start >= run.start && start <= runEnd) from = { node: run.node, offset: start - run.start };
    if (end >= run.start && end <= runEnd) {
      to = { node: run.node, offset: end - run.start };
      // Keep going only until both ends are known: a zero-length run at the boundary would
      // otherwise steal the end from the run that actually contains the text.
      if (from !== undefined) break;
    }
  }
  if (from === undefined || to === undefined) return undefined;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/**
 * Marks a subtree as one that must not cost the pending selection when focus enters it.
 *
 * The composer is the only such subtree, and it needs to be: focusing its textarea COLLAPSES the
 * document selection, which is indistinguishable from the person clicking the words away unless
 * somebody says so. See {@link useSelectionInside} for the bug this fixes.
 */
export const KEEPS_SELECTION = "data-keeps-selection";

/**
 * The passage a surface is HOLDING, for the window's right-click menu to find.
 *
 * The sibling of {@link KEEPS_SELECTION} and the other half of the same problem. That one stops the
 * composer's focus from being read as "the person clicked the words away"; this one stops the
 * consequence of that focus — a collapsed document selection — from being read as "nothing is
 * selected". Right-clicking the passage you had just dragged over offered no menu at all, because
 * `itemsForEvent` asks `window.getSelection()` and the textarea had already taken it.
 *
 * An ATTRIBUTE rather than a shared variable, because that is how `itemsForEvent` asks every other
 * question it asks: it is handed an element and walks up from it (`closest("img")`, `closest("a")`,
 * `closest("input, textarea")`). A module-level "current selection" would be a second source of
 * truth about a thing the DOM can carry, readable from anywhere and stale the moment a second
 * artifact mounts.
 */
export const HELD_QUOTE = "data-held-quote";

/**
 * Report the current selection when it lies inside `ref`, in flattened-text offsets.
 *
 * Listens on `selectionchange` at the document, because a selection can be extended with the
 * keyboard, dragged past the container's edge, or cleared by a click anywhere — none of which are
 * events the container itself sees.
 *
 * ## The composer opens when the drag ENDS, not while it is happening
 *
 * `selectionchange` fires continuously as the pointer moves, so surfacing every one of them opened
 * the composer on the first character and then focused its textarea — which took the caret out of
 * the document mid-drag and ended the selection the person was still making. The result was a
 * popover that flickered and a passage you could not extend.
 *
 * So the range is TRACKED on every `selectionchange` and only COMMITTED on `pointerup`. The rule is
 * the one every text editor uses — the gesture is finished when the person lets go, not when it
 * first becomes non-empty.
 *
 * Pointer only, deliberately. Shift-arrow selection fires `keyup` on every keypress, so committing
 * there opened the composer in the middle of a keyboard selection and stole the focus that was
 * extending it — the same failure as committing mid-drag, one input device over. The cost is that
 * there is no keyboard route to a comment yet; that wants a deliberate shortcut rather than a
 * side effect of moving the caret.
 *
 * ## The composer must not clear the selection it is about
 *
 * A collapsed or absent selection normally means "the person clicked the words away", and clearing
 * is right. It also happens when the composer's textarea takes focus — a textarea owns its own
 * selection, so putting the caret in it collapses the document's. The first version cleared on
 * that, which is why the popover appeared and vanished in the same frame: it opened, focused
 * itself, and killed the very selection that opened it.
 *
 * So an empty selection clears only when focus is NOT inside a subtree that has declared itself
 * selection-preserving ({@link KEEPS_SELECTION}). Clicking back in the artifact still closes the
 * composer, because focus is then in the artifact rather than in the composer.
 */
/**
 * Whether an empty selection means the person is DONE with the passage.
 *
 * The one judgement in {@link useSelectionInside}, pulled out because it is the only part of it a
 * test in this repo can reach — the suite runs on `environment: "node"`, so there is no document to
 * put a caret in. Both arguments are facts about the gesture, and both are reasons to keep holding.
 *
 * `activeInKeeper` is the original: focusing the composer's textarea collapses the document's
 * selection, which is indistinguishable from a click on empty space unless somebody says so.
 *
 * `secondary` is the one that was missing, and it is why the passage could be commented on but never
 * copied. On Windows a right-click delivers `mousedown` first and `contextmenu` after it, so the
 * mousedown moved focus out of the composer, `activeInKeeper` went false, a `selectionchange` fired
 * for the moved caret, and the pane surrendered the passage — unmounting the composer and taking the
 * held quote with it. The menu then opened a moment later, asked what was selected, and was told
 * nothing. The gesture that exists to ask a question ABOUT a selection was being read as the gesture
 * that throws one away.
 *
 * A right-click is never a dismissal. Clicking back into the artifact with the primary button still
 * is one, which is the behaviour the composer is supposed to have.
 */
export function maySurrenderSelection(activeInKeeper: boolean, secondary: boolean): boolean {
  return !activeInKeeper && !secondary;
}

export function useSelectionInside(ref: RefObject<HTMLElement | null>): [PendingSelection | null, () => void] {
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  /** The last range seen, held until the gesture ends. See the hook's note. */
  const pending = useRef<PendingSelection | null>(null);
  const clear = useCallback(() => {
    pending.current = null;
    setSelection(null);
  }, []);
  /**
   * Whether the gesture in flight is a SECONDARY click — see {@link maySurrenderSelection}.
   *
   * A ref and not state: it is read inside a listener during a gesture and must not cost a render,
   * and nothing on screen depends on it. Set on the way down, so it is already true by the time the
   * focus change it causes has produced a `selectionchange`.
   */
  const secondary = useRef(false);

  useEffect(() => {
    // CAPTURE, so this runs before any handler that might move the focus — the point is to know
    // which button started the gesture, and every consequence of the press comes after this.
    const onDown = (event: MouseEvent): void => {
      secondary.current = event.button === 2;
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  useEffect(() => {
    const onChange = (): void => {
      const root = ref.current;
      const live = window.getSelection();
      /**
       * Whether an EMPTY selection should close the composer.
       *
       * Only the clearing is suppressed, never the updating — the first version returned outright
       * whenever focus was in the composer, which fixed the flicker and then made the artifact
       * unselectable: with the composer open, focus is in its textarea, so every drag in the
       * artifact was ignored and no second passage could ever be picked.
       */
      const mayClear = maySurrenderSelection(
        document.activeElement?.closest(`[${KEEPS_SELECTION}]`) != null,
        secondary.current,
      );
      const nothing = (): void => {
        if (!mayClear) return;
        pending.current = null;
        setSelection(null);
      };
      if (root === null || live === null || live.rangeCount === 0 || live.isCollapsed) {
        nothing();
        return;
      }
      const range = live.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) return; // A selection elsewhere is not ours to clear.
      const quote = range.toString();
      if (quote.trim().length === 0) {
        nothing();
        return;
      }
      const runs = textRuns(root);
      const start = offsetOf(runs, range.startContainer, range.startOffset);
      const end = offsetOf(runs, range.endContainer, range.endOffset);
      if (start === undefined || end === undefined || end <= start) {
        nothing();
        return;
      }
      const rect = range.getBoundingClientRect();
      pending.current = {
        quote,
        start,
        end,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      };
      // Already open on this passage? Keep it in step as the selection is extended. Opening is what
      // waits for the release; following is not.
      setSelection((shown) => (shown === null ? null : pending.current));
    };

    /** The pointer was released — show what was tracked. See the hook's note on why not the keyboard. */
    const commit = (): void => {
      if (pending.current !== null) setSelection(pending.current);
    };

    document.addEventListener("selectionchange", onChange);
    document.addEventListener("pointerup", commit);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("pointerup", commit);
    };
  }, [ref]);

  return [selection, clear];
}

// --- marking what has been commented on --------------------------------------

const HIGHLIGHT = "jaira-note";
/** The one under the pointer, or the one whose thread is being hovered — see `styles.css`. */
const HOT = "jaira-note-hot";
/**
 * The passage a note is being WRITTEN about, held on screen while the composer has the focus.
 *
 * A textarea owns its own selection, so focusing the composer collapses the document's — which is
 * why the words you had just dragged over went plain in the same frame the popover appeared, with
 * the quote in the popover's header the only remaining sign of what you had picked. Nothing was
 * lost (`useSelectionInside` keeps the offsets, which is what the note is anchored by); what was
 * lost was the reader's place, on the one surface whose whole job is pointing at a passage.
 *
 * It cannot be fixed by keeping the DOM selection: the composer has to be typeable, focusing it is
 * what makes it typeable, and no element can hold the caret while another holds a selection. So the
 * mark is PAINTED instead — the same `CSS.highlights` the resolved notes use, which touches no DOM
 * and therefore works over rendered markdown, a table, an iframe's sibling, anything.
 */
const DRAFTING = "jaira-note-drafting";

/** Paint every resolved note's range. A no-op where `CSS.highlights` is absent — see the module note. */
export function useNoteHighlights(
  ref: RefObject<HTMLElement | null>,
  notes: readonly ReviewNote[],
  /** The note the pointer is over, drawn louder than the rest. */
  hot?: number | null,
  /** The passage a note is being written about right now — see {@link DRAFTING}. */
  drafting?: { start: number; end: number } | null,
): void {
  // Layout, not effect: the ranges are measured against DOM that has to be the DOM on screen, and
  // a paint between the two shows the previous review's marks over this one's text.
  useLayoutEffect(() => {
    const root = ref.current;
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const Ctor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (root === null || highlights === undefined || Ctor === undefined) return undefined;

    const runs = textRuns(root);
    const text = root.textContent ?? "";
    const ranges: Range[] = [];
    const hotRanges: Range[] = [];
    anchorNotes(text, notes).forEach((note, i) => {
      if (note.resolved === undefined) return;
      const range = rangeAt(runs, note.resolved.start, note.resolved.end);
      if (range === undefined) return;
      (i === hot ? hotRanges : ranges).push(range);
    });
    // The passage being commented on, in the offsets the selection reported. Resolved against the
    // SAME runs as the notes, so a document that re-rendered under the composer (the view toggle
    // moved, a stream landed) puts the mark where the words are now rather than where they were.
    const draft =
      drafting === undefined || drafting === null ? undefined : rangeAt(runs, drafting.start, drafting.end);
    if (ranges.length === 0) highlights.delete(HIGHLIGHT);
    else highlights.set(HIGHLIGHT, new Ctor(...ranges));
    if (hotRanges.length === 0) highlights.delete(HOT);
    else highlights.set(HOT, new Ctor(...hotRanges));
    if (draft === undefined) highlights.delete(DRAFTING);
    else highlights.set(DRAFTING, new Ctor(draft));
    return () => {
      highlights.delete(HIGHLIGHT);
      highlights.delete(HOT);
      highlights.delete(DRAFTING);
    };
  });
}

/**
 * The artifact's flattened text, kept in state rather than read off the ref during render.
 *
 * Re-read on EVERY render with no dependency list, and written only when it actually differs. That
 * is not laziness about dependencies — the text changes for a reason React cannot see: switching
 * `ValueView`'s toggle from markdown to source re-renders a child with entirely different
 * `textContent`, and the note list has to re-anchor against it. (Notes survive that switch on the
 * quote, which is the anchoring rule paying for itself.)
 */
export function useFlatText(ref: RefObject<HTMLElement | null>): string {
  const [text, setText] = useState("");
  useLayoutEffect(() => {
    const current = ref.current?.textContent ?? "";
    setText((previous) => (previous === current ? previous : current));
  });
  return text;
}

/**
 * Which note the pointer is over, by hit-testing the caret position under it.
 *
 * A painted highlight is not an element, so there is nothing to put a `:hover` on — the whole reason
 * `CSS.highlights` can sit over arbitrary rendered content is that it does not touch the DOM. So the
 * pointer is converted to a document offset and matched against the notes' ranges, which is the same
 * arithmetic the anchoring already does.
 *
 * Returns the index into `notes`, or `null`. Cheap enough for `pointermove`: one caret hit-test and
 * a walk over a handful of ranges.
 */
export function useHoveredNote(ref: RefObject<HTMLElement | null>, notes: readonly ReviewNote[]): number | null {
  const [hovered, setHovered] = useState<number | null>(null);
  const live = useRef(notes);
  live.current = notes;

  useEffect(() => {
    const root = ref.current;
    if (root === null) return undefined;
    const onMove = (e: PointerEvent): void => {
      const offset = offsetAtPoint(root, e.clientX, e.clientY);
      if (offset === null) {
        setHovered(null);
        return;
      }
      const anchored = anchorNotes(root.textContent ?? "", live.current);
      const at = anchored.findIndex(
        (note) => note.resolved !== undefined && offset >= note.resolved.start && offset < note.resolved.end,
      );
      setHovered(at === -1 ? null : at);
    };
    const onLeave = (): void => setHovered(null);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, [ref]);

  return hovered;
}

/** The flattened-text offset under a viewport point, or null when the point is not over text. */
function offsetAtPoint(root: HTMLElement, x: number, y: number): number | null {
  // Two spellings of one API: `caretPositionFromPoint` is the standard, `caretRangeFromPoint` is
  // what Chromium shipped first and still supports.
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  const node = position?.offsetNode ?? doc.caretRangeFromPoint?.(x, y)?.startContainer;
  const within = position?.offset ?? doc.caretRangeFromPoint?.(x, y)?.startOffset;
  if (node === undefined || within === undefined || !root.contains(node)) return null;
  return offsetOf(textRuns(root), node, within) ?? null;
}

/** Put the browser selection back on a note's passage — the notes list's way back into the text. */
export function reselect(root: HTMLElement | null, note: ReviewNote): void {
  if (root === null) return;
  const resolved = anchorNotes(root.textContent ?? "", [note])[0]?.resolved;
  if (resolved === undefined) return;
  const range = rangeAt(textRuns(root), resolved.start, resolved.end);
  if (range === undefined) return;
  const live = window.getSelection();
  live?.removeAllRanges();
  live?.addRange(range);
  (range.startContainer.parentElement ?? root).scrollIntoView({ block: "nearest" });
}

// --- who is writing ----------------------------------------------------------

/**
 * Names already resolved this session, so a second mount starts with the right one.
 *
 * Main caches per project too, but an IPC round trip is still a render apart — and one consumer,
 * the self-mounting changeset reviewer, remounts when the author changes. Seeding from here makes
 * that remount happen once ever rather than once per review.
 */
const AUTHORS = new Map<string, string>();

/**
 * The name a note is signed with, from `git config user.name`.
 *
 * "you" when git has no opinion — an unsigned note is better than a blocked one, and a person
 * reviewing their own machine's work knows who "you" is.
 */
export function useAuthor(project?: string | undefined): string {
  const key = project ?? "";
  const [author, setAuthor] = useState(() => AUTHORS.get(key) ?? "you");
  useEffect(() => {
    if (AUTHORS.has(key)) {
      setAuthor(AUTHORS.get(key)!);
      return undefined;
    }
    let live = true;
    void invoke("git:identity", project === undefined ? {} : { project })
      .then((identity) => {
        if (identity.name === undefined || identity.name.length === 0) return;
        AUTHORS.set(key, identity.name);
        if (live) setAuthor(identity.name);
      })
      .catch(() => {
        /* An unsigned note is the fallback, not an error to report. */
      });
    return () => {
      live = false;
    };
  }, [key, project]);
  return author;
}
