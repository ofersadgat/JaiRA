/**
 * An anchored review note — the one comment record both review components use
 * ([decision 0002](../../../docs/engineering/decisions/0002-one-gate-vocabulary.md)).
 *
 * A gate exists so a person can send work back with notes, and until now the only place to put them
 * was one textarea for the whole artifact: "the second paragraph is wrong" had to be written out as
 * prose because there was no way to point. A note points.
 *
 * ## Why the quote is the anchor and the offsets are the hint
 *
 * A note is written against text that is about to be regenerated. Offsets do not survive that — the
 * model rewrites a paragraph above and every number below it is wrong, silently, which is the worst
 * kind of wrong for an anchor. The quote does survive, and it is also what the next reader needs:
 * the model receiving the note is told *which words*, not which character range.
 *
 * So {@link anchorNote} resolves the range from the quote FIRST and treats the stored offsets as a
 * disambiguator for a quote that appears more than once. A note whose quote is gone is not an
 * error — it is an ORPHAN, and it still has to be shown, because "the thing you commented on no
 * longer exists" is information the reviewer wants rather than a note to drop on the floor.
 *
 * ## Offsets into what
 *
 * Into the plain text of the rendered view — `textContent`, not the source. That is the string the
 * person actually selected from, and it is the same string whichever view produced it, so a note
 * taken on the markdown rendering still resolves against the source view and back again.
 */
import type { JsonValue } from "@declarative-ai/json";

/** Where in a diff a note sits. Absent ⇒ the artifact is not a diff. */
export type NoteSide = "before" | "after";

export interface ReviewNote {
  /**
   * What the note is about: the input name for `review_artifact`, the change id inside a set.
   *
   * Present even in the single-artifact case, so a note read out of a run's outputs says what it
   * was about without the state file beside it.
   */
  artifact: string;
  /** The text the note is anchored to, verbatim. The anchor of record — see the module note. */
  quote: string;
  /** Where the quote was when the note was taken. A hint, not the anchor. */
  range?: { start: number; end: number };
  side?: NoteSide;
  /** What the person wrote. */
  body: string;
  /** Who wrote it — `git config user.name`, else "you". */
  author: string;
  /** When, ISO-8601. */
  at: string;
  /**
   * The rest of the conversation about this passage, oldest first.
   *
   * A note is a THREAD, not a remark. Review comments get answered — by the person clarifying what
   * they meant, or by a later round explaining what was done — and a shape with room for only the
   * opening line forces every answer to be a new note anchored to the same words, which reads as
   * several unrelated complaints about one sentence.
   */
  replies?: NoteReply[];
  /**
   * Where the note was WRITTEN, when that is not here (decision 0004): `gitlab`, `github`.
   *
   * A message that came from the forge says so, once, beside its author. Absent means it was written
   * in JaiRA — which is also what decides which notes are posted to the forge when a gate settles
   * locally: the ones the forge has not already got.
   */
  source?: string;
  /** The forge's id for the thread, so a later state can reply on it (`remote_comment` `thread`). */
  thread?: string;
}

/** One message after the opening one. */
export interface NoteReply {
  author: string;
  body: string;
  at: string;
}

/** A note plus where it currently resolves. `range` absent ⇒ orphaned; the quote is gone. */
export interface AnchoredNote extends ReviewNote {
  resolved?: { start: number; end: number };
}

/**
 * Resolve a note against the text as it is NOW.
 *
 * Quote first, stored offsets only to choose between repeats. The order matters: preferring the
 * offsets would silently re-anchor a note onto whatever text drifted into those positions, which
 * reads as a comment about the wrong sentence rather than as a comment that lost its sentence.
 */
export function anchorNote(text: string, note: ReviewNote): { start: number; end: number } | undefined {
  if (note.quote.length === 0) return undefined;
  // The stored range still holding the same words is the common case and the cheap one.
  const hinted = note.range;
  if (hinted !== undefined && text.slice(hinted.start, hinted.end) === note.quote) return hinted;

  const first = text.indexOf(note.quote);
  if (first === -1) return undefined;

  // Repeats: take the occurrence nearest where the note was written. With no hint, the first one —
  // which is the only answer available and is at least stable across renders.
  if (hinted === undefined) return { start: first, end: first + note.quote.length };
  let best = first;
  for (let at = first; at !== -1; at = text.indexOf(note.quote, at + 1)) {
    if (Math.abs(at - hinted.start) < Math.abs(best - hinted.start)) best = at;
  }
  return { start: best, end: best + note.quote.length };
}

/** Every note against one artifact, each with its current position. Orphans keep their place. */
export function anchorNotes(text: string, notes: readonly ReviewNote[]): AnchoredNote[] {
  return notes.map((note) => {
    const resolved = anchorNote(text, note);
    return resolved === undefined ? { ...note } : { ...note, resolved };
  });
}

/** How many characters of a quote a list row shows before eliding the middle. */
const QUOTE_ELISION = 90;

/**
 * A quote as a list row shows it: whitespace flattened, the middle elided.
 *
 * The middle rather than the tail, because the two ends are what identify a passage — a row reading
 * "The probe runs on open, on every…and on demand." is recognisable, and the same length trimmed
 * from the right is not.
 */
export function shortQuote(quote: string): string {
  const flat = quote.replace(/\s+/gu, " ").trim();
  if (flat.length <= QUOTE_ELISION) return flat;
  const half = Math.floor((QUOTE_ELISION - 1) / 2);
  return `${flat.slice(0, half)}…${flat.slice(flat.length - half)}`;
}

// --- validation --------------------------------------------------------------

export type NotesCheck = { ok: true; notes: ReviewNote[] } | { ok: false; errors: string };

function badAt(i: number, what: string): NotesCheck {
  return { ok: false, errors: `notes[${i}].${what}` };
}

/**
 * Check submitted notes. Called in the main process for the same reason every other component
 * result is: the renderer is the untrusted half of the boundary, and a note lands on a state's
 * declared outputs like any other value.
 *
 * `undefined` is valid and means no notes — a review with nothing to say about a particular line is
 * the normal one, and demanding an empty array would make every state file declare a slot it never
 * fills.
 */
export function checkNotes(raw: unknown): NotesCheck {
  if (raw === undefined) return { ok: true, notes: [] };
  if (!Array.isArray(raw)) return { ok: false, errors: "result.notes must be an array when present" };
  const notes: ReviewNote[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i] as Record<string, unknown> | null;
    if (row === null || typeof row !== "object" || Array.isArray(row)) return badAt(i, "must be an object");
    for (const key of ["artifact", "quote", "body", "author", "at"] as const) {
      if (typeof row[key] !== "string") return badAt(i, `${key} must be a string`);
    }
    if ((row["body"] as string).trim().length === 0) return badAt(i, "body must not be empty");
    const note: ReviewNote = {
      artifact: row["artifact"] as string,
      quote: row["quote"] as string,
      body: row["body"] as string,
      author: row["author"] as string,
      at: row["at"] as string,
    };
    const range = row["range"];
    if (range !== undefined) {
      if (range === null || typeof range !== "object" || Array.isArray(range)) return badAt(i, "range must be an object");
      const { start, end } = range as { start?: unknown; end?: unknown };
      if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) {
        return badAt(i, "range.start and range.end must be integers");
      }
      if (start < 0 || end < start) return badAt(i, "range must be a non-negative, non-inverted span");
      note.range = { start, end };
    }
    const side = row["side"];
    if (side !== undefined) {
      if (side !== "before" && side !== "after") return badAt(i, `side must be "before" or "after"`);
      note.side = side;
    }
    for (const key of ["source", "thread"] as const) {
      const held = row[key];
      if (held === undefined) continue;
      if (typeof held !== "string" || held.length === 0) return badAt(i, `${key} must be a non-empty string when present`);
      note[key] = held;
    }
    const replies = row["replies"];
    if (replies !== undefined) {
      if (!Array.isArray(replies)) return badAt(i, "replies must be an array when present");
      const checked: NoteReply[] = [];
      for (let r = 0; r < replies.length; r++) {
        const reply = replies[r] as Record<string, unknown> | null;
        if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
          return badAt(i, `replies[${r}] must be an object`);
        }
        for (const key of ["author", "body", "at"] as const) {
          if (typeof reply[key] !== "string") return badAt(i, `replies[${r}].${key} must be a string`);
        }
        if ((reply["body"] as string).trim().length === 0) return badAt(i, `replies[${r}].body must not be empty`);
        checked.push({ author: reply["author"] as string, body: reply["body"] as string, at: reply["at"] as string });
      }
      if (checked.length > 0) note.replies = checked;
    }
    notes.push(note);
  }
  return { ok: true, notes };
}

/** A note as it goes over the wire — the same fields, typed as JSON. */
export function noteJson(note: ReviewNote): JsonValue {
  return {
    artifact: note.artifact,
    quote: note.quote,
    ...(note.range === undefined ? {} : { range: { start: note.range.start, end: note.range.end } }),
    ...(note.side === undefined ? {} : { side: note.side }),
    body: note.body,
    author: note.author,
    at: note.at,
    ...(note.replies === undefined || note.replies.length === 0
      ? {}
      : { replies: note.replies.map((r) => ({ author: r.author, body: r.body, at: r.at })) }),
  };
}
