/**
 * `on_remote_event` (decision 0004 §2): a transition that waits on the forge.
 *
 * Through the REAL engine, because what is being claimed is that it behaves as `on_user_event`'s
 * sibling does — a deferred call in a guard, parked, answered from outside the run, with a timeout
 * that answers `false` and a cancel that withdraws it.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/exec";
import { buildPromptExecutor, executeWorkflow, newRegistry, statusOfResult } from "../src/wiring";
import { hostCalleeSignatures } from "../src/userEvents";
import { ON_REMOTE_EVENT, RemoteEventHub, type RemoteEventRequest } from "../src/remoteEvents";
import { MemoryHandles } from "./remoteRig";

const HOST_FUNCTIONS = hostCalleeSignatures();

const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

const files = (guard: string) => ({
  "publish.json": {
    operation: { kind: "function", function: "start" },
    children: { merged: { state: "merged" }, revise: { state: "revise" } },
    transitions: [
      { to: "merged", when: `.run.cursor !== 'merged' && .run.cursor !== 'revise' && .operation.outcome === 'success' && ${guard}.decision === 'approve'` },
      { to: "revise", when: `.run.cursor !== 'merged' && .run.cursor !== 'revise' && .operation.outcome === 'success' && ${guard}` },
      { to: "terminate.success" },
    ],
  },
  "merged.json": { operation: { kind: "function", function: "mark_merged" } },
  "revise.json": { operation: { kind: "function", function: "mark_revise" } },
});

function harness(guard = "on_remote_event('merge_request', { settle_after: '5m' })", opened = true) {
  const waiting: RemoteEventRequest[] = [];
  const resolved: string[] = [];
  const handles = new MemoryHandles();
  handles.ensure({ taskId: "task-7", key: "review", provider: "gitlab", host: "gitlab.com", project: "team/app", remote: "origin", branch: "jaira/task-7/review", target: "main" });
  if (opened) handles.update("task-7", "review", { number: 41, url: "https://gitlab.com/team/app/-/merge_requests/41", pushedHead: "abc" });
  const registry = newRegistry();
  const entered: string[] = [];
  const host = (name: string) => ({ kind: "host", impl: async () => (entered.push(name), { value: {} as never }), capabilities: { interactive: false, readOnly: true, memoizable: false } }) as never;
  registry.functions.set("start", host("publish"));
  registry.functions.set("mark_merged", host("merged"));
  registry.functions.set("mark_revise", host("revise"));
  const hub = new RemoteEventHub({ onWaiting: (r) => waiting.push(r), onResolved: (id) => resolved.push(id) });
  hub.register(registry, "task-7", handles);
  const run = executeWorkflow({
    bundle: loadBundle(files(guard) as never, "publish", { functions: HOST_FUNCTIONS }),
    inputs: {},
    registry,
    prompt: buildPromptExecutor({ fakeRules: [] }),
  });
  return { hub, handles, waiting, resolved, run, entered };
}

describe("on_remote_event", () => {
  it("resolves by name from a guard, like its sibling", () => {
    expect(HOST_FUNCTIONS.has(ON_REMOTE_EVENT)).toBe(true);
  });

  it("parks the state, marks the request AWAITED — which is all the poller needs — and carries settle_after onto the row", async () => {
    const { hub, handles, waiting } = harness();
    await settled();
    expect(waiting).toMatchObject([{ taskId: "task-7", key: "review" }]);
    expect(hub.list()).toHaveLength(1);
    expect(handles.get("task-7", "review")).toMatchObject({ awaiting: true, settleAfterMs: 300_000 });
    expect(handles.awaiting()).toHaveLength(1);
    hub.declineAll();
  });

  it("resolves with the settlement, which a guard reads like any value", async () => {
    const { hub, run, entered } = harness();
    await settled();
    const settlement = { decision: "approve", decisions: [], settled_by: { via: "remote", who: "mara", act: "merged" }, remote: { number: 41 } } as unknown as JsonValue;
    expect(hub.deliver("task-7", "review", settlement)).toBe(true);
    expect(statusOfResult(await run)).toBe("completed");
    expect(entered).toContain("merged");
    expect(entered).not.toContain("revise");
  });

  it("takes the other rule for another decision — the same wait, read twice, asked once", async () => {
    const { hub, run, entered, waiting } = harness();
    await settled();
    // Delivered with the head it was settled AT, as the service does: the first rule reads it and
    // says no, and the second — a separate call to the engine — hears the same answer rather than
    // parking a wait for an event that has already happened.
    hub.deliver("task-7", "review", { decision: "revise", decisions: [], settled_by: { via: "remote", act: "quiet" } } as unknown as JsonValue, "abc");
    expect(statusOfResult(await run)).toBe("completed");
    expect(entered).toContain("revise");
    expect(waiting).toHaveLength(1);
  });

  it("answers false when its timeout runs out, stops being awaited, and the rules behind it get their turn", async () => {
    const { handles, run, entered } = harness("on_remote_event('merge_request', { timeout: 0.05 })");
    expect(statusOfResult(await run)).toBe("completed");
    expect(entered).toEqual(["publish"]);
    expect(handles.get("task-7", "review")!.awaiting).toBe(false);
  });

  it("answers false at once when no request was ever opened — there is nothing to hear from", async () => {
    const { run, waiting } = harness(undefined, false);
    expect(statusOfResult(await run)).toBe("completed");
    expect(waiting).toEqual([]);
  });

  it("answers false when nobody is watching, rather than parking on a forge nobody reads", async () => {
    const registry = newRegistry();
    registry.functions.set("start", { kind: "host", impl: async () => ({ value: {} as never }), capabilities: { interactive: false, readOnly: true, memoizable: true } } as never);
    new RemoteEventHub().register(registry, "task-7", new MemoryHandles());
    const run = executeWorkflow({ bundle: loadBundle(files("on_remote_event('merge_request')") as never, "publish", { functions: HOST_FUNCTIONS }), inputs: {}, registry, prompt: buildPromptExecutor({ fakeRules: [] }) });
    expect(statusOfResult(await run)).toBe("completed");
  });

  it("is withdrawn when the process stops listening, and the row stops being polled", async () => {
    const { hub, handles, resolved, waiting, run } = harness();
    await settled();
    hub.declineAll();
    expect(hub.list()).toEqual([]);
    expect(resolved).toEqual([waiting[0]!.requestId]);
    expect(handles.awaiting()).toEqual([]);
    expect(hub.deliver("task-7", "review", {} as JsonValue)).toBe(false);
    await run;
  });
});
