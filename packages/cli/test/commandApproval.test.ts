/**
 * A run started by `jaira` is governed as an app run is (tool-policy.md): the project's policy, its
 * scopes and its audit, and an approver — the person at the terminal, or a refusal that says why
 * nobody was asked and what would let the call run.
 *
 * The terminal is a DOUBLE: `io.ask` is what `main.ts` supplies only when stdin and stdout are both a
 * TTY, so an `io` that carries one IS a run at a terminal, and one without is a pipe.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { initProject, loadPermissionFunction, openProject } from "@jaira/persistence";
import {
  ApprovalHub,
  compileRunPolicy,
  decideCommand,
  handedToClaude,
  handedToCodex,
  newRegistry,
  permissionFunctionRunner,
  registerApprovalPrompt,
  type ApprovalRequest,
  type HandedEnvironment,
  type PermissionFunctionRunner,
} from "@jaira/runtime";
import { APPROVAL_PROMPT_FUNCTION, defaultConfig, lowerPermissionSet, parsePermissionSet, type PermissionFunctionRequest } from "@jaira/shared";
import { runCli, type CliIo } from "../src/cli";
import { cliApprovals, governRun, renderApproval, unattendedRefusal } from "../src/commandApprover";

let dir: string;

/**
 * A harmless line a BUILT-IN asks about: naming `.env` is touching a credentials path, and `node
 * --version` prints its version and reads nothing. `run_command` has no permission set in reach, so the
 * built-ins are what judge it.
 */
const LINE = "node --version .env";
const ASKED = "the command touches a credentials path";

function write(relPath: string, body: unknown): void {
  const file = join(dir, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}

/** A `run_command` state. */
function commandState(command: string): unknown {
  return {
    label: `run ${command}`,
    outputs: { stdout: { schema: { type: "string" }, binding: ".operation.output.stdout" } },
    operation: { kind: "function", function: "run_command", args: { command }, output: { stdout: { schema: { type: "string" } } } },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-cli-approve-"));
  initProject(dir, testHome());
  write(".jaira/workflows/check.json", commandState(LINE));
  write(".jaira/workflows/push.json", commandState("git push origin main"));
  // Two states, one line: an answer "for this run" is asked once and remembered for the second.
  write(".jaira/workflows/twice.json", { label: "Twice", outputs: {}, children: { a: {}, b: {} }, sequence: ["a", "b"] });
  write(".jaira/workflows/twice/a.json", commandState(LINE));
  write(".jaira/workflows/twice/b.json", commandState(LINE));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A CLI `io`; `answers` makes it a terminal, answered in order. */
function io(answers?: string[]): CliIo & { out: () => string; err: () => string; asked: () => string[] } {
  let out = "";
  let err = "";
  const asked: string[] = [];
  return {
    cwd: dir,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    ...(answers !== undefined
      ? {
          ask: async (question: string) => {
            asked.push(question);
            err += question;
            return answers.shift();
          },
          confirm: async () => false,
        }
      : {}),
    out: () => out,
    err: () => err,
    asked: () => asked,
  };
}

const run = (cli: CliIo, root: string, ...flags: string[]) => runCli(["--home", testHome(), "run", "--root", root, ...flags], cli);
const reportOf = (cli: { out: () => string; err: () => string }) => {
  try {
    return JSON.parse(cli.out()) as { status: string; taskId?: string; outputs?: Record<string, unknown>; failure?: { reason?: string } };
  } catch {
    throw new Error(`no report on stdout; stderr said:\n${cli.err()}`);
  }
};

describe("a run started by jaira, at a terminal", () => {
  it("ASKS, showing the line taken apart into its parts — and a yes runs it", async () => {
    const cli = io(["y"]);
    const code = await run(cli, "check");
    const report = reportOf(cli);
    expect(report.status, cli.err()).toBe("completed");
    expect(code).toBe(0);
    expect(String(report.outputs?.["stdout"])).toMatch(/^v\d+\./);
    expect(cli.asked()).toHaveLength(1);
    // What the app draws, in terminal clothing: the line, which part each character is, the words
    // its rule matched, and a row per part with its subject, verdict and what decided it.
    expect(cli.err()).toContain(`$ ${LINE}`);
    expect(cli.err()).toMatch(/\n {6}1{19}\n {6}\^{4}\n/);
    expect(cli.err()).toMatch(/1\s+node --version \.env\s+node\s+ASKS\s+built-in: the command touches a credentials path/);
    expect(cli.asked()[0]).toMatch(/\[y\] allow once {2}\[r\] allow node for this run {2}\[n\] deny/);
  });

  it("REFUSES on a no, and the state fails saying the command was refused", async () => {
    const cli = io(["n"]);
    const code = await run(cli, "check");
    expect(code).toBe(1);
    const report = reportOf(cli);
    expect(report.status).toBe("failed");
    expect(JSON.stringify(report)).toContain(`command refused: ${ASKED}`);
  });

  it("remembers an answer FOR THIS RUN by its parts: the second state's line is not asked about", async () => {
    const cli = io(["r"]);
    const code = await run(cli, "twice");
    expect(reportOf(cli).status, cli.err()).toBe("completed");
    expect(code).toBe(0);
    expect(cli.asked()).toHaveLength(1);
  });

  it("audits every decision into command_log, as an app run does", async () => {
    const cli = io(["y"]);
    await run(cli, "check");
    const project = openProject(dir, { baseDir: testHome() });
    try {
      const rows = project.commands.list(reportOf(cli).taskId!);
      expect(rows).toEqual([expect.objectContaining({ tool: "bash", command: LINE, decidedBy: "policy", reason: ASKED })]);
    } finally {
      project.close();
    }
  });

  it("runs a state whose environment is a REFERENCED block holding a permission set — which used to fail to load", async () => {
    write(".jaira/envs/reader.json", { tools: { read_file: "allow", other: "deny" } });
    write(".jaira/workflows/refenv.json", { ...(commandState(LINE) as Record<string, unknown>), environment: "$/envs/reader" });
    const cli = io(["y"]);
    expect(await run(cli, "refenv")).toBe(0);
    expect(reportOf(cli).status).toBe("completed");
  });

  it("never asks under --approve deny", async () => {
    const cli = io(["y"]);
    expect(await run(cli, "check", "--approve", "deny")).toBe(1);
    expect(cli.asked()).toEqual([]);
    expect(reportOf(cli).failure?.reason ?? JSON.stringify(reportOf(cli))).toMatch(/--approve deny refuses every approval; pass --approve ask at a terminal to be asked/);
  });
});

describe("a run started by jaira, with nobody to ask", () => {
  it("REFUSES, naming what would let the line run — the terminal, or the setting that asked", async () => {
    const cli = io();
    expect(await run(cli, "check")).toBe(1);
    const reason = JSON.stringify(reportOf(cli));
    expect(reason).toContain(`command refused: ${ASKED}; nobody was asked: this jaira run has no terminal`);
    expect(reason).toMatch(/run it at a terminal to be asked/);
    // A built-in asked and no permission set judges `run_command`'s line, so only turning the built-ins off answers it.
    expect(reason).toMatch(/nothing short of turning the built-ins off lets \\"node\\" run unasked here/);
    expect(cli.err()).toMatch(/^refused: bash: node --version \.env — nobody was asked/m);
  });

  it("refuses a BUILT-IN ask with the setting that would answer it, and runs nothing", async () => {
    const cli = io();
    expect(await run(cli, "push", "--non-interactive")).toBe(1);
    const reason = JSON.stringify(reportOf(cli));
    expect(reason).toMatch(/--non-interactive refuses every approval/);
    expect(reason).toContain('\\"functions\\": { \\"bash\\": { \\"builtins\\": false } } in .jaira/settings.json');
    // `run_command` has no permission set in reach, so a permission set line would be advice that changes nothing.
    expect(reason).not.toMatch(/permission set/);
    // …and the setting it names does answer it: with the built-ins off, the line is allowed.
    expect(decideCommand({ builtins: false }, "git push origin main").action).toBe("allow");
    expect(decideCommand({}, "git push origin main").action).toBe("require_approval");
  });

  it("refuses --approve ask with no terminal as a usage error, before anything is made", async () => {
    const cli = io();
    expect(await run(cli, "check", "--approve", "ask")).toBe(2);
    expect(cli.err()).toMatch(/--approve ask needs a terminal/);
    expect(cli.out()).toBe("");
    expect(await run(io(), "check", "--approve", "maybe")).toBe(2);
  });
});

describe("the request as a person reads it", () => {
  it("says what a tool call is about when it is not a line, and how to allow it for good", () => {
    const request: ApprovalRequest = { requestId: "r", tool: "write_file", input: { path: "notes.txt", content: "x" }, sessionId: "s", at: 0 };
    expect(renderApproval(request)).toContain("path: notes.txt");
    expect(unattendedRefusal(request, "no-terminal")).toMatch(/a "write_file": "allow" line in the state's permission set$/);
  });

  it("names the permission set line too where a PERMISSION_SET judged the line — an agent's shell, not run_command", () => {
    const command = "git push origin main";
    const parts = { ...decideCommand({}, command).parts, permissionSet: "$/permission-sets/feature/build" };
    const request: ApprovalRequest = { requestId: "r", tool: "bash", command, input: { command }, sessionId: "s", at: 0, parts };
    expect(unattendedRefusal(request, "flag")).toMatch(/write a "git push": "allow" line in the permission set \$\/permission-sets\/feature\/build$/);
    // The line, numbered by part, with the words that matched underneath, and the permission set named.
    const drawn = renderApproval(request);
    expect(drawn).toContain(`$ ${command}`);
    expect(drawn).toMatch(/1\s+git push origin main\s+git push\s+ASKS\s+built-in: pushes publish work/);
    expect(drawn).toContain("permission set: $/permission-sets/feature/build");
  });
});

/**
 * Permission sets hold in a CLI run EXACTLY as in an app run — measured through the real chain
 * (`handedToClaude` / `handedToCodex`), with each host's policy and approver as it builds them.
 */
describe("permission sets under a CLI run", () => {
  const config = defaultConfig();
  const lowered = (map: Record<string, unknown>): HandedEnvironment => {
    const { tools, permissions } = lowerPermissionSet(parsePermissionSet(map).permissionSet);
    return { tools, permissions };
  };
  const ENVIRONMENTS: Record<string, HandedEnvironment> = {
    "read-only": lowered({ read_file: "allow", glob: "allow", grep: "allow", other: "deny" }),
    "a shell with named commands": lowered({ bash: "deny", "git status": "allow", "node": "ask", read_file: "allow" }),
    "a native built-in, other ask": lowered({ edit: { mode: "ask", implementation: "native" }, bash: "ask", other: "ask" }),
    "a shell a FUNCTION judges": lowered({ bash: { function: "judge" }, write_file: { function: "judge" }, read_file: "allow", other: "deny" }),
    "no permission set": {},
  };
  /** What each host's runner would answer for `judge`: git and write_file may, nothing else. */
  const judge: PermissionFunctionRunner = async (_reference, request) => (request.part?.program === "git" || request.tool === "write_file" ? "allow" : "deny");
  /** The app's `startRun`: the run recipe, and its hub's approver — which refuses when nobody is listening. */
  const app = () => {
    const hub = new ApprovalHub();
    return { policy: compileRunPolicy(config, { workspaceRoot: dir, grants: hub.grants("t") }), approve: hub.approver({ taskId: "t", functions: { run: judge } }) };
  };
  /** The CLI's, with nobody at a terminal — a refusal that never waits on a person. */
  const cli = () => governRun(config, cliApprovals({ mode: "deny", unasked: "no-terminal", write: () => {} }), { workspaceRoot: dir, functions: { run: judge } });

  it.each(Object.keys(ENVIRONMENTS))("claude is handed the same under %s", async (name) => {
    const environment = ENVIRONMENTS[name]!;
    expect(await handedToClaude(environment, { run: cli() })).toEqual(await handedToClaude(environment, { run: app() }));
  });

  it.each(Object.keys(ENVIRONMENTS))("codex is handed the same under %s, by a route and as a function", async (name) => {
    const environment = ENVIRONMENTS[name]!;
    for (const via of ["route", "function"] as const) {
      expect(await handedToCodex(environment, { via, run: cli() })).toEqual(await handedToCodex(environment, { via, run: app() }));
    }
  });

  it("was NOT the same before: a run with no policy and no approver judges no shell line", async () => {
    const environment = ENVIRONMENTS["a shell with named commands"]!;
    const before = await handedToClaude(environment, { run: {} });
    const now = await handedToClaude(environment, { run: cli() });
    // `git status` is allowed by its line, and `rm notes.txt` (write_file, which the map does not hold) asks.
    expect(now.shell).toMatchObject({ command: "allow", write: "ask" });
    expect(before.shell).not.toEqual(now.shell);
  });

  it("asks a line's FUNCTION before anybody, in a CLI run as in the app — nobody at the terminal is asked", async () => {
    const handed = await handedToClaude(ENVIRONMENTS["a shell a FUNCTION judges"]!, { run: cli() });
    // `git status` the function allows, `rm` it refuses; `cat` is the map's read_file line.
    expect(handed.shell).toMatchObject({ command: "allow", read: "allow", write: "deny" });
    expect(handed.tools["write_file"]).toMatchObject({ decision: "allow" });
  });
});

/**
 * `approve_tool_call` in a CLI run (decision 0007, amended 2026-09-22): the approval prompt a function
 * calls is put to the person at the terminal — the same queue as the approvals — and answered allow or
 * deny; with nobody to ask it fails, which leaves the call asking, and the hub refuses it saying why.
 */
describe("the approval prompt a function calls, at a terminal", () => {
  const config = defaultConfig();
  const REQUEST: PermissionFunctionRequest = {
    tool: "bash",
    subject: "npm publish",
    function: "smart",
    input: { command: "npm publish" },
    line: "npm publish",
    part: { text: "npm publish", kind: "command", subject: "npm publish", span: { start: 0, end: 11 }, program: "npm", subcommand: "publish", args: [], flags: [] },
    state: "release",
    cwd: "/work",
  };
  const NO_PROMPT = { start: () => ({ result: Promise.resolve({ error: { classification: "permanent", reason: "no model here" } }) }) } as never;
  /** The CLI's runner over one registry holding the terminal's approval prompt, as `jaira run` builds it. */
  const runnerFor = (approvals: ReturnType<typeof cliApprovals>) => {
    const registry = newRegistry();
    registerApprovalPrompt(registry, approvals.prompt);
    return permissionFunctionRunner({ registry, prompt: NO_PROMPT, load: (reference) => loadPermissionFunction(reference, {}) });
  };

  it.each([
    ["y", "allow"],
    ["n", "deny"],
    ["", "deny"],
  ] as const)("answers %j as %s, showing which function asks about which call", async (typed, decision) => {
    let shown = "";
    const approvals = cliApprovals({ mode: "ask", ask: async () => typed, write: (text) => (shown += text) });
    expect(await runnerFor(approvals)(APPROVAL_PROMPT_FUNCTION, REQUEST)).toBe(decision);
    expect(shown).toContain("the function 'smart' asks you");
    expect(shown).toContain("$ npm publish");
    expect(shown).toContain("state release · in /work");
  });

  it("fails with nobody to ask — and the call it was about is refused by the hub, saying why", async () => {
    const approvals = cliApprovals({ mode: "deny", unasked: "non-interactive", write: () => {} });
    const result = await approvals.prompt(APPROVAL_PROMPT_FUNCTION, { request: REQUEST as never });
    expect(result).toMatchObject({ error: { reason: expect.stringMatching(/^nobody can be asked — --non-interactive refuses every approval/) } });
    const run = governRun(config, approvals, { workspaceRoot: dir, functions: { run: runnerFor(approvals) } });
    const handed = await handedToClaude(lowerPermissionSet(parsePermissionSet({ bash: { function: APPROVAL_PROMPT_FUNCTION }, other: "deny" }).permissionSet), { run });
    expect(handed.shell).toMatchObject({ command: "ask" });
  });

  it("lets a line through that the person allows at the terminal, and refuses one they deny", async () => {
    const environment = lowerPermissionSet(parsePermissionSet({ bash: { function: APPROVAL_PROMPT_FUNCTION }, other: "deny" }).permissionSet);
    const handedWith = (typed: string) => {
      const approvals = cliApprovals({ mode: "ask", ask: async () => typed, write: () => {} });
      return handedToClaude(environment, { run: governRun(config, approvals, { workspaceRoot: dir, functions: { run: runnerFor(approvals) } }) });
    };
    // The command the person allows runs — answered by the prompt, so the hub asked nobody; a file part
    // or a script answers to its own line, which this map leaves to `other: deny`.
    expect((await handedWith("y")).shell).toEqual({ command: "allow", read: "deny", write: "deny", script: "deny" });
    // Every line they deny is refused, and a shell every line of which is refused is not a shell.
    const denied = await handedWith("n");
    expect(denied.shell).toEqual({});
    expect(denied.tools["bash"]).toEqual({ reachable: false, via: [] });
  });
});
