---
id: engineering/units/component-contracts
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ui/components/choose-option-gate, ui/components/review-artifact-gate, ui/components/edit-artifact-gate, ui/components/fill-form-gate, ui/components/confirm-action-gate, ui/components/choice-list, ui/components/question-stepper, ui/components/review-notes, ui/components/changeset-review, ui/surfaces/components-view, ux/patterns/quote-anchored-note, ux/patterns/own-answer-beside-offered-options, ux/patterns/ask-one-or-several-questions, ux/patterns/comments-turn-a-verdict-into-send-back, product/decide-with-the-context-in-front-of-you]
layer: core
owns_contracts: []
requires: [engineering/units/changesets, engineering/units/document-types]
implemented_by: [packages/shared/src/components.ts, packages/shared/src/reviewNotes.ts, packages/shared/src/componentGallery.ts]
verified_by: [packages/shared/test/components.test.ts, packages/shared/test/choices.test.ts, packages/shared/test/reviewNotes.test.ts, packages/app/test/schemaFormModel.test.ts, packages/app/test/componentGallery.test.ts]
siblings: [engineering/units/interaction-gateway, engineering/units/interaction-hub, engineering/units/changesets, engineering/units/schema-check]
---

# Component contracts

## The unit reads what an author configured for a gate and checks what a person answered against it

These three files implement [gate-components](../contracts/gate-components.md), which [interaction-hub](interaction-hub.md) owns. The configs and result shapes are that contract's, and are not repeated here.

- `COMPONENT_NAMES` and `isComponentName` name the six built-in components.
- `parseComponentConfig(component, raw)` normalizes a config into `ComponentConfig`, or throws a message naming the path it refused, such as `choose_option.questions[1].default 'z' is not one of its options`. `raw` is what the function received: `operation.args` merged with the state's resolved inputs into one flat object. There is no `config` key.
- `validateComponentResult(config, value, inputs?)` answers `{ok: true}` or `{ok: false, errors}`. For `review_artifacts` it finds the changeset among `inputs` by shape through `changesetInputOf` and checks every decision with `checkDecisions`; without `inputs` it checks shape only.
- `choicesOfConfig` reduces a `choose_option` or `review_artifact` config to `Choice[]`, the one question shape the renderer draws, and `choicesOfQuestions` in `ipc.ts` reduces an agent's questions to the same shape. `sendBackOption` names the author's second option that is not `danger`.
- `fillFormSchema(fields)` restates a `fill_form`'s fields as the JSON Schema the app's schema form draws: a required text answer is `minLength: 1`, a `custom` enum is `examples`, and `multiline` is `contentMediaType: "text/plain"`.
- `componentConfigIssues(states)` lints authored state documents. A config that does not parse is an error at `operation.args`, with a placeholder standing in for each key the state declares as an input; a `review_artifact` state with no `notes` output is a warning at `outputs`.
- `reviewNotes.ts`: `anchorNote` resolves a note by its quote, keeping the stored range when it still holds the quote and otherwise taking the repeat nearest it; `anchorNotes` keeps orphans in place; `checkNotes` validates submitted notes and names the index it refused; `noteJson` and `shortQuote`.
- `componentGallery.ts`: `GALLERY_GROUPS`, one group per surface with a variant per knob, flattened into `GALLERY_SURFACES`. Importing the module registers a `component-<name>` schema per component through `registerSchema` with `pickable: false`, addressed by `componentConfigSchemaId`.

It deliberately does not own:

- Parking a gate, delivering an answer and follow-up rounds: [interaction-hub](interaction-hub.md) and [interaction-gateway](interaction-gateway.md).
- Calling the check at the trust boundary: `submitInteraction` in [interaction-gateway](interaction-gateway.md).
- The changeset shape and deriving decisions from gestures: [changesets](changesets.md).
- The schema registry and the validator that reads it: [document-types](document-types.md) and [schema-check](schema-check.md).
- Drawing any gate, which is renderer code.

## The rules are pure core logic, kept in the shared package so main and the renderer import one implementation

- Layer `core`, package `@jaira/shared`, exported from both `index.ts` and `browser.ts`. It imports `@declarative-ai/json` types, `changeset.ts` and `schemas.ts`, and nothing with side effects beyond the schema registration.
- Boundary: renderer and main. Main runs `validateComponentResult` as the check that decides. The renderer reduces the config main parsed into choices and schemas, parses a settled call's recorded args to redraw it, and its component gallery parses sample configs and runs the same check on a sample answer.
- Upstream seam: none. The engine's check of a state's declared output schema is a second, independent gate.
- Callers: the gateway's `withContract`, `configOf` and `submitInteraction`; runtime `followUp.ts`; persistence `workflows.ts` for lint; the renderer's `components.tsx`, `reviewNotes.tsx`, `runViews.tsx` and `componentGallery.tsx`.

## The unit owns no data and holds no state

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| The six `component-<name>` schema entries | registered once when `componentGallery.ts` is first imported | the schema registry in `schemas.ts` | `schema:validate` resolves the gallery's documents through them |
| `GALLERY_GROUPS` and `GALLERY_SURFACES` | read only | this module | the renderer's Components view |

## The invariants refuse any answer that nothing on screen could have produced

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A malformed config is refused with a message naming its path, never drawn as an empty gate | `components.test.ts` "rejects malformed authored config with a path-shaped message" |
| 2 | A decision outside the declared options is refused, unless the state says `custom`, which takes any non-empty string and is refused beside `comments` | `components.test.ts` `"refuses an undeclared decision — the whole point of re-validating in main"`, "lets a choose_option decision be any non-empty string, and refuses it beside comments" |
| 3 | `questions` refuses `options` beside it, the single question's knobs at the top, a repeated name and a default that is not one of its options, and `follow_up` parses only beside `questions` | `components.test.ts` "refuses the single question's knobs beside questions, both spellings at once, a repeated name and a default not on offer", "takes follow-up questions only beside questions, as the state's own parameter" |
| 4 | A multi-part answer is `{answers}` keyed by question name, each checked as a decision, and a key that names no question is refused | `components.test.ts` "validates { answers } keyed by name, each the way a decision is" |
| 5 | A multi-select answer is a non-empty list of distinct declared values | `choices.test.ts` `"refuses an empty list — 'none of these' was not offered"`, "refuses a repeat and an undeclared value" |
| 6 | A `review_artifacts` answer is checked against the one input that parses as a changeset, and two such inputs or none are refused | `components.test.ts` "refuses rather than guesses when two inputs are changesets, or none is", "validates a result against the CHANGESET it was asked about, not just a shape" |
| 7 | The send-back option is the second option that is not `danger`, and a vocabulary with only one has none | `components.test.ts` `"names the author's second non-destructive option — approve / revise / cut sends back as revise"`, "has no send-back for a two-word vocabulary, so the row of options stays" |
| 8 | `content` on a review answer is refused unless the state is `editable`, and `notes` on a `choose_option` answer are refused | `choices.test.ts` `"refuses content from one that did not — nothing on screen could have produced it"`; `components.test.ts` "refuses notes on choose_option, which shows no artifact to anchor to" |
| 9 | A malformed note is refused by field and index | `reviewNotes.test.ts` "names the field and the index it refused" |
| 10 | A note anchors by its quote before its range, picks the nearest repeat, and is kept as an orphan when its quote is gone | `reviewNotes.test.ts` "re-finds the quote when the text above it grew", "picks the repeat nearest where the note was written", `"is undefined when the quote is gone — an orphan, not an error"`, "keeps orphans in place rather than dropping them" |
| 11 | Lint accepts a config key the state declares as an input, and warns on a `review_artifact` state that would drop its notes | `components.test.ts` "accepts a config key the state declares as an input, because the run merges it in", "warns about a review_artifact state that would drop its anchored notes" |
| 12 | A `fill_form`'s schema refuses what its contract refuses, an empty required text included | `schemaFormModel.test.ts` "restates the gate's contract in schema keywords", "refuses an empty required answer exactly as the contract does" |
| 13 | The gallery has a card for every built-in component and covers every knob of `choose_option` and `fill_form` | `componentGallery.test.ts` "has a card for every built-in component", "covers every knob a choose_option and a fill_form can express" |

## The check answers yes or no, so what it does not inspect passes through unchanged

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| An answer carries fields the check does not inspect, such as an unknown field on a note | `validateComponentResult` returns only ok or not; `checkNotes` drops unknown fields from the notes it builds, but the caller submits the value it received | none | the extra field reaches the engine, whose output schema is the last check |
| A `review_artifacts` answer is checked without `inputs` | the check is shape-only: each decision has an id and a known kind, and completeness against the changeset is not checked | pass the inputs, as the gateway does | none |
| A config fails to parse when a gate parks | `parseComponentConfig` throws; the gateway sets `configError` and skips the answer check | fix the state file | the gate shows the config error |
| A state's `operation.args` is a reference, or its operation is not a literal `function` op | lint skips the state | none | no lint mark on that state |
| A quote appears more than once and the note has no range | `anchorNote` takes the first occurrence | none | the note marks the first repeat |
| An optional `fill_form` field or multi-part question is `""` or `null` | read as not answered | none needed | none |
| Two writers, a kill mid-write, a partial read or a duplicate retry | cannot occur: the unit writes nothing and keeps no state | none needed | none |

## The rules live in the shared package, which the architecture reserves for models

- The parse and the check are core rules in `@jaira/shared`, where architecture.md lists models, configuration and IPC types, so that the renderer bundle and the main process run one implementation of the gate contract.
