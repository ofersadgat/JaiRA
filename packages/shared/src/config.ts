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
import type { CredentialUse } from "./executors";
import { EXECUTOR_STEPS, type JairaExecutorSteps } from "./executorStack";
import { parseFunctionRule, type JairaOperationNode, type JairaPromptNode } from "./executorTree";

/**
 * How each provider route is REACHED, and the named presets.
 *
 * There is no `default` here any more, and its absence is the point. A default MODEL was always the
 * wrong shape for the question: what a state with no model of its own needs is a default EXECUTOR —
 * something that can route — and a bare id could not be one. It also could not work, because
 * `PromptRouterExecutor` dispatches on `op.config.model` while `defaults` are applied inside a leaf's
 * lowering: a default naming an agent was invisible to the routing that had to happen first, so it
 * fell through to the provider path and was refused there. The default call settings now belong to
 * the default executor's prompt node, which applies them BEFORE dispatch (`./executorTree`).
 */
export interface JairaModelConfig {
  /**
   * How each route prefix is REACHED, keyed by the prefix itself.
   *
   * Prefix-keyed because that is what a model id already is: `anthropic/…` and
   * `openrouter/…` name remote fleets that each need their own key, `local/…` an
   * OpenAI-compatible server on this machine, `embedded/…` weights loaded into this
   * process. One map keyed the way the ids are, rather than four differently-shaped
   * blocks that have to be kept in step with them.
   *
   * Absent is the ordinary case: with nothing here the provider SDKs read
   * `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` from the process environment, exactly as
   * before. What this adds is the ability to name a secret that lives somewhere the
   * environment does not — the OS keychain, or a `.env.local` beside the project.
   */
  routes?: Record<string, JairaModelRoute>;
  /**
   * Named prompt-op configurations, selected per state by `operation.configRef`.
   *
   * The mechanism is upstream's and predates this block: `configRef` resolves against
   * a `ConfigurationRegistry` and merges UNDER a state's inline config and OVER the
   * defaults. All that was ever missing was somewhere to write the presets down.
   */
  presets?: Record<string, Record<string, JsonValue>>;
}

/**
 * One serving route's settings — declarative-ai's `ModelRouterOptions`, as config.
 *
 * Deliberately one shape rather than four: which fields apply follows from the KEY,
 * the parser says so when they disagree, and a flat block is what a settings form can
 * render without first learning the taxonomy.
 */
export interface JairaModelRoute {
  /** Off without deleting it, so a route can be parked rather than retyped later. */
  enabled?: boolean;
  /**
   * The SECRET this route's key is looked up under — a name, never a key.
   *
   * Resolved through the same chain every executor credential uses (OS keychain,
   * `.env.local`/`.env` beside the project, then the base root, then the process
   * environment), because `config.json` is committed source and a key written into it
   * is a key in everyone's checkout.
   */
  credential?: string;
  /** `local` only: the OpenAI-compatible server's base URL, version path included. */
  baseURL?: string;
  /** `local` only: extra request headers. */
  headers?: Record<string, string>;
  /**
   * `local` only: can this server honour a full `response_format: json_schema`?
   *
   * A CEILING on the per-call decision, not a switch — `llama-server` and vLLM can, a
   * bare completion shim in front of llama.cpp cannot. Default true.
   */
  supportsStructuredOutputs?: boolean;
  /**
   * `local` only: how to START the server when nothing answers `baseURL`.
   *
   * Absent ⇒ attached; the server is expected to be running already. Present ⇒ the
   * router probes first and starts the process only if nothing answers, so someone who
   * already has one running keeps theirs.
   */
  serve?: JairaLocalServerSpec;
  /** `embedded` only: provider-native model id → the weights to load for it. */
  weights?: Record<string, JairaEmbeddedWeights>;
}

export interface JairaLocalServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Polled until it answers. Defaults to `${baseURL}/models`. */
  readyUrl?: string;
  readyTimeoutMs?: number;
}

export interface JairaEmbeddedWeights {
  /** Filesystem path to the GGUF. For a split model, the FIRST part. */
  modelPath: string;
  contextSize?: number;
  gpuLayers?: number | "auto" | "max";
  sequences?: number;
}

/**
 * Where this project's commands run (DESIGN §9.1). `"windows"` spawns natively;
 * `{ "wsl": "Ubuntu" }` runs git and agents inside that distro — deliberately not
 * Windows git against `\\wsl$`, which is slow and permission-fragile.
 */
export type JairaExecEnvironment = "windows" | { wsl: string };

/**
 * What every executor has in common, whatever adapter drives it.
 *
 * `enabled: false` takes the runtime out of the registry entirely, so a state naming it fails as an
 * unregistered function. That is deliberately louder than registering a disabled stub that refuses
 * at call time: a workflow which cannot run in this project should say so before it starts, not
 * halfway through.
 *
 * `credential` names a SECRET, never holds one. The value is resolved at run time through the
 * lookup chain (OS keychain, then `.env.local`/`.env` beside the project, then the same two in the
 * base root, then the process environment), because `config.json` is committed source and a key in
 * it is a key in everyone's checkout.
 */
/**
 * What every agent runtime carries: whether it exists here, and how it authenticates.
 *
 * Deliberately NOT which models it may run. That was `agents.<executor>.models`, and it was the wrong
 * place: which models a route may be asked for is a fact about the ROUTE, and the route lives in the
 * executor tree (`executors.<name>.prompt.routes.<prefix>`). Two homes for one setting meant two
 * screens, two parsers, and a question — "does this limit apply to the tree's route or to the agent
 * underneath it?" — with no good answer. This block is now only what the agent IS.
 */
export interface JairaExecutorConfig {
  enabled?: boolean;
  credential?: string;
}

/** The built-in executors, by the registry name a state's `functionRef` uses. */
export const BUILTIN_EXECUTORS = ["claude-code", "claude-cli", "codex-cli"] as const;
export type BuiltinExecutor = (typeof BUILTIN_EXECUTORS)[number];

/**
 * The in-process Claude Agent SDK adapter (`claude-code`).
 *
 * An API client: it needs a key and has no binary to point at. That it takes `credential` and no
 * `command`, where {@link JairaClaudeCliConfig} takes the opposite, is the whole difference between
 * the two Claude runtimes — and the reason they are two types rather than one shared block.
 */
export interface JairaClaudeCodeConfig extends JairaExecutorConfig {
  credential?: string;
}

/**
 * The subprocess Claude adapter (`claude-cli`).
 *
 * **No `credential`, deliberately.** `claude` authenticates itself against the subscription its user
 * signed into; it does not take an API key from JaiRA and would ignore one. A field for it invited
 * someone to store a secret nothing reads and then to believe the executor was configured because
 * the box was full — so the parser refuses it and names the reason.
 */
export interface JairaClaudeCliConfig extends JairaExecutorConfig {
  /** Path to the binary. Default `claude` on PATH. */
  command?: string;
  credential?: never;
}

/** @deprecated The two Claude adapters no longer share a shape — see the two types above. */
export type JairaClaudeAgentConfig = JairaClaudeCodeConfig & { command?: string };

/**
 * A non-Claude coding-agent CLI (DESIGN §8.1's `generic-cli`, §16).
 *
 * Registered by `@jaira/runtime`'s `registerGenericAgents` and driven through
 * JaiRA's Exec layer, so a WSL project runs it inside the distro. It is
 * **policy-weak by design**: a generic binary has no permission callback, so §8.2's
 * capability gate refuses it under a policy that can require approval rather than
 * letting it run unguarded.
 */
export interface JairaGenericCliAgent extends JairaExecutorConfig {
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

/**
 * The codex adapter's project settings (DESIGN §8.1).
 *
 * Codex is NOT a `generic-cli` entry: that runtime enforces nothing and §8.2 refuses
 * it under any policy that can ask a human, where codex has a real up-front channel
 * — its sandbox — and so declares `policyEnforcement: "config"`.
 */
export interface JairaCodexAgentConfig extends JairaExecutorConfig {
  /** The executable. Default: `codex` on PATH. */
  command?: string;
  /**
   * The sandbox a codex state gets when it names no permission mode.
   *
   * This is the whole of codex's up-front enforcement, so it is what the `config`
   * claim rests on. `read-only` is the right setting for a project whose codex
   * states only review — an agent that cannot write cannot be talked into writing.
   */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface JairaAgentConfig {
  /** Non-Claude CLIs available to this project. */
  genericCli?: JairaGenericCliAgent[];
  /** Settings for the built-in `codex-cli` runtime. */
  codex?: JairaCodexAgentConfig;
  /** Settings for the built-in `claude-code` runtime (the in-process SDK adapter). */
  claudeCode?: JairaClaudeCodeConfig;
  /** Settings for the built-in `claude-cli` runtime (the subprocess adapter). */
  claudeCli?: JairaClaudeCliConfig;
}

/**
 * Where artifacts are stored (DESIGN §7.6).
 *
 * `destination` is a URI/path template rather than an enumerated mode, because
 * "which backend" and "how the path is derived" are independent questions and an
 * enum conflates them. `virtual:` keeps content in memory; anything else is a
 * `file:` path (the scheme is implicit) built from a closed variable set.
 */
export interface JairaArtifactConfig {
  /** e.g. `$DEFAULT`, `$CENTRAL`, `$JAIRA/artifacts/$TASK_ID/$RELPATH`, `virtual:`. */
  destination: string;
  /** What `$ARTIFACT_DIR` expands to. */
  dir: string;
  /** Keep content inline below this size, so bindings and prompts stay cheap. */
  inlineMaxBytes: number;
}

export const DEFAULT_ARTIFACT_DESTINATION = "$DEFAULT";
export const DEFAULT_INLINE_MAX_BYTES = 65_536;

export interface JairaConfig {
  models: JairaModelConfig;
  /**
   * Named executors, each a TREE (`./executorTree`) — the configuration of every level.
   *
   * `default` is the one every UI-initiated operation uses, and it always resolves: what is stored
   * here is a sparse OVERLAY, and `resolveExecutorTree` derives the rest from what is available. An
   * empty map therefore still means "an operation executor over a function executor and a router
   * across every provider and agent" — the tree JaiRA used to build by hand and could not express.
   */
  executors: Record<string, JairaOperationNode>;
  /**
   * @deprecated Use `artifacts.dir`. Kept because it was the original §15 Q1
   * surface and existing configs set it; it seeds `artifacts.dir` when present.
   */
  artifactDir: string;
  /** Where artifacts are stored (DESIGN §7.6). */
  artifacts: JairaArtifactConfig;
  /** Durable memoization of model calls — off unless asked for. */
  memo: JairaMemoConfig;
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
  /** Where workflow references are looked up (EXPRESSIONS.md §4). */
  workflows: JairaWorkflowConfig;
}

export interface JairaWorkflowConfig {
  /**
   * The ordered roots a BARE reference is searched along — shell `PATH` semantics, first match wins.
   *
   * Entries may use the `$JAIRA` / `$PROJECT` / `$BASE` roots or be absolute; they may NOT be bare,
   * or resolving the path would need the path. A subtree overrides or extends this through an
   * `environment.path`, spliced with `"$INHERITED"`.
   *
   * A file found at ANY entry keeps its bare state id, so an earlier entry OVERRIDES a later one
   * rather than sitting beside it: that is how a project customizes a workflow it gets from the
   * shared base root. A state id is a RELATIVE PATH resolved against this list, exactly as a bare
   * command name resolves against a shell's `PATH` — it has always needed a project to mean
   * anything, and within one resolution it still names exactly one file.
   *
   * **Absent is the normal case**, and it means "the layers, in order": the path is generated from
   * `jairaPaths().roots` by `workflowSearchPath`. Setting it is an override for a project that
   * needs something the layer model does not express — and it replaces the generated list rather
   * than extending it, so a project that sets it takes on naming every root it wants.
   */
  path?: string[];
}

/**
 * The default search path is **generated**, not written down: `jairaPaths().roots` is the one list,
 * and `workflowSearchPath` derives `<root>/workflows` + `<root>/functions` from it. An absent
 * `config.workflows.path` therefore means "the layers, in order", and adding a layer cannot leave a
 * hand-maintained constant behind.
 *
 * This constant remains only as the SPELLING of that default, for a UI that wants to show a user
 * what they are overriding. Nothing resolves against it.
 */
export const DEFAULT_WORKFLOW_PATH_SPELLING = [
  "$JAIRA/workflows",
  "$JAIRA/functions",
  "$BASE/workflows",
  "$BASE/functions",
];

export const DEFAULT_ARTIFACT_DIR = "jaira-artifacts";

/**
 * Durable memoization of model calls.
 *
 * OFF by default, deliberately. It saves real money — an identical prompt is otherwise paid for once
 * per run, task and process — but it is not a pure optimization: a re-run of a task returns the
 * answer the first run got rather than asking again, which is surprising if you re-ran precisely
 * because you wanted a fresh one. Opting in is the honest default for something that changes what a
 * run observes.
 */
export interface JairaMemoConfig {
  enabled: boolean;
}

export function defaultConfig(): JairaConfig {
  return {
    models: {},
    memo: { enabled: false },
    artifactDir: DEFAULT_ARTIFACT_DIR,
    artifacts: {
      destination: DEFAULT_ARTIFACT_DESTINATION,
      dir: DEFAULT_ARTIFACT_DIR,
      inlineMaxBytes: DEFAULT_INLINE_MAX_BYTES,
    },
    execEnvironment: "windows",
    policy: {},
    agents: {},
    executors: {},
    workflows: {},
  };
}

/**
 * Parse the workflow-reference block (EXPRESSIONS.md §4).
 *
 * Strict about bare entries, because the failure is otherwise circular and confusing: a bare path
 * entry would itself need the path to resolve.
 */
function parseWorkflows(raw: unknown): JairaWorkflowConfig {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.workflows must be an object");
  }
  const list = (raw as Record<string, unknown>)["path"];
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("config.workflows.path must be a non-empty array");
  }
  const path = list.map((entry, i) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`config.workflows.path[${i}] must be a non-empty string`);
    }
    if (!entry.startsWith("$") && !/^([a-zA-Z]:)?[/\\]/.test(entry)) {
      throw new Error(
        `config.workflows.path[${i}] ('${entry}') must be rooted ($JAIRA/…, $PROJECT/…, $BASE/…) or ` +
          `absolute — a bare entry would need the path to resolve itself`,
      );
    }
    return entry;
  });
  return { path };
}

/**
 * Parse the artifact block (DESIGN §7.6). `artifactDir` seeds `artifacts.dir` when
 * the newer block does not set it, so an existing config keeps working.
 *
 * The destination template is NOT validated here — that needs the variable
 * vocabulary, which lives in `@jaira/runtime` (shared must stay free of it so the
 * renderer's bundle does not pull it in). `parseDestination` there is the checker,
 * and it runs at project open.
 */
/** Parse the memo block. Absent ⇒ off, which is the documented default on {@link JairaMemoConfig}. */
function parseMemo(raw: unknown): JairaMemoConfig {
  if (raw === undefined) return { enabled: false };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.memo must be an object");
  }
  const enabled = (raw as Record<string, unknown>)["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error("config.memo.enabled must be a boolean");
  }
  return { enabled: enabled ?? false };
}

function parseArtifacts(raw: unknown, artifactDir: string): JairaArtifactConfig {
  const fallback: JairaArtifactConfig = {
    destination: DEFAULT_ARTIFACT_DESTINATION,
    dir: artifactDir,
    inlineMaxBytes: DEFAULT_INLINE_MAX_BYTES,
  };
  if (raw === undefined) return fallback;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.artifacts must be an object");
  }
  const cfg = raw as Record<string, unknown>;

  const destination = cfg["destination"] ?? fallback.destination;
  if (typeof destination !== "string" || destination.trim().length === 0) {
    throw new Error("config.artifacts.destination must be a non-empty string");
  }
  const dir = cfg["dir"] ?? fallback.dir;
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("config.artifacts.dir must be a non-empty string");
  }
  const inlineMaxBytes = cfg["inlineMaxBytes"] ?? fallback.inlineMaxBytes;
  if (typeof inlineMaxBytes !== "number" || !Number.isInteger(inlineMaxBytes) || inlineMaxBytes < 0) {
    throw new Error("config.artifacts.inlineMaxBytes must be a non-negative integer");
  }
  return { destination, dir, inlineMaxBytes };
}

/**
 * Parse the generic-agent list.
 *
 * Strict rather than forgiving: a typo here means a state either fails as
 * "unregistered function" or runs the wrong binary, and both are worse than a
 * config error naming the field.
 */
/**
 * Validate the `enabled` / `credential` pair every executor shares.
 *
 * `credential` is checked to be a plain name because it is looked up as one. Accepting a value that
 * *looks* like a key here would be the single easiest way to end up with a secret committed in
 * `config.json`, so a string containing whitespace is refused with the reason spelled out.
 */
function checkExecutorFields(
  spec: Record<string, unknown>,
  where: string,
  credentialUse: CredentialUse = "optional",
): void {
  if (spec["enabled"] !== undefined && typeof spec["enabled"] !== "boolean") {
    throw new Error(`${where}.enabled must be a boolean`);
  }
  const credential = spec["credential"];
  if (credential === undefined) return;
  // Refused rather than ignored, for the reason `parseModelRoute` refuses a misplaced field: a key
  // configured for a runtime that will never read one is not a harmless extra: it is somebody
  // believing an executor is set up, and the failure it produces ("why is it still not signed in?")
  // is far harder to trace than a save that names the field.
  if (credentialUse === "none") {
    throw new Error(
      `${where}.credential is not a setting this executor has — it authenticates itself, so no API ` +
        `key is used. Remove the field; sign in with the binary itself instead.`,
    );
  }
  if (typeof credential !== "string" || credential.length === 0) {
    throw new Error(`${where}.credential must be a non-empty string`);
  }
  if (/\s/.test(credential)) {
    throw new Error(
      `${where}.credential ('${credential}') must NAME a secret, not hold one — the value is looked up ` +
        `at run time from the keychain, a .env file, or the environment`,
    );
  }
}

function parseClaudeCode(raw: unknown, where: string): JairaClaudeCodeConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const spec = raw as Record<string, unknown>;
  // `command` is listed so the SPECIFIC refusal below fires rather than the generic "not a setting":
  // someone who wrote it has a real misconception — that this adapter is a binary — and the message
  // that names the other one is worth far more than the shorter refusal.
  allowedFields(spec, ["enabled", "credential", "command"], where);
  checkExecutorFields(spec, where, "required");
  if (spec["command"] !== undefined) {
    throw new Error(
      `${where}.command is not a setting this executor has — it runs the SDK inside this process, ` +
        `so there is no binary to point at. Configure agents.claudeCli instead.`,
    );
  }
  return spec as JairaClaudeCodeConfig;
}

function parseClaudeCli(raw: unknown, where: string): JairaClaudeCliConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const spec = raw as Record<string, unknown>;
  // Unknown fields are refused here as everywhere else. `models` used to be one of these blocks'
  // settings and is not any more — a limit on which models a route may run belongs to the route, and
  // silently accepting it here would leave someone believing a limit was in force that is not.
  // `credential` is listed for the reason `command` is on the SDK block: the specific refusal
  // explains that this runtime signs itself in, and the generic one would not.
  allowedFields(spec, ["enabled", "command", "credential"], where);
  checkExecutorFields(spec, where, "none");
  if (spec["command"] !== undefined && (typeof spec["command"] !== "string" || spec["command"].length === 0)) {
    throw new Error(`${where}.command must be a non-empty string`);
  }
  return spec as JairaClaudeCliConfig;
}

function parseAgents(raw: unknown): JairaAgentConfig {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.agents must be an object");
  }
  const codex = parseCodexAgent((raw as Record<string, unknown>)["codex"]);
  const claudeCode = parseClaudeCode((raw as Record<string, unknown>)["claudeCode"], "config.agents.claudeCode");
  const claudeCli = parseClaudeCli((raw as Record<string, unknown>)["claudeCli"], "config.agents.claudeCli");
  const builtins = {
    ...(codex !== undefined ? { codex } : {}),
    ...(claudeCode !== undefined ? { claudeCode } : {}),
    ...(claudeCli !== undefined ? { claudeCli } : {}),
  };
  const list = (raw as Record<string, unknown>)["genericCli"];
  if (list === undefined) return builtins;
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
    allowedFields(spec, ["enabled", "credential", "name", "command", "args", "prompt", "env"], where);
    checkExecutorFields(spec, where);
    return spec as unknown as JairaGenericCliAgent;
  });
  return { genericCli, ...builtins };
}

/** The sandbox names codex accepts. Spelled out here so a typo is a config error rather than a
 *  silently-ignored flag value the agent then runs without. */
const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

function parseCodexAgent(raw: unknown): JairaCodexAgentConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.agents.codex must be an object");
  }
  const spec = raw as Record<string, unknown>;
  allowedFields(spec, ["enabled", "command", "sandbox", "credential"], "config.agents.codex");
  checkExecutorFields(spec, "config.agents.codex");
  if (spec["command"] !== undefined && (typeof spec["command"] !== "string" || spec["command"].length === 0)) {
    throw new Error("config.agents.codex.command must be a non-empty string");
  }
  if (spec["sandbox"] !== undefined && !CODEX_SANDBOXES.includes(spec["sandbox"] as string)) {
    throw new Error(`config.agents.codex.sandbox must be one of ${CODEX_SANDBOXES.join(", ")}`);
  }
  return spec as JairaCodexAgentConfig;
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

/** True for a plain JSON object — the only thing worth merging key by key. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The registry name a generic-CLI entry is reached by, which is also its identity when layering. */
function genericCliName(entry: unknown): string {
  const name = isPlainObject(entry) ? entry["name"] : undefined;
  return typeof name === "string" && name.length > 0 ? name : "generic-cli";
}

/**
 * Lay a project's `config.json` over the shared base root's (DESIGN §3).
 *
 * Merged as raw DOCUMENTS, before parsing, so validation sees exactly the configuration that will be
 * used and an error names a field rather than an internal merge artefact.
 *
 * Three rules, each chosen because the other reading is worse:
 *
 *  - **Objects merge key by key.** A project that sets only `models.default` must not lose the base's
 *    `agents` and `policy`, which is what a wholesale replace would do — and the reason to keep a
 *    shared root at all is that most projects override one or two things.
 *  - **Arrays replace.** Concatenating `workflows.path` would make the effective search order depend
 *    on a file the author is not reading, and a project could then never REMOVE a base entry.
 *  - **`agents.genericCli` merges by name.** It is the one array that is really a keyed map: the
 *    base defines the shared executors, and a project expects to add one or retune one, not to
 *    redeclare the set. An entry with a base name overrides it in place, keeping the base's order.
 */
export function mergeConfigDocuments(base: unknown, project: unknown): unknown {
  if (!isPlainObject(base)) return project;
  if (!isPlainObject(project)) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(project)) {
    const under = base[key];
    if (isPlainObject(under) && isPlainObject(value)) {
      merged[key] = mergeAgentBlock(key, under, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/** `agents` is a plain object merge except for its one keyed array. */
function mergeAgentBlock(
  key: string,
  base: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeConfigDocuments(base, project) as Record<string, unknown>;
  if (key !== "agents") return merged;
  const baseList = base["genericCli"];
  const projectList = project["genericCli"];
  if (!Array.isArray(baseList) || !Array.isArray(projectList)) return merged;
  const byName = new Map<string, unknown>(baseList.map((entry) => [genericCliName(entry), entry]));
  for (const entry of projectList) {
    const name = genericCliName(entry);
    const under = byName.get(name);
    byName.set(name, isPlainObject(under) && isPlainObject(entry) ? mergeConfigDocuments(under, entry) : entry);
  }
  return { ...merged, genericCli: [...byName.values()] };
}

/**
 * The route prefixes JaiRA knows how to REACH.
 *
 * Two families in one list, because a model id does not distinguish them and should not: the first
 * four are declarative-ai's serving routes (a provider fleet, a local server, in-process weights), the
 * rest are EXECUTORS — a coding agent answering the prompt itself. What a prefix selects is "who
 * answers", and the honest surface for that is one namespace (DESIGN §8.3).
 */
export const MODEL_ROUTE_KEYS = ["anthropic", "openrouter", "local", "embedded"] as const;

/** Which of a route's fields belong to it, so a misplaced one is refused rather than ignored. */
const ROUTE_FIELDS: Record<string, readonly string[]> = {
  anthropic: ["enabled", "credential"],
  openrouter: ["enabled", "credential"],
  local: ["enabled", "credential", "baseURL", "headers", "supportsStructuredOutputs", "serve"],
  embedded: ["enabled", "weights"],
};

function plainObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(plainObject(value, where))) {
    if (typeof entry !== "string") throw new Error(`${where}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

/**
 * Parse one route block.
 *
 * Unknown-for-this-route fields are an ERROR rather than being dropped, which is the opposite of how
 * the executor blocks are read — and deliberately so. A `baseURL` under `anthropic` is not a harmless
 * extra key: it is somebody configuring an endpoint that will never be consulted, and the failure it
 * produces later ("why is it still calling the public API?") is far harder to trace than a refused save
 * that names the field.
 */
function parseModelRoute(value: unknown, key: string): JairaModelRoute {
  const where = `config.models.routes.${key}`;
  const raw = plainObject(value, where);
  const allowed = ROUTE_FIELDS[key];
  if (allowed === undefined) {
    throw new Error(`${where} names an unknown route — expected one of ${MODEL_ROUTE_KEYS.join(", ")}`);
  }
  for (const field of Object.keys(raw)) {
    if (!allowed.includes(field)) {
      throw new Error(`${where}.${field} is not a setting the '${key}' route has — it takes ${allowed.join(", ")}`);
    }
  }
  const route: JairaModelRoute = {};
  if (raw["enabled"] !== undefined) {
    if (typeof raw["enabled"] !== "boolean") throw new Error(`${where}.enabled must be a boolean`);
    route.enabled = raw["enabled"];
  }
  if (raw["credential"] !== undefined) {
    const name = raw["credential"];
    if (typeof name !== "string" || name.length === 0) throw new Error(`${where}.credential must be a non-empty string`);
    if (/\s/.test(name)) {
      throw new Error(
        `${where}.credential '${name}' looks like a secret VALUE — it must NAME a secret (like ANTHROPIC_API_KEY), which is then resolved from the keychain, a .env file, or the environment`,
      );
    }
    route.credential = name;
  }
  if (raw["baseURL"] !== undefined) {
    if (typeof raw["baseURL"] !== "string" || raw["baseURL"].length === 0) throw new Error(`${where}.baseURL must be a non-empty string`);
    route.baseURL = raw["baseURL"];
  }
  if (raw["headers"] !== undefined) route.headers = stringMap(raw["headers"], `${where}.headers`);
  if (raw["supportsStructuredOutputs"] !== undefined) {
    if (typeof raw["supportsStructuredOutputs"] !== "boolean") throw new Error(`${where}.supportsStructuredOutputs must be a boolean`);
    route.supportsStructuredOutputs = raw["supportsStructuredOutputs"];
  }
  if (raw["serve"] !== undefined) {
    const serve = plainObject(raw["serve"], `${where}.serve`);
    if (typeof serve["command"] !== "string" || serve["command"].length === 0) {
      throw new Error(`${where}.serve.command must be a non-empty string`);
    }
    const spec: JairaLocalServerSpec = { command: serve["command"] };
    if (serve["args"] !== undefined) {
      if (!Array.isArray(serve["args"]) || serve["args"].some((a) => typeof a !== "string")) {
        throw new Error(`${where}.serve.args must be an array of strings`);
      }
      spec.args = serve["args"] as string[];
    }
    if (serve["env"] !== undefined) spec.env = stringMap(serve["env"], `${where}.serve.env`);
    if (serve["readyUrl"] !== undefined) {
      if (typeof serve["readyUrl"] !== "string") throw new Error(`${where}.serve.readyUrl must be a string`);
      spec.readyUrl = serve["readyUrl"];
    }
    if (serve["readyTimeoutMs"] !== undefined) {
      if (typeof serve["readyTimeoutMs"] !== "number") throw new Error(`${where}.serve.readyTimeoutMs must be a number`);
      spec.readyTimeoutMs = serve["readyTimeoutMs"];
    }
    route.serve = spec;
  }
  if (raw["weights"] !== undefined) {
    const weights: Record<string, JairaEmbeddedWeights> = {};
    for (const [id, entry] of Object.entries(plainObject(raw["weights"], `${where}.weights`))) {
      const w = plainObject(entry, `${where}.weights.${id}`);
      if (typeof w["modelPath"] !== "string" || w["modelPath"].length === 0) {
        throw new Error(`${where}.weights.${id}.modelPath must be a non-empty string`);
      }
      weights[id] = {
        modelPath: w["modelPath"],
        ...(typeof w["contextSize"] === "number" ? { contextSize: w["contextSize"] } : {}),
        ...(w["gpuLayers"] !== undefined ? { gpuLayers: w["gpuLayers"] as number | "auto" | "max" } : {}),
        ...(typeof w["sequences"] === "number" ? { sequences: w["sequences"] } : {}),
      };
    }
    route.weights = weights;
  }
  return route;
}

/** Parse the `models` block: the default id, how each route is reached, and the named presets. */
function parseModels(value: unknown): JairaModelConfig {
  if (value === undefined) return {};
  const raw = plainObject(value, "config.models");
  const models: JairaModelConfig = {};

  if (raw["default"] !== undefined) {
    // Refused rather than ignored, because a config carrying it was RELYING on it. It never worked
    // for an agent id anyway (the router dispatches before a leaf's defaults are applied), so a
    // silent drop would turn a broken setting into an invisible one.
    throw new Error(
      "config.models.default has moved: the default call settings belong to the default executor's " +
        "prompt node — executors.default.prompt.defaults.model — which is applied before routing",
    );
  }

  if (raw["routes"] !== undefined) {
    const routes: Record<string, JairaModelRoute> = {};
    for (const [key, entry] of Object.entries(plainObject(raw["routes"], "config.models.routes"))) {
      routes[key] = parseModelRoute(entry, key);
    }
    models.routes = routes;
  }

  if (raw["presets"] !== undefined) {
    const presets: Record<string, Record<string, JsonValue>> = {};
    for (const [name, entry] of Object.entries(plainObject(raw["presets"], "config.models.presets"))) {
      presets[name] = plainObject(entry, `config.models.presets.${name}`) as Record<string, JsonValue>;
    }
    models.presets = presets;
  }
  return models;
}

export function parseConfig(raw: unknown): JairaConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config must be a JSON object");
  }
  const cfg = raw as Record<string, unknown>;

  const models = parseModels(cfg["models"]);

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
    memo: parseMemo(cfg["memo"]),
    artifactDir,
    artifacts: parseArtifacts(cfg["artifacts"], artifactDir),
    execEnvironment: parseExecEnvironment(cfg["execEnvironment"]),
    policy: (rawPolicy as Record<string, JsonValue> | undefined) ?? {},
    agents: parseAgents(cfg["agents"]),
    executors: parseExecutorDefinitions(cfg["executors"]),
    workflows: parseWorkflows(cfg["workflows"]),
  };
}

/**
 * Parse the named executor trees (`./executorTree`).
 *
 * What is stored is an OVERLAY, so almost everything is optional and an absent field means "derive
 * it" rather than "no value". What the parser is strict about is what is PRESENT: a mis-spelled node
 * field is a setting that silently is not there, on a tree whose whole job is to be explicit.
 *
 * Recursive, because the tree is: a router's routes are prompt nodes, and one of those may be a
 * router again.
 */
function parseExecutorDefinitions(raw: unknown): Record<string, JairaOperationNode> {
  if (raw === undefined) return {};
  const map = plainObject(raw, "config.executors");
  const out: Record<string, JairaOperationNode> = {};
  for (const [name, entry] of Object.entries(map)) {
    const where = `config.executors.${name}`;
    if (name.includes("/")) {
      throw new Error(`${where} must not contain '/' — an executor's name IS a model prefix, and a prefix ends at the first slash`);
    }
    out[name] = parseOperationNode(entry, where);
  }
  return out;
}

/** The top of the tree: dispatch on the kind of operation. */
function parseOperationNode(raw: unknown, where: string): JairaOperationNode {
  const spec = plainObject(raw, where);
  allowedFields(spec, ["kind", "description", "function", "prompt", "steps"], where);
  if (spec["kind"] !== undefined && spec["kind"] !== "operation") {
    throw new Error(`${where}.kind must be "operation" — it is the top of the tree, which dispatches prompt ops from function ops`);
  }
  if (spec["description"] !== undefined && (typeof spec["description"] !== "string" || spec["description"].length === 0)) {
    throw new Error(`${where}.description must be a non-empty string`);
  }
  return {
    kind: "operation",
    ...(spec["description"] !== undefined ? { description: spec["description"] as string } : {}),
    ...(spec["function"] !== undefined ? { function: parseFunctionNode(spec["function"], `${where}.function`) } : {}),
    ...(spec["prompt"] !== undefined ? { prompt: parsePromptNode(spec["prompt"], `${where}.prompt`) } : {}),
    ...(spec["steps"] !== undefined ? { steps: parseExecutorSteps(spec["steps"], `${where}.steps`) } : {}),
  };
}

function parseFunctionNode(raw: unknown, where: string): JairaOperationNode["function"] {
  const spec = plainObject(raw, where);
  allowedFields(spec, ["kind", "rules", "steps"], where);
  if (spec["kind"] !== undefined && spec["kind"] !== "function") throw new Error(`${where}.kind must be "function"`);
  if (spec["rules"] !== undefined) {
    for (const [i, rule] of patternList(spec["rules"], `${where}.rules`).entries()) {
      if (parseFunctionRule(rule) === undefined) {
        throw new Error(`${where}.rules[${i}] ('${rule}') is not a rule — write everything, nothing, +name or -name`);
      }
    }
  }
  return {
    kind: "function",
    ...(spec["rules"] !== undefined ? { rules: patternList(spec["rules"], `${where}.rules`) } : {}),
    ...(spec["steps"] !== undefined ? { steps: parseExecutorSteps(spec["steps"], `${where}.steps`) } : {}),
  };
}

/**
 * A prompt node — a router, a provider, or an agent.
 *
 * The kind may be ABSENT at the top of the prompt half, where it is derived as the router: that is
 * the shape a fresh install gets, and demanding it be written down would mean every project stating
 * the one thing it never wants to change.
 */
function parsePromptNode(raw: unknown, where: string, position: "top" | "route" = "top"): JairaPromptNode {
  const spec = plainObject(raw, where);
  // At the TOP of the prompt half, an absent kind is the router — the shape a fresh install gets, and
  // the one nobody should have to state. Inside `routes`, an absent kind is a LEAF whose identity the
  // PREFIX already gives: a node under `routes.anthropic` is that provider, and writing it down would
  // be writing down what the key says. Resolution supplies it either way.
  const stated = spec["kind"];
  const kind = stated ?? (position === "top" ? "router" : "leaf");
  if (kind !== "router" && kind !== "provider" && kind !== "agent" && kind !== "leaf") {
    throw new Error(`${where}.kind must be one of router, provider, agent`);
  }

  if (kind === "leaf") {
    // Neither name is required — the route key supplies it — so both are permitted and only their
    // shape is checked. A field belonging to neither is still refused.
    allowedFields(spec, ["provider", "agent", "model", "allow", "defaults", "steps"], where);
    return leafFields(spec, where, undefined) as JairaPromptNode;
  }

  if (kind === "router") {
    allowedFields(spec, ["kind", "defaults", "routes", "fallback", "steps"], where);
    const routes: Record<string, JairaPromptNode> = {};
    for (const [prefix, entry] of Object.entries(plainObject(spec["routes"] ?? {}, `${where}.routes`))) {
      if (prefix.includes("/")) {
        throw new Error(`${where}.routes.${prefix} must not contain '/' — a route key IS a model prefix`);
      }
      routes[prefix] = parsePromptNode(entry, `${where}.routes.${prefix}`, "route");
    }
    return {
      kind: "router",
      ...(spec["defaults"] !== undefined
        ? { defaults: plainObject(spec["defaults"], `${where}.defaults`) as Record<string, JsonValue> }
        : {}),
      ...(Object.keys(routes).length > 0 ? { routes } : {}),
      ...(spec["fallback"] !== undefined ? { fallback: parsePromptNode(spec["fallback"], `${where}.fallback`) } : {}),
      ...(spec["steps"] !== undefined ? { steps: parseExecutorSteps(spec["steps"], `${where}.steps`) } : {}),
    };
  }

  const target = kind === "provider" ? "provider" : "agent";
  allowedFields(spec, ["kind", target, "model", "allow", "defaults", "steps"], where);
  return { kind, ...leafFields(spec, where, target) } as JairaPromptNode;
}

/** The settings a provider node and an agent node share, plus whichever name they carry. */
function leafFields(
  spec: Record<string, unknown>,
  where: string,
  target: "provider" | "agent" | undefined,
): Record<string, unknown> {
  const names: Array<"provider" | "agent"> = target === undefined ? ["provider", "agent"] : [target];
  for (const field of [...names, "model"]) {
    if (spec[field] !== undefined && (typeof spec[field] !== "string" || (spec[field] as string).length === 0)) {
      throw new Error(`${where}.${field} must be a non-empty string`);
    }
  }
  const owner = names.map((n) => spec[n]).find((v): v is string => typeof v === "string");
  const model = spec["model"] as string | undefined;
  // The node's own name is the prefix, so a prefixed model would be doubled — `claude-cli/opus` on a
  // node whose agent is `claude-cli` reaches the binary as a model nothing knows.
  if (owner !== undefined && model !== undefined && model.startsWith(`${owner}/`)) {
    throw new Error(
      `${where}.model ('${model}') must be the model as it is known there ('${model.slice(owner.length + 1)}') — ` +
        `the route's own name is already the prefix`,
    );
  }
  return {
    ...Object.fromEntries(names.filter((n) => spec[n] !== undefined).map((n) => [n, spec[n]])),
    ...(model !== undefined ? { model } : {}),
    ...(spec["allow"] !== undefined ? { allow: patternList(spec["allow"], `${where}.allow`) } : {}),
    ...(spec["defaults"] !== undefined
      ? { defaults: plainObject(spec["defaults"], `${where}.defaults`) as Record<string, JsonValue> }
      : {}),
    ...(spec["steps"] !== undefined ? { steps: parseExecutorSteps(spec["steps"], `${where}.steps`) } : {}),
  };
}

/** Refuse a field this node does not have, naming the ones it does. */
function allowedFields(spec: Record<string, unknown>, allowed: string[], where: string): void {
  for (const field of Object.keys(spec)) {
    if (!allowed.includes(field)) {
      throw new Error(`${where}.${field} is not a setting — it takes ${allowed.join(", ")}`);
    }
  }
}

/** A non-empty list of non-empty patterns. Empty would be a limit that admits nothing, never meant. */
function patternList(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${where} must be a non-empty array of patterns`);
  return raw.map((entry, i) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${where}[${i}] must be a non-empty string`);
    }
    return entry;
  });
}

function parseExecutorSteps(raw: unknown, where: string): JairaExecutorSteps {
  const map = plainObject(raw, where);
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(map)) {
    const step = EXECUTOR_STEPS.find((s) => s.name === name);
    if (step === undefined) {
      throw new Error(`${where}.${name} is not a step — the stack is built from ${EXECUTOR_STEPS.map((s) => s.name).join(", ")}`);
    }
    out[name] = checkAgainstSchema(entry, step.schema, `${where}.${name}`);
  }
  return out as JairaExecutorSteps;
}

/**
 * Check a value against one of the step schemas — the small subset those schemas actually use.
 *
 * Deliberately not a general JSON Schema validator: `@declarative-ai/validate` is one and it is
 * Node-only, while this file is in everyone's bundle. What the step schemas use is objects, numbers,
 * booleans, strings and `required`, so that is what this reads. Anything richer belongs in a schema
 * these are not, and would be a reason to move the check rather than to grow this.
 */
function checkAgainstSchema(value: unknown, schema: Record<string, JsonValue>, where: string): Record<string, unknown> {
  const spec = plainObject(value, where);
  const properties = (schema["properties"] ?? {}) as Record<string, Record<string, JsonValue>>;
  for (const field of Object.keys(spec)) {
    if (properties[field] === undefined) {
      throw new Error(`${where}.${field} is not a setting — it takes ${Object.keys(properties).join(", ")}`);
    }
  }
  for (const required of (schema["required"] ?? []) as string[]) {
    if (spec[required] === undefined) throw new Error(`${where}.${required} is required`);
  }
  for (const [field, sub] of Object.entries(properties)) {
    const held = spec[field];
    if (held === undefined) continue;
    if (sub["type"] === "object") {
      checkAgainstSchema(held, sub, `${where}.${field}`);
      continue;
    }
    if (sub["type"] === "number" && (typeof held !== "number" || !Number.isFinite(held))) {
      throw new Error(`${where}.${field} must be a number`);
    }
    if (sub["type"] === "boolean" && typeof held !== "boolean") throw new Error(`${where}.${field} must be a boolean`);
    if (sub["type"] === "string" && (typeof held !== "string" || held.length === 0)) {
      throw new Error(`${where}.${field} must be a non-empty string`);
    }
  }
  return spec;
}
