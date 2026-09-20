---
id: ui/components/task-panel
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/button-says-what-will-happen, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/nested-under-what-caused-it, ux/patterns/context-beside-what-you-stand-on]
serves: [product/hand-work-to-agents, product/pick-up-where-it-left-off, product/parallel-work-without-collisions, product/large-work-splits-into-independent-pieces, product/failures-explain-themselves, product/complete-record-of-every-run, product/review-changes-before-they-land]
surfaces: [ui/surfaces/files-view, ui/surfaces/debug-view, ui/surfaces/task-context]
reuses: [ui/components/task-name, ui/components/instance-index, ui/components/icon]
implemented_by: [packages/app/src/renderer/detail.tsx, packages/app/src/renderer/taskAction.ts]
verified_by: [packages/app/test/runViews.test.ts]
mockups: [ui/assets/task-panel/empty.html, ui/assets/task-panel/running.html, ui/assets/task-panel/ended.html]
siblings: [ui/components/task-metrics, ui/components/instance-index, ui/components/task-card, ui/components/state-inspector]
---

# Task panel

One task described down a context panel: a status glyph and the task's name in large bold type, dim fact lines under it, a row of buttons led by the verb that starts it again, then uppercase sections for what blocks it, its instances, a boxed mono log of live events and its outputs as boxed JSON.

## The panel describes one task and offers the verbs that operate it

**Use when.** A context panel describes a task: in the Files view under a run's own facts or under a task's metrics, in the Debug view beside its test run, and on the Tasks view, where the head tops both readings of the task and the sections are its `Details` reading.

**Do not use when.** The task is one item among others on a board: that is [task-card](task-card.md). What one run or task consumed is [task-metrics](task-metrics.md), which the Files view draws above this panel. The list of a run's states is [instance-index](instance-index.md), which this panel hosts. A state described for authoring, rather than a task, is [state-inspector](state-inspector.md).

## The status and name read first, the start verb second, and the record below

- **Head line.** A 16px status glyph in its status colour, then the name drawn by [task-name](task-name.md) in the app face at the large panel size, bold.
- **Fact lines.** Small app text in `--dim`, each on its own line and wrapping freely: `{task id} · {process} · snapshot {hash}`; the branch line `⎇ {branch} · {worktree path}`; the origin line with a fork [icon](icon.md), for a task forked, split or made from another; the waiting line with a clock icon, for a task holding for others. Icons are 11px in a dimmed `--accent`.
- **Buttons.** 10px under the facts, 6px apart, wrapping. The start verb is a bordered button on `--panel-2`; `Cancel`, `Open state ↗`, `Review changes` and the host's reading switch are ghost buttons. `Open state ↗` shows where the task has an active state, and `Review changes` where it has a worktree and the host offers review.
- **Sections.** 16px apart, each under an uppercase small app caption in `--dim` with wide tracking. `BLOCKED` lists `{state id}: {reason}` in `--bad`, only when a child could not be entered. `INSTANCES` holds the instance index, or `No run yet.` in `--dim`. `LIVE EVENTS` is a box on `--bg` with a 1px `--line` edge and 8px corners holding mono lines. `OUTPUTS` is the same box holding the latest run's outputs as indented JSON, only when there are outputs.

## The glyph, the verb and which sections appear change with the task's standing

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A task that never ran: `·` in `--dim`, `Start` with the tooltip `Runs the workflow`, `No run yet.` under `INSTANCES`, `—` in the live events box, no outputs. A task holding for others adds the clock line and its `Start` tooltip names what it waits for. | [empty.html](../assets/task-panel/empty.html) |
| loading | Cannot occur in the panel: the host shows its own reading message until the task has been read, and the live events box fills line by line as events arrive. | |
| partial | Cannot occur as its own look: a running task's instances and events are what has happened so far, drawn as running. | |
| running | `▶` in `--accent`, `Re-run` with no tooltip, instances with the live state tinted, events streaming. A task parked on a question or on a child it could not enter still shows `▶`; the second adds `BLOCKED`. A task being stopped shows `·` in `--text`. | [running.html](../assets/task-panel/running.html) |
| ended | The glyph names how it ended: interrupted `⚠` in `--accent`, canceled `∅` in `--dim`, failed `✗` in `--bad`, completed `✓` in `--ok`. A stopped or failed task offers `Resume` or `Retry` where its record can be picked up, else `Start again`, or `Try again` once failed. A completed task offers `Re-run` and shows `OUTPUTS`. Three are drawn side by side. | [ended.html](../assets/task-panel/ended.html) |

## Each button does the act its word names

| On | Does | Feedback |
| --- | --- | --- |
| Pointer rests on the start verb | Nothing | Tooltip: where it picks up and how much finished work it keeps, or that it starts from the top and why resuming is unavailable, or what a holding task waits for |
| Click `Resume` or `Retry` | Continues the same task from its record, running nothing already finished | The glyph turns `▶` and events arrive |
| Click `Start`, or `Start again` or `Try again` on a task that recorded nothing | Runs the process from the top in the same task, on the snapshot it pinned | The glyph turns `▶` |
| Click `Re-run`, or `Start again` or `Try again` on a task whose record cannot be picked up | Makes a new task with the same inputs and runs it; refused while the task is running | The view moves to the new task |
| Click `Cancel` | Stops the task; the button is offered at every standing | A running task shows `·` while it stops, then `∅` |
| Click `Open state ↗` | Opens the task's deepest active state in the Files view | The Files view with that state open |
| Click `Review changes` | Starts a review of the worktree's changes | The review arrives as a request waiting on the person |
| Pointer rests on a fact line | Nothing | Branch line: the worktree path. Origin line: the origin's task id. Waiting line: each task it waits for with its status |

A holding task keeps its verb, and starting it is refused with the names of what it waits for.

## The copy states the act, what is kept and where the task came from

| Where | String |
| --- | --- |
| Id line | `{task id} · {process}` then ` · snapshot {first 12 characters of the hash}` |
| Branch line | `⎇ {branch} · {worktree path}` · `⎇ {branch} · worktree pending` |
| Origin line | `forked from {task title}, {where}` · `split from {task title}, {where}` · `made by {task title}, {where}`; `{where}` is the point a fork was cut at, or `element {n} of {mount}` then ` ({item})` for a split or made task; `a task since deleted` stands in for a missing title |
| Waiting line | `waiting for {title}, {title}` |
| Start verb | `Start` · `Resume` · `Retry` · `Start again` · `Try again` · `Re-run` |
| Start tooltip | `Runs the workflow` · `Picks up in {states} — keeps the {n} operations this task already finished and runs nothing again` · `Re-runs the state that failed — keeps the {n} operations before it and runs none of them again` · `Runs the workflow again from the top, against the snapshot this task pinned`, then ` — resuming is unavailable: {reason}` where the record cannot be read · `Waiting for '{title}', '{title}' to complete`; `operations` reads `operation` for one, and `{states}` is `this run` where none is named |
| Other buttons | `Cancel` · `Open state ↗` · `Review changes` · the Tasks view's `Conversation` or `Details` |
| Section captions | `Blocked` · `Instances` · `Live events` · `Outputs`, drawn uppercase |
| Blocked row | `{state id}: {reason}` |
| Live events | `{event type}  {state id}`, then ` → {target or outcome}`; with no live stream, the last 12 recorded events; with none, `—` |

## The panel scrolls with its column and gives long values their own scroll

- It takes the context panel's width and scrolls with the panel. Ids, branches and paths wrap rather than ellipsise; the buttons wrap onto further rows.
- The live events and outputs boxes scroll inside themselves past 220px and wrap long lines. The live events box keeps the newest 300 lines.
- Theme: glyph colours, the boxes and the captions are tokens.
- Focus: every button is a native button in the tab order with the app's focus outline, in reading order from the start verb. The fact lines, the boxes and the sections are not focusable.

## The name and the ids are data set in the app face

- The task's name, its id, the process id, the branch and the worktree path are data set in the app face.
