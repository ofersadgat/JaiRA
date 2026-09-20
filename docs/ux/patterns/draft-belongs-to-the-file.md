---
id: ux/patterns/draft-belongs-to-the-file
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/author-processes-without-memorising-the-format, product/keep-process-and-description-in-step, product/share-processes-across-projects, product/try-one-step-on-its-own, product/bring-your-own-models-and-agents]
siblings: [ux/patterns/unsaved-proposal, ux/patterns/one-document-several-readings, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/problems-marked-where-they-are, ux/patterns/park-and-ask]
---

# Draft belongs to the file

An unsaved edit belongs to the file, not to the place it was typed. The person can open another file or another part of the app and come back, and the edit is still there. The file is marked as unsaved wherever it is listed, a folded folder is marked when anything inside it is, and a folded editor keeps the mark. Typing the text back to what is saved removes the mark. Save and revert stay in reach however long the document is. Renaming a file or folder carries its unsaved edits along, and deleting drops them. Running a step uses the saved file, while checking a process against its description uses the unsaved text.

## Use it for any stored text a person may leave half edited

**Use when.** A person edits text kept as a file: process files, prompts, descriptions, and the raw settings of a layer.

**Do not use when.** The text is an answer that is sent rather than saved: use [park-and-ask](park-and-ask.md). The text was produced for the person to accept or reject: use [unsaved-proposal](unsaved-proposal.md). A setting is changed through a form, which writes each change as it is made, as in [schema-driven-form](schema-driven-form.md).

## The edit waits with its file until the person saves or reverts it

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Types | Keeps the difference from the saved file and marks the file wherever it is listed | The file has unsaved edits |
| 2 | Goes elsewhere and comes back | Shows the file with the edit still in it | Nothing was lost |
| 3 | Saves | Refuses while the file does not parse, otherwise writes it, reads it back and clears the mark | The file is saved, or why it cannot be |
| 3' | Reverts | Puts the saved text back without asking | The edit is gone |

## Every state says whether the file on disk matches what the person sees

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A file that does not exist on disk says saving creates it | Type and save |
| empty | No unsaved edit: nothing is marked and saving is unavailable | Edit |
| loading | Saving and reverting are unavailable while a save is under way, and nothing else says so | Wait for the mark to clear |
| partial | The file says it has unsaved changes and is marked wherever it is listed. Running the step says the run uses the last saved file | Save, revert, or run the saved version |
| error | A file that does not parse cannot be saved, with the reason beside the save. A refused save is reported apart from the file and does not stay, and the edit is kept | Fix the text and save again |
| denied | The project's settings with no project open offer no editor and say to open a project | Open a project, or edit the shared layer |
| success | The mark clears everywhere the file is listed, and nothing else announces the save | Carry on editing, or run |

## Revert discards at once, and every unsaved edit is lost when the app closes

Revert asks for no confirmation. In the code and prompt editors, the editor's own undo brings a reverted edit back.

Unsaved edits last while the app stays open. Reloading or quitting discards them without a prompt.

A step opened beside the picture of a process holds its edit only there. The file list does not mark it, and closing that side view discards it.

A change made to the file on disk under an unsaved edit is not noticed, and saving writes over it.

## Saving takes a pointer or Tab, and the file list's marks are hover text only

**Keyboard only.** There is no key for saving. Save and revert are ordinary buttons reached by Tab, and each editor's own undo, redo and indent keys work. The file list is not reachable by keyboard.

**Screen reader.** The unsaved mark in the file list is given only as hover text. The words beside the save say that changes are unsaved.

**Small window.** Save and revert stay in reach however far the document scrolls. An editor shown with a reading folds away to a line that keeps the unsaved mark.

**Slow machine.** Editors load when first opened. A save in progress shows only as its controls being unavailable.

## This departs from the UX principles in two places

Unsaved edits are discarded without a prompt when the app closes.

Saving writes over a change made on disk since the edit began, without saying so.
