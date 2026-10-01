import { useMemo } from "react";
import { lookOf } from "@jaira/ui/appearanceLayer";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { leafWaitOf, parkedGateOf, reviewerServicesOf, startAgainOf } from "@jaira/ui/panelHost";
import { push } from "@jaira/ui/panelStack";
import { SHUT, shutOf } from "@jaira/ui/uiState";
import { useShell } from "../../app/shell";
import { panelOnStack, runFocus, runViewed } from "../panel/panelBridge";

/** The fields of `FileSurfaceContext` a run is read from. */
export type RunFields = Pick<
  FileSurfaceContext,
  | "conversation" | "sessions" | "onLoadSession" | "onLoadSessions" | "shutStates" | "onToggleShutState" | "onSetShutStates" | "userEvents" | "onDeliverUserEvent" | "sessionHistory" | "records" | "liveTurn" | "batches"
  | "onWalkInto" | "onWalkIntoSidechain" | "onOpenWorkflow" | "runFocus" | "onRunFocus" | "onRunHere" | "runGate" | "onRunGate" | "runGateServices" | "onRerun" | "onResume" | "onRewind" | "onFork"
  | "runQuestion" | "onRunQuestion" | "runApproval" | "onRunApproval" | "moveQuestions" | "onMoveQuestion"
  // A leaf's own panel (`files/LeafPanel.tsx`): the conversation on screen, and the interaction it waits on.
  | "session" | "sessionInstance" | "waiting" | "onAnswer"
>;

/**
 * What a RUN is read from — the fields of `App.tsx`'s `surfaces` that `RunView` and `CompositeView` read:
 * the conversation, its sessions and records, the live tail, the folds, the waits, the walks, the gate
 * the task is parked on (`inlineGate`, with the shell's `reviewerServices`), the running agent's question
 * and approval (`inlineQuestion`, `inlineApproval`), and the questions moves parked (`moveQuestions`). The Files room's `useFileSurfaces` carries the rest; laid
 * over it, the two are the context the desktop hands a run.
 */
export function useRunContext(): RunFields {
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const focus = runFocus.use();
  const project = state.selectedProject ?? undefined;
  const detail = state.detail;
  // `App.tsx`'s `inlineGate`: in the Tasks room, the gate the selected task is parked on.
  const gate = state.view === "tasks" && detail !== null ? parkedGateOf(state.pending, detail.taskId) : undefined;
  // …and the agent question and command approval this conversation is holding, hosted the same way.
  const question = state.view === "tasks" && detail !== null ? state.questions.find((q) => q.taskId === detail.taskId) : undefined;
  const approval = state.view === "tasks" && detail !== null ? state.approvals.find((a) => a.taskId === detail.taskId) : undefined;
  // What the shell lends a changeset reviewer (`panelHost.ts`' `reviewerServicesOf`, `App.tsx`'s own).
  const services = useMemo(() => reviewerServicesOf(state.drafts, actions), [state.drafts, actions]);
  const batches = useMemo(() => lookOf(state.config).conversation.sequentialBatches, [state.config]);
  return {
    conversation: state.conversation,
    sessions: state.sessions,
    onLoadSession: actions.loadSession,
    onLoadSessions: actions.loadSessions,
    shutStates: shutOf(ui, SHUT.runStates),
    onToggleShutState: (key: string) => actions.toggleShut(SHUT.runStates, key),
    onSetShutStates: (keys: readonly string[], shut: boolean) => actions.setShut(SHUT.runStates, keys, shut),
    userEvents: state.userEvents,
    onDeliverUserEvent: actions.deliverUserEvent,
    sessionHistory: state.sessionHistory,
    records: state.records,
    liveTurn: state.liveTurn,
    batches,
    onWalkInto: actions.walkInto,
    onWalkIntoSidechain: actions.walkIntoSidechain,
    // The link in a session panel's gutter and a run card's click: describe the workflow in the panel,
    // scoped to the run — pushed on the panel's stack, as `App.tsx`'s `onOpenWorkflow` does.
    onOpenWorkflow: (stateId: string, instanceId: string) => {
      actions.inspectWorkflow(stateId, instanceId, project);
      panelOnStack.get()?.((was) => push(was, { kind: "state", key: `state:${state.selectedProject ?? ""}:${stateId}@${instanceId}`, stateId, project: state.selectedProject ?? state.at, tab: "run" }));
    },
    ...(focus !== undefined ? { runFocus: focus } : {}),
    onRunFocus: runFocus.set,
    // Only when something moved — a scroll reports on every frame (`App.tsx`'s `onRunHere`).
    onRunHere: (instance, onScreen) => {
      const was = runViewed.get();
      const kept = onScreen !== undefined && was.onScreen !== undefined && was.onScreen.size === onScreen.size && [...onScreen].every((id) => was.onScreen!.has(id)) ? was.onScreen : onScreen;
      if (was.current !== instance || was.onScreen !== kept) runViewed.set({ current: instance, onScreen: kept });
    },
    ...(gate !== undefined ? { runGate: gate, onRunGate: (value: unknown) => actions.answer(gate.requestId, value), runGateServices: services } : {}),
    ...(question !== undefined ? { runQuestion: question, onRunQuestion: (answers: Record<string, string | string[]> | undefined) => actions.answerQuestion(question.requestId, answers) } : {}),
    ...(approval !== undefined ? { runApproval: approval, onRunApproval: (decision, scope, extras) => actions.decideApproval(approval.requestId, decision, scope, extras) } : {}),
    // The questions MOVES parked in task conversations: each drawn where its move asked it.
    moveQuestions: state.pending.filter((p) => p.moves === true),
    // The conversation a leaf shows, and the interaction the selected task is parked on — what the leaf
    // pins, and pressing Answer selects (`App.tsx`'s `waiting` and `onAnswer`).
    session: state.session,
    sessionInstance: state.sessionInstance,
    ...leafWaitOf(state.pending, state.selected, actions.select),
    onMoveQuestion: (requestId: string, value: unknown) => actions.answer(requestId, value),
    onRerun: (taskId: string) => startAgainOf(actions, detail, project, taskId),
    onResume: (taskId: string) => void actions.resumeTask(taskId, project),
    onRewind: (taskId: string, seq: number) => void actions.rewindTask(taskId, seq, project),
    onFork: (taskId: string, seq: number) => void actions.forkTask(taskId, seq, project),
  };
}
