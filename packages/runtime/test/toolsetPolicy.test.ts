/**
 * The consumers of a grant and its modes read ONE map (decision 0007 §1) — and a state in the old
 * form and the same state in the new form come out of each of them the same.
 */
import { describe, expect, it } from "vitest";
import type { Approver } from "@declarative-ai/permissions";
import type { LoadedState } from "@declarative-ai/hw";
import { lowerToolset, parseToolset, TOOLSET_MARKERS, toolsetOfLegacy, type ChatSettings } from "@jaira/shared";
import { chatOperationOf, chatPlanFor, stateWithChatSettings } from "../src/chatOperation";
import { commandDecisionOf, compilePolicy } from "../src/policy";
import { planAgentTools } from "../src/agentTools";
import { gateTools, registerAllTools } from "../src/tools";
import { newRegistry } from "../src/wiring";

const LEGACY = {
  tools: ["read_file", "bash", "write_file"],
  permissions: { tools: { read_file: "allow", bash: "ask", write_file: "deny" }, other: "deny" },
} as const;
const MAP = { read_file: "allow", bash: "ask", write_file: "deny", other: "deny" } as const;

const legacyToolset = toolsetOfLegacy(LEGACY.tools, LEGACY.permissions);
const mapToolset = parseToolset(MAP).toolset;

describe("compilePolicy", () => {
  it("compiles the same state in old and new form to the same ExecPolicy", () => {
    const policy = { tools: { glob: "allow" as const }, toolDefault: "ask" as const };
    const fromLegacy = compilePolicy(policy, { toolset: legacyToolset });
    const fromMap = compilePolicy(policy, { toolset: mapToolset });
    expect(fromMap.baseline).toEqual(fromLegacy.baseline);
    expect(Object.keys(fromMap.smart ?? {}).sort()).toEqual(Object.keys(fromLegacy.smart ?? {}).sort());
    expect(typeof fromMap.scopeOf).toBe(typeof fromLegacy.scopeOf);
  });

  it("folds the call's modes OVER the project's, and leaves the project's alone where it says nothing", () => {
    const { baseline } = compilePolicy({ tools: { glob: "allow", read_file: "deny" } }, { toolset: mapToolset });
    // The shell folds as `smart` whatever its entry says: `bash: "ask"` is the answer for any command
    // nothing else names, on a line that is taken apart — not a mode for the tool (decision 0007 §4).
    expect(baseline?.tools).toMatchObject({ glob: "allow", read_file: "allow", bash: "smart", write_file: "deny", run_command: "smart" });
  });

  it("is what it always was with no toolset", () => {
    expect(compilePolicy({ tools: { glob: "allow" } }).baseline).toEqual(compilePolicy({ tools: { glob: "allow" } }, {}).baseline);
    expect(compilePolicy({}).baseline?.tools?.["bash"]).toBe("smart");
  });

  it("JUDGES a shell line against the toolset's command subjects — and keeps the floor above them", () => {
    const toolset = parseToolset({ bash: "smart", "git push": "allow", "git reset": "allow" }).toolset;
    const policy = compilePolicy({}, { toolset });
    const smart = (command: string) => policy.smart!["bash"]!({ tool: "bash", input: { command }, sessionId: "s" } as never);
    // Not folded into the baseline: `git push` is not a tool, and nothing there would read it.
    expect(policy.baseline?.tools?.["git push"]).toBeUndefined();
    // An entry that NAMES the command replaces the built-in ask it stood in for…
    expect(smart("git push")).toBe("allow");
    // …and with no such entry the built-in ask still stands.
    expect(compilePolicy({}, { toolset: parseToolset({ bash: "smart" }).toolset }).smart!["bash"]!({ tool: "bash", input: { command: "git push" }, sessionId: "s" } as never)).toBe("ask");
    // The destructive floor is above every toolset: naming the command does not open it.
    expect(smart("git push --force")).toBe("deny");
    expect(smart("git reset --hard")).toBe("deny");
  });

  it("reads a STATE's command subjects off the lowered block, at the moment of decision", () => {
    // A run compiles one policy for the project; each state's toolset arrives on its own block.
    const policy = compilePolicy({});
    const block = lowerToolset(parseToolset({ bash: "deny", "git status": "allow", read_file: "allow", other: "deny" }).toolset).permissions;
    expect(block).toMatchObject({ tools: { bash: "smart" }, subjects: { bash: "deny", "git status": "allow" } });
    const narrowed = (command: string) => {
      const input = { command };
      const mode = policy.scopeOf!({ name: "bash" }, input as never, block as never);
      // What the narrowing found is what the approver and the approval are handed, by the same input.
      return { mode, smart: policy.smart!["bash"]!({ tool: "bash", input, sessionId: "s" } as never), parts: commandDecisionOf(input)?.parts.parts.map((p) => `${p.subject}:${p.verdict}`) };
    };
    // `"bash": "deny", "git status": "allow"` — the decision's own read-only toolset.
    expect(narrowed("git status")).toEqual({ mode: undefined, smart: "allow", parts: ["git status:allowed"] });
    expect(narrowed("git commit -m x")).toMatchObject({ mode: "deny", parts: ["git commit:denied"] });
    expect(narrowed("cd src && cat a.ts")).toMatchObject({ mode: undefined, smart: "allow", parts: ["read_file:allowed"] });
    expect(narrowed("cat a.ts > b.ts")).toMatchObject({ mode: "deny", parts: ["read_file:allowed", "write_file:denied"] });
    // An unmigrated block says nothing about parts: only a deny narrows, and the approver decides as it did.
    const legacy = { tools: { bash: "allow" } };
    expect(policy.scopeOf!({ name: "bash" }, { command: "git push" } as never, legacy as never)).toBeUndefined();
    expect(policy.scopeOf!({ name: "bash" }, { command: "git reset --hard" } as never, legacy as never)).toBe("deny");
    // …and an agent's own shell is the same tool under another name.
    expect(policy.scopeOf!({ name: "Bash" }, { command: "git commit -m x" } as never, block as never)).toBe("deny");
  });

  it("reads them in a RUN too, where upstream hands the narrowing the block without `subjects` or `source`", () => {
    const policy = compilePolicy({});
    const lowered = lowerToolset(parseToolset({ bash: "deny", "git status": "allow", read_file: "allow", other: "deny" }).toolset, undefined, "$/toolsets/x/y");
    // What `literalPermissions` keeps: `tools`, `default`, `other`, `profile`, `scopes`.
    const { subjects: _subjects, source: _source, ...literal } = lowered.permissions!;
    const narrowed = (command: string) => {
      const input = { command };
      const mode = policy.scopeOf!({ name: "bash" }, input as never, literal as never);
      return { mode, toolset: commandDecisionOf(input)?.parts.toolset, parts: commandDecisionOf(input)?.parts.parts.map((p) => `${p.subject}:${p.verdict}`) };
    };
    expect(narrowed("git status")).toEqual({ mode: undefined, toolset: "$/toolsets/x/y", parts: ["git status:allowed"] });
    // The project's policy alone would run both; the toolset refuses them.
    expect(narrowed("rm notes.txt")).toMatchObject({ mode: "deny", parts: ["write_file:denied"] });
    expect(narrowed("npm install")).toMatchObject({ mode: "deny" });
  });

  it("answers to the STRICTEST of the subjects a child inherited beside its own", () => {
    // Upstream merges `permissions.tools` per key, so a child can hold its parent's carried key too.
    const policy = compilePolicy({});
    const parent = lowerToolset(parseToolset({ bash: "allow", git: "allow" }).toolset).permissions!.tools!;
    const child = lowerToolset(parseToolset({ bash: "deny", "git status": "allow" }).toolset).permissions!.tools!;
    const merged = { tools: { ...parent, ...child } };
    const mode = (command: string) => policy.scopeOf!({ name: "bash" }, { command } as never, merged as never);
    expect(mode("git status")).toBeUndefined();
    // The parent's `git` would run it; the child's own map falls to its `bash: "deny"`.
    expect(mode("git log")).toBe("deny");
  });
});

describe("planAgentTools", () => {
  it("serves and keeps the same tools from a toolset as from the list it was folded from — and only the MAP removes the rest", () => {
    const fromLegacy = planAgentTools(["read_file", "glob", "bash"], { glob: "native" });
    const fromMap = planAgentTools(parseToolset({ read_file: "allow", glob: { mode: "ask", implementation: "native" }, bash: "smart" }).toolset);
    expect({ ...fromMap, denyNatives: [] }).toEqual(fromLegacy);
    // The legacy reading leaves the agent what the list did not mention, exactly as it always did.
    expect(fromLegacy.denyNatives).toEqual([]);
    expect(fromMap.inject).toEqual(["read_file", "glob", "show_artifact", "bash"].filter((n) => n !== "glob"));
    expect(fromMap.askNatives).toEqual(["Glob"]);
    expect(fromMap.denyNatives).toEqual(expect.arrayContaining(["Write", "Edit", "WebFetch"]));
  });

  it("hands an agent TOOLS only — a command subject or `script` is not one", () => {
    const plan = planAgentTools(parseToolset({ bash: "smart", "git commit": "ask", script: "deny", other: "deny" }).toolset);
    expect(plan.inject).toEqual(["show_artifact", "bash"]);
  });

  it("does not offer a tool the legacy block only gave a mode", () => {
    const plan = planAgentTools(toolsetOfLegacy(["read_file"], { tools: { write_file: "deny" } }));
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
  const gated = (options: { toolset?: typeof mapToolset; authored?: ChatSettings["permissions"] }) => {
    const registry = newRegistry();
    registerAllTools(registry, { cwd: "/work", files: { vars: { taskId: "t", worktree: "/work" } } as never });
    return gateTools({ registry, names: ["read_file", "write_file"], sessionId: "s1", approve, ...options });
  };

  it("resolves the same modes from a toolset as from the block it replaces", async () => {
    const outcomes: unknown[] = [];
    for (const options of [{ toolset: mapToolset }, { authored: { ...LEGACY.permissions } }]) {
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

  it("still honours the legacy `default`, as a listed tool's mode and as `other`", async () => {
    const { gate } = gated({ authored: { default: "deny" } });
    expect(await gate.check({ name: "read_file" }, { path: "a.ts" })).toMatchObject({ allow: false });
    expect(await gate.check({ name: "SomeMcpTool" }, {})).toMatchObject({ allow: false });
  });

  it("seeds NO profile: an old `read-only` is the denies it meant, decided by the map", async () => {
    asked.length = 0;
    const { gate, tools } = gated({ authored: { profile: "read-only", tools: { read_file: "allow", write_file: "allow" } } });
    expect(gate.profile).toBe("full");
    expect(gated({ toolset: mapToolset }).gate.profile).toBe("full");
    // The writer the block ALLOWED is refused, as the profile refused it — by the gate a delegated
    // agent asks, and by the wrapped tool a composed runtime runs.
    expect(await gate.check({ name: "write_file" }, { path: "a.ts" })).toMatchObject({ allow: false });
    expect(await tools["write_file"]!.run({ path: "a.ts", content: "x" }, {})).toMatchObject({ denied: true });
    expect((await gate.check({ name: "read_file" }, { path: "a.ts" })).allow).toBe(true);
    // And a name nothing registered answers to the `other` the profile reads as.
    expect(await gate.check({ name: "Task" }, {})).toMatchObject({ allow: false });
    expect(asked).toEqual([]);
  });
});

describe("a conversation turn", () => {
  const host = (environment: LoadedState["environment"]): LoadedState =>
    ({ id: "plan", operation: { kind: "prompt", user: "go", config: {}, input: {}, output: { name: "text", kind: "text" } }, environment }) as unknown as LoadedState;

  it("runs the same operation from a toolset as from the three fields it replaces", () => {
    const legacy: ChatSettings = { tools: ["read_file", "glob"], permissions: { tools: { read_file: "allow", glob: "ask" } }, implementations: { glob: "native" } };
    const map: ChatSettings = { toolset: { read_file: "allow", glob: { mode: "ask", implementation: "native" } } };
    const args = { message: "hi", session: { id: "s@1" } };
    const fromLegacy = chatOperationOf(chatPlanFor([], legacy), args);
    const fromMap = chatOperationOf(chatPlanFor([], map), args);
    expect(fromMap.operation).toEqual(fromLegacy.operation);
    expect(fromMap.environment.tools).toEqual(fromLegacy.environment.tools);
    expect(fromMap.environment.permissions).toMatchObject({ tools: { read_file: "allow", glob: "ask" } });
  });

  it("inherits an implementation a state's toolset chose, through the lowered block", () => {
    const plan = chatPlanFor([host({ tools: ["read_file"], permissions: { tools: { read_file: "allow" }, implementations: { read_file: "native" } } as never })]);
    expect(plan.settings.implementations).toEqual({ read_file: "native" });
    expect(plan.origin.implementations).toBe("inherited");
    expect(chatOperationOf(plan, { message: "hi", session: { id: "s@1" } }).environment.tools).toEqual(["show_artifact"]);
  });

  it("shows the composer the shell's AUTHORED mode, not the `smart` it was lowered as", () => {
    const lowered = lowerToolset(parseToolset({ bash: "deny", "git status": "allow" }).toolset);
    const plan = chatPlanFor([host({ tools: lowered.tools, permissions: lowered.permissions as never })]);
    expect(plan.settings.permissions).toMatchObject({ tools: { bash: "deny" }, subjects: { bash: "deny", "git status": "allow" } });
    // …and sending it lowers it again, to the same block the state held.
    expect(chatOperationOf(plan, { message: "hi", session: { id: "s@1" } }).environment.permissions).toEqual(lowered.permissions);
  });

  it("writes a toolset into a state as what it lowers to", () => {
    const written = stateWithChatSettings(host({}), { toolset: { read_file: "allow", "git status": "allow", other: "deny" } });
    expect(written?.environment).toEqual({
      tools: ["read_file"],
      permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS }, other: "deny", subjects: { "git status": "allow" } },
    });
  });
});
