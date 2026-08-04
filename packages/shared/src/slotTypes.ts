/**
 * The slot type vocabulary the authoring UI offers — a small, named set of JSON Schema templates.
 *
 * A slot's type is its `schema`, not its `kind`. `kind` is the engine's TRANSPORT tag (`text` ·
 * `json` · `blob` · `prompt` · `function`) and it is *derived* from the schema by `kindFor`:
 * string + `contentMediaType`/`contentEncoding` ⇒ `blob`, other strings ⇒ `text`, everything else ⇒
 * `json`. WORKFLOWS.md §3 says outright that you rarely write it. So a form offering `kind` and
 * nothing else offers the one field authors should not be filling in, and hides the field that
 * carries every type worth naming — arrays, objects, and the synonyms below.
 *
 * **Synonyms are `x-type`, never `format`.** `x-type` is the one `x-` keyword the subtype checker
 * treats as CONSTRAINING (`@declarative-ai/validate`'s `isSubschema`), so a `Url` slot refuses a
 * bare-string producer and vice versa; and a name with no codec registered passes through as raw
 * JSON (`decodeWithSchema`), so the vocabulary works as pure nominal typing today and gains
 * encode/decode the day someone registers one. `format` would buy none of that: the subtype checker
 * ignores it as annotation-only, and JaiRA's ajv is built without `ajv-formats`, so a `format`
 * keyword is checked by precisely nothing.
 *
 * ## What this module OWNS
 *
 * Five keywords, listed in {@link OWNED_KEYWORDS}. A schema built from anything else — `properties`,
 * `enum`, `minimum`, even a `description` — is not in this vocabulary, and {@link slotTypeOf}
 * reports it as such rather than approximating it. The caller then shows it read-only. That refusal
 * is the point: a picker that rounded `{"type":"object","properties":{…}}` down to "object" would
 * delete the properties the moment anyone touched the row.
 */

/** A named type in the vocabulary. `any` is "no schema at all" — unconstrained, and unchecked. */
export type SlotTypeName =
  | "any"
  | "text"
  | "url"
  | "file"
  | "artifact"
  | "number"
  | "integer"
  | "datetime"
  | "boolean"
  | "object";

/** A schema document, as far as this module needs to read one. */
export type SchemaObject = Record<string, unknown>;

/**
 * The keywords the picker writes and therefore may overwrite. Anything else on a schema puts it
 * outside the vocabulary — see the module header.
 */
export const OWNED_KEYWORDS: readonly string[] = ["type", "x-type", "contentMediaType", "contentEncoding", "items"];

/** One entry in the picker, in the order it is offered. */
export interface SlotTypeInfo {
  name: SlotTypeName;
  /** What the dropdown shows. */
  label: string;
  /** A one-line note on what the type means for the engine. */
  hint: string;
}

export const SLOT_TYPES: readonly SlotTypeInfo[] = [
  { name: "any", label: "any", hint: "no schema — nothing about this slot can be type-checked" },
  { name: "text", label: "text", hint: "a plain string" },
  { name: "url", label: "url", hint: "a string tagged Url — only another Url may be wired into it" },
  { name: "file", label: "file path", hint: "a string tagged FilePath — a path, not the bytes" },
  { name: "artifact", label: "artifact", hint: "content with a media type — this is what makes a slot a blob" },
  { name: "number", label: "number", hint: "any JSON number" },
  { name: "integer", label: "integer", hint: "a whole number" },
  { name: "datetime", label: "datetime", hint: "a number tagged DateTime — an instant, not a bare epoch" },
  { name: "boolean", label: "boolean", hint: "true or false" },
  { name: "object", label: "object", hint: "an object with no declared properties — add them on the JSON tab" },
];

/** The `x-type` name each synonym carries. One place, so the UI and any future codec agree. */
export const TYPE_NAMES = { url: "Url", file: "FilePath", datetime: "DateTime" } as const;

/** The default media type a new artifact slot declares. */
export const DEFAULT_MEDIA_TYPE = "text/markdown";

/** A type as a slot actually carries it: the name, whether it is a list, and the artifact's payload. */
export interface SlotType {
  name: SlotTypeName;
  /** True when the schema is an array wrapping the named type. */
  list: boolean;
  /** `artifact` only: the schema's `contentMediaType`. */
  mediaType?: string;
  /** `artifact` only: the schema's `contentEncoding`, when it declares one. */
  encoding?: string;
}

/** The unconstrained default — what a slot with no schema is, and what a new row starts as. */
export const ANY_TYPE: SlotType = { name: "any", list: false };

/** The schema for one non-list type, or `undefined` for `any`. */
function leafSchema(type: SlotType): SchemaObject | undefined {
  switch (type.name) {
    case "any":
      return undefined;
    case "text":
      return { type: "string" };
    case "url":
      return { type: "string", "x-type": TYPE_NAMES.url };
    case "file":
      return { type: "string", "x-type": TYPE_NAMES.file };
    case "artifact":
      return {
        type: "string",
        contentMediaType: type.mediaType && type.mediaType.length > 0 ? type.mediaType : DEFAULT_MEDIA_TYPE,
        ...(type.encoding !== undefined ? { contentEncoding: type.encoding } : {}),
      };
    case "number":
      return { type: "number" };
    case "integer":
      return { type: "integer" };
    case "datetime":
      return { type: "number", "x-type": TYPE_NAMES.datetime };
    case "boolean":
      return { type: "boolean" };
    case "object":
      return { type: "object" };
  }
}

/**
 * The schema a type writes, or `undefined` when it declares none.
 *
 * A list of `any` is `{"type":"array"}` with no `items` — genuinely "a list of anything", which is
 * different from no schema at all and worth being able to say.
 */
export function schemaForSlotType(type: SlotType): SchemaObject | undefined {
  const leaf = leafSchema(type);
  if (!type.list) return leaf;
  return leaf === undefined ? { type: "array" } : { type: "array", items: leaf };
}

function isObject(value: unknown): value is SchemaObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when a schema carries only keywords this module owns — see the module header. */
function onlyOwnedKeywords(schema: SchemaObject): boolean {
  return Object.keys(schema).every((key) => OWNED_KEYWORDS.includes(key));
}

/** Read one non-list schema. `null` means "outside the vocabulary". */
function leafTypeOf(schema: SchemaObject): SlotType | null {
  if (!onlyOwnedKeywords(schema) || "items" in schema) return null;
  const type = schema["type"];
  const named = schema["x-type"];
  const mediaType = schema["contentMediaType"];
  const encoding = schema["contentEncoding"];

  if (mediaType !== undefined || encoding !== undefined) {
    // The documented artifact declaration (WORKFLOWS.md §10) — and the one derivation `kindFor`
    // makes that an author is expected to know, since it is what turns a slot into a blob.
    if (type !== "string" || named !== undefined || typeof mediaType !== "string") return null;
    if (encoding !== undefined && typeof encoding !== "string") return null;
    return { name: "artifact", list: false, mediaType, ...(encoding === undefined ? {} : { encoding }) };
  }
  if (typeof named === "string") {
    if (type === "string" && named === TYPE_NAMES.url) return { name: "url", list: false };
    if (type === "string" && named === TYPE_NAMES.file) return { name: "file", list: false };
    if (type === "number" && named === TYPE_NAMES.datetime) return { name: "datetime", list: false };
    // A type name this vocabulary does not know. Real, and not ours to rewrite.
    return null;
  }
  if (named !== undefined) return null;
  switch (type) {
    case "string":
      return { name: "text", list: false };
    case "number":
      return { name: "number", list: false };
    case "integer":
      return { name: "integer", list: false };
    case "boolean":
      return { name: "boolean", list: false };
    case "object":
      return { name: "object", list: false };
    case undefined:
      return Object.keys(schema).length === 0 ? { name: "any", list: false } : null;
    default:
      return null;
  }
}

/**
 * Which vocabulary type a slot's schema is, or `null` when it is richer than the vocabulary.
 *
 * `null` is not a failure — it is the answer for every schema with `properties`, an `enum`, a bound,
 * or a type name from elsewhere. The caller shows those read-only rather than offering a control
 * that could only make them worse.
 */
export function slotTypeOf(schema: unknown): SlotType | null {
  if (schema === undefined) return ANY_TYPE;
  if (!isObject(schema)) return null;
  if (!onlyOwnedKeywords(schema)) return null;
  if (schema["type"] === "array") {
    // Only `items` may accompany an array — a tuple form (`items: [...]`) or `prefixItems` is not
    // "a list of one type" and must not be shown as one.
    const items = schema["items"];
    if (Object.keys(schema).some((key) => key !== "type" && key !== "items")) return null;
    if (items === undefined) return { name: "any", list: true };
    if (!isObject(items)) return null;
    const leaf = leafTypeOf(items);
    return leaf === null ? null : { ...leaf, list: true };
  }
  return leafTypeOf(schema);
}

/** True when two schemas are the same document — used to leave an untouched slot exactly as it was. */
export function sameSchema(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Key-sorted, so a reformat or a differently ordered template does not read as a change. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}
