/**
 * `jaira workflow check` — the project's workflows against an English description
 * of the flow the user wants.
 *
 * The exit code is the contract: 0 only when every requirement in the document is
 * satisfied, so this is what a pre-commit hook or CI job gates on. The check runs
 * through the ordinary engine, so `--fake` scripts it end to end with no provider —
 * which is also how the disagreement case below is testable at all.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaPaths } from "@jaira/shared";
import { conformanceRules, type ConformanceFinding, type ConformanceRequirement } from "@jaira/runtime";
import { runCli, type CliIo } from "../src/cli";
import { makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(() => {
  dir = makePlanningProject();
  writeFileSync(
    join(dir, "workflow.md"),
    "# Planning\n\nTurn the issue into goals, then write a plan, then critique it.\n",
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

const REQUIREMENTS: ConformanceRequirement[] = [
  { id: "R1", requirement: "the issue becomes goals", category: "step", quote: "Turn the issue into goals" },
  { id: "R2", requirement: "a human approves the plan", category: "human_gate", quote: "then critique it" },
];

const satisfied = (id: string, states: string[]): ConformanceFinding => ({
  id,
  requirement: REQUIREMENTS.find((r) => r.id === id)!.requirement,
  status: "satisfied",
  states,
  detail: "the state does this",
});

const missing = (id: string): ConformanceFinding => ({
  id,
  requirement: REQUIREMENTS.find((r) => r.id === id)!.requirement,
  status: "missing",
  states: [],
  detail: "no state renders a gate to a person",
});

/** Write a fake script for the two prompt states and return the `--fake` argument. */
function fake(findings: ConformanceFinding[], verdict: "conforms" | "gaps" | "diverges", extras = []): string {
  writeFileSync(
    join(dir, "fake.json"),
    JSON.stringify(conformanceRules({ requirements: REQUIREMENTS, verdict, findings, extras })),
    "utf8",
  );
  return "@fake.json";
}

describe("jaira workflow check", () => {
  it("exits 0 and lists every requirement when the workflows implement the description", async () => {
    const res = await cli([
      "workflow",
      "check",
      "--fake",
      fake([satisfied("R1", ["feature/plan/goals"]), satisfied("R2", ["feature/plan/critique"])], "conforms"),
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("conformance: conforms");
    expect(res.out).toMatch(/✓ R1 {2}the issue becomes goals/);
    expect(res.out).toContain("states: feature/plan/goals");
    // The document and the workflows it was checked against are both named.
    expect(res.out).toContain("workflow.md");
    expect(res.out).toContain("feature/plan");
  });

  it("exits 1 naming the requirement nothing implements", async () => {
    const res = await cli([
      "workflow",
      "check",
      "--fake",
      fake([satisfied("R1", ["feature/plan/goals"]), missing("R2")], "gaps"),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("conformance: gaps");
    expect(res.out).toMatch(/✗ R2 {2}a human approves the plan {2}— missing/);
    expect(res.out).toContain("no state renders a gate to a person");
    // Unsatisfied findings come first — the reason the command was run is at the top.
    expect(res.out.indexOf("R2")).toBeLessThan(res.out.indexOf("R1"));
  });

  it("believes the findings over a verdict that contradicts them", async () => {
    const res = await cli(["workflow", "check", "--fake", fake([missing("R2")], "conforms")]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("reported 'conforms' but its own findings say 'gaps'");
    expect(res.out).toContain("conformance: gaps");
  });

  it("prints the findings as JSON, with the workflows it checked", async () => {
    const res = await cli([
      "workflow",
      "check",
      "--json",
      "--fake",
      fake([satisfied("R1", ["feature/plan/goals"]), missing("R2")], "gaps"),
    ]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.out) as {
      verdict: string;
      workflows: string[];
      requirements: ConformanceRequirement[];
      findings: ConformanceFinding[];
    };
    expect(parsed.verdict).toBe("gaps");
    expect(parsed.workflows).toEqual(["feature/plan"]);
    expect(parsed.requirements.map((r) => r.id)).toEqual(["R1", "R2"]);
    expect(parsed.findings.find((f) => f.id === "R2")!.status).toBe("missing");
  });

  it("checks the file it is given, and says where it looked when there is none", async () => {
    writeFileSync(join(dir, "desired.md"), "Do the thing.\n", "utf8");
    const named = await cli(["workflow", "check", "desired.md", "--fake", fake([satisfied("R1", ["x"])], "conforms")]);
    expect(named.code).toBe(0);
    expect(named.out).toContain("desired.md");

    rmSync(join(dir, "workflow.md"));
    const missingDoc = await cli(["workflow", "check"]);
    expect(missingDoc.code).toBe(1);
    expect(missingDoc.err).toContain("no workflow description at");
    expect(missingDoc.err).toContain("workflow.md");
  });

  it("refuses to judge a project whose workflows do not load", async () => {
    writeFileSync(join(jairaPaths(dir).workflowsDir, "scratch.json"), "{ half-written", "utf8");
    const res = await cli(["workflow", "check", "--fake", fake([satisfied("R1", ["x"])], "conforms")]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("cannot check conformance");
    expect(res.err).toContain("scratch.json");
    expect(res.err).toContain("jaira workflow lint");
  });

  it("rejects an unknown --workflow root instead of checking nothing", async () => {
    const res = await cli([
      "workflow",
      "check",
      "--workflow",
      "feature/nope",
      "--fake",
      fake([satisfied("R1", ["x"])], "conforms"),
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("unknown workflow 'feature/nope'");
    expect(res.err).toContain("feature/plan");
  });
});
