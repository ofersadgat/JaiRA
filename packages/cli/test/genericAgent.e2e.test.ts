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
      output: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } },
    },
  },
};

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(jairaPaths(dir).configFile, JSON.stringify(config, null, 2), "utf8");
}

/**
 * A generic agent only runs at all under a policy that never escalates — SPEC
 * §11.3's built-in approval classes are all `require_approval`, so leaving the
 * built-ins on means §8.2 refuses a runtime that enforces nothing. Turning them off
 * is the project saying "this workspace is disposable", which is the only honest way
 * to run a policy-weak agent.
 */
function neverEscalates(agent: Record<string, unknown>): Record<string, unknown> {
  return { agents: { genericCli: [agent] }, policy: { builtins: false } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-generic-"));
  const paths = initProject(dir);
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
  const code = await runCli(args, io);
  return { code, out, err };
}

describe("generic-cli agent through the CLI", () => {
  it("runs the configured binary and returns its stdout as the state's output", async () => {
    writeConfig(neverEscalates({ command: process.execPath, args: [agentScript, "{prompt}"] }));

    const res = await cli(["run", "--root", "solo", "--inputs", '{"instruction":"tidy the imports"}']);

    expect(res.code).toBe(0);
    const report = JSON.parse(res.out) as {
      status: string;
      outputs?: { report?: { content?: string } };
    };
    expect(report.status).toBe("completed");
    // A blob-kind output slot is registered as an artifact, so the text arrives as
    // the artifact's inline content.
    expect(report.outputs?.report?.content).toBe("did: tidy the imports");
  });

  it("fails the state with the binary's own complaint when it exits non-zero", async () => {
    writeFileSync(agentScript, `process.stderr.write("model unavailable");\nprocess.exit(3);\n`, "utf8");
    writeConfig(neverEscalates({ command: process.execPath, args: [agentScript] }));

    const res = await cli(["run", "--root", "solo", "--inputs", '{"instruction":"x"}']);

    expect(res.code).toBe(1);
    expect(res.out).toMatch(/model unavailable/);
  });

  it("refuses the run when the project's policy can escalate (DESIGN §8.2)", async () => {
    // A generic binary has no permission callback, so a policy that can require
    // approval is meaningless against it — refusing beats running it unguarded.
    writeConfig({
      agents: { genericCli: [{ command: process.execPath, args: [agentScript, "{prompt}"] }] },
      policy: { rules: [{ match: { program: "git", subcommand: "push" }, action: "require_approval" }] },
    });

    const res = await cli(["run", "--root", "solo", "--inputs", '{"instruction":"x"}']);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/enforces no policy/);
    expect(res.err).toMatch(/solo/);
  });

  it("fails honestly when nothing is configured", async () => {
    const res = await cli(["run", "--root", "solo", "--inputs", '{"instruction":"x"}']);
    expect(res.code).toBe(1);
    // Not "ran some default binary" — the function simply is not registered.
    expect(res.out + res.err).toMatch(/generic-cli/);
  });
});
