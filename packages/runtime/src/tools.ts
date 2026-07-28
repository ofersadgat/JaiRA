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
import { isPermissionDenied, PermissionLedger, withPermission } from "@declarative-ai/permissions";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { NodeExec, type Exec } from "./exec";
import { isDeniedPath } from "./policy";
import { isWslEnv, type ExecEnv } from "./paths";

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
 * `readOnly: false` is deliberate and load-bearing — it is what the `read-only`
 * and `plan` permission profiles gate on, so a plan-mode session cannot run
 * commands at all regardless of the per-command policy.
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
      // other Exec caller, which passes argv. Rather than letting Exec spawn a
      // shell (it never does, by design), the interpreter is named explicitly and
      // the command is passed to it as a single argument. Naming it also keeps the
      // interpreter consistent with the dialect the POLICY parsed the command with
      // (`compilePolicy` picks posix for WSL, PowerShell otherwise) — a mismatch
      // there would mean judging one language and executing another.
      const env: ExecEnv = options.execEnv ?? "windows";
      const [interpreter, ...prefix] = isWslEnv(env)
        ? (["bash", "-lc"] as const)
        : (["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"] as const);

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

      const result = (await gated.run({ command }, ctx)) as JsonValue;
      if (isPermissionDenied(result)) {
        // A refusal is the state's outcome, classified — not an exception, and not a
        // silent success either.
        return { error: { classification: "permanent", reason: `command refused: ${result.reason}` }, metrics: metrics() };
      }
      return { value: result as ResolvedValue, metrics: metrics() };
    },
  };
}

/** Register the command-running function on a registry's `functions` facet. */
export function registerCommandFunction(
  registry: CapabilityRegistry<WorkflowMetrics>,
  options: ToolOptions = {},
): void {
  const fn = createRunCommandFunction(options);
  registry.functions.set(RUN_COMMAND, hostFunction(fn.run, fn.capabilities));
}
