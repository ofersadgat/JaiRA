/**
 * Reaching a call that is still running.
 *
 * Driven through `withTurnStream`, which is the wrapper the app actually composes — registering is
 * the other half of the job it already does, so testing `register` in isolation would be testing a
 * path nothing takes.
 *
 * The thing under test is a lifetime, not a computation: an entry has to appear while the call runs
 * and be gone the moment it settles, however it settles. A stale entry is worse than a missing one —
 * it offers a Send button that reaches a handle nothing is listening to.
 */
import { describe, expect, it } from "vitest";
import type { ExecHandle, ExecServices, Executor, InlineFamily, Operation, ResolvedValue } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { LiveCalls } from "../src/liveHandles";
import { withTurnStream } from "../src/wiring";

const METRICS = { startMs: 0, durationMs: 1, costUsd: 0 } as unknown as WorkflowMetrics;

/** An executor whose one call is settled by the test, with or without a `control`. */
function pending(options: { steerable: boolean }) {
  let settle!: (r: { value: ResolvedValue; metrics: WorkflowMetrics }) => void;
  let reject!: (e: unknown) => void;
  const sent: string[] = [];
  const executor: Executor<ExecServices, WorkflowMetrics> = {
    capabilities: {} as never,
    metrics: { merge: (a: WorkflowMetrics) => a, empty: () => METRICS } as never,
    start(_op: Operation<InlineFamily>, _ctx: ExecServices): ExecHandle<ResolvedValue, WorkflowMetrics> {
      return {
        events: (async function* () {})(),
        result: new Promise((res, rej) => {
          settle = res as never;
          reject = rej;
        }),
        cancel: async () => {},
        ...(options.steerable
          ? {
              control: {
                send: async (text: string) => void sent.push(text),
                interrupt: async () => {},
                setPermissionMode: async () => {},
                setModel: async () => {},
              },
            }
          : {}),
      } as ExecHandle<ResolvedValue, WorkflowMetrics>;
    },
  };
  return { executor, settle: () => settle({ value: "done" as never, metrics: METRICS }), fail: () => reject(new Error("boom")), sent };
}

const ctxWith = (id: string | undefined): ExecServices =>
  (id === undefined ? {} : { session: { id } }) as ExecServices;

const op = { kind: "prompt", user: "hi", config: {}, input: {}, output: { name: "text", kind: "text" } } as Operation<InlineFamily>;

describe("a call in flight", () => {
  it("is reachable by the session id both ends already know", async () => {
    const live = new LiveCalls();
    const inner = pending({ steerable: true });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith("s@4"));

    expect(live.sessions()).toEqual(["s@4"]);
    expect(live.canSend("s@4")).toBe(true);
    await live.get("s@4")!.control!.send!("are you nearly done?");
    expect(inner.sent).toEqual(["are you nearly done?"]);

    inner.settle();
    await handle.result;
    expect(live.sessions()).toEqual([]);
  });

  it("is registered without control when the transport cannot be steered", async () => {
    // The common case, and the reason a caller gets the handle rather than a `send` function: "there
    // is a call but you cannot talk to it" and "there is no call" are different answers.
    const live = new LiveCalls();
    const inner = pending({ steerable: false });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith("s@1"));

    expect(live.get("s@1")).toBeDefined();
    expect(live.canSend("s@1")).toBe(false);

    inner.settle();
    await handle.result;
    expect(live.get("s@1")).toBeUndefined();
  });

  it("is forgotten when it fails, not only when it succeeds", async () => {
    const live = new LiveCalls();
    const inner = pending({ steerable: true });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith("s@9"));
    expect(live.sessions()).toEqual(["s@9"]);

    inner.fail();
    await expect(handle.result).rejects.toThrow("boom");
    expect(live.sessions()).toEqual([]);
  });
});

describe("a call with no conversation", () => {
  it("is passed through unregistered — nobody can address it, so nobody can steer it", async () => {
    // hw's embedded callee: "a COMPUTATION embedded in a binding, not a turn in the enclosing state's
    // conversation". It has no position and therefore no name to register under.
    const live = new LiveCalls();
    const inner = pending({ steerable: true });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith(undefined));
    expect(live.sessions()).toEqual([]);
    inner.settle();
    await handle.result;
  });
});

describe("waiting for a call that cannot be steered", () => {
  it("is just the handle's own promise — there is no queue to store or flush", async () => {
    const live = new LiveCalls();
    const inner = pending({ steerable: false });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith("s@2"));

    let waited = false;
    const waiting = live.settle("s@2").then(() => (waited = true));
    // Still running: a waiter must not be released early, or it would send against a position the
    // call is about to claim.
    await Promise.resolve();
    expect(waited).toBe(false);

    inner.settle();
    await handle.result;
    await waiting;
    expect(waited).toBe(true);
  });

  it("releases the waiter when the call FAILED, rather than leaving it hanging", async () => {
    // `settled` never rejects: "the run failed" must not become "your message could not be sent".
    // It reports TRUE either way — the question is whether the head stopped moving, not whether the
    // turn went well.
    const live = new LiveCalls();
    const inner = pending({ steerable: false });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith("s@7"));
    const waiting = live.settle("s@7");

    inner.fail();
    await expect(handle.result).rejects.toThrow("boom");
    await expect(waiting).resolves.toBe(true);
  });

  it("sees the entry already gone once the wait resolves", async () => {
    // Otherwise a caller that re-reads immediately would find a call that has finished and wait again.
    const live = new LiveCalls();
    const inner = pending({ steerable: false });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith("s@3"));
    const waiting = live.settle("s@3").then(() => live.get("s@3"));

    inner.settle();
    await handle.result;
    expect(await waiting).toBeUndefined();
  });

  it("returns at once when nothing is running there", async () => {
    // TRUE, not false: the caller asked whether it is free to send, and it is.
    await expect(new LiveCalls().settle("nobody@0")).resolves.toBe(true);
    await expect(new LiveCalls().settle("nobody@0", 50)).resolves.toBe(true);
  });

  it("GIVES UP at the bound rather than inheriting whatever the call is parked on", async () => {
    // The waiter is on the CALL's promise, so an unbounded wait behind a provider that stopped
    // answering hangs the caller — which in the app is an IPC handler, and the composer then sits on
    // `busy` with no reply, no error and nothing to cancel. `false` says the head did NOT settle, so
    // the caller appends beside the running call and lets `withSessionPosition` fork.
    const live = new LiveCalls();
    const inner = pending({ steerable: false });
    const handle = withTurnStream(() => {}, inner.executor, live).start(op, ctxWith("s@5"));

    expect(await live.settle("s@5", 10)).toBe(false);
    // And the call really is still running — the bound expired, it did not finish.
    expect(live.get("s@5")).toBeDefined();

    inner.settle();
    await handle.result;
    expect(await live.settle("s@5", 10)).toBe(true);
  });
});

describe("two calls sharing one session id", () => {
  it("lets the FIRST to finish forget only its own entry", async () => {
    // Two states can share a conversation stream, so the register can hold a replacement for a key.
    // An unconditional delete on settle removes the LIVE call's entry: `canSend` starts saying no
    // about something that is running, and a waiter is released against a turn still in flight.
    const live = new LiveCalls();
    const first = pending({ steerable: false });
    const second = pending({ steerable: true });
    const h1 = withTurnStream(() => {}, first.executor, live).start(op, ctxWith("shared@1"));
    const h2 = withTurnStream(() => {}, second.executor, live).start(op, ctxWith("shared@1"));

    // The second replaced the first, which is what a register keyed by session means.
    expect(live.canSend("shared@1")).toBe(true);

    first.settle();
    await h1.result;
    // Still the second's, and still steerable. This is the assertion that failed before.
    expect(live.get("shared@1")).toBeDefined();
    expect(live.canSend("shared@1")).toBe(true);

    second.settle();
    await h2.result;
    expect(live.sessions()).toEqual([]);
  });
});
