---
id: ux/patterns/one-document-several-readings
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/author-processes-without-memorising-the-format, product/see-how-a-process-flows, product/read-what-work-produced, product/read-comfortably]
siblings: [ux/patterns/draft-belongs-to-the-file, ux/patterns/schema-driven-form, ux/patterns/preview-beside-the-setting, ux/patterns/problems-marked-where-they-are]
---

# One document, several readings

One thing can be read or edited in several forms: a form and its source text, a picture of a process, a formatted document, a data tree, a table, a set of changes. Every reading is drawn from the same document, so switching never makes a second copy, and the readings that edit share one unsaved text. A reading that cannot represent part of the document shows that part as not editable there and keeps it exactly as written. The reading offered first follows the kind of thing and the person's choice for that kind. Where the kind of a message in a conversation was guessed, the person can correct it.

## Use it when the same content answers different questions

**Use when.** The person needs to see what a thing is, what it says, or how it connects, from one document: a process file as a form, as text or as a picture, and produced documents, data and changes read as what they are.

**Do not use when.** Only one reading means anything: offer no choice. Values are entered fresh for something that accepts them: use [schema-driven-form](schema-driven-form.md). The person is choosing how a kind of file reads in general: use [preview-beside-the-setting](preview-beside-the-setting.md).

## The person switches reading freely and every editing reading changes the one document

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Opens the thing | Draws the reading its kind calls for, or the one last chosen for that file, and offers the others | Which readings exist and which is showing |
| 2 | Switches reading | Draws the new reading from the same document | The content is the same, seen another way |
| 3 | Edits in a reading that edits | Changes the one document. An edit through a form rewrites the file's layout and keeps every field the form does not show | Every editing reading agrees, and the file is unsaved as in [draft-belongs-to-the-file](draft-belongs-to-the-file.md) |
| 4 | Corrects the guessed kind of a message, for that message or the whole conversation | Draws it again as that kind and remembers the correction | It stays corrected when the conversation opens again |

## Every state points the person to the reading where they can act

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | The reading the kind calls for, with the others offered | Switch reading |
| empty | An empty file says it is empty. A thing with one meaningful reading offers no choice | Edit it in its source |
| loading | A heavy reading says it is loading. A formatted reading shows the source text until it is ready | Read the source meanwhile |
| partial | A part the form cannot represent, such as a reference, is not editable there and names the source text as the place to edit it. A reading shown above an editor draws the saved file, not the unsaved edit | Edit that part in the source, or save to see the edit drawn |
| error | A document that does not parse offers no form and says to fix it in the source. A document with no description of its fields says there is nothing to draw until one is chosen | Fix the source, or choose a description |
| denied | A reading that only reads says it is not a place to type | Edit in a reading that edits |
| success | The chosen reading, agreeing with every editing reading | Switch, edit or save |

## Switching costs nothing, and reading choices last less long than kind corrections

Switching reading changes nothing in the document. The first form edit rewrites the file's layout, and reverting the unsaved edit puts the saved text back.

The reading chosen for a process file lasts while the app stays open. A reading chosen for one value in a conversation lasts only while that value stays in view. A correction of a message's kind is kept across restarts.

## Readings switch by keyboard, but the picture of a process is read by pointer

**Keyboard only.** Readings are switched with ordinary buttons reached by Tab, not with arrow keys. The picture of a process is followed by pointer, and only its zoom is reachable by keyboard.

**Screen reader.** A process file's reading switches do not announce which reading is showing. A value's reading switches announce which one is pressed.

**Small window.** A process file's readings take turns in one area. A reading above an editor can be folded away to give the editor the whole height.

**Slow machine.** A heavy reading loads only when first chosen, and only the chosen reading is worked out. A table stops at 500 rows.
