import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import type { InstanceNode, StateView } from "@jaira/shared/browser";
import type { FileSurfaceContext, FileSurfaceProps } from "@jaira/ui/fileTypes";
import { runColumnsOf, runDragOffersOf, runsByChild, standingOn } from "@jaira/ui/runBoardModel";
import { nodeAt } from "@jaira/ui/trail";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Board } from "../Board";
import type { TranscriptSource } from "../panel/RunTranscript";
import { RunBoard } from "./RunBoard";
import { RunConversation } from "./RunConversation";
import { SidechainConversation } from "./SidechainConversation";

/**
 * `runViews.tsx`'s `RunView`, universal (decision 0015): one run walked into, in the Tasks room's middle
 * column — its executions as cards (`RunBoard`), or what it said (`RunConversation`), as the title bar's
 * toggle says (`runMode`). A run that declared no children and entered none is a leaf of the walk, and
 * its conversation is the only reading whatever the toggle says; a subagent's conversation at the tail
 * of the walk is its own page (`SidechainConversation`).
 *
 *   .composite     column, flex 1
 */
export function RunView({ context }: { context: FileSurfaceContext }): JSX.Element {
  const { detail, trail, trailState, onWalkInto } = context;
  const tail = trail?.at(-1);
  const node = tail === undefined ? undefined : nodeAt(detail?.instances ?? [], tail.instanceId);
  const declared = trailState?.children ?? [];
  const mode = context.runMode ?? "board";
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const openRun = (child: InstanceNode): void => {
    if (onWalkInto !== undefined) return onWalkInto(child);
    setOpen(new Set([child.instanceId]));
  };
  const board = mode === "board" && (declared.length > 0 || (node?.children.length ?? 0) > 0);

  // A sidechain tail is its own kind of place: no board and no children, so the page is that conversation.
  if (tail?.sidechain !== undefined) {
    return (
      <Composite>
        <SidechainConversation step={tail} detail={detail} source={sourceOf(context)} />
      </Composite>
    );
  }
  if (node === undefined) return <Composite><Empty>This task has not run here yet.</Empty></Composite>;
  return (
    <Composite>
      {board ? (
        <RunBoard
          declared={declared}
          parent={node}
          openInstance={open.size === 1 ? [...open][0]! : null}
          // One click marks the execution AND puts its state in the side panel, scoped to this pass.
          onSelect={(child) => {
            setOpen(new Set([child.instanceId]));
            context.onOpenWorkflow?.(child.stateId, child.instanceId);
          }}
          onOpen={openRun}
          // What this run is waiting for somebody to do, where a column here is the place to do it.
          offers={runDragOffersOf(detail?.taskId, runColumnsOf(declared, runsByChild(node)), context.userEvents)}
          onDrop={context.onDeliverUserEvent}
        />
      ) : (
        // The bookmark the side panel's Steps index sends, and where the reader is for it to mark: this
        // column is the document when the toggle says Conversation, so it is the column that scrolls.
        <Conversation context={context} parent={node} bookmarks />
      )}
    </Composite>
  );
}

/**
 * `runViews.tsx`'s `CompositeView`, universal: what a state file IS DOING, in the Files room — the same
 * two readings of wherever the trail stands (`standingOn`), or, with no run walked into, the workflow's
 * own shape from the task board. What `fileSurfaces.tsx`'s `WorkflowRunView` draws for a composite.
 */
export function CompositeView({ state, context }: FileSurfaceProps & { state: StateView }): JSX.Element {
  const { detail, selected, onSelectTask, onDrill, onWalkInto } = context;
  const [ownMode, setOwnMode] = useState<"board" | "conversation">("board");
  const mode = context.runMode ?? ownMode;
  const setMode = context.onRunMode ?? setOwnMode;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const at = standingOn(state, context);
  const tailStep = context.trail?.at(-1);
  if (at.sidechain !== undefined && tailStep !== undefined) {
    return (
      <Composite>
        <SidechainConversation step={tailStep} detail={detail} source={sourceOf(context)} />
      </Composite>
    );
  }
  const openRun = (node: InstanceNode): void => {
    if (onWalkInto !== undefined) return onWalkInto(node);
    setMode("conversation");
    setOpen(new Set([node.instanceId]));
  };
  const board = mode === "board" && (at.declared.length > 0 || (at.node?.children.length ?? 0) > 0 || at.node === undefined);
  return (
    <Composite>
      {board ? (
        at.node === undefined ? (
          state.board !== null ? <Board board={state.board} selected={selected} trays={false} onSelectTask={(taskId) => onSelectTask(taskId)} onDrill={onDrill} /> : <Empty>No board here yet.</Empty>
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
      ) : detail === null ? (
        <Empty>Select a run to see what it said.</Empty>
      ) : (
        <Conversation context={context} parent={at.node} />
      )}
    </Composite>
  );
}

/**
 * What a run's conversation is read from, out of the context (`RunConversation`'s `context`): the store's
 * fields, the cut's two verbs, the walks, the workflow's link, the moves' questions, the running agent's
 * question and approval, and what the shell lends a gate that mounts the changeset reviewer.
 */
function sourceOf(context: FileSurfaceContext): TranscriptSource {
  return {
    conversation: context.conversation,
    sessions: context.sessions,
    sessionHistory: context.sessionHistory,
    records: context.records,
    liveTurn: context.liveTurn,
    onLoadSessions: context.onLoadSessions,
    shutStates: context.shutStates,
    onToggleShutState: context.onToggleShutState,
    onSetShutStates: context.onSetShutStates,
    batches: context.batches,
    userEvents: context.userEvents,
    onDeliverUserEvent: context.onDeliverUserEvent,
    project: context.project,
    onSelectTask: context.onSelectTask,
    onRewind: context.onRewind,
    onFork: context.onFork,
    onWalkIntoSidechain: context.onWalkIntoSidechain,
    onOpenWorkflow: context.onOpenWorkflow,
    moveQuestions: context.moveQuestions,
    onMoveQuestion: context.onMoveQuestion,
    gateServices: context.runGateServices,
    ...(context.runApproval !== undefined && context.onRunApproval !== undefined ? { approval: context.runApproval, onApproval: context.onRunApproval } : {}),
    ...(context.runQuestion !== undefined && context.onRunQuestion !== undefined ? { question: context.runQuestion, onQuestion: context.onRunQuestion } : {}),
  };
}

/** The conversation reading, from the context: `RunConversation` with the run's gate, its re-run and resume. */
function Conversation({ context, parent, bookmarks = false }: { context: FileSurfaceContext; parent: InstanceNode | undefined; bookmarks?: boolean }): JSX.Element {
  const detail = context.detail;
  if (detail === null) return <Empty>Select a run to see what it said.</Empty>;
  const source = sourceOf(context);
  const gate = context.runGate !== undefined && context.onRunGate !== undefined ? { gate: context.runGate, onGate: context.onRunGate } : {};
  // A gate, the agent's question and its approval each hold the run WAITING (`RunView`'s `asking`).
  const asking = (context.runGate !== undefined && context.onRunGate !== undefined) || source.question !== undefined || source.approval !== undefined;
  return (
    <RunConversation
      detail={detail}
      parent={parent}
      source={source}
      project={context.project}
      {...gate}
      asking={asking}
      onRerun={context.onRerun}
      onResume={context.onResume}
      {...(bookmarks ? { focus: context.runFocus, onHere: context.onRunHere } : {})}
    />
  );
}

/** `.composite`: a column taking the middle column's height. */
function Composite({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View flex={1} minHeight={0} flexDirection="column">
      {children}
    </View>
  );
}

/** `p.empty`: --dim, 8 above and below, and the paragraph's margins (1em of the body's 13). */
function Empty({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}
