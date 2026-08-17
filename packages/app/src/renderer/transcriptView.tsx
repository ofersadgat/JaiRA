/**
 * The transcript, as a document with a chat in it.
 *
 * What replaced the two stacked panels — a session viewer over a journal projection — that between
 * them showed one state's words above the whole task's events and left the reader to interleave
 * them. There is one stream now, built by `transcript.ts`, and this file only decides how an entry
 * looks.
 *
 * ## Only one side is a bubble
 *
 * What the workflow SENT is a bubble on the right; what came BACK is bare prose, full width, with no
 * chrome at all. Both sides used to be bubbles, which made the answer — the thing the whole run
 * exists to produce — a quoted aside of the same weight as the prompt that asked for it, in a column
 * two thirds as wide as the panel it was in. A model's answer is a document. The instruction that
 * provoked it is an aside. The layout now says so.
 *
 * ## Work is a margin, not a stack of boxes
 *
 * A call, a thought and a journal fact are all the same shape: a glyph, a name, a preview, and a
 * mark saying whether it worked. One dense line each, no border, hover to highlight, click to open
 * underneath. Forty of them read as a column of activity you can skim down the left edge of, and a
 * stretch longer than {@link SHOWN} folds its older half away — because the question asked of a long
 * agent loop is almost always "what has it done lately", and the answer used to be forty screens up.
 *
 * ## The chrome rule
 *
 * Chrome marks a boundary between one OPERATION and the next, and nothing else. A single run's words
 * are {@link Transcript}, bare. Where several runs are shown together — which is what the session
 * panels in `sessionPanels.tsx` do — each gets a {@link RunCard} around it.
 *
 * A run is the unit, so a state that ran three times is three sibling cards rather than one card
 * that has to explain itself. Each is headed by its call signature, which is the same line the board
 * card carries, because they are the same fact: a run, and what it was called with.
 *
 * What decides which cards sit together is NOT this file. It used to be — a composite's own words
 * with its children's cards underneath — and that arrangement is gone, because it grouped by state
 * where the thing being read is grouped by conversation. See `sessionBands.ts`.
 */
import { useEffect, useState, type JSX, type ReactNode } from "react";
import type { InstanceNode, ServedArtifact, SessionView } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { Markdown, type FenceRenderer } from "./markdown";
import { ValueView } from "./valueView";
import { Icon } from "./icons";
import {
  blocksOf,
  iconOf,
  sidechainEntriesOf,
  signatureOf,
  type LiveTail,
  type MessageEntry,
  type SignatureParam,
  type ThoughtEntry,
  type ToolEntry,
  type TranscriptEntry,
  type WorkEntry,
} from "./transcript";

/** Renders one spawning call's subagent conversation — supplied by the Transcript that has the session. */
type SidechainOf = (call: string) => TranscriptEntry[];

/**
 * Walk into a subagent conversation — make the doorway a PLACE rather than a fold.
 *
 * Supplied by a host that has somewhere to put the step: the Files/Tasks walk pushes it on the
 * trail, the task panel on its own local stack. The name is what the crumb will read.
 */
type OpenSidechain = (call: string, name: string) => void;

/**
 * Replacing a message that was already sent — what the Chat view lends its transcript.
 *
 * Two halves because they are two different pieces of knowledge and only the host has either: which
 * turns can be replaced at all (`can`), and what to do when one is (`edit`). A transcript beside a
 * board is handed neither and shows no edit buttons, which is correct — a run's prompt came from the
 * workflow, and rewriting it after the fact would be a record of a run that never happened.
 */
export interface EditMessage {
  can: (turn: number) => boolean;
  edit: (turn: number, text: string) => void;
}

/** `09:14:02`. Seconds included: the gap between two calls is the thing being read. */
function clockOf(at: number | undefined): string {
  return at === undefined || at === 0 ? "" : new Date(at).toLocaleTimeString();
}

/** `2.4 s`, `1 m 12 s`. */
export function durationOf(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

/**
 * The fenced languages that are a PICTURE, and the type each one is.
 *
 * Only markup that a viewer can draw. A fence tagged `js` or `sql` is code, and code read as code is
 * already the best rendering of it — this exists for the two that have a second one.
 */
const DRAWABLE_FENCES: Readonly<Record<string, string>> = {
  html: "text/html",
  svg: "image/svg+xml",
};

/**
 * A fenced block, drawn rather than quoted — the answer's half of the artifact story.
 *
 * A model that wants to hand over a page has two routes: `show_artifact`, which produces a real
 * artifact with a real viewer, and pasting the page into its answer. The second used to arrive as a
 * grey box of source with no way to look at it, which is what a transcript full of `<!DOCTYPE html>`
 * looks like — 29,000 characters nobody can see. This closes that: the SAME {@link ValueView} the
 * artifacts pane and the payload blocks use, so one page looks identical wherever it turns up, and
 * the Rendered / Code / Text toggle comes with it rather than being built a second time here.
 *
 * Static, and that is the difference from an artifact rather than an oversight. `Html` is a `srcdoc`
 * frame with an empty `sandbox`, so scripts do not run — the interactive path needs a served
 * `jaira-artifact:` URL, and a fence has no artifact behind it to serve. A model that wants its
 * mockup to MOVE has a tool for that, and this is the fallback, not a second way in.
 *
 * Module-level so the reference is stable: `Markdown` memoises on it.
 */
const drawFence: FenceRenderer = ({ lang, code }) => {
  const mime = DRAWABLE_FENCES[lang];
  return mime === undefined ? undefined : <ValueView value={code} hint={{ mime }} />;
};

/**
 * A payload block, or the honest statement that the record kept none.
 *
 * Shown through {@link ValueView}, so a payload that has a better rendering than JSON gets it and
 * keeps the JSON one press away. That is not decoration here: a structured output whose value is a
 * set of files is the single most common large payload in this app, and it was being printed as an
 * array of strings with `\n` in them — the whole of what a run produced, in its least readable form.
 */
function Payload({
  label,
  value,
  artifacts,
}: {
  label: string;
  value: JsonValue | undefined;
  /** How to show one that RUNS. Absent ⇒ interactive artifacts render statically — see {@link ArtifactSurface}. */
  artifacts?: ArtifactSurface | undefined;
}): JSX.Element {
  if (value === undefined) return <div className="ts-payload ts-payload-empty">no {label} was recorded</div>;
  return (
    <div className="ts-payload">
      <ValueView
        value={value}
        label={label}
        {...(artifacts !== undefined ? { serve: artifacts.serve } : {})}
        {...(artifacts?.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {})}
      />
    </div>
  );
}

/**
 * Showing an artifact that RUNS — what a surface hands the transcript so a mockup can be interactive.
 *
 * Two capabilities, deliberately separate. `serve` is what makes the frame possible at all; `onPrompt`
 * is where a message from inside it goes, and a surface may offer the first without the second — a
 * transcript beside a board can show a working mockup while having no composer for it to talk to.
 */
export interface ArtifactSurface {
  /** Grant this artifact an address a frame can load. See `ipc.ts`'s `ServeArtifactRequest`. */
  serve: (path: string) => Promise<ServedArtifact>;
  /** Put text in front of the user, for them to send or discard. Never sends by itself. */
  onPrompt?: ((text: string) => void) | undefined;
}

/** How a row's glyph and name are coloured. Not the same axis as the mark at the end — see {@link Row}. */
type Tone = "plain" | "muted" | "warn" | "bad";

/**
 * One line of work, whatever produced it.
 *
 * A call, a piece of reasoning and a journal fact are one component because on screen they are one
 * thing: something happened, here is what it was, here is whether it worked. They used to be three
 * components with three borders, three paddings and three ideas about where the timestamp goes.
 *
 * The timestamp stays on the row even though messages have given theirs up to a hover. Down here it
 * is not decoration: the gap between two calls is how you find the one that took ninety seconds.
 */
function Row({
  entry,
  name,
  preview,
  tone,
  mark,
  prose,
  note,
  body,
}: {
  entry: WorkEntry;
  /** The bold half of the line. Absent for an event, whose whole text is the preview. */
  name?: string;
  preview: string;
  tone: Tone;
  /** The verdict at the end of the line, when there is one to give. */
  mark?: "ok" | "bad" | "waiting";
  /**
   * The preview is a sentence, not an argument.
   *
   * A call's preview is a path or a command and reads in monospace; a thought's and an event's are
   * English, and English set in monospace at 11px is a ransom note.
   */
  prose?: boolean;
  /**
   * A small annotation between the preview and the clock — "thought for 12 s", a live pulse.
   *
   * On the LINE rather than in the body, because it answers the question the row is skimmed for.
   * It sits before the timestamp so the right edge stays a single column of clocks.
   */
  note?: ReactNode;
  /** What opens underneath. Absent means the row does not open at all. */
  body?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const canOpen = body !== undefined;
  const line = (
    <>
      <span className="ts-icon">
        <Icon name={iconOf(entry)} />
      </span>
      {name !== undefined ? <span className="ts-name">{name}</span> : null}
      <span className="ts-preview ellip">{preview}</span>
      {note !== undefined ? <span className="ts-note">{note}</span> : null}
      <span className="ts-at">{clockOf(entry.at)}</span>
      <span className="ts-chev">{canOpen ? <Icon name="chevron" /> : null}</span>
      <span className="ts-mark">
        {mark === "ok" ? <Icon name="check" /> : mark === "bad" ? <Icon name="cross" /> : null}
      </span>
    </>
  );
  return (
    <div
      className={`ts-row ts-tone-${tone}${open ? " open" : ""}${canOpen ? " can-open" : ""}${prose === true ? " prose" : ""}`}
    >
      {canOpen ? (
        <button type="button" className="ts-row-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {line}
        </button>
      ) : (
        <div className="ts-row-line">{line}</div>
      )}
      {open && canOpen ? <div className="ts-row-body">{body}</div> : null}
    </div>
  );
}

/**
 * One tool call: a line, and both its halves when asked for.
 *
 * Expanded shows BOTH, labelled. It used to show one — the result if there was one, the arguments
 * otherwise — so a call you opened to find out what it was asked answered with what it returned
 * instead, and a record that kept neither printed the word `null`.
 */
function Tool({
  entry,
  sidechainOf,
  onOpenSidechain,
  artifacts,
}: {
  entry: ToolEntry;
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
}): JSX.Element {
  const sub = entry.sidechain !== undefined && sidechainOf !== undefined ? sidechainOf(entry.sidechain) : undefined;
  // What the crumb will read: the call's first argument is the Task's short description, which is
  // the one name a person chose for this subagent. The tool's own name is the honest fallback.
  const chainName = `⑂ ${entry.summary.length > 0 ? entry.summary : entry.name}`;
  return (
    <Row
      entry={entry}
      name={entry.name}
      preview={entry.sidechain !== undefined ? `⑂ ${entry.summary}` : entry.summary}
      tone={entry.ok === false ? "bad" : "plain"}
      mark={entry.ok === undefined ? "waiting" : entry.ok ? "ok" : "bad"}
      body={
        <>
          {/* The subagent's conversation, first: it is what this call DID, and the arguments and
              report below are its envelope. A conversation inside a conversation renders as one —
              same component, one rule down the left edge — because it is one. */}
          {entry.sidechain !== undefined && (sub !== undefined || onOpenSidechain !== undefined) ? (
            <div className="ts-sidechain">
              <div className="ts-sidechain-head">
                <span>subagent conversation{sub !== undefined ? ` · ${sub.length} entries` : ""}</span>
                {onOpenSidechain !== undefined ? (
                  // The doorway as NAVIGATION: the same conversation, as the last element of the
                  // address instead of a fold inside a row — which is what makes it a place you can
                  // stand in, and walk back out of.
                  <button
                    type="button"
                    className="ts-sidechain-open"
                    onClick={() => onOpenSidechain(entry.sidechain!, chainName)}
                  >
                    walk in →
                  </button>
                ) : null}
              </div>
              {sub !== undefined ? (
                <Transcript
                  entries={sub}
                  {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
                  {...(artifacts !== undefined ? { artifacts } : {})}
                />
              ) : null}
            </div>
          ) : null}
          <Payload label="arguments" value={entry.args} {...(artifacts !== undefined ? { artifacts } : {})} />
          {/* A call still in flight has no result, and saying so is different from showing an empty
              one — which is why this is absent rather than an empty block. */}
          {entry.ok === undefined && entry.result === undefined ? (
            <div className="ts-payload ts-payload-empty">still running</div>
          ) : (
            <Payload label="result" value={entry.result} {...(artifacts !== undefined ? { artifacts } : {})} />
          )}
          {/* The agent's OWN record of the execution, when the native capture kept one — richer than
              the wire result and shown beside it, never instead of it. */}
          {entry.detail !== undefined ? (
            <Payload label="record" value={entry.detail} {...(artifacts !== undefined ? { artifacts } : {})} />
          ) : null}
        </>
      }
    />
  );
}

/**
 * A wall clock that ticks while something is live, and not otherwise.
 *
 * A second is the right resolution for "thought for 12 s" and the wrong cost for a transcript with
 * forty settled rows in it — so the interval exists only while `live` is true, and a row that has
 * stopped thinking stops re-rendering with it.
 */
function useElapsed(startedAt: number | undefined, live: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live, startedAt]);
  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

/**
 * One block of reasoning — and how long it took, which is the question actually being asked of it.
 *
 * A finished block states its duration ("thought for 12.4 s"); a block still being written counts
 * up beside a pulse, because a model that has been thinking for ninety seconds and one that has
 * stalled look identical without a number that moves. The duration is the turn's
 * thinking-start → answer-start, so it is the wait a person actually experienced, not the length of
 * the text that came out of it.
 */
function Thought({ entry }: { entry: ThoughtEntry }): JSX.Element {
  const live = entry.live === true;
  const elapsed = useElapsed(entry.startedAt, live);
  const shown = live ? elapsed : entry.durationMs;
  // Present tense while it runs. "thought for 40 s" beside a live pulse reads as a block that
  // finished and is somehow still going; what the counter is for is saying what is happening NOW.
  const took = shown !== undefined ? `${live ? "thinking for" : "thought for"} ${durationOf(shown)}` : undefined;
  return (
    <Row
      entry={entry}
      name="thinking"
      preview={entry.text.replace(/\s+/g, " ").trim()}
      tone="muted"
      prose
      {...(live || took !== undefined
        ? {
            note: (
              <span className={live ? "ts-think-live" : "ts-think-took"}>
                {live ? <Pulse /> : null}
                {took ?? "thinking…"}
              </span>
            ),
          }
        : {})}
      // Nothing to open when the provider withheld the reasoning: the row is the whole fact, and a
      // disclosure onto an empty pane is a row that lies about having something behind it.
      {...(entry.text.length > 0 ? { body: <pre className="ts-think-text">{entry.text}</pre> } : {})}
    />
  );
}

/** One entry of work, dispatched by kind. All three land on the same {@link Row}. */
function Work({
  entry,
  sidechainOf,
  onOpenSidechain,
  artifacts,
}: {
  entry: WorkEntry;
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
}): JSX.Element {
  if (entry.kind === "tool") {
    return (
      <Tool
        entry={entry}
        {...(sidechainOf !== undefined ? { sidechainOf } : {})}
        {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
        {...(artifacts !== undefined ? { artifacts } : {})}
      />
    );
  }
  if (entry.kind === "thought") return <Thought entry={entry} />;
  // An event is a fact, not a call: no name to bold, no verdict to give — and nothing to open,
  // unless the fact is a compression of a fuller line (a native attachment, a queued operation).
  return (
    <Row
      entry={entry}
      preview={entry.text}
      tone={entry.tone === "plain" ? "muted" : entry.tone}
      prose
      {...(entry.detail !== undefined
        ? { body: <Payload label="detail" value={entry.detail} {...(artifacts !== undefined ? { artifacts } : {})} /> }
        : {})}
    />
  );
}

/**
 * How many rows of a long stretch of work stay visible.
 *
 * Five is roughly what fits above the fold beside a message, and the fold hides the OLDER half
 * rather than the newer one on purpose: a run that is still going is read from its live edge
 * backwards, and the thing you want is what it just did.
 */
const SHOWN = 5;

/** Worth a fold only when it hides more than it costs — one hidden row behind a toggle line is a loss. */
function foldsAt(count: number): number {
  return count > SHOWN + 1 ? count - SHOWN : 0;
}

/** A stretch of work between two messages, with its older half foldable. */
function WorkBlockView({
  entries,
  sidechainOf,
  onOpenSidechain,
  artifacts,
}: {
  entries: WorkEntry[];
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const hidden = foldsAt(entries.length);
  const shown = hidden === 0 || open ? entries : entries.slice(hidden);
  return (
    <div className="ts-work">
      {hidden > 0 ? (
        <button type="button" className="ts-fold" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="ts-chev">
            <Icon name="chevron" />
          </span>
          {open ? "Show fewer steps" : `${hidden} earlier steps`}
        </button>
      ) : null}
      {/* Keyed by the entry's position in the WHOLE block, not in the visible slice. Folding shifts
          every index, so a slice-relative key hands one row's open/closed state to a different row —
          an expanded tool call's payload jumps to an unrelated line. */}
      {shown.map((entry, i) => (
        <Work
          key={hidden === 0 || open ? i : hidden + i}
          entry={entry}
          {...(sidechainOf !== undefined ? { sidechainOf } : {})}
          {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
          {...(artifacts !== undefined ? { artifacts } : {})}
        />
      ))}
    </div>
  );
}

/**
 * Something that was said.
 *
 * Three shapes, and the difference between them is the point. An answer is a document. An
 * instruction is a bubble on the right, the way every chat client has arranged it for twenty years.
 * A system prompt is neither — it is the frame the run was given, so it is quiet, full width, and
 * marked with the one label a reader would not otherwise guess.
 */
function Message({ entry, onEdit }: { entry: MessageEntry; onEdit?: EditMessage | undefined }): JSX.Element {
  // Only a message the host can NAME a position for is editable, which is why this asks rather than
  // being told: the host holds the edit points, and a button offered over a message nothing can be
  // sent in place of would be a button that fails when pressed.
  const editable = onEdit !== undefined && entry.turn !== undefined && onEdit.can(entry.turn);
  /**
   * Whether this answer is being read as markdown or as what the model actually wrote.
   *
   * An answer is rendered by default because that is what it was written to be, and the toggle
   * exists because rendering is a CLAIM — a fence that never closed, a heading that ate a paragraph,
   * a table that did not parse are all invisible in the rendering and obvious in the source. It
   * lives in the hover meta rather than in a permanent control: this is a check you make
   * occasionally, and a button over every paragraph the model wrote is chrome that never rests.
   */
  const [source, setSource] = useState(false);
  const meta = (
    // Hidden until hovered. On a message the clock is provenance rather than content: worth having,
    // never worth a permanent line of grey above every paragraph the model wrote.
    <div className="ts-meta">
      <span>{clockOf(entry.at)}</span>
      {entry.role === "assistant" && entry.text !== undefined && entry.text.length > 0 ? (
        <button className="ghost ts-view" aria-pressed={source} onClick={() => setSource((v) => !v)}>
          {source ? "Rendered" : "Source"}
        </button>
      ) : null}
      {editable ? (
        <button className="ghost ts-edit" onClick={() => onEdit.edit(entry.turn!, entry.text ?? "")}>
          Edit
        </button>
      ) : null}
    </div>
  );
  const said = entry.text !== undefined && entry.text.length > 0;
  if (entry.role === "user") {
    return (
      <div className="ts-msg ts-msg-user">
        <div className="ts-bubble">{said ? <pre className="ts-text">{entry.text}</pre> : <span className="sub">(empty)</span>}</div>
        {meta}
      </div>
    );
  }
  if (entry.role === "assistant") {
    return (
      <div className="ts-msg ts-msg-assistant">
        {said ? (
          source ? (
            <pre className="ts-text">{entry.text}</pre>
          ) : (
            <Markdown text={entry.text ?? ""} fence={drawFence} />
          )
        ) : (
          <p className="empty">(no answer was recorded)</p>
        )}
        {meta}
      </div>
    );
  }
  return (
    <div className="ts-msg ts-msg-aside">
      <span className="ts-tag">{entry.role}</span>
      {/* Shown as written. This is the input, and reformatting an input is how you stop being able
          to see what was actually sent. */}
      {said ? <pre className="ts-text">{entry.text}</pre> : null}
      {meta}
    </div>
  );
}

/**
 * The sheet a conversation is printed on.
 *
 * A transcript used to sit directly on the app's grey, which made it look like one more pane of
 * chrome — the same surface as the rail, the board and the file tree. It is not chrome. It is the
 * record, and a record reads as a page: a raised surface, a hairline, and grey around it rather than
 * underneath it.
 *
 * The wrapper is here rather than at each host because both surfaces that show a transcript need the
 * same page, and a page defined twice is a page that drifts.
 */
export function Paper({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="ts-page">
      <div className="ts-paper">{children}</div>
    </div>
  );
}

/** Three dots, breathing. The one piece of motion in the transcript, and it means "still going". */
function Pulse(): JSX.Element {
  return (
    <span className="ts-pulse" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * A run's conversation, with no chrome at all.
 *
 * This is what a leaf shows, and what a composite shows for its own operation. Both are "this state
 * speaking", and they look the same because they are the same.
 */
export function Transcript({
  session,
  entries,
  live,
  empty,
  onOpenSidechain,
  onEdit,
  artifacts,
}: {
  session?: SessionView | null;
  entries: TranscriptEntry[];
  /**
   * The live tail behind {@link entries}, when the record is still open — here for its SIDECHAINS,
   * which the doorway rows render while the subagent's turns are still streaming by. The tail's own
   * text and items are already in `entries`; this is the part `entriesOf` cannot flatten, because it
   * belongs behind a row rather than in the flow.
   */
  live?: LiveTail | null | undefined;
  /** What to say when there is nothing — a function op ran no model call, which is an answer. */
  empty?: string | undefined;
  /** Walk into a subagent conversation. Absent ⇒ the doorway only folds open in place. */
  onOpenSidechain?: OpenSidechain | undefined;
  /** Send a message in place of one already here. Absent ⇒ no message offers an edit. */
  onEdit?: EditMessage | undefined;
  /**
   * How an artifact that RUNS is shown, and where a message from one goes.
   *
   * Optional, and the absence is a real posture rather than a missing feature: a transcript rendered
   * without it still shows every interactive artifact, statically. Granting one takes a task and a
   * project, which a transcript has only where a surface hands them over — see `chatPane.tsx`.
   */
  artifacts?: ArtifactSurface | undefined;
}): JSX.Element {
  if (entries.length === 0) {
    return <p className="empty">{empty ?? session?.empty ?? "Nothing has been said here yet."}</p>;
  }
  // The session and the live tail are what hold the subagent conversations, so only a Transcript
  // that was handed one can open a doorway — the recursive sub-transcript inside a row passes
  // neither, which also bounds the inline walk.
  const chains = session !== null && session !== undefined ? session.sidechains : undefined;
  const sidechainOf: SidechainOf | undefined =
    chains !== undefined || live?.sidechains !== undefined
      ? (call) => sidechainEntriesOf(session ?? null, call, live?.sidechains?.[call])
      : undefined;
  return (
    <div className="ts">
      {blocksOf(entries).map((block, i) => {
        if (block.kind === "work")
          return (
            <WorkBlockView
              key={i}
              entries={block.entries}
              {...(sidechainOf !== undefined ? { sidechainOf } : {})}
              {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
              {...(artifacts !== undefined ? { artifacts } : {})}
            />
          );
        if (block.kind === "message") return <Message key={i} entry={block} {...(onEdit !== undefined ? { onEdit } : {})} />;
        return (
          <div key={i} className="ts-msg ts-msg-assistant ts-live">
            {/* Plain text, not markdown: a half-arrived answer has half a fenced block in it, and
                rendering that produces a code block that swallows the rest of the stream. */}
            <pre className="ts-text-live">{block.text}</pre>
            <div className="ts-live-line">
              <Pulse />
              writing…
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The `draft {goals=3 items, context="# Context…"}` line, or the run's own name when it has one. */
function Signature({ name, label, params }: { name: string; label?: string; params: SignatureParam[] }): JSX.Element {
  return (
    <span className="ts-sig ellip">
      <span className="ts-sig-name">{name}</span>
      {label !== undefined ? (
        <span className="ts-sig-label"> {label}</span>
      ) : params.length === 0 ? null : (
        <span className="ts-sig-args">
          {" {"}
          {params.map((param, i) => (
            <span key={param.name}>
              {i > 0 ? ", " : ""}
              {param.name}=<span className="ts-sig-value">{param.preview}</span>
            </span>
          ))}
          {"}"}
        </span>
      )}
    </span>
  );
}

/** The status dot. Colour only — the header already says everything in words. */
function Dot({ status }: { status: InstanceNode["status"] }): JSX.Element {
  return <span className={`ts-dot ts-dot-${status}`} />;
}

/**
 * One run of one child, as a card.
 *
 * Folded by default and opened on demand, which is what makes a five-state run five lines until you
 * ask. `onOpen` exists because the conversation behind a card is fetched, not held: loading every
 * child's transcript to render a list of headers would be one round trip per state on every
 * selection.
 *
 * The card is a rule down the left of its contents rather than a box around them. A box inside a box
 * inside a box is what three levels of nesting used to look like, and by the third the transcript
 * had lost a fifth of its width to borders that said nothing the indent did not.
 */
export function RunCard({
  node,
  open,
  running,
  children,
  onToggle,
}: {
  node: InstanceNode;
  open: boolean;
  /** True while this run is the live one — the card it is worth opening by default. */
  running?: boolean;
  children?: ReactNode;
  onToggle: () => void;
}): JSX.Element {
  const sig = signatureOf(node);
  const took = node.endedAt !== undefined ? durationOf(node.endedAt - node.startedAt) : undefined;
  return (
    <section className={`ts-card${open ? " open" : ""}${running === true ? " live" : ""}`}>
      <button type="button" className="ts-card-head" aria-expanded={open} onClick={onToggle}>
        <span className="ts-chev">
          <Icon name="chevron" />
        </span>
        <Dot status={node.status} />
        <Signature {...sig} />
        <span className="ts-card-meta">
          {clockOf(node.startedAt)}
          {took !== undefined ? ` · ${took}` : ""}
        </span>
      </button>
      {open ? <div className="ts-card-body">{children}</div> : null}
    </section>
  );
}

