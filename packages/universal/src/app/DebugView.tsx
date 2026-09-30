import type { JSX } from "react";
import { DebugPane } from "../components/debug/DebugPane";
import { PanelColumn } from "./PanelColumn";
import { useShell } from "./shell";

/**
 * The Debug room (`DebugPane`), as `App.tsx` draws it in `.viewport` (decision 0015), with the props
 * `App.tsx` hands its own and the shell's side panel beside it.
 */
export function DebugView(): JSX.Element {
  const { state, actions } = useShell();
  return (
    <DebugPane
      debug={state.debug}
      detail={state.detail}
      conversation={state.conversation}
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
