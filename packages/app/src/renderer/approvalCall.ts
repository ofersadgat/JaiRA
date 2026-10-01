import { APPROVAL_PROMPT_FUNCTION } from "@jaira/shared/browser";

/**
 * Where the pending approval's call is in `entries`: an `approve_tool_call` still unanswered whose
 * call id names the request (`approve_<asked>_<requestId>`, `recordApprovalCall`). -1 when this stretch
 * does not hold it.
 */
export function approvalCallIndex(entries: readonly { kind: string; name?: string; callId?: string; ok?: boolean; result?: unknown }[], requestId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "tool" && e.name === APPROVAL_PROMPT_FUNCTION && e.callId?.endsWith(`_${requestId}`) === true && e.ok === undefined && e.result === undefined) return i;
  }
  return -1;
}
