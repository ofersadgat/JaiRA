/**
 * `on_remote_event` — a transition that waits on the FORGE (decision 0004 §2).
 *
 * ```
 * on_remote_event('merge_request', { events: ['settled'], settle_after: '10m', timeout: '7d' })
 * ```
 *
 * The sibling of `on_user_event`, on the same engine machinery and with the same park semantics: a
 * deferred call in a guard, nothing new starts in the state while it waits, a `timeout` answers
 * `false`, and a taken transition cancels the waits it did not answer. What differs is who answers —
 * not a gesture in this window but something done on a merge request, possibly days later and
 * possibly while the app was closed.
 *
 * It resolves with the SAME settlement `review_artifacts.remote` uses — `{ decision?, decisions,
 * settled_by, remote }` — so a workflow that wants a forge wait with no gate at all has one, and a
 * guard can read `.decision` off it. With no changeset there is nothing to decide per change, and
 * `decisions` is empty.
 *
 * This hub does no watching. It marks the request's row AWAITED — which is the poller's whole
 * definition of "something to poll" — and is told when the watcher settles it.
 */
import {
  hostFunction,
  type CapabilityRegistry,
  type FunctionInputs,
  type FunctionResult,
  type HostCapabilities,
  type InlineFamily,
  type JsonValue,
  type ResolvedValue,
  type Signature,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { DEFAULT_REMOTE_KEY, parseDuration, type RemoteHandlePort } from "@jaira/shared";

export const ON_REMOTE_EVENT = "on_remote_event";
/** The one event there is. A name and not a flag, so the call reads like its sibling. */
export const MERGE_REQUEST = "merge_request";

export const REMOTE_EVENT_SIGNATURE: Signature<InlineFamily> = {
  input: {
    event: { kind: "text", index: 0, schema: { type: "string" } },
    options: { kind: "json", index: 1, optional: true, schema: { type: "object" } },
    transition: { kind: "json", optional: true, schema: { type: "object", properties: { to: { type: "string" } } } },
  },
  output: { name: "settlement", kind: "json", schema: {} },
};

export const REMOTE_EVENT_CAPABILITIES: HostCapabilities = {
  // Not interactive: nobody at THIS machine is being asked anything.
  interactive: false,
  readOnly: true,
  memoizable: false,
  deferred: true,
};

export interface RemoteEventRequest {
  requestId: string;
  taskId: string;
  /** The request's key within the task. */
  key: string;
  at: number;
}

export interface RemoteEventHubOptions {
  /**
   * Called when a wait begins — the host's cue to probe now. ABSENT MEANS UNATTENDED: with nothing
   * watching, every call answers `false` at once rather than parking on a forge nobody reads.
   */
  onWaiting?: (request: RemoteEventRequest) => void;
  onResolved?: (requestId: string) => void;
  now?: () => number;
}

interface Pending {
  request: RemoteEventRequest;
  settle: (value: JsonValue | false) => boolean;
}

const record = (v: unknown): Record<string, JsonValue> => (v !== null && typeof v === "object" && !Array.isArray(v) ? ({ ...v } as Record<string, JsonValue>) : {});

/** A duration as the settings write one (`"7d"`), or a number of seconds as `on_user_event` takes. */
function millis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value * 1000;
  return typeof value === "string" ? parseDuration(value) : undefined;
}

export class RemoteEventHub {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  /** Set by {@link declineAll}: this process has stopped listening, so nothing new parks. */
  private closed = false;
  /**
   * What each request last settled with, and the head it was settled AT.
   *
   * A state may read one wait from several rules — `on_remote_event(…).decision === 'approve'` and,
   * behind it, the bare call. Those are separate calls to the engine, and the second is only reached
   * once the first has answered; without this it would park a fresh wait for an event that has
   * already happened and never will again. Keyed to the pushed head, so the next ROUND — which
   * pushes — waits for news rather than hearing the last round's answer twice.
   */
  private readonly heard = new Map<string, { head: string | undefined; settlement: JsonValue }>();

  constructor(private readonly options: RemoteEventHubOptions = {}) {}

  list(): RemoteEventRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  register(registry: CapabilityRegistry<WorkflowMetrics>, taskId: string | undefined, handles: RemoteHandlePort | undefined): this {
    registry.functions.set(
      ON_REMOTE_EVENT,
      hostFunction(
        async (inputs: FunctionInputs, ctx: { abortSignal?: AbortSignal }) => this.park(inputs, taskId, handles, ctx?.abortSignal),
        REMOTE_EVENT_CAPABILITIES,
        { signature: REMOTE_EVENT_SIGNATURE },
      ),
    );
    return this;
  }

  private park(
    inputs: FunctionInputs,
    taskId: string | undefined,
    handles: RemoteHandlePort | undefined,
    abortSignal?: AbortSignal,
  ): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> {
    const no = Promise.resolve({ value: false as ResolvedValue });
    if (this.closed || this.options.onWaiting === undefined || taskId === undefined || handles === undefined) return no;
    if (String(inputs["event"] ?? "") !== MERGE_REQUEST) return no;

    const options = record(inputs["options"]);
    const remote = record(options["remote"]);
    const key = typeof remote["$key"] === "string" ? remote["$key"] : typeof remote["key"] === "string" ? remote["key"] : DEFAULT_REMOTE_KEY;
    const row = handles.get(taskId, key);
    // Nothing was opened, so there is nothing to hear from: the honest answer is that it did not happen.
    if (row === undefined || row.number === undefined) return no;
    const heard = this.heard.get(JSON.stringify([taskId, key]));
    if (heard !== undefined && heard.head === row.pushedHead) return Promise.resolve({ value: heard.settlement as ResolvedValue });

    const requestId = `remote-${++this.counter}`;
    const request: RemoteEventRequest = { requestId, taskId, key, at: this.options.now?.() ?? Date.now() };
    const settleAfter = millis(options["settle_after"]);
    handles.update(taskId, key, { awaiting: true, requestId: null, ...(settleAfter !== undefined ? { settleAfterMs: settleAfter } : {}) });

    return new Promise<FunctionResult<ResolvedValue, WorkflowMetrics>>((resolve) => {
      const timeout = millis(options["timeout"]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.options.onResolved?.(requestId);
      };
      // The engine cancelling the call — a taken transition cancels the waits it did not answer.
      // Named, `once`, and removed when the wait ends any other way (see `userEvents.ts` for why).
      const onAbort = (): void => {
        if (!this.pending.delete(requestId)) return;
        handles.update(taskId, key, { awaiting: false });
        stop();
      };
      const settle = (value: JsonValue | false): boolean => {
        if (!this.pending.delete(requestId)) return false;
        abortSignal?.removeEventListener("abort", onAbort);
        if (value === false) handles.update(taskId, key, { awaiting: false });
        resolve({ value: value as ResolvedValue });
        stop();
        return true;
      };
      if (timeout !== undefined && timeout > 0) {
        // Node caps a timer at 2^31-1 ms (~24.8 days); past that it fires at once, which for a wait
        // is the opposite of what was asked.
        timer = setTimeout(() => settle(false), Math.min(timeout, 2_147_483_647));
        timer.unref?.();
      }
      this.pending.set(requestId, { request, settle });
      this.options.onWaiting?.(request);
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted === true) onAbort();
    });
  }

  /** The watcher settled this task's request: hand the settlement to whatever guard is waiting on it. */
  deliver(taskId: string, key: string, settlement: JsonValue, pushedHead?: string): boolean {
    this.heard.set(JSON.stringify([taskId, key]), { head: pushedHead, settlement });
    let delivered = false;
    for (const pending of [...this.pending.values()]) {
      if (pending.request.taskId === taskId && pending.request.key === key) delivered = pending.settle(settlement) || delivered;
    }
    return delivered;
  }

  /** Withdraw every wait — a closing window, a cancelled run. The rows stop being awaited. */
  declineAll(): void {
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.settle(false);
  }
}
