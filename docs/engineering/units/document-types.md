---
id: engineering/units/document-types
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/read-what-work-produced, ux/patterns/one-document-several-readings, ui/components/value-view, ui/components/data-tree, ui/components/table-view, ui/components/file-changes-list, ui/components/schema-json-editor, ui/components/slot-table, ui/components/file-link-field, ui/components/file-types-pane]
layer: core
owns_contracts: []
requires: [engineering/units/changesets]
implemented_by: [packages/shared/src/mime.ts, packages/shared/src/typeNames.ts, packages/shared/src/grammars.ts, packages/shared/src/valueViews.ts, packages/shared/src/structured.ts, packages/shared/src/slotTypes.ts, packages/shared/src/schemas.ts, packages/shared/src/references.ts]
verified_by: [packages/shared/test/mime.test.ts, packages/shared/test/valueViews.test.ts, packages/shared/test/structured.test.ts, packages/shared/test/slotTypes.test.ts, packages/shared/test/typeNames.test.ts, packages/app/test/languages.test.ts, packages/app/test/schemas.test.ts, packages/app/test/references.test.ts]
siblings: [engineering/units/schema-check, engineering/units/component-contracts, engineering/units/files-view-models]
---

# Document types

## The unit answers what a file or value is and every way it can be read, parsed, typed and schema-checked

Every question routes name or path, then MIME type, then everything else:

- `mime.ts`: `mimeOfPath(relPath)` classifies a layer-root-relative path. `workflows/*.json` is `application/vnd.jaira.workflow+json`, `workflows/*.yaml` and `*.yml` are `application/vnd.jaira.workflow+yaml`, any markdown under `workflows/` is `text/vnd.jaira.workflow-description+markdown`, the root `settings.json` is `application/vnd.jaira.config+json`, and anything unnamed is `text/plain`. `isWorkflowDescription`, `descriptionRootOf`, `mimeOfFenceLang`, `extensionForMime`, `isTextMime` and `mimeFallbacks` go with it.
- `typeNames.ts`: `typeNameOf` gives a person's label and a `TypeFamily`, falling back to the MIME string itself. `paneFamilyOf`, `PANE_FAMILIES` and `PANE_TYPES` group types for the appearance pane; `OFFERED_TYPES` lists what a person may assert a value is.
- `grammars.ts`: `monacoGrammarOf`, `codeMirrorGrammarOf` and `hasGrammar` name each engine's grammar for a type, or `plaintext` and `null`.
- `valueViews.ts`: `viewsFor(value, hint)` returns the `ViewId`s that apply, best first and with `text` always last. A declared type silences every sniffer; with nothing declared, a patch is sniffed only on its `@@` mark, markdown on two structural marks outside block comments, and HTML on a real element. `renderersFor`, `detectedMime`, `editorKindOf`, `mediaKindOf`, `mediaSrcOf`, `artifactOf`, `changesOf`, `changeStats` and `totalStats` go with it.
- `structured.ts`: `structuredFormatOf` and `parseStructured` turn JSON with comments, JSON Lines, a YAML stream with merge keys, CSV or TSV into a value, or into `{ok: false, message, spot?}`, and never throw.
- `slotTypes.ts`: `SLOT_TYPES`, `slotTypeOf`, `schemaForSlotType` and `sameSchema` map ten named slot types to JSON Schema through the five `OWNED_KEYWORDS`. Synonyms are `x-type`, and a schema using any other keyword reads as `null`.
- `schemas.ts`: the schema registry. `registerSchema`, `listSchemas`, `schemaById`, `skeletonOf`, `mergeSkeleton` and `propertiesOf`, with the built-in entries `state`, `state-prompt` and `prompt-operation`. Nothing is `required`; what a finished document needs after the environment merge is `expected` and the `x-expected` keyword, which the validator ignores.
- `references.ts`: `readRef` and `writeRef` spell a reference by position, `refForPath` spells a file as `$/<path>` dropping only `json`, `yaml` and `yml`, and `looksLikeRef` flags an obvious non-reference.

It deliberately does not own:

- Compiling a registered schema and validating a document or a form value against it: [schema-check](schema-check.md).
- The six `component-<name>` schema entries, registered from `componentGallery.ts`: [component-contracts](component-contracts.md).
- The `Change` shape and the diff strategies `viewsFor` and `changesOf` read: [changesets](changesets.md).
- Which renderer draws a view and the per-person choice of one: renderer `fileTypes.ts` and [user-settings](user-settings.md).
- Resolving a reference on disk, which the engine's loader does.

## The unit is pure core logic in the shared package, read by the renderer and main alike

- Layer `core`, package `@jaira/shared`, exported from both `index.ts` and `browser.ts`. Nothing here reads a file, and its only dependencies are `yaml`, `jsonc-parser` and the changeset types.
- Callers: the renderer's value view, file surfaces, schema editor, slot and state forms, markdown editor and transcript; main's `writeFile`, `readFile` and sync status; persistence's file tree and `descriptions.ts`; runtime `changesets.ts` and `fileTools.ts`.
- Upstream seam: none is called. `REF_DATA_EXTENSIONS` restates `DATA_EXTENSIONS` from `@declarative-ai/hw` `reference.ts`, and `slotTypes.ts` writes synonyms as `x-type` because `@declarative-ai/validate` `subtype.ts` treats that keyword as constraining.

## The unit's only state is the schema registry, filled when the module loads

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| The schema registry, a module-level `Map` of `SchemaEntry` by id | written by `registerSchema` at import, last registration of an id winning; read by `listSchemas`, which skips `pickable: false`, and `schemaById` | `schemas.ts`, per process | [schema-check](schema-check.md) compiles entries; [component-contracts](component-contracts.md) registers six |
| The type tables `TEXT`, `BINARY`, `FENCE_ALIASES`, `NAMES`, `BARE` and `GRAMMARS` | read only | the modules | none |

## The invariants keep a declared type authoritative and the source always reachable

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A JSON file under `workflows/` is a state file and one elsewhere is not; every markdown under `workflows/` is a description; only the root `settings.json` is config; an unnamed type is `text/plain` | `mime.test.ts` "distinguishes a state file from a JSON file that merely looks like one", "names every markdown file under workflows/, because each describes one", `"only calls the root settings.json config — a nested one is just JSON"`, "falls back to plain text for anything unrecognised, rather than to nothing" |
| 2 | A vendor type resolves to the syntax it is written in, and every text type ends at `text/plain` exactly once | `mime.test.ts` "sends a vendor type to the syntax it is written in, then to plain text", "ends every text type at text/plain, and lists it only once" |
| 3 | A fence's language name and a file's extension resolve to the same type | `languages.test.ts` "resolves the same type from a language name as from an extension" |
| 4 | A stated type is never overruled by a sniffer, whether or not it names a view | `valueViews.test.ts` "believes a declared media type over the sniffer", "never sniffs over a type the caller stated, whether or not it names a view" |
| 5 | Every reading of a string or value keeps the source reading behind it | `valueViews.test.ts` "keeps the source available behind every rendering" |
| 6 | A code view is offered exactly where a grammar exists to colour it | `languages.test.ts` "offers a code view exactly where a grammar exists to produce one" |
| 7 | One markdown mark, or the continuation lines of a block comment, never make a string markdown | `valueViews.test.ts` "wants two structural marks before calling a string markdown", "does not read a doc comment's continuation lines as a bullet list" |
| 8 | A single-key wrapper around an artifact is read as the artifact, and a wrapper with other keys is not | `valueViews.test.ts` "unwraps a single-key wrapper, which is what one blob output slot produces", "refuses to unwrap when there is something else in the object" |
| 9 | A structured parse never throws or hangs: a YAML alias bomb is refused, a bad JSON Lines line fails the file naming it, and a YAML syntax error carries its line | `structured.test.ts` "refuses an alias bomb instead of hanging on it", "fails the whole file on a bad line, and names it", "reports a syntax error with the line, rather than throwing" |
| 10 | An `x-type` name outside the vocabulary is never read as its bare type, and a list of anything is distinct from no schema | `slotTypes.test.ts` "refuses a type name it does not know rather than reading it as the bare type", "tells 'a list of anything' apart from 'no schema'" |
| 11 | The state schema reports a misspelled top-level key, and never reports a reference, an empty document or an unknown operation field | `schemas.test.ts` "catches a misspelled top-level key, which is the error people actually make", "accepts a reference anywhere a literal would go", `"accepts an empty document — nothing is required in the file"`, "accepts a field the vocabulary has never heard of on an operation" |
| 12 | A skeleton is valid, and merging one never changes a value the document already has | `schemas.test.ts` "writes a skeleton that is itself valid", "adds what a document is missing without touching what it has", `"leaves an empty string or an empty object alone — present is present"` |
| 13 | A `$ref` with sibling keys is not read as a plain reference, and `$ref` inside a schema is never claimed as one | `references.test.ts` "refuses a reference carrying sibling overrides", `"never claims $ref inside a schema — that key is JSON Schema's"` |
| 14 | A reference spelled from a path drops only a data extension | `references.test.ts` "drops a data extension, because a reference probes for one", "KEEPS any other extension" |
| 15 | A type's label is never invented: an unnamed type is labelled with its MIME string | `typeNames.test.ts` "falls back to the type itself rather than inventing a name" |

## The failure modes are misreadings that cost a reading, never a thrown error

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A string with no declared type is sniffed wrongly | an extra reading is offered, or a rich one is missing | assert a type from `OFFERED_TYPES` | an extra reading, or the source only |
| A binary file's extension is in neither table | `mimeOfPath` answers `text/plain`, which `isTextMime` accepts, so `file:read` returns it as a UTF-8 string | none | the file opens as garbled text, and saving writes that text back |
| A state file is authored as `.jsonc` | it is `application/json`, not the workflow type, so `writeFile` accepts it as plain text | none | the file gets neither the authoring form nor the board |
| A document does not parse | `parseStructured` answers `ok: false` with the parser's message and, where known, a 1-based line and column | fix the document | the data or table reading says where it broke |
| A YAML document expands aliases past the parser's limit | the `yaml` throw is caught as `ok: false` | none | the data reading shows the refusal |
| A change edits two places far apart | `changeStats` counts every line between the first and last difference as both removed and added | none | the `+a −r` figure overstates the change |
| A slot schema uses a keyword outside `OWNED_KEYWORDS`, or an authored value is a `$ref` with siblings | `slotTypeOf` or `readRef` answers `null` or `undefined` | edit the JSON | the field is shown read-only |
| Two writers, a kill mid-write, a partial read or a duplicate retry | cannot occur: the unit writes nothing, and the registry is filled once at import | none needed | none |

## Renaming a type or a family orphans saved preferences, and nothing migrates

- The MIME strings and `PaneFamily` ids are keys in the per-person renderer choices, `"<mime>:<kind>"` and `"family:<family>:<kind>"`. Renaming one leaves those preferences unread.
- The schema entry ids are what `schema:validate` callers send, and a renamed id is refused by name.
- Changing what `isWorkflowDescription` matches changes which files carry the sync panel and which baselines [description-sync](description-sync.md) keeps.

## The rules live in the shared package, which the architecture reserves for models

- Type, view, parse and schema rules are core logic in `@jaira/shared` so the renderer and main run one implementation of each answer.
- `REF_DATA_EXTENSIONS` restates the engine's list rather than importing it, because the renderer must not load the engine.
