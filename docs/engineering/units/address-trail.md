---
id: engineering/units/address-trail
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ui/components/address-bar, ui/surfaces/run-view, ux/patterns/drill-in-and-back-out, ux/patterns/nested-under-what-caused-it, product/keep-track-of-everything]
layer: ui
owns_contracts: []
requires: [engineering/units/renderer-store, engineering/units/board-projection]
implemented_by: [packages/app/src/renderer/trail.ts, packages/app/src/renderer/crumbs.tsx, packages/app/src/renderer/files.tsx, packages/app/src/renderer/runViews.tsx, packages/app/src/renderer/store.ts]
verified_by: [packages/app/test/trail.test.ts]
siblings: [engineering/units/renderer-store, engineering/units/run-rail-geometry, engineering/units/view-addressing]
---

# Address trail

## The trail is the list of runs walked into below the open state, and the view always stands on its last step

`trail.ts` in the renderer holds the pure rules:

- `TrailStep {instanceId, stateId, name?, sidechain?}`. A step with `sidechain` walks into a subagent conversation: `instanceId` and `stateId` are its host's, and `sidechain` is the tool call id keying `SessionView.sidechains` on the host's session.
- `nodeAt` finds an instance at any depth, and `instanceOf` finds a state's newest instance that is not superseded.
- `stepOf` names a step by the instance's label, else the key its parent mounted it under, else nothing.
- `prunedTrail` cuts the trail at the first step whose instance no longer resolves to the same state, or whose host session is loaded and no longer holds its sidechain. `sameTrail` compares two trails by instance id.

Around it:

- `standingOn` in `runViews.tsx` picks what the middle column shows: the trail's last step, or the open state's newest instance when the trail is empty, with the declared children of the state stood on.
- `crumbsOf` in `files.tsx` joins folders, state segments and `runCrumbs` from `crumbs.tsx` into one address. `runCrumbs` names the base crumb by the task title with the state id prefix dropped by `shortRunName`, a deeper crumb by its name or `#<id>`, and offers the other tasks of the state at the base and the sibling instances below it.
- The store owns the list in `AppState.trail` and the declared children of a deeper tail in `trailState`.

It deliberately does not own:

- The instance tree it resolves against: [board-projection](board-projection.md), served as `TaskDetail.instances` per [task-view-models](../contracts/task-view-models.md).
- Selection, the session cache and every fetch: [renderer-store](renderer-store.md).
- Which database answers the reads: [view-addressing](view-addressing.md).

## The trail is renderer state that names one task's instances and never crosses into main

- Layer `ui`, in `packages/app/src/renderer`. `trail.ts` imports only types from `@jaira/shared/browser`.
- Boundary: renderer and main. The trail is read-only navigation; nothing it holds is sent to main except the state id `refreshTrailState` passes to `state:view`.
- No upstream seam.
- The store's writes: `select`, `openTask`, `standOn`, `drillProject` and `openDir` reset it; `openStateAt` replaces it with the instance it names; `seedTrail` puts the newest run of the open state on it after a detail lands; `walkTo` and `walkInto` replace from a level and append; `walkIntoSidechain` appends a doorway; `walkBackTo` truncates, and `walkBackTo(-1)` clears the selection with it; `refreshDetail` prunes it against every detail it receives.

## The instance tree is the truth, and the trail is a path through it

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `AppState.trail` | written by the store's navigation actions; pruned on every `task:detail` answer | the renderer | the address bar, the Files and Tasks middle columns, the context panel |
| `AppState.trailState` | fetched by `refreshTrailState` through `state:view` when the tail's state is not the open one | main's state view | `standingOn` for a deeper tail's columns |
| `TaskDetail.instances` | read to resolve every step | the task's journal, through [board-projection](board-projection.md) | the board and the task panel |
| `AppState.sessions` | read to check a sidechain step's host | main's session view | [renderer-store](renderer-store.md) |

## The invariants keep the address from describing a place that does not exist

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A step resolves at any depth, and never to an instance the task does not have | `trail.test.ts` "reaches any depth, because a walk can go to any depth", "answers nothing for an instance this task has not got" |
| 2 | A step is named by the run's label, else its mount key, and a run entered as a root has no name | `trail.test.ts` "uses the run's own name when it has one", "falls back to the key its parent mounted it under — the name on the card you clicked", "has NO name for a run entered as a root — the state is the crumb before it" |
| 3 | Pruning keeps a fully resolving trail, truncates at the first miss, empties when nothing resolves, and cuts a step whose id now names another state | `trail.test.ts` "keeps a trail whose every step still resolves", "TRUNCATES at the first miss rather than filtering — a path with a hole is not a path", "empties when the run is gone entirely — a retry restarts instance ids", "cuts a step whose id was REISSUED to a different state" |
| 4 | A sidechain step is kept while its host resolves and its session is unloaded or still holds the chain, and cut otherwise | `trail.test.ts` "keeps the step while the host resolves and its session still holds the chain", "keeps the step when the host's session is simply not fetched — absence of the cache is not evidence", "cuts the step when the loaded session no longer holds the chain", "cuts the step when its HOST no longer resolves, like any other step" |
| 5 | Two trails are the same when they name the same instances | `trail.test.ts` "compares by the instances named, which is what decides whether a patch is worth making" |
| 6 | The view stands on the trail's last step, on the state's newest run when the trail is empty, on nothing when the tail no longer resolves, and on the host of a sidechain tail | `trail.test.ts` "falls back to the file's own newest run when nothing has been walked into", "stands on the LAST element of the trail, which is what makes the bar an address", "stands on nothing when the trail names an instance the task no longer has", "says when the tail is a SUBAGENT CONVERSATION, standing on its host" |
| 7 | A deeper tail takes its columns from its own state, and a tail on the open state keeps the file's | `trail.test.ts` "takes the columns from the state it is standing on, not from the file", "keeps the file's own columns when the tail IS the file's state" |
| 8 | Run crumbs follow the file's crumbs, the last is where you stand, and clicking an earlier one truncates to it | `trail.test.ts` "appends the runs walked into, and shows the last one as where you are", "truncates to the crumb clicked, which is what walking back out means", "makes the file's own crumb a way OUT once a run is on the path" |
| 9 | A chevron at the base offers the state's other tasks, below it the sibling runs, and nothing where the only entry is the current one | `trail.test.ts` "offers the state's other RUNS before the base — which are other tasks", "offers the SIBLING runs below the base, and picking one replaces that level", "has no menu where the only entry would be where you already are" |
| 10 | Selecting another task or opening another file resets the trail rather than extending it | unasserted |

## A late answer can put the wrong run on the path until the next detail arrives

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A detail for a file no longer open lands after the next file is open | `seedTrail` ignores it | none needed | none |
| A detail for a card no longer selected lands after `openTask` selected another | the seed is ignored, because `openTask` re-checks the selection | none needed | none |
| Under `select`, a detail for the previous card in the same state lands last | `refreshDetail` does not re-check the selection, so it prunes the new trail against the old task's tree, and the seed checks only the open state | the next detail for the selected task prunes it | the path stands on the previous card's run |
| A task is rewound or its instances are removed | the next detail truncates the trail at the first removed step | none needed | the path shortens to what still exists |
| A sidechain host's session is not cached | the step is kept | the session loads and confirms or cuts it | the doorway stays on the path |
| `state:view` for a deeper tail fails | `trailState` is null and the board draws only the children that ran | none | columns for unreached children are missing |
| The same walk is applied twice | `walkTo` replaces from its index, so the trail is unchanged | none needed | none |

## The trail departs from the store's other state by being cut rather than filtered

- A trail with a missing step is truncated, never compacted, because the remaining steps would claim a descent that did not happen.
- Instance ids are durable for a task's whole life, so pruning guards rewinds and the reuse of the trail across a detail from another task, not reissued ids.
