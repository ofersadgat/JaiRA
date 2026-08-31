/**
 * One OPEN PROJECT, and everything that belongs to it while it is open.
 *
 * `AppService` used to hold a single `project?: Project` and, beside it, a dozen fields that were
 * really that project's: the runs in flight, the interaction hub they park on, the approval hub and
 * its audit bookkeeping, the workflow watchers, the sync in flight. Each was a singleton because
 * there was only ever one project — which made "open another one" mean "close this one first".
 *
 * A session is that bundle, named. The service holds a map of them, so a second project is a second
 * entry rather than a second copy of the service, and JaiRA's own runs (the system project, DESIGN
 * §3.1) can be open at the same time as the user's work without either seeing the other's tasks.
 *
 * Two things deliberately do NOT live here, because they are facts about the MACHINE rather than
 * about a project: the executor probes and the availability snapshot. A `claude` binary that answers
 * answers for every project, and asking again per project would pay for the same socket twice.
 */
import type { FSWatcher } from "node:fs";
import type { Project } from "@jaira/persistence";
import { LiveCalls } from "@jaira/runtime";
import type { ApprovalHub, ApprovalRequest, InteractionHub, QuestionHub, UserEventHub } from "@jaira/runtime";
import type { SyncDirection, WorkflowLayer } from "@jaira/shared";
import { LiveTurnLog } from "./liveTurns";

/** A run this session started and has not yet settled. */
export interface LiveRun {
  taskId: string;
  runId: number;
  abort: AbortController;
  /** Resolves when the run has finished recording and settled its task row. */
  done: Promise<void>;
}

/**
 * What the last sync proposed and which of its files are still unsaved.
 *
 * The baseline advances when a proposal is ACCEPTED, not when it is produced (see
 * `persistence/workflowSync.ts`), so something has to remember what was on offer between the run and
 * the save. It belongs to the session that owns the DOCUMENT, which for a shared-root description is
 * the system session — that is how a base-layer proposal survives a project being switched
 * underneath it, which it did not when this was one field on the service.
 */
export interface PendingSync {
  direction: SyncDirection;
  document: string;
  /** The layer the document lives in — which decides where its baseline is written back. */
  layer: WorkflowLayer;
  /**
   * WHICH project, for a `project`-layer document.
   *
   * Carried on the pending proposal rather than looked up when the save lands, because by then there
   * is nothing to look it up FROM: the window holds several projects and none of them is the focused
   * one (SHELL.md §2.3), so the only moment this is known is when the sync was asked for.
   */
  project?: string;
  remaining: Set<string>;
}

/**
 * Where one description's in-flight sync state lives.
 *
 * A {@link ProjectSession} satisfies this structurally, and normally IS the holder. The interface
 * exists for the one case that has no session at all: the shared root is syncable with no project
 * open, and its proposal still has to be remembered between the run and the save.
 */
export interface SyncHolder {
  /**
   * The system task a sync in flight is running AS, so a cancel has an unambiguous target.
   *
   * A task id rather than an `AbortController`, because a sync is a task now: cancelling it is
   * cancelling that task, which also settles its row and releases its claim. An abort held here would
   * stop the work and leave the record saying it was still running.
   */
  syncTask?: string;
  pendingSync?: PendingSync;
}

/**
 * Which kind of project this is.
 *
 * `shared` is the SELECTED root opened as a project in its own right, so a workflow authored in
 * `<root>/workflows` has somewhere for its runs to be recorded — and so does JaiRA itself, whose
 * description sync and conformance check are runs of the same kind against the same root.
 *
 * It is never the FOCUSED session: a window with no user project open must answer "list the tasks"
 * with nothing, not with this.
 */
export type SessionKind = "user" | "shared";

export interface ProjectSessionOptions {
  key: string;
  kind: SessionKind;
  project: Project;
  hub: InteractionHub;
  approvals: ApprovalHub;
  questions: QuestionHub;
  userEvents: UserEventHub;
}

export class ProjectSession {
  readonly key: string;
  readonly kind: SessionKind;
  readonly project: Project;

  /** Runs in flight, by task id. */
  readonly live = new Map<string, LiveRun>();
  /**
   * Model CALLS in flight, by session id — a finer grain than {@link live}, and a different question.
   *
   * A run is live for minutes; the call inside it is what a person can actually talk to, and only
   * while it is taking its turn. See `withLiveCalls`.
   */
  readonly liveCalls = new LiveCalls();
  /**
   * The hand-typed turns in flight, by task id — what a "stop" has to reach.
   *
   * Separate from {@link live} because a chat turn is deliberately not a run: it claims no job, moves
   * no task status, and registers nothing there. Without this there was simply nothing to abort, so a
   * message sent to an agent that then worked for four minutes could only be waited out.
   *
   * A SET per task, not one controller — because more than one turn can be in flight in a thread.
   *
   * It held a single controller on the premise that "`sendChatMessage` already waits for a call in
   * flight before starting another", and the premise was never quite true: a message can JOIN a turn
   * rather than wait for it, and the wait itself is bounded and can time out. What the single slot
   * then did was not merely lose track of one — the new turn ABORTED the old one on its way in, so
   * sending a follow-up killed the answer being written. The stop button worked by accident and
   * typing twice worked like pressing it.
   *
   * The set is per task because the button is: one conversation, one stop, and it means everything
   * this thread has going.
   */
  readonly chatTurns = new Map<string, Set<AbortController>>();
  /**
   * The newest typed turn's COMPLETION, by task — what the message behind it waits for.
   *
   * Where a message goes is computed from where the conversation is recorded as ENDING, so a message
   * still in flight is invisible to the next one's arithmetic: both resolve to the same position, the
   * second collides, and the store branches. One conversation becomes two and the thread reads one.
   *
   * Resolved when the send returns, which is after its journal entry — so a waiter that re-reads the
   * conversation's end at that point sees the turn in it. The live register cannot answer the same
   * question: it holds a call only while it RUNS, so it is silent both before the call starts and
   * after it settles, and a waiter consulting it in either window computes a position something else
   * is already holding.
   *
   * Only a message that cannot JOIN the turn in flight waits on this — see `sendChatMessage`. One
   * that can is not going to claim a position at all.
   */
  readonly chatDone = new Map<string, Promise<void>>();
  /**
   * How to write down what a task's live turn holds RIGHT NOW, by task id.
   *
   * Registered by whatever is streaming — a run or a typed turn — and called by "stop" before it
   * aborts anything. The throttle behind it is right for the ordinary case and wrong for exactly this
   * one: an interrupted call has no settled result to supersede its partial, so what survives is the
   * last flush, which is up to an interval stale and, for a turn stopped early, nothing at all. A
   * stop is the one moment the exact tail matters, because it is the tail the person was reading.
   */
  readonly liveFlush = new Map<string, () => void>();
  readonly hub: InteractionHub;
  /** requestId → taskId, for a request whose registration could not name one. */
  readonly requestTask = new Map<string, string>();
  /**
   * taskId → the project this task's work is ABOUT, when that is not this session.
   *
   * Set for the reviews JaiRA runs on another project's behalf: a changeset review is recorded here,
   * in the system project, while the files under review live in the reviewed task's project or in
   * the layer root a sync proposal targets. It is what lets a parked gate tell the renderer which
   * project to read `$WORKTREE`, `$JAIRA` and `$PROJECT` against — see
   * `PendingInteraction.subjectProject`, which is stamped from here and is deliberately not that
   * request's `project` (the session it parked in, which for a review is always JaiRA's own).
   *
   * In memory, like {@link requestTask}: a parked request does not outlive the process either.
   */
  readonly subjectProject = new Map<string, string>();
  /**
   * Function names this session routes to the renderer — its gate vocabulary. Grows as runs register
   * their bundles' functions, and is what makes a parked state read `waiting_for_user` in the views.
   */
  readonly interactive = new Set<string>();
  /** Per-command approvals (DESIGN §10.2) — provider-initiated, so not authored states. */
  readonly approvals: ApprovalHub;
  /** requestId → the run it belongs to, so a decision can be audited against it. */
  readonly approvalRun = new Map<string, { taskId: string; runId: number }>();
  /** Requests seen, kept until resolved so the audit entry can name the command. */
  readonly approvalsSeen = new Map<string, ApprovalRequest>();
  /** Mid-run questions (`AskUserQuestion`) — the call IS the question, so not an approval. */
  readonly questions: QuestionHub;
  /**
   * Transitions waiting on a gesture — `on_user_event`, the seam that makes a card draggable.
   *
   * The fourth inbox channel and the only one with no inbox: the other three park something and ask
   * for an answer, where this one parks a RULE and offers the move it describes through the board a
   * person is already looking at. Nothing is shown until they reach for the card.
   */
  readonly userEvents: UserEventHub;
  /**
   * The live turn each running task is streaming — main's copy of the renderer's `liveTurn`, held
   * where navigation cannot lose it and served back over `session:live`. See {@link LiveTurnLog}.
   */
  readonly liveTurns = new LiveTurnLog();

  /**
   * The workflows watchers and their shared debounce timer (§11.1 re-lint).
   *
   * Plural because there are two roots to watch: this project's own and the shared base root. A base
   * edit changes what this project runs, so leaving it unwatched would mean the browser quietly
   * described a workflow that no longer exists.
   */
  watchers: FSWatcher[] = [];
  watchTimer?: ReturnType<typeof setTimeout>;

  /** The system task a sync in flight is running as — see {@link SyncHolder}. */
  syncTask?: string;
  pendingSync?: PendingSync;

  constructor(options: ProjectSessionOptions) {
    this.key = options.key;
    this.kind = options.kind;
    this.project = options.project;
    this.hub = options.hub;
    this.approvals = options.approvals;
    this.questions = options.questions;
    this.userEvents = options.userEvents;
  }

  get dir(): string {
    return this.project.paths.projectDir;
  }

  /**
   * Abort everything this session is doing and close its database.
   *
   * Awaiting the aborted runs is not optional: a run keeps journaling for a beat after its abort (and
   * still has a `finishTaskRun` to write), so closing the database first would throw "database
   * connection is not open" from inside the engine's event tee — an unhandled rejection, and a task
   * row left `running`.
   */
  async close(reason = "the project was closed"): Promise<void> {
    clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    // ABANDONED, not settled — the default, and stated here because it is the whole of what makes a
    // gate durable. The promise has to settle or the engine never unwinds and the database never
    // closes; that is a fact about this process and not an answer to the question, so the row stays
    // and the next open asks the same thing again. See `RequestFate`.
    this.hub.rejectAll(reason, "abandoned");
    this.approvals.denyAll();
    // A parked question parks the agent's tool loop just as hard — dismissed, the agent proceeds
    // on its own judgment, which is the honest answer from a project that is going away.
    this.questions.dismissAll();
    // A wait on a gesture nobody can make any more answers `false`: the transitions behind it get
    // their turn, which is what an author's fallback rule is for.
    this.userEvents.declineAll();
    // A sync in flight is one of the live runs below, so aborting it needs nothing special here. What
    // does go is the proposal it was about to produce, which belongs to a project that is going away.
    this.syncTask = undefined;
    this.pendingSync = undefined;
    // A hand-typed turn is not in `live`, so it would otherwise keep talking to a provider on behalf
    // of a project that is gone — and finish by writing to a closed database.
    for (const turns of this.chatTurns.values()) for (const turn of turns) turn.abort();
    this.chatTurns.clear();
    const inFlight = [...this.live.values()];
    for (const run of inFlight) run.abort.abort();
    await Promise.allSettled(inFlight.map((run) => run.done));
    this.live.clear();
    this.project.close();
  }
}
