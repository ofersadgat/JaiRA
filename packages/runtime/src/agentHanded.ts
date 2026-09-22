/**
 * What a delegated claude or codex agent is ACTUALLY handed under one effective `environment` —
 * measured, not modelled (decision 0007).
 *
 * What a toolset does to an agent is the product of the engine, JaiRA's wrapper and the upstream
 * executor, and a test that restated any of their rules would stay green while the chain drifted.
 * So a lowered block is run through the chain a real run goes through, and what comes out is read:
 *
 *   a one-state workflow → the ENGINE (which resolves the tools and builds the gate) →
 *   `withAgentToolset` (JaiRA's wrapper, by claude's own declaration) → the upstream agent executor
 *   → the options a real `claude` would be spawned with.
 *
 * A fake QUERY stands in for the binary alone — the rig `agentToolset.test.ts` pins. What is read off
 * the spawn: the tools of ours that are served, the built-ins on the deny list, the pre-approvals,
 * and — by asking the spawn's own permission callback — what decides a call by every name the agent
 * could still address. Nothing here restates a rule of the gate, the plan or the executor, so the
 * answer stays true when any of them changes. Reach is judged, not mechanism: a way in that is
 * refused is not a way in, and a shell every line of which is refused is not a shell.
 */
import { mcpToolName, type AgentQuery, type AgentQueryOptions } from "@declarative-ai/agents-api";
import type { Tool } from "@declarative-ai/exec";
import { loadBundle } from "@declarative-ai/hw";
import {
  nativesOfStandard,
  SHELL_TOOL,
  TOOL_SPECS,
  unmappedNatives,
  type PermissionsDecl,
} from "@jaira/shared";
import { AGENT_CODEX, registerAgentRuntimes } from "./agents";
import { CLAUDE_TOOLS } from "./agentTools";
import { agentPromptRoutes } from "./modelRoutes";
import { compilePolicy, type JairaPolicy } from "./policy";
import { grantAlwaysGrantedTools, JAIRA_TOOL_NAMES } from "./tools";
import { buildPromptExecutor, executeWorkflow, newRegistry } from "./wiring";

/** The two fields of an effective `environment` a grant is read from, in the shape the ENGINE takes. */
export interface HandedEnvironment {
  tools?: readonly string[] | undefined;
  permissions?: PermissionsDecl | undefined;
}

/** What decides one call: nobody (it runs), a person, or nobody (it is refused). */
export type HandedDecision = "allow" | "ask" | "deny";

export interface HandedTool {
  /** Can the agent do this at all — by our tool, or by a built-in it kept? */
  reachable: boolean;
  /** By what: `app` for ours, else the built-in's own name. */
  via: string[];
  /** The LEAST strict decision among the ways it can be reached; absent when it cannot. */
  decision?: HandedDecision;
}

/** The shell lines every reachable shell is asked about — one per kind of part (decision 0007 §4). */
export const SHELL_PROBES: Readonly<Record<string, string>> = {
  command: "git status",
  read: "cat README.md",
  write: "rm notes.txt",
  script: "./build.sh",
};

export interface AgentHanded {
  /** Our tools, served over the bridge. */
  served: string[];
  /** The built-ins on the agent's deny list. */
  removed: string[];
  /** What is never put to the permission callback. */
  preApproved: string[];
  /**
   * The built-ins the agent's OWN settings force to the permission callback (`permissions.ask`).
   * Without such a rule Claude Code decides a read-only built-in, and a sub-agent tool, itself, and the
   * callback — which is where every decision below is read — is never consulted for it.
   */
  askRules: string[];
  /** Per standard tool, the shell included (its `decision` is left to {@link shell}). */
  tools: Record<string, HandedTool>;
  /** claude's built-ins with no standard tool: removed, or what decides a call. */
  natives: Record<string, HandedDecision | "removed">;
  /** What decides a call by a name nobody declared. */
  other: HandedDecision;
  /** What decides each of {@link SHELL_PROBES}; empty when no shell is reachable. */
  shell: Record<string, HandedDecision>;
}

export interface HandedOptions {
  /** The project's policy; the default policy when absent. */
  policy?: JairaPolicy;
  /**
   * An ENCLOSING state's `environment`, in the shape the engine takes: the probe then runs as that
   * state's child and inherits it down the chain exactly as a mounted state does — `permissions`
   * merged per key, `tools` one level deeper, the list replaced.
   */
  parent?: HandedEnvironment;
}

/** The probe workflow: one prompt state, alone or as the only child of a state holding `parent`. */
function probeStates(
  environment: HandedEnvironment,
  operation: Record<string, unknown>,
  outputs: Record<string, unknown>,
  options: HandedOptions,
): { states: Record<string, unknown>; root: string } {
  const { scopes: _scopes, ...permissions } = environment.permissions ?? {};
  const def = {
    label: "probe",
    outputs,
    operation,
    environment: {
      ...(environment.tools !== undefined ? { tools: [...environment.tools] } : {}),
      ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
    },
  };
  if (options.parent === undefined) return { states: { probe: def }, root: "probe" };
  const { scopes: _parentScopes, ...parentPermissions } = options.parent.permissions ?? {};
  const parent = {
    label: "enclosing",
    outputs: {},
    environment: {
      ...(options.parent.tools !== undefined ? { tools: [...options.parent.tools] } : {}),
      ...(Object.keys(parentPermissions).length > 0 ? { permissions: parentPermissions } : {}),
    },
    children: { probe: { state: "enclosing/probe", inputs: {} } },
    sequence: ["probe"],
  };
  return { states: { enclosing: parent, "enclosing/probe": def }, root: "enclosing" };
}

const PROBE_INPUT = {
  path: "README.md",
  file_path: "README.md",
  pattern: "*.md",
  url: "https://example.com/",
  query: "example",
  content: "x",
  old_string: "a",
  new_string: "b",
  title: "probe",
};

function stubRegistry(): ReturnType<typeof newRegistry> {
  const registry = newRegistry();
  for (const name of JAIRA_TOOL_NAMES) {
    // `readOnly` matters only under a session profile, and a probe runs under none.
    const tool: Tool = { description: name, inputSchema: { type: "object" }, readOnly: false, run: async () => "ok" };
    registry.tools.set(name, tool);
  }
  return registry;
}

/**
 * Run one effective environment to the spawn, and read off what the agent is handed.
 *
 * `scopes` are left OUT of the probe: a scope table answers per place, by the standard tool a call
 * is (natives translated), which is its own test's business. Throws when the engine would refuse the block (a tool nothing registers).
 */
export async function handedToClaude(environment: HandedEnvironment, options: HandedOptions = {}): Promise<AgentHanded> {
  const seen: AgentQueryOptions[] = [];
  const query: AgentQuery = async function* (opts) {
    seen.push(opts);
    yield { type: "result", result: { text: "Done.", structured: { report: "probe" } } };
  };
  const { states, root } = probeStates(
    environment,
    { kind: "prompt", prompt: "probe", model: "claude-cli/default" },
    { report: { kind: "text", schema: { type: "string" } } },
    options,
  );
  grantAlwaysGrantedTools(states);

  let asked = 0;
  const result = await executeWorkflow({
    bundle: loadBundle(states, root),
    inputs: {},
    registry: stubRegistry(),
    prompt: buildPromptExecutor({ routes: agentPromptRoutes({}, { query }), tree: { kind: "agent", agent: "claude-cli" } }),
    policy: compilePolicy(options.policy ?? {}),
    approve: () => {
      asked += 1;
      return { decision: "deny", scope: "once" };
    },
  });
  const opts = seen[0];
  if (opts === undefined) {
    const reason = (result as { failure?: { reason?: string } }).failure?.reason ?? JSON.stringify(result).slice(0, 400);
    throw new Error(`the engine never reached the agent under this block: ${reason}`);
  }

  const removed = new Set(opts.disallowedTools ?? []);
  const preApproved = new Set(opts.allowedTools ?? []);
  const settings = (opts.providerOptions as { settings?: { permissions?: { ask?: unknown } } } | undefined)?.settings;
  const askRules = Array.isArray(settings?.permissions?.ask) ? (settings.permissions.ask as unknown[]).filter((rule): rule is string => typeof rule === "string") : [];
  const served = Object.keys(opts.mcpTools ?? {});
  const decide = async (toolName: string, input: Record<string, unknown>): Promise<HandedDecision> => {
    if (opts.canUseTool === undefined) return "allow";
    const before = asked;
    const verdict = await opts.canUseTool({ toolName, input: input as never }, { signal: new AbortController().signal });
    if (asked > before) return "ask";
    return (verdict as { allow?: boolean }).allow === true ? "allow" : "deny";
  };
  const RANK: Record<HandedDecision, number> = { allow: 0, ask: 1, deny: 2 };
  const least = (decisions: readonly HandedDecision[]): HandedDecision | undefined =>
    decisions.length === 0 ? undefined : decisions.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));

  /** The names a standard tool can still be addressed by, each with the input it would carry. */
  const waysTo = (standard: string): Array<{ via: string; name: string; preApproved: boolean }> => [
    ...(served.includes(standard) ? [{ via: "app", name: mcpToolName(standard), preApproved: preApproved.has(standard) }] : []),
    ...nativesOfStandard(CLAUDE_TOOLS, standard)
      .filter((native) => !removed.has(native))
      .map((native) => ({ via: native, name: native, preApproved: preApproved.has(native) })),
  ];

  const tools: Record<string, HandedTool> = {};
  const shell: Record<string, HandedDecision> = {};
  for (const spec of TOOL_SPECS) {
    if (spec.unserved === true) continue;
    const ways = waysTo(spec.name);
    if (ways.length === 0) {
      tools[spec.name] = { reachable: false, via: [] };
      continue;
    }
    if (spec.name === SHELL_TOOL) {
      const lines: Record<string, HandedDecision> = {};
      for (const [kind, line] of Object.entries(SHELL_PROBES)) {
        const decisions: HandedDecision[] = [];
        for (const way of ways) decisions.push(way.preApproved ? "allow" : await decide(way.name, { command: line }));
        lines[kind] = least(decisions)!;
      }
      // A shell every line of which is refused is not a shell. The tool may be offered — a map's
      // `"bash": "deny"` still offers it — but nothing can be run through it, and "the agent has a
      // shell it cannot use" and "the agent has no shell" are one grant.
      const usable = Object.values(lines).some((decision) => decision !== "deny");
      tools[spec.name] = usable ? { reachable: true, via: ways.map((way) => way.via) } : { reachable: false, via: [] };
      if (usable) Object.assign(shell, lines);
      continue;
    }
    const decisions: HandedDecision[] = [];
    for (const way of ways) decisions.push(way.preApproved ? "allow" : await decide(way.name, PROBE_INPUT));
    const decision = least(decisions)!;
    // A way in that is refused is not a way in: `edit: "deny"` and no `edit` at all are one grant.
    tools[spec.name] = decision === "deny" ? { reachable: false, via: [] } : { reachable: true, via: ways.map((way) => way.via), decision };
  }

  const natives: Record<string, HandedDecision | "removed"> = {};
  for (const native of unmappedNatives(CLAUDE_TOOLS)) natives[native] = removed.has(native) ? "removed" : await decide(native, {});

  return {
    served: [...served].sort(),
    removed: [...removed].sort(),
    preApproved: [...preApproved].sort(),
    askRules: [...askRules].sort(),
    tools,
    natives,
    other: await decide("mcp__somebody__a_tool_nobody_declared", {}),
    shell,
  };
}

/** What a delegated codex is handed: its one channel, the sandbox. */
export interface CodexHanded {
  /** `plan` is `--sandbox read-only` on this transport; absent keeps the configured sandbox. */
  permissionMode: string | undefined;
  /** Our tools, served over the bridge — which codex refuses to be handed at all. */
  served: string[];
}

export interface CodexHandedOptions extends HandedOptions {
  /**
   * How the state reaches codex: by a model prefix (`model: "codex-cli/default"`, the prompt route),
   * or as a FUNCTION (`operation.function: "codex-cli"`), which is registered separately.
   */
  via?: "route" | "function";
}

/**
 * {@link handedToClaude}'s codex half: one effective environment run to the spawn a real `codex exec`
 * would get, through the engine and whichever wrapper holds that path to its toolset.
 */
export async function handedToCodex(environment: HandedEnvironment, options: CodexHandedOptions = {}): Promise<CodexHanded> {
  const seen: AgentQueryOptions[] = [];
  const query: AgentQuery = async function* (opts) {
    seen.push(opts);
    yield { type: "result", result: { text: "Done.", structured: { report: "probe" } } };
  };
  const viaFunction = options.via === "function";
  const { states, root } = probeStates(
    environment,
    viaFunction
      ? { kind: "function", function: AGENT_CODEX, args: { prompt: "probe" } }
      : { kind: "prompt", prompt: "probe", model: `${AGENT_CODEX}/default` },
    viaFunction ? {} : { report: { kind: "text", schema: { type: "string" } } },
    options,
  );
  grantAlwaysGrantedTools(states);
  const registry = stubRegistry();
  if (viaFunction) registerAgentRuntimes(registry, { query, adapters: ["codex"] });
  const result = await executeWorkflow({
    bundle: loadBundle(states, root),
    inputs: {},
    registry,
    prompt: buildPromptExecutor({ routes: agentPromptRoutes({}, { query }), tree: { kind: "agent", agent: AGENT_CODEX } }),
    policy: compilePolicy(options.policy ?? {}),
    approve: () => ({ decision: "deny", scope: "once" }),
  });
  const opts = seen[0];
  if (opts === undefined) {
    const reason = (result as { failure?: { reason?: string } }).failure?.reason ?? JSON.stringify(result).slice(0, 400);
    throw new Error(`the engine never reached codex under this block: ${reason}`);
  }
  return { permissionMode: opts.permissionMode, served: Object.keys(opts.mcpTools ?? {}).sort() };
}
