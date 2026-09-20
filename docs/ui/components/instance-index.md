---
id: ui/components/instance-index
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/verbs-on-the-thing-itself, ux/patterns/second-deliberate-step-for-irreversible]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/failures-explain-themselves, product/rewind-to-where-it-went-wrong, product/try-another-direction]
surfaces: [ui/surfaces/task-context, ui/surfaces/files-view, ui/surfaces/debug-view]
reuses: [ui/components/state-rail, ui/components/context-menu, ui/components/icon]
implemented_by: [packages/app/src/renderer/runIndex.tsx, packages/app/src/renderer/sessionPanels.tsx, packages/app/src/renderer/detail.tsx]
verified_by: [packages/app/test/runIndex.test.ts]
mockups: [ui/assets/instance-index/empty.html, ui/assets/instance-index/success.html, ui/assets/instance-index/live.html, ui/assets/instance-index/error.html, ui/assets/instance-index/here.html, ui/assets/instance-index/folded.html]
siblings: [ui/components/letterhead, ui/components/state-rail, ui/components/task-metrics, ui/components/task-card]
---

# Instance index

An `INSTANCES` section in a task's details: one 30px row per state the run entered, each a coloured lobe or fork on a [state-rail](state-rail.md) with a status dot, the state's key in bold mono and its clock at the far right, tinted blue, amber or red where the run is working, waiting or broken.

## The index shows a run's states at a glance and leads into the conversation

**Use when.** A panel describes one task and a person needs the run's shape at a glance: which states ran, in what nesting, which one is live, asking or failed, and how long each took, with a way into each state's place in the conversation.

**Do not use when.** The person needs what a state said or produced: that is the [letterhead](letterhead.md) and the sheet under it in the run's conversation. A board of tasks uses [task-card](task-card.md). Cost and token figures belong to [task-metrics](task-metrics.md).

## The shape reads first, then each state's key, then its tone and time

- **Heading.** `Instances` as a bare section heading in the app face, uppercase in `--dim`, with a fold-all glyph at its right end when the run has a state with children below its own.
- **Gutter.** The state rail at 30px per row. A state with children opens a lane its states sit inside; a state without children is a lobe off its parent's line. Hues match the conversation's rail for the same run.
- **Chevron slot.** 15px. A state with children has a chevron in `--dim` that points left while open and down while folded; a state without keeps the slot empty so every key starts at the same x.
- **Bookmark.** The rest of the row, one button with a 5px radius: a 6px dot in `--dim` for every status, the key in the data face at weight 600 in `--text`, a failure reason in the app face in `--bad`, and the meta right-aligned in tabular figures at 85% opacity. The row's own text is mono in `--dim`.
- **Loop tag.** On the first pass of two or more identical consecutive passes, a pill after the bookmark reads `↻ {n} passes` in `--accent` on a 9% accent wash, and every pass of the loop carries a 2px accent rule on its left edge.

## Tone comes from the letterhead's rule, so the index and the conversation agree

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | The task has never run: `No run yet.` in `--dim` under the heading, with no fold-all. | [empty.html](../assets/instance-index/empty.html) |
| loading | Cannot occur: the index draws from the run the panel already holds. | |
| partial | Cannot occur: every row draws whole; a live run appends rows as states are entered. | |
| success | A finished run: every row untinted, dot, key and `{start clock} · {duration}`. A panel with no conversation beside it draws the same rows, and pointing at them changes nothing. | [success.html](../assets/instance-index/success.html) |
| live | The running path tinted `--accent` at 12% with the key in `--accent`, from the run's own row down to the state at work. A run waiting on a person tints the path `--warn` at 14% with a thin `--warn` ring and the key in `--warn`. Live meta reads `{duration} so far` and ticks every second. | [live.html](../assets/instance-index/live.html) |
| error | A failed state and the states above it that failed with it tinted `--bad` at 11% with the key in `--bad`; the failing state's reason follows its key on one line. A pass thrown away by a retry stays at 72% opacity with its key struck through, and passes around it never fold into a loop. | [error.html](../assets/instance-index/error.html) |
| here | The state the conversation is scrolled to, or the last row pressed: an `--accent` 15% fill, a 1.5px `--accent` ring, the key in `--accent`, and a ring round its knot on the rail. On a tinted row the tint stays and only the ring is added, as the asking run in live.html shows. | [here.html](../assets/instance-index/here.html) |
| folded | A folded state keeps its row with the chevron down and a `{n} states` badge on `--panel-2`, and the rail shows a bump with a plus. A folded loop becomes one row: a 3px swatch per state of the cycle, the keys joined by ` · `, and the same tag. | [folded.html](../assets/instance-index/folded.html) |

## A row goes to its state, a chevron folds, and right-click offers the cut

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a row | Nothing | Ground `--fill-ghost-hover`, text `--text` |
| Click a row | With the conversation in the middle column, scrolls it to where that state was entered and the panel stays on details. Otherwise switches the panel to the conversation, scrolled there | The place flashes for 1.2s; the here ring moves to the row |
| Click a chevron | Folds or opens the state's lane | Badge and bump appear, the rows inside go |
| Click a loop tag or a folded loop | Folds the passes into one row, or opens them | Rows merge or split |
| Click the fold-all | Folds every state below the run's own, or opens them all | The glyph swaps and its word changes |
| Click a lane in the gutter | Folds a state with children; goes to a state without | As the chevron or the row |
| Right-click a row, on the Tasks view, any state but the run's own | Opens a [context-menu](context-menu.md): go to it, rewind to before it, fork before it | Menu at the pointer. Rewind asks in a [confirm-dialog](../surfaces/confirm-dialog.md) first; Fork starts a new task at once |

Folds are not saved: reopening the task shows every state open.

## The copy is the state's key, its time and three verbs

| Where | String |
| --- | --- |
| Heading | `Instances`, drawn uppercase |
| Fold-all | `collapse all` · `expand all`, shown on hover or focus; label `Collapse all` · `Expand all` |
| Row tooltip | `go to {key} in the conversation` |
| Chevron label | `Collapse {key}` · `Expand {key}` |
| Reason | `{failure reason}`, such as `output does not match the schema: /features must be array` |
| Badge | `{n} state` · `{n} states`, drawn uppercase |
| Meta | `{start clock} · {duration}` such as `10:02:11 AM · 2 m 40 s` · `{start clock} · {duration} so far` |
| Loop tag | `↻ {n} passes`, drawn uppercase; tooltip `{n} passes of this cycle — fold them into one row` |
| Folded loop | `{key} · {key}`; tooltip `expand {n} passes` |
| Menu | `Go to {key} in the conversation` · `Rewind to before {key}`, note `deletes it and everything after` · `Fork before {key}`, note `a new task from here` |
| Rewind dialog | Title `Rewind to before {key}?`; note `It and every state entered after it are deleted, and the run enters it again. Files edited in the worktree stay as they are. This cannot be undone.`; confirm `Rewind` |
| Empty | `No run yet.` |

`{key}` is the key the parent mounted the state under, or its state id.

## The meta gives way first and the key never does

- The index takes the panel's width. The chevron, key, badge and loop tag never shrink; the reason and then the meta ellipsise, so a narrow panel loses the clock before the key.
- A run deeper than four levels squeezes its gutter as [state-rail](state-rail.md) describes, so the rows never lose more than 152px to it.
- Theme: every tint is mixed from `--accent`, `--warn` or `--bad` into `--panel`; lane hues take the theme's saturation and lightness.
- Focus: chevrons, bookmarks, loop tags and the fold-all are native buttons in tab order. The gutter and the right-click menu are pointer only.
- Missing content: a state with no start time shows no meta. Live durations tick while any state in the run is live and stop once none is.

## The index sets small words by hand and quietens by opacity

- The badge, the loop tag and the fold-all word are 9.5px and 10px instead of multiples of a voice's base.
- `states`, `passes` and `collapse all` are app words set in the data face, the first two uppercased.
- The meta and a thrown-away pass are quietened with opacity instead of the `--tok-hint` register.
