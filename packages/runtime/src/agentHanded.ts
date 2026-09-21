/**
 * What a delegated claude agent is ACTUALLY handed under one effective `environment` — measured, not
 * modelled (decision 0007 step 7).
 *
 * The migration from the list form to a toolset map must preserve what a state DOES, not what it
 * SAYS, and the two differ: a list is a grant and a map is a fence (`agentTools.ts`). So "is this map
 * the same as that list" cannot be answered by comparing the two documents. It is answered here, by
 * running each one through the chain a real run goes through and looking at what comes out:
 *
 *   a one-state workflow → the ENGINE (which resolves the tools and builds the gate, seeding an old
 *   `profile`) → `withAgentToolset` (JaiRA's wrapper, by claude's own declaration) → the upstream
 *   agent executor → the options a real `claude` would be spawned with.
 *
 * A fake QUERY stands in for the binary alone — the rig `agentToolset.test.ts` pins. What is read off
 * the spawn: the tools of ours that are served, the built-ins on the deny list, the pre-approvals,
 * and — by asking the spawn's own permission callback — what decides a call by every name the agent
 * could still address. Nothing here restates a rule of the gate, the plan or the executor, so the
 * answer stays true when any of them changes.
 *
 * {@link handedDifferences} compares two of these. The comparison is of REACH and DECISION per
 * standard tool — "can the agent read a file, and who is asked" — not of which implementation serves
 * it: claude's own `Glob` under the gate and JaiRA's `glob` under the same mode are the same grant.
 */
import { mcpToolName, type AgentQuery, type AgentQueryOptions } from "@declarative-ai/agents-api";
import type { Tool } from "@declarative-ai/exec";
import { loadBundle } from "@declarative-ai/hw";
import {
  isLoweredToolset,
  LEGACY_NARROWING_PROFILES,
  LEGACY_NON_READ_ONLY_TOOLS,
  nativesOfStandard,
  SHELL_TOOL,
  TOOL_SPECS,
  unmappedNatives,
  type PermissionsDecl,
} from "@jaira/shared";
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
  /** Which reading the run made of the block: the marks a lowered map leaves, or none. */
  form: "legacy" | "map";
  /** Our tools, served over the bridge. */
  served: string[];
  /** The built-ins on the agent's deny list. */
  removed: string[];
  /** What is never put to the permission callback. */
  preApproved: string[];
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
    // `readOnly` is what the engine's `profile` handling reads, and the frozen list is what it said
    // the day the flag was removed — `tools.test.ts` holds the real tools to it.
    const tool: Tool = {
      description: name,
      inputSchema: { type: "object" },
      readOnly: !LEGACY_NON_READ_ONLY_TOOLS.includes(name),
      run: async () => "ok",
    };
    registry.tools.set(name, tool);
  }
  return registry;
}

/**
 * Run one effective environment to the spawn, and read off what the agent is handed.
 *
 * `scopes` are left OUT of the probe: a scope table answers per place, by the standard tool a call
 * is (natives translated), and it passes through a migration untouched — the caller compares the
 * table itself. Throws when the engine would refuse the block (a tool nothing registers).
 */
export async function handedToClaude(environment: HandedEnvironment, options: HandedOptions = {}): Promise<AgentHanded> {
  const seen: AgentQueryOptions[] = [];
  const query: AgentQuery = async function* (opts) {
    seen.push(opts);
    yield { type: "result", result: { text: "Done.", structured: { report: "probe" } } };
  };
  const { scopes: _scopes, ...permissions } = environment.permissions ?? {};
  const def = {
    label: "probe",
    outputs: { report: { kind: "text", schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: "probe", model: "claude-cli/default" },
    environment: {
      ...(environment.tools !== undefined ? { tools: [...environment.tools] } : {}),
      ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
    },
  };
  const states: Record<string, unknown> = { probe: def };
  grantAlwaysGrantedTools(states);

  let asked = 0;
  const result = await executeWorkflow({
    bundle: loadBundle(states, "probe"),
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
    form: isLoweredToolset(environment.permissions) ? "map" : "legacy",
    served: [...served].sort(),
    removed: [...removed].sort(),
    preApproved: [...preApproved].sort(),
    tools,
    natives,
    other: await decide("mcp__somebody__a_tool_nobody_declared", {}),
    shell,
  };
}

// --- the comparison ------------------------------------------------------------

/** Why a difference is one a migration may carry: there is NO map that says what the list said. */
export type ToleratedDifference =
  /**
   * Under an old narrowing `profile` a name nobody declared was put to a person, while `Task`,
   * `Agent` and `SlashCommand` were removed. A map has one `other`: `deny` removes the three and
   * refuses the unknown name; `ask` would hand the three back. The migration writes `deny` — what
   * `applyLegacyProfile` has always read the profile as — and the unknown name is TIGHTENED.
   */
  | "profile-unknown-name"
  /**
   * OPT-IN, never assumed. A list that never named `bash` still left claude its own `Bash`, every
   * call put to a person, and no map says that: a map that does not hold the shell REMOVES it.
   * Accepting this takes the shell away — tightened, and what the list said it wanted.
   */
  | "unlisted-shell"
  /**
   * OPT-IN, never assumed, and it may LOOSEN. A list that pinned the shell to a mode of its own
   * (`permissions.tools.bash`, or a `default` that reached it) asked before EVERY line. A map cannot
   * say that in a run: its shell entry lowers as `smart` with the authored mode in
   * `permissions.subjects`, and the engine hands the policy a state's `tools`, `default`, `other`
   * and `scopes` only (`literalPermissions`) — the subjects never arrive, so the line is judged by
   * the project's own command policy, which may run what a person used to be asked about.
   *
   * That judgement is what decision 0007 §4 is FOR, so this is the intended destination and not a
   * defect; it is opt-in because it is a change in what happens, and migrating is where a state's
   * author chooses.
   */
  | "shell-judged";

/** What {@link handedDifferences} needs to know about where `before` came from. */
export interface HandedContext extends HandedEnvironment {
  /**
   * The opt-in kinds the caller accepts. `profile-unknown-name` needs no opting into — there is no
   * other map — and everything else is accepted by name or not at all.
   */
  accept?: readonly ToleratedDifference[];
}

export interface HandedDifference {
  /** What differs: `read_file`, `native:Task`, `other`, `shell:write`. */
  subject: string;
  before: string;
  after: string;
  /** Set when the difference is one no map could avoid; absent is a FAILURE of the proof. */
  tolerated?: ToleratedDifference;
}

const describeTool = (tool: HandedTool | undefined): string =>
  tool === undefined || !tool.reachable ? "not reachable" : `reachable, ${tool.decision ?? "judged by line"}`;

/**
 * Every way `after` hands the agent something `before` did not, or the reverse.
 *
 * A difference with no `tolerated` is a FAILURE of the proof, and the two shell kinds are tolerated
 * only where the caller named them — see {@link ToleratedDifference}.
 */
export function handedDifferences(before: AgentHanded, after: AgentHanded, context: HandedContext = {}): HandedDifference[] {
  const out: HandedDifference[] = [];
  const accepts = (kind: ToleratedDifference): boolean => context.accept?.includes(kind) === true;
  // The shell a list never named, kept by the agent with every call put to a person — and gone.
  const shellDropped =
    accepts("unlisted-shell") &&
    !(context.tools ?? []).includes(SHELL_TOOL) &&
    before.tools[SHELL_TOOL]?.reachable === true &&
    after.tools[SHELL_TOOL]?.reachable !== true;
  // The shell both sides hold, whose LINES are no longer answered the same way.
  const shellJudged = accepts("shell-judged") && before.tools[SHELL_TOOL]?.reachable === true && after.tools[SHELL_TOOL]?.reachable === true;
  for (const name of new Set([...Object.keys(before.tools), ...Object.keys(after.tools)])) {
    const a = describeTool(before.tools[name]);
    const b = describeTool(after.tools[name]);
    if (a !== b) out.push({ subject: name, before: a, after: b, ...(name === SHELL_TOOL && shellDropped ? { tolerated: "unlisted-shell" as const } : {}) });
  }
  for (const name of new Set([...Object.keys(before.natives), ...Object.keys(after.natives)])) {
    // Refused up front and refused at the callback are one answer: the call cannot happen. The
    // legacy reading leaves `Task` in place for `other: "deny"` to refuse; a map takes it off the
    // agent. Comparing the mechanism rather than the outcome would call that a lost tool.
    const answer = (held: HandedDecision | "removed" | undefined): string => (held === undefined || held === "removed" || held === "deny" ? "refused" : held);
    const a = answer(before.natives[name]);
    const b = answer(after.natives[name]);
    if (a !== b) out.push({ subject: `native:${name}`, before: a, after: b });
  }
  if (before.other !== after.other) {
    const profile = context.permissions?.profile;
    const narrowing = profile !== undefined && LEGACY_NARROWING_PROFILES.includes(profile);
    const tightened = before.other === "ask" && after.other === "deny";
    out.push({ subject: "other", before: before.other, after: after.other, ...(narrowing && tightened ? { tolerated: "profile-unknown-name" as const } : {}) });
  }
  for (const kind of new Set([...Object.keys(before.shell), ...Object.keys(after.shell)])) {
    const a = before.shell[kind];
    const b = after.shell[kind];
    if (a === b) continue;
    // With the shell itself gone there is no line left to judge; that is one difference, named above.
    if (shellDropped && b === undefined) continue;
    out.push({ subject: `shell:${kind}`, before: a ?? "no shell", after: b ?? "no shell", ...(shellJudged ? { tolerated: "shell-judged" as const } : {}) });
  }
  return out;
}
