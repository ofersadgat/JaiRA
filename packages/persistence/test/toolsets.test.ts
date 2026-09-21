/**
 * Toolsets end to end (decision 0007 §1–§2): files in buckets under the layer roots, referenced from
 * a state, lowered on the way into the engine, and linted where they are written.
 *
 * The thing worth testing here is what the shared model cannot: that a reference resolves through the
 * SAME resolver and the same layers every other reference uses, and that the load path, the lint
 * surface and the snapshot agree about the result.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { TOOLSET_MARKERS } from "@jaira/shared";
import { loadBundle, snapshotHash } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "../src/snapshots";
import { listToolsets, loadWorkflowBundle } from "../src/toolsets";
import { browseWorkflows } from "../src/workflows";
import { workflowLoadOptions } from "../src/workflowRefs";

let dir: string;
let project: Project;

function write(root: string, relPath: string, body: unknown): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
}

/** A one-state workflow whose environment is the thing under test. */
function state(environment: unknown): unknown {
  return {
    label: "Plan",
    outputs: { plan: { schema: { type: "string" }, binding: ".operation.output.plan" } },
    environment,
    operation: { kind: "prompt", prompt: "go", model: "claude-sonnet-5", output: { plan: { schema: { type: "string" } } } },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-toolsets-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

function load(rootId: string, onReferencedFile?: (file: string) => void) {
  return loadWorkflowBundle(
    readWorkflowFiles(project.paths.workflowsDir),
    rootId,
    workflowLoadOptions(project.paths, onReferencedFile !== undefined ? { onReferencedFile } : {}),
  );
}

const environmentOf = (rootId: string): unknown => load(rootId).states[rootId]!.environment;

describe("a toolset, referenced from a state", () => {
  it("resolves `$/toolsets/<bucket>/<name>` and reaches the engine as a list and a block", () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", glob: "allow", bash: "deny", "git status": "allow", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/chat/read-only" }));
    expect(environmentOf("plan")).toEqual({
      tools: ["read_file", "glob", "bash"],
      permissions: { tools: { read_file: "allow", glob: "allow", bash: "deny", ...TOOLSET_MARKERS }, other: "deny", subjects: { "git status": "allow" } },
    });
  });

  it("starts from one and says more — sibling keys override", () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", bash: "deny", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: { $ref: "$/toolsets/chat/read-only", write_file: "ask", bash: "smart" } }));
    expect(environmentOf("plan")).toEqual({
      tools: ["read_file", "bash", "write_file"],
      permissions: { tools: { read_file: "allow", bash: "smart", write_file: "ask", ...TOOLSET_MARKERS }, other: "deny" },
    });
  });

  it("follows a toolset file that itself starts from another, into a NESTED bucket", () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.jairaDir, "toolsets/feature/implementation/build.json", {
      $ref: "$/toolsets/chat/read-only",
      edit: { mode: "ask", implementation: "native" },
    });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/feature/implementation/build" }));
    expect(environmentOf("plan")).toEqual({
      tools: ["read_file", "edit"],
      permissions: { tools: { read_file: "allow", edit: "ask", ...TOOLSET_MARKERS }, other: "deny", implementations: { edit: "native" } },
    });
  });

  it("layers like everything else: the project's file wins, and the shared root supplies what it lacks", () => {
    write(testHome(), "toolsets/chat/read-only.json", { read_file: "ask", other: "ask" });
    write(testHome(), "toolsets/chat/shared-only.json", { glob: "allow" });
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/chat/read-only" }));
    write(project.paths.workflowsDir, "other.json", state({ tools: "$/toolsets/chat/shared-only" }));
    expect(environmentOf("plan")).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS }, other: "deny" } });
    expect(environmentOf("other")).toEqual({ tools: ["glob"], permissions: { tools: { glob: "allow", ...TOOLSET_MARKERS } } });
  });

  it("is inherited by a child exactly as a list is, and a child's own toolset replaces it", () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.workflowsDir, "wf.json", {
      environment: { tools: "$/toolsets/chat/read-only" },
      children: { a: {}, b: { environment: { tools: { bash: "smart" } } } },
      sequence: ["a", "b"],
    });
    const leaf = (state({}) as Record<string, unknown>);
    delete leaf["environment"];
    write(project.paths.workflowsDir, "wf/a.json", leaf);
    write(project.paths.workflowsDir, "wf/b.json", leaf);
    const bundle = load("wf");
    expect(bundle.states["wf/a"]!.environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS }, other: "deny" } });
    expect(bundle.states["wf/b"]!.environment?.tools).toEqual(["bash"]);
  });
});

describe("legacy equivalence", () => {
  it("the same state in old and new form loads to the same environment, and an old one is untouched", () => {
    const legacy = { tools: ["read_file", "bash"], permissions: { tools: { read_file: "allow", bash: "ask" }, other: "deny" } };
    write(project.paths.workflowsDir, "old.json", state(legacy));
    write(project.paths.workflowsDir, "new.json", state({ tools: { read_file: "allow", bash: "ask", other: "deny" } }));
    // The same list and the same modes — and the MAP leaves its marks, which is how a run tells it
    // from the legacy reading: a map is the whole grant on a delegated agent, a list never was.
    expect(environmentOf("new")).toEqual({
      tools: legacy.tools,
      permissions: { ...legacy.permissions, tools: { ...legacy.permissions.tools, ...TOOLSET_MARKERS } },
    });
    expect(environmentOf("old")).toEqual(legacy);
    // Through the door and around it: the wrapper changes nothing about a state in the old form.
    const files = readWorkflowFiles(project.paths.workflowsDir);
    const direct = loadBundle(files, "old", workflowLoadOptions(project.paths));
    expect(load("old").states["old"]).toEqual(direct.states["old"]);
    expect(snapshotHash(load("old"))).toBe(snapshotHash(direct));
  });

  it("still loads the old profile block, profile and all", () => {
    write(project.paths.workflowsDir, "sync.json", state({ tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } }));
    expect(environmentOf("sync")).toEqual({ tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } });
  });
});

describe("the snapshot", () => {
  it("records the toolset file in the closure, and a pinned task does not see a later edit", async () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/chat/read-only" }));
    const read: string[] = [];
    const bundle = load("plan", (file) => read.push(file.replace(/\\/g, "/")));
    expect(read.some((file) => file.endsWith("toolsets/chat/read-only.json"))).toBe(true);

    const snap = await ensureSnapshot(project.paths.snapshotsDir, bundle);
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "deny", other: "deny" });
    const pinned = loadSnapshot(project.paths.snapshotsDir, snap.hash);
    expect(pinned.states["plan"]!.environment?.permissions).toEqual({ tools: { read_file: "allow", ...TOOLSET_MARKERS }, other: "deny" });
    // …and the edit is a different workflow to the next task.
    expect(snapshotHash(load("plan"))).not.toBe(snap.hash);
  });
});

describe("the linter", () => {
  const issuesOf = (rootId: string) => browseWorkflows(project).workflows.find((w) => w.rootId === rootId)!;

  it("is quiet about a good toolset, in either form", () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", "git log": "allow", script: "ask", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/chat/read-only" }));
    write(project.paths.workflowsDir, "old.json", state({ tools: ["read_file"], permissions: { tools: { read_file: "allow" } } }));
    expect(issuesOf("plan").loadError).toBeUndefined();
    expect(issuesOf("plan").issues).toEqual([]);
    expect(issuesOf("old").issues).toEqual([]);
  });

  it("WARNS that an unknown tool name falls to `other`, and still loads", () => {
    write(project.paths.workflowsDir, "plan.json", state({ tools: { reed_file: "allow", other: "ask" } }));
    const entry = issuesOf("plan");
    expect(entry.loadError).toBeUndefined();
    expect(entry.issues).toEqual([
      { stateId: "plan", path: "environment.tools.reed_file", severity: "warning", message: expect.stringMatching(/not a tool JaiRA knows.*'other'/) },
    ]);
  });

  it("reports a mode that is not one as an ERROR at the entry, through a reference too", () => {
    write(project.paths.jairaDir, "toolsets/chat/broken.json", { read_file: "sometimes" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: { $ref: "$/toolsets/chat/broken", bash: "ask" } }));
    const entry = issuesOf("plan");
    expect(entry.loadError).toBeUndefined();
    expect(entry.issues).toEqual([
      { stateId: "plan", path: "environment.tools.read_file", severity: "error", message: expect.stringMatching(/a mode is one of allow, deny, ask, smart/) },
    ]);
    // A RUN is refused rather than started under a toolset nobody could read.
    expect(() => load("plan")).toThrow(/plan: environment\.tools\.read_file: .*a mode is one of/);
  });

  it("reports a reference cycle as an error NAMING it", () => {
    write(project.paths.jairaDir, "toolsets/loop/a.json", { $ref: "$/toolsets/loop/b", read_file: "allow" });
    write(project.paths.jairaDir, "toolsets/loop/b.json", { $ref: "$/toolsets/loop/a" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/loop/a" }));
    const [issue] = issuesOf("plan").issues;
    expect(issue).toMatchObject({ stateId: "plan", path: "environment.tools", severity: "error" });
    expect(issue!.message).toMatch(/^toolset reference cycle: .*toolsets\/loop\/a\.json# → .*toolsets\/loop\/b\.json# → .*toolsets\/loop\/a\.json#$/);
    expect(() => load("plan")).toThrow(/toolset reference cycle/);
  });

  it("reports a reference that names nothing", () => {
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/chat/nope" }));
    expect(issuesOf("plan").issues).toEqual([expect.objectContaining({ path: "environment.tools", severity: "error" })]);
  });
});

describe("buckets", () => {
  it("lists every toolset across the layer roots, first root winning, buckets free to nest", () => {
    write(testHome(), "toolsets/chat/read-only.json", {});
    write(testHome(), "toolsets/chat/full.json", {});
    write(testHome(), "toolsets/chat_control/read-only.json", {});
    write(testHome(), "toolsets/loose.json", {});
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", {});
    write(project.paths.jairaDir, "toolsets/feature/implementation/build.json", {});

    const listed = listToolsets(project.paths.roots);
    expect(listed.map((t) => [t.id, t.bucket, t.name, t.root === project.paths.jairaDir ? "project" : "base", t.overrides])).toEqual([
      ["chat/full", "chat", "full", "base", false],
      ["chat/read-only", "chat", "read-only", "project", true],
      ["chat_control/read-only", "chat_control", "read-only", "base", false],
      ["feature/implementation/build", "feature/implementation", "build", "project", false],
    ]);
    expect(listed[3]!.reference).toBe("$/toolsets/feature/implementation/build");
  });

  it("picks up a THIRD layer root with no change — it reads whatever `roots` holds", () => {
    const third = mkdtempSync(join(tmpdir(), "jaira-toolsets-system-"));
    try {
      write(third, "toolsets/chat/ask-first.json", {});
      write(project.paths.jairaDir, "toolsets/chat/read-only.json", {});
      const listed = listToolsets([...project.paths.roots, third]);
      expect(listed.map((t) => t.id)).toEqual(["chat/ask-first", "chat/read-only"]);
      expect(listed[0]!.root).toBe(third);
    } finally {
      rmSync(third, { recursive: true, force: true });
    }
  });
});
