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
import type { Scope } from "./scopes";
import type { ToolsetChoice } from "./toolsetBuckets";
import type { ToolsetDecl } from "./toolsets";

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
   * Shown with the operation rather than folded into the model-settings disclosure.
   *
   * `model` is in the model GROUP because that is what it is — a field of the LLM call — but it is
   * not a knob, and being filed beside `topK` and `frequencyPenalty` behind a collapsed summary is
   * what made an `environment` block look like it said nothing. Which model answers is the most
   * consequential thing a block states, and on an `environment` block it is the thing that decides
   * who serves every descendant. It belongs where you can see it without opening anything.
   */
  prominent?: true;
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
  // The LIST form. A toolset — a map from a subject to a mode, or a reference to one
  // (`"$/toolsets/chat/read-only"`) — is the other thing this key holds (`toolsets.ts`, decision
  // 0007). The form shows that one read-only, as it does any value it did not write, and the schema
  // (`schemas.ts`) admits both.
  { name: "tools", key: "tools", type: "list", label: "Tools", group: "operation",
    placeholder: "read_file, run_command",
    hint: "tool names — or, in JSON, a toolset: a map from a tool or a command to allow / ask / deny / smart, or a reference to one. An empty list drops the inherited ones" },
  { name: "model", key: "model", type: "string", label: "Model", group: "model",
    kinds: ["prompt"], prominent: true,
    placeholder: "claude-sonnet-5, or claude-cli/sonnet to pin the route",
    hint: "a bare id routes to whatever serves that family here — prefix it to insist on one route" },
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

/**
 * The authored permission baseline: a default, and per-tool overrides.
 *
 * ⚠️ The LEGACY shape, and the shape the upstream engine takes. What an author writes now is a
 * toolset in `tools` (`toolsets.ts`, decision 0007); `tools` and `default` here are still read, and
 * every consumer reads both forms through the one `Toolset` they fold into.
 */
export interface PermissionsDecl {
  /**
   * LEGACY, read and never written. A profile is no longer a concept (decision 0007 §1): an old
   * `"read-only"` is read as the `deny` entries and the `other` it used to mean — `applyLegacyProfile`
   * in `toolsets.ts` — and no lowering hands one to the engine.
   */
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
  /**
   * WHERE each tool may act — see `scopes.ts`.
   *
   * The axis a mode alone cannot express: `write_file: "allow"` is allow-everywhere, and what anybody
   * actually means is "under `app/`". Unmatched denies, so a table naming only the sandbox IS the
   * sandbox and widening is the thing you have to write.
   */
  scopes?: Scope[];
  /**
   * WRITTEN BY LOWERING, never authored: a toolset's command subjects and `script`, with their modes
   * (`"git commit": "allow"`). A map-form state reaches the engine as a list and this block, and
   * these are the entries neither has a place for.
   *
   * What a shell line's PARTS are judged against (decision 0007 §4). The shell's own entry is here
   * too — `bash`, the mode for any command nothing else names — because `tools.bash` is lowered as
   * `smart` so that the line is read before anything answers for the tool. Its presence is also what
   * tells a lowered toolset from an unmigrated block, whose shell answers as it always did.
   */
  subjects?: Record<string, PermissionMode>;
  /**
   * WRITTEN BY LOWERING, never authored, and only beside {@link subjects}: where those subjects came
   * from — the reference the state named its toolset by (`$/toolsets/chat/ask-first`), or `inline`
   * for a map written on the state (a `$ref` with siblings counts as written on the state: a sibling
   * is an entry no file holds). Written WITH `subjects` every time, so a child block that replaces
   * the one replaces the other, and an approval never names a parent's file for a child's map.
   *
   * It is how an approval can say which toolset asked, and which file "add to the toolset" edits.
   */
  source?: string;
  /** WRITTEN BY LOWERING, never authored: a toolset entry's `implementation`, by tool. */
  implementations?: Record<string, ToolImplementation>;
}

/** A tool a caller may be granted. */
export interface ToolChoice {
  name: string;
  /**
   * What each agent route calls ITS OWN tool doing this job, by route (`{ "claude-cli": "Read" }`) —
   * read off the executors' declarations (`agentTools.ts`) by whoever lists the tools. Absent for a
   * route ⇒ that agent has no built-in to choose instead, so the implementation is not a choice there.
   */
  natives?: Record<string, string>;
}

/**
 * FROZEN — the tools the `read-only` preset let through, and so the tools `chat/read-only` allows.
 *
 * The composer's four presets were functions of a tool (`modeFor`); they are toolset FILES now
 * (`$SYSTEM/toolsets/chat/*.json`, decision 0007 §2), and "which preset is this" is `matchToolset` in
 * `toolsetBuckets.ts`. This list is what is left of them: exactly the tools `ToolSpec.readOnly` was
 * true for on the day that flag was removed, kept so a test can hold the shipped file to the map the
 * preset always wrote, and the runtime's tools to the facts it was derived from. Nothing reads it to
 * decide anything.
 */
export const READ_ONLY_PRESET_TOOLS: readonly string[] = ["read_file", "glob", "grep", "show_artifact", "web_fetch", "web_search"];

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
  /**
   * The same three things as ONE map — a toolset, subject → mode (`toolsets.ts`, decision 0007).
   *
   * When present it is the whole answer and `tools`, `permissions.tools` / `default` / `other` and
   * `implementations` are not read; `permissions.scopes` still is, because where a tool may act is
   * not part of a toolset. This is what the composer WRITES — picking a toolset row, ticking a tool
   * or changing a mode sends the whole map — and the three fields above are what a state's lowered
   * block still arrives as; `toolsetOfSettings` reads either.
   */
  toolset?: ToolsetDecl;
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
   * whose model is `{"$expr": …}` would state something false about what the call will do, and the
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
  available: {
    routes: string[];
    tools: ToolChoice[];
    models: Array<{ id: string; input: string[]; output: string[] }>;
    /**
     * Every toolset on this project's search path, references followed — what the Permissions card's
     * rows and its bucket picker are drawn from (decision 0007 §5). Absent from a plan built before
     * there were any, which a composer reads as "no buckets".
     */
    toolsets?: ToolsetChoice[];
    /** The bucket the card opens on — see `bucketOf` in `toolsetBuckets.ts`. */
    bucket?: string;
  };
}
