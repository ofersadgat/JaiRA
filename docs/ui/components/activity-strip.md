---
id: ui/components/activity-strip
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/button-says-what-will-happen, ux/patterns/arm-the-cut-then-confirm, ux/patterns/follow-the-live-edge]
serves: [product/watch-agents-work-live, product/pick-up-where-it-left-off, product/rewind-to-where-it-went-wrong, product/decisions-stay-yours, product/chat-with-agents, product/large-work-splits-into-independent-pieces]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/run-view, ui/surfaces/task-context, ui/surfaces/chat-view]
reuses: []
implemented_by: [packages/app/src/renderer/runViews.tsx, packages/app/src/renderer/taskAction.ts, packages/app/src/renderer/transcriptView.tsx, packages/app/src/renderer/transcript.ts]
verified_by: [packages/app/test/runViews.test.ts, packages/app/test/transcript.test.ts, packages/app/test/fastForward.test.ts]
mockups: [ui/assets/activity-strip/running.html, ui/assets/activity-strip/ended.html, ui/assets/activity-strip/rewind-armed.html, ui/assets/activity-strip/live-line.html, ui/assets/activity-strip/fast-forward.html]
siblings: [ui/components/composer, ui/components/waiting-on-sheet, ui/components/status-pill, ui/components/letterhead]
---

# Activity strip

A one-line bar pinned under a conversation that says what is happening there now: under a run, a rounded strip with three pulsing dots or a still dot, a sentence such as `Running ux → critique · 4 m 2 s` and the one button that stops, resumes or retries it — or, while the run is being fast-forwarded, where it is going, where it stands, how far through, and `Skip` beside `Stop`; under a chat, a thin blue-washed line with a bold blue verb such as `Thinking`, what it acts on in mono, and a counter.

## The strip speaks where nothing can be typed, and the line speaks above a chat's composer

**Use when.** A run's reading holds no conversation of its own, such as a state that only orchestrates its children: the run strip takes the composer's place and carries the run's Stop. A rewind is armed on a run: the strip becomes the confirmation, standing above the composer when the state does hold a conversation. A task is being fast-forwarded to a state ahead of it ([decision 0005](../../engineering/decisions/0005-connect.md) §4): the strip stands above the composer too, whatever state is selected, because Skip is always showing. A chat turn is in flight: the live line sits between the transcript and the composer.

**Do not use when.** The state holds a conversation and nothing is armed: the [composer](composer.md) stands there with its own stop. The run completed: nothing is drawn. The run waits for a move to its next stage: [waiting-on-sheet](waiting-on-sheet.md) offers that move in the conversation, while the strip only reports the wait. Many pieces of work are summarised at once: use [status-pill](status-pill.md).

## The marker and the sentence read first, the clock second and the button last

- **Band.** The run strip sits in a `--bg` band with 10px above, 16px at the sides and 14px below, the same band the composer occupies, so the panel edge never moves. The strip is at most 900px wide and centred.
- **Strip.** `--panel` ground, 1px `--line`, 10px corners and 9px between parts. The sentence is app text at 0.92 of the app base in `--dim`.
- **Marker.** Three 4px dots breathing in turn while the run moves; a still 6px dot in the tone's colour once it has stopped. Both sit in the same place, so the sentence starts at the same point in every form.
- **Sentence.** What is happening, then the path of child keys joined by ` → ` at 600 in `--text`. It ellipsises on one line, except the rewind confirmation, which wraps.
- **Clock.** A half-faded `·` and the time since the run started, in the data face at tabular figures, ticking once a second while running or waiting.
- **Button.** At the far right: a red-outlined `Stop` while the run goes; one filled accent verb once it has stopped; a ghost `Cancel` beside a filled `--bad` `Rewind` while a cut is armed.
- **Live line.** The full width of the chat column, a 1px `--line` rule above and a 5% `--accent` wash, 5px by 14px. The dots in `--dim`, the verb at 600 in `--accent`, what it acts on in the data face taking the rest of the width, the counter, and `Jump to live ↓` in `--accent` hard against the right edge.

## Every form is one line that names the run's condition and offers the act that changes it

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the strip always reports a run that exists, and a chat with no turn in flight draws no line. | |
| loading | Cannot occur: until the reading is known to hold no conversation, the composer stands in the strip's place. | |
| running | Three forms with the pulsing dots. `Running {path}` with the clock and `Stop`. `Waiting for you in {path}` on an amber strip, its edge `--warn` at 42% and its ground at 7%, the dots stilled in `--warn`, whenever the deepest state waits on the person or a question is on offer. `Stopping {path}` on a `--warn` tint with `Force stop` and no clock, once a stop has been asked for. | [running.html](../assets/activity-strip/running.html) |
| ended | A still dot and the one verb that fits. `Failed in {path}` on a `--bad` tint with `Retry` or `Try again`. `Interrupted in {path}` or `Stopped in {path}` on a `--warn` tint with `Resume` or `Start again`. A dashed edge with `Not started` and `Start`, or `Waiting` with `Start` or `Resume` for a task held until others finish. `Resume` and `Retry` appear when the record lets the run carry on; the start-over words appear when it does not. | [ended.html](../assets/activity-strip/ended.html) |
| fast-forward | The pulsing dots and `Fast-forwarding to {target}`, the target at 600 in `--text`; then `· at {path}` once the run has entered something on the way; then `· {n} of {m}`, the states on the way entered so far over how many there are, in the data face at 11/12.5 in `--dim`. No clock: what it counts is states. A plain `Skip to {target}` beside the red-outlined `Stop`. It replaces the running forms for as long as the fast-forward lasts, and goes the moment the target is entered, a state on the way fails, the run stops, or Skip is pressed. | [fast-forward.html](../assets/activity-strip/fast-forward.html) |
| rewind armed | A `--bad` tint and red dot, the sentence naming every state that goes and wrapping to as many lines as it needs, then `Cancel` and a filled `--bad` `Rewind` in white. It replaces whatever form the strip had. | [rewind-armed.html](../assets/activity-strip/rewind-armed.html) |
| live line | Chat only. `Thinking` or `Answering` with a counter in tenths of a second; `Writing` with the file path or tool name and the size written so far; `Running` with `{tool} · {summary}` and a counter; `Working` alone before anything arrives. `Jump to live ↓` joins once the reader has scrolled away. | [live-line.html](../assets/activity-strip/live-line.html) |
| error | Cannot occur as a look of its own: a failed run is the ended form, and a stop or send that fails puts a red line above the strip. | |
| success | Cannot occur: a run that completed draws no strip and leaves its band empty. | |

## Stop, the verb and the cut each change the strip into the form that follows

| On | Does | Feedback |
| --- | --- | --- |
| `Stop` | Stops the whole task, its children included, and withdraws a question it holds | The strip turns to `Stopping {path}`, then to the stopped form |
| `Skip to {target}` | Interrupts the state that is running, records it and every state between as skipped, and enters the target at once; the fast-forward is over and the target's questions are the person's | The strip turns to `Running {path}` in the target; the conversation shows the skipped states on the grey |
| `Stop` while fast-forwarding | Stops the run and ends the fast-forward | The strip turns to `Stopping {path}`, then to the stopped form |
| `Force stop` | Sends the stop again | The strip keeps `Stopping {path}` until the run settles, then turns to the stopped form |
| `Resume` or `Retry` | Carries the same task on, keeping every finished operation and running none again | The strip turns to `Running {path}` |
| `Try again`, `Start again` or `Start` | Runs the workflow from the top; a task that cannot begin again in place runs as a copy, and the selection follows the copy | The strip turns to `Running {path}` |
| `Start` on a held task | Refused while the tasks it waits for are unfinished | The error notice names those tasks and their status |
| Pointer on the verb | Nothing | A tooltip says what the verb keeps |
| `Rewind` | Deletes the named states and enters the first of them again | The faded rows go and the strip returns to the run's form |
| `Cancel` | Disarms the cut | The rows un-fade and the strip returns to the run's form |
| `Jump to live ↓` | Scrolls to the newest line and follows it again | The link disappears |

## The copy states the condition, the place and the act

| Where | String |
| --- | --- |
| Going | `Running {path}` · `Waiting for you in {path}`, where `{path}` is `{child key} → {child key}`, or `this run` without one |
| Clock | `{duration}`, such as `840 ms`, `2.4 s` or `4 m 2 s` |
| Stopping | `Stopping {path} — waiting for the agent to finish what it is doing` |
| Fast-forward | `Fast-forwarding to {target}` · `at {path}` · `{n} of {m}` · `Skip to {target}` · Skip's tooltip: `Stop what is running and go straight to {target}; what is between is recorded as skipped` |
| Stop buttons | `Stop` · `Force stop` |
| Stopped | `Failed` · `Interrupted` · `Stopped` · `Not started` · `Waiting`, then ` in {path}` when the run has a path |
| Verbs | `Resume` · `Retry` · `Try again` · `Start again` · `Start` |
| Verb tooltips | `Resume`: `Picks up in {states} — keeps the {n} operations this task already finished and runs nothing again`, or `Waiting for '{title}', '{title}' to complete` on a held task · `Retry`: `Re-runs the state that failed — keeps the {n} operations before it and runs none of them again` · `Try again` and `Start again`: `Runs the workflow again from the top, against the snapshot this task pinned` · `Start`: `Runs the workflow`. `operations` is `operation` for one |
| Rewind | `Rewind to before {name} — {a, b and c} are deleted and the run enters {name} again. Files edited in the worktree stay as they are.`, with `is` for one state · `Cancel` · `Rewind` |
| Live verbs | `Thinking` · `Answering` · `Writing` · `Running` · `Working` |
| Live figures | `{s.s} seconds` · `{m} m {s.s} s` · `{n} B` · `{n} KB` · `{n.n} MB` |
| Live jump | `Jump to live ↓` |

## The sentence gives way first, and nothing on either bar takes focus unasked

- Resize: the strip spans the column up to 900px and centres beyond that. The sentence ellipsises first; the dot, the clock and the button never shrink. The live line cuts what it acts on and keeps the verb and the counter whole.
- Theme: every tint is `--bad`, `--warn` or `--accent` mixed into `--panel` or over the ground, so both themes keep the tones. The Rewind button's white text is literal in both.
- Focus: the buttons are in the tab order in reading order, `Cancel` before `Rewind`. An armed cut does not move focus, and Escape does not disarm it. With reduced motion the dots hold still at half strength.
- Long or missing content: a deep path ellipsises in the strip and wraps in the rewind sentence. A run with no path says `this run` while going and the bare word once stopped. The clock is absent until the run's start is known.

## The strip departs from the type registers in its sizes, its path and one colour

- The sentence, the clock and the live line are sized at hand-set ratios of the voice bases instead of taking a register.
- The path of child keys is data and renders in the app face.
- The Rewind button's text is a literal white instead of a token.
