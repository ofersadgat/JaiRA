/**
 * `on_event(name, filter?)` — a deferred guard that waits for something to HAPPEN (decision 0010 §3),
 * and the hub that hands what happened to whoever waits for it.
 *
 * ```jsonc
 * { "name": "release_push", "when": "on_event('git.push', { branch: 'release/*' })", "to": "release_build" }
 * ```
 *
 * The sibling of `on_user_event` and `on_remote_event`, on the same engine machinery, with three
 * differences that are the point of it:
 *
 *  - **It resolves to the event** — `{ name, payload, at }` — not to `true`: a rule reads what
 *    happened (`.event.payload.branch`), and the event is what a target's `inputs` are built from.
 *  - **It is never answered `false` because nobody is watching.** Waiting for the world is its whole
 *    job, attended or not; a run that is stopped withdraws the wait, and nothing else does.
 *  - **Events are QUEUED per task.** From the moment a task first waits on an event name, every event
 *    of that name that arrives for its project is kept for it until a wait takes it — so an event that
 *    lands while no rule is armed (a guard between rounds, a rule sitting out while the chain it
 *    started runs) is handled when the rule is armed again, in order, rather than lost. A wait takes
 *    the OLDEST queued event its filter matches; with none, it parks until one arrives.
 *
 * It is a LISTENING wait (`HostCapabilities.listens`): a subscription rather than a question, so every
 * `on_event` rule in a state is armed at once and the first to come true fires. One event goes to ONE
 * wait — the oldest armed wait whose filter matches, which is the first such rule in list order — and
 * the engine keeps an answer the taken rule did not read for the next round, so an event is handled
 * once.
 *
 * ## Which events
 *
 * The hub is PER PROJECT (one per open session, like every other hub): the repository watcher and
 * the service deliver an event to the hub of the project it happened for, so a task never hears
 * another project's push. `task.*` events are delivered with the task they are ABOUT, which never
 * hears its own.
 *
 * ## Across a restart
 *
 * A task parked on `on_event` when the app closes is suspended and resumed on the next start (see the
 * service). When its guards first began waiting on each name is durable (`EventWaitPort`), and the
 * hub keeps what it delivered in the last {@link RECENT_MS}, so what the watcher catches up on after
 * the start — before the resumed task has re-armed — is still queued for it.
 */
import {
  hostFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type FunctionResult,
  type HostCapabilities,
  type InlineFamily,
  type ResolvedValue,
  type Signature,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  EVENT_NAMES,
  EVENT_SPECS,
  isEventName,
  matchesEventFilter,
  type EventDelivery,
  type EventFilter,
  type EventName,
  type EventWaitPort,
  type JairaEvent,
} from "@jaira/shared";

export const ON_EVENT = "on_event";

export const EVENT_SIGNATURE: Signature<InlineFamily> = {
  input: {
    /** Which event — one of `EVENT_NAMES`. */
    name: { kind: "text", index: 0, schema: { type: "string" } },
    /** `{ branch, remote, author, source_branch, target_branch }` — each a glob or a list — as the event takes them. */
    filter: { kind: "json", index: 1, optional: true, schema: { type: "object" } },
    /** Filled by the loader, never by an author: it keeps two rules' identical waits two calls. */
    transition: { kind: "json", optional: true, schema: { type: "object", properties: { to: { type: "string" } } } },
  },
  output: { name: "event", kind: "json", schema: { type: "object" } },
};

export const EVENT_CAPABILITIES: HostCapabilities = {
  // Nobody at this machine is being asked anything.
  interactive: false,
  readOnly: true,
  // An event, not a computation: a memo would answer the next wait with the last push.
  memoizable: false,
  deferred: true,
  // A subscription, not a question — every `on_event` rule in a state armed at once.
  listens: true,
};

/** How long delivered events are kept for a task that resumes and re-arms after they arrived. */
export const RECENT_MS = 15 * 60_000;
/** At most this many events are kept per task and name; past it the oldest go. */
export const QUEUE_LIMIT = 100;
/** `wait_git_event`'s timeout when the call names none, and the longest it may name. */
export const WAIT_DEFAULT_MS = 10 * 60_000;
export const WAIT_MAX_MS = 60 * 60_000;

/** Who waits: a task's guards (`on_event`), or its agent (`wait_git_event`) — two queues, so one never takes the other's event. */
export type EventWaiter = "guard" | "tool";

/** A wait in progress — what a view could draw. */
export interface EventWaitRequest {
  requestId: string;
  taskId: string;
  waiter: EventWaiter;
  name: EventName;
  filter?: EventFilter;
  /** Epoch ms the wait began. */
  at: number;
}

export interface EventHubOptions {
  /** When a task's guards first waited on each name, kept across a restart. Absent: in memory only. */
  waits?: EventWaitPort;
  now?: () => number;
  onWaiting?: (request: EventWaitRequest) => void;
  onResolved?: (requestId: string) => void;
}

/**
 * A wait's name and filter, checked — or why they cannot be waited on. An unknown event, or a filter
 * key the event does not take, is refused rather than waited on forever.
 */
export function checkEventWait(name: unknown, filter: unknown, where = ON_EVENT): { name: EventName; filter?: EventFilter } | { error: string } {
  if (!isEventName(name)) {
    return { error: `${where}: ${JSON.stringify(name)} is not an event — it is one of ${EVENT_NAMES.join(", ")}` };
  }
  if (filter === undefined || filter === null) return { name };
  if (typeof filter !== "object" || Array.isArray(filter)) return { error: `${where}('${name}'): the filter is an object — { branch: 'main' }` };
  const takes = EVENT_SPECS[name].filters;
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (!(takes as readonly string[]).includes(key)) {
      return {
        error:
          takes.length === 0
            ? `${where}('${name}'): ${name} takes no filter, and was given '${key}'`
            : `${where}('${name}'): '${key}' is not a filter ${name} takes — it takes ${takes.join(", ")}`,
      };
    }
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) out[key] = value as string[];
    else return { error: `${where}('${name}'): the filter's '${key}' is a glob or a list of globs` };
  }
  return Object.keys(out).length > 0 ? { name, filter: out as EventFilter } : { name };
}

/**
 * `on_event` where nothing can ever deliver one — a process with no repository watcher and no other
 * task to finish, like the CLI. It RESOLVES, so a workflow that waits on an event loads and runs; and
 * a run that reaches the wait fails saying why, rather than hanging on a world nobody is watching or
 * — the thing this wait must never do — being answered `false` for being unattended.
 */
export function registerUnservedEvents(registry: CapabilityRegistry<WorkflowMetrics>, where: string): void {
  registry.functions.set(
    ON_EVENT,
    hostFunction(
      async (inputs: FunctionInputs): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
        const checked = checkEventWait(inputs["name"], inputs["filter"]);
        const reason = "error" in checked ? checked.error : `${ON_EVENT}('${checked.name}') is not served ${where} — nothing watches for events here; run the task in the app`;
        return { error: { classification: "permanent", reason } };
      },
      EVENT_CAPABILITIES,
      { signature: EVENT_SIGNATURE },
    ),
  );
}

interface Subscription {
  /** Epoch ms from which events count. */
  since: number;
  queue: EventDelivery[];
}

interface Pending {
  request: EventWaitRequest;
  settle: (delivery: EventDelivery | undefined) => boolean;
}

const subscriberOf = (taskId: string, waiter: EventWaiter): string => `${waiter}:${taskId}`;

export class EventHub {
  /** subscriber → name → its queue. */
  private readonly subscriptions = new Map<string, Map<EventName, Subscription>>();
  private readonly pending = new Map<string, Pending>();
  /** What was delivered lately, for a task that re-arms after a restart. */
  private recent: Array<{ delivery: EventDelivery; seenAt: number; from?: string }> = [];
  private counter = 0;

  constructor(private readonly options: EventHubOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Every wait in progress, oldest first. */
  list(): EventWaitRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** Register `on_event` for one run. */
  register(registry: CapabilityRegistry<WorkflowMetrics>, taskId: string | undefined): this {
    registry.functions.set(
      ON_EVENT,
      hostFunction(
        async (inputs: FunctionInputs, ctx: { abortSignal?: AbortSignal }) => this.park(inputs, taskId, ctx?.abortSignal),
        EVENT_CAPABILITIES,
        { signature: EVENT_SIGNATURE },
      ),
    );
    return this;
  }

  private async park(inputs: FunctionInputs, taskId: string | undefined, abortSignal?: AbortSignal): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> {
    const checked = checkEventWait(inputs["name"], inputs["filter"]);
    if ("error" in checked) return { error: { classification: "permanent", reason: checked.error } };
    if (taskId === undefined) return { error: { classification: "permanent", reason: `${ON_EVENT}: only a task's run can wait for an event` } };
    const delivery = await this.wait(taskId, checked.name, checked.filter, { waiter: "guard", ...(abortSignal !== undefined ? { signal: abortSignal } : {}) });
    // Undefined only when the wait was withdrawn — the engine cancelled the call, and its own
    // cancellation has already settled it; this value is never read.
    return { value: (delivery ?? null) as unknown as ResolvedValue };
  }

  /**
   * Wait for one event of `name` matching `filter`, for one task: the oldest already queued for it,
   * else the next to arrive. Resolves `undefined` when the timeout passes or the signal aborts.
   *
   * A task's first wait on a name opens its queue for that name; a guard's is durable (see the
   * module's note), so a resumed task's queue starts where the suspended one's did.
   */
  wait(
    taskId: string,
    name: EventName,
    filter: EventFilter | undefined,
    options: { waiter?: EventWaiter; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<EventDelivery | undefined> {
    const waiter = options.waiter ?? "tool";
    const subscriber = subscriberOf(taskId, waiter);
    const subscription = this.subscribe(subscriber, taskId, name, waiter === "guard");
    const index = subscription.queue.findIndex((delivery) => matchesEventFilter(delivery, filter));
    if (index >= 0) return Promise.resolve(subscription.queue.splice(index, 1)[0]);
    if (options.signal?.aborted === true) return Promise.resolve(undefined);

    const requestId = `on-event-${++this.counter}`;
    const request: EventWaitRequest = { requestId, taskId, waiter, name, ...(filter !== undefined ? { filter } : {}), at: this.now() };
    return new Promise<EventDelivery | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      const onAbort = (): void => void settle(undefined);
      const settle = (delivery: EventDelivery | undefined): boolean => {
        if (!this.pending.delete(requestId)) return false;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(delivery);
        this.options.onResolved?.(requestId);
        return true;
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => settle(undefined), Math.min(Math.max(0, options.timeoutMs), 2_147_483_647));
        timer.unref?.();
      }
      this.pending.set(requestId, { request, settle });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.options.onWaiting?.(request);
    });
  }

  private subscribe(subscriber: string, taskId: string, name: EventName, durable: boolean): Subscription {
    let byName = this.subscriptions.get(subscriber);
    if (byName === undefined) this.subscriptions.set(subscriber, (byName = new Map()));
    let subscription = byName.get(name);
    if (subscription !== undefined) return subscription;
    const now = this.now();
    let since = now;
    if (durable && this.options.waits !== undefined) {
      since = this.options.waits.since(taskId, name) ?? now;
      this.options.waits.open(taskId, name, since);
    }
    // What arrived since then and before this process's first wait — a resumed task's catch-up.
    const queue = since < now ? this.recent.filter((r) => r.seenAt >= since && r.delivery.name === name && r.from !== taskId).map((r) => r.delivery) : [];
    byName.set(name, (subscription = { since, queue }));
    return subscription;
  }

  /**
   * An event happened for this project: hand it to the oldest armed wait it matches for each task that
   * listens for its name, and queue it for each that has none. `from` is the task a `task.*` event is
   * about, which does not hear its own. Returns how many tasks it reached.
   */
  deliver(event: JairaEvent | EventDelivery, options: { from?: string } = {}): number {
    const now = this.now();
    const delivery: EventDelivery = { ...event, at: "at" in event && typeof event.at === "string" ? event.at : new Date(now).toISOString() } as EventDelivery;
    this.recent.push({ delivery, seenAt: now, ...(options.from !== undefined ? { from: options.from } : {}) });
    this.recent = this.recent.filter((r) => now - r.seenAt <= RECENT_MS).slice(-QUEUE_LIMIT * 2);
    let reached = 0;
    for (const [subscriber, byName] of this.subscriptions) {
      const subscription = byName.get(delivery.name);
      if (subscription === undefined) continue;
      const taskId = subscriber.slice(subscriber.indexOf(":") + 1);
      if (options.from !== undefined && taskId === options.from) continue;
      reached += 1;
      const waiting = [...this.pending.values()].find(
        (p) => subscriberOf(p.request.taskId, p.request.waiter) === subscriber && p.request.name === delivery.name && matchesEventFilter(delivery, p.request.filter),
      );
      if (waiting !== undefined && waiting.settle(delivery)) continue;
      subscription.queue.push(delivery);
      if (subscription.queue.length > QUEUE_LIMIT) subscription.queue.splice(0, subscription.queue.length - QUEUE_LIMIT);
    }
    return reached;
  }

  /** What is queued for a task's guards (or its agent), oldest first — for a view, and for tests. */
  queued(taskId: string, name: EventName, waiter: EventWaiter = "guard"): EventDelivery[] {
    return [...(this.subscriptions.get(subscriberOf(taskId, waiter))?.get(name)?.queue ?? [])];
  }

  /**
   * A task's run ended for good (not suspended): its queues and its durable wait starts go, and any
   * wait still open is withdrawn.
   */
  forgetTask(taskId: string): void {
    for (const waiter of ["guard", "tool"] as const) this.subscriptions.delete(subscriberOf(taskId, waiter));
    for (const pending of [...this.pending.values()]) if (pending.request.taskId === taskId) pending.settle(undefined);
    this.options.waits?.closeTask(taskId);
  }

  /**
   * The project is closing. Waits are NOT answered — an answer would let a guard's fallback rule fire
   * on a world that did not change; the run's abort withdraws them. The durable starts stay, so the
   * resumed task's queue picks up where this one's was.
   */
  close(): void {
    this.subscriptions.clear();
  }
}
