/**
 * Project config — `.jaira/config.json` (DESIGN §3). v1 carries provider
 * bindings (name → llm-call config) and the artifact root; exec environment,
 * policy, and runner adapters arrive in later phases.
 */

export interface JairaConfig {
  /** `agent.provider` name → llm-call defaults (model, sampling, …).
   *  Bound via @ai-exec/hw `llmCallBinding` at run time. */
  providers: Record<string, Record<string, unknown>>;
  /** Artifact root relative to the project dir (DESIGN §15 Q1). */
  artifactDir: string;
}

export const DEFAULT_ARTIFACT_DIR = "jaira-artifacts";

export function defaultConfig(): JairaConfig {
  return { providers: {}, artifactDir: DEFAULT_ARTIFACT_DIR };
}

export function parseConfig(raw: unknown): JairaConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be a JSON object");
  }
  const cfg = raw as Record<string, unknown>;
  const providers: Record<string, Record<string, unknown>> = {};
  if (cfg["providers"] !== undefined) {
    if (cfg["providers"] === null || typeof cfg["providers"] !== "object" || Array.isArray(cfg["providers"])) {
      throw new Error("config.providers must be an object");
    }
    for (const [name, value] of Object.entries(cfg["providers"] as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`config.providers.${name} must be an object`);
      }
      providers[name] = value as Record<string, unknown>;
    }
  }
  const artifactDir = cfg["artifactDir"] ?? DEFAULT_ARTIFACT_DIR;
  if (typeof artifactDir !== "string" || artifactDir.length === 0) {
    throw new Error("config.artifactDir must be a non-empty string");
  }
  return { providers, artifactDir };
}
