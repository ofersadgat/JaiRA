---
id: product/chat-run-order
type: product-feature
status: proposed
updated: 2026-09-01
story: "As a developer with more conversations open than I can hold in my head, I should be able to see the conversations that still owe me an answer at the top of the Chat list and the rest in the order they ended, so that I can tell which threads still want something from me without opening them one at a time."
importance: 0.45
audience: developer
metrics:
  - "How far down today's list you must read before you have seen every unsettled conversation. READ IT TWICE, once per mount: the project Chat row shows one project's conversations, the root row shows every project's, and the two differ in length by about the amount this threshold tests. Deeper than a drawer of visible rows on EITHER, or there is nothing here to fix"
  - "Count of unsettled conversations older than a week, which the partition pins above everything — stays below the visible row count on BOTH mounts, or the top of the list is a graveyard"
  - "How long an unsettled conversation whose clock has STOPPED (`failed` or `interrupted`) stays unread — `ui.seen` watermark against its frozen `updatedAt`, sampled before and after; the median falls. This is the value measure"
  - "Share of opens preceded by typing in the search field: falls"
requires: []
siblings: [product/tasks-workflow-index]
---

# Chat list: unsettled first, then by when it ended

> As a developer with more conversations open than I can hold in my head, I
> should be able to see the conversations that still owe me an answer at the top
> of the Chat list and the rest in the order they ended, so that I can tell which
> threads still want something from me without opening them one at a time.

The Chat drawer already lists conversations, newest-touched first. This adds the
one clause it lacks: conversations you are not done with sort above ones you are,
and within each group the order is by when the run ended, most recent first.

## What the brief asked for, and what this is

The brief says "a list of **runs** ordered by completion date descending". This
deliverable orders a list of **conversations**. That is not a substitution the
gate has to be talked into, because the `runs` table no longer exists.

- **There is no list of runs left to order.** Migration 16 retired the table:
  "a task is one machine, so the runs table folded into it and `run_id` left
  every row" (`migrations.ts:415-416`). The per-attempt facts it held are now
  columns on the task's own row (`runtime.ts:39-45`), because "the lifecycle
  facts the retired `runs` table held per attempt — when it started, how it
  ended, what it produced — are facts about the task" (`runtime.ts:5-8`). The
  bootstrap schema still declares a `runs` table (`db.ts:34-47`), but that is the
  shape a database is *created* in before migrations run; no live database is in
  it, and quoting it as current would be a mistake.
- **And there is no second attempt to show even at the task level.** `RunView`
  survives by name and is now one per task: "a resume CONTINUES the machine under
  the same task, and a re-run is a new task linked by `parentTaskId`, so there is
  no second attempt to list" (`view.ts:225-232`), with `TaskView.runs` documented
  as "the machine's one summary" (`view.ts:265-266`). The literal reading of the
  brief therefore does not name a longer list than this one — **it names a list
  the product no longer has any rows for.**
- **The two readings have converged.** A re-run is already a task, so it is
  already a row in this list (`runtime.ts:35-36`). A resume adds no row anywhere
  (`runtime.ts:5-7`). A typed turn was never a run and still is not — "no
  workspace is materialized, no job is claimed, no task status moves. A
  conversation continued by hand is a conversation, not a second execution of the
  workflow" (`service.ts:3251`, restated at `ipc.ts:1180` and at the point of use,
  `chatPane.tsx:104`). Every source of extra rows is now either a conversation row
  already or nothing at all.

Ordering conversations is the only reading of "a list of runs" with rows behind
it. Nobody has to be talked out of the per-run list, because building it would
mean first restoring a distinction the product deliberately removed.

**What genuinely is lost, and it is named rather than buried.** `beginTask`
overwrites `started_at` and clears `ended_at`, `outcome` and the output fields on
every start (`runtime.ts:157-165`), so a task row remembers only its **last**
stretch. A conversation interrupted at noon and resumed at three reports three
o'clock, and the noon attempt survives only in the journal. If the brief's "runs"
meant *"I want to see the attempts, including the ones that failed"*, that want is
real, this deliverable does not serve it, and — since the collapse — nothing else
on screen serves it either. That is a **separate feature** (per-attempt history,
reconstructed from `state_machine_events`), not a variant of this one. It is in
Open questions as such, and it is the thing to raise at the gate if the brief's
wording was load-bearing.

## Where this fits

- **Serves** — the same developer as [tasks-workflow-index](tasks-workflow-index.md).
  What is lost without it: a thread you are not done with sinks below finished
  ones the moment anything touches them, so the conversation that still wants
  something from you is the one hardest to find.

- **Neighbors** —

  - *This is not a new panel.* `ChatListPanel` shipped and works
    (`chatPane.tsx:257`): search, rename, delete, unread and answering
    indicators, mounted at both the project Chat row and the root "All
    conversations" row (`App.tsx:1398`, `App.tsx:1419`). **The brief's "chat can
    be improved" is therefore about this list's order, not its absence.** The
    issue says "both chat and tasks can be improved" and treats them
    symmetrically; which drawer is empty is a fact about the code
    (`App.tsx:1402-1412` has no `panel` key), not a claim the person made. This is
    a change to one `useMemo` (`chatPane.tsx:268`) plus the field it needs.

    **And because it is one component at both mounts, both lists reorder — that is
    a consequence, not a choice.** `App.tsx:1398` and `:1419` render the same
    `<ChatListPanel surface={chat} …/>`, and the sort lives inside it. So "does the
    root list use the same order, or stay strictly recency?" is not an open
    question: same order is what falls out, and *strictly recency at the root*
    would mean a per-mount prop, a branch in the `useMemo` and a second rule to
    explain — work that appears nowhere in Scope and that nobody asked for. If
    somebody wants the two mounts to differ, that is a change to this feature and
    it should be raised as one.

  - *This is not a queue of what is waiting on me.* The partition reads one
    `status` column, so a row moves across the line only when its own status
    moves. A `running` conversation and a parked one both sort as unsettled, and
    neither is claimed to be more urgent than the other. Getting from "unsettled"
    to "waiting on you" means folding `on_user_event` offers into the key
    (`waiting_for_user`, `projection.ts:180-195`) — a key that clears when you
    answer it, so the list reorders under whatever the person is reaching for at
    the moment they reach for it. A different feature, see Framings considered.

  - *This is not the board's lanes.* `laneOf` splits a column's cards by status
    too (`board.tsx:50`), and it answers a different question. The disagreement is
    **structural, not a single exception**: there are four lanes and this list
    draws one line, its unsettled group spans all four and its settled group is a
    strict subset of one. That is worked through in Scope, where it decides what
    form the group boundary can take. `failed` is the sharpest instance of it and
    is argued separately below.

- **Depends on / used by** — nothing must ship first. The sort key is already a
  stored column on the task's runtime row; it is simply not carried onto the view
  type the panel consumes. See Cost.

- **History** — narrows the sort introduced with the panel
  (`b.updatedAt - a.updatedAt`, `chatPane.tsx:270`), which is correct for "a
  conversation you are having is one you had a moment ago" and wrong for "which
  of these still wants something".

## Value

Ordering by last-touched means a finished conversation that gets renamed, or
resumed and closed again, jumps above a thread that has been parked for a day.
The list is busiest exactly when that matters most. Today the escape is the
search box, which requires already knowing the thread's name — which is the thing
the person came to the list to find out.

## Scope

**Necessary**

- **Partition on whether the person is done with the thread: `completed` and
  `canceled` below, everything else above.** The full status set is seven, not
  six — `queued | running | stopping | completed | failed | canceled |
  interrupted` (`task.ts:8-25`) — so the top group is `queued`, `running`,
  `stopping`, `interrupted` and `failed`.

  `stopping` belongs above on its own terms and not by default: it means "a stop
  has been ASKED FOR and the run has not settled yet", it is deliberately neither
  terminal nor startable, and output is visibly still arriving while it holds
  (`task.ts:11-20`). A thread still producing text is not one you are done with.
- Within each group, order by completion time descending. Descending **is** the
  brief's "oldest last" — that clause is a restatement, not a third rule.

  If "oldest last" is a restatement of the key, is "uncompleted first" one too? It
  reads that way — a single `endedAt`-descending key with absent-sorts-first would
  produce both clauses at once and need no partition. It is **rejected on what
  that key actually returns**, not on the wording: every stopped run carries an
  `endedAt`, including `failed` and `interrupted` (`runtime.ts:177`, `:203`), so
  the one-key reading lifts only `running`, `queued` and `stopping` and buries the
  rest. Full argument in Framings considered; it is the cheapest build here and it
  is worth knowing exactly why it is not taken.
- **The top group has no completion time in general, and falls back to
  `updatedAt`.** This needs no special case: it is what the shipped helper
  already does, `endedAtOf(card) = card.endedAt ?? card.updatedAt`
  (`board.tsx:60`). One key, one function, both groups.
- `endedAt` on `TaskSummary`. This is the actual work; see Cost.
- **A visible boundary between the two groups, and it must be structural** — a
  rule line or a group heading, drawn between the rows. A third form, a per-row
  status mark, is ruled out here rather than left to the design phase; the reason
  is below and it is a fact about the board's vocabulary, not a preference.

  **This is an addition to the brief and it was not being recorded as one.** The
  issue asks for an order and nothing else — "a list of runs ordered by completion
  date descending (uncompleted first, oldest last)" — and this clause puts a drawn
  thing on screen that nobody asked for, in the *necessary* set. The catalog's
  departures table recorded only reductions, so every substitution on the brief's
  wording was visible to the gate and this was not. It is now in
  [index.md](index.md) § Added beyond the brief, and the Open question below asks
  whether it should exist at all rather than only what shape it takes. The
  argument for it is in this doc and it is a good one; the point is that a person
  gets to hear it as a proposal instead of finding it already in the build.

  **The partition crosses the board's lane taxonomy rather than refining it, and
  that decides two things at once.** There are four lanes — `running`, `paused`,
  `not-started`, `finished` (`LANES`, `board.tsx:32`) — and this list draws one
  line. Above it: `queued` (not-started), `running` and `stopping` (running or
  paused, by `activeStatus`), `interrupted` (paused) and `failed` (finished).
  Below it: `completed` and `canceled`, both finished (`laneOf`, `board.tsx:51-56`).
  So the unsettled group spans **all four** lanes and the settled group is a strict
  subset of **one**. Consequences:

  - **No lane name labels either group**, so a heading or a rule cannot be worded
    from that vocabulary and the two groups need names of their own. Those names
    are new, necessarily — the board has no word for this cut.
  - **A per-row status mark would print "Finished" on both sides of the line**, on
    `failed` above and `completed` below, which is a boundary that argues against
    itself. That is why the third form is dropped.

  An earlier constraint said this boundary must take its names from the lanes,
  with `failed` as the one deliberate exception. The collision is structural rather
  than a single exception, and the constraint as written was unsatisfiable here. It
  is narrowed in the sibling's § Where this fits to what it can actually bind: the
  name for **one task's status**, which both panels do use, and where that doc's
  per-row roll-up should indeed count in lanes. It does not reach a **grouping**
  the board has no name for. The `failed` divergence argued below is still a real
  decision and still worth a person's confirmation; it is simply not the whole of
  the disagreement.

**Sufficient** — the five above.

### Why `failed` sorts above and `canceled` below — and why the brief says otherwise

**Start with the brief.** The instruction is "uncompleted first". Read literally it
has one exception, `completed`, and every other status goes above the line —
including `canceled`. This deliverable puts `canceled` below. That is a
**departure from what was asked for**, and it is the one place the feature
overrules a direct instruction, so it is answered here rather than only against
two predicates in the codebase.

**The answer:** "uncompleted" and "still owes you something" come apart on exactly
one status. A conversation you stopped yourself is uncompleted, but you were the
one who stopped it — you know it exists, you know its name, and the search box
finds it. The line is not a completeness test; it is there so that threads which
still owe you an answer are not buried under ones that already gave you theirs.
On that reading `canceled` belongs below and `failed` belongs above, and the
brief's wording gets the second of those right and the first wrong. It is
recorded as a departure in the catalog's cut-or-reduced table, it is offered back
at the gate, and it is the single row in either feature that contradicts a direct
instruction.

The rest of this section is why neither predicate that already exists can be
borrowed to draw the same line.

**It is not `isTerminalStatus`** (`completed | failed | canceled`,
`task.ts:44-48`). That set puts `failed` below, and a failed conversation is one
where you asked something and got nothing back — the run errored, the thread has
no answer in it, and the thing you wanted has not happened. Burying it under
settled conversations, ordered by whenever it happened to stop, is exactly the
failure the story names.

**And it is not `isStartableStatus`.** The tempting argument is that `failed`
belongs above because it "is exactly the status a re-run may begin from". **That
reason no longer discriminates anything.** The predicate is now
`queued || interrupted || failed || canceled` (`task.ts:63-64`), and the commit
that widened it says why: "a stop is an INTERRUPTION — the difference between it
and a crash is who caused it, which is not a fact about whether there is anything
left to pick up. Pause and cancel differ in what they RELEASE … and not in
whether they can be continued" (`task.ts:53-61`). So resumability now holds for
`canceled` too, and taking it as the criterion would drag every stopped thread
into the top group. Four of the seven statuses are startable and they fall on
both sides of the line this feature needs.

**The criterion is who ended the thread, and whether it left an answer.** It is a
judgement — every ordering rule is — and the thing that matters about it is not
that it avoids being one but that it is a total function of a single stored
column, so a row's side of the line changes only when its own status changes:

- `completed` — it finished and answered. Below.
- `canceled` — **you** ended it. You do not need the list to tell you about a
  thread you personally stopped, and you can find it by name. Below.
- `failed` — nobody chose this and there is no answer. Above.
- `queued`, `running`, `stopping`, `interrupted` — not over. Above.

Note what this drops. `canceled` sits below though the brief puts it above and
though the codebase treats it as resumable — two independent reasons to doubt it,
and the first is the one that counts, because a brief is an instruction and a
predicate is only evidence. It is in Open questions rather than settled here. The
guard is metric row two: if stopped threads people did mean to return to pile up
unfound, that shows as unsettled work the list is not surfacing, and the answer is
to move `canceled` up — back to the literal brief — rather than to abandon the
partition.

So settled is `completed | canceled` — a third, narrower predicate that agrees
with neither incumbent. It should ship as a named export next to the list rather
than an inline test, with this reasoning beside it, so that a later reader who
notices it disagreeing with both finds out why instead of "fixing" it back to one
of them.

**The board disagrees, on purpose.** `laneOf` files `failed` under "finished"
(`board.tsx:52`). That is right there and wrong here, because the two lists ask
different questions: a lane describes what the **machine** is doing, and a failed
run is not executing; a chat row describes what the **thread** wants from you,
and a failed thread wants a retry. Two surfaces, two questions, one status that
answers them differently. Recorded here so the divergence is a decision rather
than a bug someone reconciles later. Note also that `interrupted` already splits
the same way — the board calls it `paused`, not `finished`.

**Why the boundary is necessary and not nice-to-have.** The story ends "so that I
can tell which threads still want something from me *without opening them one at a
time*". An order alone does not tell anyone that: rows sorted unsettled-first look
exactly like rows sorted by recency until you already know where the seam is, and
the seam moves every time a conversation finishes. The marks already on the row do
not close the gap either — `unread` compares the read watermark to `updatedAt`
(`chatPane.tsx:286`) and `answering` is `status === "running" || producing > 0`
(`chatPane.tsx:295`), so a conversation that is `interrupted`, `queued` or `failed`
carries **no mark at all**, and those are precisely the statuses this feature sorts
to the top. Without a boundary the feature delivers its mechanism and not its
value.

**Nice to have**

- Collapsing the settled group, once the boundary makes it a group.

## Cost — and what the runs collapse did to it

Three estimates of this now exist, each cheaper than the last, and only the third
is current. Both earlier ones are recorded because each was wrong in a way a
reader could otherwise repeat.

- *The exploration said:* true completion ordering needs a new index on
  `runs.ended_at` and a migration across four packages, so take `updatedAt` as a
  proxy. Wrong then — `endedAt` was already computed — and moot now, because
  `runs.ended_at` is not a column any live database has.
- *A later draft said:* `endedAt` lives on `RunRow`, so `taskSummaries` needs a
  per-task last-run lookup served by the `runs_task` index. Wrong now: `RunRow`
  is gone, and so is the index.
- *What is actually there:* `TaskRuntimeRow` **carries `endedAt` as a plain
  column** (`runtime.ts:41-42`), and `taskSummaries` already holds that row — it
  maps `project.runtime.list()` and assembles the summary field by field
  (`views.ts:53-63`). The work is one more conditional spread beside the ones
  already written there. **No migration, no new index, and no lookup at all.**

What remains is the shared type. `TaskSummary` does not declare `endedAt`
(`view.ts:837-853`) and `ChatListPanel` consumes `TaskSummary`, so the change is
one field on an interface, one spread in `taskSummaries`, and one `useMemo`
(`chatPane.tsx:268-270`).

**The fallback needs no special case, and has a first-class reason.** The top
group has no completion time in general, and the shipped helper already covers it:
`endedAtOf(card) = card.endedAt ?? card.updatedAt` (`board.tsx:60`), tested over
both the ordering and the fallback (`board.test.ts:92`, `:106`). The absence is an
invariant rather than an accident — `beginTask` sets `ended_at = NULL` on every
start, because "`ended_at IS NULL` while running is what makes 'how did this end'
unambiguous to read" (`runtime.ts:153-165`), so "absent means running or never
ran" (`runtime.ts:41`) is exactly the case the fallback exists for.

`BoardCard.endedAt` remains the documented sort key for finished lanes —
"distinct from `updatedAt`, which is the task ROW's clock and moves for anything
at all that touches the task" (`view.ts:157`) — and the projection still takes the
max across instances, so a canceled or part-failed root reports when it actually
stopped (`endedAtOf(run)`, `projection.ts:409`, called from `stateViews.ts:680`).
Two functions share the name: the projection's takes a run, the renderer's takes a
card.

**The performance concern an earlier draft carried is withdrawn twice over.** It
worried about "per-task work on every `task:list`, where today the call is a single
row scan". `taskSummaries` already does per-task work —
`project.tasks.tryRead(row.taskId)`, a JSON file read, once per row
(`views.ts:55`) — and after the collapse the addition is not even a query. No
build-phase performance question is left here.

## Metrics

| Metric | Read from | Success | Instrumented? |
| --- | --- | --- | --- |
| How far down today's list you must read before you have seen every unsettled conversation. **Read twice — once per mount** | offline replay of stored `status` and `updatedAt`, grouped per project for the project Chat row and across all projects for the root "All conversations" row | deeper than a drawer of visible rows on **either** list; if the unsettled already sit near the top under recency on both, there is nothing here to fix | **Yes** — offline, before the build |
| Unsettled conversations older than a week, which the partition pins above everything. **Read twice, same two populations** | same offline read | fewer than a drawer's worth of visible rows on **both** | **Yes** — offline, the failure guard |
| How long an unsettled conversation **whose clock has stopped** stays unread — `seen[taskId] < updatedAt` over rows in `failed` or `interrupted` only | the persisted read watermark (`JairaUiState.seen`, `settings.ts:82`; `unread` at `chatPane.tsx:286`) | the median falls | **Partly** — nothing new to log, but see below |
| Share of opens preceded by use of the search field | navigation events | falls | **No** — needs a navigation log |

Rows one and two measure **the size of the problem**, not the size of the win,
and they are labelled that way on purpose: they are the pre-build read, and if
row one comes back shallow on both lists the feature is not worth building. Row
three is the one that measures the value — an open thread nobody has read is
exactly the failure the story names, and if the order works that number falls.

**So this feature carries two live conditions, and the catalog said it carried
none.** [index.md](index.md) described it as the one that "carries neither; it is
smaller and it ships", which is false of this table: row one has an explicit
**don't-build** outcome, and row three's before-sample is a prerequisite nobody
has been assigned (§ Open questions). Neither is a build-time risk in the sibling's
sense — the code here is one field, one spread and one `useMemo`, and none of it
can fail late — but both are conditions that can stop this feature before it
starts, which is what that sentence denied. The catalog is corrected, and so is
the sequencing argument that rested on it.

**Which population rows one and two read is not a detail.** There are two lists,
not one: the project Chat row shows one project's conversations and the root row
shows every project's, and they differ in length by roughly the amount the "deeper
than a drawer of visible rows" threshold is testing. Reporting only the root number
would flatter the feature, since the longer list clears a depth threshold more
easily. So both are read and both are reported. The **build condition is that
either clears**, because one component serves both mounts (§ Where this fits) and
there is no way to ship the change to one list and not the other: a root list that
is deep while a project list is shallow means the feature earns its place at the
address where people keep everything, which is a real answer and not a failed read.
Row two, the graveyard guard, is the opposite shape and takes the opposite
quantifier — a top-of-list graveyard on **either** mount is a failure, so it must
stay under the threshold on both.

**Row three's restriction to `failed` and `interrupted` is load-bearing.**
`unread` is `seen[taskId] < updatedAt`, and `updatedAt` is "the task ROW's clock
and moves for anything at all that touches the task" (`view.ts:157`). A `running`
or `stopping` conversation touches its own row continuously while it produces, so
its watermark can never catch up: it is unread **by construction**, for as long as
it runs, no matter where the list puts it. Averaging those rows in would have made
the metric a measure of how long runs take. A long run would have read as a list
failure and a fast one as a list success, and shipping no change at all would move
the number if the workload changed. Restricted to `failed` and `interrupted`,
`updatedAt` is frozen at the moment the run stopped and nothing moves it until a
person acts — so the interval from that instant to the first `seen` mark at or
after it is genuinely how long the thread went unnoticed, which is the quantity the
story is about. `queued` is excluded for a different reason: its clock is frozen
too, but a queued conversation has not yet failed to give anyone anything, so
time-to-notice is not a cost there.

**The sibling had a metric over the same frozen clock and it is gone, for an
unrelated reason.** [tasks-workflow-index](tasks-workflow-index.md) § Metrics
withdrew `seen[taskId] < updatedAt` over `ProjectSummary.ended` because the Tasks
row's bulk clear makes it unattributable, **not** because of anything about its
clock. The stopped-clock property was the one part of that metric that was sound,
and it is the part this row keeps. The two grounds are independent, and reading the
withdrawal as a verdict on the clock would take this row down with it wrongly.

Rows one and two are counted against the partition as decided above, so `failed`
conversations count in the top group. That widens the top group slightly and
therefore makes row two — the graveyard guard — marginally harder to pass, which
is the correct direction: if adding failures to the top makes it a graveyard,
that is worth knowing before the build rather than after.

**A metric that was proposed and does not exist.** "Rank held by the conversation
actually opened, replayed old order vs new", once marked *computable today*, is not
computable at all: which conversation was opened is not stored. `markSeen(taskId,
at)` writes a **last-value map keyed by task**, and it marks to the row's own clock
rather than to now (`store.ts:3200`, `settings.ts:82`) — so there is no per-open
timestamp, no open count, and no history to replay a rank against. Status and
`updatedAt` alone cannot say which row a person chose. The claim is withdrawn
rather than repaired, because the quantity it named does not exist in any store.

Row three's instrumentation label is "partly" for a reason worth being precise
about: `seen` is persisted, so nothing new has to be logged, but it is
last-value — **it must be sampled forward and cannot be replayed backwards**. A
before/after comparison therefore requires taking the "before" sample now, prior
to the change. That is a real prerequisite and it belongs in the build ticket,
not in a footnote.

**And the watermark is cleared in bulk, which the sibling's version of this metric
does not survive and this one does.** The Chat sidebar row's Pills clear marks
every unseen conversation in one gesture — `markSeenAll(unseenRows(atChats, …))`
(`App.tsx:1417`), wired at `sidebar.tsx:327` — stamping each task at its own clock
(`store.ts:3227`), so nothing in the stored map distinguishes a bulk clear from
row-by-row reading. That would be fatal if the panel's *existence* were the
change, because then visiting the row would be the thing under test. It is not:
`ChatListPanel` already ships, so the before and after samples are the same
surface with the same clear gesture available on both sides, and the only
difference between them is the order of the rows. The confound is present in equal
measure on each side of the comparison rather than correlated with the treatment.
[tasks-workflow-index](tasks-workflow-index.md) § Metrics withdraws its equivalent
metric on exactly this distinction; the two docs are describing one signal and
reaching opposite verdicts for a stated reason.

Deliberately omitted: conversations opened per session, which rises whether or
not the order helps.

**The failure this measures for.** Parked threads nobody intends to return to sit
at the top permanently and push live work down. If the second row exceeds the
visible rows, the partition costs more than it pays, and the fallback is a third
group — parked beyond some age — rather than reverting to recency.

## Framings considered

Each row stands on its own reasoning. Two passes tried to generalise the last
row's argument into a standing amendment and both failed. The first version ("a
listing surface may not rank by a judgement about what to do next") forbade this
feature too, since its partition is also a judgement. The second ("sorts on stored
state, never live state") got the answer backwards: the rejected alternative reads
an append-only journal, while this feature reads a column that is overwritten in
place. Two failures of the same generalisation, in opposite directions, are
evidence the general rule is not there to be found — so the row below carries only
what a reader can check about these two features, and no principle is proposed. See
the exceptions section of [index.md](index.md).

| Framing | Why not |
| --- | --- |
| Do nothing — keep `updatedAt` descending | Correct for recency, wrong for "still wants something". A finished thread that gets renamed outranks one parked for a day, and the list is longest exactly when that hurts. |
| One row per run, as the brief literally says | **Not a variant of this list — a list with no rows to draw.** Migration 16 retired the `runs` table (`migrations.ts:415-416`) and `RunView` is now one per task: "a resume CONTINUES the machine under the same task, and a re-run is a new task linked by `parentTaskId`, so there is no second attempt to list" (`view.ts:228-231`). A re-run is therefore already a row here, a resume adds no row anywhere, and a typed turn was never a run. Earlier drafts rejected this on a cross-task run query that does not exist and on two-routes-to-one-view (`App.tsx:267`); both arguments are now beside the point, because the rows themselves are. See § What the brief asked for. |
| **Read "(uncompleted first, oldest last)" as one sort key, not a partition** — order by `endedAt` descending with rows that have none sorting first, and both clauses fall out of the single key | The cheapest possible build. It is rejected on what the key actually produces, which is **not** the brief's own words. `endedAt` is stamped for every way a run stops, not only success: `endTask` writes it with the outcome (`runtime.ts:177`), and crash recovery writes it with `outcome = 'interrupted'` (`runtime.ts:203`). So "has no `endedAt`" picks out `running`, `queued` and `stopping` — and **only** those. `failed`, `interrupted` and `canceled` all carry one, so the single key files them among the `completed` rows by stop-time. A failed thread would sort below a conversation that answered you an hour later, which is the exact burial § Why `failed` sorts above rejects, and "uncompleted first" would then be false of four of the seven statuses. The one-key reading is cheaper because it does less, and what it does not do is the thing the story asks for. |
| Partition on `isTerminalStatus`, reusing the incumbent predicate | Cheaper to write and wrong on `failed`, which the incumbent calls terminal and the person calls unanswered. Taking the predicate would have meant taking a definition of "done" that was written for a different question. See § Why `failed` sorts above. |
| Partition on `isStartableStatus` — "above the line is whatever you could re-run" | Has stopped picking out anything. `canceled` joined the set (`task.ts:64`) because a stop is resumable, so this reading now lifts every stopped thread to the top; four of seven statuses are startable and they fall on both sides of the line. A predicate maintained for the run lifecycle will keep moving for reasons that have nothing to do with this list — which is the general argument against borrowing either incumbent. |
| Order by true completion, take `updatedAt` as the proxy | The concession the exploration wrote down. Rejected on inspection, and the runs collapse has since made the rejection cheaper still: `endedAt` is already computed, already has an exported helper (`board.tsx:60`), and is now a plain column on the task's runtime row that `taskSummaries` already holds (`runtime.ts:41-42`, `views.ts:53-63`). The proxy would substitute a worse key for a field that costs one spread. |
| Rank by what is waiting on a human (`on_user_event` offers), not by status | A different feature, not a variant. **Not** because the offer state is unstored — it is stored, as `call.waiting` / `call.settled` rows the projection folds into `waiting_for_user` (`projection.ts:180-195`), so a "stored key versus live key" framing would be wrong on exactly this point. The difference is **what makes a row move, and whether the person caused it**. A wait clears when *you answer it* — so servicing the top row is itself what demotes it and promotes another into the place your cursor is already travelling to — or when the agent moves past the offer on its own, which you did not do and did not see. This feature's key moves when a conversation's own status moves: fewer times over its life, at moments the person either caused or is being told about. Revisit with the resume queue as a whole. |

## Open questions

| Question | Resolved by |
| --- | --- |
| **Did "a list of runs" mean per-attempt rows?** If it did, that is not an overrule the gate can apply to this feature. The runs table is retired and a task row keeps only its last stretch (`runtime.ts:157-165`), so per-attempt rows mean **a new feature** — attempt history rebuilt from `state_machine_events` — not a different sort on this list. The decision worth taking here is whether that feature is wanted, not whether this one is wrong. | the gate |
| `failed` sorts with the open threads, which puts this list deliberately out of step with the board's lanes on one status. Argued in § Why `failed` sorts above; worth a person's confirmation. | the gate |
| **`canceled` sorts below, and the brief says "uncompleted first", which puts it above.** This is the one place either feature overrules a direct instruction, and it is the single row most likely to be wrong. The argument is that you do not need a list to remind you of a thread you stopped yourself; the counter-argument is that you asked for uncompleted first and meant it. Secondarily, the codebase now treats a stop as resumable too (`task.ts:53-64`). Reverting is one predicate member and costs nothing. | the gate |
| **Was "(uncompleted first, oldest last)" one sort rule or two?** It parses as a single `endedAt`-descending key with absent-first, which would make both the partition and the boundary additions nobody asked for — the cheapest build on the table. It is rejected because every stopped run carries an `endedAt` (`runtime.ts:177`, `:203`), so that key buries `failed` and `interrupted` among the completed. Worth confirming, because it is a reading of the person's own words and not of the code. | the gate |
| **Should the boundary exist at all?** It is the one thing here the brief did not ask for, and it sits in the *necessary* set — so a gate that approves this feature approves a drawn line it was never offered. The argument that the order alone does not deliver the story is in § Why the boundary is necessary; the counter-argument is that the person asked for a sort and the marks already on the rows might be enough. Cutting it leaves a feature that still does what the issue literally requested. | the gate |
| Which structural form the boundary takes — a rule line or a group heading — and **what the two groups are called**, since the partition crosses the board's lanes and no lane names either group (§ Scope). The per-row status mark is ruled out here rather than left open, for the reason given there. Only reachable if the row above is answered yes. | design phase |
| The value metric needs its "before" sample taken from `ui.seen` prior to shipping, because the map is last-value and cannot be replayed. Is anyone going to take it? | before the build |

An earlier draft carried an eighth row — "does the per-task last-run lookup show
up at realistic task counts?" — and it is **removed rather than answered**. After
the runs collapse there is no lookup: `endedAt` is a column `taskSummaries`
already holds. The question named work that no longer has to be done.
