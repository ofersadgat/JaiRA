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
import { createCliAgentFunction, createCodexAgentFunction, CODEX_CAPS, type CodexSandbox, type SpawnProcess } from "@declarative-ai/agents-cli";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import { resolveInvocation, type ExecObserver } from "./exec";
import type { ExecEnv } from "./paths";

/** The registry names JaiRA registers its agents under. */
export const AGENT_SDK = "claude-code";
export const AGENT_CLI = "claude-cli";
/**
 * Codex (DESIGN §8.1). A separate NAME rather than a `generic-cli` entry because it
 * is a separate adapter: `generic-cli` enforces nothing and §8.2 refuses it under
 * any policy that can ask a human, where codex has a real up-front channel (its
 * sandbox) and therefore declares `policyEnforcement: "config"` — which passes.
 */
export const AGENT_CODEX = "codex-cli";

/**
 * Spawn a CLI agent through a seam JaiRA can watch, in the project's execution
 * environment (DESIGN §4.2a, §9.1).
 *
 * Two jobs upstream's default spawn cannot do:
 *
 *  - **Track the process.** An abandoned agent keeps billing, and it was recorded
 *    nowhere; the observer is what makes an orphan findable.
 *  - **Reach into WSL.** Every other child JaiRA starts is mapped by
 *    {@link resolveInvocation}, and an agent must be too. It used to be expressed
 *    as `command: "wsl.exe"` plus `args: ["-d", distro, "--", "claude"]` on the
 *    adapter — which is WRONG, and silently: an adapter builds
 *    `[command, ...its own flags, ...args]`, so `wsl.exe` was handed the agent's
 *    flags before its own arguments and `--cd` was never passed at all. Mapping the
 *    whole argv HERE is the same thing Exec does, in the one place that sees the
 *    finished command line.
 *
 * Three details are copied deliberately from upstream's version and must not be
 * "tidied":
 *
 *  - **stderr is ignored, not piped.** An unread pipe fills at ~64 KB and the child
 *    then blocks forever on write, so stdout stops and `exit` never settles.
 *  - **an `error` listener is attached.** A `ChildProcess` `'error'` with no
 *    listener throws and would take the host process down — and ENOENT on a missing
 *    `claude` binary is the likeliest first-run outcome.
 *  - **stdin errors are swallowed.** An agent that answers before reading its whole
 *    prompt leaves an EPIPE on the pipe, which arrives as an unhandled `'error'`.
 */
export function agentSpawn(options: { execEnv?: ExecEnv; observer?: ExecObserver } = {}): SpawnProcess {
  return (argv, opts) => {
    const [agentCommand, ...agentArgs] = argv;
    const { file: command, argv: args, cwd } = resolveInvocation(agentCommand!, agentArgs, {
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    const child = spawn(command, args, {
      ...(cwd !== undefined ? { cwd } : {}),
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const observer = options.observer;

    let token: unknown;
    try {
      token = observer?.onSpawn({
        command,
        argv: args,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    } catch {
      token = undefined;
    }
    const observeExit = (code: number | null): void => {
      try {
        observer?.onExit(token, { code, signal: null });
      } catch {
        // Bookkeeping must not change the agent's outcome.
      }
    };

    let spawnError: Error | undefined;
    child.on("error", (e: Error) => {
      spawnError = e;
      lines.close();
    });

    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    }

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
  /** Where the agent runs. A WSL project drives the CLI adapters inside the distro. */
  execEnv?: ExecEnv;
  /** Records the agent subprocess as a job, so an abandoned one is findable. */
  observer?: ExecObserver;
  /**
   * Replace the agent-query seam — the whole reason this is testable without an
   * SDK, a `claude` binary, or a network: a fake query drives the same adapter.
   */
  query?: AgentQuery;
  /** Which adapters to register. Default: all three. */
  adapters?: Array<"sdk" | "cli" | "codex">;
  /** Extra options forwarded to the SDK adapter (tool injection, native renames). */
  sdk?: Omit<ClaudeCodeFunctionOptions, "query">;
  /** Path to the CLI binary (default: `claude` on PATH). */
  cliCommand?: string;
  /**
   * Replace the process seam the CLI adapters spawn through.
   *
   * The counterpart of {@link AgentRuntimeOptions.query} one level down: a fake query replaces the
   * whole transport, where a fake spawn keeps the real argv-building and stream-parsing and only
   * stands in for the binary — which is the half worth testing for a CLI agent.
   */
  spawn?: SpawnProcess;
  /** Path to the codex binary (default: `codex` on PATH). */
  codexCommand?: string;
  /**
   * The sandbox a codex run gets when the state names no permission mode
   * (default `workspace-write`).
   *
   * Worth setting to `read-only` for a project whose codex states only review:
   * it is codex's ONLY up-front enforcement channel, so it is what the honest
   * `policyEnforcement: "config"` rests on.
   */
  codexSandbox?: CodexSandbox;
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
  const adapters = options.adapters ?? ["sdk", "cli", "codex"];

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

  // Both CLI adapters get JaiRA's spawn: it is what maps the argv into the project's
  // execution environment (a WSL project runs its agent in the distro) and what
  // records the process as a job. Supplied ALWAYS, not just when an observer is
  // wired — upstream's default cannot reach WSL, and a silently-native agent in a
  // WSL project is the kind of wrong that looks like it works until paths differ.
  const spawn =
    options.spawn ??
    agentSpawn({
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      ...(options.observer !== undefined ? { observer: options.observer } : {}),
    });

  if (adapters.includes("cli")) {
    const cli =
      options.query !== undefined
        ? // A supplied query replaces the subprocess entirely, so the CLI adapter
          // becomes the SDK adapter with a different name — which is what makes the
          // registration path testable without a `claude` binary.
          createClaudeCodeFunction({ ...options.sdk, query: options.query })
        : createCliAgentFunction({
            ...options.sdk,
            ...(options.cliCommand !== undefined ? { command: options.cliCommand } : {}),
            spawn,
          });
    registry.functions.set(
      AGENT_CLI,
      runtimeFunction(cli.run as never, cli.capabilities) as never,
    );
  }

  if (adapters.includes("codex")) {
    // Registered whether or not the binary is present, exactly as `claude-cli` is: a
    // state that names it fails with codex's own "could not be started", which says
    // more than "unregistered function" would.
    const codex =
      options.query !== undefined
        ? createClaudeCodeFunction({ ...options.sdk, capabilities: CODEX_CAPS, approvalCallback: false, query: options.query })
        : createCodexAgentFunction({
            ...options.sdk,
            ...(options.codexCommand !== undefined ? { command: options.codexCommand } : {}),
            ...(options.codexSandbox !== undefined ? { sandbox: options.codexSandbox } : {}),
            spawn,
          });
    registry.functions.set(
      AGENT_CODEX,
      runtimeFunction(codex.run as never, codex.capabilities) as never,
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
