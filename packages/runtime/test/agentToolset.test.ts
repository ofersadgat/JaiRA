/**
 * An agent gets its toolset and nothing else (decision 0007 §3) — through the REAL wiring.
 *
 * The chain under test is the one `agentPolicy.test.ts` pins, one step further: `executeWorkflow` →
 * the engine (which resolves a state's tools and builds its gate) → `withAgentToolset` (JaiRA's
 * wrapper, holding the route's executor to the toolset by that executor's own declaration) → the
 * upstream agent executor → the query options a real `claude` or `codex` would be spawned with. A
 * fake QUERY stands in for the binary alone.
 *
 * What is being defended, in the order the decision states it:
 *
 *  - NOT in the toolset → the native is removed;
 *  - IN it → ours is injected and displaces the native, or the native is kept and forced through the
 *    permission callback so the entry's mode still decides;
 *  - a native with no standard tool answers to `other`;
 *  - an old `profile: "read-only"` and the map it reads as reach the agent as the same configuration.
 */
import { describe, expect, it } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import type { AgentQuery, AgentQueryOptions } from "@declarative-ai/agents-api";
import type { ExecServices, InlineFamily, PromptOp, Tool } from "@declarative-ai/exec";
import type { Approver } from "@declarative-ai/permissions";
import { lowerStateToolsets, parseToolset } from "@jaira/shared";
import { planAgentTools, withToolsetService } from "../src/agentTools";
import { agentPromptRoutes } from "../src/modelRoutes";
import { gateTools } from "../src/tools";
import { buildPromptExecutor, executeWorkflow, newRegistry } from "../src/wiring";

/** What upstream's own `read-only` profile removed from claude — the list this task must not lose. */
const PROFILE_DENIED = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Task", "Agent", "SlashCommand"];

function capturingQuery(): { seen: AgentQueryOptions[]; query: AgentQuery } {
  const seen: AgentQueryOptions[] = [];
  const query: AgentQuery = async function* (opts) {
    seen.push(opts);
    yield { type: "result", result: { text: "Done.", structured: { report: "all quiet" } } };
  };
  return { seen, query };
}

const tool = (readOnly: boolean): Tool => ({ description: "a tool", inputSchema: { type: "object" }, readOnly, run: async () => "ok" });

function registry() {
  const out = newRegistry();
  for (const name of ["read_file", "glob", "grep", "web_fetch"]) out.tools.set(name, tool(true));
  for (const name of ["edit", "write_file", "bash"]) out.tools.set(name, tool(false));
  return out;
}

/** One prompt state under `environment`, lowered as the loader lowers it, run on one agent route. */
async function run(
  environment: Record<string, unknown>,
  options: { agent?: string; approve?: Approver; agents?: Parameters<typeof agentPromptRoutes>[0] } = {},
): Promise<{ opts: AgentQueryOptions | undefined; asked: string[]; result: Awaited<ReturnType<typeof executeWorkflow>> }> {
  const agent = options.agent ?? "claude-cli";
  const { seen, query } = capturingQuery();
  const asked: string[] = [];
  const def = {
    label: "Read and report",
    outputs: { report: { kind: "text", schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: "Summarize.", model: `${agent}/default` },
    environment,
  };
  const lowered = lowerStateToolsets("digest", def, () => {
    throw new Error("no reference expected");
  });
  expect(lowered.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  const result = await executeWorkflow({
    bundle: loadBundle({ digest: lowered.def }, "digest"),
    inputs: {},
    registry: registry(),
    prompt: buildPromptExecutor({ routes: agentPromptRoutes(options.agents ?? {}, { query }), tree: { kind: "agent", agent } }),
    approve:
      options.approve ??
      ((req) => {
        asked.push(req.tool);
        return { decision: "deny", scope: "once" };
      }),
  });
  return { opts: seen[0], asked, result };
}

const ask = (opts: AgentQueryOptions, toolName: string, input: Record<string, unknown> = {}) =>
  opts.canUseTool!({ toolName, input: input as never }, { signal: new AbortController().signal });

/** The legacy form 19 authored states still use, and the map it reads as. */
const LEGACY_READ_ONLY = { tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } };
const READ_ONLY_MAP = { tools: { read_file: "allow", edit: "deny", write_file: "deny", bash: "deny", other: "deny" } };

describe("a read-only toolset reaches claude as `profile: \"read-only\"` did", () => {
  it("removes everything the profile removed, and produces the SAME configuration from either form", async () => {
    const legacy = (await run(LEGACY_READ_ONLY)).opts!;
    const map = (await run(READ_ONLY_MAP)).opts!;

    // Nothing the profile denied up front has come back.
    expect(legacy.disallowedTools).toEqual(expect.arrayContaining(PROFILE_DENIED));
    expect(map.disallowedTools).toEqual(expect.arrayContaining(PROFILE_DENIED));
    // The two forms are one configuration: the deny list, the pre-approvals, what is served, the mode.
    expect([...(map.disallowedTools ?? [])].sort()).toEqual([...(legacy.disallowedTools ?? [])].sort());
    expect(map.allowedTools).toEqual(legacy.allowedTools);
    expect(Object.keys(map.mcpTools ?? {})).toEqual(Object.keys(legacy.mcpTools ?? {}));
    expect(map.permissionMode).toBe(legacy.permissionMode);
    expect(map.providerOptions).toEqual(legacy.providerOptions);

    // The grant, unchanged: the one held tool is served over the bridge and pre-approved by its `allow`.
    expect(Object.keys(map.mcpTools ?? {})).toEqual(["read_file"]);
    expect(map.allowedTools).toEqual(["read_file"]);
    // `read-only` was never a claude permission mode, and still is not one.
    expect(map.permissionMode).toBeUndefined();
  });

  it("removes MORE than the profile did: the built-in of every standard tool the toolset does not hold", async () => {
    // The profile was a fence against writers and said nothing about `Glob`, `Grep` or the web
    // readers, which ran ungoverned beside a list that never granted them. A toolset is the whole
    // grant: `Read` is displaced by ours, and what is not held is not there.
    const { opts } = await run(READ_ONLY_MAP);
    expect(opts!.disallowedTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]));
  });

  it("hands the engine no profile from a map — the restriction IS the map", async () => {
    const lowered = lowerStateToolsets(
      "s",
      { environment: { tools: { read_file: "allow" }, permissions: { profile: "read-only" } } },
      () => {
        throw new Error("unused");
      },
    );
    const environment = (lowered.def as { environment: { tools: string[]; permissions: Record<string, unknown> } }).environment;
    expect(environment.permissions).not.toHaveProperty("profile");
    expect(environment.permissions).toMatchObject({ tools: { edit: "deny", write_file: "deny", bash: "deny" }, other: "deny" });
    // …and says so where the author can see it.
    expect(lowered.issues.map((issue) => issue.message).join("\n")).toMatch(/permissions\.profile beside a toolset map/);
  });
});

describe("a read-only toolset reaches codex as the same sandbox flag", () => {
  it("is `--sandbox read-only` from the old profile and from the map — codex's `plan` is nothing else", async () => {
    // No tools held: codex cannot be served ours, and refuses a run that injects any.
    const legacy = (await run({ permissions: { profile: "read-only" } }, { agent: "codex-cli" })).opts!;
    const map = (await run({ tools: { edit: "deny", write_file: "deny", bash: "deny", other: "deny" } }, { agent: "codex-cli" })).opts!;
    expect(legacy.permissionMode).toBe("plan");
    expect(map.permissionMode).toBe("plan");
    // Codex has no deny list and refuses one by name, so the toolset writes NOTHING into it: what is
    // there is the engine's own (`AskUserQuestion`, withheld from any state that declares outputs),
    // and it is the same from either form.
    expect(map.disallowedTools).toEqual(legacy.disallowedTools);
    for (const native of ["shell", "apply_patch", "Bash", "Edit", "Write", "Task"]) expect(map.disallowedTools ?? []).not.toContain(native);
  });

  it("is derived from the TOOLSET: the writing sandbox is on only for a subject it unlocks", async () => {
    // A state that declared nothing keeps what codex has — the configured sandbox.
    expect((await run({}, { agent: "codex-cli" })).opts!.permissionMode).toBeUndefined();
    // Holding `bash` (with a fake query nothing refuses the injection) turns the switch on…
    expect((await run({ tools: { read_file: "allow", bash: "ask" } }, { agent: "codex-cli" })).opts!.permissionMode).toBeUndefined();
    // …and a toolset that holds only readers leaves it off, with no profile anywhere.
    expect((await run({ tools: { read_file: "allow", glob: "allow" } }, { agent: "codex-cli" })).opts!.permissionMode).toBe("plan");
    expect((await run({ tools: ["read_file"] }, { agent: "codex-cli" })).opts!.permissionMode).toBe("plan");
  });
});

describe("the postmortem case: tools with no restriction (task t-19fipjbavj)", () => {
  it("does NOT leave the CLI agent its own Edit — a tool list is the whole grant now", async () => {
    // The feature workflow declared `tools: ["read_file"]` and never a profile. The list was a grant,
    // not a fence: claude kept its built-ins, used its native `Edit` 127 times and rewrote docs on
    // disk. No profile exists any more, and none is needed: `edit` is not in the toolset.
    const { opts, asked } = await run({ tools: ["read_file"] });
    expect(opts!.disallowedTools).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "NotebookEdit", "Write", "Bash"]));
    // And if the binary asked anyway, the answer is no — without a person being asked to say it.
    expect(await ask(opts!, "Edit", { file_path: "docs/product/x.md" })).toMatchObject({ allow: false });
    expect(asked).toEqual([]);
    // What the state DID hold is served, and nothing else is.
    expect(Object.keys(opts!.mcpTools ?? {})).toEqual(["read_file"]);
  });

  it("leaves a state that declared NO tools what the agent has — under the gate, by standard name", async () => {
    // Not a toolset that holds nothing: a state that said nothing. Every workflow written before tools
    // were a fence is this, and removing everything from it would not be a migration.
    const { opts, asked } = await run({ permissions: { tools: { read_file: "allow", edit: "deny" } } });
    expect(opts!.disallowedTools ?? []).not.toContain("Read");
    expect(opts!.disallowedTools ?? []).not.toContain("Bash");
    // An explicit `deny` still removes — every native that is that standard tool.
    expect(opts!.disallowedTools).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "NotebookEdit"]));
    // The callback names `Read`; the mode was written against `read_file`, and is what answers.
    expect(await ask(opts!, "Read", { file_path: "a.ts" })).toMatchObject({ allow: true });
    // `Bash` has no mode of its own, so a person is asked — about `bash`, the name a policy is written in.
    expect(await ask(opts!, "Bash", { command: "ls" })).toMatchObject({ allow: false });
    expect(asked).toEqual(["bash"]);
  });
});

describe("a native with no standard tool", () => {
  it("answers to `other` at call time, and is not removed up front unless `other` refuses it", async () => {
    const open = await run({ tools: { read_file: "allow", other: "allow" } });
    expect(open.opts!.disallowedTools ?? []).not.toContain("Task");
    expect(await ask(open.opts!, "Task", {})).toMatchObject({ allow: true });
    // A name no executor declared at all lands in the same place.
    expect(await ask(open.opts!, "TodoWrite", {})).toMatchObject({ allow: true });
    expect(open.asked).toEqual([]);

    const asking = await run({ tools: { read_file: "allow", other: "ask" } });
    expect(asking.opts!.disallowedTools ?? []).not.toContain("Task");
    expect(await ask(asking.opts!, "Task", {})).toMatchObject({ allow: false });
    expect(asking.asked).toEqual(["Task"]);

    const shut = await run({ tools: { read_file: "allow", other: "deny" } });
    expect(shut.opts!.disallowedTools).toEqual(expect.arrayContaining(["Task", "Agent", "SlashCommand"]));
    expect(await ask(shut.opts!, "TodoWrite", {})).toMatchObject({ allow: false });
    expect(shut.asked).toEqual([]);
  });
});

describe("nothing is granted outside the toolset", () => {
  it("serves exactly the held tools, pre-approves only an `allow`, and removes every other built-in", async () => {
    const { opts } = await run({ tools: { read_file: "allow", grep: "ask", bash: "deny", other: "deny" } });
    // `bash` is held and refused: never offered, and its built-in is gone with it.
    expect(Object.keys(opts!.mcpTools ?? {}).sort()).toEqual(["grep", "read_file"]);
    expect(opts!.allowedTools).toEqual(["read_file"]);
    const declared = ["Read", "Glob", "Grep", "Edit", "MultiEdit", "NotebookEdit", "Write", "Bash", "WebFetch", "WebSearch", "Task", "Agent", "SlashCommand"];
    expect([...(opts!.disallowedTools ?? [])].filter((name) => declared.includes(name)).sort()).toEqual([...declared].sort());
  });
});

describe("a transport that enforces nothing", () => {
  const agents = { genericCli: [{ name: "aider", command: "aider" }] };

  it("still refuses a toolset that refuses anything — by name, with no profile to go by", async () => {
    const { opts, result } = await run(READ_ONLY_MAP, { agent: "aider", agents });
    expect(opts).toBeUndefined();
    // Read back off the gate, where an unheld tool answers to `other` — so everything refused is named.
    expect(JSON.stringify(result)).toMatch(/aider: this state's toolset refuses .*'edit', 'write_file'.*'bash'.*'other', and this transport enforces nothing/);
  });

  it("runs a state that restricts nothing", async () => {
    const { opts } = await run({}, { agent: "aider", agents });
    expect(opts).toBeDefined();
  });
});

describe("the implementation choice — a conversation turn, which knows its toolset", () => {
  it("keeps a `native` built-in, forces it to the callback, and lets the ENTRY's mode decide", async () => {
    const { toolset } = parseToolset({ read_file: "allow", grep: { mode: "ask", implementation: "native" }, other: "deny" });
    const plan = planAgentTools(toolset);
    const { seen, query } = capturingQuery();
    const asked: string[] = [];
    const approve: Approver = (req) => {
      asked.push(req.tool);
      return { decision: "allow", scope: "once" };
    };
    // What `runChatMessage` builds: ours wrapped and gated, and the toolset published for the executor.
    const { tools, gate } = gateTools({ registry: registry(), names: plan.inject.filter((name) => name !== "show_artifact"), sessionId: "s1", approve, toolset });
    const services = withToolsetService({ tools, gate, approve } as ExecServices, toolset);
    const operation: PromptOp<InlineFamily> = {
      kind: "prompt",
      user: "find it",
      config: { model: "claude-cli/default" },
      input: {},
      output: { name: "text", kind: "text" },
    };
    await agentPromptRoutes({}, { query })["claude-cli"]!.start(operation, services).result;

    const opts = seen[0]!;
    // Ours is injected for `read_file` and displaces `Read`; `Grep` is KEPT…
    expect(Object.keys(opts.mcpTools ?? {})).toEqual(["read_file"]);
    expect(opts.disallowedTools).toContain("Read");
    expect(opts.disallowedTools).not.toContain("Grep");
    // …and cannot run without consulting us: the ask rule is in the agent's own settings.
    expect(opts.providerOptions).toMatchObject({ settings: { permissions: { ask: ["Grep"] } } });
    // The callback names `Grep`; the entry is `grep: ask`, so a person is asked — about `grep`.
    expect(await ask(opts, "Grep", { pattern: "x" })).toMatchObject({ allow: true });
    expect(asked).toEqual(["grep"]);
    // A tool the toolset does not hold was removed, and would be refused unasked if it turned up.
    expect(opts.disallowedTools).toEqual(expect.arrayContaining(["Glob", "Edit", "Bash", "Task"]));
    expect(await ask(opts, "Bash", { command: "rm -rf ." })).toMatchObject({ allow: false });
    expect(asked).toEqual(["grep"]);
  });
});
