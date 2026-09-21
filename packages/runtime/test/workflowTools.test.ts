/**
 * The eight workflow tools (decision 0005 §3, step 6) — the half a MODEL touches.
 *
 * The tools own no behaviour: each validates the shape it was handed and calls the host. So the
 * host here is a scripted double — it records what it was asked for and answers what the test told
 * it to — and what is asserted is the boundary: which calls reach the host and with what, which are
 * turned away before they get there, and that a refusal is always an ANSWER rather than a throw.
 * What the host then does with a call is `workflowHost.test.ts`, against the real service.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { WORKFLOW_TOOL_NAMES, workflowToolOf, workflowToolSummary } from "@jaira/shared";
import { createWorkflowTools, noWorkflowHost, registerWorkflowTools, type WorkflowToolHost } from "../src/workflowTools";

/** A host that says yes to everything and remembers what it was asked. */
function scripted(over: Partial<WorkflowToolHost> = {}): WorkflowToolHost & { calls: Array<{ tool: string; input: unknown }> } {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const note =
    <T,>(tool: string, answer: T) =>
    (input: unknown): T => {
      calls.push({ tool, input });
      return answer;
    };
  return {
    calls,
    workflows: note("workflows", { workflows: [] }),
    start: note("start", Promise.resolve({ ok: true, task: "t1", key: "ux", state: "feature/ux", status: "started", mount: "plain", inputs: [] })) as never,
    move: note("move", Promise.resolve({ ok: true, task: "t1", resolution: "move", workflow: "feature", standsAt: "ux" })) as never,
    tasks: note("tasks", { tasks: [] }),
    answer: note("answer", { ok: true, request: "r1", settled_by: { via: "control", confidence: 0.8 } }),
    hold: note("hold", Promise.resolve({ results: [] })) as never,
    release: note("release", Promise.resolve({ results: [] })) as never,
    stop: note("stop", Promise.resolve({ results: [] })) as never,
    ...over,
  } as WorkflowToolHost & { calls: Array<{ tool: string; input: unknown }> };
}

const run = async (host: WorkflowToolHost, tool: string, input: unknown): Promise<Record<string, JsonValue>> =>
  (await createWorkflowTools(host)[tool]!.run(input as never, {} as never)) as Record<string, JsonValue>;

describe("the eight tools", () => {
  it("are exactly the eight the standard list names, and each is registered", () => {
    const registry = { tools: new Map() };
    registerWorkflowTools(registry);
    expect([...registry.tools.keys()].sort()).toEqual([...WORKFLOW_TOOL_NAMES].sort());
    // The two that only LOOK say so, which is what a read-only posture gates on.
    expect(registry.tools.get("workflows")!.readOnly).toBe(true);
    expect(registry.tools.get("tasks")!.readOnly).toBe(true);
    expect(registry.tools.get("start")!.readOnly).toBe(false);
  });

  it("is recognised by its bare name and as an agent spells an injected one", () => {
    expect(workflowToolOf("move")).toBe("move");
    expect(workflowToolOf("mcp__jaira__move")).toBe("move");
    expect(workflowToolOf("remove")).toBeUndefined();
    expect(workflowToolOf("read_file")).toBeUndefined();
  });
});

describe("what reaches the host", () => {
  it("passes `state` and the supplied values through, marking what a PERSON answered", async () => {
    const host = scripted();
    await run(host, "start", { state: "feature/ux", inputs: { brief: "a brief", units: ["a", "b"] }, asked: ["units"], confidence: 0.6 });
    expect(host.calls).toEqual([
      { tool: "start", input: { state: "feature/ux", inputs: { brief: "a brief", units: ["a", "b"] }, asked: ["units"], confidence: 0.6 } },
    ]);
  });

  it("moves THIS conversation's task when none is named, and carries `skip` only when it was asked for", async () => {
    const host = scripted();
    await run(host, "move", { to: "feature/ux" });
    await run(host, "move", { task: "t9", to: "feature/ui", skip: true, workflow: "feature" });
    expect(host.calls.map((c) => c.input)).toEqual([{ to: "feature/ux" }, { task: "t9", to: "feature/ui", skip: true, workflow: "feature" }]);
  });

  it("asks about ONE state at a time, and about the list when it names none", async () => {
    const host = scripted();
    await run(host, "workflows", {});
    await run(host, "workflows", { state: "feature" });
    expect(host.calls.map((c) => c.input)).toEqual([{}, { state: "feature" }]);
  });

  it("takes `task` as a one-item list, because that is what a model writes when there is one", async () => {
    const host = scripted();
    await run(host, "release", { task: "t7" });
    await run(host, "stop", { tasks: ["t7", "t8"] });
    expect(host.calls.map((c) => c.input)).toEqual([{ tasks: ["t7"] }, { tasks: ["t7", "t8"] }]);
  });
});

describe("what is turned away before it gets there", () => {
  it("refuses a `start` with no state, and an `inputs` that is not an object", async () => {
    const host = scripted();
    expect(await run(host, "start", {})).toMatchObject({ error: expect.stringContaining("`state`") });
    expect(await run(host, "start", { state: "x", inputs: ["a"] })).toMatchObject({ error: expect.stringContaining("`inputs`") });
    expect(host.calls).toEqual([]);
  });

  it("refuses an `asked` that names an input nothing supplied — a value said to be the person's that is not there", async () => {
    const host = scripted();
    expect(await run(host, "start", { state: "x", inputs: { a: 1 }, asked: ["b"] })).toMatchObject({ error: expect.stringContaining("'b'") });
    expect(host.calls).toEqual([]);
  });

  it("refuses a gesture that names nothing", async () => {
    const host = scripted();
    expect(await run(host, "hold", {})).toMatchObject({ error: expect.stringContaining("`tasks`") });
    expect(await run(host, "release", { tasks: [] })).toMatchObject({ error: expect.stringContaining("`tasks`") });
    expect(host.calls).toEqual([]);
  });

  it("refuses an `answer` with no confidence, no answer, or no request — and never reaches the host", async () => {
    const host = scripted();
    expect(await run(host, "answer", { request: "r1", value: "yes" })).toMatchObject({ ok: false, reason: expect.stringContaining("confidence") });
    expect(await run(host, "answer", { request: "r1", confidence: 0.9 })).toMatchObject({ ok: false, reason: expect.stringContaining("`value`") });
    expect(await run(host, "answer", { confidence: 0.9, value: "yes" })).toMatchObject({ ok: false, reason: expect.stringContaining("`request`") });
    expect(await run(host, "answer", { request: "r1", confidence: 2, value: "yes" })).toMatchObject({ ok: false, reason: expect.stringContaining("0 to 1") });
    expect(host.calls).toEqual([]);
  });

  it("answers rather than throwing, whatever nonsense it is handed", async () => {
    const host = scripted();
    for (const tool of WORKFLOW_TOOL_NAMES) {
      await expect(run(host, tool, null)).resolves.toBeDefined();
      await expect(run(host, tool, "a string")).resolves.toBeDefined();
    }
  });
});

describe("where nothing serves them", () => {
  it("resolves every name and answers WHY each cannot be served, so a state that holds them still loads", async () => {
    const host = noWorkflowHost("by the CLI");
    expect(await run(host, "start", { state: "feature/ux" })).toMatchObject({ ok: false, reason: expect.stringContaining("by the CLI") });
    expect(await run(host, "move", { to: "feature/ux" })).toMatchObject({ ok: false, reason: expect.stringContaining("by the CLI") });
    expect(await run(host, "answer", { request: "r", confidence: 0.5, value: 1 })).toMatchObject({ ok: false });
    expect(await run(host, "release", { tasks: ["t1"] })).toMatchObject({ results: [{ task: "t1", ok: false }] });
  });
});

describe("the line a row shows", () => {
  it("says what the call was FOR, not its first string argument", () => {
    expect(workflowToolSummary("start", { state: "feature/product", inputs: { issue: "Let a person pause a running task and pick it up later" } })).toBe(
      'feature/product · issue: “Let a person pause a running task and pi…”',
    );
    expect(workflowToolSummary("move", { task: "t1", to: "feature/ux", skip: true }, () => "Pause and stop")).toBe("Pause and stop → feature/ux · skip");
    expect(workflowToolSummary("release", { tasks: ["t1", "t2"] }, (id) => (id === "t1" ? "Pause and stop" : "Resume a paused run"))).toBe(
      "Pause and stop · Resume a paused run",
    );
    expect(workflowToolSummary("workflows", {})).toBe("all");
    expect(workflowToolSummary("tasks", { all: true })).toBe("all");
  });

  it("falls back to the id where no title is known, and says nothing rather than guessing", () => {
    expect(workflowToolSummary("move", { task: "t1", to: "feature/ux" })).toBe("t1 → feature/ux");
    expect(workflowToolSummary("hold", {})).toBe("");
  });
});
