/**
 * What a PROVIDER is, as a type hierarchy — the data behind the Providers screen.
 *
 * A provider is anything that can answer a prompt: a remote fleet reached with a key, a server on
 * this machine, weights loaded into this process, or a coding agent running as a program. The old
 * screen split them across two tabs — "Models" for the four serving routes and "Executors" for the
 * agents — which is a split along how JaiRA happens to reach them rather than along what a user is
 * doing. Both tabs answered one question, *what can run here and how do I set it up*, and neither
 * answered it completely.
 *
 * So they are one list, and their settings follow the hierarchy rather than being flattened:
 *
 * ```text
 * provider                                  enabled
 * ├── API provider                          credential
 * │   ├── Anthropic
 * │   ├── OpenRouter
 * │   └── Local server                      baseURL, structured output, launch command
 * ├── Embedded weights                      weights
 * └── agent provider
 *     ├── in-process SDK                    credential
 *     ├── CLI agent                         command
 *     │   ├── Claude CLI
 *     │   ├── Codex                         sandbox, credential
 *     │   └── a generic CLI                 name, argv, prompt delivery, environment, credential
 * ```
 *
 * Each LEVEL contributes its own settings, and the form shows them as nested bands. Rendering the
 * union as one flat list of boxes is what made the old form unlearnable: there was no way to see
 * which settings every provider has, which come from being a CLI, and which are codex's alone.
 *
 * Pure data plus pure functions — no React, no IPC — so the hierarchy is testable without either.
 */
import { EXECUTOR_KINDS, type CredentialUse, type ExecutorInfo, type ExecutorKind } from "@jaira/shared/browser";
import {
  EXECUTOR_CONFIG_KEYS,
  checkCredentialName,
  formatAllow,
  formatArgs,
  formatEnv,
  parseAllow,
  parseArgs,
  parseEnv,
} from "./executorConfig";
import { formatJson, formatServe, parseJsonBlock, parseServe } from "./modelsConfig";

/** How a field's value is spelled in the form, which decides its control and its parse. */
export type ControlKind =
  | "text"
  | "secret-name"
  | "url"
  | "argv"
  | "env"
  | "json"
  | "serve"
  | "select"
  | "patterns";

export interface FieldSpec {
  /** Dotted path INSIDE this provider's own config block (`baseURL`, `serve`, `models.default`). */
  path: string;
  label: string;
  hint: string;
  control: ControlKind;
  /** For `select`: the options, `""` first and meaning "inherit". */
  options?: Array<[label: string, value: string]>;
  /** Shown when neither this layer nor the merged config states a value. */
  placeholder?: string;
}

/** One level of the hierarchy: what this kind of provider adds to the kind above it. */
export interface ProviderLevel {
  title: string;
  hint?: string;
  fields: FieldSpec[];
}

/** Where a provider's settings live in the document, which decides which patcher writes them. */
export type ProviderLocation =
  | { kind: "route"; key: string }
  | { kind: "agent"; name: string; executorKind: ExecutorKind };

export interface ProviderSpec {
  /** Stable id — the route prefix or the executor's registry name. Also the probe's key. */
  id: string;
  title: string;
  /** One line, addressed to someone deciding whether they want this provider at all. */
  hint: string;
  /** Which of the two lists it appears under. */
  family: "model" | "agent";
  location: ProviderLocation;
  /** Most general first. The base "provider" level is the row header's toggle, so it is not here. */
  levels: ProviderLevel[];
  /** Whether this provider uses an API key at all. */
  credential: CredentialUse;
  /** The variable its key is conventionally kept under — a suggestion, never a fallback. */
  suggestedCredential?: string;
}

// --- the shared levels -------------------------------------------------------

const API_KEY_FIELD: FieldSpec = {
  path: "credential",
  label: "Credential",
  hint: "The NAME of the secret holding the key — never the key. It is resolved at run time from the OS keychain, a .env file, or the environment.",
  control: "secret-name",
};

/** The level every keyed remote fleet shares. Stated once so the two remote routes cannot drift. */
const apiProviderLevel = (variable: string): ProviderLevel => ({
  title: "API provider",
  hint: `Reached over HTTP with a key. With no credential named, the SDK reads ${variable} from the environment.`,
  fields: [{ ...API_KEY_FIELD, placeholder: variable }],
});

/** The level every agent that is a PROGRAM shares — the one thing they all need is a binary. */
const CLI_AGENT_LEVEL: ProviderLevel = {
  title: "CLI agent",
  hint: "A program JaiRA runs. In a WSL project it is launched inside the distro, like every other command.",
  fields: [
    {
      path: "command",
      label: "Command",
      hint: "The executable, or a full path to it. Empty uses the default name on PATH.",
      control: "text",
    },
  ],
};

// --- the model providers -----------------------------------------------------

export const MODEL_PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic",
    title: "Anthropic",
    hint: "Claude models, billed to an API key. Serves every model id starting anthropic/.",
    family: "model",
    location: { kind: "route", key: "anthropic" },
    credential: "required",
    suggestedCredential: "ANTHROPIC_API_KEY",
    levels: [apiProviderLevel("ANTHROPIC_API_KEY")],
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    hint: "One key for many vendors. Serves every model id starting openrouter/.",
    family: "model",
    location: { kind: "route", key: "openrouter" },
    credential: "required",
    suggestedCredential: "OPENROUTER_API_KEY",
    levels: [apiProviderLevel("OPENROUTER_API_KEY")],
  },
  {
    id: "local",
    title: "Local server",
    hint: "An OpenAI-compatible server on this machine — Ollama, LM Studio, llama-server, vLLM.",
    family: "model",
    location: { kind: "route", key: "local" },
    // A local server usually needs no key, but plenty are put behind one.
    credential: "optional",
    levels: [
      {
        title: "API provider",
        hint: "It speaks the same HTTP as a remote fleet, so it takes a key when one is required.",
        fields: [{ ...API_KEY_FIELD, placeholder: "usually none" }],
      },
      {
        title: "Local server",
        hint: "Where it listens, what it can honour, and how to start it if nothing answers.",
        fields: [
          {
            path: "baseURL",
            label: "Server URL",
            hint: "Including the version path. This is what the startup check connects to.",
            control: "url",
            placeholder: "http://localhost:11434/v1",
          },
          {
            path: "supportsStructuredOutputs",
            label: "Structured output",
            hint: "A CEILING on what a call may ask for. llama-server and vLLM honour a full JSON schema; a bare completion shim does not.",
            control: "select",
            options: [
              ["yes — honours a full json_schema", ""],
              ["no — cap it at json_object", "no"],
            ],
          },
          {
            path: "serve",
            label: "Start it with",
            hint: "Left empty the server is expected to be running already. Given a command, JaiRA probes first and starts it only if nothing answers.",
            control: "serve",
            placeholder: "ollama serve",
          },
        ],
      },
    ],
  },
  {
    id: "embedded",
    title: "Embedded weights",
    hint: "GGUF weights loaded into this process. Needs the optional node-llama-cpp package.",
    family: "model",
    location: { kind: "route", key: "embedded" },
    credential: "none",
    levels: [
      {
        title: "Embedded weights",
        hint: "One entry per model id you want to serve. The startup check confirms each file is actually there.",
        fields: [
          {
            path: "weights",
            label: "Weights",
            hint: "JSON: the model id you will name in a prompt → the GGUF to load for it. For a split model, the FIRST part.",
            control: "json",
            placeholder: '{ "qwen2.5-7b": { "modelPath": "/models/qwen.gguf" } }',
          },
        ],
      },
    ],
  },
];

// --- the agent providers -----------------------------------------------------

/** The levels each agent KIND adds, below the shared agent level. */
function agentLevels(kind: ExecutorKind): ProviderLevel[] {
  const credential = EXECUTOR_KINDS[kind].credential;
  const keyLevel = (title: string, hint: string, placeholder?: string): ProviderLevel => ({
    title,
    hint,
    fields: [{ ...API_KEY_FIELD, ...(placeholder !== undefined ? { placeholder } : {}) }],
  });

  switch (kind) {
    case "sdk":
      return [
        keyLevel(
          "In-process SDK",
          "An API client running inside this process — no binary, and it cannot work without a key.",
          "ANTHROPIC_API_KEY",
        ),
      ];
    case "cli":
      return [
        CLI_AGENT_LEVEL,
        {
          title: "Claude CLI",
          // The sentence this whole restructure exists to be able to say in the right place.
          hint: "It signs itself in against the subscription its user already has, so there is no key to configure — and nothing here asks for one.",
          fields: [],
        },
      ];
    case "codex":
      return [
        CLI_AGENT_LEVEL,
        {
          title: "Codex",
          hint: "Signs itself in, or uses a key when one is named. Its sandbox is the whole of what it can enforce of the project's policy.",
          fields: [
            {
              path: "sandbox",
              label: "Sandbox",
              hint: "What a codex state may do when it names no permission mode. read-only is right for a project whose codex states only review — an agent that cannot write cannot be talked into writing.",
              control: "select",
              options: [
                ["— inherit", ""],
                ["read-only", "read-only"],
                ["workspace-write", "workspace-write"],
                ["danger-full-access", "danger-full-access"],
              ],
            },
            { ...API_KEY_FIELD, placeholder: "OPENAI_API_KEY — or none, and it signs itself in" },
          ],
        },
      ];
    case "generic":
      return [
        CLI_AGENT_LEVEL,
        {
          title: "A generic CLI",
          hint: "Driven by an argv template. It enforces no policy of its own, so a project whose policy can require approval will refuse it.",
          fields: [
            {
              path: "name",
              label: "Registry name",
              hint: "What a state's function names, and the model prefix that routes to it.",
              control: "text",
            },
            {
              path: "args",
              label: "Arguments",
              hint: "One per line — not a shell string, so an argument containing a space survives. A literal {prompt} is replaced by the instruction; with no placeholder it is appended after --.",
              control: "argv",
              placeholder: "{prompt}",
            },
            {
              path: "prompt",
              label: "Prompt delivery",
              hint: "How the instruction reaches the binary.",
              control: "select",
              options: [
                ["— inherit (as an argument)", ""],
                ["as an argument", "argument"],
                ["on stdin", "stdin"],
              ],
            },
            {
              path: "env",
              label: "Environment",
              hint: "Extra variables for the child process, NAME=value per line.",
              control: "env",
            },
            { ...API_KEY_FIELD, placeholder: "none, unless the binary needs one" },
          ],
        },
      ];
  }
  return [];
}

/** The shared agent level — what makes something an agent rather than a served model. */
const AGENT_LEVEL: ProviderLevel = {
  title: "Agent provider",
  hint: "It answers a prompt by RUNNING — reading files, executing commands — rather than by returning a completion. What it can enforce of the project's policy depends on the runtime.",
  fields: [],
};

/** Turn the live executor inventory into provider specs, in inventory order. */
export function agentProviders(executors: ExecutorInfo[]): ProviderSpec[] {
  return executors.map((info) => ({
    id: info.name,
    title: info.name,
    hint: EXECUTOR_KINDS[info.kind].hint,
    family: "agent" as const,
    location: { kind: "agent" as const, name: info.name, executorKind: info.kind },
    credential: info.credentialUse,
    ...(EXECUTOR_KINDS[info.kind].suggestedCredential !== undefined
      ? { suggestedCredential: EXECUTOR_KINDS[info.kind].suggestedCredential! }
      : {}),
    levels: [AGENT_LEVEL, ...agentLevels(info.kind)],
  }));
}

/** Every field a spec offers, flattened — for a form that needs to read or write them all. */
export function allFields(spec: ProviderSpec): FieldSpec[] {
  return spec.levels.flatMap((level) => level.fields);
}

/**
 * The document path a provider's block sits at, as dotted segments.
 *
 * A generic CLI has none: its block is an ARRAY ENTRY found by name, which is why writes go through
 * `applyExecutorPatch` rather than a path walk. Returning `null` for it makes that the caller's
 * explicit branch instead of a path that quietly addresses the wrong thing.
 */
export function providerBlockPath(spec: ProviderSpec): string[] | null {
  if (spec.location.kind === "route") return ["models", "routes", spec.location.key];
  const key = EXECUTOR_CONFIG_KEYS[spec.location.name];
  return key === undefined ? null : ["agents", key];
}

// --- a field's value, as text ------------------------------------------------

/**
 * Read one field out of a block, as the string its control holds.
 *
 * One function over the control KIND rather than a branch per field, which is what the two old forms
 * each had — and what let them disagree about, for instance, whether an emptied argv box meant "no
 * arguments" or "inherit".
 */
export function fieldText(control: ControlKind, value: unknown): string {
  switch (control) {
    case "serve":
      return formatServe(value);
    case "json":
      return formatJson(value);
    case "argv":
      return formatArgs(value);
    case "patterns":
      return formatAllow(value);
    case "env":
      return formatEnv(value);
    case "select":
      // The only boolean-as-select is `supportsStructuredOutputs`, where `false` is the ONE value
      // worth writing: true is the default, and a layer stating it overrides nothing.
      if (value === false) return "no";
      return typeof value === "string" ? value : "";
    default:
      return typeof value === "string" ? value : "";
  }
}

/**
 * Turn a control's text back into the value to write. `undefined` REMOVES the key.
 *
 * Throws on malformed input rather than keeping the old value silently: a settings box that accepts
 * a typo and saves nothing is the worst of both — the screen says one thing and the file says
 * another.
 */
export function fieldValue(field: FieldSpec, text: string): unknown {
  const trimmed = text.trim();
  switch (field.control) {
    case "serve":
      return parseServe(text);
    case "json":
      return parseJsonBlock(text, field.label);
    case "argv":
      return parseArgs(text);
    case "patterns":
      return parseAllow(text);
    case "env":
      return parseEnv(text);
    case "select":
      // `""` is "inherit" for every select, so it removes the key. `supportsStructuredOutputs` is
      // the one whose non-empty value is a boolean rather than the string itself.
      if (trimmed === "") return undefined;
      return field.path === "supportsStructuredOutputs" ? false : trimmed;
    case "secret-name":
      if (trimmed === "") return undefined;
      checkCredentialName(trimmed);
      return trimmed;
    default:
      return trimmed === "" ? undefined : trimmed;
  }
}
