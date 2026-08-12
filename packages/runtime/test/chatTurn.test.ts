/**
 * One typed message, run and journalled.
 *
 * What these pin is the JOURNAL, because that is the whole interface between a chat turn and the rest
 * of the product: the panel, the board and the task's status are all projections of these events, and
 * a turn that ran perfectly but emitted the wrong shape is a turn nobody can see. So the assertions
 * are mostly "what did the projection get", and the projection itself is run on the output rather
 * than reasoned about — a test that hand-checks event names would pass while the tree came out wrong.
 */
import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";

import { projectRun } from "@jaira/persistence";
import { ScriptedFakeExecutor } from "../src/fakeExecutor";
import { sessionServicesFor } from "../src/summary";
import { withSessionLayers } from "../src/wiring";
import { chatOperationOf, chatPlanFor } from "../src/chatOperation";
import { CHAT_INSTANCE_BASE, isChatInstance, runChatTurn, type ChatInstance } from "../src/chatTurn";

/** The host state, already merged — the shape a snapshot pins. */
const host = {
  id: "plan/draft",
  operation: { kind: "prompt", user: "draft", config: { model: "m" }, input: {}, output: { name: "text", kind: "text" } },
} as never;

/** A journal that remembers, so a test can project it exactly as the app does. */
function journal() {
  const events: EngineEvent[] = [];
  const atMs: number[] = [];
  let clock = 1_000;
  return {
    events,
    atMs,
    record: (event: EngineEvent, at: number) => {
      events.push(event);
      atMs.push(at);
    },
    now: () => (clock += 10),
  };
}

/** Only the chat child's own events — the harness seeds the parent instance the child hangs off. */
const chatEvents = (log: ReturnType<typeof journal>): EngineEvent[] =>
  log.events.filter((e) => isChatInstance(e.instanceId));

const instance = (patch: Partial<ChatInstance> = {}): ChatInstance => ({
  instanceId: CHAT_INSTANCE_BASE,
  parentInstanceId: 2,
  stateId: "plan/draft",
  childKey: "ask",
  iteration: 0,
  ...patch,
});

/** Send one message, against a store that carries across calls so positions really move. */
async function send(
  ports: ReturnType<typeof harness>,
  args: { message: string; position: string; instance?: Partial<ChatInstance> },
) {
  const plan = chatPlanFor([host]);
  const { operation } = chatOperationOf(plan, { message: args.message, session: { id: args.position } });
  return runChatTurn(
    { executor: ports.executor, sessions: ports.stores.sessions, record: ports.log.record, now: ports.log.now },
    { instance: instance(args.instance), operation, position: args.position },
  );
}

/**
 * The real wiring, not a stand-in.
 *
 * The executor goes under `withSessionLayers` because that is what `ChatTurnPorts.executor` demands,
 * and the demand is not decorative: an unlayered executor runs the model and stamps no
 * `metrics.sessionRef`, so the turn happens and nothing can find the transcript it happened in. The
 * first draft of this harness passed a bare fake and the position test caught it, which is the reason
 * it is written this way rather than mocked.
 *
 * `sessionServicesFor` supplies the pair, so the store the layers write through is the same one the
 * turn resolves against — pairing a decorated session store with someone else's records would claim
 * positions in a conversation nobody can read.
 */
function harness(rules: Array<{ value?: string; error?: string }> = [{ value: "because the offset drifted" }]) {
  const log = journal();
  const stores = sessionServicesFor({ states: {} } as never, async () => "");
  const executor = withSessionLayers(stores, new ScriptedFakeExecutor(rules as never));
  // The instance being read. Without it the chat child has no parent in the journal and projects as
  // a root, which would quietly make every `.children` assertion below vacuous.
  log.record({ type: "instance.entered", instanceId: 2, stateId: "plan/draft", inputs: {} }, 900);
  return { log, stores, executor };
}

describe("what the journal says about one message", () => {
  it("enters the instance, runs the op, and ends the turn", async () => {
    const h = harness();
    const result = await send(h, { message: "why did that fail?", position: "s@3" });
    expect(result.failure).toBeUndefined();
    expect(chatEvents(h.log).map((e) => e.type)).toEqual([
      "instance.entered",
      "operation.started",
      "operation.completed",
      "instance.terminated",
    ]);
  });

  it("hangs off the instance being read, under the reserved key", async () => {
    const h = harness();
    await send(h, { message: "hi", position: "s@1" });
    expect(chatEvents(h.log)[0]).toMatchObject({
      type: "instance.entered",
      parentInstanceId: 2,
      childKey: "ask",
      stateId: "plan/draft",
    });
  });

  it("records no inputs — the message is the prompt, and it is already in the transcript", async () => {
    const h = harness();
    await send(h, { message: "hi", position: "s@1" });
    expect(chatEvents(h.log)[0]).toMatchObject({ inputs: {} });
  });

  it("projects as a completed child, so an idle conversation does not read as work in flight", async () => {
    const h = harness();
    await send(h, { message: "hi", position: "s@1" });
    // Projected, not asserted event-by-event: the tree is the thing the panel and the board read.
    const tree = projectRun(h.log.events, {}, h.log.atMs);
    const chat = tree.instances.flatMap((r) => r.children).find((c) => isChatInstance(c.instanceId));
    expect(chat).toBeDefined();
    expect(chat!.status).toBe("completed");
    expect(chat!.superseded).toBe(false);
  });
});

describe("the loop is one instance", () => {
  it("takes a transition per message instead of re-entering, so nothing is superseded", async () => {
    const h = harness();
    await send(h, { message: "first", position: "s@1" });
    await send(h, { message: "second", position: "s@2", instance: { iteration: 1 } });
    await send(h, { message: "third", position: "s@3", instance: { iteration: 2 } });

    // One entry, three turns. A second `instance.entered` under this key would mark the first
    // superseded and the panel filters those out — every message but the last would vanish.
    expect(chatEvents(h.log).filter((e) => e.type === "instance.entered")).toHaveLength(1);
    expect(chatEvents(h.log).filter((e) => e.type === "transition.taken")).toHaveLength(2);
    expect(chatEvents(h.log).filter((e) => e.type === "operation.completed")).toHaveLength(3);
  });

  it("counts the exchanges, and stays one node in the tree", async () => {
    const h = harness();
    await send(h, { message: "first", position: "s@1" });
    await send(h, { message: "second", position: "s@2", instance: { iteration: 1 } });

    const tree = projectRun(h.log.events, {}, h.log.atMs);
    const chats = tree.instances.flatMap((r) => r.children).filter((c) => isChatInstance(c.instanceId));
    expect(chats).toHaveLength(1);
    expect(chats[0]!.iteration).toBe(1);
    expect(chats[0]!.status).toBe("completed");
  });
});

describe("the position it ends at", () => {
  it("reports where the conversation now is, so the next message can continue it", async () => {
    const h = harness();
    const first = await send(h, { message: "hi", position: "s@0" });
    // The join between a turn and its transcript. Without it the reply is recorded somewhere nothing
    // can find its way back to.
    expect(first.sessionRef).toBeDefined();
    const second = await send(h, { message: "again", position: first.sessionRef!, instance: { iteration: 1 } });
    expect(second.sessionRef).not.toBe(first.sessionRef);
  });
});

describe("a turn that failed", () => {
  it("is a turn of the conversation, not an exception", async () => {
    // A refusal has to reach the journal, or the panel shows a message that was sent and no reason it
    // went nowhere.
    const h = harness([{ error: "model refused" }]);
    const result = await send(h, { message: "do the thing", position: "s@1" });
    expect(result.failure).toContain("model refused");
    expect(chatEvents(h.log).map((e) => e.type)).toEqual([
      "instance.entered",
      "operation.started",
      "operation.failed",
      "instance.terminated",
    ]);
    const tree = projectRun(h.log.events, {}, h.log.atMs);
    const chat = tree.instances.flatMap((r) => r.children).find((c) => isChatInstance(c.instanceId));
    expect(chat!.status).toBe("failed");
  });
});

describe("the id space", () => {
  it("is disjoint from the engine's, which allocates from a counter it owns", async () => {
    // A conversation can be continued while the engine is still running, so `max(id) + 1` off the
    // journal would race a counter this process cannot see.
    expect(isChatInstance(CHAT_INSTANCE_BASE)).toBe(true);
    expect(isChatInstance(1)).toBe(false);
    expect(isChatInstance(-1)).toBe(false);
  });
});

describe("what a chat turn hands the executor", () => {
  /**
   * The four seams a DELEGATED agent needs, and why `tools` alone is not enough.
   *
   * JaiRA's own tools arrive already wrapped by `gateTools`, so the four permission modes are honoured
   * for those whatever the route is. An agent route is the other half of the surface: `claude-cli` and
   * the API agent bring their OWN Bash, Read and Write, and they are gated by neither `gateTools` nor
   * the modes — they are gated by the two services below, which the adapter reads directly.
   *
   *  - `approve` — an adapter declaring `policyEnforcement: "callback"` builds its native permission
   *    callback ONLY when this is present (`agentExecutor`: `const approve = ctx.approve`, and the
   *    callback is `approve && wantsApprovalCallback ? … : undefined`). Absent, there is no callback,
   *    and the agent's own tools run with nothing asked of anybody.
   *  - `policy` — the same adapter's deny floor is `ctx.policy.baseline.tools`, the set it filters out
   *    before offering anything. Absent, nothing is ever withheld.
   *
   * A test that only checked `tools` passed throughout the window in which both were missing, which is
   * why this asserts the whole bundle rather than the part that was easy to remember.
   */
  it("passes the services through verbatim, so a delegated agent finds its gates", async () => {
    const ports = harness();
    const seen: Record<string, unknown>[] = [];
    const spy = {
      ...ports.executor,
      start: (op: never, ctx: Record<string, unknown>) => {
        seen.push(ctx);
        return ports.executor.start(op, ctx as never);
      },
    } as typeof ports.executor;

    const approve = () => ({ decision: "allow" as const, scope: "once" as const });
    const policy = { baseline: { tools: { bash: "deny" as const } } };
    const plan = chatPlanFor([host]);
    const { operation } = chatOperationOf(plan, { message: "hi", session: { id: "s@0" } });
    await runChatTurn(
      {
        executor: spy,
        sessions: ports.stores.sessions,
        record: ports.log.record,
        now: ports.log.now,
        services: { tools: {}, approve, policy } as never,
      },
      { instance: instance(), operation, position: "s@0" },
    );

    expect(seen).toHaveLength(1);
    // The session is added by the turn; everything else must survive untouched.
    expect(seen[0]!.approve).toBe(approve);
    expect(seen[0]!.policy).toBe(policy);
    expect(seen[0]!.tools).toEqual({});
    expect(seen[0]!.session).toBeDefined();
  });
});
