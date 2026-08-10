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
import { useMemo, useState, type JSX } from "react";
import type { InstanceNode, StateChild, StateView, TaskDetail } from "@jaira/shared/browser";
import { Board } from "./board";
import { entriesOf, journalFor, signatureOf } from "./transcript";
import { ChildRuns, Transcript, durationOf } from "./transcriptView";
import type { FileSurfaceProps } from "./fileTypes";

/**
 * The instance in the tree that IS this state, for the run being read.
 *
 * Depth-first and newest-first, so a state re-entered by a loop resolves to its latest pass — the
 * one whose children are on screen. A superseded instance is skipped: its children were cleared by
 * a sequence reset and showing them would populate the board with runs the engine has disowned.
 */
export function instanceOf(nodes: readonly InstanceNode[], stateId: string): InstanceNode | undefined {
  let best: InstanceNode | undefined;
  const walk = (list: readonly InstanceNode[]): void => {
    for (const node of list) {
      if (node.stateId === stateId && !node.superseded) {
        if (best === undefined || node.startedAt >= best.startedAt) best = node;
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return best;
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

/** One execution, as a card in a board column. The same signature line the transcript card carries. */
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
    <div
      className={`run-tile${selected ? " sel" : ""}`}
      onClick={onOpen}
      title={`${node.stateId} · ${new Date(node.startedAt).toLocaleString()}`}
    >
      <div className="run-tile-top">
        <span className={`ts-dot ts-dot-${node.status}`} />
        <span className="grow ellip">{sig.label ?? sig.name}</span>
        {/* Only when there is more than one. A lone card numbered "1 of 1" is a question raised and
            immediately answered. */}
        {total > 1 ? <span className="chip">{index + 1}</span> : null}
      </div>
      {sig.params.length > 0 ? (
        <div className="run-tile-args">
          {sig.params.slice(0, 2).map((param) => (
            <div key={param.name} className="ellip">
              {param.name} {param.preview}
            </div>
          ))}
          {sig.params.length > 2 ? <div className="sub">+{sig.params.length - 2} more</div> : null}
        </div>
      ) : null}
      <div className="run-tile-meta">
        {node.status === "running" ? "running" : (took ?? new Date(node.startedAt).toLocaleTimeString())}
      </div>
    </div>
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
  return (
    <div className="run-board">
      {declared.map((child) => {
        const runs = byChild.get(child.key) ?? [];
        return (
          <div className="run-col" key={child.key}>
            <h3>
              <span className="ellip">{child.label ?? child.key}</span>
              <span className="count">{runs.length}</span>
            </h3>
            <div className="run-col-body">
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
              {runs.length === 0 ? <p className="empty">not reached</p> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The composite's conversation: its own words, then a card per child run.
 *
 * The state's own operation is rendered BARE, exactly as a leaf is, because chrome marks a child
 * boundary and this is not a child — it is this state speaking. A composite that orchestrates and
 * says nothing itself contributes no empty block; it is cards all the way down.
 */
export function RunConversation({
  state,
  detail,
  context,
  open,
  onToggle,
}: {
  state: StateView;
  detail: TaskDetail | null;
  context: FileSurfaceProps["context"];
  open: ReadonlySet<number>;
  onToggle: (instanceId: number) => void;
}): JSX.Element {
  const { conversation, session, liveTurn, sessions } = context;
  const parent = useMemo(() => instanceOf(detail?.instances ?? [], state.stateId), [detail, state.stateId]);
  const own = useMemo(
    () => entriesOf(session, journalFor(conversation?.turns ?? [], state.stateId), liveTurn?.text ?? null),
    [session, conversation, state.stateId, liveTurn],
  );

  if (detail === null) return <p className="empty">Select a run to see what it said.</p>;
  const kids = parent?.children.filter((node) => !node.superseded) ?? [];
  return (
    <div className="run-convo scroll">
      {/* Only when it said something. An empty block above the cards would claim the parent spoke. */}
      {own.length > 0 ? <Transcript entries={own} /> : null}
      {own.length > 0 && kids.length > 0 ? <div className="run-convo-rule" /> : null}
      {kids.length === 0 && own.length === 0 ? <p className="empty">This run has not entered a child yet.</p> : null}
      <ChildRuns
        nodes={kids}
        openIds={open}
        onToggle={onToggle}
        render={(node) => {
          const child = sessions[node.instanceId];
          if (child === undefined) return <p className="empty">Loading…</p>;
          const entries = entriesOf(child, journalFor(conversation?.turns ?? [], node.stateId));
          return <Transcript session={child} entries={entries} />;
        }}
      />
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

/** Everything a composite shows: the toggle, and whichever half it selects. */
export function CompositeView(props: FileSurfaceProps & { state: StateView }): JSX.Element {
  const { state, context } = props;
  const { detail, selected, onSelectTask, onDrill, onLoadSession, sessions } = context;
  const [mode, setMode] = useState<RunMode>("board");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());

  const parent = useMemo(() => instanceOf(detail?.instances ?? [], state.stateId), [detail, state.stateId]);

  const toggle = (instanceId: number): void => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(instanceId)) next.delete(instanceId);
      else {
        next.add(instanceId);
        // Fetched on expand, not up front — see `AppState.sessions`.
        if (sessions[instanceId] === undefined) onLoadSession(instanceId);
      }
      return next;
    });
  };

  /** Clicking a card in the board opens its transcript, which is the other half of the toggle. */
  const openRun = (node: InstanceNode): void => {
    setMode("conversation");
    setOpen(new Set([node.instanceId]));
    if (sessions[node.instanceId] === undefined) onLoadSession(node.instanceId);
  };

  return (
    <div className="composite">
      <div className="composite-bar">
        <RunModeToggle mode={mode} onMode={setMode} />
        <span className="grow" />
        {/* Which run both halves are about. Without it the board reads as every task at once, which
            is what it used to be. */}
        {detail !== null ? <span className="sub ellip">{detail.title}</span> : null}
      </div>
      {mode === "board" ? (
        detail === null ? (
          // No run selected: the workflow's own shape, from the task board. Cards are tasks here
          // because there is no run to take executions from — which is the honest answer, not a
          // second design.
          <Board board={state.board!} selected={selected} trays={false} onSelectTask={onSelectTask} onDrill={onDrill} />
        ) : (
          <RunBoard
            declared={state.children}
            parent={parent}
            openInstance={open.size === 1 ? [...open][0]! : null}
            onOpen={openRun}
          />
        )
      ) : (
        <RunConversation state={state} detail={detail} context={context} open={open} onToggle={toggle} />
      )}
    </div>
  );
}
