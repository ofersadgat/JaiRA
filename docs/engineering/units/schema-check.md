---
id: engineering/units/schema-check
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/author-processes-without-memorising-the-format, ux/patterns/schema-driven-form, ui/components/schema-form, ui/components/schema-json-editor]
layer: service
owns_contracts: [engineering/contracts/schema-check-channels]
requires: [engineering/units/document-types, engineering/units/app-log]
implemented_by: [packages/app/src/main/service.ts]
verified_by: [packages/app/test/schemaCheck.test.ts, packages/app/test/schemas.test.ts]
siblings: [engineering/units/document-types, engineering/units/component-contracts, engineering/units/ipc-bridge]
---

# Schema check

## The unit validates editor documents and form values in main, with the verdict the run would reach

Four `AppService` methods in `service.ts`:

- `validateSchema({schemaId, text})` parses the text with `JSON.parse` and validates it against a registered entry. It answers a `parseError`, or violations collapsed by `collapseErrors` to one row per mistake: binding-form `required` errors are dropped, an `anyOf` row is dropped when a deeper row explains it, unknown fields are keyed by name, and `messageFor` names the allowed values of an `enum` or `const`.
- `checkValues({checks})` validates each `{key, schema, value}` against an author's schema and answers every ajv error whole. `true` and `{}` pass without compiling, and a schema that does not compile becomes `compileError` on its own item.
- `detectSchema(text)` answers the pickable entries a JSON object satisfies while declaring every one of its top-level keys, ordered by how many of each entry's `expected` keys the document carries.
- `schemaValidator(id, document)` and `valueValidator(schema)` compile and cache.

It deliberately does not own:

- The schema registry, the entry documents and `propertiesOf`: [document-types](document-types.md).
- Deciding when a form asks and placing each error under its field: renderer `schemaForm/check.ts` `useSchemaCheck` and `schemaForm/model.ts` `fieldErrorsOf`.
- The run's own validation, which `SchemaValidator` in `@declarative-ai/validate` performs. This unit mirrors its configuration and does not call it.
- Re-validating a person's gate answer: [component-contracts](component-contracts.md) and [interaction-gateway](interaction-gateway.md).

## The unit is main-process code behind three channels, and calls only the schema registry

- Layer `service`, reached through the handler table in `index.ts` as `schema:validate`, `schema:check` and `schema:detect`: [schema-check-channels](../contracts/schema-check-channels.md).
- Boundary: renderer and main. ajv runs only in main; the renderer sends text or values and draws the answer.
- It calls `schemaById`, `listSchemas` and `propertiesOf` from [document-types](document-types.md), and `refusal`, which logs a warning through [app-log](app-log.md).
- Upstream seam: none is called. Both ajv instances are `new Ajv({allErrors: true, strict: false})`, the configuration of `SchemaValidator` in `@declarative-ai/validate` `ajv.ts`.

## The unit owns two compiled-validator caches and nothing durable

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `ajv` and `schemaValidators`, compiled registry entries keyed by entry id | compiled on first use; never evicted | the entry in the schema registry | none |
| `valueAjv` and `valueValidators`, compiled author schemas keyed by `JSON.stringify(schema)` | compiled on first use; both replaced once the map holds more than 500 | the schema the caller sent | none |

The two instances are kept apart so an author's `$id` never collides with an editor schema.

## The invariants keep the form's verdict and the run's verdict the same

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A form value is ok exactly when the run's `SchemaValidator` says ok | `schemaCheck.test.ts` "says ok exactly when the run's own validator does" |
| 2 | Every complaint comes back whole, with its instance path and keyword | `schemaCheck.test.ts` "hands back every complaint whole, with the path it is about" |
| 3 | A schema that constrains nothing passes without being compiled | `schemaCheck.test.ts` "passes a schema that constrains nothing without compiling it, as the run does" |
| 4 | A schema that does not compile never throws, and the other items in the batch are still checked | `schemaCheck.test.ts` "reports a schema that cannot be compiled rather than throwing, and checks the rest" |
| 5 | An unknown schema id is refused, never passed | `schemas.test.ts` "refuses an unknown id rather than silently passing the document" |
| 6 | Text that is not JSON answers a parse error and no violations | `schemas.test.ts` "reports a parse error instead of schema noise about a half-typed document" |
| 7 | One deep mistake is one violation, two independent mistakes are two, and an invalid document always has at least one | `schemas.test.ts` "reports a deep mistake once, not once per enclosing block", "still reports two independent mistakes separately", "never reports a document as invalid with nothing to show for it" |
| 8 | An `enum` or `const` violation names the allowed values, and an unknown key names the field | `schemas.test.ts` "names the allowed values instead of just saying there are some", "names the value a const field demands", "still names the offending field for an unknown key" |
| 9 | Detection names only an entry the document satisfies, prefers the more specific, and declines for `{}`, a non-object and non-JSON | `schemas.test.ts` "recognises a state file", "prefers the more specific schema when both fit", "matches nothing for an unrelated JSON document", "declines to guess for an empty object", "declines for anything that is not an object", "declines for text that is not JSON at all", `"agrees with the validator — a detected schema reports no violations"` |
| 10 | An author's `$id` never collides with an editor schema | unasserted |
| 11 | The value cache starts over rather than holding more than 501 compiled validators | unasserted |

## The failure modes come back as answers, except a malformed request

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A request is malformed, such as `checks` not being an array | the method throws a `TypeError`, logged at `error` as `schema:check: <message>`, and the call rejects | fix the caller | the form reads `could not be checked: <message>` |
| A schema does not compile, such as one with an external `$ref` | that item answers `compileError`; the rest are checked | fix the schema | the field reads `this schema can't be checked: <error>` |
| Two schemas with one `$id` and different text are checked in one session, including one schema with its keys reordered | the later one fails to compile with ajv's `already exists` and answers `compileError` | none, until the cache starts over past 500 | the field reads that its schema cannot be checked |
| `schema:validate` names an unregistered id | refused with `no schema named '<id>'`, logged at `warn` | pick a registered id | the store's action answers `null` and the editor shows no status |
| The editor holds JSON with comments or a trailing comma | `JSON.parse` fails, so the answer is `parseError` with no violations | remove them | the editor shows the parse error |
| Two writers, a kill mid-write, a partial read or a duplicate retry | cannot occur: the caches are process memory and a repeated check gives the same answer | none needed | none |

## One number bounds the value cache

- 500 compiled value validators, after which `valueValidator` in `service.ts` clears the map and makes a fresh `Ajv`.

## The unit uses ajv directly instead of the engine's validator wrapper

- `SchemaValidator` joins every error into one string, and an editor and a form need each error apart with the path it is about, so the unit compiles with its own ajv under the same configuration.
