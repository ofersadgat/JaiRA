/**
 * A toolset line's FUNCTION, as a project holds one (decision 0007, amended 2026-09-22): resolved along
 * the same path as any callee, held to the SAME module approval as any user function, and run the way
 * a host runs it — so a `.ts` judge, a prompt document that is an LLM call somebody configured, and an
 * expression document that asks the person are all one kind of thing.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moduleHash } from "@declarative-ai/hw";
import { APPROVAL_PROMPT_FUNCTION, ApprovalRequired, type PermissionFunctionRequest } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import {
  InteractionHub,
  newRegistry,
  permissionFunctionRunner,
  prepareUserFunctions,
  registerApprovalPrompt,
  registerUserFunctions,
  type HubRequest,
} from "@jaira/runtime";
import {
  beginTaskRun,
  browseWorkflows,
  createTask,
  initProject,
  loadPermissionFunction,
  openProject,
  permissionFunctionRefsOf,
  prepareUserModules,
  resetUserModules,
  resolveUserFunctions,
  userModules,
  workflowLoadOptions,
  type Project,
} from "../src/index";

const JUDGE = `export const judge = {
  /** @param request the call being judged — see PermissionFunctionRequest. */
  decide(request: { [key: string]: unknown }): "allow" | "deny" {
    const part = request["part"] as { program?: string } | undefined;
    return part?.program === "git" ? "allow" : "deny";
  },
};
`;

/** A state whose toolset hands every shell command nothing else names to `reference`. */
const guarded = (reference: string): Record<string, unknown> => ({
  label: "Guarded",
  environment: { tools: { read_file: "allow", bash: { function: reference }, other: "deny" } },
  operation: { prompt: "go", output: { report: { schema: { type: "string" } } } },
  outputs: { report: { binding: ".operation.output.report" } },
});

const request = (program: string): PermissionFunctionRequest => ({
  tool: "bash",
  subject: "bash",
  function: "judge.decide",
  input: { command: `${program} status` },
  line: `${program} status`,
  part: { text: `${program} status`, kind: "command", subject: `${program} status`, span: { start: 0, end: program.length + 7 }, program, subcommand: "status", args: [], flags: [] },
  task: "t-1",
});

let dir: string;
let project: Project | undefined;
let judgeFile: string;

function writeJson(rel: string, value: unknown): void {
  writeFileSync(join(dir, ".jaira", rel), JSON.stringify(value), "utf8");
}

async function open(): Promise<Project> {
  project = openProject(dir, { baseDir: testHome() });
  await prepareUserModules(project.paths, { rebuild: true });
  return project;
}

/** A runner over a fresh registry, loading as a host does: the project's options, the modules merged and prepared. */
function runnerFor(p: Project, registry = newRegistry(), prompt: Parameters<typeof permissionFunctionRunner>[0]["prompt"] = NO_PROMPT) {
  return permissionFunctionRunner({
    registry,
    prompt,
    load: async (reference) => {
      const bundle = loadPermissionFunction(reference, workflowLoadOptions(p.paths));
      const modules = userModules()!;
      resolveUserFunctions(modules, bundle);
      registerUserFunctions(registry, modules.userFunctions);
      await prepareUserFunctions(modules.userFunctions);
      return bundle;
    },
  });
}

const NO_PROMPT = { start: () => ({ result: Promise.resolve({ error: { classification: "permanent", reason: "no model here" } }) }) } as never;

beforeEach(() => {
  resetUserModules();
  dir = mkdtempSync(join(tmpdir(), "jaira-permfn-"));
  initProject(dir, testHome());
  mkdirSync(join(dir, ".jaira", "functions"), { recursive: true });
  judgeFile = join(dir, ".jaira", "functions", "judge.ts");
  writeFileSync(judgeFile, JUDGE, "utf8");
  writeJson("workflows/guarded.json", guarded("judge.decide"));
});

afterEach(() => {
  project?.close();
  project = undefined;
  resetUserModules();
  rmSync(dir, { recursive: true, force: true });
});

describe("a `.ts` function a toolset names goes through the module approval like any other", () => {
  it("refuses to start the task until the file is approved — naming the file and the call, as a question", async () => {
    const p = await open();
    createTask(p, { title: "t", workflow: "guarded", id: "t-1" });
    const error = await beginTaskRun(p, "t-1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApprovalRequired);
    const pending = (error as ApprovalRequired).pending;
    expect(pending.map((entry) => entry.file.replace(/\\/g, "/"))).toEqual([expect.stringMatching(/\.jaira\/functions\/judge\.ts$/)]);
    expect(pending[0]!.symbols).toEqual(["judge.decide"]);
    expect(p.runtime.get("t-1")?.snapshotHash).toBeUndefined();
  });

  it("says so in the linter, as the file to approve and as the line whose function does not resolve", async () => {
    const p = await open();
    const entry = browseWorkflows(p).workflows.find((w) => w.rootId === "guarded")!;
    expect(entry.needsApproval?.[0]?.symbols).toEqual(["judge.decide"]);
    expect(entry.issues).toEqual([
      expect.objectContaining({ stateId: "guarded", path: "environment.tools.bash", severity: "error", message: expect.stringMatching(/^the function 'judge\.decide' does not resolve: /) }),
    ]);
  });

  it("once approved, starts — the module frozen into the run's identity — and decides per call", async () => {
    const p = await open();
    userModules()!.approvals.approve(judgeFile, moduleHash(JUDGE));
    await prepareUserModules(p.paths, { rebuild: true });
    createTask(p, { title: "t", workflow: "guarded", id: "t-1" });
    const started = await beginTaskRun(p, "t-1");
    expect(permissionFunctionRefsOf(started.bundle)).toEqual(["judge.decide"]);
    // The module a toolset line reaches is in the digest, as a module a state calls would be.
    expect(started.bundle.moduleDigest).toBeTruthy();
    const run = runnerFor(p);
    expect(await run("judge.decide", request("git"))).toBe("allow");
    expect(await run("judge.decide", request("rm"))).toBe("deny");
  });

  it("refuses again once the file changes — and a run's function load refuses it too", async () => {
    const p = await open();
    userModules()!.approvals.approve(judgeFile, moduleHash(JUDGE));
    writeFileSync(judgeFile, JUDGE.replace('"git"', '"rm"'), "utf8");
    await prepareUserModules(p.paths, { rebuild: true });
    createTask(p, { title: "t", workflow: "guarded", id: "t-1" });
    await expect(beginTaskRun(p, "t-1")).rejects.toBeInstanceOf(ApprovalRequired);
    await expect(runnerFor(p)("judge.decide", request("git"))).rejects.toThrow(/not a known operation/);
  });

  it("reports a name no module declares as what it is — a typo, not something to approve", async () => {
    writeJson("workflows/guarded.json", guarded("judge.nope"));
    const p = await open();
    createTask(p, { title: "t", workflow: "guarded", id: "t-1" });
    const error = await beginTaskRun(p, "t-1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(ApprovalRequired);
    expect((error as Error).message).toMatch(/environment\.tools\.bash: the function 'judge\.nope' does not resolve/);
  });
});

describe("a function a project writes as a DOCUMENT", () => {
  it("an LLM call somebody configured — a prompt document — answers per call", async () => {
    writeJson("functions/llm_judge.json", {
      kind: "prompt",
      prompt: "Answer allow or deny for: {{.inputs.request.line}}",
      input: { request: { kind: "json", index: 0, schema: { type: "object" } } },
      output: { kind: "text", schema: { type: "string", enum: ["allow", "deny"] } },
    });
    const p = await open();
    const asked: string[] = [];
    const prompt = {
      start: (op: { user: string }) => {
        asked.push(op.user);
        return {
          result: Promise.resolve({ value: op.user.includes("git") ? "allow" : "deny", metrics: { startMs: 0, durationMs: 0, costUsd: 0, costSource: "unknown" } }),
          events: (async function* () {})(),
        };
      },
    } as never;
    const run = runnerFor(p, newRegistry(), prompt);
    expect(await run("llm_judge", request("git"))).toBe("allow");
    expect(await run("llm_judge", request("rm"))).toBe("deny");
    expect(asked).toEqual(["Answer allow or deny for: git status", "Answer allow or deny for: rm status"]);
  });

  it("an expression that ASKS THE PERSON through the approval prompt — answered both ways", async () => {
    writeJson("functions/ask_me.json", { $expr: `${APPROVAL_PROMPT_FUNCTION}(.inputs.request)` });
    const p = await open();
    for (const answer of ["allow", "deny"] as const) {
      const registry = newRegistry();
      const parked: HubRequest[] = [];
      const hub = new InteractionHub({ onRequest: (r) => void parked.push(r) });
      registerApprovalPrompt(registry, (component, inputs) => hub.ask(component, inputs, "t-1"));
      const pending = runnerFor(p, registry)("ask_me", request("npm"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({ component: APPROVAL_PROMPT_FUNCTION, taskId: "t-1", inputs: { request: request("npm") } });
      hub.submit(parked[0]!.requestId, { decision: answer });
      expect(await pending).toBe(answer);
    }
  });

  it("finds `smart` and the approval prompt with no file at all — they are JaiRA's", async () => {
    const p = await open();
    const options = workflowLoadOptions(p.paths);
    expect(() => loadPermissionFunction("smart", options)).not.toThrow();
    expect(() => loadPermissionFunction(APPROVAL_PROMPT_FUNCTION, options)).not.toThrow();
    expect(() => loadPermissionFunction("no_such_function", options)).toThrow(/not a known operation|resolves to no document/);
  });
});
