/**
 * The dialogs `App.tsx` raises on its own — what they say and when — moved out of it unchanged so the
 * universal shell (decision 0015) raises the same ones with the same words.
 */
import type { PendingApproval } from "@jaira/shared/browser";
import type { AskSpec } from "./menuTypes";
import { projectName } from "./projects";

/** The approval that names no task: no conversation can host it, so it is the one still modal. */
export function orphanApprovalOf(approvals: readonly PendingApproval[]): PendingApproval | null {
  return approvals.find((a) => a.taskId === undefined) ?? null;
}

/**
 * A folder that is not a project YET. The same dialog every other "are you sure" uses, and
 * deliberately not `danger`: this creates a directory beside the person's work rather than
 * taking anything away, and it is the one gesture that turns a checkout into somewhere JaiRA
 * can run. Dismissing leaves the folder exactly as it was found.
 */
export function initPromptSpec(dir: string, onConfirm: () => void): AskSpec {
  return {
    title: `Set up JaiRA in ${projectName(dir)}?`,
    note: `${dir} is not a JaiRA project yet. Setting it up creates a .jaira/ folder there for its workflows, settings and run history. Nothing else in the folder is touched.`,
    confirmLabel: "Set up project",
    onConfirm,
  };
}
