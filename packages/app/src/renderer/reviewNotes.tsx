/**
 * Anchored review notes on screen: select text, say what is wrong with it, see it marked
 * ([decision 0002](../../../../docs/engineering/decisions/0002-one-gate-vocabulary.md)).
 *
 * ## Offsets come from the rendered text, not the source
 *
 * A person selects words on the page. Whatever produced those words — markdown, a source view, a
 * diff — the thing selected is a run of `textContent`, so that is what an offset counts into. It
 * also means a note taken on the rendered view resolves against the source view and back, because
 * `viewsFor` renders the same characters either way. What it does NOT survive is a view that
 * reformats (JSON re-indented), and that is what the quote is for.
 *
 * ## Marking uses the Custom Highlight API, and degrades to nothing
 *
 * Wrapping matched ranges in `<mark>` means mutating a subtree React owns, across element
 * boundaries that `Range.surroundContents` refuses outright. `CSS.highlights` paints the same
 * ranges without touching the DOM at all, which is the only version of this that can sit on top of
 * arbitrary rendered content. Electron is well past the version that shipped it; the feature check
 * is there for jsdom, where the absence costs a test its highlight and nothing else.
 *
 * The cost is that a highlight is not hit-testable — you cannot click the marked words to open the
 * note. So the notes list below the artifact is not a convenience, it is the way in: it carries the
 * quote, and clicking a row re-selects the passage.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from "react";
import { anchorNotes, shortQuote, type ReviewNote } from "@jaira/shared/browser";
import { Icon } from "./icons";
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
export function useSelectionInside(ref: RefObject<HTMLElement | null>): [PendingSelection | null, () => void] {
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  /** The last range seen, held until the gesture ends. See the module note. */
  const pending = useRef<PendingSelection | null>(null);
  const clear = useCallback(() => {
    pending.current = null;
    setSelection(null);
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
      const mayClear = document.activeElement?.closest(`[${KEEPS_SELECTION}]`) == null;
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

    /** The pointer was released — show what was tracked. See the module note on why not the keyboard. */
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

/** Paint every resolved note's range. A no-op where `CSS.highlights` is absent — see the module note. */
export function useNoteHighlights(
  ref: RefObject<HTMLElement | null>,
  notes: readonly ReviewNote[],
  /** The note the pointer is over, drawn louder than the rest. */
  hot?: number | null,
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
    if (ranges.length === 0) highlights.delete(HIGHLIGHT);
    else highlights.set(HIGHLIGHT, new Ctor(...ranges));
    if (hotRanges.length === 0) highlights.delete(HOT);
    else highlights.set(HOT, new Ctor(...hotRanges));
    return () => {
      highlights.delete(HIGHLIGHT);
      highlights.delete(HOT);
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

// --- the surfaces ------------------------------------------------------------

/**
 * The composer, floating at the selection.
 *
 * Fixed-positioned against the viewport rect the selection reported, because the artifact it sits
 * over scrolls inside its own well and an absolutely-positioned popover would ride away from the
 * words it is about. Clamped horizontally so a selection at the right edge does not open a box off
 * the window.
 */
export function NoteComposer({
  selection,
  author,
  onSave,
  onCancel,
}: {
  selection: PendingSelection;
  author: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const WIDTH = 320;
  const left = Math.max(8, Math.min(selection.rect.left, window.innerWidth - WIDTH - 8));
  // Below the selection when there is room, above it when there is not.
  const below = selection.rect.bottom + 8;
  const fits = below + 160 < window.innerHeight;

  return (
    <div
      className="note-composer"
      data-testid="note-composer"
      {...{ [KEEPS_SELECTION]: "" }}
      style={{
        left,
        width: WIDTH,
        ...(fits ? { top: below } : { bottom: window.innerHeight - selection.rect.top + 8 }),
      }}
      // A click inside must not clear the selection the note is about.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="note-composer-head">
        <Icon name="comment" className="note-icon" />
        <span className="note-author">{author}</span>
      </div>
      <blockquote className="note-quote">{shortQuote(selection.quote)}</blockquote>
      <textarea
        ref={ref}
        rows={3}
        value={body}
        placeholder="What should change here?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          // Enter submits; Shift+Enter is a newline. A note is normally one sentence.
          if (e.key === "Enter" && !e.shiftKey && body.trim().length > 0) {
            e.preventDefault();
            onSave(body.trim());
          }
        }}
      />
      <div className="note-composer-actions">
        <button className="primary" disabled={body.trim().length === 0} onClick={() => onSave(body.trim())}>
          Comment
        </button>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Every note on this artifact, as THREADS.
 *
 * A review comment gets answered — by the person clarifying what they meant, or by a later round
 * saying what was done — so a shape with room for only the opening line pushed every answer into a
 * new note anchored to the same words, and one conversation read as several complaints.
 *
 * Each thread is the quote it is about, then its messages oldest first, then a box to add another.
 * It is also the way BACK into the text, since a painted highlight cannot be clicked: hovering a
 * thread lights its passage, and hovering the passage lights the thread.
 *
 * An orphan — a note whose quote is no longer in the artifact — stays and says so. What you
 * commented on being gone is the reviewer's information, not a reason to drop their words.
 */
export function NoteList({
  notes,
  text,
  author,
  hovered,
  onHover,
  onReselect,
  onReply,
  onRemove,
}: {
  notes: readonly ReviewNote[];
  /** The artifact's current flattened text, for deciding which notes still resolve. */
  text: string;
  /** Who a reply is from. */
  author: string;
  /** The thread the pointer is over in the ARTIFACT — lit here to close the loop. */
  hovered?: number | null;
  onHover?: ((index: number | null) => void) | undefined;
  onReselect: (note: ReviewNote) => void;
  onReply?: ((index: number, body: string) => void) | undefined;
  onRemove: (index: number) => void;
}): JSX.Element | null {
  if (notes.length === 0) return null;
  const anchored = anchorNotes(text, notes);
  return (
    <div className="note-list" data-testid="note-list">
      <div className="note-list-head">
        <Icon name="comment" className="note-icon" />
        {notes.length === 1 ? "1 note" : `${notes.length} notes`}
      </div>
      {anchored.map((note, i) => (
        <NoteThread
          key={`${note.at}-${i}`}
          note={note}
          author={author}
          orphan={note.resolved === undefined}
          hot={hovered === i}
          onEnter={() => onHover?.(i)}
          onLeave={() => onHover?.(null)}
          onReselect={() => onReselect(note)}
          onReply={onReply === undefined ? undefined : (body) => onReply(i, body)}
          onRemove={() => onRemove(i)}
        />
      ))}
    </div>
  );
}

function NoteThread({
  note,
  author,
  orphan,
  hot,
  onEnter,
  onLeave,
  onReselect,
  onReply,
  onRemove,
}: {
  note: ReviewNote;
  author: string;
  orphan: boolean;
  hot: boolean;
  onEnter(): void;
  onLeave(): void;
  onReselect(): void;
  onReply?: ((body: string) => void) | undefined;
  onRemove(): void;
}): JSX.Element {
  const [reply, setReply] = useState("");
  const messages = [{ author: note.author, body: note.body, at: note.at }, ...(note.replies ?? [])];

  return (
    <div
      className={["note-row", orphan ? "orphan" : "", hot ? "hot" : ""].join(" ").trim()}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <div className="note-row-top">
        <button
          className="note-row-quote"
          title={orphan ? "this passage is no longer in the artifact" : "show this passage"}
          disabled={orphan}
          onClick={onReselect}
        >
          {orphan ? "text changed" : shortQuote(note.quote)}
        </button>
        <button className="ghost note-row-remove" title="delete this thread" onClick={onRemove}>
          <Icon name="cross" />
        </button>
      </div>

      {messages.map((message, i) => (
        <div className="note-msg" key={`${message.at}-${i}`}>
          <div className="note-msg-by">
            <Icon name="comment" className="note-icon" /> {message.author}
          </div>
          <div className="note-msg-body">{message.body}</div>
        </div>
      ))}

      {onReply === undefined ? null : (
        <form
          className="note-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim().length === 0) return;
            onReply(reply.trim());
            setReply("");
          }}
        >
          <input
            value={reply}
            placeholder={`Reply as ${author}…`}
            onChange={(e) => setReply(e.target.value)}
          />
          <button className="ghost" type="submit" disabled={reply.trim().length === 0}>
            Reply
          </button>
        </form>
      )}
    </div>
  );
}
