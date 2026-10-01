import type { JSX } from "react";
import { initPromptSpec, orphanApprovalOf } from "@jaira/ui/appDialogs";
import { useShell } from "../../app/shell";
import { AskDialog } from "../files/AskDialog";
import { SuggestHost } from "../form/SuggestLayer";
import { ApprovalDialog, ModuleApprovalDialog } from "./Dialogs";
import { Toast } from "./Toast";

/**
 * The dialogs the shell raises on its own, over whatever room is showing: a workflow's modules to trust
 * before it starts (first — it is asked before any run exists), else a command approval that names no
 * task; and a folder to set up as a project. What they say and when is `appDialogs.ts`'s. The folder
 * browser (`FolderBrowser.tsx`) is not here: the sidebar's project chooser opens it
 * (`SidebarRegion.tsx`). Last, the toast: the store's error, or its notice.
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
      <Toast error={state.error} notice={state.notice} onDismissError={actions.dismissError} onDismissNotice={actions.dismissNotice} />
      {/* A phone's layer for a box's suggestions, over the frame (nothing on web: `SuggestLayer.web.tsx`). */}
      <SuggestHost />
    </>
  );
}
