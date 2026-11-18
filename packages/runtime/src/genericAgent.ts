/**
 * The `generic-cli` agent runtime (DESIGN §14 phase 7, §8.1, §16).
 *
 * A coding agent that is not Claude Code — opencode, codex, or anything else that
 * takes an instruction and writes to the workspace. Upstream's `claude-cli`
 * adapter cannot serve these: its argv (`--output-format stream-json`,
 * `--permission-prompt-tool`) and its stream parsing are Claude's protocol. What
 * *is* reusable is the normalized `AgentQuery` seam, so JaiRA supplies a query and
 * gets the same registry entry shape.
 *
 * **This runtime is policy-weak, and says so.** DESIGN §16: "generic-cli runners
 * start policy-weak by design." A generic binary offers no permission callback and
 * no reliable pre-approval flags, so nothing JaiRA does can gate the commands it
 * runs — its capabilities therefore declare `policyEnforcement: "none"`, which is
 * what makes §8.2's `gateCapabilities` refuse it under a policy that can require
 * approval. Declaring anything stronger would be the exact failure DESIGN §16
 * warns about: pretending uniformity.
 *
 * **Unless its registration says how to serve it.** A binary that can be pointed at an MCP server
 * and have its own tools switched off is given an `mcp` block (`JairaGenericCliMcp`): each run stands
 * up the tool bridge codex uses, hands the binary its address through `{mcpUrl}` / `{mcpConfig}`, and
 * serves the tools the state holds there, every call gated before it runs. With `builtinsOff` stated,
 * the binary is held to a permission set as codex is ({@link GENERIC_BRIDGED_CAPS}).
 *
 * What it *does* get is JaiRA's own Exec layer, so a WSL project runs its agent
 * inside the distro (DESIGN §9.1) with no extra work here.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeFunction, type CapabilityRegistry, type JsonValue, type RuntimeCapabilities } from "@declarative-ai/exec";
import {
  createClaudeCodeFunction,
  DELEGATED_CAPS,
  type AgentQuery,
  type AgentQueryOptions,
  type AgentStreamMessage,
} from "@declarative-ai/agents-api";
import { defaultStartMcpBridge, type McpBridge, type StartMcpBridge } from "@declarative-ai/agents-cli";
import { emptyWorkflowMetrics, type WorkflowMetrics } from "@declarative-ai/hw";
import { ALWAYS_GRANTED_TOOLS, MCP_CONFIG_PLACEHOLDER, MCP_URL_PLACEHOLDER, type AgentToolDeclaration, type JairaGenericCliAgent } from "@jaira/shared";
import { NodeExec, type Exec } from "./exec";
import { isWslEnv, onMachine, pathFor, type ExecEnv } from "./paths";
import { GENERIC_BRIDGED_TOOLS, GENERIC_CLI_TOOLS, holdAgentFunction, permissionSetViewOf, type AgentFunctionRun } from "./agentTools";

/** The default registry name a single configured generic CLI is registered under. */
export const AGENT_GENERIC_CLI = "generic-cli";

/**
 * Honest capabilities for a generic binary.
 *
 * `policyEnforcement: "none"` is the load-bearing field: no callback reaches
 * `ctx.approve`, and there is no flag vocabulary to translate a deny list into, so
 * neither `callback` nor `config` would be true. `interactive: false` because a
 * generic CLI in a workflow has no channel to ask a human anything.
 */
export const GENERIC_CLI_CAPS: RuntimeCapabilities = {
  ...DELEGATED_CAPS,
  policyEnforcement: "none",
  interactive: false,
  streaming: false,
  /**
   * FALSE, unlike the `claude` and `codex` transports it inherits from.
   *
   * Those two carry an output schema natively (`--json-schema`, `--output-schema`). A generic CLI is
   * an arbitrary binary with an argv template — there is no flag to put a schema in and no field to
   * read one back from, so claiming the capability would be claiming a guarantee nothing enforces.
   * The query refuses a schema outright rather than dropping it.
   */
  structuredOutput: false,
};

/**
 * A generic CLI whose registration says its own tools are off and points it at the tool bridge
 * (`mcp.builtinsOff`): it acts only through the tools served to it, each call put to the gate at the
 * bridge before it runs — codex's record, for codex's reason. The claim is the person's: JaiRA cannot
 * look inside the binary to check it.
 */
export const GENERIC_BRIDGED_CAPS: RuntimeCapabilities = { ...GENERIC_CLI_CAPS, policyEnforcement: "config" };

/** Does this registration say the binary has none of its own tools, only the ones served? */
export function bridgesOnly(spec: JairaGenericCliAgent): boolean {
  return spec.mcp?.builtinsOff === true;
}

/** What a generic CLI declares about its tools: nothing, or — its own off — only what crosses the bridge. */
export function genericCliToolsOf(spec: JairaGenericCliAgent): AgentToolDeclaration {
  return bridgesOnly(spec) ? GENERIC_BRIDGED_TOOLS : GENERIC_CLI_TOOLS;
}

/**
 * The registration without its bridge: how a call that no permission set holds is run. Such a state has
 * said nothing about tools, so the binary keeps its own, as it did before it could be bridged — the same
 * arguments that point it at the bridge turn them off, and the engine hands a state that names no tools
 * only the ones always granted, so bridging it there would leave it unable to read a file.
 */
export function unbridged(spec: JairaGenericCliAgent): JairaGenericCliAgent {
  const { mcp: _bridge, ...rest } = spec;
  return rest;
}

/**
 * A call's options less the tools every state is granted whatever it says (`show_artifact`), for a binary
 * that cannot be served them. Leaving them out takes a means away and restricts nothing, where refusing
 * over them refused every state the engine had granted them to — which is every state.
 */
function withoutAlwaysGranted(opts: AgentQueryOptions): AgentQueryOptions {
  const granted = new Set(ALWAYS_GRANTED_TOOLS);
  const tools = Object.fromEntries(Object.entries(opts.mcpTools ?? {}).filter(([name]) => !granted.has(name)));
  const allowed = opts.allowedTools?.filter((name) => !granted.has(name));
  return { ...opts, mcpTools: tools, ...(allowed !== undefined ? { allowedTools: allowed } : {}) };
}

/** A generic CLI's capability record — see {@link GENERIC_CLI_CAPS} and {@link GENERIC_BRIDGED_CAPS}. */
export function genericCliCapsOf(spec: JairaGenericCliAgent): RuntimeCapabilities {
  return bridgesOnly(spec) ? GENERIC_BRIDGED_CAPS : GENERIC_CLI_CAPS;
}

/** The config file's name when the registration names none. */
export const MCP_CONFIG_FILE = "jaira-mcp.json";

/** Where the prompt is substituted when the argv template does not name it. */
export const PROMPT_PLACEHOLDER = "{prompt}";

/**
 * Where a requested MODEL is substituted, for a binary that takes one.
 *
 * A placeholder rather than a generated `--model` flag, because there is no generic spelling: one CLI
 * wants `--model`, another `-m`, another an environment variable. The template already carries the
 * binary's own vocabulary for everything else, so it carries this too — `["-m", "{model}", "--json"]`.
 */
export const MODEL_PLACEHOLDER = "{model}";

export interface GenericCliQueryOptions {
  /** Where to run (a WSL project runs its agent in the distro). */
  execEnv?: ExecEnv;
  /** The process seam. Tests inject a fake; production uses {@link NodeExec}. */
  exec?: Exec;
  /** Cap a runaway agent. Absent ⇒ no limit. */
  timeoutMs?: number;
  /**
   * Look a named secret up — the chain the probe reads (keychain, the `.env` files, the environment).
   * Asked as each run starts, so a key stored after the agent was registered is found. Absent, a key
   * config names is left to the environment the binary inherits, as it always was.
   */
  secret?: (name: string) => string | undefined;
  /**
   * The bridge seam, for a registration with `mcp`: the host's persistent bridge, or upstream's
   * per-run one when absent. Tests inject a fake.
   */
  startBridge?: StartMcpBridge;
}

/**
 * What this run asks for that the binary cannot be held to — `undefined` to go ahead.
 *
 * Without `mcp` the binary can be served nothing and told nothing, so every policy option is refused,
 * as it always was. With it, the tools are served over the bridge and each call is gated there, so the
 * tools and a pre-approval of them travel. With its own tools off as well, a denied name is honoured by
 * its absence — the binary has no tool of its own to deny — and a permission mode of `plan` or `default`
 * by the gate, which decides every call; any other mode speaks about the binary's own prompting, which
 * nothing here can set.
 */
export function genericCliRefusal(spec: JairaGenericCliAgent, opts: AgentQueryOptions): string | undefined {
  const served = new Set(Object.keys(opts.mcpTools ?? {}));
  const bridged = spec.mcp !== undefined;
  const only = bridgesOnly(spec);
  const preApproved = (opts.allowedTools ?? []).filter((name) => !(bridged && served.has(name)));
  const denied = only ? [] : (opts.disallowedTools ?? []);
  const mode = opts.permissionMode;
  const unenforceable = [
    ...(!bridged && served.size > 0 ? [`its declared tools [${[...served].join(", ")}]`] : []),
    ...(preApproved.length > 0 ? [`a pre-approval of [${preApproved.join(", ")}]`] : []),
    ...(denied.length > 0 ? [`a tool deny-list [${denied.join(", ")}]`] : []),
    ...(mode !== undefined && !(only && (mode === "plan" || mode === "default")) ? [`the '${mode}' permission mode`] : []),
  ];
  if (unenforceable.length === 0) return undefined;
  return bridged
    ? `'${spec.command}' is served JaiRA's tools over MCP but keeps its own, so this state's ${unenforceable.join(", ")} cannot reach it — ` +
        "turn its own tools off and say so in its registration (mcp.builtinsOff), run the state on claude-cli, claude-code or codex-cli, or drop the restriction"
    : `'${spec.command}' is a generic CLI with no tool bridge and no permission flags, so this state's ` +
        `${unenforceable.join(", ")} cannot reach it — give its registration an mcp block, run the state on claude-cli, claude-code or codex-cli, ` +
        "which serve declared tools over MCP and honour the policy, or drop the restriction";
}

/** Every `{mcpUrl}` and `{mcpConfig}` in `text`, filled. */
function fillMcp(text: string, url: string, config: string | undefined): string {
  const withUrl = text.split(MCP_URL_PLACEHOLDER).join(url);
  return config === undefined ? withUrl : withUrl.split(MCP_CONFIG_PLACEHOLDER).join(config);
}

/** A config value with every string in it filled — keys too, for a binary that names a server by its URL. */
function fillMcpJson(value: JsonValue, url: string, config: string | undefined): JsonValue {
  if (typeof value === "string") return fillMcp(value, url, config);
  if (Array.isArray(value)) return value.map((item) => fillMcpJson(item, url, config));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [fillMcp(key, url, config), fillMcpJson(item as JsonValue, url, config)]));
  }
  return value;
}

/**
 * Build an `AgentQuery` that drives a generic CLI.
 *
 * The prompt reaches the binary one of two ways, because CLIs differ and guessing
 * would break one of them: as an argument (the `{prompt}` placeholder, or appended
 * after `--`), or on stdin. Rendering it into a shell string is never an option —
 * an instruction is workflow data, and Exec passes argv without a shell.
 */
export function createGenericCliQuery(spec: JairaGenericCliAgent, given: GenericCliQueryOptions = {}): AgentQuery {
  // The agent is the machine's: a workspace's container (decision 0027) holds only the commands JaiRA runs.
  const options = onMachine(given);
  const exec = options.exec ?? new NodeExec();
  return async function* genericCliQuery(asked): AsyncIterable<AgentStreamMessage> {
    const opts = spec.mcp !== undefined ? asked : withoutAlwaysGranted(asked);
    // REFUSED, not dropped — the same rule the model check below follows. A generic CLI has no schema
    // flag and no structured field, so a caller that asked for a shape would get prose back and be
    // told nothing about why. Worse, that failure is classified `api-retriable`, so a repair loop
    // would re-run the whole binary twice more with a hint it has no way to act on.
    if (opts.schema !== undefined) {
      yield {
        type: "other",
        error:
          "a generic CLI agent has no output-schema channel, so a state that declares outputs cannot run on one — " +
          "run it on claude-cli or codex-cli, which carry a schema natively, or on a provider route",
      };
      return;
    }
    // The POLICY options, refused by the same rule — see `genericCliRefusal`. Every one of these was
    // once silently dropped here, which is precisely how an agent ends up running with its own
    // defaults while the workflow believes it is restricted. (A narrowing `permissions.profile` on a
    // binary that enforces nothing never reaches this far: `policyEnforcement: "none"` refuses it one
    // layer up.)
    const refusal = genericCliRefusal(spec, opts);
    if (refusal !== undefined) {
      yield { type: "other", error: refusal };
      return;
    }
    const template = spec.args ?? [];
    // A model this template has nowhere to put is REFUSED, not dropped. Running whatever the binary
    // defaults to while the workflow believes it asked for something else is silent and expensive —
    // the same rule the deny-list follows, and for the same reason (`seam.ts`: "an adapter that cannot
    // honour it must refuse, not drop it").
    if (opts.model !== undefined && !template.includes(MODEL_PLACEHOLDER)) {
      yield {
        type: "other",
        error:
          `'${spec.command}' was asked for the model '${opts.model}', but its configured arguments have no ` +
          `${MODEL_PLACEHOLDER} placeholder to put it in — add one (e.g. ["-m", "${MODEL_PLACEHOLDER}"]), or ` +
          `name the executor without a model suffix so it uses its own default`,
      };
      return;
    }
    const usesPlaceholder = template.includes(PROMPT_PLACEHOLDER);
    const viaStdin = spec.prompt === "stdin";
    const filled = template.map((arg) => (arg === MODEL_PLACEHOLDER ? opts.model! : arg));

    // The key config names, handed to the binary under its own name — which is the variable it reads
    // (`GEMINI_API_KEY`, `META_API_KEY`). A key named and not found REFUSES the run, as the probe calls
    // the agent not working: run without it, the binary would fall back to whatever sign-in it has,
    // and the person who stored a key would be billed somewhere they did not choose.
    let key: Record<string, string> = {};
    if (spec.credential !== undefined && options.secret !== undefined) {
      const value = options.secret(spec.credential);
      if (value === undefined || value.length === 0) {
        yield {
          type: "other",
          error:
            `'${spec.command}' is set to use the key '${spec.credential}', but no value was found for it — ` +
            "store one (Settings → Connections → Agents), or clear the key so the binary signs itself in",
        };
        return;
      }
      key = { [spec.credential]: value };
    }
    // The bridge, for a registration that says how the binary is pointed at it: always when the binary's
    // own tools are off — the same arguments turn them off, so a run with nothing to serve still gets
    // them — and otherwise only when there are tools to serve.
    const mcp = spec.mcp;
    const served = opts.mcpTools ?? {};
    let bridge: McpBridge | undefined;
    let configDir: string | undefined;
    try {
      let extraArgs: string[] = [];
      let extraEnv: Record<string, string> = {};
      if (mcp !== undefined && (bridgesOnly(spec) || Object.keys(served).length > 0)) {
        try {
          bridge = await (options.startBridge ?? defaultStartMcpBridge)({
            tools: served,
            ...(opts.validator !== undefined ? { validator: opts.validator } : {}),
          });
        } catch (e) {
          yield { type: "other", error: `the agent's tool bridge could not start: ${e instanceof Error ? e.message : String(e)}` };
          return;
        }
        // The file holds the bridge's URL, which is a credential (it carries the run's secret): a folder
        // of its own, readable by this user alone, removed when the run ends.
        let configPath: string | undefined;
        if (mcp.config !== undefined) {
          configDir = await mkdtemp(join(tmpdir(), "jaira-mcp-"));
          const file = join(configDir, mcp.configName ?? MCP_CONFIG_FILE);
          configPath = options.execEnv !== undefined ? pathFor(options.execEnv, file) : file;
          await writeFile(file, `${JSON.stringify(fillMcpJson(mcp.config, bridge.url, configPath), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        }
        extraArgs = (mcp.args ?? []).map((arg) => fillMcp(arg, bridge!.url, configPath));
        extraEnv = Object.fromEntries(Object.entries(mcp.env ?? {}).map(([name, value]) => [name, fillMcp(value, bridge!.url, configPath)]));
      }
      const args = usesPlaceholder
        ? [...filled.map((arg) => (arg === PROMPT_PLACEHOLDER ? opts.prompt : arg)), ...extraArgs]
        : viaStdin
          ? [...filled, ...extraArgs]
          : // `--` first: an instruction beginning with `-` must not be read as a flag.
            [...filled, ...extraArgs, "--", opts.prompt];
      // Config's own `env` outranks the key: a variable stated there is stated on purpose. The bridge's
      // outrank both, being where this run's tools are.
      const env = intoDistro({ ...key, ...spec.env, ...extraEnv }, options.execEnv);
      yield* runGenericCli(spec, args, env, opts, options, exec, viaStdin);
    } finally {
      await bridge?.close().catch(() => undefined);
      if (configDir !== undefined) await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** Start the binary and read its answer — the part of a generic run after its arguments are known. */
async function* runGenericCli(
  spec: JairaGenericCliAgent,
  args: string[],
  env: Record<string, string> | undefined,
  opts: AgentQueryOptions,
  options: GenericCliQueryOptions,
  exec: Exec,
  viaStdin: boolean,
): AsyncIterable<AgentStreamMessage> {
  let result;
  try {
    result = await exec.run(spec.command, args, {
      // The agent works in the task's worktree; a WSL run needs the distro's view.
      ...(opts.cwd !== undefined
        ? { cwd: options.execEnv !== undefined ? pathFor(options.execEnv, opts.cwd) : opts.cwd }
        : {}),
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(viaStdin ? { stdin: opts.prompt } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(opts.abortSignal !== undefined ? { abortSignal: opts.abortSignal } : {}),
    });
  } catch (e) {
    // A failure to *start* — usually the binary is not installed.
    yield { type: "other", error: `'${spec.command}' could not be started: ${(e as Error).message}` };
    return;
  }

  if (result.aborted) {
    yield { type: "other", error: `'${spec.command}' was canceled` };
    return;
  }
  if (result.timedOut) {
    yield { type: "other", error: `'${spec.command}' timed out` };
    return;
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    yield { type: "other", error: `'${spec.command}' exited ${result.code}${detail ? `: ${detail}` : ""}` };
    return;
  }
  // No cost is reported: a generic CLI does not tell us what it spent, and
  // inventing a number would corrupt the run's roll-up.
  yield { type: "result", result: { text: result.stdout.trim() } };
}

/**
 * The variables a generic CLI is started with, made to reach it inside a WSL distro.
 *
 * `wsl.exe` carries the Windows side's environment into the distro only for the names `WSLENV`
 * lists, so a key set here would stop at the boundary — each name is added (`/u`: from Windows into
 * WSL), after whatever `WSLENV` already lists. Natively nothing is needed. `undefined` for none.
 */
export function intoDistro(env: Record<string, string>, execEnv: ExecEnv | undefined): Record<string, string> | undefined {
  const names = Object.keys(env).filter((name) => name !== "WSLENV");
  if (names.length === 0) return Object.keys(env).length > 0 ? env : undefined;
  if (execEnv === undefined || !isWslEnv(execEnv)) return env;
  const listed = (env["WSLENV"] ?? process.env["WSLENV"] ?? "").split(":").filter((entry) => entry.length > 0);
  const add = names.map((name) => `${name}/u`).filter((entry) => !listed.includes(entry));
  return { ...env, WSLENV: [...listed, ...add].join(":") };
}

export interface GenericAgentOptions extends GenericCliQueryOptions {
  /** The configured generic agents (`config.agents.genericCli`). */
  agents?: readonly JairaGenericCliAgent[];
}

/**
 * Register every configured generic CLI as a `runtime` entry.
 *
 * Nothing is registered when nothing is configured, so a state naming
 * `generic-cli` in a project that never set one up fails with "unregistered
 * function" — the honest error — rather than silently running some default binary.
 */
export function registerGenericAgents(
  registry: CapabilityRegistry<WorkflowMetrics>,
  options: GenericAgentOptions = {},
): CapabilityRegistry<WorkflowMetrics> {
  for (const spec of options.agents ?? []) {
    const name = spec.name ?? AGENT_GENERIC_CLI;
    const functionOf = (registration: JairaGenericCliAgent) =>
      createClaudeCodeFunction({
        capabilities: genericCliCapsOf(registration),
        // The runtime half of `policyEnforcement: "none"`: there is no channel to route an approver
        // through, so one must not be built and then silently ignored by the query. Bridged, the gate
        // moves to the bridge instead (upstream's `AgentExecutor`).
        approvalCallback: false,
        query: createGenericCliQuery(registration, options),
      });
    const fn = functionOf(spec);
    // With no tools of its own declared off it declares no channel, so a permission set that refuses
    // anything is refused — as the prompt route of the same binary refuses it (decision 0007 §3). With
    // them off, what it holds is served over the bridge and gated there.
    const held = holdAgentFunction(genericCliToolsOf(spec), fn.run as AgentFunctionRun, name);
    const run = bridgesOnly(spec) ? unheldPlainly(held, functionOf(unbridged(spec)).run as AgentFunctionRun, name) : held;
    registry.functions.set(name, runtimeFunction(run as never, fn.capabilities) as never);
  }
  return registry;
}

/**
 * A bridged function's `run` for a call no permission set holds: the binary with its own tools
 * ({@link unbridged}) — unless the policy would not let an unchecked shell run, which the binary's own
 * shell would be. Its capability record says `config`, true of every held call, so §8.2's check before
 * the run lets such a state through; this is that check, made where it can see that the call is unheld.
 */
function unheldPlainly(held: AgentFunctionRun, plain: AgentFunctionRun, label: string): AgentFunctionRun {
  return async (inputs, ctx) => {
    if (permissionSetViewOf(ctx) !== undefined) return held(inputs, ctx);
    const shell = ctx.gate?.modeOf({ name: "shell" });
    if (shell === undefined || shell === "allow") return plain(inputs, ctx);
    return {
      error: {
        classification: "permanent",
        reason:
          `${label}: this state declares no permission set, so the binary would run with its own tools — its own shell among them, ` +
          `which nothing here can put to this project's policy. Give the state a permission set: then it works through JaiRA's tools, each checked`,
      },
      metrics: emptyWorkflowMetrics(),
    };
  };
}
