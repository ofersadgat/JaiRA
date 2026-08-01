/**
 * `jaira workflow list` / `lint` — the workflow browser on the headless surface
 * (DESIGN §11.1). `lint`'s exit code is the contract that matters: it is what a
 * pre-commit hook or CI job would gate on.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaPaths } from "@jaira/shared";
import { runCli, type CliIo } from "../src/cli";
import { makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(() => {
  dir = makePlanningProject();
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

function writeWorkflow(relPath: string, content: string): void {
  writeFileSync(join(jairaPaths(dir).workflowsDir, relPath), content, "utf8");
}

describe("jaira workflow", () => {
  it("lists the project's workflows with a health marker", async () => {
    const res = await cli(["workflow", "list"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^feature\/plan {2}\(Planning\) {2}✓/m);
    expect(res.out).toMatch(/states {2}\d+/);
  });

  it("lints clean and exits 0", async () => {
    const res = await cli(["workflow", "lint", "--json"]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toEqual({ errors: [], unreadable: [], unreachable: [] });
  });

  it("exits 1 with the offending state named when a workflow is broken", async () => {
    writeWorkflow(
      "feature/plan/goals.json",
      JSON.stringify({
        label: "Goals",
        outputs: { goals: { kind: "text" } },
        operation: { kind: "prompt", template: "list goals" },
        // A guard that infers to text, not boolean (§7.2 is strict here).
        transitions: [{ to: "terminate.success", when: ".outputs.goals" }],
      }),
    );
    const res = await cli(["workflow", "lint", "--json"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.out) as { errors: Array<{ rootId: string }> };
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.rootId).toBe("feature/plan");
  });

  it("fails lint for a file that will not parse", async () => {
    writeWorkflow("scratch.json", "{ half-written");
    const res = await cli(["workflow", "lint", "--json"]);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.out) as { unreadable: Array<{ file: string }> };
    expect(parsed.unreadable.map((f) => f.file)).toEqual(["scratch.json"]);
  });

  it("reports an unknown subcommand as a usage error", async () => {
    expect((await cli(["workflow", "explode"])).code).toBe(2);
  });
});
