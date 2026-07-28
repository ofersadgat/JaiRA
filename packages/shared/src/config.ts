/**
 * Project config — `.jaira/config.json` (DESIGN §3).
 *
 * Since the declarative-ai ops redesign a state names its model directly in
 * `operation.config.model`, so the old `providers` map (name → llm-call config,
 * bound through the removed `llmCallBinding`) is gone. What remains project-level
 * is the DEFAULT model a state inherits when it names none, plus the artifact
 * root. Exec environment, policy, and agent runtimes arrive in later phases.
 */
import type { JsonValue } from "@declarative-ai/json";

export interface JairaModelConfig {
  /**
   * Default model id for states that name none. Must be route-prefixed
   * (`anthropic/claude-sonnet-5`, `openrouter/openai/gpt-5`) — routing is
   * explicit in declarative-ai, and a bare id is a fail-fast error.
   */
  default?: string;
}

/**
 * Where this project's commands run (DESIGN §9.1). `"windows"` spawns natively;
 * `{ "wsl": "Ubuntu" }` runs git and agents inside that distro — deliberately not
 * Windows git against `\\wsl$`, which is slow and permission-fragile.
 */
export type JairaExecEnvironment = "windows" | { wsl: string };

/**
 * A non-Claude coding-agent CLI (DESIGN §8.1's `generic-cli`, §16).
 *
 * Registered by `@jaira/runtime`'s `registerGenericAgents` and driven through
 * JaiRA's Exec layer, so a WSL project runs it inside the distro. It is
 * **policy-weak by design**: a generic binary has no permission callback, so §8.2's
 * capability gate refuses it under a policy that can require approval rather than
 * letting it run unguarded.
 */
export interface JairaGenericCliAgent {
  /** Registry name a state's `functionRef` uses. Default `generic-cli`. */
  name?: string;
  /** The executable. */
  command: string;
  /**
   * argv template. A literal `{prompt}` element is replaced by the instruction;
   * with no placeholder the prompt is appended after `--`.
   */
  args?: string[];
  /** How the instruction reaches the binary. Default: as an argument. */
  prompt?: "argument" | "stdin";
  /** Extra environment for the child process. */
  env?: Record<string, string>;
}

export interface JairaAgentConfig {
  /** Non-Claude CLIs available to this project. */
  genericCli?: JairaGenericCliAgent[];
}

export interface JairaConfig {
  models: JairaModelConfig;
  /** Artifact root relative to the project dir (DESIGN §15 Q1). */
  artifactDir: string;
  execEnvironment: JairaExecEnvironment;
  /**
   * The project's safety policy (DESIGN §10.1). Kept as opaque JSON here and
   * compiled by `@jaira/runtime`'s `compilePolicy`: `shared` must stay free of the
   * permission model so the renderer's bundle does not pull it in. An empty policy
   * means "built-in rules only" (SPEC §11.2/§11.3), which is the safe default.
   */
  policy: Record<string, JsonValue>;
  /** Agent runtimes beyond the built-in Claude adapters (DESIGN §8.1). */
  agents: JairaAgentConfig;
}

export const DEFAULT_ARTIFACT_DIR = "jaira-artifacts";

export function defaultConfig(): JairaConfig {
  return { models: {}, artifactDir: DEFAULT_ARTIFACT_DIR, execEnvironment: "windows", policy: {}, agents: {} };
}

/**
 * Parse the generic-agent list.
 *
 * Strict rather than forgiving: a typo here means a state either fails as
 * "unregistered function" or runs the wrong binary, and both are worse than a
 * config error naming the field.
 */
function parseAgents(raw: unknown): JairaAgentConfig {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.agents must be an object");
  }
  const list = (raw as Record<string, unknown>)["genericCli"];
  if (list === undefined) return {};
  if (!Array.isArray(list)) throw new Error("config.agents.genericCli must be an array");
  const genericCli = list.map((entry, i) => {
    const where = `config.agents.genericCli[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${where} must be an object`);
    }
    const spec = entry as Record<string, unknown>;
    if (typeof spec["command"] !== "string" || spec["command"].length === 0) {
      throw new Error(`${where}.command must be a non-empty string`);
    }
    if (spec["args"] !== undefined && !(Array.isArray(spec["args"]) && spec["args"].every((a) => typeof a === "string"))) {
      throw new Error(`${where}.args must be an array of strings`);
    }
    if (spec["prompt"] !== undefined && spec["prompt"] !== "argument" && spec["prompt"] !== "stdin") {
      throw new Error(`${where}.prompt must be "argument" or "stdin"`);
    }
    if (spec["name"] !== undefined && (typeof spec["name"] !== "string" || spec["name"].length === 0)) {
      throw new Error(`${where}.name must be a non-empty string`);
    }
    if (
      spec["env"] !== undefined &&
      (spec["env"] === null ||
        typeof spec["env"] !== "object" ||
        Array.isArray(spec["env"]) ||
        !Object.values(spec["env"] as Record<string, unknown>).every((v) => typeof v === "string"))
    ) {
      throw new Error(`${where}.env must be an object of strings`);
    }
    return spec as unknown as JairaGenericCliAgent;
  });
  return { genericCli };
}

function parseExecEnvironment(raw: unknown): JairaExecEnvironment {
  if (raw === undefined) return "windows";
  if (raw === "windows") return "windows";
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const distro = (raw as Record<string, unknown>)["wsl"];
    if (typeof distro === "string" && distro.length > 0) return { wsl: distro };
  }
  throw new Error('config.execEnvironment must be "windows" or { "wsl": "<distro>" }');
}

export function parseConfig(raw: unknown): JairaConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be a JSON object");
  }
  const cfg = raw as Record<string, unknown>;

  const models: JairaModelConfig = {};
  if (cfg["models"] !== undefined) {
    if (cfg["models"] === null || typeof cfg["models"] !== "object" || Array.isArray(cfg["models"])) {
      throw new Error("config.models must be an object");
    }
    const raw = (cfg["models"] as Record<string, unknown>)["default"];
    if (raw !== undefined) {
      if (typeof raw !== "string" || raw.length === 0) {
        throw new Error("config.models.default must be a non-empty string");
      }
      if (!raw.includes("/")) {
        throw new Error(
          `config.models.default '${raw}' must be route-prefixed, e.g. 'anthropic/claude-sonnet-5' or 'openrouter/openai/gpt-5'`,
        );
      }
      models.default = raw;
    }
  }

  const artifactDir = cfg["artifactDir"] ?? DEFAULT_ARTIFACT_DIR;
  if (typeof artifactDir !== "string" || artifactDir.length === 0) {
    throw new Error("config.artifactDir must be a non-empty string");
  }
  const rawPolicy = cfg["policy"];
  if (rawPolicy !== undefined && (rawPolicy === null || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))) {
    throw new Error("config.policy must be an object");
  }
  return {
    models,
    artifactDir,
    execEnvironment: parseExecEnvironment(cfg["execEnvironment"]),
    policy: (rawPolicy as Record<string, JsonValue> | undefined) ?? {},
    agents: parseAgents(cfg["agents"]),
  };
}
