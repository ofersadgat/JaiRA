/**
 * The consumers of a grant and its modes read ONE map (decision 0007 §1) — and a state in the old
 * form and the same state in the new form come out of each of them the same.
 */
import { describe, expect, it } from "vitest";
import type { Approver } from "@declarative-ai/permissions";
import type { LoadedState } from "@declarative-ai/hw";
import { parseToolset, TOOLSET_MARKERS, toolsetOfLegacy, type ChatSettings } from "@jaira/shared";
import { chatOperationOf, chatPlanFor, stateWithChatSettings } from "../src/chatOperation";
import { compilePolicy } from "../src/policy";
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
    expect(baseline?.tools).toMatchObject({ glob: "allow", read_file: "allow", bash: "ask", write_file: "deny", run_command: "smart" });
  });

  it("is what it always was with no toolset", () => {
    expect(compilePolicy({ tools: { glob: "allow" } }).baseline).toEqual(compilePolicy({ tools: { glob: "allow" } }, {}).baseline);
    expect(compilePolicy({}).baseline?.tools?.["bash"]).toBe("smart");
  });

  it("CARRIES a command subject without enforcing it — a shell line still answers to the command policy", () => {
    const toolset = parseToolset({ bash: "smart", "git push": "allow" }).toolset;
    const policy = compilePolicy({}, { toolset });
    // Not folded into the baseline: `git push` is not a tool, and nothing there would read it.
    expect(policy.baseline?.tools?.["git push"]).toBeUndefined();
    // …and the built-in ask for a push still stands, whatever the toolset says (decision 0007 §4 is later).
    expect(policy.smart!["bash"]!({ tool: "bash", input: { command: "git push" }, sessionId: "s" } as never)).toBe("ask");
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

  it("writes a toolset into a state as what it lowers to", () => {
    const written = stateWithChatSettings(host({}), { toolset: { read_file: "allow", "git status": "allow", other: "deny" } });
    expect(written?.environment).toEqual({
      tools: ["read_file"],
      permissions: { tools: { read_file: "allow", ...TOOLSET_MARKERS }, other: "deny", subjects: { "git status": "allow" } },
    });
  });
});
