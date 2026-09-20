---
id: ui/components/status-pill
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/live-facts-and-unseen-counts]
serves: [product/see-what-changed-since-you-looked, product/keep-track-of-everything, product/all-projects-in-one-place, product/everything-waiting-on-you-together]
surfaces: [ui/surfaces/sidebar, ui/surfaces/tasks-view, ui/surfaces/inbox-strip, ui/surfaces/files-view, ui/surfaces/run-view, ui/surfaces/task-context, ui/surfaces/debug-view, ui/surfaces/settings-appearance]
reuses: []
implemented_by: [packages/app/src/renderer/pill.tsx, packages/app/src/renderer/board.tsx]
verified_by: [packages/app/test/pill.test.ts]
mockups: [ui/assets/status-pill/empty.html, ui/assets/status-pill/success.html, ui/assets/status-pill/partial.html, ui/assets/status-pill/word.html, ui/assets/status-pill/badge.html]
siblings: [ui/components/sidebar-row, ui/components/project-row, ui/components/task-card, ui/components/address-bar]
---

# Status pill

A small rounded mono badge holding a status glyph and a count or a word, filled with a tint of its own colour for running and waiting work and flat for what failed, stopped or finished; a row of them ends in a coloured `+N` when room runs out, and at inspector scale the same vocabulary is one coloured glyph with no ground.

## A pill says how work stands where there is room for a glyph and a number

**Use when.** A place summarises work in little room: a sidebar row, the project crumb of the address bar, the inbox strip's total. The word form is for one task on a board card. The single glyph is for a surface that describes one task or state at a time, where timed out must read apart from failed and blocked apart from waiting: the task panel's heading, a leaf state's task list, the run panel, the self-test's verdicts.

**Do not use when.** The work has not started: queued work has no pill. The person must act on a request: gather it on the [inbox-strip](../surfaces/inbox-strip.md). The mark names a kind of thing rather than a standing: use an [icon](icon.md). A provider's or a connection's health: [provider-row](provider-row.md) carries its own dot.

## The glyph reads first, the fill says live or news, and the number follows

- **Pill.** Glyph, then a count or a word, 3px apart, in the data face at 0.8 of the data base, weight 600, tabular figures, on a 15px line with fully rounded ends and no border. The glyph is a touch smaller than the figures.
- **Live facts are filled.** `▶` running in `--accent` and `⏸` waiting in `--warn`, each on a 15% tint of its own colour. They count what is true now and never clear.
- **Unseen counts are flat.** `⛔` failed in `--bad`, `⚠` stopped in `--warn`, `✓` done in `--ok`, with no ground and 3px of side padding. They count tasks that ended since the person last looked.
- **Statuses fold into five kinds.** Waiting on a person and blocked are waiting; failed and timed out are failed; interrupted and canceled are stopped; completed is done.
- **A row of pills.** 3px apart in the order running, waiting, failed, stopped, done, folded to the room its host can spare: 96px on a sidebar row less 20px for each verb the row carries, 62px on the open project, 220px on the address bar's project crumb. The first kind present always shows, so no width hides running work. What does not fit becomes `+{n}`, counting tasks rather than kinds, flat at weight 500, in the colour of the most serious kind it hides: failed, then stopped, then waiting, then running, then done.
- **Where waiting is counted.** A project row splits waiting out of running. The Tasks and Chat rows under it cannot see a conversation waiting on an answer, so there it counts as running.
- **Badge.** One glyph centred in a 16px slot, in the face and size of its line, coloured and nothing else: `▶` running and `⚠` interrupted in `--accent`, `⏸` waiting for a person in `--warn`, `⛔` blocked, `✗` failed and `⏱` timed out in `--bad`, `✓` completed in `--ok`, `∅` canceled and `·` queued in `--dim`.

## Every state is a set of pills, a fold, a word or a bare glyph

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Nothing running, waiting or unseen: no pill and no row of pills, and the host ends at its name or twisty. | [empty.html](../assets/status-pill/empty.html) |
| loading | Cannot occur: counts describe what is loaded and change as it does. | |
| success | Every kind fits: filled live pills, then flat unseen counts, in order. | [success.html](../assets/status-pill/success.html) |
| partial | The pills that fit, then `+{n}` tinted by the worst kind folded away. The open project and rows that carry verbs have the least room, so they fold first. | [partial.html](../assets/status-pill/partial.html) |
| error | Cannot occur as a look of its own: failed work is a count or a word like any other kind. | |
| word | One task on a board card: glyph and word, filled for running and waiting, flat for failed, stopped and done. | [word.html](../assets/status-pill/word.html) |
| badge | The single coloured glyph beside a task's name in a leaf state's list, for every status including queued. | [badge.html](../assets/status-pill/badge.html) |

## Clicking a row of pills clears the news and leaves the live facts

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a row of pills that can be cleared | Nothing | Pointer cursor; flat pills and `+{n}` turn `--text`; filled pills keep their colour |
| Click that row of pills | Marks every ended task counted there as seen, each as of its own last change | Flat pills leave, and `+{n}` shrinks or leaves; filled pills stay |
| Pointer over a pill | Nothing | Tooltip names the count and the kind |
| Pointer over a word pill or a badge | Nothing | Tooltip is the raw status |

A row of pills can be cleared on sidebar rows and on the address bar's project crumb. The inbox strip's total, card pills and badges take no click of their own.

## The copy is five glyphs, five words and a count

| Where | String |
| --- | --- |
| Count pill | `▶{n}` · `⏸{n}` · `⛔{n}` · `⚠{n}` · `✓{n}` |
| Count pill tooltip | `{n} running` · `{n} waiting` · `{n} error` · `{n} warning` · `{n} success` |
| Word pill | `▶ running` · `⏸ waiting` · `⛔ failed` · `⚠ stopped` · `✓ done` |
| Word pill and badge tooltip | `{status}`, raw, such as `waiting_for_user` or `timeout` |
| Overflow | `+{n}`, tooltip `{n} more` |
| Row of pills tooltip | `mark these seen` |
| Inbox strip total tooltip | `{n} waiting on you` |
| Badge | `▶` `⏸` `⛔` `✓` `✗` `∅` `⏱` `⚠` `·` |

## Pills never wrap or shrink, and the fold is estimated at the default data size

- Resize: a pill keeps its width and the host's name truncates instead. How many pills fit is worked out from each pill's width at the default data size, so at a larger data size the pills drawn are wider than the room they were counted into.
- Theme: every colour is a token, and a filled pill's tint is mixed from its own colour, so ink and ground stay matched in both themes. Where the system font draws `⏸` and `⛔` as colour emoji, they keep the emoji's colours inside the pill.
- Focus order: pills are never focusable, so clearing counts needs a pointer. A screen reader gets each pill's tooltip and no announcement when counts change.
- Long or missing content: each extra digit widens a pill by one figure. With the sidebar collapsed to its strip, no pills show at all.

## The pill departs from the registers in two ways

- `running`, `waiting`, `failed`, `stopped` and `done` are JaiRA's words set in the data face, because a column of pills is compared like figures.
- The pill carries no register class and sets its own size at 0.8 of the data base, beside `.data-num` at 0.79.
