/**
 * A cut call, CONTINUED from its own record rather than made again.
 *
 * A call is cut when the app closes under it, or a stop unwinds the run. Resuming the task re-dispatches
 * it, and the store REOPENS its record (Identity and Resume §08) — which used to mean the call started
 * over: the same prompt sent again, into a provider conversation that already held the first attempt,
 * and the first attempt's turns overwritten by the second's first flush. A call that had worked for an
 * hour did the hour again, and a question it was waiting on when the app closed was simply gone.
 *
 * The record is the call's state (the person, 2026-10-21: "the agent record should be written, so we
 * should be able to replay that record and thus present the permission and have it properly run if
 * permission is given"). So a reopened record that already says something is continued from:
 *
 *  - what it said stays in front of everything written from here on (the store's `carried`);
 *  - the message it is made with is a NOTE saying what happened since — the app closed; the person
 *    has since answered what it was asking — written into the record as JaiRA's words;
 *  - a transport that resumes a provider conversation resumes THIS call's own (the record's handle,
 *    reported as the call streamed), so the model has everything it said; one that replays is handed
 *    the conversation before the call, the call's own turns, and a result for every call in them that
 *    never got one — an unanswered call is a request a provider refuses.
 *
 * Both CLIs, resumed on a conversation that ends in a call with no result, put their own "interrupted"
 * result there and carry on (measured 2026-10-21: claude-cli 2.1.287, codex 0.147) — and both models
 * then make the call again. Which is how an answer given after the app closed reaches the call: the
 * call made again IS the one that asked, and meets the answer seeded for it (`ApprovalHub.seed`).
 */
import {
  resolveSessionRef,
  type ExecServices,
  type Executor,
  type InlineFamily,
  type Operation,
  type ResolvedSession,
} from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import type { WorkflowMetrics } from "@declarative-ai/hw";

/** What the continuation layer needs from the store that holds the records. */
export interface ContinuationPorts {
  /** The cut call a dispatch at this seat continues — see `SqliteSessionStore.continuationAt`. */
  continuationAt(at: { id: string; seq: number }): { recordId: string; entries: JsonValue[]; messages: JsonValue[]; providerSessionId?: string } | undefined;
  /** Write the message the continuation is made with into its record. */
  noteContinuation(recordId: string, text: string): void;
  /**
   * The words this record's continuation is made with — what the person answered since it was cut —
   * or `undefined` for the plain "carry on". Taken: asked once per continuation.
   */
  noteFor?(recordId: string): string | undefined;
}

/** What a cut call is told when nothing was asked of the person since: carry on. */
export const CONTINUE_NOTE =
  "The app was closed while you were working, so your last turn was cut off before it finished. Carry on from where you were.";

/** The call as the note names it: the tool, and its line when it has one. */
function callWords(tool: string, command: string | undefined): string {
  const line = command !== undefined && command.trim() !== "" ? ` (\`${command.length > 200 ? `${command.slice(0, 200)}…` : command}\`)` : "";
  return `\`${tool}\`${line}`;
}

/**
 * The note a call continues with when the person answered, after the app closed, the permission it was
 * waiting on. Allowed, it is told to make the same call again — the call it made never ran — and the
 * call made again meets the answer seeded for it.
 */
export function approvalNote(tool: string, command: string | undefined, decision: "allow" | "deny"): string {
  const waited = `The app was closed while your call to ${callWords(tool, command)} waited for the person's permission, so it did not run.`;
  return decision === "allow"
    ? `${waited} They have since allowed it: make the same call again, then carry on.`
    : `${waited} They have since denied it: do not make it. Carry on without it.`;
}

/** The note a call continues with when the person answered, after the app closed, the question it asked. */
export function answersNote(answers: Record<string, string | readonly string[]> | undefined): string {
  const waited = "The app was closed while your question waited for the person's answer.";
  if (answers === undefined) return `${waited} They have since left it to you: use your own judgment and carry on.`;
  const lines = Object.entries(answers).map(([question, answer]) => `- ${question} → ${Array.isArray(answer) ? answer.join(", ") : String(answer)}`);
  return `${waited} They have since answered:\n${lines.join("\n")}\nCarry on with those answers.`;
}

/** The result a replayed conversation gives a call that never got one. */
const CUT_RESULT = "Not run to completion: the app was closed before this call's result was recorded, so its outcome is unknown.";

/** The op a continuation is made with: the cut call's own, asking the note instead. Only a prompt op can. */
function withNote(op: Operation<InlineFamily>, note: string): Operation<InlineFamily> | undefined {
  const prompt = op as { kind?: unknown; user?: unknown };
  if (prompt.kind !== "prompt" || typeof prompt.user !== "string") return undefined;
  return { ...(op as object), user: note } as Operation<InlineFamily>;
}

/** The tool calls a message makes, in either shape a record holds — Anthropic's or the AI SDK's. */
function callsOf(message: JsonValue): Array<{ id: string; name: string; shape: "anthropic" | "sdk" }> {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (m === null || typeof m !== "object" || m.role !== "assistant" || !Array.isArray(m.content)) return [];
  const out: Array<{ id: string; name: string; shape: "anthropic" | "sdk" }> = [];
  for (const part of m.content as Array<Record<string, unknown>>) {
    if (part?.["type"] === "tool_use" && typeof part["id"] === "string") out.push({ id: part["id"], name: String(part["name"] ?? ""), shape: "anthropic" });
    if (part?.["type"] === "tool-call" && typeof part["toolCallId"] === "string") out.push({ id: part["toolCallId"], name: String(part["toolName"] ?? ""), shape: "sdk" });
  }
  return out;
}

/** The ids of the calls a message answers. */
function answersOf(message: JsonValue): string[] {
  const m = message as { content?: unknown } | null;
  if (m === null || typeof m !== "object" || !Array.isArray(m.content)) return [];
  const out: string[] = [];
  for (const part of m.content as Array<Record<string, unknown>>) {
    if (part?.["type"] === "tool_result" && typeof part["tool_use_id"] === "string") out.push(part["tool_use_id"]);
    if (part?.["type"] === "tool-result" && typeof part["toolCallId"] === "string") out.push(part["toolCallId"]);
  }
  return out;
}

/**
 * A conversation in which every tool call has a result: each call left without one gets
 * {@link CUT_RESULT}, right after the message that made it — the same repair both CLIs make to their
 * own sessions on resume, made here for a transport that replays.
 */
export function closeDanglingCalls(messages: readonly JsonValue[]): JsonValue[] {
  const answered = new Set(messages.flatMap(answersOf));
  const out: JsonValue[] = [];
  for (const message of messages) {
    out.push(message);
    const open = callsOf(message).filter((call) => !answered.has(call.id));
    if (open.length === 0) continue;
    const anthropic = open.filter((call) => call.shape === "anthropic");
    const sdk = open.filter((call) => call.shape === "sdk");
    if (anthropic.length > 0) {
      out.push({ role: "user", content: anthropic.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: CUT_RESULT, is_error: true })) } as JsonValue);
    }
    if (sdk.length > 0) {
      out.push({
        role: "tool",
        content: sdk.map((call) => ({ type: "tool-result", toolCallId: call.id, toolName: call.name, output: { type: "error-text", value: CUT_RESULT } })),
      } as JsonValue);
    }
  }
  return out;
}

/**
 * Put the continuation layer around an executor — INSIDE `withRecord`, which reopens the record this
 * layer then reads, and outside everything that talks to a provider.
 */
export function withContinuation(
  inner: Executor<ExecServices, WorkflowMetrics>,
  ports: ContinuationPorts,
): Executor<ExecServices, WorkflowMetrics> {
  return {
    capabilities: inner.capabilities,
    metrics: inner.metrics,
    ...(inner.capabilitiesFor !== undefined ? { capabilitiesFor: (op: Operation<InlineFamily>) => inner.capabilitiesFor!(op) } : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      const session = ctx.session as ResolvedSession<JsonValue> | undefined;
      const cut = session !== undefined ? ports.continuationAt(session.at) : undefined;
      if (session === undefined || cut === undefined) return inner.start(op, ctx);
      const note = ports.noteFor?.(cut.recordId) ?? CONTINUE_NOTE;
      const continued = withNote(op, note);
      if (continued === undefined) return inner.start(op, ctx);
      ports.noteContinuation(cut.recordId, note);
      // THIS call's provider conversation when it reported one — it holds everything the call said —
      // else the position's. The position's provider only goes with the position's own handle: the
      // call's is the same route's, since the op it was made with is the one being continued.
      const handle = cut.providerSessionId ?? session.providerSessionId;
      const own = handle !== undefined && handle === session.providerSessionId;
      const prior = session.messages.bind(session);
      const resumed = resolveSessionRef<JsonValue>(session.id, {
        // An append now, whatever the call was dispatched as: a fork that ran has its own conversation,
        // and continuing it is appending to that.
        mode: cut.providerSessionId !== undefined ? "append" : session.mode,
        at: session.at,
        ...(handle !== undefined ? { providerSessionId: handle } : {}),
        ...(own && session.provider !== undefined ? { provider: session.provider } : {}),
        ...(cut.providerSessionId === undefined && session.forkFrom !== undefined ? { forkFrom: session.forkFrom } : {}),
        ...(session.seed !== undefined ? { seed: session.seed } : {}),
        // For a transport that replays: the conversation before the call, then the call's own turns —
        // its question, what it said, and the note — with every call in them answered.
        messages: async () => [...(await prior()), ...closeDanglingCalls(cut.messages)],
      });
      return inner.start(continued, { ...ctx, session: resumed });
    },
  };
}
