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
import { Fragment, useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import { ContextMenu, MENU_WIDTH, type MenuAnchor } from "./menu";
import { clockOf, durationOf } from "./transcriptView";
import { signatureOf } from "./transcript";
import type { InstanceNode } from "@jaira/shared/browser";
import { StateBlock, StateHeader, headerToneOf, surfaceKindOf } from "./stateSurface";
import {
  forksOf,
  pathFrom,
  placeNotes,
  placeOf,
  placeRunForks,
  runForkAt,
  segmentsFrom,
  startersOf,
  type BandNote,
  type RunFork,
  type SessionBand,
  type SessionPiece,
  type SessionSegment,
} from "./sessionBands";
import { RailedRows } from "./railView";
import type { RailStep } from "./rail";

/** Nothing folded — the default for a host that does not remember folds. Frozen, so it cannot be
 *  mutated into one host's state by another. */
const EMPTY_SHUT: ReadonlySet<string> = new Set();

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
 *
 * ⚠️ The stroke is a STYLESHEET rule (`#jaira-zig path`), not a property inherited from whatever
 * references the pattern. It was the latter, and the teeth had never once been drawn: a paint server
 * resolves custom properties against its own position in the tree, and this `<defs>` sits outside
 * every element that set `--zig` — so the stroke was an unresolved variable, which is to say none.
 * The tint the rule uses is a mix of `--accent` and `--line`, both of which are on `:root` and so
 * resolve wherever the pattern happens to live.
 */
export function ZigDefs(): JSX.Element {
  return (
    <svg width="0" height="0" aria-hidden focusable="false" style={{ position: "absolute" }}>
      <defs>
        <pattern id={ZIG} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 6.5 L4 1.5 L8 6.5" fill="none" strokeWidth="1.25" />
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

/** One side of a fork, as {@link ForkMark} draws it. Named by the caller — see the note there. */
export interface ForkSide {
  /** Opaque here; handed back to `onShow`. */
  key: string;
  /** What this side is CALLED. */
  label: string;
  /** What tells it apart from the others, in the menu: how it ended, and where it lives. */
  note?: string;
}

/**
 * One place a conversation divided — the division and the choice at once.
 *
 * A torn edge, and a chip in the middle of it reading `fork: n of m — side`. That is the whole mark
 * at every scale: no wash, no rules, no second tooth size. Between turns inside a sheet and between
 * panels on the grey it is the same drawing, and what tells the two apart is where it sits and what
 * the label names — an attempt in a conversation, a run on the grey.
 *
 * ## Why the count comes before the name
 *
 * `2 of 2` answers "is there something I am not seeing" before you have read the name of anything,
 * and that question is the entire reason the mark exists: an edited or retried conversation simply
 * came back shorter, which is indistinguishable on screen from having lost the turns. `fork:` leads
 * because it is the only word that is the same on every mark at every scale — the one the eye can
 * learn — and everything after it is particular to this one.
 *
 * ## Nothing here says what is SHARED
 *
 * Deliberately. Everything above a mark is common to both its sides — that is what the mark IS — so
 * a panel announcing "carried over" or "replayed" would be saying the same thing again, in words,
 * and would be one more claim that has to be kept true. The position is the whole statement.
 *
 * ## Quiet at rest
 *
 * The chip takes its box on hover, focus and open, and is a line of text before that. Same posture
 * as the message rail (`.ts-rail`), and the same reason: a transcript at rest is the words, and a
 * fork has no more right to permanent chrome than a copy button does. It is what lets every branched
 * panel carry a mark without the view acquiring furniture.
 *
 * `torn: false` is the placement with nothing to tear — a branch that is its own panel, where the
 * chip sits in the gutter beside the session id and no conversation was cut in two.
 */
export function ForkMark({
  sides,
  shown,
  onShow,
  note,
  torn = true,
}: {
  /** Every side, oldest first — attempt 1, then 2, then 3. */
  sides: readonly ForkSide[];
  shown: string;
  onShow: (key: string) => void;
  /** The sentence the label has no room for: where it divided, and why. Shown over the menu. */
  note?: string;
  torn?: boolean;
}): JSX.Element | null {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const at = Math.max(
    0,
    sides.findIndex((side) => side.key === shown),
  );
  const side = sides[at];
  // A fork with one side is not a fork. Nothing to say and nothing to choose between.
  if (side === undefined || sides.length < 2) return null;
  return (
    <div className={`fork-mark${torn ? " fork-torn" : ""}`}>
      {torn ? <Zig /> : null}
      <button
        type="button"
        className="fork-chip"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={note ?? "the other sides of this fork"}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({
            // Centred under the chip rather than left-aligned to it: the chip is itself centred in
            // the tear, and a menu hanging off one end of a centred control points at nothing.
            x: Math.max(0, box.left + box.width / 2 - MENU_WIDTH / 2),
            y: box.bottom + 3,
            ...(note !== undefined ? { title: note } : {}),
            items: sides.map((one) => ({
              label: one.label,
              ...(one.note !== undefined ? { note: one.note } : {}),
              checked: one.key === shown,
              onSelect: () => onShow(one.key),
            })),
          });
        }}
      >
        <Icon name="choice" />
        <span className="fork-kind">fork:</span>
        <span className="fork-side ellip">
          {at + 1} of {sides.length} — {side.label}
        </span>
        <Icon name="chevron" />
      </button>
      {torn ? <Zig /> : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/**
 * What one side of a fork is CALLED in a run: how that attempt ended.
 *
 * There is nothing else to call them. A chat's sides are named by the message that opens each, which
 * is the thing that differs there; two attempts of one state say the same thing to the same model
 * and differ only in what came back. Absent status reads as the success it always did, which is the
 * same convention `StateSession.outcome` documents for a journal that predates the distinction.
 */
function sideName(piece: SessionPiece): string {
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
function sideOf(
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

/**
 * What a piece is remembered as when it is folded.
 *
 * Three parts, and each one is load-bearing. The RUN, because an instance id is minted per run and
 * so `#i2` names a different state in every one of them. The SEQUENCE, because a state that called
 * twice is two pieces. And the SCOPE — the task — because the other two are not enough: a folded
 * tree stamps `runId` on every node, but a single-run projection leaves it absent, and two tasks
 * would then both remember a state as `:2:0` and fold each other's.
 *
 * The alternative was a bucket per task, which is what `SHUT` ids are for. It loses to this by one
 * property: a task pruned from the database leaves its keys behind either way, and a single bucket
 * is one entry to forget rather than one per task nobody can enumerate.
 */
function keyOfPiece(piece: SessionPiece, scope: string): string {
  return `${scope}:${piece.node.runId ?? ""}:${piece.node.instanceId}:${piece.seq ?? ""}`;
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
function spanOf(segment: SessionSegment): string {
  const from = Math.min(...segment.pieces.map((piece) => piece.startedAt));
  if (!Number.isFinite(from)) return "";
  const ends = segment.pieces.map((piece) => piece.endedAt);
  const to = ends.some((end) => end === undefined) ? undefined : Math.max(...(ends as number[]));
  const took = to !== undefined && to >= from ? durationOf(to - from) : undefined;
  return [clockOf(from), took].filter((part) => part !== undefined && part.length > 0).join(" · ");
}

/**
 * One state inside a session's panel — its letterhead, and its transcript under it.
 *
 * Opened rather than folded, always, and that is deliberate: a sheet of collapsed headers is an
 * index, and the first thing somebody opening a run wants is what it said. The fold is a thing you
 * DO — to a forty-turn agent loop you are scrolling past, or to a whole session at once from the
 * gutter above.
 */
function Piece({
  piece,
  open,
  onToggle,
  render,
}: {
  piece: SessionPiece;
  open: boolean;
  onToggle: () => void;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  const node = piece.node;
  const kind = surfaceKindOf(node);
  const sig = signatureOf(node);
  const tone = headerToneOf(node, kind);
  return (
    <StateBlock
      open={open}
      // What the Instances index sends a reader to — see `keyOfNode` in `runIndex.tsx`.
      instance={`${node.runId ?? ""}:${node.instanceId}`}
      header={
        <StateHeader
          open={open}
          {...(kind !== undefined ? { kind } : {})}
          {...(tone !== undefined ? { tone } : {})}
          name={sig.name}
          {...(sig.label !== undefined ? { label: sig.label } : {})}
          {...(summaryOf(piece) !== undefined ? { summary: summaryOf(piece)! } : {})}
          {...(metaOf(node) !== "" ? { meta: metaOf(node) } : {})}
          {...(kind === "conversation" ? { status: node.status } : {})}
          onToggle={onToggle}
        />
      }
    >
      {render(piece)}
    </StateBlock>
  );
}

/**
 * The clock a header carries, and how long it took.
 *
 * Formatted here rather than in the header because it is arithmetic over a node, and a header should
 * be handed words. A run still going has no duration to state, and says nothing rather than zero.
 */
export function metaOf(node: InstanceNode): string {
  const took = node.endedAt !== undefined ? durationOf(node.endedAt - node.startedAt) : undefined;
  return [clockOf(node.startedAt), took].filter((part) => part !== undefined && part.length > 0).join(" · ");
}

/**
 * What a FOLDED state's line says instead of its label — see {@link StateHeader}.
 *
 * The one thing available without reading the record: how it ended, and what it cost. A richer
 * summary (the docs it wrote, the severity it exited at) is the operation's OUTPUT, which the
 * projection does not carry per instance yet — so this says the two things it can rather than
 * guessing at the one it cannot.
 */
function summaryOf(piece: SessionPiece): string | undefined {
  const op = piece.node.operation;
  const parts: string[] = [];
  if (op?.status === "failed") parts.push(op.reason ?? "failed");
  else if (piece.node.status === "canceled") parts.push("canceled");
  if (op?.costUsd !== undefined) parts.push(`$${op.costUsd.toFixed(2)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
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
  forks,
  runForks,
  onGoTo,
  onGoToRun,
  onOpenWorkflow,
  shut,
  onToggle,
  onSetShut,
  scope,
  render,
}: {
  segment: SessionSegment;
  /** What folds are remembered UNDER — see {@link keyOfPiece}. */
  scope: string;
  /** Folded states, by the key {@link keyOfPiece} gives them. */
  shut: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Fold or unfold several at once — one write, not one per state. */
  onSetShut: (keys: readonly string[], shut: boolean) => void;
  /** False when something else already names this session — see the tab row in {@link Band}. */
  named?: boolean;
  /** True when this piece is the whole view and needs no card around it — see {@link isSolo}. */
  bare?: boolean;
  /** The run that opened this conversation — see {@link startersOf}. */
  starter?: SessionPiece | undefined;
  /** Every fork in the run, by position — see {@link forksOf}. */
  forks?: Map<string, SessionPiece[]> | undefined;
  /** Run-scale forks by the piece they open, for one that divides this panel — see {@link runForkAt}. */
  runForks?: Map<SessionPiece, RunFork> | undefined;
  /** Go and read another RUN's side of a divergence. */
  onGoToRun?: ((runId: number) => void) | undefined;
  /** Go and read another side of a fork. Absent ⇒ no host that can scroll to one. */
  onGoTo?: ((place: string) => void) | undefined;
  /** Describe that run's workflow beside this. Absent ⇒ no host with a panel to describe it in. */
  onOpenWorkflow?: ((piece: SessionPiece) => void) | undefined;
  render: (piece: SessionPiece) => ReactNode;
}): JSX.Element {
  // At most one piece of a panel is a side of a fork: the sides of one division differ by session,
  // and a panel is one session. So the panel can be stamped with it and found from anywhere.
  const side = sideOf(segment, forks);

  /**
   * Which states in this sheet are folded — REMEMBERED, not held here.
   *
   * A fold is a statement about what you are done reading, and navigating away is not a retraction
   * of it. `JairaUiState.shut` already stores exactly this shape (see `SHUT.runStates`), so the set
   * arrives as a prop and the sheet only decides what to do with it. Empty is the opening position:
   * everything expanded, always — the first thing somebody opening a run wants is what it said, and
   * folding is a thing you do.
   */
  const keys = segment.pieces.map((piece) => keyOfPiece(piece, scope));
  const allShut = keys.length > 0 && keys.every((key) => shut.has(key));
  // One control, one meaning: fold what is in this session. On a solo sheet there are no letterheads
  // to fold, so the same gesture folds the sheet itself and leaves the gutter line standing alone.
  const toggleAll = (): void => onSetShut(keys, !allShut);
  const onGutterKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleAll();
  };

  /**
   * ONE STATE MEANS NO LETTERHEAD — and the gutter takes over its job entirely.
   *
   * The gutter above already names the session and the state that opened it, and it now carries the
   * session's own span as well; with one state inside, that span IS that state's timing. So a
   * letterhead under it would be the same three facts a second time, and dropping it is two lines
   * collapsing into one rather than anything going missing.
   *
   * This is `isSolo`'s rule moved from the VIEW down to the SHEET. It used to ask "is this whole
   * view one piece", which made it a special case for walking into a leaf; asked per sheet it is
   * simply what a one-state session looks like, everywhere.
   *
   * The EXCEPTION is a surface. A computation, a question and a wait each sit alone on a
   * session-less sheet by construction, so read literally this would strip the heading off exactly
   * the states the heading exists for. The principle underneath is not "one state", it is "the
   * gutter is already saying this" — and a surface has no session to be named or timed by.
   */
  const only = segment.pieces.length === 1 ? segment.pieces[0] : undefined;
  const solo = only !== undefined && surfaceKindOf(only.node) === "conversation";
  /**
   * A SURFACE has no gutter at all — it is the other half of the rule above.
   *
   * The gutter's three facts are all about a conversation: which session this is, which state opened
   * it, and how long the whole of it took. A computation, a question and a wait have none of them,
   * and drawn anyway the row said "no conversation" directly above a letterhead already reading
   * `computed`, then repeated the state's own timing as if it were a session's. So the letterhead is
   * the only header, which is what makes it the exception to "one state means no letterhead": there
   * is nothing above it saying the same thing.
   */
  const surface = only !== undefined && segment.sessionId === undefined && surfaceKindOf(only.node) !== "conversation";

  return (
    <div
      className="sb-panel"
      {...(side !== undefined ? { "data-fork-place": side.place } : {})}
      {...(segment.pieces[0]?.node.runId !== undefined ? { "data-run": segment.pieces[0].node.runId } : {})}
    >
      {named && !surface ? (
        <div
          className={`sb-gutter${solo ? " solo" : ""}`}
          {...(solo ? { role: "button", tabIndex: 0, onClick: toggleAll, onKeyDown: onGutterKey } : {})}
        >
          {/* A solo sheet's gutter IS its letterhead, so it opens with the same chevron. With more
              than one state the fold lives on each letterhead, and the gutter's control folds the
              lot — see the button at the end of the row. */}
          {solo ? (
            <span className={`sb-gut-chev${allShut ? "" : " open"}`}>
              <Icon name="chevron" />
            </span>
          ) : null}
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
          {/* The third fact of the same kind as the two beside it. The id says which conversation
              this is and the state says what opened it; this says where the conversation CAME FROM,
              which until it was drawn was the one thing on the panel a reader could not recover. */}
          {side !== undefined && onGoTo !== undefined ? (
            <ForkMark
              torn={false}
              sides={side.sides.map((one) => ({
                key: placeOf(one)!,
                label: sideName(one),
                ...(one.sessionId !== undefined ? { note: one.sessionId } : {}),
              }))}
              shown={side.place}
              onShow={onGoTo}
              note="the position was already taken, so every attempt after the first branched"
            />
          ) : null}
          {/* The session's own span, not any one state's. With several states it is their envelope;
              with one it is that state's timing, which is what lets the letterhead go. */}
          {spanOf(segment) !== "" ? <span className="sb-span">{spanOf(segment)}</span> : null}
          {/* An icon that grows its word on hover rather than carrying one permanently or waiting on
              a tooltip. Absent on a solo sheet: there are no letterheads to fold, and the gutter's
              own chevron is already the control. */}
          {solo ? null : (
            <button
              type="button"
              className="sb-foldall"
              aria-label={allShut ? "Expand all" : "Collapse all"}
              onClick={toggleAll}
            >
              <Icon name={allShut ? "unfold" : "fold"} />
              <span className="sb-foldall-label">{allShut ? "expand all" : "collapse all"}</span>
            </button>
          )}
        </div>
      ) : null}
      <section className={`sb-sheet${segment.resumed ? " resumed" : ""}${segment.paused ? " paused" : ""}`}>
        {segment.resumed && segment.sessionId !== undefined ? (
          <TearBar kind="resumed">
            resumed session <span className="mono">{segment.sessionId}</span>
          </TearBar>
        ) : null}
        <div className="sb-body">
          {segment.pieces.map((piece, i) => {
            const key = `${piece.node.instanceId}:${piece.seq ?? "—"}`;
            // A run-scale fork that divides this conversation PART-WAY down is drawn here, between
            // the card that is shared and the card that is not. The gap above the sheet is the right
            // place only when the divided work opens it — otherwise the mark would sit above an
            // operation both sides share, which is the one thing it must never say.
            const divides = i > 0 ? runForks?.get(piece) : undefined;
            return (
              <Fragment key={key}>
                {divides !== undefined && onGoToRun !== undefined ? (
                  <RunForkMark fork={divides} onGoToRun={onGoToRun} inSheet />
                ) : null}
                {solo ? (
                  // Stamped like a letterhead even though there is none: a solo sheet still holds a
                  // state, and a bookmark to it has to land somewhere. Without this the one panel a
                  // reader is most likely to jump to — a leaf run, which is the whole view — was the
                  // one the index could not reach.
                  allShut ? null : (
                    <div className="sb-bare" data-instance={`${piece.node.runId ?? ""}:${piece.node.instanceId}`}>
                      {render(piece)}
                    </div>
                  )
                ) : (
                  <Piece
                    piece={piece}
                    open={!shut.has(keyOfPiece(piece, scope))}
                    onToggle={() => onToggle(keyOfPiece(piece, scope))}
                    render={render}
                  />
                )}
              </Fragment>
            );
          })}
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
  forks,
  runForks,
  onGoTo,
  onGoToRun,
  onOpenWorkflow,
  shut,
  onToggle,
  onSetShut,
  scope,
  render,
}: {
  band: SessionBand;
  scope: string;
  shut: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSetShut: (keys: readonly string[], shut: boolean) => void;
  /** Passed through to the sheet — see {@link isSolo}. Only ever true for a one-segment band. */
  bare?: boolean;
  /** Who opened each session in the run, by segment key — see {@link startersOf}. */
  starters: Map<string, SessionPiece>;
  /** Every fork in the run, by position — see {@link forksOf}. */
  forks: Map<string, SessionPiece[]>;
  /** Run-scale forks by the piece they open — see {@link runForkAt}. */
  runForks: Map<SessionPiece, RunFork>;
  onGoTo: (place: string) => void;
  onGoToRun: (runId: number) => void;
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
          forks={forks}
          runForks={runForks}
          onGoTo={onGoTo}
          onGoToRun={onGoToRun}
          {...(onOpenWorkflow !== undefined ? { onOpenWorkflow } : {})}
          shut={shut}
          onToggle={onToggle}
          onSetShut={onSetShut}
          scope={scope}
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
          <Sheet
            segment={band.segments[shown]!}
            named={false}
            forks={forks}
            runForks={runForks}
            onGoTo={onGoTo}
            onGoToRun={onGoToRun}
            shut={shut}
            onToggle={onToggle}
            onSetShut={onSetShut}
            scope={scope}
            render={render}
          />
        </>
      ) : (
        <div className="sb-columns">
          {band.segments.map((segment) => (
            <Sheet
              key={segment.key}
              segment={segment}
              starter={starters.get(segment.key)}
              forks={forks}
              runForks={runForks}
              onGoTo={onGoTo}
              onGoToRun={onGoToRun}
              {...(onOpenWorkflow !== undefined ? { onOpenWorkflow } : {})}
              shut={shut}
              onToggle={onToggle}
              onSetShut={onSetShut}
              scope={scope}
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
function NoteRow({ note, root }: { note: BandNote; root: string }): JSX.Element {
  // Moving is not going wrong: a forking-path glyph and the ordinary text colour, against the alert
  // and `--bad` a failure gets. Same shape and same column either way, because they are the same KIND
  // of thing — a fact about a state, written where the state has no page of its own — and reading a
  // run means reading them interleaved, in the order they happened.
  const moved = note.kind === "entered" || note.kind === "transition";
  const where = pathFrom(note.path, root);
  return (
    <div className={moved ? "sb-note step" : "sb-note"} role="note">
      <Icon name={moved ? "choice" : "alert"} className="sb-note-icon" />
      {/* What HAPPENED, then where. A block is the negative of entering and says so in the same
          words — "could not enter product → explore" — rather than leaving a reason to stand on its
          own beside a name and leaving the reader to work out that the state never ran. */}
      {VERB[note.kind] === "" ? null : <span className="sb-note-verb">{VERB[note.kind]}</span>}
      {/* The ROOT has no path to draw — you are looking at it — so its own row is the sentence
          alone rather than a sentence with a blank column in front of it. */}
      {where === "" ? null : (
        <span className="sb-note-state mono ellip" title={note.stateId ?? where}>
          {where}
        </span>
      )}
      {note.kind === "entered" || note.text.length === 0 ? null : (
        <span className="sb-note-text">{note.kind === "blocked" ? `: ${note.text}` : note.text}</span>
      )}
    </div>
  );
}

/** What each kind of note says it is. The row reads as a sentence, so this is its verb. */
const VERB: Record<BandNote["kind"], string> = {
  entered: "entered",
  transition: "entered",
  blocked: "could not enter",
  failure: "",
};

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
  const inside = opens || note.kind === "failure" ? at : at.slice(0, -1);
  return {
    // The instance where there is one: `explore` running twice is two lanes, and a key on the state
    // would fold the second pass into the first. A note that never became an instance cannot collide
    // with anything — nothing else in the run is at its seq.
    key: opens && note.instanceId !== undefined ? `i${note.instanceId}` : `n${note.seq}`,
    stateId: note.stateId ?? at[at.length - 1] ?? "",
    at: inside,
    opens,
  };
}

/**
 * Where the TASK divided, drawn on the grey between the panels.
 *
 * The same mark as the one inside a sheet and the one in a gutter — teeth and a chip — because it is
 * the same fact at a third scale. All that differs is what the label names: a RUN, because a run is
 * what a reader is choosing between here.
 *
 * Everything above it is shared by every side. A resumed run replays what an earlier one answered
 * and dispatches from here on, and where "here" is comes off the run's own row (`RunView.forkedAt`)
 * rather than being inferred from the shape of what it left behind — replay leaves no record, and
 * the one trace it does leave is indistinguishable from a function op.
 *
 * NOTHING SAYS WHAT IS SHARED, deliberately. The mark's position is the whole statement, and a panel
 * that also announced "carried over" would be repeating it in words that then have to be kept true.
 *
 * The sides are all already on the page — `piecesOf` draws every run's work, including a call the
 * fold's latest-wins merge dropped — so choosing one takes you to it rather than swapping it in.
 */
function RunForkMark({
  fork,
  onGoToRun,
  inSheet = false,
}: {
  fork: RunFork;
  onGoToRun: (runId: number) => void;
  /** Between two cards of one panel rather than between panels — same mark, no measure of its own. */
  inSheet?: boolean;
}): JSX.Element {
  const newest = fork.sides[fork.sides.length - 1];
  return (
    <div className={inSheet ? undefined : "sb-notes"}>
      <ForkMark
        sides={fork.sides.map((side) => ({
          key: String(side.runId),
          label: `run ${side.runId}`,
          note: sideName(side.piece),
        }))}
        shown={String(newest?.runId ?? "")}
        onShow={(key) => onGoToRun(Number(key))}
        note={
          fork.at.length === 0
            ? "these runs share nothing — each one started from the top"
            : `the task divided at ${fork.at.map((step) => step.childKey).join(" / ")}`
        }
      />
    </div>
  );
}

/** The whole conversation: bands down the page, in the order they happened. */
export function SessionBandsView({
  bands,
  render,
  notes = [],
  root = "",
  onOpenWorkflow,
  runForks = [],
  shut = EMPTY_SHUT,
  onToggle = () => undefined,
  onSetShut = () => undefined,
  scope = "",
  focus,
  palette,
  empty,
}: {
  bands: readonly SessionBand[];
  render: (piece: SessionPiece) => ReactNode;
  /**
   * Folded states, and the two ways to change that — see `SHUT.runStates`.
   *
   * Defaulted, so a host that does not remember folds still renders: every state opens, and folding
   * one does nothing rather than throwing. That is the honest degradation for a surface with no
   * settings behind it, and it is what the tests render against.
   */
  shut?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  onSetShut?: (keys: readonly string[], shut: boolean) => void;
  /** The task these folds belong to — see {@link keyOfPiece}. Empty is fine for a host with no
   *  memory: nothing is remembered, so nothing can collide. */
  scope?: string;
  /** Failures and transitions with no panel to appear in — see {@link BandNote} and {@link NoteRow}. */
  notes?: readonly BandNote[];
  /** The MOUNT PATH this page is read from — what a note's path is shown relative to. Root is `""`. */
  root?: string;
  /** Describe the workflow a panel's conversation was opened by — see the gutter in {@link Sheet}. */
  onOpenWorkflow?: ((piece: SessionPiece) => void) | undefined;
  /** Every place the TASK divided — see {@link runForksOf}. A run that never forked has none. */
  runForks?: readonly RunFork[];
  /**
   * A state to go to, asked for from outside this column — the Instances index's bookmark.
   *
   * `instance` is `runId:instanceId`; `at` is a stamp that changes on every ask, so pressing the
   * same bookmark twice moves the page twice.
   */
  focus?: { instance: string; at: number } | undefined;
  /**
   * The run's colours, when the host has them — see `paletteOfRun`.
   *
   * A hue is a POSITION in the order states first appear, so a palette derived from the rows on
   * screen is a palette about those rows. This view's rows are BANDS and the task panel's index is
   * one row per state: two different lists, two different orders, and the same state coming out a
   * different colour in each. Both are drawing one run, so both read one list.
   */
  palette?: ReadonlyMap<string, string> | undefined;
  empty?: string;
}): JSX.Element {
  /**
   * The column the panels are in, so one panel can send you to another.
   *
   * A fork's sides are all already drawn here — a retried state is two operations and therefore two
   * panels — so the mark's job in this view is not to swap one for another but to take you to the
   * one you picked. The lookup is by attribute rather than by a map of refs because the target is
   * addressed by POSITION (`data-fork-place`), which is the same key the fork map uses and the only
   * thing a side knows about its siblings.
   */
  const sheets = useRef<HTMLDivElement | null>(null);
  const goTo = useCallback((place: string): void => {
    const found = sheets.current?.querySelector(`[data-fork-place="${place}"]`);
    if (!(found instanceof HTMLElement)) return;
    found.scrollIntoView({ block: "center", behavior: "smooth" });
    // Lit briefly, because the sides of a fork look alike by construction: they are the same state,
    // usually saying nearly the same thing, and arriving at one with no confirmation of which is
    // indistinguishable from not having moved.
    found.classList.add("sb-panel-lit");
    window.setTimeout(() => found.classList.remove("sb-panel-lit"), 1200);
  }, []);

  /** The same jump one scale up: the first panel the chosen RUN produced. */
  const goToRun = useCallback((runId: number): void => {
    const found = sheets.current?.querySelector(`[data-run="${runId}"]`);
    if (!(found instanceof HTMLElement)) return;
    found.scrollIntoView({ block: "center", behavior: "smooth" });
    found.classList.add("sb-panel-lit");
    window.setTimeout(() => found.classList.remove("sb-panel-lit"), 1200);
  }, []);

  /** The `focus.at` of the last ask this column actually served — see the effect below. */
  const served = useRef<number | undefined>(undefined);
  /**
   * A bookmark landing: go to one state's letterhead, from outside this column.
   *
   * `focus.at` is a stamp rather than a flag, and it has to be: asking for the same state twice is a
   * real request — you scrolled away and pressed it again — and a prop that only carried the id
   * would look unchanged and do nothing the second time.
   *
   * ⚠️ THE PANEL IS NOT THERE YET when the ask arrives, and that is the ordinary case rather than
   * the edge one. A bookmark pressed in the task panel's Details reading mounts this column for the
   * first time, and its transcripts are FETCHED — so at the moment the ask lands, `bands` is empty
   * and there is nothing in the document to scroll to. Running once and giving up silently is a
   * bookmark that never works. So the ask is retried as the conversation fills in, and `served`
   * records the stamp of the one that found its target, which is what stops it re-scrolling the
   * reader every time another transcript arrives.
   *
   * The header rather than the sheet, because a sheet holds several states and the ask is for one of
   * them. The flash is the same one a fork mark makes when it sends you to its other side: arriving
   * somewhere with no confirmation is indistinguishable from not having moved.
   */
  useEffect(() => {
    if (focus === undefined || served.current === focus.at) return;
    // No `CSS.escape`: the value is `runId:instanceId` inside a quoted attribute selector, where the
    // only characters that would need it are a quote and a backslash, and a key holds neither.
    const found = sheets.current?.querySelector(`[data-instance="${focus.instance}"]`);
    if (!(found instanceof HTMLElement)) return;
    served.current = focus.at;
    found.scrollIntoView({ block: "center", behavior: "smooth" });
    found.classList.add("sb-panel-lit");
    const clear = window.setTimeout(() => found.classList.remove("sb-panel-lit"), 1200);
    return () => {
      window.clearTimeout(clear);
      found.classList.remove("sb-panel-lit");
    };
  }, [focus?.instance, focus?.at, bands, notes]);

  // Notes even with no bands, and that is the case worth having: a run whose first child was blocked
  // never opened a conversation at all, so "this run has not said anything yet" was the whole screen
  // — a true sentence standing where the reason belonged.
  if (bands.length === 0 && notes.length === 0) return <p className="empty">{empty ?? "This run has not said anything yet."}</p>;
  const bare = isSolo(bands);
  const placed = placeNotes(notes, bands);
  const starters = startersOf(bands);
  const forks = forksOf(bands.flatMap((band) => band.segments.flatMap((segment) => segment.pieces)));
  const placedForks = placeRunForks(runForks, bands);
  /** The rest of them: a fork that divides a panel rather than opening one. */
  const byPiece = runForkAt(runForks);

  /**
   * The page as one flat sequence of rows, so the rail can draw the hierarchy beside it.
   *
   * The two lists are built together and stay index-aligned: `steps` is what the rail reasons about
   * (a path, and whether the row enters it) and `nodes` is what the row says. They are separate
   * because a rail row is about a STATE and a page row is about anything at all — a panel, a note, a
   * mark — and the rail also inserts rows of its own where a state is left.
   */
  const steps: RailStep[] = [];
  const nodes: ReactNode[] = [];
  const add = (step: RailStep, node: ReactNode): void => {
    steps.push(step);
    nodes.push(node);
  };
  /** Where a panel's state sits. The address is stamped from the run's root, the same basis a note's
   *  path has, so both are trimmed to the module being read the same way. */
  const atPiece = (piece: SessionPiece): string[] =>
    segmentsFrom((piece.node.address ?? []).map((step) => step.childKey).join("/"), root);
  const addNotes = (list: readonly BandNote[]): void => {
    for (const note of list) add(stepOfNote(note, root), <NoteRow note={note} root={root} />);
  };

  for (const [i, band] of bands.entries()) {
    for (const fork of placedForks[i]!) {
      const opened = fork.sides[0]!.piece;
      add(
        { key: `f${i}:${JSON.stringify(fork.at)}`, stateId: opened.node.stateId, at: atPiece(opened), opens: false },
        <RunForkMark fork={fork} onGoToRun={goToRun} />,
      );
    }
    addNotes(placed[i]!);
    // A band can hold several conversations at once, and they are laid out ACROSS. Its place on the
    // rail is its first piece's: the row is one row however many panels are in it.
    const lead = band.segments[0]?.pieces[0];
    add(
      {
        key: `b${i}`,
        stateId: lead?.node.stateId ?? "",
        at: lead === undefined ? [] : atPiece(lead),
        opens: false,
      },
      <Band
        band={band}
        bare={bare}
        starters={starters}
        forks={forks}
        runForks={byPiece}
        onGoTo={goTo}
        onGoToRun={goToRun}
        {...(onOpenWorkflow !== undefined ? { onOpenWorkflow } : {})}
        shut={shut}
        onToggle={onToggle}
        onSetShut={onSetShut}
        scope={scope}
        render={render}
      />,
    );
  }
  addNotes(placed[bands.length]!);

  return (
    <div className="sb" ref={sheets}>
      <ZigDefs />
      <RailedRows
        steps={steps}
        renderStep={(i) => nodes[i]}
        {...(bands.some((band) => band.segments.length > 1) ? { className: "rail-wide" } : {})}
        {...(palette !== undefined ? { palette } : {})}
      />
    </div>
  );
}
