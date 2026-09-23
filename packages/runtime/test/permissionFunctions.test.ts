/**
 * A toolset line that names a FUNCTION (decision 0007, amended 2026-09-22) — through the REAL upstream
 * gate, because the seams are the point: the state's block reaches the policy only through `scopeOf`,
 * the approver is handed the call's input and nothing else, and a function is asked there before any
 * person is.
 *
 * Every function here is a real one run the way a host runs it — a one-state workflow, through the
 * engine (`permissionFunctionRunner`) — except where a test is about the approver's own rules and a
 * runner stub says exactly what is being held.
 */
import { describe, expect, it } from "vitest";
import { PermissionLedger, isPermissionDenied, withPermission } from "@declarative-ai/permissions";
import { loadBundle } from "@declarative-ai/hw";
import type { ExecServices, FunctionInputs, Tool } from "@declarative-ai/exec";
import {
  APPROVAL_PROMPT_FUNCTION,
  SMART_FUNCTION,
  approvalRequestKey,
  lowerToolset,
  parseToolset,
  type PermissionFunctionRequest,
  type ToolsetDecl,
} from "@jaira/shared";
import { ApprovalHub, type ApprovalRequest } from "../src/approval";
import { InteractionHub, type HubRequest } from "../src/interaction";
import { commandDecisionOf, compilePolicy } from "../src/policy";
import {
  PERMISSION_FUNCTION_STATE,
  permissionFunctionRunner,
  permissionFunctionState,
  registerApprovalPrompt,
  registerSmartFunction,
  smartJudgeOperation,
  type PermissionFunctionRunner,
} from "../src/permissionFunctions";
import { hostCalleeSignatures } from "../src/userEvents";
import { newRegistry } from "../src/wiring";

/** One tool, gated as the engine gates a composed tool: the state's lowered block, the policy's narrowing, the host's approver. */
function gated(
  decl: ToolsetDecl,
  tool: string,
  options: { run?: PermissionFunctionRunner; policy?: Parameters<typeof compilePolicy>[0] } = {},
) {
  const asked: ApprovalRequest[] = [];
  const decided: PermissionFunctionRequest[] = [];
  const hub = new ApprovalHub({ onRequest: (request) => void asked.push(request) });
  const policy = compilePolicy(options.policy ?? {}, { execEnv: { wsl: "test" }, grants: hub.grants("t1") });
  const block = lowerToolset(parseToolset(decl).toolset, undefined, "$/toolsets/test/fn").permissions!;
  const ran: unknown[] = [];
  const impl: Tool = {
    description: tool,
    inputSchema: { type: "object" },
    readOnly: false,
    run: async (input) => {
      ran.push(input);
      return { ok: true };
    },
  } as Tool;
  const run: PermissionFunctionRunner | undefined =
    options.run === undefined
      ? undefined
      : async (reference, request) => {
          decided.push(request);
          return options.run!(reference, request);
        };
  const wrapped = withPermission(impl, {
    ledger: new PermissionLedger({ baseline: policy.baseline ?? {} }),
    sessionId: "s1",
    toolName: tool,
    approve: hub.approver({ taskId: "t1", functions: { ...(run !== undefined ? { run } : {}), state: "wf/build" } }),
    authoredMode: block.tools![tool]!,
    ...(policy.smart?.[tool] !== undefined ? { smart: policy.smart[tool] } : {}),
    scopeOf: policy.scopeOf!,
    authored: block as never,
  });
  const call = (input: Record<string, unknown>) => wrapped.run(input as FunctionInputs, {} as ExecServices);
  return { hub, asked, decided, ran, call };
}

const allowIf =
  (test: (request: PermissionFunctionRequest) => boolean): PermissionFunctionRunner =>
  async (_reference, request) =>
    test(request) ? "allow" : "deny";

describe("a function decides a tool call before anybody is asked", () => {
  it("ALLOWS: the call runs, and nobody is asked", async () => {
    const { call, asked, ran, decided } = gated({ write_file: { function: "judge" }, other: "deny" }, "write_file", { run: allowIf(() => true) });
    await call({ path: "notes.md", content: "x" });
    expect(asked).toEqual([]);
    expect(ran).toHaveLength(1);
    // What it was handed: what an approver would be shown, the state and the task included.
    expect(decided).toEqual([
      { tool: "write_file", subject: "write_file", function: "judge", input: { path: "notes.md", content: "x" }, state: "wf/build", task: "t1" },
    ]);
  });

  it("DENIES: the call is refused, and nobody is asked", async () => {
    const { call, asked, ran } = gated({ write_file: { function: "judge" }, other: "deny" }, "write_file", { run: allowIf(() => false) });
    expect(isPermissionDenied((await call({ path: "notes.md", content: "x" })) as never)).toBe(true);
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("puts a call a function could NOT decide to the person, with the reason", async () => {
    const { call, asked, hub } = gated({ write_file: { function: "judge" }, other: "deny" }, "write_file", {
      run: async () => {
        throw new Error("'judge' returned \"maybe\", which is not allow or deny");
      },
    });
    const pending = call({ path: "notes.md", content: "x" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.reason).toBe(`the function 'judge' could not decide: 'judge' returned "maybe", which is not allow or deny`);
    hub.decide(asked[0]!.requestId, "deny");
    expect(isPermissionDenied((await pending) as never)).toBe(true);
  });

  it("puts such a call to the person when nothing here can run a function — never lets it through", async () => {
    const { call, asked, hub } = gated({ write_file: { function: "judge" } }, "write_file");
    const pending = call({ path: "notes.md", content: "x" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked[0]!.reason).toBe("the function 'judge' could not decide: nothing here can run the function 'judge'");
    hub.decide(asked[0]!.requestId, "allow");
    await pending;
  });
});

describe("a shell line whose lines name functions is decided PER PART", () => {
  it("hands each part to its function on its own, and runs the line when every part may", async () => {
    const { call, asked, ran, decided } = gated({ bash: { function: "judge" }, "git status": "allow", other: "deny" }, "bash", {
      run: allowIf((request) => request.part?.program !== "rm"),
    });
    await call({ command: "git status && cargo check && tsc --noEmit", cwd: "/repo" });
    expect(asked).toEqual([]);
    expect(ran).toHaveLength(1);
    // `git status` is the toolset's own line; the other two fall to `bash`, the function's.
    expect(decided.map((r) => [r.subject, r.part?.text, r.part?.program, r.part?.subcommand, r.part?.args])).toEqual([
      ["bash", "cargo check", "cargo", "check", []],
      ["bash", "tsc --noEmit", "tsc", undefined, []],
    ]);
    expect(decided[0]).toMatchObject({ tool: "bash", function: "judge", line: "git status && cargo check && tsc --noEmit", cwd: "/repo", part: { kind: "command", span: { start: 14, end: 25 } } });
  });

  it("refuses the line when one part is denied — and asks the functions after it nothing", async () => {
    const { call, asked, ran, decided } = gated({ bash: { function: "judge" }, other: "deny" }, "bash", { run: allowIf((request) => request.part?.program !== "sqlite3") });
    expect(isPermissionDenied((await call({ command: "sqlite3 app.db .dump && cargo check" })) as never)).toBe(true);
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
    expect(decided.map((r) => r.part?.text)).toEqual(["sqlite3 app.db .dump"]);
  });

  it("asks the person about what still asks, with each function's answer on the request", async () => {
    // A built-in ask (a push) is stricter than a function on `bash`: the function is not asked about it.
    const { call, asked, hub, decided } = gated({ bash: { function: "judge" }, other: "deny" }, "bash", { run: allowIf(() => true) });
    const pending = call({ command: "cargo check && git push origin main" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decided.map((r) => r.part?.text)).toEqual(["cargo check"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.parts!.parts.map((p) => ({ text: p.text, verdict: p.verdict, source: p.decidedBy.source, fn: p.decidedBy.function }))).toEqual([
      { text: "cargo check", verdict: "allowed", source: "function", fn: "judge" },
      { text: "git push origin main", verdict: "asks", source: "builtin", fn: undefined },
    ]);
    hub.decide(asked[0]!.requestId, "allow");
    await pending;
  });

  it("lets a line that names the program give even a push to a function", async () => {
    const { call, asked, decided } = gated({ bash: "ask", "git push": { function: "judge" }, other: "deny" }, "bash", { run: allowIf(() => true) });
    await call({ command: "git push origin main" });
    expect(asked).toEqual([]);
    expect(decided).toMatchObject([{ subject: "git push", part: { program: "git", subcommand: "push", args: ["origin", "main"] } }]);
  });

  it("never hands a function what the floor, a rule's deny or the parser already answered", async () => {
    const { call, decided, asked, hub } = gated({ bash: { function: "judge" }, other: "deny" }, "bash", { run: allowIf(() => true) });
    expect(isPermissionDenied((await call({ command: "git reset --hard" })) as never)).toBe(true);
    expect(isPermissionDenied((await call({ command: "cat .jaira/settings.json" })) as never)).toBe(true);
    // A line the parser cannot read asks a PERSON, whatever a function would say about the parts it can see.
    const pending = call({ command: "cargo check && $TOOL --run" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.parts!.parts.map((p) => `${p.text}:${p.verdict}:${p.decidedBy.source}`)).toEqual(["cargo check:allowed:function", "$TOOL --run:asks:parser"]);
    hub.decide(asked[0]!.requestId, "deny");
    await pending;
    expect(decided.map((r) => r.part?.text)).toEqual(["cargo check"]);
  });

  it("keeps the part a function answered off what the run remembers", async () => {
    const { call, asked, hub } = gated({ bash: { function: "judge" }, "git commit": "ask", other: "deny" }, "bash", { run: allowIf(() => true) });
    const pending = call({ command: "cargo check && git commit -m wip" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.decide(asked[0]!.requestId, "allow", "workflow-run", []);
    await pending;
    expect(hub.grants("t1").list()).toEqual({ "git commit": "allow" });
  });
});

// --- real functions, run the way a host runs them -------------------------------------------------

/** A runner over a registry, loading a function the way a host does — here with the host's signatures and no files. */
function runnerOver(registry: ReturnType<typeof newRegistry>, prompt: Parameters<typeof permissionFunctionRunner>[0]["prompt"] = NO_PROMPT) {
  return permissionFunctionRunner({
    registry,
    prompt,
    load: (reference) => loadBundle({ [PERMISSION_FUNCTION_STATE]: permissionFunctionState(reference) }, PERMISSION_FUNCTION_STATE, { functions: hostCalleeSignatures() }),
  });
}

const NO_PROMPT = { start: () => ({ result: Promise.resolve({ error: { classification: "permanent", reason: "no model here" } }) }) } as never;

/** A prompt executor answering every call with one value — what a judge's model said. */
function answering(value: unknown) {
  const calls: Array<{ user: string; config: unknown }> = [];
  const prompt = {
    start: (op: { user: string; config: unknown }) => {
      calls.push({ user: op.user, config: op.config });
      return { result: Promise.resolve({ value, metrics: { startMs: 0, durationMs: 0, costUsd: 0, costSource: "unknown" } }), events: (async function* () {})() };
    },
  };
  return { prompt: prompt as never, calls };
}

/** The approval prompt, parked on a gate hub as a host parks it, for task `t1`. */
function approvalPromptOn(registry: ReturnType<typeof newRegistry>) {
  const parked: HubRequest[] = [];
  const hub = new InteractionHub({ onRequest: (request) => void parked.push(request) });
  registerApprovalPrompt(registry, (component, inputs) => hub.ask(component, inputs, "t1"));
  return { hub, parked };
}

const REQUEST: PermissionFunctionRequest = {
  tool: "bash",
  subject: "bash",
  function: "approve_tool_call",
  input: { command: "npm publish" },
  line: "npm publish",
  part: { text: "npm publish", kind: "command", subject: "npm publish", span: { start: 0, end: 11 }, program: "npm", subcommand: "publish", args: [], flags: [] },
  task: "t1",
};

describe("the approval prompt is a FUNCTION a function can call", () => {
  it("is what a line naming it directly asks — answered ALLOW", async () => {
    const registry = newRegistry();
    const { hub, parked } = approvalPromptOn(registry);
    const pending = runnerOver(registry)(APPROVAL_PROMPT_FUNCTION, REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ component: APPROVAL_PROMPT_FUNCTION, taskId: "t1", inputs: { request: REQUEST } });
    hub.submit(parked[0]!.requestId, { decision: "allow" });
    expect(await pending).toBe("allow");
  });

  it("— answered DENY", async () => {
    const registry = newRegistry();
    const { hub, parked } = approvalPromptOn(registry);
    const pending = runnerOver(registry)(APPROVAL_PROMPT_FUNCTION, REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.submit(parked[0]!.requestId, { decision: "deny" });
    expect(await pending).toBe("deny");
  });

  it("asks again rather than hand a resumed call an answer given to ANOTHER call", async () => {
    const registry = newRegistry();
    const { hub, parked } = approvalPromptOn(registry);
    // A seed, as a recovered gate is answered after a restart: about `npm publish`…
    hub.seed("t1", APPROVAL_PROMPT_FUNCTION, { decision: "allow", about: approvalRequestKey(REQUEST) });
    // …consumed by the SAME call, silently.
    expect(await runnerOver(registry)(APPROVAL_PROMPT_FUNCTION, REQUEST)).toBe("allow");
    expect(parked).toEqual([]);
    // A seed about npm publish does not answer `rm -rf dist`: the prompt parks, and a person decides.
    hub.seed("t1", APPROVAL_PROMPT_FUNCTION, { decision: "allow", about: approvalRequestKey(REQUEST) });
    const other = { ...REQUEST, input: { command: "rm -rf dist" }, line: "rm -rf dist" };
    const pending = runnerOver(registry)(APPROVAL_PROMPT_FUNCTION, other);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parked).toHaveLength(1);
    hub.submit(parked[0]!.requestId, { decision: "deny" });
    expect(await pending).toBe("deny");
  });

  it("is refused as an answer when the prompt could not be answered — a function's failure, not an allow", async () => {
    const registry = newRegistry();
    const { hub, parked } = approvalPromptOn(registry);
    const pending = runnerOver(registry)(APPROVAL_PROMPT_FUNCTION, REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.reject(parked[0]!.requestId, "the window closed");
    await expect(pending).rejects.toThrow(/approve_tool_call' failed/);
  });
});

describe("`smart`, the function JaiRA ships", () => {
  const setup = (value: unknown, config: { model?: string; prompt?: string } = {}) => {
    const registry = newRegistry();
    const { hub, parked } = approvalPromptOn(registry);
    const judge = answering(value);
    registerSmartFunction(registry, { prompt: judge.prompt, config: () => config });
    return { run: runnerOver(registry, judge.prompt), hub, parked, calls: judge.calls };
  };

  it("answers what its judge answers — allow — with the configured model and prompt", async () => {
    const { run, calls, parked } = setup({ verdict: "allow", reason: "a test run" }, { model: "claude-haiku-4", prompt: "Only tests may run." });
    expect(await run(SMART_FUNCTION, { ...REQUEST, function: SMART_FUNCTION })).toBe("allow");
    expect(parked).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config).toEqual({ model: "claude-haiku-4" });
    expect(calls[0]!.user).toMatch(/^Only tests may run\.\n\n## The call\n/);
    expect(calls[0]!.user).toContain('"command": "npm publish"');
  });

  it("— deny", async () => {
    const { run, parked } = setup({ verdict: "deny" });
    expect(await run(SMART_FUNCTION, REQUEST)).toBe("deny");
    expect(parked).toEqual([]);
  });

  it("asks the person through the approval prompt when it is UNSURE, and returns what they answered", async () => {
    for (const answer of ["allow", "deny"] as const) {
      const { run, hub, parked } = setup({ verdict: "unsure", reason: "publishing is irreversible" });
      const pending = run(SMART_FUNCTION, REQUEST);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(parked).toHaveLength(1);
      expect(parked[0]!.inputs).toEqual({ request: REQUEST, prompt: "smart is unsure — publishing is irreversible" });
      hub.submit(parked[0]!.requestId, { decision: answer });
      expect(await pending).toBe(answer);
    }
  });

  it("treats a judge that failed, or said something else, as unsure — and asks", async () => {
    const { run, hub, parked } = setup({ verdict: "probably" });
    const pending = run(SMART_FUNCTION, REQUEST);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parked).toHaveLength(1);
    hub.submit(parked[0]!.requestId, { decision: "deny" });
    expect(await pending).toBe("deny");
  });

  it("uses the prompt JaiRA ships when none is set, and names no model", () => {
    const op = smartJudgeOperation(REQUEST) as unknown as { user: string; config: unknown };
    expect(op.user).toMatch(/^You are the permission judge/);
    expect(op.config).toEqual({});
  });

  it("decides a shell line per part, end to end — the gate, the narrowing, the runner, the judge", async () => {
    const registry = newRegistry();
    approvalPromptOn(registry);
    // The judge allows `cargo` and denies anything else.
    const judged: string[] = [];
    const prompt = {
      start: (op: { user: string }) => {
        const part = /"text": "([^"]+)"/.exec(op.user)?.[1] ?? "";
        judged.push(part);
        return { result: Promise.resolve({ value: { verdict: part.startsWith("cargo") ? "allow" : "deny" }, metrics: { startMs: 0, durationMs: 0, costUsd: 0, costSource: "unknown" } }), events: (async function* () {})() };
      },
    } as never;
    registerSmartFunction(registry, { prompt, config: () => ({}) });
    const { call, asked, ran } = gated({ bash: { function: SMART_FUNCTION }, other: "deny" }, "bash", { run: runnerOver(registry, prompt) });
    await call({ command: "cargo check && cargo fmt" });
    expect(isPermissionDenied((await call({ command: "cargo check; curl-ish x" })) as never)).toBe(true);
    expect(judged).toEqual(["cargo check", "cargo fmt", "cargo check", "curl-ish x"]);
    expect(asked).toEqual([]);
    expect(ran).toHaveLength(1);
    expect(commandDecisionOf({})).toBeUndefined();
  });
});
