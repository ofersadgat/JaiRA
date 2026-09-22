/**
 * The toolset data model (decision 0007 §1): the map, its references, the legacy reader, and the
 * lowering that hands a map-form state to an engine that only takes a list and a block.
 */
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { operationSchema, toolsSchema } from "../src/schemas";
import {
  applyLegacyProfile,
  carriedShellSubjects,
  declOfToolset,
  heldTools,
  isLoweredToolset,
  SHELL_DENIED_MARKERS,
  shellCarriedKey,
  shellWithheld,
  declaresTools,
  LEGACY_NON_READ_ONLY_TOOLS,
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
  toolsetOfLegacy,
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
    // The legacy reading is a grant, and runs as it did.
    expect(offeredTools(toolsetOfLegacy(["bash"], { tools: { bash: "deny" } }))).toEqual(["bash"]);
  });

  it("round-trips a WITHHELD shell through the lowered block: held, not offered, and its authored mode", () => {
    const toolset = parseToolset({ read_file: "allow", bash: "deny", other: "deny" }).toolset;
    const lowered = lowerToolset(toolset);
    expect(lowered.tools).toEqual(["read_file"]);
    expect(lowered.permissions).toEqual({ tools: { read_file: "allow", bash: "deny", ...TOOLSET_MARKERS }, other: "deny", subjects: { bash: "deny" } });
    const back = toolsetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back).toEqual(toolset);
    expect(declOfToolset(back)).toEqual({ read_file: "allow", bash: "deny", other: "deny" });
  });

  it("CARRIES an offered shell's subjects in a `permissions.tools` key, because a run is handed nothing else", () => {
    const lowered = lowerToolset(parseToolset({ bash: "deny", "git status": "allow", other: "deny" }).toolset, undefined, "$/toolsets/x/y");
    const tools = lowered.permissions!.tools!;
    expect(tools["bash"]).toBe("smart");
    // The pair that says the shell's own entry is `deny`, for a switch a run derives from it.
    expect(tools).toMatchObject(SHELL_DENIED_MARKERS);
    expect(carriedShellSubjects(tools)).toEqual([{ subjects: { bash: "deny", "git status": "allow" }, source: "$/toolsets/x/y" }]);
    // …which no reader takes for a tool, and which reads back as the toolset it was.
    expect(Object.keys(toolsetOfEnvironment(lowered.tools, lowered.permissions).entries)).toEqual(["bash", "git status"]);
    // A shell whose entry is not `deny` carries its subjects and no pair.
    const asking = lowerToolset(parseToolset({ bash: "ask" }).toolset).permissions!.tools!;
    expect(carriedShellSubjects(asking)).toEqual([{ subjects: { bash: "ask" } }]);
    expect(Object.keys(asking)).not.toContain("jaira:bash-deny+");
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

describe("the legacy reader", () => {
  it("folds the list and the permissions block into the same map", () => {
    const toolset = toolsetOfLegacy(["read_file", "bash"], { tools: { read_file: "allow", write_file: "deny" }, default: "ask", profile: "full" });
    expect(toolset.entries).toEqual({
      read_file: { kind: "tool", mode: "allow" },
      // No mode of its own, so it takes the block's `default`.
      bash: { kind: "tool", mode: "ask" },
      // Named by the block and NOT granted by the list: the mode is kept, the tool is not offered.
      write_file: { kind: "tool", mode: "deny", offered: false },
    });
    // `default` → `other`.
    expect(toolset.other).toBe("ask");
    // `full` excluded nothing, so it leaves nothing behind — and a toolset has no profile to carry.
    expect(Object.keys(toolset)).not.toContain("profile");
    expect(offeredTools(toolset)).toEqual(["read_file", "bash"]);
  });

  it("reads an old `profile: \"read-only\"` as the MAP it meant: every writer denied, `other` deny", () => {
    // The 19 authored states that still say it. `bash` is LISTED here and refused anyway, which is
    // what the profile did: it ran ahead of the mode and no `allow` beside it rescued a writer.
    const toolset = toolsetOfLegacy(["read_file", "bash"], { profile: "read-only", tools: { read_file: "allow", bash: "allow" }, default: "ask" });
    expect(toolset).toEqual({
      entries: {
        read_file: { kind: "tool", mode: "allow" },
        bash: { kind: "tool", mode: "deny", offered: false },
        edit: { kind: "tool", mode: "deny", offered: false },
        write_file: { kind: "tool", mode: "deny", offered: false },
      },
      other: "deny",
      // …and it is still the LEGACY reading: on a delegated agent it removes what the profile
      // removed and nothing a list merely did not mention.
      legacy: true,
    });
    expect(offeredTools(toolset)).toEqual(["read_file"]);
    // `plan` narrowed identically; a custom name was never registered by JaiRA and changes nothing.
    expect(toolsetOfLegacy(["bash"], { profile: "plan" }).entries["bash"]).toEqual({ kind: "tool", mode: "deny", offered: false });
    expect(toolsetOfLegacy(["bash"], { profile: "search" })).toEqual({ entries: { bash: { kind: "tool" } }, legacy: true });
  });

  it("freezes what `readOnly` said, for that reader alone", () => {
    expect(LEGACY_NON_READ_ONLY_TOOLS).toEqual(["edit", "write_file", "bash"]);
    expect(applyLegacyProfile({ entries: {} }, undefined)).toEqual({ entries: {} });
    expect(applyLegacyProfile({ entries: {} }, "full")).toEqual({ entries: {} });
  });

  it("never LOWERS a profile: a map beside one takes its denies, and the engine is handed none", () => {
    const { toolset } = parseToolset({ read_file: "allow", bash: "allow" });
    const lowered = lowerToolset(toolset, { profile: "read-only" });
    expect(lowered.tools).toEqual(["read_file"]);
    expect(lowered.permissions).toEqual({
      // The shell's refusal rides as its SUBJECT, behind the gate mode every shell entry lowers to.
      // …and a shell refused with nothing left to run is WITHHELD: its gate mode is `deny`.
      tools: { read_file: "allow", bash: "deny", edit: "deny", write_file: "deny", ...TOOLSET_MARKERS },
      other: "deny",
      subjects: { bash: "deny" },
    });
  });

  it("lets an authored `other` win over `default`, and leaves a mode absent when nothing said one", () => {
    const toolset = toolsetOfLegacy(["bash"], { default: "ask", other: "deny" });
    expect(toolset.other).toBe("deny");
    expect(toolsetOfLegacy(["bash"]).entries["bash"]).toEqual({ kind: "tool" });
    expect(toolModes(toolsetOfLegacy(["bash"]))).toEqual({});
  });

  it("keeps a listed name it does not know — an unregistered tool is still refused where it always was", () => {
    expect(offeredTools(toolsetOfLegacy(["echo_tool", "git"]))).toEqual(["echo_tool", "git"]);
  });

  it("folds the composer's implementations map onto the entries", () => {
    expect(toolImplementations(toolsetOfLegacy(["read_file", "glob"], undefined, { read_file: "native" }))).toEqual({ read_file: "native" });
  });
});

describe("legacy equivalence", () => {
  const legacy = { tools: ["read_file", "bash", "write_file"], permissions: { tools: { read_file: "allow", bash: "ask", write_file: "deny" }, other: "deny" } } as const;
  const map = { read_file: "allow", bash: "ask", write_file: "deny", other: "deny" };

  it("the same state in old and new form is the same GRANT and the same MODES — and only the old one is `legacy`", () => {
    // What differs is what a delegated agent KEEPS: the legacy reading leaves it the built-ins the
    // list did not mention, as it always did; a map is the whole grant (decision 0007 §3).
    const fromMap = parseToolset(map).toolset;
    const fromLegacy = toolsetOfLegacy(legacy.tools, legacy.permissions);
    expect(fromMap.legacy).toBeUndefined();
    expect(fromLegacy.legacy).toBe(true);
    expect({ ...fromMap, legacy: true }).toEqual(fromLegacy);
  });

  it("and lowers to the block the old form wrote by hand — but for the shell, whose mode is a SUBJECT, and the marks that say it was a MAP", () => {
    // `bash: "ask"` is the answer for any command nothing else names, not a mode for the tool: the
    // gate is handed `smart` so the line is taken apart first, and the authored mode rides beside it.
    const lowered = { tools: legacy.tools, permissions: { tools: { ...legacy.permissions.tools, bash: "smart" }, other: "deny", subjects: { bash: "ask" } } };
    // …and, since the shell is offered, its subjects carried where a RUN can read them.
    const marked = {
      ...lowered,
      permissions: { ...lowered.permissions, tools: { ...lowered.permissions.tools, ...TOOLSET_MARKERS, [shellCarriedKey({ subjects: { bash: "ask" } })]: "allow" } },
    };
    expect(lowerToolset(parseToolset(map).toolset)).toEqual(marked);
    // The legacy reading lowers with NO marks, so a run reads it as legacy.
    expect(lowerToolset(toolsetOfLegacy(legacy.tools, legacy.permissions))).toEqual(lowered);
    // Without the shell, the legacy block is the same block to the letter.
    const { bash: _bash, ...tools } = legacy.permissions.tools;
    const quiet = { tools: ["read_file", "write_file"], permissions: { tools, other: "deny" as const } };
    expect(lowerToolset(toolsetOfLegacy(quiet.tools, quiet.permissions))).toEqual(quiet);
    // Either spelling reads back as the toolset it was — a map as a map, a list as the legacy reading.
    expect(toolsetOfEnvironment(marked.tools, marked.permissions as never)).toEqual(parseToolset(map).toolset);
    expect(toolsetOfEnvironment(lowered.tools, lowered.permissions as never)).toEqual({ ...parseToolset(map).toolset, legacy: true });
  });

  it("tells a lowered MAP from a legacy block by the marks, and strips them on the way back", () => {
    const lowered = lowerToolset(parseToolset(map).toolset);
    expect(isLoweredToolset(lowered.permissions)).toBe(true);
    expect(isLoweredToolset(legacy.permissions)).toBe(false);
    // One mark, or a mark with the wrong mode, is somebody's tool entry and not a mark.
    expect(isLoweredToolset({ tools: { "jaira:toolset+": "allow" } })).toBe(false);
    const back = toolsetOfEnvironment(lowered.tools, lowered.permissions);
    expect(back.legacy).toBeUndefined();
    expect(Object.keys(back.entries)).toEqual(["read_file", "bash", "write_file"]);
    expect(toolsetOfEnvironment(legacy.tools, legacy.permissions).legacy).toBe(true);
    // Two marks that DISAGREE, because a gate answers `other` for a name it has no entry for.
    expect(new Set(Object.values(TOOLSET_MARKERS)).size).toBe(2);
  });

  it("round-trips through the lowered shape, command subjects and implementations included", () => {
    const authored = parseToolset({ read_file: { mode: "allow", implementation: "native" }, bash: "smart", "git commit": "ask", script: "deny", other: "ask" }).toolset;
    const lowered = lowerToolset(authored);
    expect(lowered.permissions).toEqual({
      tools: { read_file: "allow", bash: "smart", ...TOOLSET_MARKERS, [shellCarriedKey({ subjects: { bash: "smart", "git commit": "ask", script: "deny" } })]: "allow" },
      other: "ask",
      subjects: { bash: "smart", "git commit": "ask", script: "deny" },
      implementations: { read_file: "native" },
    });
    expect(toolsetOfEnvironment(lowered.tools, lowered.permissions)).toEqual(authored);
  });

  it("keeps `scopes` beside a toolset, folds a legacy `profile` INTO it, and never writes `default` or a profile", () => {
    const scopes = [{ path: "app/**", default: "allow" as const }];
    const lowered = lowerToolset(parseToolset({ read_file: "allow" }).toolset, { scopes, profile: "read-only", default: "ask" });
    // `bash` is refused like the other two — and with nothing left to run it is withheld, `deny` at the gate.
    expect(lowered.permissions).toEqual({
      tools: { read_file: "allow", edit: "deny", write_file: "deny", bash: "deny", ...TOOLSET_MARKERS },
      other: "deny",
      subjects: { bash: "deny" },
      scopes,
    });
    expect(permissionsOfToolset(toolsetOfLegacy(["bash"], { default: "ask" }))).toEqual({ tools: { bash: "smart" }, other: "ask", subjects: { bash: "ask" } });
  });
});

describe("lowering a state file", () => {
  const read = readerOver({
    "$/toolsets/chat/read-only": { read_file: "allow", glob: "allow", other: "deny" },
    "$/lib/list": ["bash"],
  });

  it("leaves an unmigrated state as the SAME object", () => {
    const def = {
      environment: { tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } },
      operation: { kind: "prompt", prompt: "go" },
      children: { a: { environment: { tools: [] } } },
    };
    const lowered = lowerStateToolsets("wf", def, NO_FILES);
    expect(lowered.def).toBe(def);
    expect(lowered.issues).toEqual([]);
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
      environment: { model: "m", tools: ["read_file", "glob"], permissions: { tools: { read_file: "allow", glob: "allow", ...TOOLSET_MARKERS }, other: "deny" } },
      // `source` is written beside `subjects`, and only there: where a shell line's subjects came from.
      // …and, for a run, in the key lowering carries an offered shell's subjects in.
      operation: {
        kind: "prompt",
        prompt: "go",
        tools: ["bash"],
        permissions: {
          tools: { bash: "smart", ...TOOLSET_MARKERS, [shellCarriedKey({ subjects: { bash: "smart", "git status": "allow" }, source: "inline" })]: "allow" },
          subjects: { bash: "smart", "git status": "allow" },
          source: "inline",
        },
      },
      children: {
        review: {
          state: "./review",
          environment: { tools: ["read_file", "glob", "write_file"], permissions: { tools: { read_file: "allow", glob: "allow", write_file: "ask", ...TOOLSET_MARKERS }, other: "deny" } },
        },
      },
    });
  });

  it("leaves what is the engine's: a binding, a scoped name, a list fragment", () => {
    for (const tools of [{ $expr: ".inputs.tools" }, "review", { $ref: "review" }, { $any: [] }, "$/lib/list", { $ref: "$/lib/list" }]) {
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
    expect((def as { environment: unknown }).environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS } } });
  });

  it("offers nothing under a reference it could not follow", () => {
    const { def, issues } = lowerStateToolsets("wf", { environment: { tools: "$/toolsets/chat/nope" } }, read);
    expect(issues).toEqual([expect.objectContaining({ path: "environment.tools", severity: "error" })]);
    expect((def as { environment: unknown }).environment).toEqual({ tools: [], permissions: { tools: { ...TOOLSET_MARKERS } } });
  });

  it("warns that the block's own modes are ignored beside a map, and keeps its scopes", () => {
    const scopes = [{ path: "app/**", default: "allow" }];
    const { def, issues } = lowerStateToolsets(
      "wf",
      { environment: { tools: { read_file: "allow" }, permissions: { tools: { read_file: "deny" }, default: "deny", scopes } } },
      read,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", path: "environment.tools" });
    expect(issues[0]!.message).toMatch(/permissions\.tools, permissions\.default beside a toolset map are ignored/);
    expect((def as { environment: unknown }).environment).toEqual({ tools: ["read_file"], permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS }, scopes } });
  });
});

describe("a message's settings", () => {
  it("reads the legacy three fields and the map form as the same toolset", () => {
    const legacy = toolsetOfSettings({
      tools: ["read_file", "bash"],
      permissions: { tools: { read_file: "allow", bash: "ask" }, other: "deny" },
      implementations: { read_file: "native" },
    });
    const map = toolsetOfSettings({ toolset: { read_file: { mode: "allow", implementation: "native" }, bash: "ask", other: "deny" } });
    expect(map.issues).toEqual([]);
    // The same grant, modes and implementations; the three fields are the LEGACY reading and the map is not.
    expect(legacy.toolset.legacy).toBe(true);
    expect({ ...map.toolset, legacy: true }).toEqual(legacy.toolset);
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
    [["read_file", "bash"]],
    ["$/toolsets/chat/read-only"],
    [{ read_file: "allow", "git status": "allow", script: "ask", other: "deny" }],
    [{ $ref: "$/toolsets/chat/read-only", write_file: { mode: "ask", implementation: "native" } }],
    [{ $expr: ".inputs.tools" }],
    [[]],
  ])("admits %j", (tools) => {
    expect(validate(tools)).toBe(true);
  });

  it.each([[{ read_file: "sometimes" }], [{ read_file: { implementation: "native" } }], [{ read_file: { mode: "ask", implementation: "theirs" } }], [7], [[1]]])(
    "refuses %j",
    (tools) => {
      expect(validate(tools)).toBe(false);
    },
  );

  it("is what the operation and environment blocks hold under `tools`", () => {
    expect((operationSchema().properties as Record<string, unknown>)["tools"]).toEqual(toolsSchema());
  });
});
