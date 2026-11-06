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
import type { PermissionSetChoice } from "./permissionSetBuckets";
import type { PermissionSetDecl } from "./permissionSets";

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
  // A permission set — a map from a subject to a mode, or a reference to one (`"$/permission-sets/read-only"`,
  // `permissionSets.ts`, decision 0007). The state editor draws it as its own Tools field; this entry is
  // what shows a value that field cannot draw (a binding), read-only, and what claims `tools`
  // diagnostics for the block.
  { name: "tools", key: "tools", type: "list", label: "Tools", group: "operation",
    placeholder: "a permission set map, in JSON",
    hint: "a permission set: a map from a tool or a command to allow / ask / deny / unavailable, a function's name, or a map of places, or a reference to one — `{}` drops the inherited ones" },
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

/**
 * The three FIXED modes a permission set entry may say (DESIGN §5.1, decision 0007). The fourth kind of
 * answer is not one of these words: any OTHER string names a function that decides each call
 * (`"web_fetch": "smart"`, decision 0023 §1), held in memory as a {@link FunctionMode} — see
 * {@link PermissionSetMode}. (`smart` was a fourth word until 2026-09-22; it is the shipped function of
 * that name, and since 2026-11-02 the string `"smart"` is how a line names it.)
 *
 * {@link UNAVAILABLE} is a decision too, but not a mode: it says the model is not handed the tool, so
 * nothing is left to decide about a call to it.
 */
export const PERMISSION_MODES = ["allow", "deny", "ask"] as const;

/**
 * The fourth word a line may say (decision 0023 §1, ruling 4): the tool is NOT HANDED to the model at
 * all, rather than handed and refused. Written on a tool, an MCP server's or tool's line, and `shell`;
 * never on a command, a runner, `script`, `other`, or a place — the model cannot be shown part of a
 * shell, and what it is shown is per tool, not per place. It is what the composer's Tools card writes
 * when a tool is unticked over a layer that offers it, so it only means something in a stack: an
 * EFFECTIVE set (`composePermissionSetLayers`) never holds it, the line is simply absent.
 */
export const UNAVAILABLE = "unavailable";

/**
 * The words a decision string may be that are NOT function names. No function may be named one of
 * these, in any case: `"Allow"` is refused rather than read as a function called `Allow`.
 */
export const RESERVED_DECISION_WORDS: readonly string[] = [...PERMISSION_MODES, UNAVAILABLE];

/**
 * A decision as AUTHORED (decision 0023 §1): one of the {@link PERMISSION_MODES}, {@link UNAVAILABLE},
 * or any other non-empty string, which names a function. Plain `string`, because the function's name
 * is free text; `parsePermissionSet` says which a given string is.
 */
export type PermissionDecisionDecl = string;

/**
 * A PLACE MAP as authored: place → decision (`{ "src": "allow", "infra": "deny", "**": "ask" }`). A map
 * speaks only at its places (§3.4); `**` is how it gives itself a default. `unavailable` is refused
 * inside one. A path literally named `mode` or `implementation` is written `./mode`, because an object
 * whose keys are only those two is the entry wrapper (`PermissionSetEntryDecl`).
 */
export type PlaceMapDecl = Record<string, PermissionDecisionDecl>;

/** A line's value as authored: a decision everywhere, or a place map (decision 0023 §1). */
export type PermissionModeDecl = PermissionDecisionDecl | PlaceMapDecl;

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
 * How hard the model should think — `llm`'s `REASONING_EFFORTS`, restated, in ascending order.
 *
 * The union of what every route names (decision 0009): `none`/`minimal` from OpenAI and OpenRouter,
 * `max` from Claude and codex, `ultra` from codex. Which levels a GIVEN model takes is its catalog
 * row's business; a call asking for more than the model offers is clamped to its top level before it
 * is sent, since asking for more thought than a model has is satisfied by giving it all of it.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** An effort LEVEL and/or a token BUDGET — models differ in which they accept, so both are carried. */
export interface ReasoningDecl {
  effort?: ReasoningEffort;
  budgetTokens?: number;
}

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * A mode that is a FUNCTION, as held IN MEMORY: `{ function: "smart" }` (decision 0007, amended
 * 2026-09-22). AUTHORED, a function is a bare string that is no mode word — `"shell": "smart"`
 * (decision 0023 §1); `{ "function": … }` was the spelling until 2026-11-02, every file was migrated,
 * and nothing reads it any more. In memory the object stays, so a function can never be mistaken for a
 * fixed mode by a `===`.
 *
 * The function is handed what an approver would be shown — the tool, the subject the entry answers
 * for, and for a shell line the PART being judged with its arguments and working directory, plus the
 * state and the task — and returns `"allow"` or `"deny"`, nothing else. It may call the function that
 * SHOWS the approval prompt (`approve_tool_call`) and return that answer, which is how a function
 * that is unsure asks the person. `function` is a reference exactly as a call in an expression names
 * its callee: a bare name searched along the path (`smart`), a dotted module symbol
 * (`policy.judge`), or a rooted path (`$BASE/functions/judge`).
 */
export interface FunctionMode {
  function: string;
}

/** What a permission set entry may say: one of the {@link PERMISSION_MODES}, or a {@link FunctionMode}. */
export type PermissionSetMode = PermissionMode | FunctionMode;

/**
 * The permission function JaiRA SHIPS: an LLM call that judges the call it is handed, and — when it is
 * unsure — asks the person through {@link APPROVAL_PROMPT_FUNCTION}. Configured in Settings →
 * Configuration → "smart" (`smart.model`, `smart.prompt`); a file named `smart` on the search path
 * replaces it, as any layer's file replaces a shipped one.
 */
export const SMART_FUNCTION = "smart";

/**
 * The function that SHOWS the approval prompt and returns what the person answered — `"allow"` or
 * `"deny"`. An interactive function like any gate (`choose_option`, `fill_form`): durable, drawn in
 * the task's conversation, callable from a permission function as `approve_tool_call(request)` and
 * never answered by a fast-forward's conversation, which is only ever offered questions.
 */
export const APPROVAL_PROMPT_FUNCTION = "approve_tool_call";

/** `smart` as a mode in memory — what the shipped `auto` permission sets give every line, authored `"smart"`. */
export const SMART_MODE: FunctionMode = Object.freeze({ function: SMART_FUNCTION }) as FunctionMode;

/**
 * A permission FUNCTION being asked about a call, as the conversation records it (the person,
 * 2026-10-24, option B): a call the tool made, beside `approve_tool_call` and the same kind of thing — a
 * `tool_use` marked `calledBy` the call it is about, with `{ function, tool, subject, command?, part? }`
 * as its input and `{ verdict, reason?, tookMs }` as its result's data. What lets the conversation say
 * "auto is checking it" while a judge decides, and what it decided after, instead of calling the wait
 * the tool running. Never replayed to a model: the model made no such call.
 */
export const PERMISSION_CHECK = "check_permission";

/**
 * A permission function as a person reads its name: the shipped `smart` is "auto" — the permission set
 * they chose — and any other by its reference.
 */
export function permissionFunctionLabel(reference: string): string {
  return reference === SMART_FUNCTION ? "auto" : reference;
}

/** Is this mode a function rather than one of the fixed words? */
export function isFunctionMode(mode: unknown): mode is FunctionMode {
  return (
    mode !== null &&
    typeof mode === "object" &&
    !Array.isArray(mode) &&
    typeof (mode as { function?: unknown }).function === "string" &&
    Object.keys(mode).length === 1
  );
}

/** Is this a mode at all — a fixed word, or a function with a non-empty reference? */
export function isPermissionSetMode(mode: unknown): mode is PermissionSetMode {
  if (typeof mode === "string") return (PERMISSION_MODES as readonly string[]).includes(mode);
  return isFunctionMode(mode) && mode.function.trim().length > 0;
}

/** The function a mode names, or `undefined` for a fixed mode. */
export function modeFunction(mode: PermissionSetMode | undefined): string | undefined {
  return isFunctionMode(mode) ? mode.function : undefined;
}

/**
 * The mode the UPSTREAM gate is handed for a permission set mode. A function decides per call, and the one
 * upstream mode that reaches a host with the call in hand and nothing decided is `ask` — the approver
 * JaiRA hands the engine runs the function before any person is asked (`withPermissionFunctions` in
 * `@jaira/runtime`).
 */
export function gateModeOf(mode: PermissionSetMode): PermissionMode {
  return isFunctionMode(mode) ? "ask" : mode;
}

/** Two modes say the same thing — the same word, or a function by the same reference. */
export function sameMode(a: PermissionSetMode | undefined, b: PermissionSetMode | undefined): boolean {
  if (isFunctionMode(a) || isFunctionMode(b)) return isFunctionMode(a) && isFunctionMode(b) && a.function === b.function;
  return a === b;
}

/**
 * A mode as one short word — for a summary line, and as the AUTHORED spelling: the fixed word, or the
 * function's reference, which is exactly how a line names a function (decision 0023 §1).
 */
export function modeWord(mode: PermissionSetMode): string {
  return isFunctionMode(mode) ? mode.function : mode;
}

/**
 * How strict a mode is: deny ▸ ask ▸ function ▸ allow (decision 0023 §3.2). A function sits between
 * `allow` and `ask` because it may let the call through without anybody asked, and may refuse it —
 * the same place `decideCommand` ranks a `function` verdict.
 */
export function modeStrictness(mode: PermissionSetMode): number {
  if (isFunctionMode(mode)) return 1;
  return mode === "allow" ? 0 : mode === "ask" ? 2 : 3;
}

/**
 * The strictest of several modes, the first met among equals (two different functions are equally
 * strict, and the one met first stands). `undefined` for none.
 */
export function strictestMode(...modes: readonly PermissionSetMode[]): PermissionSetMode | undefined {
  let out: PermissionSetMode | undefined;
  for (const mode of modes) if (out === undefined || modeStrictness(mode) > modeStrictness(out)) out = mode;
  return out;
}

/** The loosest of several modes, the first met among equals. `undefined` for none. */
export function loosestMode(...modes: readonly PermissionSetMode[]): PermissionSetMode | undefined {
  let out: PermissionSetMode | undefined;
  for (const mode of modes) if (out === undefined || modeStrictness(mode) < modeStrictness(out)) out = mode;
  return out;
}

/**
 * A `permissions` block in the shape the upstream engine takes — what a permission set LOWERS to.
 *
 * An author writes a permission set in `tools` (`permissionSets.ts`, decision 0007) and nothing here:
 * every key of this block is written by lowering (`permissionsOfPermissionSet`) and read back by
 * `permissionSetOfEnvironment`. Where a tool may act is a place map on its line (decision 0023 §3); the
 * state table `permissions.scopes` is gone and the linter refuses it. The engine still knows a `profile`
 * and a `default`; nothing JaiRA writes carries either, and the linter refuses an authored one.
 */
export interface PermissionsDecl {
  /**
   * WRITTEN BY LOWERING: each tool entry's mode as the upstream gate takes it — a function as `ask`
   * (see {@link functions}), and the shell's as `ask` whatever it says (see {@link subjects}).
   */
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
   * WRITTEN BY LOWERING, never authored, and on EVERY lowered map (empty when no line has places): each
   * line's PLACE MAP (decision 0023 §3), by subject, as authored — `{ "read_file": { "**": "deny",
   * "docs/product": "allow" } }`, the line's own mode as its `**` where it has one, and each place's
   * decision in its authored spelling: `allow`, `ask`, `deny`, or a FUNCTION by name.
   *
   * Authored words, not gate modes, because nothing upstream reads this key: `tools` and `subjects`
   * hold gate modes only because the upstream gate reads them, and {@link functions} exists to carry
   * what a gate mode cannot say. A place's function is therefore found HERE, by the narrowing and by
   * `decideCommand`, and routed to its function the way a line's is.
   *
   * Where a line has places, this is the line: `tools` holds its LOOSEST answer for the gate (decision
   * 0023 §3.10), and `subjects` its own mode where it has one; `permissionSetOfEnvironment` reads the
   * line back from here. Always written, for the reason {@link functions} is: `permissions` merges per
   * key down the `environment` chain, and a child whose map wrote no places would otherwise judge its
   * own `read_file: "allow"` at its parent's places.
   *
   * Where the old state table `permissions.scopes` was: those tables were moved onto lines as place
   * maps (decision 0023 §3.7) and the key is gone. An executor's `scopes` are a separate FLOOR, kept.
   */
  places?: Record<string, Record<string, string>>;
  /**
   * WRITTEN BY LOWERING, never authored: a permission set's command subjects and `script`, with their modes
   * (`"git commit": "allow"`). A map-form state reaches the engine as a list and this block, and
   * these are the entries neither has a place for.
   *
   * What a shell line's PARTS are judged against (decision 0007 §4). The shell's own entry is here
   * too — `shell`, the mode for any command nothing else names — because `tools.shell` is lowered as
   * `ask`, so that no line runs before the host has read it. A subject whose entry is a function is
   * `ask` here, as it is at the gate, and named in {@link functions}.
   */
  subjects?: Record<string, PermissionMode>;
  /**
   * WRITTEN BY LOWERING, never authored, and on EVERY lowered map (empty when nothing is a function):
   * the subjects whose entry is a function, by subject — a tool, a command, `script`, `shell` or
   * `other` — each to the function's reference (`{ "shell": "smart" }`).
   *
   * Always written because `permissions` merges per key down the `environment` chain: a child whose
   * map named no function would otherwise inherit its parent's, and a line it meant to ASK about would
   * be handed to the parent's function instead.
   */
  functions?: Record<string, string>;
  /**
   * WRITTEN BY LOWERING, never authored, and only beside {@link subjects}: where those subjects came
   * from — the reference the state named its permission set by (`$/permission-sets/ask-first`), or `inline`
   * for a map written on the state (a `$ref` with siblings counts as written on the state: a sibling
   * is an entry no file holds). Written WITH `subjects` every time, so a child block that replaces
   * the one replaces the other, and an approval never names a parent's file for a child's map.
   *
   * It is how an approval can say which permission set asked, and which file "add to the permission set" edits.
   */
  source?: string;
  /** WRITTEN BY LOWERING, never authored: a permission set entry's `implementation`, by tool. */
  implementations?: Record<string, ToolImplementation>;
  /**
   * WRITTEN BY LOWERING, never authored, on every map a STATE lowers: the stack of layers the set was
   * composed from (decision 0023 §2.6) and who set each line (§2.7) — what a part's row names as its
   * layer (`CommandPart.decidedBy.layer`) and what an approval lists for "Add to". Written on every
   * such map for the reason {@link functions} is: a child's map must never name its parent's layers.
   */
  stack?: PermissionStackDecl;
}

/**
 * A stack of permission sets as a lowered block, or a turn's policy, carries it (decision 0023 §2.7).
 *
 * `layers` oldest first, each by its id (`ask-first`, `app/build`, `inline`, `tools`) and, for a
 * layer in a file, the reference it was read through. `lines` is who set each line — by normalized
 * subject, `other` included: the layer behind its own mode (`everywhere`), behind each other place, and
 * behind its implementation. Absent for a stack of one layer, which set every line.
 */
export interface PermissionStackDecl {
  layers: Array<{ id: string; reference?: string }>;
  lines?: Record<string, { everywhere?: string; places: Record<string, string>; implementation?: string }>;
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
 * FROZEN — the tools the `read-only` preset let through, and so the tools `read-only` allows IN
 * THE PROJECT: since decision 0023 §7.1 its `read_file`, `glob` and `grep` are place maps that allow in
 * `$PROJECT` and `$WORKTREE` and ask elsewhere and at a credential, and the test that holds the file to
 * this list reads each line at `$PROJECT`.
 *
 * The composer's four presets were functions of a tool (`modeFor`); they are permission set FILES now
 * (`$SYSTEM/permission-sets/*.json`, decision 0007 §2), and "which preset is this" is `matchPermissionSet` in
 * `permissionSetBuckets.ts`. This list is what is left of them: exactly the tools `ToolSpec.readOnly` was
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
 * operation that inherits `shell` would be offering to add a tool the call already has — and taking it
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
   * The same three things as ONE permission set (`permissionSets.ts`, decision 0007) — and, since
   * decision 0023, the conversation's STACK of them (§2.6, ruling 8):
   *
   * ```json
   * { "layers": ["$/permission-sets/ask-first", "$/permission-sets/web/docs-sites"], "write_file": "allow", "glob": "unavailable" }
   * ```
   *
   * `layers[0]` is the bottom layer (the preset), the rest are the conversation's own layers (§2.6
   * step 3), and the lines written beside them are the TOOLS layer (step 5): what the composer's Tools
   * card ticks and moves, `unavailable` for a tool unticked over a layer that offers it. The bucket's
   * standing layers (`permissions.layers.<bucket>` in settings, step 2) go between the bottom and the
   * rest, and the run's answers (step 4) between the rest and the tools — neither is written here.
   * A map with no `layers` is a stack of one layer, the tools layer, over the top level's (`""`) standing
   * layers. The service follows the references (`resolveChatPermissionStack`) before a turn runs;
   * `permissionSetOfSettings` reads a map that has none.
   *
   * When present it is the whole answer and `tools`, `permissions` and `implementations` are not
   * read — where a tool may act is a place map on its line; the three fields above are what a state's
   * lowered block still arrives as.
   */
  permissionSet?: PermissionSetDecl;
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
    /** `levels`: the model's reasoning levels in a few words (`low–max`, `no thinking level`), when known. */
    models: Array<{ id: string; input: string[]; output: string[]; levels?: string }>;
    /**
     * Every permission set on this project's search path, references followed — what the Permissions card's
     * rows and its bucket picker are drawn from (decision 0007 §5). Absent from a plan built before
     * there were any, which a composer reads as "no buckets".
     */
    permissionSets?: PermissionSetChoice[];
    /** The bucket the card opens on — see `bucketOf` in `permissionSetBuckets.ts`. */
    bucket?: string;
  };
}
