/**
 * The executor inventory as the UI sees it (DESIGN §8.1, §8.2).
 *
 * Types only, and in `shared` rather than `runtime`, because the renderer renders this list and
 * `runtime` is Node-only — importing it into the renderer's graph would break the bundle. The
 * behaviour that produces these values lives in `@jaira/runtime`'s `executors.ts`.
 */

/** How an executor is driven, which decides what a health check can even observe. */
export type ExecutorKind = "sdk" | "cli" | "codex" | "generic";

/**
 * What a credential MEANS for a kind of executor — three answers, not two.
 *
 * The middle one is the whole reason this exists. `claude-cli` authenticates itself: it carries the
 * subscription the user already signed into, and it will not read an API key out of the environment
 * to decide who it is. Offering a key field for it was worse than useless — it invited someone to
 * store a secret that nothing would ever read, and then to believe the executor was configured
 * because the box was filled in. `none` is therefore a claim about the RUNTIME, not a UI preference:
 * the parser refuses a `credential` under such an executor for the same reason.
 */
export type CredentialUse = "required" | "optional" | "none";

/**
 * One editable field of an executor — what the runtime IS, and nothing about which models it runs.
 *
 * Model limits used to live here too. They moved to the executor TREE's route node, because that is
 * what they are about: a limit on a route, not on the binary underneath it.
 */
export type ExecutorField =
  | "name"
  | "command"
  | "credential"
  | "sandbox"
  | "args"
  | "prompt"
  | "env";

/**
 * What each KIND of executor is, and what it can be configured with.
 *
 * One table rather than a `switch` per surface, because "which fields does codex have" was being
 * answered independently by the config parser, the form, and the probe — three answers that drifted.
 * A kind that gains a field gains it everywhere from here.
 */
export interface ExecutorKindSpec {
  label: string;
  /** One line, addressed to someone deciding whether they want this executor at all. */
  hint: string;
  /** The settings this kind actually has, in the order a form should offer them. */
  fields: ExecutorField[];
  /** Whether this runtime uses an API key at all — see {@link CredentialUse}. */
  credential: CredentialUse;
  /** The variable a `required`/`optional` key is conventionally kept under. A suggestion only. */
  suggestedCredential?: string;
}

/**
 * The four kinds, and the deliberately different shapes they take.
 *
 * `sdk` and `cli` are both Claude and they are NOT the same form: the in-process SDK is an API client
 * and needs a key; the CLI is a program that already knows who its user is and needs a path. Treating
 * them as one "executor" with one generic block is what produced a settings screen asking for an
 * Anthropic key in order to run a binary that would have ignored it.
 */
export const EXECUTOR_KINDS: Record<ExecutorKind, ExecutorKindSpec> = {
  sdk: {
    label: "in-process SDK",
    hint: "The Claude Agent SDK, running inside this process. Needs an API key and the npm package.",
    fields: ["credential"],
    credential: "required",
    suggestedCredential: "ANTHROPIC_API_KEY",
  },
  cli: {
    label: "Claude CLI",
    hint: "The `claude` binary, on its own subscription — it signs itself in, so no API key is used.",
    fields: ["command"],
    credential: "none",
  },
  codex: {
    label: "Codex CLI",
    hint: "The `codex` binary. Signs itself in, or uses a key when one is named. Enforces policy through its sandbox.",
    fields: ["command", "sandbox", "credential"],
    credential: "optional",
    suggestedCredential: "OPENAI_API_KEY",
  },
  generic: {
    label: "a CLI agent",
    hint: "Any other coding-agent binary, driven by an argv template. Enforces no policy of its own.",
    fields: ["name", "command", "args", "prompt", "env", "credential"],
    credential: "optional",
  },
};

/** Which link of the secret chain supplied a credential. */
export type SecretSource =
  | "keychain"
  | "project-jaira-env-local"
  | "project-jaira-env"
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
  /** The file that supplied it, for the six file-backed sources. */
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
  /**
   * Whether this runtime uses a key at all — {@link EXECUTOR_KINDS}, carried on the instance.
   *
   * Carried rather than re-derived because every consumer needs it and the kind table lives in one
   * package: the probe decides whether a missing key is a failure, and the form decides whether to
   * offer the box, from this one field.
   */
  credentialUse: CredentialUse;
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
 *
 * `needs-sign-in` is its own word, and a WARNING rather than a failure: the binary answers and nothing
 * is broken — somebody has to sign it in (or in again, when a run's call on its login was refused).
 */
export type ProbeStatus = "ok" | "failed" | "disabled" | "not-checked" | "needs-sign-in";

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
  /**
   * What would FIX a `failed` route or executor, in one imperative line.
   *
   * Separate from `detail` because they are different sentences and the UI shows them differently:
   * `detail` is what was observed, this is what to do about it. A check that concludes "unavailable"
   * without saying how to change that is the thing this whole surface was added to stop doing.
   */
  fix?: string;
  /**
   * Who an agent that signs itself in is signed in AS — only for one whose sign-in could be read.
   *
   * A LIST with the one in use marked `active`, though every CLI today holds exactly one: a runtime
   * that keeps several sign-ins (and the app switching between them) is a new row here, not a new
   * shape. Empty means it was read and there is none; absent means it could not be read, or the
   * executor has no sign-in to read (a key, an SDK).
   */
  accounts?: AgentAccount[];
}

/** What a sign-in or sign-out came to: done, or the binary's own words for why not. */
export type SignInOutcome = { ok: true } | { ok: false; reason: string };

/** One sign-in an agent holds — never a secret, only what the agent itself prints about it. */
export interface AgentAccount {
  /** Who: the account's email, or the kind of sign-in when the agent names no one ("ChatGPT"). */
  label: string;
  /** How it signed in, in the agent's own word: `claude.ai`, `console`, `ChatGPT`, `bedrock`. */
  method?: string;
  /** The subscription it carries, in the agent's own word: `max`, `pro`. */
  plan?: string;
  organization?: string;
  /** The sign-in calls go out on. */
  active: boolean;
  /** Why a run's call on this sign-in was REFUSED, in the agent's words — the stored sign-in reads fine and does not work. */
  refused?: string;
}

/**
 * Everything the app observed about who can answer a prompt, and when it looked.
 *
 * One snapshot rather than two independent probe maps because it is read as one question — *what can
 * run here right now?* — and because the answer includes {@link AvailabilitySnapshot.defaultModel},
 * which is derived from BOTH halves and would otherwise be recomputed differently by each caller.
 */
import type { JairaOperationNode } from "./executorTree";
import type { ForgeCheck } from "./forge";

export interface AvailabilitySnapshot {
  /** Provider routes, keyed in `MODEL_ROUTE_KEYS` order. */
  routes: ProbeResult[];
  /** Executors, in inventory order. */
  executors: ProbeResult[];
  /** Forge connections, in configuration order — each checked by asking its host who the token is. */
  forges?: ForgeCheck[];
  /**
   * The DEFAULT executor, resolved — the whole tree, derived from what the checks above found.
   *
   * The tree rather than a chosen model id, because a model id could never be the answer: it cannot
   * route, and a default naming an agent was invisible to the routing that has to happen first. What
   * a state with no model of its own gets is this executor.
   */
  tree?: JairaOperationNode;
  /** Epoch ms of the check, or 0 when none has run yet. */
  checkedAt: number;
}

/**
 * The variable each built-in executor's key is conventionally kept under.
 *
 * A SUGGESTION for the settings UI and nothing more: no lookup falls back to these, because a
 * credential that is found under a name the config never mentions is a credential nobody can trace.
 * What they are for is the first-run case — someone has an Anthropic key and no idea what JaiRA
 * wants it called — where offering the conventional name is the difference between a filled-in
 * field and a search through the documentation.
 *
 * `claude-cli` is absent, and its absence is the point: the CLI signs itself in, so there is no key
 * for it to suggest and the form does not offer one ({@link EXECUTOR_KINDS}).
 */
export const SUGGESTED_CREDENTIALS: Record<string, string> = {
  "claude-code": "ANTHROPIC_API_KEY",
  "codex-cli": "OPENAI_API_KEY",
};

/** Human wording for a source, for a UI that has only the origin to show. */
export const SECRET_SOURCE_LABELS: Record<SecretSource, string> = {
  keychain: "OS keychain",
  "project-jaira-env-local": "project .jaira/.env.local",
  "project-jaira-env": "project .jaira/.env",
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
  "project-env-local": "this project's .jaira/.env.local",
  "base-env-local": "the shared root's .env.local",
};
