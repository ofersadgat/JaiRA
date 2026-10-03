---
id: ui/components/placement-summary
type: ui-component
status: shipped
updated: 2026-10-02
realizes: [ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/unattended-run-never-waits-silently, ux/patterns/show-the-request-not-the-outcome]
serves: [product/nothing-stalls-in-silence, product/chat-with-agents, product/failures-explain-themselves]
surfaces: [ui/surfaces/chat-view]
reuses: [ui/components/machine-icon, ui/components/icon, ui/components/transcript]
implemented_by: [packages/universal/src/components/chat/PlacementSummary.tsx, packages/universal/src/components/chat/QueuedMessage.tsx, packages/app/src/renderer/placementSummary.ts]
verified_by: [packages/app/test/environmentModel.test.ts, packages/app/test/placementChoice.test.ts, packages/app/shots/chat-placement.mts, packages/client/src/specimens/environmentSpecimens.tsx#placement-placing, packages/client/src/specimens/environmentSpecimens.tsx#placement-waiting, packages/client/src/specimens/environmentSpecimens.tsx#placement-starting, packages/client/src/specimens/environmentSpecimens.tsx#placement-started]
mockups: [ui/assets/chat-view/placing.html, ui/assets/chat-view/queued.html, ui/assets/chat-view/starting.html, ui/assets/chat-view/placed.html]
siblings: [ui/components/transcript, ui/components/work-row, ui/components/environment-bar]
---

# Placement summary

A box of numbered phases above a conversation's first message — `Placing` with a pill reading `28 workspaces asked 28✕`, then `Starting` — each with a time at its right, and under it a foot reading `Every step`; below it the message as a dashed or amber bubble while it has not been sent.

## The summary says how a conversation came to run where it does

**Use when.** A conversation is placed: its project has more than one workspace, so the engine asks them for room before the first message is sent. It stands above that message, because the message is not sent until the conversation has somewhere to run.

**Do not use when.** The work is the agent's own: tool calls and reasoning between two messages are the [transcript](transcript.md)'s work summary, which this one is drawn like. A project with one workspace asks nobody and has no summary.

## Each phase is a row of actions, and the one in progress shows its latest

The box, its phases, their numbers, names, pills, times, the rows under the phase in progress and the foot are drawn to the transcript's work summary's measures. A pill is an action, or a count of one kind of action.

- **Placing.** Asking a workspace whether it has room is an action; one that has no room, or whose machine does not answer, is an action that failed. The pill reads `{n} workspaces asked` with a folder, and once any refused it turns `--bad` and carries the count and `✕`. Waiting before asking again is an action: `{n} waits` with a clock in `--warn`. The phase ends in where the conversation went: an arrow and `{machine} / {workspace}` in `--ok`.
- **Starting.** What was then done to get it going: `{n} worktree` with a branch glyph, `{n} snapshot` with a pin, and the launch — `launching` with the pulse and a 1.5px `--accent` ring while it is going, the agent's route with a play glyph once it has answered.
- **Rows.** Under the phase in progress, one line per action: the clock time in the data face, a glyph, the sentence, and the time so far at the right. An ask's glyph is the [machine-icon](machine-icon.md) of the machine asked, without its dot. A refused ask's glyph is `--bad` and its reason follows the sentence as a tag in `--bad` at weight 600 on a 12% `--bad` wash. A wait's row is `--warn` throughout. The action going on now stands on a 7% `--accent` wash with the pulse for its glyph.
- **Foot.** `Every step`, the count and the time, and a chevron. Pressing it opens every action in place, under the box.
- **Message.** Under the summary, at the right: the bubble the message will be. While it is being placed the bubble is at 70% opacity with a dashed edge. While it waits the bubble is an 8% wash of `--warn` over `--panel` with a dashed edge in a 50% mix of `--warn`, a pill under it reading `queued · {time}` with a clock in `--warn` on a 13% `--warn` wash, and under that `Edit` and `Delete`.

## The phases roll up as the conversation gets going

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Not placed: nothing is drawn. | |
| loading | Being placed for the first time: `Placing` in `--accent` with the pulse and one live pill reading `asking`; the message dashed and faded; the composer greyed with `Finding somewhere for this conversation to run…`. | [placing.html](../assets/chat-view/placing.html) |
| partial | Waiting: `Placing` in `--warn` with a clock, on a 7% `--warn` wash, its pills counting every workspace asked and every wait, its rows the latest round and the wait in progress; the message amber with its pill; the composer greyed with `This conversation starts when a workspace has room.`, its chips still changing what the first message runs under. | [queued.html](../assets/chat-view/queued.html) |
| error | A refusal is not a failure of the conversation: it is counted, its reason is shown on its row, and the conversation keeps waiting. | [queued.html](../assets/chat-view/queued.html) |
| starting | It has somewhere to run and has said nothing yet: `Placed` rolled up to its pills, `Starting` in `--accent` with its rows; the message sent. | [starting.html](../assets/chat-view/starting.html) |
| success | Running or finished: `Placed` and `Started`, both rolled up, above the message and everything said after it. | [placed.html](../assets/chat-view/placed.html) |

## The message can be taken back while nothing has been sent

| On | Does | Feedback |
| --- | --- | --- |
| `Every step` | Opens or closes every action under the box | The chevron turns |
| `Edit` | Takes the message back to the start box with its words, where it was sent and what it was to run under; the waiting conversation is deleted | The Chat room shows the start box with the message in it |
| `Delete` | Deletes the waiting conversation | The Chat room shows an empty start box |
| A composer chip, while waiting | Changes what the first message runs under | The chip's value |
| The [environment-bar](environment-bar.md), while waiting | Changes what the conversation waits for | The summary counts for the new choice |

## The copy counts what was asked and names where it went

| Where | String |
| --- | --- |
| Phase names | `Placing` · `Placed` · `Starting` · `Started` |
| Pills | `asking` · `{n} workspace asked` or `{n} workspaces asked`, then `{n}✕` · `{n} wait` or `{n} waits` · `sent by hand` · `{machine} / {workspace}` · `{n} worktree` · `{n} snapshot` · `launching` · `{route}` or `agent` |
| Rows | `Asked {machine} / {workspace}` · tag `refused · {reason}` · `Waiting {n} s before asking again`, `… before asking {machine} again`, `… before asking {workspace} again` · `Asked {n} workspaces before that: none had room` · `Placed on {machine} / {workspace}` · `Sent by hand to {machine} / {workspace}` · `Made the worktree for {branch}` · `Pinned {workflow} as it is now` · `Launching {route} in {workspace}` · `Launched {route} in {workspace}` |
| Reasons | The engine's own: `offline` · `not {tag}` · `no recent reading` · `{n} of {cap} running` · `busy ({n}% CPU)` · `low on memory ({n}% free)` · `out of usage ({account})` |
| Foot | `Every step` · `{n} steps · {time}` · `{n} steps · {time} so far` |
| Message pill | `queued · {time}` |
| Message verbs | `Edit`, tooltip `Take this message back to change it — the conversation has not started` · `Delete`, tooltip `Delete this message — the conversation has not started, and will not` |

The engine's own machine is named `this machine` in every pill and row.

## The summary keeps one line per phase and clips its pills

- Width: the summary takes the sheet's column. Pills that do not fit are clipped at the phase's time, which never moves.
- Time: a phase in progress counts up each second; a finished one keeps the time it took.
- Theme: every wash and tone is a token.
- A conversation that started on another workspace than the one it was asked for in is followed there: the thread, the title's chip and the bar change to the workspace that took it.

## The pills are not pressed

A pill of the transcript's work summary opens the rows it counts on hover. These pills do not: the rows of the phase in progress are already under it, and `Every step` opens the rest.
