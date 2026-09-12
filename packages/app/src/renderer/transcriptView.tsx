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
 * are {@link Transcript}, bare. Where several runs share a sheet — which is what the session panels
 * in `sessionPanels.tsx` do — each is headed by a LETTERHEAD (`stateSurface.tsx`): a line of type
 * inside the sheet's top margin with a rule under it.
 *
 * That replaced a card per run, and the indent went with it. A card wrapped every state in a fold, a
 * dot and a signature and then hung its body behind a left rule — three levels of which spent about
 * a fifth of the width restating a boundary the rule already draws.
 *
 * What decides which cards sit together is NOT this file. It used to be — a composite's own words
 * with its children's cards underneath — and that arrangement is gone, because it grouped by state
 * where the thing being read is grouped by conversation. See `sessionBands.ts`.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import {
  artifactOf,
  detectedMime,
  mimeOfFenceLang,
  mimeOfPath,
  mimeOfSchema,
  OFFERED_TYPES,
  typeNameOf,
  viewsFor,
  type InstanceNode,
  type ServedArtifact,
  type SessionView,
  type ViewHint,
  type ViewId,
} from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { choicesOfQuestions, type AgentQuestion } from "@jaira/shared/browser";
import { answersOfAnsweredText, answersOfValue, ChoiceList, ChoiceSteps, type Answer } from "./choices";
import { Markdown } from "./markdown";
import { ValueView } from "./valueView";
import { familyIcon, Icon } from "./icons";
import { ContextMenu, MENU_WIDTH, type MenuAnchor } from "./menu";
import { typeKeyOf, useMessageTypes } from "./messageTypes";
import { useValuePanel } from "./valuePanel";
import {
  blocksOf,
  dayLabelOf,
  endOfBlock,
  gapBetween,
  iconOf,
  startOfBlock,
  type Gap,
  type LiveStatus,
  sidechainEntriesOf,
  signatureOf,
  type LiveTail,
  type MessageEntry,
  type SignatureParam,
  type ThoughtEntry,
  type ToolEntry,
  type TranscriptEntry,
  type WorkEntry,
  type WritingEntry,
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
  /**
   * Which CUT this message can be the point of, if any — see `cut.ts`.
   *
   * A message that begins a turn is cut BEFORE: it and everything after it go. A reply ends one and
   * is cut AFTER: it stays, and everything after it goes. Both land on the same kind of point — the
   * start of the next turn in the journal — so the sentence in the tooltip is the only thing that
   * differs. `undefined` means neither verb is offered here: nothing comes after this message, or
   * the journal does not name its turn.
   */
  cut?: ((turn: number) => "before" | "after" | undefined) | undefined;
  /**
   * Delete from the cut on, then carry on from there.
   *
   * Not the fork {@link edit} makes: a rewind KEEPS nothing. It ARMS the deletion — the transcript
   * shows what would go and the host asks in words — and the host does it when the person says so.
   */
  rewind?: ((turn: number, text: string) => void) | undefined;
  /**
   * A second conversation sharing everything before the cut. Arms the host's composer: the next
   * message is what starts the new conversation, so nothing exists until one is sent.
   */
  fork?: ((turn: number, text: string) => void) | undefined;
}

/** `09:14:02`. Seconds included: the gap between two calls is the thing being read. */
export function clockOf(at: number | undefined): string {
  return at === undefined || at === 0 ? "" : new Date(at).toLocaleTimeString();
}

/**
 * The whole moment, for the tooltip behind the clock — every field, in the reader's own format.
 */
function fullClockOf(at: number | undefined): string | undefined {
  return at === undefined || at === 0 ? undefined : new Date(at).toLocaleString();
}

/**
 * What the rail says about WHEN, which has to be a complete answer on its own.
 *
 * A bare clock is complete only for today. Hovering a message from Tuesday and reading `14:22:31`
 * tells you the minute and leaves the day to be worked out from the floating chip, which is at the
 * top of the scroller and may not even be on screen — so the two devices between them answered the
 * question only if you used both. The date joins the clock the moment the message is not from today,
 * which is exactly when it stops being redundant.
 */
function stampOf(at: number | undefined): string {
  if (at === undefined || at === 0) return "";
  const when = new Date(at);
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  if (sameDay) return when.toLocaleTimeString();
  return `${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${when.toLocaleTimeString()}`;
}

/** Bytes as a person reads them — what a size looks like beside a name. */
export function sizeOf(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** `2.4 s`, `1 m 12 s`. */
export function durationOf(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

/**
 * How long a model thought, said the way a person waiting would say it — `0.4 seconds`,
 * `12.4 seconds`, `2 m 5.3 s`.
 *
 * Its own formatter rather than {@link durationOf}, which serves run cards and switches units under
 * a second: a thinking block that reports `840 ms` and then `1.2 s` a moment later is a counter that
 * changes shape while you are reading it. Tenths all the way down, so the number only ever grows,
 * and the word spelled out because this is a sentence about a wait, not a figure in a table.
 */
export function thoughtTime(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} seconds`;
  return `${Math.floor(seconds / 60)} m ${(seconds % 60).toFixed(1)} s`;
}

/**
 * The type a tool call's OWN arguments say its payload is.
 *
 * A `Read` of `main.cpp` produces a string, and nothing downstream knew what kind of string — so
 * `viewsFor` sniffed, and sniffing is weakest exactly on source code. The call already carries the
 * answer: a path, in an argument the tool itself named. Reading it turns a guess into a
 * declaration, and a declaration beats the sniffer everywhere in `viewsFor`.
 *
 * Absolute paths are what a tool is given, so the vendor rules in {@link mimeOfPath} — which key
 * off a position under a layer root — simply do not fire, and the extension answers. `text/plain`
 * comes back as `undefined` for the same reason it does in {@link mimeOfFenceLang}: it is not a
 * statement worth making, and making it would silence sniffing on a value nobody classified.
 */
function pathMimeOf(args: JsonValue | undefined): string | undefined {
  if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) return undefined;
  const at = args as Record<string, JsonValue | undefined>;
  for (const key of ["file_path", "filePath", "notebook_path", "path"]) {
    const named = at[key];
    if (typeof named === "string" && named !== "") {
      const mime = mimeOfPath(named.replace(/\\/g, "/"));
      return mime === "text/plain" ? undefined : mime;
    }
  }
  return undefined;
}

/**
 * A payload block, or the honest statement that the record kept none.
 *
 * Shown through {@link ValueView}, so a payload that has a better rendering than JSON gets it and
 * keeps the JSON one press away. That is not decoration here: a structured output whose value is a
 * set of files is the single most common large payload in this app, and it was being printed as an
 * array of strings with `\n` in them — the whole of what a run produced, in its least readable form.
 *
 * `fence` for the same reason a message gets one: this is a reading surface. Without it a payload
 * that reads as markdown mounted the CodeMirror live-preview editor — one per block, in a column of
 * forty — which is precisely the cost that prop exists to avoid, and it was being paid here only
 * because nobody passed it.
 */
function Payload({
  label,
  value,
  hint,
  artifacts,
}: {
  label: string;
  value: JsonValue | undefined;
  /** What the call says this is — see {@link pathMimeOf}. Absent ⇒ `viewsFor` sniffs, as before. */
  hint?: string | undefined;
  /** How to show one that RUNS. Absent ⇒ interactive artifacts render statically — see {@link ArtifactSurface}. */
  artifacts?: ArtifactSurface | undefined;
}): JSX.Element {
  if (value === undefined) return <div className="ts-payload ts-payload-empty">no {label} was recorded</div>;
  return (
    <div className="ts-payload">
      <ValueView
        value={value}
        label={label}
        {...(hint !== undefined ? { hint: { mime: hint } } : {})}
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
  shown,
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
  /**
   * What is shown underneath WITHOUT being asked for — today, a page the call produced.
   *
   * Deliberately a second slot rather than more {@link body}. The fold is the transcript's answer to
   * forty tool calls, and it is the right answer for arguments and results, which are evidence you
   * go looking for. A thing the model made for you to LOOK AT is not evidence; it is the point of
   * the call, and a point behind a disclosure triangle is a point nobody found. See {@link Tool}.
   */
  shown?: ReactNode;
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
      {shown !== undefined ? <div className="ts-row-shown">{shown}</div> : null}
    </div>
  );
}

/**
 * The page a call PRODUCED, when it produced one — `show_artifact`'s half of the artifact story.
 *
 * Read off the result rather than off the tool's NAME, deliberately. `show_artifact` reaches an
 * agent under several names (bare, and MCP-prefixed per transport), and it is not the only producer
 * an artifact envelope can come out of; what makes a result showable is that it says what its bytes
 * are, which is exactly what {@link artifactOf} asks. A name test would have to be kept in step with
 * every transport, and would answer wrongly the first time it was not.
 *
 * `content` decides. The envelope carries the bytes inline whenever they are small enough
 * (`inlineMaxBytes`), which is the common case and the cheap one — there is nothing to fetch and
 * nothing to serve. Above that the envelope is metadata and a `uri`, and the page stays where the
 * artifacts panel can open it: an artifact too large to inline is also too large to unfold into the
 * middle of a conversation unasked.
 */
export function producedArtifact(result: JsonValue | undefined): JsonValue | undefined {
  if (result === undefined) return undefined;
  const artifact = artifactOf(result);
  return artifact?.content !== undefined ? result : undefined;
}

/**
 * One tool call: a line, and both its halves when asked for — and the page, when it made one.
 *
 * Expanded shows BOTH, labelled. It used to show one — the result if there was one, the arguments
 * otherwise — so a call you opened to find out what it was asked answered with what it returned
 * instead, and a record that kept neither printed the word `null`.
 *
 * A call that produced a PAGE draws it under the line without being asked. That is not a special
 * case for one tool; it is the difference between a result and a rendering. `show_artifact` exists
 * to put something in front of a person, and for three calls of it the conversation showed three
 * collapsed grey lines reading `show_artifact  mockup.html` — the work was done, recorded, servable
 * and invisible. The renderer is the same {@link ValueView} the artifacts panel and the payload
 * blocks use, so a mockup looks identical wherever it turns up and arrives with its
 * Rendered / Code / Text toggle rather than a second one built here.
 */
/**
 * An agent's question to the person, out of the call that asked it — `AskUserQuestion`.
 *
 * The questions are the call's arguments. The answers are what came back, read from the richest
 * record there is: the agent's own `toolUseResult` keeps them as a map, and the wire result the
 * model saw spells them out as text, which is parsed when the map was not captured. A call still in
 * flight, or a dismissal, answers nothing and is drawn unanswered.
 *
 * A call that FAILED is not a question. The binary refuses the tool's input on its own rules — five
 * questions where it takes four — before any person is asked, and the agent goes on as if answered.
 * Drawn as a question, that read as one nobody could answer: options a reader could not pick and a
 * run that did not wait. It is the failed tool call it was, with the refusal behind the row.
 */
export function askedOf(entry: ToolEntry): { questions: AgentQuestion[]; answers: Record<string, JsonValue> | undefined } | undefined {
  if (entry.name !== "AskUserQuestion" && !entry.name.endsWith("__AskUserQuestion")) return undefined;
  if (entry.ok === false) return undefined;
  const args = entry.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const questions = (args as Record<string, JsonValue>)["questions"];
  if (!Array.isArray(questions)) return undefined;
  const sound = questions.filter(
    (q): q is JsonValue & Record<string, JsonValue> =>
      q !== null && typeof q === "object" && !Array.isArray(q) && typeof (q as Record<string, JsonValue>)["question"] === "string",
  );
  if (sound.length === 0) return undefined;
  const asked = sound.map(
    (q): AgentQuestion => ({
      question: q["question"] as string,
      ...(typeof q["header"] === "string" ? { header: q["header"] } : {}),
      ...(q["multiSelect"] === true ? { multiSelect: true } : {}),
      options: Array.isArray(q["options"])
        ? q["options"]
            .filter((o): o is JsonValue & Record<string, JsonValue> => o !== null && typeof o === "object" && !Array.isArray(o))
            .map((o) => ({
              label: String(o["label"] ?? ""),
              ...(typeof o["description"] === "string" ? { description: o["description"] } : {}),
            }))
        : [],
    }),
  );
  const detail = entry.detail;
  const kept =
    detail !== undefined && detail !== null && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, JsonValue>)["answers"]
      : undefined;
  if (kept !== undefined && kept !== null && typeof kept === "object" && !Array.isArray(kept)) {
    return { questions: asked, answers: kept as Record<string, JsonValue> };
  }
  const text = resultTextOf(entry.result);
  const parsed =
    text === undefined
      ? undefined
      : answersOfAnsweredText(
          text,
          asked.map((q) => q.question),
        );
  return { questions: asked, answers: parsed };
}

/** The text of a tool's result, out of whichever envelope the transport left it in. */
function resultTextOf(result: JsonValue | undefined): string | undefined {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const texts = result
      .map((block) =>
        block !== null && typeof block === "object" && !Array.isArray(block) && typeof (block as Record<string, JsonValue>)["text"] === "string"
          ? ((block as Record<string, JsonValue>)["text"] as string)
          : typeof block === "string"
            ? block
            : "",
      )
      .filter((t) => t.length > 0);
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return undefined;
}

/**
 * The agent's question as the person saw it, with what they answered — the same chooser the dialog
 * drew, inert. Several questions keep their stepper, Back and Next included: they were read one at
 * a time, and they are re-read the same way.
 */
function AskedQuestions({ questions, answers }: { questions: AgentQuestion[]; answers: Record<string, JsonValue> | undefined }): JSX.Element {
  const choices = useMemo(() => choicesOfQuestions(questions), [questions]);
  const [state, setState] = useState<Record<string, Answer>>(() =>
    answersOfValue(choices, answers === undefined ? undefined : { answers }),
  );
  return (
    <div className="gate-settled ts-asked" data-testid="asked">
      {choices.length > 1 ? (
        <ChoiceSteps
          choices={choices}
          answers={state}
          onAnswer={(question, next) => setState((prev) => ({ ...prev, [question]: next }))}
          onSubmit={() => undefined}
          readOnly
        />
      ) : (
        <ChoiceList
          choices={choices}
          answers={state}
          onAnswer={(question, next) => setState((prev) => ({ ...prev, [question]: next }))}
          readOnly
        />
      )}
    </div>
  );
}

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
  const asked = askedOf(entry);
  // What the crumb will read: the call's first argument is the Task's short description, which is
  // the one name a person chose for this subagent. The tool's own name is the honest fallback.
  const chainName = `⑂ ${entry.summary.length > 0 ? entry.summary : entry.name}`;
  const produced = producedArtifact(entry.result);
  // What the call itself says its payload is — see {@link pathMimeOf}. Read from the ARGUMENTS and
  // applied to what came back, because a file's type is a property of the file, not of the string
  // a tool happened to return.
  const pathMime = pathMimeOf(entry.args);
  return (
    <Row
      entry={entry}
      name={entry.name}
      preview={entry.sidechain !== undefined ? `⑂ ${entry.summary}` : entry.summary}
      tone={entry.ok === false ? "bad" : "plain"}
      mark={entry.ok === undefined ? "waiting" : entry.ok ? "ok" : "bad"}
      {...(asked !== undefined
        ? {
            // The question the agent put to the person, and their answer, drawn under the line
            // without being asked for: it is the one call in a transcript whose arguments a person
            // wrote half of. Keyed on whether it has been answered, so a row that was in flight
            // redraws with the answer rather than keeping its empty state.
            shown: <AskedQuestions key={asked.answers === undefined ? "asking" : "answered"} questions={asked.questions} answers={asked.answers} />,
          }
        : produced !== undefined
        ? {
            shown: (
              <ValueView
                value={produced}
                {...(artifacts !== undefined ? { serve: artifacts.serve } : {})}
                {...(artifacts?.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {})}
              />
            ),
          }
        : entry.output !== undefined
          ? {
              // The call that DELIVERED the operation's output, drawn rather than folded — the same
              // argument the artifact above makes, about the same slot. This row is the agent's way
              // of terminating with a value, so what is behind its triangle is not evidence for the
              // answer, it IS the answer; what reads as a result ("Structured output provided
              // successfully") is an acknowledgement carrying no information at all.
              shown: (
                <ValueView
                  value={entry.output.value}
                  label={entry.output.name ?? "output"}
                  {...(entry.output.schema !== undefined ? { hint: { schema: entry.output.schema } } : {})}
                />
              ),
            }
          : {})}
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
            <Payload
              label="result"
              value={entry.result}
              {...(pathMime !== undefined ? { hint: pathMime } : {})}
              {...(artifacts !== undefined ? { artifacts } : {})}
            />
          )}
          {/* The agent's OWN record of the execution, when the native capture kept one — richer than
              the wire result and shown beside it, never instead of it. */}
          {entry.detail !== undefined ? (
            <Payload
              label="record"
              value={entry.detail}
              {...(pathMime !== undefined ? { hint: pathMime } : {})}
              {...(artifacts !== undefined ? { artifacts } : {})}
            />
          ) : null}
        </>
      }
    />
  );
}

/**
 * A wall clock that ticks while something is live, and not otherwise.
 *
 * TENTHS, because a counter that moves once a second is doing the job of a pulse: what the number
 * is for is telling a stalled run from a working one, and a digit that changes ten times a second is
 * the fastest way to say "still going" that is also a measurement. It costs one `setState` per
 * 100 ms on ONE row — the interval exists only while `live` is true, so a transcript with forty
 * settled rows in it re-renders none of them.
 */
const TICK_MS = 100;

/**
 * `tick` is a parameter because the two things that count here are counting different quantities.
 * A thinking block is a pause you are WAITING OUT, measured in tenths so the digits prove something
 * is alive. A run has been going for four minutes and nobody is watching the seconds — a tenth there
 * is forty re-renders a second spent on a number whose last digit nobody reads.
 */
export function useElapsed(startedAt: number | undefined, live: boolean, tick = TICK_MS): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tick);
    return () => clearInterval(timer);
  }, [live, startedAt, tick]);
  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

/**
 * One block of reasoning — and how long it took, which is the question actually being asked of it.
 *
 * A finished block states its duration ("Thought for 12.4 seconds"); a block still being written
 * counts up in tenths beside a pulse, because a model that has been thinking for ninety seconds and
 * one that has stalled look identical without a number that moves. The duration is the turn's
 * thinking-start → answer-start, so it is the wait a person actually experienced, not the length of
 * the text that came out of it.
 */
function Thought({ entry, narrated }: { entry: ThoughtEntry; narrated?: boolean | undefined }): JSX.Element {
  // Live only while nothing else is counting these seconds. A bar six pixels below saying
  // "Thinking · 12.4 seconds" makes this one a second opinion, and two clocks on one wait is worse
  // than either — but only the LIVE half defers: the duration a finished block states is a fact
  // about that block, and belongs beside it whatever is happening now.
  const live = entry.live === true && narrated !== true;
  const elapsed = useElapsed(entry.startedAt, live);
  const shown = live ? elapsed : entry.durationMs;
  // Present tense while it runs. "Thought for 40 seconds" beside a live pulse reads as a block that
  // finished and is somehow still going; what the counter is for is saying what is happening NOW.
  const took = shown !== undefined ? `${live ? "Thinking for" : "Thought for"} ${thoughtTime(shown)}` : undefined;
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
                {took ?? "Thinking…"}
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

/**
 * A call being WRITTEN — the row that stands in for a tool call while its arguments stream.
 *
 * The answer to a conversation that looks stopped while it is working hardest. A model producing a
 * fifteen-kilobyte page emits it as one argument of one call, and until that call is assembled there
 * is nothing on the stream a transcript recognises: the thinking has ended, the answer has not
 * begun, and the row for the call does not exist because the call does not. This is the interval,
 * shown as what it is — this tool, this path, this much so far, still going.
 *
 * A counter rather than a spinner, for the same reason the thinking row counts: a number that grows
 * is the difference between "producing a large page" and "hung", and those are the only two things
 * a reader of a long silence is trying to tell apart.
 *
 * It never opens. There is nothing behind it — half a JSON string is not an argument list, and a row
 * that unfolded onto one would be showing the reader the transport.
 */
function Writing({ entry }: { entry: WritingEntry }): JSX.Element {
  return (
    <Row
      entry={entry}
      name={entry.name}
      preview={entry.path ?? ""}
      tone="plain"
      note={
        <span className="ts-think-live">
          <Pulse />
          {`writing${entry.chars > 0 ? ` ${sizeOf(entry.chars)}` : "…"}`}
        </span>
      }
    />
  );
}

/** One entry of work, dispatched by kind. All four land on the same {@link Row}. */
function Work({
  entry,
  sidechainOf,
  onOpenSidechain,
  artifacts,
  narrated,
}: {
  entry: WorkEntry;
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
  /** A status bar is saying what is happening now — see `narrated` on {@link Transcript}. */
  narrated?: boolean | undefined;
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
  if (entry.kind === "thought") return <Thought entry={entry} {...(narrated === true ? { narrated } : {})} />;
  if (entry.kind === "writing") return <Writing entry={entry} />;
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

/**
 * Which rows of a block survive the fold — the last {@link SHOWN}, and every ANSWER produced before
 * them.
 *
 * The exemption is the fold's own rule taken seriously. It hides the older half because the question
 * asked of a long agent loop is "what has it done lately"; that is true of forty greps and false of
 * the mockup you asked for, which is not a step towards the answer but a piece of it. A run that
 * drew six pages and then read four files would have folded five of the six away — the transcript
 * saying, of work the model did on request, that it was too old to look at.
 *
 * A call that delivered the operation's structured output is exempt by the same argument, and by
 * more of it: a page is a piece of the answer and that call IS the answer, so folding it would hide
 * the one row the state exists to produce behind "12 earlier steps". Agent transports emit it
 * mid-loop rather than last (the model goes on to summarise afterwards), so this is not a rare
 * shape — it is where the row normally sits.
 *
 * Indices are into the WHOLE block, and travel with the rows: they are the render keys, and a
 * slice-relative key hands one row's open/closed state to a different row every time the fold moves.
 */
export function unfoldable(entries: readonly WorkEntry[], hidden: number): Array<{ entry: WorkEntry; index: number }> {
  const rows = entries.map((entry, index) => ({ entry, index }));
  if (hidden === 0) return rows;
  return rows.filter(
    ({ entry, index }) =>
      index >= hidden || (entry.kind === "tool" && (entry.output !== undefined || producedArtifact(entry.result) !== undefined)),
  );
}

/** A stretch of work between two messages, with its older half foldable. */
function WorkBlockView({
  entries,
  sidechainOf,
  onOpenSidechain,
  artifacts,
  narrated,
}: {
  entries: WorkEntry[];
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
  /** A status bar is saying what is happening now — see `narrated` on {@link Transcript}. */
  narrated?: boolean | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const hidden = foldsAt(entries.length);
  const rows = unfoldable(entries, open ? 0 : hidden);
  // What the toggle can actually reveal. Not `hidden`: the pages exempted above are on screen
  // already, and counting them would offer to show rows nobody is hiding.
  const folded = entries.length - rows.length;
  return (
    <div className="ts-work">
      {folded > 0 ? (
        <button type="button" className="ts-fold" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="ts-chev">
            <Icon name="chevron" />
          </span>
          {open ? "Show fewer steps" : `${folded} earlier steps`}
        </button>
      ) : null}
      {/* Keyed by the entry's position in the WHOLE block, not in the visible slice. Folding shifts
          every index, so a slice-relative key hands one row's open/closed state to a different row —
          an expanded tool call's payload jumps to an unrelated line. */}
      {rows.map(({ entry, index }) => (
        <Work
          key={index}
          entry={entry}
          {...(sidechainOf !== undefined ? { sidechainOf } : {})}
          {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
          {...(artifacts !== undefined ? { artifacts } : {})}
          {...(narrated === true ? { narrated } : {})}
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
 *
 * A fourth case is not a shape but a CLAIM about what the words are. An operation that declares a
 * structured output can still be answered in text — the model writes the JSON as its message and
 * upstream binds it — and the answer then arrived as a paragraph of `{"matched": false, …}` put
 * through a markdown renderer, which is the least readable form of the one thing the state exists to
 * produce. Where main can prove the text IS the value (see `SessionOutput`), the value is drawn
 * instead, through the same {@link ValueView} every other value in the app goes through.
 */
function Message({
  entry,
  onEdit,
  scope,
  doomed = false,
}: {
  entry: MessageEntry;
  onEdit?: EditMessage | undefined;
  scope?: string | undefined;
  /** Past an armed cut: drawn faded, because it is what a rewind would delete. */
  doomed?: boolean;
}): JSX.Element {
  // Only a message the host can NAME a position for is editable, which is why this asks rather than
  // being told: the host holds the edit points, and a button offered over a message nothing can be
  // sent in place of would be a button that fails when pressed.
  const editable = onEdit !== undefined && entry.turn !== undefined && onEdit.can(entry.turn);
  // …and only one the host can name a CUT for offers the two verbs — the same question, asked of
  // the reply as well as the message, since a reply can end a conversation as well as a message can
  // begin one.
  const cut = onEdit !== undefined && entry.turn !== undefined ? onEdit.cut?.(entry.turn) : undefined;
  const store = useMessageTypes();
  const panel = useValuePanel();
  /**
   * A type asserted during THIS viewing, before any of it reaches the settings file.
   *
   * Three values, and the third is the one that needs the type: `undefined` is "nothing said here",
   * `null` is "said, and what was said is to stop asserting anything" — which is not the same as
   * never having asked, because a message inheriting the conversation's type has to be able to opt
   * back out of it. Collapsing them makes "back to what JaiRA detected" a no-op on exactly the
   * messages somebody would press it on.
   */
  const [local, setLocal] = useState<string | null | undefined>(undefined);
  const [picked, setPicked] = useState<ViewId | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [reading, setReading] = useState<MenuAnchor | null>(null);
  const [more, setMore] = useState<MenuAnchor | null>(null);
  const [copied, setCopied] = useState(false);

  // A message with no turn is a live fragment: there is no stable name to store a preference under,
  // so it gets the control and not the remembering. Keying it on the conversation would be worse
  // than forgetting — it would silently assert the type of every message in the thread.
  const msgKey = scope !== undefined && entry.turn !== undefined ? typeKeyOf(scope, entry.turn) : undefined;
  const convKey = scope !== undefined ? typeKeyOf(scope) : undefined;
  const forConversation = convKey === undefined ? undefined : store?.get(convKey);
  /** What THIS message asserts, before the conversation is consulted — kept apart because clearing
   *  has to know which of the two layers is the one actually in force. */
  const own = local === undefined ? (msgKey === undefined ? undefined : store?.get(msgKey)) : (local ?? undefined);
  const override = own ?? forConversation;

  const said = entry.text !== undefined && entry.text.length > 0;
  const value = entry.output !== undefined ? entry.output.value : (entry.text ?? "");

  /**
   * What the app would say this is if nobody had corrected it.
   *
   * The declared type first, because a slot saying `contentMediaType` is a statement and everything
   * under it is a default. Then DETECTION, which now runs on both sides of the conversation — an
   * instruction is markdown about as often as an answer is, and until this ran on user messages the
   * app's answer for one was "text" whatever was in it.
   *
   * The ROLE is the floor under detection rather than a rule over it. An answer with no structural
   * marks is still markdown, because that is what an answer is written as; anything else with no
   * marks is what somebody typed. That is the fact the transcript has relied on since it was written
   * — one side through a markdown renderer, the other through a `<pre>` — said out loud, so the chip
   * has something true to report and `viewsFor` cannot quietly re-decide it.
   */
  const given =
    detectedMime(value, entry.output?.schema !== undefined ? { schema: entry.output.schema } : {}) ??
    (entry.role === "assistant" ? "text/markdown" : "text/plain");
  const mime = override ?? given;
  const named = typeNameOf(mime);

  const hint: ViewHint = {
    mime,
    ...(entry.output?.schema !== undefined ? { schema: entry.output.schema } : {}),
  };
  const views = viewsFor(value, hint);
  // A reading you chose survives a change of type, and stops surviving the moment the new type has
  // no such reading — which is what makes "set it to Markdown" land on the rendering rather than on
  // the source you were trying to get away from.
  const view = picked !== null && views.includes(picked) ? picked : views[0]!;

  const assert = (next: string, everywhere = false): void => {
    setMenu(null);
    if (everywhere) {
      if (convKey !== undefined) store?.set(convKey, next);
      // The message's own assertion goes with it. Leaving it would make "use this everywhere" the
      // one action that cannot be undone from the message you performed it on.
      if (msgKey !== undefined) store?.set(msgKey, undefined);
      setLocal(undefined);
      return;
    }
    setLocal(next);
    if (msgKey !== undefined) store?.set(msgKey, next);
  };

  /**
   * Stop asserting — and clear the layer that is ACTUALLY in force.
   *
   * Clearing only the message's own key would be a button that does nothing on exactly the messages
   * somebody presses it on: a message inheriting the conversation's type has no assertion of its own
   * to remove, so removing it changes nothing and the type comes straight back. The menu says which
   * of the two it is about, so the row is never a surprise.
   */
  const clear = (): void => {
    setMenu(null);
    setLocal(null);
    if (msgKey !== undefined) store?.set(msgKey, undefined);
    if (own === undefined && convKey !== undefined && forConversation !== undefined) store?.set(convKey, undefined);
  };

  const copy = (): void => {
    void navigator.clipboard
      .writeText(entry.text ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2)))
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  // The tick goes back to being a copy icon on its own. A button that stays changed is a button that
  // has stopped saying what it does.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const openTypes = (at: DOMRect): void => {
    const rows = OFFERED_TYPES.map((candidate) => {
      const name = typeNameOf(candidate);
      // Where the app's own answer came from, said in a word. Only ever on the row it is true of:
      // a column of provenance beside every option would be a column that is blank most of the way
      // down, which reads as data missing rather than as a fact about two of the rows.
      const note =
        candidate === own
          ? "yours"
          : candidate === override
            ? "this thread"
            : candidate === given
              ? (mimeOfSchema(entry.output?.schema) === candidate ? "declared" : "detected")
              : undefined;
      return {
        label: name.label,
        icon: familyIcon(name.family),
        ...(note !== undefined ? { note } : {}),
        checked: candidate === mime,
        onSelect: () => assert(candidate),
      };
    });
    setMenu({
      // Under the chip and aligned to its left edge: the menu is about the control, and a list of
      // types that grew leftwards away from the word it is replacing would be pointing at nothing.
      x: at.left,
      y: at.bottom + 3,
      title: "This text is",
      items: [
        ...rows,
        ...(convKey === undefined
          ? []
          : [
              {
                label: "Use for every message here",
                separator: true,
                note: "until you say otherwise",
                onSelect: () => assert(mime, true),
              },
            ]),
        ...(override === undefined
          ? []
          : [
              // Named for the layer it clears, because they are different acts: one puts this message
              // back, the other stops the whole conversation being read that way.
              own !== undefined
                ? {
                    label: "Back to what JaiRA detected",
                    separator: convKey === undefined,
                    note: typeNameOf(given).label,
                    onSelect: clear,
                  }
                : {
                    label: "Stop using it for every message",
                    separator: false,
                    note: `back to ${typeNameOf(given).label}`,
                    onSelect: clear,
                  },
            ]),
      ],
    });
  };

  /**
   * How to READ what the type says this is — the second question, and never the first.
   *
   * The list comes from `viewsFor`, so it grows and shrinks with the type: assert JSON on a value
   * with a schema and a Form appears in here, assert Plain text and this control goes away entirely.
   * That dependency is the reason the two are separate controls rather than one long menu — a menu
   * that mixed "what this is" with "how to draw it" would offer combinations that do not exist.
   */
  const openReadings = (at: DOMRect): void => {
    setReading({
      x: at.left,
      y: at.bottom + 3,
      title: "Read it as",
      items: views.map((id) => ({
        label: READING[id].label,
        note: READING[id].hint,
        checked: id === view,
        onSelect: () => setPicked(id),
      })),
    });
  };

  const openMore = (at: DOMRect): void => {
    setMore({
      x: at.right - MENU_WIDTH,
      y: at.bottom + 3,
      items:
        panel === null
          ? []
          : [
              {
                label: "Open in context panel",
                note: "keeps it on screen while you carry on",
                onSelect: () =>
                  panel.open({
                    title: entry.output?.name ?? (entry.role === "user" ? "Message" : "Answer"),
                    value,
                    hint,
                  }),
              },
            ],
    });
  };

  /**
   * The rail: what you can DO to this message, what it is, and when it was said.
   *
   * Hidden until the pointer or the keyboard arrives, which is the whole posture — a transcript at
   * rest is the words and nothing else. Two control groups, and the divider between them is load
   * bearing: on the left are verbs, on the right are two different claims about the value. The TYPE
   * is what this text is, and it can be wrong. The READING is how that type is being shown, and it
   * can only be preferred. One control used to do both jobs and did neither, which is how a plan
   * that was markdown ended up with a `Source` button and no way to say so.
   */
  const rail = (
    <div className="ts-rail">
      <button type="button" className="ts-act" title="Copy" aria-label="Copy" onClick={copy}>
        <Icon name={copied ? "check" : "copy"} />
      </button>
      {editable ? (
        <button
          type="button"
          className="ts-act"
          title="Edit"
          aria-label="Edit this message"
          onClick={() => onEdit.edit(entry.turn!, entry.text ?? "")}
        >
          <Icon name="pencil" />
        </button>
      ) : null}
      {cut !== undefined && onEdit?.rewind !== undefined ? (
        <button
          type="button"
          className="ts-act"
          title={
            cut === "before"
              ? "Rewind to before this message — it and everything after it are deleted"
              : "Rewind to this reply — everything after it is deleted"
          }
          aria-label={cut === "before" ? "Rewind to before this message" : "Rewind to this reply"}
          onClick={() => onEdit.rewind!(entry.turn!, entry.text ?? "")}
        >
          <Icon name="rewind" />
        </button>
      ) : null}
      {cut !== undefined && onEdit?.fork !== undefined ? (
        <button
          type="button"
          className="ts-act"
          title={
            cut === "before"
              ? "Fork before this message — a new conversation that shares everything up to here"
              : "Fork after this reply — a new conversation that shares everything up to here"
          }
          aria-label={cut === "before" ? "Fork before this message" : "Fork after this reply"}
          onClick={() => onEdit.fork!(entry.turn!, entry.text ?? "")}
        >
          <Icon name="choice" />
        </button>
      ) : null}
      {said || entry.output !== undefined ? (
        <>
          <span className="ts-rail-cut" />
          {entry.output?.name !== undefined ? <span className="ts-slot">{entry.output.name}</span> : null}
          <button
            type="button"
            className={override !== undefined ? "ts-type on" : "ts-type"}
            title={`${named.label} — ${mime}${override !== undefined ? `, set by you (JaiRA said ${typeNameOf(given).label})` : ""}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => openTypes(e.currentTarget.getBoundingClientRect())}
          >
            <Icon name={familyIcon(named.family)} />
            {named.label}
            <span className="ts-car">▾</span>
          </button>
          {/* Its own dropdown beside the type's, not a segmented strip, because the number of
              renderings is not fixed: a schema'd JSON value has three (a form, the highlighted
              value, the serialization) and a markdown string has two. A strip that is two buttons
              wide here and four there is a control that moves everything after it, and a rail is a
              row of things whose positions people learn.

              The same rule `ValueView` keeps applies: absent where there is nothing to choose. It
              is no longer a dead end, because the control beside it changes what a type admits. */}
          {views.length > 1 ? (
            <button
              type="button"
              className={picked !== null ? "ts-read on" : "ts-read"}
              title={READING[view].hint}
              aria-haspopup="menu"
              aria-expanded={reading !== null}
              onClick={(e) => openReadings(e.currentTarget.getBoundingClientRect())}
            >
              {READING[view].label}
              <span className="ts-car">▾</span>
            </button>
          ) : null}
        </>
      ) : null}
      <span className="grow" />
      <span className="ts-clock" title={fullClockOf(entry.at)}>
        {stampOf(entry.at)}
      </span>
      {panel !== null ? (
        <button
          type="button"
          className="ts-act"
          title="What else can be done with this"
          aria-haspopup="menu"
          aria-expanded={more !== null}
          onClick={(e) => openMore(e.currentTarget.getBoundingClientRect())}
        >
          …
        </button>
      ) : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {reading !== null ? <ContextMenu anchor={reading} onClose={() => setReading(null)} /> : null}
      {more !== null ? <ContextMenu anchor={more} onClose={() => setMore(null)} /> : null}
    </div>
  );

  /**
   * The words, through the one viewer the rest of the app uses.
   *
   * `chrome={false}` because the controls are in the rail, and `fence` because a transcript reads
   * rather than edits — see `ValueView`'s note on both. What this replaced was three separate
   * answers to "how is a message drawn": a markdown call, a `<pre>`, and a `ValueView` for the one
   * case that had a structured output. They disagreed, which is why only one of the three ever had
   * a way back to the source.
   */
  const body = (
    <ValueView value={value} hint={hint} view={view} chrome={false} />
  );

  const day = dayLabelOf(entry.at);
  const stamped = day !== undefined ? { "data-day": day } : {};

  const fade = doomed ? " ts-doomed" : "";
  if (entry.role === "user") {
    return (
      <div className={`ts-msg ts-msg-user${fade}`} {...stamped}>
        <div className="ts-bubble">{said ? body : <span className="sub">(empty)</span>}</div>
        {rail}
      </div>
    );
  }
  if (entry.role === "assistant") {
    return (
      <div className={`ts-msg ts-msg-assistant${fade}`} {...stamped}>
        {said || entry.output !== undefined ? body : <p className="empty">(no answer was recorded)</p>}
        {rail}
      </div>
    );
  }
  return (
    <div className={`ts-msg ts-msg-aside${fade}`} {...stamped}>
      <span className="ts-tag">{entry.role}</span>
      {/* Shown as written, which is what `text/plain` now MEANS rather than merely what happened to
          happen: this is the input, and reformatting an input is how you stop being able to see what
          was actually sent. The chip is still there for the day one of them is a pasted diff. */}
      {said ? body : null}
      {rail}
    </div>
  );
}

/** What each reading is called in the rail, and what its tooltip says it does. */
const READING: Record<ViewId, { label: string; hint: string }> = {
  markdown: { label: "Rendered", hint: "As markdown, rendered" },
  html: { label: "Rendered", hint: "As HTML, rendered" },
  media: { label: "Preview", hint: "Play or show it" },
  changes: { label: "Files", hint: "The files this changes, as a diff" },
  code: { label: "Code", hint: "Highlighted, in an editor" },
  text: { label: "Source", hint: "The text exactly as it was written" },
  json: { label: "JSON", hint: "Highlighted, with what each key means" },
  data: { label: "Data", hint: "Parsed — the value this document denotes" },
  patch: { label: "Diff", hint: "The change this patch describes" },
  table: { label: "Table", hint: "As rows and columns" },
  form: { label: "Form", hint: "As the fields its schema declares" },
};

/**
 * The pause between two messages — space sized to the silence, with a word in it.
 *
 * No rule across the page. A ruled separator is a horizontal line through a column of prose, and it
 * reads as the end of the document rather than as a gap in a conversation; the space itself does
 * most of the telling, and the label only has to name what the space already showed.
 */
function GapMark({ gap }: { gap: Gap }): JSX.Element {
  return <span className={`ts-gap ts-gap-${gap.size}`}>{gap.label}</span>;
}

/**
 * Which day you are looking at, floating over the transcript.
 *
 * The other half of the answer the gaps give. A gap says how long a pause was and never says a
 * date — that is this, and it is a property of WHERE YOU ARE rather than of any one message, which
 * is why it is one chip for a conversation of any length instead of a stamp on every line.
 *
 * It fades rather than disappearing when the scrolling stops. A control that comes and goes at the
 * edge of vision is a flicker; one that sits at a third of its opacity is a thing you can look at
 * when you want the answer and never notice when you do not.
 */
export function DayChip({ scroller }: { scroller: RefObject<HTMLDivElement | null> }): JSX.Element | null {
  const [day, setDay] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback((): void => {
    const box = scroller.current;
    if (box === null) return;
    const top = box.getBoundingClientRect().top;
    let found: string | null = null;
    for (const node of Array.from(box.querySelectorAll<HTMLElement>("[data-day]"))) {
      // The last message whose top edge has passed under the chip is the one the chip names. Reading
      // rectangles rather than offsets because the messages are several elements deep inside their
      // own positioned ancestors, and `offsetTop` would be measured against a different one per row.
      if (node.getBoundingClientRect().top - top > 30) break;
      found = node.dataset["day"] ?? found;
    }
    setDay((was) => (was === found ? was : (found ?? was)));
  }, [scroller]);

  useEffect(() => {
    const box = scroller.current;
    if (box === null) return;
    const onScroll = (): void => {
      setMoving(true);
      read();
      if (idle.current !== null) clearTimeout(idle.current);
      idle.current = setTimeout(() => setMoving(false), 900);
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    read();
    return () => {
      box.removeEventListener("scroll", onScroll);
      if (idle.current !== null) clearTimeout(idle.current);
    };
  }, [scroller, read]);

  // Nothing to say until something on screen is stamped — an empty conversation, or one whose
  // records carry no times at all.
  if (day === null) return null;
  return (
    <div className="ts-daychip-hold" aria-hidden="true">
      <span className={moving ? "ts-daychip on" : "ts-daychip"}>{day}</span>
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
export function Pulse(): JSX.Element {
  return (
    <span className="ts-pulse" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * What the model is doing right now, in one fixed place.
 *
 * The generalisation of the writing row, and it earns its place by being the only thing on screen
 * whose POSITION does not depend on how much has happened. Everything else that announces a live run
 * is a row in stream order — a thinking counter, a waiting call, a page being written — and stream
 * order puts the answer to "is it still going" wherever the conversation happens to have reached.
 * Four screens up, behind a closed fold, under a tall artifact. This is at the bottom, always, and
 * it says one sentence.
 *
 * It holds NO state. {@link liveStatusOf} reads it off the entries and the tail that are already
 * being rendered, so there is nothing here that can disagree with the transcript above it — which is
 * the way a status line normally goes wrong.
 *
 * The transcript stops repeating what this says: see `narrated` on {@link Transcript}. Two places
 * counting the same seconds, six pixels apart, is worse than either alone.
 */
export function LiveStatusBar({ status, onJump }: { status: LiveStatus; onJump?: (() => void) | undefined }): JSX.Element {
  const since = status.kind === "writing" || status.kind === "working" ? undefined : status.since;
  const elapsed = useElapsed(since, true);
  // Sized, not timed. The question asked of a page being written is how big it is getting; the
  // question asked of everything else is how long it has been.
  const figure =
    status.kind === "writing"
      ? status.chars > 0
        ? sizeOf(status.chars)
        : undefined
      : elapsed !== undefined
        ? thoughtTime(elapsed)
        : undefined;
  return (
    <div className="ts-status">
      <Pulse />
      <span className="ts-status-verb">{verbOf(status)}</span>
      <span className="ts-status-what ellip">{whatOf(status)}</span>
      {figure !== undefined ? <span className="ts-status-figure">{figure}</span> : null}
      {/* Only when the reader has gone somewhere else. The bar is where they would look to find out
          something is still happening, so it is also where the way back belongs. */}
      {onJump !== undefined ? (
        <button type="button" className="ts-status-jump" onClick={onJump}>
          Jump to live ↓
        </button>
      ) : null}
    </div>
  );
}

/** The verb, present tense — the whole of what the line is for. */
function verbOf(status: LiveStatus): string {
  if (status.kind === "writing") return "Writing";
  if (status.kind === "answering") return "Answering";
  if (status.kind === "thinking") return "Thinking";
  if (status.kind === "running") return "Running";
  return "Working";
}

/** What it is doing it TO, when there is something to name. */
function whatOf(status: LiveStatus): string {
  if (status.kind === "writing") return status.path ?? status.name;
  if (status.kind === "running") return status.summary.length > 0 ? `${status.name} · ${status.summary}` : status.name;
  return "";
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
  narrated,
  scope,
  doomedFrom,
}: {
  session?: SessionView | null;
  entries: TranscriptEntry[];
  /**
   * An ARMED cut: every message from this turn on is what a rewind would delete, drawn faded under
   * one counted line, so "everything after it" is a claim the reader can check before agreeing to
   * it. Absent is the ordinary transcript.
   */
  doomedFrom?: number | undefined;
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
  /**
   * Something ELSE is saying what is happening right now — a {@link LiveStatusBar}.
   *
   * Set by a surface that has somewhere fixed to put the live state, and it makes the transcript
   * stop duplicating it: the row for a call still being written goes (it is a now-only fact, never
   * recorded, and the bar is a better place for it), and the thinking row keeps its text and its
   * settled duration but gives up its live counter.
   *
   * What it does NOT suppress is anything that survives the turn. "Thought for 12.4 seconds" is a
   * fact about a block that finished and belongs beside it forever; the bar is only ever about the
   * present, so the two never overlap once a turn has landed.
   */
  narrated?: boolean | undefined;
  /**
   * What to remember a reader's type corrections under — see `messageTypes.ts`.
   *
   * A name for THIS conversation, supplied by whatever is drawing it: a task id in the Chat view, a
   * session id in a run's bands. Absent ⇒ the chip still works and nothing is written down, which is
   * the right posture for a transcript nobody owns — a subagent's side conversation, a fork's
   * abandoned branch — where a stored preference would be keyed to something that never comes back.
   */
  scope?: string | undefined;
}): JSX.Element {
  // Dropped rather than never built: `entriesOf` has one reading of the tail and every surface gets
  // the same one, so which rows a surface DRAWS is a rendering decision and belongs here.
  const shown = narrated === true ? entries.filter((entry) => entry.kind !== "writing") : entries;
  if (shown.length === 0) {
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
  const blocks = blocksOf(shown);
  // What an armed cut takes, counted once: the messages at or past the turn, replies included.
  const doomedCount =
    doomedFrom === undefined
      ? 0
      : shown.filter((entry) => entry.kind === "message" && entry.turn !== undefined && entry.turn >= doomedFrom).length;
  let doomed = false;
  return (
    <div className="ts">
      {blocks.map((block, i) => {
        // Once a doomed message has gone by, everything under it goes too: the tool calls of a
        // doomed reply carry no turn of their own and are read by their place in the flow.
        const crossed =
          !doomed && doomedFrom !== undefined && block.kind === "message" && block.turn !== undefined && block.turn >= doomedFrom;
        if (crossed) doomed = true;
        const cutLine = crossed ? (
          <div className="ts-cut" key={`cut-${i}`} role="note">
            {doomedCount} message{doomedCount === 1 ? "" : "s"} below this line will be deleted
          </div>
        ) : null;
        // The pause before this block, drawn as space rather than as a rule — see `gapBetween`.
        // Measured between BLOCKS rather than between messages, because a stretch of forty tool
        // calls is not a silence: the agent was working, and marking that as "3 hours later" would
        // be annotating the run as if nobody had been there.
        const gap = gapBetween(endOfBlock(blocks[i - 1]), startOfBlock(block));
        const before = gap === undefined ? null : <GapMark key={`gap-${i}`} gap={gap} />;
        if (block.kind === "work")
          return (
            <Fragment key={i}>
              {before}
              {cutLine}
              <div className={doomed ? "ts-doomed" : undefined}>
              <WorkBlockView
                entries={block.entries}
                {...(sidechainOf !== undefined ? { sidechainOf } : {})}
                {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
                {...(artifacts !== undefined ? { artifacts } : {})}
                {...(narrated === true ? { narrated } : {})}
              />
              </div>
            </Fragment>
          );
        if (block.kind === "message")
          return (
            <Fragment key={i}>
              {before}
              {cutLine}
              <Message
                entry={block}
                {...(onEdit !== undefined ? { onEdit } : {})}
                {...(scope !== undefined ? { scope } : {})}
                doomed={doomed}
              />
            </Fragment>
          );
        return (
          <div key={i} className={`ts-msg ts-msg-assistant ts-live${doomed ? " ts-doomed" : ""}`}>
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


