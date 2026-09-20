---
id: ui/components/state-rail
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/arm-the-cut-then-confirm, ux/patterns/verbs-on-the-thing-itself]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/rewind-to-where-it-went-wrong, product/try-another-direction]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/files-view, ui/surfaces/debug-view]
reuses: [ui/components/context-menu]
implemented_by: [packages/app/src/renderer/rail.ts, packages/app/src/renderer/railView.tsx]
verified_by: [packages/app/test/rail.test.ts]
mockups: [ui/assets/state-rail/success.html, ui/assets/state-rail/lobes.html, ui/assets/state-rail/folded.html, ui/assets/state-rail/pointed.html, ui/assets/state-rail/armed-cut.html, ui/assets/state-rail/deep.html]
siblings: [ui/components/instance-index, ui/components/run-step-note, ui/components/session-sheet, ui/components/file-tree]
---

# State rail

A gutter of coloured 2px lines down the left of a column of rows, one line per state the run is inside, that curves in from its parent's line with a ringed knot where a state is entered and curves back where it is left, so the rows beside it step right one level at a time.

## The rail draws how a run's states nest beside rows that say what each state did

**Use when.** A column of rows follows a run in order and each row belongs to a state path: the sheets and notes of a [run-conversation](../surfaces/run-conversation.md), or one row per state in [instance-index](instance-index.md). The host supplies the rows; the rail decides their indent and inserts the rows where a state is left.

**Do not use when.** The nesting is a folder hierarchy: [file-tree](file-tree.md) draws one hairline per level instead. The rows are not a run's history, such as a board or a settings list.

## The lines read first, their knots second and the rows beside them last

- **Lane.** A 2px vertical line in the state's hue. Hues are handed out in the order states first appear in the run, each 137.5° round the wheel from the last, at `--rail-s` saturation and `--rail-l` lightness. The same state entered twice takes the same hue, which is how a loop shows. The outermost lane, the trunk, is `--rule`.
- **Fork.** A row where a state is entered is exactly one cap tall, 34px in a conversation and 30px in the index. The new lane curves out of its parent's line from a knot, a 9px ring filled `--bg` and stroked in the new lane's hue. A state at the top level forks with the knot alone.
- **Join.** Where a state is left, its lane curves back into its parent's line in a row of its own. A state left and its sibling entered at the same depth share one row that steps sideways.
- **Lobe.** In the index, a state with nothing under it leaves its parent's line and comes straight back inside its own row, with a 7px ring at the far side.
- **Spacing.** Lanes sit 18px apart from 9px in. The gutter on each row is as wide as the lanes open on it plus 11px, so the content indents as the run goes deeper. Content rows take their own height with 7px above and below and 10px to the left.
- **Width.** The rail and its rows form one column at most 1052px wide, centred; 1472px when a band holds sheets side by side; the full panel width in the index.

## The rail has a look for nesting, folding, pointing, cutting and depth, and none for outcome

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: with no rows the rail draws nothing, and its host says what is absent, such as `No run yet.` in the index. | |
| loading | Cannot occur: the rail draws from rows already on the page. | |
| partial | Cannot occur as a look of its own: a run still going draws like a finished one, new rows are appended and no hue already drawn changes. | |
| error | Cannot occur: a lane never takes an outcome colour. A failed state keeps its hue and its row says it failed. | |
| success | Forks, straights and joins in each state's hue, the trunk in `--rule` running off the bottom of the last row, the rows indented to their depth. | [success.html](../assets/state-rail/success.html) |
| lobes | Every row a lobe or a fork, 30px each, as the index draws them. The row the reader is on carries a 15px `--accent` ring round its knot. | [lobes.html](../assets/state-rail/lobes.html) |
| folded | The folded state's rows are gone. Its fork becomes a short bump out and back with a plus in the knot, and its row reads `{state key}`, a `rolled up` tag on `--panel-2` and `{n} states` in `--dim`. The index keeps its own row instead of that line. | [folded.html](../assets/state-rail/folded.html) |
| pointed | Every stroke of the lane under the pointer brightens in every row it crosses, and a dark tag in `--text` with `--bg` letters follows the pointer naming the state. | [pointed.html](../assets/state-rail/pointed.html) |
| armed cut | A rewind is armed: a 15px `--bad` ring round the knot where it cuts, the host's counted line under that row, and every row after it at 35% opacity. | [armed-cut.html](../assets/state-rail/armed-cut.html) |
| deep | Past four levels the three deepest gaps stay 18px and each shallower gap is 0.8 of the next, so the gutter never passes 152px. Lanes closer than 2px share one 4px column striped 9px in each member's hue with 3px gaps; the trunk keeps at least 5px. | [deep.html](../assets/state-rail/deep.html) |

## Pointing lights a lane, clicking folds it, and right-clicking offers the cut

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a line, curve or knot | Lights that lane | Brightened strokes in every row and the name tag at the pointer, fading in over 90ms |
| Pointer into the gutter of a run eight or more levels deep | Spreads every gap to at least 8px while the pointer stays in the gutter | The lanes slide right; the lit lane stays the one aimed at |
| Pointer leaves the rail | Clears the light and closes the spread | Strokes and tag return to rest |
| Click on a lit lane | Folds it, or opens it when folded. In the index a lane with nothing under it goes to that state instead | Rows collapse to the rolled line and the bump, or return |
| Click on a striped column | Nothing | The spread already shows its lanes apart |
| Right-click a lane, in a conversation whose run can be cut | Offers the two cuts in a [context-menu](context-menu.md); Rewind arms the cut, Fork starts a new task | Menu at the pointer |

A fold is not saved: reopening the view shows every lane open.

## The copy is the state's name and the two cuts

| Where | String |
| --- | --- |
| Name tag, one lane | `{state key}` |
| Name tag, striped column | `{n} lanes · {state key} · {state key}` |
| Rolled line | `{state key}` · `rolled up`, drawn uppercase · `{n} state` or `{n} states` |
| Menu | `Rewind to before {state key}`, note `deletes it and everything after` · `Fork before {state key}`, note `a new task from here` |

## The rail keeps its lanes straight at any width and has no keyboard route

- Lane positions are worked out once for the run's deepest point, so a row never kinks a line; a narrower window only narrows the content beside the gutter.
- Curves stretch sideways to the gutter's width while every stroke stays 2px.
- Theme: hues keep their angle and take the theme's saturation and lightness, 55% and 44% in light, 62% and 68% in dark; trunk and rings are tokens.
- Focus: nothing on the rail is focusable. Folding and the cuts are pointer gestures; the index's chevrons and the conversation's entered rows are the keyboard route.
- Long content: a content row grows to fit, such as a wrapped reason, and its lines run its full height. The name tag never wraps.

## The rail sets two sizes by hand, a face it did not mean, and a fade by opacity

- The name tag is 11px and the rolled tag 10px, instead of multiples of a voice's base.
- The state key on the rolled line is data and renders in the app face.
- Rows after an armed cut fade with opacity instead of the `--tok-hint` register.
