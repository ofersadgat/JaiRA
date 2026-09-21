/**
 * `jaira workflow list` / `lint` — the workflow browser on the headless surface
 * (DESIGN §11.1). `lint`'s exit code is the contract that matters: it is what a
 * pre-commit hook or CI job would gate on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaPaths, setBuiltInDir } from "@jaira/shared";
import { testHome } from "@jaira/testing";
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
  const code = await runCli(["--home", testHome(), ...args], io);
  return { code, out, err };
}

function writeWorkflow(relPath: string, content: string): void {
  writeFileSync(join(jairaPaths(dir, testHome()).workflowsDir, relPath), content, "utf8");
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

/**
 * The built-in layer from the headless surface (decision 0006, step 1).
 *
 * The CLI builds its paths inside `runCli`, so a fixture cannot be handed in as an argument: it is
 * registered for the process, which is the same call a host that kept the layer somewhere unusual
 * would make. What is checked is that the CLI's three verbs over workflows — list, lint, run — all
 * see a state that exists ONLY in what ships.
 */
describe("jaira workflow, over what ships", () => {
  let shipped: string;

  beforeEach(() => {
    shipped = mkdtempSync(join(tmpdir(), "jaira-cli-shipped-"));
    mkdirSync(join(shipped, "workflows", "debug"), { recursive: true });
    writeFileSync(
      join(shipped, "workflows", "debug", "shipped.json"),
      JSON.stringify({
        label: "Shipped self-test",
        inputs: { word: { schema: { type: "string" }, default: "hello" } },
        outputs: { word: { schema: { type: "string" }, binding: ".inputs.word" } },
      }),
      "utf8",
    );
    setBuiltInDir(shipped);
  });

  afterEach(() => {
    setBuiltInDir(undefined);
    rmSync(shipped, { recursive: true, force: true });
  });

  it("lists a workflow no layer of the person's defines", async () => {
    const res = await cli(["workflow", "list"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^debug\/shipped {2}\(Shipped self-test\)/m);
    expect(res.out).toMatch(/^feature\/plan {2}\(Planning\)/m);
  });

  it("lints it with everything else, and fails on a shipped state that is broken", async () => {
    expect((await cli(["workflow", "lint", "--json"])).code).toBe(0);
    writeFileSync(join(shipped, "workflows", "debug", "broken.json"), "{ half-shipped", "utf8");
    const res = await cli(["workflow", "lint", "--json"]);
    expect(res.code).toBe(1);
    expect((JSON.parse(res.out) as { unreadable: Array<{ file: string }> }).unreadable.map((f) => f.file)).toEqual([
      "debug/broken.json",
    ]);
  });

  it("runs it by bare id, and lets the project's copy of the same id win", async () => {
    const ran = await cli(["run", "--root", "debug/shipped", "--non-interactive"]);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("hello");

    mkdirSync(join(jairaPaths(dir, testHome()).workflowsDir, "debug"), { recursive: true });
    writeWorkflow(
      "debug/shipped.json",
      JSON.stringify({
        label: "Mine",
        inputs: { word: { schema: { type: "string" }, default: "overridden" } },
        outputs: { word: { schema: { type: "string" }, binding: ".inputs.word" } },
      }),
    );
    const again = await cli(["run", "--root", "debug/shipped", "--non-interactive"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("overridden");
    expect(again.out).not.toContain("hello");
  });
});
