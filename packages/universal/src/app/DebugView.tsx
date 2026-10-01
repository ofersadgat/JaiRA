import type { JSX } from "react";
import { DebugPane } from "../components/debug/DebugPane";
import { PanelColumn } from "./PanelColumn";
import { useShell } from "./shell";

/**
 * The Debug room: `DebugPane` (the self-test) on the store — the run, what it said, and the verbs that
 * start, cancel and recheck it — with the shell's side panel beside it.
 */
export function DebugView(): JSX.Element {
  const { state, actions } = useShell();
  return (
    <DebugPane
      debug={state.debug}
      detail={state.detail}
      conversation={state.conversation}
      sessionHistory={state.sessionHistory}
      session={state.session}
      sessionInstance={state.sessionInstance}
      liveTurn={state.liveTurn}
      onShowSession={actions.showSession}
      availability={state.availability}
      hasProject={state.at !== null}
      onRun={(options) => void actions.debugRun(options)}
      onCancel={() => void actions.debugCancel()}
      onRecheck={actions.debugRefresh}
      onDismissError={actions.debugDismissError}
      onOpenState={(stateId, layer) => void actions.openWorkflow(stateId, layer)}
      panel={<PanelColumn />}
    />
  );
}
