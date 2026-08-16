/**
 * The `operation` block's field vocabulary — one table, read by three things.
 *
 * It lived in the renderer's `operationForm.ts`, which was the right home while the authoring form
 * was the only thing that knew these names. It is not any more: the schema the JSON editor validates
 * against is built from this same table (`schemas.ts`), and that schema is compiled in the MAIN
 * process, which cannot import a renderer module.
 *
 * So it moves here, where both sides can read it. The form still owns everything about how a field is
 * EDITED — which control, what it does with a half-typed number — and this owns only what a field IS.
 * The alternative was a second list of field names beside the first, and the whole reason this was a
 * table in the first place was to have one place to add a field rather than two places to forget one.
 *
 * `label`, `hint` and `placeholder` come along rather than staying behind. They are display strings,
 * but they are display strings ABOUT the vocabulary — `slotTypes.ts` already carries the same kind of
 * thing for the same reason, and the schema reference panel wants exactly these words.
 */

/**
 * The simple fields — one authored key, one text box.
 *
 * A table rather than fifteen near-identical read/write blocks. `number` fields are held as TEXT in
 * the form and parsed on write: a box bound to a number turns a half-typed `0.` into `0` under the
 * cursor, and `maxOutputTokens` being briefly `1` while someone types `16000` is worse than briefly
 * invalid.
 */
export interface SimpleField {
  /** The form's name for it, and the key in `OperationFieldsForm.fields`. */
  name: string;
  /** The key as authored. Differs from `name` only where hw accepts a second spelling. */
  key: string;
  /** The loader's lowered spelling, read on the way in and removed on the way out. */
  alias?: string;
  type: "string" | "number" | "list";
  label: string;
  placeholder?: string;
  hint?: string;
  /** Grouped in the UI: the call's own knobs sit apart from what the operation IS. */
  group: "operation" | "model";
  /** Rendered as a textarea rather than an input. */
  multiline?: boolean;
  /**
   * Which operation kinds this field means anything on.
   *
   * WORKFLOWS.md §4: "`prompt`, `system` and the LLM call surface are meaningless on a function op,
   * and `function`/`args` are meaningless on a prompt op." The form has always shown the right ones
   * by group; saying it in the data is what lets the prompt-operation schema exclude the others
   * without a second list of which-belongs-where.
   *
   * Absent ⇒ both kinds.
   */
  kinds?: readonly ("prompt" | "function")[];
  /**
   * Whether the form offers to hold this field as a document REFERENCE rather than a literal.
   *
   * Every string field could legally be one — `{"$ref": …}` is admitted in any string position
   * (WORKFLOWS.md §2.2) — but offering it everywhere would put a link button on `model` and `seed`,
   * where nobody has ever wanted one. It is set on the fields that are documents in their own right
   * and are therefore worth keeping in a file: a prompt, a system prompt.
   */
  linkable?: true;
}

export const SIMPLE_FIELDS: readonly SimpleField[] = [
  { name: "prompt", key: "prompt", type: "string", label: "Prompt", group: "operation", multiline: true,
    kinds: ["prompt"], linkable: true,
    hint: "{{.inputs.x}} interpolates; Link holds it in a file instead" },
  { name: "system", key: "system", type: "string", label: "System", group: "operation", multiline: true,
    kinds: ["prompt"], linkable: true,
    hint: "the system prompt for this call" },
  { name: "functionRef", key: "function", alias: "functionRef", type: "string", label: "Function", group: "operation",
    kinds: ["function"],
    placeholder: "claude-code, codex-cli, choose_option, …" },
  { name: "tools", key: "tools", type: "list", label: "Tools", group: "operation",
    placeholder: "read_file, run_command",
    hint: "logical names resolved through the tool registry — an empty list drops the inherited ones" },
  { name: "model", key: "model", type: "string", label: "Model", group: "model",
    kinds: ["prompt"],
    placeholder: "anthropic/claude-sonnet-5 (route-prefixed)" },
  { name: "temperature", key: "temperature", type: "number", label: "Temperature", group: "model", kinds: ["prompt"] },
  { name: "topP", key: "topP", type: "number", label: "Top P", group: "model", kinds: ["prompt"] },
  { name: "topK", key: "topK", type: "number", label: "Top K", group: "model", kinds: ["prompt"] },
  { name: "maxOutputTokens", key: "maxOutputTokens", type: "number", label: "Max output tokens", group: "model",
    kinds: ["prompt"] },
  { name: "maxSteps", key: "maxSteps", type: "number", label: "Max steps", group: "model",
    hint: "how many tool-use rounds one call may take" },
  { name: "seed", key: "seed", type: "number", label: "Seed", group: "model", kinds: ["prompt"] },
  { name: "presencePenalty", key: "presencePenalty", type: "number", label: "Presence penalty", group: "model",
    kinds: ["prompt"] },
  { name: "frequencyPenalty", key: "frequencyPenalty", type: "number", label: "Frequency penalty", group: "model",
    kinds: ["prompt"] },
  { name: "stopSequences", key: "stopSequences", type: "list", label: "Stop sequences", group: "model",
    kinds: ["prompt"] },
  { name: "outputModalities", key: "outputModalities", type: "list", label: "Output modalities", group: "model",
    kinds: ["prompt"] },
  // Shell PATH semantics, first match wins, and SPLICED rather than unioned: arrays replace
  // everywhere else in the merge, so `$INHERITED` is how an author prepends instead of shadowing.
  { name: "path", key: "path", type: "list", label: "Search path", group: "operation",
    placeholder: "./ops, $INHERITED",
    hint: "where a bare reference is looked up; entries may not themselves be bare" },
];

/**
 * The fields whose value is arbitrary JSON, edited as JSON.
 *
 * No generated form could do better: `args` is untyped by nature — only the function knows what it
 * takes — and `providerOptions`/`toolChoice` are passed through to a provider hw has never parsed.
 * A box that admits `{"$ref": …}` is also the only way to write the one reference form `args`
 * REQUIRES, since a bare string there would be data rather than a reference (§3.1).
 */
export interface JsonField {
  name: string;
  key: string;
  label: string;
  placeholder: string;
  hint: string;
  group: "operation" | "model";
  /** See {@link SimpleField.kinds}. */
  kinds?: readonly ("prompt" | "function")[];
}

export const JSON_FIELDS: readonly JsonField[] = [
  { name: "args", key: "args", label: "Arguments", group: "operation", kinds: ["function"],
    placeholder: '{ "options": ["approve", "block"] }',
    hint: "bound as the function's `config` input; a reference here must be written {\"$ref\": …}" },
  { name: "toolChoice", key: "toolChoice", label: "Tool choice", group: "model", kinds: ["prompt"],
    placeholder: '"auto"', hint: "passed through to the provider" },
  { name: "providerOptions", key: "providerOptions", label: "Provider options", group: "model", kinds: ["prompt"],
    placeholder: '{ "anthropic": { "cacheControl": true } }', hint: "passed through to the provider" },
];

/**
 * How the operation's conversation is declared (SPEC §4.7) — a preamble injected into THIS call,
 * which is a different thing from a `{ conversation }` wire that reads a transcript as data.
 */
export const CONVERSATION_MODES = ["full_history", "summary", "fresh", "selected_artifacts"] as const;

/** DESIGN §5.1. `smart` defers to an approver that inspects the call rather than just the tool name. */
export const PERMISSION_MODES = ["allow", "deny", "ask", "smart"] as const;
/** The built-in profiles. Any other string is a custom profile the host resolves, so this is a
 *  suggestion list and not a closed set — the control accepts free text. */
export const PERMISSION_PROFILES = ["read-only", "plan", "full"] as const;

/** True when a field is authorable on an operation of this kind. */
export function fieldAppliesTo(field: { kinds?: readonly string[] }, kind: "prompt" | "function"): boolean {
  return field.kinds === undefined || field.kinds.includes(kind);
}

// --- continuing a conversation by hand ----------------------------------------
//
// The composer edits an operation, so its vocabulary is the operation's. These live HERE rather than
// beside the runtime that consumes them because the renderer needs them too and this package is the
// one both can see — `@jaira/shared` depends only on `@declarative-ai/json`, which is also why the
// shapes are restated in plain terms instead of imported from `llm` and `hw`.

/**
 * How hard the model should think.
 *
 * `xhigh` is above `high` and exists because a transport we drive has a tier the three-value
 * vocabulary cannot name. A provider that tops out lower CLAMPS rather than refusing, since asking
 * for more thought than a model offers is satisfied by giving it all of it.
 */
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** An effort LEVEL and/or a token BUDGET — models differ in which they accept, so both are carried. */
export interface ReasoningDecl {
  effort?: ReasoningEffort;
  budgetTokens?: number;
}

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The authored permission baseline: a profile, a default, and per-tool overrides. */
export interface PermissionsDecl {
  profile?: string;
  default?: PermissionMode;
  tools?: Record<string, PermissionMode>;
  /**
   * The mode for a tool that is not in the vocabulary at all — see `toolVocabulary.ts`.
   *
   * NOT the same field as {@link PermissionsDecl.default}, and the difference is the whole reason a
   * delegated agent's built-ins ran ungoverned. `default` answers for a tool we KNOW and nobody has
   * set: "I have not decided about `write_file` yet". `other` answers for a name that turns up at
   * run time and is in no table — an agent's own `Glob`, a tool from somebody else's MCP server.
   * With one field those two questions had one answer, and only one of them deserves `deny`.
   */
  other?: PermissionMode;
}

/** A tool a caller may be granted, and whether it can change anything. */
export interface ToolChoice {
  name: string;
  readOnly: boolean;
}

/**
 * A named starting point for the per-tool modes — a PRESET, not a setting of its own.
 *
 * This is the composer's whole permission model, and it is deliberately not the engine's `profile`.
 * A profile is a scope FILTER resolved at call time: it runs ahead of the mode, refuses anything it
 * excludes, and — for a name nothing recognises — refuses everything. A preset is the opposite kind
 * of thing. It is spent the moment it is clicked: it writes a mode for every tool and then has no
 * further say, so what runs is the map, which is also what the reader can see and edit.
 *
 * Two consequences worth stating, because they are why it is built this way:
 *
 *  - Nothing unresolvable can be sent. The composer never writes a profile NAME, so it cannot write
 *    one no registry knows — which is exactly how a permission control came to deny every tool call
 *    while displaying the word the reader had picked.
 *  - Editing one tool does not silently discard the rest. The map keeps every other mode and the
 *    preset simply stops matching, which is what {@link presetOf} reports as `custom`.
 *
 * `plan` is not among them. Plan mode is an escalation — read-only until the agent presents a plan
 * and a human approves the exit — and the exit gate is registered by the engine for the states IT
 * runs, not by the chat path. Offered here it would be `read-only` under a name that promises a door
 * out that nobody has hung.
 */
export interface PermissionPreset {
  id: string;
  label: string;
  hint: string;
  /** The mode this preset assigns a tool. Asked of the TOOL, so a newly registered one is covered. */
  modeFor: (tool: ToolChoice) => PermissionMode;
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  { id: "ask", label: "ask first", hint: "stop and ask before every call", modeFor: () => "ask" },
  {
    id: "read-only",
    label: "read-only",
    hint: "reading goes ahead, anything that writes is refused",
    modeFor: (tool) => (tool.readOnly ? "allow" : "deny"),
  },
  { id: "auto", label: "auto", hint: "each call decided by the approver", modeFor: () => "smart" },
  { id: "full", label: "full access", hint: "anything, without asking", modeFor: () => "allow" },
];

/** The modes a preset assigns over a given tool set — what clicking it writes. */
export function presetModes(preset: PermissionPreset, tools: readonly ToolChoice[]): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {};
  for (const tool of tools) out[tool.name] = preset.modeFor(tool);
  return out;
}

/**
 * Which preset a per-tool map corresponds to, or `undefined` for one that is nobody's.
 *
 * The label on the chip, and the reason a preset can be a starting point rather than a mode: edit one
 * tool and this stops matching, so the control reads `custom` instead of going on naming a preset
 * whose modes are no longer in force.
 *
 * Only the tools OFFERED are compared. A map carrying a mode for something this project no longer
 * registers is stale rather than custom, and letting a dead key hold the label at `custom` forever
 * would make the presets un-selectable-looking for no reason the reader could see.
 */
export function presetOf(
  modes: Record<string, PermissionMode> | undefined,
  tools: readonly ToolChoice[],
): PermissionPreset | undefined {
  if (modes === undefined || tools.length === 0) return undefined;
  return PERMISSION_PRESETS.find((preset) => tools.every((tool) => modes[tool.name] === preset.modeFor(tool)));
}

/**
 * The knobs the composer turns, on top of what the state already inherits.
 *
 * `tools` is the WHOLE list rather than an addition, because the operation format merges it by
 * replacement and `[]` is how an inherited tool is dropped. A composer showing an empty box beside an
 * operation that inherits `bash` would be offering to add a tool the call already has — and taking it
 * away if the person sent without touching it.
 */
export interface ChatSettings {
  model?: string;
  reasoning?: ReasoningDecl;
  tools?: readonly string[];
  permissions?: PermissionsDecl;
  /**
   * Whose CODE runs a tool — ours, or the agent's own built-in. By logical name.
   *
   * A separate axis from permission, deliberately, because they are separate questions and the menu
   * used to conflate them into one option called "default". "Let the agent use its own `Read`" and
   * "let the agent read without asking" are not the same statement, and the old control could only
   * express them together: picking `default` handed over the implementation AND gave up the gate.
   *
   * Access is ALWAYS the app's. A native implementation still answers to the mode beside it — what
   * changes is which code executes, not who authorized it.
   *
   * Absent for a tool ⇒ whatever the transport does by default, which for an agent is its own
   * built-in unless something displaces it.
   */
  implementations?: Record<string, ToolImplementation>;
}

/** Whose implementation runs — see {@link ChatSettings.implementations}. */
export type ToolImplementation = "app" | "native";

/**
 * Where one setting's value came from.
 *
 * "gpt-5, inherited from `plan/draft`" and "gpt-5, because you picked it" are different facts, and a
 * control that cannot tell them apart cannot offer to reset itself. `unset` is a third answer, not a
 * missing one: nothing was inherited, so the composer shows the project default rather than a value.
 */
export type SettingOrigin = "inherited" | "override" | "unset";

/** A setting the state declared as an expression, which has no value without a run-time scope. */
export interface UnresolvedSetting {
  field: string;
  expr: string;
}

/**
 * What pressing Enter will actually do.
 *
 * Three different things wear one button, and a person cannot see which from the box alone:
 *
 *  - `idle` — nothing is running here; the message starts a turn of its own.
 *  - `steerable` — a call is mid-turn and the transport can take input, so the message joins THAT
 *    turn and the agent answers in its own stream. No child is recorded.
 *  - `busy` — a call is mid-turn and cannot be interrupted, so sending waits for it to finish
 *    first. The delay is the behaviour, not a hang.
 */
export type ChatLiveState = "idle" | "steerable" | "busy";

/** What the composer renders: the settings a message would run under, and where each came from. */
export interface ChatPlanView {
  settings: ChatSettings;
  origin: Record<keyof ChatSettings, SettingOrigin>;
  /** The state whose operation supplied the inherited half. Absent ⇒ nothing did. */
  from?: string;
  /**
   * Shown rather than defaulted away. A composer that printed the project default beside a state
   * whose model is `{"expr": …}` would state something false about what the call will do, and the
   * person would have no way to tell.
   */
  unresolved: UnresolvedSetting[];
  /** What Enter will do right now — see {@link ChatLiveState}. */
  live: ChatLiveState;
  /**
   * What will ACTUALLY run when nothing is changed — resolved, and never blank.
   *
   * Distinct from {@link ChatSettings}, which says what was DECLARED. "No model" is a true statement
   * about a workflow file and a useless one to a person about to press Enter; these are the values
   * that answer what they were really asking. Where nothing can be known, the string names the thing
   * that decides — "the model's default", "claude-cli decides" — rather than inventing a value.
   */
  effective: { model?: string; reasoning: string; permissions: string };
  /**
   * What this machine can actually offer — the choices a control is allowed to present.
   *
   * ROUTES rather than models: the id is {route}/{model}, and the route names who answers. Switching
   * runner and switching model are the same edit to one string, which is why the control is one
   * control; it is still called "model" to the reader, because that is the word for what they are
   * choosing.
   *
   * Tools are what the registry holds for this project. Offering a name it cannot resolve would be a
   * checkbox that fails at send time.
   */
  available: { routes: string[]; tools: ToolChoice[]; models: Array<{ id: string; input: string[]; output: string[] }> };
}
