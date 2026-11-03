/**
 * A parked call decided again (decision 0023, 2026-11-03): the person changed the permissions while a
 * call waited on them — picked another layer, let go of an answer, answered another call "for this
 * run" — and what the call waits for may no longer be a question.
 *
 * The same ONE decision every call goes through (`decideToolCall`): the mode the block gives the tool,
 * the policy's narrowing — the line taken apart again, each part against the stack as it is now — and
 * `smart`, with an approver that asks nobody. It reads what the parts came to, as the real approver
 * does first (`withPermissionFunctions`): every part allowed, the call is; one denied, it is refused;
 * anything else is still a question for the person already being asked, its rows as they are now. A
 * part a FUNCTION now decides is left to the question as it stands: a function is asked before the
 * person, never instead of one already asking.
 */
import { PermissionLedger, decideToolCall, type Approver, type ExecPolicy, type PermissionMode, type PermissionRequest } from "@declarative-ai/permissions";
import type { CommandApproval, PermissionsDecl } from "@jaira/shared";
import { commandDecisionOf, forgetCallDecisions, functionCallOf, refusedByOfCall } from "./policy";
import type { RefusedBy } from "./refusals";

/** What a parked call comes to, decided again. */
export type Rejudged =
  | { decision: "allow" }
  /** `by`: who refuses it now — what the agent is told. */
  | { decision: "deny"; by: RefusedBy | undefined }
  /** Still a question: its rows and reason as they are now (absent: a call that is not a line). */
  | { ask: { parts?: CommandApproval; reason?: string } };

/** What a call is decided under: the policy it was compiled with, and the block as it stands now. */
export interface JudgingUnder {
  policy: ExecPolicy;
  /** The operation's lowered `permissions` block, written from the stack as it is now. */
  block: PermissionsDecl | undefined;
}

/** The mode a block gives a tool before its input is read — the gate's `authoredMode`. */
function modeOfBlock(block: PermissionsDecl | undefined, tool: string): PermissionMode | undefined {
  const tools = block?.tools as Record<string, PermissionMode> | undefined;
  if (tools !== undefined && Object.hasOwn(tools, tool)) return tools[tool];
  const other = (block as { other?: PermissionMode; default?: PermissionMode } | undefined)?.other;
  return other ?? (block as { default?: PermissionMode } | undefined)?.default;
}

export async function rejudgeCall(req: PermissionRequest, under: JudgingUnder): Promise<Rejudged> {
  // What the first decision kept against the call's input is what is being decided again.
  forgetCallDecisions(req.input);
  let asked = false;
  const probe: Approver = (call) => {
    const decided = commandDecisionOf(call.input);
    if (functionCallOf(call.input) === undefined && decided !== undefined && decided.action !== "require_approval") return { decision: decided.action === "allow" ? "allow" : "deny", scope: "once" };
    asked = true;
    // Refused only inside this pass: nothing is remembered from a `once`.
    return { decision: "deny", scope: "once" };
  };
  let by: RefusedBy | undefined;
  const authoredMode = modeOfBlock(under.block, req.tool);
  const verdict = await decideToolCall({ name: req.tool }, req.input as never, {
    // A ledger of its own: an answer about the whole tool is the call's, not this pass's to keep.
    ledger: new PermissionLedger({ baseline: under.policy.baseline ?? {} }),
    sessionId: req.sessionId,
    approve: probe,
    ...(authoredMode !== undefined ? { authoredMode } : {}),
    ...(under.policy.smart?.[req.tool] !== undefined ? { smart: under.policy.smart[req.tool] } : {}),
    ...(under.policy.profiles !== undefined ? { profiles: under.policy.profiles } : {}),
    ...(under.block !== undefined ? { authored: under.block as never } : {}),
    ...(under.policy.scopeOf !== undefined ? { scopeOf: under.policy.scopeOf } : {}),
    // Who refuses it, kept for the agent's words; the refusal itself is the call's, when it is answered.
    refusal: (refused) => {
      by = asked ? undefined : refusedByOfCall(refused);
      return undefined;
    },
  });
  if (asked) {
    const decided = commandDecisionOf(req.input);
    return { ask: { ...(decided !== undefined ? { parts: decided.parts, reason: decided.reason } : {}) } };
  }
  return verdict.allow ? { decision: "allow" } : { decision: "deny", by };
}
