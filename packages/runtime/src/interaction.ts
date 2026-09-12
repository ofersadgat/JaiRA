/**
 * The live human-in-the-loop seam (DESIGN §7.1, SPEC §11.4).
 *
 * An interactive state is an ordinary `FunctionOp` whose function is registered
 * as `interactive`. This hub registers such functions and, instead of answering
 * from a script, parks the call and emits a request for a UI to answer. The
 * Electron main process forwards those requests to the renderer over IPC and
 * feeds answers back through {@link InteractionHub.submit}.
 *
 * Why this preserves the approval-gate guarantee: the registry is supplied by
 * the caller (the main process), and nothing running *inside* a workflow can
 * reach it or this hub. An answer can only arrive through `submit`, which only
 * the IPC layer calls — so an agent cannot fabricate a human decision.
 *
 * ## This hub is the process, and the question is not
 *
 * Everything here lives in one Map for as long as one process does. That used to be the whole
 * story, and it made quitting the app an ANSWER: every parked call was rejected, the state took a
 * failure the author never wrote a rule for, and the question somebody was in the middle of
 * reading was gone. A gate is a place a task sits — the same thing `on_user_event` says about a
 * wait — and a place has to still be there when you come back.
 *
 * So a park is now published to a host that writes it down (`pending_interactions` in
 * `@jaira/persistence`), and {@link RequestFate} is how this hub tells that host which of the two
 * things happened: a person decided, or the process left. The second one keeps the row, the next
 * open offers the same gate, and answering it starts the task again with the answer already in
 * hand — see {@link InteractionHub.seed}, which is the half of that round trip that lives here.
 */
import {
  failureOf,
  hostFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type FunctionResult,
  type JsonValue,
  type ResolvedValue,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { INTERACTIVE } from "./scriptedFunctions";

export interface HubRequest {
  requestId: string;
  /** The registered function name — the UI component to render. */
  component: string;
  inputs: Record<string, JsonValue>;
  /**
   * The task whose run parked, when the registration named one.
   *
   * Carried rather than inferred, because the alternative was a guess: the app used to label a
   * request with whichever run happened to be first in its live map, which is right only while
   * exactly one run exists. A registration belongs to one run, so that is where the answer is.
   */
  taskId?: string;
}

type Pending = {
  request: HubRequest;
  resolve: (result: FunctionResult<ResolvedValue, WorkflowMetrics>) => void;
};

/**
 * The seeded-answer map key: one task's one component.
 *
 * `\u0000` as the separator, and it is not decoration. A task id and a function name are both
 * caller-supplied strings, and any printable joiner is a string one of them could contain — which
 * would let `unseed` clear a neighbour's answer, or let two different pairs collide on one queue.
 */
function seedKey(taskId: string, component: string): string {
  return `${taskId}\u0000${component}`;
}

/**
 * How a parked request stopped being parked.
 *
 * `settled` is a person: an answer, or a decline, either way a decision that belongs to the run.
 * `abandoned` is the process going away with the question still open — and the difference is the
 * whole of what makes a gate durable, because only the first means the question is over. A host
 * keeping a record of parked gates deletes on `settled` and keeps on `abandoned`.
 */
export type RequestFate = "settled" | "abandoned";

export interface InteractionHubOptions {
  /** Called when a state parks awaiting a human. */
  onRequest?: (request: HubRequest) => void;
  /** Called when a parked request is answered, canceled, or rejected. */
  onResolved?: (requestId: string, fate: RequestFate) => void;
  /** Request id generator — injectable so tests are deterministic. */
  nextId?: () => string;
}

export class InteractionHub {
  private readonly pending = new Map<string, Pending>();
  /**
   * Answers given BEFORE the call that wants them — keyed by {@link seedKey}, FIFO.
   *
   * A gate survives the process that parked it (`pending_interactions`), so a person can answer one
   * whose run is long gone. Answering it starts the task again from the record; the resumed run
   * replays everything that completed and re-dispatches the state it stopped in, which is this
   * function — and re-asking a question already answered is the one thing that must not happen.
   *
   * So the answer is handed to the hub before the run starts and consumed by the park it was meant
   * for. Deliberately NOT the {@link ScriptedFunctions} path, which REPLACES the registration for a
   * function name and so would leave a second park later in the same run with an exhausted queue
   * and no live hub behind it. This is one shot, and everything after it parks normally.
   */
  private readonly seeded = new Map<string, JsonValue[]>();
  /**
   * Requests taken OFF the pending list without being settled — see {@link hold}.
   *
   * A follow-up round: the person answered, the host is asking a model whether to ask more, and the
   * engine's promise has to stay open through that. Not on {@link pending}, because nothing on screen
   * should offer the answered question again; not settled, because the answer is not final.
   */
  private readonly held = new Map<string, { request: HubRequest; resolve: (r: FunctionResult<ResolvedValue, WorkflowMetrics>) => void }>();
  private counter = 0;

  constructor(private readonly options: InteractionHubOptions = {}) {}

  /**
   * Answer the NEXT park of `component` by `taskId` without ever showing it — see {@link seeded}.
   *
   * Scoped to a task because a component name is not an identity: `choose_option` is parked by every
   * workflow that asks a question, and an answer meant for one task must not be eaten by another
   * task's run that happens to reach its gate first.
   */
  seed(taskId: string, component: string, value: JsonValue): void {
    const key = seedKey(taskId, component);
    this.seeded.set(key, [...(this.seeded.get(key) ?? []), value]);
  }

  /**
   * Drop every seeded answer for a task.
   *
   * A resumed run may never reach the state it was seeded for — an earlier transition can take it
   * somewhere else — and an answer left lying about would be spent on whatever asked next, which
   * from the person's side is a question that answered itself.
   */
  unseed(taskId: string): void {
    for (const key of [...this.seeded.keys()]) if (key.startsWith(seedKey(taskId, ""))) this.seeded.delete(key);
  }

  /** Requests currently awaiting an answer, oldest first. */
  list(): HubRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /**
   * Register `name` as an interactive function backed by this hub. Every call
   * parks until `submit`/`reject` names its request id.
   *
   * `taskId` is the run this registration serves — a registry is built per run, so it is known here
   * and stamped on every request the registration parks.
   */
  register(registry: CapabilityRegistry<WorkflowMetrics>, name: string, taskId?: string): this {
    registry.functions.set(
      name,
      hostFunction(async (inputs: FunctionInputs) => this.park(name, inputs, taskId), INTERACTIVE),
    );
    return this;
  }

  private park(
    component: string,
    inputs: FunctionInputs,
    taskId?: string,
  ): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> {
    // The answer somebody already gave, if this is the park it was given for — see {@link seeded}.
    // Consumed before a request id is minted, because there is no request: nothing is shown, nothing
    // is published, and the engine gets its value in the same turn it asked.
    const queue = taskId === undefined ? undefined : this.seeded.get(seedKey(taskId, component));
    if (queue !== undefined && queue.length > 0) {
      const value = queue.shift()!;
      if (queue.length === 0) this.seeded.delete(seedKey(taskId!, component));
      return Promise.resolve({ value } as FunctionResult<ResolvedValue, WorkflowMetrics>);
    }
    const requestId = this.options.nextId?.() ?? `ui-${++this.counter}`;
    const request: HubRequest = {
      requestId,
      component,
      inputs: inputs as Record<string, JsonValue>,
      ...(taskId !== undefined ? { taskId } : {}),
    };
    return new Promise<FunctionResult<ResolvedValue, WorkflowMetrics>>((resolve) => {
      this.pending.set(requestId, { request, resolve });
      this.options.onRequest?.(request);
    });
  }

  /** Answer a parked request. Returns false when the id is unknown (or already answered). */
  submit(requestId: string, value: JsonValue): boolean {
    return this.settle(requestId, { value }, "settled");
  }

  /**
   * Take a parked request off the list while the host decides what to do with its answer.
   *
   * Reported to the host as SETTLED — the durable row closes and the renderer drops the gate — but
   * the engine's promise stays open on {@link held}, to be {@link release}d with a value or
   * {@link repark}ed as a new request. `undefined` when the id is not a live park.
   */
  hold(requestId: string): HubRequest | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    this.pending.delete(requestId);
    this.held.set(requestId, entry);
    this.options.onResolved?.(requestId, "settled");
    return entry.request;
  }

  /** Settle a held request with its final value. False when nothing is held under the id. */
  release(requestId: string, value: JsonValue): boolean {
    const entry = this.held.get(requestId);
    if (!entry) return false;
    this.held.delete(requestId);
    entry.resolve({ value } as FunctionResult<ResolvedValue, WorkflowMetrics>);
    return true;
  }

  /**
   * Park a held request AGAIN, as a new request with new inputs — the next round of a gate that
   * asks follow-up questions. Same component, same task, same engine promise; a fresh id, because a
   * request id names one question put to a person and this is a different one. Published like any
   * park, so it gets its durable row and its place on screen.
   */
  repark(requestId: string, inputs: Record<string, JsonValue>): HubRequest | undefined {
    const entry = this.held.get(requestId);
    if (!entry) return undefined;
    this.held.delete(requestId);
    const next = this.options.nextId?.() ?? `ui-${++this.counter}`;
    const request: HubRequest = { ...entry.request, requestId: next, inputs };
    this.pending.set(next, { request, resolve: entry.resolve });
    this.options.onRequest?.(request);
    return request;
  }

  /** Fail a parked request — a declined gate, as DATA (the engine's contract). */
  reject(requestId: string, reason: string): boolean {
    return this.settle(requestId, { error: failureOf(new Error(reason)) }, "settled");
  }

  /**
   * Fail every parked request — used when a run is canceled or the window
   * closes, so a workflow never hangs on a gate nobody can answer any more.
   *
   * `fate` is what the host is told about each. The default is `abandoned`, because every caller of
   * the whole-hub form is a shutdown: the promise has to settle so the engine can unwind and the
   * database can close, and that is a fact about THIS PROCESS rather than an answer to the question.
   * A host holding the question durably keeps it — which is what makes closing the app not a
   * decision, and reopening it not a fresh start.
   */
  rejectAll(reason: string, fate: RequestFate = "abandoned"): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, { error: failureOf(new Error(reason)) }, fate);
    }
    // A held request has no row and no place on screen any more — its answer is with the host,
    // mid-decision — so there is nothing to keep; the engine is simply unblocked.
    for (const [requestId, entry] of [...this.held.entries()]) {
      this.held.delete(requestId);
      entry.resolve({ error: failureOf(new Error(reason)) });
    }
  }

  private settle(
    requestId: string,
    result: FunctionResult<ResolvedValue, WorkflowMetrics>,
    fate: RequestFate,
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(result);
    this.options.onResolved?.(requestId, fate);
    return true;
  }
}
