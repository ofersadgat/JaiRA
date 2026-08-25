/**
 * The conversation, drawn as one panel per session — see `sessionBands.ts` for the model.
 *
 * ## A panel is a session, and a page
 *
 * The sheet the transcript is printed on used to wrap the WHOLE conversation, so a run through four
 * sessions was one page with four unmarked changes of subject on it. Here every session gets its own,
 * which is what makes "these turns share a context and those do not" a thing you can see rather than
 * infer from state names.
 *
 * ## The bars mean interruption, not decoration
 *
 * A torn edge along the bottom of a panel says this conversation stops here and comes back later; the
 * same edge along the top of a later panel says this is where it came back. They are always a pair,
 * and between them is whatever ran in the meantime — which is the whole reason the session had to be
 * cut in two rather than printed as one continuous panel out of time order.
 *
 * ## Across is at the same time; down is later
 *
 * A {@link SessionBand} holds sessions whose calls overlapped, so it lays them out ACROSS. Two fit as
 * columns and stay readable; three do not, and fall back to tabs — the toggle in the corner of the
 * band is there for when that guess is wrong, which it will be on a wide window or a narrow one. It
 * appears on hover because it is a control about the drawing rather than part of the record, and a
 * run with eight bands would otherwise carry eight permanent buttons nobody is looking at.
 *
 * ## The grey between the panels is part of the record
 *
 * Two things are drawn on it, and both are there because a panel is a conversation and neither of
 * them happened in one.
 *
 * A {@link BandNote} is a failure in a state that never opened a session — a child blocked before it
 * could run, a composite that gave up because one of its children failed. It goes between the panels
 * at the point in the run where it happened, which is the only place that is both in time order and
 * not inside a conversation that did not have it. This is usually the whole error of a failed run,
 * and until it was drawn here it was on screen nowhere at all.
 *
 * The gutter says which workflow a panel's conversation was OPENED by, beside the session id. The id
 * is a name the engine chose — `default` on most runs — so on its own it tells you which panels share
 * a context and nothing about what any of them is; the state that started it is the other half, and
 * it is a place you can go.
 */
import { Fragment, useState, type JSX, type ReactNode } from "react";
import { Icon } from "./icons";
import { RunCard } from "./transcriptView";
import {
  placeNotes,
  startersOf,
  type BandNote,
  type SessionBand,
  type SessionPiece,
  type SessionSegment,
} from "./sessionBands";

/** How a band with more than one session is arranged. */
export type BandLayout = "columns" | "tabs";

/**
 * Two side by side, three or more tabbed.
 *
 * A guess, and the toggle exists because it is one: two columns of transcript in a normal window are
 * comfortably readable and three are not, but "normal window" is doing work in that sentence.
 */
function defaultLayout(band: SessionBand): BandLayout {
  return band.segments.length <= 2 ? "columns" : "tabs";
}

/** The id the torn edges reference. Defined once per view — see {@link ZigDefs}. */
const ZIG = "jaira-zig";

/**
 * The zigzag itself, as a tiling pattern.
 *
 * Drawn rather than typed. `/\/\/\/\` written as text is the right picture and the wrong mechanism —
 * it cannot fill a panel of unknown width without either wrapping or being cut mid-tooth, and it
 * reads to a screen reader as a run of punctuation. This is one path repeated at 8px, so it fills
 * exactly, and the words in the middle of the bar are the accessible name of the whole thing.
 */
export function ZigDefs(): JSX.Element {
  return (
    <svg width="0" height="0" aria-hidden focusable="false" style={{ position: "absolute" }}>
      <defs>
        <pattern id={ZIG} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 6.5 L4 1.5 L8 6.5" fill="none" stroke="var(--zig)" strokeWidth="1.25" />
        </pattern>
      </defs>
    </svg>
  );
}

function Zig(): JSX.Element {
  return (
    <svg className="sb-zig" aria-hidden focusable="false" preserveAspectRatio="none">
      <rect width="100%" height="100%" fill={`url(#${ZIG})`} />
    </svg>
  );
}

/**
 * A torn edge with a sentence in the middle of it.
 *
 * `paused` tears along the BOTTOM of what is above it and `resumed` along the top of what is below,
 * so the two are always a pair with something in between: the run that interrupted a session here,
 * or — in a conversation — the point where one thread became two.
 *
 * The label is the caller's because the two uses say different things about the same shape. A band
 * names the session, because the halves of a split conversation have to be findable from each other
 * and the id is the only thing they share that every other panel does not. A fork names neither
 * half: both sides are this conversation, and what a reader needs there is which one they are
 * reading.
 */
export function TearBar({ kind, children }: { kind: "paused" | "resumed"; children: ReactNode }): JSX.Element {
  return (
    <div className={`sb-tear sb-tear-${kind}`}>
      <Zig />
      <span className="sb-tear-label">{children}</span>
      <Zig />
    </div>
  );
}

/**
 * One state's operation inside a session's panel.
 *
 * The same card a child run has always been drawn as, opened rather than folded: a panel of collapsed
 * headers is an index, and this is meant to read as a conversation. The fold is still there for a
 * forty-turn agent loop somebody wants out of the way.
 */
function Piece({ piece, render }: { piece: SessionPiece; render: (piece: SessionPiece) => ReactNode }): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <RunCard
      node={piece.node}
      open={open}
      running={piece.node.status === "running"}
      onToggle={() => setOpen((v) => !v)}
    >
      {render(piece)}
    </RunCard>
  );
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
function isSolo(bands: readonly SessionBand[]): boolean {
  return bands.length === 1 && bands[0]!.segments.length === 1 && bands[0]!.segments[0]!.pieces.length === 1;
}

/**
 * One session's panel: its name in the grey above it, then what it said.
 *
 * The name is OUTSIDE the sheet, not a bar across the top of it. A panel is a page, and what a page
 * is called belongs beside it rather than printed on it — a header inside the border made every
 * conversation open with a strip of chrome before its first word, which for a run of one session is
 * a title bar over the only thing on screen.
 *
 * Suppressed in a tabbed band, where the tab the reader just clicked already carries the name and a
 * second copy of it directly underneath says nothing.
 */
function Sheet({
  segment,
  named = true,
  bare = false,
  starter,
  onOpenWorkflow,
  render,
}: {
  segment: SessionSegment;
  /** False when something else already names this session — see the tab row in {@link Band}. */
  named?: boolean;
  /** True when this piece is the whole view and needs no card around it — see {@link isSolo}. */
  bare?: boolean;
  /** The run that opened this conversation — see {@link startersOf}. */
  starter?: SessionPiece | undefined;
  /** Describe that run's workflow beside this. Absent ⇒ no host with a panel to describe it in. */
  onOpenWorkflow?: ((piece: SessionPiece) => void) | undefined;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  return (
    <div className="sb-panel">
      {named ? (
        <div className="sb-gutter">
          {segment.sessionId !== undefined ? (
            <span className="sb-session mono ellip" title={segment.sessionId}>
              {segment.sessionId}
            </span>
          ) : (
            // Not a failure and not a blank: a function op runs in no conversation, and so does a
            // call that has not settled yet. Both are things that happened.
            <span className="sb-session sb-none">no conversation</span>
          )}
          {/* WHICH workflow this conversation belongs to, and a way to go read it. A session id is a
              name the engine chose — `default` on most runs — so on its own the gutter says which
              panels share a context and nothing about what any of them is. The state that opened it
              is the missing half, and it is a place: clicking it describes that workflow with this
              run's own values against it. */}
          {starter !== undefined && onOpenWorkflow !== undefined ? (
            <button
              type="button"
              className="link sb-workflow ellip"
              title={`${starter.node.stateId} — describe this run of it`}
              onClick={() => onOpenWorkflow(starter)}
            >
              {starter.node.stateId}
            </button>
          ) : null}
        </div>
      ) : null}
      <section className={`sb-sheet${segment.resumed ? " resumed" : ""}${segment.paused ? " paused" : ""}`}>
        {segment.resumed && segment.sessionId !== undefined ? (
          <TearBar kind="resumed">
            resumed session <span className="mono">{segment.sessionId}</span>
          </TearBar>
        ) : null}
        <div className="sb-body">
          {segment.pieces.map((piece) =>
            bare ? (
              <div key={`${piece.node.instanceId}:${piece.seq ?? "—"}`} className="sb-bare">
                {render(piece)}
              </div>
            ) : (
              <Piece key={`${piece.node.instanceId}:${piece.seq ?? "—"}`} piece={piece} render={render} />
            ),
          )}
        </div>
        {segment.paused && segment.sessionId !== undefined ? (
          <TearBar kind="paused">
            paused session <span className="mono">{segment.sessionId}</span>
          </TearBar>
        ) : null}
      </section>
    </div>
  );
}

/** What a tab is called. The session id, or the state that ran in no conversation at all. */
function tabNameOf(segment: SessionSegment): string {
  return segment.sessionId ?? (segment.pieces[0]?.node.childKey ?? segment.pieces[0]?.node.stateId ?? segment.key);
}

/**
 * One slice of wall clock.
 *
 * A single session is drawn with no band chrome whatsoever — the overwhelming majority of runs are
 * one conversation from start to finish, and a layout toggle over a thing that has one arrangement is
 * a control that can only be wrong.
 */
function Band({
  band,
  bare = false,
  starters,
  onOpenWorkflow,
  render,
}: {
  band: SessionBand;
  /** Passed through to the sheet — see {@link isSolo}. Only ever true for a one-segment band. */
  bare?: boolean;
  /** Who opened each session in the run, by segment key — see {@link startersOf}. */
  starters: Map<string, SessionPiece>;
  onOpenWorkflow?: ((piece: SessionPiece) => void) | undefined;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  const [layout, setLayout] = useState<BandLayout | null>(null);
  const [tab, setTab] = useState(0);
  const chosen = layout ?? defaultLayout(band);
  const solo = band.segments.length === 1;

  if (solo) {
    return (
      <div className="sb-band">
        <Sheet
          segment={band.segments[0]!}
          bare={bare}
          starter={starters.get(band.segments[0]!.key)}
          {...(onOpenWorkflow !== undefined ? { onOpenWorkflow } : {})}
          render={render}
        />
      </div>
    );
  }

  const shown = Math.min(tab, band.segments.length - 1);
  return (
    <div className={`sb-band concurrent ${chosen}`}>
      {/* Out of the flow, in the corner of the band's own grey. In the flow it would need a row of
          its own above panels that already have their names there, and that row would be empty
          whenever nobody was pointing at it. */}
      <div className="sb-layout">
        <button
          type="button"
          className={chosen === "columns" ? "on" : undefined}
          aria-pressed={chosen === "columns"}
          title="Side by side"
          onClick={() => setLayout("columns")}
        >
          <Icon name="columns" />
        </button>
        <button
          type="button"
          className={chosen === "tabs" ? "on" : undefined}
          aria-pressed={chosen === "tabs"}
          title="Tabbed"
          onClick={() => setLayout("tabs")}
        >
          <Icon name="tabs" />
        </button>
      </div>
      {chosen === "tabs" ? (
        <>
          <div className="sb-tabs" role="tablist">
            {band.segments.map((segment, i) => (
              <button
                key={segment.key}
                type="button"
                role="tab"
                aria-selected={i === shown}
                className={i === shown ? "on" : undefined}
                onClick={() => setTab(i)}
              >
                <span className="ellip">{tabNameOf(segment)}</span>
              </button>
            ))}
          </div>
          <Sheet segment={band.segments[shown]!} named={false} render={render} />
        </>
      ) : (
        <div className="sb-columns">
          {band.segments.map((segment) => (
            <Sheet
              key={segment.key}
              segment={segment}
              starter={starters.get(segment.key)}
              {...(onOpenWorkflow !== undefined ? { onOpenWorkflow } : {})}
              render={render}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One failure, on the grey between the panels.
 *
 * Deliberately not a sheet and not a card. A panel is a conversation, and this is the opposite of
 * one — the state it names never spoke, which is why it is here rather than inside something. So it
 * is drawn as an annotation on the background the panels sit on: the same place a note would be
 * written in the margin of a printed transcript, at the point in the stack where it happened.
 */
function NoteRow({ note }: { note: BandNote }): JSX.Element {
  return (
    <div className="sb-note" role="note">
      <Icon name="alert" className="sb-note-icon" />
      {note.stateId !== undefined ? (
        <span className="sb-note-state mono ellip" title={note.stateId}>
          {note.stateId.split("/").pop()}
        </span>
      ) : null}
      <span className="sb-note-text">{note.text}</span>
    </div>
  );
}

/** The notes standing at one point in the stack, or nothing at all. */
function Notes({ notes }: { notes: readonly BandNote[] }): JSX.Element | null {
  if (notes.length === 0) return null;
  return (
    <div className="sb-notes">
      {notes.map((note) => (
        <NoteRow key={`${note.seq}:${note.stateId ?? ""}`} note={note} />
      ))}
    </div>
  );
}

/** The whole conversation: bands down the page, in the order they happened. */
export function SessionBandsView({
  bands,
  render,
  notes = [],
  onOpenWorkflow,
  empty,
}: {
  bands: readonly SessionBand[];
  render: (piece: SessionPiece) => ReactNode;
  /** Failures with no panel to appear in — see {@link BandNote} and {@link NoteRow}. */
  notes?: readonly BandNote[];
  /** Describe the workflow a panel's conversation was opened by — see the gutter in {@link Sheet}. */
  onOpenWorkflow?: ((piece: SessionPiece) => void) | undefined;
  empty?: string;
}): JSX.Element {
  // Notes even with no bands, and that is the case worth having: a run whose first child was blocked
  // never opened a conversation at all, so "this run has not said anything yet" was the whole screen
  // — a true sentence standing where the reason belonged.
  if (bands.length === 0 && notes.length === 0) return <p className="empty">{empty ?? "This run has not said anything yet."}</p>;
  const bare = isSolo(bands);
  const placed = placeNotes(notes, bands);
  const starters = startersOf(bands);
  return (
    <div className="sb">
      <ZigDefs />
      {bands.map((band, i) => (
        <Fragment key={`${band.startedAt}:${i}`}>
          <Notes notes={placed[i]!} />
          <Band
            band={band}
            bare={bare}
            starters={starters}
            {...(onOpenWorkflow !== undefined ? { onOpenWorkflow } : {})}
            render={render}
          />
        </Fragment>
      ))}
      <Notes notes={placed[bands.length]!} />
    </div>
  );
}
