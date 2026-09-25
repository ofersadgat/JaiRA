/**
 * `on_event` and the event hub (decision 0010 §3).
 *
 * Through the REAL engine where the claim is about a guard — it parks, an event from outside the run
 * answers it, the rule reads what it resolved to — and against the hub itself for the queue: per
 * task, from the first wait, oldest match first, never answered for being unattended, and kept across
 * a restart for a task that resumes.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import type { EventName, EventWaitPort, JairaEvent } from "@jaira/shared";
import { buildPromptExecutor, executeWorkflow, newRegistry, statusOfResult } from "../src/wiring";
import { hostCalleeSignatures } from "../src/userEvents";
import { checkEventWait, EVENT_CAPABILITIES, EventHub, ON_EVENT, RECENT_MS, registerUnservedEvents } from "../src/eventHub";

const HOST_FUNCTIONS = hostCalleeSignatures();

const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

const base = { remote: "origin", connection: "github", host: "github.com", repository: "acme/app" };
const push = (branch: string, after = "b"): JairaEvent => ({ name: "git.push", payload: { ...base, branch, before: "a", after, commits: [] } });
const finished = (taskId: string): JairaEvent => ({ name: "task.finished", payload: { task_id: taskId, title: "t", workflow: "w", status: "completed" } });

class MemoryWaits implements EventWaitPort {
  readonly rows = new Map<string, number>();
  since(taskId: string, name: EventName): number | undefined {
    return this.rows.get(`${taskId} ${name}`);
  }
  open(taskId: string, name: EventName, since: number): void {
    if (!this.rows.has(`${taskId} ${name}`)) this.rows.set(`${taskId} ${name}`, since);
  }
  closeTask(taskId: string): void {
    for (const key of [...this.rows.keys()]) if (key.startsWith(`${taskId} `)) this.rows.delete(key);
  }
}

function harness(guard: string, hub = new EventHub()) {
  const files = {
    "watch.json": {
      operation: { kind: "function", function: "start" },
      children: { deploy: { state: "deploy" } },
      transitions: [
        { to: "deploy", when: `.run.cursor !== 'deploy' && .operation.outcome === 'success' && ${guard}` },
        { to: "terminate.success", when: ".run.cursor === 'deploy'" },
      ],
    },
    "deploy.json": { operation: { kind: "function", function: "deploy" } },
  };
  const registry = newRegistry();
  const entered: string[] = [];
  const host = (name: string) => ({ kind: "host", impl: async () => (entered.push(name), { value: {} as never }), capabilities: { interactive: false, readOnly: true, memoizable: false } }) as never;
  registry.functions.set("start", host("watch"));
  registry.functions.set("deploy", host("deploy"));
  hub.register(registry, "task-7");
  const abort = new AbortController();
  const run = executeWorkflow({
    bundle: loadBundle(files as never, "watch", { functions: HOST_FUNCTIONS }),
    inputs: {},
    registry,
    prompt: buildPromptExecutor({ fakeRules: [] }),
    abortSignal: abort.signal,
  } as never);
  return { hub, run, entered, abort };
}

describe("on_event", () => {
  it("resolves by name from a guard, as a listening wait", () => {
    expect(HOST_FUNCTIONS.has(ON_EVENT)).toBe(true);
    expect(EVENT_CAPABILITIES).toMatchObject({ deferred: true, listens: true, memoizable: false });
  });

  it("parks the rule until a matching event arrives, and the rule reads what it resolved to", async () => {
    const { hub, run, entered } = harness("on_event('git.push', { branch: 'main' }).payload.after === 'abc'");
    await settled();
    expect(hub.list()).toMatchObject([{ taskId: "task-7", waiter: "guard", name: "git.push", filter: { branch: "main" } }]);
    // Another branch: not this rule's. It waits on.
    hub.deliver(push("release/2.0", "abc"));
    await settled();
    expect(entered).toEqual(["watch"]);
    hub.deliver(push("main", "abc"));
    expect(statusOfResult(await run)).toBe("completed");
    expect(entered).toEqual(["watch", "deploy"]);
    expect(hub.list()).toEqual([]);
  });

  it("is NOT answered for being unattended — a hub with nobody listening parks all the same, and closing it answers nothing", async () => {
    const { hub, run, entered, abort } = harness("on_event('task.finished')");
    await settled();
    expect(hub.list()).toHaveLength(1);
    hub.close();
    await settled();
    expect(entered).toEqual(["watch"]);
    expect(hub.list()).toHaveLength(1);
    // Only stopping the run withdraws it.
    abort.abort();
    expect(statusOfResult(await run)).toBe("canceled");
    expect(hub.list()).toEqual([]);
  });

  it("refuses an event that is not one, and a filter key the event does not take — the run fails saying so", async () => {
    const unknown = harness("on_event('git.pull')");
    const result = await unknown.run;
    expect(statusOfResult(result)).toBe("failed");
    expect(JSON.stringify(result)).toContain(`on_event: \\"git.pull\\" is not an event`);
    const key = harness("on_event('task.failed', { branch: 'main' })");
    const keyed = await key.run;
    expect(statusOfResult(keyed)).toBe("failed");
    expect(JSON.stringify(keyed)).toContain("task.failed takes no filter, and was given 'branch'");
  });
});

describe("where nothing watches", () => {
  it("on_event resolves, and a run that reaches it fails saying why — never answered false", async () => {
    const registry = newRegistry();
    registry.functions.set("start", { kind: "host", impl: async () => ({ value: {} }), capabilities: { interactive: false, readOnly: true, memoizable: false } } as never);
    registry.functions.set("deploy", { kind: "host", impl: async () => ({ value: {} }), capabilities: { interactive: false, readOnly: true, memoizable: false } } as never);
    registerUnservedEvents(registry, "by the CLI");
    const files = {
      "watch.json": {
        operation: { kind: "function", function: "start" },
        children: { deploy: { state: "deploy" } },
        transitions: [{ to: "deploy", when: ".run.cursor !== 'deploy' && on_event('git.push')" }, { to: "terminate.success", when: ".run.cursor === 'deploy'" }],
      },
      "deploy.json": { operation: { kind: "function", function: "deploy" } },
    };
    const result = await executeWorkflow({ bundle: loadBundle(files as never, "watch", { functions: HOST_FUNCTIONS }), inputs: {}, registry, prompt: buildPromptExecutor({ fakeRules: [] }) });
    expect(statusOfResult(result)).toBe("failed");
    expect(JSON.stringify(result)).toContain("on_event('git.push') is not served by the CLI");
  });
});

describe("checkEventWait", () => {
  it("takes a name and the filter keys that event takes, each a glob or a list", () => {
    expect(checkEventWait("git.push", { branch: ["main", "release/*"], author: "mara" })).toEqual({ name: "git.push", filter: { branch: ["main", "release/*"], author: "mara" } });
    expect(checkEventWait("git.merge_request.opened", undefined)).toEqual({ name: "git.merge_request.opened" });
    expect(checkEventWait("git.checks.failed", { author: "x" })).toEqual({ error: "on_event('git.checks.failed'): 'author' is not a filter git.checks.failed takes — it takes branch, remote" });
    expect(checkEventWait("git.push", { branch: 3 })).toEqual({ error: "on_event('git.push'): the filter's 'branch' is a glob or a list of globs" });
    expect(checkEventWait("git.push", "main")).toEqual({ error: "on_event('git.push'): the filter is an object — { branch: 'main' }" });
  });
});

describe("the queue", () => {
  it("keeps, per task, what arrived since its first wait on that name — and takes the oldest match", async () => {
    let now = 1_000;
    const hub = new EventHub({ now: () => now });
    hub.deliver(push("main", "before-any-wait"));
    const first = hub.wait("t1", "git.push", undefined, { waiter: "guard" });
    now += 10;
    hub.deliver(push("main", "one"));
    expect((await first)?.payload).toMatchObject({ after: "one" });
    // Between waits: queued, not lost.
    hub.deliver(push("dev", "two"));
    hub.deliver(push("main", "three"));
    hub.deliver(push("main", "four"));
    expect(hub.queued("t1", "git.push").map((e) => (e.payload as { after: string }).after)).toEqual(["two", "three", "four"]);
    expect((await hub.wait("t1", "git.push", { branch: "main" }, { waiter: "guard" }))?.payload).toMatchObject({ after: "three" });
    expect((await hub.wait("t1", "git.push", undefined, { waiter: "guard" }))?.payload).toMatchObject({ after: "two" });
    // Another task that never waited has nothing queued; the one that did never saw "before-any-wait".
    expect(hub.queued("t2", "git.push")).toEqual([]);
    expect(hub.queued("t1", "git.push").map((e) => (e.payload as { after: string }).after)).toEqual(["four"]);
  });

  it("gives one event to ONE wait: the oldest armed wait its filter matches", async () => {
    const hub = new EventHub();
    const release = hub.wait("t1", "git.push", { branch: "release/*" }, { waiter: "guard" });
    const any = hub.wait("t1", "git.push", undefined, { waiter: "guard" });
    hub.deliver(push("release/1", "r"));
    expect((await release)?.payload).toMatchObject({ after: "r" });
    expect(hub.list()).toHaveLength(1);
    hub.deliver(push("main", "m"));
    expect((await any)?.payload).toMatchObject({ after: "m" });
  });

  it("keeps a task's guards and its agent apart", async () => {
    const hub = new EventHub();
    const tool = hub.wait("t1", "git.push", undefined, { waiter: "tool" });
    const guard = hub.wait("t1", "git.push", undefined, { waiter: "guard" });
    hub.deliver(push("main"));
    expect(await tool).toBeDefined();
    expect(await guard).toBeDefined();
  });

  it("delivers a task event to every other task listening, never to the one it is about", async () => {
    const hub = new EventHub();
    const self = hub.wait("t1", "task.finished", undefined, { waiter: "guard", timeoutMs: 50 });
    const other = hub.wait("t2", "task.finished", undefined, { waiter: "guard" });
    expect(hub.deliver(finished("t1"), { from: "t1" })).toBe(1);
    expect((await other)?.payload).toMatchObject({ task_id: "t1" });
    expect(await self).toBeUndefined();
  });

  it("reaches only its own project — one hub per project", async () => {
    const mine = new EventHub();
    const theirs = new EventHub();
    const waiting = theirs.wait("t1", "git.push", undefined, { waiter: "guard", timeoutMs: 50 });
    mine.deliver(push("main"));
    expect(await waiting).toBeUndefined();
  });

  it("times out to undefined, and a withdrawn wait leaves nothing behind", async () => {
    const hub = new EventHub();
    expect(await hub.wait("t1", "git.push", undefined, { timeoutMs: 10 })).toBeUndefined();
    const abort = new AbortController();
    const waiting = hub.wait("t1", "git.push", undefined, { signal: abort.signal });
    abort.abort();
    expect(await waiting).toBeUndefined();
    expect(hub.list()).toEqual([]);
  });
});

describe("across a restart", () => {
  it("a resumed task's queue starts where the suspended one's did — what the watcher caught up on before it re-armed is kept for it", async () => {
    const waits = new MemoryWaits();
    let now = 1_000;
    const before = new EventHub({ waits, now: () => now });
    void before.wait("t1", "git.push", undefined, { waiter: "guard", timeoutMs: 5 });
    before.close();
    expect(waits.since("t1", "git.push")).toBe(1_000);

    // The next start: the watcher's first look lands before the resumed run has re-armed its guard.
    now = 90_000_000;
    const after = new EventHub({ waits, now: () => now });
    after.deliver(push("main", "caught-up"));
    now += 1_000;
    expect((await after.wait("t1", "git.push", undefined, { waiter: "guard" }))?.payload).toMatchObject({ after: "caught-up" });
    // A task that was not waiting before the close starts from its own first wait.
    expect(await after.wait("t2", "git.push", undefined, { waiter: "guard", timeoutMs: 5 })).toBeUndefined();
    // And only for so long.
    now += RECENT_MS + 1;
    after.deliver(push("main", "fresh"));
    expect(after.queued("t1", "git.push").map((e) => (e.payload as { after: string }).after)).toEqual(["fresh"]);
  });

  it("forgets a task whose run ended for good — its queue and its durable start", () => {
    const waits = new MemoryWaits();
    const hub = new EventHub({ waits });
    void hub.wait("t1", "git.push", undefined, { waiter: "guard" });
    hub.forgetTask("t1");
    expect(waits.since("t1", "git.push")).toBeUndefined();
    expect(hub.list()).toEqual([]);
    hub.deliver(push("main"));
    expect(hub.queued("t1", "git.push")).toEqual([]);
  });
});
