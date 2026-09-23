---
id: ui/components/operation-fields-editor
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/pick-from-what-exists, ux/patterns/one-document-several-readings, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/problems-marked-where-they-are]
serves: [product/author-processes-without-memorising-the-format, product/bring-your-own-models-and-agents, product/agents-act-only-where-allowed, product/repeatable-agent-processes]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel]
reuses: [ui/components/slot-table, ui/components/file-link-field, ui/components/issue-mark, ui/components/run-value-field, ui/components/value-view]
implemented_by: [packages/app/src/renderer/operationFields.tsx, packages/app/src/renderer/operationForm.ts]
verified_by: [packages/app/test/operationForm.test.ts, packages/app/test/configPanel.test.ts]
mockups: [ui/assets/operation-fields-editor/prompt.html, ui/assets/operation-fields-editor/function.html, ui/assets/operation-fields-editor/partial.html, ui/assets/operation-fields-editor/model-settings.html, ui/assets/operation-fields-editor/error.html, ui/assets/operation-fields-editor/reading.html]
siblings: [ui/components/state-form, ui/components/slot-table, ui/components/llm-config-form]
---

# Operation fields editor

A column of uppercase-labelled fields for one operation or environment block: Prompt or Function, System, Tools, Search path and Model, with `🔗 Link` beside the labels that can live in a file, then two slot tables, Session and Conversation selects, a Permissions list and a folded `Model settings`.

## The operation fields editor spells out what one call is and how it runs

**Use when.** A state's Operation block is a prompt, a function or inherited, or a state declares Environment defaults for itself and every state below it. Both blocks are the same fields; the block above the editor says which one it is.

**Do not use when.** The operation is held whole in another file: the [state-form](state-form.md) shows a reference box in its place. The call settings belong to a provider or executor in Settings: use [llm-config-form](llm-config-form.md).

## What the call says comes first, how it is wired second, and its tuning last and folded

Fields stack 8px apart. Each label is uppercase at ×0.88 of the app size with .04em tracking in `--dim`, 4px above its box.

1. **Prompt.** A six-row mono box, for a prompt or inherited block. `🔗 Link` sits beside the label.
2. **System.** A three-row mono box, with `🔗 Link`.
3. **Function.** A one-line box offering the built-in gates and every executor as the person types, each with a note such as `built-in human gate` or that it is turned off, for a function or inherited block.
4. **Tools** and **Search path.** One-line boxes taking comma-separated names.
5. **Model.** A one-line box, for a prompt or inherited block.
6. **Arguments.** A three-row mono JSON box, for a function or inherited block.
7. **Operation inputs** and **Operation output.** Two [slot-table](slot-table.md) blocks; the output table says an empty binding means `the call returns this name`.
8. **Session.** A select, with a name box beside it when the session is named, then `fork the session rather than appending` as a checkbox on its own line.
9. **Conversation.** A select, with an artifacts box beside it for `selected_artifacts`.
10. **Permissions.** A titled block with `+ Tool`: a profile box and a default-mode select share a line, then one row per tool with its name, a 92px mode select and `✕`. A permission's path scopes are not drawn and are kept as written.
11. **Model settings.** A closed fold in `--dim`. Open, it gains a 2px `--line` rule down its left and holds Temperature, Top P, Top K, Max output tokens, Max steps, Seed, Presence penalty, Frequency penalty, Stop sequences, Output modalities, two JSON boxes for Tool choice and Provider options, and Reasoning as an effort select beside a budget box. These fields show for every kind.

A linked field swaps its box for a mono reference box, adds `spliced in where it is referenced — a copy, not a live link` under it in the uppercase label style, and opens a `▾ what {reference} says` preview of the file under it, drawn by [value-view](value-view.md) and capped at 320px.

## Every state keeps the same order of fields and changes which appear and whether they take typing

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a look of its own: an unset field is an empty box with its placeholder, as most fields in the function mockup are. | |
| loading | Cannot occur: the fields draw from the document in hand. A linked field's preview reads `Reading…` while its file is read. | |
| success | A prompt block: the prompt and tools filled, the output table declared, Permissions with a profile and a tool row, Model settings closed. | [prompt.html](../assets/operation-fields-editor/prompt.html) |
| function | A function block: Function and Arguments in place of Prompt and Model, the rest as a prompt block has them. | [function.html](../assets/operation-fields-editor/function.html) |
| partial | A value the fields cannot edit stays as written. A linked prompt shows its reference, the note and the preview. A field holding a richer reference is a dimmed box with `a referenced value — edit it on the JSON tab` under it, uppercase like the labels. A computed session reads `a computed position` in a dimmed select beside a dimmed box of its JSON. | [partial.html](../assets/operation-fields-editor/partial.html) |
| model-settings | The fold open over its thirteen fields, with the tuned ones filled. | [model-settings.html](../assets/operation-fields-editor/model-settings.html) |
| error | On the Operation block only, a problem marks its box with a 2px `--bad` or `--warn` border and puts its message on the field's tooltip. The Environment block is never marked. | [error.html](../assets/operation-fields-editor/error.html) |
| reading | The configuration a run resolved against: every empty field, an undeclared Session or Conversation and empty Permissions are left out, `fork` shows only when set, `Link` and `+ Tool` and `✕` are gone, boxes lose their borders, Model settings appears only when something is tuned and then open, and the call's whole result sits under the output table. | [reading.html](../assets/operation-fields-editor/reading.html) |

## Each control writes one key of the block, and a blank control removes it

| On | Does | Feedback |
| --- | --- | --- |
| Type in a text field | Writes the value; Tools, Search path, Stop sequences and Output modalities split on commas; a number field writes only a finished number; a blank field removes the key | The editor's `unsaved changes` |
| Type in a JSON box | Writes the parsed JSON, or the text itself when it does not parse; blank removes it | The editor's `unsaved changes` |
| `🔗 Link` | Starts an empty reference and keeps the inline text aside | A reference box in place of the text box, and `🔗 Linked` in `--accent` |
| `🔗 Linked` | Removes the reference and gives back the inline text | The text box returns |
| Choose a Session | `not declared` removes it; `named` writes the name typed beside it; `fresh` starts a new conversation over the inherited one | The name box appears for `named` |
| Tick `fork the session rather than appending` | Always branches the conversation | The tick |
| Choose a Conversation | Sets the transcript preamble; `selected_artifacts` reads the artifact names typed beside it | The artifacts box appears |
| `+ Tool` | Adds a tool row set to `ask`; a row with no tool name is not written | A new row |
| `✕` on a tool row | Removes it | The row goes |
| `Model settings` | Opens or closes the fold | The fold opens under its rule |

## The copy says what each field decides in the author's terms

| Where | String |
| --- | --- |
| Labels | `Prompt` · `System` · `Function` · `Tools` · `Search path` · `Model` · `Arguments` · `Session` · `Conversation` · `Permissions`, drawn uppercase |
| Model settings labels | `Temperature` · `Top P` · `Top K` · `Max output tokens` · `Max steps` · `Seed` · `Presence penalty` · `Frequency penalty` · `Stop sequences` · `Output modalities` · `Tool choice` · `Provider options` · `Reasoning` |
| Placeholders | Function `claude-code, codex-cli, choose_option, …` · Tools `read_file, run_command` · Search path `./ops, $INHERITED` · Model `claude-sonnet-5, or claude-cli/sonnet to pin the route` · Arguments `{ "options": ["approve", "block"] }` · Tool choice `"auto"` · Provider options `{ "anthropic": { "cacheControl": true } }` |
| Tooltips | Prompt `{{.inputs.x}} interpolates; Link holds it in a file instead` · System `the system prompt for this call` · Tools `logical names resolved through the tool registry — an empty list drops the inherited ones` · Model `a bare id routes to whatever serves that family here — prefix it to insist on one route` · Search path `where a bare reference is looked up; entries may not themselves be bare` · Max steps `how many tool-use rounds one call may take` · Arguments ``bound as the function's `config` input; a reference here must be written {"$ref": …}`` · Tool choice and Provider options `passed through to the provider` |
| Link | `🔗 Link` · `🔗 Linked` · tooltips `hold this value in a file and reference it (WORKFLOWS.md §2.2)` and `hold this value inline instead of in a file — what you had before linking comes back` |
| Linked note | `spliced in where it is referenced — a copy, not a live link` |
| Preview | `what {reference} says` · `Reading…` · `Nothing readable at {path}.` |
| Reference held read-only | `a referenced value — edit it on the JSON tab` |
| Session | `not declared — its own stream` · `named — shared by every state using the name` · `fresh — override the chain and start new` · `a computed position` · name placeholder `review` · tooltips `which conversation stream this call joins` and `also the resource-bundle key — workspace and permissions` |
| Fork | `fork the session rather than appending` · tooltip `always branch, rather than appending when the position is still the head` |
| Conversation | `not declared` · `full_history` · `summary` · `fresh` · `selected_artifacts` · artifacts placeholder `plan_doc, critique` · tooltip `the transcript preamble injected into THIS call (SPEC §4.7)` |
| Function notes | `built-in human gate` · `{executor kind}` · `{executor kind} — turned off, so it is not registered` |
| Permissions | `+ Tool` · profile placeholder `profile — which effects are in scope`, offering `read-only` · `plan` · `full` · `default mode…` · modes `allow` · `deny` · `ask` · tool placeholder `tool name` · tooltip `remove` |
| Reasoning | `effort…` · `low` · `medium` · `high` · `budget tokens` |

## The fields take the column's width, and long values scroll inside their boxes

- **Resize.** Every box fills the column. Paired controls, such as Session and its name or a profile and its mode, share one line; a tool row keeps its mode select at 92px.
- **Theme.** Borders, the fold's rule, the link toggle's accent and the issue colours are tokens.
- **Focus.** Tab follows the order above. Each `🔗 Link` comes right after its label, before its box.
- **Long or missing content.** Prompt, System and the JSON boxes resize vertically; in a reading they grow to their text. A one-line box scrolls its text. A missing value shows the placeholder while editing and nothing in a reading.

## The editor departs from the visual direction in three places

- Function names, tool names, model ids, profiles and modes are data typed or chosen in the app face.
- Field labels are an uppercase style of their own rather than `.app-label`, and the notes under a linked or referenced field take the same uppercase.
- `🔗 Link` is quieted with opacity and is an emoji glyph rather than a line icon.
