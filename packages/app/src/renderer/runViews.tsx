/**
 * What a COMPOSITE state is doing, two ways.
 *
 * A composite has children, so there are two honest readings of "what happened here" and the old
 * panel only had one. The board answers *where is everything* — one column per declared child, which
 * is the shape of the workflow. The conversation answers *what did it say* — the state's own
 * operation, then its children's runs in the order they happened, which is the shape of one task
 * going through it. Neither is a view of the other, so they are a toggle rather than a layout.
 *
 * Both are built from the selected task's INSTANCE TREE rather than from the task list, and that is
 * the change that makes a loop legible. A board column used to hold one card per task; it now holds
 * one card per EXECUTION, because a state that ran three times is three things that happened and a
 * single card cannot be clicked into three different transcripts.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type JSX, type ReactNode } from "react";
import type {
  ChatPlanView,
  ChatSettings,
  FastForwardView,
  SettledByView,
  InstanceNode,
  OperationRecordView,
  SessionRef,
  PendingInteraction,
  PendingQuestion,
  ApprovalScope,
  PendingApproval,
  WritableLayer,
  PendingUserEvent,
  StateChild,
  StateView,
  TaskDetail,
} from "@jaira/shared/browser";
import { Board, Column, Tile } from "./board";
import { ApprovalSurface, GateSurface, QuestionSurface, type EditorServices } from "./components";
import type { ComponentServices } from "./changesetReview";
import { TaskDetailSections, TaskHead } from "./detail";
import { entriesOf, entriesOfPart, journalFor, markAnsweredQuestions, previewOf, sidechainEntriesOf, signatureOf } from "./transcript";
import { ValueView } from "./valueView";
import { useStickToBottom } from "./stickToBottom";
import { sessionKey } from "./sessionCache";
import { STOPPED, stoppedAction } from "./taskAction";
import { instanceOf as instanceOfState, nodeAt, prunedTrail, type TrailStep } from "./trail";
import { AnsweredForYou, Paper, Pulse, Transcript, clockOf, durationOf, useElapsed, type CallSurface } from "./transcriptView";
import { advanceTargetOf, isAsking, surfaceKindOf } from "./stateSurface";
import { isComponentName, parseComponentConfig, readCall, MOVE_EVENTS, type ReadCall } from "@jaira/shared/browser";
import { Icon } from "./icons";
import { bandsOf, instancesOf, mountPathOf, notesOf, piecesOf, recordAt, type BandNote, type SessionPiece } from "./sessionBands";
import { SessionBandsView, cutNameOf, type CutOffer } from "./sessionPanels";
import { AskDialog, type AskSpec } from "./menu";
import { paletteOfRun } from "./runIndex";
import type { FileSurfaceProps } from "./fileTypes";
import { Composer } from "./composer";
import { invoke } from "./store";

// Moved to `trail.ts`, which is where the tree queries live now — it also seeds a walk, and that
// has to work for a composite, which has no session row to look one up by. Re-exported because this
// is where the board that uses it has always found it.
export { instanceOf } from "./trail";

/** Whether this subtree holds a state that is asking right now — see {@link isAsking}. */
function hasAsking(node: InstanceNode): boolean {
  return isAsking(node) || node.children.some(hasAsking);
}

/**
 * WHICH instance is asking — the same walk, returning the state rather than a yes.
 *
 * Every surface that draws a parked gate needs this and each of them was deriving it separately or
 * not at all. The letterhead's tint needs it (a canceled instance still holding a live question is
 * not a settled state — see `headerToneOf`), the run index needs it for the same reason, and the
 * conversation already needed it to decide which panel the question goes in.
 *
 * A pairing, not a lookup: `pending_interactions` records the component and the task, never the
 * instance, so nothing in the store says which state a surviving question belongs to. What says it
 * is the tree — exactly one instance has a function operation that dispatched and never settled —
 * which is why this is only ever asked when the hub is actually holding a request. The FIRST such
 * instance, since SPEC §7.1 gives an instance one operation and one task's tree cannot hold two
 * parked calls on one state.
 */
/**
 * The instance whose CALL is running and which has no running child — where an agent that asks is
 * asking from. Deepest first, since a running composite's own call is never the one talking.
 */
function runningLeafOf(nodes: readonly InstanceNode[]): string | undefined {
  for (const node of nodes) {
    if (node.superseded) continue;
    const inside = runningLeafOf(node.children);
    if (inside !== undefined) return inside;
    if (node.status === "running" && node.operation?.status === "running") return node.instanceId;
  }
  return undefined;
}

function askingInstanceOf(nodes: readonly InstanceNode[]): string | undefined {
  for (const node of nodes) {
    if (isAsking(node)) return node.instanceId;
    const inside = askingInstanceOf(node.children);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

/** Every execution of each declared child, keyed by the child key the parent mounted it under. */
export function runsByChild(parent: InstanceNode | undefined): Map<string, InstanceNode[]> {
  const out = new Map<string, InstanceNode[]>();
  for (const child of parent?.children ?? []) {
    const key = child.childKey ?? child.stateId;
    const list = out.get(key);
    if (list === undefined) out.set(key, [child]);
    else list.push(child);
  }
  // Oldest first inside a column, so a retry reads downward as the story it is.
  for (const list of out.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

/**
 * One execution, as a card in a board column.
 *
 * The same {@link Tile} the Tasks view puts a task in — the tile is chrome, and a board of runs and
 * a board of tasks are the same picture of two different things. What is this board's own is the
 * body: a run is identified by what it was CALLED WITH, which is the same signature the transcript
 * card carries, because they are the same object seen twice.
 */
function RunTile({
  node,
  index,
  total,
  selected,
  onSelect,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  node: InstanceNode;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  /** Present only when a waiting transition has offered this execution's run a move — see {@link RunBoard}. */
  onDragStart?: ((e: ReactDragEvent) => void) | undefined;
  onDragEnd?: (() => void) | undefined;
}): JSX.Element {
  const sig = signatureOf(node);
  const took = node.endedAt !== undefined ? durationOf(node.endedAt - node.startedAt) : undefined;
  return (
    <Tile
      status={node.status}
      title={sig.label ?? sig.name}
      selected={selected}
      tip={`${node.stateId} · ${new Date(node.startedAt).toLocaleString()} — double-click to walk in`}
      // Only when there is more than one. A lone card numbered "1 of 1" is a question raised and
      // immediately answered.
      trailing={total > 1 ? <span className="chip">{index + 1}</span> : undefined}
      meta={
        <>
          <span className="ellip">
            {node.status === "running" ? "running" : (took ?? new Date(node.startedAt).toLocaleTimeString())}
          </span>
          <span className="card-status">{node.status.replace(/_/g, " ")}</span>
        </>
      }
      // One click marks it, two walk into it — the same pair of gestures the task board uses, and the
      // reason it has to be the same pair is that these are the same board one level apart. A single
      // click that navigated meant you could not point at a card without leaving the page it was on.
      onSelect={onSelect}
      onDrill={onOpen}
      {...(onDragStart !== undefined ? { onDragStart } : {})}
      {...(onDragEnd !== undefined ? { onDragEnd } : {})}
    >
      {sig.params.length > 0 ? (
        <div className="card-args">
          {sig.params.slice(0, 2).map((param) => (
            <div key={param.name} className="ellip">
              {param.name} {param.preview}
            </div>
          ))}
          {sig.params.length > 2 ? <div className="sub">+{sig.params.length - 2} more</div> : null}
        </div>
      ) : null}
    </Tile>
  );
}

/**
 * The board of a composite, as EXECUTIONS.
 *
 * One column per declared child so the shape is the workflow's even where nothing has run, and one
 * card per pass so a loop is visible. A column with nothing in it says so rather than being dropped:
 * a child that was never reached is a fact about the run, and the columns either side of it are how
 * you can tell.
 */
export function RunBoard({
  declared,
  parent,
  openInstance,
  onSelect,
  onOpen,
  offers = NO_RUN_OFFERS,
  onDrop,
}: {
  /** The state's declared children, in run order — the columns, whether or not anything ran. */
  declared: readonly StateChild[];
  parent: InstanceNode | undefined;
  openInstance: string | null;
  /** One click: mark it. */
  onSelect: (node: InstanceNode) => void;
  /** Two: walk into it. */
  onOpen: (node: InstanceNode) => void;
  /**
   * The moves a waiting transition of THIS run is offering — column key → the wait a drop there
   * answers (`on_user_event`, WORKFLOWS.md §7.4). See {@link runDragOffersOf}.
   *
   * Empty by default, which is the honest answer for a board that is not looking at live work: no
   * card is draggable unless something is actually waiting for it to be. The Tasks board has had
   * this since the gesture existed; this board — the one a double-click on a run lands on, whose
   * columns are the very phases the rule names — offered nothing, so a card that could be dragged
   * one level up could not be dragged here.
   */
  offers?: ReadonlyMap<string, string>;
  /** A card was dropped on a column that was offering it a place. The caller answers the wait. */
  onDrop?: ((requestId: string) => void) | undefined;
}): JSX.Element {
  const byChild = useMemo(() => runsByChild(parent), [parent]);
  // What actually ran, when nothing says what was declared — a state view still in flight, or one
  // that would not load. Fewer columns than the truth (a child nothing reached cannot appear) but
  // never wrong about the ones it draws, which beats an empty board while a fetch lands.
  const columns = declared.length > 0 ? declared : [...byChild.keys()].map((key) => ({ key }) as StateChild);
  /**
   * The card a drag picks up: the execution the run RESTS on — the parent's latest child that was
   * not superseded. A wait belongs to the run, not to a pass, and the pass it is about is the one
   * the parent stopped after; every other card in the column is history.
   */
  const resting = useMemo(() => [...(parent?.children ?? [])].reverse().find((n) => !n.superseded), [parent]);
  const [dragging, setDragging] = useState(false);
  const draggable = onDrop !== undefined && offers.size > 0;
  return (
    // The same board the Tasks view draws, down to the class names: one column per declared child,
    // numbered in run order, cards inside. What differs is that a card here is one EXECUTION.
    <div className="board-body">
      <div className="columns">
        {columns.map((child, index) => {
          const runs = byChild.get(child.key) ?? [];
          const latest = runs[runs.length - 1];
          const requestId = offers.get(child.key);
          return (
            <Column
              key={child.key}
              name={child.label ?? child.key}
              seq={index + 1}
              count={runs.length}
              empty="not reached"
              // Double-clicking a COLUMN walks into the newest execution in it — the same descent a
              // card's double-click makes, reached from the heading. A column nothing reached has
              // nowhere to go, and says so by not being openable.
              tip={latest !== undefined ? `double-click to walk into ${child.key}` : `${child.key} was not reached`}
              {...(latest !== undefined ? { onOpen: () => onOpen(latest) } : {})}
              {...(dragging && onDrop !== undefined
                ? {
                    drop: {
                      accepts: requestId !== undefined,
                      onDrop: () => {
                        setDragging(false);
                        if (requestId !== undefined) onDrop(requestId);
                      },
                    },
                  }
                : {})}
            >
              {runs.map((node, i) => (
                <RunTile
                  key={node.instanceId}
                  node={node}
                  index={i}
                  total={runs.length}
                  selected={node.instanceId === openInstance}
                  onSelect={() => onSelect(node)}
                  onOpen={() => onOpen(node)}
                  {...(draggable && node === resting
                    ? {
                        onDragStart: (e: ReactDragEvent) => {
                          // Something has to be on the transfer or Firefox refuses the drag outright.
                          e.dataTransfer.setData("text/plain", node.instanceId);
                          e.dataTransfer.effectAllowed = "move";
                          setDragging(true);
                        },
                        onDragEnd: () => setDragging(false),
                      }
                    : {})}
                />
              ))}
            </Column>
          );
        })}
      </div>
    </div>
  );
}

const NO_RUN_OFFERS: ReadonlyMap<string, string> = new Map();

/**
 * The drags this run's board can offer: column key → the wait a drop there would answer.
 *
 * The same reading `dragOffersOf` makes for the Tasks board, one level down. A wait names the task
 * it parked in and the child key its rule moves to (`to_state`, filled in by the hub), and this
 * board's columns ARE those keys — so a wait of this task whose target is a column here is an
 * offer, and one aimed anywhere else is not. FIRST wins where two rules offer the same move, which
 * is the engine's own order.
 */
export function runDragOffersOf(
  taskId: string | undefined,
  columns: readonly { key: string }[],
  requests: readonly PendingUserEvent[],
): ReadonlyMap<string, string> {
  if (taskId === undefined) return NO_RUN_OFFERS;
  const keys = new Set(columns.map((c) => c.key));
  const offers = new Map<string, string>();
  for (const request of requests) {
    if (!MOVE_EVENTS.includes(request.event) || request.taskId !== taskId) continue;
    const to = advanceTargetOf(request);
    if (to === undefined || !keys.has(to) || offers.has(to)) continue;
    offers.set(to, request.requestId);
  }
  return offers;
}

// The key convention now lives in `sessionCache.ts`, with the invalidation that has to agree with
// it. Re-exported because this is where the panels have always found it.
export { sessionKey };

/**
 * A transition parked on a gesture, drawn where the run stopped.
 *
 * The case that was rendered NOWHERE. `on_user_event('task_drag')` is declared on seven of the
 * feature workflow's phase transitions, and until now a run that reached one simply stopped: the
 * last panel was whatever spoke before it, with nothing on the page saying why nothing followed. The
 * board lit a column, which is the right place to make the gesture and the wrong place to learn that
 * one is wanted.
 *
 * ## Why it is not an instance
 *
 * A wait sits BETWEEN states — a transition's guard evaluated `on_user_event(...)` and stopped — so
 * there is no node to hang it off and no operation to read a status from. `projection.ts` does set
 * `waiting_for_user` on the instance, but it sets the same value for an interactive OPERATION, so
 * asking the node cannot tell a parked transition from a state holding a question out to you. The
 * hub's request is what tells them apart, and it is also the only thing that knows WHERE the wait
 * wants the task to go.
 *
 * ## Where the destination comes from
 *
 * `options.to_state`, filled in by the hub from the rule's own `to` when the author left it out (see
 * `optionsOf` in `userEvents.ts`). Never re-derived from the workflow file here: a second reader of
 * the same expression language is how two parts of one app come to disagree about which column a
 * card belongs in. Absent means the rule goes to a `terminate.*` pseudo-state, which no gesture can
 * satisfy — the wait is real and the button would be a lie, so it is not offered.
 */
function WaitingOn({ request, onDeliver }: { request: PendingUserEvent; onDeliver: () => void }): JSX.Element {
  const to = advanceTargetOf(request);
  // LIVE: a wait is the one thing on this page that is still happening, and how long it has been
  // going is most of what a reader wants from it. The counter stops the moment the hub resolves the
  // request, because the panel stops being rendered at all.
  const waited = useElapsed(request.at, true) ?? 0;
  return (
    <div className="sb-panel">
      <section className="sb-sheet ss-waiting">
        <div className="sb-body">
          <div className="lh tb amber" aria-hidden>
            <Icon name="clock" className="lh-ico" />
            <span className="lh-kind">waiting on you</span>
            <span className="lh-name mono">{to !== undefined ? `→ ${to}` : request.event}</span>
            <span className="lh-meta">{durationOf(waited)}</span>
          </div>
          <p className="prose">
            {to !== undefined ? (
              <>
                Move this task to <span className="mono">{to}</span> to carry on. Nothing downstream runs until you do.
              </>
            ) : (
              <>
                This run is waiting for <span className="mono">{request.event}</span>.
              </>
            )}
          </p>
          {to !== undefined ? (
            <div className="ss-wait-do">
              <button type="button" className="primary" onClick={onDeliver}>
                Advance to {to}
              </button>
              {/* The gesture the workflow author had in mind, said rather than replaced. The button
                  is the same delivery from the surface the run is being read on; the drag is still
                  what the board is for. */}
              <span className="ss-wait-or">— or drag the card there on the board</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/**
 * What a state with no conversation has to SAY — the body under its letterhead.
 *
 * The header is not here. Every state in a run wears one now (see `stateSurface.tsx`), and the sheet
 * is what draws it — so this is only the contents, which is the difference between a surface and a
 * conversation rather than between a surface and a card.
 *
 * Two things, in the order somebody reads them.
 *
 * A FAILED call says what went wrong, from `node.operation.reason`. That is the whole of the error
 * routing on this side: `projection.ts` writes the reason onto the operation, so the panel has it
 * without touching the journal — and `notesOf` correspondingly stops drawing it on the grey, because
 * a failure written in two places is one of them lying about being the account of it.
 *
 * Otherwise, the state's INPUTS. The one thing about these states the projection already carries and
 * the one thing nothing showed: `signatureOf` lists them on a header only when the state declares no
 * label, and every state that ends up here declares one. So a gate handed a score, three reasons,
 * two must-asks and twenty kilobytes of deliverables rendered as its own name and nothing else.
 *
 * PREVIEWS, not values, and that is a stopping point rather than laziness. `previewOf` bounds every
 * slot to a line, where rendering `docs` in full would put a 20 KB document in the middle of a run
 * somebody is scrolling. What belongs here eventually is the derivation — the call, its named
 * arguments, the value it produced — and that needs the binding tree and the operation records
 * joined, which is a projection change rather than a rendering one.
 */
/**
 * ONE CALL a state made, as the derivation it is: what was run, on what, and what came back.
 *
 * This is the panel a `function` state never had. A state whose outputs are bound to function
 * expressions dispatches one call per output and emits no `operation.started`, so the projection
 * gave it no operation, the letterhead called it `computed`, and the body listed its INPUTS and
 * stopped — which is how a state that ran `confidence.score`, `confidence.reasons` and
 * `confidence.mustAsk` came to be drawn as a state that had done nothing, with all three names,
 * their arguments and their answers sitting in `operation_records`.
 *
 * The three lines are the three questions in the order somebody asks them. WHAT ran — the short
 * name, with the whole `functionRef` on the hover, because where a function lives is not what it is
 * called. WHAT WITH — the resolved arguments, so an answer that looks wrong can be checked against
 * what the call was actually handed rather than against the expression meant to produce it. WHAT
 * CAME BACK — through {@link ValueView} like every other value in the app, so a function returning a
 * document gets the document's readings and not a line of JSON.
 */
function CallBlock({ call }: { call: ReadCall }): JSX.Element {
  const args = Object.entries(call.args);
  return (
    <div className="ss-call">
      <div className="ss-call-head">
        <Icon name="sigma" className="ss-call-ico" />
        <span className="ss-call-name mono" title={call.ref ?? call.name}>
          {call.name ?? call.kind ?? "call"}
        </span>
        {call.status !== "completed" ? <span className="ss-call-status">{call.status}</span> : null}
      </div>
      {args.length > 0 ? (
        <div className="ss-slots">
          {args.map(([name, value]) => (
            <div className="ss-slot" key={name}>
              <span className="ss-slot-name">{name}</span>
              <span className="ss-slot-value ellip" title={previewOf(value)}>
                {previewOf(value)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {call.error !== undefined ? (
        <ValueView value={call.error} label="error" />
      ) : call.result !== undefined ? (
        <ValueView value={call.result} label="returned" />
      ) : null}
    </div>
  );
}

/** Exported for the test that renders one — the same reason {@link TableView} is. */
/**
 * The function call a settled `asked` state made, when its record is still there.
 *
 * Settled means the operation is no longer running, or the instance was cut from under it — a
 * cancel leaves `operation.status` at `running` (nothing ever completes it), so the instance's own
 * status has to be read too; see `headerToneOf` for the same rule. `asking` is the live gate being
 * hosted right now, which is never settled however the node reads.
 *
 * `undefined` when the record has been pruned, and then the panel falls back to the call listing:
 * a gate cannot be drawn from a call nothing remembers.
 */
function settledGateCallOf(
  node: InstanceNode,
  records: Record<string, OperationRecordView>,
  asking: boolean,
): ReadCall | undefined {
  if (asking || surfaceKindOf(node) !== "asked") return undefined;
  const operation = node.operation;
  if (operation === undefined) return undefined;
  const cut = node.status === "canceled" || node.status === "failed" || node.status === "timeout";
  if (operation.status === "running" && !cut) return undefined;
  const calls = (node.calls ?? [])
    .map((call) => records[call.operationId])
    .filter((row): row is OperationRecordView => row !== undefined)
    .map(readCall);
  return calls.filter((call) => call.ref !== undefined || call.kind === "function").at(-1) ?? calls.at(-1);
}

/**
 * The request a settled gate is drawn from, rebuilt from its record.
 *
 * Everything `GateSurface` reads is on the call: the component is the function it called, the
 * inputs are the arguments it was called with (a component's authored surface IS its args — see
 * `withContract` in main), and the contract is parsed from those the way main parses it for a live
 * gate. What the record does not carry is which project parked it, spelled here as the empty
 * project, which `GateSurface` reads as "the focused one".
 */
function settledGateOf(call: ReadCall, node: InstanceNode, taskId: string | undefined, project: string | undefined): PendingInteraction {
  const component = call.name ?? call.ref ?? "function";
  const pending: PendingInteraction = {
    requestId: `settled:${node.instanceId}`,
    taskId: taskId ?? "",
    project: project ?? "",
    component,
    inputs: call.args,
  };
  if (isComponentName(component)) {
    try {
      pending.config = parseComponentConfig(component, call.args);
    } catch (e) {
      pending.configError = (e as Error).message;
    }
  }
  return pending;
}

// "Answered for you" lives beside the question block it also marks (`transcriptView.tsx`); the gate
// here and the shots import it from this module, as they always have.
export { AnsweredForYou };

/** A settled gate in its state's panel: the control as answered, and the record behind a toggle. */
function SettledGate({
  call,
  node,
  taskId,
  project,
  services,
  editor,
}: {
  call: ReadCall;
  node: InstanceNode;
  taskId: string | undefined;
  project: string | undefined;
  services?: Partial<ComponentServices> | undefined;
  editor?: EditorServices | undefined;
}): JSX.Element {
  const [record, setRecord] = useState(false);
  const pending = useMemo(() => settledGateOf(call, node, taskId, project), [call, node, taskId, project]);
  // Answered iff the call answered: an error, a cut, or a record with no result is a question
  // nobody got to answer, whatever the arguments say.
  const answered = call.error === undefined && call.result !== undefined;
  return (
    <>
      {/* Keyed on the answer's arrival. The panel mounts the moment the request is gone, and the
          record can still be open then — the result lands a beat later — and a component seeds its
          answers once, on mount. Without the remount the chooser drew the question with nothing
          lit, the answer having arrived after it had already looked. */}
      <GateSurface
        key={answered ? "answered" : "open"}
        pending={pending}
        onSubmit={() => undefined}
        services={services}
        {...(editor !== undefined ? { editor } : {})}
        settled={answered ? { value: call.result } : {}}
      />
      {answered && node.settledBy !== undefined && taskId !== undefined ? (
        <AnsweredForYou
          by={node.settledBy}
          onAnswerYourself={() => {
            void invoke("task:answerYourself", { taskId, at: node.settledBy!.at, ...(project !== undefined && project !== "" ? { project } : {}) }).catch(() => undefined);
          }}
        />
      ) : null}
      <div className="gate-record">
        <button type="button" className="quiet" aria-expanded={record} onClick={() => setRecord((v) => !v)}>
          {record ? "Hide the record" : "Show the record"}
        </button>
        {record ? <CallBlock call={call} /> : null}
      </div>
    </>
  );
}

export function SilentState({ node, records }: { node: InstanceNode; records: Record<string, OperationRecordView> }): JSX.Element {
  const failure = node.operation?.status === "failed" ? node.operation.reason : undefined;
  /**
   * The calls this state dispatched, joined to what they ran — see `shared/operationRecords.ts`.
   *
   * Dropped where the record is missing rather than drawn as a placeholder: a call whose record has
   * been pruned is a call nothing can say anything about, and a row reading "call (unknown)" is a
   * gap dressed up as information.
   */
  const calls = useMemo(
    () => (node.calls ?? []).map((call) => records[call.operationId]).filter((row) => row !== undefined).map(readCall),
    [node.calls, records],
  );
  if (failure !== undefined) {
    return (
      <>
        <p className="ss-fail">
          <span className="ss-fail-msg">{failure}</span>
        </p>
        {/* The calls STAY under a failure, and that is the point of showing them at all: the state
            that could not resolve `confidence.score` is the state whose other two calls succeeded,
            and seeing which ones got through is most of the diagnosis. */}
        {calls.map((call, i) => (
          <CallBlock key={i} call={call} />
        ))}
      </>
    );
  }
  if (calls.length > 0) {
    return (
      <>
        {calls.map((call, i) => (
          <CallBlock key={i} call={call} />
        ))}
      </>
    );
  }
  const slots = Object.entries(node.inputs ?? {});
  if (slots.length === 0) {
    // A real answer and a rare one: a state can be entered with nothing bound to it. Not the old
    // sentence in new chrome — the letterhead above has already said what this state is.
    return <p className="ss-none">Nothing was bound to this run.</p>;
  }
  return (
    <div className="ss-slots">
      {slots.map(([name, value]) => (
        <div className="ss-slot" key={name}>
          <span className="ss-slot-name">{name}</span>
          {/* How the value was settled (decision 0005 §4): bound by wiring, inferred, or asked. */}
          {node.inputProvenance?.[name] !== undefined ? (
            <span className={`prov prov-${node.inputProvenance[name]!.via}`}>{node.inputProvenance[name]!.via}</span>
          ) : null}
          <span className="ss-slot-value ellip">{previewOf(value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * One run's conversation, as a panel per SESSION — see `sessionBands.ts` and `sessionPanels.tsx`.
 *
 * What this replaced was organised by state: the run's own words at the top, then a card per child
 * run underneath. That had two things wrong with it. The small one is that a composite has no
 * conversation of its own, and the transcript that appeared above the cards anyway was whichever one
 * happened to be LAST in the whole task — `sessionView` falls back to `history.at(-1)` when it is
 * asked about an instance that never spoke, and a state with no operation is exactly that instance.
 *
 * The large one is that a state is not the unit a conversation has. Sessions are shared — several
 * states continuing one thread is the ordinary case, and the point of declaring one — so a layout
 * keyed on states cannot say which of the things on screen were talking to the same context. Keyed on
 * sessions, it says nothing else.
 *
 * `parent` is the run being READ, which is the trail's tail rather than the open file's own instance:
 * walking into a child and asking what it said must show that child's words. Everything BELOW that
 * run is flattened into the same set of panels rather than nested, because a grandchild that
 * continues its grandparent's session belongs in that session's panel — see `piecesOf`.
 */
export function RunConversation({
  parent,
  detail,
  context,
  onOpenSidechain,
  focus,
  asking,
  gate,
  onGate,
  gateServices,
  gateEditor,
  question,
  onQuestion,
  approval,
  onApproval,
  onHere,
}: {
  /** The run whose conversation this is. Undefined ⇒ nothing has run here yet. */
  parent: InstanceNode | undefined;
  detail: TaskDetail | null;
  context: FileSurfaceProps["context"];
  /**
   * A gate is on offer below — so the run is WAITING, whatever its row says.
   *
   * The row can say `canceled` and be telling the truth: the process that was blocked on the gate
   * went away, and the question outlived it. What must not happen is the strip reporting a stop and
   * offering "Retry" directly above a question somebody is about to answer — Retry starts the task
   * over and throws the answer away, which is the opposite of what the button next to it does.
   */
  asking?: boolean | undefined;
  /**
   * The parked gate, hosted in the panel of the state that raised it — see {@link isAsking}.
   *
   * Passed down rather than drawn by the caller after this component, which is where it started and
   * read wrong: a question appended below the whole conversation is a footnote about the run, and
   * leaves the reader to work out which state is asking. The state already says so — its letterhead
   * reads "asked of you" — so the answer belongs under that heading and nowhere else.
   */
  gate?: PendingInteraction | undefined;
  onGate?: ((value: unknown) => void) | undefined;
  gateServices?: Partial<ComponentServices> | undefined;
  gateEditor?: EditorServices | undefined;
  /**
   * A running agent's question, hosted under the state whose agent asked it — the transcript so far
   * above, the question below, because the agent asked mid-turn and what it said first is the
   * context for what it is asking. The journal does not say which instance asked, so the question
   * goes under the leaf whose call is running: an agent asks from inside its own call.
   */
  question?: PendingQuestion | undefined;
  onQuestion?: ((answers: Record<string, string | string[]> | undefined) => void) | undefined;
  /** A command approval a running agent is waiting on, hosted under the same leaf for the same reason. */
  approval?: PendingApproval | undefined;
  onApproval?: ((decision: "allow" | "deny", scope: ApprovalScope, extras?: { remember?: string[]; addTo?: WritableLayer }) => void) | undefined;
  /** A state to go to, asked for by the Instances index — see `SessionBandsView`. */
  focus?: { instance: string; at: number } | undefined;
  /**
   * Where the reader is, reported as they scroll — the state whose section is under the top of the
   * scroller, by instance id, for the Instances index to mark. The reverse of `focus`. Undefined
   * when no section has reached the top yet, and on unmount.
   */
  onHere?: ((instance: string | undefined) => void) | undefined;
  /**
   * Where "walk into this subagent conversation" goes, when this panel's host has somewhere for it.
   * Defaults to the trail (`context.onWalkIntoSidechain`); the task panel passes its own stack.
   * The node is the PIECE the doorway was clicked in — the host whose session holds the chain.
   */
  onOpenSidechain?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
}): JSX.Element {
  const { conversation, liveTurn, sessions, sessionHistory, records, onLoadSessions, onOpenWorkflow, userEvents, onDeliverUserEvent, shutStates, onToggleShutState, onSetShutStates } = context;
  const openSidechain = onOpenSidechain ?? context.onWalkIntoSidechain;
  /**
   * The TASK's conversation, not the newest run's.
   *
   * It was the newest run's, and that was wrong twice over on a task anybody had resumed. A resumed
   * run dispatches only what it did not replay, so its own journal holds a conversation with holes
   * where the replayed states are — and each hole was drawn as a panel reading "this state ran no
   * model call", about a state that had one. And a run-scale fork cannot be drawn at all when only
   * one of its sides is on the page.
   *
   * Nothing is unscoped by this: `piecesOf` joins on the run AND the instance, taking the run from
   * the folded tree's own stamp, which is the pairing that was missing when the filter was the only
   * thing standing between `#i2` and three older runs' `#i2`.
   */
  const bands = useMemo(() => bandsOf(piecesOf(parent, sessionHistory), { batches: context.batches }), [parent, sessionHistory, context.batches]);
  const needed = useMemo(() => instancesOf(bands), [bands]);
  /**
   * The run's colours, from the TREE rather than from the rows this view happens to draw.
   *
   * Its rows are bands — several states can share one — and the task panel's index is one row per
   * state, so each deriving its own hue ladder made the two disagree about what colour a state is
   * while both were drawing the same run. See `paletteOfRun`.
   */
  const palette = useMemo(
    () => paletteOfRun(detail?.instances ?? (parent === undefined ? [] : [parent])),
    [detail?.instances, parent],
  );
  /**
   * Follow the live edge — the behaviour this panel is watched in and did not have.
   *
   * Everything that makes the transcript taller is in the follow list: the bands (a state entered),
   * the fetched transcripts (a record landed), the tail (a word arrived) — and the folds, which make
   * it SHORTER: a reader at the live edge who folds a section above it is still at the live edge,
   * and without this the scroller was left wherever the browser's clamp dropped it, which read as
   * empty space where the last message had been. The task is the reset — a different run is a
   * different conversation, and the pin does not travel between them.
   */
  const follow = useStickToBottom<HTMLDivElement>([bands, sessions, liveTurn, conversation, shutStates], [detail?.taskId]);
  /**
   * Which state the reader is at, for the index beside this column — see {@link onHere}.
   *
   * The LAST section whose top has passed the upper part of the scroller: a section is "where you
   * are" once its heading has scrolled up into the top third, which is where a reader's eye is when
   * they are reading it, rather than the moment its heading touches the top edge. The entered row
   * and the letterhead both carry the instance id, which is what lets one query name both — the row
   * is what a bookmark lands on, so the two agree about where a state starts. Measured against the
   * viewport, as the board's spy is, so a restyle that positions an ancestor changes nothing here.
   * Nothing past the line yet ⇒ the first section, so the index never marks nothing while something
   * is on screen.
   */
  const track = useCallback((): void => {
    if (onHere === undefined) return;
    const el = follow.ref.current;
    if (el === null) return;
    const line = el.getBoundingClientRect().top + el.clientHeight / 3;
    let at: string | undefined;
    let first: string | undefined;
    for (const row of el.querySelectorAll<HTMLElement>("[data-entered], [data-instance]")) {
      const id = row.dataset["entered"] ?? row.dataset["instance"];
      if (id === undefined) continue;
      first ??= id;
      if (row.getBoundingClientRect().top <= line) at = id;
    }
    onHere(at ?? first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onHere]);
  // Coalesced to a frame: a scroll fires many times per paint, and the answer only changes per paint.
  const trackFrame = useRef<number | null>(null);
  const trackSoon = useCallback((): void => {
    if (trackFrame.current !== null) return;
    trackFrame.current = window.requestAnimationFrame(() => {
      trackFrame.current = null;
      track();
    });
  }, [track]);
  // Sections arriving, folding, or the follow pin moving the scroller all move what is under the
  // line, and none of them is a scroll the listener would see — so it is re-read after each.
  useEffect(trackSoon, [trackSoon, bands, sessions, liveTurn, conversation, shutStates]);
  useEffect(
    () => () => {
      if (trackFrame.current !== null) window.cancelAnimationFrame(trackFrame.current);
      onHere?.(undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  /**
   * A bookmark takes the reader off the live edge, so stop following BEFORE it lands.
   *
   * A layout effect, and it has to be: the follow above is one too, and on the render that mounts
   * this column it has already written `scrollTop = scrollHeight`. Left pinned, the next transcript
   * to arrive would do it again — after the jump, before the paint — and the reader would be sent
   * somewhere and returned without ever seeing it.
   */
  useLayoutEffect(() => {
    if (focus !== undefined) follow.unpin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.instance, focus?.at]);
  /**
   * What went wrong in the states that never opened a conversation.
   *
   * The journal is the only record of them, and until this it was filtered per PANEL — a turn reached
   * the screen by matching a piece's state id, so a child that was blocked before it could run and a
   * composite that terminated because one of its children failed both matched nothing and were both
   * dropped. That is the whole error of a failed run, silently absent from the one view somebody
   * opens to find it.
   *
   * The RUN's, not this level's, even when a walk has gone in a few steps: a journal turn names the
   * state it is about and not the instance, so there is nothing to scope by — and the failures being
   * shown are a cascade anyway, in which the sentence explaining why a child gave up is on the child
   * and the one explaining what that cost is on the parent. Each note names its own state.
   */
  // The TREE as well as the turns: a failure belongs on the grey only when the instance it names
  // ran no operation, and the tree is where that is written. See `notesOf` and `ranAnOperation`.
  const notes = useMemo(() => notesOf(conversation?.turns ?? [], parent), [conversation, parent]);
  /**
   * Where the run being READ sits, so a note's path is shown from here rather than from the root of
   * the workflow. Walking into `product` should leave its notes saying `explore`, not
   * `product → explore` — the second half is the page you are already on.
   */
  /**
   * The waits belonging to THIS task, oldest first.
   *
   * Filtered here rather than published filtered, because the hub's list is what the board reads
   * whole. A wait carries the task it parked in (`UserEventHub.register` stamps it), so this is a
   * comparison rather than a guess — and a run with none is the ordinary case, which costs an empty
   * array and draws nothing.
   */
  const waits = useMemo(
    () =>
      detail === null
        ? []
        : [...userEvents].filter((one) => one.taskId === detail.taskId).sort((a, b) => a.at - b.at),
    [userEvents, detail],
  );
  const rootPath = useMemo(
    () => (parent === undefined ? "" : mountPathOf(detail?.instances ?? [], parent.instanceId)),
    [detail, parent],
  );
  /**
   * The instance whose question is on the page — the same conjunction that decides where it is DRAWN.
   *
   * Gated on the gate existing, which is the whole point: without it, an instance that dispatched a
   * gate and was then stopped with the run reads identically to one whose question survived the
   * stop, and the letterhead would tint a dead question as a live one. See `askingInstanceOf`.
   */
  const askingHere = useMemo(
    () => (gate === undefined || onGate === undefined ? undefined : askingInstanceOf(detail?.instances ?? [])),
    [gate, onGate, detail?.instances],
  );
  // Where a running agent's question or approval is drawn: under the leaf whose call is running.
  const agentHere = useMemo(
    () =>
      (question !== undefined && onQuestion !== undefined) || (approval !== undefined && onApproval !== undefined)
        ? runningLeafOf(detail?.instances ?? [])
        : undefined,
    [question, onQuestion, approval, onApproval, detail?.instances],
  );

  /**
   * A rewind the reader has ARMED from an entered row or a knot — see `CutOffer` and `cut.ts`.
   *
   * Held here because the two things it changes are both this component's: the rail fades what
   * would go, and the strip under the conversation asks in words. Cleared with the task, since a
   * cut is a question about one journal. A fork needs no arming: there is nothing to type, so the
   * fork's first act is the machine's, and the shell opens the copy.
   */
  const [armed, setArmed] = useState<ArmedRewind | null>(null);
  useEffect(() => setArmed(null), [detail?.taskId]);
  const { onRewind, onFork } = context;
  const onCut = useMemo<CutOffer | undefined>(() => {
    if (detail === null || onRewind === undefined || onFork === undefined) return undefined;
    const taskId = detail.taskId;
    return {
      rewind: (note: BandNote) =>
        setArmed({
          seq: note.seq,
          at: note.at,
          name: cutNameOf(note, rootPath),
          // Every state entered at or after the cut, named — the sentence in the strip is what makes
          // "everything after it" a checkable claim.
          doomed: notes.filter((one) => one.kind === "entered" && one.at >= note.at).map((one) => cutNameOf(one, rootPath)),
        }),
      fork: (note: BandNote) => onFork(taskId, note.seq),
    };
  }, [detail, onRewind, onFork, notes, rootPath]);

  /**
   * What this conversation's call rows are lent: the workflow tools' notes are drawn on the RAIL, from
   * the `jaira.moved` rows (`notesOf`), so the rows themselves say nothing more; and "Answer it
   * yourself" under an agent's question is the gate's own rewind.
   */
  const detailTaskId = detail?.taskId;
  const calls = useMemo<CallSurface>(
    () => ({
      outcomes: "rail",
      ...(detailTaskId !== undefined
        ? {
            onAnswerYourself: (by: SettledByView) => {
              void invoke("task:answerYourself", { taskId: detailTaskId, at: by.at, ...(context.project !== undefined && context.project !== "" ? { project: context.project } : {}) }).catch(() => undefined);
            },
          }
        : {}),
    }),
    [detailTaskId, context.project],
  );

  // Every panel is open, so every transcript in them is needed — fetched in one round rather than
  // on expand, which is what the folded card design paid for and this one does not.
  useEffect(() => {
    const missing = needed.filter((one) => sessions[sessionKey(one)] === undefined);
    if (missing.length > 0) onLoadSessions(missing);
  }, [needed, sessions, onLoadSessions]);

  if (detail === null) return <p className="empty">Select a run to see what it said.</p>;

  /**
   * One piece's transcript.
   *
   * The live delta is matched on the POSITION rather than on the state: a loop runs one state several
   * times and only the position tells the passes apart. A piece that has not written a position yet
   * has none to match, so it falls back to the state — which is the only handle a call still in
   * flight offers, and is why an answer appears while it is being written rather than after.
   */
  const render = (piece: SessionPiece): ReactNode => {
    /**
     * A state with nothing to read — because it was never going to have any, or because its call
     * failed before it wrote a word. See `stateSurface.tsx` for the kinds.
     *
     * Answered BEFORE the session is fetched, and that is the point rather than an optimisation:
     * `session:view` has nothing to say about these and says so in one sentence, which is the bug.
     * Everything the body needs is on the projection already.
     *
     * ⚠️ The session check is not redundant with the kind. `piecesOf` SYNTHESISES a node for an
     * operation the folded tree has no node for — an earlier run's work a later run overwrote — and
     * a synthesised node carries no `operation`, because a `SessionRef` does not record one. Asking
     * the node alone would call every one of those computed and draw a worksheet over a conversation
     * sitting right there in the record. A piece that wrote a session position said something,
     * whatever the tree remembers about it.
     */
    // The question goes in the panel that is ASKING it, which is the whole point of hosting a gate
    // in the conversation rather than over it. Appended after the transcript it read as a footnote
    // about the run; here it is the body of the state whose letterhead says "asked of you", under
    // the prompt that state wrote.
    if (gate !== undefined && onGate !== undefined && isAsking(piece.node)) {
      return (
        <GateSurface
          pending={gate}
          onSubmit={onGate}
          services={gateServices}
          {...(gateEditor !== undefined ? { editor: gateEditor } : {})}
        />
      );
    }
    // The question once it is no longer being asked: the same control, as it was answered — or,
    // for a run stopped on it, as it was never answered. Under the same letterhead, in the same
    // place, so the conversation reads the same before and after. The call's arguments and result
    // are still there, behind a toggle, for anyone who wants the record rather than the reading.
    const settledCall = settledGateCallOf(piece.node, records, gate !== undefined && isAsking(piece.node));
    if (settledCall !== undefined) {
      return (
        <SettledGate
          call={settledCall}
          node={piece.node}
          taskId={detail?.taskId}
          project={context.project}
          services={gateServices}
          editor={gateEditor}
        />
      );
    }
    const silent = piece.sessionId === undefined && surfaceKindOf(piece.node) !== "conversation";
    if (silent || piece.node.operation?.status === "failed") return <SilentState node={piece.node} records={records} />;
    const view = sessions[sessionKey(recordAt(piece))];
    if (view === undefined) return <p className="empty">Loading…</p>;
    const matches =
      liveTurn !== null &&
      (piece.sessionId !== undefined
        ? liveTurn.sessionId === piece.sessionId && liveTurn.seq === piece.seq
        : liveTurn.stateId === piece.node.stateId && piece.node.status === "running");
    // The whole tail, not just its text: the items are the tool calls and events streaming by, and
    // they belong in this panel the moment they happen rather than when the record closes —
    // sidechains included, which is what lets a doorway row show its subagent talking live.
    const live = matches ? liveTurn : null;
    // The agent's questions the control conversation answered say so, as a gate does — the marks are
    // the instance's `jaira.answered` rows, joined to the blocks by the call each answered. A piece
    // that is one stretch of a turn a workflow tool's note cut draws only that stretch (`splitAtNotes`).
    const entries = entriesOfPart(
      markAnsweredQuestions(entriesOf(view, journalFor(conversation?.turns ?? [], piece.node.stateId), live), piece.node.answeredQuestions),
      piece.part,
    );
    const transcript = (
      <Transcript
        session={view}
        entries={entries}
        live={live}
        calls={calls}
        // The SESSION, not the task: a turn number is only unique inside one, so a run's several
        // conversations would otherwise overwrite each other's type corrections at turn 3. A piece
        // with no session id yet is one still being written, and gets the control without the
        // remembering — see `messageTypes.ts`.
        {...(piece.sessionId !== undefined ? { scope: piece.sessionId } : {})}
        {...(openSidechain !== undefined
          ? { onOpenSidechain: (call: string, name: string) => openSidechain(piece.node, call, name) }
          : {})}
      />
    );
    // The agent's question or the command it is waiting to run, under what it said before asking.
    // Keyed on the request so a second one from the same agent starts with nothing lit.
    if (piece.node.instanceId === agentHere) {
      return (
        <>
          {transcript}
          {approval !== undefined && onApproval !== undefined ? (
            <div className="inline-gate">
              <ApprovalSurface key={approval.requestId} pending={approval} onDecide={onApproval} />
            </div>
          ) : null}
          {question !== undefined && onQuestion !== undefined ? (
            <div className="inline-gate">
              <QuestionSurface key={question.requestId} pending={question} onSubmit={onQuestion} />
            </div>
          ) : null}
        </>
      );
    }
    return transcript;
  };

  return (
    <div className="run-convo-wrap">
      <div
        className="run-convo scroll"
        ref={follow.ref}
        onScroll={() => {
          follow.onScroll();
          trackSoon();
        }}
      >
        <SessionBandsView
          bands={bands}
          render={render}
          {...(askingHere !== undefined ? { asking: askingHere } : {})}
          notes={notes}
          {...(rootPath !== undefined ? { root: rootPath } : {})}
          {...(onOpenWorkflow !== undefined
            ? { onOpenWorkflow: (piece: SessionPiece) => onOpenWorkflow(piece.node.stateId, piece.node.instanceId) }
            : {})}
          shut={shutStates}
          onToggle={onToggleShutState}
          onSetShut={onSetShutStates}
          scope={detail.taskId}
          {...(focus !== undefined ? { focus } : {})}
          palette={palette}
          empty="This run has not entered a child yet."
          {...(onCut !== undefined ? { onCut } : {})}
          {...(armed !== null ? { armed: { seq: armed.seq, at: armed.at } } : {})}
          {...(detail.origin !== undefined
            ? { origin: { ...detail.origin, onGo: () => context.onSelectTask(detail.origin!.taskId) } }
            : {})}
          onSelectTask={context.onSelectTask}
        />
        {/* AFTER the bands, always. A wait is the present tense of a run — it is where the thing
            stopped — so it belongs at the bottom of what has happened rather than sorted into it by
            the clock it parked at. It is also outside `SessionBandsView` because it is not a band:
            no session, no piece, and nothing that could overlap another conversation. */}
        {waits.map((request) => (
          <WaitingOn key={request.requestId} request={request} onDeliver={() => onDeliverUserEvent(request.requestId)} />
        ))}
      </div>
      {/* Pinned below the scroller, not inside it: what you are about to say does not scroll away
          with what was already said. */}
      <ChatComposer
        taskId={detail.taskId}
        instanceId={parent?.instanceId}
        project={context.project}
        running={detail.status === "running"}
        detail={detail}
        {...(asking === true ? { asking: true } : {})}
        {...(context.onRerun !== undefined ? { onRerun: context.onRerun } : {})}
        {...(context.onResume !== undefined ? { onResume: context.onResume } : {})}
        {...(armed !== null && onRewind !== undefined
          ? {
              armed,
              onRewindConfirm: () => {
                setArmed(null);
                onRewind(detail.taskId, armed.seq);
              },
              onArmCancel: () => setArmed(null),
            }
          : {})}
      />
    </div>
  );
}

/** A rewind that is armed and not yet confirmed — what the strip asks about. See `RunConversation`. */
export interface ArmedRewind {
  seq: number;
  at: number;
  /** The state the cut is before. */
  name: string;
  /** Every state the cut deletes, the named one first. */
  doomed: string[];
}

/** "a, b and c" — the deleted states, said as a list. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The strip while a rewind is armed: the sentence, and the one filled button in the danger colour.
 *
 * In `RunActivity`'s place, because that is where this task already reports what is happening to
 * it and offers the one button that changes it — and a rewind is that, for a moment. The worktree
 * is named because it is the thing a reader would otherwise assume goes back too, and it does not.
 */
export function CutStrip({ armed, onConfirm, onCancel }: { armed: ArmedRewind; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  const gone = armed.doomed.length === 0 ? [armed.name] : armed.doomed;
  return (
    <div className="run-doing bad cut-strip" role="alertdialog" aria-label={`Rewind to before ${armed.name}`}>
      <span className="run-doing-mark bad" aria-hidden="true" />
      <span className="ellip">
        Rewind to before <b>{armed.name}</b> — {listed(gone)} {gone.length === 1 ? "is" : "are"} deleted and the run enters{" "}
        {armed.name} again. Files edited in the worktree stay as they are.
      </span>
      <span className="grow" />
      <button type="button" className="ghost" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="cut" onClick={onConfirm}>
        Rewind
      </button>
    </div>
  );
}

/**
 * A subagent conversation as a PANEL — what a sidechain step at the end of the path shows.
 *
 * The same reading the doorway row folds open, standing on its own page: the host instance's
 * session is fetched the way any panel's is, the chain behind `step.sidechain` is read the way the
 * main thread is (`sidechainEntriesOf`), and turns still streaming by are appended from the live
 * tail. No composer — a sidechain is somebody else's conversation, already over or still being had,
 * and there is no session of this state's to continue.
 *
 * Doorways INSIDE the chain walk deeper: a nested spawn keys its own chain in the same flat map,
 * under the same host, so `onOpen` pushes another sidechain step with the same instance on it.
 */
export function SidechainConversation({
  step,
  context,
  onOpen,
}: {
  /** The sidechain step being stood on. `step.sidechain` is set — that is what makes it one. */
  step: TrailStep;
  context: FileSurfaceProps["context"];
  /** Where a nested doorway goes. Defaults to the trail, like the panel this mirrors. */
  onOpen?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
}): JSX.Element {
  const { sessions, onLoadSessions, liveTurn } = context;
  const call = step.sidechain ?? "";
  const view = sessions[step.instanceId] ?? null;
  // The host node, for pushing nested steps — and the honest answer when it is gone.
  const host = nodeAt(context.detail?.instances ?? [], step.instanceId);
  const open = onOpen ?? context.onWalkIntoSidechain;

  useEffect(() => {
    // A sidechain's host is a node of the folded tree, so it carries the run it came from.
    const at = { instanceId: step.instanceId };
    if (sessions[sessionKey(at)] === undefined) onLoadSessions([at]);
  }, [sessions, step.instanceId, host, onLoadSessions]);

  const liveItems = liveTurn?.sidechains[call];
  const entries = useMemo(() => sidechainEntriesOf(view, call, liveItems), [view, call, liveItems]);
  // Same rule as the thread that spawned it: a subagent streaming its work is a live edge to stand
  // on. The call is the reset — walking into a different chain starts at the end of that one.
  const follow = useStickToBottom<HTMLDivElement>([entries], [call]);

  if (step.sidechain === undefined) return <p className="empty">This step is not a subagent conversation.</p>;
  if (view === null && liveItems === undefined) return <p className="empty">Loading…</p>;
  return (
    <div className="run-convo-wrap">
      <div className="run-convo scroll" ref={follow.ref} onScroll={follow.onScroll}>
        <Paper>
          <Transcript
            session={view}
            entries={entries}
            live={liveTurn}
            empty="This subagent has not said anything yet."
            {...(open !== undefined && host !== undefined
              ? { onOpenSidechain: (nested: string, name: string) => open(host, nested, name) }
              : {})}
          />
        </Paper>
      </div>
    </div>
  );
}

/**
 * The composer, bound to the run being read.
 *
 * It owns the overrides and re-asks for a plan whenever they change, because the plan is what the
 * settings strip renders and an override has to be reflected in it — picking a model must show the
 * model picked, not the one the state inherits.
 */
function ChatComposer({
  taskId,
  instanceId,
  project,
  running,
  detail,
  asking,
  onRerun,
  onResume,
  armed,
  onRewindConfirm,
  onArmCancel,
}: {
  taskId: string;
  instanceId: string | undefined;
  project?: string | undefined;
  /** A rewind armed above — the strip asks about it here, in place of whatever it was showing. */
  armed?: ArmedRewind | undefined;
  onRewindConfirm?: (() => void) | undefined;
  onArmCancel?: (() => void) | undefined;
  /** The TASK is still going — what makes the button a stop button. See {@link stop}. */
  running?: boolean;
  /** A gate is on offer below — passed straight through, see {@link RunConversation}. */
  asking?: boolean | undefined;
  /** The run itself, for the case where there is no conversation to compose into — {@link RunActivity}. */
  detail: TaskDetail;
  /** Set a stopped run going again. Passed straight through — see {@link RunActivity}. */
  onRerun?: ((taskId: string) => void) | undefined;
  /** Pick a stopped run up where it left off — see `RunActivity`. */
  onResume?: ((taskId: string) => void) | undefined;
}): JSX.Element {
  const [overrides, setOverrides] = useState<ChatSettings>({});
  // THREE states, not two. `undefined` is "not asked yet", `null` is "asked, and there is no
  // conversation here" — and only the second may disable the box. Collapsing them makes every first
  // render flash a disabled composer reading that the run holds no conversation, before the channel
  // has said anything at all.
  const [plan, setPlan] = useState<ChatPlanView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a turn, to re-ask. Nothing else in the dep list moves when a message is sent — same
  // task, same instance, same overrides — so without this the strip kept showing the plan from
  // BEFORE the send: a stale "joins this turn", and a model chip still naming the previous answer.
  const [sent, setSent] = useState(0);

  useEffect(() => {
    if (instanceId === undefined) {
      setPlan(null);
      return;
    }
    setPlan(undefined); // asking again — back to "not known", so a stale plan is never shown as current
    let live = true;
    // The channel ANSWERS `null` for a state that holds no conversation — the ordinary case for a
    // composite — so that is a value here rather than a rejection. The `catch` stays for the rest:
    // a genuinely broken read still disables the box rather than leaving it enabled over an error,
    // because a send that is going to fail should not be offered.
    void invoke("chat:plan", { taskId, instanceId, overrides, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setPlan(next))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [taskId, instanceId, overrides, project, sent]);

  const send = (message: string): void => {
    if (instanceId === undefined) return;
    setBusy(true);
    setError(null);
    void invoke("chat:send", { taskId, instanceId, message, overrides, ...(project !== undefined ? { project } : {}) })
      .then((result) => setError(result.failure ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        setSent((n) => n + 1);
      });
  };

  /**
   * Stop what is actually going, which is two different things — the same split the Chat view makes.
   *
   * While the TASK is running the thing to abort is the run, and `chat:cancel` has nothing registered
   * to reach; a message typed into a settled run is a chat turn, which `task:cancel` knows nothing
   * about. One button, and it has to pick.
   *
   * Offered even where nothing can be SENT, which is the point. A composite holds no conversation of
   * its own, so this box is disabled over it — and it is precisely the node somebody stands on to
   * watch a whole workflow, so "stop" there has to mean "stop the run, children and all". `task:cancel`
   * is task-scoped, so it does: there is no per-instance abort to reach for and none is wanted.
   */
  const stop = (): void => {
    // `asking` counts as running for this decision, and it is the case the split was written before
    // gates were durable: a task holding a recovered gate has no run to abort, but stopping it is
    // exactly what withdraws the question (`task:cancel` clears the gate). `chat:cancel` there would
    // reach for a turn nobody typed and quietly do nothing.
    if (running === true || asking === true) {
      void invoke("task:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    void invoke("chat:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch(() => undefined);
  };

  /** Skip, from the fast-forward strip (decision 0005 §4): enter the target now, what is between recorded `skipped`. */
  const skip = (): void => {
    void invoke("task:skip", { taskId, ...(project !== undefined ? { project } : {}) }).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };
  // A fast-forward is SHOWING whatever the panel is otherwise showing: the strip is where Skip lives,
  // and a Skip that was only offered over a composite would be a Skip that vanished the moment
  // somebody clicked into the conversation that is answering for them.
  const forwarding = detail.fastForward !== undefined;

  // Why sending is impossible, when it is. `null` is not a loading state to wait out — the channel
  // answered and said this state has no session of its own, and an enabled box above that answer is
  // an invitation to an error. `undefined` is the wait, and it disables nothing.
  //
  // Only ONE case reaches the composer now: nothing selected. The other — a composite, which
  // orchestrates and says nothing while its children each hold a session — used to produce a greyed
  // box carrying a sentence explaining itself, and a greyed box is a control that has to be read
  // before it can be dismissed. See {@link RunActivity} for what stands there instead.
  const disabled = instanceId === undefined ? "Select a run to continue its conversation." : undefined;

  // The three-state `plan` is what makes this safe, and collapsing it is the way to get it wrong:
  // `undefined` is "not asked yet" and `null` is "asked, and there is no conversation here". Acting
  // on both would flash the composer out of existence and back on every first render.
  const cutStrip =
    armed !== undefined && onRewindConfirm !== undefined && onArmCancel !== undefined ? (
      <CutStrip armed={armed} onConfirm={onRewindConfirm} onCancel={onArmCancel} />
    ) : null;
  if (plan === null && instanceId !== undefined) {
    return (
      <div className="cx-doing">
        {error !== null ? <p className="cx-error">{error}</p> : null}
        {cutStrip ?? (
          <RunActivity
            detail={detail}
            onStop={stop}
            onSkip={skip}
            {...(asking === true ? { asking: true } : {})}
            {...(onRerun !== undefined ? { onRerun } : {})}
            {...(onResume !== undefined ? { onResume } : {})}
          />
        )}
      </div>
    );
  }

  return (
    <>
      {cutStrip !== null ? <div className="cx-doing">{cutStrip}</div> : null}
      {cutStrip === null && forwarding ? (
        <div className="cx-doing">
          <RunActivity detail={detail} onStop={stop} onSkip={skip} />
        </div>
      ) : null}
      {error !== null ? <p className="cx-error">{error}</p> : null}
      <Composer
        plan={plan ?? null}
        // A run in flight is busy whatever the box says: the button is the only handle on it, and a
        // disabled composer over a running workflow used to be a panel with no way to stop it.
        busy={busy || running === true}
        // …and a state that holds a conversation can be TYPED INTO while it runs, which is the other
        // half of the same fact: the message joins the call in flight where the transport takes one.
        // `disabled` already covers the states that hold none, so this is exactly the rest.
        joinable={disabled === undefined}
        overrides={overrides}
        onOverrides={setOverrides}
        onSend={send}
        onStop={stop}
        onSaveToolset={(request) => invoke("toolset:save", { ...request, ...(project !== undefined ? { project } : {}) })}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    </>
  );
}

/**
 * What is happening here, and the button that ends it — what stands where the composer would.
 *
 * A composite orchestrates and says nothing, so there is no conversation of its own to type into.
 * The old answer was a disabled composer carrying a sentence about why it was disabled, which is a
 * control you have to read before you can dismiss it, sitting under every run of every workflow that
 * has children. It also carried the only Stop button on the page, which is why it could not simply
 * be deleted: a composite is exactly the node somebody stands on to watch a whole workflow.
 *
 * So the box goes and the fact stays. One line, present only while something is ACTUALLY going on,
 * naming the state that is going and carrying `task:cancel`. When the run settles it is not there
 * either — a strip that says "idle" is the greyed composer again in a smaller box.
 *
 * ## Why this duplicates the header's Cancel
 *
 * `TaskHead` has had one all along, wired to the same `task:cancel`, and nothing here changes it.
 * This one sits where the composer's send button was, which is where the hand already goes, and it
 * is the only one of the two that says WHAT it would be stopping. The pair is safe for exactly one
 * reason and it must stay true: both are task-scoped, so pressing either does the same thing to the
 * same run. The day one of them means "stop this state" they become a trap.
 */
export function RunActivity({
  detail,
  onStop,
  asking,
  onRerun,
  onResume,
  onSkip,
}: {
  detail: TaskDetail;
  onStop: () => void;
  /**
   * A gate is on offer under this strip — see {@link RunConversation}.
   *
   * It outranks the row's own status because a durable gate makes those two things independent: the
   * question is live and the process that was blocked on it is not. Reporting the stop here would
   * put "Retry" — which starts over and discards the answer — immediately above the control that
   * answers.
   */
  asking?: boolean | undefined;
  /** Set it going again. Absent ⇒ the strip reports the stop and offers nothing — see the context field. */
  onRerun?: ((taskId: string) => void) | undefined;
  /** Pick it up where it stopped. Absent ⇒ the strip only ever offers the restart. */
  onResume?: ((taskId: string) => void) | undefined;
  /**
   * Skip to a fast-forward's target (decision 0005 §4). Absent ⇒ a fast-forward is drawn without it,
   * which a caller should not do: "Skip is always showing" is the decision's word.
   */
  onSkip?: (() => void) | undefined;
}): JSX.Element | null {
  if (detail.fastForward !== undefined) return <FastForwardStrip forward={detail.fastForward} onStop={onStop} onSkip={onSkip} />;
  const deepest = detail.activePath[detail.activePath.length - 1];
  const node = deepest === undefined ? undefined : nodeAt(detail.instances, deepest.instanceId);
  // A gate is not motion but it is still something happening, and it is happening to YOU — which is
  // the one status here worth colouring differently, because it is the one you can end by acting.
  const waiting = node?.status === "waiting_for_user" || asking === true;
  const going = detail.status === "running" || waiting;
  // A stop has been asked for and the run has not settled. Neither going nor stopped: the agent is
  // finishing the tool it is inside, and what it says on the way out is still arriving.
  const stopping = detail.status === "stopping";
  const startedAt = detail.runs.find((run) => run.outcome === "running")?.startedAt;
  // Once a second. The transcript's own counter runs in tenths to prove a thinking model is alive;
  // nobody watches the tenths of a run that has been going for four minutes.
  const elapsed = useElapsed(startedAt, going, 1000);

  // The whole path, not just its tail: `review` on its own says nothing on a workflow with three
  // states called review, and the path is how the panel below is already labelled.
  const where = detail.activePath.map((step) => step.childKey ?? step.stateId.split("/").pop() ?? step.stateId).join(" → ");
  const at = where.length > 0 ? <b>{where}</b> : <b>this run</b>;

  if (stopping) {
    return (
      <div className="run-doing warn">
        <Pulse />
        <span className="ellip">
          Stopping {at} — waiting for the agent to finish what it is doing
        </span>
        <span className="grow" />
        {/* Rung 4, OFFERED rather than taken. The gate is shut and the turn is ending; this is for
            the person who does not want to wait for either. */}
        <button type="button" className="danger" onClick={onStop}>
          Force stop
        </button>
      </div>
    );
  }

  if (going) {
    return (
      <div className={waiting ? "run-doing waiting" : "run-doing"}>
        <Pulse />
        <span className="ellip">
          {waiting ? "Waiting for you in " : "Running "}
          {at}
        </span>
        {elapsed !== undefined ? (
          <>
            <span className="run-doing-cut">·</span>
            <span className="run-doing-el">{durationOf(elapsed)}</span>
          </>
        ) : null}
        <span className="grow" />
        <button type="button" className="danger" onClick={onStop}>
          Stop
        </button>
      </div>
    );
  }

  /**
   * A run that STOPPED, which is also something that happened here.
   *
   * The strip was only ever drawn while something was moving, on the reasoning that a settled run
   * has nothing to say. That is right for a run that finished and wrong for every other way of
   * stopping: failed, canceled and interrupted are all states somebody is looking at the panel
   * BECAUSE of, and the panel said nothing about any of them — the badge in the header carried the
   * whole story, and the thing you wanted to do about it was three clicks away.
   *
   * `completed` is still nothing. A run that did what it was asked is the one case where silence is
   * the correct report.
   */
  const stopped = stoppedAction(detail);
  if (stopped === undefined || onRerun === undefined) return null;
  // `onResume` absent (a caller that has not wired the channel) falls back to the rerun it always
  // did — with the fallback WORDING too, since the button would otherwise promise a continuation it
  // is not going to perform.
  const resuming = stopped.act === "resume" && onResume !== undefined;
  const act = resuming ? onResume! : onRerun;
  const fallback = STOPPED[detail.status]!;
  return (
    <div className={`run-doing ${stopped.tone}`}>
      <span className={`run-doing-mark ${stopped.tone}`} aria-hidden="true" />
      <span className="ellip">
        {stopped.said} {detail.activePath.length > 0 ? <>in {at}</> : null}
      </span>
      <span className="grow" />
      <button
        type="button"
        className="primary"
        onClick={() => act(detail.taskId)}
        title={resuming ? stopped.hint : fallback.hint}
      >
        {resuming ? stopped.verb : fallback.verb}
      </button>
    </div>
  );
}

/**
 * The activity strip while a task is being FAST-FORWARDED (decision 0005 §4) — the strip with a
 * destination and a way past it.
 *
 * "Fast-forwarding to **implementation** · at **ux → item** · 1 of 3", then **Skip to implementation**
 * beside **Stop**. Skip is ALWAYS here while the mode is: it is the one thing a person watching work
 * run ahead of them needs within reach, and it is not in the strip's ordinary vocabulary anywhere
 * else. No elapsed clock: what the strip is counting is states, not seconds.
 */
export function FastForwardStrip({ forward, onStop, onSkip }: { forward: FastForwardView; onStop: () => void; onSkip?: (() => void) | undefined }): JSX.Element {
  const of = forward.through.length;
  return (
    <div className="run-doing ffwd" data-testid="ffwd-strip">
      <Pulse />
      <span className="ellip">
        Fast-forwarding to <b>{forward.targetLabel}</b>
      </span>
      {forward.at !== undefined ? (
        <>
          <span className="run-doing-cut">·</span>
          <span className="ellip">
            at <b>{forward.at}</b>
          </span>
        </>
      ) : null}
      {of > 0 ? (
        <>
          <span className="run-doing-cut">·</span>
          <span className="ffwd-steps" title={forward.through.join(", ")}>
            {Math.max(forward.step, 1)} of {of}
          </span>
        </>
      ) : null}
      <span className="grow" />
      {onSkip !== undefined ? (
        <button type="button" onClick={onSkip} title={`Stop what is running and go straight to ${forward.targetLabel}; what is between is recorded as skipped`}>
          Skip to {forward.targetLabel}
        </button>
      ) : null}
      <button type="button" className="danger" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}

/**
 * One run, in the middle column of the Tasks view — the mirror of {@link CompositeView}.
 *
 * Same two readings of the same thing, reached without a file. `CompositeView` starts from a
 * `StateView` because the Files view got there by opening a document; here the address arrived by
 * drilling a board, and the only state on it is the one the trail's tail already names. So the
 * declared children come from `trailState` — fetched by every walk — rather than from a document
 * nobody opened.
 *
 * Clicking a card WALKS IN, which is what makes the address grow a segment instead of the view
 * quietly redrawing one level down with no record of where it was.
 */
export function RunView({ context }: { context: FileSurfaceProps["context"] }): JSX.Element {
  const { detail, trail, trailState, onWalkInto } = context;
  const tail = trail?.at(-1);
  const node = tail === undefined ? undefined : nodeAt(detail?.instances ?? [], tail.instanceId);
  const declared = trailState?.children ?? [];
  const [ownMode, setOwnMode] = useState<RunMode>("board");
  const mode = context.runMode ?? ownMode;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const openRun = (child: InstanceNode): void => {
    if (onWalkInto !== undefined) return onWalkInto(child);
    setOpen(new Set([child.instanceId]));
  };

  // A run that declared no children and entered none is a LEAF of the walk: there is no board to
  // draw for it, so its conversation is the only reading, whatever the toggle says.
  const board = mode === "board" && (declared.length > 0 || (node?.children.length ?? 0) > 0);

  // A sidechain tail is its own kind of place: a subagent conversation has no board and no children
  // of its own, so the panel is that conversation whatever the toggle says.
  if (tail?.sidechain !== undefined) {
    return (
      <div className="composite">
        <SidechainConversation step={tail} context={context} />
      </div>
    );
  }

  if (node === undefined) return <p className="empty">This task has not run here yet.</p>;
  const columns = declared.length > 0 ? declared : [...runsByChild(node).keys()].map((key) => ({ key }));
  return (
    <div className="composite">
      {board ? (
        <RunBoard
          declared={declared}
          parent={node}
          openInstance={open.size === 1 ? [...open][0]! : null}
          // One click marks the execution AND puts it in the context panel: the inspector, scoped to
          // this pass — the inputs it was called with, its run history. A click that only drew a
          // highlight left the panel describing the task while the person was pointing at one of
          // its executions, which is the pair of things this board exists to tell apart.
          onSelect={(child) => {
            setOpen(new Set([child.instanceId]));
            context.onOpenWorkflow?.(child.stateId, child.instanceId);
          }}
          onOpen={openRun}
          // What this run is waiting for somebody to do, where a column here is the place to do it.
          offers={runDragOffersOf(detail?.taskId, columns, context.userEvents)}
          onDrop={context.onDeliverUserEvent}
        />
      ) : (
        // The bookmark the task panel's Instances index sends — see `TaskContext.goTo`. This column
        // is the document when the toggle says Conversation, so it is the column that scrolls.
        <RunConversation
          parent={node}
          detail={detail}
          context={context}
          {...(context.runFocus !== undefined ? { focus: context.runFocus } : {})}
          {...(context.onRunHere !== undefined ? { onHere: context.onRunHere } : {})}
          {...(context.runGate !== undefined && context.onRunGate !== undefined
            ? {
                asking: true,
                gate: context.runGate,
                onGate: context.onRunGate,
                ...(context.runGateServices !== undefined ? { gateServices: context.runGateServices } : {}),
                ...(context.runGateEditor !== undefined ? { gateEditor: context.runGateEditor } : {}),
              }
            : {})}
          {...(context.runQuestion !== undefined && context.onRunQuestion !== undefined
            ? { asking: true, question: context.runQuestion, onQuestion: context.onRunQuestion }
            : {})}
          {...(context.runApproval !== undefined && context.onRunApproval !== undefined
            ? { asking: true, approval: context.runApproval, onApproval: context.onRunApproval }
            : {})}
        />
      )}
    </div>
  );
}

/**
 * The Tasks view's context panel: a task, read as its conversation.
 *
 * Clicking a card is a question about what that task SAID, and the panel used to answer with a form
 * — an instance tree, a line of event types, a blob of JSON outputs. All three are facts about the
 * run and none of them is the run, so reading one meant clicking through into the Files view to find
 * the transcript that was there all along.
 *
 * The conversation is the default and the detail is behind a toggle, in that order, because the
 * detail is what you go looking for once the conversation has told you something is wrong.
 *
 * `parent` is the task's ROOT instance, so every session under it is flattened into the same set of
 * panels — see {@link RunConversation}. The Files view walks a trail and reads one level of it; here
 * there is no walk, and the whole task is the answer.
 */
export function TaskContext({
  detail,
  stream,
  context,
  onStart,
  onCancel,
  onOpenState,
  onReviewChanges,
  gate,
  onGate,
  gateServices,
  gateEditor,
}: {
  detail: TaskDetail;
  stream: string[];
  context: FileSurfaceProps["context"];
  onStart: () => void;
  onCancel: () => void;
  onOpenState?: ((stateId: string) => void) | undefined;
  onReviewChanges?: (() => void) | undefined;
  /**
   * A parked gate ABOUT this task, hosted here rather than in a modal — §8.1's default host: what a
   * state asked is part of what happened in this conversation, and reading it here is where someone
   * will look for it.
   *
   * Any component, not only the reviewer. The gate that survives a restart arrives the same way and
   * is drawn the same way; `PendingInteraction.resumes` is the only thing that differs, and
   * {@link GateSurface} is where it is said.
   */
  gate?: PendingInteraction | undefined;
  onGate?: ((value: unknown) => void) | undefined;
  gateServices?: Partial<ComponentServices> | undefined;
  /** What `edit_artifact` and the artifact viewers need to be the app's editor. */
  gateEditor?: EditorServices | undefined;
}): JSX.Element {
  const [mode, setMode] = useState<"conversation" | "detail">("conversation");
  /**
   * Where the Instances index last sent the reader.
   *
   * Held here rather than in the index because it has to outlive the mode: a bookmark pressed in
   * Details flips this panel to Conversation, and the conversation that then MOUNTS is the thing
   * that has to scroll. The alternative — doing nothing when the conversation is not on screen —
   * makes every label in this panel inert, since the two readings share one column.
   */
  const [focus, setFocus] = useState<{ instance: string; at: number } | undefined>(undefined);
  /**
   * WHICH conversation the bookmark is for.
   *
   * When the middle column is showing this task's conversation — the Tasks view's toggle says
   * Conversation — that column is the document, and a label pressed in this panel's Details reading
   * has to scroll IT: this panel keeping its own conversation beside the real one, and scrolling
   * that, was a bookmark that visibly did nothing. The ask goes up to the shell (`onRunFocus`), and
   * this panel stays on Details, which is where the person was reading. Otherwise — a board in the
   * middle, or no shell at all — the conversation this panel can show is the only one, as before.
   */
  const goTo = (node: InstanceNode): void => {
    const bookmark = { instance: node.instanceId, at: Date.now() };
    if (context.runMode === "conversation" && context.onRunFocus !== undefined) {
      context.onRunFocus(bookmark);
      return;
    }
    setFocus(bookmark);
    setMode("conversation");
  };
  /**
   * The state the index marks as "here": where the middle column's conversation is scrolled to, when
   * that column is the conversation (`runHere` follows its scroll), else the last bookmark pressed
   * in this panel — the one thing this panel knows about its own conversation's position.
   */
  const here = context.runMode === "conversation" && context.onRunFocus !== undefined ? context.runHere : focus?.instance;
  // The task's own root run. A task that has never run has none, and the conversation says so.
  const root = detail.instances[0];
  /**
   * The subagent conversations walked into, as a LOCAL stack — this panel has no address bar, so
   * the steps live here rather than on the trail. Same shape, same pruning rule: the steps are
   * `TrailStep`s and `prunedTrail` is what keeps them honest against a task that re-ran. Reset on a
   * selection change for the same reason the trail is — instance ids name one task's run only.
   */
  const [chain, setChain] = useState<TrailStep[]>([]);
  useEffect(() => setChain([]), [detail.taskId]);
  /**
   * A question arriving takes the panel to where the question IS.
   *
   * The two readings share one column and Details returns before the gate is drawn, so a person who
   * had left the panel on Details would have a task that had stopped, no visible reason, and the
   * one thing that would explain it hidden behind a toggle. Nothing else in this panel moves the
   * reader; this does, because the alternative is silence.
   */
  const asking = gate?.requestId;
  useEffect(() => {
    if (asking !== undefined) setMode("conversation");
  }, [asking]);
  /**
   * Whether the conversation has a panel to put the question in.
   *
   * Asked of the same tree the panels are built from, with the same predicate the renderer uses, so
   * the two cannot disagree about whether the gate was drawn — and the alternative to asking is a
   * question that silently belongs to nobody.
   */
  const hosted = gate !== undefined && detail.instances.some((node) => hasAsking(node));
  /**
   * The index's two verbs — the same cut the conversation offers, from the Details reading.
   *
   * A row there is a state, and the journal position of its entry is in the conversation the shell
   * already holds. No strip to arm in this reading, so the rewind asks through a dialog instead.
   */
  const [ask, setAsk] = useState<AskSpec | null>(null);
  const seqOfEntry = (node: InstanceNode): number | undefined =>
    context.conversation?.turns.find((turn) => turn.kind === "entered" && turn.instanceId === node.instanceId)?.seq;
  const nameOfNode = (node: InstanceNode): string => node.childKey ?? node.stateId.split("/").pop() ?? node.stateId;
  const indexCut =
    context.onRewind !== undefined && context.onFork !== undefined
      ? {
          rewind: (node: InstanceNode) => {
            const seq = seqOfEntry(node);
            if (seq === undefined) return;
            setAsk({
              title: `Rewind to before ${nameOfNode(node)}?`,
              note: "It and every state entered after it are deleted, and the run enters it again. Files edited in the worktree stay as they are. This cannot be undone.",
              confirmLabel: "Rewind",
              danger: true,
              onConfirm: () => {
                setAsk(null);
                context.onRewind?.(detail.taskId, seq);
              },
            });
          },
          fork: (node: InstanceNode) => {
            const seq = seqOfEntry(node);
            if (seq !== undefined) context.onFork?.(detail.taskId, seq);
          },
        }
      : undefined;
  const hops = prunedTrail(chain, detail.instances, (id) => context.sessions[id]);
  const pushHop = (node: InstanceNode, call: string, name: string): void =>
    setChain([...hops, { instanceId: node.instanceId, stateId: node.stateId, sidechain: call, name }]);
  const standing = hops[hops.length - 1];

  if (mode === "detail") {
    return (
      <div className="detail">
        <TaskHead
          detail={detail}
          onStart={onStart}
          onCancel={onCancel}
          {...(onOpenState ? { onOpenState } : {})}
          {...(onReviewChanges ? { onReviewChanges } : {})}
        >
          <button className="ghost" onClick={() => setMode("conversation")}>
            Conversation
          </button>
        </TaskHead>
        <TaskDetailSections
          detail={detail}
          stream={stream}
          onGoTo={goTo}
          {...(hosted ? { asking: askingInstanceOf(detail.instances) } : {})}
          {...(here !== undefined ? { here } : {})}
          {...(indexCut !== undefined ? { onCut: indexCut } : {})}
        />
        {ask !== null ? <AskDialog spec={ask} onCancel={() => setAsk(null)} /> : null}
      </div>
    );
  }

  return (
    <div className="detail task-context">
      <TaskHead
        detail={detail}
        onStart={onStart}
        onCancel={onCancel}
        {...(onOpenState ? { onOpenState } : {})}
        {...(onReviewChanges ? { onReviewChanges } : {})}
      >
        <button className="ghost" onClick={() => setMode("detail")}>
          Details
        </button>
      </TaskHead>
      {standing !== undefined ? (
        <>
          {/* The way back out: the panel's own little address, one crumb per doorway walked
              through, with the conversation itself as the root. The same reading the address bar
              gives the same walk in the middle column — smaller, because this panel is. */}
          <div className="sc-crumbs">
            <button type="button" className="sc-crumb" onClick={() => setChain([])}>
              Conversation
            </button>
            {hops.map((hop, i) => (
              <span key={`${hop.instanceId}:${hop.sidechain}`} className="sc-crumb-part">
                <span className="crumb-sep">›</span>
                {i === hops.length - 1 ? (
                  <span className="sc-crumb last">{hop.name ?? hop.sidechain}</span>
                ) : (
                  <button type="button" className="sc-crumb" onClick={() => setChain(hops.slice(0, i + 1))}>
                    {hop.name ?? hop.sidechain}
                  </button>
                )}
              </span>
            ))}
          </div>
          <SidechainConversation step={standing} context={context} onOpen={pushHop} />
        </>
      ) : (
        <RunConversation
          parent={root}
          detail={detail}
          context={context}
          onOpenSidechain={pushHop}
          {...(gate !== undefined && onGate !== undefined
            ? {
                asking: true,
                gate,
                onGate,
                ...(gateServices !== undefined ? { gateServices } : {}),
                ...(gateEditor !== undefined ? { gateEditor } : {}),
              }
            : {})}
          {...(focus !== undefined ? { focus } : {})}
        />
      )}
      {gate !== undefined && onGate !== undefined && !hosted ? (
        // The FALLBACK, and only that. The question belongs in the panel of the state that raised it
        // — `RunConversation` puts it there — and this is what happens when the tree has no such
        // panel to put it in: a record still loading, or a gate parked by an instance the projection
        // has not caught up with. A question with nowhere to go must not disappear, so it goes here,
        // at the end, which is where it used to live for everything.
        <section className="inline-gate" data-testid="inline-gate">
          <GateSurface
            pending={gate}
            onSubmit={onGate}
            services={gateServices}
            {...(gateEditor !== undefined ? { editor: gateEditor } : {})}
          />
        </section>
      ) : null}
    </div>
  );
}

/** Which of the two readings the panel is showing. Held per state, so switching files does not reset it. */
export type RunMode = "board" | "conversation";

/** The toggle itself. Two words, because the two readings need naming rather than iconography. */
export function RunModeToggle({ mode, onMode }: { mode: RunMode; onMode: (mode: RunMode) => void }): JSX.Element {
  return (
    <div className="run-mode">
      <button type="button" className={mode === "board" ? "on" : undefined} onClick={() => onMode("board")}>
        Tasks
      </button>
      <button
        type="button"
        className={mode === "conversation" ? "on" : undefined}
        onClick={() => onMode("conversation")}
      >
        Conversation
      </button>
    </div>
  );
}

/**
 * Where the walk is standing, and what is under it.
 *
 * The trail's tail is the answer to both questions, and everything the panel renders comes from
 * here. The FALLBACK is what keeps the old behaviour honest rather than special: with no run walked
 * into, the run is this state's own newest instance and the declared children are the open file's —
 * exactly what the panel showed before there was a trail.
 */
export function standingOn(
  state: StateView,
  context: FileSurfaceProps["context"],
): {
  node: InstanceNode | undefined;
  stateId: string;
  declared: readonly StateChild[];
  deep: boolean;
  /** Set when the tail is a SUBAGENT CONVERSATION — `node` is then its host. See `TrailStep.sidechain`. */
  sidechain?: string;
} {
  const detail = context.detail;
  const tail = context.trail?.at(-1);
  if (tail === undefined) {
    return {
      node: instanceOfState(detail?.instances ?? [], state.stateId),
      stateId: state.stateId,
      declared: state.children,
      deep: false,
    };
  }
  const deep = tail.stateId !== state.stateId;
  return {
    node: nodeAt(detail?.instances ?? [], tail.instanceId),
    stateId: tail.stateId,
    // A step deeper is a different state, and its columns are ITS declared children. `trailState` is
    // fetched for exactly this; without it the board falls back to what actually ran, which is the
    // instance tree's own answer and misses only the children nothing reached.
    declared: deep ? (context.trailState?.children ?? []) : state.children,
    deep,
    ...(tail.sidechain !== undefined ? { sidechain: tail.sidechain } : {}),
  };
}

/**
 * Everything a state's viewer shows: whichever reading the toggle selects, of wherever the trail is
 * standing.
 *
 * The toggle is in the panel's top bar — it is a statement about what the whole middle column is
 * showing, and it belongs with the address bar for the same reason a browser's view controls do.
 * The mode comes from the context when there is a bar to set it and from local state when there is
 * not, so this component works either way rather than requiring a host it cannot check for.
 *
 * Clicking a run card WALKS IN rather than opening it in place: the card is a level of the address,
 * so it becomes the last crumb and this view redraws one level down. That is the only way out of the
 * old behaviour's dead end, where three levels of drilling left no record of the two above.
 */
export function CompositeView(props: FileSurfaceProps & { state: StateView }): JSX.Element {
  const { state, context } = props;
  const { detail, selected, onSelectTask, onDrill, onWalkInto } = context;
  const [ownMode, setOwnMode] = useState<RunMode>("board");
  const mode = context.runMode ?? ownMode;
  const setMode = context.onRunMode ?? setOwnMode;
  // Which card the BOARD is showing as selected. It no longer decides anything in the conversation —
  // the panels there open every session they hold — so this is now what it always looked like: the
  // board's own selection.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const at = standingOn(state, context);

  // Standing on a sidechain step: the view is that subagent conversation, and neither reading of a
  // composite applies — there is no board a conversation could declare.
  const tailStep = context.trail?.at(-1);
  if (at.sidechain !== undefined && tailStep !== undefined) {
    return (
      <div className="composite">
        <SidechainConversation step={tailStep} context={context} />
      </div>
    );
  }

  /**
   * Clicking a card walks into it. Without a host that can — a surface rendered outside the shell —
   * it falls back to what it did before: show that run's conversation in place.
   */
  const openRun = (node: InstanceNode): void => {
    if (onWalkInto !== undefined) return onWalkInto(node);
    setMode("conversation");
    setOpen(new Set([node.instanceId]));
  };

  // A run that declared no children and entered none is a LEAF of the walk: there is no board to
  // draw for it, so its conversation is the only reading and the toggle says so by being absent.
  const board =
    mode === "board" && (at.declared.length > 0 || (at.node?.children.length ?? 0) > 0 || at.node === undefined);

  return (
    // No bar of its own naming the run any more. Which run every reading is about is a question the
    // ADDRESS answers — it is the last element of the path — and saying it twice, once in a path and
    // once in a strip below it, is how the two come to disagree.
    <div className="composite">
      {board ? (
        at.node === undefined ? (
          // No run walked into: the workflow's own shape, from the task board. Cards are tasks here
          // because there is no run to take executions from — which is the honest answer, not a
          // second design. Clicking one selects it, which is what puts a run on the path.
          // The click event the board hands over is dropped here on purpose, and it has to be: this
          // surface's `onSelectTask` is `(taskId) => void` over `actions.select(taskId, project)`,
          // so passing the board's second argument straight through handed a MouseEvent to a
          // parameter that names a database. There is no multi-selection on this board to read it
          // for — that lives on the Tasks view, which keeps the set.
          <Board
            board={state.board!}
            selected={selected}
            trays={false}
            onSelectTask={(taskId) => onSelectTask(taskId)}
            onDrill={onDrill}
          />
        ) : (
          <RunBoard
            declared={at.declared}
            parent={at.node}
            openInstance={open.size === 1 ? [...open][0]! : null}
            onSelect={(node) => setOpen(new Set([node.instanceId]))}
            onOpen={openRun}
            offers={runDragOffersOf(detail?.taskId, at.declared, context.userEvents)}
            onDrop={context.onDeliverUserEvent}
          />
        )
      ) : (
        <RunConversation parent={at.node} detail={detail} context={context} />
      )}
    </div>
  );
}
