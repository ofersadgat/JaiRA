/**
 * `start_task` and `notify`, the events task's two step functions (decision 0010 §4), against a host
 * of the test's own. The service's half — the task made, its provenance and mirror, its start — is
 * `app/test/eventsTask.test.ts`; this is the contract: what the functions take, who called (the
 * engine's dispatch site on the context), and that a start is answered once it has STARTED, not when
 * the task ends.
 */
import { describe, expect, it } from "vitest";
import { newCapabilityRegistry, type FunctionInputs } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { eventSummary, type EventDelivery } from "@jaira/shared";
import {
  callerOf,
  checkStartTask,
  hostCalleeSignatures,
  NOTIFY,
  registerEventsTaskFunctions,
  START_TASK,
  type EventsTaskCaller,
  type EventsTaskHost,
  type EventsTaskNotice,
  type EventsTaskStart,
} from "../src/index";

const push: EventDelivery = {
  name: "git.pushed",
  payload: { remote: "origin", connection: "github", host: "github.com", repository: "acme/app", branch: "main", before: "0a", after: "a1b2c3d4e5", commits: [] },
  at: "2026-09-25T10:00:00.000Z",
};

/** Call 1 of the automation instance `i-1`'s operation list, as the engine dispatches it (SPEC §7.1d). */
const SITE = { scope: { instanceId: "i-1", sequence: -1 } };

function rig(host?: Partial<EventsTaskHost>) {
  const started: Array<{ request: EventsTaskStart; caller: EventsTaskCaller }> = [];
  const notices: Array<{ notice: EventsTaskNotice; caller: EventsTaskCaller }> = [];
  const registry = newCapabilityRegistry<WorkflowMetrics>();
  registerEventsTaskFunctions(registry, {
    startTask: async (request, caller) => {
      started.push({ request, caller });
      return { task_id: `t${started.length}` };
    },
    notify: (notice, caller) => void notices.push({ notice, caller }),
    ...host,
  });
  const call = async (name: string, inputs: FunctionInputs, ctx: unknown = {}) => {
    const entry = registry.functions.get(name)!;
    return (entry as unknown as { impl(inputs: FunctionInputs, ctx: unknown): Promise<{ value?: unknown; error?: { reason: string } }> }).impl(inputs, ctx);
  };
  return { registry, started, notices, call };
}

describe("start_task", () => {
  it("starts a task of the workflow with its inputs and title, as the CALLING STATE's child by default", async () => {
    const { started, call } = rig();
    const result = await call(START_TASK, { workflow: "feature/review", inputs: { issue: "fix it" }, title: "Review" }, SITE);
    expect(result.value).toEqual({ task_id: "t1" });
    // Who called is the engine's dispatch site, not an argument: the instance, and which call of its list.
    expect(started).toEqual([{ request: { workflow: "feature/review", inputs: { issue: "fix it" }, title: "Review", topLevel: false }, caller: { instanceId: "i-1", call: 1 } }]);
  });

  it("`top_level: true` asks for a task on its own; an event named in the call is handed over", async () => {
    const { started, call } = rig();
    await call(START_TASK, { workflow: "feature/review", top_level: true, event: push as never }, { scope: { instanceId: "i-2", sequence: 0 } });
    expect(started[0]).toEqual({ request: { workflow: "feature/review", topLevel: true, event: push }, caller: { instanceId: "i-2", call: 0 } });
  });

  it("a call no engine dispatched has no site: call 0, and no instance", () => {
    expect(callerOf(undefined)).toEqual({ call: 0 });
    expect(callerOf({ scope: { instanceId: "i", sequence: -3 } })).toEqual({ instanceId: "i", call: 3 });
    // A call SITE (sequence ≥ 1) is not an operation of a list: call 0 of the state.
    expect(callerOf({ scope: { instanceId: "i", sequence: 2 } })).toEqual({ instanceId: "i", call: 0 });
  });

  it("answers once the start is answered — it never waits for the task", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const { call } = rig({ startTask: async () => ({ task_id: "t9" }) });
    // The host's task would finish only when `finish` is called; the call is already answered.
    const result = await call(START_TASK, { workflow: "feature/review" });
    expect(result.value).toEqual({ task_id: "t9" });
    finish();
    await finished;
  });

  it("a task that was made and could not start is an ANSWER, not a failure of the events task", async () => {
    const { call } = rig({ startTask: async () => ({ task_id: "t2", error: "no such workflow" }) });
    expect((await call(START_TASK, { workflow: "nope" })).value).toEqual({ task_id: "t2", error: "no such workflow" });
  });

  it("refuses arguments that are not a start", async () => {
    const { call } = rig();
    expect((await call(START_TASK, {})).error?.reason).toMatch(/'workflow' names the workflow/);
    expect((await call(START_TASK, { workflow: "a", inputs: [1] })).error?.reason).toMatch(/'inputs' is an object/);
    expect((await call(START_TASK, { workflow: "a", top_level: "yes" })).error?.reason).toMatch(/'top_level' is true or false/);
    expect(checkStartTask({ workflow: " a ", event: { name: "not.an.event", payload: {} } })).toEqual({ workflow: "a", topLevel: false });
  });

  it("without a host it is only a declaration — what every workflow loads against, and no run but the events task's acts on", async () => {
    const registry = newCapabilityRegistry<WorkflowMetrics>();
    registerEventsTaskFunctions(registry);
    const entry = registry.functions.get(START_TASK) as unknown as { impl(i: FunctionInputs, c: unknown): Promise<{ error?: { reason: string } }> };
    expect((await entry.impl({ workflow: "a" }, {})).error?.reason).toMatch(/only the events task/);
    expect([...hostCalleeSignatures().keys()]).toEqual(expect.arrayContaining([START_TASK, NOTIFY]));
  });
});

describe("notify", () => {
  it("posts the text — its event read by the host off the calling state when the call names none — and answers what it told", async () => {
    const { notices, call } = rig();
    expect((await call(NOTIFY, { text: " deployed " }, SITE)).value).toEqual({ text: "deployed" });
    expect((await call(NOTIFY, { text: "again", event: push as never })).value).toEqual({ text: "again", event: "git.pushed a1b2c3d on main" });
    expect(notices).toEqual([
      { notice: { text: "deployed" }, caller: { instanceId: "i-1", call: 1 } },
      { notice: { text: "again", event: push }, caller: { call: 0 } },
    ]);
    expect((await call(NOTIFY, { text: "" })).error?.reason).toMatch(/'text'/);
  });

  it("answers with the event the HOST read off the calling state", async () => {
    const { call } = rig({ notify: (notice) => ({ ...notice, event: push }) });
    expect((await call(NOTIFY, { text: "deployed" }, SITE)).value).toEqual({ text: "deployed", event: "git.pushed a1b2c3d on main" });
  });
});

describe("eventSummary", () => {
  it("says what happened in a line, the event's name first", () => {
    expect(eventSummary(push)).toBe("git.pushed a1b2c3d on main");
    const mr = { remote: "origin", connection: "gitlab", host: "gitlab.com", repository: "g/p" };
    const request = { number: 42, title: "Add sign-in", state: "open", author: "ofer", source_branch: "f", target_branch: "main", head_sha: "abc", url: "u" };
    expect(eventSummary({ name: "merge_request.opened", payload: { ...mr, merge_request: request } })).toBe("merge_request.opened !42 by ofer");
    expect(eventSummary({ name: "merge_request.merged", payload: { ...mr, host: "github.com", merge_request: request } })).toBe("merge_request.merged #42 by ofer");
    expect(eventSummary({ name: "merge_request.commented", payload: { ...mr, merge_request: request, comments: [{}, {}] } })).toBe("merge_request.commented !42 · 2 comments");
    expect(eventSummary({ name: "pipeline.failed", payload: { ...mr, ref: "main", sha: "0123456789", checks: [] } })).toBe("pipeline.failed 0123456 on main");
    expect(eventSummary({ name: "task.finished", payload: { task_id: "t", title: "First", workflow: "w", status: "completed" } })).toBe('task.finished "First"');
    expect(eventSummary({ name: "something.else" })).toBe("something.else");
  });
});
