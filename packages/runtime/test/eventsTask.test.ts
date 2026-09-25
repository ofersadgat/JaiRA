/**
 * `start_task` and `notify`, the events task's two step functions (decision 0010 §4), against a host
 * of the test's own. The service's half — the task made, its origin, its start — is `app/test/
 * eventsTask.test.ts`; this is the contract: what the functions take, what they hand back (the event,
 * for the next step), and that a start is answered once it has STARTED, not when the task ends.
 */
import { describe, expect, it } from "vitest";
import { newCapabilityRegistry, type FunctionInputs } from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { eventSummary, type EventDelivery } from "@jaira/shared";
import { checkStartTask, hostCalleeSignatures, NOTIFY, registerEventsTaskFunctions, START_TASK, type EventsTaskHost, type EventsTaskNotice, type EventsTaskStart } from "../src/index";

const push: EventDelivery = {
  name: "git.push",
  payload: { remote: "origin", connection: "github", host: "github.com", repository: "acme/app", branch: "main", before: "0a", after: "a1b2c3d4e5", commits: [] },
  at: "2026-09-25T10:00:00.000Z",
};

function rig(host?: Partial<EventsTaskHost>) {
  const started: EventsTaskStart[] = [];
  const notices: EventsTaskNotice[] = [];
  const registry = newCapabilityRegistry<WorkflowMetrics>();
  registerEventsTaskFunctions(registry, {
    startTask: async (request) => {
      started.push(request);
      return { task_id: `t${started.length}` };
    },
    notify: (notice) => void notices.push(notice),
    ...host,
  });
  const call = async (name: string, inputs: FunctionInputs) => {
    const entry = registry.functions.get(name)!;
    return (entry as unknown as { impl(inputs: FunctionInputs, ctx: unknown): Promise<{ value?: unknown; error?: { reason: string } }> }).impl(inputs, {});
  };
  return { registry, started, notices, call };
}

describe("start_task", () => {
  it("starts a task of the workflow with its inputs and title, and hands the event on", async () => {
    const { started, call } = rig();
    const result = await call(START_TASK, { workflow: "feature/review", inputs: { issue: "fix it" }, title: "Review", event: push as never });
    expect(result.value).toEqual({ task_id: "t1", event: push });
    expect(started).toEqual([{ workflow: "feature/review", inputs: { issue: "fix it" }, title: "Review", event: push }]);
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
    expect(checkStartTask({ workflow: " a ", event: { name: "not.an.event", payload: {} } })).toEqual({ workflow: "a" });
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
  it("posts the text with its event, and hands the event on", async () => {
    const { notices, call } = rig();
    expect((await call(NOTIFY, { text: " deployed ", event: push as never })).value).toEqual({ event: push });
    expect(notices).toEqual([{ text: "deployed", event: push }]);
    expect((await call(NOTIFY, { text: "" })).error?.reason).toMatch(/'text'/);
  });
});

describe("eventSummary", () => {
  it("says what happened in a line, the event's name first", () => {
    expect(eventSummary(push)).toBe("git.push a1b2c3d on main");
    const mr = { remote: "origin", connection: "gitlab", host: "gitlab.com", repository: "g/p" };
    const request = { number: 42, title: "Add sign-in", state: "open", author: "ofer", source_branch: "f", target_branch: "main", head_sha: "abc", url: "u" };
    expect(eventSummary({ name: "git.merge_request.opened", payload: { ...mr, merge_request: request } })).toBe("git.merge_request.opened !42 by ofer");
    expect(eventSummary({ name: "git.merge_request.merged", payload: { ...mr, host: "github.com", merge_request: request } })).toBe("git.merge_request.merged #42 by ofer");
    expect(eventSummary({ name: "git.merge_request.comments", payload: { ...mr, merge_request: request, comments: [{}, {}] } })).toBe("git.merge_request.comments !42 · 2 comments");
    expect(eventSummary({ name: "git.checks.failed", payload: { ...mr, ref: "main", sha: "0123456789", checks: [] } })).toBe("git.checks.failed 0123456 on main");
    expect(eventSummary({ name: "task.finished", payload: { task_id: "t", title: "First", workflow: "w", status: "completed" } })).toBe('task.finished "First"');
    expect(eventSummary({ name: "something.else" })).toBe("something.else");
  });
});
