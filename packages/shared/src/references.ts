/**
 * How a document reference is SPELLED — the one rule the authoring form kept sending people to the
 * JSON tab for (WORKFLOWS.md §2.2).
 *
 * A reference is templating: the referenced node is spliced in and then behaves as if it had been
 * typed there. What it looks like depends entirely on what the position expects:
 *
 *  - a position expecting an **object or array** ⇒ a **bare string** is the reference
 *    (`"operation": "$/lib/review.operation"`, `"schema": "$/types/markdown"`);
 *  - a position expecting a **string or number** ⇒ `{"$ref": "…"}` is the reference
 *    (`"prompt": {"$ref": "$/prompts/review.md"}`).
 *
 * That asymmetry is not an accident and it cannot be papered over: a string where a string belongs is
 * a string, which is what lets a prompt contain `feature/plan.outputs.summary` with no escaping. So
 * the form has to know which position it is editing, and this module is where that knowledge lives —
 * one table rather than an `if` at each of the four call sites.
 *
 * Reading is deliberately STRICTER than the loader. The loader happily merges sibling keys over a
 * `{"$ref": …}` in an object position; this reports such a value as "not a plain link", because a
 * control that showed only the `$ref` would delete the overrides the moment anyone touched it. The
 * form falls back to read-only there, which is what it already does for every other shape it cannot
 * represent.
 */

/**
 * Which spelling a position uses.
 *
 * `schema` is the narrow case WORKFLOWS.md §2.2 flags, and it has to be its own value rather than a
 * synonym for `object`: **inside a `schema`, `$ref` is always JSON Schema's own, never ours.** We
 * never claim the key there, so `"schema": {"$ref": "#/$defs/plan"}` is a JSON Schema reference and
 * reading it as a document link would rewrite it as a bare string and change what it means. Only the
 * bare-string form — `"schema": "$/types/markdown"` — is ours, which is exactly why the two
 * vocabularies cannot collide: JSON Schema has no use for a bare string in that position.
 */
export type RefPosition = "string" | "object" | "schema";

/**
 * The suffixes an extensionless reference probes, in hw's order (`reference.ts`'s `DATA_EXTENSIONS`).
 *
 * Restated rather than imported because `@jaira/shared` is loaded in the renderer, which has no
 * business reaching into the engine. It is worth restating for one reason: these are the ONLY
 * extensions that may be dropped. `$/prompts/goals` finds `goals.json` and does not find `goals.md`,
 * so a picker that offered the extensionless spelling of a `.md` file would suggest a reference that
 * resolves to nothing.
 */
export const REF_DATA_EXTENSIONS: readonly string[] = ["json", "yaml", "yml"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The reference an authored value holds, or `undefined` when it is not a plain one.
 *
 * `undefined` covers both "this is a literal" and "this is a reference with sibling overrides" — the
 * caller treats the second the way it treats every other unrepresentable shape, read-only.
 */
export function readRef(value: unknown, position: RefPosition): string | undefined {
  if (typeof value === "string") return position === "string" ? undefined : value;
  // Never inside a schema — the key belongs to JSON Schema there. See {@link RefPosition}.
  if (position === "schema") return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const ref = record["$ref"];
  // Sole key only: siblings override what the reference brought in, and this form cannot show them.
  if (typeof ref !== "string" || Object.keys(record).length !== 1) return undefined;
  return ref;
}

/** The value to write for a reference in this position. Inverse of {@link readRef}. */
export function writeRef(ref: string, position: RefPosition): string | { $ref: string } {
  return position === "string" ? { $ref: ref } : ref;
}

/**
 * Spell a file's path under a layer root as a reference the loader would resolve.
 *
 * `$/…` rather than `$JAIRA/…`: a bare `$` is searched along the whole layer path, so a prompt the
 * shared root supplies and a project copy that overrides it are one spelling. Naming a layer is
 * something an author does deliberately, not something a picker should decide for them.
 *
 * A data extension is dropped because references probe for it and the shorter form is what the
 * documented examples use (`$/types/markdown`). Every other extension is KEPT — see
 * {@link REF_DATA_EXTENSIONS}.
 */
export function refForPath(path: string): string {
  const match = /\.([^./]+)$/.exec(path);
  const bare =
    match !== null && REF_DATA_EXTENSIONS.includes(match[1]!.toLowerCase())
      ? path.slice(0, -match[0].length)
      : path;
  return `$/${bare}`;
}

/**
 * A rough "does this look like a reference at all" check, for warning before the linter runs.
 *
 * Not the loader's rule and not trying to be — hw decides by probing the filesystem, which the
 * renderer cannot do. This only catches the case worth catching early: a link box holding something
 * that names no root and no path, which cannot resolve wherever it is read from.
 */
export function looksLikeRef(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return (
    trimmed.startsWith("$") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[/\\]/.test(trimmed) ||
    // A bare id — `lib/review.operation`. Legal, and searched along the path like any other.
    /^[^\s]+\/[^\s]+$/.test(trimmed)
  );
}
