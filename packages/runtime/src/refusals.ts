/**
 * Who refused a tool call, and the words the agent reads for it (decision 0007, amended 2026-10-24).
 *
 * A refused call is the agent's answer to its call: it reads the refusal in place of the tool's result,
 * as an error (upstream's bridge, `deniedResult`), and what it does next depends on being told that
 * nothing happened, who said no, and whether anybody can change that. Upstream's one decision knows only
 * WHICH STEP said no (`RefusalCause`); who stands behind that step is JaiRA's, and is written down here
 * by whoever decided — the approval hub for a person, a stop or the app closing; the permission
 * functions for `smart`; the policy for a rule — so the policy's `refusal` callback can say it.
 *
 * Kept by the call's CANONICAL input, not its object: a permission function hands the approval prompt a
 * copy of the request, so the person's answer is given about an equal object, not the same one. A
 * decision forgets what was kept for its input when it starts ({@link forgetRefusal}), so an earlier
 * call with the same input never answers for this one.
 */
import { SMART_FUNCTION } from "@jaira/shared";
import { canonical } from "./hostCalls";

/** A rule that refused a call without anybody being asked. */
export type RefusalRule =
  /** A permission set's line for the tool, or for a part of the line, is `deny`. */
  | "permission set"
  /** JaiRA's own: the destructive floor, `.jaira/` being engine-owned. */
  | "built-in rules"
  /** A scope table: the call would act somewhere it may not. */
  | "scopes"
  /** The person denied this tool earlier, for longer than one call. */
  | "earlier answer"
  /** The session's profile leaves the tool out. */
  | "profile";

/** Who refused a call. */
export type RefusedBy =
  | { kind: "rule"; rule: RefusalRule; reason?: string; profile?: string }
  /** A permission function the permission set names — `smart`. */
  | { kind: "function"; function: string; reason?: string }
  /** The person, asked. */
  | { kind: "person" }
  /** Nobody decided: a stop, the app closing, the call ending first, or nobody there to ask. */
  | { kind: "nobody"; why: "stopped" | "closed" | "abandoned" | "unattended"; reason?: string }
  /** An approver none of the above wrote down — a host's own — said no. */
  | { kind: "approver" };

/** What is kept, by canonical input. Bounded: an entry nobody read is dropped oldest first. */
const REFUSED = new Map<string, RefusedBy>();
const KEPT = 500;

/** Start a decision about this call afresh — see the module header. */
export function forgetRefusal(input: unknown): void {
  REFUSED.delete(canonical(input));
}

/**
 * Write down who refused this call. `keep` leaves an answer already written alone — a function's `deny`
 * after it asked the person is the person's.
 */
export function noteRefusal(input: unknown, by: RefusedBy, keep = false): void {
  const key = canonical(input);
  if (keep && REFUSED.has(key)) return;
  REFUSED.delete(key);
  REFUSED.set(key, by);
  if (REFUSED.size > KEPT) REFUSED.delete(REFUSED.keys().next().value as string);
}

/** Who refused this call, as written down — read once. */
export function takeRefusal(input: unknown): RefusedBy | undefined {
  const key = canonical(input);
  const by = REFUSED.get(key);
  REFUSED.delete(key);
  return by;
}

/** What a refused call did not do, by the standard tool it is — "Nothing was <verb>." */
function verbOf(tool: string): string {
  switch (tool) {
    case "read_file":
    case "glob":
    case "grep":
      return "read";
    case "edit":
    case "write_file":
      return "changed";
    case "shell":
    case "script":
    case "run_command":
      return "run";
    case "web_fetch":
      return "fetched";
    case "web_search":
      return "searched";
    default:
      return "done";
  }
}

/** A function, as the agent is told of it: `smart` is "auto", the name the person picked it by. */
function functionName(reference: string): string {
  return reference === SMART_FUNCTION ? "auto" : `the function '${reference}'`;
}

/**
 * The sentence the agent reads for a refused call — always "Not run:", then who, why when known, that
 * nothing happened, and what it may do instead. `tool` is the call's standard name where it has one.
 */
export function refusalWords(by: RefusedBy, tool: string): string {
  const nothing = `Nothing was ${verbOf(tool)}.`;
  const because = "reason" in by && by.reason !== undefined && by.reason.length > 0 ? ` (${by.reason})` : "";
  switch (by.kind) {
    case "rule":
      switch (by.rule) {
        case "permission set":
          return `Not run: this conversation's permission set denies ${tool}${because}. ${nothing} Do not retry it; do the work another way, or ask the person to change the permission set.`;
        case "built-in rules":
          return `Not run: JaiRA's built-in rules refuse this ${tool} call${because}. ${nothing} Do not retry it; do the work another way.`;
        case "scopes":
          return `Not run: ${tool} would act outside where this conversation may act${because}. ${nothing} Do not retry it there.`;
        case "earlier answer":
          return `Not run: the person denied ${tool} earlier in this conversation. ${nothing} Do not retry it; carry on without it, or ask them.`;
        case "profile":
          return `Not run: this conversation is in ${by.profile ?? "a"} mode, which does not allow ${tool}. ${nothing} Do not retry it; say what you would do instead.`;
      }
      break;
    case "function":
      return `Not run: ${functionName(by.function)} denied it${because}. ${nothing} Do not retry the same call; carry on without it, or tell the person why you need it.`;
    case "person":
      return `Not run: the person denied this call. ${nothing} Do not make it again; carry on without it, or ask them what they want instead.`;
    case "approver":
      return `Not run: this call was not approved. ${nothing} Do not make it again; carry on without it.`;
    case "nobody":
      switch (by.why) {
        case "stopped":
          return `Not run: the run was stopped while this call waited for approval. ${nothing}`;
        case "closed":
          return `Not run: the app closed while this call waited for approval. ${nothing}`;
        case "abandoned":
          return `Not run: the call ended before anybody answered it. ${nothing}`;
        case "unattended":
          return `Not run: this call needs approval and nobody is here to give it${because}. ${nothing}`;
      }
  }
  return `Not run: ${tool} was refused. ${nothing}`;
}

/**
 * How a rule that refused a call is named in the conversation — on the step drawn under the call
 * ("Denied by the permission set"), where a function's step names the function.
 */
export function ruleLabel(rule: RefusalRule): string {
  switch (rule) {
    case "permission set":
      return "the permission set";
    case "built-in rules":
      return "the built-in rules";
    case "scopes":
      return "the scopes";
    case "earlier answer":
      return "your earlier answer";
    case "profile":
      return "the conversation's mode";
  }
}

/** Tools a person denied for longer than one call, by the ledger session the answer was given in. */
const DENIED_EARLIER = new Map<string, Set<string>>();

/** Remember that the person denied `tool` for longer than one call in this session. */
export function rememberDenial(sessionId: string, tool: string): void {
  const tools = DENIED_EARLIER.get(sessionId) ?? new Set<string>();
  tools.add(tool);
  DENIED_EARLIER.set(sessionId, tools);
}

/** Whether a refusal by the tool's mode is the person's earlier answer rather than the permission set. */
export function deniedEarlier(sessionId: string, tool: string): boolean {
  return DENIED_EARLIER.get(sessionId)?.has(tool) === true;
}
