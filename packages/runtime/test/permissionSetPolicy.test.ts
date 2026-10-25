/**
 * The consumers of a grant and its modes read ONE map (decision 0007 §1) — and a permission set, and the
 * lowered block a loaded state holds for it, come out of each of them the same.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPermissionDenied, type Approver } from "@declarative-ai/permissions";
import type { LoadedState } from "@declarative-ai/hw";
import { lowerPermissionSet, parsePermissionSet, PERMISSION_SET_MARKERS, permissionSetOfEnvironment, type ChatSettings, type PermissionSet } from "@jaira/shared";
import { chatOperationOf, chatPlanFor, stateWithChatSettings } from "../src/chatOperation";
import { commandDecisionOf, compilePolicy } from "../src/policy";
import { noteCallDialect } from "../src/callDialect";
import { planAgentTools } from "../src/agentTools";
import { gateTools, registerAllTools } from "../src/tools";
import { newRegistry } from "../src/wiring";

const MAP = { read_file: "allow", shell: "ask", write_file: "deny", other: "deny" } as const;

const mapPermissionSet = parsePermissionSet(MAP).permissionSet;
const LOWERED = lowerPermissionSet(mapPermissionSet);
/** The map read back off the block a loaded state holds for it. */
const loweredPermissionSet = permissionSetOfEnvironment(LOWERED.tools, LOWERED.permissions);

describe("compilePolicy", () => {
  it("compiles a permission set and its lowered block, read back, to the same ExecPolicy", () => {
    const fromLowered = compilePolicy({}, { permissionSet: loweredPermissionSet });
    const fromMap = compilePolicy({}, { permissionSet: mapPermissionSet });
    expect(fromMap.baseline).toEqual(fromLowered.baseline);
    expect(Object.keys(fromMap.smart ?? {}).sort()).toEqual(Object.keys(fromLowered.smart ?? {}).sort());
    expect(typeof fromMap.scopeOf).toBe(typeof fromLowered.scopeOf);
  });

  it("folds the call's modes into the baseline, over the command tools' smart", () => {
    const { baseline } = compilePolicy({}, { permissionSet: mapPermissionSet });
    // The shell folds as `ask` whatever its entry says: `shell: "ask"` is the answer for any command
    // nothing else names, on a line that is taken apart — not a mode for the tool (decision 0007 §4).
    expect(baseline?.tools).toMatchObject({ read_file: "allow", shell: "ask", write_file: "deny", run_command: "smart" });
    // Nothing the project says reaches the baseline any more: a tool no permission set names falls to upstream's own default.
    expect(baseline?.tools?.["glob"]).toBeUndefined();
    expect(baseline?.default).toBeUndefined();
  });

  it("with no permission set, gives the command tools smart and nothing else", () => {
    expect(compilePolicy({}).baseline).toEqual(compilePolicy({ builtins: false }, {}).baseline);
    expect(compilePolicy({}).baseline?.tools?.["shell"]).toBe("smart");
    expect(compilePolicy({}).baseline?.default).toBeUndefined();
  });

  it("JUDGES a shell line against the permission set's command subjects — and keeps the floor above them", () => {
    const permissionSet = parsePermissionSet({ shell: "allow", "git push": "allow", "git reset": "allow" }).permissionSet;
    const policy = compilePolicy({}, { permissionSet });
    const smart = (command: string) => policy.smart!["shell"]!({ tool: "shell", input: { command }, sessionId: "s" } as never);
    // Not folded into the baseline: `git push` is not a tool, and nothing there would read it.
    expect(policy.baseline?.tools?.["git push"]).toBeUndefined();
    // An entry that NAMES the command replaces the built-in ask it stood in for…
    expect(smart("git push")).toBe("allow");
    // …and with no such entry the built-in ask still stands.
    expect(compilePolicy({}, { permissionSet: parsePermissionSet({ shell: "allow" }).permissionSet }).smart!["shell"]!({ tool: "shell", input: { command: "git push" }, sessionId: "s" } as never)).toBe("ask");
    // The destructive floor is above every permission set: naming the command does not open it.
    expect(smart("git push --force")).toBe("deny");
    expect(smart("git reset --hard")).toBe("deny");
  });

  it("reads a STATE's command subjects off the lowered block, at the moment of decision", () => {
    // A run compiles one policy for the project; each state's permission set arrives on its own block.
    const policy = compilePolicy({});
    const block = lowerPermissionSet(parsePermissionSet({ shell: "deny", "git status": "allow", read_file: "allow", other: "deny" }).permissionSet).permissions;
    expect(block).toMatchObject({ tools: { shell: "ask" }, subjects: { shell: "deny", "git status": "allow" } });
    const narrowed = (command: string) => {
      const input = { command };
      const mode = policy.scopeOf!({ name: "shell" }, input as never, block as never);
      // What the narrowing found is what the approver and the approval are handed, by the same input.
      return { mode, smart: policy.smart!["shell"]!({ tool: "shell", input, sessionId: "s" } as never), parts: commandDecisionOf(input)?.parts.parts.map((p) => `${p.subject}:${p.verdict}`) };
    };
    // `"shell": "deny", "git status": "allow"` — the decision's own read-only permission set.
    expect(narrowed("git status")).toEqual({ mode: undefined, smart: "allow", parts: ["git status:allowed"] });
    expect(narrowed("git commit -m x")).toMatchObject({ mode: "deny", parts: ["git commit:denied"] });
    expect(narrowed("cd src && cat a.ts")).toMatchObject({ mode: undefined, smart: "allow", parts: ["read_file:allowed"] });
    expect(narrowed("cat a.ts > b.ts")).toMatchObject({ mode: "deny", parts: ["read_file:allowed", "write_file:denied"] });
    // A block with no `subjects` says nothing about parts: only a deny narrows, and the approver decides.
    const silent = { tools: { read_file: "allow" } };
    expect(policy.scopeOf!({ name: "shell" }, { command: "git push" } as never, silent as never)).toBeUndefined();
    expect(policy.scopeOf!({ name: "shell" }, { command: "git reset --hard" } as never, silent as never)).toBe("deny");
    // …and an agent's own shell is the same tool under another name.
    expect(policy.scopeOf!({ name: "Bash" }, { command: "git commit -m x" } as never, block as never)).toBe("deny");
  });

  it("reads a line in the language of the shell that runs it, whatever the project runs", () => {
    // A WSL project: its own `shell` is POSIX.
    const policy = compilePolicy({}, { execEnv: { wsl: "Ubuntu" } });
    const block = lowerPermissionSet(parsePermissionSet({ shell: "deny", "git status": "allow", read_file: "allow", other: "deny" }).permissionSet).permissions;
    const judged = (tool: string, command: string, dialect?: "posix" | "powershell") => {
      const input = { command };
      if (dialect !== undefined) noteCallDialect(input, dialect);
      const mode = policy.scopeOf!({ name: tool }, input as never, block as never);
      const parts = commandDecisionOf(input)?.parts;
      return { mode, dialect: parts?.dialect, parts: parts?.parts.map((p) => `${p.subject}:${p.verdict}`) };
    };
    const line = "Get-Content a.txt; git status";
    // Claude's `PowerShell`: `Get-Content` is `read_file`, and the line runs.
    expect(judged("PowerShell", line)).toEqual({ mode: undefined, dialect: "powershell", parts: ["read_file:allowed", "git status:allowed"] });
    // The project's own shell reads the same words as POSIX: `Get-Content` is a program nobody named.
    expect(judged("shell", line)).toEqual({ mode: "deny", dialect: "posix", parts: ["get-content:denied", "git status:allowed"] });
    // Asked as `shell` with the language noted — what the translated gate does for an agent's own shell.
    expect(judged("shell", line, "powershell")).toMatchObject({ mode: undefined, dialect: "powershell" });
    // Claude's `Bash` is POSIX on a Windows project too: a here-document PowerShell could not read is `cat`, reading.
    expect(compilePolicy({}, { execEnv: "windows" }).scopeOf!({ name: "Bash" }, { command: "cat <<EOF\nnotes\nEOF" } as never, block as never)).toBeUndefined();
    expect(judged("PowerShell", "cat <<EOF\nnotes\nEOF")).toMatchObject({ mode: "ask", dialect: "powershell" });
  });

  it("reads them in a RUN too: upstream hands the narrowing the block whole, `subjects` and `source` included", () => {
    const policy = compilePolicy({});
    const lowered = lowerPermissionSet(parsePermissionSet({ shell: "deny", "git status": "allow", read_file: "allow", other: "deny" }).permissionSet, undefined, "$/permission-sets/x/y");
    const narrowed = (command: string, block: unknown) => {
      const input = { command };
      const mode = policy.scopeOf!({ name: "shell" }, input as never, block as never);
      return { mode, permissionSet: commandDecisionOf(input)?.parts.permissionSet, parts: commandDecisionOf(input)?.parts.parts.map((p) => `${p.subject}:${p.verdict}`) };
    };
    // What `literalPermissions` hands a run since declarative-ai 3f5e5cc: the block, host keys and all.
    expect(narrowed("git status", lowered.permissions)).toEqual({ mode: undefined, permissionSet: "$/permission-sets/x/y", parts: ["git status:allowed"] });
    // The project's policy alone would run both; the permission set refuses them.
    expect(narrowed("rm notes.txt", lowered.permissions)).toMatchObject({ mode: "deny", parts: ["write_file:denied"] });
    expect(narrowed("npm install", lowered.permissions)).toMatchObject({ mode: "deny" });
  });

  it("lets a child's OWN subjects win over its parent's", () => {
    // Upstream merges `permissions` per key down the chain (and `tools` one level deeper), so the
    // child's `subjects` replaces the parent's — and it is what judges the line.
    const policy = compilePolicy({});
    const parent = lowerPermissionSet(parsePermissionSet({ shell: "deny", "git status": "allow" }).permissionSet).permissions!;
    const child = lowerPermissionSet(parsePermissionSet({ shell: "allow", git: "allow" }).permissionSet).permissions!;
    const merged = { ...parent, ...child, tools: { ...parent.tools, ...child.tools } };
    expect(merged.subjects).toEqual({ shell: "allow", git: "allow" });
    const mode = (command: string) => policy.scopeOf!({ name: "shell" }, { command } as never, merged as never);
    // The parent's `shell: "deny"` would refuse it; the child's own map runs it.
    expect(mode("git log")).toBeUndefined();
    expect(mode("git status")).toBeUndefined();
  });
});

describe("planAgentTools", () => {
  it("serves and keeps the same tools from a permission set as from its lowered block — and removes the rest", () => {
    const permissionSet = parsePermissionSet({ read_file: "allow", glob: { mode: "ask", implementation: "native" }, shell: { function: "smart" } }).permissionSet;
    const lowered = lowerPermissionSet(permissionSet);
    const fromMap = planAgentTools(permissionSet);
    expect(planAgentTools(permissionSetOfEnvironment(lowered.tools, lowered.permissions))).toEqual(fromMap);
    expect(fromMap.inject).toEqual(["read_file", "show_artifact", "shell"]);
    expect(fromMap.askNatives).toEqual(["Glob"]);
    expect(fromMap.denyNatives).toEqual(expect.arrayContaining(["Write", "Edit", "WebFetch"]));
  });

  it("hands an agent TOOLS only — a command subject or `script` is not one", () => {
    const plan = planAgentTools(parsePermissionSet({ shell: { function: "smart" }, "git commit": "ask", script: "deny", other: "deny" }).permissionSet);
    expect(plan.inject).toEqual(["show_artifact", "shell"]);
  });

  it("does not offer a tool a block only gives a mode — a key a child inherited beside its own list", () => {
    const plan = planAgentTools(permissionSetOfEnvironment(["read_file"], { tools: { read_file: "allow", write_file: "allow", ...PERMISSION_SET_MARKERS } }));
    expect(plan.inject).not.toContain("write_file");
    expect(plan.denyNatives).toContain("Write");
  });
});

describe("gateTools", () => {
  const asked: string[] = [];
  const approve: Approver = (req) => {
    asked.push(req.tool);
    return { decision: "deny", scope: "once" };
  };
  const gated = (options: { permissionSet?: PermissionSet | (() => PermissionSet | undefined); authored?: ChatSettings["permissions"] }) => {
    const registry = newRegistry();
    registerAllTools(registry, { cwd: "/work", files: { vars: { taskId: "t", worktree: "/work" } } as never });
    return gateTools({ registry, names: ["read_file", "write_file"], sessionId: "s1", approve, ...options });
  };

  it("resolves the same modes from a permission set as from the block it lowers to", async () => {
    const outcomes: unknown[] = [];
    for (const options of [{ permissionSet: mapPermissionSet }, { authored: { ...LOWERED.permissions } }]) {
      asked.length = 0;
      const { gate } = gated(options);
      outcomes.push({
        read: (await gate.check({ name: "read_file" }, { path: "a.ts" })).allow,
        write: (await gate.check({ name: "write_file" }, { path: "a.ts" })).allow,
        // A name nothing here registered answers to `other`.
        unknown: (await gate.check({ name: "SomeMcpTool" }, {})).allow,
        // An `allow` is an allow: there is no profile table left to ask about what the map allowed
        // (decision 0007 §1). A `deny` — an entry's, or `other`'s — never reaches the approver either.
        asked: [...asked],
      });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toEqual({ read: true, write: false, unknown: false, asked: [] });
  });

  it("seeds NO profile: the restriction is the map", () => {
    expect(gated({ permissionSet: mapPermissionSet }).gate.profile).toBe("full");
    expect(gated({ authored: { ...LOWERED.permissions } }).gate.profile).toBe("full");
  });

  /**
   * A permission set given as a FUNCTION is read at each call, by the gate and by every wrapped tool —
   * the person, 2026-10-24: "changing the permissions from auto to full still isnt taking immediate
   * affect. tool calls are still going through auto even after changing to full". The shipped presets,
   * so the case is the one the composer's chip makes.
   */
  it("decides each call under the permission set as it stands — Auto, then Full, then Ask, in one turn", async () => {
    const preset = (name: string) =>
      parsePermissionSet(JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/builtin/permission-sets/chat/${name}.json`, import.meta.url)), "utf8")) as unknown).permissionSet;
    let current = preset("auto");
    const { gate, tools } = gated({ permissionSet: () => current });
    asked.length = 0;
    // Auto: a function line, which the gate puts to the approver (where the function runs first) —
    // through the gate for an agent's own `edit`, through the wrapper for `read_file`, which was handed over.
    expect(gate.modeOf({ name: "edit" })).toBe("ask");
    expect((await gate.check({ name: "edit" }, { path: "a.ts" })).allow).toBe(false);
    expect(isPermissionDenied((await tools["read_file"]!.run({ path: "a.ts" }, {})) as never)).toBe(true);
    expect(asked).toEqual(["edit", "read_file"]);

    current = preset("full");
    expect(gate.modeOf({ name: "edit" })).toBe("allow");
    expect((await gate.check({ name: "edit" }, { path: "a.ts" })).allow).toBe(true);
    expect(isPermissionDenied((await tools["read_file"]!.run({ path: "a.ts" }, {})) as never)).toBe(false);
    // An agent's own built-in answers to the map's `other`, which Full allows too.
    expect((await gate.check({ name: "SomeMcpTool" }, {})).allow).toBe(true);
    expect(asked).toEqual(["edit", "read_file"]);

    current = preset("ask-first");
    expect((await gate.check({ name: "edit" }, { path: "a.ts" })).allow).toBe(false);
    expect(asked).toEqual(["edit", "read_file", "edit"]);
  });

  it("a function answering nothing is a turn that declared no permission set", async () => {
    const { gate } = gated({ permissionSet: () => undefined });
    const plain = gated({}).gate;
    asked.length = 0;
    expect((await gate.check({ name: "read_file" }, { path: "a.ts" })).allow).toBe((await plain.check({ name: "read_file" }, { path: "a.ts" })).allow);
    expect(gate.modeOf({ name: "SomeMcpTool" })).toBe(plain.modeOf({ name: "SomeMcpTool" }));
  });
});

describe("a conversation turn", () => {
  const host = (environment: LoadedState["environment"]): LoadedState =>
    ({ id: "plan", operation: { kind: "prompt", user: "go", config: {}, input: {}, output: { name: "text", kind: "text" } }, environment }) as unknown as LoadedState;

  it("runs the same operation from a permission set as from the lowered block a state's declaration arrives as", () => {
    const decl = { read_file: "allow", glob: { mode: "ask", implementation: "native" } } as const;
    const lowered = lowerPermissionSet(parsePermissionSet(decl).permissionSet);
    const inherited: ChatSettings = { tools: lowered.tools, ...(lowered.permissions !== undefined ? { permissions: lowered.permissions } : {}) };
    const map: ChatSettings = { permissionSet: decl };
    const args = { message: "hi", session: { id: "s@1" } };
    const fromInherited = chatOperationOf(chatPlanFor([], inherited), args);
    const fromMap = chatOperationOf(chatPlanFor([], map), args);
    expect(fromMap.operation).toEqual(fromInherited.operation);
    expect(fromMap.environment.tools).toEqual(fromInherited.environment.tools);
    expect(fromMap.environment.permissions).toMatchObject({ tools: { read_file: "allow", glob: "ask" } });
  });

  it("inherits an implementation a state's permission set chose, through the lowered block", () => {
    const plan = chatPlanFor([host({ tools: ["read_file"], permissions: { tools: { read_file: "allow" }, implementations: { read_file: "native" } } as never })]);
    expect(plan.settings.implementations).toEqual({ read_file: "native" });
    expect(plan.origin.implementations).toBe("inherited");
    expect(chatOperationOf(plan, { message: "hi", session: { id: "s@1" } }).environment.tools).toEqual(["show_artifact"]);
  });

  it("shows the composer the shell's AUTHORED mode, not the `ask` it was lowered as", () => {
    const lowered = lowerPermissionSet(parsePermissionSet({ shell: "deny", "git status": "allow" }).permissionSet);
    const plan = chatPlanFor([host({ tools: lowered.tools, permissions: lowered.permissions as never })]);
    expect(plan.settings.permissions).toMatchObject({ tools: { shell: "deny" }, subjects: { shell: "deny", "git status": "allow" } });
    // …and sending it lowers it again, to the same block the state held.
    expect(chatOperationOf(plan, { message: "hi", session: { id: "s@1" } }).environment.permissions).toEqual(lowered.permissions);
  });

  it("writes a permission set into a state as what it lowers to", () => {
    const written = stateWithChatSettings(host({}), { permissionSet: { read_file: "allow", "git status": "allow", other: "deny" } });
    expect(written?.environment).toEqual({
      tools: ["read_file"],
      permissions: { tools: { read_file: "allow", ...PERMISSION_SET_MARKERS }, implementations: {}, other: "deny", subjects: { "git status": "allow" }, functions: {} },
    });
  });
});
