---
id: ui/surfaces/task-context
type: ui-surface
status: shipped
updated: 2026-09-13
kind: panel
realizes: [ux/patterns/context-beside-what-you-stand-on, ux/patterns/park-and-ask, ux/patterns/drill-in-and-back-out, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/button-says-what-will-happen, ux/patterns/second-deliberate-step-for-irreversible]
serves: [product/keep-track-of-everything, product/complete-record-of-every-run, product/decisions-stay-yours, product/failures-explain-themselves, product/pick-up-where-it-left-off, product/rewind-to-where-it-went-wrong, product/review-changes-before-they-land]
components: [ui/components/task-panel, ui/components/task-name, ui/components/instance-index, ui/components/gate-surface, ui/components/transcript, ui/components/activity-strip, ui/components/composer]
mockups: [ui/assets/task-context/empty.html, ui/assets/task-context/conversation.html, ui/assets/task-context/details.html, ui/assets/task-context/subagent.html, ui/assets/task-context/gate-fallback.html, ui/assets/task-context/rewind-asked.html]
siblings: [ui/surfaces/tasks-view, ui/surfaces/context-panel, ui/surfaces/run-conversation, ui/surfaces/run-view, ui/surfaces/confirm-dialog, ui/surfaces/inbox-strip]
---

# Task context

What the Tasks room's context panel shows for the task last clicked on its board: the task's head over its whole conversation, or over its details behind a toggle. It sits right of the board or run column behind the divider, 360px wide by default, and gives way to a pinned value or to the state inspector when a column was clicked last.

## The task's name reads first, its verbs second and its record under them

- **Name.** A heading at 1.2 times the app base: the task's status as a coloured glyph, then its [task-name](../components/task-name.md).
- **Facts.** Lines in `--dim` at 0.88 of the app base: `{task id} · {workflow} · snapshot {first 12 characters}`; `⎇ {branch} · {worktree path}`, or `· worktree pending`, when the task works on a branch; `{forked from, split from or made by} {title}, {label}` with a fork glyph for a task made from another; `waiting for {titles}` with a clock glyph while it holds for other tasks.
- **Verbs.** A wrapping row: a plain button named by what it will do, which is the strip's verb for a stopped task, `Re-run` for a task that has run and `Start` for one that has not; then ghost `Cancel`, `Open state ↗` while the run stands in a state, `Review changes` when the task has a worktree, and last the reading toggle, `Details` or `Conversation`. These make up the [task-panel](../components/task-panel.md) head.
- **Conversation reading.** [run-conversation](run-conversation.md) for every state of the task, filling the panel under the head, with the [activity-strip](../components/activity-strip.md) or the [composer](../components/composer.md) pinned at its foot.
- **Details reading.** Four sections under small uppercase `--dim` headings: `Blocked`, with a red `{state id}: {reason}` line per blocked state; `Instances`, the [instance-index](../components/instance-index.md); `Live events`, a mono box of the live stream or the last twelve `{type}  {state id}` entries, or `—`; `Outputs`, the latest run's outputs as JSON.

## The panel reads the task as a conversation unless the person asks for its details

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | A task that has never run: the head offers `Start`, the page reads `This run has not entered a child yet.` and the composer is greyed with `Select a run to continue its conversation.`. | [empty.html](../assets/task-context/empty.html) |
| loading | Cannot occur: the panel reads `Select a task.` until the task has been read and then draws it whole. | |
| error | Cannot occur as a state of the panel: a failed task shows its failure in the head's glyph, the strip's `Failed in {path}` and the red letterhead or index row. | |
| conversation | The default reading. The whole task's sheets, notes and gates down the page, and the strip naming what the run is doing now. | [conversation.html](../assets/task-context/conversation.html) |
| details | The head with `Conversation` as its toggle, over the four sections, scrolling with the panel. | [details.html](../assets/task-context/details.html) |
| subagent | After `walk in →`, crumbs on a `--rule` underline read `Conversation › ⑂ {name}` over that subagent's page. Each crumb walks back, and choosing another task clears the walk. | [subagent.html](../assets/task-context/subagent.html) |
| gate fallback | A gate about the task that no sheet can hold yet is drawn at the foot of the panel under a 2px `--accent` rule, with the large heading. | [gate-fallback.html](../assets/task-context/gate-fallback.html) |
| rewind asked | `Rewind to before {name}` from an index row asks in [confirm-dialog](confirm-dialog.md) over the window: `Rewind to before {name}?`, a red note that `It and every state entered after it are deleted, and the run enters it again. Files edited in the worktree stay as they are. This cannot be undone.`, then `Rewind` in `--bad` and `Cancel`. | [rewind-asked.html](../assets/task-context/rewind-asked.html) |

A gate arriving for the task switches the panel from Details to Conversation, the one time it changes reading by itself.

## A card opens the panel and its verbs lead out of it

- A person arrives by clicking a card on the Tasks board, or by choosing an entry on the [inbox-strip](inbox-strip.md), which switches to the Tasks room with that task selected.
- The toggle switches readings in place. A state chosen in the index switches to Conversation and scrolls to where the state was entered, flashing it; when the middle column already shows this task's conversation, that column scrolls instead and the panel stays on Details.
- Right-clicking an index row offers `Go to {name} in the conversation`, `Rewind to before {name}` and `Fork before {name}`. Fork makes the new task at once.
- `Open state ↗` leaves for the [files-view](files-view.md) with the state the run stands in open.
- `Review changes` asks for a review of the worktree's changes, which arrives as a gate in the conversation.
- `Cancel` stops the task; the verb button starts, resumes or copies it as its name says.
- Clicking another card, clicking a column or pinning a value replaces the panel.

## The conversation owns the panel's height and the details scroll with it

- **Resize.** The panel is 260 to 760px wide, or up to 1200px while a value is pinned. The verbs wrap onto further rows as it narrows, and the conversation's sheets narrow with it.
- **Height.** In the conversation reading the head stays put, the page scrolls inside the panel and the strip stays at the foot. The details reading scrolls as one document.
- **Theme.** Glyphs, tones and lanes are tokens with a light and a dark value.
- **Focus.** Arriving moves focus nowhere. The verbs and the toggle are buttons in the tab order; the rewind confirmation puts focus on `Rewind`.
- **Long or missing content.** The task name wraps. The branch line and the origin and holding lines are absent when they do not apply, `Blocked` is absent when nothing is blocked, and `Outputs` is absent until a run has produced some.
- **Unsaved work.** A message typed but not sent in the composer is lost when another task is selected.
