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
import { createLogger } from "@declarative-ai/log";
import { MOVED_EVENT, refusal, type MovedEvent } from "@jaira/shared";
import type { JsonValue } from "@declarative-ai/json";
import type { EngineEvent } from "@declarative-ai/hw";
import { isTaskId, type ConversationTurn, type ConversationView, type MadeBatch } from "@jaira/shared";
import type { Project } from "./project";
import { holdingOf } from "./lifecycle";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.persistence.conversation");

/** Turns returned by default. A long agent run produces thousands; the tail is what is being read. */
export const CONVERSATION_LIMIT = 400;

export interface ConversationOptions {
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
/**
 * The task an instance id names, when the id is a task's and that task's provenance says THIS task
 * made it (decision 0003). The id's shape is only the filter — it spares a file read per ordinary
 * instance — and the provenance is the join: a task id that happens to sit in another task's journal
 * for some other reason is not a made task.
 */
function isMadeRow(project: Project, parent: string, instanceId: string): boolean {
  return isTaskId(instanceId) && project.tasks.tryRead(instanceId)?.origin?.taskId === parent;
}

/**
 * The batch a `fanout.made` row records, read from where THIS task stands — see `MadeBatch`. The
 * titles and standings are the tasks' own, now; the row's title is the fallback for a task since
 * deleted.
 */
function madeBatchOf(project: Project, taskId: string, event: Extract<EngineEvent, { type: "fanout.made" }>): MadeBatch {
  const waits = new Set(project.tasks.tryRead(taskId)?.dependsOn ?? []);
  return {
    kind: event.kind,
    runs: event.runs.map((run) => {
      const meta = project.tasks.tryRead(run.runId);
      const row = project.runtime.get(run.runId);
      return {
        taskId: run.runId,
        element: run.element,
        ...(run.id !== undefined ? { id: run.id } : {}),
        title: meta?.title ?? run.title,
        status: row?.status ?? "queued",
        holding: meta !== undefined ? holdingOf(project, meta).length : 0,
        // A generated split makes its tasks HELD and confirms nothing (decision 0005 §3): the line
        // has to say so, or three tasks that are waiting to be asked for read as three that are
        // merely queued behind something.
        ...(meta?.origin?.kind === "split" && meta.origin.start === "manual" && row?.status === "queued" ? { held: true } : {}),
        self: run.runId === taskId,
        waitsFor: waits.has(run.runId),
      };
    }),
  };
}

export function conversationView(project: Project, taskId: string, options: ConversationOptions = {}): ConversationView {
  const row = project.runtime.get(taskId);
  // Named with the project it was looked for IN. A task id is a rowid in one database and every
  // read about it names that database (see `taskDetailView`) — so when this fires, the useful half
  // of the report is which one was asked, not which id was missing.
  if (!row) throw refusal(log, `unknown task '${taskId}' in ${project.paths.projectDir}`, { taskId });
  const meta = project.tasks.tryRead(taskId);
  const events = project.events.list(taskId);
  if (events.length === 0) {
    return { taskId, title: meta?.title ?? taskId, turns: [] };
  }

  /**
   * Where each instance sits, as the chain of child KEYS from the root — see `ConversationTurn.path`.
   *
   * Built on the way through because that is the only place the answer exists: an event names its
   * parent instance, and the path is the walk up. The root's own path is the empty string, which is
   * what makes "the module you are already looking at" distinguishable from a step inside it.
   */
  const pathOf = new Map<string, string>();
  /**
   * The mount, or `undefined` when the event does not say.
   *
   * The two are different answers and the difference matters: `""` is the ROOT — the module a page
   * is already about — while `undefined` is "this journal does not record where". Older runs are the
   * second case, because `instance.blocked` carried no parent or key until it was given one. Reading
   * those as the root would put every historical block on the module itself and, worse, make two
   * blocks with the same reason indistinguishable.
   */
  const under = (parentInstanceId: string | undefined, childKey: string | undefined, element?: number): string | undefined => {
    if (parentInstanceId === undefined || childKey === undefined) return undefined;
    const base = pathOf.get(parentInstanceId) ?? "";
    // An element of a fan-out (WORKFLOWS.md §6.2) is `key[i]` — the same spelling the engine gives
    // its address, so a reader can tell the batch's third element from the mount's third pass.
    const step = element === undefined ? childKey : `${childKey}[${element}]`;
    return base === "" ? step : `${base}/${step}`;
  };

  /** A `path` field, or none at all — an absent mount is not a mount at the root. */
  const mountedAt = (path: string | undefined): { path?: string } => (path === undefined ? {} : { path });

  const turns: ConversationTurn[] = [];
  /** The instance ids that are tasks a fan-out made — see the `instance.entered` case. */
  const madeIds = new Set<string>();
  for (const stored of events) {
    const event = stored.event;
    const at = stored.createdAt;
    const seq = stored.seq;
    /**
     * This event's own place in the run AND the instance it happened to.
     *
     * The two travel together because every reader that wants one wants the other: the path says
     * which mount of a state file this is, and the instance says which RUN of that mount — a loop
     * makes the first ambiguous on its own. See `ConversationTurn.instanceId`.
     */
    const at_ = (instanceId: string): { path?: string; instanceId: string } => ({
      ...mountedAt(pathOf.get(instanceId)),
      instanceId,
    });
    // What the conversation's own `start_task` / `move_task` did (host vocabulary, decision 0005 §3):
    // a fact about the conversation, so it sits at the ROOT, which is the conversation.
    if ((event as { type: string }).type === MOVED_EVENT) {
      const row = event as unknown as MovedEvent;
      turns.push({ seq, at, kind: "moved", path: "", text: row.tool, moved: row.outcome, ...(row.toolCallId !== undefined ? { toolCallId: row.toolCallId } : {}) });
      continue;
    }
    switch (event.type) {
      case "instance.entered": {
        // A RE-STATED entry is not a step. Until 2026-09-08 a continuing run re-entered the live
        // spine under the SAME ids and journaled that (Identity and Resume §04, `load.ts`), and
        // every open of the app that finds a task waiting resumes it — so a journal read as written
        // grew a fresh "entered product" and "entered product → ask" at its tail per reload. hw no
        // longer writes them, but the journals that hold them are still read here, and the rule is
        // the one `projectRun` applies: an id already in the map is the machine being IN that
        // instance again, not entering it. History entered once stays entered once.
        if (pathOf.has(event.instanceId)) break;
        // A root has no parent, and its path is the empty string — not "unknown". Every instance is
        // entered before anything else is said about it, so this is what fills the map.
        pathOf.set(event.instanceId, under(event.parentInstanceId, event.childKey, event.element) ?? "");
        // An element that became a TASK (decision 0003) is the machine making something, not
        // entering it: the mirrored row is the engine's record of the element, and the line that
        // says what was made is the batch's own (`fanout.made`, below). The mirrored row's instance
        // id is the task's id, and the task's provenance is what confirms the join.
        if (isMadeRow(project, taskId, event.instanceId)) {
          madeIds.add(event.instanceId);
          // An ADOPTION (decision 0005 §2) has no batch row to draw its line from — it was never an
          // element — so the mirrored entry is the line: "adopted [title] · standing", at the child
          // it stands for. The task's standing is read now, as a batch's is.
          if ((event as { adopted?: boolean }).adopted === true) {
            const adopted = project.tasks.tryRead(event.instanceId);
            turns.push({
              seq,
              at,
              kind: "made",
              stateId: event.stateId,
              ...mountedAt(under(event.parentInstanceId, event.childKey)),
              ...(event.parentInstanceId !== undefined ? { instanceId: event.parentInstanceId } : {}),
              made: {
                kind: "adopt",
                runs: [
                  {
                    taskId: event.instanceId,
                    element: 0,
                    title: adopted?.title ?? event.instanceId,
                    status: project.runtime.get(event.instanceId)?.status ?? "queued",
                    holding: adopted !== undefined ? holdingOf(project, adopted).length : 0,
                    self: false,
                    waitsFor: (meta?.dependsOn ?? []).includes(event.instanceId),
                  },
                ],
              },
            });
          }
          break;
        }
        turns.push({ seq, at, kind: "entered", stateId: event.stateId, ...at_(event.instanceId) });
        break;
      }
      case "fanout.made":
        // The runs a fan-out made of its elements (decision 0003): one line at the mount, in every
        // task of the batch — the task that split wrote it before cutting the copies, so each carries
        // it — and each reads it from where it stands. Addressed by the MOUNT, not an element: the
        // line belongs to the state that made them, and the reader's own element enters after it.
        turns.push({
          seq,
          at,
          kind: "made",
          stateId: event.stateId,
          ...mountedAt(under(event.instanceId, event.childKey)),
          instanceId: event.instanceId,
          made: madeBatchOf(project, taskId, event),
        });
        break;
      case "instance.blocked":
        // Never an instance — the engine's `instanceId` is -1 — so no id is carried at all, and its
        // place comes from the MOUNT the engine reported rather than from a path it never got as far
        // as having. The absence is what tells a reader there is no panel to look for.
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
        turns.push({ seq, at, kind: "started", stateId: event.stateId, ...at_(event.instanceId), text: event.op });
        break;
      case "operation.completed":
        turns.push({
          seq,
          at,
          kind: "output",
          stateId: event.stateId,
          ...at_(event.instanceId),
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
          ...at_(event.instanceId),
          ok: false,
          text: event.failure.reason,
        });
        break;
      case "transition.taken":
        turns.push({ seq, at, kind: "transition", stateId: event.stateId, ...at_(event.instanceId), text: event.to });
        break;
      case "instance.terminated":
        // A made task's end is on its line already, read from its row; a second line saying
        // "terminated" about a task would be a fact about the mirror, not the machine.
        if (madeIds.has(event.instanceId)) break;
        turns.push({
          seq,
          at,
          kind: "terminated",
          stateId: event.stateId,
          ...at_(event.instanceId),
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
  for (const entry of project.commands.list(taskId)) {
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
    turns: turns.length > limit ? turns.slice(-limit) : turns,
  };
}
