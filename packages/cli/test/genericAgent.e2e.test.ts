/**
 * A `generic-cli` agent state, driven end to end through the CLI (DESIGN §8.1,
 * §14 phase 7).
 *
 * Two things this proves that a unit test cannot: the CLI *registers* agent
 * runtimes at all (it did not before phase 7 — an agent state failed as
 * "unregistered function" while the app ran it fine), and DESIGN §8.2's capability
 * gate runs on this surface too, refusing a policy-weak runtime under a policy that
 * can escalate.
 *
 * The "agent" is a tiny node script, so nothing is mocked below the Exec seam and
 * no real coding agent is needed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { jairaPaths } from "@jaira/shared";
import { writeWorkflowFiles } from "@jaira/runtime";
import { testHome } from "@jaira/testing";
import { runCli, type CliIo } from "../src/cli";

let dir: string;
let agentScript: string;

/**
 * A one-state workflow whose operation is the configured generic agent.
 *
 * Two authoring details this fixture exists to pin, both easy to get wrong:
 *
 *  - An **operation input is a parameter with a `binding` field**, not a bare
 *    binding. (`children.<key>.inputs` values *are* bare bindings, which is the
 *    trap.) Authored as `".inputs.instruction"` the slot silently resolves to
 *    empty, and the agent runs with no instruction at all.
 *  - A delegated agent returns **one string**, so its output slot must be
 *    `blob`-kind: the engine fills exactly one produced slot from a whole-value
 *    blob output, whereas a `json` output is read as a record of named outputs and
 *    the state fails as "did not produce required output".
 */
const AGENT_WORKFLOW = {
  solo: {
    label: "Delegate",
    inputs: { instruction: { schema: { type: "string" } } },
    outputs: { report: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
    operation: {
      kind: "function",
      function: "generic-cli",
      input: { prompt: { kind: "text", binding: ".inputs.instruction" } },
      output: { report: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } },
    },
  },
};

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(jairaPaths(dir, testHome()).settingsFile, JSON.stringify(config, null, 2), "utf8");
}

/**
 * A project's policy can always escalate now: a line no permission set judges answers to the shipped
 * `security/standard`, which asks — the built-ins switch that let a "disposable workspace" turn that off
 * is gone (the person, 2026-11-25: "there shouldnt be built in rules. all rules should go through
 * permissions"). So §8.2 refuses a binary that enforces nothing (`policyEnforcement: "none"`) on every
 * project. What gets past the gate is a registration whose own tools are declared off and pointed at the
 * bridge (`mcp.builtinsOff`, `policyEnforcement: "config"`) — held to the state's permission set there.
 */
function bridged(agent: Record<string, unknown>): Record<string, unknown> {
  return { agents: { genericCli: [{ ...agent, mcp: { env: { JAIRA_MCP_URL: "{mcpUrl}" }, builtinsOff: true } }] } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-generic-"));
  const paths = initProject(dir, testHome());
  writeWorkflowFiles(paths.workflowsDir, AGENT_WORKFLOW);
  // A stand-in coding agent: echoes what it was told to do.
  agentScript = join(dir, "agent.mjs");
  writeFileSync(
    agentScript,
    `const prompt = process.argv[2] ?? "";\nprocess.stdout.write("did: " + prompt);\n`,
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) };
  const code = await runCli(["--home", testHome(), ...args], io);
  return { code, out, err };
}

describe("generic-cli agent through the CLI", () => {
  it("lets a bridged registration past the gate — and then holds it to a permission set the state must declare", async () => {
    writeConfig(bridged({ command: process.execPath, args: [agentScript, "{prompt}"] }));

    const res = await cli(["run", "--root", "solo", "--inputs", '{"instruction":"tidy the imports"}']);

    // Past §8.2 (no "enforces no policy"), to the function itself, which refuses a call no set holds:
    // the binary would run with its own shell, which nothing here can put to the project's policy.
    expect(res.code).toBe(1);
    expect(res.err).not.toMatch(/enforces no policy/);
    const report = JSON.parse(res.out) as { status: string; failure?: { reason?: string } };
    expect(report.status).toBe("failed");
    expect(report.failure?.reason).toMatch(/generic-cli: this state declares no permission set/);
    expect(res.out).not.toMatch(/did: tidy the imports/);
  });

  it("refuses the run when the project's policy can escalate (DESIGN §8.2)", async () => {
    // A generic binary has no permission callback, so a policy that can require
    // approval is meaningless against it — refusing beats running it unguarded.
    writeConfig({
      agents: { genericCli: [{ command: process.execPath, args: [agentScript, "{prompt}"] }] },
      // A line no permission set judges answers to security/standard, which asks: this project can escalate.
    });

    const res = await cli(["run", "--root", "solo", "--inputs", '{"instruction":"x"}']);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/enforces no policy/);
    expect(res.err).toMatch(/solo/);
    // Refused before it ran (the binary would have echoed what it was told) — and that it was refused at all
    // is the proof the CLI registered it: an unregistered ref is not the gate's business.
    expect(res.out + res.err).not.toMatch(/did: /);
  });

  it("fails honestly when nothing is configured", async () => {
    const res = await cli(["run", "--root", "solo", "--inputs", '{"instruction":"x"}']);
    expect(res.code).toBe(1);
    // Not "ran some default binary" — the function simply is not registered.
    expect(res.out + res.err).toMatch(/generic-cli/);
  });
});
