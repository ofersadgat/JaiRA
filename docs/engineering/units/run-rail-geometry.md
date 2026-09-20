---
id: engineering/units/run-rail-geometry
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ui/components/state-rail, ui/components/instance-index, ui/surfaces/run-conversation, ux/patterns/fold-to-a-summary-expand-in-place, product/complete-record-of-every-run]
layer: ui
owns_contracts: []
requires: [engineering/units/board-projection]
implemented_by: [packages/app/src/renderer/rail.ts, packages/app/src/renderer/runIndex.tsx]
verified_by: [packages/app/test/rail.test.ts, packages/app/test/runIndex.test.ts]
siblings: [engineering/units/address-trail, engineering/units/ui-layout-state, engineering/units/board-projection]
---

# Run rail geometry

## Rail geometry turns a run's ordered rows into lanes, pixel positions and one colour per state, and draws nothing

`rail.ts` in the renderer is a pure view model:

- `railOf(steps)` turns `RailStep {key, stateId, at, opens}` rows into `RailRow {open, enter?, exit?, step?, turn}` rows and the deepest lane count. Before each row it closes every open lane that does not hold the row's path, so a lane closes at the row that proves it closed. A row that opens a state forks a lane; a join directly followed by a fork at the same depth is one row; the trunk at depth 0 is never closed; a row deeper than anything open opens the missing lanes.
- `lanesOf(row)` is how many lane columns a row needs, and `insideOf(rows)` counts the lanes forked under each lane, which a folded lane reports.
- `centresFor(depth, fan)` computes the lane centres once per run from its deepest point. Gaps are indexed from the deepest lane inward, so going one deeper appends one smaller gap and never moves an existing one. `needsFan(depth)` says whether any gap is too narrow to aim at, and `fan` raises every gap to that floor.
- `stacksOf(centres)` groups lanes whose gap has fallen under 2 px into one column, never absorbing the trunk, and `stackPaint` draws a stacked column as its members' colours in turn.
- `gutterWidth(centres, lanes)` is the content indent for a row, and `forkPath`, `joinPath`, `bumpPath` and `lobePath` are the SVG paths of a row's curves.
- `paletteOf(steps)` hands each distinct state id a hue in order of first appearance, stepped by the golden angle, as `hsl(<hue> var(--rail-s) var(--rail-l))`.

`paletteOfRun(instances)` in `runIndex.tsx` walks a task's instance tree depth first and is the one list every reader of a run passes to `paletteOf`.

It deliberately does not own:

- Drawing the gutter, knots and folds: `railView.tsx`, and which folds are remembered: [ui-layout-state](ui-layout-state.md).
- Ordering the rows of a conversation, which the run conversation's bands and `sessionPanels.tsx` build.
- The instance tree the palette is built from: [board-projection](board-projection.md).

## Rail geometry is pure renderer code with no state, no IPC and no persistence

- Layer `ui`, in `packages/app/src/renderer`. `rail.ts` imports nothing.
- Consumers: `railView.tsx` draws from it, `runIndex.tsx` builds the Instances index and the palette, and `sessionPanels.tsx` builds `RailStep` rows.
- No boundary is crossed and no upstream seam is used.

## Rail geometry owns no data, and the instance tree is the truth for every colour

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `RailStep` rows | read | the caller's ordered rows | `sessionPanels.tsx`, `runIndex.tsx` |
| `RailRow` rows, centres and paths | computed per render | derived | `railView.tsx` |
| The state palette | computed from `paletteOfRun(detail.instances)` | the task's instance tree | the run conversation, the Instances index, `SessionPanel` |

## The invariants keep a live run's rail from lurching, repainting or drawing at the wrong depth

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A lane forks at the row that enters its state and is not among that row's straights | `rail.test.ts` "forks a lane where a state is entered, and leaves it out of that row's straights" |
| 2 | A lane closes at the first row that is not under it | `rail.test.ts` "closes a lane at the row that PROVES it closed, because nothing records leaving" |
| 3 | The trunk stays open through the run's last row, and every deeper lane joins back to it at the end | `rail.test.ts` "keeps the TRUNK open through the run's own rows and off the bottom — a spine, not a segment", "closes every lane UNDER the trunk at the end, so a run that ends deep joins back to it" |
| 4 | A join followed by a fork at the same depth is drawn as one row | `rail.test.ts` "merges a join with the fork that follows it at the same depth" |
| 5 | Two passes of one state are two lanes of one colour, and re-entering a state closes the first pass first | `rail.test.ts` "gives a loop TWO lanes with one colour — which is what makes a loop legible", "re-enters a state it never left, closing the first pass first" |
| 6 | A row deeper than any open lane opens the lanes it skipped | `rail.test.ts` "opens the lanes a hole in the record never mentioned, rather than drawing at the wrong depth" |
| 7 | A folded lane counts the states forked under it, not the rows | `rail.test.ts` "counts what a folded lane is standing in for, as states rather than as rows" |
| 8 | The content indent follows the lanes open on that row | `rail.test.ts` "steps in and out with the lanes open on THAT row — the content indent" |
| 9 | The gutter stays bounded at any depth, an existing gap never moves when the run goes deeper, at most one more lane stacks per level, and the trunk is never stacked | `rail.test.ts` "stays bounded however deep the run goes", "never moves an existing gap when the run goes one deeper", "stacks at most one more lane per level", "never absorbs the trunk, whatever the depth" |
| 10 | Fanning raises every gap to an aimable width and no further, and a shallow run never fans | `rail.test.ts` "opens every gap to something aimable when it is fanned, and nothing more", "does not fan a run that is shallow enough to aim at as it is" |
| 11 | One state has one colour, the colours in one run stay well apart, and a state appearing later never changes an earlier state's colour | `rail.test.ts` "gives one state one colour, however many times it is entered", "keeps every pair in a run well apart, which a hash of the state id did not", "only ever APPENDS, so a live run never repaints a lane already on screen" |
| 12 | The index and the conversation give a state the same colour, because both take the palette from the run's tree | `runIndex.test.ts` "does not move a single hue, because the palette is built from the RUN and not from the rows" |

## A mismatched row list is the only way the rail draws wrong, and nothing is ever written

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A rail is drawn with no palette passed | `railView.tsx` derives one from its own rows, so hues follow that row order | pass `paletteOfRun` of the task's instances | a state's colour differs between the conversation and the Instances index |
| The rows skip a state's entry | the missing lanes open silently at that row, with no fork drawn | none needed | lanes appear without a fork |
| A run is deep enough that gaps fall under 2 px | shallow lanes share a column painted in their colours in turn | point at the gutter to fan it | striped columns at the shallow end |
| Two writers, a killed process, a partial read or a retried write | cannot occur: every function is pure and holds nothing between renders | none needed | none |

## Every budget is a constant in `rail.ts`

- Row and lane pitch: `CAP` 34 px, `MID` 17 px, `PAD` 9 px, `PITCH` 18 px, `TAIL` 11 px.
- Squeezing: `FULL` 3 gaps at full pitch from the deep end, then each gap times `RATIO` 0.8; `MIN_GAP` 2 px stacks lanes; `ROOT_GAP` 5 px is the trunk's floor; `FAN_MIN` 8 px is the fanned floor. The lanes therefore span at most about 126 px and the gutter stays under about 152 px at any depth.
- Stack paint: 9 px segments with 3 px gaps.
- Colour: hue starts at `HUE0` 18 and steps by `GOLDEN` 137.508 degrees.

## Rail colours depart from stable per-state colours by following order of appearance

- A hue is a position in the run's list of states rather than a hash of the state id, because hashes put states of one run within a few degrees of each other. The cost is that one state has a different colour in two runs, and every reader of one run must pass the same list.
