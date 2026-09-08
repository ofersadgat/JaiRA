---
id: product/tasks-workflow-index
type: product-feature
status: proposed
updated: 2026-09-01
story: "As a developer orchestrating agents across a project's workflows, I should be able to open the Tasks drawer and find the workflows that project actually has work in — and jump to one — so that I can see where my work stands without reading a board of mostly empty columns, and reach another workflow without walking the address up from wherever I am."
importance: 0.55
audience: developer
metrics:
  - "THIS FEATURE HAS NO POST-SHIP MEASURE. Read this entry before the next one, because the next one cannot be taken either. The census gate three drafts carried is DELETED (it settles only the build ORDER of two independent siblings, which is reversible and not worth a week of journal sampling — an earlier draft said no decision turned on it, which was too strong) and the `ui.seen` measure is WITHDRAWN (the sidebar's clear marks every task in the project in one gesture, stamped at each task's own clock, so the confound is invisible in the stored map). Neither should be re-proposed; both are argued in § Metrics"
  - "Walk-backs between entering Tasks and the first card interaction: median 0 after, at least 1 today from any drilled level. NOT INSTRUMENTED — it needs a navigation log the app does not have, which is not scoped in this feature. It is the only measure left, so the gate is choosing between approving an uncheckable build and requiring that log first"
requires: []
siblings: [product/chat-run-order]
---

# Tasks panel: the workflow index

> As a developer orchestrating agents across a project's workflows, I should be
> able to open the Tasks drawer and find the workflows that project actually has
> work in — and jump to one — so that I can see where my work stands without
> reading a board of mostly empty columns, and reach another workflow without
> walking the address up from wherever I am.

The drawer under the Tasks row lists one entry per workflow the person has work
in, within a project. Clicking one drills that project's board to that workflow,
so the middle column stops being a stack of per-project sections and becomes the
board of the thing you named.

## What the brief asked for, and what this is

The brief is one sentence — "a list item per top level workflow that you can
click on to show the task view contents of that workflow" — and it contains three
phrases that each admit more than one reading, plus a fourth question it never
raised. All four are resolved here rather than in the build, so the gate can
overrule any of them.

**"A workflow" — the definition, or the run?** A row is a **workflow**, and its
count is how many tasks live in it. Three concurrent runs of `feature` are one
row with a count of three, not three rows.

- *Why.* This is already the codebase's grouping: `rootsBoard` makes one column
  per workflow and files every task into it as a card (`stateViews.ts:605`,
  `:696`). A row per run would be the board's cards hoisted into the drawer,
  which is the middle column's job, and it would make the panel's row count grow
  without bound while the thing it indexes stays fixed.
- *What it costs, and to which half.* The developer running one workflow three
  times over, in one project, gets a **one-row index**. That is not "no index",
  and the feature splits cleanly around it:

  - The **enumerating** half still serves them. A drawer that says "`feature`, 3
    running" answers what the activity is about, which today's answers nothing.
    That does not need a second row and it is not gated on anything.
  - The **choosing-between-rows** half does not, and cannot: with one row there is
    nothing to choose. Getting back up from depth to a *single* workflow's board
    is already what `TaskAddressBar` does. This is the half that carries the
    difference between importance 0.55 and 0.45 — by argument, since the census
    read that used to score it is deleted; see § Metrics.

**"Top level" — the top of the state tree, or the top of the task tree?** The
phrase admits both readings, they are about different trees, and **the same rule
answers both**.

- *The top of the state tree.* A workflow is a tree of states, so "top level
  workflow" reads as "the workflow itself, not the states inside it". Rows are
  workflows; a child state never gets its own row. This falls straight out of
  reusing the board's grouping — `rootsBoard` makes a column per workflow, and
  depth within one is `boardPathOf`'s business, not the drawer's
  (`stateViews.ts:605`, `:674`).
- *The top of the task tree.* A run can spawn other tasks, so "top level" also
  reads as "the tasks nobody spawned". The answer is the `homeOf` roll-up: a
  spawned task **files under its topmost ancestor's workflow** rather than
  claiming a row of its own (`stateViews.ts:638`). So a workflow that only ever
  runs as somebody's child has no row, and its tasks are counted in the row of
  the flow that started them.
- *Why the second reading is not "drop them".* Rolling up and dropping look alike
  from the outside and differ in the count: dropped, a row's number disagrees
  with the board column it opens. Argued in Scope § Necessary.

**"Show the contents" — drill, or describe?** Clicking a row **drills** the
board — the middle column narrows to that workflow. The alternative was
`selectWorkflow`, which fills the right-hand panel with the workflow's state
description and leaves the middle where it was (`onSelectColumn`,
`App.tsx:1845`).

- *Why drill.* "Task view contents" names the Tasks view's own middle column, and
  describe already has a route: single-clicking the column. A panel that
  described would be a second way to reach a surface that is one click away on
  screen; a panel that drills is the only way to reach that board from depth.
- *The third reading, rejected outright.* `openTask` (`App.tsx:1852`) opens one
  run. A workflow row has N tasks and no single task to open, so this reading
  needs a rule for which one — and any such rule is a priority claim the person
  did not make.

**What is a row, when there is more than one project?** The brief does not ask,
but the answer decides how many rows the panel draws. **A row is a (project,
workflow) pair.** The same workflow run in two projects is two rows, and at the
root address the list is **sectioned by project** rather than flat.

- *Why the destination forces it.* The click calls `drillProject(project, level)`,
  which writes `levels[project]` and sets `taskFocus` to that project
  (`store.ts:2526-2530`). A row with no project in it has nowhere to go. And the
  ambiguity is not hypothetical: "the project travels with it: a shared root is a
  column on every board, and the run the panel would start belongs to the one it
  was clicked on" (`App.tsx:1842-1844`) — one workflow id legitimately has runs
  under several projects.
- *Why the grouping forces it too.* The roll-up rule this reuses is per-project
  by construction. `rootsBoard` takes one `Project` (`stateViews.ts:605`), and
  `homeOf` walks `parentTaskId` through **that project's** summaries only,
  stopping where the records do: "a parent this project holds no row for … leaves
  the child where it stands" (`stateViews.ts:634-638`). A flat cross-project row
  could not reuse that walk; it would need a second grouping rule that disagrees
  with the board's on exactly the subsidiary tasks the walk exists for.
- *What it costs, and which way.* It **widens** the panel: a person running
  `feature` in two projects gets 2 rows where a workflow-only row gives 1. The
  decision is made on the destination and the walk, but a reader should know
  which direction it moves the list before they picture one.
- *What it does not cost.* At a project address the project segment is redundant
  and is not drawn; the rows read as plain workflows. The sectioning is visible
  only at the root, where the person already asked for more than one project.
- *The residue.* A task with no workflow at all is keyed by its title, because
  that is what the board does with it (`keyOf`, `stateViews.ts:626`). Those rows
  exist and are not special-cased; the panel says the same thing the board says.

**"Has work in" — one definition, used everywhere below.** The story's central
phrase decides which tasks put a row on screen. Settled, once:

> A project **has work in** a workflow when it holds a task filed under that
> workflow by the roll-up rule — **whatever that task's status**, running or
> ended.

This is the board's own population, not a new one: `ProjectSummary` carries
`tasks`, `running`, `waiting` and `ended` side by side (`view.ts:777-815`), and
the board draws cards for stopped tasks as well as live ones. It is bounded by
retention rather than by any window this panel invents — when pruning drops a
task, its row's count falls and the row leaves with the last of them.

Two consequences worth stating rather than discovering later.

*A workflow whose last run ended months ago **is** a row.* That is deliberate —
the drawer's job is to say where the project has work, and a project has work in
a flow it ran and stopped — but it also means the row count grows with retention
rather than with activity, which is what makes any count over this population
useless as a threshold.

*And the rows creep toward the board's columns as a project is used.* The rows
are always a subset of the columns, and the gap is exactly the authored workflows
nothing has run within retention. On a fully exercised project the two lists
coincide. That bears on § Where this fits (what the build-time cut can and cannot
rest on), on § Value (which half of the story decays and which does not), and on
§ Metrics (which half of the importance number is soft). It is drawn in all three
rather than left here as an aside about counting.

## Where this fits

- **Serves** — the developer orchestrating coding agents (`principles.md`, "Who
  we serve"). Files' drawer lists files and the middle shows a file; Chat's lists
  conversations and the middle shows a conversation; the Tasks row is built with
  `counts` and `onSeen` and nothing else — no `panel` key at all
  (`App.tsx:1403-1412`, against the Chat row's `panel:` at `App.tsx:1419` and the
  Files row's at `App.tsx:1435`). This is the missing third: **a side panel
  enumerates the one kind of thing its activity is about, and the middle shows one
  of them.** The row's identity above is that contract applied honestly: the
  middle shows one project's board drilled to one workflow, so the row names both.
  Without this, Tasks is the only activity whose drawer teaches nothing about the
  gesture the other two share.

- **Neighbors** —

  - *This is not the board's column strip*, even though at the root board level
    the columns **are** workflows and their double-click calls the very same
    `drillProject` this panel would call (`board.tsx:333` → `App.tsx:1847` →
    `store.ts:2526`). Two distinctions keep this from being a second route to one
    view.

    **The column route exists only at the root level; the panel route exists at
    every depth.** Once you have drilled into a workflow, its columns are that
    workflow's child states — there is no longer any workflow on screen, and the
    only way to a sibling workflow is back up the address. That is the trip this
    removes.

    **And the two lists are usually not the same list — but they converge.** The
    board's columns are built from `browser.workflows` — every workflow the
    project has a *file* for — plus a column for any workflow it has run without
    one (`stateViews.ts:608`, `:620`). Empty columns are not dropped: the renderer
    maps every column and passes `empty="—"` for a count of zero (`board.tsx:678`,
    `:684`). So the column strip answers **"what could I start here"** and the
    panel answers **"where do I have work"**. On a project with twenty authored
    workflows and runs in two, they differ by eighteen rows.

    **The relation stated exactly, because it decides what the build-time cut can
    rest on.** Every panel row is also a column: a workflow with a retained task
    either has a file (so `browser.workflows` lists it) or does not (so
    `stateViews.ts:620` adds a column for it anyway). **The panel's rows are a
    subset of the columns, always.** The difference between them is exactly *the
    authored workflows with no retained task* — and, given "has work in" as fixed
    above, any task at any status bounded only by retention, that set **shrinks as
    a project is used**. On a project where every authored workflow has been run
    once inside the retention window, the two lists are the same set, and the
    story's "without reading a board of mostly empty columns" buys nothing there.

    **Two consequences, and only one of them is a cut condition.**

    - *The filtering half of the value decays with project age.* It is largest on
      a project with many authored-and-unrun flows and reaches zero on a fully
      exercised one. That is a bound on the story's first clause and it is drawn
      in § Value and in § Metrics rather than left as a fact about thresholds.
    - *The reachability half does not decay at all, and it is what the cut must be
      tested against.* The column strip exists only at the root board level.
      Drilled into a workflow, the columns are that workflow's child states and no
      workflow is on screen — so even where the two lists hold identical sets, one
      of them is reachable from where the person is standing and the other is not.

    So the cut condition is narrow: **if the build offers the panel only where the
    column strip already is, cut it** rather than ship the duplicate route. Set
    coincidence is *not* a second trigger — it is a fact about how old and how
    exercised a given project is, not about the build, so the same binary would be
    a duplicate on one project and not on another. A build cannot be cut on a
    condition it does not control and that varies per user. The codebase has
    refused the shape the narrowed condition names once already: there is no root
    Files row because "a root Files row would open the same tree a project row
    opens — two ways to one view" (`App.tsx:267`).

  - *This is not Chat's list.* A conversation is addressed by turn, a workflow by
    state, and the two sets are disjoint by stored workflow id —
    `isChatWorkflow(task.workflow)` partitions them and `App.tsx:1407-1410`
    literally computes Tasks' counts as project counts **minus** chat counts
    (`minusCounts`). Nothing is reachable from both, so neither list can show the
    other's rows.

    **But they share a drawer, and both sibling features put a status treatment in
    it.** That is true of the chrome even though it is false of the rows, and the
    shared constraint holds on one half only.

    *Where it holds — here.* This feature's per-row roll-up aggregates the statuses
    of N tasks, and the row opens that project's board column, where those same
    tasks are drawn split into lanes. So the roll-up should count in **lanes**
    (`LANES`, `board.tsx:32`; `laneOf`, `:50`; `lanesOf`, `:72-84`) rather than
    coining a third vocabulary — a row reading "2 running, 1 paused" is a promise
    about the surface one click away, and any other set of words makes it a
    promise the board does not keep.

    *Where it does not — the sibling's group boundary.* There are four lanes and
    [chat-run-order](chat-run-order.md) draws one line, and **the line crosses the
    taxonomy rather than refining it**. Its unsettled group spans all four lanes
    (`queued` → not-started, `running`/`stopping` → running or paused,
    `interrupted` → paused, `failed` → finished) and its settled group is a strict
    subset of one (`completed` and `canceled`, both finished, `board.tsx:51-56`).
    No lane names either group, so a rule line or a heading over one **cannot** be
    labelled from this vocabulary, and a per-row lane label would print "Finished"
    on both sides of the boundary. That is structural rather than a single argued
    exception. What the two panels genuinely share is the name for **one task's
    status**; what the constraint never reached is the name for a **grouping** the
    board has no name for.

    One more thing it does not say: the rows are not the same shape. Chat's marks
    are per-row booleans over one task (`unread`, `chatPane.tsx:286`; `answering`,
    `:295`), while a workflow row aggregates over N tasks and has no watermark
    equivalent, so `WorkflowListPanel` shares vocabulary with `ChatListPanel` and
    not a row component.

  - *This is not the address bar.* `TaskAddressBar` says where you are standing;
    this says where you could stand instead. If a later pass makes the panel a
    full ancestors-plus-siblings tree, one of the two becomes redundant — see
    Framings considered.

- **Depends on / used by** — nothing must ship first. Both inputs to the grouping
  are already stored columns on `TaskSummary`: `workflow` (`view.ts:841`) and
  `parentTaskId` (`view.ts:844-850`, which the roll-up walks), both already
  returned by `task:list` and `task:all` and already held as an array in the
  renderer. The project stamp the row needs is already on `ProjectTask`
  (`view.ts:832-834`), which exists precisely because "a row in a cross-project
  list that cannot say whose task it is cannot be opened".

- **History** — replaces nothing; the Tasks drawer has never had contents. It
  reverses the implicit decision that the board's columns are a sufficient index
  of workflows, which holds only at the root level.

## Value

Today, reaching workflow B while standing inside workflow A costs a walk back up
the address until the board is at the root listing, then a drill down into B. The
panel makes that one click from any depth. The cost being removed is not clicks so
much as **re-orientation**: the walk-up redraws the middle column two or three
times on the way, and each redraw is a screen the person has to read to confirm
they are where they meant to go.

The second thing it buys is a census — **per project**, which is what the
destination action can deliver. For each project: which workflows do I have work
in, in the sense fixed above, a task filed there at any status rather than only a
run in flight. That is not currently answerable from the drawer at all, and on the
board it is answerable only by reading the **counts** rather than the headers —
the headers list every workflow the project has a file for whether or not anything
has ever run in it, and an empty column is drawn with a "—" rather than dropped
(`stateViews.ts:608`, `board.tsx:684`). At the root address the sections stack, so
the census across projects is a scroll rather than a lie.

**And that second thing is worth less on an old project than on a new one.** The
panel's rows are a subset of the board's columns and the gap between them is the
authored workflows nothing has run within retention (§ Where this fits). That gap
closes as a project is used: on one where every authored flow has been run once
and not yet pruned, the census is the column strip's own headers, and the story's
"without reading a board of mostly empty columns" describes a board that is no
longer mostly empty.

**What survives that is the first paragraph, not the second.** Re-orientation cost
is about where you are standing, not about how many columns are drawn — drilled
into a workflow there are no workflow columns at all, whatever the project's age,
so the one click from depth is worth the same on day one and on day four hundred.
The two halves of this feature age differently, and the durable one is the smaller
of the two: the census is the floor's warrant and it decays, the jump is the
delta's and it does not. That is stated plainly because it is a reason a person
might rank this feature differently for a mature project than for a fresh one, and
nothing else in this doc would have told them.

## Scope

**Necessary**

- A `WorkflowListPanel` on the Tasks row: one row per distinct (project,
  workflow) pair the project **has work in** — the definition fixed in § What the
  brief asked for, which is every task the project holds at any status, grouped by
  **the same rule the board already uses**: a task spawned by another files under
  its topmost ancestor's workflow, found by walking `parentTaskId` up within its
  own project (`homeOf`, `stateViews.ts:638`), with the walk stopping where the
  records do.

  The rule is a roll-up and not a filter on `parentTaskId === undefined`. That
  reading **drops** subsidiary tasks instead of rolling them up, so a row's count
  would disagree with the count on the board column it opens — the same workflow,
  two numbers, and the panel is the one that would be wrong. Reusing `homeOf` is
  also the cheaper answer: the rule and its edge cases are already written down
  and already tested.
- Click drills that project's board to that workflow —
  `drillProject(project, workflow)`, which already sets `levels[project]` and
  `taskFocus` together (`store.ts:2526-2530`). No new renderer state field.
- At the root address, rows sectioned by project; at a project address, that
  project's rows with the project segment suppressed.
- The panel must be reachable at every board depth, not only at the root
  listing. This is the clause that makes it not a duplicate route — and it is
  **necessary but free**. The sidebar row is assembled from `atSummary` and
  `atChats` and never reads `levels`, the drill-depth state (`App.tsx:1402-1412`
  against `store.ts:2526-2530`), so a `panel` hangs off the row at every depth
  exactly as `ChatListPanel` and `FileTreePanel` already do. Nothing has to be
  built to satisfy this and code would have to be added to violate it. It stays in
  the necessary set as a constraint a build must not break, not as work a build
  must do.
- **A count and a status roll-up per row**, counted in the board's lanes for the
  reason given in § Where this fits. The story's first half is *seeing where work
  stands*, and a bare list of workflow names does not say that — a row reading
  `feature` is a row you still have to open. Both numbers derive from the same
  `TaskSummary` array the rows are already grouped from, so this costs nothing the
  panel is not already paying. It rests on the story alone; an earlier draft also
  rested it on carrying the one post-ship measure, and that measure is withdrawn
  (§ Metrics).

  **And it is an addition to the brief, which was not being recorded anywhere the
  gate reads.** The issue asks for "a list item per top level workflow that you can
  click on" — an item and a click, no numbers on it. The catalog's departures table
  held only reductions, so every narrowing of the brief was offered back and every
  widening of it was invisible. This clause and the sibling's group boundary are
  the two; they are now in [index.md](index.md) § Added beyond the brief, and
  § Open questions asks a person whether this one should exist rather than only how
  it should be worded.

**Sufficient** — the five above.

**Nice to have**

- Subsidiary tasks shown *individually*, nested under the row that already counts
  them — adds "what did this flow spawn" without a second surface. The roll-up
  above is what makes the count right; this is what would make it legible.

## Cost

Renderer only. No new IPC channel, no new persisted field, no migration. The
panel is a `useMemo` over an array the store already refreshes, so there is no
recomputation to keep in step and nothing to invalidate. The project stamp the
sectioning needs is already on the cross-project rows.

## Metrics

**This feature has no post-ship measure at all.** That is what the gate is being
handed, not a caveat on a row. Earlier drafts carried four rows — two pre-build
census reads, one `ui.seen` measure, one navigation measure nobody can take. The
census reads are **deleted** because the only thing they settle is a reversible
ordering choice; the `ui.seen` row is **withdrawn** because it cannot attribute.
Both arguments are below, so neither is re-proposed. (An earlier draft said the
census was deleted because *no decision* turned on it. That was too strong — one
does — and the corrected version is below.)

| Metric | Read from | Success | Instrumented? |
| --- | --- | --- | --- |
| Walk-backs between entering Tasks and the first card interaction | a navigation log | median 0; today at least 1 from any drilled level | **No** — the log does not exist, and this feature does not scope it |

One row, uninstrumented. **Nothing here measures the gesture the issue literally
asked for** — a clickable item that shows a workflow's task view contents — and
nothing measures anything else either.

**The story's second clause ships unmeasurable.** "Reach another workflow without
walking the address up" is a trip not taken, and nothing in any store records where
a person was standing. `levels` is in-memory, last-value renderer state
(`store.ts:544`), initialised `{}` (`:822`) and patched on every drill (`:2528`);
there is no time series and nothing to replay. The one row above is the measure
that would settle it, and it cannot be taken.

**The first clause is in the same position, and the measure that used to cover it
does not attribute.** That measure was `seen[taskId] < updatedAt` over
`ProjectSummary.ended`, offered as evidence that the per-row status roll-up told
somebody something. It is not evidence about a row. The Tasks sidebar row's clear
gesture is `onSeen: () => actions.markSeenAll(runsOf(atSummary))`
(`App.tsx:1411`), wired straight to the Pills' `onClear` (`sidebar.tsx:327`), and
`runsOf` returns **every** unseen non-chat task in the project
(`App.tsx:1330-1333`). One click marks the lot. A falling median is therefore
equally consistent with *"the roll-up told me something about this workflow"* and
with *"the panel gave me a reason to visit the row, and I cleared the pills while I
was there"* — and the second reading is the one this feature causes most directly,
because filling an empty drawer is exactly a reason to visit the row.

**The confound cannot be filtered out afterwards, which is what withdraws the row
rather than merely weakening it.** `markSeenAll` takes `{taskId, at}` pairs and
stamps each task at **its own clock** rather than at the moment of the click
(`store.ts:3227`, over marks `runsOf` builds from each task's own `at`). So a bulk
clear leaves a `seen` map indistinguishable from one produced by reading every task
individually: no shared timestamp, no cohort, nothing in the data to detect it by.
A measure whose confound is invisible in its own signal is not a measure with a
caveat on it.

Repairing it would mean giving the panel a **per-row** seen mark — a clear scoped
to one workflow — which is a gesture nobody asked for, added to a read-only listing
for the sole purpose of instrumenting it. That is the wrong trade and it is named
rather than taken.

**The sibling is exposed to the same bulk clear and survives it, for a reason that
does not transfer here.** `App.tsx:1417` clears Chat's rows the same way. But
`ChatListPanel` already ships, so its before/after compares one surface against
itself with the same clear gesture on both sides and only the order changing
between the samples. Here the panel itself is the change, so a visit to the row is
precisely what the feature causes — the confound is correlated with the treatment.
Same signal, same weakness, opposite verdict, and the asymmetry is the reason.

**The census gate is deleted, and the importance number is now set by argument.**
Two earlier drafts gated this feature on a stored-history read: the share of
sampled moments with two or more (project, workflow) pairs live at once,
conjunctive with the share of runs sitting below the root of their own state tree,
both at one in four. The read **cuts nothing** — the drawer at every depth is free
because the sidebar row never reads `levels` (`App.tsx:1402-1412` against
`store.ts:2526-2530`), and drilling on click is the brief's own instruction — which
leaves it able to do one thing: move the number between 0.55 and 0.45.

**The gate still goes, but the argument for deleting it was overstated and rested
on a false premise.** Both halves are corrected here, because the conclusion
survives on a weaker claim and the strong one does not.

*The false premise.* An earlier pass quoted [index.md](index.md) saying
`chat-run-order` "carries neither; it is smaller and it ships", and used it to
conclude that risk sequencing puts the sibling first whatever the census returned.
The sibling carries **two** live conditions: its first metric is a pre-build read
with an explicit don't-build outcome, and its value metric needs a before-sample
nobody has been assigned ([chat-run-order](chat-run-order.md) § Metrics, § Open
questions). The catalog sentence is corrected there and in index.md, and any
argument that leaned on it has to be re-made.

*The overstatement.* "No outcome of the read changes what anyone does next" does
not follow. Under value sequencing it plainly does: a passing read gives 0.55
against 0.45 and this feature goes first; a failing read gives a tie that cost then
breaks toward the sibling, whose build is one field, one spread and one `useMemo`
(§ Cost, there) against a whole new panel here. That is a different order, so the
read moves something.

*What is actually true, and it is enough.* **The only thing it moves is the order
of two features that neither require nor block each other** — `requires: []` on
both sides, and index.md's graph draws a sibling relation rather than a dependency.
So getting the order wrong costs the delay of one feature behind another and
nothing else: whichever goes second is built exactly as it would have been, and the
choice can be reversed on any morning by picking up the other one. Against that
sits a working week of hourly journal sampling plus two threshold arguments to
settle before the sampling starts. **A week of measurement to settle a reversible
ordering choice is the wrong trade**, and that — not the impossibility of the read
mattering — is why the gate is deleted. Note also that the sibling's own pre-build
read can come back shallow, in which case there is no second feature and no order
to decide at all; the census would have been taken to sequence against something
that was not being built.

So the number stands on argument, offered to the gate as a judgement to overrule
rather than a threshold to verify:

- **0.45 is the floor, and the floor is the drawer.** The Tasks drawer is the only
  one of the three panels that enumerates nothing, and a panel that enumerates
  nothing is a broken contract however many workflows anyone runs. That parity
  claim is not ranked below a re-sort of a list that already enumerates, which puts
  this level with the sibling and not under it. Beside it sits a second, weaker
  warrant — that the rows are a *filtered* list where the board's columns are the
  whole authored set — and the paragraph after these bullets is about how that one
  decays.
- **0.55 is that floor plus the jump from depth**, argued from structure rather
  than from population: once you have drilled into a workflow, its columns are that
  workflow's child states, so no workflow is on screen and the only route to a
  sibling is back up the address. That holds for anyone who drills at all, and it
  needs no census to establish that people drill — the board is what drilling is
  for.

**The floor rests on two warrants stacked, and one of them decays** — which cuts
against the number rather than for it. The parity claim is a contract claim: the
Tasks drawer enumerates nothing while the other two enumerate, and that is broken
however many rows a person would get. The *filtering* claim is a population claim:
the panel shows where work is where the columns show everything authored. But the
panel's rows are a subset of the columns and the gap is the authored-and-unrun
flows, so on a fully exercised project the filtering warrant is worth nothing and
the floor is left standing on the contract alone (§ Where this fits, § Value). The
delta has no such exposure: drilled in, there are no workflow columns at all, at
any project age.

So the two numbers age in opposite directions, and it is the **floor** that is
soft. A gate ranking this feature for a mature, fully exercised project should
know that it is buying 0.10 of durable jump plus a contract repair, not 0.45 of
census. That is a reason to overrule the number in one direction for one kind of
project, and it is offered as such.

What the census would have answered is *how many* people are in that position,
which is a question about the size of the served population. It is worth asking on
the day someone is choosing between this feature and a third one, where the answer
would settle something that is not reversible by picking up the other item on
Monday. It was not worth a week to order two siblings.

*Three things the deleted gate got right, kept so they are not re-derived by
whoever asks the population question later.* The read had to come from the
**journal**, not from `task_runtime`: `beginTask` overwrites `started_at` and
clears `ended_at` on every start (`runtime.ts:157-165`), so a resumed task reports
one interval where it lived through several, and a concurrency read would lose
exactly the long-running work most likely to overlap with something else — while
the journal keeps every instance's own `startedAt` / `endedAt` (`view.ts:85-86`),
subject to pruning. "Two or more pairs **live at once**" is a **lower bound** on
rows offered rather than an estimate of them, since a row exists for any retained
task at any status; the wider count grows with retention alone and could never
fail. And depth would have been read from `boardPathOf` (`projection.ts:338`,
`stateViews.ts:674`), which is where a **run** sits in its state tree and not what
the person had on screen — run nesting standing in for viewport depth, which was
always the weakest link in it.

**So what is the gate being asked?** Not a threshold. Two things:

1. **Approve a build nobody can check afterwards, or require the navigation log
   first.** Those are the options and there is not a third; the log is not scoped
   here and nobody has decided to build it. Note which way this cuts: the
   higher-ranked of the two features is the one with nothing to verify it, while
   the smaller, cheaper, lower-ranked sibling carries a value measure that moves.
2. **Overrule 0.55 by argument if the argument is wrong**, since there is no read
   standing behind it any more.

**Importance did not fall because of any of this.** The scale in
[index.md](index.md) is value if shipped and explicitly not confidence, not cost
and not risk, so a feature that cannot be measured is not thereby worth less. It
is worth the same and known less well, and those are kept apart deliberately.

Deliberately omitted: panel opens and row clicks, which would both rise if the
panel were popular and useless.

## Framings considered

Each row stands on its own reasoning. Two passes tried to raise the resume-queue
row's argument into a standing amendment and both attempts failed their own
reader's test — the first forbade this feature along with the alternative, the
second picked the alternative as the *better* of the two. The row's concrete
reasons are unaffected; what is withdrawn is the claim that they generalise.
Recorded so the same generalisation is not attempted a fourth time without reading
why it failed twice: see § Framings in [chat-run-order](chat-run-order.md) and the
exceptions section of [index.md](index.md).

| Framing | Why not |
| --- | --- |
| Do nothing — the board's columns are the workflow list | True only at the root board level, and at the root it is **less wrong than a filtering argument alone would suggest**. The columns are every authored workflow, empty ones included (`stateViews.ts:608`, `board.tsx:684`), so they differ from the panel's rows by the authored-and-unrun set — which is large on a young project and **empty on a fully exercised one**, where "do nothing" gets you the same set one surface over. What survives that convergence is the other half: drilled in, no workflow is on screen at all, which is exactly when you want one. So this framing is rejected on reachability, and only partly on content. |
| A row per run rather than per workflow | This is the board's cards moved into the panel, and the panel would then grow with the work rather than with the index. It also costs the feature its shape: the middle shows one of the thing the panel lists, and a panel of runs makes the middle a run — the task view, not the board. See § What the brief asked for. |
| A row that *describes* the workflow rather than drilling to it | `selectWorkflow` already does exactly this from the column strip (`App.tsx:1845`), so the panel would be a second route to a surface already one click away — the shape refused at `App.tsx:267`. |
| A flat cross-project row — one row per workflow id, however many projects it runs in | No destination: `drillProject` takes a project (`store.ts:2526`), and a shared root is a column on every board (`App.tsx:1843`). It also needs a second grouping rule, because `homeOf`'s walk is scoped to one project's records by design (`stateViews.ts:634`). Sectioning by project keeps one rule and one click. |
| Panel as resume queue — rank rows by what is waiting on a human | Two reasons, neither of which is that the state is underivable — it is derivable, from stored `call.waiting` / `call.settled` events (`projection.ts:180-195`). **Cost:** the wait state is folded per task from that task's own journal, and there is no cross-task listing of it in persistence or IPC — a panel ranking every project's rows by it needs a channel that does not exist. (An earlier version of this row rested the same point on `runs` being indexed `(task_id, id)`; that table was retired by migration 16, so the index argument is gone and the missing channel is what is left of it.) **Shape:** the sort key erases itself when you use it — answering the top row is exactly what clears its wait, promoting another row into the place your cursor is already travelling to, and a wait can also clear because the *agent* moved on while you read. A workflow index has neither problem: it answers "where do I have work" rather than "what should I do next", and a row is where it was yesterday even when the order is wrong. |
| Panel as address — one tree of ancestors plus siblings-at-depth from `state.trail` | Rewrites Files' panel (held fixed this pass), subsumes `ChatListPanel`, and collides with `TaskAddressBar` such that one of the two becomes redundant — a decision that has to be won before anything is built. Reopen alongside that address bar, not as a panel change. |

## Open questions

| Question | Resolved by |
| --- | --- |
| **The feature ships with nothing that can check it afterwards.** Approve that, or require a navigation log first — which is unscoped work nobody has committed to. This is the first question, not the last, because it is the only one whose answer changes what happens next. | the gate |
| **Is 0.55 right, now that it rests on argument rather than a read?** The census gate is deleted (§ Metrics): 0.45 is the floor and the extra 0.10 is the jump-from-depth claim. Both halves are argued from code, neither is measured, and the number is a judgement offered to be overruled. **Ask it twice if the projects in question are mature**: the floor stacks a contract warrant that holds always on a filtering warrant that goes to zero once every authored workflow has been run within retention, so the softness is in the larger number and not the smaller one. | the gate |
| A row is a workflow and not a run; clicking it drills rather than describes; a row carries its project. Three substitutions on the brief's wording, all argued in § What the brief asked for, all the kind a person should get to overrule. | the gate |
| The one-project-one-workflow person gets the drawer but not the jump. Is that split the right shape, or should the panel simply not ship at one row? | the gate |
| **Should the count and status roll-up exist at all?** The brief asks for "a list item per top level workflow that you can click on" and nothing about numbers on it, and this clause sits in the *necessary* set — so, like the sibling's group boundary, it is an addition a gate would approve without being offered it. The argument is that a bare list of names does not deliver "see where my work stands" (§ Scope); the counter is that the board one click away already draws those tasks. Recorded in [index.md](index.md) § Added beyond the brief. | the gate |
| **Does the panel row stay distinguishable from the root column's double-click in the built UI?** Cut it if the build offers the panel only where the column strip already is — that is the whole of the condition, and it is about **where the panel is reachable from**, not about what it lists. Set coincidence is not a trigger: the rows are a subset of the columns and the two sets meet on any project whose authored flows have all been run within retention (§ Where this fits), which is a fact about the project rather than the build and would make the same binary a duplicate for one person and not another. | build phase |
| Does the per-row roll-up count in the board's lanes, given that the row opens a board column drawn in exactly those lanes? Argued in § Where this fits; the wording of a row is still a design choice. Only reachable if the roll-up survives the gate row above. | design phase |
