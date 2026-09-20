---
id: ux/patterns/problems-marked-where-they-are
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/catch-process-mistakes-before-running, product/author-processes-without-memorising-the-format, product/share-processes-across-projects]
siblings: [ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/draft-belongs-to-the-file, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/one-document-several-readings, ux/patterns/schema-driven-form]
---

# Problems marked where they are

Problems found in what a person wrote are shown on the exact thing they are in: a field, a line, a file. Each file's problems are rolled up onto every folder above it, so a folded folder still says that something inside is wrong, how many errors and warnings, and which is worse. A process file that no process reaches is marked as not checked rather than left looking clean. An open process file lists its problems, and choosing one goes to its place and marks it briefly. Process problems are worked out again from the saved files shortly after every save or change on disk. Problems in a document checked against its description, and in code, follow the text as it is typed.

## Use it when checkable content spreads across many files and fields

**Use when.** Content can be checked before anything runs, and the person must find each problem among many files and fields.

**Do not use when.** An action was refused: use [refuse-with-the-reason-and-the-fix](refuse-with-the-reason-and-the-fix.md). Values are being entered for something that accepts them: problems show on their fields as in [schema-driven-form](schema-driven-form.md).

## The person sees where problems are without opening anything, then goes to each

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Saves, or a file changes on disk | Checks the processes again and marks each file and every folder above it with counts and the worse severity | Where problems are, without opening anything |
| 2 | Opens a marked file | Lists its problems and marks the affected fields | What each problem is |
| 3 | Chooses a problem | Switches to the reading that shows it, opens what hides it, brings it into view and marks it for a moment, as in [jump-to-the-place-and-mark-it](jump-to-the-place-and-mark-it.md) | The exact place to fix |

## Every state says whether the content was checked and where to go next

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A process file that no process reaches is marked as not checked, and says why | Wire it into a process |
| empty | A checked process file with no problems says it is clean. A document says it conforms to its description | Run it |
| loading | A document being checked against its description says it is checking. If that check fails, it keeps saying so | Edit the text to check again |
| partial | With no project open, a file is checked on its own and says it was not checked as part of a project. Process problems describe the saved file while an unsaved edit is open | Open a project, or save |
| error | A file that does not parse is marked as unreadable, with the parse error. A code file outside any compiler configuration shows no problems and gives no reason | Fix the file |
| denied | Cannot occur: problems are information, and nothing about them is refused | Fix what is shown |
| success | Nothing is marked | Run the process |

## Nothing here needs undoing, and marks follow what they describe

Marks change only when the content changes. Saving a fix removes the file's marks and what it added to every folder above it. Leaving loses nothing.

## Problems are reached from their list by keyboard, but the file list and its counts are not

**Keyboard only.** Each listed problem is a button reached by Tab. Choosing one brings its place into view and leaves focus on the list. The file list is not reachable by keyboard. Code editors have their own keys for moving between problems.

**Screen reader.** Counts and severity in the file list are given only as hover text and are not announced.

**Small window.** A chosen problem's place is brought to the middle of the view.

**Slow machine.** A change on disk is acted on after a 0.15 second pause, and each change checks the whole checkout again. Code is checked 0.4 seconds after typing pauses, without holding up typing, and an answer about text that has since changed is dropped.

## This departs from the UX principles in one place

A check against a description that fails never ends its waiting state, so the document goes on saying it is checking.
