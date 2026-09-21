/**
 * The built-in layer, `$SYSTEM` (decision 0006, step 1).
 *
 * What JaiRA ships is the LAST of three layers, and four things have to be true of it at once: it
 * resolves like the other two and loses to both; configuration cannot move or drop it; a task pinned
 * to something it supplied survives the app changing underneath it; and its `.ts` functions run
 * without the approval a person's module needs — while a person's copy of one does not inherit that.
 *
 * Nothing real ships in the layer yet, and these tests would not want it if it did: every one of them
 * hands in a fixture directory of its own (`builtInDir`), so what is asserted is the mechanism and not
 * whatever happens to be in `packages/shared/builtin/` this week.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalRequired, defaultBuiltInDir, jairaPaths, setBuiltInDir, baseAsProjectPaths } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { loadBundle } from "@declarative-ai/hw";
import {
  approvalsPending,
  beginTaskRun,
  browseBaseWorkflows,
  browseWorkflows,
  canonicalModulePath,
  createTask,
  fileTree,
  initProject,
  isBuiltInModule,
  loadSnapshot,
  openProject,
  prepareUserModules,
  readWorkflowFiles,
  resetUserModules,
  stateSlots,
  stateView,
  userModules,
  workflowLoadOptions,
  workflowRoots,
  type Project,
} from "../src/index";

let dir: string;
let builtIn: string;
let project: Project | undefined;

const promptState = (prompt: unknown, label = "Shipped"): Record<string, unknown> => ({
  label,
  outputs: { text: { schema: { type: "string" }, binding: ".operation.output.text" } },
  operation: { kind: "prompt", prompt, model: "anthropic/claude-sonnet-5", output: { text: { schema: { type: "string" } } } },
});

function write(root: string, relPath: string, body: unknown): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return file;
}

function open(): Project {
  project = openProject(dir, { baseDir: testHome(), builtInDir: builtIn });
  return project;
}

/** Load a root the way `beginTaskRun` does: the project's own files, the rest found on the path. */
function load(p: Project, rootId: string, path?: string[]) {
  return loadBundle(
    readWorkflowFiles(p.paths.workflowsDir),
    rootId,
    workflowLoadOptions(p.paths, path !== undefined ? { path } : {}),
  );
}

const promptOf = (p: Project, rootId: string, path?: string[]): unknown =>
  (load(p, rootId, path).states[rootId]!.operation as { user?: unknown }).user;

beforeEach(() => {
  resetUserModules();
  dir = mkdtempSync(join(tmpdir(), "jaira-builtin-"));
  builtIn = mkdtempSync(join(tmpdir(), "jaira-shipped-"));
  initProject(dir, testHome());
});

afterEach(() => {
  project?.close();
  project = undefined;
  resetUserModules();
  setBuiltInDir(undefined);
  rmSync(dir, { recursive: true, force: true });
  rmSync(builtIn, { recursive: true, force: true });
});

describe("the layout", () => {
  it("puts the built-in layer last, behind the project and the shared root", () => {
    const paths = jairaPaths(dir, testHome(), builtIn);
    expect(paths.roots).toEqual([paths.jairaDir, paths.base.baseDir, paths.builtIn.dir]);
    expect(paths.builtIn.workflowsDir).toBe(join(paths.builtIn.dir, "workflows"));
    expect(paths.builtIn.toolsetsDir).toBe(join(paths.builtIn.dir, "toolsets"));
  });

  it("is behind the shared root opened as a project, too", () => {
    const paths = baseAsProjectPaths(testHome(), builtIn);
    expect(paths.roots).toEqual([paths.base.baseDir, paths.builtIn.dir]);
  });

  it("finds a directory on its own when nobody names one, and takes a registered one over it", () => {
    // Under vitest this module is source, so the third candidate — `packages/shared/builtin` — is
    // the one that exists. The assertion is on the NAME, not the contents: what ships is step 2's.
    expect(defaultBuiltInDir().replace(/\\/g, "/")).toMatch(/packages\/shared\/builtin$/);
    setBuiltInDir(builtIn);
    expect(jairaPaths(dir, testHome()).builtIn.dir).toBe(builtIn);
    setBuiltInDir(undefined);
    expect(defaultBuiltInDir().replace(/\\/g, "/")).toMatch(/packages\/shared\/builtin$/);
  });
});

describe("three-layer resolution", () => {
  it("resolves a bare id from the built-in layer when nobody else defines it", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    expect(promptOf(open(), "chat/hello")).toBe("shipped");
  });

  it("lets the shared root shadow the built-in copy, and the project shadow both", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    expect(promptOf(p, "chat/hello")).toBe("shipped");

    write(p.paths.base.workflowsDir, "chat/hello.json", promptState("shared"));
    expect(promptOf(p, "chat/hello")).toBe("shared");

    write(p.paths.workflowsDir, "chat/hello.json", promptState("project"));
    expect(promptOf(p, "chat/hello")).toBe("project");
  });

  it("searches `$/…` along all three, first match winning", () => {
    write(builtIn, "prompts/hello.md", "shipped prompt");
    const p = open();
    write(p.paths.workflowsDir, "greet.json", promptState({ $ref: "$/prompts/hello.md" }));
    expect(promptOf(p, "greet")).toBe("shipped prompt");

    write(p.paths.base.baseDir, "prompts/hello.md", "shared prompt");
    expect(promptOf(p, "greet")).toBe("shared prompt");

    write(p.paths.jairaDir, "prompts/hello.md", "project prompt");
    expect(promptOf(p, "greet")).toBe("project prompt");
  });

  it("names the shipped copy with `$SYSTEM/…`, whatever shadows it", () => {
    write(builtIn, "prompts/hello.md", "shipped prompt");
    const p = open();
    write(p.paths.jairaDir, "prompts/hello.md", "project prompt");
    write(p.paths.base.baseDir, "prompts/hello.md", "shared prompt");
    write(p.paths.workflowsDir, "greet.json", promptState({ $ref: "$SYSTEM/prompts/hello.md" }));
    expect(promptOf(p, "greet")).toBe("shipped prompt");
  });

  it("folds a `$SYSTEM/workflows/…` STATE reference back to its bare id, as `$BASE/workflows/…` always has", () => {
    // The limit of "names the shipped copy", written down so nobody discovers it: a state's id is
    // its identity, and an id under ANY search-path entry is the bare one (WORKFLOWS.md §2.1). So a
    // child named through `$SYSTEM` is the same state as the bare spelling — and shadowing applies
    // to it. Pinning a particular COPY is what a document reference does; a state reference cannot.
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    write(p.paths.workflowsDir, "parent.json", { label: "Parent", children: { hello: { state: "$SYSTEM/workflows/chat/hello" } } });
    expect(Object.keys(load(p, "parent").states).sort()).toEqual(["chat/hello", "parent"]);
    expect((load(p, "parent").states["chat/hello"]!.operation as { user?: unknown }).user).toBe("shipped");

    write(p.paths.workflowsDir, "chat/hello.json", promptState("project"));
    expect((load(p, "parent").states["chat/hello"]!.operation as { user?: unknown }).user).toBe("project");
  });

  it("resolves a toolset-shaped fragment from the layer by the reference form that already exists", () => {
    // `toolsets/` is a directory of ordinary fragments (decision 0006); what a toolset MEANS is 0007's.
    write(builtIn, "toolsets/chat/ask-first.json", { model: "from-toolset" });
    const p = open();
    write(p.paths.workflowsDir, "greet.json", {
      ...promptState("x"),
      operation: { $ref: "$/toolsets/chat/ask-first", kind: "prompt", prompt: "x" },
    });
    expect((load(p, "greet").states.greet!.operation as { config?: { model?: string } }).config?.model).toBe("from-toolset");
  });

  it("treats a missing built-in directory as an empty layer", () => {
    rmSync(builtIn, { recursive: true, force: true });
    const p = open();
    write(p.paths.workflowsDir, "greet.json", promptState("mine"));
    expect(existsSync(p.paths.builtIn.dir)).toBe(false);
    expect(promptOf(p, "greet")).toBe("mine");
    expect(browseWorkflows(p).workflows.map((w) => w.rootId)).toEqual(["greet"]);
    expect(() => load(p, "chat/hello")).toThrow();
  });

  it("keeps the layer on the end of a configured path that left it out", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    // `workflows.path` REPLACES the generated list — and what ships is not the project's to drop.
    const options = workflowLoadOptions(p.paths, { path: ["$JAIRA/workflows"] });
    expect(options.defaultRoot).toEqual([p.paths.workflowsDir, p.paths.builtIn.workflowsDir, p.paths.builtIn.functionsDir]);
    expect(promptOf(p, "chat/hello", ["$JAIRA/workflows"])).toBe("shipped");
  });

  it("moves the layer to the end of a configured path that put it first", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    write(p.paths.base.workflowsDir, "chat/hello.json", promptState("shared"));
    const path = ["$SYSTEM/workflows", "$JAIRA/workflows", "$BASE/workflows"];
    expect(workflowLoadOptions(p.paths, { path }).defaultRoot).toEqual([
      p.paths.workflowsDir,
      p.paths.base.workflowsDir,
      p.paths.builtIn.workflowsDir,
      p.paths.builtIn.functionsDir,
    ]);
    expect(promptOf(p, "chat/hello", path)).toBe("shared");
  });
});

describe("what enumerates layers sees three", () => {
  it("lists a shipped state in the browser, marked `system`, and lints it", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    const browser = browseWorkflows(p);
    expect(browser.files.map((f) => [f.stateId, f.layer])).toEqual([["chat/hello", "system"]]);
    const entry = browser.workflows.find((w) => w.rootId === "chat/hello");
    expect(entry?.layer).toBe("system");
    expect(entry?.loadError).toBeUndefined();
    expect(entry?.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("marks the shipped copy shadowed once a person overrides it", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    write(p.paths.base.workflowsDir, "chat/hello.json", promptState("shared"));
    const files = browseWorkflows(p).files.map((f) => [f.layer, f.shadowed === true]);
    expect(files).toEqual([
      ["base", false],
      ["system", true],
    ]);
    expect(browseWorkflows(p).workflows.find((w) => w.rootId === "chat/hello")?.layer).toBe("base");
  });

  it("reports a broken shipped state as a lint finding rather than hiding it", () => {
    write(builtIn, "workflows/broken.json", { label: "Broken", children: { gone: { state: "./gone" } } });
    const entry = browseWorkflows(open()).workflows.find((w) => w.rootId === "broken");
    expect(entry?.layer).toBe("system");
    expect(entry?.loadError ?? entry?.issues.map((i) => i.message).join("\n")).toMatch(/gone/);
  });

  it("browses the layer behind the shared root with no project open", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    setBuiltInDir(builtIn);
    expect(browseBaseWorkflows(testHome()).files.map((f) => [f.stateId, f.layer])).toEqual([["chat/hello", "system"]]);
  });

  it("answers three workflow roots, and finds a shipped state's slots through them", () => {
    write(builtIn, "workflows/chat/hello.json", { ...promptState("shipped"), inputs: { topic: { schema: { type: "string" } } } });
    const p = open();
    expect(workflowRoots(p)).toEqual([p.paths.workflowsDir, p.paths.base.workflowsDir, p.paths.builtIn.workflowsDir]);
    expect(stateSlots(workflowRoots(p), ["chat/hello"])["chat/hello"]?.inputs.map((s) => s.name)).toEqual(["topic"]);
  });

  it("opens a shipped state's view on the shipped file", () => {
    const file = write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    const view = stateView(p, "chat/hello", browseWorkflows(p));
    expect(view.layer).toBe("system");
    expect(view.file).toBe(file);
  });

  it("draws the read-only root LAST in the Files tree, as `system` and never as `base`", () => {
    // Labelling every root after the first `base` — which the tree used to do — would have offered
    // to save into the installed app. The layer is what every menu on that root reads.
    const file = write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    const roots = fileTree(p, browseWorkflows(p)).roots;
    expect(roots.map((r) => r.layer)).toEqual(["project", "base", "system"]);
    expect(roots[2]).toMatchObject({ label: "Built in", dir: builtIn, prefix: "", exists: true });
    const hello = roots[2]!.nodes[0]?.children?.[0]?.children?.[0];
    expect(hello).toMatchObject({ stateId: "chat/hello", layer: "system", path: "workflows/chat/hello.json" });
    expect(hello?.shadowed).toBeUndefined();
    expect(file.endsWith("hello.json")).toBe(true);
  });

  it("marks the shipped row overridden and the person's row overriding, once a copy shadows it", () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    write(testHome(), "workflows/chat/hello.json", promptState("mine"));
    const p = open();
    const roots = fileTree(p, browseWorkflows(p)).roots;
    const at = (index: number): unknown => roots[index]!.nodes.find((n) => n.name === "workflows")?.children?.[0]?.children?.[0];
    expect(at(1)).toMatchObject({ layer: "base", overridesBuiltIn: true });
    expect(at(2)).toMatchObject({ layer: "system", shadowed: true });
  });
});

describe("a pinned task keeps the built-in it started with", () => {
  it("copies what the layer supplied into the snapshot — state, child and fragment", async () => {
    write(builtIn, "prompts/hello.md", "shipped prompt v1");
    write(builtIn, "workflows/chat/hello.json", {
      label: "Hello",
      children: { say: { state: "./say" } },
    });
    write(builtIn, "workflows/chat/hello/say.json", promptState({ $ref: "$/prompts/hello.md" }, "Say"));
    const p = open();
    // One state of the closure is the PROJECT's, so the closure genuinely spans layers.
    write(p.paths.workflowsDir, "chat/hello/say.json", promptState({ $ref: "$SYSTEM/prompts/hello.md" }, "Say (mine)"));

    createTask(p, { title: "t", workflow: "chat/hello", id: "t-1" });
    const started = await beginTaskRun(p, "t-1");
    expect(Object.keys(started.bundle.states).sort()).toEqual(["chat/hello", "chat/hello/say"]);

    // The app is upgraded: every shipped file changes, and one disappears.
    write(builtIn, "prompts/hello.md", "shipped prompt v2");
    write(builtIn, "workflows/chat/hello.json", { label: "Hello v2", children: {} });
    rmSync(join(builtIn, "workflows/chat/hello/say.json"));

    const pinned = loadSnapshot(p.paths.snapshotsDir, started.snapshotHash);
    expect(pinned.states["chat/hello"]!.label).toBe("Hello");
    expect(pinned.states["chat/hello/say"]!.label).toBe("Say (mine)");
    expect((pinned.states["chat/hello/say"]!.operation as { user?: unknown }).user).toBe("shipped prompt v1");
    // And the live definition has moved on, which is what the browser's drift mark is for.
    expect(load(p, "chat/hello").states["chat/hello"]!.label).toBe("Hello v2");
  });

  it("survives the layer vanishing altogether", async () => {
    write(builtIn, "workflows/chat/hello.json", promptState("shipped"));
    const p = open();
    createTask(p, { title: "t", workflow: "chat/hello", id: "t-1" });
    const started = await beginTaskRun(p, "t-1");
    rmSync(builtIn, { recursive: true, force: true });
    const pinned = loadSnapshot(p.paths.snapshotsDir, started.snapshotHash);
    expect((pinned.states["chat/hello"]!.operation as { user?: unknown }).user).toBe("shipped");
  });
});

describe("the approval gate's exemption", () => {
  const SOURCE = `export const confidence = {
  score(rank: number): number {
    return 1 - rank / 3;
  },
};
`;
  const CALLER: Record<string, unknown> = {
    label: "Caller",
    inputs: { rank: { schema: { type: "integer" }, default: 0 } },
    outputs: { score: { binding: "confidence.score(.inputs.rank)", schema: { type: "number" } } },
  };

  async function openWithModules(): Promise<Project> {
    const p = open();
    await prepareUserModules(p.paths, { rebuild: true });
    return p;
  }

  it("runs a shipped `.ts` function nobody approved, and freezes it into the snapshot", async () => {
    write(builtIn, "functions/confidence.ts", SOURCE);
    const p = await openWithModules();
    write(p.paths.workflowsDir, "caller.json", CALLER);

    const entry = browseWorkflows(p).workflows.find((w) => w.rootId === "caller");
    expect(entry?.loadError).toBeUndefined();
    expect(entry?.needsApproval).toBeUndefined();

    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    const started = await beginTaskRun(p, "t-1");
    expect(started.bundle.moduleDigest).toBeTruthy();
    // Frozen like any other module: the emitted code is in the snapshot, so the pin covers it.
    expect(existsSync(join(started.snapshotDir, "_modules"))).toBe(true);
  });

  it("does not list the shipped function among what the PERSON approved", async () => {
    write(builtIn, "functions/confidence.ts", SOURCE);
    const p = await openWithModules();
    write(p.paths.workflowsDir, "caller.json", CALLER);
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    await beginTaskRun(p, "t-1");
    expect([...userModules()!.approvals.all().keys()]).toEqual([]);
  });

  it("gates a person's copy that shadows the shipped function, exactly as before", async () => {
    write(builtIn, "functions/confidence.ts", SOURCE);
    const p = open();
    const mine = write(p.paths.jairaDir, "functions/confidence.ts", SOURCE.replace("1 - rank / 3", "1"));
    await prepareUserModules(p.paths, { rebuild: true });
    write(p.paths.workflowsDir, "caller.json", CALLER);
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });

    const pending = await approvalsPending(userModules()!, [mine]);
    expect(pending.map((entry) => canonicalModulePath(entry.file))).toEqual([canonicalModulePath(mine)]);
    // Byte-identical to something trusted is still not trusted: the next edit is the person's.
    const twin = write(p.paths.base.baseDir, "functions/twin.ts", SOURCE);
    expect((await approvalsPending(userModules()!, [twin])).length).toBe(1);
    // And the shipped file itself is never pending.
    expect(await approvalsPending(userModules()!, [join(builtIn, "functions/confidence.ts")])).toEqual([]);
  });

  it("refuses to START on an unapproved module even when a shipped one of the same name exists", async () => {
    // The project's `functions/` holds a DIFFERENT symbol the workflow calls, so resolution cannot
    // fall through to the layer: the gate is the only thing between this file and a run.
    write(builtIn, "functions/confidence.ts", SOURCE);
    const p = open();
    write(p.paths.jairaDir, "functions/mine.ts", `export const mine = { one(): number { return 1; } };\n`);
    await prepareUserModules(p.paths, { rebuild: true });
    write(p.paths.workflowsDir, "caller.json", {
      label: "Caller",
      outputs: { one: { binding: "mine.one()", schema: { type: "number" } } },
    });
    createTask(p, { title: "t", workflow: "caller", id: "t-1" });
    const error = await beginTaskRun(p, "t-1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApprovalRequired);
    expect((error as ApprovalRequired).pending.map((entry) => entry.file.endsWith("mine.ts"))).toEqual([true]);
  });

  it("decides by location, and is not fooled by a sibling directory or a `..`", () => {
    expect(isBuiltInModule(join(builtIn, "functions", "confidence.ts"), builtIn)).toBe(true);
    expect(isBuiltInModule(join(builtIn, "functions", "lib", "deep.ts"), builtIn)).toBe(true);
    expect(isBuiltInModule(`${builtIn}-evil/functions/confidence.ts`, builtIn)).toBe(false);
    expect(isBuiltInModule(join(builtIn, "..", "elsewhere", "x.ts"), builtIn)).toBe(false);
    expect(isBuiltInModule(builtIn, builtIn)).toBe(false);
  });
});
