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
import type { ChatPlanView, ChatSettings, InstanceNode, StateChild, StateView, TaskDetail } from "@jaira/shared/browser";
import { Board, Column, Tile } from "./board";
import { entriesOf, journalFor, signatureOf } from "./transcript";
import { instanceOf as instanceOfState, nodeAt } from "./trail";
import { Transcript, durationOf } from "./transcriptView";
import { bandsOf, instancesOf, piecesOf, type SessionPiece } from "./sessionBands";
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
  onOpen,
}: {
  node: InstanceNode;
  index: number;
  total: number;
  selected: boolean;
  onOpen: () => void;
}): JSX.Element {
  const sig = signatureOf(node);
  const took = node.endedAt !== undefined ? durationOf(node.endedAt - node.startedAt) : undefined;
  return (
    <Tile
      status={node.status}
      title={sig.label ?? sig.name}
      selected={selected}
      tip={`${node.stateId} · ${new Date(node.startedAt).toLocaleString()}`}
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
      onSelect={onOpen}
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
  onOpen,
}: {
  /** The state's declared children, in run order — the columns, whether or not anything ran. */
  declared: readonly StateChild[];
  parent: InstanceNode | undefined;
  openInstance: number | null;
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
                  key={node.instanceId}
                  node={node}
                  index={i}
                  total={runs.length}
                  selected={node.instanceId === openInstance}
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
}: {
  /** The run whose conversation this is. Undefined ⇒ nothing has run here yet. */
  parent: InstanceNode | undefined;
  detail: TaskDetail | null;
  context: FileSurfaceProps["context"];
}): JSX.Element {
  const { conversation, liveTurn, sessions, sessionHistory, onLoadSessions } = context;
  // The history spans every run of the task and instance ids restart on each, so an unscoped join
  // would match this run's `#i2` against three older runs' as well. The instance tree is the latest
  // run's, and this is the id that goes with it.
  const runId = detail?.runs[detail.runs.length - 1]?.runId;
  const bands = useMemo(() => bandsOf(piecesOf(parent, sessionHistory, runId)), [parent, sessionHistory, runId]);
  const needed = useMemo(() => instancesOf(bands), [bands]);

  // Every panel is open, so every transcript in them is needed — fetched in one round rather than
  // on expand, which is what the folded card design paid for and this one does not.
  useEffect(() => {
    const missing = needed.filter((instanceId) => sessions[instanceId] === undefined);
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
    const view = sessions[piece.node.instanceId];
    if (view === undefined) return <p className="empty">Loading…</p>;
    const live =
      liveTurn === null
        ? null
        : piece.sessionId !== undefined
          ? liveTurn.sessionId === piece.sessionId && liveTurn.seq === piece.seq
            ? liveTurn.text
            : null
          : liveTurn.stateId === piece.node.stateId && piece.node.status === "running"
            ? liveTurn.text
            : null;
    const entries = entriesOf(view, journalFor(conversation?.turns ?? [], piece.node.stateId), live);
    return <Transcript session={view} entries={entries} />;
  };

  return (
    <div className="run-convo-wrap">
      <div className="run-convo scroll">
        <SessionBandsView bands={bands} render={render} empty="This run has not entered a child yet." />
      </div>
      {/* Pinned below the scroller, not inside it: what you are about to say does not scroll away
          with what was already said. */}
      <ChatComposer taskId={detail.taskId} instanceId={parent?.instanceId} project={context.project} />
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
function ChatComposer({ taskId, instanceId, project }: { taskId: string; instanceId: number | undefined; project?: string | undefined }): JSX.Element {
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

  // Why sending is impossible, when it is. `null` is not a loading state to wait out — the channel
  // answered and said this state has no session of its own, and an enabled box above that answer is
  // an invitation to an error. `undefined` is the wait, and it disables nothing.
  //
  // A composite is the case: it orchestrates and says nothing, so it holds no session, while its
  // CHILDREN each hold one. The message says what is true of the node you are on rather than of the
  // panel, which is showing those children's transcripts.
  const disabled =
    instanceId === undefined
      ? "Select a run to continue its conversation."
      : plan === null
        ? "No chat session exists in this state"
        : undefined;

  return (
    <>
      {error !== null ? <p className="cx-error">{error}</p> : null}
      <Composer
        plan={plan ?? null}
        busy={busy}
        overrides={overrides}
        onOverrides={setOverrides}
        onSend={send}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    </>
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
): { node: InstanceNode | undefined; stateId: string; declared: readonly StateChild[]; deep: boolean } {
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
            onOpen={openRun}
          />
        )
      ) : (
        <RunConversation parent={at.node} detail={detail} context={context} />
      )}
    </div>
  );
}
