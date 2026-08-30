---
id: product/tasks-workflow-index
type: product-feature
status: proposed
updated: 2026-08-28
story: "As a developer orchestrating agents across a project's workflows, I should be able to open the Tasks drawer and find the workflows that project actually has work in — and jump to one — so that I can see where my work stands without reading a board of mostly empty columns, and reach another workflow without walking the address up from wherever I am."
importance: 0.55
audience: developer
metrics:
  - "Gate condition A: share of sampled moments where two or more distinct (project, workflow) pairs were LIVE AT ONCE, over stored run history — at or above one in four. A deliberate lower bound on rows offered, not an estimate of them; the panel lists ended work too"
  - "Gate condition B: share of runs whose board path is non-empty — at or above one in four, so there is a depth to be stranded at. Conjunctive with A: both gate the JUMPING half only, neither can cut the panel, and either can pass while the other fails"
  - "How long an ENDED task goes unlooked-at (`ui.seen` against `ProjectSummary.ended[].updatedAt`, a frozen clock), sampled before and after — the median falls. This measures the per-row roll-up, which is the one necessary clause carrying a post-ship measure"
  - "Walk-backs between entering Tasks and the first card interaction: median 0 after, at least 1 today from any drilled level. Not instrumented and not substitutable — see Metrics"
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
click on to show the task view contents of that workflow" — and it contains two
phrases that each admit more than one reading, plus a third question it never
raised. All three are resolved here rather than in the build, so the gate can
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
  times over, in one project, gets a **one-row index**. The previous draft called
  that "no index" and wrote the person off, and then justified the feature's
  importance on a claim — the empty drawer — that a one-row index satisfies
  perfectly well. Both cannot be true. Scoped properly:

  - The **enumerating** half still serves them. A drawer that says "`feature`, 3
    running" is a drawer that answers what the activity is about, which today's
    answers nothing. That does not need a second row and it is not gated on
    anything.
  - The **choosing-between-rows** half does not, and cannot: with one row there is
    nothing to choose. Getting back up from depth to a *single* workflow's board
    is already what `TaskAddressBar` does. This is the half the census gate below
    decides, and if the gate fails it is the half that is cut — not the panel.

**"Show the contents" — drill, or describe?** Clicking a row **drills** the
board — the middle column narrows to that workflow. The alternative was
`selectWorkflow`, which fills the right-hand panel with the workflow's state
description and leaves the middle where it was (`App.tsx:1754`).

- *Why drill.* "Task view contents" names the Tasks view's own middle column, and
  describe already has a route: single-clicking the column. A panel that
  described would be a second way to reach a surface that is one click away on
  screen; a panel that drills is the only way to reach that board from depth.
- *The third reading, rejected outright.* `openTask` (`App.tsx:1761`) opens one
  run. A workflow row has N tasks and no single task to open, so this reading
  needs a rule for which one — and any such rule is a priority claim the person
  did not make.

**What is a row, when there is more than one project?** The brief does not ask
and the previous draft did not answer, but the answer decides this feature's own
cut gate, so it is settled here. **A row is a (project, workflow) pair.** The
same workflow run in two projects is two rows, and at the root address the list
is **sectioned by project** rather than flat.

- *Why the destination forces it.* The click calls `drillProject(project, level)`,
  which writes `levels[project]` and sets `taskFocus` to that project
  (`store.ts:2532-2535`). A row with no project in it has nowhere to go. And the
  ambiguity is not hypothetical: "a shared root is a column on every board"
  (`App.tsx:1752`) — one workflow id legitimately has runs under several
  projects.
- *Why the grouping forces it too.* The roll-up rule this reuses is per-project
  by construction. `rootsBoard` takes one `Project` (`stateViews.ts:605`), and
  `homeOf` walks `parentTaskId` through **that project's** summaries only,
  stopping where the records do: "a parent this project holds no row for … leaves
  the child where it stands" (`stateViews.ts:634-638`). A flat cross-project row
  could not reuse that walk; it would need a second grouping rule that disagrees
  with the board's on exactly the subsidiary tasks the walk exists for.
- *What it costs, and which way.* It **raises** the number the cut gate reads: a
  person running `feature` in two projects now counts 2 where the previous draft
  counted 1. The decision is made on the destination and the walk, and it would
  be the same decision if it lowered the number — but a reader should know which
  way it cuts before they read the number.
- *What it does not cost.* At a project address the project segment is redundant
  and is not drawn; the rows read as plain workflows. The sectioning is visible
  only at the root, where the person already asked for more than one project.
- *The residue.* A task with no workflow at all is keyed by its title, because
  that is what the board does with it (`keyOf`, `stateViews.ts:626`). Those rows
  exist and are not special-cased; the panel says the same thing the board says.

**"Has work in" — one definition, used everywhere below.** The story's central
phrase was previously left to context, and this doc resolved it three
incompatible ways: Scope grouped over all tasks with no time filter, § Value
asserted the same, and the cut gate measured something narrower — concurrently
*running* pairs. A reader could not tell which population a row belonged to, and
the gate could have cut a half of the feature on a number unrelated to how many
rows the panel offers. Settled, once:

> A project **has work in** a workflow when it holds a task filed under that
> workflow by the roll-up rule — **whatever that task's status**, running or
> ended.

This is the board's own population, not a new one: `ProjectSummary` carries
`tasks`, `running`, `waiting` and `ended` side by side (`view.ts:790-821`), and
the board draws cards for stopped tasks as well as live ones. It is bounded by
retention rather than by any window this panel invents — when pruning drops a
task, its row's count falls and the row leaves with the last of them.

Two consequences worth stating rather than discovering later. A workflow whose
last run ended months ago **is** a row, which is deliberate: the third metric
below measures exactly those rows, and under a running-only reading that metric
would have had nothing to read. And the cut gate is **narrower than this on
purpose** — it asks how often two or more pairs were live *at the same moment*,
which is a lower bound on rows offered, not an estimate of them. That narrowing
is argued where the gate is stated; the point here is that it is one noun with a
declared window, not two nouns.

## Where this fits

- **Serves** — the developer orchestrating coding agents (`principles.md`, "Who
  we serve"). Files' drawer lists files and the middle shows a file; Chat's lists
  conversations and the middle shows a conversation; the Tasks row is built with
  counts and nothing else — no `panel` key at all (`App.tsx:1307-1317`, against
  `App.tsx:1324` next to it). This is the missing third: **a side panel enumerates
  the one kind of thing its activity is about, and the middle shows one of them.**
  The row's identity above is that contract applied honestly: the middle shows one
  project's board drilled to one workflow, so the row names both. Without this,
  Tasks is the only activity whose drawer teaches nothing about the gesture the
  other two share.

- **Neighbors** —

  - *This is not the board's column strip*, even though at the root board level
    the columns **are** workflows and their double-click calls the very same
    `drillProject` this panel would call (`App.tsx:1756`, `store.ts:2532`). Two
    distinctions keep this from being a second route to one view:

    **The column route exists only at the root level; the panel route exists at
    every depth.** Once you have drilled into a workflow, its columns are that
    workflow's child states — there is no longer any workflow on screen, and the
    only way to a sibling workflow is back up the address. That is the trip this
    removes.

    **And the two lists are not the same list.** The board's columns are built
    from `browser.workflows` — every workflow the project has a *file* for —
    plus a column for any workflow it has run without one (`stateViews.ts:608`,
    `:620`). Empty columns are not dropped: the renderer maps every column and
    draws "—" for a count of zero (`board.tsx:653`, `:659`). So the column strip
    answers **"what could I start here"** and the panel answers **"where do I
    have work"**. On a project with twenty authored workflows and runs in two,
    they differ by eighteen rows.

    If the build cannot hold either line — if the panel ends up offered only
    where the columns already are, listing the same set — cut it rather than
    ship the duplicate. The codebase has refused this exact shape once already:
    there is no root Files row because "a root Files row would open the same tree
    a project row opens — two ways to one view" (`App.tsx:265`).

  - *This is not Chat's list.* A conversation is addressed by turn, a workflow by
    state, and the two sets are disjoint by stored workflow id —
    `isChatWorkflow(task.workflow)` partitions them and `App.tsx:1312` literally
    computes Tasks' counts as project counts **minus** chat counts. Nothing is
    reachable from both, so neither list needs to mention the other.

  - *This is not the address bar.* `TaskAddressBar` says where you are standing;
    this says where you could stand instead. If a later pass makes the panel a
    full ancestors-plus-siblings tree, one of the two becomes redundant — see
    Framings considered.

- **Depends on / used by** — nothing must ship first. Both inputs to the grouping
  are already stored columns on `TaskSummary`: `workflow` (`view.ts:847`) and
  `parentTaskId` (`view.ts:856`, which the roll-up walks), both already returned
  by `task:list` and `task:all` and already held as an array in the renderer. The
  project stamp the row needs is already on `ProjectTask` (`view.ts:838`), which
  exists precisely because "a row in a cross-project list that cannot say whose
  task it is cannot be opened".

- **History** — replaces nothing; the Tasks drawer has never had contents. It
  reverses the implicit decision that the board's columns are a sufficient index
  of workflows, which holds only at the root level.

## Value

Today, reaching workflow B while standing inside workflow A costs a walk back up
the address until the board is at the root listing again, then a drill down into
B. The panel makes that one click from any depth. The cost being removed is not
clicks so much as **re-orientation**: the walk-up redraws the middle column two
or three times on the way, and each redraw is a screen the person has to read to
confirm they are where they meant to go.

The second thing it buys is a census — **per project**, which is the correction
the previous draft needed. It claimed the panel "answers it flat, across
projects", which the destination action cannot do. What it answers is: for each
project, which workflows do I have work in — in the sense fixed above, a task
filed there at any status, not only a run in flight. That is not currently
answerable from the drawer at all, and on the board it is answerable only by
reading the **counts** rather than the headers — the headers list every workflow
the project has a file for whether or not anything has ever run in it, and an
empty column is drawn with a "—" rather than dropped (`stateViews.ts:608`,
`board.tsx:659`). At the root address the sections stack, so the census across
projects is a scroll rather than a lie.

## Scope

**Necessary**

- A `WorkflowListPanel` on the Tasks row: one row per distinct (project,
  workflow) pair the project **has work in** — the definition fixed in § What the
  brief asked for, which is every task the project holds at any status, grouped by
  **the same rule the board already uses** — a task spawned by another files under
  its topmost ancestor's workflow,
  found by walking `parentTaskId` up within its own project (`homeOf`,
  `stateViews.ts:638`), with the walk stopping where the records do.

  This corrects the previous draft, which said "tasks with
  `parentTaskId === undefined`". That reading **drops** subsidiary tasks instead
  of rolling them up, so a row's count would disagree with the count on the
  board column it opens — the same workflow, two numbers, and the panel is the
  one that would be wrong. Reusing `homeOf` is also the cheaper answer: the rule
  and its edge cases are already written down and already tested.
- Click drills that project's board to that workflow —
  `drillProject(project, workflow)`, which already sets `levels[project]` and
  `taskFocus` together (`store.ts:2532`). No new renderer state field.
- At the root address, rows sectioned by project; at a project address, that
  project's rows with the project segment suppressed.
- The panel must be reachable at every board depth, not only at the root
  listing. This is the clause that makes it not a duplicate route; it is
  necessary, not cosmetic.
- **A count and a status roll-up per row.** Moved up from *sufficient*, where the
  previous draft had it, and the reason is worth stating because the previous
  arrangement had the set inverted against the evidence: everything in the
  necessary list above is unmeasurable after shipping, and the one thing that can
  be measured had been scoped as an optional extra. A build could then satisfy
  every necessary clause and ship with nothing to check afterwards.

  It also earns the place on its own. The story's first half is seeing where work
  stands, and a bare list of workflow names does not say that — a row that reads
  `feature` is a row you still have to open. Both numbers derive from the same
  `TaskSummary` array the rows are already grouped from, so this costs nothing
  the panel is not already paying.

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

| Metric | Read from | Success | Instrumented? |
| --- | --- | --- | --- |
| **Gate, condition A.** Share of sampled moments at which **two or more** distinct (project, workflow) pairs were **live at once** — a run in flight in each, by the roll-up rule above | task files (`workflow`, `parentTaskId`, project) joined to `runs.started_at` / `runs.ended_at` in the stored database, sampled hourly across a working week | at or above **one in four** | **Yes** — an offline read over stored history. **Pre-build gate on the jumping half only** |
| **Gate, condition B.** Share of runs whose `boardPathOf` is non-empty (`stateViews.ts:674`) — whether there is a depth to be stranded at in the first place | replay of stored `state_machine_events` through the existing projection | at or above **one in four** | **Yes** — same read, same gate, same half |
| How long an ended task goes unlooked-at — `seen[taskId] < updatedAt` over `ProjectSummary.ended` — sampled before and after | the persisted read watermark (`JairaUiState.seen`, `settings.ts:82`; the Tasks row already marks against it, `App.tsx:1316`) | the median falls | **Partly** — nothing new to log, but it is last-value and the "before" must be sampled prior to shipping |
| Walk-backs between entering Tasks and the first card interaction | navigation events | median 0; today at least 1 from any drilled level | **No** — needs a navigation log the app does not have |

**Say it plainly: the story's second clause ships unmeasurable, and the gate is
being asked to accept that.** "Reach another workflow without walking the address
up" is a trip not taken, and nothing in any store records where a person was
standing. `levels` is in-memory, last-value renderer state (`store.ts:544`),
initialised `{}` (`:822`) and patched on every drill (`:2534`); there is no time
series and nothing to replay. Row four is the measure that would settle it and row
four cannot be taken. That is a real gap in this deliverable, not a footnote, and
the previous draft's error was to leave it implied. The story's *first* clause —
seeing where work stands from the drawer — is not in the same position: row three
bears on it, narrowly.

**Row three is what can be measured, and it now measures something the feature is
required to have.** The previous draft's arrangement was inverted: this row
measured the status roll-up, and the roll-up was scoped *sufficient* — so nothing
in the necessary set had a post-ship measure and a conforming build could ship
entirely unchecked. The roll-up has moved into Scope § Necessary, which is the
repair; this row did not change. What it reads: `ui.seen` already watermarks task
rows, not only conversations — the Tasks row's own unseen counts are computed from
it (`App.tsx:1312-1316`). Today that count is one number for a whole project; the
panel breaks it out per workflow. If that helps, ended work gets looked at sooner
and the median falls.

It is still a **narrower claim than the story's first clause**, and that is
labelled rather than papered over: the roll-up is evidence that the drawer says
something useful, not that the walk-up was avoided. The measured set is
`ProjectSummary.ended` on purpose — an ended task's `updatedAt` is frozen, so the
watermark can catch up to it. A running task moves its own clock and is unread by
construction for as long as it runs, which would make this a measure of run
duration instead. The sibling doc restricts its equivalent metric the same way and
for the same reason.

**Rows one and two are one gate with two conditions, and they cut one half.** Both
are pre-build reads that do not move after shipping. Neither can cut the panel —
the enumerating half is ungated, for the reason given in § What the brief asked
for — and the previous draft's row two said "flat runs cut the feature outright",
which contradicted that split in the row directly beneath the row that installed
it. Corrected: **both conditions gate the jumping half, and both must hold.**

*Why both, rather than one.* They can disagree, which is what makes the second
one worth reading. Condition A can pass while every run is flat: several
workflows live at once, but nobody is ever below the root listing, where the
column strip already offers every workflow and there is no walk-up to save.
Condition B can pass while A fails: runs go deep, but only ever one at a time, so
there is no second row to jump to. The jumping half is worth a route only where
both are true, so they are conjunctive rather than alternative — and stated that
way, neither is redundant with the other.

*Why A's window is narrower than the noun, deliberately.* "Has work in" counts a
task at any status; condition A counts only pairs with a run **in flight at the
same moment**. That is a smaller number on purpose, and naming the gap is the
point: the panel offers a row for every retained pair, so A is a **lower bound on
rows offered, not an estimate of them**. Under the wider reading the count only
grows with retention and the threshold could never fire, which is the defect the
old row two had. A gate that cannot fail is not a gate. The narrower window is
also the one the claim needs: the trip being removed is between two things you are
working on now, not between one you are working on and one you finished in March.

*Why one in four for B, and what it is a proxy for.* `boardPathOf(run)` is the
run's own active-or-stopped path, computed per card to decide which column it
belongs in (`stateViews.ts:664`). It says how deep a **run** sits in its
workflow's state tree, not what the person had on screen — run nesting standing in
for viewport depth. That substitution is the weakest link in this gate and it is
labelled rather than hidden: the quantity the claim wants is unmeasurable for the
same reason row four is. The threshold matches A's because it answers the same
shape of question — below one in four, the stranded-at-depth case is rarer than
the cost of the second route.

Deliberately omitted: panel opens and row clicks, which would both rise if the
panel were popular and useless.

## Framings considered

Each row stands on its own reasoning, and this pass **withdraws** the standing
amendment two previous passes tried to build on the resume-queue row. Both
attempts to state that row's argument as a general principle failed their own
reader's test — the first forbade this feature along with the alternative, the
second picked the alternative as the *better* of the two. The row's concrete
reasons are unaffected and are given below; what is withdrawn is the claim that
they generalise. Recorded here rather than dropped silently so the same
generalisation is not attempted a fourth time without reading why it failed
twice: see § Framings in [chat-run-order](chat-run-order.md) and the exceptions
section of [index.md](index.md).

| Framing | Why not |
| --- | --- |
| Do nothing — the board's columns are the workflow list | True only at the root board level, and even there the columns are a different set: every authored workflow, empty ones included (`stateViews.ts:608`, `board.tsx:659`). Drilled in, no workflow is on screen at all, which is exactly when you want one. |
| A row per run rather than per workflow | This is the board's cards moved into the panel, and the panel would then grow with the work rather than with the index. It also costs the feature its shape: the middle shows one of the thing the panel lists, and a panel of runs makes the middle a run — the task view, not the board. See § What the brief asked for. |
| A row that *describes* the workflow rather than drilling to it | `selectWorkflow` already does exactly this from the column strip (`App.tsx:1754`), so the panel would be a second route to a surface already one click away — the shape refused at `App.tsx:265`. |
| A flat cross-project row — one row per workflow id, however many projects it runs in | No destination: `drillProject` takes a project (`store.ts:2532`), and a shared root is a column on every board (`App.tsx:1752`). It also needs a second grouping rule, because `homeOf`'s walk is scoped to one project's records by design (`stateViews.ts:634`). Sectioning by project keeps one rule and one click. |
| Panel as resume queue — rank rows by what is waiting on a human | Two reasons, neither of which is that the state is underivable — it is derivable, from stored `call.waiting` / `call.settled` events (`projection.ts:180-195`). **Cost:** it needs a cross-task run-listing channel and index that do not exist (`runs` is indexed `(task_id, id)`, readable only per task). **Shape:** the sort key erases itself when you use it — answering the top row is exactly what clears its wait, promoting another row into the place your cursor is already travelling to, and a wait can also clear because the *agent* moved on while you read. A workflow index has neither problem: it answers "where do I have work" rather than "what should I do next", and a row is where it was yesterday even when the order is wrong. |
| Panel as address — one tree of ancestors plus siblings-at-depth from `state.trail` | Rewrites Files' panel (held fixed this pass), subsumes `ChatListPanel`, and collides with `TaskAddressBar` such that one of the two becomes redundant — a decision that has to be won before anything is built. Reopen alongside that address bar, not as a panel change. |

## Open questions

| Question | Resolved by |
| --- | --- |
| Do **both** gate conditions clear one in four on real stored history — two or more pairs live at once, and runs deep enough that there is a position to be stranded at? | before the build — together they decide whether the jumping half ships, not whether the panel does |
| **Is one in four the right threshold, on either condition?** It is argued, not derived: below it the second route is being built for a case rarer than the cost of maintaining it. A person who cares more about the rare case than about the cost should move it — and may reasonably want a different number on each condition, since B is a proxy and A is not. | the gate |
| **Condition A counts only pairs live at the same moment, while a row exists for any retained task.** That gap is deliberate — a wider count could never fail — but it means the gate under-reads the panel it is gating. Is a lower bound the right instrument, or should A count rows-offered with a recency window instead? | the gate |
| A row is a workflow and not a run; clicking it drills rather than describes; a row carries its project. Three substitutions on the brief's wording, all argued in § What the brief asked for, all the kind a person should get to overrule. | the gate |
| The one-project-one-workflow person gets the drawer but not the jump. The previous draft excluded them outright and then claimed importance on a ground that included them; this version splits the feature instead. Is the split the right shape, or should the panel simply not ship at one row? | the gate |
| **The story's second clause ships unmeasurable**, and only the roll-up carries a post-ship measure. Is that acceptable, or does the navigation log come first? | the gate |
| Does the panel row and the root column's double-click stay distinguishable in the built UI, or does one have to go? | build phase |
| Row three's "before" sample must be taken from `ui.seen` prior to shipping, because the map is last-value and cannot be replayed. Is anyone going to take it? | before the build |
