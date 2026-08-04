/**
 * The executor inventory and its health check (DESIGN §8.1, §8.2).
 *
 * "Executor" is the user-facing word for what the registry calls a delegated agent runtime: the
 * things a state reaches with `operation.function: "claude-cli"`. There are three built in and any
 * number configured, and until now the only way to find out whether one actually worked on this
 * machine was to start a task and watch it fail.
 *
 * This module answers two questions the app needs and the CLI benefits from:
 *
 *  - **Which executors exist, and is each one turned on?** `enabled: false` removes a runtime from
 *    the registry rather than registering a stub that refuses when called, so a workflow that
 *    cannot run here fails at start with "unregistered function" instead of halfway through.
 *  - **Would this one work if a state named it?** {@link probeExecutor} runs the check without
 *    running the agent: the binary resolves and answers, and the credential the config names is
 *    findable. It never starts a session and never spends money.
 *
 * A probe reports what it OBSERVED, and says so when it could not observe anything. "Not checked"
 * is a distinct outcome from "working", because reporting an unverifiable executor as healthy is
 * the failure this whole surface exists to prevent.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  BUILTIN_EXECUTORS,
  type ExecutorInfo,
  type JairaAgentConfig,
  type JairaConfig,
  type JairaExecutorConfig,
  type JairaGenericCliAgent,
  type ProbeResult,
  type ProbeStatus,
  type SecretOrigin,
} from "@jaira/shared";
import { AGENT_CLI, AGENT_CODEX, AGENT_SDK } from "./agents";
import { AGENT_GENERIC_CLI } from "./genericAgent";
import type { Exec } from "./exec";
import type { ExecEnv } from "./paths";
import { SecretResolver } from "./secrets";

// The wire shapes live in `shared` so the renderer can name them; the behaviour lives here.
export type { ExecutorInfo, ExecutorKind, ProbeResult, ProbeStatus } from "@jaira/shared";

/** The default binary for each CLI-backed built-in. */
const DEFAULT_COMMANDS: Record<string, string> = {
  [AGENT_CLI]: "claude",
  [AGENT_CODEX]: "codex",
};

/** Enabled unless config says otherwise — a project that configures nothing gets everything. */
function isEnabled(spec: JairaExecutorConfig | undefined): boolean {
  return spec?.enabled !== false;
}

/**
 * Attach only the optional fields that have a value.
 *
 * `exactOptionalPropertyTypes` is on, so `{ command: undefined }` is not the same as an absent
 * `command` — and an IPC payload with explicit `undefined`s survives structured cloning as null.
 */
function withOptional<T extends object>(base: T, extra: Record<string, string | undefined>): T {
  const out: Record<string, unknown> = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value;
  return out as T;
}

/**
 * Every executor this project could use, built-ins first and configured CLIs after.
 *
 * Built-ins are always LISTED, even when disabled — the list is what the settings UI renders, and
 * an executor you turned off has to stay visible or there is no way to turn it back on.
 */
export function listExecutors(agents: JairaAgentConfig = {}): ExecutorInfo[] {
  const out: ExecutorInfo[] = [
    withOptional<ExecutorInfo>(
      { name: AGENT_SDK, kind: "sdk", enabled: isEnabled(agents.claudeCode), policyEnforcement: "callback" },
      { credential: agents.claudeCode?.credential },
    ),
    withOptional<ExecutorInfo>(
      { name: AGENT_CLI, kind: "cli", enabled: isEnabled(agents.claudeCli), policyEnforcement: "callback" },
      { command: agents.claudeCli?.command ?? DEFAULT_COMMANDS[AGENT_CLI], credential: agents.claudeCli?.credential },
    ),
    withOptional<ExecutorInfo>(
      { name: AGENT_CODEX, kind: "codex", enabled: isEnabled(agents.codex), policyEnforcement: "config" },
      {
        command: agents.codex?.command ?? DEFAULT_COMMANDS[AGENT_CODEX],
        credential: agents.codex?.credential,
        sandbox: agents.codex?.sandbox,
      },
    ),
  ];
  for (const spec of agents.genericCli ?? []) {
    out.push(
      withOptional<ExecutorInfo>(
        {
          name: spec.name ?? AGENT_GENERIC_CLI,
          kind: "generic",
          enabled: isEnabled(spec),
          // A generic binary has no permission callback, which is the whole of §8.2's objection.
          policyEnforcement: "none",
        },
        { command: spec.command, credential: spec.credential },
      ),
    );
  }
  return out;
}

/** Which built-in adapters `registerAgentRuntimes` should install for this config. */
export function enabledAdapters(agents: JairaAgentConfig = {}): Array<"sdk" | "cli" | "codex"> {
  const out: Array<"sdk" | "cli" | "codex"> = [];
  if (isEnabled(agents.claudeCode)) out.push("sdk");
  if (isEnabled(agents.claudeCli)) out.push("cli");
  if (isEnabled(agents.codex)) out.push("codex");
  return out;
}

/** The generic CLIs that are turned on — what `registerGenericAgents` should receive. */
export function enabledGenericAgents(agents: JairaAgentConfig = {}): JairaGenericCliAgent[] {
  return (agents.genericCli ?? []).filter((spec) => isEnabled(spec));
}

export interface ProbeOptions {
  exec: Exec;
  execEnv?: ExecEnv;
  secrets?: SecretResolver;
  /** How long the version check may take. A missing binary should fail fast, not hang the UI. */
  timeoutMs?: number;
  /** Resolve a module id — injected so a test can check the SDK branch without installing it. */
  resolve?: (id: string) => string;
}

/** The package the `claude-code` runtime drives in process. */
const AGENT_SDK_MODULE = "@anthropic-ai/claude-agent-sdk";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolve a module id from this package's own position, under either module system.
 *
 * `createRequire(import.meta.url)` is the obvious spelling and it is wrong here: the Electron main
 * process is bundled to CJS, where esbuild empties `import.meta` — `createRequire(undefined)` then
 * throws a TypeError, so probing an `sdk` executor in the real app failed with a crash instead of an
 * answer. `__filename` exists in exactly the case `import.meta` does not, so branching on it keeps
 * one expression correct in both and keeps `import.meta` out of a CJS bundle entirely.
 *
 * Built lazily rather than at module load: this is only needed by the `sdk` branch, and a resolver
 * that throws while being constructed would take the whole inventory down with it.
 */
function defaultResolve(id: string): string {
  const base = typeof __filename === "string" ? __filename : join(process.cwd(), "noop.js");
  return createRequire(base).resolve(id);
}

/**
 * Check one executor without running it.
 *
 * The version flag is the check because it is the one invocation every one of these binaries
 * supports, exits from immediately, and cannot be talked into doing work. Anything richer would
 * mean starting a session — which costs money and is exactly what a user pressing "Test" does not
 * expect to happen.
 */
export async function probeExecutor(info: ExecutorInfo, options: ProbeOptions): Promise<ProbeResult> {
  if (!info.enabled) {
    return { name: info.name, status: "disabled", detail: "turned off in this project's configuration" };
  }

  // The credential is checked for every kind, because a present binary with no key fails at the
  // first call — and "the binary is there" would otherwise read as "this works".
  const credential = probeCredential(info, options.secrets);

  if (info.kind === "sdk") {
    const resolve = options.resolve ?? defaultResolve;
    try {
      resolve(AGENT_SDK_MODULE);
    } catch {
      return {
        name: info.name,
        status: "failed",
        detail: `'${AGENT_SDK_MODULE}' is not installed, so the in-process adapter cannot run`,
        ...credential,
      };
    }
    return {
      name: info.name,
      status: credential.credentialMissing !== undefined ? "failed" : "ok",
      detail:
        credential.credentialMissing !== undefined
          ? `the SDK is installed, but no value was found for '${credential.credentialMissing}'`
          : `'${AGENT_SDK_MODULE}' is installed`,
      ...credential,
    };
  }

  if (info.command === undefined) {
    return { name: info.name, status: "not-checked", detail: "no command is configured to check", ...credential };
  }

  let result;
  try {
    result = await options.exec.run(info.command, ["--version"], {
      ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch (e) {
    return { name: info.name, status: "failed", detail: `'${info.command}' could not be started: ${(e as Error).message}`, ...credential };
  }

  if (result.timedOut) {
    return { name: info.name, status: "failed", detail: `'${info.command} --version' did not answer in time`, ...credential };
  }
  if (result.code !== 0) {
    // A non-zero exit is reported with the binary's OWN words: "not recognized" and "permission
    // denied" are different problems, and paraphrasing them loses the difference.
    const said = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? "";
    return {
      name: info.name,
      status: "failed",
      detail: `'${info.command} --version' exited ${result.code}${said ? `: ${said}` : ""}`,
      ...credential,
    };
  }

  const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.trim();
  if (credential.credentialMissing !== undefined) {
    return {
      name: info.name,
      status: "failed",
      detail: `'${info.command}' runs, but no value was found for '${credential.credentialMissing}'`,
      ...(version ? { version } : {}),
      ...credential,
    };
  }
  return {
    name: info.name,
    status: "ok",
    detail: `'${info.command}' responded`,
    ...(version ? { version } : {}),
    ...credential,
  };
}

/** Resolve the named credential, reporting only its ORIGIN — the value must not leave this process. */
function probeCredential(
  info: ExecutorInfo,
  secrets: SecretResolver | undefined,
): { credential?: SecretOrigin; credentialMissing?: string } {
  if (info.credential === undefined) return {};
  const origin = secrets?.describe(info.credential);
  if (origin === undefined) return { credentialMissing: info.credential };
  return { credential: origin };
}

/** Probe every executor a project has. Concurrent: each is an independent short-lived process. */
export async function probeExecutors(config: JairaConfig, options: ProbeOptions): Promise<ProbeResult[]> {
  return Promise.all(listExecutors(config.agents).map((info) => probeExecutor(info, options)));
}

/** The built-in names, re-exported so a caller need not know which module defines each adapter. */
export { BUILTIN_EXECUTORS };
