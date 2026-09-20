---
id: ui/components/computed-state-body
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/absence-is-stated]
serves: [product/complete-record-of-every-run, product/failures-explain-themselves]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/value-view, ui/components/icon]
implemented_by: [packages/app/src/renderer/runViews.tsx, packages/app/src/renderer/transcript.ts]
verified_by: [packages/app/test/callBlock.test.ts]
mockups: [ui/assets/computed-state-body/empty.html, ui/assets/computed-state-body/partial.html, ui/assets/computed-state-body/success.html, ui/assets/computed-state-body/inputs.html, ui/assets/computed-state-body/error.html]
siblings: [ui/components/letterhead, ui/components/transcript, ui/components/gate-surface, ui/components/run-value-field]
---

# Computed state body

The body under the letterhead of a state that did not speak: a red mono sentence when it failed, then one block per function it called, each a sigma glyph and the function's name in bold over dim argument names with one-line values and a small `RETURNED` value, or, when it called nothing, the inputs it was given as the same name-over-value lines.

## A computed state body is the account of a state that has no conversation to show

**Use when.** A state on a session sheet computed its outputs, called functions to produce them, or failed. A failed state shows this body in place of any transcript, so its reason is the first line under its red [letterhead](letterhead.md). A settled gate's `Show the record` opens one call block drawn the same way.

**Do not use when.** The state spoke and did not fail: its [transcript](transcript.md) is the body. A gate is asking or was answered: [gate-surface](gate-surface.md) draws the control. A conversation's tool call is a [work-row](work-row.md). The value a state's slot produced, read beside its declaration, is a [run-value-field](run-value-field.md).

## The failure reads first, then each call's name, its arguments and what it returned

- **Failure.** The reason in the data face at the data base size in `--bad`, at most 62 characters wide and breaking inside long ids. The first call block starts directly under it with no space between.
- **Call head.** The sigma [icon](icon.md) in `--dim`, 7px, then the function's short name at weight 600 in `--text` at the data base size, with its full reference as the tooltip. A call that did not complete adds its status word, uppercase in the data face at 10/12 of the data size with 0.08em tracking in `--warn`. 8px under the head.
- **Arguments.** One pair per argument, 4px apart and 10px above the result: the name in the data face at 11/12 in `--dim`, then 2px lower the value's preview at the data base size in `--text`, on one line ending in an ellipsis, with the preview again as its tooltip.
- **Result.** A [value-view](value-view.md) labelled `returned`, or `error` for a call that failed, leading with its JSON reading.
- **Several calls.** Stacked, never boxed, in the order they were made. Each block after the first has 14px above a 1px `--line` rule and 12px below it.
- **Inputs.** With no calls, the state's inputs as the same pairs, 10px apart, with no tooltip and nothing under them.

## Every state keeps the same pairs and changes what stands above and below them

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | The state was entered with no inputs and called nothing: `Nothing was bound to this run.` in `--dim`, alone under the letterhead. | [empty.html](../assets/computed-state-body/empty.html) |
| loading | Cannot occur: the body is drawn from the run's record before any conversation is read, so it never waits. A call whose record was trimmed from history is left out rather than drawn empty. | |
| partial | A call that never completed, such as one cut short when its run was stopped: `OPEN` in `--warn` beside its name, its arguments, and no value under them. Calls that finished before it keep their results. | [partial.html](../assets/computed-state-body/partial.html) |
| success | Every call the state made, each with the value it returned. | [success.html](../assets/computed-state-body/success.html) |
| inputs | A state that worked out its outputs from what it was given, calling nothing: its inputs as name-over-value pairs. | [inputs.html](../assets/computed-state-body/inputs.html) |
| error | A red title block over the reason. A failed computed state keeps every call under the reason, those that succeeded with `RETURNED` and the failed one with `FAILED` and an `ERROR` value. A failed conversation state shows the reason alone. | [error.html](../assets/computed-state-body/error.html) |

## The body is read, and only its values take input

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a function's name | Nothing | The tooltip shows the full reference |
| Pointer over an argument's value | Nothing | The tooltip repeats the preview, so a value cut by a narrow sheet can be read |
| A reading or `…` in a result's header | As [value-view](value-view.md) describes | The result redraws in that reading |
| The letterhead above | Folds the body away | As [letterhead](letterhead.md) describes |

## The copy is the record's own words and bounded previews

| Where | String |
| --- | --- |
| Nothing bound | `Nothing was bound to this run.` |
| Function name | `{function name}`, else `{call kind}`, else `call` |
| Function name tooltip | `{function reference}` |
| Status word | `{record status}`, only when not completed, such as `open` or `failed`, drawn uppercase |
| Result label | `returned` · `error`, drawn uppercase |
| Failure | `{reason}`, such as `output 'mustAsk': no function is registered under confidence.mustAsk` |
| Value preview | `"{text}"`, cut to `"{first 48 characters}…"` · `{n} items` for a list and `{n} fields` for an object when their JSON passes 48 characters, otherwise the JSON · `{number}` · `true` · `false` · `null` · `—` for no value |

## The body spans its sheet and keeps every line but the failure to one line

- Width is the sheet's, from the 360px context panel to a wide conversation column. Names and previews never wrap; a preview ends in an ellipsis. The failure wraps inside its 62-character measure.
- A result keeps the height bounds and sideways scrolling that value-view gives it, so a long JSON value never widens the sheet.
- Theme: `--bad`, `--warn`, `--dim`, `--text` and `--line` are tokens with a light and a dark value.
- Focus: nothing in the body takes focus except each result's reading switch and `…`, reached by Tab in page order.
- Missing content: a call with no arguments goes from its head straight to its result; a call with neither is its head alone.

## Two words in the body cross the voices

- The function name is data set in the app face.
- The status word is set in the data face and uppercased.
