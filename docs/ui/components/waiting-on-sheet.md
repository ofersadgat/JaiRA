---
id: ui/components/waiting-on-sheet
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/drag-only-where-the-process-allows, ux/patterns/show-the-request-not-the-outcome, ux/patterns/say-what-it-is-doing-and-for-how-long]
serves: [product/move-work-on-by-hand, product/decisions-stay-yours]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/run-view, ui/surfaces/task-context]
reuses: [ui/components/letterhead, ui/components/icon]
implemented_by: [packages/app/src/renderer/runViews.tsx, packages/app/src/renderer/stateSurface.tsx]
verified_by: [packages/app/test/stateSurface.test.ts]
mockups: [ui/assets/waiting-on-sheet/waiting.html, ui/assets/waiting-on-sheet/no-target.html]
siblings: [ui/components/session-sheet, ui/components/letterhead, ui/components/gate-surface, ui/components/activity-strip]
---

# Waiting-on sheet

An empty sheet with a dashed amber edge and no fill at the foot of a run page, headed by an amber `WAITING ON YOU → build` line with a clock glyph and a counting duration, over the sentence `Move this task to build to carry on. Nothing downstream runs until you do.` and a filled `Advance to build` button with `— or drag the card there on the board` beside it.

## The sheet stands where a run stopped for a person to move it on

**Use when.** A run has reached a transition that waits for the person to move the task to its next stage, which on the board is a drag of its card. One sheet is drawn per such wait, oldest first, after everything the run has done.

**Do not use when.** A state asks a question or wants a decision: the [gate-surface](gate-surface.md) goes in that state's own [session-sheet](session-sheet.md) under an `ASKED OF YOU` [letterhead](letterhead.md). The run is only reported as waiting: the [activity-strip](activity-strip.md) says `Waiting for you in {path}` and offers no move.

## The amber heading reads first, then the sentence, then the move

- **Sheet.** The run page's sheet shape with a 1px dashed border, `--warn` mixed 34% into `--line`, no fill and no shadow, so the grey shows through: nothing is written on it yet.
- **Heading.** The letterhead's amber title block, filled out to the sheet's edges: a clock glyph, `waiting on you` in the data face uppercased with wide tracking, `→ {target}` in bold, and the duration at the far right, all in `--warn`. It has no chevron and does not fold.
- **Sentence.** App text in `--text`, the target named in it.
- **Move.** 11px under the sentence, a filled accent `Advance to {target}` button, 10px gap, then the drag hint in `--dim` at 0.96 of the app base. The row wraps when narrow.

## The sheet has a look with a target and a look without one

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the sheet is drawn only while a wait exists, and goes when it ends. | |
| loading | Cannot occur: the wait arrives whole, with its target, from the start. | |
| waiting | The target is known: `→ {target}`, the sentence naming it, `Advance to {target}` and the drag hint. The duration counts up while it waits. | [waiting.html](../assets/waiting-on-sheet/waiting.html) |
| no target | The wait ends the run instead of moving it: the heading and the sentence name the event, `This run is waiting for {event}.`, and no button is offered because no move could satisfy it. | [no-target.html](../assets/waiting-on-sheet/no-target.html) |
| partial | Cannot occur: between pressing the button and the run moving, the sheet stays exactly as it was. | |
| error | Cannot occur as a look of its own: a move the run no longer waits for is dropped without a word, and the sheet goes. | |
| success | Cannot occur as a look: once the run takes the move the sheet is removed and the run carries on above where it stood. | |

## Advancing asks the run to move and shows nothing until it has

| On | Does | Feedback |
| --- | --- | --- |
| `Advance to {target}` | Delivers the move to the waiting run, the same as dropping the card on that column | None at first; the sheet disappears once the run has taken the move |
| Dragging the card on the board | The same move | The same |

## The copy names the target and says what is held up

| Where | String |
| --- | --- |
| Kind | `waiting on you`, drawn uppercase |
| Heading name | `→ {target}`, or `{event}` with no target |
| Duration | `{duration}`, such as `840 ms`, `12.4 s` or `26 m 3 s` |
| Sentence, with target | `Move this task to {target} to carry on. Nothing downstream runs until you do.` |
| Sentence, without | `This run is waiting for {event}.` |
| Button | `Advance to {target}` |
| Hint | `— or drag the card there on the board` |

## The sheet stretches with the page, and only its button can be reached

- Resize: the sheet spans the column. The heading keeps its glyph, kind word, name and duration on one line; the sentence wraps; the button and hint wrap below each other when narrow.
- Theme: the dashed edge and the heading tint mix from `--warn`, so both themes keep the amber.
- Focus: the heading is hidden from screen readers and is not a control; the button is in the tab order and the sentence says where the task must go.
- Long content: a long target name widens the heading's name and the button; nothing ellipsises.

## The sheet departs from the type registers in its heading and its names

- The kind word is JaiRA's word set in the data face and uppercased.
- The target inside the sentence is data and renders in the app face.
