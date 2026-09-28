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
import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import {
  artifactOf,
  mimeOfFenceLang,
  mimeOfPath,
  typeNameOf,
  viewsFor,
  type InstanceNode,
  type ServedArtifact,
  type SessionView,
  type ViewId,
} from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { APPROVAL_PROMPT_FUNCTION, choicesOfQuestions, toolDisplayOf, workflowOutcomeOf, workflowToolOf, type AgentQuestion, type MessageAuthor, type SettledByView, type WorkflowOutcome } from "@jaira/shared/browser";
import { answersOfAnsweredText, answersOfValue, ChoiceList, ChoiceSteps, type Answer } from "./choices";
import { Markdown } from "./markdown";
import { ValueView } from "./valueView";
import { CompactionLine, TurnContext } from "./usageMeters";
import type { ContextReading } from "@jaira/shared/browser";
import { familyIcon, Icon } from "./icons";
import { ContextMenu, MENU_WIDTH, type MenuAnchor } from "./menu";
import { typeKeyOf, useMessageTypes } from "./messageTypes";
import { useValuePanel } from "./valuePanel";
import { WorkLookContext, WorkSummary } from "./workSummaryView";
import { approvalAboutOf, approvalAnswerOf, approvalWordsOf, isApprovalCall, isIdle } from "./workSummary";
import { ShellLine } from "./shellLine";
import {
  blocksOf,
  dayLabelOf,
  endOfBlock,
  gapBetween,
  iconOf,
  shellLineOf,
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




// How a message is read, its rail's menus and its clock — `messageReading.ts`, shared with the universal
// copy (decision 0015).
import { READING, copyTextOf, cutTitleOf, fullClockOf, messageReadingOf, readingMenuOf, stampOf, typeMenuOf } from "./messageReading";

// `sizeOf`, `thoughtTime` and what the live status line says live in `liveStatusModel.ts`, shared with the
// universal copy (decision 0015).
import { sizeOf, statusFigureOf, thoughtTime, verbOf, whatOf } from "./liveStatusModel";
export { sizeOf, thoughtTime };

// `durationOf` and `useElapsed` live in `runActivityModel.ts`, shared with the universal copy (decision 0015).
import { clockOf, durationOf, useElapsed } from "./runActivityModel";
export { clockOf, durationOf, useElapsed };


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
  called,
  server,
  preview,
  command,
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
  /** The name the agent actually called, when {@link name} is its display title — the name's tooltip. */
  called?: string;
  /** The MCP server a call went to, when that is somebody else's — a quiet word after the name. */
  server?: string;
  preview: string;
  /** The preview is this command line: drawn in the colours of its parts, as an approval draws it. */
  command?: string | undefined;
  tone: Tone;
  /** The verdict at the end of the line, when there is one to give. */
  mark?: "ok" | "bad" | "waiting" | "cut";
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
      {name !== undefined ? (
        <span className="ts-name" {...(called !== undefined && called !== name ? { title: called } : {})}>
          {name}
        </span>
      ) : null}
      {server !== undefined ? <span className="ts-server">{server}</span> : null}
      <span className="ts-preview ellip">{command !== undefined ? <ShellLine line={command} /> : preview}</span>
      {note !== undefined ? <span className="ts-note">{note}</span> : null}
      <span className="ts-at">{clockOf(entry.at)}</span>
      <span className="ts-chev">{canOpen ? <Icon name="chevron" /> : null}</span>
      <span className="ts-mark">
        {mark === "ok" ? <Icon name="check" /> : mark === "bad" ? <Icon name="cross" /> : mark === "cut" ? <span title="No result was recorded">–</span> : null}
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

/**
 * What a `move` or a `start` DID, under the row that did it (decision 0005 "What draws").
 *
 * The decision's line — "adopted into **feature** as `product` · standing at `ux`" — is a fact about
 * the work, not about the call, so it is drawn as the note it is: the same glyph, verb and monospace
 * ending a `made` or `entered` note uses on the rail. It renders INLINE, under the tool row, because
 * that is where the caller put it and a component has no opinion about its place; nothing here reads
 * a task or a journal, only what the tool answered.
 *
 * `null` for a call that was refused, or one that only looked: a refusal is already the row's `bad`
 * mark plus its result, and saying it twice in different words is worse than saying it once.
 */
function WorkflowOutcome({ result }: { result: JsonValue }): JSX.Element | null {
  const outcome = workflowOutcomeOf(result);
  return outcome === undefined ? null : <OutcomeNote outcome={outcome} />;
}

/**
 * The note itself — one reading of `WorkflowOutcome`, drawn wherever the caller puts it: under the call
 * in a one-column transcript, or as a row on the rail (`NoteRow`, from the `jaira.moved` row) where the
 * conversation has one. The words are the same in both places because the reading is.
 */
export function OutcomeNote({ outcome }: { outcome: WorkflowOutcome }): JSX.Element {
  const { verb, standsAt: where, workflow, adoptedAs, held, through } = outcome;
  // A FAST-FORWARD (decision 0005 §4): the move did not land anywhere yet — the states between are
  // running, and this conversation is what answers them. The note says where it is going and
  // through what, in the words the strip below uses.
  if (verb === "fast-forwarding to") {
    return (
      <div className="sb-note step sb-connected" role="note">
        <Icon name="workflow" className="sb-note-icon" />
        <span className="sb-note-verb">fast-forwarding to</span>
        <span className="sb-note-text">
          <b>{where.split("/").pop()}</b>
          {through !== undefined && through.length > 0 ? ` · through ${through.join(", ")}` : null}
        </span>
        {workflow !== undefined ? (
          <span className="sb-note-state mono ellip" title={workflow}>
            {workflow}
          </span>
        ) : null}
      </div>
    );
  }
  // `start` says what was mounted and how; `move` says which of the three resolutions happened, and
  // an adoption says what the task became in the workflow that took it.
  return (
    <div className="sb-note step sb-connected" role="note">
      <Icon name="workflow" className="sb-note-icon" />
      <span className="sb-note-verb">{verb}</span>
      {adoptedAs !== undefined && workflow !== undefined ? (
        <span className="sb-note-text">
          <b>{workflow}</b> as <span className="mono">{adoptedAs}</span> · standing at
        </span>
      ) : held === true ? (
        <span className="sb-note-text">one task per element, held · standing at</span>
      ) : null}
      <span className="sb-note-state mono ellip" title={where}>
        {where}
      </span>
    </div>
  );
}

/**
 * A question the CONTROL CONVERSATION answered (decision 0005 §4): who, how sure, and the way back —
 * under a settled gate, and under an agent's `AskUserQuestion` block alike.
 *
 * In the accent and not in `ok`: it is a judgement somebody may want back, not a confirmation. The
 * confidence is the number the conversation gave and the one `autopilot.askBelow` was held against.
 * "Answer it yourself" is a REWIND to the state's entry — the question is asked again and the
 * fast-forward, if it is still going, is over.
 */
export function AnsweredForYou({ by, onAnswerYourself }: { by: SettledByView; onAnswerYourself?: (() => void) | undefined }): JSX.Element {
  return (
    <div className="gate-settled-by by-control" data-testid="answered-for-you">
      <Icon name="think" />
      <div>
        Answered for you by <b>the conversation</b> <span className="conf">· confidence {by.confidence.toFixed(2)}</span>
      </div>
      <span className="grow" />
      {onAnswerYourself !== undefined ? (
        <button type="button" className="quiet" onClick={onAnswerYourself} title="Rewind to this question, so it is asked again and answered by you">
          Answer it yourself
        </button>
      ) : null}
    </div>
  );
}

/**
 * What a surface lends the CALL rows of its transcript — the placement decisions a transcript cannot
 * make for itself (a component has no opinion about its place).
 */
/**
 * A subagent's conversation, under the call that spawned it: a line naming it, that unfolds it here —
 * a conversation inside a conversation renders as one, same component, one step further in,
 * because it is one — and, where the host can stand in it, walks into it.
 */
function SidechainDoor({
  call,
  name,
  entries,
  running,
  onOpenSidechain,
  artifacts,
}: {
  call: string;
  name: string;
  entries: TranscriptEntry[] | undefined;
  /** The subagent is at work exactly while the call that spawned it is still running. */
  running: boolean;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const messages = entries?.filter((entry) => entry.kind === "message").length ?? 0;
  return (
    <div className={`ts-sidechain${open ? " open" : ""}`}>
      <div className="ts-sidechain-head">
        {entries !== undefined ? (
          <button type="button" className="ts-sidechain-fold" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            <span className="ts-chev">
              <Icon name="chevron" />
            </span>
            <span>
              Subagent conversation · {messages === 1 ? "1 message" : `${messages} messages`}
              {running ? " · working" : ""}
            </span>
          </button>
        ) : (
          <span>Subagent conversation</span>
        )}
        {onOpenSidechain !== undefined ? (
          // The doorway as NAVIGATION: the same conversation, as the last element of the address
          // instead of a fold inside a row — which is what makes it a place you can stand in, and walk
          // back out of.
          <button type="button" className="ts-sidechain-open" onClick={() => onOpenSidechain(call, name)}>
            walk in →
          </button>
        ) : null}
      </div>
      {open && entries !== undefined ? (
        <Transcript
          entries={entries}
          working={running}
          {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
          {...(artifacts !== undefined ? { artifacts } : {})}
        />
      ) : null}
    </div>
  );
}

export interface CallSurface {
  /**
   * Where a workflow tool's note goes. `inline` (the default) draws it under the call — right for a
   * one-column conversation. `rail`: the host draws it as a row beside the panel, from the journal
   * (`jaira.moved`), so the call's row says nothing more.
   */
  outcomes?: "inline" | "rail";
  /** Take back an answer the conversation gave — the rewind "Answer it yourself" is. Absent ⇒ no button. */
  onAnswerYourself?: ((by: SettledByView) => void) | undefined;
}

function Tool({
  entry,
  open,
  sidechainOf,
  onOpenSidechain,
  artifacts,
  calls,
}: {
  entry: ToolEntry;
  /** See `open` on {@link Work}. */
  open: boolean;
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
  calls?: CallSurface | undefined;
}): JSX.Element {
  const sub = entry.sidechain !== undefined && sidechainOf !== undefined ? sidechainOf(entry.sidechain) : undefined;
  const asked = askedOf(entry);
  // No answer recorded is one of two different facts: the call is still running (the record is still
  // being written, and this is its last stretch), or it never answered (the record went on, or ended,
  // without one). Only the first may be called running.
  const unanswered = entry.ok === undefined && entry.result === undefined;
  const running = unanswered && open;
  // What the crumb will read: the call's first argument is the Task's short description, which is
  // the one name a person chose for this subagent. The tool's own name is the honest fallback.
  const display = toolDisplayOf(entry.name);
  const chainName = `⑂ ${entry.summary.length > 0 ? entry.summary : display.title}`;
  const produced = producedArtifact(entry.result);
  // What the call itself says its payload is — see {@link pathMimeOf}. Read from the ARGUMENTS and
  // applied to what came back, because a file's type is a property of the file, not of the string
  // a tool happened to return.
  const pathMime = pathMimeOf(entry.args);
  // The approval prompt, a tool the tool called: its verdict is its name, and who, how far and after
  // how long are the rest of the line (the person, 2026-09-26).
  if (isApprovalCall(entry)) {
    const words = approvalWordsOf(entry);
    return (
      <Row
        entry={entry}
        name={words.name}
        called={entry.name}
        preview={words.preview}
        command={approvalAnswerOf(entry) === undefined ? approvalAboutOf(entry).command : undefined}
        prose={approvalAnswerOf(entry) !== undefined}
        tone={words.tone}
        {...(words.mark !== undefined ? { mark: words.mark === "waiting" && !(unanswered && open) ? "cut" : words.mark } : {})}
      />
    );
  }
  return (
    <Row
      entry={entry}
      name={display.title}
      called={entry.name}
      {...(display.server !== undefined ? { server: display.server } : {})}
      preview={entry.sidechain !== undefined ? `⑂ ${entry.summary}` : entry.summary}
      command={entry.sidechain === undefined ? shellLineOf(entry) : undefined}
      tone={entry.ok === false ? "bad" : "plain"}
      mark={entry.ok === undefined ? (running || !unanswered ? "waiting" : "cut") : entry.ok ? "ok" : "bad"}
      {...(entry.sidechain !== undefined && (sub !== undefined || onOpenSidechain !== undefined)
        ? {
            // The subagent's conversation is what this call DID — a conversation of its own, the call's
            // child — so its door is on the row without being asked for, not behind the row's fold
            // with the arguments (the person, 2026-09-26: "i thought we had subagents create child
            // conversations, no? it currently is just listed as a tool use").
            shown: (
              <SidechainDoor
                call={entry.sidechain}
                name={chainName}
                entries={sub}
                running={running}
                {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
                {...(artifacts !== undefined ? { artifacts } : {})}
              />
            ),
          }
        : workflowToolOf(entry.name) !== undefined && entry.result !== undefined && entry.ok !== false
        ? // The host draws the note on its rail when it has one; then the row is only the call.
          calls?.outcomes === "rail"
          ? {}
          : { shown: <WorkflowOutcome result={entry.result} /> }
        : asked !== undefined
        ? {
            // The question the agent put to the person, and their answer, drawn under the line
            // without being asked for: it is the one call in a transcript whose arguments a person
            // wrote half of. Keyed on whether it has been answered, so a row that was in flight
            // redraws with the answer rather than keeping its empty state. When the control
            // conversation gave the answer, the block says so — as a settled gate does.
            shown: (
              <>
                <AskedQuestions key={asked.answers === undefined ? "asking" : "answered"} questions={asked.questions} answers={asked.answers} />
                {entry.settledBy !== undefined ? (
                  <AnsweredForYou
                    by={entry.settledBy}
                    {...(calls?.onAnswerYourself !== undefined ? { onAnswerYourself: () => calls.onAnswerYourself!(entry.settledBy!) } : {})}
                  />
                ) : null}
              </>
            ),
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
          <Payload label="arguments" value={entry.args} {...(artifacts !== undefined ? { artifacts } : {})} />
          {/* A call with no result says which kind of "none" it is — still running, or never answered —
              which is different from showing an empty one, and why this is not an empty block. */}
          {unanswered ? (
            <div className="ts-payload ts-payload-empty">
              {running ? "still running" : "no result was recorded — the conversation went on without this call answering"}
            </div>
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
 * One block of reasoning — and how long it took, which is the question actually being asked of it.
 *
 * A finished block states its duration ("Thought for 12.4 seconds"); a block still being written
 * counts up in tenths beside a pulse, because a model that has been thinking for ninety seconds and
 * one that has stalled look identical without a number that moves. The duration is the turn's
 * thinking-start → answer-start, so it is the wait a person actually experienced, not the length of
 * the text that came out of it.
 */
function Thought({ entry, narrated, open }: { entry: ThoughtEntry; narrated?: boolean | undefined; open: boolean }): JSX.Element {
  // Live only while nothing else is counting these seconds. A bar six pixels below saying
  // "Thinking · 12.4 seconds" makes this one a second opinion, and two clocks on one wait is worse
  // than either — but only the LIVE half defers: the duration a finished block states is a fact
  // about that block, and belongs beside it whatever is happening now.
  // And only while the record is still being written: a thought left marked live by a tail that
  // outlived its turn is a thought that stopped, and a counter on it would climb forever.
  const live = entry.live === true && open && narrated !== true;
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
function Writing({ entry, open }: { entry: WritingEntry; open: boolean }): JSX.Element {
  return (
    <Row
      entry={entry}
      name={toolDisplayOf(entry.name).title}
      called={entry.name}
      preview={entry.path ?? ""}
      tone="plain"
      note={
        open ? (
          <span className="ts-think-live">
            <Pulse />
            {`writing${entry.chars > 0 ? ` ${sizeOf(entry.chars)}` : "…"}`}
          </span>
        ) : (
          <span className="ts-think-took">{`stopped while being written${entry.chars > 0 ? ` (${sizeOf(entry.chars)})` : ""}`}</span>
        )
      }
    />
  );
}

/** One entry of work, dispatched by kind. All four land on the same {@link Row}. */
function Work({
  entry,
  open,
  sidechainOf,
  onOpenSidechain,
  artifacts,
  narrated,
  calls,
}: {
  entry: WorkEntry;
  /**
   * The row's stretch is the last thing in a record still being written — the ONLY place anything can
   * still be happening. What a row says is live (a call "still running", a thought's counter, a call
   * being written) it says only when this is true.
   */
  open: boolean;
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
  /** A status bar is saying what is happening now — see `narrated` on {@link Transcript}. */
  narrated?: boolean | undefined;
  calls?: CallSurface | undefined;
}): JSX.Element {
  if (entry.kind === "tool") {
    return (
      <Tool
        entry={entry}
        open={open}
        {...(sidechainOf !== undefined ? { sidechainOf } : {})}
        {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
        {...(artifacts !== undefined ? { artifacts } : {})}
        {...(calls !== undefined ? { calls } : {})}
      />
    );
  }
  if (entry.kind === "thought") return <Thought entry={entry} open={open} {...(narrated === true ? { narrated } : {})} />;
  if (entry.kind === "writing") return <Writing entry={entry} open={open} />;
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
 * The rows no summary may hide — drawn under it, whatever it says.
 *
 * The same argument the old fold made for its exemptions, and for the same rows: a page the model
 * drew, the call that delivered the operation's output, a question the agent put to the person (half
 * of which the person wrote), what a workflow tool did and a subagent's conversation are not steps
 * towards the answer, they are pieces of it. A summary that counted them into "3 commands · 2 edited" would be saying, of work done
 * on request, that it was bookkeeping.
 */
export function keptUnderSummary(entry: WorkEntry, calls?: CallSurface): boolean {
  if (entry.kind !== "tool") return false;
  // A subagent's call: its conversation is a child of this one, not a step of it.
  if (entry.sidechain !== undefined) return true;
  if (entry.output !== undefined || producedArtifact(entry.result) !== undefined || askedOf(entry) !== undefined) return true;
  return workflowToolOf(entry.name) !== undefined && entry.result !== undefined && entry.ok !== false && calls?.outcomes !== "rail";
}

/**
 * A stretch of work between two messages: one line is its own row, and more are summarised — phases,
 * chips and the latest rows, as `workSummaryView.tsx` draws them.
 */
function WorkBlockView({
  entries,
  working,
  sidechainOf,
  onOpenSidechain,
  artifacts,
  narrated,
  calls,
}: {
  entries: WorkEntry[];
  /** The agent is at work in this stretch now: it is the last thing in a record still being written. */
  working: boolean;
  sidechainOf?: SidechainOf | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  artifacts?: ArtifactSurface | undefined;
  /** A status bar is saying what is happening now — see `narrated` on {@link Transcript}. */
  narrated?: boolean | undefined;
  calls?: CallSurface | undefined;
}): JSX.Element | null {
  const look = useContext(WorkLookContext);
  const rowOf = (index: number): ReactNode => (
    <Work
      entry={entries[index]!}
      open={working}
      {...(sidechainOf !== undefined ? { sidechainOf } : {})}
      {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
      {...(artifacts !== undefined ? { artifacts } : {})}
      {...(narrated === true ? { narrated } : {})}
      {...(calls !== undefined ? { calls } : {})}
    />
  );
  // A stretch of nothing but rate limits and notes did no work: with those hidden down to the stretch,
  // it is not drawn at all — not even its "Every step" line.
  if ((look.notes === "hide-blocks" || look.notes === "hide") && isIdle(entries, entries.map((_, i) => i))) return null;
  // One line has nothing to summarise: a chip saying "1 file" over the row it counts is the row twice.
  if (entries.length === 1) return <div className="ts-work">{rowOf(0)}</div>;
  const kept = entries.flatMap((entry, index) => (keptUnderSummary(entry, calls) ? [index] : []));
  return <WorkSummary entries={entries} working={working} kept={kept} rowOf={rowOf} clock={clockOf} />;
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
  contextBefore,
  workflow,
}: {
  entry: MessageEntry;
  /** The state whose conversation this is — what a message the workflow wrote names, and opens. */
  workflow?: string | undefined;
  onEdit?: EditMessage | undefined;
  scope?: string | undefined;
  /** The reading on the answer before this one — what "+46% since the reply before" is measured from. */
  contextBefore?: ContextReading | undefined;
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

  // What the app says this is, what it is read as, and how — `messageReading.ts`, shared with the
  // universal copy (decision 0015).
  const { given, mime, named, hint, views, view } = messageReadingOf(entry, value, override, picked);

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
      .writeText(copyTextOf(entry, value))
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
    setMenu({
      // Under the chip and aligned to its left edge: the menu is about the control, and a list of
      // types that grew leftwards away from the word it is replacing would be pointing at nothing.
      x: at.left,
      y: at.bottom + 3,
      title: "This text is",
      items: typeMenuOf({ entry, own, override, given, mime, conversation: convKey !== undefined, assert, clear }),
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
      items: readingMenuOf(views, view, setPicked),
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
          title={cutTitleOf("rewind", cut).title}
          aria-label={cutTitleOf("rewind", cut).label}
          onClick={() => onEdit.rewind!(entry.turn!, entry.text ?? "")}
        >
          <Icon name="rewind" />
        </button>
      ) : null}
      {cut !== undefined && onEdit?.fork !== undefined ? (
        <button
          type="button"
          className="ts-act"
          title={cutTitleOf("fork", cut).title}
          aria-label={cutTitleOf("fork", cut).label}
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
      {/* How full the conversation was after this turn — read off the turn's own entry. */}
      {entry.context !== undefined ? <TurnContext context={entry.context} before={contextBefore} /> : null}
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
  // Said to the model and NOT typed by the person: still on the right, where everything said to the
  // model is, and named by where it came from.
  const openState = panel?.openState;
  const source =
    entry.by !== undefined ? (
      <MessageSource by={entry.by} workflow={workflow} {...(workflow !== undefined && openState !== undefined ? { onOpen: () => openState(workflow) } : {})} />
    ) : null;
  if (entry.role === "user") {
    return (
      <div className={`ts-msg ts-msg-user${entry.by !== undefined ? " ts-msg-sent" : ""}${fade}`} {...stamped}>
        {source}
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
      <span className="ts-tag">
        {entry.role}
        {source}
      </span>
      {/* Shown as written, which is what `text/plain` now MEANS rather than merely what happened to
          happen: this is the input, and reformatting an input is how you stop being able to see what
          was actually sent. The chip is still there for the day one of them is a pasted diff. */}
      {said ? body : null}
      {rail}
    </div>
  );
}

/**
 * The badge on a message the person did not type — WHO wrote it, in a word, with the rest on the
 * tooltip. Exported for the snapshot specimens, which draw it over the real stylesheet.
 */
export function MessageSource({ by, workflow, onOpen }: { by: MessageAuthor; workflow?: string | undefined; onOpen?: (() => void) | undefined }): JSX.Element {
  const said = MESSAGE_SOURCE[by];
  // The workflow's words name the workflow they came from, and open its definition — the file
  // they were written in, which is where to read them whole and where to change them.
  if (by === "workflow" && workflow !== undefined) {
    const label = (
      <>
        <Icon name={said.icon} />
        From <span className="mono">{workflow}</span>
      </>
    );
    const title = `Written by the workflow ${workflow} — its author's words, not typed here`;
    return onOpen !== undefined ? (
      <button type="button" className={`ts-source ts-source-${by} ts-source-link`} title={`${title}. Open its definition beside the conversation.`} onClick={onOpen}>
        {label}
      </button>
    ) : (
      <span className={`ts-source ts-source-${by}`} title={title}>
        {label}
      </span>
    );
  }
  return (
    <span className={`ts-source ts-source-${by}`} title={said.title}>
      <Icon name={said.icon} />
      {said.label}
    </span>
  );
}

const MESSAGE_SOURCE: Record<MessageAuthor, { label: string; title: string; icon: "send" | "workflow" }> = {
  host: { label: "Written by JaiRA", title: "JaiRA wrote and sent this for you — you did not type it", icon: "send" },
  workflow: { label: "From the workflow", title: "The workflow's words for this call — written by its author, not typed here", icon: "workflow" },
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
  const figure = statusFigureOf(status, elapsed);
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
  calls,
  working,
}: {
  session?: SessionView | null;
  entries: TranscriptEntry[];
  /**
   * The record is still being written — the agent is at work right now, so the last stretch of work
   * is drawn as in progress. Said by the caller, which knows (a chat's task status); absent, read off
   * the session's own status.
   *
   * Never inferred from a call with no answer: a conversation can END on one — the agent stopped, the
   * process went away, the result was never written — and a record that finished that way is not one
   * still running, however its last call looks (2026-09-25: a finished chat pulsed "Running git fetch…"
   * forever).
   */
  working?: boolean | undefined;
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
  /** Placement decisions for the call rows — see {@link CallSurface}. Absent ⇒ every note inline, no rewind. */
  calls?: CallSurface | undefined;
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
  const writing = working ?? session?.status === "running";
  // What an armed cut takes, counted once: the messages at or past the turn, replies included.
  const doomedCount =
    doomedFrom === undefined
      ? 0
      : shown.filter((entry) => entry.kind === "message" && entry.turn !== undefined && entry.turn >= doomedFrom).length;
  let doomed = false;
  // The context readings as the conversation goes: the last one seen, and whether a compaction was
  // drawn since — a reading that DROPS with none between gets a line of its own anyway.
  let lastContext: ContextReading | undefined;
  let compactedSince = false;
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
                working={writing && i === blocks.length - 1}
                {...(sidechainOf !== undefined ? { sidechainOf } : {})}
                {...(onOpenSidechain !== undefined ? { onOpenSidechain } : {})}
                {...(artifacts !== undefined ? { artifacts } : {})}
                {...(narrated === true ? { narrated } : {})}
                {...(calls !== undefined ? { calls } : {})}
              />
              </div>
            </Fragment>
          );
        if (block.kind === "compaction") {
          compactedSince = true;
          return (
            <Fragment key={i}>
              {before}
              {cutLine}
              <CompactionLine trigger={block.trigger} before={block.before} after={block.after} durationMs={block.durationMs} window={lastContext?.window} />
            </Fragment>
          );
        }
        if (block.kind === "message") {
          const prior = lastContext;
          const context = block.context;
          // A reading far below the one before, with no compaction drawn between: the context got
          // smaller and nothing said why (codex reports no compaction of its own).
          const dropped =
            context !== undefined && prior !== undefined && !compactedSince && prior.used > 0 && context.used < prior.used * 0.6 ? (
              <CompactionLine derived before={prior.used} after={context.used} window={context.window ?? prior.window} />
            ) : null;
          if (context !== undefined) {
            lastContext = context;
            compactedSince = false;
          }
          return (
            <Fragment key={i}>
              {before}
              {cutLine}
              {dropped}
              <Message
                entry={block}
                {...(onEdit !== undefined ? { onEdit } : {})}
                {...(scope !== undefined ? { scope } : {})}
                doomed={doomed}
                {...(session?.stateId !== undefined ? { workflow: session.stateId } : {})}
                {...(context !== undefined && prior !== undefined ? { contextBefore: prior } : {})}
              />
            </Fragment>
          );
        }
        return (
          <div key={i} className={`ts-msg ts-msg-assistant ts-live${doomed ? " ts-doomed" : ""}`}>
            {/* Plain text, not markdown: a half-arrived answer has half a fenced block in it, and
                rendering that produces a code block that swallows the rest of the stream. */}
            <pre className="ts-text-live">{block.text}</pre>
            {writing ? (
              <div className="ts-live-line">
                <Pulse />
                writing…
              </div>
            ) : null}
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


