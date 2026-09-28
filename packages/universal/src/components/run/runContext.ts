import { useMemo } from "react";
import { lookOf } from "@jaira/ui/appearanceLayer";
import type { FileSurfaceContext } from "@jaira/ui/fileTypes";
import { parkedGateOf, startAgainOf } from "@jaira/ui/panelHost";
import { push } from "@jaira/ui/panelStack";
import { SHUT, shutOf } from "@jaira/ui/uiState";
import { useShell } from "../../app/shell";
import { panelOnStack, runFocus, runViewed } from "../panel/panelBridge";

/** The fields of `FileSurfaceContext` a run is read from. */
export type RunFields = Pick<
  FileSurfaceContext,
  | "conversation" | "sessions" | "onLoadSession" | "onLoadSessions" | "shutStates" | "onToggleShutState" | "onSetShutStates" | "userEvents" | "onDeliverUserEvent" | "sessionHistory" | "records" | "liveTurn" | "batches"
  | "onWalkInto" | "onWalkIntoSidechain" | "onOpenWorkflow" | "runFocus" | "onRunFocus" | "onRunHere" | "runGate" | "onRunGate" | "onRerun" | "onResume" | "onRewind" | "onFork"
>;

/**
 * What a RUN is read from — the fields of `App.tsx`'s `surfaces` that `RunView` and `CompositeView` read:
 * the conversation, its sessions and records, the live tail, the folds, the waits, the walks, and the
 * gate the task is parked on (`inlineGate`). The Files room's `useFileSurfaces` carries the rest; laid
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
    onRunHere: (instance, onScreen) => runViewed.set({ current: instance, onScreen }),
    ...(gate !== undefined ? { runGate: gate, onRunGate: (value: unknown) => actions.answer(gate.requestId, value) } : {}),
    onRerun: (taskId: string) => startAgainOf(actions, detail, project, taskId),
    onResume: (taskId: string) => void actions.resumeTask(taskId, project),
    onRewind: (taskId: string, seq: number) => void actions.rewindTask(taskId, seq, project),
    onFork: (taskId: string, seq: number) => void actions.forkTask(taskId, seq, project),
  };
}
