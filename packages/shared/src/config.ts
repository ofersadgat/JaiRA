/**
 * Project config — `.jaira/config.json` (DESIGN §3).
 *
 * Since the declarative-ai ops redesign a state names its model directly in
 * `operation.config.model`, so the old `providers` map (name → llm-call config,
 * bound through the removed `llmCallBinding`) is gone. What remains project-level
 * is the DEFAULT model a state inherits when it names none, plus the artifact
 * root. Exec environment, policy, and agent runtimes arrive in later phases.
 */

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

export interface JairaConfig {
  models: JairaModelConfig;
  /** Artifact root relative to the project dir (DESIGN §15 Q1). */
  artifactDir: string;
  execEnvironment: JairaExecEnvironment;
}

export const DEFAULT_ARTIFACT_DIR = "jaira-artifacts";

export function defaultConfig(): JairaConfig {
  return { models: {}, artifactDir: DEFAULT_ARTIFACT_DIR, execEnvironment: "windows" };
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
  return { models, artifactDir, execEnvironment: parseExecEnvironment(cfg["execEnvironment"]) };
}
