import type { JSX } from "react";
import { initPromptSpec, orphanApprovalOf } from "@jaira/ui/appDialogs";
import { useShell } from "../../app/shell";
import { AskDialog } from "../files/AskDialog";
import { ApprovalDialog, ModuleApprovalDialog } from "./Dialogs";

/**
 * The dialogs `App.tsx` raises on its own, over whatever room is showing (decision 0015): a workflow's
 * modules to trust before it starts (first — it is asked before any run exists), else a command approval
 * that names no task; and a folder to set up as a project. What they say and when is `appDialogs.ts`'s,
 * shared with the desktop. The folder browser (`FolderBrowser.tsx`) is opened from the sidebar's
 * project chooser, which the universal sidebar does not draw yet.
 */
export function ShellFloats(): JSX.Element {
  const { state, actions } = useShell();
  const orphan = orphanApprovalOf(state.approvals);
  return (
    <>
      {state.moduleApproval !== null ? (
        <ModuleApprovalDialog files={state.moduleApproval.files} error={state.error} onApprove={actions.approveModulesAndStart} onCancel={actions.dismissModuleApproval} />
      ) : orphan !== null ? (
        <ApprovalDialog pending={orphan} error={state.error} onDecide={(decision, scope, extras) => actions.decideApproval(orphan.requestId, decision, scope, extras)} />
      ) : null}
      {state.initPrompt !== null ? <AskDialog spec={initPromptSpec(state.initPrompt, () => void actions.initProject())} onCancel={actions.dismissInit} /> : null}
    </>
  );
}
