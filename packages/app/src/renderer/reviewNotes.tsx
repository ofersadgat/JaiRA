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
import { useEffect, useRef, useState, type JSX } from "react";
import { FORGE_LABELS, anchorNotes, decisionWordOf, shortQuote, type ForgeProviderKind, type ReviewNote } from "@jaira/shared/browser";
import { BrandIcon, Icon } from "./icons";
import { Popover } from "./popover";
import { forgeName as forgeLabel, repliesOnForge } from "./remoteStrip";

export {
  HELD_QUOTE,
  KEEPS_SELECTION,
  maySurrenderSelection,
  reselect,
  useAuthor,
  useFlatText,
  useHoveredNote,
  useNoteHighlights,
  useSelectionInside,
  type PendingSelection,
} from "./reviewSelection";
import { KEEPS_SELECTION, type PendingSelection } from "./reviewSelection";

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

  // Below the selection when there is room, above it when there is not; kept inside the window.
  return (
    <Popover
      anchor={selection.rect}
      side="below"
      align="start"
      gap={8}
      className="note-composer"
      data-testid="note-composer"
      {...{ [KEEPS_SELECTION]: "" }}
      style={{ width: 320 }}
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
    </Popover>
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
  /** May return a promise: a reply on a forge thread is a network call, and the row says so while it runs. */
  onReply?: ((index: number, body: string, resolve?: boolean) => void | Promise<void>) | undefined;
  /** Absent ⇒ the threads are a record: nothing can be deleted. */
  onRemove?: ((index: number) => void) | undefined;
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
          onReply={onReply === undefined ? undefined : (body, resolve) => onReply(i, body, resolve)}
          onRemove={onRemove === undefined ? undefined : () => onRemove(i)}
        />
      ))}
    </div>
  );
}

/**
 * Where a message was written, when that is not here (decision 0004) — once, beside its author.
 *
 * A mark and a word rather than a colour: the note is the same kind of thing whoever wrote it, and
 * what the reader needs is only to know that replying to it is replying on the forge.
 */
export function SourceMark({ source }: { source: string }): JSX.Element {
  const label = FORGE_LABELS[source as ForgeProviderKind]?.name ?? source;
  return (
    <span className="note-src" title={`written on ${label}`}>
      <BrandIcon name={source} /> {label}
    </span>
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
  onReply?: ((body: string, resolve?: boolean) => void | Promise<void>) | undefined;
  onRemove?: (() => void) | undefined;
}): JSX.Element {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  // A thread that lives on the forge: a reply is posted THERE, as the connection's account.
  const onForge = repliesOnForge(note);
  const send = (resolve: boolean): void => {
    const body = reply.trim();
    if (body.length === 0 || onReply === undefined || sending) return;
    setFailed(undefined);
    const sent = onReply(body, resolve);
    if (!(sent instanceof Promise)) {
      setReply("");
      return;
    }
    // The words stay in the box until the forge has them: a reply lost to a dropped connection must
    // still be there to send again.
    setSending(true);
    void sent
      .then(() => setReply(""))
      .catch((e: unknown) => setFailed((e as Error).message))
      .finally(() => setSending(false));
  };
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
        {/* A thread that lives on the forge cannot be deleted from here: this is a view of it. */}
        {onRemove === undefined || note.source !== undefined ? null : (
        <button className="ghost note-row-remove" title="delete this thread" onClick={onRemove}>
          <Icon name="cross" />
        </button>
        )}
      </div>

      {messages.map((message, i) => (
        // A message whose whole body is a decision word IS that decision (decision 0004), so it is
        // drawn as one rather than as a remark that happens to be short.
        <div className={`note-msg${note.source !== undefined && decisionWordOf(message.body) !== undefined ? " is-word" : ""}`} key={`${message.at}-${i}`}>
          <div className="note-msg-by">
            <Icon name="comment" className="note-icon" /> {message.author}
            {note.source === undefined ? null : <SourceMark source={note.source} />}
          </div>
          <div className="note-msg-body">{message.body}</div>
        </div>
      ))}

      {onReply === undefined ? null : (
        <form
          className="note-reply"
          onSubmit={(e) => {
            e.preventDefault();
            send(false);
          }}
        >
          <input
            value={reply}
            disabled={sending}
            placeholder={onForge ? `Reply on ${forgeLabel(note.source)}…` : `Reply as ${author}…`}
            onChange={(e) => setReply(e.target.value)}
          />
          <button className="ghost" type="submit" disabled={sending || reply.trim().length === 0}>
            {sending ? "Sending…" : "Reply"}
          </button>
          {onForge ? (
            <button className="ghost" type="button" disabled={sending || reply.trim().length === 0} title="post the reply and mark the thread resolved on the forge" onClick={() => send(true)}>
              Reply &amp; resolve
            </button>
          ) : null}
          {failed === undefined ? null : <span className="sub warn-text">{failed}</span>}
        </form>
      )}
    </div>
  );
}
