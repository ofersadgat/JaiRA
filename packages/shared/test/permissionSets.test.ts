/**
 * The permission set data model (decision 0007 §1): the map, its references, and the lowering that hands a
 * map-form state to an engine that only takes a list and a block — and reads it back.
 */
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { operationSchema, toolsSchema } from "../src/schemas";
import {
  declOfPermissionSet,
  heldTools,
  isLoweredPermissionSet,
  shellWithheld,
  declaresTools,
  lowerStatePermissionSets,
  lowerPermissionSet,
  offeredTools,
  parsePermissionSet,
  permissionsOfPermissionSet,
  resolvePermissionSetDecl,
  shellSubjects,
  gateToolModes,
  subjectKindOf,
  toolImplementations,
  toolModes,
  PERMISSION_SET_MARKERS,
  permissionSetOfEnvironment,
  permissionSetOfSettings,
  functionReferencesOf,
  type PermissionSetIssue,
  type PermissionSetReader,
} from "../src/permissionSets";

/** A reader over an in-memory set of permission set files, keyed by the reference that names them. */
function readerOver(files: Record<string, unknown>): PermissionSetReader {
  return (reference, _from) => {
    if (!Object.hasOwn(files, reference)) throw new Error(`reference '${reference}' matches no file`);
    return { value: files[reference], key: reference, from: reference };
  };
}

const NO_FILES = readerOver({});

describe("a subject", () => {
  it.each([
    ["read_file", "tool"],
    ["bash", "tool"],
    ["other", "other"],
    ["script", "script"],
    ["git commit", "command"],
    ["git push --force", "command"],
    ["git", "command"],
    ["apt-get", "command"],
    // The workflow tools are named verb_object, so the shell programs they once shadowed are
    // commands again: a permission set can say `start`, `move` and `stop` as it says `git`.
    ["start_task", "tool"],
    ["move_task", "tool"],
    ["list_tasks", "tool"],
    ["answer_question", "tool"],
    ["start", "command"],
    ["move", "command"],
    ["stop", "command"],
    ["reed_file", "unknown-tool"],
    ["Glob", "unknown-tool"],
    // A tool of an MCP server, and a server's own line (the units doc `mcp-servers`).
    ["mcp__github__create_issue", "mcp"],
    ["mcp__github", "mcp"],
    ["mcp__a__b__c", "mcp"],
  ])("'%s' is a %s", (subject, kind) => {
    expect(subjectKindOf(subject)).toBe(kind);
  });
});

describe("parsing the map", () => {
  it("reads subject → mode: present is offered with that mode, absent is not offered", () => {
    const { permissionSet, issues } = parsePermissionSet({ read_file: "allow", web_fetch: "ask", bash: "ask" });
    expect(issues).toEqual([]);
    expect(offeredTools(permissionSet)).toEqual(["read_file", "web_fetch", "bash"]);
    expect(toolModes(permissionSet)).toEqual({ read_file: "allow", web_fetch: "ask", bash: "ask" });
    expect(offeredTools(permissionSet)).not.toContain("write_file");
  });

  it("WITHHOLDS a shell it denies outright — held as written, handed to nobody", () => {
    const { permissionSet } = parsePermissionSet({ read_file: "allow", bash: "deny", other: "deny" });
    expect(shellWithheld(permissionSet)).toBe(true);
    expect(heldTools(permissionSet)).toEqual(["read_file", "bash"]);
    expect(offeredTools(permissionSet)).toEqual(["read_file"]);
    expect(gateToolModes(permissionSet)).toEqual({ read_file: "allow", bash: "deny" });
    // A command subject that denies too leaves nothing to run: still withheld.
    expect(shellWithheld(parsePermissionSet({ bash: "deny", "git push": "deny" }).permissionSet)).toBe(true);
    // One that allows, asks or names a function keeps the shell OFFERED, for those lines.
    for (const mode of ["allow", "ask", { function: "smart" }]) {
      const offered = parsePermissionSet({ bash: "deny", "git status": mode }).permissionSet;
      expect(shellWithheld(offered)).toBe(false);
      expect(offeredTools(offered)).toEqual(["bash"]);
      expect(gateToolModes(offered)).toEqual({ bash: "ask" });
    }
    expect(shellWithheld(parsePermissionSet({ bash: "deny", script: "ask" }).permissionSet)).toBe(false);
  });

  it("round-trips a WITHHELD shell through the lowered block: held, not offered, and its authored mode", () => {
    const permissionSet = parsePermissionSet({ read_file: "allow", bash: "deny", other: "deny" }).permissionSet;
    const lowered = lowerPermissionSet(permissionSet);
    expect(lowered.tools).toEqual(["read_file"]);
    expect(lowered.permissions).toEqual({ tools: { read_file: "allow", bash: "deny", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", subjects: { bash: "deny" }, functions: {} });
    const back = permissionSetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back).toEqual(permissionSet);
    expect(declOfPermissionSet(back)).toEqual({ read_file: "allow", bash: "deny", other: "deny" });
  });

  it("carries an offered shell's subjects in `subjects` alone — `permissions.tools` holds tools and the marks", () => {
    const lowered = lowerPermissionSet(parsePermissionSet({ bash: "deny", "git status": "allow", other: "deny" }).permissionSet, undefined, "$/permission-sets/x/y");
    const tools = lowered.permissions!.tools!;
    expect(tools).toEqual({ bash: "ask", ...PERMISSION_SET_MARKERS });
    expect(lowered.permissions).toMatchObject({ subjects: { bash: "deny", "git status": "allow" }, source: "$/permission-sets/x/y" });
    expect(Object.keys(permissionSetOfEnvironment(lowered.tools, lowered.permissions).entries)).toEqual(["bash", "git status"]);
  });

  it("reads an object entry, with the implementation chosen too", () => {
    const { permissionSet, issues } = parsePermissionSet({ write_file: { mode: "ask", implementation: "native" }, read_file: { mode: "allow" } });
    expect(issues).toEqual([]);
    expect(toolModes(permissionSet)).toEqual({ write_file: "ask", read_file: "allow" });
    expect(toolImplementations(permissionSet)).toEqual({ write_file: "native" });
  });

  it("keeps `other` apart from the entries — it names no one tool", () => {
    const { permissionSet } = parsePermissionSet({ read_file: "allow", other: "deny" });
    expect(permissionSet.other).toBe("deny");
    expect(Object.keys(permissionSet.entries)).toEqual(["read_file"]);
    expect(offeredTools(permissionSet)).toEqual(["read_file"]);
  });

  it("accepts command subjects and `script`, and carries them without offering them as tools", () => {
    const { permissionSet, issues } = parsePermissionSet({ bash: "ask", "git status": "allow", "git  commit": "ask", git: "deny", script: "ask" });
    expect(issues).toEqual([]);
    expect(offeredTools(permissionSet)).toEqual(["bash"]);
    // Whitespace in a command subject is normalized, so two spellings of one command are one entry.
    // The shell's own entry is among them: it is the mode for any command no other entry names (§4).
    expect(shellSubjects(permissionSet)).toEqual({ bash: "ask", "git status": "allow", "git commit": "ask", git: "deny", script: "ask" });
    // …and the gate is handed `ask` for it, so no line runs before the host has read it.
    expect(toolModes(permissionSet)).toEqual({ bash: "ask" });
    expect(gateToolModes(permissionSet)).toEqual({ bash: "ask" });
  });

  it("WARNS about a tool name nothing knows, and drops it — it falls to `other`", () => {
    const { permissionSet, issues } = parsePermissionSet({ reed_file: "allow", other: "ask" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "reed_file", severity: "warning" });
    expect(issues[0]!.message).toMatch(/not a tool JaiRA knows.*'other'/);
    expect(permissionSet.entries).toEqual({});
    expect(permissionSet.other).toBe("ask");
  });

  it.each([
    [{ read_file: "yes" }, /a mode is one of allow, deny, ask, or a function/],
    [{ read_file: { implementation: "native" } }, /has no mode/],
    [{ read_file: { mode: "ask", implementation: "theirs" } }, /implementation.*one of app, native/],
    [{ read_file: 3 }, /a mode is one of/],
    [{ $expr: "x" }, /not a subject/],
    [{ "": "allow" }, /cannot be empty/],
  ])("reports %j as an ERROR and leaves the entry out", (decl, message) => {
    const { permissionSet, issues } = parsePermissionSet(decl);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(1);
    expect(issues[0]!.message).toMatch(message);
    expect(permissionSet.entries).toEqual({});
  });

  it("warns about an implementation where it means nothing", () => {
    const { issues } = parsePermissionSet({ "git commit": { mode: "ask", implementation: "native" }, other: { mode: "deny", implementation: "app" } });
    expect(issues.map((i) => i.severity)).toEqual(["warning", "warning"]);
  });

  it("refuses something that is not a map", () => {
    expect(parsePermissionSet(["read_file"]).issues[0]!.severity).toBe("error");
  });
});

describe("references", () => {
  const files = {
    "$/permission-sets/chat/read-only": { read_file: "allow", glob: "allow", bash: "deny", other: "deny" },
    "$/permission-sets/chat/writer": { $ref: "$/permission-sets/chat/read-only", write_file: { mode: "ask", implementation: "native" } },
    "$/permission-sets/feature/implementation/build": { $ref: "$/permission-sets/chat/writer", bash: { function: "smart" } },
    "$/permission-sets/loop/a": { $ref: "$/permission-sets/loop/b", read_file: "allow" },
    "$/permission-sets/loop/b": { $ref: "$/permission-sets/loop/a" },
    "$/permission-sets/loop/self": "$/permission-sets/loop/self",
    "$/lib/list": ["bash"],
  };
  const read = readerOver(files);
  const resolve = (node: unknown): { decl: Record<string, unknown> | undefined; issues: PermissionSetIssue[] } => {
    const issues: PermissionSetIssue[] = [];
    return { decl: resolvePermissionSetDecl(node, read, "wf", issues), issues };
  };

  it("a bare string is the permission set it names", () => {
    expect(resolve("$/permission-sets/chat/read-only")).toEqual({ decl: files["$/permission-sets/chat/read-only"], issues: [] });
  });

  it("`$ref` with sibling keys starts from one and overrides per subject", () => {
    const { decl, issues } = resolve({ $ref: "$/permission-sets/chat/read-only", write_file: "ask", bash: "ask" });
    expect(issues).toEqual([]);
    expect(decl).toEqual({ read_file: "allow", glob: "allow", bash: "ask", other: "deny", write_file: "ask" });
  });

  it("a permission set file may start from another, through a nested bucket, to any depth", () => {
    const { decl, issues } = resolve("$/permission-sets/feature/implementation/build");
    expect(issues).toEqual([]);
    expect(decl).toEqual({
      read_file: "allow",
      glob: "allow",
      bash: { function: "smart" },
      other: "deny",
      write_file: { mode: "ask", implementation: "native" },
    });
  });

  it("an override replaces the ENTRY whole — no implementation is left behind", () => {
    const { decl } = resolve({ $ref: "$/permission-sets/chat/writer", write_file: "allow" });
    expect(parsePermissionSet(decl).permissionSet.entries["write_file"]).toEqual({ kind: "tool", mode: "allow" });
  });

  it("a cycle is an error NAMING it", () => {
    const { decl, issues } = resolve("$/permission-sets/loop/a");
    expect(decl).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toBe("permission set reference cycle: $/permission-sets/loop/a → $/permission-sets/loop/b → $/permission-sets/loop/a");
    expect(resolve("$/permission-sets/loop/self").issues[0]!.message).toMatch(/cycle: \$\/permission-sets\/loop\/self → \$\/permission-sets\/loop\/self/);
  });

  it("a reference that names nothing, or names something that is not a map, is an error", () => {
    expect(resolve("$/permission-sets/chat/nope").issues[0]!.message).toMatch(/matches no file/);
    expect(resolve({ $ref: "$/lib/list", bash: "ask" }).issues[0]!.message).toMatch(/is not a permission set/);
  });
});

describe("reading a lowered block back", () => {
  const map = { read_file: "allow", bash: "ask", write_file: "deny", other: "deny" };

  it("lowers the shell's mode as a SUBJECT, and leaves the marks that say a permission set was declared", () => {
    // `bash: "ask"` is the answer for any command nothing else names, not a mode for the tool: the
    // gate is handed `ask` so no line runs before it is taken apart, and the authored mode rides beside it.
    expect(lowerPermissionSet(parsePermissionSet({ ...map, bash: "allow" }).permissionSet)).toEqual({
      tools: ["read_file", "bash", "write_file"],
      permissions: { tools: { read_file: "allow", bash: "ask", write_file: "deny", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", subjects: { bash: "allow" }, functions: {} },
    });
  });

  it("tells a lowered MAP by its marks, and strips them on the way back", () => {
    const lowered = lowerPermissionSet(parsePermissionSet(map).permissionSet);
    expect(isLoweredPermissionSet(lowered.permissions)).toBe(true);
    // A block with no marks declared no permission set; one mark, or a mark with the wrong mode, is not the pair.
    expect(isLoweredPermissionSet({ tools: { read_file: "allow" } })).toBe(false);
    expect(isLoweredPermissionSet({ tools: { "jaira:permission set+": "allow" } })).toBe(false);
    const back = permissionSetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back).toEqual(parsePermissionSet(map).permissionSet);
    // An empty map still says it was one.
    expect(lowerPermissionSet(parsePermissionSet({}).permissionSet)).toEqual({ tools: [], permissions: { tools: { ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {} } });
  });

  it("keeps a mode for a tool the list does not offer as an UN-offered entry — a child's inherited key", () => {
    // `permissions.tools` merges per key down the chain, and the list is replaced whole.
    const back = permissionSetOfEnvironment(["glob"], { tools: { glob: "allow", read_file: "allow", ...PERMISSION_SET_MARKERS } });
    expect(back.entries).toEqual({ glob: { kind: "tool", mode: "allow" }, read_file: { kind: "tool", mode: "allow", offered: false } });
    expect(offeredTools(back)).toEqual(["glob"]);
  });

  it("gives a listed tool no mode where the block gives none — a turn that declared no permission set", () => {
    expect(permissionSetOfEnvironment(["show_artifact"]).entries).toEqual({ show_artifact: { kind: "tool" } });
    expect(toolModes(permissionSetOfEnvironment(["show_artifact"]))).toEqual({});
  });

  it("round-trips through the lowered shape, command subjects and implementations included", () => {
    const authored = parsePermissionSet({ read_file: { mode: "allow", implementation: "native" }, bash: "deny", "git commit": "ask", script: "deny", other: "ask" }).permissionSet;
    const lowered = lowerPermissionSet(authored);
    expect(lowered.permissions).toEqual({
      tools: { read_file: "allow", bash: "ask", ...PERMISSION_SET_MARKERS },
      other: "ask",
      subjects: { bash: "deny", "git commit": "ask", script: "deny" },
      functions: {},
      implementations: { read_file: "native" },
    });
    expect(permissionSetOfEnvironment(lowered.tools, lowered.permissions)).toEqual(authored);
  });

  it("keeps `scopes` beside a permission set, and never writes `default` or a profile", () => {
    const scopes = [{ path: "app/**", default: "allow" as const }];
    const lowered = lowerPermissionSet(parsePermissionSet({ read_file: "allow" }).permissionSet, { scopes });
    expect(lowered.permissions).toEqual({ tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, scopes });
  });
});

describe("a line that names a FUNCTION (decision 0007, amended 2026-09-22)", () => {
  it("reads { function } as a mode on any line — a tool, a command, script, the shell, other", () => {
    const { permissionSet, issues } = parsePermissionSet({
      write_file: { function: "judge" },
      read_file: { function: "smart", implementation: "native" },
      glob: { mode: { function: "policy.judge" } },
      bash: { function: "smart" },
      "git push": { function: "$BASE/functions/push_judge" },
      script: { function: "smart" },
      other: { function: "smart" },
    });
    expect(issues).toEqual([]);
    expect(toolModes(permissionSet)).toEqual({ write_file: { function: "judge" }, read_file: { function: "smart" }, glob: { function: "policy.judge" }, bash: { function: "smart" } });
    expect(toolImplementations(permissionSet)).toEqual({ read_file: "native" });
    expect(shellSubjects(permissionSet)).toEqual({ bash: { function: "smart" }, "git push": { function: "$BASE/functions/push_judge" }, script: { function: "smart" } });
    expect(permissionSet.other).toEqual({ function: "smart" });
  });

  it("refuses the word `smart` — it is a function now — and a function with no name or with company", () => {
    expect(parsePermissionSet({ bash: "smart" }).issues[0]!.message).toBe(`'bash' has the mode "smart" — smart is a function now: write { "function": "smart" }`);
    expect(parsePermissionSet({ bash: { function: "  " } }).issues[0]!.message).toMatch(/a function mode is \{ "function": "<reference>" \}/);
    expect(parsePermissionSet({ bash: { function: "smart", mode: "ask" } }).issues[0]!.message).toMatch(/says both 'mode' and 'function'/);
    expect(parsePermissionSet({ bash: { mode: { function: "smart", extra: 1 } } }).issues[0]!.severity).toBe("error");
  });

  it("lowers a function as `ask` wherever the gate reads a mode, and names it in `functions`", () => {
    const permissionSet = parsePermissionSet({ write_file: { function: "judge" }, bash: { function: "smart" }, "git push": "deny", other: { function: "smart" } }).permissionSet;
    const lowered = lowerPermissionSet(permissionSet, undefined, "$/permission-sets/x/y");
    expect(lowered).toEqual({
      tools: ["write_file", "bash"],
      permissions: {
        tools: { write_file: "ask", bash: "ask", ...PERMISSION_SET_MARKERS },
        implementations: {},
        other: "ask",
        subjects: { bash: "ask", "git push": "deny" },
        source: "$/permission-sets/x/y",
        functions: { write_file: "judge", bash: "smart", other: "smart" },
      },
    });
    // …and reads back as the same map.
    expect(permissionSetOfEnvironment(lowered.tools, lowered.permissions)).toEqual(permissionSet);
    expect(declOfPermissionSet(permissionSet)).toEqual({ write_file: { function: "judge" }, bash: { function: "smart" }, "git push": "deny", other: { function: "smart" } });
    expect(functionReferencesOf(permissionSet)).toEqual(["judge", "smart"]);
  });

  it("writes `functions` on EVERY lowered map, so a child's own map never inherits its parent's function", () => {
    // `permissions` merges per key down the chain: a parent's `functions` beside a child's `tools` would
    // hand the child's `ask` to the parent's function. An empty map on the child replaces it.
    const parent = lowerPermissionSet(parsePermissionSet({ bash: { function: "smart" } }).permissionSet).permissions!;
    const child = lowerPermissionSet(parsePermissionSet({ bash: "ask" }).permissionSet).permissions!;
    const merged = { ...parent, ...child, tools: { ...parent.tools, ...child.tools } };
    expect(merged.functions).toEqual({});
    expect(permissionSetOfEnvironment(["bash"], merged).entries["bash"]!.mode).toBe("ask");
  });

  it("withholds nothing a function could let through", () => {
    expect(shellWithheld(parsePermissionSet({ bash: { function: "smart" } }).permissionSet)).toBe(false);
    expect(shellWithheld(parsePermissionSet({ bash: "deny", "git status": { function: "smart" } }).permissionSet)).toBe(false);
  });

  it("asks the host about every function a state's permission set names, and makes one it cannot find an ERROR there", () => {
    const asked: string[] = [];
    const check = (reference: string): string | undefined => {
      asked.push(reference);
      return reference === "nope" ? "'nope' is not a known operation" : undefined;
    };
    const { issues } = lowerStatePermissionSets("wf", { operation: { kind: "prompt", tools: { bash: { function: "smart" }, write_file: { function: "nope" }, edit: { function: "nope" } } } }, NO_FILES, check);
    expect(asked).toEqual(["smart", "nope"]);
    expect(issues).toEqual([
      { stateId: "wf", path: "operation.tools.write_file", message: "the function 'nope' does not resolve: 'nope' is not a known operation", severity: "error" },
      { stateId: "wf", path: "operation.tools.edit", message: "the function 'nope' does not resolve: 'nope' is not a known operation", severity: "error" },
    ]);
  });
});

describe("lowering a state file", () => {
  const read = readerOver({
    "$/permission-sets/chat/read-only": { read_file: "allow", glob: "allow", other: "deny" },
    "$/lib/list": ["bash"],
  });

  it("leaves a state with no permission set as the SAME object", () => {
    const def = {
      environment: { model: "m", permissions: { scopes: [{ path: "app/**", default: "allow" }] } },
      operation: { kind: "prompt", prompt: "go" },
      children: { a: { environment: { model: "n" } } },
    };
    const lowered = lowerStatePermissionSets("wf", def, NO_FILES);
    expect(lowered.def).toBe(def);
    expect(lowered.issues).toEqual([]);
  });

  it("refuses the LIST form — written, or in a file a reference names — and lowers it to nothing", () => {
    for (const tools of [["read_file"], [], "$/lib/list", { $ref: "$/lib/list" }]) {
      const { def, issues } = lowerStatePermissionSets("wf", { environment: { tools } }, read);
      expect(issues, JSON.stringify(tools)).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.tools", severity: "error" })]);
      expect(issues[0]!.message).toMatch(/the list form was removed/);
      expect((def as { environment: unknown }).environment).toEqual({ tools: [], permissions: { tools: { ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {} } });
    }
  });

  it("refuses the old `permissions` modes, beside a map or on their own, and keeps the scopes", () => {
    const scopes = [{ path: "app/**", default: "allow" }];
    const beside = lowerStatePermissionSets(
      "wf",
      { environment: { tools: { read_file: "allow" }, permissions: { tools: { read_file: "deny" }, default: "deny", scopes } } },
      read,
    );
    expect(beside.issues).toEqual([expect.objectContaining({ severity: "error", path: "environment.tools" })]);
    expect(beside.issues[0]!.message).toMatch(/permissions\.tools, permissions\.default are no longer read/);
    expect((beside.def as { environment: unknown }).environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, scopes } });

    const alone = lowerStatePermissionSets("wf", { operation: { kind: "prompt", permissions: { profile: "read-only", scopes } } }, read);
    expect(alone.issues).toEqual([expect.objectContaining({ severity: "error", path: "operation.permissions" })]);
    expect(alone.issues[0]!.message).toMatch(/permissions\.profile is no longer read/);
    expect((alone.def as { operation: unknown }).operation).toEqual({ kind: "prompt", permissions: { scopes } });
  });

  it("lowers a reference, an inline map and a `$ref` with overrides — in all three positions", () => {
    const { def, issues } = lowerStatePermissionSets(
      "wf",
      {
        environment: { model: "m", tools: "$/permission-sets/chat/read-only" },
        operation: { kind: "prompt", prompt: "go", tools: { bash: { function: "smart" }, "git status": "allow" } },
        children: { review: { state: "./review", environment: { tools: { $ref: "$/permission-sets/chat/read-only", write_file: "ask" } } } },
      },
      read,
    );
    expect(issues).toEqual([]);
    expect(def).toEqual({
      environment: { model: "m", tools: ["read_file", "glob"], permissions: { tools: { read_file: "allow", glob: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", functions: {} } },
      // `source` is written beside `subjects`, and only there: where a shell line's subjects came from.
      operation: {
        kind: "prompt",
        prompt: "go",
        tools: ["bash"],
        permissions: {
          tools: { bash: "ask", ...PERMISSION_SET_MARKERS },
          implementations: {},
          subjects: { bash: "ask", "git status": "allow" },
          source: "inline",
          functions: { bash: "smart" },
        },
      },
      children: {
        review: {
          state: "./review",
          environment: { tools: ["read_file", "glob", "write_file"], permissions: { tools: { read_file: "allow", glob: "allow", write_file: "ask", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", functions: {} } },
        },
      },
    });
  });

  it("leaves what is the engine's: a binding, a scoped name", () => {
    for (const tools of [{ $expr: ".inputs.tools" }, "review", { $ref: "review" }, { $any: [] }]) {
      const def = { environment: { tools } };
      expect(lowerStatePermissionSets("wf", def, read).def).toBe(def);
    }
  });

  it("reports an issue at the path it was written, and lowers what could be read", () => {
    const { def, issues } = lowerStatePermissionSets("wf", { environment: { tools: { read_file: "allow", bash: "maybe", Glob: "ask" } } }, read);
    expect(issues).toEqual([
      expect.objectContaining({ stateId: "wf", path: "environment.tools.bash", severity: "error" }),
      expect.objectContaining({ stateId: "wf", path: "environment.tools.Glob", severity: "warning" }),
    ]);
    expect((def as { environment: unknown }).environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {} } });
  });

  it("offers nothing under a reference it could not follow", () => {
    const { def, issues } = lowerStatePermissionSets("wf", { environment: { tools: "$/permission-sets/chat/nope" } }, read);
    expect(issues).toEqual([expect.objectContaining({ path: "environment.tools", severity: "error" })]);
    expect((def as { environment: unknown }).environment).toEqual({ tools: [], permissions: { tools: { ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {} } });
  });
});

describe("lowering a permission set inside a REFERENCED block", () => {
  const scopes = [{ path: "app/**", default: "allow" }];
  const map = { read_file: "allow", bash: "deny", "git status": "allow", other: "deny" };
  const read = readerOver({
    "$/permission-sets/chat/read-only": { read_file: "allow", glob: "allow", other: "deny" },
    "$/envs/inline": { model: "m", tools: map, permissions: { scopes } },
    "$/envs/named": { tools: "$/permission-sets/chat/read-only" },
    "$/envs/over": { $ref: "$/envs/inline", permissions: { scopes: [] } },
    "$/envs/plain": { model: "m" },
    "$/envs/list": { tools: ["bash"] },
    "$/envs/old": { permissions: { default: "deny" } },
    "$/ops/plan": { kind: "prompt", prompt: "go", tools: map },
  });
  /** What the same map lowers to when it is written on the state. */
  const written = (block: Record<string, unknown>) => (lowerStatePermissionSets("wf", { environment: block }, read).def as { environment: Record<string, unknown> }).environment;

  it("opens the block and lowers its map EXACTLY as one written on the state — beside the reference, which stays", () => {
    const { tools, permissions } = written({ tools: map, permissions: { scopes } });
    for (const environment of ["$/envs/inline", { $ref: "$/envs/inline" }, { $ref: "$/envs/inline", model: "n" }]) {
      const { def, issues } = lowerStatePermissionSets("wf", { environment }, read);
      expect(issues, JSON.stringify(environment)).toEqual([]);
      const siblings = typeof environment === "string" ? { $ref: environment } : environment;
      // The lowered fields are SIBLINGS of the reference: the engine's `$ref` merge lets a sibling
      // `tools` list replace the target's map, and sibling `permissions` override it per key.
      expect((def as { environment: unknown }).environment).toEqual({ ...siblings, tools, permissions });
    }
  });

  it("does the same for an `operation` and a child mount's `environment`", () => {
    const { def, issues } = lowerStatePermissionSets("wf", { operation: "$/ops/plan", children: { a: { state: "./a", environment: "$/envs/named" } } }, read);
    expect(issues).toEqual([]);
    const { tools, permissions } = written({ tools: map });
    expect((def as { operation: unknown }).operation).toEqual({ $ref: "$/ops/plan", tools, permissions });
    // A permission set REFERENCE inside the block keeps its name as the source, as it would on the state.
    expect((def as { children: { a: unknown } }).children.a).toEqual({ state: "./a", environment: { $ref: "$/envs/named", ...written({ tools: "$/permission-sets/chat/read-only" }) } });
  });

  it("follows a block that starts from another, merging `permissions` per key the way the engine does", () => {
    const { def } = lowerStatePermissionSets("wf", { environment: "$/envs/over" }, read);
    expect((def as { environment: unknown }).environment).toEqual({ $ref: "$/envs/over", ...written({ tools: map, permissions: { scopes: [] } }) });
  });

  it("leaves a referenced block with no permission set — and one it cannot follow — as the SAME object", () => {
    for (const environment of ["$/envs/plain", { $ref: "$/envs/plain", model: "n" }, "$/envs/nope", { $ref: "review" }]) {
      const def = { environment };
      const lowered = lowerStatePermissionSets("wf", def, read);
      expect(lowered.def, JSON.stringify(environment)).toBe(def);
      expect(lowered.issues).toEqual([]);
    }
  });

  it("refuses the old forms inside a referenced block, naming the block", () => {
    const list = lowerStatePermissionSets("wf", { environment: "$/envs/list" }, read);
    expect(list.issues).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.tools", severity: "error" })]);
    expect(list.issues[0]!.message).toMatch(/^in the block '\$\/envs\/list' names: .*the list form was removed/);
    const old = lowerStatePermissionSets("wf", { environment: "$/envs/old" }, read);
    expect(old.issues).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.permissions", severity: "error" })]);
    expect(old.issues[0]!.message).toMatch(/^in the block '\$\/envs\/old' names: permissions\.default is no longer read/);
  });

  it("lets a block's OWN `tools` win over the one its reference holds, as the engine's merge does", () => {
    const environment = { $ref: "$/envs/inline", tools: { glob: "allow" } };
    const { def } = lowerStatePermissionSets("wf", { environment }, read);
    expect((def as { environment: { tools: unknown } }).environment.tools).toEqual(["glob"]);
  });
});

describe("a message's settings", () => {
  it("reads a state's lowered declaration and the map form as the same permission set", () => {
    const inherited = permissionSetOfSettings({
      tools: ["read_file", "bash"],
      permissions: { tools: { read_file: "allow", bash: "ask", ...PERMISSION_SET_MARKERS }, other: "deny", subjects: { bash: "ask" } },
      implementations: { read_file: "native" },
    });
    const map = permissionSetOfSettings({ permissionSet: { read_file: { mode: "allow", implementation: "native" }, bash: "ask", other: "deny" } });
    expect(map.issues).toEqual([]);
    expect(inherited.permissionSet).toEqual(map.permissionSet);
  });

  it("tells saying nothing about tools from granting none", () => {
    expect(declaresTools({})).toBe(false);
    expect(declaresTools({ permissions: { tools: { bash: "deny" } } })).toBe(false);
    expect(declaresTools({ tools: [] })).toBe(true);
    expect(declaresTools({ permissionSet: {} })).toBe(true);
  });
});

describe("the operation schema", () => {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(toolsSchema());

  it.each([
    ["$/permission-sets/chat/read-only"],
    [{ read_file: "allow", "git status": "allow", script: "ask", other: "deny" }],
    [{ $ref: "$/permission-sets/chat/read-only", write_file: { mode: "ask", implementation: "native" } }],
    [{ $expr: ".inputs.tools" }],
    [{}],
  ])("admits %j", (tools) => {
    expect(validate(tools)).toBe(true);
  });

  it.each([[{ read_file: "sometimes" }], [{ read_file: { implementation: "native" } }], [{ read_file: { mode: "ask", implementation: "theirs" } }], [7], [[1]], [["read_file", "bash"]], [[]]])(
    "refuses %j",
    (tools) => {
      expect(validate(tools)).toBe(false);
    },
  );

  it("is what the operation and environment blocks hold under `tools`", () => {
    expect((operationSchema().properties as Record<string, unknown>)["tools"]).toEqual(toolsSchema());
  });
});
