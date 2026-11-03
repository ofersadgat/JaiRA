/**
 * The permission set data model (decision 0007 §1): the map, its references, and the lowering that hands a
 * map-form state to an engine that only takes a list and a block — and reads it back.
 */
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { operationSchema, toolsSchema } from "../src/schemas";
import { runnerModeOf } from "../src/commandRunners";
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
  linePlaces,
  holdsShellLines,
  gateToolModes,
  subjectKindOf,
  toolImplementations,
  toolModes,
  PERMISSION_SET_MARKERS,
  permissionSetOfEnvironment,
  permissionSetOfSettings,
  functionReferencesOf,
  entryOfDecl,
  mcpGateModes,
  permissionSetLayersOf,
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
    ["shell", "tool"],
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
    const { permissionSet, issues } = parsePermissionSet({ read_file: "allow", web_fetch: "ask", shell: "ask" });
    expect(issues).toEqual([]);
    expect(offeredTools(permissionSet)).toEqual(["read_file", "web_fetch", "shell"]);
    expect(toolModes(permissionSet)).toEqual({ read_file: "allow", web_fetch: "ask", shell: "ask" });
    expect(offeredTools(permissionSet)).not.toContain("write_file");
  });

  it("WITHHOLDS a shell it denies outright — held as written, handed to nobody", () => {
    const { permissionSet } = parsePermissionSet({ read_file: "allow", shell: "deny", other: "deny" });
    expect(shellWithheld(permissionSet)).toBe(true);
    expect(heldTools(permissionSet)).toEqual(["read_file", "shell"]);
    expect(offeredTools(permissionSet)).toEqual(["read_file"]);
    expect(gateToolModes(permissionSet)).toEqual({ read_file: "allow", shell: "deny" });
    // A command subject that denies too leaves nothing to run: still withheld.
    expect(shellWithheld(parsePermissionSet({ shell: "deny", "git push": "deny" }).permissionSet)).toBe(true);
    // One that allows, asks or names a function keeps the shell OFFERED, for those lines.
    for (const mode of ["allow", "ask", "smart"]) {
      const offered = parsePermissionSet({ shell: "deny", "git status": mode }).permissionSet;
      expect(shellWithheld(offered)).toBe(false);
      expect(offeredTools(offered)).toEqual(["shell"]);
      expect(gateToolModes(offered)).toEqual({ shell: "ask" });
    }
    expect(shellWithheld(parsePermissionSet({ shell: "deny", script: "ask" }).permissionSet)).toBe(false);
  });

  it("round-trips a WITHHELD shell through the lowered block: held, not offered, and its authored mode", () => {
    const permissionSet = parsePermissionSet({ read_file: "allow", shell: "deny", other: "deny" }).permissionSet;
    const lowered = lowerPermissionSet(permissionSet);
    expect(lowered.tools).toEqual(["read_file"]);
    expect(lowered.permissions).toEqual({ tools: { read_file: "allow", shell: "deny", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", subjects: { shell: "deny" }, functions: {}, places: {} });
    const back = permissionSetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back).toEqual(permissionSet);
    expect(declOfPermissionSet(back)).toEqual({ read_file: "allow", shell: "deny", other: "deny" });
  });

  it("carries an offered shell's subjects in `subjects` alone — `permissions.tools` holds tools and the marks", () => {
    const lowered = lowerPermissionSet(parsePermissionSet({ shell: "deny", "git status": "allow", other: "deny" }).permissionSet, "$/permission-sets/x/y");
    const tools = lowered.permissions!.tools!;
    expect(tools).toEqual({ shell: "ask", ...PERMISSION_SET_MARKERS });
    expect(lowered.permissions).toMatchObject({ subjects: { shell: "deny", "git status": "allow" }, source: "$/permission-sets/x/y" });
    expect(Object.keys(permissionSetOfEnvironment(lowered.tools, lowered.permissions).entries)).toEqual(["shell", "git status"]);
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
    const { permissionSet, issues } = parsePermissionSet({ shell: "ask", "git status": "allow", "git  commit": "ask", git: "deny", script: "ask" });
    expect(issues).toEqual([]);
    expect(offeredTools(permissionSet)).toEqual(["shell"]);
    // Whitespace in a command subject is normalized, so two spellings of one command are one entry.
    // The shell's own entry is among them: it is the mode for any command no other entry names (§4).
    expect(shellSubjects(permissionSet)).toEqual({ shell: "ask", "git status": "allow", "git commit": "ask", git: "deny", script: "ask" });
    // …and the gate is handed `ask` for it, so no line runs before the host has read it.
    expect(toolModes(permissionSet)).toEqual({ shell: "ask" });
    expect(gateToolModes(permissionSet)).toEqual({ shell: "ask" });
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
    [{ read_file: "Allow" }, /is the word 'allow' — write it in lower case/],
    [{ read_file: "  " }, /an empty string names nothing/],
    [{ read_file: { implementation: "native" } }, /has no mode/],
    [{ read_file: { mode: "ask", implementation: "theirs" } }, /implementation.*one of app, native/],
    [{ read_file: 3 }, /a decision is one of allow, deny, ask, unavailable, the name of a function/],
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
    "$/permission-sets/chat/read-only": { read_file: "allow", glob: "allow", shell: "deny", other: "deny" },
    "$/permission-sets/chat/writer": { $ref: "$/permission-sets/chat/read-only", write_file: { mode: "ask", implementation: "native" } },
    "$/permission-sets/feature/implementation/build": { $ref: "$/permission-sets/chat/writer", shell: "smart" },
    "$/permission-sets/loop/a": { $ref: "$/permission-sets/loop/b", read_file: "allow" },
    "$/permission-sets/loop/b": { $ref: "$/permission-sets/loop/a" },
    "$/permission-sets/loop/self": "$/permission-sets/loop/self",
    "$/lib/list": ["shell"],
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
    const { decl, issues } = resolve({ $ref: "$/permission-sets/chat/read-only", write_file: "ask", shell: "ask" });
    expect(issues).toEqual([]);
    expect(decl).toEqual({ read_file: "allow", glob: "allow", shell: "ask", other: "deny", write_file: "ask" });
  });

  it("a permission set file may start from another, through a nested bucket, to any depth", () => {
    const { decl, issues } = resolve("$/permission-sets/feature/implementation/build");
    expect(issues).toEqual([]);
    expect(decl).toEqual({
      read_file: "allow",
      glob: "allow",
      shell: "smart",
      other: "deny",
      write_file: { mode: "ask", implementation: "native" },
    });
  });

  it("an override merges the line: a newer mode leaves the implementation below standing, unless it names one", () => {
    // Decision 0023 §2.3: what a layer leaves out says nothing — and a line that says only a mode says
    // nothing about whose code runs the tool.
    const { decl } = resolve({ $ref: "$/permission-sets/chat/writer", write_file: "allow" });
    expect(parsePermissionSet(decl).permissionSet.entries["write_file"]).toEqual({ kind: "tool", mode: "allow", implementation: "native" });
    const ours = resolve({ $ref: "$/permission-sets/chat/writer", write_file: { mode: "allow", implementation: "app" } }).decl;
    expect(parsePermissionSet(ours).permissionSet.entries["write_file"]).toEqual({ kind: "tool", mode: "allow", implementation: "app" });
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
    expect(resolve({ $ref: "$/lib/list", shell: "ask" }).issues[0]!.message).toMatch(/is not a permission set/);
  });
});

describe("reading a lowered block back", () => {
  const map = { read_file: "allow", shell: "ask", write_file: "deny", other: "deny" };

  it("lowers the shell's mode as a SUBJECT, and leaves the marks that say a permission set was declared", () => {
    // `shell: "ask"` is the answer for any command nothing else names, not a mode for the tool: the
    // gate is handed `ask` so no line runs before it is taken apart, and the authored mode rides beside it.
    expect(lowerPermissionSet(parsePermissionSet({ ...map, shell: "allow" }).permissionSet)).toEqual({
      tools: ["read_file", "shell", "write_file"],
      permissions: { tools: { read_file: "allow", shell: "ask", write_file: "deny", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", subjects: { shell: "allow" }, functions: {}, places: {} },
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
    expect(lowerPermissionSet(parsePermissionSet({}).permissionSet)).toEqual({ tools: [], permissions: { tools: { ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, places: {} } });
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
    const authored = parsePermissionSet({ read_file: { mode: "allow", implementation: "native" }, shell: "deny", "git commit": "ask", script: "deny", other: "ask" }).permissionSet;
    const lowered = lowerPermissionSet(authored);
    expect(lowered.permissions).toEqual({
      tools: { read_file: "allow", shell: "ask", ...PERMISSION_SET_MARKERS },
      other: "ask",
      subjects: { shell: "deny", "git commit": "ask", script: "deny" },
      functions: {},
      places: {},
      implementations: { read_file: "native" },
    });
    expect(permissionSetOfEnvironment(lowered.tools, lowered.permissions)).toEqual(authored);
  });

  it("never writes `default`, a profile or a state table (`scopes` is gone — decision 0023 §3.7)", () => {
    const lowered = lowerPermissionSet(parsePermissionSet({ read_file: "allow" }).permissionSet);
    expect(lowered.permissions).toEqual({ tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, places: {} });
  });
});

describe("a line that names a FUNCTION (decision 0007, amended 2026-09-22)", () => {
  it("reads any string that is no mode word as a function, on any line — a tool, a command, script, the shell, other", () => {
    const { permissionSet, issues } = parsePermissionSet({
      write_file: "judge",
      read_file: { mode: "smart", implementation: "native" },
      glob: { mode: " policy.judge " },
      shell: "smart",
      "git push": "$BASE/functions/push_judge",
      script: "smart",
      other: "smart",
    });
    expect(issues).toEqual([]);
    expect(toolModes(permissionSet)).toEqual({ write_file: { function: "judge" }, read_file: { function: "smart" }, glob: { function: "policy.judge" }, shell: { function: "smart" } });
    expect(toolImplementations(permissionSet)).toEqual({ read_file: "native" });
    expect(shellSubjects(permissionSet)).toEqual({ shell: { function: "smart" }, "git push": { function: "$BASE/functions/push_judge" }, script: { function: "smart" } });
    expect(permissionSet.other).toEqual({ function: "smart" });
  });

  it("names no function after a mode word, in any case — and reads the old { function } spelling as no function at all", () => {
    for (const word of ["Allow", "ASK", "Deny", "Unavailable"]) {
      expect(parsePermissionSet({ shell: word }).issues[0]!.message, word).toMatch(/write it in lower case; no function can be named/);
    }
    // `{ "function": … }` was the spelling until 2026-11-02, and nothing reads it now. Read as what an
    // object is today — a place map — it would quietly mean "at the path `function`", so a map whose one
    // place is `function` is REFUSED instead, naming the spelling; the path is written `./function`.
    const old = parsePermissionSet({ shell: { function: "smart" } });
    expect(old.permissionSet.entries).toEqual({});
    expect(old.issues[0]!.message).toMatch(/write the function's name as the line's value: "smart"/);
    expect(parsePermissionSet({ shell: { "./function": "smart" } }).permissionSet.entries["shell"]).toEqual({ kind: "tool", places: { "./function": { function: "smart" } } });
    expect(parsePermissionSet({ shell: { mode: { src: 3 } } }).issues[0]!.severity).toBe("error");
  });

  it("lowers a function as `ask` wherever the gate reads a mode, and names it in `functions`", () => {
    const permissionSet = parsePermissionSet({ write_file: "judge", shell: "smart", "git push": "deny", other: "smart" }).permissionSet;
    const lowered = lowerPermissionSet(permissionSet, "$/permission-sets/x/y");
    expect(lowered).toEqual({
      tools: ["write_file", "shell"],
      permissions: {
        tools: { write_file: "ask", shell: "ask", ...PERMISSION_SET_MARKERS },
        implementations: {},
        other: "ask",
        subjects: { shell: "ask", "git push": "deny" },
        source: "$/permission-sets/x/y",
        functions: { write_file: "judge", shell: "smart", other: "smart" },
        places: {},
      },
    });
    // …and reads back as the same map.
    expect(permissionSetOfEnvironment(lowered.tools, lowered.permissions)).toEqual(permissionSet);
    expect(declOfPermissionSet(permissionSet)).toEqual({ write_file: "judge", shell: "smart", "git push": "deny", other: "smart" });
    expect(functionReferencesOf(permissionSet)).toEqual(["judge", "smart"]);
  });

  it("writes `functions` on EVERY lowered map, so a child's own map never inherits its parent's function", () => {
    // `permissions` merges per key down the chain: a parent's `functions` beside a child's `tools` would
    // hand the child's `ask` to the parent's function. An empty map on the child replaces it.
    const parent = lowerPermissionSet(parsePermissionSet({ shell: "smart" }).permissionSet).permissions!;
    const child = lowerPermissionSet(parsePermissionSet({ shell: "ask" }).permissionSet).permissions!;
    const merged = { ...parent, ...child, tools: { ...parent.tools, ...child.tools } };
    expect(merged.functions).toEqual({});
    expect(permissionSetOfEnvironment(["shell"], merged).entries["shell"]!.mode).toBe("ask");
  });

  it("withholds nothing a function could let through", () => {
    expect(shellWithheld(parsePermissionSet({ shell: "smart" }).permissionSet)).toBe(false);
    expect(shellWithheld(parsePermissionSet({ shell: "deny", "git status": "smart" }).permissionSet)).toBe(false);
  });

  it("asks the host about every function a state's permission set names, and makes one it cannot find an ERROR there", () => {
    const asked: string[] = [];
    const check = (reference: string): string | undefined => {
      asked.push(reference);
      return reference === "nope" ? "'nope' is not a known operation" : undefined;
    };
    const { issues } = lowerStatePermissionSets("wf", { operation: { kind: "prompt", tools: { shell: "smart", write_file: "nope", edit: { "**": "ask", src: "nope" } } } }, NO_FILES, check);
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
    "$/lib/list": ["shell"],
  });

  it("leaves a state with no permission set as the SAME object", () => {
    const def = {
      environment: { model: "m" },
      operation: { kind: "prompt", prompt: "go" },
      children: { a: { environment: { model: "n" } } },
    };
    const lowered = lowerStatePermissionSets("wf", def, NO_FILES);
    expect(lowered.def).toBe(def);
    expect(lowered.issues).toEqual([]);
  });

  it("refuses a LIST for `tools` — written, or in a file a reference names — and lowers it to nothing", () => {
    for (const tools of [["read_file"], [], "$/lib/list", { $ref: "$/lib/list" }]) {
      const { def, issues } = lowerStatePermissionSets("wf", { environment: { tools } }, read);
      expect(issues, JSON.stringify(tools)).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.tools", severity: "error" })]);
      expect(issues[0]!.message).toMatch(/`tools` is a permission set: a map/);
      expect((def as { environment: unknown }).environment).toEqual({ tools: [], permissions: { tools: { ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, places: {} } });
    }
  });

  it("refuses modes in `permissions`, beside a map or on their own, and the state table `scopes` with them", () => {
    const scopes = [{ path: "app/**", default: "allow" }];
    const beside = lowerStatePermissionSets(
      "wf",
      { environment: { tools: { read_file: "allow" }, permissions: { tools: { read_file: "deny" }, default: "deny", scopes } } },
      read,
    );
    expect(beside.issues).toEqual([expect.objectContaining({ severity: "error", path: "environment.tools" })]);
    expect(beside.issues[0]!.message).toMatch(/permissions\.tools, permissions\.default are not a setting of `permissions`/);
    // Decision 0023 §3.7: the table's places are a line's place map now, and the message says how to write one.
    expect(beside.issues[0]!.message).toMatch(/permissions\.scopes is gone — where a tool may act is a map of places on its line/);
    expect((beside.def as { environment: unknown }).environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, places: {}, stack: { layers: [{ id: "inline" }] } } });

    const alone = lowerStatePermissionSets("wf", { operation: { kind: "prompt", permissions: { profile: "read-only", scopes } } }, read);
    expect(alone.issues).toEqual([expect.objectContaining({ severity: "error", path: "operation.permissions" })]);
    expect(alone.issues[0]!.message).toMatch(/permissions\.profile is not a setting of `permissions`/);
    expect(alone.issues[0]!.message).toMatch(/permissions\.scopes is gone/);
    // Nothing of an authored `permissions` is kept: an author writes nothing there now.
    expect((alone.def as { operation: unknown }).operation).toEqual({ kind: "prompt" });

    const table = lowerStatePermissionSets("wf", { operation: { kind: "prompt", permissions: { scopes } } }, read);
    expect(table.issues.map((issue) => issue.path)).toEqual(["operation.permissions"]);
    expect((table.def as { operation: unknown }).operation).toEqual({ kind: "prompt" });
  });

  it("lowers a reference, an inline map and a `$ref` with overrides — in all three positions", () => {
    const { def, issues } = lowerStatePermissionSets(
      "wf",
      {
        environment: { model: "m", tools: "$/permission-sets/chat/read-only" },
        operation: { kind: "prompt", prompt: "go", tools: { shell: "smart", "git status": "allow" } },
        children: { review: { state: "./review", environment: { tools: { $ref: "$/permission-sets/chat/read-only", write_file: "ask" } } } },
      },
      read,
    );
    expect(issues).toEqual([]);
    expect(def).toEqual({
      environment: {
        model: "m",
        tools: ["read_file", "glob"],
        permissions: {
          tools: { read_file: "allow", glob: "allow", ...PERMISSION_SET_MARKERS },
          implementations: {},
          other: "deny",
          functions: {},
          places: {},
          // The stack the set was read through (decision 0023 §2.7): one layer, which set every line.
          stack: { layers: [{ id: "chat/read-only", reference: "$/permission-sets/chat/read-only" }] },
        },
      },
      // `source` is written beside `subjects`, and only there: where a shell line's subjects came from.
      operation: {
        kind: "prompt",
        prompt: "go",
        tools: ["shell"],
        permissions: {
          tools: { shell: "ask", ...PERMISSION_SET_MARKERS },
          implementations: {},
          subjects: { shell: "ask", "git status": "allow" },
          source: "inline",
          functions: { shell: "smart" },
          places: {},
          stack: { layers: [{ id: "inline" }] },
        },
      },
      children: {
        review: {
          state: "./review",
          environment: {
            tools: ["read_file", "glob", "write_file"],
            permissions: {
              tools: { read_file: "allow", glob: "allow", write_file: "ask", ...PERMISSION_SET_MARKERS },
              implementations: {},
              other: "deny",
              functions: {},
              places: {},
              // A copy is the stack [the set it names, its own lines], and who set each line is kept.
              stack: {
                layers: [{ id: "chat/read-only", reference: "$/permission-sets/chat/read-only" }, { id: "inline" }],
                lines: {
                  read_file: { everywhere: "chat/read-only", places: {} },
                  glob: { everywhere: "chat/read-only", places: {} },
                  other: { everywhere: "chat/read-only", places: {} },
                  write_file: { everywhere: "inline", places: {} },
                },
              },
            },
          },
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
    const { def, issues } = lowerStatePermissionSets("wf", { environment: { tools: { read_file: "allow", shell: 7, Glob: "ask" } } }, read);
    expect(issues).toEqual([
      expect.objectContaining({ stateId: "wf", path: "environment.tools.shell", severity: "error" }),
      expect.objectContaining({ stateId: "wf", path: "environment.tools.Glob", severity: "warning" }),
    ]);
    expect((def as { environment: unknown }).environment).toEqual({
      tools: ["read_file"],
      permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, places: {}, stack: { layers: [{ id: "inline" }] } },
    });
  });

  it("offers nothing under a reference it could not follow", () => {
    const { def, issues } = lowerStatePermissionSets("wf", { environment: { tools: "$/permission-sets/chat/nope" } }, read);
    expect(issues).toEqual([expect.objectContaining({ path: "environment.tools", severity: "error" })]);
    expect((def as { environment: unknown }).environment).toEqual({ tools: [], permissions: { tools: { ...PERMISSION_SET_MARKERS }, implementations: {}, functions: {}, places: {} } });
  });
});

describe("lowering a permission set inside a REFERENCED block", () => {
  const map = { read_file: "allow", shell: "deny", "git status": "allow", other: "deny" };
  const read = readerOver({
    "$/permission-sets/chat/read-only": { read_file: "allow", glob: "allow", other: "deny" },
    "$/envs/inline": { model: "m", tools: map },
    "$/envs/named": { tools: "$/permission-sets/chat/read-only" },
    "$/envs/over": { $ref: "$/envs/inline", model: "o" },
    "$/envs/plain": { model: "m" },
    "$/envs/list": { tools: ["shell"] },
    "$/envs/old": { permissions: { default: "deny" } },
    "$/ops/plan": { kind: "prompt", prompt: "go", tools: map },
  });
  /** What the same map lowers to when it is written on the state. */
  const written = (block: Record<string, unknown>) => (lowerStatePermissionSets("wf", { environment: block }, read).def as { environment: Record<string, unknown> }).environment;

  it("opens the block and lowers its map EXACTLY as one written on the state — beside the reference, which stays", () => {
    const { tools, permissions } = written({ tools: map });
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
    expect((def as { environment: unknown }).environment).toEqual({ $ref: "$/envs/over", ...written({ tools: map }) });
  });

  it("leaves a referenced block with no permission set — and one it cannot follow — as the SAME object", () => {
    for (const environment of ["$/envs/plain", { $ref: "$/envs/plain", model: "n" }, "$/envs/nope", { $ref: "review" }]) {
      const def = { environment };
      const lowered = lowerStatePermissionSets("wf", def, read);
      expect(lowered.def, JSON.stringify(environment)).toBe(def);
      expect(lowered.issues).toEqual([]);
    }
  });

  it("refuses a list or modes inside a referenced block, naming the block", () => {
    const list = lowerStatePermissionSets("wf", { environment: "$/envs/list" }, read);
    expect(list.issues).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.tools", severity: "error" })]);
    expect(list.issues[0]!.message).toMatch(/^in the block '\$\/envs\/list' names: .*`tools` is a permission set: a map/);
    const old = lowerStatePermissionSets("wf", { environment: "$/envs/old" }, read);
    expect(old.issues).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.permissions", severity: "error" })]);
    expect(old.issues[0]!.message).toMatch(/^in the block '\$\/envs\/old' names: permissions\.default is not a setting of `permissions`/);
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
      tools: ["read_file", "shell"],
      permissions: { tools: { read_file: "allow", shell: "ask", ...PERMISSION_SET_MARKERS }, other: "deny", subjects: { shell: "ask" } },
      implementations: { read_file: "native" },
    });
    const map = permissionSetOfSettings({ permissionSet: { read_file: { mode: "allow", implementation: "native" }, shell: "ask", other: "deny" } });
    expect(map.issues).toEqual([]);
    expect(inherited.permissionSet).toEqual(map.permissionSet);
  });

  it("tells saying nothing about tools from granting none", () => {
    expect(declaresTools({})).toBe(false);
    expect(declaresTools({ permissions: { tools: { shell: "deny" } } })).toBe(false);
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
    [{ read_file: "smart", web_fetch: "unavailable", write_file: { src: "allow", "**": "ask" }, edit: { mode: { src: "allow" }, implementation: "native" } }],
    [{ layers: ["$/permission-sets/chat/ask-first", "$/permission-sets/app/build"], shell: "allow" }],
  ])("admits %j", (tools) => {
    expect(validate(tools)).toBe(true);
  });

  it.each([[{ read_file: "" }], [{ read_file: {} }], [{ read_file: { src: "unavailable" } }], [{ read_file: { mode: "ask", src: "allow" } }], [{ other: "unavailable" }], [{ read_file: { implementation: "native" } }], [{ read_file: { mode: "ask", implementation: "theirs" } }], [7], [[1]], [["read_file", "shell"]], [[]]])(
    "refuses %j",
    (tools) => {
      expect(validate(tools)).toBe(false);
    },
  );

  it("is what the operation and environment blocks hold under `tools`", () => {
    expect((operationSchema().properties as Record<string, unknown>)["tools"]).toEqual(toolsSchema());
  });
});

describe("command runner lines (decision 0007, amended 2026-09-26, later)", () => {
  it("reads runner:* and runner:<program> as the runners' gate, and drops a runner it does not know", () => {
    const { permissionSet, issues } = parsePermissionSet({ shell: "deny", "runner:*": "allow", "runner:sudo": "deny", "runner:frobnicate": "allow", other: "deny" });
    expect(permissionSet.entries["runner:*"]).toEqual({ kind: "runner", mode: "allow" });
    expect(permissionSet.entries["runner:sudo"]).toEqual({ kind: "runner", mode: "deny" });
    expect(permissionSet.entries["runner:frobnicate"]).toBeUndefined();
    expect(issues.map((issue) => issue.path)).toEqual(["runner:frobnicate"]);
    expect(runnerModeOf(permissionSet, "sudo")).toEqual({ mode: "deny", line: "runner:sudo" });
    expect(runnerModeOf(permissionSet, "npm")).toEqual({ mode: "allow", line: "runner:*" });
  });

  it("offers the shell for a runner line that lets runners through, and carries the lines lowered and back", () => {
    const { permissionSet } = parsePermissionSet({ read_file: "allow", shell: "deny", "runner:*": "allow", other: "deny" });
    expect(shellWithheld(permissionSet)).toBe(false);
    expect(shellWithheld(parsePermissionSet({ read_file: "allow", shell: "deny", "runner:*": "deny", other: "deny" }).permissionSet)).toBe(true);
    const lowered = permissionsOfPermissionSet(permissionSet);
    expect(lowered.subjects).toMatchObject({ shell: "deny", "runner:*": "allow" });
    expect(permissionSetOfEnvironment(offeredTools(permissionSet), lowered).entries["runner:*"]).toEqual({ kind: "runner", mode: "allow" });
  });
});

describe("a line's value (decision 0023 §1)", () => {
  it("reads every spelling: a word, a function's name, unavailable, a place map, and each inside the wrapper", () => {
    const { permissionSet, issues } = parsePermissionSet({
      read_file: "allow",
      web_fetch: "smart",
      web_search: "unavailable",
      write_file: { src: "allow", infra: "deny", "**": "ask" },
      edit: { src: "judge" },
      grep: { mode: { "**": "deny", docs: "allow" }, implementation: "native" },
      glob: { mode: "policy.judge", implementation: "native" },
      other: "deny",
    });
    expect(issues).toEqual([]);
    expect(permissionSet.entries).toEqual({
      read_file: { kind: "tool", mode: "allow" },
      web_fetch: { kind: "tool", mode: { function: "smart" } },
      web_search: { kind: "tool", unavailable: true },
      // `**` is the line's own mode; a map without one has none, and a call no place matches falls through.
      write_file: { kind: "tool", mode: "ask", places: { src: "allow", infra: "deny" } },
      edit: { kind: "tool", places: { src: { function: "judge" } } },
      grep: { kind: "tool", mode: "deny", places: { docs: "allow" }, implementation: "native" },
      glob: { kind: "tool", mode: { function: "policy.judge" }, implementation: "native" },
    });
    // …and writes each back as it was written, `**` first in a map.
    expect(declOfPermissionSet(permissionSet)).toEqual({
      read_file: "allow",
      web_fetch: "smart",
      web_search: "unavailable",
      write_file: { "**": "ask", src: "allow", infra: "deny" },
      edit: { src: "judge" },
      grep: { mode: { "**": "deny", docs: "allow" }, implementation: "native" },
      glob: { mode: "policy.judge", implementation: "native" },
      other: "deny",
    });
  });

  it("tells the wrapper from a place map by its keys — a path named `mode` is `./mode`", () => {
    expect(entryOfDecl({ mode: "ask" })).toEqual({ mode: "ask" });
    expect(entryOfDecl({ implementation: "native", mode: "ask" })).toEqual({ mode: "ask", implementation: "native" });
    expect(entryOfDecl({ "./mode": "allow" })).toEqual({ places: { "./mode": "allow" } });
    const typo = parsePermissionSet({ read_file: { mode: "ask", implmentation: "native" } });
    expect(typo.permissionSet.entries).toEqual({});
    expect(typo.issues[0]!.message).toMatch(/names 'mode' beside other places .* written '\.\/mode'/);
  });

  it.each([
    [{ "git commit": "unavailable" }, /cannot be unavailable/],
    [{ script: "unavailable" }, /cannot be unavailable/],
    [{ "runner:*": "unavailable" }, /cannot be unavailable/],
    [{ other: "unavailable" }, /'other' cannot be unavailable/],
    [{ read_file: { src: "unavailable" } }, /unavailable is never a place's decision/],
    [{ web_search: { "**": "allow", "news.example": "deny" } }, /'web_search' takes no place/],
    [{ screenshot: { "**": "allow", primary: "deny" } }, /'screenshot' takes no place/],
    [{ other: { "**": "deny", src: "allow" } }, /'other' takes no place — it names no one tool/],
    [{ read_file: {} }, /names no place/],
    [{ read_file: { "": "allow" } }, /a place cannot be empty/],
    [{ read_file: { src: { deeper: "allow" } } }, /at 'src': .* is not a decision/],
    [{ layers: ["$/permission-sets/chat/ask-first"] }, /'layers' names the layers a set is built from/],
  ])("refuses %j", (decl, message) => {
    const { permissionSet, issues } = parsePermissionSet(decl);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(1);
    expect(issues[0]!.message).toMatch(message);
    expect(permissionSet.entries).toEqual({});
    expect(permissionSet.other).toBeUndefined();
  });

  it("allows unavailable on a tool, the shell and an MCP line, and a place map on a command, script, a runner and MCP", () => {
    const { issues } = parsePermissionSet({
      read_file: "unavailable",
      shell: "unavailable",
      mcp__figma: "unavailable",
      mcp__figma__get_code: { "**": "ask" },
      "npm run build": { "packages/app": "allow" },
      script: { "**": "ask", "scripts/safe": "allow" },
      "runner:*": { "**": "ask" },
      "git push": { main: "deny", "claude/**": "allow" },
    });
    expect(issues).toEqual([]);
  });

  it("holds and offers nothing under `unavailable`, and refuses an unavailable MCP line at the gate", () => {
    const { permissionSet } = parsePermissionSet({ read_file: "allow", web_fetch: "unavailable", shell: "unavailable", "git status": "allow", mcp__figma: "allow", mcp__figma__delete: "unavailable", other: "deny" });
    expect(heldTools(permissionSet)).toEqual(["read_file"]);
    expect(offeredTools(permissionSet)).toEqual(["read_file"]);
    expect(gateToolModes(permissionSet)).toEqual({ read_file: "allow" });
    // An absent MCP tool line would fall to its server's `allow`: until what an agent is handed reads
    // `unavailable`, the gate refuses the tool by name.
    expect(mcpGateModes(permissionSet)).toEqual({ mcp__figma: "allow", mcp__figma__delete: "deny" });
    // An unavailable shell is not withheld — it is not held at all.
    expect(shellWithheld(permissionSet)).toBe(false);
    expect(declOfPermissionSet(permissionSet)).toMatchObject({ web_fetch: "unavailable", shell: "unavailable", mcp__figma__delete: "unavailable" });
  });

  it("compiles a line with places LOOSE for the gate, and hands a judge of a call each line's own mode beside its places", () => {
    const { permissionSet } = parsePermissionSet({
      read_file: { "**": "deny", src: "allow" },
      write_file: { infra: "deny" }, // no `**`: elsewhere falls to `other`
      edit: { "**": "ask", src: "smart" },
      shell: "ask",
      "npm run build": { "packages/app": "allow" }, // no `**`: elsewhere a less specific line answers
      other: "allow",
    });
    // §3.10: never stricter at the gate than some place's answer — `other` included where a line has no `**`.
    expect(gateToolModes(permissionSet)).toEqual({ read_file: "allow", write_file: "allow", edit: "ask", shell: "ask" });
    // A judge of one call is handed each line's OWN mode — its `**` — and reads its places beside it:
    // a line with no `**` has no mode of its own, and a call no place matches falls past it.
    expect(toolModes(permissionSet)).toEqual({ read_file: "deny", edit: "ask", shell: "ask" });
    expect(shellSubjects(permissionSet)).toEqual({ shell: "ask" });
    expect(linePlaces(permissionSet)).toEqual({
      read_file: { src: "allow" },
      write_file: { infra: "deny" },
      edit: { src: { function: "smart" } },
      "npm run build": { "packages/app": "allow" },
    });
    expect(holdsShellLines(permissionSet)).toBe(true);
    expect(holdsShellLines(parsePermissionSet({ "npm run build": { "packages/app": "allow" } }).permissionSet)).toBe(true);
    expect(holdsShellLines(parsePermissionSet({ read_file: "allow" }).permissionSet)).toBe(false);
    // A function at a place is a function the set names.
    expect(functionReferencesOf(permissionSet)).toEqual(["smart"]);
  });

  it("lowers every line's place map into `places`, authored, and reads the lines back from there", () => {
    const authored = parsePermissionSet({
      read_file: { "**": "deny", "docs/product": "allow" },
      write_file: { infra: "deny" },
      edit: { "**": "smart", src: "judge" },
      "npm run build": { "packages/app": "allow" },
      "git push": { "**": "ask", "claude/**": "allow" },
      other: "ask",
    }).permissionSet;
    const lowered = lowerPermissionSet(authored, "$/permission-sets/app/build");
    expect(lowered.permissions!.places).toEqual({
      read_file: { "**": "deny", "docs/product": "allow" },
      write_file: { infra: "deny" },
      edit: { "**": "smart", src: "judge" },
      "npm run build": { "packages/app": "allow" },
      "git push": { "**": "ask", "claude/**": "allow" },
    });
    // The gate is told each tool line's loosest answer; a command line's own mode rides in `subjects`.
    expect(lowered.permissions!.tools).toMatchObject({ read_file: "allow", write_file: "ask", edit: "ask" });
    expect(lowered.permissions!.subjects).toEqual({ "git push": "ask" });
    expect(lowered.permissions!.source).toBe("$/permission-sets/app/build");
    // …and the block reads back as the very set: the gate's loosest mode is never taken for the line's own.
    expect(permissionSetOfEnvironment(lowered.tools, lowered.permissions)).toEqual(authored);
    // A set whose only shell line is a place map with no `**` still says it judges a line.
    expect(lowerPermissionSet(parsePermissionSet({ "npm run build": { "packages/app": "allow" } }).permissionSet).permissions!.subjects).toEqual({});
  });

  it("withholds the shell only when every place of every line that could run refuses", () => {
    expect(shellWithheld(parsePermissionSet({ shell: { "**": "deny" }, "git status": "deny" }).permissionSet)).toBe(true);
    expect(shellWithheld(parsePermissionSet({ shell: { "**": "deny", "packages/app": "allow" } }).permissionSet)).toBe(false);
    expect(shellWithheld(parsePermissionSet({ shell: "deny", "npm run build": { "**": "deny", "packages/app": "allow" } }).permissionSet)).toBe(false);
  });

  it("writes `other` back only when the set has one (§2.3)", () => {
    expect(declOfPermissionSet(parsePermissionSet({ read_file: "allow" }).permissionSet)).toEqual({ read_file: "allow" });
    expect(declOfPermissionSet(parsePermissionSet({ read_file: "allow", other: "smart" }).permissionSet)).toEqual({ read_file: "allow", other: "smart" });
  });
});

describe("layers in a set's references (decision 0023 §2.5)", () => {
  const read = readerOver({
    "$/permission-sets/chat/ask-first": { read_file: "deny", "git push": "ask", shell: "ask", write_file: { mode: "ask", implementation: "native" }, other: "ask" },
    "$/permission-sets/app/build": { "npm run build": { "packages/app": "allow" }, read_file: { "C:": "allow" } },
    "$/permission-sets/web/docs": { web_fetch: { "docs.example.com": "allow" } },
    "$/permission-sets/stack/saved": { layers: ["$/permission-sets/chat/ask-first", "$/permission-sets/app/build"], git: "allow" },
    "$/permission-sets/loop/a": { layers: ["$/permission-sets/loop/b"] },
    "$/permission-sets/loop/b": { $ref: "$/permission-sets/loop/a" },
  });
  const resolve = (node: unknown): { decl: Record<string, unknown> | undefined; issues: PermissionSetIssue[] } => {
    const issues: PermissionSetIssue[] = [];
    return { decl: resolvePermissionSetDecl(node, read, "wf", issues), issues };
  };

  it("merges a `$ref` copy's lines into the one below: a place over a plain decision makes it the `**`", () => {
    const { decl, issues } = resolve({ $ref: "$/permission-sets/chat/ask-first", read_file: { "C:": "allow" } });
    expect(issues).toEqual([]);
    expect(decl!["read_file"]).toEqual({ "**": "deny", "C:": "allow" });
    // The lines it does not name fall through untouched.
    expect(decl!["git push"]).toBe("ask");
  });

  it("reads a file's `layers` oldest first, its own lines the newest", () => {
    const { decl, issues } = resolve("$/permission-sets/stack/saved");
    expect(issues).toEqual([]);
    expect(decl).toEqual({
      read_file: { "**": "deny", "C:": "allow" },
      "git push": "ask",
      shell: "ask",
      write_file: { mode: "ask", implementation: "native" },
      other: "ask",
      "npm run build": { "packages/app": "allow" },
      git: "allow",
    });
    // §2.2: a newer `git: allow` does not override an older `git push: ask` — the merged set holds both.
    expect(shellSubjects(parsePermissionSet(decl).permissionSet)).toMatchObject({ git: "allow", "git push": "ask" });
  });

  it("lists the stack a node is, each layer named by the reference that reached it", () => {
    const issues: PermissionSetIssue[] = [];
    const layers = permissionSetLayersOf({ $ref: "$/permission-sets/stack/saved", layers: ["$/permission-sets/web/docs"], shell: "allow" }, read, "wf", issues, "chat/session");
    expect(issues).toEqual([]);
    expect(layers!.map((layer) => layer.id)).toEqual(["$/permission-sets/chat/ask-first", "$/permission-sets/app/build", "$/permission-sets/stack/saved", "$/permission-sets/web/docs", "chat/session"]);
  });

  it("names a cycle through `layers`, and refuses a `layers` that is no list of references", () => {
    expect(resolve("$/permission-sets/loop/a").issues[0]!.message).toBe(
      "permission set reference cycle: $/permission-sets/loop/a → $/permission-sets/loop/b → $/permission-sets/loop/a",
    );
    expect(resolve({ layers: "$/permission-sets/chat/ask-first" }).issues[0]!.message).toMatch(/takes a list of references/);
  });
});
