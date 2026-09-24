/**
 * "Add to the permission set" (decision 0007 §4): a remembered answer written into the permission set file that
 * asked, in the layer a person chose.
 *
 * What is worth proving against a real directory tree: that the write lands in the RIGHT layer, that
 * an override of a lower layer's permission set keeps following it and is resolved by the same loader a run
 * uses (and lints clean), that somebody's file keeps its comments and its order, and that nothing is
 * ever written into what ships or invented for a map that has no file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PERMISSION_SET_MARKERS, jairaPaths, setBuiltInDir, type JairaPaths } from "@jaira/shared";
import { initProject } from "../src/project";
import { readWorkflowFiles } from "../src/snapshots";
import { addToPermissionSet, loadWorkflowBundle, permissionSetIdOfReference, permissionSetWriteTargets } from "../src/permissionSets";
import { workflowLoadOptions } from "../src/workflowRefs";

let scratch: string;
let paths: JairaPaths;
let builtIn: string;

const REF = "$/permission-sets/chat/ask-first";
const SHIPPED = { read_file: "allow", bash: "ask", "git status": "allow", other: "deny" };

function write(root: string, relPath: string, body: unknown): string {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return file;
}

function state(environment: unknown): unknown {
  return {
    label: "Plan",
    outputs: { plan: { schema: { type: "string" }, binding: ".operation.output.plan" } },
    environment,
    operation: { kind: "prompt", prompt: "go", model: "claude-sonnet-5", output: { plan: { schema: { type: "string" } } } },
  };
}

/** Load `plan` the way a run does, collecting every permission set issue the lint surface would show. */
function loadPlan(): { permissions: unknown; issues: string[] } {
  const issues: string[] = [];
  const bundle = loadWorkflowBundle(readWorkflowFiles(paths.workflowsDir), "plan", {
    ...workflowLoadOptions(paths),
    onPermissionSetIssue: (issue) => issues.push(`${issue.severity}: ${issue.message}`),
  });
  return { permissions: bundle.states["plan"]!.environment?.permissions, issues };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "jaira-permission-set-write-"));
  builtIn = join(scratch, "builtin");
  const home = join(scratch, "home");
  const projectDir = join(scratch, "project");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(builtIn, { recursive: true });
  setBuiltInDir(builtIn);
  initProject(projectDir, home);
  paths = jairaPaths(projectDir, home, builtIn);
  write(paths.workflowsDir, "plan.json", state({ tools: REF }));
});

afterEach(() => {
  setBuiltInDir(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

describe("where a line can be written", () => {
  it("offers both writable layers for a BUILT-IN permission set, each as an override that follows it — and never the built-in layer", () => {
    write(builtIn, "permission-sets/chat/ask-first.json", SHIPPED);
    const found = permissionSetWriteTargets(paths, REF);
    expect(found.id).toBe("chat/ask-first");
    expect(found.targets.map((t) => [t.layer, t.file, t.follows, t.shadowed])).toEqual([
      ["project", ".jaira/permission-sets/chat/ask-first.json", "$SYSTEM/permission-sets/chat/ask-first", undefined],
      ["base", "~/.jaira/permission-sets/chat/ask-first.json", "$SYSTEM/permission-sets/chat/ask-first", undefined],
    ]);
    expect(found.targets.every((t) => !t.path.startsWith(builtIn))).toBe(true);
  });

  it("follows the NEAREST lower layer, edits in place where the layer holds the file, and says when a nearer copy shadows a write", () => {
    write(builtIn, "permission-sets/chat/ask-first.json", SHIPPED);
    write(paths.base.baseDir, "permission-sets/chat/ask-first.json", { ...SHIPPED, "git log": "allow" });
    expect(permissionSetWriteTargets(paths, REF).targets.map((t) => [t.layer, t.follows])).toEqual([
      ["project", "$BASE/permission-sets/chat/ask-first"],
      ["base", undefined],
    ]);
    // A project copy that does NOT follow the shared one wins the search, so a shared write is not read here…
    write(paths.jairaDir, "permission-sets/chat/ask-first.json", SHIPPED);
    expect(permissionSetWriteTargets(paths, REF).targets.map((t) => [t.layer, t.follows, t.shadowed])).toEqual([
      ["project", undefined, undefined],
      ["base", undefined, true],
    ]);
    // …and one that does follow it is not in the way.
    write(paths.jairaDir, "permission-sets/chat/ask-first.json", { $ref: "$BASE/permission-sets/chat/ask-first", "git commit": "allow" });
    expect(permissionSetWriteTargets(paths, REF).targets.map((t) => [t.layer, t.shadowed])).toEqual([
      ["project", undefined],
      ["base", undefined],
    ]);
  });

  it("offers only the layer that holds a permission set nothing lower does", () => {
    write(paths.jairaDir, "permission-sets/chat/ask-first.json", SHIPPED);
    expect(permissionSetWriteTargets(paths, REF).targets.map((t) => t.layer)).toEqual(["project"]);
  });

  it("offers NOTHING, and says why, for a map written on the state, a reference that is not layered, a YAML file and a missing file", () => {
    expect(permissionSetWriteTargets(paths, "inline")).toMatchObject({ targets: [], unwritable: expect.stringMatching(/written on the state itself/) });
    expect(permissionSetWriteTargets(paths, undefined).targets).toEqual([]);
    expect(permissionSetWriteTargets(paths, "$BASE/permission-sets/chat/ask-first")).toMatchObject({ targets: [], unwritable: expect.stringMatching(/layered/) });
    expect(permissionSetWriteTargets(paths, "./mine")).toMatchObject({ targets: [] });
    expect(permissionSetWriteTargets(paths, REF)).toMatchObject({ id: "chat/ask-first", targets: [], unwritable: expect.stringMatching(/No layer holds/) });
    write(paths.jairaDir, "permission-sets/chat/ask-first.yaml", "read_file: allow\n");
    expect(permissionSetWriteTargets(paths, REF)).toMatchObject({ targets: [], unwritable: expect.stringMatching(/YAML/) });
    // A reference cannot climb out of `permission-sets/`.
    expect(permissionSetIdOfReference("$/permission-sets/../settings")).toBeUndefined();
    expect(permissionSetIdOfReference("$/permission-sets/chat/../../settings")).toBeUndefined();
    expect(permissionSetIdOfReference("$/permission-sets/solo")).toBeUndefined();
    expect(permissionSetIdOfReference("$/permission-sets/feature/implementation/writes-asking")).toBe("feature/implementation/writes-asking");
  });
});

describe("writing the line", () => {
  it("creates an OVERRIDE of a built-in permission set that keeps following it — the loader resolves it and lint is clean", () => {
    const shipped = write(builtIn, "permission-sets/chat/ask-first.json", SHIPPED);
    const before = readFileSync(shipped, "utf8");

    const written = addToPermissionSet(paths, REF, "project", { "terraform plan": "allow" });
    expect(written).toEqual({ file: join(paths.jairaDir, "permission-sets", "chat", "ask-first.json"), created: true });
    expect(readFileSync(written.file, "utf8")).toBe('{\n  "$ref": "$SYSTEM/permission-sets/chat/ask-first",\n  "terraform plan": "allow"\n}\n');
    // What ships is untouched.
    expect(readFileSync(shipped, "utf8")).toBe(before);

    const loaded = loadPlan();
    expect(loaded.issues).toEqual([]);
    expect(loaded.permissions).toEqual({
      // The two marks say the block was a MAP, which is how a run tells it from a state that declared none.
      tools: { read_file: "allow", bash: "ask", ...PERMISSION_SET_MARKERS },
      implementations: {},
      other: "deny",
      subjects: { bash: "ask", "git status": "allow", "terraform plan": "allow" },
      source: REF,
      functions: {},
    });

    // It FOLLOWS: a line the built-in layer gains later is inherited, which a copy would have frozen out.
    write(builtIn, "permission-sets/chat/ask-first.json", { ...SHIPPED, "git diff": "allow" });
    expect(loadPlan().permissions).toMatchObject({ subjects: { "git diff": "allow", "terraform plan": "allow" } });

    // The next answer finds the override there and edits it in place.
    expect(addToPermissionSet(paths, REF, "project", { git: "deny" })).toMatchObject({ created: false });
    expect(readFileSync(written.file, "utf8")).toBe('{\n  "$ref": "$SYSTEM/permission-sets/chat/ask-first",\n  "terraform plan": "allow",\n  "git": "deny"\n}\n');
    expect(loadPlan()).toMatchObject({ issues: [], permissions: { subjects: { git: "deny" } } });
  });

  it("writes 'for all projects' into the shared root, following the built-in one", () => {
    write(builtIn, "permission-sets/chat/ask-first.json", SHIPPED);
    const written = addToPermissionSet(paths, REF, "base", { "git commit": "allow" });
    expect(written.file).toBe(join(paths.base.baseDir, "permission-sets", "chat", "ask-first.json"));
    expect(existsSync(join(paths.jairaDir, "permission-sets", "chat", "ask-first.json"))).toBe(false);
    expect(loadPlan()).toMatchObject({ issues: [], permissions: { subjects: { "git commit": "allow", "git status": "allow" } } });
  });

  it("PRESERVES the format of a file somebody wrote: order, indentation, blank lines, and an entry's implementation", () => {
    // No comments: a permission set file is read as strict JSON by the loader, so one with a comment in it
    // never loads in the first place (the text edit itself keeps them; see the shared test).
    const text = [
      "{",
      '\t"read_file": "allow",',
      '\t"write_file": { "mode": "ask", "implementation": "native" },',
      "",
      '\t"bash": "ask",',
      '\t"git commit": "ask",',
      '\t"other": "deny"',
      "}",
      "",
    ].join("\n");
    const file = write(paths.jairaDir, "permission-sets/chat/ask-first.json", text);
    addToPermissionSet(paths, REF, "project", { "git commit": "allow", "terraform plan": "deny", write_file: "allow" });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "{",
        '\t"read_file": "allow",',
        '\t"write_file": { "mode": "allow", "implementation": "native" },',
        "",
        '\t"bash": "ask",',
        '\t"git commit": "allow",',
        '\t"other": "deny",',
        '\t"terraform plan": "deny"',
        "}",
        "",
      ].join("\n"),
    );
    expect(loadPlan().issues).toEqual([]);
  });

  it("REFUSES, writing nothing: the built-in layer, a map with no file, a list file, and an empty answer", () => {
    const shipped = write(builtIn, "permission-sets/chat/ask-first.json", SHIPPED);
    const before = readFileSync(shipped, "utf8");
    expect(() => addToPermissionSet(paths, REF, "system", { git: "allow" })).toThrow(/read-only/);
    expect(readFileSync(shipped, "utf8")).toBe(before);

    expect(() => addToPermissionSet(paths, "inline", "project", { git: "allow" })).toThrow(/written on the state itself/);
    expect(() => addToPermissionSet(paths, undefined, "project", { git: "allow" })).toThrow(/no permission set file/);
    expect(() => addToPermissionSet(paths, REF, "project", {})).toThrow(/nothing to add/);
    expect(existsSync(join(paths.jairaDir, "permission-sets"))).toBe(false);

    // A LIST is no permission set and has no place for a command subject: it is left exactly as it was.
    const list = write(paths.jairaDir, "permission-sets/chat/ask-first.json", ["bash", "read_file"]);
    const listBefore = readFileSync(list, "utf8");
    expect(() => addToPermissionSet(paths, REF, "project", { git: "allow" })).toThrow(/not a map/);
    expect(readFileSync(list, "utf8")).toBe(listBefore);
  });
});
