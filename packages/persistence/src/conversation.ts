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
import { ENTERED_TURN, type ConversationTurn, type ConversationView } from "@jaira/shared";
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
 * Only the events a reader can act on become turns.
 *
 * `instance.entered` used to be dropped for every state that also emits `operation.started`, on the
 * grounds that entering and starting are one moment. That was a decision about the TRANSCRIPT, taken
 * in the projection — and the transcript ignores `operation` turns anyway (`EVENT_TONE`), so it cost
 * nothing there and hid the fact from the one reader that needs it. The canvas draws the run's PATH,
 * and a state entering is the step; that a conversation opens underneath it is a second fact, not the
 * same one. So the journal is projected as it was written, and dropping is left to whoever is
 * reading.
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

  /**
   * Where each instance sits, as the chain of child KEYS from the root — see `ConversationTurn.path`.
   *
   * Built on the way through because that is the only place the answer exists: an event names its
   * parent instance, and the path is the walk up. The root's own path is the empty string, which is
   * what makes "the module you are already looking at" distinguishable from a step inside it.
   */
  const pathOf = new Map<number, string>();
  /**
   * The mount, or `undefined` when the event does not say.
   *
   * The two are different answers and the difference matters: `""` is the ROOT — the module a page
   * is already about — while `undefined` is "this journal does not record where". Older runs are the
   * second case, because `instance.blocked` carried no parent or key until it was given one. Reading
   * those as the root would put every historical block on the module itself and, worse, make two
   * blocks with the same reason indistinguishable.
   */
  const under = (parentInstanceId: number | undefined, childKey: string | undefined): string | undefined => {
    if (parentInstanceId === undefined || childKey === undefined) return undefined;
    const base = pathOf.get(parentInstanceId) ?? "";
    return base === "" ? childKey : `${base}/${childKey}`;
  };

  /** A `path` field, or none at all — an absent mount is not a mount at the root. */
  const mountedAt = (path: string | undefined): { path?: string } => (path === undefined ? {} : { path });

  const turns: ConversationTurn[] = [];
  for (const stored of events) {
    const event = stored.event;
    const at = stored.createdAt;
    const seq = stored.seq;
    /** This event's own place in the run, for the instances that have one. */
    const where = (instanceId: number): { path?: string } => mountedAt(pathOf.get(instanceId));
    switch (event.type) {
      case "instance.entered": {
        // A root has no parent, and its path is the empty string — not "unknown". Every instance is
        // entered before anything else is said about it, so this is what fills the map.
        pathOf.set(event.instanceId, under(event.parentInstanceId, event.childKey) ?? "");
        turns.push({ seq, at, kind: "operation", stateId: event.stateId, ...where(event.instanceId), text: ENTERED_TURN });
        break;
      }
      case "instance.blocked":
        // Never an instance — `instanceId` is -1 — so its place comes from the MOUNT the engine
        // reported instead of from a path it never got as far as having.
        turns.push({
          seq,
          at,
          kind: "blocked",
          stateId: event.stateId,
          ...mountedAt(under(event.parentInstanceId, event.childKey)),
          text: event.reason,
          ok: false,
        });
        break;
      case "operation.started":
        turns.push({ seq, at, kind: "operation", stateId: event.stateId, ...where(event.instanceId), text: event.op });
        break;
      case "operation.completed":
        turns.push({
          seq,
          at,
          kind: "output",
          stateId: event.stateId,
          ...where(event.instanceId),
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
          ...where(event.instanceId),
          ok: false,
          text: event.failure.reason,
        });
        break;
      case "transition.taken":
        turns.push({ seq, at, kind: "transition", stateId: event.stateId, ...where(event.instanceId), text: event.to });
        break;
      case "instance.terminated":
        turns.push({
          seq,
          at,
          kind: "operation",
          stateId: event.stateId,
          ...where(event.instanceId),
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
