/**
 * An agent gets its permission set and nothing else (decision 0007 §3).
 *
 * Three things live here, and they are one argument:
 *
 *  1. **What each agent executor DECLARES** about its own tools — {@link CLAUDE_TOOLS},
 *     {@link CODEX_TOOLS}, {@link GENERIC_CLI_TOOLS}. Which built-ins it has, which standard tool each
 *     one is, and for a transport with nothing finer, which coarse switch unlocks which subjects. This
 *     used to be a `natives: { claude: … }` column on the shared vocabulary; the standard list holds
 *     no agent's names now.
 *  2. **The plan** — {@link planAgentTools}: a permission set and a declaration in, and out comes what is
 *     injected, which natives are removed, which are kept and forced through the permission callback,
 *     and how each switch is set.
 *  3. **The wrapper** — {@link withAgentPermissionSet}: the plan, applied to ONE call on its way into an
 *     agent executor. It sits where the route is finally known, which is the only place the right
 *     declaration can be picked.
 *
 * ## The rule, per standard tool
 *
 *  - **Not in the permission set → the native is removed.** The deny list, or the switch left off.
 *  - **In it → OUR implementation is injected and displaces the native.** The default.
 *  - **In it as `implementation: "native"` → the built-in is kept and forced through the permission
 *    callback**, so the entry's mode still decides — asked about by its STANDARD name, which is the
 *    name the mode was written against.
 *  - **A native with no standard tool answers to `other`.** It is never removed for want of an entry.
 *    `other: "deny"` refuses it as configuration — a `deny` needs no person, and a sub-agent tool
 *    (`Task`) would otherwise inherit tools this deny list never sees — and any other `other` is what
 *    the callback answers with.
 *
 * ## Where the permission set comes from
 *
 * A conversation turn KNOWS its permission set and hands it over on the services bundle
 * ({@link PERMISSION_SET_SERVICE}). A run does not build one: the engine resolves a state's `environment`
 * itself and hands an executor the tools it resolved (`ctx.tools`), a gate over the state's modes
 * (`ctx.gate`) and the RESOLVED block itself (`ctx.authored`, upstream since declarative-ai 3f5e5cc),
 * so the permission set is read back from those ({@link viewOfServices}) — the block for what was WRITTEN
 * (implementations, a written `other`, the shell's authored mode), the tools for what is held.
 *
 * ## A state that declares no permission set is handed on untouched
 *
 * The rule is a MAP's, and a state whose `environment` chain names no permission set has made no statement
 * about tools at all — which is not the statement "nothing": an empty map removes every built-in. So
 * such a call is passed through exactly as the engine built it, the agent keeping its own tools under
 * the gate. A run tells the two apart by the marks a lowered map leaves in its `permissions.tools`
 * (`PERMISSION_SET_MARKERS` in `@jaira/shared`), read off `ctx.authored`; a conversation turn that declares
 * nothing publishes no permission set and reads the same way.
 */
import {
  finishedHandle,
  permanentFailure,
  type Executor,
  type ExecServices,
  type InlineFamily,
  type JsonValue,
  type Operation,
} from "@declarative-ai/exec";
import { emptyWorkflowMetrics, type WorkflowMetrics } from "@declarative-ai/hw";
import type { ExecPolicy, PermissionMode as GateMode, ToolGate } from "@declarative-ai/permissions";
import {
  isFunctionMode,
  isLoweredPermissionSet,
  nativesOfStandard,
  offeredTools,
  standardOfNative,
  TOOL_SPEC_BY_NAME,
  TOOL_SPECS,
  permissionSetOfEnvironment,
  unmappedNatives,
  type AgentToolDeclaration,
  type PermissionsDecl,
  type ToolImplementation,
  type PermissionSet,
  type PermissionSetMode,
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
 * Codex — `codex exec` has no per-tool deny list, no allow-list and no permission callback. What it
 * has is the sandbox, and an MCP bridge: the tools a permission set holds are served to it over the bridge
 * and every call is put to the gate there (upstream `AgentExecutor`, for a transport with no
 * callback), exactly as claude's callback puts them. So the declaration says which standard subjects
 * the WRITING sandbox unlocks, and the flag is derived from the permission set: `workspace-write` only where
 * the permission set KEEPS one of codex's own writers (`shell` for `bash`, `apply_patch` for `edit`, held
 * with `implementation: "native"`), `read-only` otherwise — ours doing the writing, under the gate.
 *
 * Its natives cannot be removed one by one: shutting the sandbox is how they are displaced.
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
 * and no channel, so a permission set that REFUSES anything cannot be held to and the call is refused.
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

// --- the permission set, as a call sees it ---------------------------------------------

/**
 * A mode as the plan reads it: what a permission set line says — a word, or a FUNCTION — or, where the line
 * says nothing, what the gate resolves to (upstream's vocabulary, which still has `smart`).
 */
export type ViewMode = PermissionSetMode | GateMode;

/** One call's permission set, reduced to the questions the plan asks of it. */
export interface PermissionSetView {
  /** Whose code runs a standard tool the permission set HOLDS; `undefined` when it does not hold it. */
  held(standard: string): ToolImplementation | undefined;
  /** The mode a standard tool resolves to, where anything says. */
  modeOf(standard: string): ViewMode | undefined;
  /** The mode a name with no standard tool resolves to — `other`, unless something named it. */
  otherFor(name: string): ViewMode | undefined;
  /**
   * Is `other` KNOWN to have been written, as against read off a gate that answers `ask` for want of
   * anything better? Only a written `ask` forces an unmapped native through the callback: forcing it
   * on a guess would put every sub-agent call of an unrestricted state in front of a person.
   */
  otherIsAuthored: boolean;
}

/** A permission set in hand — a conversation turn's. */
export function viewOfPermissionSet(permissionSet: PermissionSet): PermissionSetView {
  const offered = new Set(offeredTools(permissionSet));
  const entry = (name: string) => (Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined);
  return {
    held: (standard) => (offered.has(standard) ? (entry(standard)?.implementation ?? "app") : undefined),
    modeOf: (standard) => entry(standard)?.mode,
    otherFor: () => permissionSet.other,
    otherIsAuthored: permissionSet.other !== undefined,
  };
}

/**
 * A permission set read back off what the ENGINE hands an executor — a run's — or `undefined` when the
 * state declared none (see the module header).
 *
 * `ctx.tools` is the state's resolved tool list, so membership is exact. `ctx.authored` is the
 * state's resolved block, so what was WRITTEN is exact: a map's marks, whose code serves a tool, a
 * written `other`, and the shell's authored mode (lowered as `ask`, carried in `subjects`) — read
 * through `permissionSetOfEnvironment`, the reader a conversation turn uses for the same block. `ctx.gate`
 * resolves a mode through that block, the run's ledger and the project baseline, and answers where
 * the block says nothing.
 */
export function viewOfServices(ctx: ExecServices): PermissionSetView | undefined {
  const authored = ctx.authored as PermissionsDecl | undefined;
  if (!isLoweredPermissionSet(authored)) return undefined;
  const held = new Set(Object.keys(ctx.tools ?? {}));
  const baseline = ctx.policy?.baseline?.tools;
  const gated = (name: string): GateMode | undefined =>
    ctx.gate?.modeOf({ name }) ?? (baseline !== undefined && Object.hasOwn(baseline, name) ? baseline[name] : undefined);
  const permissionSet = permissionSetOfEnvironment([...held], authored);
  const entry = (name: string) => (Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name] : undefined);
  return {
    held: (standard) => (held.has(standard) ? (entry(standard)?.implementation ?? "app") : undefined),
    modeOf: (name) => entry(name)?.mode ?? gated(name),
    otherFor: (name) => permissionSet.other ?? gated(name),
    otherIsAuthored: permissionSet.other !== undefined,
  };
}

// --- the plan -----------------------------------------------------------------

/** What an agent should be handed, once a permission set has met a declaration. */
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
  /** Natives REMOVED: their standard tool is not in the permission set, or what answers for them is `deny`. */
  denyNatives: string[];
  /** Each declared switch, ON when the permission set holds one of its subjects un-denied. */
  switches: Record<string, boolean>;
}

/**
 * Resolve a permission set against one agent's declaration — see the module header for the rule.
 *
 * A tool marked `alwaysGranted` is held whether the permission set names it or not: its absence is an
 * omission, never a decision. It still answers to the gate.
 *
 * Takes a permission set or a {@link PermissionSetView}. The declaration defaults to claude's, which is what every
 * caller meant before there was more than one.
 */
export function planAgentTools(grant: PermissionSet | PermissionSetView, declaration: AgentToolDeclaration = CLAUDE_TOOLS): AgentToolPlan {
  const view: PermissionSetView = isView(grant) ? grant : viewOfPermissionSet(grant);
  const plan: AgentToolPlan = { inject: [], displaced: [], askNatives: [], denyNatives: [], switches: {} };
  const holds = (standard: string): ToolImplementation | undefined =>
    view.held(standard) ?? (TOOL_SPEC_BY_NAME.get(standard)?.alwaysGranted === true ? "app" : undefined);

  for (const spec of TOOL_SPECS) {
    // Named and not yet served (`ToolSpec.unserved`): nothing to inject and no agent's built-in to
    // keep or remove, whatever the permission set says about it.
    if (spec.unserved === true) continue;
    const natives = nativesOfStandard(declaration, spec.name);
    const implementation = holds(spec.name);
    if (implementation === undefined) {
      // NOT IN THE PERMISSION_SET: removed.
      plan.denyNatives.push(...natives);
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
    // A written `ask`, or a written FUNCTION: either way the callback must be reached for the call to
    // be decided — the function runs there, before anybody is asked.
    else if (view.otherIsAuthored && (mode === "ask" || mode === "smart" || isFunctionMode(mode))) plan.askNatives.push(native);
  }

  // A switch is the coarse transport's only way to keep or remove its own writers, so it is ON exactly
  // when the plan KEEPS one of the natives it unlocks — a subject held with `implementation: "native"`
  // and not denied. A subject held with OUR implementation is served over the bridge and gated there,
  // which is what displacing the native means on a transport that cannot remove one tool alone: the
  // sandbox stays shut, so the agent's own writers cannot do the job the permission set gave to ours.
  const kept = new Set(plan.askNatives);
  for (const [name, subjects] of Object.entries(declaration.switches ?? {})) {
    plan.switches[name] = subjects.some((subject) => nativesOfStandard(declaration, subject).some((native) => kept.has(native)));
  }
  return plan;
}

/** What a permission set REFUSES — the reason a transport that enforces nothing cannot run it. */
export function refusalsOf(view: PermissionSetView): string[] {
  const denied = TOOL_SPECS.filter((spec) => view.modeOf(spec.name) === "deny").map((spec) => spec.name);
  return view.otherFor("other") === "deny" ? [...denied, "other"] : denied;
}

function isView(grant: PermissionSet | PermissionSetView): grant is PermissionSetView {
  return typeof (grant as PermissionSetView).held === "function";
}

// --- the wrapper --------------------------------------------------------------

/**
 * The key a caller that KNOWS its permission set publishes it under, on the services bundle.
 *
 * A conversation turn builds its own services, so it can say exactly what the permission set is —
 * implementations included. A run cannot (see the module header) and leaves it absent.
 */
export const PERMISSION_SET_SERVICE = "jairaPermissionSet";

/** Publish a permission set on a services bundle — see {@link PERMISSION_SET_SERVICE}. */
export function withPermissionSetService<T extends object>(services: T, permissionSet: PermissionSet | undefined): T {
  return permissionSet === undefined ? services : ({ ...services, [PERMISSION_SET_SERVICE]: permissionSet } as T);
}

function permissionSetOf(ctx: ExecServices): PermissionSet | undefined {
  const value = (ctx as unknown as Record<string, unknown>)[PERMISSION_SET_SERVICE];
  return value !== null && typeof value === "object" ? (value as PermissionSet) : undefined;
}

export interface AgentPermissionSetOptions {
  /** What the transport is called in a refusal. */
  label: string;
  /** Which bag of `providerOptions` this agent reads — where an ask rule is written. */
  providerOptionsKey?: string;
  /**
   * For a `switches` transport: the executor to use for one setting of the switches, or `undefined`
   * to keep the one that was wrapped. This is how a flag that is fixed at construction is nonetheless
   * derived per call — there is one executor per setting, and the permission set picks.
   */
  switched?: (switches: Readonly<Record<string, boolean>>) => StackedExecutor | undefined;
}

/**
 * Hold ONE agent executor to the permission set of each call it answers.
 *
 *  - `tools` (claude): the removed and displaced natives reach the agent as its deny list, through
 *    the channel the executor already reads (`ctx.policy.baseline` and `ctx.gate.modeOf`); the kept
 *    ones get an ask rule in the agent's own settings; and the gate the callback consults is asked
 *    about a native by its STANDARD name, so `Read` answers to the `read_file` entry.
 *  - `switches` (codex): the executor for this setting of the switches answers, handed the held tools
 *    of ours to serve over its bridge — every call gated there — less any whose entry kept codex's own.
 *  - `none` (a generic CLI): a permission set that refuses anything is refused, by name.
 *
 * The same wrapper holds a claude agent reached as a FUNCTION: upstream's function entry takes it as
 * `wrapExecutor` (see {@link agentFunctionWrapper}), so the two ways into one agent are one code path.
 */
export function withAgentPermissionSet<E extends Executor<ExecServices, any>>(
  declaration: AgentToolDeclaration,
  inner: E,
  options: AgentPermissionSetOptions,
): E {
  const executor = inner;
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(op) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      if (op.kind !== "prompt") return executor.start(op, ctx);
      const known = permissionSetOf(ctx);
      const view = known !== undefined ? viewOfPermissionSet(known) : viewOfServices(ctx);
      // A state that declared no permission set is handed on exactly as the engine built it — see the
      // module header.
      if (view === undefined) return executor.start(op, ctx);
      const plan = planAgentTools(view, declaration);

      if (declaration.channel === "none") {
        const refused = refusalsOf(view);
        if (refused.length === 0) return executor.start(op, ctx);
        return finishedHandle(
          permanentFailure<WorkflowMetrics>(
            `${options.label}: this state's permission set refuses ${refused.map((name) => `'${name}'`).join(", ")}, and this transport ` +
              `enforces nothing — no deny list, no sandbox, no permission callback — so nothing could hold the agent to it. ` +
              `Run the state on claude-code, claude-cli or codex-cli, or drop the restriction`,
            emptyWorkflowMetrics(),
          ),
        );
      }

      if (declaration.channel === "switches") {
        return (options.switched?.(plan.switches) ?? executor).start(op, switchedServices(ctx, nativelyServed(view, declaration, ctx)));
      }

      const denied = [...new Set([...plan.displaced, ...plan.denyNatives])];
      return executor.start(
        withAskRules(op, options.providerOptionsKey ?? "claudeCode", plan.askNatives),
        servicesUnder(ctx, declaration, denied, nativelyServed(view, declaration, ctx)),
      );
    },
  } as unknown as E;
}

/**
 * The `wrapExecutor` a claude agent reached as a FUNCTION is registered with: the route's own wrapper,
 * {@link withAgentPermissionSet}, around the executor the function entry builds for each call. A function
 * call has no op of its own to write an ask rule into until the entry builds one, and this is the door
 * upstream opened at that moment — so `implementation: "native"`, the deny list and the translated
 * gate reach a function call exactly as they reach the route.
 */
export function agentFunctionWrapper(declaration: AgentToolDeclaration, label: string): <E extends Executor<ExecServices, any>>(executor: E) => E {
  return (executor) => withAgentPermissionSet(declaration, executor, { label });
}

/**
 * The services a `switches` transport (codex) is handed for a call held to a permission set: the tools of ours
 * it serves, less those whose entry kept codex's own, and a copy of the policy whose baseline names only
 * those served tools.
 *
 * The baseline is where the executor builds its up-front deny list from — every name in it the gate
 * answers `deny` — and codex has no deny list, so it refuses a run that carries one. Under a permission set the
 * names left in it are the policy's command-tool vocabulary (`shell`, `sh`, `powershell`, …) and any
 * standard tool the map does not hold, all answering to the map's `other`: none is a tool of ours codex
 * could be served, and codex's own writers are shut or kept by the SWITCH, which is where the permission set's
 * removals reach this transport. The gate itself is untouched, so every call at the bridge is still
 * decided by the whole map.
 */
function switchedServices(ctx: ExecServices, withheldNames: readonly string[]): ExecServices {
  const tools = ctx.tools === undefined ? undefined : Object.fromEntries(Object.entries(ctx.tools).filter(([name]) => !withheldNames.includes(name)));
  const baseline = ctx.policy?.baseline?.tools;
  const policy: ExecPolicy | undefined =
    ctx.policy === undefined || baseline === undefined
      ? ctx.policy
      : {
          ...ctx.policy,
          baseline: {
            ...ctx.policy.baseline,
            tools: Object.fromEntries(Object.entries(baseline).filter(([name]) => tools !== undefined && Object.hasOwn(tools, name))),
          },
        };
  return { ...ctx, ...(tools !== undefined ? { tools } : {}), ...(policy !== undefined ? { policy } : {}) };
}

/**
 * The tools in `ctx.tools` whose entry chose the agent's OWN implementation — withheld from the
 * executor, so ours is not injected beside the built-in the plan keeps.
 *
 * A lowered map still LISTS such a tool (the engine resolves the list against the registry, and the
 * gate learns the tool from it), so the engine hands ours over; only the block says whose code was
 * chosen. A conversation turn never registers it in the first place.
 */
function nativelyServed(view: PermissionSetView, declaration: AgentToolDeclaration, ctx: ExecServices): string[] {
  return Object.keys(ctx.tools ?? {}).filter((name) => view.held(name) === "native" && nativesOfStandard(declaration, name).length > 0);
}

/** A registered agent function's `run`, in the shape `runtimeFunction` takes. */
export type AgentFunctionRun = (inputs: Record<string, unknown>, ctx: ExecServices) => Promise<unknown>;

/**
 * Hold an agent reached as a FUNCTION to the permission set of each call, for the channels whose holding
 * reads the call's INPUTS. A `tools` transport (claude) is not held here: its function entry is
 * registered with {@link agentFunctionWrapper}, the route's own wrapper, because what it needs — an ask
 * rule for a kept built-in — is written into the op the entry builds, which no wrapper of `run` sees.
 *
 *  - `switches` (codex): the adapter reads its sandbox off the call's own `permissionMode` input,
 *    and `plan` is nothing but `--sandbox read-only` there — so a permission set that leaves the writing
 *    switch OFF writes `permissionMode: "plan"` over whatever the call carried, as the route picks its
 *    read-only executor. A switch that is on leaves the call as it was: the configured sandbox. The
 *    tools of ours it holds are served over the bridge, gated there, less any whose entry kept codex's
 *    own — as the route serves them.
 *  - `none` (a generic CLI): a permission set that refuses anything is refused, by name, as the route does.
 *
 * A call whose state declared no permission set is handed on untouched, as {@link withAgentPermissionSet} hands one on.
 */
export function holdAgentFunction<R extends AgentFunctionRun>(declaration: AgentToolDeclaration, run: R, label: string): R {
  if (declaration.channel === "tools") {
    throw new Error(`${label}: a \`tools\` transport is held by its route's wrapper (agentFunctionWrapper), not by its run`);
  }
  return (async (inputs: Record<string, unknown>, ctx: ExecServices) => {
    const known = permissionSetOf(ctx);
    const view = known !== undefined ? viewOfPermissionSet(known) : viewOfServices(ctx);
    if (view === undefined) return run(inputs, ctx);
    if (declaration.channel === "none") {
      const refused = refusalsOf(view);
      if (refused.length === 0) return run(inputs, ctx);
      return {
        error: {
          classification: "permanent",
          reason:
            `${label}: this state's permission set refuses ${refused.map((name) => `'${name}'`).join(", ")}, and this transport ` +
            `enforces nothing — no deny list, no sandbox, no permission callback — so nothing could hold the agent to it. ` +
            `Run the state on claude-code, claude-cli or codex-cli, or drop the restriction`,
        },
        metrics: emptyWorkflowMetrics(),
      };
    }
    const plan = planAgentTools(view, declaration);
    const shut = Object.values(plan.switches).some((on) => !on);
    return run(shut ? { ...inputs, permissionMode: "plan" } : inputs, switchedServices(ctx, nativelyServed(view, declaration, ctx)));
  }) as R;
}

/**
 * The services an agent executor reads, with the plan's removals in them and the gate translated.
 *
 * The executor builds its deny list from the names in `ctx.policy.baseline.tools` that resolve to
 * `deny`, asking `ctx.gate.modeOf` first — so a native to remove is named in the baseline AND answered
 * `deny` by the gate. Both are copies: the run's policy and the engine's gate are untouched. `withheld`
 * names tools of ours taken out of the copy of `ctx.tools` the executor is handed.
 */
export function servicesUnder(
  ctx: ExecServices,
  declaration: AgentToolDeclaration,
  denied: readonly string[],
  withheld: readonly string[] = [],
): ExecServices {
  const refused = new Set(denied);
  const tools =
    withheld.length === 0 || ctx.tools === undefined
      ? undefined
      : Object.fromEntries(Object.entries(ctx.tools).filter(([name]) => !withheld.includes(name)));
  // Untouched when there is nothing to remove: a call with no policy keeps having none.
  const policy: ExecPolicy | undefined =
    denied.length === 0
      ? ctx.policy
      : {
          ...ctx.policy,
          baseline: {
            ...ctx.policy?.baseline,
            tools: { ...ctx.policy?.baseline?.tools, ...Object.fromEntries(denied.map((native) => [native, "deny" as GateMode])) },
          },
        };
  const gate = ctx.gate === undefined ? undefined : translatedGate(ctx.gate, declaration, refused);
  return { ...ctx, ...(policy !== undefined ? { policy } : {}), ...(gate !== undefined ? { gate } : {}), ...(tools !== undefined ? { tools } : {}) };
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
        return Promise.resolve({ allow: false as const, reason: `tool '${tool.name}' is not in this state's permission set` });
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
