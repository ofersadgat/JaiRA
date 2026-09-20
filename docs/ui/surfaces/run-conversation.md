---
id: ui/surfaces/run-conversation
type: ui-surface
status: shipped
updated: 2026-09-13
kind: panel
realizes: [ux/patterns/stream-then-settle, ux/patterns/follow-the-live-edge, ux/patterns/park-and-ask, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/arm-the-cut-then-confirm, ux/patterns/button-says-what-will-happen, ux/patterns/nested-under-what-caused-it, ux/patterns/drill-in-and-back-out, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/decisions-stay-yours, product/agents-ask-instead-of-guessing, product/risky-actions-wait-for-approval, product/failures-explain-themselves, product/steer-agents-mid-task, product/rewind-to-where-it-went-wrong, product/try-another-direction, product/pick-up-where-it-left-off, product/move-work-on-by-hand]
components: [ui/components/state-rail, ui/components/run-step-note, ui/components/session-sheet, ui/components/concurrent-band, ui/components/letterhead, ui/components/fork-mark, ui/components/waiting-on-sheet, ui/components/computed-state-body, ui/components/gate-surface, ui/components/agent-question, ui/components/command-approval, ui/components/transcript, ui/components/message, ui/components/work-row, ui/components/activity-strip, ui/components/composer, ui/components/composer-setting-chip, ui/components/context-menu]
mockups: [ui/assets/run-conversation/empty.html, ui/assets/run-conversation/running.html, ui/assets/run-conversation/asking.html, ui/assets/run-conversation/ended.html, ui/assets/run-conversation/rewind-armed.html, ui/assets/run-conversation/subagent.html]
siblings: [ui/surfaces/run-view, ui/surfaces/task-context, ui/surfaces/chat-view]
---

# Run conversation

A run read as its conversations: sheets stacked down a grey page in the order they happened, notes about machine steps and failures written on the grey between them, a rail of coloured lanes down the left, and a strip or a composer pinned at the foot. It fills the middle column in [run-view](run-view.md) and the context panel in [task-context](task-context.md). Walking into a subagent replaces the whole page with that subagent's conversation.

## Time runs down the page and the present sits at its foot

- **Page.** `--bg` with 14px of padding at the top and sides. The rows share one measure, centred, at most 1052px wide, or 1472px when any band holds conversations that overlapped.
- **Rail.** A [state-rail](../components/state-rail.md) gutter beside every row. Each state takes a lane in a hue of its own, forking where the state is entered and curving back where it is left.
- **Rows, in time order.** A [run-step-note](../components/run-step-note.md) where a state was entered or made other tasks, in `--dim`, or where a state was blocked or failed with no sheet, in `--bad`. A [session-sheet](../components/session-sheet.md) per conversation, or a [concurrent-band](../components/concurrent-band.md) where several ran at once. A [fork-mark](../components/fork-mark.md) where a state's history divided, and one reading `forked from: {title}, {label}` between the rows a forked task copied and its own.
- **Inside a sheet.** A [letterhead](../components/letterhead.md) per state, then one body: the [transcript](../components/transcript.md) of [message](../components/message.md)s and [work-row](../components/work-row.md)s; a [gate-surface](../components/gate-surface.md) while the state asks, or as it was answered afterwards; a [computed-state-body](../components/computed-state-body.md) for a state that never spoke; or `Loading…`.
- **Under the running state's transcript.** An [agent-question](../components/agent-question.md) or a [command-approval](../components/command-approval.md) below a 2px `--accent` rule.
- **After every band.** One [waiting-on-sheet](../components/waiting-on-sheet.md) per move the run waits for.
- **Foot, outside the scroller.** When the run read holds no conversation of its own, the [activity-strip](../components/activity-strip.md) in a `--bg` band. Otherwise the [composer](../components/composer.md) with its [composer-setting-chip](../components/composer-setting-chip.md)s. A red `--bad` line with the message stands above either when a send fails. Both are at most 900px wide and centred.

## The page shows what the run did and what it waits for now

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | `This run has not entered a child yet.` in `--dim`, with the strip still under it while the run goes. With no task chosen the page is `Select a run to see what it said.` alone. Notes still draw when the first child was blocked before it spoke. | [empty.html](../assets/run-conversation/empty.html) |
| loading | A state's sheet holds `Loading…` under its letterhead until that conversation has been read. Every visible conversation is read at once, so the sheets fill together. | [running.html](../assets/run-conversation/running.html) |
| running | The running state's letterhead is an `--accent` title block, work rows appear as they happen, and the answer being written shows as plain text with a pulse and `writing…` that settles into the message. The strip reads `Running {path}` and a duration with a `Stop` button. A conversation state has the composer instead, busy, with a stop button beside send. | [running.html](../assets/run-conversation/running.html) |
| asking | A gate sits under an amber `ASKED OF YOU` title block; an agent's question or a command waiting for approval sits under the running transcript. A move the run waits for draws a dashed amber sheet after every band with `Advance to {to}`. The strip turns amber, its pulse stops, and it reads `Waiting for you in {path}`. | [asking.html](../assets/run-conversation/asking.html) |
| ended | A failed state is a red title block over its reason in `--bad` and the calls it made; a failure with no sheet is a red note on the grey. The strip names how the run stopped and offers the verb that fits: `Failed`, `Stopped` or `Interrupted in {path}` with `Retry`, `Resume`, `Try again` or `Start again`; `Stopping {path}` with `Force stop`; `Not started` or `Waiting` with `Start`. A completed run has no strip and keeps its empty band. | [ended.html](../assets/run-conversation/ended.html) |
| rewind armed | The entered row's knot is ringed in `--bad`, a line under it reads `{n} states below this line will be deleted`, and every row after it fades. The strip becomes the confirmation with `Cancel` and a filled `--bad` `Rewind`. | [rewind-armed.html](../assets/run-conversation/rewind-armed.html) |
| subagent | One sheet holding the subagent's transcript, its live turns appended as they stream, with no rail, strip or composer. It reads `Loading…` before the conversation arrives, `This subagent has not said anything yet.` when it is empty, and `This step is not a subagent conversation.` when the address points elsewhere. | [subagent.html](../assets/run-conversation/subagent.html) |

A gate's prompt is set in the small uppercase `--dim` heading style, its glyph and words pushed to opposite ends of the line, while an agent's question and a command approval take the large `--text` heading.

## Every link on the page leads to the thing it names

- A person arrives by opening a run's conversation in run-view or by selecting a task in the Tasks room.
- The workflow link beside a sheet's session id describes that state in the context panel.
- `walk in →` on a subagent's work row opens that subagent's page, adding a crumb to the address bar in run-view or to the panel's own crumbs in task-context. The crumbs walk back.
- A task named in a `split off` or `made` note selects that task. The origin chip selects the task this one was forked from; an origin since deleted reads `a task since deleted`.
- A fork chip scrolls to the other side and flashes it `--accent` for 1.2 seconds. A bookmark from the run index does the same to the entered row.
- Pointing at an entered row shows a rewind and a fork glyph; right-clicking a lane's knot offers `Rewind to before {name}` and `Fork before {name}`. Rewind arms the cut; fork makes the new task at once.
- `Advance to {to}` delivers the move. The strip's verb resumes, retries or starts the run again.

## The page follows the newest line until the reader scrolls away

- **Live edge.** While the reader is at the bottom, new rows, streamed text and opened folds keep the page pinned there. Scrolling up stops it.
- **Resize.** Sheets take the column's width up to the measure, from the 360px context panel to a wide middle column. The rail's gutter grows with the depth of the run and the content beside it narrows.
- **Theme.** Grounds, tones and lane hues are tokens with a light and a dark value.
- **Focus.** Arrival moves focus nowhere. Letterheads, links and strip buttons are in the tab order, and an entered row's glyphs appear on focus as well as on hover.
- **Remembered.** Which states are folded is kept per task and survives a restart. Whether a concurrent band shows columns or tabs is not kept.
- **Unsaved work.** A message typed but not sent, and its per-message settings, are lost when another task is selected.

## A gate's prompt departs from the type registers

- The prompt is authored text and is drawn uppercase with wide tracking, where data never takes a text transform.
