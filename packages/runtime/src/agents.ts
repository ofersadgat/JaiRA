/**
 * Delegated agent runtimes (DESIGN §8, §8.1) — the `claude-code` adapters, split
 * by *invocation mechanism* upstream: `@declarative-ai/agents-api` reaches the
 * agent through its in-process SDK, `@declarative-ai/agents-cli` through a
 * subprocess. A workflow authored against one runs against the other; what differs
 * is how the safety policy is enforced (`callback` vs `config`), which is exactly
 * what DESIGN §8.2's capability gating reads.
 *
 * JaiRA's job here is small and worth keeping small: name the runtimes, pass the
 * execution environment through (a WSL project's agent must run inside the
 * distro), and let the engine supply `ctx.workspace` / `ctx.policy` /
 * `ctx.approve`. Everything about *how* an agent is driven belongs upstream.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { runtimeFunction, type CapabilityRegistry, type RuntimeCapabilities } from "@declarative-ai/exec";
import { createClaudeCodeFunction, type AgentQuery, type ClaudeCodeFunctionOptions } from "@declarative-ai/agents-api";
import { createCliAgentFunction, type SpawnProcess } from "@declarative-ai/agents-cli";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import type { ExecObserver } from "./exec";
import { isWslEnv, type ExecEnv } from "./paths";

/** The registry names JaiRA registers its agents under. */
export const AGENT_SDK = "claude-code";
export const AGENT_CLI = "claude-cli";

/**
 * Spawn the CLI agent through a seam JaiRA can watch (DESIGN §4.2a).
 *
 * Upstream's default spawn is module-private, so tracking the `claude` process —
 * the orphan that most matters, since an abandoned one keeps billing — means
 * supplying our own. Two details are copied deliberately from upstream's version
 * and must not be "tidied":
 *
 *  - **stderr is ignored, not piped.** An unread pipe fills at ~64 KB and the child
 *    then blocks forever on write, so stdout stops and `exit` never settles.
 *  - **an `error` listener is attached.** A `ChildProcess` `'error'` with no
 *    listener throws and would take the host process down — and ENOENT on a missing
 *    `claude` binary is the likeliest first-run outcome.
 */
function observedSpawn(observer: ExecObserver): SpawnProcess {
  return (argv, opts) => {
    const [command, ...args] = argv;
    const child = spawn(command!, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    let token: unknown;
    try {
      token = observer.onSpawn({
        command: command!,
        argv: args,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    } catch {
      token = undefined;
    }
    const observeExit = (code: number | null): void => {
      try {
        observer.onExit(token, { code, signal: null });
      } catch {
        // Bookkeeping must not change the agent's outcome.
      }
    };

    let spawnError: Error | undefined;
    child.on("error", (e: Error) => {
      spawnError = e;
      lines.close();
    });

    return {
      lines,
      kill: () => void child.kill(),
      exit: new Promise<number>((resolve) => {
        child.on("error", () => {
          observeExit(-1);
          resolve(-1);
        });
        child.on("close", (code) => {
          const value = spawnError ? -1 : (code ?? 0);
          observeExit(value);
          resolve(value);
        });
      }),
    };
  };
}

export interface AgentRuntimeOptions {
  /** Where the agent runs. A WSL project drives the CLI adapter inside the distro. */
  execEnv?: ExecEnv;
  /** Records the agent subprocess as a job, so an abandoned one is findable. */
  observer?: ExecObserver;
  /**
   * Replace the agent-query seam — the whole reason this is testable without an
   * SDK, a `claude` binary, or a network: a fake query drives the same adapter.
   */
  query?: AgentQuery;
  /** Which adapters to register. Default: both. */
  adapters?: Array<"sdk" | "cli">;
  /** Extra options forwarded to the SDK adapter (tool injection, native renames). */
  sdk?: Omit<ClaudeCodeFunctionOptions, "query">;
  /** Path to the CLI binary (default: `claude` on PATH). */
  cliCommand?: string;
}

/**
 * Register the delegated agent runtimes on a capability registry.
 *
 * A state reaches one with `operation: { kind: "function", function: "claude-code",
 * config: { … } }`; its `prompt` input is the instruction, and the authored
 * `config` is the runtime surface.
 */
export function registerAgentRuntimes(
  registry: CapabilityRegistry<WorkflowMetrics>,
  options: AgentRuntimeOptions = {},
): CapabilityRegistry<WorkflowMetrics> {
  const adapters = options.adapters ?? ["sdk", "cli"];

  if (adapters.includes("sdk")) {
    const sdk = createClaudeCodeFunction({
      ...options.sdk,
      ...(options.query !== undefined ? { query: options.query } : {}),
    });
    registry.functions.set(
      AGENT_SDK,
      runtimeFunction(sdk.run as never, sdk.capabilities) as never,
    );
  }

  if (adapters.includes("cli")) {
    const env = options.execEnv ?? "windows";
    const cli =
      options.query !== undefined
        ? // A supplied query replaces the subprocess entirely, so the CLI adapter
          // becomes the SDK adapter with a different name — which is what makes the
          // registration path testable without a `claude` binary.
          createClaudeCodeFunction({ ...options.sdk, query: options.query })
        : createCliAgentFunction({
            ...options.sdk,
            ...(options.cliCommand !== undefined ? { command: options.cliCommand } : {}),
            // A WSL project's agent must run in the distro, not on Windows.
            ...(isWslEnv(env) ? { args: ["-d", env.wsl, "--", options.cliCommand ?? "claude"] } : {}),
            ...(isWslEnv(env) ? { command: "wsl.exe" } : {}),
            // Only when someone is watching: upstream's own spawn is the better
            // default, and this one exists solely to report the process.
            ...(options.observer !== undefined ? { spawn: observedSpawn(options.observer) } : {}),
          });
    registry.functions.set(
      AGENT_CLI,
      runtimeFunction(cli.run as never, cli.capabilities) as never,
    );
  }

  return registry;
}

// --- Capability gating (DESIGN §8.2) -----------------------------------------

export interface GateIssue {
  stateId: string;
  functionRef: string;
  message: string;
}

export interface GateOptions {
  /** True when the project's policy can escalate a call to a human. */
  policyNeedsApproval?: boolean;
  /** True when no UI can answer an approval (a headless run). */
  unattended?: boolean;
}

function capabilitiesOf(
  registry: CapabilityRegistry<WorkflowMetrics>,
  name: string,
): RuntimeCapabilities | undefined {
  const entry = registry.functions.get(name);
  if (!entry || entry.kind !== "runtime") return undefined;
  return entry.capabilities as RuntimeCapabilities;
}

/**
 * The function a state's operation dispatches to, from either state shape.
 *
 * The authored form spells it `function` and the loaded form `functionRef`, and
 * callers naturally reach for `bundle.source` (it is what a snapshot stores).
 * Reading only `functionRef` made this whole gate a silent no-op against authored
 * states — a check that never fires is worse than no check, because it reads as
 * one that passed.
 */
function functionRefOf(def: { operation?: { kind?: string; functionRef?: unknown; function?: unknown } }): string | undefined {
  const op = def.operation;
  if (op?.kind !== "function") return undefined;
  if (typeof op.functionRef === "string") return op.functionRef;
  return typeof op.function === "string" ? op.function : undefined;
}

/**
 * Cross-check each state's chosen runtime against what it actually supports
 * (DESIGN §8.2): "violations block the task with a clear error rather than
 * degrading silently".
 *
 * The check that matters: a policy which can require approval is meaningless
 * against an adapter that enforces nothing, so that combination is refused rather
 * than quietly running unguarded.
 */
export function gateCapabilities(
  registry: CapabilityRegistry<WorkflowMetrics>,
  states: Record<string, { operation?: { kind?: string; functionRef?: unknown; function?: unknown } }>,
  options: GateOptions = {},
): GateIssue[] {
  const issues: GateIssue[] = [];
  for (const [stateId, def] of Object.entries(states)) {
    const functionRef = functionRefOf(def);
    if (functionRef === undefined) continue;
    const caps = capabilitiesOf(registry, functionRef);
    if (caps === undefined) continue; // a host function or an unregistered ref — not this check's business

    if (options.policyNeedsApproval === true && caps.policyEnforcement === "none") {
      issues.push({
        stateId,
        functionRef,
        message: `'${functionRef}' enforces no policy (policyEnforcement: "none"), but this project's policy can require approval — refusing rather than running it unguarded`,
      });
    }
    if (options.unattended === true && caps.policyEnforcement === "callback" && options.policyNeedsApproval === true) {
      issues.push({
        stateId,
        functionRef,
        message: `'${functionRef}' will escalate tool calls to a human, but this run has no interactive surface to answer them`,
      });
    }
  }
  return issues;
}
