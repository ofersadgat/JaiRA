/**
 * Permission sets end to end (decision 0007 §1–§2): files in buckets under the layer roots, referenced from
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
import { PERMISSION_SET_MARKERS } from "@jaira/shared";
import { loadBundle, snapshotHash } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "../src/snapshots";
import { listPermissionSets, loadWorkflowBundle, readPermissionSets } from "../src/permissionSets";
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
  dir = mkdtempSync(join(tmpdir(), "jaira-permission-sets-"));
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

describe("a permission set, referenced from a state", () => {
  it("resolves `$/permission-sets/<bucket>/<name>` and reaches the engine as a list and a block", () => {
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "allow", glob: "allow", bash: "deny", "git status": "allow", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/chat/read-only" }));
    expect(environmentOf("plan")).toEqual({
      tools: ["read_file", "glob", "bash"],
      // The shell is offered and its LINES are judged: the gate is handed `ask` for it, and the
      // `deny` its author wrote is the answer for any command no entry names (decision 0007 §4).
      // The two marks say the block was a MAP, which is how a run tells it from a state that declared none.
      // `source` rides beside `subjects`: the FILE those subjects came from, which is what an approval
      // names and what "add to the permission set" writes into.
      // A RUN is handed the block whole (upstream `ExecServices.authored`), so nothing is carried twice.
      permissions: {
        tools: { read_file: "allow", glob: "allow", bash: "ask", ...PERMISSION_SET_MARKERS },
        implementations: {},
        other: "deny",
        subjects: { bash: "deny", "git status": "allow" },
        source: "$/permission-sets/chat/read-only",
        functions: {},
      },
    });
  });

  it("starts from one and says more — sibling keys override", () => {
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "allow", bash: "deny", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: { $ref: "$/permission-sets/chat/read-only", write_file: "ask", bash: { function: "smart" } } }));
    expect(environmentOf("plan")).toEqual({
      tools: ["read_file", "bash", "write_file"],
      // A `$ref` that says more is written on the STATE: a sibling is an entry no file holds, so a
      // line added to the file could be shadowed here, and the source says `inline`.
      permissions: {
        tools: { read_file: "allow", bash: "ask", write_file: "ask", ...PERMISSION_SET_MARKERS },
        implementations: {},
        other: "deny",
        subjects: { bash: "ask" },
        source: "inline",
        functions: { bash: "smart" },
      },
    });
  });

  it("follows a permission set file that itself starts from another, into a NESTED bucket", () => {
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.jairaDir, "permission-sets/feature/implementation/build.json", {
      $ref: "$/permission-sets/chat/read-only",
      edit: { mode: "ask", implementation: "native" },
    });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/feature/implementation/build" }));
    expect(environmentOf("plan")).toEqual({
      tools: ["read_file", "edit"],
      permissions: { tools: { read_file: "allow", edit: "ask", ...PERMISSION_SET_MARKERS }, other: "deny", functions: {}, implementations: { edit: "native" } },
    });
  });

  it("layers like everything else: the project's file wins, and the shared root supplies what it lacks", () => {
    write(testHome(), "permission-sets/chat/read-only.json", { read_file: "ask", other: "ask" });
    write(testHome(), "permission-sets/chat/shared-only.json", { glob: "allow" });
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/chat/read-only" }));
    write(project.paths.workflowsDir, "other.json", state({ tools: "$/permission-sets/chat/shared-only" }));
    expect(environmentOf("plan")).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", functions: {} } });
    expect(environmentOf("other")).toEqual({ tools: ["glob"], permissions: { tools: { glob: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {} } });
  });

  it("is inherited by a child, and a child's own permission set replaces it", () => {
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.workflowsDir, "wf.json", {
      environment: { tools: "$/permission-sets/chat/read-only" },
      children: { a: {}, b: { environment: { tools: { bash: { function: "smart" } } } } },
      sequence: ["a", "b"],
    });
    const leaf = (state({}) as Record<string, unknown>);
    delete leaf["environment"];
    write(project.paths.workflowsDir, "wf/a.json", leaf);
    write(project.paths.workflowsDir, "wf/b.json", leaf);
    const bundle = load("wf");
    expect(bundle.states["wf/a"]!.environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", functions: {} } });
    expect(bundle.states["wf/b"]!.environment?.tools).toEqual(["bash"]);
  });
});

describe("a permission set inside a REFERENCED block", () => {
  const map = { read_file: "allow", glob: "allow", bash: "deny", "git status": "allow", other: "deny" };
  const scopes = [{ path: "app/**", default: "allow" }];

  it("reaches the engine exactly as the same map written on the state — environment, operation and a child's mount", () => {
    write(project.paths.jairaDir, "envs/reader.json", { tools: map, permissions: { scopes } });
    write(project.paths.jairaDir, "envs/named.json", { $ref: "$/envs/base" });
    write(project.paths.jairaDir, "envs/base.json", { tools: "$/permission-sets/chat/read-only" });
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", map);
    const op = (state({}) as { operation: Record<string, unknown> }).operation;
    write(project.paths.jairaDir, "ops/plan.json", { ...op, tools: map });
    write(project.paths.workflowsDir, "written.json", state({ tools: map, permissions: { scopes } }));
    write(project.paths.workflowsDir, "byref.json", state("$/envs/reader"));
    write(project.paths.workflowsDir, "bydollarref.json", state({ $ref: "$/envs/reader", model: "claude-sonnet-5" }));
    write(project.paths.workflowsDir, "writtenname.json", state({ tools: "$/permission-sets/chat/read-only" }));
    write(project.paths.workflowsDir, "chained.json", state("$/envs/named"));
    const writtenOp: Record<string, unknown> = { ...(state({}) as Record<string, unknown>), operation: { ...op, tools: map } };
    delete writtenOp["environment"];
    write(project.paths.workflowsDir, "writtenop.json", writtenOp);
    write(project.paths.workflowsDir, "refop.json", { ...writtenOp, operation: "$/ops/plan" });

    // Before 0007's follow-up this load FAILED: the map reached the engine inside the referenced
    // block and the engine refused it as `unrecognized binding form`.
    const same = load("written").states["written"]!.environment;
    expect(same?.tools).toEqual(["read_file", "glob", "bash"]);
    expect(load("byref").states["byref"]!.environment).toEqual(same);
    const dollar = load("bydollarref").states["bydollarref"]!.environment;
    expect({ tools: dollar?.tools, permissions: dollar?.permissions }).toEqual(same);
    // A permission set REFERENCE inside a block that starts from another: resolved, and named as the source.
    expect(load("chained").states["chained"]!.environment).toEqual(load("writtenname").states["writtenname"]!.environment);
    // An operation's tools resolve onto the state's environment; the operation itself is the same too.
    const opOf = (id: string) => {
      const resolved = load(id).states[id]!;
      return { operation: resolved.operation, environment: resolved.environment };
    };
    expect(opOf("refop")).toEqual(opOf("writtenop"));
    expect(opOf("refop").environment?.tools).toEqual(["read_file", "glob", "bash"]);
  });

  it("is inherited by a child exactly as a map written on the parent — or on the child's mount", () => {
    write(project.paths.jairaDir, "envs/reader.json", { tools: map });
    const leaf = state({}) as Record<string, unknown>;
    delete leaf["environment"];
    for (const [id, environment] of [["wfw", { tools: map }], ["wfr", "$/envs/reader"]] as const) {
      write(project.paths.workflowsDir, `${id}.json`, { environment, children: { a: {} }, sequence: ["a"] });
      write(project.paths.workflowsDir, `${id}/a.json`, leaf);
      write(project.paths.workflowsDir, `m${id}.json`, { children: { a: { environment } }, sequence: ["a"] });
      write(project.paths.workflowsDir, `m${id}/a.json`, leaf);
    }
    const written = load("wfw").states["wfw/a"]!.environment;
    expect(written?.tools).toEqual(["read_file", "glob", "bash"]);
    expect(load("wfr").states["wfr/a"]!.environment).toEqual(written);
    expect(load("mwfr").states["mwfr/a"]!.environment).toEqual(load("mwfw").states["mwfw/a"]!.environment);
    expect(load("mwfr").states["mwfr/a"]!.environment?.tools).toEqual(["read_file", "glob", "bash"]);
  });

  it("is PINNED: the block's file is in the closure, and a pinned task does not see a later edit to it", async () => {
    write(project.paths.jairaDir, "envs/reader.json", { tools: { read_file: "allow", other: "deny" } });
    write(project.paths.workflowsDir, "plan.json", state("$/envs/reader"));
    const read: string[] = [];
    const bundle = load("plan", (file) => read.push(file.replace(/\\/g, "/")));
    expect(read.some((file) => file.endsWith("envs/reader.json"))).toBe(true);

    const snap = await ensureSnapshot(project.paths.snapshotsDir, bundle);
    write(project.paths.jairaDir, "envs/reader.json", { tools: { read_file: "deny", other: "deny" } });
    const pinned = loadSnapshot(project.paths.snapshotsDir, snap.hash);
    expect(pinned.states["plan"]!.environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", functions: {} } });
    expect(snapshotHash(load("plan"))).not.toBe(snap.hash);
  });

  it("leaves a referenced block with no permission set untouched: the same state and snapshot hash as around the door", () => {
    write(project.paths.jairaDir, "envs/plain.json", { model: "claude-sonnet-5" });
    write(project.paths.workflowsDir, "plain.json", state("$/envs/plain"));
    const direct = loadBundle(readWorkflowFiles(project.paths.workflowsDir), "plain", workflowLoadOptions(project.paths));
    expect(load("plain").states["plain"]).toEqual(direct.states["plain"]);
    expect(snapshotHash(load("plain"))).toBe(snapshotHash(direct));
  });

  it("refuses the list form inside a referenced block, naming the block, and a run will not start", () => {
    write(project.paths.jairaDir, "envs/old.json", { tools: ["read_file"] });
    write(project.paths.workflowsDir, "old.json", state("$/envs/old"));
    const entry = browseWorkflows(project).workflows.find((w) => w.rootId === "old")!;
    expect(entry.issues).toEqual([
      expect.objectContaining({ stateId: "old", path: "environment.tools", severity: "error", message: expect.stringMatching(/^in the block '\$\/envs\/old' names: .*the list form was removed/) }),
    ]);
    expect(() => load("old")).toThrow(/the list form was removed/);
  });
});

describe("a state that declares no permission set", () => {
  it("loads untouched, through the door and around it", () => {
    write(project.paths.workflowsDir, "plain.json", state({ model: "claude-sonnet-5" }));
    const files = readWorkflowFiles(project.paths.workflowsDir);
    const direct = loadBundle(files, "plain", workflowLoadOptions(project.paths));
    expect(load("plain").states["plain"]).toEqual(direct.states["plain"]);
    expect(snapshotHash(load("plain"))).toBe(snapshotHash(direct));
  });
});

describe("the snapshot", () => {
  it("records the permission set file in the closure, and a pinned task does not see a later edit", async () => {
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "allow", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/chat/read-only" }));
    const read: string[] = [];
    const bundle = load("plan", (file) => read.push(file.replace(/\\/g, "/")));
    expect(read.some((file) => file.endsWith("permission-sets/chat/read-only.json"))).toBe(true);

    const snap = await ensureSnapshot(project.paths.snapshotsDir, bundle);
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "deny", other: "deny" });
    const pinned = loadSnapshot(project.paths.snapshotsDir, snap.hash);
    expect(pinned.states["plan"]!.environment?.permissions).toEqual({ tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", functions: {} });
    // …and the edit is a different workflow to the next task.
    expect(snapshotHash(load("plan"))).not.toBe(snap.hash);
  });
});

describe("the linter", () => {
  const issuesOf = (rootId: string) => browseWorkflows(project).workflows.find((w) => w.rootId === rootId)!;

  it("is quiet about a good permission set", () => {
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { read_file: "allow", "git log": "allow", script: "ask", other: "deny" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/chat/read-only" }));
    expect(issuesOf("plan").loadError).toBeUndefined();
    expect(issuesOf("plan").issues).toEqual([]);
  });

  it("refuses the old LIST form and the old `permissions` modes, and a run will not start under either", () => {
    write(project.paths.workflowsDir, "old.json", state({ tools: ["read_file"], permissions: { tools: { read_file: "allow" } } }));
    write(project.paths.workflowsDir, "ro.json", state({ permissions: { profile: "read-only" } }));
    expect(issuesOf("old").issues).toEqual([
      expect.objectContaining({ stateId: "old", path: "environment.tools", severity: "error", message: expect.stringMatching(/the list form was removed/) }),
      expect.objectContaining({ stateId: "old", path: "environment.tools", severity: "error", message: expect.stringMatching(/permissions\.tools is no longer read/) }),
    ]);
    expect(issuesOf("ro").issues).toEqual([
      expect.objectContaining({ stateId: "ro", path: "environment.permissions", severity: "error", message: expect.stringMatching(/permissions\.profile is no longer read/) }),
    ]);
    expect(() => load("old")).toThrow(/the list form was removed/);
    rmSync(join(project.paths.workflowsDir, "old.json"));
    expect(() => load("ro")).toThrow(/permissions\.profile is no longer read/);
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
    write(project.paths.jairaDir, "permission-sets/chat/broken.json", { read_file: "sometimes" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: { $ref: "$/permission-sets/chat/broken", bash: "ask" } }));
    const entry = issuesOf("plan");
    expect(entry.loadError).toBeUndefined();
    expect(entry.issues).toEqual([
      { stateId: "plan", path: "environment.tools.read_file", severity: "error", message: expect.stringMatching(/a mode is one of allow, deny, ask, or a function/) },
    ]);
    // A RUN is refused rather than started under a permission set nobody could read.
    expect(() => load("plan")).toThrow(/plan: environment\.tools\.read_file: .*a mode is one of/);
  });

  it("reports a reference cycle as an error NAMING it", () => {
    write(project.paths.jairaDir, "permission-sets/loop/a.json", { $ref: "$/permission-sets/loop/b", read_file: "allow" });
    write(project.paths.jairaDir, "permission-sets/loop/b.json", { $ref: "$/permission-sets/loop/a" });
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/loop/a" }));
    const [issue] = issuesOf("plan").issues;
    expect(issue).toMatchObject({ stateId: "plan", path: "environment.tools", severity: "error" });
    expect(issue!.message).toMatch(/^permission set reference cycle: .*permission-sets\/loop\/a\.json# → .*permission-sets\/loop\/b\.json# → .*permission-sets\/loop\/a\.json#$/);
    expect(() => load("plan")).toThrow(/permission set reference cycle/);
  });

  it("reports a reference that names nothing", () => {
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/chat/nope" }));
    expect(issuesOf("plan").issues).toEqual([expect.objectContaining({ path: "environment.tools", severity: "error" })]);
  });
});

describe("buckets", () => {
  it("lists every permission set across the layer roots, first root winning, buckets free to nest", () => {
    write(testHome(), "permission-sets/chat/read-only.json", {});
    write(testHome(), "permission-sets/chat/full.json", {});
    write(testHome(), "permission-sets/chat_control/read-only.json", {});
    write(testHome(), "permission-sets/loose.json", {});
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", {});
    write(project.paths.jairaDir, "permission-sets/feature/implementation/build.json", {});

    const listed = listPermissionSets(project.paths.roots);
    expect(listed.map((t) => [t.id, t.bucket, t.name, t.root === project.paths.jairaDir ? "project" : "base", t.overrides])).toEqual([
      ["chat/full", "chat", "full", "base", false],
      ["chat/read-only", "chat", "read-only", "project", true],
      ["chat_control/read-only", "chat_control", "read-only", "base", false],
      ["feature/implementation/build", "feature/implementation", "build", "project", false],
    ]);
    expect(listed[3]!.reference).toBe("$/permission-sets/feature/implementation/build");
  });

  it("picks up a THIRD layer root with no change — it reads whatever `roots` holds", () => {
    const third = mkdtempSync(join(tmpdir(), "jaira-permission-sets-system-"));
    try {
      write(third, "permission-sets/chat/ask-first.json", {});
      write(project.paths.jairaDir, "permission-sets/chat/read-only.json", {});
      const listed = listPermissionSets([...project.paths.roots, third]);
      expect(listed.map((t) => t.id)).toEqual(["chat/ask-first", "chat/read-only"]);
      expect(listed[0]!.root).toBe(third);
    } finally {
      rmSync(third, { recursive: true, force: true });
    }
  });
});

describe("the permission sets that SHIP (decision 0007 step 4)", () => {
  // The suite runs over an EMPTY built-in layer; these are about what ships, so they ask for it —
  // and reopen the project, whose paths were resolved before they could.
  beforeEach(() => {
    shippedLayer();
    project.close();
    project = openProject(dir, { baseDir: testHome() });
  });

  it("are listed from the built-in layer: two buckets, the same four names in each", () => {
    const listed = listPermissionSets(project.paths.roots);
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
    for (const permissionSet of listPermissionSets(project.paths.roots)) {
      write(project.paths.workflowsDir, "plan.json", state({ tools: permissionSet.reference }));
      const entry = browseWorkflows(project).workflows.find((w) => w.rootId === "plan")!;
      expect(entry.loadError, permissionSet.id).toBeUndefined();
      expect(entry.issues, permissionSet.id).toEqual([]);
      expect(() => load("plan"), permissionSet.id).not.toThrow();
    }
  });

  it("reaches the engine as the list and block the map lowers to — the workflow tools among them", () => {
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/chat/read-only" }));
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
          ...PERMISSION_SET_MARKERS,
        },
        implementations: {},
        other: "deny",
        subjects: { bash: "deny" },
        // Beside `subjects`: the file they came from, which is what an approval names.
        source: "$/permission-sets/chat/read-only",
        functions: {},
      },
    });
    // `chat_control` holds the workflow tools and NOTHING of the project: the engine resolves those
    // eight against its registry, and a project tool is not on the list to be handed over at all.
    write(project.paths.workflowsDir, "plan.json", state({ tools: "$/permission-sets/chat_control/ask-first" }));
    const control = environmentOf("plan") as { tools: string[]; permissions: { tools: Record<string, string>; other: string } };
    expect(control.tools).toEqual(["list_workflows", "start_task", "move_task", "list_tasks", "answer_question", "hold_task", "release_task", "stop_task"]);
    expect(control.tools).not.toContain("bash");
    expect(control.permissions.other).toBe("deny");
    expect(control.permissions.tools).toMatchObject({ list_workflows: "ask", start_task: "ask", stop_task: "ask" });
  });

  it("are READ for the composer with the layer that supplied each, a project's file winning and a `$ref` followed", () => {
    write(project.paths.jairaDir, "permission-sets/chat/read-only.json", { $ref: "$SYSTEM/permission-sets/chat/read-only", bash: "ask" });
    write(testHome(), "permission-sets/feature/implementation/writes-asking.json", { write_file: "ask", other: "deny" });
    write(project.paths.jairaDir, "permission-sets/chat/broken.json", { read_file: "sometimes" });
    const read = readPermissionSets(project.paths);
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
    // A permission set nobody could read is left out rather than offered as half of itself.
    expect(read.some((t) => t.id === "chat/broken")).toBe(false);
  });
});
