---
id: ui/components/file-link-field
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/pick-from-what-exists, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/problems-marked-where-they-are, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/author-processes-without-memorising-the-format, product/share-processes-across-projects, product/catch-process-mistakes-before-running]
surfaces: [ui/surfaces/files-view, ui/surfaces/context-panel]
reuses: [ui/components/value-view, ui/components/issue-mark]
implemented_by: [packages/app/src/renderer/links.tsx, packages/app/src/renderer/linkPreview.tsx]
verified_by: [packages/app/test/operationForm.test.ts, packages/app/test/references.test.ts, packages/app/test/completions.test.ts]
mockups: [ui/assets/file-link-field/inline.html, ui/assets/file-link-field/empty.html, ui/assets/file-link-field/linked.html, ui/assets/file-link-field/preview.html, ui/assets/file-link-field/folded.html, ui/assets/file-link-field/unresolved.html]
siblings: [ui/components/operation-fields-editor, ui/components/slot-table, ui/components/state-form, ui/components/issue-mark]
---

# File link field

A small ghost `🔗 Link` button beside a field's label that turns into an accent-outlined `🔗 Linked`, swapping the field's box for a mono `$/…` path box and showing, under a thin left rule, what that file says.

## A file link holds a field's value in a file and shows the file in place

**Use when.** A state's value may be written inline or kept in a file and referenced: an operation's or environment's `Prompt` and `System`, a slot's type in a slot table, and an operation block whose Kind is `linked — a block held in another file`, where the path box and preview appear without the toggle.

**Do not use when.** The value is only ever inline, such as a model or a seed: those fields carry no toggle. A value written as an expression or a reference with extra keys is shown read-only with `a referenced value — edit it on the JSON tab`, and is edited on the JSON tab of [workflow-editor](workflow-editor.md). To read a file for its own sake, open it in the Files view.

## The label says whether the value is here or in a file, and the file's content follows

- **Toggle.** A small ghost button 6px after the label, in the app face. `🔗 Link` at 70% opacity until the pointer is over it; `🔗 Linked` at full opacity with an `--accent` border and text. In a form whose labels are uppercase, the button keeps its own case.
- **Path box.** The field's own control is replaced by a full-width input holding the reference in the data face, such as `$/prompts/feature/ui/render.md`, with no spellcheck.
- **Note.** Under a linked `Prompt` or `System`, `spliced in where it is referenced — a copy, not a live link` in `--dim`, drawn uppercase by the form's label rule. Under a linked operation, `spliced in whole; sibling keys would override it, and those stay on the JSON tab`.
- **Warning.** When the path names no file in either the shared or the project root, the box border turns `--warn` and `no file here yet — the linter will call this unresolved` sits under it in `--warn`.
- **Preview.** Under a reference that resolves: a 2px `--rule` left rule with 8px of indent, a bar reading `▾ what {reference} says` in `.app-secondary`, and the file drawn by the [value-view](value-view.md) for its type, so a markdown prompt is rendered with its `Rendered` and `Source` switch. The body stops at 320px and scrolls.

## The field moves from inline to a path to the file's own content

| State | Rendered as | Mockup |
| --- | --- | --- |
| inline | The field's ordinary box with `🔗 Link` faded beside its label. Stacked: a value the form holds read-only, whose toggle and box are disabled at half opacity with `a referenced value — edit it on the JSON tab` under them. | [inline.html](../assets/file-link-field/inline.html) |
| empty | Just linked: `🔗 Linked`, an empty path box showing the placeholder `$/prompts/feature_goals.md`, `$/lib/review.operation` for an operation or `$/types/markdown` for a type, the note, no warning and no preview. | [empty.html](../assets/file-link-field/empty.html) |
| linked | The path box holding a reference that resolves, the note, and the preview open over the file's content. | [linked.html](../assets/file-link-field/linked.html) |
| loading | The preview bar over `Reading…` in `--dim` while the file is read. A file that cannot be read shows `Nothing readable at {path}.` in the same place. | [preview.html](../assets/file-link-field/preview.html) |
| folded | The preview bar alone with `▸`. | [folded.html](../assets/file-link-field/folded.html) |
| error | A path that names no file: `--warn` box border and the warning line, and no preview. When the linter reports that field as an error, the border is a 2px `--bad` one and the lint message is the field's tooltip, as [issue-mark](issue-mark.md) draws it. | [unresolved.html](../assets/file-link-field/unresolved.html) |
| partial | Cannot occur: the preview draws the whole file inside its scrolling body. | |
| reading | Not a look of its own: no toggle is drawn, the path box is greyed like every control in a reading, and the preview stays. | |

## Linking and unlinking never lose what was typed

| On | Does | Feedback |
| --- | --- | --- |
| `🔗 Link` | Holds the field as a reference, empty or with the path it had before, and keeps the inline value aside | The box becomes a path box and the toggle reads `🔗 Linked` |
| `🔗 Linked` | Holds the field inline again | The inline value that was there before linking comes back |
| Typing in the path box | Writes the reference and offers every file in the shared and project roots as `$/{path}` | The warning appears or clears as the path stops or starts naming a file; the preview follows the file named |
| The preview bar | Folds or opens the preview; the choice is remembered for that file | `▾` and `▸` swap and the body goes or returns |
| Pointer over the toggle or the bar | Nothing | The toggle goes to full opacity; the bar takes `--fill-ghost-hover` |

## The copy says where the value lives and what that means

| Where | String |
| --- | --- |
| Toggle | `🔗 Link` · `🔗 Linked` |
| Toggle tooltips | `hold this value in a file and reference it (WORKFLOWS.md §2.2)` · `hold this value inline instead of in a file — what you had before linking comes back` |
| Path placeholders | `$/prompts/feature_goals.md` · `$/lib/review.operation` · `$/types/markdown` |
| Notes | `spliced in where it is referenced — a copy, not a live link` · `spliced in whole; sibling keys would override it, and those stay on the JSON tab` |
| Warning | `no file here yet — the linter will call this unresolved` |
| Read-only value | `a referenced value — edit it on the JSON tab` |
| Preview bar | `what {reference} says`; tooltip `{path} — click to hide what it says` or `{path} — click to show what it says` |
| Preview body | `Reading…` · `Nothing readable at {path}.` |

## The field takes its column's width and the preview caps its height

- Resize: the path box fills its column; in a slot table's type cell it shares the row with the `list` checkbox and the toggle. The preview spans every column of the field it sits in.
- Theme: the toggle, warning and rule are tokens; the unresolved state is also carried by its sentence.
- Focus order: the label's toggle, then the path box, then the preview bar, then the controls inside the preview.
- Long content: a long reference scrolls inside its box; the preview bar's sentence runs on one line; a long file scrolls inside the 320px body.
- Missing content: with no file reader, as in a form drawn outside the Files view and context panel, no preview is drawn, and none is drawn for a path that names no file.

## The toggle departs from the direction in how it quietens and what it draws

- Its resting state is quietened with 70% opacity instead of a colour role.
- The chain is a literal emoji rather than a line icon.
- The reference inside the preview bar is data set in the app face.
