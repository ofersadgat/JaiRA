---
id: ui/components/transcript
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/stream-then-settle, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/arm-the-cut-then-confirm, ux/patterns/absence-is-stated, ux/patterns/say-what-it-is-doing-and-for-how-long]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/chat-with-agents, product/rewind-to-where-it-went-wrong]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/files-view]
reuses: [ui/components/message, ui/components/work-row, ui/components/icon]
implemented_by: [packages/app/src/renderer/transcriptView.tsx, packages/app/src/renderer/transcript.ts]
verified_by: [packages/app/test/transcript.test.ts, packages/app/test/transcriptCut.test.ts, packages/app/test/transcriptTime.test.ts]
mockups: [ui/assets/transcript/empty.html, ui/assets/transcript/partial.html, ui/assets/transcript/success.html, ui/assets/transcript/time-passed.html, ui/assets/transcript/armed.html, ui/assets/transcript/error.html]
siblings: [ui/components/session-sheet, ui/components/activity-strip, ui/components/computed-state-body, ui/components/gate-surface]
---

# Transcript

A white sheet with rounded corners on the grey page, carrying one conversation from top to bottom: tinted bubbles on the right for what was sent, full-width prose for answers, dense one-line rows of work between them, and small grey words where time passed.

## A transcript draws one conversation in the order it happened

**Use when.** One conversation is read whole: a chat, a subagent walked into, the conversation of a leaf state in the Files view, the body of a state on a session sheet, or a subagent's conversation opened inside its call's row.

**Do not use when.** A run has several conversations: each goes on its own [session-sheet](session-sheet.md), which holds a transcript as its body without a second sheet. A state that never spoke is drawn by [computed-state-body](computed-state-body.md), and a question put to a person by [gate-surface](gate-surface.md). What a run is doing right now, pinned at the foot, is [activity-strip](activity-strip.md).

## The words read first, the work between them second, and time last

- **Page and sheet.** Where the transcript is the whole view, a `--bg` page with 14px above, 16px at the sides and 22px below holds a `--panel` sheet with a 1px `--line` border, 12px corners and a faint shadow, at most 900px wide and centred. On a session sheet the transcript takes that sheet's body instead.
- **Column.** 12px above, 16px at the sides and 22px below, then the blocks top to bottom.
- **Messages.** Each [message](message.md): a sent bubble at the right, an answer across the full width, or a system prompt behind a rule.
- **Work.** Each stretch of work between two messages is a column of [work-row](work-row.md)s, pulled 6px outward so the glyphs line up with the prose edge, with 6px above and 10px below.
- **Fold.** A stretch of more than six rows shows only its last five under a centred line with a chevron and `{n} earlier steps`, in the app face at 12/12.5 of the app size and weight 600 in `--dim`. A row that produced a page or delivered the state's output is never folded.
- **Answer arriving.** Plain text in the app face at 13/12.5 in `--dim`, and under it three 4px breathing dots and `writing…`.
- **Time passed.** A centred word between two blocks in the data face at 10/12 of the data size, `--dim` at 66% with 0.05em tracking, spaced by how long the pause was. A new day is uppercase at 82%, weight 500, with the widest space.
- **Day chip.** In the Chat view only, a translucent pill floating at the top centre of the scroller naming the day under it in the data face at 10/12, `--dim` on 88% `--panel` with a blur, a 1px `--line` border and a soft shadow.

## The transcript shows absence, the live edge, pauses, a cut and a bad ending in place

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | One `--dim` sentence on the sheet: `Nothing has been said here yet.`, or its host's own, such as `Working…` for a chat that is running. | [empty.html](../assets/transcript/empty.html) |
| loading | Drawn by the host: a session sheet or a subagent's page reads `Loading…` until the conversation has been read. | |
| partial | A turn still in flight: sent bubbles stand above the answer arriving as plain text with `writing…`, a reasoning row counts up in `--accent`, and a call still being written shows its size. Where the Chat view's status line narrates the turn, the row for a call being written is not drawn and the reasoning row stops counting. | [partial.html](../assets/transcript/partial.html) |
| success | The settled conversation: messages with their work between them, long stretches folded to `{n} earlier steps`. | [success.html](../assets/transcript/success.html) |
| time passed | `{m} minutes later` after a pause of five minutes or more with 20px above and 16px below; `1 hour later` or `{h} hours later` from an hour with 34px and 28px; the weekday, or a short date from a week ago, on a new day with 52px and 44px. The day chip reads `Today` or a short date, at 34% while still and full strength while scrolling. | [time-passed.html](../assets/transcript/time-passed.html) |
| armed | A rewind waiting for confirmation: a `--bad` lowercase line between dashed rules reads how many messages go, and everything from it down fades to 38%, the bubbles losing their tint. | [armed.html](../assets/transcript/armed.html) |
| error | A call that did not end well closes with one more row: amber `the process ended before this call finished — everything above is what had been recorded`, or red `this call failed`. | [error.html](../assets/transcript/error.html) |

## Only the fold and the scroll belong to the transcript itself

| On | Does | Feedback |
| --- | --- | --- |
| `{n} earlier steps` | Shows the folded rows in place | The chevron turns over and the line reads `Show fewer steps` |
| `Show fewer steps` | Folds the older rows again | The chevron turns back |
| Pointer over the fold line | Nothing | Text `--text` on a 9% `--accent` wash |
| Scrolling a chat | The day chip names the day of the last message whose top has passed 30px under it | The chip brightens and fades back 900ms after scrolling stops |
| A message or a row | See [message](message.md) and [work-row](work-row.md) | |

## The copy says what is missing, what is arriving and how long the silence was

| Where | String |
| --- | --- |
| Empty | `Nothing has been said here yet.` |
| Empty, by host | `Working…` · `This conversation has not said anything yet.` · `Select a run to see what it said.` · `This subagent has not said anything yet.` |
| Fold | `{n} earlier steps` · `Show fewer steps` |
| Answer arriving | `writing…` |
| Cut | `{n} message below this line will be deleted` · `{n} messages below this line will be deleted` |
| Pause | `{m} minutes later` · `1 hour later` · `{h} hours later` · `{weekday}`, such as `Tuesday` · `{short weekday} {day} {short month}`, such as `Mon 17 Aug` |
| Day chip | `Today` · `{short weekday} {day} {short month}` |
| Bad ending | `the process ended before this call finished — everything above is what had been recorded` · `this call failed` |

## The sheet keeps a reading measure and the transcript never scrolls sideways

- Resize: the sheet narrows with its column below 900px and stays centred above it. Long unbroken text wraps anywhere; a wide value scrolls inside its own row.
- Theme: every colour is a token, and the sheet's shadow deepens in the dark theme.
- Focus: the fold line, each row that opens and each message's controls are in the tab order in reading order. Arrival moves focus nowhere.
- Missing content: a block with no time on it draws no pause before or after it, and the day chip draws nothing until a message on screen has a time. A pause is measured from the end of one block to the start of the next, so a long stretch of work never reads as a silence.
- Reduced motion: the dots stop at 55% and the day chip changes without fading.

## Three parts depart from the type registers

- The day-boundary word is data set uppercase.
- The pause words and the resting day chip are quietened with opacity rather than `--tok-hint`.
- The fold line, the arriving text and the pause words use their own multiples of the base sizes rather than a register.
