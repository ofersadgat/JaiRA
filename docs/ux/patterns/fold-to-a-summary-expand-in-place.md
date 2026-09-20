---
id: ux/patterns/fold-to-a-summary-expand-in-place
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/know-what-work-costs, product/find-out-why-the-app-misbehaves, product/author-processes-without-memorising-the-format]
siblings: [ux/patterns/nested-under-what-caused-it, ux/patterns/the-window-remembers-its-arrangement, ux/patterns/draft-belongs-to-the-file, ux/patterns/stream-then-settle]
---

# Fold to a summary, expand in place

Content that is long, repetitive or secondary folds to one line that says what it hides: how many earlier steps, how many passes of a loop, what a call did and whether it succeeded, what a step cost, or that a folded editor holds unsaved edits. It opens where it is, growing in place, and folds back the same way. A long stretch of an agent's work folds its older steps and keeps its newest steps in view, and anything the work produced stays in view however old it is. A stretch folds only when it would hide more than one step. Whole steps of a run can be folded one at a time or all at once. Folds that say how the person likes to read are remembered, as in [the-window-remembers-its-arrangement](the-window-remembers-its-arrangement.md). Opening a single entry is not.

## Use it when a record is long and most of it is read only when needed

**Use when.** A record holds far more than is read at a glance: an agent's steps, repeated passes of a loop, the detail of a tool call, the full detail of a log entry, a file's editor while the person watches the step it holds run.

**Do not use when.** The content is what the person came for, such as what a step produced: keep it in view. Work started by other work is shown inside what started it with [nested-under-what-caused-it](nested-under-what-caused-it.md), which folds the same way.

## The summary says whether opening is worth it, and opening grows the content where it stands

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Reads the summary line | Shows what is folded: a count, an outcome, a cost, or that unsaved edits are behind it | Whether it is worth opening |
| 2 | Opens it | Grows it in place, reading the content first if it has not been read | The detail, in its place in the record |
| 3 | Folds it again, or folds or opens every step at once | Collapses it in place, and remembers which steps are folded | The record is short again |

## Every state shows either the summary or the content in its place

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Long stretches of work start folded, and what the work produced starts in view | Open a stretch |
| empty | Content with nothing behind it offers nothing to open, such as reasoning the provider withheld | Keep reading |
| loading | An opened part whose content is being read says it is loading | Wait |
| partial | A folded stretch names how many earlier steps it hides, and an opened one offers to show fewer. Repeated passes name how many there are. A file's editor sits shut, half open or fully open | Open, fold, or change how much shows |
| error | An opened part with nothing recorded says nothing was recorded. A file whose text does not parse names the problem with its line and column | Keep reading, or fix the file |
| denied | Cannot occur: folding hides nothing the person may not see | Open it |
| success | The opened content, in place | Fold it |

## Folding is undone by opening, and only single-entry opens are lost on leaving

Every fold is undone by opening it again, at any time.

Which steps of a run are folded, and how much room a file's editor takes, are kept for the person across restarts. Everything else opened, such as a tool call's detail or a stretch of earlier steps, folds again when the person leaves it.

## Every summary opens by keyboard, and folded content costs nothing until opened

**Keyboard only.** Summary lines are standard buttons, or behave as buttons: reached by Tab and opened with Enter or Space.

**Screen reader.** Summary lines are announced as open or closed.

**Small window.** Summary lines are cut short to fit the width.

**Slow machine.** Folded content is not drawn. Heavy editors are built only when opened, and the transcript behind a folded part is read only when it is opened.
