/**
 * The toolset data model (decision 0007 §1): the map, its references, and the lowering that hands a
 * map-form state to an engine that only takes a list and a block — and reads it back.
 */
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { operationSchema, toolsSchema } from "../src/schemas";
import {
  declOfToolset,
  heldTools,
  isLoweredToolset,
  shellWithheld,
  declaresTools,
  lowerStateToolsets,
  lowerToolset,
  offeredTools,
  parseToolset,
  permissionsOfToolset,
  resolveToolsetDecl,
  shellSubjects,
  gateToolModes,
  subjectKindOf,
  toolImplementations,
  toolModes,
  TOOLSET_MARKERS,
  toolsetOfEnvironment,
  toolsetOfSettings,
  type ToolsetIssue,
  type ToolsetReader,
} from "../src/toolsets";

/** A reader over an in-memory set of toolset files, keyed by the reference that names them. */
function readerOver(files: Record<string, unknown>): ToolsetReader {
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
    // commands again: a toolset can say `start`, `move` and `stop` as it says `git`.
    ["start_task", "tool"],
    ["move_task", "tool"],
    ["list_tasks", "tool"],
    ["answer_question", "tool"],
    ["start", "command"],
    ["move", "command"],
    ["stop", "command"],
    ["reed_file", "unknown-tool"],
    ["Glob", "unknown-tool"],
    ["mcp__github__create_issue", "unknown-tool"],
  ])("'%s' is a %s", (subject, kind) => {
    expect(subjectKindOf(subject)).toBe(kind);
  });
});

describe("parsing the map", () => {
  it("reads subject → mode: present is offered with that mode, absent is not offered", () => {
    const { toolset, issues } = parseToolset({ read_file: "allow", web_fetch: "ask", bash: "ask" });
    expect(issues).toEqual([]);
    expect(offeredTools(toolset)).toEqual(["read_file", "web_fetch", "bash"]);
    expect(toolModes(toolset)).toEqual({ read_file: "allow", web_fetch: "ask", bash: "ask" });
    expect(offeredTools(toolset)).not.toContain("write_file");
  });

  it("WITHHOLDS a shell it denies outright — held as written, handed to nobody", () => {
    const { toolset } = parseToolset({ read_file: "allow", bash: "deny", other: "deny" });
    expect(shellWithheld(toolset)).toBe(true);
    expect(heldTools(toolset)).toEqual(["read_file", "bash"]);
    expect(offeredTools(toolset)).toEqual(["read_file"]);
    expect(gateToolModes(toolset)).toEqual({ read_file: "allow", bash: "deny" });
    // A command subject that denies too leaves nothing to run: still withheld.
    expect(shellWithheld(parseToolset({ bash: "deny", "git push": "deny" }).toolset)).toBe(true);
    // One that allows, asks or defers keeps the shell OFFERED, for those lines.
    for (const mode of ["allow", "ask", "smart"]) {
      const offered = parseToolset({ bash: "deny", "git status": mode }).toolset;
      expect(shellWithheld(offered)).toBe(false);
      expect(offeredTools(offered)).toEqual(["bash"]);
      expect(gateToolModes(offered)).toEqual({ bash: "smart" });
    }
    expect(shellWithheld(parseToolset({ bash: "deny", script: "ask" }).toolset)).toBe(false);
  });

  it("round-trips a WITHHELD shell through the lowered block: held, not offered, and its authored mode", () => {
    const toolset = parseToolset({ read_file: "allow", bash: "deny", other: "deny" }).toolset;
    const lowered = lowerToolset(toolset);
    expect(lowered.tools).toEqual(["read_file"]);
    expect(lowered.permissions).toEqual({ tools: { read_file: "allow", bash: "deny", ...TOOLSET_MARKERS }, implementations: {}, other: "deny", subjects: { bash: "deny" } });
    const back = toolsetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back).toEqual(toolset);
    expect(declOfToolset(back)).toEqual({ read_file: "allow", bash: "deny", other: "deny" });
  });

  it("carries an offered shell's subjects in `subjects` alone — `permissions.tools` holds tools and the marks", () => {
    const lowered = lowerToolset(parseToolset({ bash: "deny", "git status": "allow", other: "deny" }).toolset, undefined, "$/toolsets/x/y");
    const tools = lowered.permissions!.tools!;
    expect(tools).toEqual({ bash: "smart", ...TOOLSET_MARKERS });
    expect(lowered.permissions).toMatchObject({ subjects: { bash: "deny", "git status": "allow" }, source: "$/toolsets/x/y" });
    expect(Object.keys(toolsetOfEnvironment(lowered.tools, lowered.permissions).entries)).toEqual(["bash", "git status"]);
  });

  it("reads an object entry, with the implementation chosen too", () => {
    const { toolset, issues } = parseToolset({ write_file: { mode: "ask", implementation: "native" }, read_file: { mode: "allow" } });
    expect(issues).toEqual([]);
    expect(toolModes(toolset)).toEqual({ write_file: "ask", read_file: "allow" });
    expect(toolImplementations(toolset)).toEqual({ write_file: "native" });
  });

  it("keeps `other` apart from the entries — it names no one tool", () => {
    const { toolset } = parseToolset({ read_file: "allow", other: "deny" });
    expect(toolset.other).toBe("deny");
    expect(Object.keys(toolset.entries)).toEqual(["read_file"]);
    expect(offeredTools(toolset)).toEqual(["read_file"]);
  });

  it("accepts command subjects and `script`, and carries them without offering them as tools", () => {
    const { toolset, issues } = parseToolset({ bash: "ask", "git status": "allow", "git  commit": "ask", git: "deny", script: "ask" });
    expect(issues).toEqual([]);
    expect(offeredTools(toolset)).toEqual(["bash"]);
    // Whitespace in a command subject is normalized, so two spellings of one command are one entry.
    // The shell's own entry is among them: it is the mode for any command no other entry names (§4).
    expect(shellSubjects(toolset)).toEqual({ bash: "ask", "git status": "allow", "git commit": "ask", git: "deny", script: "ask" });
    // …and the gate is handed `smart` for it, so the line is read before anything answers for the tool.
    expect(toolModes(toolset)).toEqual({ bash: "ask" });
    expect(gateToolModes(toolset)).toEqual({ bash: "smart" });
  });

  it("WARNS about a tool name nothing knows, and drops it — it falls to `other`", () => {
    const { toolset, issues } = parseToolset({ reed_file: "allow", other: "ask" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: "reed_file", severity: "warning" });
    expect(issues[0]!.message).toMatch(/not a tool JaiRA knows.*'other'/);
    expect(toolset.entries).toEqual({});
    expect(toolset.other).toBe("ask");
  });

  it.each([
    [{ read_file: "yes" }, /a mode is one of allow, deny, ask, smart/],
    [{ read_file: { implementation: "native" } }, /has no mode/],
    [{ read_file: { mode: "ask", implementation: "theirs" } }, /implementation.*one of app, native/],
    [{ read_file: 3 }, /a mode is one of/],
    [{ $expr: "x" }, /not a subject/],
    [{ "": "allow" }, /cannot be empty/],
  ])("reports %j as an ERROR and leaves the entry out", (decl, message) => {
    const { toolset, issues } = parseToolset(decl);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(1);
    expect(issues[0]!.message).toMatch(message);
    expect(toolset.entries).toEqual({});
  });

  it("warns about an implementation where it means nothing", () => {
    const { issues } = parseToolset({ "git commit": { mode: "ask", implementation: "native" }, other: { mode: "deny", implementation: "app" } });
    expect(issues.map((i) => i.severity)).toEqual(["warning", "warning"]);
  });

  it("refuses something that is not a map", () => {
    expect(parseToolset(["read_file"]).issues[0]!.severity).toBe("error");
  });
});

describe("references", () => {
  const files = {
    "$/toolsets/chat/read-only": { read_file: "allow", glob: "allow", bash: "deny", other: "deny" },
    "$/toolsets/chat/writer": { $ref: "$/toolsets/chat/read-only", write_file: { mode: "ask", implementation: "native" } },
    "$/toolsets/feature/implementation/build": { $ref: "$/toolsets/chat/writer", bash: "smart" },
    "$/toolsets/loop/a": { $ref: "$/toolsets/loop/b", read_file: "allow" },
    "$/toolsets/loop/b": { $ref: "$/toolsets/loop/a" },
    "$/toolsets/loop/self": "$/toolsets/loop/self",
    "$/lib/list": ["bash"],
  };
  const read = readerOver(files);
  const resolve = (node: unknown): { decl: Record<string, unknown> | undefined; issues: ToolsetIssue[] } => {
    const issues: ToolsetIssue[] = [];
    return { decl: resolveToolsetDecl(node, read, "wf", issues), issues };
  };

  it("a bare string is the toolset it names", () => {
    expect(resolve("$/toolsets/chat/read-only")).toEqual({ decl: files["$/toolsets/chat/read-only"], issues: [] });
  });

  it("`$ref` with sibling keys starts from one and overrides per subject", () => {
    const { decl, issues } = resolve({ $ref: "$/toolsets/chat/read-only", write_file: "ask", bash: "ask" });
    expect(issues).toEqual([]);
    expect(decl).toEqual({ read_file: "allow", glob: "allow", bash: "ask", other: "deny", write_file: "ask" });
  });

  it("a toolset file may start from another, through a nested bucket, to any depth", () => {
    const { decl, issues } = resolve("$/toolsets/feature/implementation/build");
    expect(issues).toEqual([]);
    expect(decl).toEqual({
      read_file: "allow",
      glob: "allow",
      bash: "smart",
      other: "deny",
      write_file: { mode: "ask", implementation: "native" },
    });
  });

  it("an override replaces the ENTRY whole — no implementation is left behind", () => {
    const { decl } = resolve({ $ref: "$/toolsets/chat/writer", write_file: "allow" });
    expect(parseToolset(decl).toolset.entries["write_file"]).toEqual({ kind: "tool", mode: "allow" });
  });

  it("a cycle is an error NAMING it", () => {
    const { decl, issues } = resolve("$/toolsets/loop/a");
    expect(decl).toBeUndefined();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toBe("toolset reference cycle: $/toolsets/loop/a → $/toolsets/loop/b → $/toolsets/loop/a");
    expect(resolve("$/toolsets/loop/self").issues[0]!.message).toMatch(/cycle: \$\/toolsets\/loop\/self → \$\/toolsets\/loop\/self/);
  });

  it("a reference that names nothing, or names something that is not a map, is an error", () => {
    expect(resolve("$/toolsets/chat/nope").issues[0]!.message).toMatch(/matches no file/);
    expect(resolve({ $ref: "$/lib/list", bash: "ask" }).issues[0]!.message).toMatch(/is not a toolset/);
  });
});

describe("reading a lowered block back", () => {
  const map = { read_file: "allow", bash: "ask", write_file: "deny", other: "deny" };

  it("lowers the shell's mode as a SUBJECT, and leaves the marks that say a toolset was declared", () => {
    // `bash: "ask"` is the answer for any command nothing else names, not a mode for the tool: the
    // gate is handed `smart` so the line is taken apart first, and the authored mode rides beside it.
    expect(lowerToolset(parseToolset(map).toolset)).toEqual({
      tools: ["read_file", "bash", "write_file"],
      permissions: { tools: { read_file: "allow", bash: "smart", write_file: "deny", ...TOOLSET_MARKERS }, implementations: {}, other: "deny", subjects: { bash: "ask" } },
    });
  });

  it("tells a lowered MAP by its marks, and strips them on the way back", () => {
    const lowered = lowerToolset(parseToolset(map).toolset);
    expect(isLoweredToolset(lowered.permissions)).toBe(true);
    // A block with no marks declared no toolset; one mark, or a mark with the wrong mode, is not the pair.
    expect(isLoweredToolset({ tools: { read_file: "allow" } })).toBe(false);
    expect(isLoweredToolset({ tools: { "jaira:toolset+": "allow" } })).toBe(false);
    const back = toolsetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back).toEqual(parseToolset(map).toolset);
    // An empty map still says it was one.
    expect(lowerToolset(parseToolset({}).toolset)).toEqual({ tools: [], permissions: { tools: { ...TOOLSET_MARKERS }, implementations: {} } });
  });

  it("keeps a mode for a tool the list does not offer as an UN-offered entry — a child's inherited key", () => {
    // `permissions.tools` merges per key down the chain, and the list is replaced whole.
    const back = toolsetOfEnvironment(["glob"], { tools: { glob: "allow", read_file: "allow", ...TOOLSET_MARKERS } });
    expect(back.entries).toEqual({ glob: { kind: "tool", mode: "allow" }, read_file: { kind: "tool", mode: "allow", offered: false } });
    expect(offeredTools(back)).toEqual(["glob"]);
  });

  it("gives a listed tool no mode where the block gives none — a turn that declared no toolset", () => {
    expect(toolsetOfEnvironment(["show_artifact"]).entries).toEqual({ show_artifact: { kind: "tool" } });
    expect(toolModes(toolsetOfEnvironment(["show_artifact"]))).toEqual({});
  });

  it("round-trips through the lowered shape, command subjects and implementations included", () => {
    const authored = parseToolset({ read_file: { mode: "allow", implementation: "native" }, bash: "smart", "git commit": "ask", script: "deny", other: "ask" }).toolset;
    const lowered = lowerToolset(authored);
    expect(lowered.permissions).toEqual({
      tools: { read_file: "allow", bash: "smart", ...TOOLSET_MARKERS },
      other: "ask",
      subjects: { bash: "smart", "git commit": "ask", script: "deny" },
      implementations: { read_file: "native" },
    });
    expect(toolsetOfEnvironment(lowered.tools, lowered.permissions)).toEqual(authored);
  });

  it("keeps `scopes` beside a toolset, and never writes `default` or a profile", () => {
    const scopes = [{ path: "app/**", default: "allow" as const }];
    const lowered = lowerToolset(parseToolset({ read_file: "allow" }).toolset, { scopes });
    expect(lowered.permissions).toEqual({ tools: { read_file: "allow", ...TOOLSET_MARKERS }, implementations: {}, scopes });
  });
});

describe("lowering a state file", () => {
  const read = readerOver({
    "$/toolsets/chat/read-only": { read_file: "allow", glob: "allow", other: "deny" },
    "$/lib/list": ["bash"],
  });

  it("leaves a state with no toolset as the SAME object", () => {
    const def = {
      environment: { model: "m", permissions: { scopes: [{ path: "app/**", default: "allow" }] } },
      operation: { kind: "prompt", prompt: "go" },
      children: { a: { environment: { model: "n" } } },
    };
    const lowered = lowerStateToolsets("wf", def, NO_FILES);
    expect(lowered.def).toBe(def);
    expect(lowered.issues).toEqual([]);
  });

  it("refuses the LIST form — written, or in a file a reference names — and lowers it to nothing", () => {
    for (const tools of [["read_file"], [], "$/lib/list", { $ref: "$/lib/list" }]) {
      const { def, issues } = lowerStateToolsets("wf", { environment: { tools } }, read);
      expect(issues, JSON.stringify(tools)).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.tools", severity: "error" })]);
      expect(issues[0]!.message).toMatch(/the list form was removed/);
      expect((def as { environment: unknown }).environment).toEqual({ tools: [], permissions: { tools: { ...TOOLSET_MARKERS }, implementations: {} } });
    }
  });

  it("refuses the old `permissions` modes, beside a map or on their own, and keeps the scopes", () => {
    const scopes = [{ path: "app/**", default: "allow" }];
    const beside = lowerStateToolsets(
      "wf",
      { environment: { tools: { read_file: "allow" }, permissions: { tools: { read_file: "deny" }, default: "deny", scopes } } },
      read,
    );
    expect(beside.issues).toEqual([expect.objectContaining({ severity: "error", path: "environment.tools" })]);
    expect(beside.issues[0]!.message).toMatch(/permissions\.tools, permissions\.default are no longer read/);
    expect((beside.def as { environment: unknown }).environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS }, implementations: {}, scopes } });

    const alone = lowerStateToolsets("wf", { operation: { kind: "prompt", permissions: { profile: "read-only", scopes } } }, read);
    expect(alone.issues).toEqual([expect.objectContaining({ severity: "error", path: "operation.permissions" })]);
    expect(alone.issues[0]!.message).toMatch(/permissions\.profile is no longer read/);
    expect((alone.def as { operation: unknown }).operation).toEqual({ kind: "prompt", permissions: { scopes } });
  });

  it("lowers a reference, an inline map and a `$ref` with overrides — in all three positions", () => {
    const { def, issues } = lowerStateToolsets(
      "wf",
      {
        environment: { model: "m", tools: "$/toolsets/chat/read-only" },
        operation: { kind: "prompt", prompt: "go", tools: { bash: "smart", "git status": "allow" } },
        children: { review: { state: "./review", environment: { tools: { $ref: "$/toolsets/chat/read-only", write_file: "ask" } } } },
      },
      read,
    );
    expect(issues).toEqual([]);
    expect(def).toEqual({
      environment: { model: "m", tools: ["read_file", "glob"], permissions: { tools: { read_file: "allow", glob: "allow", ...TOOLSET_MARKERS }, implementations: {}, other: "deny" } },
      // `source` is written beside `subjects`, and only there: where a shell line's subjects came from.
      operation: {
        kind: "prompt",
        prompt: "go",
        tools: ["bash"],
        permissions: {
          tools: { bash: "smart", ...TOOLSET_MARKERS },
          implementations: {},
          subjects: { bash: "smart", "git status": "allow" },
          source: "inline",
        },
      },
      children: {
        review: {
          state: "./review",
          environment: { tools: ["read_file", "glob", "write_file"], permissions: { tools: { read_file: "allow", glob: "allow", write_file: "ask", ...TOOLSET_MARKERS }, implementations: {}, other: "deny" } },
        },
      },
    });
  });

  it("leaves what is the engine's: a binding, a scoped name", () => {
    for (const tools of [{ $expr: ".inputs.tools" }, "review", { $ref: "review" }, { $any: [] }]) {
      const def = { environment: { tools } };
      expect(lowerStateToolsets("wf", def, read).def).toBe(def);
    }
  });

  it("reports an issue at the path it was written, and lowers what could be read", () => {
    const { def, issues } = lowerStateToolsets("wf", { environment: { tools: { read_file: "allow", bash: "maybe", Glob: "ask" } } }, read);
    expect(issues).toEqual([
      expect.objectContaining({ stateId: "wf", path: "environment.tools.bash", severity: "error" }),
      expect.objectContaining({ stateId: "wf", path: "environment.tools.Glob", severity: "warning" }),
    ]);
    expect((def as { environment: unknown }).environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS }, implementations: {} } });
  });

  it("offers nothing under a reference it could not follow", () => {
    const { def, issues } = lowerStateToolsets("wf", { environment: { tools: "$/toolsets/chat/nope" } }, read);
    expect(issues).toEqual([expect.objectContaining({ path: "environment.tools", severity: "error" })]);
    expect((def as { environment: unknown }).environment).toEqual({ tools: [], permissions: { tools: { ...TOOLSET_MARKERS }, implementations: {} } });
  });
});

describe("lowering a toolset inside a REFERENCED block", () => {
  const scopes = [{ path: "app/**", default: "allow" }];
  const map = { read_file: "allow", bash: "deny", "git status": "allow", other: "deny" };
  const read = readerOver({
    "$/toolsets/chat/read-only": { read_file: "allow", glob: "allow", other: "deny" },
    "$/envs/inline": { model: "m", tools: map, permissions: { scopes } },
    "$/envs/named": { tools: "$/toolsets/chat/read-only" },
    "$/envs/over": { $ref: "$/envs/inline", permissions: { scopes: [] } },
    "$/envs/plain": { model: "m" },
    "$/envs/list": { tools: ["bash"] },
    "$/envs/old": { permissions: { default: "deny" } },
    "$/ops/plan": { kind: "prompt", prompt: "go", tools: map },
  });
  /** What the same map lowers to when it is written on the state. */
  const written = (block: Record<string, unknown>) => (lowerStateToolsets("wf", { environment: block }, read).def as { environment: Record<string, unknown> }).environment;

  it("opens the block and lowers its map EXACTLY as one written on the state — beside the reference, which stays", () => {
    const { tools, permissions } = written({ tools: map, permissions: { scopes } });
    for (const environment of ["$/envs/inline", { $ref: "$/envs/inline" }, { $ref: "$/envs/inline", model: "n" }]) {
      const { def, issues } = lowerStateToolsets("wf", { environment }, read);
      expect(issues, JSON.stringify(environment)).toEqual([]);
      const siblings = typeof environment === "string" ? { $ref: environment } : environment;
      // The lowered fields are SIBLINGS of the reference: the engine's `$ref` merge lets a sibling
      // `tools` list replace the target's map, and sibling `permissions` override it per key.
      expect((def as { environment: unknown }).environment).toEqual({ ...siblings, tools, permissions });
    }
  });

  it("does the same for an `operation` and a child mount's `environment`", () => {
    const { def, issues } = lowerStateToolsets("wf", { operation: "$/ops/plan", children: { a: { state: "./a", environment: "$/envs/named" } } }, read);
    expect(issues).toEqual([]);
    const { tools, permissions } = written({ tools: map });
    expect((def as { operation: unknown }).operation).toEqual({ $ref: "$/ops/plan", tools, permissions });
    // A toolset REFERENCE inside the block keeps its name as the source, as it would on the state.
    expect((def as { children: { a: unknown } }).children.a).toEqual({ state: "./a", environment: { $ref: "$/envs/named", ...written({ tools: "$/toolsets/chat/read-only" }) } });
  });

  it("follows a block that starts from another, merging `permissions` per key the way the engine does", () => {
    const { def } = lowerStateToolsets("wf", { environment: "$/envs/over" }, read);
    expect((def as { environment: unknown }).environment).toEqual({ $ref: "$/envs/over", ...written({ tools: map, permissions: { scopes: [] } }) });
  });

  it("leaves a referenced block with no toolset — and one it cannot follow — as the SAME object", () => {
    for (const environment of ["$/envs/plain", { $ref: "$/envs/plain", model: "n" }, "$/envs/nope", { $ref: "review" }]) {
      const def = { environment };
      const lowered = lowerStateToolsets("wf", def, read);
      expect(lowered.def, JSON.stringify(environment)).toBe(def);
      expect(lowered.issues).toEqual([]);
    }
  });

  it("refuses the old forms inside a referenced block, naming the block", () => {
    const list = lowerStateToolsets("wf", { environment: "$/envs/list" }, read);
    expect(list.issues).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.tools", severity: "error" })]);
    expect(list.issues[0]!.message).toMatch(/^in the block '\$\/envs\/list' names: .*the list form was removed/);
    const old = lowerStateToolsets("wf", { environment: "$/envs/old" }, read);
    expect(old.issues).toEqual([expect.objectContaining({ stateId: "wf", path: "environment.permissions", severity: "error" })]);
    expect(old.issues[0]!.message).toMatch(/^in the block '\$\/envs\/old' names: permissions\.default is no longer read/);
  });

  it("lets a block's OWN `tools` win over the one its reference holds, as the engine's merge does", () => {
    const environment = { $ref: "$/envs/inline", tools: { glob: "allow" } };
    const { def } = lowerStateToolsets("wf", { environment }, read);
    expect((def as { environment: { tools: unknown } }).environment.tools).toEqual(["glob"]);
  });
});

describe("a message's settings", () => {
  it("reads a state's lowered declaration and the map form as the same toolset", () => {
    const inherited = toolsetOfSettings({
      tools: ["read_file", "bash"],
      permissions: { tools: { read_file: "allow", bash: "smart", ...TOOLSET_MARKERS }, other: "deny", subjects: { bash: "ask" } },
      implementations: { read_file: "native" },
    });
    const map = toolsetOfSettings({ toolset: { read_file: { mode: "allow", implementation: "native" }, bash: "ask", other: "deny" } });
    expect(map.issues).toEqual([]);
    expect(inherited.toolset).toEqual(map.toolset);
  });

  it("tells saying nothing about tools from granting none", () => {
    expect(declaresTools({})).toBe(false);
    expect(declaresTools({ permissions: { tools: { bash: "deny" } } })).toBe(false);
    expect(declaresTools({ tools: [] })).toBe(true);
    expect(declaresTools({ toolset: {} })).toBe(true);
  });
});

describe("the operation schema", () => {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(toolsSchema());

  it.each([
    ["$/toolsets/chat/read-only"],
    [{ read_file: "allow", "git status": "allow", script: "ask", other: "deny" }],
    [{ $ref: "$/toolsets/chat/read-only", write_file: { mode: "ask", implementation: "native" } }],
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
