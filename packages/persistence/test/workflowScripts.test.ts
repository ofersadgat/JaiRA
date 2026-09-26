/**
 * Workflow SCRIPTS in a project (hw SCRIPTS.md): a `.ts` under `.jaira/workflows/` is a state whose
 * structure is its code, compiled to the documents it is.
 *
 * What is defended here is JaiRA's half: the browser lists a script as the workflow it is, under the
 * file a person edits; a load finds the states its compile generates, in-tree and by id; the code it
 * IMPORTS is held to the same approval as a function module; and the run hands the engine what a
 * script needs to import it — so the import runs exactly when the module is approved.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecResult, JsonValue, ResolvedValue } from "@declarative-ai/exec";
import { moduleHash, validateBundle } from "@declarative-ai/hw";
import { buildPromptExecutor, executeWorkflow, newRegistry, statusOfResult, withPresetModels } from "@jaira/runtime";
import { shippedLayer, testHome } from "@jaira/testing";
import {
  browseWorkflows,
  canonicalModulePath,
  initProject,
  loadWorkflowBundle,
  moduleEntriesOf,
  openProject,
  prepareUserModules,
  readWorkflowFiles,
  resetUserModules,
  scriptModuleOptions,
  userModules,
  workflowLoadOptions,
  type Project,
} from "../src/index";

const SCRIPT = `import { shout } from "$/lib/shout";

export const meta = { name: "Greet", description: "Say hello, loudly." };

export default async function greet(who: string) {
  const line = await llm("Say hello to " + shout(who));
  return { line };
}
`;
const LIB = `export function shout(s: string): string { return s.toUpperCase(); }\n`;

let base: string;
let dir: string;
let project: Project | undefined;
let libFile: string;

async function open(): Promise<Project> {
  project = openProject(dir, { baseDir: testHome() });
  await prepareUserModules(project.paths, { rebuild: true });
  return project;
}

beforeEach(() => {
  resetUserModules();
  base = mkdtempSync(join(tmpdir(), "jaira-base-"));
  process.env.JAIRA_HOME = base;
  dir = mkdtempSync(join(tmpdir(), "jaira-scripts-"));
  const paths = initProject(dir, testHome());
  writeFileSync(join(paths.workflowsDir, "greet.ts"), SCRIPT, "utf8");
  // A helper sitting among the workflows: no `meta`, so it is code a script may import, not a workflow.
  writeFileSync(join(paths.workflowsDir, "helpers.ts"), `export const x = 1;\n`, "utf8");
  mkdirSync(join(dir, ".jaira", "lib"), { recursive: true });
  libFile = join(dir, ".jaira", "lib", "shout.ts");
  writeFileSync(libFile, LIB, "utf8");
});

afterEach(() => {
  project?.close();
  project = undefined;
  resetUserModules();
  delete process.env.JAIRA_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

/**
 * These load the TypeScript compiler and type-check real modules — a second alone, and several
 * seconds on a machine running the whole suite at once, which the default five-second budget does not
 * cover. A slower machine should make them slower, never fail them.
 */
describe("a workflow script in a project", { timeout: 30_000 }, () => {
  it("is listed as the workflow it is, under the script a person edits — and a helper beside it is not", async () => {
    const p = await open();
    const browser = browseWorkflows(p);
    const roots = browser.workflows.map((w) => w.rootId);
    expect(roots).toContain("greet");
    expect(roots.some((id) => id.startsWith("greet/"))).toBe(false);
    expect(roots).not.toContain("helpers");
    expect(browser.files.find((f) => f.stateId === "greet")).toMatchObject({ file: "greet.ts", label: "Greet" });
  });

  it("loads with the states its compile generates, in-tree and by id, and validates", async () => {
    const p = await open();
    const files = readWorkflowFiles(p.paths.workflowsDir);
    expect(Object.keys(files).sort()).toEqual(["greet.json", "greet/call_0.json"]);
    const bundle = loadWorkflowBundle(files, "greet", workflowLoadOptions(p.paths));
    expect(Object.keys(bundle.states).sort()).toEqual(["greet", "greet/call_0"]);
    expect(validateBundle(bundle).errors).toEqual([]);
    // A state its compile generates is found by id too — how a base or built-in layer's script loads.
    expect(workflowLoadOptions(p.paths).loadState!("greet/call_0")).toMatchObject({ label: expect.stringMatching(/^llm: Say hello to/) });
  });

  it("holds the code it imports to the approval a function module needs — it runs only once approved", async () => {
    const p = await open();
    const bundle = loadWorkflowBundle(readWorkflowFiles(p.paths.workflowsDir), "greet", workflowLoadOptions(p.paths));
    expect(moduleEntriesOf(bundle)).toEqual([canonicalModulePath(libFile)]);
    const run = async () =>
      executeWorkflow({
        bundle,
        inputs: { who: "ada" },
        registry: newRegistry(),
        prompt: buildPromptExecutor({ fakeRules: [{ promptIncludes: "ADA", output: "hello, ADA" }] }),
        scripts: scriptModuleOptions()!,
      });
    const refused = await run();
    expect(statusOfResult(refused)).toBe("failed");
    expect(JSON.stringify(refused)).toMatch(/shout\.ts/);

    userModules()!.approvals.approve(canonicalModulePath(libFile), moduleHash(LIB));
    const ran = await run();
    expect(statusOfResult(ran)).toBe("completed");
    expect((ran as { value?: unknown }).value).toEqual({ line: "hello, ADA" });
  });

  it("runs agent() under the built-in agent preset — the first coding agent this machine has", async () => {
    // The presets JaiRA really ships, not the empty built-in layer every other test runs on.
    shippedLayer();
    const p = await open();
    writeFileSync(join(p.paths.workflowsDir, "fix.ts"), `export const meta = { name: "Fix" };
export default async function fix() { return await agent("fix the build"); }
`, "utf8");
    const bundle = loadWorkflowBundle(readWorkflowFiles(p.paths.workflowsDir), "fix", workflowLoadOptions(p.paths));
    // The model each call reached the executor with — after the preset chose.
    const seen: string[] = [];
    const leaf = {
      capabilities: { memoizable: true },
      metrics: { merge: (a: unknown) => a },
      start: (op: { config?: { model?: string } }) => {
        seen.push(op.config?.model ?? "");
        return { events: [], result: Promise.resolve({ value: "fixed", metrics: { durationMs: 0 } } as unknown as ExecResult<ResolvedValue>), cancel: async () => undefined };
      },
    };
    // A machine with Codex and nothing else: both Claude Code routes are passed over.
    const available = (model: string) => (model === "codex-cli/default" ? { available: true as const, route: "codex-cli" } : { available: false as const, why: "not set up here" });
    const presets = p.config.models.presets as Record<string, Record<string, JsonValue>>;
    const result = await executeWorkflow({
      bundle,
      inputs: {},
      registry: newRegistry(),
      prompt: withPresetModels({ presets, available }, undefined, leaf as never) as never,
      scripts: scriptModuleOptions()!,
    });
    expect(statusOfResult(result)).toBe("completed");
    expect(seen).toEqual(["codex-cli/default"]);
  });

  it("recompiles when a file it read changes, and reuses the compile while none has", async () => {
    const p = await open();
    const first = readWorkflowFiles(p.paths.workflowsDir)["greet.json"];
    expect(readWorkflowFiles(p.paths.workflowsDir)["greet.json"]).toBe(first);
    writeFileSync(join(p.paths.workflowsDir, "greet.ts"), SCRIPT.replace('"Greet"', '"Greet loudly"'), "utf8");
    expect(readWorkflowFiles(p.paths.workflowsDir)["greet.json"]).toMatchObject({ label: "Greet loudly" });
  });
});
