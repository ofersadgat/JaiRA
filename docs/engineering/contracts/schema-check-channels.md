---
id: engineering/contracts/schema-check-channels
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/schema-check]
consumers: ["@jaira/app renderer schemaForm/check.ts useSchemaCheck, through schema:check, for the Run form, New task, fill_form and Settings", "@jaira/app renderer store.ts validateSchema and detectSchema, for the JSON editor and the component gallery", "@jaira/app main index.ts handler table", "@jaira/app tests schemaCheck.test.ts and schemas.test.ts"]
siblings: [engineering/contracts/ipc-channels, engineering/contracts/preload-bridge, engineering/contracts/gate-components]
---

# Schema check channels

The IPC request channels that check form values against an author's schema with the run's validator configuration, check a JSON document against a registered schema, and detect which registered schema a document already satisfies.

## A caller reaches for these to learn what main's validator says, and never to accept a gate answer

**Use when.** A form needs the run's verdict on the values it holds: `schema:check`. The JSON editor needs a document's violations against the schema it is held to, or a first pick for its schema picker: `schema:validate` and `schema:detect`.

**Do not use when.** Checking a person's answer to a gate, which main does itself at submit through [component-contracts](../units/component-contracts.md). Listing the schemas or the fields one declares, which the renderer reads from the registry in [document-types](../units/document-types.md) directly. How a call is invoked and how its failure travels: [preload-bridge](preload-bridge.md).

## The shape is one request per channel, with no project, because schemas are the same in every project

### `schema:check` takes a batch of values and answers one result per item, in order

`SchemaCheckRequest`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `checks` | `SchemaCheckItem[]` | yes | one item per value; a slot's schema is its own document, so slots are never folded into one schema |

`SchemaCheckItem`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `key` | string | yes | the caller's name for the check, echoed on its result |
| `schema` | `JsonValue` | yes | a standalone JSON Schema; a local `$ref` resolves inside it |
| `value` | `JsonValue` | yes | the value to check |

`SchemaCheckResponse` is `{results: SchemaCheckResult[]}`, one per item in the order of `checks`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `key` | string | yes | the item's `key` |
| `ok` | boolean | yes | true when the value satisfies the schema |
| `errors` | `SchemaCheckError[]` | yes | every ajv error; empty when `ok` or when the schema did not compile |
| `compileError` | string | no | ajv's message when the schema did not compile; `ok` is then false |

`SchemaCheckError`, ajv's error object:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `instancePath` | string, a JSON pointer | yes | where in the value, `""` for the root |
| `schemaPath` | string, a `#` JSON pointer | yes | the schema keyword that failed |
| `keyword` | string | yes | the failing keyword, such as `required` or `minLength` |
| `params` | `Record<string, JsonValue>` | yes | the keyword's parameters, round-tripped through JSON |
| `message` | string | no | ajv's message |

### `schema:validate` takes text and answers violations with dotted paths

`ValidateSchemaRequest`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schemaId` | string | yes | a registered entry id, pickable or not: `state`, `state-prompt`, `prompt-operation` or `component-<name>` |
| `text` | string | yes | the document as typed |

`ValidateSchemaResult`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schemaId` | string | yes | the entry's id |
| `parseError` | string | no | `JSON.parse`'s message; when present, `violations` is empty |
| `violations` | `SchemaViolation[]` | yes | one row per mistake |

`SchemaViolation`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `path` | string | yes | a dotted path into the document such as `operation.temperature`, `""` for the root |
| `message` | string | yes | worded for the editor; names the allowed values of an `enum` or `const`, and the field for an unknown key |

### `schema:detect` takes text and answers the best pickable match

The request is `{text: string}`. `DetectSchemaResult`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `schemaId` | string or null | yes | the best match, or null when none |
| `candidates` | string[] | yes | every pickable entry the document satisfies, best first |

## Most failures come back as answers, and only an unknown id or a malformed request rejects

| Condition | Response | Caller does |
| --- | --- | --- |
| `schema:validate` names no registered entry | rejects with `no schema named '<id>'`, logged at `warn` | send a registered id |
| `schema:validate` text is not JSON | answers `parseError` with `violations: []` | show the parse error |
| A `schema:check` item's schema does not compile | that item answers `ok: false`, `errors: []` and `compileError`; the other items are checked | show the compile error on that field |
| A `schema:check` request is malformed, such as `checks` not being an array | rejects with a `TypeError`, logged at `error` as `schema:check: <message>` | fix the caller |
| `schema:detect` text is not JSON, is not an object, or is `{}` | answers `{schemaId: null, candidates: []}` | leave the picker on none |

## A change here breaks the renderer in the same build, or makes the form and the run disagree

- Channel names live in `IPC_CHANNELS`, from which the preload whitelist is built. Renderer and main ship together, so no older caller exists and there is no deprecation path.
- `fieldErrorsOf` in `schemaForm/model.ts` reads `instancePath`, `schemaPath`, `keyword` and `params` to place and word each error, so a change to those, including an ajv upgrade that changes a keyword's `params`, changes what a form says.
- The validator configuration must stay `{allErrors: true, strict: false}`, the run's, or a form refuses values a run accepts or the reverse.
- Entry ids are addresses. Renaming one makes `schema:validate` refuse every caller still sending the old id.

## The answers are shaped by caching, parsing and matching rules a caller cannot see

- `true` and `{}` answer ok without compiling. Every other schema is compiled, and `false` answers not ok.
- The value cache is keyed by the schema's text. The same schema with its keys in another order compiles twice, and two schemas sharing one `$id` in a session collide: the later answers `compileError` with ajv's `already exists`, whatever its value, until the cache starts over past 500 entries.
- Errors from `schema:check` carry JSON pointers; violations from `schema:validate` carry dotted paths, in which a key containing `.` or `/` reads as more than one segment.
- `schema:validate` parses with `JSON.parse`, so a comment or a trailing comma answers `parseError` and no violations, although a `.jsonc` state file may carry both.
- `schema:detect` considers only pickable entries, matches an entry only when it declares every top-level key the document has, and ranks by how many of the entry's `expected` keys are present.
- `useSchemaCheck` matches results to items by position rather than by `key`, asks 120 ms after typing settles, and drops an answer for values that have since changed.
- The store's `validateSchema` and `detectSchema` actions catch every rejection and answer `null`, so a refused id looks like no status at all.
