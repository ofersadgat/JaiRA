/**
 * The schema registry: documents a hand-edited JSON file can be held to.
 *
 * The JSON editor has a picker, and this is what fills it. Choosing an entry buys four things — the
 * document is validated as you type, a skeleton can be inserted into an empty one, legal keys are
 * suggested at the cursor, and the field reference sits beside the text. All four read the SAME
 * schema document, which is the only reason offering all four is cheap.
 *
 * ## Permissive on shape, precise on vocabulary
 *
 * These schemas are deliberately not a second implementation of the loader. Two facts about the
 * format make an aggressive schema actively harmful here:
 *
 *  - **Almost nothing is required in the file.** WORKFLOWS.md §4: "Every field is optional *in the
 *    file*; what the file leaves out, the `environment` chain may supply. What matters is the shape
 *    *after* merging." A schema that marked `prompt` required would report an error on a state that
 *    correctly inherits its prompt from an ancestor. So `required` is empty, and what is required
 *    after merging is carried separately in {@link SchemaEntry.expected} — read by the skeleton and
 *    the reference panel, which are advice, and never by the validator, which is a verdict.
 *  - **Any value may be a reference.** §2.2: a block can be transcluded, so `"prompt"` may hold a
 *    string OR `{"$ref": "$/prompts/x.md"}` OR `{"$expr": …}`. Every leaf therefore accepts its own
 *    type or a binding form. Without that, the single most idiomatic thing in the format reads as an
 *    error.
 *
 * What the schemas DO catch is the error people actually make by hand: a misspelled key, and a
 * scalar of the wrong type. `additionalProperties` is where the two shapes genuinely differ, and the
 * difference is authored, not incidental — see {@link STATE_SCHEMA} and {@link OPERATION_SCHEMA}.
 */
import {
  CONVERSATION_MODES,
  PERMISSION_MODES,
  PERMISSION_PROFILES,
  JSON_FIELDS,
  SIMPLE_FIELDS,
  fieldAppliesTo,
  type JsonField,
  type SimpleField,
} from "./operationVocabulary";
import { DEFAULT_MEDIA_TYPE, TYPE_NAMES } from "./slotTypes";

/** A schema document, as far as this module builds one. Structural — no JSON Schema types imported. */
export type SchemaDoc = Record<string, unknown>;

/**
 * One entry in the picker.
 *
 * `expected` is the honest split described above: the keys a finished document needs, which is NOT
 * the same question as what makes this file invalid on its own.
 */
export interface SchemaEntry {
  /** Stable id, stored in the editor's per-file choice. */
  id: string;
  label: string;
  /** One line under the picker: what this schema is for. */
  hint: string;
  document: SchemaDoc;
  /**
   * Keys a complete document is expected to carry — required AFTER the environment merge, not in
   * the file. The skeleton writes these; the reference panel marks them; the validator ignores them.
   */
  expected: readonly string[];
  /**
   * `false` ⇒ registered but NOT offered in the picker, and never auto-detected for a file.
   *
   * The registry answers two questions with one map: "what may I hold this FILE to" (the picker) and
   * "check this text against schema X" (`schema:validate`, which resolves by id). A component
   * config is the second without being the first — it is a fragment of a state file, never a file —
   * and putting it in the picker would offer nine choices that are wrong for every `.json` on disk.
   */
  pickable?: boolean;
}

// --- the binding forms every leaf admits ------------------------------------

/**
 * The three ways a value can arrive instead of being written literally (WORKFLOWS.md §2.2, §8).
 *
 * Listed once and spread into every leaf. `$ref` is a path reference, `$expr` an expression, `json`
 * an explicit literal wrapper — and a leaf that refused them would flag the format's own examples.
 */
const BINDING_FORMS: SchemaDoc[] = [
  { type: "object", properties: { $ref: { type: "string" } }, required: ["$ref"] },
  { type: "object", properties: { $expr: { type: "string" } }, required: ["$expr"] },
  { type: "object", properties: { json: {} }, required: ["json"] },
];

/** A leaf that accepts its own type, or any binding form. */
function leaf(own: SchemaDoc): SchemaDoc {
  return { anyOf: [own, ...BINDING_FORMS] };
}

/**
 * The keyword carrying "required after merging".
 *
 * `x-` prefixed because it is not JSON Schema's — ajv is told `strict: false` precisely so extras
 * like this pass through unremarked. It must NOT be `required`: that is the keyword the validator
 * acts on, and acting on it here would report an error against a file that correctly inherits the
 * field from an ancestor's `environment`.
 */
const EXPECTED_KEYWORD = "x-expected";

function markExpected(properties: Record<string, SchemaDoc>, key: string): void {
  const property = properties[key];
  if (property !== undefined) property[EXPECTED_KEYWORD] = true;
}

/** The schema for one vocabulary field's own type. */
function ownTypeOf(field: SimpleField): SchemaDoc {
  if (field.type === "number") return { type: "number" };
  if (field.type === "list") return { type: "array", items: { type: "string" } };
  return { type: "string" };
}

/** `description` for a generated property — the reference panel and a schema-aware editor both read it. */
function describe(field: SimpleField | JsonField): string {
  const hint = "hint" in field ? field.hint : undefined;
  return hint === undefined ? field.label : `${field.label} — ${hint}`;
}

// --- the schema a slot declares ----------------------------------------------

/** Where the self-reference points. One string, so the definition and its users cannot drift. */
const JSON_SCHEMA_REF = "#/definitions/jsonSchema";

/**
 * A slot's `schema` — a JSON Schema document, described well enough to complete inside.
 *
 * This is a *subset*, chosen by what this project actually honours rather than by what the JSON
 * Schema spec permits, and the difference matters in one place especially:
 *
 * **`format` is deliberately absent.** `slotTypes.ts` says it outright: synonyms are `x-type`, never
 * `format`, because the subtype checker treats `x-type` as CONSTRAINING while it ignores `format` as
 * annotation-only — and JaiRA's ajv is built without `ajv-formats`, so a `format` keyword here is
 * checked by precisely nothing. Offering it would be inviting authors to write a constraint that
 * silently does not exist. `x-type` is offered in its place, with the names the vocabulary uses.
 *
 * `contentMediaType` gets a pointed description for the same reason: WORKFLOWS.md §3 calls it out as
 * THE derivation worth knowing, because it is what makes a slot a blob.
 *
 * Self-referential through `$ref`, so `items` and `properties` nest without bound. Both ajv and
 * {@link propertiesOf} resolve it — the latter needs the document root, which is why the definition
 * is attached to whole entries by {@link withDefinitions} rather than inlined at each use.
 */
function jsonSchemaSchema(): SchemaDoc {
  const self: SchemaDoc = { $ref: JSON_SCHEMA_REF };
  return {
    type: "object",
    properties: {
      type: {
        anyOf: [
          { type: "string", enum: ["string", "number", "integer", "boolean", "object", "array", "null"] },
          { type: "array", items: { type: "string" } },
        ],
        description: "the JSON type; a slot's kind is derived from this",
      },
      "x-type": {
        type: "string",
        examples: [TYPE_NAMES.url, TYPE_NAMES.file, TYPE_NAMES.datetime],
        description: `a nominal synonym (${TYPE_NAMES.url}, ${TYPE_NAMES.file}, ${TYPE_NAMES.datetime}, …) — the one x- keyword the subtype checker enforces`,
      },
      contentMediaType: {
        type: "string",
        description: `the media type — THIS is what makes a slot a blob (§3), e.g. ${DEFAULT_MEDIA_TYPE}`,
      },
      contentEncoding: { type: "string", description: "how the content is encoded, e.g. base64" },
      items: { ...self, description: "the schema every element of an array matches" },
      properties: {
        type: "object",
        additionalProperties: self,
        description: "an object's declared properties, each a schema of its own",
      },
      required: { type: "array", items: { type: "string" }, description: "which properties must be present" },
      additionalProperties: {
        anyOf: [{ type: "boolean" }, self],
        description: "false to close the object, or a schema every extra property must match",
      },
      enum: { type: "array", description: "the closed set of values allowed" },
      const: { description: "the single value allowed" },
      default: { description: "the value assumed when none is supplied" },
      title: { type: "string", description: "a short name for this value" },
      description: { type: "string", description: "author's note, carried into prompts and tool schemas" },
      minimum: { type: "number" },
      maximum: { type: "number" },
      minLength: { type: "number" },
      maxLength: { type: "number" },
      pattern: { type: "string", description: "a regular expression the string must match" },
      minItems: { type: "number" },
      maxItems: { type: "number" },
      // Kept open: a schema may carry keywords this subset does not name, and refusing them would
      // flag a document ajv itself accepts.
    },
  };
}

/**
 * Attach the shared definitions to a document that is registered as an entry.
 *
 * Only entry ROOTS get them: `$ref: "#/…"` resolves against the document being validated, so an
 * `operation` block nested inside a state resolves through the state's copy. Adding a second set on
 * the nested block would be dead weight that has to be kept in step with the first.
 */
function withDefinitions(document: SchemaDoc): SchemaDoc {
  return { ...document, definitions: { jsonSchema: jsonSchemaSchema() } };
}

// --- the blocks a state nests ------------------------------------------------

/**
 * One slot, in `inputs` or `outputs` (WORKFLOWS.md §3).
 *
 * The names in these maps are the AUTHOR's — `issue`, `plan_doc` — so the map itself has nothing to
 * suggest. What it has is `additionalProperties`: every value, whatever its key, is one of these.
 * That is what gives the editor something to offer once the cursor is inside a slot, and it is the
 * whole reason the schemas needed depth rather than a bare `{ type: "object" }`.
 */
function slotSchema(): SchemaDoc {
  return {
    type: "object",
    properties: {
      schema: {
        ...leaf({ $ref: JSON_SCHEMA_REF }),
        description: "JSON Schema for the value; absent ⇒ unconstrained, and nothing about it can be type-checked",
      },
      kind: leaf({
        type: "string",
        enum: ["text", "json", "blob", "prompt", "function"],
        description: "the leaf kind — usually derived from `schema` rather than written",
      }),
      binding: leaf({
        anyOf: [{ type: "string" }, { type: "object" }],
        description: "where the value comes from (§8). Required for a derived output, absent for a produced one",
      }),
      default: { description: "used when nothing is wired in; also the opt-out from the reachability rule" },
      optional: leaf({ type: "boolean", description: "slots are REQUIRED by default" }),
      description: leaf({ type: "string", description: "author's note" }),
      name: leaf({ type: "string", description: "outputs only: the external name, when it differs from the key" }),
    },
  };
}

/** A slot map — arbitrary names, each naming a slot. */
function slotMapSchema(what: string): SchemaDoc {
  return { type: "object", description: what, additionalProperties: leaf(slotSchema()) };
}

/**
 * One declared child (§6).
 *
 * `inputs` here is NOT a slot map: a child's inputs are wired with BARE bindings (`".inputs.issue"`),
 * with no `binding:` wrapper, so modelling it as slots would flag every correct wiring in the format.
 */
function childSchema(): SchemaDoc {
  return {
    type: "object",
    properties: {
      state: leaf({ type: "string", description: "the child's state reference; absent ⇒ ./<key>" }),
      inputs: leaf({ type: "object", description: "wiring into the child's declared inputs, as bare bindings (§8)" }),
      async: leaf({ type: "boolean", description: "true ⇒ the cursor does not wait for this child" }),
      environment: {
        ...leaf(operationSchema()),
        description: "defaults for THIS mount of the child and its subtree (§6.1)",
      },
      /**
       * The DEFAULT home for a transition, and the reason it is worth the duplicate entry beside the
       * state-level `transitions`: a rule on the mount is eligible only in the round that child's
       * completion triggered. Written at state level the same rule has to name the child in its
       * guard, hold its position against every other rule, and be re-evaluated after every unrelated
       * completion — which is how a guard reading a child's outputs re-fires forever once that child
       * has run.
       */
      transitions: leaf({
        type: "array",
        items: leaf(transitionSchema()),
        description: "considered when THIS child finishes, ahead of the state's own list (§7); an unconditional `to` means 'after this child, go here'",
      }),
    },
  };
}

/** One transition (§7). `to` is the only field the format calls required outright. */
function transitionSchema(): SchemaDoc {
  const properties: Record<string, SchemaDoc> = {
    to: leaf({
      type: "string",
      description: "a declared child key, or terminate.success / .error / .canceled / .timeout",
    }),
    when: leaf({ type: "string", description: "guard expression; absent ⇒ unconditional. Must infer to boolean" }),
  };
  markExpected(properties, "to");
  return { type: "object", properties };
}

// --- the operation block ----------------------------------------------------

/**
 * The shared parts of an operation, whatever its kind.
 *
 * `input`, `output`, `session`, `conversation` and `permissions` are modelled loosely on purpose:
 * each has real structure (§4.3, §4.4, §5.1), and each is also routinely written as a reference or
 * a shorthand string. Constraining them would buy little and cost false errors on valid files.
 */
function commonOperationProperties(): Record<string, SchemaDoc> {
  return {
    /**
     * §4.3, and the one place this schema is deliberately strict.
     *
     * `operation.input` is a PARAMETER map, not a binding map: each value is a parameter declaration
     * whose wiring goes under `binding`. WORKFLOWS.md calls writing a bare binding here "the single
     * most common silent failure" — the loader sees a parameter with no binding, the slot resolves
     * empty, the agent runs with no instruction, and the state reports SUCCESS. Nothing warns you.
     *
     * Modelling the values as slots is what makes the editor complete inside one, and it also makes
     * the bare-string form fail the schema — which is the only warning that failure has ever had.
     */
    input: leaf({
      type: "object",
      description: "parameter map (§4.3) — each value is a parameter; its wiring goes under `binding`",
      additionalProperties: leaf(slotSchema()),
    }),
    output: { ...leaf(slotSchema()), description: "output slot (§4.4); absent ⇒ built from the state's produced outputs" },
    session: leaf({
      anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" }, $expr: { type: "string" } } }],
      description: 'logical session this call joins; absent ⇒ "default", null ⇒ a fresh one',
    }),
    conversation: leaf({
      anyOf: [
        { type: "string", enum: [...CONVERSATION_MODES] },
        {
          type: "object",
          properties: {
            mode: { type: "string", enum: [...CONVERSATION_MODES], description: "how much transcript to carry" },
            artifacts: {
              type: "array",
              items: { type: "string" },
              description: "selected_artifacts only: which artifacts to inject",
            },
          },
        },
      ],
      description: "how much transcript this call carries (§5.1)",
    }),
    permissions: leaf({
      type: "object",
      properties: {
        profile: { type: "string", description: `a named profile — ${PERMISSION_PROFILES.join(", ")}, or a custom one` },
        default: {
          type: "string",
          enum: [...PERMISSION_MODES],
          description: "the mode for tools the map below does not name",
        },
        tools: {
          type: "object",
          description: "per-tool modes, keyed by tool name",
          additionalProperties: { type: "string", enum: [...PERMISSION_MODES] },
        },
      },
      description: "authored permission baseline (§5.1)",
    }),
    reasoning: leaf({
      type: "object",
      properties: {
        effort: { type: "string", description: "how hard the model should think" },
        budgetTokens: { type: "number", description: "a token budget for reasoning" },
      },
    }),
    fork: leaf({ type: "boolean", description: "start a new branch of the conversation rather than appending" }),
    limits: leaf({ type: "object", properties: { max_iterations: { type: "number" }, timeout: { type: "number" } } }),
  };
}

/**
 * An `operation` block, built from the field vocabulary.
 *
 * `additionalProperties` is TRUE here, and that is not laziness. hw passes any field it does not own
 * straight into the call config — "the operation IS the call" — so a knob invented after this table
 * was written still reaches the model. Flagging it would tell an author their working file is wrong.
 */
export function operationSchema(kind?: "prompt" | "function"): SchemaDoc {
  const properties: Record<string, SchemaDoc> = commonOperationProperties();

  for (const field of SIMPLE_FIELDS) {
    if (kind !== undefined && !fieldAppliesTo(field, kind)) continue;
    properties[field.key] = { ...leaf(ownTypeOf(field)), description: describe(field) };
  }
  for (const field of JSON_FIELDS) {
    if (kind !== undefined && !fieldAppliesTo(field, kind)) continue;
    properties[field.key] = { description: describe(field) };
  }

  properties["kind"] =
    kind === undefined
      ? { type: "string", enum: ["prompt", "function"], description: "which of the two operation shapes applies" }
      : { const: kind, description: `"${kind}" — this schema describes ${kind} operations` };

  // Required AFTER the environment merge (§4's table), marked on the property rather than only on the
  // entry. The entry's `expected` can only speak about the root; a state's `operation` block is a
  // level down, and its `prompt` is just as required there — so the mark travels with the property
  // and `propertiesOf` finds it at any depth.
  markExpected(properties, "kind");
  if (kind === "prompt") markExpected(properties, "prompt");
  if (kind === "function") markExpected(properties, "function");

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: kind === undefined ? "Operation" : `${kind[0]!.toUpperCase()}${kind.slice(1)} operation`,
    type: "object",
    properties,
    required: [],
    additionalProperties: true,
  };
}

// --- the state file ---------------------------------------------------------

/**
 * A state file (WORKFLOWS.md §2).
 *
 * `additionalProperties` is FALSE, unlike the operation, and for the reason §2 states outright:
 * "Nothing else is recognized." An unknown key at the top level of a state file is a typo or a
 * misremembered field, every time — which makes this the one place the schema earns its keep most.
 *
 * `operation` takes the kind-specific block when one is named, which is the whole difference between
 * the two state entries in the picker.
 */
export function stateSchema(kind?: "prompt" | "function"): SchemaDoc {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: kind === undefined ? "State" : `State (${kind} operation)`,
    type: "object",
    properties: {
      id: { type: "string", description: "the state's own path reference — derived from the file's location" },
      label: { type: "string", description: "display name on the board; falls back to the id" },
      description: { type: "string", description: "author's note; also useful prompt context" },
      inputs: leaf(slotMapSchema("declared input slots (§3)")),
      outputs: leaf(slotMapSchema("declared output slots (§3); a state with none produces nothing")),
      operation: {
        ...leaf(operationSchema(kind)),
        description: "the one thing this state does (§4); {} means \"what my environment chain describes\"",
      },
      environment: {
        ...leaf(operationSchema()),
        description: "defaults for this state's operation and every descendant's (§5)",
      },
      children: leaf({
        type: "object",
        description: "declared child states (§6); absent ⇒ inferred from the directory",
        additionalProperties: leaf(childSchema()),
      }),
      sequence: leaf({
        type: "array",
        items: { type: "string" },
        description: "order the cursor advances through children; absent ⇒ declaration order",
      }),
      transitions: leaf({
        type: "array",
        items: leaf(transitionSchema()),
        description: "control flow (§7), evaluated in order — first match wins",
      }),
      limits: leaf({
        type: "object",
        properties: { max_iterations: { type: "number" }, timeout: { type: "number" } },
        description: "max_iterations (guard value) and timeout (seconds)",
      }),
    },
    required: [],
    additionalProperties: false,
  };
}

// --- the registry -----------------------------------------------------------

const REGISTRY = new Map<string, SchemaEntry>();

/**
 * Add a schema to the picker.
 *
 * The same shape as the file-surface table, and for the same reason: adding one should be a line
 * rather than an edit to the component that renders the list. Last registration of an id wins.
 */
export function registerSchema(entry: SchemaEntry): void {
  REGISTRY.set(entry.id, entry);
}

/** Everything in the picker, in registration order — see {@link SchemaEntry.pickable}. */
export function listSchemas(): SchemaEntry[] {
  return [...REGISTRY.values()].filter((entry) => entry.pickable !== false);
}

export function schemaById(id: string): SchemaEntry | undefined {
  return REGISTRY.get(id);
}

registerSchema({
  id: "state",
  label: "Workflow state",
  hint: "a state file as it lives under workflows/ — WORKFLOWS.md §2",
  document: withDefinitions(stateSchema()),
  expected: [],
});

registerSchema({
  id: "state-prompt",
  label: "Workflow state (prompt)",
  hint: "a state whose operation is one structured LLM call",
  document: withDefinitions(stateSchema("prompt")),
  expected: ["operation"],
});

registerSchema({
  id: "prompt-operation",
  label: "Prompt operation",
  hint: "an operation block on its own — what a state $refs, or what you paste into one",
  document: withDefinitions(operationSchema("prompt")),
  // Required after merging (§4), not in the file: the skeleton writes both, the validator asks for
  // neither, and a state that inherits its prompt from an ancestor is correct with only `kind`.
  expected: ["kind", "prompt"],
});

// --- what the schema can do for an editor -----------------------------------

/** One violation, as the editor lists it. */
export interface SchemaViolation {
  /** JSON path into the document, e.g. `operation.temperature`. Empty for the root. */
  path: string;
  message: string;
}

/**
 * A starting document for an empty file.
 *
 * Built from `expected` plus the schema's own properties, with placeholder values chosen by type —
 * enough to be a valid frame rather than a guess at content. Deliberately shallow: a skeleton that
 * pre-filled `children` and `transitions` would be a wall of scaffolding for a state that has
 * neither, and deleting it is more work than writing the two keys you wanted.
 */
export function skeletonOf(entry: SchemaEntry): unknown {
  const properties = (entry.document["properties"] ?? {}) as Record<string, SchemaDoc>;
  const out: Record<string, unknown> = {};
  for (const key of entry.expected) {
    out[key] = placeholderFor(properties[key]);
  }
  if (entry.expected.length === 0) {
    // Nothing is required even after merging — so offer the fields an author almost always writes
    // rather than an empty object, which is what they already have.
    for (const key of ["label", "description"]) {
      if (properties[key] !== undefined) out[key] = "";
    }
  }
  return out;
}

/** A plausible empty value for one property's schema. */
function placeholderFor(schema: SchemaDoc | undefined): unknown {
  if (schema === undefined) return "";
  if (typeof schema["const"] === "string") return schema["const"];
  const enumerated = schema["enum"];
  if (Array.isArray(enumerated) && enumerated.length > 0) return enumerated[0];
  const own = firstOwnType(schema);
  if (own === "object") return {};
  if (own === "array") return [];
  if (own === "number") return 0;
  if (own === "boolean") return false;
  return "";
}

/** The declared type of a leaf, looking through the `anyOf` that admits binding forms. */
function firstOwnType(schema: SchemaDoc): string | undefined {
  if (typeof schema["type"] === "string") return schema["type"];
  const options = schema["anyOf"];
  if (Array.isArray(options) && options.length > 0) {
    const first = options[0] as SchemaDoc;
    if (typeof first["type"] === "string") return first["type"];
    return firstOwnType(first);
  }
  return undefined;
}

/** One row of the reference panel, and one suggestion at the cursor. */
export interface SchemaProperty {
  key: string;
  /** The declared type, as a word — `string`, `object`, `array`. Undefined when unconstrained. */
  type: string | undefined;
  description: string | undefined;
  /** True when a complete document is expected to carry it (see {@link SchemaEntry.expected}). */
  expected: boolean;
  /** The closed set of values, when there is one. */
  values: readonly string[] | undefined;
}

/**
 * The properties a schema declares, for the reference panel and for completion.
 *
 * `at` walks into a nested object — `["operation"]` gives the operation block's fields — which is
 * what lets the same function answer "what can I write here?" for a cursor anywhere in the document.
 */
export function propertiesOf(entry: SchemaEntry, at: readonly string[] = []): SchemaProperty[] {
  const root = entry.document;
  let schema: SchemaDoc | undefined = descend(root, root);
  for (const step of at) {
    if (schema === undefined) return [];
    const properties = (schema["properties"] ?? {}) as Record<string, SchemaDoc>;
    // A named property first; failing that, `additionalProperties` — which is how a map with
    // AUTHOR-CHOSEN keys answers "what goes inside `inputs.issue`?". Without this fallback every
    // such map is a dead end, and the slot, child and permission blocks are all such maps.
    const extra = schema["additionalProperties"];
    const next = properties[step] ?? (typeof extra === "object" && extra !== null ? (extra as SchemaDoc) : undefined);
    schema = descend(root, next);
  }
  const properties = (schema?.["properties"] ?? {}) as Record<string, SchemaDoc>;
  return Object.entries(properties).map(([key, value]) => {
    const enumerated = value["enum"] ?? (typeof value["const"] === "string" ? [value["const"]] : undefined);
    return {
      key,
      type: firstOwnType(value),
      description: typeof value["description"] === "string" ? value["description"] : undefined,
      // Two sources, because the question has two scopes: the entry knows what its ROOT document
      // needs, and the property knows what it is itself — which is the only one that can answer for
      // a field nested inside an `operation` block.
      expected: value[EXPECTED_KEYWORD] === true || (at.length === 0 && entry.expected.includes(key)),
      values: Array.isArray(enumerated) ? (enumerated as string[]) : undefined,
    };
  });
}

/**
 * Add what a document is missing, without touching what it has.
 *
 * The skeleton used to replace the document, which meant it was only safe on an empty one — and
 * "start me a valid frame" is most useful precisely when you are half-way through and cannot
 * remember what else belongs. Merging makes it non-destructive, so it can be offered always.
 *
 * Existing values always win, at every depth. A key the document already has is left exactly as it
 * is, including an empty string or a `{}` someone is about to fill in: the skeleton's job is to name
 * what is absent, and it has no opinion about what is present.
 */
export function mergeSkeleton(entry: SchemaEntry, current: unknown): unknown {
  return mergeMissing(skeletonOf(entry), current);
}

function mergeMissing(additions: unknown, current: unknown): unknown {
  if (!isPlainObject(additions)) return current;
  // A document that is not an object cannot be merged into — an array or a scalar at the root is not
  // this schema's shape at all, and overwriting it would be the destructive behaviour being removed.
  if (!isPlainObject(current)) return additions;

  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(additions)) {
    if (!(key in merged)) merged[key] = value;
    else if (isPlainObject(value) && isPlainObject(merged[key])) merged[key] = mergeMissing(value, merged[key]);
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Look through the binding-form `anyOf` to the schema the author is actually writing.
 *
 * The binding forms are recognised by a NON-EMPTY `required` — they are the only schemas here that
 * have one, since nothing in this format is required in the file. Testing for the key's presence
 * instead would skip the real schemas too, all of which carry `required: []`.
 */
function unwrap(schema: SchemaDoc | undefined): SchemaDoc | undefined {
  if (schema === undefined) return undefined;
  const options = schema["anyOf"];
  if (!Array.isArray(options)) return schema;

  const candidates = (options as SchemaDoc[])
    .filter((option) => {
      const required = option["required"];
      return !(Array.isArray(required) && required.length > 0);
    })
    // Recursive because these nest: `conversation` is a leaf whose own type is itself an `anyOf` of
    // a shorthand string and the full block.
    .map((option) => unwrap(option))
    .filter((option): option is SchemaDoc => option !== undefined);

  // Prefer the branch that has something to descend INTO. `conversation` may be written as a bare
  // mode string or as a block, and only one of those can answer "what goes inside it?" — returning
  // the first branch would make every such field a dead end.
  return (
    candidates.find(
      (option) =>
        option["properties"] !== undefined ||
        option["items"] !== undefined ||
        option["additionalProperties"] !== undefined,
    ) ?? candidates[0]
  );
}

/**
 * Peel a schema down to the object whose properties are being asked about.
 *
 * Three wrappers can sit in the way and they compose in any order, so this loops rather than
 * branching once: a binding-form `anyOf`, a `$ref` into the shared definitions, and an array whose
 * ITEMS are what a cursor "inside transitions" is actually in — the path carries no index (see
 * `cursorContext`), so the array itself is never the answer.
 *
 * Bounded, because a `$ref` cycle is a document bug rather than a reason to hang the renderer.
 */
function descend(root: SchemaDoc, schema: SchemaDoc | undefined): SchemaDoc | undefined {
  let current = schema;
  for (let step = 0; step < 12; step++) {
    if (current === undefined) return undefined;
    if (Array.isArray(current["anyOf"])) {
      current = unwrap(current);
      continue;
    }
    if (typeof current["$ref"] === "string") {
      current = pointerTo(root, current["$ref"]);
      continue;
    }
    if (current["items"] !== undefined) {
      current = current["items"] as SchemaDoc;
      continue;
    }
    return current;
  }
  return undefined;
}

/** Resolve a local JSON pointer (`#/definitions/jsonSchema`). Foreign refs are not resolvable here. */
function pointerTo(root: SchemaDoc, ref: string): SchemaDoc | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node === null || typeof node !== "object" ? undefined : (node as SchemaDoc);
}
