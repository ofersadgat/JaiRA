/**
 * An agent gets its toolset and nothing else (decision 0007 §3).
 *
 * Three things live here, and they are one argument:
 *
 *  1. **What each agent executor DECLARES** about its own tools — {@link CLAUDE_TOOLS},
 *     {@link CODEX_TOOLS}, {@link GENERIC_CLI_TOOLS}. Which built-ins it has, which standard tool each
 *     one is, and for a transport with nothing finer, which coarse switch unlocks which subjects. This
 *     used to be a `natives: { claude: … }` column on the shared vocabulary; the standard list holds
 *     no agent's names now.
 *  2. **The plan** — {@link planAgentTools}: a toolset and a declaration in, and out comes what is
 *     injected, which natives are removed, which are kept and forced through the permission callback,
 *     and how each switch is set.
 *  3. **The wrapper** — {@link withAgentToolset}: the plan, applied to ONE call on its way into an
 *     agent executor. It sits where the route is finally known, which is the only place the right
 *     declaration can be picked.
 *
 * ## The rule, per standard tool
 *
 *  - **Not in the toolset → the native is removed.** The deny list, or the switch left off.
 *  - **In it → OUR implementation is injected and displaces the native.** The default.
 *  - **In it as `implementation: "native"` → the built-in is kept and forced through the permission
 *    callback**, so the entry's mode still decides — asked about by its STANDARD name, which is the
 *    name the mode was written against.
 *  - **A native with no standard tool answers to `other`.** It is never removed for want of an entry.
 *    `other: "deny"` refuses it as configuration — a `deny` needs no person, and a sub-agent tool
 *    (`Task`) would otherwise inherit tools this deny list never sees — and any other `other` is what
 *    the callback answers with.
 *
 * ## Where the toolset comes from
 *
 * A conversation turn KNOWS its toolset and hands it over on the services bundle
 * ({@link TOOLSET_SERVICE}). A run does not: the engine resolves a state's `environment` itself and
 * hands an executor two things — the tools it resolved (`ctx.tools`) and a gate over the state's
 * modes (`ctx.gate`) — so the toolset is READ BACK from those ({@link viewOfServices}). What cannot be
 * read back is whose code was chosen: a run's `implementation: "native"` is carried on the lowered
 * block and reaches nobody, so a run injects ours.
 *
 * A call that declares NO tools at all — no list, no map — is not a toolset that holds nothing; it is
 * a state that said nothing, and the agent keeps what it has, under the gate. That is every state
 * written before tools were a fence, and it is told apart from an empty toolset by the only evidence
 * a run has: whether anything but the always-granted tools was resolved.
 */
import {
  finishedHandle,
  permanentFailure,
  type ExecServices,
  type InlineFamily,
  type JsonValue,
  type Operation,
} from "@declarative-ai/exec";
import { emptyWorkflowMetrics, type WorkflowMetrics } from "@declarative-ai/hw";
import type { ExecPolicy, PermissionMode, ToolGate } from "@declarative-ai/permissions";
import {
  ALWAYS_GRANTED_TOOLS,
  nativesOfStandard,
  offeredTools,
  standardOfNative,
  TOOL_SPEC_BY_NAME,
  TOOL_SPECS,
  toolsetOfLegacy,
  unmappedNatives,
  type AgentToolDeclaration,
  type ToolImplementation,
  type Toolset,
} from "@jaira/shared";
import type { StackedExecutor } from "./executorStack";

// --- what each executor declares ----------------------------------------------

/**
 * Claude Code — `claude-code` (the SDK) and `claude-cli` (the subprocess) drive the same agent.
 *
 * `MultiEdit` and `NotebookEdit` ARE `edit`: they replace text in a file that exists, and an agent
 * denied `Edit` and left `MultiEdit` has been denied nothing.
 *
 * `Task`, `Agent` and `SlashCommand` have no standard tool: a sub-agent and a command file can each do
 * anything, which is exactly what `other` is for.
 *
 * `AskUserQuestion` is deliberately NOT declared. It is answered on its own seam before any gate is
 * consulted, and a state that must not write may still ask.
 */
export const CLAUDE_TOOLS: AgentToolDeclaration = {
  channel: "tools",
  natives: {
    Read: "read_file",
    Glob: "glob",
    Grep: "grep",
    Edit: "edit",
    MultiEdit: "edit",
    NotebookEdit: "edit",
    Write: "write_file",
    Bash: "bash",
    WebFetch: "web_fetch",
    WebSearch: "web_search",
    Task: null,
    Agent: null,
    SlashCommand: null,
  },
};

/**
 * Codex — `codex exec` has no per-tool deny list, no allow-list and no permission callback. Its one
 * channel is the sandbox, so the declaration says which standard subjects the WRITING sandbox
 * unlocks, and the flag is derived from the toolset: `workspace-write` when the toolset holds
 * `write_file`, `edit` or `bash`, `read-only` otherwise.
 *
 * Its natives are named so a line in the composer can say what would run; none can be removed alone.
 */
export const CODEX_TOOLS: AgentToolDeclaration = {
  channel: "switches",
  natives: { shell: "bash", apply_patch: "edit" },
  switches: { "workspace-write": ["write_file", "edit", "bash"] },
};

/** The switch {@link CODEX_TOOLS} declares — the sandbox that lets codex change the workspace. */
export const CODEX_WRITE_SWITCH = "workspace-write";

/**
 * A generic CLI — a binary JaiRA knows nothing about and can tell nothing to. It declares no tools
 * and no channel, so a toolset that REFUSES anything cannot be held to and the call is refused.
 */
export const GENERIC_CLI_TOOLS: AgentToolDeclaration = { channel: "none", natives: {} };

/** Every declaration, for the one question asked without knowing the route: what is this native? */
const ALL_DECLARATIONS: readonly AgentToolDeclaration[] = [CLAUDE_TOOLS, CODEX_TOOLS, GENERIC_CLI_TOOLS];

/** The standard tool a native name stands for under ANY declared agent, or `undefined`. */
export function standardOfAnyNative(native: string): string | undefined {
  for (const declaration of ALL_DECLARATIONS) {
    const standard = standardOfNative(declaration, native);
    if (typeof standard === "string") return standard;
  }
  return undefined;
}

// --- the toolset, as a call sees it ---------------------------------------------

/** One call's toolset, reduced to the four questions the plan asks of it. */
export interface ToolsetView {
  /**
   * Does this call state a toolset at all? `false` is a state that declared no tools — the agent
   * keeps what it has, under the gate — and is NOT the same as a toolset that holds nothing.
   */
  declared: boolean;
  /** Whose code runs a standard tool the toolset HOLDS; `undefined` when it does not hold it. */
  held(standard: string): ToolImplementation | undefined;
  /** The mode a standard tool resolves to, where anything says. */
  modeOf(standard: string): PermissionMode | undefined;
  /** The mode a name with no standard tool resolves to — `other`, unless something named it. */
  otherFor(name: string): PermissionMode | undefined;
  /**
   * Is `other` KNOWN to have been written, as against read off a gate that answers `ask` for want of
   * anything better? Only a written `ask` forces an unmapped native through the callback: forcing it
   * on a guess would put every sub-agent call of an unrestricted state in front of a person.
   */
  otherIsAuthored: boolean;
}

/** A toolset in hand — a conversation turn's. */
export function viewOfToolset(toolset: Toolset): ToolsetView {
  const offered = new Set(offeredTools(toolset));
  const entry = (name: string) => (Object.hasOwn(toolset.entries, name) ? toolset.entries[name] : undefined);
  return {
    declared: true,
    held: (standard) => (offered.has(standard) ? (entry(standard)?.implementation ?? "app") : undefined),
    modeOf: (standard) => entry(standard)?.mode,
    otherFor: () => toolset.other,
    otherIsAuthored: toolset.other !== undefined,
  };
}

/**
 * A toolset read back off what the ENGINE hands an executor — a run's.
 *
 * `ctx.tools` is the state's resolved tool list, so membership is exact. `ctx.gate` resolves a mode
 * through the state's own block, the run's ledger and the project baseline, so a `deny` is exact too
 * — including `other`, which is what the gate answers for a name nothing registered.
 */
export function viewOfServices(ctx: ExecServices): ToolsetView {
  const names = Object.keys(ctx.tools ?? {});
  const held = new Set(names);
  const baseline = ctx.policy?.baseline?.tools;
  const modeOf = (name: string): PermissionMode | undefined =>
    ctx.gate?.modeOf({ name }) ?? (baseline !== undefined && Object.hasOwn(baseline, name) ? baseline[name] : undefined);
  return {
    declared: names.some((name) => !ALWAYS_GRANTED_TOOLS.includes(name)),
    held: (standard) => (held.has(standard) ? "app" : undefined),
    modeOf,
    otherFor: modeOf,
    otherIsAuthored: false,
  };
}

// --- the plan -----------------------------------------------------------------

/** What an agent should be handed, once a toolset has met a declaration. */
export interface AgentToolPlan {
  /**
   * Standard tools to DECLARE, so ours are injected. This is `environment.tools`: membership of the
   * list is what selects our implementation, which is why the choice is a list and not a flag.
   */
  inject: string[];
  /** Natives an injected tool of ours DISPLACES — removed, or the model reaches for them instead. */
  displaced: string[];
  /**
   * Natives the agent KEEPS, forced to its permission callback so our gate still decides.
   *
   * Without the rule Claude Code's own policy auto-allows its read-only built-ins and never consults
   * the callback at all — "native" means the implementation, never the access.
   */
  askNatives: string[];
  /** Natives REMOVED: their standard tool is not in the toolset, or what answers for them is `deny`. */
  denyNatives: string[];
  /** Each declared switch, ON when the toolset holds one of its subjects un-denied. */
  switches: Record<string, boolean>;
}

/**
 * Resolve a toolset against one agent's declaration — see the module header for the rule.
 *
 * A tool marked `alwaysGranted` is held whether the toolset names it or not: its absence is an
 * omission, never a decision. It still answers to the gate.
 *
 * Takes a toolset, a {@link ToolsetView}, or the legacy pair a toolset is folded from (the granted
 * list and the composer's implementations map). The declaration defaults to claude's, which is what
 * every caller meant before there was more than one.
 */
export function planAgentTools(
  grant: readonly string[] | Toolset | ToolsetView,
  legacyImplementations: Readonly<Record<string, ToolImplementation>> = {},
  declaration: AgentToolDeclaration = CLAUDE_TOOLS,
): AgentToolPlan {
  const view: ToolsetView = isView(grant)
    ? grant
    : viewOfToolset(isToolList(grant) ? toolsetOfLegacy(grant, undefined, legacyImplementations) : grant);
  const plan: AgentToolPlan = { inject: [], displaced: [], askNatives: [], denyNatives: [], switches: {} };
  const holds = (standard: string): ToolImplementation | undefined =>
    view.held(standard) ?? (TOOL_SPEC_BY_NAME.get(standard)?.alwaysGranted === true ? "app" : undefined);

  for (const spec of TOOL_SPECS) {
    const natives = nativesOfStandard(declaration, spec.name);
    const implementation = holds(spec.name);
    if (implementation === undefined) {
      // NOT IN THE TOOLSET. Removed — unless the call declared no tools at all, where only an explicit
      // `deny` removes anything and the agent otherwise keeps what it has.
      if (view.declared || view.modeOf(spec.name) === "deny") plan.denyNatives.push(...natives);
      continue;
    }
    // A tool we cannot serve has no `app` to choose, whatever the entry recorded.
    const choice = spec.nativeOnly === true ? "native" : implementation;
    if (choice === "native" && natives.length > 0) {
      // Kept — and a `deny` beside it is still a deny, delivered as configuration.
      if (view.modeOf(spec.name) === "deny") plan.denyNatives.push(...natives);
      else plan.askNatives.push(...natives);
      continue;
    }
    plan.inject.push(spec.name);
    plan.displaced.push(...natives);
  }

  for (const native of unmappedNatives(declaration)) {
    const mode = view.otherFor(native);
    if (mode === "deny") plan.denyNatives.push(native);
    else if (view.otherIsAuthored && (mode === "ask" || mode === "smart")) plan.askNatives.push(native);
  }

  for (const [name, subjects] of Object.entries(declaration.switches ?? {})) {
    const open = (subject: string): boolean => view.modeOf(subject) !== "deny";
    plan.switches[name] = view.declared
      ? subjects.some((subject) => holds(subject) !== undefined && open(subject))
      : subjects.some(open);
  }
  return plan;
}

/** What a toolset REFUSES — the reason a transport that enforces nothing cannot run it. */
export function refusalsOf(view: ToolsetView): string[] {
  const denied = TOOL_SPECS.filter((spec) => view.modeOf(spec.name) === "deny").map((spec) => spec.name);
  return view.otherFor("other") === "deny" ? [...denied, "other"] : denied;
}

function isToolList(grant: readonly string[] | Toolset | ToolsetView): grant is readonly string[] {
  return Array.isArray(grant);
}

function isView(grant: readonly string[] | Toolset | ToolsetView): grant is ToolsetView {
  return !Array.isArray(grant) && typeof (grant as ToolsetView).held === "function";
}

// --- the wrapper --------------------------------------------------------------

/**
 * The key a caller that KNOWS its toolset publishes it under, on the services bundle.
 *
 * A conversation turn builds its own services, so it can say exactly what the toolset is —
 * implementations included. A run cannot (see the module header) and leaves it absent.
 */
export const TOOLSET_SERVICE = "jairaToolset";

/** Publish a toolset on a services bundle — see {@link TOOLSET_SERVICE}. */
export function withToolsetService<T extends object>(services: T, toolset: Toolset | undefined): T {
  return toolset === undefined ? services : ({ ...services, [TOOLSET_SERVICE]: toolset } as T);
}

function toolsetOf(ctx: ExecServices): Toolset | undefined {
  const value = (ctx as unknown as Record<string, unknown>)[TOOLSET_SERVICE];
  return value !== null && typeof value === "object" ? (value as Toolset) : undefined;
}

export interface AgentToolsetOptions {
  /** What the transport is called in a refusal. */
  label: string;
  /** Which bag of `providerOptions` this agent reads — where an ask rule is written. */
  providerOptionsKey?: string;
  /**
   * For a `switches` transport: the executor to use for one setting of the switches, or `undefined`
   * to keep the one that was wrapped. This is how a flag that is fixed at construction is nonetheless
   * derived per call — there is one executor per setting, and the toolset picks.
   */
  switched?: (switches: Readonly<Record<string, boolean>>) => StackedExecutor | undefined;
}

/**
 * Hold ONE agent executor to the toolset of each call it answers.
 *
 *  - `tools` (claude): the removed and displaced natives reach the agent as its deny list, through
 *    the channel the executor already reads (`ctx.policy.baseline` and `ctx.gate.modeOf`); the kept
 *    ones get an ask rule in the agent's own settings; and the gate the callback consults is asked
 *    about a native by its STANDARD name, so `Read` answers to the `read_file` entry.
 *  - `switches` (codex): the executor for this setting of the switches answers.
 *  - `none` (a generic CLI): a toolset that refuses anything is refused, by name.
 */
export function withAgentToolset(
  declaration: AgentToolDeclaration,
  inner: StackedExecutor,
  options: AgentToolsetOptions,
): StackedExecutor {
  const executor = inner;
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(op) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      if (op.kind !== "prompt") return executor.start(op, ctx);
      const known = toolsetOf(ctx);
      const view = known !== undefined ? viewOfToolset(known) : viewOfServices(ctx);
      const plan = planAgentTools(view, {}, declaration);

      if (declaration.channel === "none") {
        const refused = refusalsOf(view);
        if (refused.length === 0) return executor.start(op, ctx);
        return finishedHandle(
          permanentFailure<WorkflowMetrics>(
            `${options.label}: this state's toolset refuses ${refused.map((name) => `'${name}'`).join(", ")}, and this transport ` +
              `enforces nothing — no deny list, no sandbox, no permission callback — so nothing could hold the agent to it. ` +
              `Run the state on claude-code, claude-cli or codex-cli, or drop the restriction`,
            emptyWorkflowMetrics(),
          ),
        );
      }

      if (declaration.channel === "switches") {
        return (options.switched?.(plan.switches) ?? executor).start(op, ctx);
      }

      const denied = [...new Set([...plan.displaced, ...plan.denyNatives])];
      return executor.start(
        withAskRules(op, options.providerOptionsKey ?? "claudeCode", plan.askNatives),
        servicesUnder(ctx, declaration, denied),
      );
    },
  };
}

/**
 * The same holding for an agent reached as a FUNCTION (`operation.function: "claude-code"`), which
 * has no prompt op to write an ask rule into: the removals and the translated gate, and nothing else.
 * Only a `tools` transport has anything to apply here.
 */
export function agentServices(declaration: AgentToolDeclaration, ctx: ExecServices): ExecServices {
  if (declaration.channel !== "tools") return ctx;
  const known = toolsetOf(ctx);
  const plan = planAgentTools(known !== undefined ? viewOfToolset(known) : viewOfServices(ctx), {}, declaration);
  return servicesUnder(ctx, declaration, [...new Set([...plan.displaced, ...plan.denyNatives])]);
}

/**
 * The services an agent executor reads, with the plan's removals in them and the gate translated.
 *
 * The executor builds its deny list from the names in `ctx.policy.baseline.tools` that resolve to
 * `deny`, asking `ctx.gate.modeOf` first — so a native to remove is named in the baseline AND answered
 * `deny` by the gate. Both are copies: the run's policy and the engine's gate are untouched.
 */
export function servicesUnder(ctx: ExecServices, declaration: AgentToolDeclaration, denied: readonly string[]): ExecServices {
  const refused = new Set(denied);
  // Untouched when there is nothing to remove: a call with no policy keeps having none.
  const policy: ExecPolicy | undefined =
    denied.length === 0
      ? ctx.policy
      : {
          ...ctx.policy,
          baseline: {
            ...ctx.policy?.baseline,
            tools: { ...ctx.policy?.baseline?.tools, ...Object.fromEntries(denied.map((native) => [native, "deny" as PermissionMode])) },
          },
        };
  const gate = ctx.gate === undefined ? undefined : translatedGate(ctx.gate, declaration, refused);
  return { ...ctx, ...(policy !== undefined ? { policy } : {}), ...(gate !== undefined ? { gate } : {}) };
}

/**
 * A gate that is asked about a native by the name its MODE was written against.
 *
 * The agent's callback names `Read`; the entry is `read_file`. Asked as `Read`, the gate finds no
 * entry and answers `other` — so a kept native would answer to the wrong line of the map. A native
 * with no standard tool, and any name nothing declared, passes through and answers to `other`, which
 * is the rule.
 */
function translatedGate(gate: ToolGate, declaration: AgentToolDeclaration, refused: ReadonlySet<string>): ToolGate {
  const subject = <T extends { name: string; readOnly?: boolean }>(tool: T): { name: string; readOnly?: boolean } => {
    const standard = standardOfNative(declaration, tool.name);
    // `readOnly` is a claim about the NATIVE; the standard tool's own is the gate's to know.
    return typeof standard === "string" ? { name: standard } : tool;
  };
  return {
    get profile() {
      return gate.profile;
    },
    modeOf: (tool) => (refused.has(tool.name) ? "deny" : gate.modeOf(subject(tool))),
    check: (tool, input) => {
      if (refused.has(tool.name)) {
        return Promise.resolve({ allow: false as const, reason: `tool '${tool.name}' is not in this state's toolset` });
      }
      const asked = subject(tool);
      return gate.check(asked, asked === tool ? input : standardInput(asked.name, input));
    },
  };
}

/**
 * A native's input, with the PLACE it names under the argument the standard tool calls it.
 *
 * A scope table and the `.jaira/` rule read `path`; Claude's `Read` says `file_path`. Without this a
 * kept native would be asked about under the right name and judged at no place at all.
 */
function standardInput<T>(standard: string, input: T): T {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const bag = input as Record<string, unknown>;
  const place = bag["file_path"] ?? bag["notebook_path"];
  if (typeof place !== "string") return input;
  const wanted = (TOOL_SPEC_BY_NAME.get(standard)?.pathArgs ?? []).filter((arg) => bag[arg] === undefined);
  if (wanted.length === 0) return input;
  return { ...bag, ...Object.fromEntries(wanted.map((arg) => [arg, place])) } as T;
}

/** Add ask rules to the agent's own settings — unioned with whatever the state already wrote. */
function withAskRules(op: Operation<InlineFamily>, key: string, natives: readonly string[]): Operation<InlineFamily> {
  if (op.kind !== "prompt" || natives.length === 0) return op;
  const config = isObject(op.config) ? op.config : {};
  const providerOptions = isObject(config["providerOptions"]) ? config["providerOptions"] : {};
  const bag = isObject(providerOptions[key]) ? providerOptions[key] : {};
  const settings = isObject(bag["settings"]) ? bag["settings"] : {};
  const permissions = isObject(settings["permissions"]) ? settings["permissions"] : {};
  const existing = Array.isArray(permissions["ask"]) ? (permissions["ask"] as JsonValue[]) : [];
  const ask = [...new Set([...existing, ...natives])] as JsonValue;
  return {
    ...op,
    config: {
      ...config,
      providerOptions: { ...providerOptions, [key]: { ...bag, settings: { ...settings, permissions: { ...permissions, ask } } } },
    } as JsonValue,
  };
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
