---
id: ui/components/tools-field
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/pick-from-what-exists, ux/patterns/schema-driven-form, ux/patterns/absence-is-stated]
serves: [product/agents-act-only-where-allowed, product/share-processes-across-projects]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel]
reuses: [ui/components/toolset-card, ui/components/schema-form, ui/components/settings-field]
implemented_by: [packages/app/src/renderer/toolsField.tsx, packages/app/src/renderer/toolsFieldForm.ts, packages/app/src/renderer/operationFields.tsx]
verified_by: [packages/app/test/toolsets.test.ts]
mockups: [ui/assets/tools-field/state-field.html, ui/assets/tools-field/state-field-adding.html, ui/assets/tools-field/state-field-none.html]
siblings: [ui/components/toolset-card, ui/components/composer-setting-chip, ui/components/settings-field]
---

# Tools field

The state editor's one field for what a state's agent may do: a picker of the toolset it starts from, `bucket / name — layer`, and under it the lines the state writes over that toolset, drawn as the [toolset card](toolset-card.md) draws any other line.

## One field for what used to be two

**Use when.** A state's `environment.tools` or `operation.tools` is edited and it is written the way [decision 0007](../../engineering/decisions/0007-toolsets.md) says: a reference to a toolset, a reference with lines over it, or lines alone.

**Do not use when.** The block is UNMIGRATED — `tools` is a list of names, or it carries the old `permissions` block with a profile, a default or a tool map. Those keep the two separate fields they have always had, unchanged and read exactly as before; which of the two a state means is chosen when it is migrated, never by opening it in a form. A whole toolset FILE is edited in [Settings → Toolsets](../surfaces/settings-toolsets.md).

## The picker states where the tools come from, and the lines state what this state changes

- **Field.** A [settings field](settings-field.md) drawn by the [schema form](schema-form.md), labelled `Tools`, required, with the hint `A toolset, and any lines this state writes over it.` and the key `environment.tools` or `operation.tools` after it. Its control is a box completing against the toolsets this project can name.
- **Options.** Every toolset on the layered search path as `bucket / name — layer`, bucket by bucket in the rail's own order, then `none — lines of its own only` last. A reference the state already holds that is not one of them — an explicit root, a relative path, a toolset since deleted — is listed FIRST as `{reference} — as written`, so the form never restates what a state names.
- **Lines.** Under the box, in a bordered card 6px below it: the toolset card's rows with no sections, every one held and so every one carrying its red minus, then one add line. A line's sentence is `over the toolset, for this state`, or `this state's own line` where the picker says none.
- **Add line.** `add a tool, a command or script`, offering the tools the lines do not hold, `script`, `other`, and anything typed.
- **Unread sibling.** A key written beside the reference that cannot be read as a line is kept as written and said under the card in `--warn`, rather than dropped: the linter is where it is reported, and a form that deleted what it could not draw would be deleting the evidence.
- **Reading.** A state that says nothing about tools draws nothing at all. One that does draws the same field with its control and its rows inert and no minus.

| Where | String |
| --- | --- |
| Field | `Tools`, required, hint `A toolset, and any lines this state writes over it.` |
| Options | `{bucket} / {name} — {this project\|all projects\|built in}` · `none — lines of its own only` · `{reference} — as written` |
| Line note | `over the toolset, for this state` · `this state's own line` |
| Add line | `add a tool, a command or script` |
| Unread | `'{key}' is written here and could not be read as a line — kept as written; see the JSON tab.` |

## Picking writes the reference, a line writes a sibling, and the plain spelling wins

- Picking a toolset writes `"tools": "$/toolsets/{bucket}/{name}"` where the state writes no lines of its own, and `{ "$ref": …, …lines }` where it does. Picking `none` leaves the lines alone as the whole statement, and a state that names neither writes no `tools` key at all.
- Half a name typed in the box writes nothing: a reference is written once the text is a toolset somebody can name.
- A line's minus, mode and implementation buttons are the [toolset card](toolset-card.md)'s and behave as they do everywhere.
- A document nothing was changed in comes back BYTE FOR BYTE — the same spelling, the same order, the same siblings — so opening a state and saving it does not re-spell a `$ref` somebody wrote as an object.
- `other` is written only when a line says it. Lines over a toolset say what they CHANGE, and writing a catch-all here would override the toolset's own on every state that was ever opened in the form.
- The toolsets the box completes against are read once per project and re-read when a toolset is written, so one added in Settings can be named here without reopening the state.
