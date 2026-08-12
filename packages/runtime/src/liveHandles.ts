/**
 * The calls that are running right now, so a person can talk to one.
 *
 * `ExecHandle.control` is how a running call is steered — `send` a message into the turn it is
 * already taking, `interrupt` it, change its model or permission mode mid-flight. The catch is that
 * the handle lives wherever `start` was called, which for a workflow is inside hw, and the app has no
 * reference to it. This is the register that gives it one.
 *
 * ## Keyed by session, because that is the name both ends know
 *
 * The interception point sees `ctx.session`, and nothing else on the services bundle identifies which
 * state is calling. That turns out to be the right key anyway: the app learns the same id from the delta
 * stream while the call is still running (`withTurnStream` reports `delta.session.id`), so the two
 * ends agree on a name without either being told about the other. Keying on an instance id would have
 * needed a seam through hw that does not exist.
 *
 * ## Absent control is the normal case
 *
 * Most transports cannot be steered at all — `sessionSteering` is declared, not discovered, and codex
 * is the honest example: SIGINT ends the process rather than the turn. So a registered call very
 * often has no `control`, and a caller has to check rather than assume. That is why {@link LiveCalls}
 * hands back the handle rather than a `send` function: "there is a call but you cannot talk to it" and
 * "there is no call" are different answers, and a UI needs to tell them apart.
 */
import type { ExecControl, ExecHandle, ExecServices, ResolvedValue } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";

/** One call in flight, as a caller outside the engine sees it. */
export interface LiveCall {
  sessionId: string;
  /** Absent when the transport underneath declares no `sessionSteering` — see the module header. */
  control?: ExecControl;
  /**
   * Resolves when this call settles, however it settles.
   *
   * Never rejects. Somebody waiting for the position to stop moving does not care whether the turn
   * succeeded — they care that the conversation has a stable head again — and rejecting here would
   * turn "the run failed" into "your message could not be sent".
   */
  settled: Promise<void>;
}

/**
 * The calls currently running, by session id.
 *
 * Deliberately not a Map exposed directly: entries are removed when a call settles, and a caller
 * holding one across an await would otherwise be steering something that finished.
 */
export class LiveCalls {
  private readonly calls = new Map<string, LiveCall>();

  /** What is running in this conversation, if anything still is. */
  get(sessionId: string): LiveCall | undefined {
    return this.calls.get(sessionId);
  }

  /**
   * True when there is a call here AND a message can actually be added to it.
   *
   * Every method on ExecControl is INDIVIDUALLY optional, so a transport offering interrupt but not
   * send is representable and real. Checking for the control object alone would offer a Send button
   * that reaches a method which is not there.
   */
  canSend(sessionId: string): boolean {
    return this.calls.get(sessionId)?.control?.send !== undefined;
  }

  /**
   * Wait for the call here to finish, if one is running. True iff it did.
   *
   * This is the whole of the queueing behaviour for a transport that cannot take a mid-turn message.
   * There is nothing to store and nothing to flush — the promise already exists, and waiting on it is
   * the queue.
   *
   * ⚠️ The caller MUST re-read the position when this returns TRUE. The head has moved, which is
   * precisely why it waited; sending the position computed beforehand would fork every time and
   * defeat the wait.
   *
   * `timeoutMs` is not optional in spirit. The promise being waited on is the CALL's, so an unbounded
   * wait inherits whatever the call is parked on — a provider that stops answering takes the waiter
   * with it, and a waiter that is an IPC handler takes the request with it: no reply, no error,
   * nothing to cancel. Past the bound this returns `false` and the caller appends beside the running
   * call instead, which `withSessionPosition` resolves by forking. A branch is a worse answer than a
   * continuation and a far better one than a request that never returns.
   *
   * It does not promise the position is still free when it returns either: another call in the same
   * session can claim it a moment later. That race is real and rare, and `withSessionPosition` answers
   * it correctly by forking, so this removes the common case rather than pretending to remove all.
   */
  async settle(sessionId: string, timeoutMs?: number): Promise<boolean> {
    const settled = this.calls.get(sessionId)?.settled;
    if (settled === undefined) return true; // nothing running: the caller is already free to go
    if (timeoutMs === undefined) {
      await settled;
      return true;
    }
    // The timer is CLEARED on the winning path, so a short wait behind a long call does not hold a
    // handle open until the bound elapses — Node keeps a pending timer alive and the process with it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([settled.then(() => true), expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Every session with a call in flight — for a UI asking "is anything running". */
  sessions(): string[] {
    return [...this.calls.keys()];
  }

  /** @internal — {@link register} owns the lifetime. */
  add(call: LiveCall): void {
    this.calls.set(call.sessionId, call);
  }

  /**
   * Drop this call's entry — and ONLY if it is still this call's.
   *
   * The identity check is what makes the register safe when two calls share a session id, which
   * states sharing one conversation stream do. The second `add` replaces the first, and the first
   * then settles: an unconditional delete removes the LIVE call's entry, so `canSend` starts saying
   * no about something that is running and `settle` returns immediately on a turn still in flight.
   *
   * @internal
   */
  remove(sessionId: string, call?: LiveCall): void {
    if (call !== undefined && this.calls.get(sessionId) !== call) return;
    this.calls.delete(sessionId);
  }
}

/**
 * Register one call while it runs, and hand back a handle that deregisters it.
 *
 * A plain function rather than an executor wrapper, because there is already a wrapper at exactly
 * this point doing exactly this interception — `withTurnStream` reads the same `ctx.session` off the
 * same call to publish its deltas. A second wrapper would have been a second copy of that machinery
 * for the other half of one job.
 *
 * It relies on being called from INSIDE the session layers, which is what makes the key right rather
 * than merely present: `withSessionPosition` passes down the position the call actually ran under, so
 * a call that had to FORK registers under the branch it ended up on and not the one it asked for.
 *
 * A call with no session is returned untouched. Those are the embedded computations hw runs inside a
 * binding, explicitly "not a turn in the enclosing state's conversation" — nobody can address one, so
 * nobody can steer one.
 */
export function register(
  live: LiveCalls,
  ctx: ExecServices,
  handle: ExecHandle<ResolvedValue, WorkflowMetrics>,
): ExecHandle<ResolvedValue, WorkflowMetrics> {
  const sessionId = ctx.session?.id;
  if (sessionId === undefined) return handle;

  // Assigned synchronously below, and only ever READ from a `handle.result` continuation — which is a
  // microtask at the earliest, so it cannot observe the hole. `remove` needs the entry itself to
  // check that the register still holds THIS call before deleting it (see `LiveCalls.remove`).
  let entry: LiveCall | undefined;
  // Removed on SETTLE rather than on success: a failed or cancelled call is equally finished, and an
  // entry left behind would offer a Send button that reaches a handle nothing is listening to.
  const result = handle.result.then(
    (r) => {
      live.remove(sessionId, entry);
      return r;
    },
    (e: unknown) => {
      live.remove(sessionId, entry);
      throw e;
    },
  );
  // Swallowed, deliberately — see `LiveCall.settled`. Derived from `result` rather than from
  // `handle.result` so a waiter cannot observe the entry still present after it resolves.
  const settled = result.then(
    () => {},
    () => {},
  );
  // A GETTER, not a snapshot. `wrapHandle` exposes `control` as a live accessor on purpose — "a
  // retry replaces the attempt underneath, and a caller holding this handle must end up steering the
  // one that is actually running rather than a dead one" — and object spread invokes a getter and
  // stores the result as a plain data property, undoing exactly that.
  //
  // Both failure modes are on the default path. `withRetry` is always composed (two repair turns), so
  // after one retry a snapshot points at a dead attempt while `canSend` still says yes. And this runs
  // synchronously inside `start`, before any wrapper that awaits before `ctl.started` — the memo and
  // rate-limit layers both do — so the snapshot is frequently `undefined` forever, which is
  // indistinguishable from a transport that simply cannot steer.
  entry = {
    sessionId,
    settled,
    get control(): ExecControl | undefined {
      return handle.control;
    },
  };
  live.add(entry);
  return {
    ...handle,
    result,
    get control(): ExecControl | undefined {
      return handle.control;
    },
  };
}
