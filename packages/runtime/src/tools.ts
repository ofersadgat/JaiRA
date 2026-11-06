/**
 * The tools JaiRA gives an agent (DESIGN §8, §10.1).
 *
 * This is what closes the policy chain. A delegated agent that calls its *own*
 * built-in shell is invisible to us; an agent calling a tool we injected goes
 * through `withPermission` → the compiled policy → our `smart` approver → the
 * command parser → allow/deny/ask. So registering `shell` here is not a
 * convenience, it is the mechanism by which SPEC §11.2/§11.3 apply to an agent at
 * all.
 *
 * Commands run through the same {@link Exec} seam as git (DESIGN §9.1), in the
 * task's workspace, so a WSL project's agent commands execute inside the distro.
 */
import { createLogger } from "@declarative-ai/log";
import { DIRECTORY_CHANGERS, refusal, takeApart, type CommandDialect } from "@jaira/shared";
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
  callPlacesOf,
  gateModeOf,
  isAbsolutePath,
  isFunctionMode,
  MODE_WHEN_UNSET,
  modeStrictness,
  nativesOfStandard,
  OTHER_SUBJECT,
  placeKindOf,
  replacementsOf,
  resolvePlaces,
  withAlwaysGranted,
  normalizePath,
  permissionsOfPermissionSet,
  resolveScope,
  resolveScopes,
  resolveUrlScope,
  scopeModeOf,
  TOOL_SPEC_BY_NAME,
  TOOL_SPECS,
  permissionSetOfEnvironment,
  isLoweredPermissionSet,
  isPermissionSetMarkKey,
  layerOfLine,
  placeWidthsOf,
  type AgentToolDeclaration,
  type CommandPart,
  type PermissionsDecl,
  type PermissionSetMode,
  type PlaceOptions,
  type Scope,
  type ScopeOptions,
  type PermissionSet,
  type PermissionStackDecl,
} from "@jaira/shared";
import { namedPlacesOf, placesForCall } from "./linePlaces";
import { CLAUDE_TOOLS, standardOfAnyNative } from "./agentTools";
import { callDialectOf } from "./callDialect";
import { registerFileTools, READ_FILE, SHOW_ARTIFACT, WRITE_FILE, type FileToolOptions } from "./fileTools";
import { publishedReadsOf } from "./showArtifact";
import { registerSearchTools } from "./searchTools";
import { registerWebTools, type WebToolOptions } from "./webTools";
import { registerWorkflowTools, type WorkflowToolHost } from "./workflowTools";
import { registerGitTools, type GitToolHost } from "./gitTools";
import { registerSystemTools, type SystemToolOptions } from "./systemTools";
import type { Approver, ExecPolicy, PermissionMode, ScopeNarrowing, ToolGate, WithPermissionOptions } from "@declarative-ai/permissions";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { NodeExec, type Exec } from "./exec";
import {
  approvalStackOf,
  commandDecisionOf,
  commandNarrowingOf,
  commandWords,
  isDeniedPath,
  noteFunctionCall,
  notePlaceAnswer,
  packageFolderOf,
  setCommandDecision,
  type CommandDecision,
  type CommandGrants,
} from "./policy";
import type { PackageReader } from "./packageScripts";
import { refusalOf } from "./approval";
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
 * The `shell` tool: run a command line in the workspace and return its output — in the shell the
 * project runs (`interpreterFor`: bash in WSL, PowerShell on Windows), which is the language the policy
 * reads the line in (`dialectFor`).
 *
 * `readOnly: false` is the UPSTREAM `Tool` field, and it is true of this tool. JaiRA's own vocabulary
 * no longer has such a flag (decision 0007): whether a state may run commands is whether its permission set
 * holds `shell`, and with what mode.
 */
export function createShellTool(options: ToolOptions = {}): Tool {
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
  registry.tools.set("shell", createShellTool(options));
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
  options: ToolOptions & {
    files: FileToolOptions;
    web?: WebToolOptions;
    /** Who serves the workflow tools. Absent ⇒ nobody: they resolve, and answer that. */
    workflows?: WorkflowToolHost;
    /** Who serves the Git tools (decision 0010 §1). Absent ⇒ nobody, the same way. */
    git?: GitToolHost;
    /** The System tools' (decision 0019): this machine, by default. */
    system?: SystemToolOptions;
  },
): void {
  registerTools(registry, options);
  registerFileTools(registry, options.files);
  registerSearchTools(registry, { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
  registerWebTools(registry, options.web ?? {});
  registerWorkflowTools(registry, options.workflows);
  registerGitTools(registry, options.git);
  registerSystemTools(registry, options.system);
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
  const shell = createShellTool(options);
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
      const gated = withPermission(shell, {
        ledger: new PermissionLedger({ baseline: policy?.baseline ?? {} }),
        sessionId,
        toolName: "shell",
        // With no approver wired, an `ask` denies — the same unattended default the
        // approval hub applies.
        approve: ctx.approve ?? (() => ({ decision: "deny", scope: "once" })),
        ...(policy?.smart?.["shell"] !== undefined ? { smart: policy.smart["shell"] } : {}),
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
   * into a permission set with `names` as the list when no {@link permission set} is handed over — see
   * there. Where a tool may act is on the set's lines (`places`), so nothing else of it is read.
   */
  authored?: PermissionsDecl | undefined;
  /**
   * The permission set this turn runs under — the ONE map the modes are read from (decision 0007).
   *
   * When absent it is read back from `names` and `authored` (`permissionSetOfEnvironment`): a listed tool
   * takes `authored.tools[name]`, and a turn that declared no permission set lists only the always-granted
   * tools with no mode, which resolve through the baseline. Only TOOL entries are read HERE. A permission set's command subjects and
   * `script` ride on the block handed to the gate and to each wrapped tool, where the policy's
   * narrowing reads them to judge a shell line part by part (decision 0007 §4) — which is also why
   * the shell's own mode reaches both as `ask`: see `gateToolModes`.
   *
   * A FUNCTION is asked at each decision, by the gate and by every wrapped tool, and nothing it said
   * is kept: what lets a person switch a conversation to another permission set mid-turn and have the
   * very next call decided under it. Only the MODES move — which tools were handed over is settled
   * when the turn starts, so a tool the turn began without is not offered by a switch that allows it.
   * A function answering `undefined` is a turn that declares none, read back from `names` as above.
   */
  permissionSet?: PermissionSet | (() => PermissionSet | undefined) | undefined;
  /**
   * The stack {@link permissionSet} was composed from (decision 0023 §2.6) — written on the block the
   * gate takes, so a part's row names the layer that decided it and an approval lists the stack. A
   * function, like the set, because the two move together when the person picks mid-turn.
   */
  stack?: PermissionStackDecl | (() => PermissionStackDecl | undefined) | undefined;
  /** What a relative scope glob and a relative call path are resolved against. */
  workspaceRoot?: string | undefined;
  /**
   * The executor's own scope table — the FLOOR (decision 0023 §7.2), which no permission set widens.
   *
   * Composed with the line's own narrowing rather than merged: a set whose place allows what the floor
   * denies is still denied.
   */
  scopeFloor?: readonly Scope[] | undefined;
}): { tools: Record<string, Tool>; gate: ToolGate; authored: () => PermissionsDecl | undefined } {
  const ledger = new PermissionLedger({ baseline: options.policy?.baseline ?? {} });
  /**
   * The map as it stands at this decision — see `permissionSet` — and the block the upstream gate
   * takes, written FROM it. The block is absent when nothing was authored at all.
   */
  const now = (): { permissionSet: PermissionSet; authored: PermissionsDecl | undefined } => {
    const given = typeof options.permissionSet === "function" ? options.permissionSet() : options.permissionSet;
    const permissionSet = given ?? permissionSetOfEnvironment(options.names, options.authored);
    const stack = given === undefined ? undefined : typeof options.stack === "function" ? options.stack() : options.stack;
    const authored = given === undefined && options.authored === undefined ? undefined : permissionsOfPermissionSet(permissionSet, undefined, stack);
    return { permissionSet, authored };
  };
  // With no approver wired, an `ask` denies — the same unattended default the approval hub takes.
  const approve: Approver = options.approve ?? (() => ({ decision: "deny", scope: "once" }));
  // The executor's floor. A line's PLACES are the policy's narrowing's (`placeNarrowingFor`, folded
  // into `commandNarrowingOf`), read off the block below at each call.
  const placeNarrowing = scopeNarrowingFor(options.scopeFloor, options.workspaceRoot);
  // A shell line is taken apart and judged part by part against this turn's permission set (decision 0007
  // §4). That judgement is the policy's, and it has to NARROW rather than only advise: an "allow for
  // this turn" remembered against the whole tool must not wave through the next line's asking parts.
  //
  // Without a compiled policy there is no line narrowing — but a line's places still narrow a direct
  // call: the gate is handed each tool line at its LOOSEST answer (decision 0023 §3.10), and only the
  // per-call narrowing brings a call down to its own.
  const lineNarrowing = commandNarrowingOf(options.policy) ?? placeNarrowingFor(options.workspaceRoot !== undefined ? { root: options.workspaceRoot, named: namedPlacesOf(options.workspaceRoot) } : {});
  const scopeNarrowing: ScopeNarrowing | undefined =
    placeNarrowing === undefined || lineNarrowing === undefined
      ? (placeNarrowing ?? lineNarrowing)
      : Object.assign(
          (tool: { name: string; readOnly?: boolean }, input: FunctionInputs, block: Parameters<ScopeNarrowing>[2]) => {
            const where = placeNarrowing(tool, input, block);
            const what = lineNarrowing(tool, input, block);
            return where === undefined || what === undefined ? (where ?? what) : strictestOf(where, what);
          },
          { narrows: (tool: { name: string; readOnly?: boolean }, block: Parameters<ScopeNarrowing>[2]) => mayNarrow(placeNarrowing, tool, block) || mayNarrow(lineNarrowing, tool, block) },
        );
  /** One gate over the SAME ledger, so a decision made at either end is remembered at both. */
  const gate = createToolGate(() => {
    const { authored } = now();
    return {
      ledger,
      sessionId: options.sessionId,
      approve,
      preGated: options.names,
      ...(authored !== undefined ? { authored } : {}),
      ...(options.policy?.smart !== undefined ? { smart: options.policy.smart } : {}),
      // No profile tables (decision 0007 §1). What they existed for — an opinion about a name the gate
      // has never registered — is the permission set's `other`, which rides on `authored`.
      ...(options.policy?.profiles !== undefined ? { profiles: options.policy.profiles } : {}),
      ...(scopeNarrowing !== undefined ? { scopeOf: scopeNarrowing } : {}),
      // What the agent reads when a call is refused, through the gate as through a wrapped tool.
      ...(options.policy?.refusal !== undefined ? { refusal: options.policy.refusal } : {}),
    };
  });
  /** The block a call is decided under now — what a parked call is decided again under (`rejudgeCall`). */
  const authored = (): PermissionsDecl | undefined => now().authored;
  if (options.names.length === 0) return { tools: {}, gate, authored };
  const out: Record<string, Tool> = {};
  for (const name of options.names) {
    const tool = options.registry.tools.get(name);
    if (tool === undefined) throw refusal(log, `tool '${name}' is not registered`);
    out[name] = withPermission(tool, () => {
      const { permissionSet, authored } = now();
      // OWN entries only. The map is keyed by TOOL NAME, so a tool called `constructor` would
      // otherwise resolve its mode — and its smart rule — to a prototype member.
      // Read off the LOWERED block where there is one, so the wrapper and the gate resolve one mode:
      // the shell's entry is `ask` there, and a FUNCTION's line too — see `gateToolModes`.
      const lowered = authored?.tools !== undefined && Object.hasOwn(authored.tools, name) ? authored.tools[name] : undefined;
      const own = Object.hasOwn(permissionSet.entries, name) ? permissionSet.entries[name]!.mode : undefined;
      const authoredMode = lowered ?? (own !== undefined ? gateModeOf(own) : undefined);
      return {
        ledger,
        sessionId: options.sessionId,
        toolName: name,
        approve,
        ...(authoredMode !== undefined ? { authoredMode } : {}),
        // The block itself, so the narrowing sees the permission set's command subjects and places at the
        // moment of decision. Upstream types it by the one key it once read (`scopes`), and passes the rest through.
        ...(authored !== undefined ? { authored: authored as unknown as NonNullable<WithPermissionOptions["authored"]> } : {}),
        ...(options.policy?.smart?.[name] !== undefined ? { smart: options.policy.smart[name] } : {}),
        ...(options.policy?.profiles !== undefined ? { profiles: options.policy.profiles } : {}),
        // The SAME narrowing the gate applies. A wrapped tool and a delegated one are two routes to one
        // decision, and a scope that bound only one of them would be a sandbox with a door in it.
        ...(scopeNarrowing !== undefined ? { scopeOf: scopeNarrowing } : {}),
        ...(options.policy?.refusal !== undefined ? { refusal: options.policy.refusal } : {}),
      };
    });
  }
  return { tools: out, gate, authored };
}

/**
 * Every tool JaiRA can put under its OWN policy.
 *
 * DERIVED from `TOOL_SPECS` rather than restated. It was a hand-written list of three, and being
 * hand-written is how it came to be a list of three: `glob`, `grep`, `edit` and the two web tools
 * were things an agent did that nothing here had a name for, so nothing here could gate them. One
 * table now, in `shared`, because the menu that draws these and the permission set that governs them need
 * the same answer — and a second copy is a second thing to forget to update.
 *
 * `tools.test.ts` asserts this against what {@link registerTools} and its siblings actually build,
 * which is what keeps the vocabulary and the implementations from drifting apart in the other
 * direction: a name here with nothing behind it is a permission somebody can grant and no tool can
 * honour.
 */
export const JAIRA_TOOLS: readonly { name: string }[] = TOOL_SPECS.filter((spec) => spec.nativeOnly !== true && spec.unserved !== true).map(
  // `unserved`: a name a permission set may hold with nothing behind it YET (the workflow tools, decision
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
 * native by its STANDARD name (`withAgentPermissionSet`) — so `Read` answers to the state's `read_file`
 * entry, and a tool the permission set does not hold was removed before it could be asked about.
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
 * The `scopeOf` a permission gate takes, built from the executor's scope table — the FLOOR (decision
 * 0023 §7.2), an operator's sandbox no permission set widens.
 *
 * The seam upstream deliberately left open: it takes a callback rather than a table because which
 * argument of a tool names a place — and whether that place is inside somebody's sandbox — is a
 * question only this side can answer. Here the vocabulary answers the first half
 * ({@link ToolSpec.pathArgs}) and `scopeModeOf` the second. A table alone is a sandbox: what it does
 * not name is refused.
 *
 * `undefined` when there is no table, so a project that has authored no scopes pays nothing and
 * behaves exactly as it did. And `undefined` PER CALL for a tool that names no place, which is what
 * keeps the narrowing from refusing calls it has no opinion about.
 *
 * What a STATE says about where is no table any more: it is a place map on the lines of its permission
 * set (§3.7), judged by {@link placeNarrowingFor} and `decideCommand`.
 */
export function scopeNarrowingFor(
  floor: readonly Scope[] | undefined,
  workspaceRoot: string | undefined,
  execEnv: ExecEnv = "windows",
): ScopeNarrowing | undefined {
  if (floor === undefined || floor.length === 0) return undefined;
  const options = { ...(workspaceRoot !== undefined ? { root: workspaceRoot } : {}) };
  const narrowing = (tool: { name: string; readOnly?: boolean }, input: FunctionInputs): PermissionMode | undefined => {
    // By LOGICAL name, whichever implementation called: a gate asked about the agent's own `Glob`
    // resolves the table written for `glob`. Without this the two spellings would be two policies.
    const name = logicalToolName(tool.name);

    // A SHELL COMMAND is about more than one place, and the ordinary extractor cannot see them: its
    // paths are inside a string. See `commandSubjects` — the cwd it runs in plus every path it
    // names, strictest winning, with `cd` moving the directory for what follows it.
    if (name === "shell") {
      const args = (input ?? {}) as { command?: unknown; cwd?: unknown };
      if (typeof args.command === "string" && workspaceRoot !== undefined) {
        const cwd = typeof args.cwd === "string" && args.cwd !== "" ? absolutize(args.cwd, workspaceRoot) : workspaceRoot;
        const subjects = commandSubjects(args.command, cwd, execEnv, callDialectOf(input, tool.name));
        // A line nothing could parse is already `ask` under the policy's own rule; resolving its cwd
        // alone would be a quieter answer than the one the parser already gives.
        const mode = resolveScopes(floor, name, subjects.paths, options) as PermissionMode;
        return subjects.unparsed ? strictestOf(mode, "ask") : mode;
      }
    }
    return scopeModeOf(floor, TOOL_SPEC_BY_NAME.get(name), name, input, options);
  };
  // A table is a sandbox — what it does not name is refused — so it may narrow every tool that acts
  // somewhere, and none that does not.
  return Object.assign(narrowing, {
    narrows: (tool: { name: string }) => {
      const name = logicalToolName(tool.name);
      return name === "shell" || TOOL_SPEC_BY_NAME.get(name)?.scope !== undefined;
    },
  });
}

/** A tool by its LOGICAL name, whichever implementation is asked about: an agent's `Glob` is `glob`. */
const logicalToolName = (name: string): string => (TOOL_SPEC_BY_NAME.has(name) ? name : (standardOfAnyNative(name) ?? name));

/**
 * Whether a narrowing may tighten some call of `tool` — `ScopeNarrowing.narrows`, which keeps a tool it
 * may tighten from being pre-approved past it. A narrowing that does not say may.
 */
export function mayNarrow(narrowing: ScopeNarrowing | undefined, tool: { name: string; readOnly?: boolean }, authored: Parameters<ScopeNarrowing>[2]): boolean {
  return narrowing !== undefined && (narrowing.narrows?.(tool, authored) ?? true);
}

/** `deny` ▸ `ask` ▸ `smart` ▸ `allow`, for the one place here that composes two modes. */
function strictestOf(a: PermissionMode, b: PermissionMode): PermissionMode {
  const rank: Record<PermissionMode, number> = { allow: 0, smart: 1, ask: 2, deny: 3 };
  return rank[a] >= rank[b] ? a : b;
}

/** One line as a direct call reads it: its own mode (`**`) and its other places. */
export interface PlacedLine {
  mode?: PermissionSetMode | undefined;
  places?: Readonly<Record<string, PermissionSetMode>> | undefined;
}

/** What a line with places answers for one direct call, and who said it. */
export interface ToolPlaceAnswer {
  mode: PermissionSetMode;
  /** The line that answered: the tool's own, or `other` where a place matched nothing and the line has no `**`. */
  subject: string;
  /** The place of the tool's line that answered, when one did. */
  place?: string;
}

/**
 * What a tool's line with PLACES answers for one direct call (decision 0023 §3.2–§3.5): the places the
 * call is about, read off its arguments (`callPlacesOf`), each answered by the most specific of the
 * line's places that matches it, the strictest kept; a place none matches answered by the line's own
 * mode — its `**` — or, where it has none, by the next less specific line, which for a tool is `other`,
 * else {@link MODE_WHEN_UNSET}. `undefined` for a line with no places, whose own mode is the gate's and
 * needs no narrowing.
 */
export function toolPlaceAnswer(tool: string, line: PlacedLine, other: PermissionSetMode | undefined, input: unknown, options: PlaceOptions = {}): ToolPlaceAnswer | undefined {
  if (line.places === undefined || Object.keys(line.places).length === 0) return undefined;
  const spec = TOOL_SPEC_BY_NAME.get(tool);
  const kind = spec?.scope ?? placeKindOf(tool);
  if (kind === undefined) return undefined;
  const calls = callPlacesOf(spec, input, options.root);
  const resolved = resolvePlaces(line.places, kind, calls, options);
  const answers: ToolPlaceAnswer[] = [];
  if (resolved.decision !== undefined) {
    const deciding = resolved.matches.find((match) => modeStrictness(match.decision) === modeStrictness(resolved.decision!)) ?? resolved.matches[0]!;
    answers.push({ mode: resolved.decision, subject: tool, place: deciding.place });
  }
  if (calls.length === 0 || resolved.unmatched.length > 0) {
    answers.push(line.mode !== undefined ? { mode: line.mode, subject: tool } : other !== undefined ? { mode: other, subject: OTHER_SUBJECT } : { mode: MODE_WHEN_UNSET, subject: tool });
  }
  return answers.reduce((worst, next) => (modeStrictness(next.mode) > modeStrictness(worst.mode) ? next : worst));
}

/** What {@link placeNarrowingFor} resolves places against, and the set to read lines off when the block names none. */
export interface PlaceNarrowingOptions extends PlaceOptions {
  /**
   * The block to read lines off when the call's own carries no `places` — the permission set a policy
   * was compiled for (a turn's), lowered. A state's own block is the nearer statement and wins.
   */
  fallback?: PermissionsDecl | undefined;
  /**
   * This task's answers (decision 0023 §2.6, the runtime layer): a direct call that asks is settled by
   * an answer kept for it — at its place, where the answer was kept at one (§3.8).
   */
  grants?: CommandGrants | undefined;
  /** How a path's package is found — the "the package" width the dialog offers. */
  packages?: PackageReader | undefined;
}

/**
 * The per-call narrowing for a DIRECT call to a tool whose line has places (decision 0023 §3.10): the
 * gate is handed the line's loosest answer, and this brings each call down to its own
 * ({@link toolPlaceAnswer}) — so it only ever tightens, and a line with no places is left to its mode
 * (`undefined`). A shell line is not judged here: its parts are `decideCommand`'s.
 *
 * A place whose decision is a FUNCTION answers `ask`, and which function — and for which line and
 * place — is kept against the call's input (`noteFunctionCall`), where the approver puts the call to it
 * before anybody is asked (`withPermissionFunctions`), as it does for a line that names one.
 *
 * A tool is read by its LOGICAL name, so a gate asked about an agent's own `Read` judges the call at
 * `read_file`'s places — its `file_path` already copied to `path` by the translated gate.
 */
export function placeNarrowingFor(options: PlaceNarrowingOptions = {}): ScopeNarrowing {
  const packageOf = packageFolderOf(options.packages);
  const narrowing: ScopeNarrowing = (tool, input, authored) => {
    const name = logicalToolName(tool.name);
    if (name === "shell" || !TOOL_SPEC_BY_NAME.has(name)) return undefined;
    // `$AGENT_WORKSPACE` is the calling agent's folder.
    const here = placesForCall(options, input);
    const block = (authored as PermissionsDecl | undefined) ?? undefined;
    let answered: { answer: ToolPlaceAnswer; block: PermissionsDecl; own?: true | undefined } | undefined = toolPlaceAnswerOf(name, input, block, here) ?? ownAnswerOf(name, block ?? options.fallback);
    // What the call is judged as when it asks: itself, or — for a publish held back by a file it reads —
    // a read of that file.
    let judged = { tool: name, input: input as unknown };
    if (name === SHOW_ARTIFACT) {
      const reading = publishReadAnswerOf(input, block, options.fallback, here);
      const stricter = reading !== undefined && (answered === undefined ? reading.answer.mode !== "allow" : modeStrictness(reading.answer.mode) > modeStrictness(answered.answer.mode));
      if (stricter) {
        // Not `own`: nothing but this narrowing holds a publish to its reads, so it is enforced here.
        answered = { answer: reading.answer, block: reading.block };
        judged = { tool: READ_FILE, input: { path: reading.path } };
      }
    }
    if (answered === undefined) return undefined;
    const { answer, block: from } = answered;
    // A call that ASKS at a place is put to the person as one part, with WHERE it acts and the place
    // widths an answer may be kept at (§3.8) — and is settled first by an answer this task already kept.
    if (answer.mode === "ask") {
      const decided = directCallDecision(judged.tool, judged.input, answer, from, { ...here, ...(packageOf !== undefined ? { packageOf } : {}) });
      if (decided !== undefined) {
        setCommandDecision(input, decided);
        // Settled "for this run": a refusal tightens; an allowance leaves the gate its own mode, and the
        // approver, should the gate still ask, reads the allowed decision and lets the call through.
        if (decided.action === "deny") return "deny";
        if (decided.action === "allow") return undefined;
        return "ask";
      }
    }
    // A line with no places is the gate's to enforce as it stands.
    if (answered.own === true) return undefined;
    notePlaceAnswer(input, { subject: answer.subject, mode: answer.mode, ...(answer.place !== undefined ? { place: answer.place } : {}) });
    if (isFunctionMode(answer.mode)) {
      noteFunctionCall(input, {
        tool: judged.tool,
        subject: answer.subject,
        function: answer.mode.function,
        ...(answer.place !== undefined ? { place: answer.place } : {}),
        ...(from.source !== undefined ? { permissionSet: from.source } : {}),
      });
      return "ask";
    }
    return answer.mode;
  };
  // Only a line with places is tightened here; a line without is the gate's mode, as it stands — but a
  // publish, which answers to `read_file`'s line for every file it reads, wherever a permission set judges.
  return Object.assign(narrowing, {
    narrows: (tool: { name: string }, authored?: Parameters<ScopeNarrowing>[2]) => {
      const name = logicalToolName(tool.name);
      if (name === "shell" || !TOOL_SPEC_BY_NAME.has(name)) return false;
      if (name === SHOW_ARTIFACT) return (authored as PermissionsDecl | undefined) !== undefined || options.fallback !== undefined;
      const block = (authored as PermissionsDecl | undefined)?.places !== undefined ? (authored as PermissionsDecl) : options.fallback;
      return block?.places !== undefined && Object.hasOwn(block.places, name);
    },
  });
}

/**
 * The strictest answer `read_file`'s line gives for the files one publish reads (`publishedReadsOf`), and
 * the file it gave it for — a publish shows a person a file's bytes, so it may publish what a read could
 * read (decision 0020, amended 2026-11-05). `undefined` when it reads no file (its text is in the call)
 * or no permission set judges it.
 */
function publishReadAnswerOf(
  input: unknown,
  authored: PermissionsDecl | undefined,
  fallback: PermissionsDecl | undefined,
  here: PlaceNarrowingOptions,
): { answer: ToolPlaceAnswer; block: PermissionsDecl; path: string } | undefined {
  let worst: { answer: ToolPlaceAnswer; block: PermissionsDecl; path: string } | undefined;
  for (const path of publishedReadsOf(input)) {
    const answered = toolPlaceAnswerOf(READ_FILE, { path }, authored, { ...here, fallback }) ?? ownAnswerOf(READ_FILE, authored ?? fallback);
    if (answered === undefined) continue;
    if (worst === undefined || modeStrictness(answered.answer.mode) > modeStrictness(worst.answer.mode)) worst = { answer: answered.answer, block: answered.block, path };
  }
  return worst;
}

/**
 * The line's OWN answer for a direct call to a tool whose line has no places — read off a lowered map
 * (never off a state that declared no permission set): the tool's gate mode, a function by its
 * reference, or `other` for a tool the map does not hold. Only what that line decides EVERYWHERE, which
 * the gate already enforces — marked `own`, so the narrowing tightens nothing with it and reads it only
 * to put an `ask` to the person with where the call acts.
 */
function ownAnswerOf(tool: string, block: PermissionsDecl | undefined): { answer: ToolPlaceAnswer; block: PermissionsDecl; own: true } | undefined {
  if (block === undefined || !isLoweredPermissionSet(block) || placeKindOf(tool) === undefined) return undefined;
  const reference = block.functions !== undefined && Object.hasOwn(block.functions, tool) ? block.functions[tool] : undefined;
  if (reference !== undefined) return undefined;
  const held = block.tools !== undefined && Object.hasOwn(block.tools, tool) && !isPermissionSetMarkKey(tool) ? block.tools[tool] : undefined;
  // `other` naming a function is the function's to answer, as a line naming one is.
  if (held === undefined && block.functions !== undefined && Object.hasOwn(block.functions, OTHER_SUBJECT)) return undefined;
  const mode = held ?? block.other;
  if (mode === undefined) return undefined;
  return { answer: { mode, subject: held !== undefined ? tool : OTHER_SUBJECT }, block, own: true };
}

/**
 * One direct call that asks, as the one-part decision a shell line's parts are (decision 0023 §3.8,
 * §4.4): its subject is the tool and its only width the tool's line, `where` the place it acts and the
 * place widths an answer may be kept at (`placeWidthsOf`), `decidedBy` the line — and the place and
 * the LAYER (§2.7) — that asked. An answer this task kept for it (`CommandGrants`, at its place where it
 * was kept at one) settles it first, as it settles a shell part. `undefined` for a call that names no
 * place that can be read, which is asked about as before.
 */
function directCallDecision(
  tool: string,
  input: unknown,
  answer: ToolPlaceAnswer,
  block: PermissionsDecl,
  options: PlaceNarrowingOptions & { packageOf?: (path: string) => string | undefined },
): CommandDecision | undefined {
  const spec = TOOL_SPEC_BY_NAME.get(tool);
  const kind = spec?.scope ?? placeKindOf(tool);
  if (kind === undefined) return undefined;
  // A path as a shell part's is: resolved against the project, so the dialog and the record name one place.
  const places = callPlacesOf(spec, input, options.root).map((place) => (kind === "path" && options.root !== undefined && !isAbsolutePath(place) ? absolutize(place, options.root) : place));
  const at = places[0];
  if (at === undefined) return undefined;
  const layer = layerOfLine(block.stack, answer.subject, answer.place);
  const widths = [tool];
  const remembered = options.grants?.answerFor(widths, () => places, options);
  const text = tool;
  const span = { start: 0, end: text.length };
  const verdict = remembered === undefined ? "asks" : remembered.decision === "allow" ? "allowed" : "denied";
  const where = answer.place !== undefined ? ` in ${answer.place}` : "";
  const part: CommandPart = {
    span,
    matched: [span],
    text,
    kind: "tool",
    subject: tool,
    ...(kind === "path" ? { paths: places } : kind === "site" ? { url: at } : {}),
    verdict,
    decidedBy:
      remembered !== undefined
        ? {
            source: "remembered",
            entry: remembered.width,
            layer: "runtime",
            ...(remembered.place !== undefined ? { place: remembered.place } : {}),
            reason: `'${remembered.width}'${remembered.place !== undefined ? ` in ${remembered.place}` : ""} was ${remembered.decision === "allow" ? "allowed" : "denied"} for this run`,
          }
        : {
            source: "permissionSet",
            entry: answer.subject,
            ...(answer.place !== undefined ? { place: answer.place } : {}),
            ...(layer !== undefined ? { layer } : {}),
            reason: `the permission set's '${answer.subject}'${where} asks`,
          },
    widths,
    where: { kind, at, widths: placeWidthsOf(kind, at, { ...options, ...(options.packageOf !== undefined ? { packageOf: options.packageOf } : {}) }) },
  };
  return {
    action: verdict === "denied" ? "deny" : verdict === "allowed" ? "allow" : "require_approval",
    reason: part.decidedBy.reason,
    parts: {
      line: text,
      dialect: "posix",
      parts: [part],
      verdict,
      ...(block.source !== undefined ? { permissionSet: block.source } : {}),
      ...(block.stack !== undefined ? { stack: approvalStackOf(block.stack, options.grants !== undefined) } : {}),
    },
  };
}

/** The place answer for one direct call off a lowered block — the call's own, else the fallback — and the block it came from. */
export function toolPlaceAnswerOf(
  tool: string,
  input: unknown,
  authored: PermissionsDecl | undefined,
  options: PlaceNarrowingOptions = {},
): { answer: ToolPlaceAnswer; block: PermissionsDecl; own?: undefined } | undefined {
  const block = authored?.places !== undefined ? authored : options.fallback;
  const map = block?.places !== undefined && Object.hasOwn(block.places, tool) ? block.places[tool] : undefined;
  if (block === undefined || map === undefined) return undefined;
  const read = permissionSetOfEnvironment(undefined, { places: { [tool]: map }, ...(block.functions !== undefined ? { functions: block.functions } : {}), ...(block.other !== undefined ? { other: block.other } : {}) });
  const line = read.entries[tool];
  if (line === undefined) return undefined;
  const answer = toolPlaceAnswer(tool, { mode: line.mode, places: line.places }, read.other, input, options);
  return answer === undefined ? undefined : { answer, block };
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
  /** The shell the line runs in, when it is not the project's (an agent's own `Bash` or `PowerShell`). */
  dialect?: CommandDialect,
): { paths: string[]; unparsed: boolean } {
  const parsed = takeApart(command, dialect ?? dialectFor(execEnv));
  if (parsed.unparsed) return { paths: [cwd], unparsed: true };
  const paths = new Set<string>([cwd]);
  let here = cwd;
  for (const request of parsed.requests) {
    // A redirect's target is a place the line is about, as much as any argument is.
    if (request.kind === "redirect") paths.add(resolveAgainst(here, request.target));
    if (request.kind !== "command") continue;
    const one = request.command;
    const words = commandWords(one);
    if (DIRECTORY_CHANGERS.includes(one.program)) {
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
 * What the executor's scope FLOOR says about ONE PART of a shell line, by the standard tool the part
 * is (decision 0007 §4): `rm x` and `> x` are asked about as `write_file` at `x`, `curl <url>` as
 * `web_fetch` at the url — so a table written for the tools binds the shell exactly as it binds them.
 * A table alone is a sandbox, so a place it names nothing about is refused. `undefined` with no table.
 */
export function partScopeFor(
  floor: readonly Scope[] | undefined,
  workspaceRoot: string | undefined,
): ((tool: string, place: { path?: string; url?: string }) => PermissionMode | undefined) | undefined {
  if (floor === undefined || floor.length === 0) return undefined;
  const options: ScopeOptions = { ...(workspaceRoot !== undefined ? { root: workspaceRoot } : {}) };
  return (tool, place) =>
    (place.path !== undefined ? resolveScope(floor, tool, place.path, options) : place.url !== undefined ? resolveUrlScope(floor, tool, place.url, options) : undefined) as
      | PermissionMode
      | undefined;
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
 * stays underneath for everything the rule syntax cannot express — `shell` above all, whose paths
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
      if (mode === undefined) continue;
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
