/**
 * A task's run, read back out of the journal as a TIMELINE (DESIGN §11.1).
 *
 * This used to open "there is no separate transcript to show", and that was true when it was written.
 * It is not now: `SqliteSessionStore` keeps every model call's messages, and `sessionView` reads them
 * back. So the two are different things, and the split is worth stating rather than blurring.
 *
 * **The transcript** is what a state SAID — the prompt, the answer, the agent's tool calls and their
 * results. One state, one operation, one conversation.
 *
 * **This** is what happened AROUND those operations: which state ran, what it called, whether its
 * output validated, every transition, and every point a human was asked something. None of it appears
 * in a transcript, because none of it happens inside a model call. A policy escalation and a human
 * gate land BETWEEN turns, and this is the only place they are visible.
 *
 * Merged from the journal and the command log rather than concatenated, because the interesting
 * moments are precisely where those two streams interleave — an escalation lands *inside* an
 * operation, and separating them loses the one thing the reader wants to know, which is what the
 * agent was doing when it asked.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ConversationTurn, ConversationView } from "@jaira/shared";
import type { Project } from "./project";

/** Turns returned by default. A long agent run produces thousands; the tail is what is being read. */
export const CONVERSATION_LIMIT = 400;

export interface ConversationOptions {
  /** Which run to read. Defaults to the latest. */
  runId?: number;
  limit?: number;
}

/** A short, human-first rendering of a termination outcome. */
function outcomeText(outcome: unknown, failure: unknown): string {
  const reason = (failure as { reason?: unknown } | undefined)?.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return typeof outcome === "string" ? outcome : "terminated";
}

/**
 * Project one run into turns.
 *
 * Only the events a reader can act on become turns. `instance.entered` is deliberately dropped for
 * every state that also emits `operation.started` — entering and starting are one moment to anyone
 * not debugging the engine, and showing both doubles the length of every conversation.
 */
export function conversationView(project: Project, taskId: string, options: ConversationOptions = {}): ConversationView {
  const row = project.runtime.get(taskId);
  // Named with the project it was looked for IN. A task id is a rowid in one database and every
  // read about it names that database (see `taskDetailView`) — so when this fires, the useful half
  // of the report is which one was asked, not which id was missing.
  if (!row) throw new Error(`unknown task '${taskId}' in ${project.paths.projectDir}`);
  const meta = project.tasks.tryRead(taskId);
  const runs = project.runtime.listRuns(taskId);
  const runId = options.runId ?? runs[runs.length - 1]?.id;
  if (runId === undefined) {
    return { taskId, title: meta?.title ?? taskId, turns: [] };
  }

  const events = project.events.list(taskId, { runId });
  const started = new Set<number>();
  for (const stored of events) {
    if (stored.event.type === "operation.started") started.add(stored.event.instanceId);
  }

  const turns: ConversationTurn[] = [];
  for (const stored of events) {
    const event = stored.event;
    const at = stored.createdAt;
    const seq = stored.seq;
    switch (event.type) {
      case "instance.entered":
        // A composite state never starts an operation of its own; without this it would be invisible
        // in a conversation that is otherwise entirely about its children.
        if (started.has(event.instanceId)) break;
        turns.push({ seq, at, kind: "operation", stateId: event.stateId, text: "entered" });
        break;
      case "instance.blocked":
        turns.push({ seq, at, kind: "failure", stateId: event.stateId, text: event.reason, ok: false });
        break;
      case "operation.started":
        turns.push({ seq, at, kind: "operation", stateId: event.stateId, text: event.op });
        break;
      case "operation.completed":
        turns.push({
          seq,
          at,
          kind: "output",
          stateId: event.stateId,
          ok: true,
          ...(event.metrics !== undefined ? { data: event.metrics as unknown as JsonValue } : {}),
        });
        break;
      case "operation.failed":
        turns.push({
          seq,
          at,
          kind: "failure",
          stateId: event.stateId,
          ok: false,
          text: event.failure.reason,
        });
        break;
      case "transition.taken":
        turns.push({ seq, at, kind: "transition", stateId: event.stateId, text: event.to });
        break;
      case "instance.terminated":
        turns.push({
          seq,
          at,
          kind: "operation",
          stateId: event.stateId,
          ok: event.outcome === "success",
          text: outcomeText(event.outcome, event.failure),
        });
        break;
      default:
        break;
    }
  }

  // The command log has its own ids, not journal seqs. Offsetting them past the journal's range
  // keeps the merge stable without pretending the two streams share a sequence.
  const seqBase = (events[events.length - 1]?.seq ?? 0) + 1;
  for (const entry of project.commands.list(taskId, { runId })) {
    const escalated = entry.decidedBy === "user";
    turns.push({
      seq: seqBase + entry.id,
      at: entry.createdAt,
      kind: escalated ? "policy" : "tool",
      tool: entry.tool,
      ok: entry.decision === "allowed" || entry.decision === "approved",
      text: entry.command ?? entry.reason ?? entry.tool,
      ...(entry.reason !== undefined && entry.command !== undefined
        ? { data: { reason: entry.reason, decision: entry.decision } as JsonValue }
        : {}),
    });
  }

  turns.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const limit = options.limit ?? CONVERSATION_LIMIT;
  return {
    taskId,
    title: meta?.title ?? taskId,
    runId,
    turns: turns.length > limit ? turns.slice(-limit) : turns,
  };
}
