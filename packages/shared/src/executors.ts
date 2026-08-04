/**
 * The executor inventory as the UI sees it (DESIGN §8.1, §8.2).
 *
 * Types only, and in `shared` rather than `runtime`, because the renderer renders this list and
 * `runtime` is Node-only — importing it into the renderer's graph would break the bundle. The
 * behaviour that produces these values lives in `@jaira/runtime`'s `executors.ts`.
 */

/** How an executor is driven, which decides what a health check can even observe. */
export type ExecutorKind = "sdk" | "cli" | "codex" | "generic";

/** Which link of the secret chain supplied a credential. */
export type SecretSource =
  | "keychain"
  | "project-env-local"
  | "project-env"
  | "base-env-local"
  | "base-env"
  | "environment";

/**
 * Where a secret came from — deliberately WITHOUT the value.
 *
 * This is the shape that crosses IPC. The renderer needs to tell a user that their key was found
 * and which file it came from; it never needs the key, so it never receives one.
 */
export interface SecretOrigin {
  source: SecretSource;
  /** The file that supplied it, for the four file-backed sources. */
  file?: string;
}

/** One executor as configured, before anything is checked. */
export interface ExecutorInfo {
  /** The registry name a state's `function` uses. */
  name: string;
  kind: ExecutorKind;
  /** False when config turned it off — it is not registered at all. */
  enabled: boolean;
  /** The binary, for the kinds that have one. */
  command?: string;
  /** The secret this executor's credential is looked up under, when config names one. */
  credential?: string;
  /** What the runtime can enforce of the project's policy (DESIGN §8.2). */
  policyEnforcement: "callback" | "config" | "none";
  /** Set for a built-in whose behaviour config also tunes, e.g. codex's sandbox. */
  sandbox?: string;
}

/**
 * What a health check concluded.
 *
 * `not-checked` is a first-class outcome and not a synonym for `ok`: reporting an executor as
 * healthy when nothing was actually observed is the failure this surface exists to prevent.
 */
export type ProbeStatus = "ok" | "failed" | "disabled" | "not-checked";

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  /** One line, addressed to the user: what was found, or why it could not be. */
  detail: string;
  /** The binary's own version output, trimmed, when it gave one. */
  version?: string;
  /** Where the named credential resolved from — never the value. */
  credential?: SecretOrigin;
  /** Set when config names a credential and nothing in the chain supplies it. */
  credentialMissing?: string;
}

/** Human wording for a source, for a UI that has only the origin to show. */
export const SECRET_SOURCE_LABELS: Record<SecretSource, string> = {
  keychain: "OS keychain",
  "project-env-local": "project .env.local",
  "project-env": "project .env",
  "base-env-local": "shared .env.local",
  "base-env": "shared .env",
  environment: "environment variable",
};

/**
 * Where a secret should be WRITTEN.
 *
 * A deliberately shorter list than {@link SecretSource}: JaiRA will not write into a project's
 * committed `.env`, and it cannot write an environment variable into someone else's shell. What is
 * left is the encrypted store and the two files that are meant to be machine-local.
 */
export type SecretTarget = "keychain" | "project-env-local" | "base-env-local";

export const SECRET_TARGET_LABELS: Record<SecretTarget, string> = {
  keychain: "OS keychain (encrypted)",
  "project-env-local": "this project's .env.local",
  "base-env-local": "the shared root's .env.local",
};
