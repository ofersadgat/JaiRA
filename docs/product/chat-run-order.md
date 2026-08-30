---
id: product/chat-run-order
type: product-feature
status: proposed
updated: 2026-08-28
story: "As a developer with more conversations open than I can hold in my head, I should be able to see the conversations that still owe me an answer at the top of the Chat list and the rest in the order they ended, so that I can tell which threads still want something from me without opening them one at a time."
importance: 0.45
audience: developer
metrics:
  - "How far down today's list you must read before you have seen every unsettled conversation — deeper than a drawer of visible rows, or there is nothing here to fix"
  - "Count of unsettled conversations older than a week, which the partition pins above everything — stays below the visible row count, or the top of the list is a graveyard"
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
deliverable orders a list of **conversations**. Those are different lists and the
divergence is deliberate, so it is named here rather than left to be discovered
in the build.

- **A run is a row in `runs`** — "one row per workflow-level execution attempt of
  a task", and a task "may accumulate several runs (initial + re-runs after
  interruption)" (`db.ts:36`). One row per run is therefore a strictly longer
  list than one row per conversation.
- **For a conversation, that difference is narrow and specific.** A typed turn is
  deliberately *not* a run: "no workspace is materialized, no job is claimed, no
  task status moves. A conversation continued by hand is a conversation, not a
  second execution of the workflow" (`service.ts:3173`). And a conversation whose
  opening message completed can never start a second run: `isStartableStatus` is
  `queued || interrupted || failed || canceled` (`task.ts:64`) and `completed` is
  not in it, so re-running a completed task is refused
  (`lifecycle.test.ts:85`). The conversations with more than one run are the ones
  whose opening attempt was interrupted, failed, or **stopped**, and was picked
  up again.
- **That set just got larger, and it argues the same way.** `canceled` is now a
  startable status — "a stop is an INTERRUPTION … Pause and cancel differ in what
  they RELEASE and not in whether they can be continued" (`task.ts:53-61`). So
  every stop-and-resume now adds a run row to a task that already had one. The
  per-run reading gets worse as the product gets better at resuming, which is the
  wrong direction for a list whose whole job is to be shorter than the work.
- **What the extra rows would do is bad.** They put a conversation's abandoned
  first attempt in the list next to its successor, both opening the same
  conversation — two rows, one destination. That is the shape this codebase has
  already refused once: there is no root Files row because "a root Files row
  would open the same tree a project row opens — two ways to one view"
  (`App.tsx:265`).
- **It also costs a channel that does not exist.** Runs are readable only per
  task — `runtime.listRuns(taskId)`, over an index on `(task_id, id)`
  (`db.ts:47`). There is no project-wide or cross-project run listing anywhere in
  persistence or IPC. One row per conversation needs a field added to a list that
  already ships; one row per run needs a new query, a new channel, and a decision
  about what a run row is even called in a list where the task has one title.

**This is a substitution, not a reading of what was written**, and it is recorded
as one in the catalog's cut-or-reduced table. If the intent really was per-run
rows — most plausibly "I want to see the attempts, including the ones that
failed" — this is the row to send back at the gate; see Open questions. The
per-attempt view already exists elsewhere, on the task's own run history
(`views.ts:527`), which is the reason to think the list wanted conversations.

## Where this fits

- **Serves** — the same developer as [tasks-workflow-index](tasks-workflow-index.md).
  What is lost without it: a thread you are not done with sinks below finished
  ones the moment anything touches them, so the conversation that still wants
  something from you is the one hardest to find.

- **Neighbors** —

  - *This is not a new panel.* `ChatListPanel` shipped and works
    (`chatPane.tsx:257`): search, rename, delete, unread and answering
    indicators, mounted at both the project Chat row and the root "All
    conversations" row (`App.tsx:1303`, `App.tsx:1324`). **The brief's premise
    that "chat can be improved" is about its order, not its absence** — the
    missing-drawer gap the brief names is real only for Tasks. This is a change
    to one `useMemo` (`chatPane.tsx:268`) plus the field it needs.

  - *This is not a queue of what is waiting on me.* The partition reads one
    `status` column, so a row moves across the line only when its own status
    moves. A `running` conversation and a parked one both sort as unsettled, and
    neither is claimed to be more urgent than the other. Getting from "unsettled"
    to "waiting on you" means folding `on_user_event` offers into the key
    (`waiting_for_user`, `projection.ts:180-195`) — a key that clears when you
    answer it, so the list reorders under whatever the person is reaching for at
    the moment they reach for it. A different feature, see Framings considered.

  - *This is not the board's lanes.* `laneOf` splits a column's cards by status
    too (`board.tsx:49`), and it answers a different question — see the argument
    about `failed` below, where the two deliberately disagree.

- **Depends on / used by** — nothing must ship first, but see Cost: the sort key
  exists on the wrong view type today.

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

  `stopping` is new since the previous draft of this doc, which enumerated six
  statuses and would have left the seventh to fall wherever a negation put it. It
  belongs above on its own terms and not by default: it means "a stop has been
  ASKED FOR and the run has not settled yet", it is deliberately neither terminal
  nor startable, and output is visibly still arriving while it holds
  (`task.ts:11-20`). A thread still producing text is not one you are done with.
- Within each group, order by completion time descending. Descending **is** the
  brief's "oldest last" — that clause is a restatement, not a third rule.
- **The top group has no completion time in general, and falls back to
  `updatedAt`.** This needs no special case: it is what the shipped helper
  already does, `endedAtOf(card) = card.endedAt ?? card.updatedAt`
  (`board.tsx:59`). One key, one function, both groups.
- `endedAt` on `TaskSummary`. This is the actual work; see Cost.
- **A visible boundary between the two groups** — a rule line, a group heading,
  or a per-row status mark. Any of the three; the doc does not pick, and the
  design phase should. There is a precedent to follow rather than a new idea to
  invent: the board already splits a column's cards into named lanes by the same
  kind of status test, and drops the empty ones (`laneOf`, `board.tsx:49`).

**Sufficient** — the five above.

### Why `failed` sorts above and `canceled` below — and why the brief says otherwise

**Start with the brief, because the previous draft did not.** The instruction is
"uncompleted first". Read literally it has one exception, `completed`, and every
other status goes above the line — including `canceled`. This deliverable puts
`canceled` below. That is a **departure from what was asked for**, and the last
two drafts of this section argued the partition only against two predicates in the
codebase, which meant the one place the feature overrules a direct instruction was
the one place it never defended. The predicates are a side argument; the brief is
the thing that has to be answered, and it is answered below.

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
borrowed to draw the same line — worth writing down carefully, because the last
two drafts each reached for one of them and each was wrong in a different way.

**It is not `isTerminalStatus`** (`completed | failed | canceled`,
`task.ts:44-48`). That set puts `failed` below, and a failed conversation is one
where you asked something and got nothing back — the run errored, the thread has
no answer in it, and the thing you wanted has not happened. Burying it under
settled conversations, ordered by whenever it happened to stop, is exactly the
failure the story names.

**And it is not `isStartableStatus`**, which is what the previous draft of this
section fell back on when it rejected the first. That draft argued: `failed`
belongs above because it "is exactly the status a re-run may begin from". **That
reason no longer discriminates anything.** The predicate has since become
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
(`board.tsx:51`). That is right there and wrong here, because the two lists ask
different questions: a lane describes what the **machine** is doing, and a failed
run is not executing; a chat row describes what the **thread** wants from you,
and a failed thread wants a retry. Two surfaces, two questions, one status that
answers them differently. Recorded here so the divergence is a decision rather
than a bug someone reconciles later. Note also that `interrupted` already splits
the same way — the board calls it `paused`, not `finished`.

**Why the boundary is necessary and not nice-to-have.** The previous draft had it
under nice-to-have and claimed the story was true without it. The story ends "so
that I can tell which threads still want something from me *without opening them
one at a time*". An order alone does not tell anyone that: rows sorted
unsettled-first look exactly like rows sorted by recency until you already know
where the seam is, and the seam moves every time a conversation finishes. The
marks already on the row do not close the gap either — `unread` compares the read
watermark to `updatedAt` (`chatPane.tsx:286`) and `answering` is
`status === "running" || producing > 0` (`chatPane.tsx:295`), so a conversation
that is `interrupted`, `queued` or `failed` carries **no mark at all**, and those
are precisely the statuses this feature sorts to the top. Without a boundary the
feature delivers its mechanism and not its value.

**Nice to have**

- Collapsing the settled group, once the boundary makes it a group.

## Cost — and two corrections

**The framing's concession does not survive checking**, so it is not carried into
the cut-or-reduced table. What the exploration said: true completion ordering
needs a new index on `runs.ended_at` and a migration across four packages, so
take `updatedAt` as a proxy. What is actually there:

- `BoardCard.endedAt` already exists and is already documented as the sort key
  for finished lanes — "distinct from `updatedAt`, which is the task ROW's clock
  and moves for anything at all that touches the task" (`view.ts:157`).
- `endedAtOf` is already an **exported renderer helper** with tests over exactly
  this ordering (`board.tsx:59`, `board.test.ts:94`).
- `RunRow.endedAt` is a plain column read by `runtime.listRuns`
  (`runtime.ts:31`), and the projection already takes the max across instances so
  a canceled or part-failed root reports when it actually stopped —
  `endedAtOf(run)` at `projection.ts:473`, called from `stateViews.ts:680`. Note
  these are two different functions with one name: the projection's takes a run,
  the renderer's takes a card.

The real gap is narrower: `endedAt` is projected onto `BoardCard`, and
`ChatListPanel` consumes `TaskSummary`, which does not carry it
(`view.ts:827-829`).
`taskSummaries` (`views.ts:52`) maps `runtime.list()` → `TaskRuntimeRow`, which has
no such column; `endedAt` lives on `RunRow` (`runtime.ts:31`). So the work is a
per-task last-run lookup, served by the existing `runs_task` index. **No
migration and no new index.**

**The second correction is to the previous draft of this doc**, which called that
lookup "per-task work on every `task:list`, where today the call is a single row
scan". That is wrong: `taskSummaries` already does per-task work — it calls
`project.tasks.tryRead(row.taskId)`, a JSON file read, once per row
(`views.ts:54`). Adding an indexed SQLite lookup beside a file read is cheaper
than the thing it sits next to. The cost concern named in the previous draft is
withdrawn; what remains is an ordinary build-phase check, not a design risk.

## Metrics

| Metric | Read from | Success | Instrumented? |
| --- | --- | --- | --- |
| How far down today's list you must read before you have seen every unsettled conversation | offline replay of stored `status` and `updatedAt` per chat task | deeper than a drawer of visible rows; if the unsettled already sit near the top under recency, there is nothing here to fix | **Yes** — offline, before the build |
| Unsettled conversations older than a week, which the partition pins above everything | same offline read | fewer than a drawer's worth of visible rows | **Yes** — offline, the failure guard |
| How long an unsettled conversation **whose clock has stopped** stays unread — `seen[taskId] < updatedAt` over rows in `failed` or `interrupted` only | the persisted read watermark (`JairaUiState.seen`, `settings.ts:82`; `unread` at `chatPane.tsx:286`) | the median falls | **Partly** — nothing new to log, but see below |
| Share of opens preceded by use of the search field | navigation events | falls | **No** — needs a navigation log |

Rows one and two measure **the size of the problem**, not the size of the win,
and they are labelled that way on purpose: they are the pre-build read, and if
row one comes back shallow the feature is not worth building. Row three is the
one that measures the value — an open thread nobody has read is exactly the
failure the story names, and if the order works that number falls.

**Row three's restriction to `failed` and `interrupted` is load-bearing, and the
previous draft did not have it.** `unread` is `seen[taskId] < updatedAt`, and
`updatedAt` is "the task ROW's clock and moves for anything at all that touches
the task" (`view.ts:157`). A `running` or `stopping` conversation touches its own
row continuously while it produces, so its watermark can never catch up: it is
unread **by construction**, for as long as it runs, no matter where the list puts
it. Averaging those rows in would have made the metric a measure of how long runs
take. A long run would have read as a list failure and a fast one as a list
success, and shipping no change at all would move the number if the workload
changed. Restricted to `failed` and `interrupted`, `updatedAt` is frozen at the
moment the run stopped and nothing moves it until a person acts — so the interval
from that instant to the first `seen` mark at or after it is genuinely how long
the thread went unnoticed, which is the quantity the story is about. `queued` is
excluded for a different reason: its clock is frozen too, but a queued
conversation has not yet failed to give anyone anything, so time-to-notice is not
a cost there. This is also how the sibling doc's ended-work metric stays clean —
it reads `ProjectSummary.ended`, likewise a stopped clock.

Rows one and two are counted against the partition as decided above, so `failed`
conversations count in the top group. That widens the top group slightly and
therefore makes row two — the graveyard guard — marginally harder to pass, which
is the correct direction: if adding failures to the top makes it a graveyard,
that is worth knowing before the build rather than after.

**A correction to the previous draft of this doc.** Its first row was "rank held
by the conversation actually opened, replayed old order vs new", marked
*computable today*. It is not computable, at all: which conversation was opened
is not stored. `markSeen(taskId, at)` writes a **last-value map keyed by task**,
and it marks to the row's own clock rather than to now (`store.ts:3206`,
`settings.ts:82`) — so there is no per-open timestamp, no open count, and no
history to replay a rank against. Status and `updatedAt` alone cannot say which
row a person chose. The claim is withdrawn rather than repaired, because the
quantity it named does not exist in any store.

Row three's instrumentation label is "partly" for a reason worth being precise
about: `seen` is persisted, so nothing new has to be logged, but it is
last-value — **it must be sampled forward and cannot be replayed backwards**. A
before/after comparison therefore requires taking the "before" sample now, prior
to the change. That is a real prerequisite and it belongs in the build ticket,
not in a footnote.

Deliberately omitted: conversations opened per session, which rises whether or
not the order helps.

**The failure this measures for.** Parked threads nobody intends to return to sit
at the top permanently and push live work down. If the second row exceeds the
visible rows, the partition costs more than it pays, and the fallback is a third
group — parked beyond some age — rather than reverting to recency.

## Framings considered

Each row stands on its own reasoning, and this pass **withdraws** the standing
amendment the last row's argument was twice generalised into. The first version
("a listing surface may not rank by a judgement about what to do next") forbade
this feature too, since its partition is also a judgement. The second ("sorts on
stored state, never live state") got the answer backwards: the rejected
alternative reads an append-only journal, while this feature reads a column that
is overwritten in place. Two failures of the same generalisation, in opposite
directions, are evidence the general rule is not there to be found — so the row
below now carries only what a reader can check about these two features, and no
principle is proposed. See the exceptions section of [index.md](index.md).

| Framing | Why not |
| --- | --- |
| Do nothing — keep `updatedAt` descending | Correct for recency, wrong for "still wants something". A finished thread that gets renamed outranks one parked for a day, and the list is longest exactly when that hurts. |
| One row per run, as the brief literally says | Adds rows only for retried opening attempts (typed turns are not runs, and a completed conversation cannot re-run), and each added row opens the same conversation as the row beside it — two routes to one view, refused once already at `App.tsx:265`. It also needs a cross-task run query and IPC channel that do not exist. Offered back at the gate; see Open questions. |
| Partition on `isTerminalStatus`, reusing the incumbent predicate | Cheaper to write and wrong on `failed`, which the incumbent calls terminal and the person calls unanswered. Taking the predicate would have meant taking a definition of "done" that was written for a different question. See § Why `failed` sorts above. |
| Partition on `isStartableStatus` — "above the line is whatever you could re-run" | The previous draft's implicit reason, and it has since stopped picking out anything. `canceled` joined the set (`task.ts:64`) because a stop is resumable, so this reading now lifts every stopped thread to the top; four of seven statuses are startable and they fall on both sides of the line. A predicate maintained for the run lifecycle will keep moving for reasons that have nothing to do with this list — which is the general argument against borrowing either incumbent. |
| Order by true completion, take `updatedAt` as the proxy | The concession the exploration wrote down. Rejected on inspection: `endedAt` is already computed and already has an exported helper, so the proxy would substitute a worse key for a field the codebase can already produce. |
| Rank by what is waiting on a human (`on_user_event` offers), not by status | A different feature, not a variant. **Not** because the offer state is unstored — it is stored, as `call.waiting` / `call.settled` rows the projection folds into `waiting_for_user` (`projection.ts:180-195`), and the previous draft's "stored key versus live key" framing was wrong on exactly this point. The difference is **what makes a row move, and whether the person caused it**. A wait clears when *you answer it* — so servicing the top row is itself what demotes it and promotes another into the place your cursor is already travelling to — or when the agent moves past the offer on its own, which you did not do and did not see. This feature's key moves when a conversation's own status moves: fewer times over its life, at moments the person either caused or is being told about. Revisit with the resume queue as a whole. |

## Open questions

| Question | Resolved by |
| --- | --- |
| Did "a list of runs" mean per-attempt rows? This doc substitutes conversations and says why; the substitution is the kind a person should get to overrule. | the gate |
| `failed` sorts with the open threads, which puts this list deliberately out of step with the board's lanes on one status. Argued in § Why `failed` sorts above; worth a person's confirmation. | the gate |
| **`canceled` sorts below, and the brief says "uncompleted first", which puts it above.** This is the one place either feature overrules a direct instruction, and it is the single row most likely to be wrong. The argument is that you do not need a list to remind you of a thread you stopped yourself; the counter-argument is that you asked for uncompleted first and meant it. Secondarily, the codebase now treats a stop as resumable too (`task.ts:53-64`). Reverting is one predicate member and costs nothing. | the gate |
| Which of the three forms the boundary takes — rule line, group heading, or per-row status mark. It is necessary; which one it is, is not decided here. | design phase |
| The value metric needs its "before" sample taken from `ui.seen` prior to shipping, because the map is last-value and cannot be replayed. Is anyone going to take it? | before the build |
| Does the root "All conversations" list use the same order, or stay strictly recency? | design phase |
| Does the per-task last-run lookup show up at realistic task counts, given the file read already beside it? | build phase |
