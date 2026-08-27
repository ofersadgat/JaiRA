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
import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type {
  ChatPlanView,
  ChatSettings,
  InstanceNode,
  PendingInteraction,
  StateChild,
  StateView,
  TaskDetail,
} from "@jaira/shared/browser";
import { Board, Column, Tile } from "./board";
import { ChangesetGate } from "./components";
import type { ComponentServices } from "./changesetReview";
import { TaskDetailSections, TaskHead } from "./detail";
import { entriesOf, journalFor, sidechainEntriesOf, signatureOf } from "./transcript";
import { instanceOf as instanceOfState, nodeAt, prunedTrail, type TrailStep } from "./trail";
import { Paper, Pulse, Transcript, durationOf, useElapsed } from "./transcriptView";
import { bandsOf, instancesOf, mountPathOf, notesOf, piecesOf, runForksOf, type SessionPiece } from "./sessionBands";
import { SessionBandsView } from "./sessionPanels";
import type { FileSurfaceProps } from "./fileTypes";
import { Composer } from "./composer";
import { invoke } from "./store";

// Moved to `trail.ts`, which is where the tree queries live now — it also seeds a walk, and that
// has to work for a composite, which has no session row to look one up by. Re-exported because this
// is where the board that uses it has always found it.
export { instanceOf } from "./trail";

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
}: {
  node: InstanceNode;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
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
}: {
  /** The state's declared children, in run order — the columns, whether or not anything ran. */
  declared: readonly StateChild[];
  parent: InstanceNode | undefined;
  openInstance: number | null;
  /** One click: mark it. */
  onSelect: (node: InstanceNode) => void;
  /** Two: walk into it. */
  onOpen: (node: InstanceNode) => void;
}): JSX.Element {
  const byChild = useMemo(() => runsByChild(parent), [parent]);
  // What actually ran, when nothing says what was declared — a state view still in flight, or one
  // that would not load. Fewer columns than the truth (a child nothing reached cannot appear) but
  // never wrong about the ones it draws, which beats an empty board while a fetch lands.
  const columns = declared.length > 0 ? declared : [...byChild.keys()].map((key) => ({ key }) as StateChild);
  return (
    // The same board the Tasks view draws, down to the class names: one column per declared child,
    // numbered in run order, cards inside. What differs is that a card here is one EXECUTION.
    <div className="board-body">
      <div className="columns">
        {columns.map((child, index) => {
          const runs = byChild.get(child.key) ?? [];
          return (
            <Column key={child.key} name={child.label ?? child.key} seq={index + 1} count={runs.length} empty="not reached">
              {runs.map((node, i) => (
                <RunTile
                  key={`${node.runId ?? ""}:${node.instanceId}`}
                  node={node}
                  index={i}
                  total={runs.length}
                  selected={node.instanceId === openInstance}
                  onSelect={() => onSelect(node)}
                  onOpen={() => onOpen(node)}
                />
              ))}
            </Column>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What one panel's transcript is cached and fetched UNDER.
 *
 * Run and instance, never the instance alone. Ids are minted `nextInstanceId++` per walk, so `#i2`
 * names a different state in every run — a cache keyed on it hands a resumed task's panel whichever
 * run last wrote that id, and the failure is silent: someone else's conversation, correctly drawn,
 * under the wrong heading. A single-run projection stamps no run, and then the id alone is the whole
 * key because there is only one run to confuse it with.
 */
export function sessionKey(at: { runId?: number; instanceId: number }): string {
  return at.runId === undefined ? String(at.instanceId) : `${at.runId}:${at.instanceId}`;
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
}: {
  /** The run whose conversation this is. Undefined ⇒ nothing has run here yet. */
  parent: InstanceNode | undefined;
  detail: TaskDetail | null;
  context: FileSurfaceProps["context"];
  /**
   * Where "walk into this subagent conversation" goes, when this panel's host has somewhere for it.
   * Defaults to the trail (`context.onWalkIntoSidechain`); the task panel passes its own stack.
   * The node is the PIECE the doorway was clicked in — the host whose session holds the chain.
   */
  onOpenSidechain?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
}): JSX.Element {
  const { conversation, liveTurn, sessions, sessionHistory, onLoadSessions, onOpenWorkflow } = context;
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
  const bands = useMemo(() => bandsOf(piecesOf(parent, sessionHistory)), [parent, sessionHistory]);
  /** Every place the task divided — an address more than one run did its own work at. */
  const runForks = useMemo(
    () => runForksOf(bands.flatMap((band) => band.segments.flatMap((segment) => segment.pieces))),
    [bands],
  );
  const needed = useMemo(() => instancesOf(bands), [bands]);
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
  const notes = useMemo(() => notesOf(conversation?.turns ?? []), [conversation]);
  /**
   * Where the run being READ sits, so a note's path is shown from here rather than from the root of
   * the workflow. Walking into `product` should leave its notes saying `explore`, not
   * `product → explore` — the second half is the page you are already on.
   */
  const rootPath = useMemo(
    () => (parent === undefined ? "" : mountPathOf(detail?.instances ?? [], parent.instanceId)),
    [detail, parent],
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
    const view = sessions[sessionKey(piece.node)];
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
    const entries = entriesOf(view, journalFor(conversation?.turns ?? [], piece.node.stateId), live);
    return (
      <Transcript
        session={view}
        entries={entries}
        live={live}
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
  };

  return (
    <div className="run-convo-wrap">
      <div className="run-convo scroll">
        <SessionBandsView
          bands={bands}
          render={render}
          notes={notes}
          runForks={runForks}
          {...(rootPath !== undefined ? { root: rootPath } : {})}
          {...(onOpenWorkflow !== undefined
            ? { onOpenWorkflow: (piece: SessionPiece) => onOpenWorkflow(piece.node.stateId, piece.node.instanceId) }
            : {})}
          empty="This run has not entered a child yet."
        />
      </div>
      {/* Pinned below the scroller, not inside it: what you are about to say does not scroll away
          with what was already said. */}
      <ChatComposer
        taskId={detail.taskId}
        instanceId={parent?.instanceId}
        project={context.project}
        running={detail.status === "running"}
        detail={detail}
        {...(context.onRerun !== undefined ? { onRerun: context.onRerun } : {})}
        {...(context.onResume !== undefined ? { onResume: context.onResume } : {})}
      />
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
    const at = { instanceId: step.instanceId, ...(host?.runId !== undefined ? { runId: host.runId } : {}) };
    if (sessions[sessionKey(at)] === undefined) onLoadSessions([at]);
  }, [sessions, step.instanceId, host, onLoadSessions]);

  const liveItems = liveTurn?.sidechains[call];
  const entries = useMemo(() => sidechainEntriesOf(view, call, liveItems), [view, call, liveItems]);

  if (step.sidechain === undefined) return <p className="empty">This step is not a subagent conversation.</p>;
  if (view === null && liveItems === undefined) return <p className="empty">Loading…</p>;
  return (
    <div className="run-convo-wrap">
      <div className="run-convo scroll">
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
  onRerun,
  onResume,
}: {
  taskId: string;
  instanceId: number | undefined;
  project?: string | undefined;
  /** The TASK is still going — what makes the button a stop button. See {@link stop}. */
  running?: boolean;
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
    if (running === true) {
      void invoke("task:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    void invoke("chat:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch(() => undefined);
  };

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
  if (plan === null && instanceId !== undefined) {
    return (
      <div className="cx-doing">
        {error !== null ? <p className="cx-error">{error}</p> : null}
        <RunActivity
          detail={detail}
          onStop={stop}
          {...(onRerun !== undefined ? { onRerun } : {})}
          {...(onResume !== undefined ? { onResume } : {})}
        />
      </div>
    );
  }

  return (
    <>
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
  onRerun,
  onResume,
}: {
  detail: TaskDetail;
  onStop: () => void;
  /** Set it going again. Absent ⇒ the strip reports the stop and offers nothing — see the context field. */
  onRerun?: ((taskId: string) => void) | undefined;
  /** Pick it up where it stopped. Absent ⇒ the strip only ever offers the restart. */
  onResume?: ((taskId: string) => void) | undefined;
}): JSX.Element | null {
  const deepest = detail.activePath[detail.activePath.length - 1];
  const node = deepest === undefined ? undefined : nodeAt(detail.instances, deepest.instanceId);
  // A gate is not motion but it is still something happening, and it is happening to YOU — which is
  // the one status here worth colouring differently, because it is the one you can end by acting.
  const waiting = node?.status === "waiting_for_user";
  const going = detail.status === "running" || waiting;
  const startedAt = detail.runs.find((run) => run.outcome === "running")?.startedAt;
  // Once a second. The transcript's own counter runs in tenths to prove a thinking model is alive;
  // nobody watches the tenths of a run that has been going for four minutes.
  const elapsed = useElapsed(startedAt, going, 1000);

  // The whole path, not just its tail: `review` on its own says nothing on a workflow with three
  // states called review, and the path is how the panel below is already labelled.
  const where = detail.activePath.map((step) => step.childKey ?? step.stateId.split("/").pop() ?? step.stateId).join(" → ");
  const at = where.length > 0 ? <b>{where}</b> : <b>this run</b>;

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
  const resuming = stopped.resume && onResume !== undefined;
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
 * What each way of stopping is called, and what starting it again actually does.
 *
 * The verbs are different because the ACTS are different, and the engine is what decides which:
 * `isStartableStatus` lets an interrupted or failed task begin again in place, against the snapshot
 * its first run pinned, while a canceled one has ended its lifecycle and can only be copied into a
 * fresh task (see `service.rerunTask`). One button either way, but it must not claim to resume when
 * what it will do is start over, and it must not claim to be the same task when what comes back is
 * a new one.
 *
 * These are the FALLBACK verbs — what a stop is called when resuming is not on offer. A task whose
 * record can still be replayed gets {@link RESUMABLE} instead, which is the whole reason this table
 * no longer has the last word.
 */
const STOPPED: Partial<Record<TaskDetail["status"], { said: string; verb: string; hint: string; tone: string }>> = {
  failed: {
    said: "Failed",
    verb: "Try again",
    hint: "Runs the workflow again from the top, against the snapshot this task pinned",
    tone: "bad",
  },
  interrupted: {
    said: "Interrupted",
    verb: "Start again",
    hint: "Runs the workflow again from the top, against the snapshot this task pinned",
    tone: "warn",
  },
  canceled: {
    said: "Stopped",
    verb: "Run again",
    hint: "A canceled run cannot restart — this starts a fresh copy of the task and opens it",
    tone: "warn",
  },
  queued: { said: "Not started", verb: "Start", hint: "Runs the workflow", tone: "idle" },
};

/**
 * The two verbs a task with a readable record gets instead — and why there are two.
 *
 * Both do the SAME thing to the engine: start at the root of the pinned snapshot with the task's
 * replay index, so every operation an earlier run completed is taken from the record rather than
 * dispatched, and the first real call is wherever the answers stop. What differs is the fact each
 * one is reporting, and that difference is not a preference — it is how the run ended.
 *
 *  - **Resume** — the process died with instances still LIVE. There is a frontier: somewhere the run
 *    was in the middle of, which is what it will pick up.
 *  - **Retry** — a state failed and the run ended with it, so every instance terminated and there is
 *    no frontier at all. What the same walk does here is replay everything that worked and re-run
 *    the state that broke, which is a retry of that state with its history intact. Its conversation
 *    position was claimed by the failed attempt, so re-entering forks automatically (SESSIONS.md §4)
 *    rather than stacking a second answer on top of the first.
 *
 * Calling both "Resume" would say "picks up where it left off" about a run that left off nowhere;
 * calling both "Retry" would say "runs it again" about a run that is being continued. Neither is a
 * word this strip can afford to get wrong, which is the same standard the table above is held to.
 */
const RESUMABLE: Record<"continue" | "retry", { verb: string; hint: (kept: number, where: string) => string }> = {
  continue: {
    verb: "Resume",
    hint: (kept, where) =>
      `Picks up in ${where} — keeps the ${kept} operation${kept === 1 ? "" : "s"} this task already finished and runs nothing again`,
  },
  retry: {
    verb: "Retry",
    hint: (kept) =>
      `Re-runs the state that failed — keeps the ${kept} operation${kept === 1 ? "" : "s"} before it and runs none of them again`,
  },
};

/** What the strip offers for a stopped task: the resume verb where there is one, else the fallback. */
export function stoppedAction(
  detail: Pick<TaskDetail, "status" | "resume">,
): { said: string; verb: string; hint: string; tone: string; resume: boolean } | undefined {
  const stopped = STOPPED[detail.status];
  if (stopped === undefined) return undefined;
  const plan = detail.resume;
  if (plan === undefined || plan.kind === "none") {
    // A record with a hole in it says so on the button that is still offered, rather than leaving a
    // person to wonder why the one they expected is missing.
    const blocked = plan?.blocked;
    return {
      ...stopped,
      ...(blocked !== undefined ? { hint: `${stopped.hint} — resuming is unavailable: ${blocked}` } : {}),
      resume: false,
    };
  }
  const shape = RESUMABLE[plan.kind];
  const where = plan.frontier.map((entry) => entry.stateId.split("/").pop() ?? entry.stateId).join(", ");
  return {
    said: stopped.said,
    verb: shape.verb,
    hint: shape.hint(plan.replayed, where.length > 0 ? where : "this run"),
    tone: stopped.tone,
    resume: true,
  };
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
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

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
  return (
    <div className="composite">
      {board ? (
        <RunBoard
          declared={declared}
          parent={node}
          openInstance={open.size === 1 ? [...open][0]! : null}
          onSelect={(child) => setOpen(new Set([child.instanceId]))}
          onOpen={openRun}
        />
      ) : (
        <RunConversation parent={node} detail={detail} context={context} />
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
}: {
  detail: TaskDetail;
  stream: string[];
  context: FileSurfaceProps["context"];
  onStart: () => void;
  onCancel: () => void;
  onOpenState?: ((stateId: string) => void) | undefined;
  onReviewChanges?: (() => void) | undefined;
  /**
   * A parked changeset gate ABOUT this task, hosted here rather than in the modal — §8.1's default
   * host: a review is part of what happened in this conversation, and reading it here is where
   * someone will look for it.
   */
  gate?: PendingInteraction | undefined;
  onGate?: ((value: unknown) => void) | undefined;
  gateServices?: Partial<ComponentServices> | undefined;
}): JSX.Element {
  const [mode, setMode] = useState<"conversation" | "detail">("conversation");
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
        <TaskDetailSections detail={detail} stream={stream} />
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
        <RunConversation parent={root} detail={detail} context={context} onOpenSidechain={pushHop} />
      )}
      {gate !== undefined && onGate !== undefined ? (
        // The newest thing in this conversation IS the review — rendered as its latest turn, not
        // floated over it. The same ChangesetGate the modal mounts, exercised by a second host,
        // which is what the mount contract is FOR (CHANGESETS.md §8.1).
        <section className="inline-gate" data-testid="inline-gate">
          <h3>Review requested</h3>
          {gate.configError !== undefined ? (
            <p className="reason">
              This state&apos;s <code>{gate.component}</code> config is invalid: {gate.configError}
            </p>
          ) : gate.config?.component === "review_artifacts" ? (
            <ChangesetGate
              config={gate.config}
              inputs={gate.inputs as Record<string, unknown>}
              onSubmit={onGate}
              about={gate.about}
              project={gate.project}
              services={gateServices}
              mountKey={gate.requestId}
            />
          ) : null}
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
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

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
          <Board board={state.board!} selected={selected} trays={false} onSelectTask={onSelectTask} onDrill={onDrill} />
        ) : (
          <RunBoard
            declared={at.declared}
            parent={at.node}
            openInstance={open.size === 1 ? [...open][0]! : null}
            onSelect={(node) => setOpen(new Set([node.instanceId]))}
            onOpen={openRun}
          />
        )
      ) : (
        <RunConversation parent={at.node} detail={detail} context={context} />
      )}
    </div>
  );
}
