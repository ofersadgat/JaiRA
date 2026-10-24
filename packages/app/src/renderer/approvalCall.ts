import { APPROVAL_PROMPT_FUNCTION } from "@jaira/shared/browser";
import { inLastStretch } from "./stillRunning";
import type { TranscriptEntry } from "./transcript";

/**
 * Where the pending approval's call is in `entries`: an `approve_tool_call` still unanswered whose
 * call id names the request (`approve_<asked>_<requestId>`, `recordApprovalCall`) — or IS it, for a
 * request found in the record after the app closed under it (`PendingApproval.recovered`), which goes
 * by its call's own id. -1 when this stretch does not hold it.
 */
export function approvalCallIndex(entries: readonly { kind: string; name?: string; callId?: string; ok?: boolean; result?: unknown }[], requestId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "tool" && e.name === APPROVAL_PROMPT_FUNCTION && (e.callId === requestId || e.callId?.endsWith(`_${requestId}`) === true) && e.ok === undefined && e.result === undefined) return i;
  }
  return -1;
}

/**
 * The ask a task's conversation shows: of its pending asks, the NEWEST — the one its agent is blocked on
 * now, and the one the status line names (`liveStatusOf`: the last unanswered call). The oldest was shown
 * until 2026-10-24, and an ask the agent had already given up on stood in front of every ask after it.
 */
export function askOfTask<T extends { taskId?: string | undefined }>(asks: readonly T[], taskId: string | null | undefined): T | undefined {
  if (taskId === null || taskId === undefined) return undefined;
  for (let i = asks.length - 1; i >= 0; i--) if (asks[i]!.taskId === taskId) return asks[i];
  return undefined;
}

/**
 * Whether a work summary draws this ask's prompt at its own call — so the page does not draw it again
 * under itself. A summary does for a call in the transcript's OPEN stretch (the last, while it is being
 * written) of more than one step (one step is a row, not a summary: `WorkBlockView`), and for an ask found
 * in the record after the app closed under it (`recovered`) wherever its call is.
 *
 * Anything else is drawn under the page, so a pending ask is always drawn SOMEWHERE (2026-10-24: an ask
 * whose call sat in an earlier stretch was drawn nowhere — the thread held its call, so the page stood
 * down, and no open summary held it — while the status line said "Waiting for you to approve").
 */
export function askDrawnAtItsCall(entries: readonly TranscriptEntry[], pending: { requestId: string; recovered?: boolean | undefined }, working: boolean): boolean {
  const at = approvalCallIndex(entries as never, pending.requestId);
  if (at < 0) return false;
  if (pending.recovered === true) return true;
  if (!working || !inLastStretch(entries, at)) return false;
  // The stretch it is in runs from after the last thing said to the end; more than one step is a summary.
  let start = at;
  while (start > 0 && !SAID.has(entries[start - 1]!.kind)) start -= 1;
  return entries.length - start > 1;
}

/** What ends a stretch of work — the same three `blocksOf` and `inLastStretch` stop at. */
const SAID: ReadonlySet<string> = new Set(["message", "live", "compaction"]);
