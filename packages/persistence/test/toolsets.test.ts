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
import { shippedLayer, testHome } from "@jaira/testing";
import { TOOLSET_MARKERS } from "@jaira/shared";
import { loadBundle, snapshotHash } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "../src/snapshots";
import { listToolsets, loadWorkflowBundle, readToolsets } from "../src/toolsets";
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
      // The shell is offered and its LINES are judged: the gate is handed `smart` for it, and the
      // `deny` its author wrote is the answer for any command no entry names (decision 0007 §4).
      // The two marks say the block was a MAP, which is how a run tells it from a legacy list.
      // `source` rides beside `subjects`: the FILE those subjects came from, which is what an approval
      // names and what "add to the toolset" writes into.
      // A RUN is handed the block whole (upstream `ExecServices.authored`), so nothing is carried twice.
      permissions: {
        tools: { read_file: "allow", glob: "allow", bash: "smart", ...TOOLSET_MARKERS },
        other: "deny",
        subjects: { bash: "deny", "git status": "allow" },
        source: "$/toolsets/chat/read-only",
      },
    });
  });

  it("starts from one and says more — sibling keys override", () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { read_file: "allow", bash: "deny", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: { $ref: "$/toolsets/chat/read-only", write_file: "ask", bash: "smart" } }));
    expect(environmentOf("plan")).toEqual({
      tools: ["read_file", "bash", "write_file"],
      // A `$ref` that says more is written on the STATE: a sibling is an entry no file holds, so a
      // line added to the file could be shadowed here, and the source says `inline`.
      permissions: {
        tools: { read_file: "allow", bash: "smart", write_file: "ask", ...TOOLSET_MARKERS },
        other: "deny",
        subjects: { bash: "smart" },
        source: "inline",
      },
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
    const legacy = { tools: ["read_file", "glob"], permissions: { tools: { read_file: "allow", glob: "ask" }, other: "deny" } };
    write(project.paths.workflowsDir, "old.json", state(legacy));
    write(project.paths.workflowsDir, "new.json", state({ tools: { read_file: "allow", glob: "ask", other: "deny" } }));
    // The same list and the same modes — and the MAP leaves its marks, which is how a run tells it
    // from the legacy reading: a map is the whole grant on a delegated agent, a list never was.
    expect(environmentOf("new")).toEqual({
      tools: legacy.tools,
      permissions: { ...legacy.permissions, tools: { ...legacy.permissions.tools, ...TOOLSET_MARKERS } },
    });
    expect(environmentOf("old")).toEqual(legacy);
    // The shell is the one tool the two forms load differently, on purpose: an old `bash: "ask"` is a
    // mode for the TOOL and asks before every line, as it always did; the map's is the answer for any
    // command nothing else names, on a line that is taken apart (decision 0007 §4).
    write(project.paths.workflowsDir, "oldsh.json", state({ tools: ["bash"], permissions: { tools: { bash: "ask" } } }));
    write(project.paths.workflowsDir, "newsh.json", state({ tools: { bash: "ask" } }));
    expect(environmentOf("oldsh")).toEqual({ tools: ["bash"], permissions: { tools: { bash: "ask" } } });
    expect(environmentOf("newsh")).toEqual({
      tools: ["bash"],
      permissions: { tools: { bash: "smart", ...TOOLSET_MARKERS }, subjects: { bash: "ask" }, source: "inline" },
    });
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

describe("the toolsets that SHIP (decision 0007 step 4)", () => {
  // The suite runs over an EMPTY built-in layer; these are about what ships, so they ask for it —
  // and reopen the project, whose paths were resolved before they could.
  beforeEach(() => {
    shippedLayer();
    project.close();
    project = openProject(dir, { baseDir: testHome() });
  });

  it("are listed from the built-in layer: two buckets, the same four names in each", () => {
    const listed = listToolsets(project.paths.roots);
    expect(listed.map((t) => t.id)).toEqual([
      "chat/ask-first",
      "chat/auto",
      "chat/full",
      "chat/read-only",
      "chat_control/ask-first",
      "chat_control/auto",
      "chat_control/full",
      "chat_control/read-only",
    ]);
    expect(listed.every((t) => t.root === project.paths.builtIn.dir && !t.overrides)).toBe(true);
  });

  it("LINT CLEAN — every one loads through a state that names it, with no issue and no warning", () => {
    for (const toolset of listToolsets(project.paths.roots)) {
      write(project.paths.workflowsDir, "plan.json", state({ tools: toolset.reference }));
      const entry = browseWorkflows(project).workflows.find((w) => w.rootId === "plan")!;
      expect(entry.loadError, toolset.id).toBeUndefined();
      expect(entry.issues, toolset.id).toEqual([]);
      expect(() => load("plan"), toolset.id).not.toThrow();
    }
  });

  it("reaches the engine as the list and block the map lowers to — the workflow tools among them", () => {
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/chat/read-only" }));
    expect(environmentOf("plan")).toEqual({
      // The nine a conversation has always held, then the eight of decision 0005, served since its
      // step 6 — before that they carried `unserved` and lowering left them out of this list.
      // The shell is HELD and not on the list: `"bash": "deny"` with no command that allows anything
      // is a shell with nothing to run, and it is withheld — `deny` at the gate.
      tools: ["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "web_fetch", "web_search", "list_workflows", "start_task", "move_task", "list_tasks", "answer_question", "hold_task", "release_task", "stop_task"],
      permissions: {
        tools: {
          read_file: "allow",
          glob: "allow",
          grep: "allow",
          edit: "deny",
          write_file: "deny",
          show_artifact: "allow",
          bash: "deny",
          web_fetch: "allow",
          web_search: "allow",
          list_workflows: "allow",
          start_task: "deny",
          move_task: "deny",
          list_tasks: "allow",
          answer_question: "deny",
          hold_task: "deny",
          release_task: "deny",
          stop_task: "deny",
          ...TOOLSET_MARKERS,
        },
        other: "deny",
        subjects: { bash: "deny" },
        // Beside `subjects`: the file they came from, which is what an approval names.
        source: "$/toolsets/chat/read-only",
      },
    });
    // `chat_control` holds the workflow tools and NOTHING of the project: the engine resolves those
    // eight against its registry, and a project tool is not on the list to be handed over at all.
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/toolsets/chat_control/ask-first" }));
    const control = environmentOf("plan") as { tools: string[]; permissions: { tools: Record<string, string>; other: string } };
    expect(control.tools).toEqual(["list_workflows", "start_task", "move_task", "list_tasks", "answer_question", "hold_task", "release_task", "stop_task"]);
    expect(control.tools).not.toContain("bash");
    expect(control.permissions.other).toBe("deny");
    expect(control.permissions.tools).toMatchObject({ list_workflows: "ask", start_task: "ask", stop_task: "ask" });
  });

  it("are READ for the composer with the layer that supplied each, a project's file winning and a `$ref` followed", () => {
    write(project.paths.jairaDir, "toolsets/chat/read-only.json", { $ref: "$SYSTEM/toolsets/chat/read-only", bash: "ask" });
    write(testHome(), "toolsets/feature/implementation/writes-asking.json", { write_file: "ask", other: "deny" });
    write(project.paths.jairaDir, "toolsets/chat/broken.json", { read_file: "sometimes" });
    const read = readToolsets(project.paths);
    expect(read.map((t) => [t.id, t.layer])).toEqual([
      ["chat/ask-first", "system"],
      ["chat/auto", "system"],
      ["chat/full", "system"],
      ["chat/read-only", "project"],
      ["chat_control/ask-first", "system"],
      ["chat_control/auto", "system"],
      ["chat_control/full", "system"],
      ["chat_control/read-only", "system"],
      ["feature/implementation/writes-asking", "base"],
    ]);
    // The override is offered as the map it RESOLVES to — what picking its row would write.
    const overridden = read.find((t) => t.id === "chat/read-only")!.decl;
    expect(overridden).toMatchObject({ read_file: "allow", edit: "deny", bash: "ask", other: "deny" });
    expect(overridden).not.toHaveProperty("$ref");
    // A toolset nobody could read is left out rather than offered as half of itself.
    expect(read.some((t) => t.id === "chat/broken")).toBe(false);
  });
});
