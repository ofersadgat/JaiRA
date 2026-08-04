/**
 * Editing a JSON value in a one-line text box, without a quoting ritual.
 *
 * A slot's `default`, an operation's `args`, a child's `{ json }` binding — all are `JsonValue`, and
 * all are things an author types into a small box. Demanding strict JSON there means writing
 * `"significant"` with the quotes for what WORKFLOWS.md itself writes as `"default": "significant"`,
 * which is the kind of tax that makes people use the JSON tab for everything.
 *
 * So: **a value that does not parse as JSON is a string.** `significant` is the string, `3` is the
 * number, `["a","b"]` is the array.
 *
 * The trap that rule walks into is round-tripping. If the STRING `3` displayed as bare `3`, reading
 * it back would produce the NUMBER 3 and silently retype the slot. {@link jsonTextOf} therefore
 * quotes exactly those strings that would come back as something else — a string is shown bare only
 * when bare text is unambiguous, which is to say only when JSON refuses to parse it.
 */

/** True when `text` is legal JSON, and therefore cannot be shown bare without changing meaning. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A JSON value as editable text. `undefined` is the empty box — "not declared", which is why an
 * empty STRING has to be shown as `""` rather than as nothing.
 */
export function jsonTextOf(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string" && value.length > 0 && !parsesAsJson(value)) return value;
  return JSON.stringify(value);
}

/** The value a box holds. Empty is `undefined` — absent, not `""`. Unparseable is a string. */
export function jsonValueOf(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * A list of names as one comma-separated box, and back.
 *
 * `tools`, `stopSequences` and `conversation.artifacts` are all short lists of short strings, and a
 * row-per-entry table for three tool names reads as ceremony. Empty is absent — but `"tools": []` is
 * MEANINGFUL (arrays replace in the environment merge, so `[]` is how an inherited tool is dropped),
 * so that one is spelled explicitly and {@link listOf} preserves it.
 */
export function listTextOf(value: unknown): string {
  return Array.isArray(value) ? value.map((entry) => String(entry)).join(", ") : "";
}

/** The list a box holds, or `undefined` when it is empty. See {@link listTextOf} on `[]`. */
export function listOf(text: string): string[] | undefined {
  const entries = text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}
