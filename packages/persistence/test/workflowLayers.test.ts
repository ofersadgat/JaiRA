/**
 * Every workflow along the settings' six layers (decision 0023, amended 2026-11-18): a bare state id is
 * found in the most specific layer that has a file for it — you in the project, Just you, the project on
 * this machine, this machine, the project, Shared, what ships — and an id is the file's path under the
 * `workflows/` it was found in. A child, a `./` reference and a `children[].state` are ids too, so each is
 * found nearest first wherever its parent came from; a bare `$/…` document reference searches the layer
 * roots in the same order. A project, Shared and what ships with nothing in the newer layers load as
 * they always did.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jairaBasePaths, projectSettingsKey, setBuiltInDir, type WorkflowLayer } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { browseWorkflows, initProject, loadWorkflowBundle, openProject, readRepositoryIdentity, readWorkflowFiles, workflowLoadOptions, type Project } from "../src/index";

let dir: string;
let builtIn: string;
let project: Project | undefined;

function write(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
}

/** A layer's root. */
function rootOf(layer: WorkflowLayer): string {
  const base = jairaBasePaths(testHome()).baseDir;
  switch (layer) {
    case "projectYou":
      return join(base, "projects", projectSettingsKey(readRepositoryIdentity(dir), dir));
    case "you":
      return join(base, "personal");
    case "projectMachine":
      return join(dir, ".jaira", "local");
    case "machine":
      return join(base, "machine");
    case "project":
      return join(dir, ".jaira");
    case "base":
      return base;
    case "system":
      return builtIn;
  }
}

/** A state in a layer: `{ label }` plus whatever else it says. */
function state(layer: WorkflowLayer, id: string, body: Record<string, unknown> = {}): void {
  write(join(rootOf(layer), "workflows", `${id}.json`), { label: `${id} from ${layer}`, operation: { kind: "prompt", prompt: "go" }, ...body });
}

const open = (): Project => (project = openProject(dir, { baseDir: testHome() }));

/** Load `rootId` the way a run does, and say which layer each state came from (by its label). */
function load(rootId: string): Record<string, unknown> {
  const p = project ?? open();
  const bundle = loadWorkflowBundle(readWorkflowFiles(p.paths.workflowsDir), rootId, workflowLoadOptions(p.paths));
  return Object.fromEntries(Object.entries(bundle.states).map(([id, s]) => [id, s.label]));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-workflow-layers-"));
  // A built-in layer of this test's own: what ships is never written to.
  builtIn = mkdtempSync(join(tmpdir(), "jaira-workflow-layers-builtin-"));
  setBuiltInDir(builtIn);
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  setBuiltInDir(undefined);
  rmSync(dir, { recursive: true, force: true });
  rmSync(builtIn, { recursive: true, force: true });
});

describe("an ordinary workflow, along the six layers", () => {
  it("is read from the most specific layer that has it, at every step down the chain", () => {
    const order: WorkflowLayer[] = ["system", "base", "project", "machine", "projectMachine", "you", "projectYou"];
    for (const layer of order) {
      state(layer, "feature/review");
      expect(load("feature/review")).toEqual({ "feature/review": `feature/review from ${layer}` });
    }
  });

  it("is listed by the browser where it is read, every other copy shadowed by it", () => {
    state("project", "feature/review");
    state("base", "feature/review");
    state("machine", "feature/review");
    const browser = browseWorkflows(open());
    expect(browser.workflows.find((w) => w.rootId === "feature/review")).toMatchObject({ layer: "machine", label: "feature/review from machine" });
    expect(browser.files.filter((f) => f.stateId === "feature/review").map((f) => [f.layer, f.shadowedBy ?? null])).toEqual([
      ["base", "machine"],
      ["machine", null],
      ["project", "machine"],
    ]);
  });

  it("keeps an old project + Shared + built-in setup as it was: the project's copy, then Shared's, then what ships", () => {
    state("system", "feature/review");
    state("base", "feature/review");
    state("base", "feature/shared-only");
    state("project", "feature/review");
    expect(load("feature/review")).toEqual({ "feature/review": "feature/review from project" });
    expect(load("feature/shared-only")).toEqual({ "feature/shared-only": "feature/shared-only from base" });
    // The browser's version of it is the run's.
    const p = project!;
    const entry = browseWorkflows(p).workflows.find((w) => w.rootId === "feature/review");
    expect(entry).toMatchObject({ layer: "project" });
    expect(entry?.snapshotHash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("children and references across layers", () => {
  it("a parent in Just you finds its children nearest first — one in the project, one in Shared, one Just you overrides", () => {
    state("you", "feature/plan", { operation: undefined, sequence: ["draft", "critique", "polish"], children: { draft: {}, critique: { state: "./critique" }, polish: { state: "feature/plan/polish" } } });
    state("project", "feature/plan/draft");
    state("base", "feature/plan/critique");
    state("project", "feature/plan/polish");
    state("you", "feature/plan/polish");
    expect(load("feature/plan")).toEqual({
      "feature/plan": "feature/plan from you",
      "feature/plan/draft": "feature/plan/draft from project",
      "feature/plan/critique": "feature/plan/critique from base",
      "feature/plan/polish": "feature/plan/polish from you",
    });
  });

  it("a project's parent whose child Just you overrides runs Just you's child — the parent stays the project's", () => {
    state("project", "feature/plan", { operation: undefined, children: { draft: { state: "./draft" } } });
    state("project", "feature/plan/draft");
    state("you", "feature/plan/draft");
    expect(load("feature/plan")).toEqual({ "feature/plan": "feature/plan from project", "feature/plan/draft": "feature/plan/draft from you" });
  });

  it("children by directory include a newer layer's file under the parent's id", () => {
    state("project", "feature/plan", { operation: undefined });
    state("project", "feature/plan/draft");
    state("machine", "feature/plan/extra");
    expect(Object.keys(load("feature/plan")).sort()).toEqual(["feature/plan", "feature/plan/draft", "feature/plan/extra"]);
  });

  it("a named root folds back to the bare id — `$YOU/workflows/…` is the same state as its id, found nearest first", () => {
    state("project", "feature/plan", { operation: undefined, children: { draft: { state: "$YOU/workflows/feature/plan/draft" } } });
    state("you", "feature/plan/draft");
    state("projectYou", "feature/plan/draft");
    // One id, `feature/plan/draft` — so the nearest copy, you in the project's, is the one read.
    expect(load("feature/plan")).toEqual({ "feature/plan": "feature/plan from project", "feature/plan/draft": "feature/plan/draft from projectYou" });
  });

  it("a bare `$/…` fragment is searched along the layer roots most specific first", () => {
    write(join(rootOf("project"), "prompts", "tone.md"), "the project's tone");
    write(join(rootOf("you"), "prompts", "tone.md"), "my tone");
    state("base", "feature/write", { operation: { kind: "prompt", prompt: { $ref: "$/prompts/tone.md" } } });
    const p = open();
    const bundle = loadWorkflowBundle(readWorkflowFiles(p.paths.workflowsDir), "feature/write", workflowLoadOptions(p.paths));
    expect(JSON.stringify(bundle.states["feature/write"]?.operation)).toContain("my tone");
  });
});
