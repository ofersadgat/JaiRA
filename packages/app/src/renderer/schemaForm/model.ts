/**
 * Everything the schema form DECIDES, with no React in it.
 *
 * `SchemaForm.tsx` draws; this module answers the questions the drawing depends on — which shapes a
 * value may take and which one it holds, what a new value starts as, what a field says about itself
 * before anyone types, what a closed list row reads as, and what a validator's complaint means in
 * words and where on the form it belongs. Those are the parts with rules in them, and the app's view
 * tests render to static markup with no DOM, so the rules live where a plain test can reach them.
 *
 * Two decisions shape the module, and both came from the person using the form:
 *
 *  - **An optional field is `oneOf(value, not set)`.** Not set is an ANSWER, chosen with a switch — it
 *    is not what an empty box happens to mean. So nothing here reads `""` as absent: `""` is a string,
 *    and whether a string may be empty is the schema's business (`minLength`), not the form's.
 *  - **The form checks what the run checks.** The verdict comes from the same validator the run uses,
 *    in the main process. This module only turns that validator's errors into sentences and pins each
 *    one to the field it is about — it never decides on its own that a value is wrong.
 */
import type { Schema } from "./types";

// --- paths ---------------------------------------------------------------------

/** A member's path under its container: `plan.steps`, or `steps` at the top. */
export function childPath(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key;
}

/** An item's path in its list: `plan.steps[2]`. */
export function itemPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

// --- reading a schema ------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function isObjectSchema(s: Schema): boolean {
  return s["type"] === "object" || s["properties"] !== undefined || s["allOf"] !== undefined;
}

export function isArraySchema(s: Schema): boolean {
  return s["type"] === "array" || s["items"] !== undefined;
}

/**
 * Follow a local `$ref` to the node the document declares it as.
 *
 * Local pointers only (`#/definitions/x`, `#/$defs/x`). A `$ref` to another document is a fetch, and
 * a form that quietly fetched would render differently depending on the network. Anything it cannot
 * follow comes back unchanged. Siblings beside the `$ref` WIN, which is 2019-09's rule and the useful
 * one: `{$ref: "#/definitions/slot", description: "the issue to work"}` means the shared shape with
 * that description.
 */
export function deref(schema: Schema, root: Schema | undefined, depth = 0): Schema {
  const ref = schema["$ref"];
  // Eight is far past anything real and stops a document that refers to itself from hanging.
  if (typeof ref !== "string" || root === undefined || depth > 8 || !ref.startsWith("#/")) return schema;
  let at: unknown = root;
  for (const step of ref.slice(2).split("/")) {
    const key = decodeURIComponent(step).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(at)) return schema;
    at = at[key];
  }
  if (!isRecord(at)) return schema;
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"));
  return deref({ ...at, ...rest }, root, depth + 1);
}

/**
 * The schema every OTHER key of an object answers to, when it declares one.
 *
 * `additionalProperties: true` and `false` are not schemas: neither says what an extra key's value
 * would LOOK like, so neither produces rows.
 */
export function mapSchema(schema: Schema, root: Schema | undefined): Schema | undefined {
  const extra = schema["additionalProperties"];
  if (!isRecord(extra)) return undefined;
  return deref(extra, root);
}

/**
 * Merge `allOf` members and own `properties` — base first, own overrides — tracking the `$type` that
 * DECLARED each member, so a base-defined member resolves its presentation under that base.
 */
export function flatten(
  schema: Schema,
  declaringType?: string,
  root?: Schema,
): { properties: Record<string, Schema>; declaredBy: Record<string, string | undefined>; required: Set<string> } {
  const myType = (schema["$type"] as string | undefined) ?? declaringType;
  let properties: Record<string, Schema> = {};
  let declaredBy: Record<string, string | undefined> = {};
  const required = new Set<string>();
  for (const member of (schema["allOf"] as Schema[] | undefined) ?? []) {
    const f = flatten(deref(member, root), undefined, root);
    properties = { ...properties, ...f.properties };
    declaredBy = { ...declaredBy, ...f.declaredBy };
    for (const key of f.required) required.add(key);
  }
  for (const [key, sub] of Object.entries((schema["properties"] as Record<string, Schema> | undefined) ?? {})) {
    properties[key] = sub;
    declaredBy[key] = myType;
  }
  for (const key of (schema["required"] as unknown[] | undefined) ?? []) {
    if (typeof key === "string") required.add(key);
  }
  return { properties, declaredBy, required };
}

// --- shapes ------------------------------------------------------------------------

const UNION_KEYS = ["anyOf", "oneOf"] as const;

/**
 * The shapes a value may take, or `undefined` when there is only one.
 *
 * Three spellings mean "one of these": `anyOf`, `oneOf`, and a `type` ARRAY
 * (`["string", "null"]`). All three become the same picker. Keywords beside an `anyOf` apply to every
 * branch — `{description, anyOf: [...]}` describes each of them, and `{type: "object", oneOf: [...]}`
 * makes every branch an object — so they are folded into each one. A `null` branch takes none of them:
 * a `minLength` beside `["string", "null"]` is about the string.
 */
export function branchesOf(schema: Schema, root?: Schema, resolve = true): Schema[] | undefined {
  for (const key of UNION_KEYS) {
    const raw = schema[key];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const siblings = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== key));
    const branches = raw.filter(isRecord).map((branch) => {
      const own = deref(branch, root);
      if (own["type"] === "null") return own;
      // Unresolved on request: the renderer hands a branch on to itself, and a `$ref` it can still
      // SEE is what stops a schema that refers to itself from being expanded for ever.
      return resolve ? { ...siblings, ...own } : { ...siblings, ...branch };
    });
    return branches.length > 1 ? branches : undefined;
  }
  const type = schema["type"];
  if (Array.isArray(type)) {
    const names = type.filter((t): t is string => typeof t === "string");
    if (names.length < 2) return undefined;
    return names.map((name) => (name === "null" ? { type: "null" } : { ...schema, type: name }));
  }
  return undefined;
}

/**
 * The schema to draw for a node: its only shape, or a one-branch union unwrapped.
 *
 * A `type: ["string"]` or an `anyOf` with one member is not a choice, and drawing a picker with one
 * chip in it would be asking a question with one answer.
 */
export function singleShapeOf(schema: Schema, root?: Schema): Schema {
  const type = schema["type"];
  if (Array.isArray(type) && type.length === 1 && typeof type[0] === "string") return { ...schema, type: type[0] };
  for (const key of UNION_KEYS) {
    const raw = schema[key];
    if (Array.isArray(raw) && raw.length === 1 && isRecord(raw[0])) {
      const siblings = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== key));
      return { ...siblings, ...deref(raw[0], root) };
    }
  }
  return schema;
}

/** The word for a JSON type, as a person reads it. */
export function typeWord(type: unknown): string {
  switch (type) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "yes / no";
    case "object":
      return "object";
    case "array":
      return "list";
    case "null":
      return "none";
    default:
      return "any";
  }
}

/** What a branch's chip says: its `title`, its constant, or its type in words. */
function branchLabel(branch: Schema): string {
  if (typeof branch["title"] === "string" && branch["title"].length > 0) return branch["title"];
  if (branch["const"] !== undefined) return JSON.stringify(branch["const"]);
  if (branch["type"] === undefined) {
    if (Array.isArray(branch["enum"])) return "choice";
    if (isObjectSchema(branch)) return "object";
    if (isArraySchema(branch)) return "list";
  }
  return typeWord(branch["type"]);
}

/** Every branch's chip label, numbered where two would otherwise read the same. */
export function branchLabels(branches: readonly Schema[]): string[] {
  const labels = branches.map(branchLabel);
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const total = labels.filter((l) => l === label).length;
    if (total === 1) return label;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return `${label} ${n}`;
  });
}

/** The JSON type a value has, in JSON Schema's words. */
export function jsonTypeOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** True when a value is of the kind a branch describes — by type, and by `enum`/`const` where given. */
function fits(branch: Schema, value: unknown): boolean {
  const actual = jsonTypeOf(value);
  if (branch["const"] !== undefined) return JSON.stringify(branch["const"]) === JSON.stringify(value);
  if (Array.isArray(branch["enum"])) return (branch["enum"] as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value));
  const type = branch["type"];
  if (type === undefined) {
    if (isObjectSchema(branch)) return actual === "object";
    if (isArraySchema(branch)) return actual === "array";
    return true;
  }
  if (type === "number") return actual === "number" || actual === "integer";
  return type === actual;
}

/**
 * True when a branch can go on holding a value — for a shape someone PICKED, which should survive a
 * value that has not caught up with it yet.
 *
 * Raw text counts for a number branch: that is what a number box holds while it is being typed in.
 */
export function fitsBranch(branch: Schema, value: unknown): boolean {
  if (fits(branch, value)) return true;
  return typeof value === "string" && (branch["type"] === "number" || branch["type"] === "integer");
}

/**
 * True when a value of this schema is more than one line — an object, a list, or a choice of shapes
 * that includes one. Such a list row opens and closes; a row of plain text is already its own summary.
 */
export function isComposite(schema: Schema, root?: Schema): boolean {
  const node = singleShapeOf(deref(schema, root), root);
  const branches = branchesOf(node, root);
  if (branches !== undefined) return branches.some((b) => isComposite(b, root));
  return isObjectSchema(node) || isArraySchema(node);
}

/**
 * Which branch a value is already in.
 *
 * By kind first — a string is not the object branch — and, between two object branches, by which
 * one's `required` members the value actually has. A value that fits none (a number box mid-edit
 * holds its raw text) stays with the first branch of the kind its schema would have produced, and an
 * absent value takes the first non-null branch: the spelling the schema puts first is the one it
 * recommends.
 */
export function branchIndexFor(branches: readonly Schema[], value: unknown, root?: Schema): number {
  if (value === undefined) {
    const first = branches.findIndex((b) => b["type"] !== "null");
    return first < 0 ? 0 : first;
  }
  const candidates = branches.map((b, i) => [b, i] as const).filter(([b]) => fits(b, value));
  if (candidates.length === 0) {
    // Raw text in a number box: the number branch, not the text branch the string would "fit".
    if (typeof value === "string") {
      const numeric = branches.findIndex((b) => b["type"] === "number" || b["type"] === "integer");
      if (numeric >= 0) return numeric;
    }
    return 0;
  }
  if (candidates.length === 1 || !isRecord(value)) return candidates[0]![1];
  const scored = candidates.map(([b, i]) => {
    const { required, properties } = flatten(b, undefined, root);
    const has = [...required].filter((key) => value[key] !== undefined).length;
    const missing = required.size - has;
    const known = Object.keys(value).filter((key) => properties[key] !== undefined).length;
    return { i, missing, known };
  });
  scored.sort((a, b) => a.missing - b.missing || b.known - a.known);
  return scored[0]!.i;
}

// --- values ------------------------------------------------------------------------

/**
 * What a value starts as the moment someone asks for one — a switch turned on, a row added, a shape
 * chosen.
 *
 * The declared `default` when there is one, because turning a field on to overrule its default should
 * start from what would have been sent. Otherwise: empty of content and right in shape. An object gets
 * its REQUIRED members seeded (they have no switch, so they must exist), and its optional ones stay
 * not set. A number starts as `""`: the box is empty, and an empty box in a number field is not a
 * number, which is what the validator will say until one is typed.
 */
export function seedFor(schema: Schema, root?: Schema, depth = 0): unknown {
  const node = singleShapeOf(deref(schema, root), root);
  if (node["default"] !== undefined) return structuredClone(node["default"]);
  if (node["const"] !== undefined) return structuredClone(node["const"]);
  const branches = branchesOf(node, root);
  if (branches !== undefined) return seedFor(branches[branchIndexFor(branches, undefined, root)]!, root, depth + 1);
  if (Array.isArray(node["enum"])) return "";
  if (isArraySchema(node)) return [];
  if (isObjectSchema(node)) {
    if (depth > 8) return {};
    const { properties, required } = flatten(node, undefined, root);
    const out: Record<string, unknown> = {};
    for (const key of required) {
      const sub = properties[key];
      if (sub !== undefined) out[key] = seedFor(sub, root, depth + 1);
    }
    return out;
  }
  switch (node["type"]) {
    case "boolean":
      return false;
    case "null":
      return null;
    case "number":
    case "integer":
    case "string":
    default:
      return "";
  }
}

/** The one control a leaf value is typed into. `null` for a leaf that holds nothing to type. */
export type LeafControl = "choice" | "multiline" | "number" | "integer" | "boolean" | "text" | "json" | "none";

/**
 * Which control a schema that is neither an object nor a list gets.
 *
 * `json` is the one worth explaining: a node with no `type` at all takes any value, and there is no
 * control for "any" except a box that reads what you type leniently — `significant` is the string,
 * `3` is the number.
 */
export function leafControlOf(schema: Schema): LeafControl {
  if (Array.isArray(schema["enum"]) || Array.isArray(schema["examples"])) {
    if (schema["type"] === undefined || schema["type"] === "string") return "choice";
  }
  switch (schema["type"]) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "null":
      return "none";
    case "string": {
      const media = schema["contentMediaType"];
      return typeof media === "string" && schema["contentEncoding"] === undefined ? "multiline" : "text";
    }
    default:
      return schema["const"] !== undefined ? "none" : "json";
  }
}

/**
 * The values a choice box offers, and whether it insists on them.
 *
 * `enum` insists. `examples` — JSON Schema's own word for "common answers" — suggests, and any text
 * is accepted, which is what a `fill_form` enum with `custom: true` becomes.
 */
export function suggestionsOf(schema: Schema): { values: string[]; strict: boolean } {
  const strict = Array.isArray(schema["enum"]);
  const raw = (strict ? schema["enum"] : schema["examples"]) as unknown[] | undefined;
  return { values: (raw ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v))), strict };
}

/**
 * What a box's text becomes in a number field.
 *
 * A number when it reads as one; otherwise the TEXT itself. Holding the text rather than dropping it
 * is the point: `1.5x` is not a value to discard silently or to round, and handed to the validator as
 * a string it comes back as "not a number" under the box that holds it.
 */
export function numberFromText(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : text;
}

// --- what a field says about itself ---------------------------------------------------

/**
 * The short line after a field's name: what the schema allows, before anything is typed.
 *
 * `text · one of 4`, `number · 0 to 1`, `list · at least 1`, `keys → text`. Plain unconstrained text
 * says nothing — its box already does — and an object says nothing because its fields are right there.
 */
export function typeHintOf(schema: Schema, root?: Schema): string {
  const node = singleShapeOf(deref(schema, root), root);
  const parts: string[] = [];
  const media = node["contentMediaType"];
  // `text/plain` is how a form asks for a box with room in it; it says nothing a reader needs.
  if (typeof media === "string") {
    if (media !== "text/plain") parts.push(media);
  }
  else if (typeof node["x-type"] === "string") parts.push(node["x-type"]);
  else if (Array.isArray(node["enum"])) {
    const values = node["enum"] as unknown[];
    parts.push(values.length <= 3 ? values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" / ") : `one of ${values.length}`);
  } else if (Array.isArray(node["examples"])) parts.push("suggestions · any text");
  else if (isArraySchema(node)) parts.push("list");
  else if (isObjectSchema(node)) {
    const every = mapSchema(node, root);
    if (every !== undefined && node["properties"] === undefined) parts.push(`keys → ${typeWord(singleShapeOf(every, root)["type"])}`);
  } else if (node["type"] !== undefined && node["type"] !== "string") parts.push(typeWord(node["type"]));

  const lo = node["minimum"];
  const hi = node["maximum"];
  if (typeof lo === "number" && typeof hi === "number") parts.push(`${lo} to ${hi}`);
  else if (typeof lo === "number") parts.push(`at least ${lo}`);
  else if (typeof hi === "number") parts.push(`at most ${hi}`);
  if (typeof node["exclusiveMinimum"] === "number") parts.push(`above ${node["exclusiveMinimum"]}`);
  if (typeof node["exclusiveMaximum"] === "number") parts.push(`below ${node["exclusiveMaximum"]}`);
  if (typeof node["multipleOf"] === "number") parts.push(`in steps of ${node["multipleOf"]}`);

  const minLength = node["minLength"];
  const maxLength = node["maxLength"];
  if (typeof minLength === "number" && minLength > 0) parts.push(`at least ${minLength} character${minLength === 1 ? "" : "s"}`);
  if (typeof maxLength === "number") parts.push(`at most ${maxLength} characters`);
  if (typeof node["pattern"] === "string") parts.push(node["pattern"]);
  if (typeof node["format"] === "string") parts.push(node["format"]);

  const minItems = node["minItems"];
  const maxItems = node["maxItems"];
  if (typeof minItems === "number" && minItems > 0) parts.push(`at least ${minItems}`);
  if (typeof maxItems === "number") parts.push(`at most ${maxItems}`);
  return parts.join(" · ");
}

/** A value as one short line of text — a default, a summary cell. */
export function shortText(value: unknown, max = 60): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What a closed list row reads as: its first two things worth reading.
 *
 * The first scalar members in declaration order — for an acceptance criterion that is its id and its
 * statement, which is what you would look for in a list of them. A row with nothing scalar in it says
 * how much it holds instead, rather than nothing.
 */
export function summaryOf(schema: Schema, value: unknown, root?: Schema): string {
  if (value === undefined) return "not set";
  if (value === null) return "none";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (!isRecord(value)) return value === "" ? "empty" : shortText(value);
  const node = singleShapeOf(deref(schema, root), root);
  const branches = branchesOf(node, root);
  const shape = branches === undefined ? node : branches[branchIndexFor(branches, value, root)]!;
  const { properties } = flatten(shape, undefined, root);
  const order = [...Object.keys(properties), ...Object.keys(value).filter((key) => properties[key] === undefined)];
  const picked = order
    .map((key) => value[key])
    .filter((v): v is string | number | boolean => (typeof v === "string" && v.length > 0) || typeof v === "number" || typeof v === "boolean")
    .slice(0, 2)
    .map((v) => shortText(v, 48));
  if (picked.length > 0) return picked.join(" · ");
  const count = Object.keys(value).length;
  return `${count} field${count === 1 ? "" : "s"}`;
}

// --- errors --------------------------------------------------------------------------

/** One complaint from the validator, as the main process hands it over (ajv's `ErrorObject`). */
export interface CheckError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

/** A complaint placed on the form: the field it belongs under, and what to say there. */
export interface FieldError {
  path: string;
  message: string;
}

/**
 * A JSON pointer as a form path, read against the VALUE.
 *
 * The value is what disambiguates `/env/1`: under a list that is item 1, under an object it is the
 * key `"1"`, and only the value knows which it is.
 */
export function pathOfPointer(pointer: string, value: unknown, base = ""): string {
  if (pointer.length === 0) return base;
  let path = base;
  let at: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) {
      const index = Number(key);
      path = itemPath(path, index);
      at = at[index];
    } else {
      path = childPath(path, key);
      at = isRecord(at) ? at[key] : undefined;
    }
  }
  return path;
}

/** The value at a pointer, for a message that quotes what was typed. */
function valueAtPointer(pointer: string, value: unknown): unknown {
  if (pointer.length === 0) return value;
  let at: unknown = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) at = at[Number(key)];
    else if (isRecord(at)) at = at[key];
    else return undefined;
  }
  return at;
}

const plural = (n: unknown, one: string, many: string): string => (n === 1 ? one : many);

/**
 * One complaint, in words.
 *
 * The validator's own messages are accurate and written for a log: `must NOT have fewer than 1
 * characters` is its template for every `minLength`, so a limit of one — which means "can't be empty"
 * — reads like a limit of forty. The common keywords are said the way a person would say them; any
 * keyword not listed here keeps the validator's text, which is still true.
 */
export function messageOf(error: CheckError, atValue: unknown): string {
  const p = error.params;
  switch (error.keyword) {
    case "required":
      return "required";
    case "minLength":
      return p["limit"] === 1 ? "can't be empty" : `must be at least ${p["limit"]} characters`;
    case "maxLength":
      return `must be at most ${p["limit"]} ${plural(p["limit"], "character", "characters")}`;
    case "minimum":
      return `must be at least ${p["limit"]}`;
    case "maximum":
      return `must be at most ${p["limit"]}`;
    case "exclusiveMinimum":
      return `must be more than ${p["limit"]}`;
    case "exclusiveMaximum":
      return `must be less than ${p["limit"]}`;
    case "multipleOf":
      return `must be a multiple of ${p["multipleOf"]}`;
    case "type": {
      const wanted = String(p["type"] ?? "");
      if ((wanted.includes("number") || wanted.includes("integer")) && typeof atValue === "string") {
        return atValue.trim().length === 0 ? "enter a number" : `'${atValue}' is not a number`;
      }
      if (wanted === "integer" && typeof atValue === "number") return "must be a whole number";
      const words = wanted.split(",").map((t) => typeWord(t.trim()));
      return `must be ${words.join(" or ")}`;
    }
    case "enum": {
      const allowed = ((p["allowedValues"] as unknown[] | undefined) ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
      return allowed.length <= 8 ? `must be one of: ${allowed.join(", ")}` : "must be one of the listed values";
    }
    case "const":
      return `must be ${JSON.stringify(p["allowedValue"])}`;
    case "pattern":
      return `must match ${p["pattern"]}`;
    case "format":
      return `must be a valid ${p["format"]}`;
    case "minItems":
      return p["limit"] === 1 ? "needs at least one item" : `needs at least ${p["limit"]} items`;
    case "maxItems":
      return `can have at most ${p["limit"]} ${plural(p["limit"], "item", "items")}`;
    case "uniqueItems":
      return `items ${p["j"]} and ${p["i"]} are the same`;
    case "minProperties":
      return `needs at least ${p["limit"]} ${plural(p["limit"], "key", "keys")}`;
    case "maxProperties":
      return `can have at most ${p["limit"]} ${plural(p["limit"], "key", "keys")}`;
    case "additionalProperties":
      return "isn't allowed here";
    case "anyOf":
    case "oneOf":
      return p["passingSchemas"] !== undefined && p["passingSchemas"] !== null ? "matches more than one shape" : "doesn't match the chosen shape";
    default:
      return error.message ?? `fails ${error.keyword}`;
  }
}

/** True when a schema path runs through a branch of a union. */
const inBranch = (schemaPath: string): boolean => /\/(anyOf|oneOf)\/\d+(\/|$)/.test(schemaPath);

/**
 * The validator's complaints, placed on the form.
 *
 * Three translations happen here, and none of them changes the verdict — that is the validator's:
 *
 *  - A missing member is reported by the validator on its PARENT (`must have required property
 *    'id'`). It belongs under the member's own box, which is where a person looks for it.
 *  - An extra member is likewise moved onto the member.
 *  - A union makes the validator try EVERY branch and report why each one failed. The form has
 *    already chosen a shape, so "must be null" under a text box is noise from a branch nobody picked.
 *    A branch's type/enum/const mismatch AT the union's own position is dropped, and so is the
 *    union's summary complaint when a more specific one survives beneath it.
 */
export function fieldErrorsOf(errors: readonly CheckError[], value: unknown, base = ""): FieldError[] {
  const unions = new Set(errors.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf").map((e) => e.instancePath));
  const kept = errors.filter((e) => {
    if (e.keyword === "if") return false;
    if (unions.has(e.instancePath) && inBranch(e.schemaPath) && (e.keyword === "type" || e.keyword === "enum" || e.keyword === "const")) return false;
    return true;
  });
  const out: FieldError[] = [];
  for (const error of kept) {
    if ((error.keyword === "anyOf" || error.keyword === "oneOf") && error.params["passingSchemas"] === undefined) {
      const specific = kept.some((e) => e !== error && e.keyword !== "anyOf" && e.keyword !== "oneOf" && (e.instancePath === error.instancePath || e.instancePath.startsWith(`${error.instancePath}/`)));
      if (specific) continue;
    }
    let pointer = error.instancePath;
    if (error.keyword === "required" && typeof error.params["missingProperty"] === "string") {
      pointer = `${pointer}/${error.params["missingProperty"].replace(/~/g, "~0").replace(/\//g, "~1")}`;
    } else if (error.keyword === "additionalProperties" && typeof error.params["additionalProperty"] === "string") {
      pointer = `${pointer}/${error.params["additionalProperty"].replace(/~/g, "~0").replace(/\//g, "~1")}`;
    }
    const path = pathOfPointer(pointer, value, base);
    const message = messageOf(error, valueAtPointer(error.instancePath, value));
    if (!out.some((e) => e.path === path && e.message === message)) out.push({ path, message });
  }
  return out;
}

/** The verdict on a form's values, as the host that asked for it holds it. */
export interface FormCheck {
  /** A check for the values now on screen has not answered yet. */
  pending: boolean;
  /** Some check has answered — the errors are a verdict, if possibly one a keystroke old. */
  answered: boolean;
  /** Every complaint, placed. Empty and not pending is the only state in which the form may be sent. */
  errors: FieldError[];
}

/** A check that has answered, with these complaints — what a caller with nothing to wait on holds. */
export function settledCheck(errors: FieldError[] = []): FormCheck {
  return { pending: false, answered: true, errors };
}

/**
 * What the button beside a form says about why it is off — the first complaint, with its path.
 *
 * `""` is "off, with nothing to say": a form that was fine a keystroke ago and is being re-checked.
 * Saying "checking…" there would flash on every pause in typing; enabling the button would let a value
 * nobody has checked be sent.
 */
export function checkBlocker(check: FormCheck): string | null {
  const [first] = check.errors;
  if (first !== undefined) {
    const where = first.path.length > 0 ? `${first.path}: ` : "";
    const more = check.errors.length > 1 ? `${check.errors.length} problems — ` : "";
    return `${more}${where}${first.message}`;
  }
  if (!check.pending) return null;
  return check.answered ? "" : "checking…";
}

/** True when `path` is `under` or lies beneath it — for "a row with an error in it stays open". */
export function isWithin(path: string, under: string): boolean {
  if (under.length === 0) return true;
  return path === under || path.startsWith(`${under}.`) || path.startsWith(`${under}[`);
}
