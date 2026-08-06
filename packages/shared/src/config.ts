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
   *
   * The prefix now chooses more than a provider: `claude-cli/sonnet` sends prompt
   * states to the CLI agent, which needs no API key at all (DESIGN §8.3).
   */
  default?: string;
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
export interface JairaExecutorConfig {
  enabled?: boolean;
  credential?: string;
}

/** The built-in executors, by the registry name a state's `functionRef` uses. */
export const BUILTIN_EXECUTORS = ["claude-code", "claude-cli", "codex-cli"] as const;
export type BuiltinExecutor = (typeof BUILTIN_EXECUTORS)[number];

/** Settings for the two built-in Claude adapters (SDK and CLI). */
export interface JairaClaudeAgentConfig extends JairaExecutorConfig {
  /** Path to the binary. CLI adapter only; default `claude` on PATH. */
  command?: string;
}

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
  claudeCode?: JairaClaudeAgentConfig;
  /** Settings for the built-in `claude-cli` runtime (the subprocess adapter). */
  claudeCli?: JairaClaudeAgentConfig;
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
function checkExecutorFields(spec: Record<string, unknown>, where: string): void {
  if (spec["enabled"] !== undefined && typeof spec["enabled"] !== "boolean") {
    throw new Error(`${where}.enabled must be a boolean`);
  }
  const credential = spec["credential"];
  if (credential === undefined) return;
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

function parseClaudeAgent(raw: unknown, where: string): JairaClaudeAgentConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const spec = raw as Record<string, unknown>;
  checkExecutorFields(spec, where);
  if (spec["command"] !== undefined && (typeof spec["command"] !== "string" || spec["command"].length === 0)) {
    throw new Error(`${where}.command must be a non-empty string`);
  }
  return spec as JairaClaudeAgentConfig;
}

function parseAgents(raw: unknown): JairaAgentConfig {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.agents must be an object");
  }
  const codex = parseCodexAgent((raw as Record<string, unknown>)["codex"]);
  const claudeCode = parseClaudeAgent((raw as Record<string, unknown>)["claudeCode"], "config.agents.claudeCode");
  const claudeCli = parseClaudeAgent((raw as Record<string, unknown>)["claudeCli"], "config.agents.claudeCli");
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

  const id = raw["default"];
  if (id !== undefined) {
    if (typeof id !== "string" || id.length === 0) throw new Error("config.models.default must be a non-empty string");
    if (!id.includes("/")) {
      throw new Error(
        `config.models.default '${id}' must be route-prefixed, e.g. 'anthropic/claude-sonnet-5', 'openrouter/openai/gpt-5', or 'claude-cli/sonnet' to run it on the CLI agent`,
      );
    }
    models.default = id;
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
    workflows: parseWorkflows(cfg["workflows"]),
  };
}
