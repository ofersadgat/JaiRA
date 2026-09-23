/**
 * The tools JaiRA gives an agent (DESIGN §8, §10.1).
 *
 * This is what closes the policy chain. A delegated agent that calls its *own*
 * built-in shell is invisible to us; an agent calling a tool we injected goes
 * through `withPermission` → the compiled policy → our `smart` approver → the
 * command parser → allow/deny/ask. So registering `bash` here is not a
 * convenience, it is the mechanism by which SPEC §11.2/§11.3 apply to an agent at
 * all.
 *
 * Commands run through the same {@link Exec} seam as git (DESIGN §9.1), in the
 * task's workspace, so a WSL project's agent commands execute inside the distro.
 */
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
import {
  hostFunction,
  type CapabilityRegistry,
  type ExecServices,
  type FunctionInputs,
  type FunctionResult,
  type HostCapabilities,
  type JsonValue,
  type ResolvedValue,
  type Tool,
} from "@declarative-ai/exec";
import { createToolGate, isPermissionDenied, PermissionLedger, withPermission } from "@declarative-ai/permissions";
import {
  absolutize,
  ALWAYS_GRANTED_TOOLS,
  isAbsolutePath,
  nativesOfStandard,
  replacementsOf,
  withAlwaysGranted,
  normalizePath,
  permissionsOfToolset,
  resolveScope,
  resolveScopes,
  resolveUrlScope,
  scopeModeOf,
  TOOL_SPEC_BY_NAME,
  TOOL_SPECS,
  toolsetOfEnvironment,
  type AgentToolDeclaration,
  type PermissionsDecl,
  type Scope,
  type ScopeOptions,
  type Toolset,
} from "@jaira/shared";
import { CLAUDE_TOOLS, standardOfAnyNative } from "./agentTools";
import { registerFileTools, READ_FILE, WRITE_FILE, type FileToolOptions } from "./fileTools";
import { registerSearchTools } from "./searchTools";
import { registerWebTools, type WebToolOptions } from "./webTools";
import { registerWorkflowTools, type WorkflowToolHost } from "./workflowTools";
import type { Approver, ExecPolicy, PermissionMode, ScopeNarrowing, ToolGate } from "@declarative-ai/permissions";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { NodeExec, type Exec } from "./exec";
import { commandDecisionOf, commandNarrowingOf, commandWords, isDeniedPath } from "./policy";
import { refusalOf } from "./approval";
import { takeApart } from "./command";
import { dialectFor, interpreterFor, type ExecEnv } from "./paths";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.runtime.tools");

export interface ToolOptions {
  exec?: Exec;
  /** Where commands run. A WSL project runs them inside the distro. */
  execEnv?: ExecEnv;
  /** Fallback working directory when the operation has no workspace. */
  cwd?: string;
  /** Per-command timeout; a hung command would otherwise stall the run. */
  timeoutMs?: number;
  /** Cap on captured output, so a runaway command cannot balloon the transcript. */
  maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 20_000;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/**
 * A `bash` tool: run a command line in the workspace and return its output.
 *
 * `readOnly: false` is the UPSTREAM `Tool` field, and it is true of this tool. JaiRA's own vocabulary
 * no longer has such a flag (decision 0007): whether a state may run commands is whether its toolset
 * holds `bash`, and with what mode.
 */
export function createBashTool(options: ToolOptions = {}): Tool {
  const exec = options.exec ?? new NodeExec();
  return {
    description:
      "Run a shell command in the task's workspace. Subject to the project's safety policy: destructive commands are refused and some require the user's approval.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run." },
        cwd: { type: "string", description: "Optional working directory, relative to the workspace root." },
      },
      required: ["command"],
    },
    readOnly: false,
    run: async (input, ctx) => {
      const args = (input ?? {}) as { command?: unknown; cwd?: unknown };
      const command = typeof args.command === "string" ? args.command : "";
      if (command.trim().length === 0) return { error: "no command given" };

      const root = ctx?.workspace?.root ?? options.cwd;
      const relative = typeof args.cwd === "string" ? args.cwd : undefined;
      // A cwd is an escape hatch out of the workspace if it is not checked; the
      // policy denies `.jaira/**` by path, and the same rule applies here.
      if (relative !== undefined && (isDeniedPath(relative) || relative.includes(".."))) {
        return { error: `cwd '${relative}' is not allowed` };
      }
      const cwd = root !== undefined && relative !== undefined ? `${root}/${relative}` : root;

      // The model hands over ONE string, which needs an interpreter — unlike every
      // other Exec caller, which passes argv. Rather than letting Exec spawn a shell
      // (it never does, by design), the interpreter is named explicitly and the
      // command passed to it as a single argument. `interpreterFor` and the policy's
      // `dialectFor` are the same decision, so the language judged is the language
      // executed — and both follow the real host, since native execution on Linux
      // has no PowerShell.
      const env: ExecEnv = options.execEnv ?? "windows";
      const [interpreter, ...prefix] = interpreterFor(env);

      const result = await exec.run(interpreter, [...prefix, command], {
        ...(cwd !== undefined ? { cwd } : {}),
        execEnv: env,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(ctx?.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
      });

      const max = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
      return {
        exitCode: result.code,
        stdout: clamp(result.stdout, max),
        stderr: clamp(result.stderr, max),
        ...(result.timedOut ? { timedOut: true } : {}),
      };
    },
  } as Tool;
}

/** Register JaiRA's tool set on a registry's `tools` facet. */
export function registerTools(registry: { tools: Map<string, Tool> }, options: ToolOptions = {}): void {
  registry.tools.set("bash", createBashTool(options));
}

/**
 * Every tool in the vocabulary, registered in one call.
 *
 * The four registration functions exist because they need different things — a shell, an artifact
 * store, a workspace, a search endpoint — and a caller doing three of the four gets a registry that
 * is missing whatever the fourth supplies. That has already happened once: `sendChatMessage` called
 * `registerTools` alone, so ticking `read_file` in the composer reached `gateTools` and threw
 * `tool 'read_file' is not registered` — the loud failure that call raises for a name nobody
 * registered, raised instead for a missing line. Five more tools is five more chances at the same
 * mistake, so there is one door now.
 */
export function registerAllTools(
  registry: { tools: Map<string, Tool> },
  options: ToolOptions & { files: FileToolOptions; web?: WebToolOptions; /** Who serves the workflow tools. Absent ⇒ nobody: they resolve, and answer that. */ workflows?: WorkflowToolHost },
): void {
  registerTools(registry, options);
  registerFileTools(registry, options.files);
  registerSearchTools(registry, { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
  registerWebTools(registry, options.web ?? {});
  registerWorkflowTools(registry, options.workflows);
}

/** The registry name a workflow state uses to run a command directly. */
export const RUN_COMMAND = "run_command";

/**
 * A host function that runs one command — a build, a test suite, a lint — without
 * delegating to an agent.
 *
 * It gates *itself*. The engine wraps registered **tools** with `withPermission`,
 * but a host function is called directly, so a command runner that did not apply
 * the policy would be a hole straight through it. Reusing upstream's
 * `withPermission` rather than re-deriving the decision means there is exactly one
 * implementation of "resolve a mode, consult `smart`, escalate to the human".
 */
export function createRunCommandFunction(options: ToolOptions = {}): {
  capabilities: HostCapabilities;
  run: (inputs: FunctionInputs, ctx: ExecServices) => Promise<FunctionResult<ResolvedValue, WorkflowMetrics>>;
} {
  const bash = createBashTool(options);
  return {
    // Not memoizable: running a command is a side effect, and its result depends on
    // a workspace this signature does not capture.
    capabilities: { interactive: false, readOnly: false, memoizable: false },
    run: async (inputs: FunctionInputs, ctx: ExecServices): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
      const startMs = Date.now();
      const metrics = (): WorkflowMetrics => ({ startMs, durationMs: Date.now() - startMs, costUsd: 0, costSource: "unknown" });

      const config = inputs["config"];
      const fromConfig =
        config !== null && typeof config === "object" && !Array.isArray(config)
          ? (config as Record<string, unknown>)["command"]
          : undefined;
      const command = typeof fromConfig === "string" ? fromConfig : typeof inputs["command"] === "string" ? (inputs["command"] as string) : "";
      if (command.trim().length === 0) {
        return { error: { classification: "permanent", reason: "run_command needs a `command`" }, metrics: metrics() };
      }

      const policy = ctx.policy;
      const sessionId = "run_command";
      const gated = withPermission(bash, {
        ledger: new PermissionLedger({ baseline: policy?.baseline ?? {} }),
        sessionId,
        toolName: "bash",
        // With no approver wired, an `ask` denies — the same unattended default the
        // approval hub applies.
        approve: ctx.approve ?? (() => ({ decision: "deny", scope: "once" })),
        ...(policy?.smart?.["bash"] !== undefined ? { smart: policy.smart["bash"] } : {}),
        ...(policy?.profiles !== undefined ? { profiles: policy.profiles } : {}),
      });

      // Held on to: the policy keeps its decision about the line, and the approver its reason for a
      // refusal, against this very object — which is how the refusal below can say WHY.
      const input = { command };
      const result = (await gated.run(input, ctx)) as JsonValue;
      if (isPermissionDenied(result)) {
        // A refusal is the state's outcome, classified — not an exception, and not a
        // silent success either.
        return { error: { classification: "permanent", reason: `command refused: ${refusalReason(input, result.reason)}` }, metrics: metrics() };
      }
      return { value: result as ResolvedValue, metrics: metrics() };
    },
  };
}

/**
 * Why a `run_command` line was refused, in words a person can act on.
 *
 * Upstream's refusal says only that the tool was "denied by permission policy". The policy's own
 * decision about the line says what it was (`git push` — pushes publish work), and an approver that
 * refused without a person says why nobody was asked and what would let the line run; either is kept
 * against the call's input. Upstream's sentence is the fallback when neither said anything.
 */
function refusalReason(input: object, fallback: string): string {
  const decided = commandDecisionOf(input);
  const policy = decided !== undefined && decided.action !== "allow" ? decided.reason : undefined;
  const approver = refusalOf(input);
  if (policy === undefined) return approver ?? fallback;
  return approver !== undefined ? `${policy}; ${approver}` : policy;
}

/** Register the command-running function on a registry's `functions` facet. */
export function registerCommandFunction(
  registry: CapabilityRegistry<WorkflowMetrics>,
  options: ToolOptions = {},
): void {
  const fn = createRunCommandFunction(options);
  registry.functions.set(RUN_COMMAND, hostFunction(fn.run, fn.capabilities));
}

/**
 * Resolve tool names to CALLABLE tools, each already under the policy.
 *
 * The engine does this for a state's operation (`resolveTools`), and nothing outside the engine
 * could — which is why a hand-continued turn ran without tools at all for a while. That was a false
 * dichotomy: the choice looked like "duplicate the guard or go without", and the third option is the
 * one {@link createRunCommandFunction} already takes — reuse `withPermission`, the same primitive the
 * engine reuses, so there is still exactly one implementation of "resolve a mode, consult `smart`,
 * escalate to the human".
 *
 * JaiRA owns both halves here: it registered the tools and it compiled the policy, so it always
 * knows what it is handing over. A name it cannot resolve is an ERROR rather than a silent omission —
 * a turn that quietly ran without the tool it was promised is the failure worth being loud about.
 *
 * ## Both halves of the surface, because the route is not known yet
 *
 * The tools come back WRAPPED and a {@link ToolGate} comes back beside them, and both are needed
 * because this runs before anything has decided which executor answers. Wrapping is the safe default:
 * an unwrapped tool reaching a `policyEnforcement: "none"` executor is an ungated tool. But if the
 * route turns out to be a delegated AGENT, that agent arrives with its OWN Bash and Write, which no
 * wrapper here can reach — it gates those through the gate, or not at all.
 *
 * The wrapped names are declared `preGated` so the two do not both fire on one call: the agent
 * pre-approves them at configuration and the wrapper makes the real decision when the tool runs.
 */
export function gateTools(options: {
  registry: { tools: Map<string, Tool> };
  /** The names the operation asked for. Empty ⇒ no tools, which is a real answer. */
  names: readonly string[];
  /** The conversation these permissions are remembered against — one ledger per session. */
  sessionId: string;
  policy?: ExecPolicy | undefined;
  approve?: Approver | undefined;
  /**
   * The operation's own `permissions` block, in the LOWERED shape a loaded state holds. Read back
   * into a toolset with `names` as the list when no {@link toolset} is handed over — see there. Its
   * `scopes` are read either way: where a tool may act is not part of a toolset.
   */
  authored?: PermissionsDecl | undefined;
  /**
   * The toolset this turn runs under — the ONE map the modes are read from (decision 0007).
   *
   * When absent it is read back from `names` and `authored` (`toolsetOfEnvironment`): a listed tool
   * takes `authored.tools[name]`, and a turn that declared no toolset lists only the always-granted
   * tools with no mode, which resolve through the baseline. Only TOOL entries are read HERE. A toolset's command subjects and
   * `script` ride on the block handed to the gate and to each wrapped tool, where the policy's
   * narrowing reads them to judge a shell line part by part (decision 0007 §4) — which is also why
   * the shell's own mode reaches both as `smart`: see `gateToolModes`.
   */
  toolset?: Toolset | undefined;
  /** What a relative scope glob and a relative call path are resolved against. */
  workspaceRoot?: string | undefined;
  /**
   * The executor's own scope table — the FLOOR, which the operation's `scopes` narrows within.
   *
   * Composed as two narrowings rather than merged: a state that allows what the floor denies is
   * still denied, which is what "a state may narrow, never widen" has to mean.
   */
  scopeFloor?: readonly Scope[] | undefined;
}): { tools: Record<string, Tool>; gate: ToolGate } {
  const ledger = new PermissionLedger({ baseline: options.policy?.baseline ?? {} });
  const toolset = options.toolset ?? toolsetOfEnvironment(options.names, options.authored);
  // The block the upstream gate takes, written FROM the map. Absent when nothing was authored at all.
  const authored =
    options.toolset === undefined && options.authored === undefined ? undefined : permissionsOfToolset(toolset, options.authored?.scopes);
  // With no approver wired, an `ask` denies — the same unattended default the approval hub takes.
  const approve: Approver = options.approve ?? (() => ({ decision: "deny", scope: "once" }));
  const placeNarrowing = scopeNarrowingFor(options.authored?.scopes, options.workspaceRoot, undefined, options.scopeFloor);
  // A shell line is taken apart and judged part by part against this turn's toolset (decision 0007
  // §4). That judgement is the policy's, and it has to NARROW rather than only advise: an "allow for
  // this turn" remembered against the whole tool must not wave through the next line's asking parts.
  const lineNarrowing = commandNarrowingOf(options.policy);
  const scopeNarrowing: ScopeNarrowing | undefined =
    placeNarrowing === undefined || lineNarrowing === undefined
      ? (placeNarrowing ?? lineNarrowing)
      : (tool, input, block) => {
          const where = placeNarrowing(tool, input, block);
          const what = lineNarrowing(tool, input, block);
          return where === undefined || what === undefined ? (where ?? what) : strictestOf(where, what);
        };
  /** One gate over the SAME ledger, so a decision made at either end is remembered at both. */
  const gate = createToolGate({
    ledger,
    sessionId: options.sessionId,
    approve,
    preGated: options.names,
    ...(authored !== undefined ? { authored } : {}),
    ...(options.policy?.smart !== undefined ? { smart: options.policy.smart } : {}),
    // No profile tables (decision 0007 §1). What they existed for — an opinion about a name the gate
    // has never registered — is the toolset's `other`, which rides on `authored`.
    ...(options.policy?.profiles !== undefined ? { profiles: options.policy.profiles } : {}),
    ...(scopeNarrowing !== undefined ? { scopeOf: scopeNarrowing } : {}),
  });
  if (options.names.length === 0) return { tools: {}, gate };
  const out: Record<string, Tool> = {};
  for (const name of options.names) {
    const tool = options.registry.tools.get(name);
    if (tool === undefined) throw refusal(log, `tool '${name}' is not registered`);
    // OWN entries only. The map is keyed by TOOL NAME, so a tool called `constructor` would
    // otherwise resolve its mode — and its smart rule — to a prototype member.
    // Read off the LOWERED block where there is one, so the wrapper and the gate resolve one mode:
    // the shell's entry is `smart` there, its authored mode being what a line's parts fall to.
    const lowered = authored?.tools !== undefined && Object.hasOwn(authored.tools, name) ? authored.tools[name] : undefined;
    const authoredMode = lowered ?? (Object.hasOwn(toolset.entries, name) ? toolset.entries[name]!.mode : undefined);
    out[name] = withPermission(tool, {
      ledger,
      sessionId: options.sessionId,
      toolName: name,
      approve,
      ...(authoredMode !== undefined ? { authoredMode } : {}),
      // The block itself, so the narrowing sees the toolset's command subjects at the moment of decision.
      ...(authored !== undefined ? { authored } : {}),
      ...(options.policy?.smart?.[name] !== undefined ? { smart: options.policy.smart[name] } : {}),
      ...(options.policy?.profiles !== undefined ? { profiles: options.policy.profiles } : {}),
      // The SAME narrowing the gate applies. A wrapped tool and a delegated one are two routes to one
      // decision, and a scope that bound only one of them would be a sandbox with a door in it.
      ...(scopeNarrowing !== undefined ? { scopeOf: scopeNarrowing } : {}),
    });
  }
  return { tools: out, gate };
}

/**
 * Every tool JaiRA can put under its OWN policy.
 *
 * DERIVED from `TOOL_SPECS` rather than restated. It was a hand-written list of three, and being
 * hand-written is how it came to be a list of three: `glob`, `grep`, `edit` and the two web tools
 * were things an agent did that nothing here had a name for, so nothing here could gate them. One
 * table now, in `shared`, because the menu that draws these and the toolset that governs them need
 * the same answer — and a second copy is a second thing to forget to update.
 *
 * `tools.test.ts` asserts this against what {@link registerTools} and its siblings actually build,
 * which is what keeps the vocabulary and the implementations from drifting apart in the other
 * direction: a name here with nothing behind it is a permission somebody can grant and no tool can
 * honour.
 */
export const JAIRA_TOOLS: readonly { name: string }[] = TOOL_SPECS.filter((spec) => spec.nativeOnly !== true && spec.unserved !== true).map(
  // `unserved`: a name a toolset may hold with nothing behind it YET (the workflow tools, decision
  // 0005 §3). Not gateable until something registers it — which is exactly what this list means.
  (spec) => ({ name: spec.name }),
);

/** Just the names — the shape most callers want. */
export const JAIRA_TOOL_NAMES = JAIRA_TOOLS.map((t) => t.name);

/**
 * Claude Code's own READING built-ins, as the names its permission rules are written against —
 * read off what the claude executor declares (`agentTools.ts`), for the standard tools that read.
 *
 * What this is is the LIST OF NAMES needed to say "ask me about these", which is a thing you can
 * only say by naming them. It is the READ ones that were the surprise: a real run globbed and read
 * twenty files and nothing asked, because in its default mode Claude Code auto-allows its own
 * read-only built-ins and never routes them to the permission callback at all.
 */
export const CLAUDE_NATIVE_READ_TOOLS: readonly string[] = ["read_file", "glob", "grep", "web_fetch", "web_search"].flatMap(
  (standard) => nativesOfStandard(CLAUDE_TOOLS, standard),
);

/**
 * The provider options that make a delegated Claude agent ASK about tools it would otherwise decide
 * for itself — the missing half of `policyEnforcement: "callback"`.
 *
 * The callback was never the problem: the MCP bridge starts, `--permission-prompt-tool` is passed
 * and still accepted, and our gate is reachable. What decides whether the gate is CONSULTED is
 * Claude Code's own policy, and in its default mode that policy answers "yes, obviously" for every
 * read its built-ins perform. A permission callback that is only invoked for the calls the agent
 * already thought were worth asking about is not a gate, it is a second opinion.
 *
 * `permissions.ask` is the rule list that overrides it, and it reaches both transports through the
 * `settings` escape hatch they already carry (`--settings <json>` on the CLI, the SDK's own settings
 * bag). Verified against `claude 2.1.142`: with `{"permissions":{"ask":["Read"]}}` and no permission
 * channel, a `-p` run that would have read a file instead answers that it needs permission.
 *
 * Authored on a state's `providerOptions`, so it is a per-state decision rather than a posture:
 *
 * ```json
 * "providerOptions": { "claudeCode": { "settings": { "permissions": { "ask": ["Read", "Glob"] } } } }
 * ```
 *
 * ⚠️ Turning this on means every one of those calls reaches JaiRA's gate, which is asked about a
 * native by its STANDARD name (`withAgentToolset`) — so `Read` answers to the state's `read_file`
 * entry, and a tool the toolset does not hold was removed before it could be asked about.
 */
export function claudeAskSettings(tools: readonly string[]): Record<string, JsonValue> {
  return claudePermissionSettings({ ask: tools });
}

/**
 * The same, for a whole posture: what the agent must ask about, and what it may not have at all.
 *
 * Precedence inside Claude Code is `deny > ask > allow`, so the two lists compose without ordering
 * care — a name in both is denied, which is the answer that should win.
 */
export function claudePermissionSettings(rules: {
  allow?: readonly string[];
  ask?: readonly string[];
  deny?: readonly string[];
}): Record<string, JsonValue> {
  const permissions: Record<string, unknown> = {};
  if (rules.allow !== undefined && rules.allow.length > 0) permissions["allow"] = [...rules.allow];
  if (rules.ask !== undefined && rules.ask.length > 0) permissions["ask"] = [...rules.ask];
  if (rules.deny !== undefined && rules.deny.length > 0) permissions["deny"] = [...rules.deny];
  if (Object.keys(permissions).length === 0) return {};
  return { claudeCode: { settings: { permissions } } } as unknown as Record<string, JsonValue>;
}

/**
 * Fold the always-granted tools into every prompt state of a bundle, in place.
 *
 * The chat path gets this through `planAgentTools`, which is the one function standing between a
 * grant and what an agent is handed. A RUN does not go through it: the engine resolves a state's
 * `environment.tools` against the registry itself, so a workflow authored before this tool existed
 * would keep drawing HTML into its answer forever. This is the run's equivalent, applied where the
 * bundle is already being walked for capabilities.
 *
 * Two restrictions, both load-bearing:
 *
 *  - **Prompt states only.** A function operation has no agent to hand a tool to, and writing
 *    `environment.tools` onto one would declare a capability against something that cannot call it.
 *  - **In place, on the RESOLVED bundle**, not on the workflow on disk. What somebody authored is not
 *    edited by running it; a pinned snapshot re-run through a newer build picks this up the same way
 *    a fresh one does, because it is applied at run start rather than baked at author time.
 *
 * A state that names the tool explicitly is untouched — including one that names it in order to
 * `deny` it, since the deny lives in `permissions`, not here, and this only ever adds to the list.
 */
export function grantAlwaysGrantedTools(states: Record<string, unknown>): void {
  if (ALWAYS_GRANTED_TOOLS.length === 0) return;
  for (const def of Object.values(states)) {
    if (def === null || typeof def !== "object") continue;
    const state = def as { operation?: { kind?: string }; environment?: { tools?: unknown } };
    if (state.operation?.kind !== "prompt") continue;
    const env = (state.environment ??= {});
    // Absent means "no JaiRA tools were declared", which is a real answer and stays one for
    // everything else — this adds the one tool whose absence was never a decision.
    env.tools = withAlwaysGranted(Array.isArray(env.tools) ? (env.tools as string[]) : []);
  }
}

/**
 * Which of the agent's built-ins each of our tools stands in for — upstream's `replacesNative`.
 *
 * Read off the claude executor's DECLARATION rather than written out, so a native added there is
 * displaced without anybody remembering a second list — `edit` displaces `Edit`, `MultiEdit` and
 * `NotebookEdit`. Naming a built-in here puts it on `disallowedTools` whenever our counterpart is
 * injected, which the agent checks BEFORE its allow-list — so the substitution is real rather than an
 * offer the model declines.
 */
export function claudeReplacements(): Record<string, string[]> {
  return replacementsOf(CLAUDE_TOOLS);
}

/**
 * The `scopeOf` a permission gate takes, built from an authored scope table.
 *
 * The seam upstream deliberately left open: it takes a callback rather than a table because which
 * argument of a tool names a place — and whether that place is inside somebody's sandbox — is a
 * question only this side can answer. Here the vocabulary answers the first half
 * ({@link ToolSpec.pathArgs}) and `scopeModeOf` the second.
 *
 * `undefined` when there is no table, so a project that has authored no scopes pays nothing and
 * behaves exactly as it did. And `undefined` PER CALL for a tool that names no place, which is what
 * keeps the narrowing from refusing calls it has no opinion about.
 */
export function scopeNarrowingFor(
  scopes: readonly Scope[] | undefined,
  workspaceRoot: string | undefined,
  execEnv: ExecEnv = "windows",
  floor?: readonly Scope[] | undefined,
  /** Build the callback even with no static table, because a state may author one per call. */
  perCall = false,
): ScopeNarrowing | undefined {
  const both = [...(floor ?? []), ...(scopes ?? [])];
  // Built even with nothing here, when a caller may still supply a per-state table at call time.
  if (both.length === 0 && !perCall) return undefined;
  const options = { ...(workspaceRoot !== undefined ? { root: workspaceRoot } : {}) };
  return (tool, input, authored) => {
    // A state's OWN table, handed over by the engine at the moment of decision. Layered under the
    // floor exactly as a statically-supplied one is — a state narrows, never widens.
    const stateScopes = authored?.scopes !== undefined && authored.scopes.length > 0
      ? ([...(scopes ?? []), ...authored.scopes] as readonly Scope[])
      : scopes;
    // By LOGICAL name, whichever implementation called: a gate asked about the agent's own `Glob`
    // resolves the table written for `glob`. Without this the two spellings would be two policies.
    const name = TOOL_SPEC_BY_NAME.has(tool.name) ? tool.name : (standardOfAnyNative(tool.name) ?? tool.name);

    // A SHELL COMMAND is about more than one place, and the ordinary extractor cannot see them: its
    // paths are inside a string. See `commandSubjects` — the cwd it runs in plus every path it
    // names, strictest winning, with `cd` moving the directory for what follows it.
    if (name === "bash") {
      const args = (input ?? {}) as { command?: unknown; cwd?: unknown };
      if (typeof args.command === "string" && workspaceRoot !== undefined) {
        const cwd = typeof args.cwd === "string" && args.cwd !== "" ? absolutize(args.cwd, workspaceRoot) : workspaceRoot;
        const subjects = commandSubjects(args.command, cwd, execEnv);
        // A line nothing could parse is already `ask` under the policy's own rule; resolving its cwd
        // alone would be a quieter answer than the one the parser already gives.
        const mode = strictest2(floor, stateScopes, name, subjects.paths, options);
        return subjects.unparsed ? strictestOf(mode, "ask") : mode;
      }
    }
    // Each layer resolved on its own and the stricter kept — see `layeredScopeMode`. Merging the two
    // tables into one list would let a state's specific entry outrank the floor's, which is exactly
    // the widening the floor exists to forbid.
    const spec = TOOL_SPEC_BY_NAME.get(name);
    const hasFloor = floor !== undefined && floor.length > 0;
    const fromFloor = hasFloor ? scopeModeOf(floor, spec, name, input, options) : undefined;
    const fromState =
      stateScopes === undefined || stateScopes.length === 0
        ? undefined
        : scopeModeOf(stateScopes, spec, name, input, { ...options, unmatched: hasFloor ? "silent" : "deny" });
    if (fromFloor === undefined) return fromState;
    if (fromState === undefined) return fromFloor;
    return strictestOf(fromFloor, fromState);
  };
}

/** The strictest verdict across two layers for a set of paths — the `bash` case of the above. */
function strictest2(
  floor: readonly Scope[] | undefined,
  scopes: readonly Scope[] | undefined,
  tool: string,
  paths: readonly string[],
  options: ScopeOptions,
): PermissionMode {
  const modes: PermissionMode[] = [];
  const hasFloor = floor !== undefined && floor.length > 0;
  if (hasFloor) modes.push(resolveScopes(floor, tool, paths, options) as PermissionMode);
  if (scopes !== undefined && scopes.length > 0) {
    modes.push(resolveScopes(scopes, tool, paths, { ...options, unmatched: hasFloor ? "silent" : "deny" }) as PermissionMode);
  }
  return modes.reduce((a, b) => strictestOf(a, b), "allow" as PermissionMode);
}

/** `deny` ▸ `ask` ▸ `smart` ▸ `allow`, for the one place here that composes two modes. */
function strictestOf(a: PermissionMode, b: PermissionMode): PermissionMode {
  const rank: Record<PermissionMode, number> = { allow: 0, smart: 1, ask: 2, deny: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * The places a shell command is about — its working directory, and every path it names.
 *
 * The sandbox for a command is where it RUNS, so the cwd is always in the set rather than a fallback
 * when no path is named: a command naming one innocuous file while running somewhere it should not
 * be is still running somewhere it should not be. Every path argument joins it, and the caller takes
 * the strictest — `cp code/app/x infra/x` is an `infra/**` call however permissive the source is.
 *
 * `cd` MOVES the working directory for the commands after it on the line. The parser already splits
 * a line into its commands, so this walks them in order and carries the directory along; `cd infra
 * && rm -rf .` is judged at `infra/`, which is the whole reason to track it.
 *
 * Extraction is best-effort BY CONSTRUCTION, and the failure direction is what makes that
 * acceptable: an argument that looks like a path is treated as one, and a line the parser cannot
 * model at all is already `ask` under the existing "unparsable ⇒ ask" rule. A missed path costs a
 * prompt, never a silent pass.
 */
export function commandSubjects(
  command: string,
  cwd: string,
  execEnv: ExecEnv = "windows",
): { paths: string[]; unparsed: boolean } {
  const parsed = takeApart(command, dialectFor(execEnv));
  if (parsed.unparsed) return { paths: [cwd], unparsed: true };
  const paths = new Set<string>([cwd]);
  let here = cwd;
  for (const request of parsed.requests) {
    // A redirect's target is a place the line is about, as much as any argument is.
    if (request.kind === "redirect") paths.add(resolveAgainst(here, request.target));
    if (request.kind !== "command") continue;
    const one = request.command;
    const words = commandWords(one);
    if (one.program === "cd" || one.program === "pushd") {
      const target = words[0];
      if (target !== undefined) here = resolveAgainst(here, target);
      paths.add(here);
      continue;
    }
    paths.add(here);
    for (const word of words) {
      // A path is an argument that names a place: one with a separator, or an absolute one. A bare
      // word is far more often a subcommand, a branch name or a pattern, and treating those as paths
      // would resolve `git push origin main` against `./origin` and `./main`.
      if (word.includes("/") || word.includes("\\") || isAbsolutePath(word)) paths.add(resolveAgainst(here, word));
    }
  }
  return { paths: [...paths], unparsed: false };
}

/**
 * What the scope tables say about ONE PART of a shell line, by the standard tool the part is
 * (decision 0007 §4): `rm x` and `> x` are asked about as `write_file` at `x`, `curl <url>` as
 * `web_fetch` at the url — so a table written for the tools binds the shell exactly as it binds them.
 *
 * Layered as every other narrowing here is: the floor and the state's table each resolved on their
 * own, the stricter kept, the state's silent where it says nothing under a floor. `undefined` with no
 * table at all.
 */
export function partScopeFor(
  scopes: readonly Scope[] | undefined,
  workspaceRoot: string | undefined,
  floor?: readonly Scope[] | undefined,
): ((tool: string, place: { path?: string; url?: string }) => PermissionMode | undefined) | undefined {
  const hasFloor = floor !== undefined && floor.length > 0;
  const hasScopes = scopes !== undefined && scopes.length > 0;
  if (!hasFloor && !hasScopes) return undefined;
  const options: ScopeOptions = { ...(workspaceRoot !== undefined ? { root: workspaceRoot } : {}) };
  return (tool, place) => {
    const resolve = (table: readonly Scope[], layer: ScopeOptions): PermissionMode | undefined =>
      (place.path !== undefined ? resolveScope(table, tool, place.path, layer) : place.url !== undefined ? resolveUrlScope(table, tool, place.url, layer) : undefined) as
        | PermissionMode
        | undefined;
    const fromFloor = hasFloor ? resolve(floor, options) : undefined;
    const fromState = hasScopes ? resolve(scopes, { ...options, unmatched: hasFloor ? "silent" : "deny" }) : undefined;
    if (fromFloor === undefined || fromState === undefined) return fromFloor ?? fromState;
    return strictestOf(fromFloor, fromState);
  };
}

/** One argument, resolved against the directory the command runs in. */
function resolveAgainst(cwd: string, value: string): string {
  return isAbsolutePath(value) ? normalizePath(value) : absolutize(value, cwd);
}

/**
 * A scope table, compiled into the agent's OWN permission rules.
 *
 * Verified against `claude 2.1.142`: its rules are path-scoped — `deny: ["Read(outside/**)"]` refuses
 * a read outside and lets the neighbouring one through. So a table need not be enforced one callback
 * at a time; it can be handed over, and the agent bounds its own built-ins up front. Our callback
 * stays underneath for everything the rule syntax cannot express — `bash` above all, whose paths
 * live inside a string.
 *
 * PRECEDENCE IS `deny > ask > allow`, which is why every rule emitted here is scoped. A bare
 * `ask: ["Read"]` would beat a specific `allow: ["Read(work/**)"]` and turn a narrow table into a
 * blanket prompt — the trap that made a first live test read as "path rules do not work".
 *
 * Only tools with a native name and a path argument compile: a rule can only name what the agent
 * calls it, and can only scope what its arguments carry. The native names are the claude executor's
 * own declaration, and EVERY native of a standard tool gets the rule — a table that bounded `Edit`
 * and said nothing about `MultiEdit` would be a sandbox with a door in it.
 */
export function compileClaudeScopeRules(
  scopes: readonly Scope[],
  options: { root?: string | undefined; declaration?: AgentToolDeclaration | undefined } = {},
): { allow: string[]; ask: string[]; deny: string[] } {
  const declaration = options.declaration ?? CLAUDE_TOOLS;
  const out = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
  for (const scope of scopes) {
    if (scope.path === undefined || scope.path === "") continue;
    const glob = absolutize(scope.path, options.root);
    for (const spec of TOOL_SPECS) {
      if ((spec.pathArgs ?? []).length === 0) continue;
      const mode = scope.tools?.[spec.name] ?? scope.default;
      // `smart` inspects the call, so it cannot be a rule — it has to reach our callback to be
      // decided at all. Emitting it as `ask` would be a lie about who decides.
      if (mode === undefined || mode === "smart") continue;
      for (const native of nativesOfStandard(declaration, spec.name)) {
        const rule = `${native}(${glob})`;
        if (mode === "allow") out.allow.push(rule);
        else if (mode === "ask") out.ask.push(rule);
        else out.deny.push(rule);
      }
    }
  }
  return out;
}
