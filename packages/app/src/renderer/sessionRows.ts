/**
 * The conversation's PAGE as rows — which notes and bands, in what order, and where each sits on the
 * rail — moved out of `sessionPanels.tsx`'s `SessionBandsView` unchanged so the universal copy of the
 * conversation (decision 0015) lays out the same page. Pure: what a row says is the caller's.
 */
import { addressSegment, segmentKey } from "@jaira/shared/browser";
import type { ContextReading, InstanceNode } from "@jaira/shared/browser";
import type { RailStep } from "./rail";
import { clockOf, durationOf } from "./runActivityModel";
import { forksOf, pathFrom, placeNotes, placeOf, segmentsFrom, splitAtNotes, startersOf, type BandNote, type SessionBand, type SessionPiece, type SessionSegment } from "./sessionBands";

/**
 * Where one note sits on the rail, and whether it OPENS a lane.
 *
 * Only entering does. The other three all happen inside a state that is already open, and two of them
 * are addressed by a path that is not their own: a transition's path is where it ARRIVES, and the row
 * belongs to the state that took it; a blocked child's path is the child, which never became a state
 * at all — which is the whole content of the note. Both are drawn against their parent.
 */
export function stepOfNote(note: BandNote, root: string): RailStep {
  const at = segmentsFrom(note.path, root);
  const opens = note.kind === "entered";
  // A made task's path is the element's (`work[0]`), and the row belongs to the state that made it:
  // nothing was entered here, so no lane opens, and the line sits against its parent.
  const inside = opens || note.kind === "failure" ? at : at.slice(0, -1);
  return {
    // The instance where there is one: `explore` running twice is two lanes, and a key on the state
    // would fold the second pass into the first. A note that never became an instance cannot collide
    // with anything — nothing else in the run is at its seq.
    key: opens && note.instanceId !== undefined ? `i${note.instanceId}` : `n${note.seq}`,
    // The PATH's last segment first, for the reason the band step above says: a path is child keys
    // (`conversation.ts` builds it from `childKey`), the palette is keyed by child key, and
    // `note.stateId` is the state DEFINITION's id — `feature/product/draft` against a palette
    // holding `draft`. The id is the fallback for a root, which has no key.
    // The KEY, not the segment: a fan-out element's segment is `build[0]`, and the palette — shared
    // with the index — is keyed by `build`. The lane's identity keeps the element (`at`); its name
    // and colour do not.
    stateId: segmentKey(at[at.length - 1] ?? note.stateId?.split("/").pop() ?? ""),
    at: inside,
    opens,
  };
}

/**
 * Whether the whole view is ONE operation — in which case none of the chrome above is earned.
 *
 * The chrome rule (see `transcriptView.tsx`) is that a card marks the boundary between one operation
 * and the next. A view holding a single piece has no next, so its card is a fold, a status dot and a
 * call signature wrapped around the only thing on the page — and it reads as a CHILD of what you are
 * looking at rather than as what you are looking at. Walking into a leaf run and being shown its
 * transcript inside a collapsible box headed with its own name is exactly that misread.
 *
 * Only the piece is dropped, never the sheet: the session name in the gutter is a different fact and
 * still worth having, because a leaf that continued its parent's conversation says so there.
 */
export function isSolo(bands: readonly SessionBand[]): boolean {
  return bands.length === 1 && bands[0]!.segments.length === 1 && bands[0]!.segments[0]!.pieces.length === 1;
}

/** One row of the page: a note between bands, or a band. */
export type PageRow = { kind: "note"; note: BandNote } | { kind: "band"; band: SessionBand };

export interface PageRows {
  /** The bands as drawn — cut where a workflow tool's note took effect (`splitAtNotes`). */
  bands: SessionBand[];
  /** Whether the whole view is one operation — see {@link isSolo}. */
  bare: boolean;
  starters: ReturnType<typeof startersOf>;
  forks: ReturnType<typeof forksOf>;
  /** What the rail reasons about, index-aligned with {@link rows}. */
  steps: RailStep[];
  rows: PageRow[];
  /** Each row's clock, for the two things placed among rows by time: an armed cut, and the origin seam. */
  ats: number[];
  /** The entered note behind each row that is one, by row index and by lane key — what a cut names. */
  noteRows: Map<number, BandNote>;
  laneNotes: Map<string, BandNote>;
}

/**
 * The page as one flat sequence of rows, so the rail can draw the hierarchy beside it.
 *
 * The two lists are built together and stay index-aligned: `steps` is what the rail reasons about
 * (a path, and whether the row enters it) and `rows` is what the row is. They are separate because a
 * rail row is about a STATE and a page row is about anything at all — a panel, a note, a mark — and
 * the rail also inserts rows of its own where a state is left.
 */
export function pageRowsOf(given: readonly SessionBand[], notes: readonly BandNote[], root: string): PageRows {
  // A conversation's band is cut where one of its workflow tools took effect, so the row saying what
  // it did sits right after the call that did it, before the reply. See `splitAtNotes`.
  const bands = splitAtNotes(given, notes);
  const bare = isSolo(bands);
  const placed = placeNotes(notes, bands);
  const starters = startersOf(bands);
  // From the bands as GIVEN: a turn a note cut is two pieces of one position, and counted twice it
  // would read as a fork of itself.
  const forks = forksOf(given.flatMap((band) => band.segments.flatMap((segment) => segment.pieces)));
  const steps: RailStep[] = [];
  const rows: PageRow[] = [];
  const ats: number[] = [];
  const noteRows = new Map<number, BandNote>();
  const laneNotes = new Map<string, BandNote>();
  const add = (step: RailStep, row: PageRow, at: number): void => {
    steps.push(step);
    rows.push(row);
    ats.push(at);
  };
  /** Where a panel's state sits. The address is stamped from the run's root, the same basis a note's
   *  path has, so both are trimmed to the module being read the same way. */
  const atPiece = (piece: SessionPiece): string[] => segmentsFrom((piece.node.address ?? []).map(addressSegment).join("/"), root);
  const addNotes = (list: readonly BandNote[]): void => {
    for (const note of list) {
      const step = stepOfNote(note, root);
      if (note.kind === "entered" || note.kind === "transition") {
        noteRows.set(steps.length, note);
        laneNotes.set(step.key, note);
      }
      add(step, { kind: "note", note }, note.at);
    }
  };
  for (const [i, band] of bands.entries()) {
    addNotes(placed[i]!);
    // A band can hold several conversations at once, and they are laid out ACROSS. Its place on the
    // rail is its first piece's: the row is one row however many panels are in it.
    const lead = band.segments[0]?.pieces[0];
    add(
      {
        key: `b${i}`,
        // The CHILD KEY where there is one, which is what `paletteOfRun` keys its hues by — see
        // `laneColour` in `railView.tsx`.
        stateId: lead === undefined ? "" : (lead.node.childKey ?? lead.node.stateId),
        at: lead === undefined ? [] : atPiece(lead),
        opens: false,
      },
      { kind: "band", band },
      band.startedAt,
    );
  }
  addNotes(placed[bands.length]!);
  return { bands, bare, starters, forks, steps, rows, ats, noteRows, laneNotes };
}

/**
 * What a piece is remembered as when it is folded.
 *
 * Three parts, and each one is load-bearing. The INSTANCE, which names one execution of one state
 * for the task's whole life. The SEQUENCE, because a state that called twice is two pieces. And the
 * SCOPE — the task — because the other two are not enough on their own: this map outlives the
 * selection, and two tasks would otherwise fold each other's pieces under one key.
 *
 * The alternative was a bucket per task, which is what `SHUT` ids are for. It loses to this by one
 * property: a task pruned from the database leaves its keys behind either way, and a single bucket
 * is one entry to forget rather than one per task nobody can enumerate.
 */
export function keyOfPiece(piece: SessionPiece, scope: string): string {
  return `${scope}:${piece.node.instanceId}:${piece.seq ?? ""}`;
}

/**
 * The SESSION's span — when it started, and how long the whole of it took.
 *
 * The envelope of its pieces rather than the sum of them: a session interrupted and resumed spent
 * the gap doing nothing, and reporting the sum would say a conversation took four minutes when it
 * was open for twenty. Which is also why this belongs to the gutter and not to any letterhead — it
 * is a fact about the thread, and no single state in it knows it.
 *
 * A session still open has no duration yet and says only when it began.
 */
export function spanOf(segment: SessionSegment): string {
  const from = Math.min(...segment.pieces.map((piece) => piece.startedAt));
  if (!Number.isFinite(from)) return "";
  const ends = segment.pieces.map((piece) => piece.endedAt);
  const to = ends.some((end) => end === undefined) ? undefined : Math.max(...(ends as number[]));
  const took = to !== undefined && to >= from ? durationOf(to - from) : undefined;
  return [clockOf(from), took].filter((part) => part !== undefined && part.length > 0).join(" · ");
}

/**
 * The clock a header carries, and how long it took.
 *
 * Formatted here rather than in the header because it is arithmetic over a node, and a header should
 * be handed words. A run still going has no duration to state, and says nothing rather than zero.
 */
export function metaOf(node: InstanceNode, now?: number): string {
  // How long it TOOK, or — for a state still going, when the caller is keeping time — how long it has
  // been going. The second reading is what a live run wants from its rail: the moment a state was
  // entered is a fact about the past, and "twenty minutes so far" is the fact about the present. A
  // caller that passes no clock gets the finished reading only, exactly as before.
  const took =
    node.endedAt !== undefined
      ? durationOf(node.endedAt - node.startedAt)
      : now !== undefined && isLiveNode(node)
        ? `${durationOf(Math.max(0, now - node.startedAt))} so far`
        : undefined;
  return [clockOf(node.startedAt), took].filter((part) => part !== undefined && part.length > 0).join(" · ");
}

/** A state that is still going — the same reading the projection's `isLive` makes, minus `superseded`. */
export function isLiveNode(node: InstanceNode): boolean {
  return !node.superseded && (node.status === "running" || node.status === "waiting_for_user" || node.status === "blocked");
}

/**
 * What a FOLDED state's line says instead of its label — see {@link StateHeader}.
 *
 * The one thing available without reading the record: how it ended, and what it cost. A richer
 * summary (the docs it wrote, the severity it exited at) is the operation's OUTPUT, which the
 * projection does not carry per instance yet — so this says the two things it can rather than
 * guessing at the one it cannot.
 */
export function summaryOf(piece: SessionPiece): string | undefined {
  const op = piece.node.operation;
  const parts: string[] = [];
  if (op?.status === "failed") parts.push(op.reason ?? "failed");
  else if (piece.node.status === "canceled") parts.push("canceled");
  // No cost: what a state spent is in its details. The header's number is the CONTEXT it added,
  // on the right before the time, folded or open (usage-readings contract).
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** One row as drawn: a page row by its index, the armed cut's counted line, or the origin seam. */
export type MarkedRow = { kind: "row"; index: number } | { kind: "cut"; states: number } | { kind: "origin" };

/**
 * The page with the two things placed among its rows by the clock — an ARMED rewind's counted line (and
 * which rows it rings and fades) and a forked task's origin seam — moved unchanged out of
 * `sessionPanels.tsx`'s `SessionBandsView`, so the universal copy places them the same way.
 *
 * The entry's own row keeps its words and takes the ring; the counted line goes right under it, and
 * everything after fades — by the clock when the entry is not a row on this page. The seam goes after
 * the last row the copy inherited: the copied rows keep the parent's clocks, the task's own come later.
 */
export function markedRowsOf(
  page: Pick<PageRows, "steps" | "ats" | "noteRows">,
  notes: readonly BandNote[],
  armed: { seq: number; at: number } | undefined,
  origin: { boundaryAt: number } | undefined,
): { steps: RailStep[]; rows: MarkedRow[]; cutRow: number; doomedFrom: number } {
  const steps: RailStep[] = [...page.steps];
  const ats: number[] = [...page.ats];
  const rows: MarkedRow[] = page.steps.map((_, index) => ({ kind: "row", index }));
  let cutRow = -1;
  let doomedFrom = -1;
  if (armed !== undefined) {
    const own = [...page.noteRows].find(([, note]) => note.seq === armed.seq)?.[0];
    const first = own ?? ats.findIndex((at) => at >= armed.at);
    if (first >= 0) {
      const states = notes.filter((note) => note.kind === "entered" && note.at >= armed.at).length;
      const after = own !== undefined ? first + 1 : first;
      const beside = steps[first]!;
      steps.splice(after, 0, { key: `cut${armed.seq}`, stateId: "", at: own !== undefined && beside.opens ? beside.at : beside.opens ? beside.at.slice(0, -1) : beside.at, opens: false });
      rows.splice(after, 0, { kind: "cut", states });
      ats.splice(after, 0, armed.at);
      cutRow = own !== undefined ? first : -1;
      doomedFrom = after + 1;
    }
  }
  if (origin !== undefined) {
    let k = 0;
    while (k < ats.length && ats[k]! <= origin.boundaryAt) k += 1;
    steps.splice(k, 0, { key: "origin", stateId: "", at: [], opens: false });
    rows.splice(k, 0, { kind: "origin" });
    ats.splice(k, 0, origin.boundaryAt);
    if (cutRow >= k) cutRow += 1;
    if (doomedFrom > k) doomedFrom += 1;
  }
  return { steps, rows, cutRow, doomedFrom };
}

/**
 * What one side of a fork is CALLED in a run: how that attempt ended.
 *
 * There is nothing else to call them. A chat's sides are named by the message that opens each, which
 * is the thing that differs there; two attempts of one state say the same thing to the same model
 * and differ only in what came back. Absent status reads as the success it always did, which is the
 * same convention `StateSession.outcome` documents for a journal that predates the distinction.
 */
export function sideName(piece: SessionPiece): string {
  if (piece.status === "error") return "failed";
  if (piece.status === "interrupted") return "stopped";
  // The one that is not a verdict at all: this side has not ended, so naming it after any of the
  // ways a call can finish would be a claim about something that has not happened yet.
  if (piece.status === "running") return "running";
  return "finished";
}

/**
 * Whether this panel is a side of a fork, and which — see {@link forksOf}.
 *
 * At most one piece can be: the sides of one division differ by session and a panel is one session,
 * so the first that matches is the answer.
 */
export function sideOf(
  segment: SessionSegment,
  forks: Map<string, SessionPiece[]> | undefined,
): { place: string; sides: SessionPiece[] } | undefined {
  if (forks === undefined) return undefined;
  for (const piece of segment.pieces) {
    const place = placeOf(piece);
    const sides = place === undefined ? undefined : forks.get(place);
    if (place !== undefined && sides !== undefined) return { place, sides };
  }
  return undefined;
}

/** What a note's state is CALLED in a sentence about it: its path from the module being read, or its id. */
export function cutNameOf(note: BandNote, root: string): string {
  const where = pathFrom(note.path, root);
  return where !== "" ? where : (note.stateId?.split("/").pop() ?? "this state");
}

/**
 * What each state ADDED to the conversation: the reading after its last turn, less the reading the
 * state before it in this session ended on. The first state in a session added everything it holds.
 * A piece with no reading is left out — the header's `+30k` is not drawn for it.
 */
export function addedOf(
  pieces: readonly SessionPiece[],
  readingOf: ((piece: SessionPiece) => ContextReading | undefined) | undefined,
): Map<SessionPiece, number> {
  const added = new Map<SessionPiece, number>();
  if (readingOf !== undefined) {
    let prior: ContextReading | undefined;
    for (const piece of pieces) {
      const reading = readingOf(piece);
      if (reading === undefined) continue;
      added.set(piece, Math.max(0, reading.used - (prior?.used ?? 0)));
      prior = reading;
    }
  }
  return added;
}
