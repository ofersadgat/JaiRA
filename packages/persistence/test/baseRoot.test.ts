/**
 * The shared BASE root and the project's overrides of it (DESIGN §3, EXPRESSIONS.md §4).
 *
 * The model under test, in one sentence: a bare state id is searched along the path — the project's
 * own `workflows/` first, the shared root last — and a match at ANY entry keeps that bare id. Two
 * consequences follow, and both are what the feature is for:
 *
 *  - a project can RUN a workflow it does not contain, and
 *  - a project can REPLACE one state of that workflow by writing a file with the same id.
 *
 * The second is the reason ids fold back from every entry rather than only the first. If the base
 * copy canonicalized to an absolute host path, the project's file would not be an override at all;
 * it would be a second, differently-named state, and nothing would shadow anything.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, type Project } from "../src/project";
import { browseWorkflows } from "../src/workflows";
import { bundleFor } from "../src/views";

let dir: string;
let baseDir: string;
let project: Project | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-base-project-"));
  baseDir = mkdtempSync(join(tmpdir(), "jaira-base-root-"));
  initProject(dir);
});

afterEach(() => {
  project?.close();
  project = undefined;
  rmSync(dir, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

/** Write a state file under a root, creating intermediate directories. */
function writeState(root: string, relPath: string, def: unknown): void {
  const file = join(root, `${relPath}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(def, null, 2), "utf8");
}

/** A trivial two-state workflow: a root that runs one child. */
function libraryWorkflow(label: string): Record<string, unknown> {
  return {
    label,
    children: { step: { state: "./step" } },
  };
}

function step(label: string): Record<string, unknown> {
  return {
    label,
    operation: {
      kind: "function",
      function: "echo",
      input: { value: { kind: "text", binding: { text: label } } },
      output: { value: { kind: "text" } },
    },
  };
}

const open = (): Project => (project = openProject(dir, { baseDir }));

describe("a workflow supplied entirely by the shared base root", () => {
  beforeEach(() => {
    writeState(join(baseDir, "workflows"), "review", libraryWorkflow("shared review"));
    writeState(join(baseDir, "workflows"), "review/step", step("base step"));
  });

  it("loads under its BARE id, though no file for it exists in the project", () => {
    const bundle = bundleFor(open(), "review");

    expect(bundle).toBeDefined();
    // The whole point: `review`, not `/tmp/…/workflows/review`. A host path here would key the
    // snapshot hash and the event log, and would differ on every machine.
    expect(bundle!.rootId).toBe("review");
    expect(Object.keys(bundle!.states).sort()).toEqual(["review", "review/step"]);
  });

  it("is listed by the browser, marked as coming from the base layer", () => {
    const browser = browseWorkflows(open());
    const root = browser.workflows.find((w) => w.rootId === "review");

    expect(root).toBeDefined();
    expect(root!.layer).toBe("base");
    expect(root!.label).toBe("shared review");
    expect(browser.files.map((f) => f.stateId).sort()).toEqual(["review", "review/step"]);
    expect(browser.files.every((f) => f.layer === "base")).toBe(true);
  });
});

describe("a project file overriding a base one", () => {
  beforeEach(() => {
    writeState(join(baseDir, "workflows"), "review", libraryWorkflow("shared review"));
    writeState(join(baseDir, "workflows"), "review/step", step("base step"));
  });

  it("replaces the base state of the same id, keeping the rest of the base workflow", () => {
    // Only the CHILD is overridden. The root still comes from the base root, which is what makes
    // this an override of one state rather than a fork of the workflow.
    writeState(join(dir, ".jaira", "workflows"), "review/step", step("project step"));

    const bundle = bundleFor(open(), "review");

    expect(bundle).toBeDefined();
    expect(Object.keys(bundle!.states).sort()).toEqual(["review", "review/step"]);
    // The project's copy won, under the very same id.
    expect(bundle!.source?.["review/step"]).toMatchObject({ label: "project step" });
    expect(bundle!.source?.["review"]).toMatchObject({ label: "shared review" });
  });

  it("lists both copies, flagging the shadowed base one", () => {
    writeState(join(dir, ".jaira", "workflows"), "review/step", step("project step"));

    const browser = browseWorkflows(open());
    const copies = browser.files.filter((f) => f.stateId === "review/step");

    expect(copies).toHaveLength(2);
    const winner = copies.find((f) => f.layer === "project");
    const loser = copies.find((f) => f.layer === "base");
    expect(winner?.shadowed).toBeUndefined();
    // Listed rather than hidden: a base file that has quietly stopped applying is worth seeing.
    expect(loser?.shadowed).toBe(true);
  });

  it("does not report the override as a lint warning", () => {
    writeState(join(dir, ".jaira", "workflows"), "review/step", step("project step"));

    const browser = browseWorkflows(open());
    const root = browser.workflows.find((w) => w.rootId === "review");

    // Shadowing IS the mechanism here, so warning about it would mean one warning per overridden
    // state — which is how a warning stops being read.
    expect(root?.issues.filter((i) => /shadow|further along/i.test(i.message))).toEqual([]);
  });
});

/**
 * `$` resolves against the LAYERS (EXPRESSIONS.md §4.1).
 *
 * The counterpart of state layering, and the half that would otherwise be missing: a state file can
 * come from the shared root, but so can the prompt, type, guard or operation document it is
 * assembled from. Without this, an override model covers whole states and nothing inside them.
 */
describe("$ searches the layer roots", () => {
  /** Write a non-state fragment (a prompt, a type) under a root. */
  function writeFragment(root: string, relPath: string, body: string): void {
    const file = join(root, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
  }

  it("finds a prompt the shared root supplies and the project does not", () => {
    writeFragment(baseDir, "prompts/critique.md", "Critique the plan.");
    writeState(join(dir, ".jaira", "workflows"), "review", {
      label: "review",
      operation: {
        kind: "prompt",
        prompt: { $ref: "$/prompts/critique.md" },
        config: { model: "anthropic/claude-sonnet-5" },
        output: { notes: { kind: "text" } },
      },
    });

    const bundle = bundleFor(open(), "review");

    expect(bundle).toBeDefined();
    expect(JSON.stringify(bundle!.states["review"])).toContain("Critique the plan.");
  });

  it("lets the project override a shared fragment under the same spelling", () => {
    writeFragment(baseDir, "prompts/critique.md", "SHARED text.");
    writeFragment(join(dir, ".jaira"), "prompts/critique.md", "PROJECT text.");
    writeState(join(dir, ".jaira", "workflows"), "review", {
      label: "review",
      operation: {
        kind: "prompt",
        prompt: { $ref: "$/prompts/critique.md" },
        config: { model: "anthropic/claude-sonnet-5" },
        output: { notes: { kind: "text" } },
      },
    });

    const rendered = JSON.stringify(bundleFor(open(), "review")!.states["review"]);

    expect(rendered).toContain("PROJECT text.");
    expect(rendered).not.toContain("SHARED text.");
  });

  it("reports a fragment no layer supplies, naming the roots tried", () => {
    writeState(join(dir, ".jaira", "workflows"), "review", {
      label: "review",
      operation: {
        kind: "prompt",
        prompt: { $ref: "$/prompts/absent.md" },
        config: { model: "anthropic/claude-sonnet-5" },
        output: { notes: { kind: "text" } },
      },
    });

    const browser = browseWorkflows(open());

    expect(browser.workflows.find((w) => w.rootId === "review")?.loadError).toMatch(/any layer root/);
  });
});

describe("the base root is only a fallback", () => {
  it("leaves a project that defines everything itself completely unaffected", () => {
    writeState(join(baseDir, "workflows"), "review", libraryWorkflow("shared review"));
    writeState(join(dir, ".jaira", "workflows"), "own", libraryWorkflow("own"));
    writeState(join(dir, ".jaira", "workflows"), "own/step", step("own step"));

    const browser = browseWorkflows(open());
    const own = browser.workflows.find((w) => w.rootId === "own");

    expect(own?.layer).toBe("project");
    expect(own?.loadError).toBeUndefined();
  });

  it("is absent without error when the shared root does not exist yet", () => {
    rmSync(baseDir, { recursive: true, force: true });
    writeState(join(dir, ".jaira", "workflows"), "own", libraryWorkflow("own"));
    writeState(join(dir, ".jaira", "workflows"), "own/step", step("own step"));

    const browser = browseWorkflows(open());

    expect(browser.workflows.map((w) => w.rootId)).toEqual(["own"]);
  });
});
