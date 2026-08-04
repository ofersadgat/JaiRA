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
