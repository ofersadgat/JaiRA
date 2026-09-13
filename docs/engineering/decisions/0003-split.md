---
id: engineering/decisions/0003-split
type: decision
status: built
updated: 2026-09-13
decides_for: [engineering/units/interaction-hub, engineering/units/lifecycle, engineering/units/board]
---

# 0003. What a fan-out element becomes: `each: "inline"`, `"task"` or `"split"`

## Context

The feature workflow decides features in `product` and then mounts `build`
once per feature with `each: true`. Two things are wrong with that, and they
are one thing.

1. **One task holds every feature.** A fan-out element is a place in the rail,
   but it is not a task: pause, stop, rewind, fork and resume are all
   task-scoped, so the second of three features can be watched but never acted
   on alone. Its status is the task's status.
2. **`build` separates product from the layers.** Product is a child of the
   root; the seven layers are children of `build`. A feature's own view, if it
   had one, would begin at `ux` with the decision that created it somewhere
   else. The reason the layers are under `build` at all is the fan-out: the
   mount needed a state to mount.

What is wanted: one task per feature, whose board shows `product` and every
layer as direct children; features ordered by what they require; each created
in the state it was put in, holding rather than running, with its own title,
without re-running anything product already did.

And the same wish one level down: when `ux` needs three items to serve one
feature, those three should be stoppable and rewindable one at a time too —
but they are not features, and they must not become three top-level tasks.
**A task at the top level is a feature.** Whatever splits inside a feature
files under it.

Three pieces of machinery already exist and are named here because the
decision is mostly their composition:

- **Cut and fork** (`cut.ts`): a task's journal can be copied up to a seq into
  a new task with re-minted ids. Every instance entered before the point keeps
  everything it did. The load then reads the copy as it reads a crash.
- **Fan-out** (`each: true`): a mount whose wire names a list is entered once
  per element, under one child record whose output is the elements' outputs
  gathered; the engine already rebuilds such a record on load from the
  elements the journal recorded.
- **`parentTaskId` and `TaskOrigin`**: a task can say which task it came from,
  and the list and the detail already draw a fork's origin.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Draw each fan-out element as a card | View-only; no workflow change | An element is not a task. Nothing can be stopped, rewound or resumed per feature, and product is still elsewhere. |
| B. A state starts a new task per element, running the mounted state | Small host function; the child's board is the mounted state's children | For a feature: product is not in the feature's task, and the parent's outputs vanish. Right for an item inside a feature, wrong for the feature itself. |
| C. Fork the running task once per feature | Copies product's history; the fork origin already renders | A fork resumes at once, keeps the parent's title, inherits the parent's branch binding (`cut.ts` copies `meta.branch`), and leaves one parent that must carry on as something. No ordering, no holding. |
| D. A `split` host function state | Host-only; the element lands in one place (`.children.split.output`) | A `split` column on the board that is not a step. A two-sided output that the workflow must name in a rule. |
| E. One field, three named values: `each: "inline"`, `"task"`, `"split"` (**chosen**) | Said where fan-out is already said; no extra state, no extra column. The field names what an element becomes, and `true` is the old spelling of the first. The two new kinds are the two things a parent can do after a fan-out — gather and continue, or end — and the first is B. | Two engine touches upstream (the validator accepts the strings; the fan-out dispatch goes through a host seam). Every later mount that needs a split element says so again. |

## Decision

**E.** `each` says what an element BECOMES, and the three answers are the
three places a piece of work can be: an instance in this task, a task under
this one, or a task beside it.

|  | `each: "inline"` | `each: "task"` | `each: "split"` |
| --- | --- | --- | --- |
| What runs per element | the mounted state, here | the mounted state, as a task | the remainder of the parent's sequence, as a task |
| Its journal | this task's | fresh, rooted at the mounted state, inputs = the element's | a copy of the parent up to the mount, positioned at it |
| The parent | holds, then continues with the outputs gathered | holds (a durable park), then continues with the outputs gathered — the same thing | ends |
| Filed | nowhere: an element in the rail | under the parent; a card in that column of the parent's board | as a peer of the parent, with an origin line |
| Worktree | the parent's | the parent's — it is the parent's own work | its own branch, created at start |
| Order | sequential unless the mount is `async` | sequential unless the mount is `async` | concurrent; `requires` decides each task's base |
| Title | the element's label, as today | from the element | from the element |

`"inline"` is what `each: true` has meant since the field existed, and
`true` stays accepted as its spelling — every workflow that says it keeps
working, and the loader reads the two as one value. New authoring says the
word: a field whose values are `true`, `"task"` and `"split"` asks the
reader to know that the boolean is the third kind, and a reader should not
have to.

Fork is the copy step of a sequence split and nothing more. A mount split
copies nothing. An inline element copies nothing and creates nothing.

"Level" is not the axis, though it looks like one from the feature workflow:
a split at product ends the parent because nothing after it is shared, and a
split at ux's items continues the parent because ui is. An author who wants
the parent to end says `"split"`; one who wants it to wait says `"task"`; and
the second is why a task at the top level stays a feature.

### The workflow is flat, and the feature split is on the first layer's wire

The root's children become `product`, `ux`, `ui`, `engineering`,
`implementation`, `acceptance`, `documentation`, `review`. `build.json` is
retired; its back-transitions (a finding that belongs to an earlier layer)
move to the root unchanged. Nothing in `product` changes.

```
"ux": {
  "inputs": {
    "feature": { "expr": ".children.product.output.features", "each": "split",
                 "id": "id", "title": "story", "requires": "requires" },
    "issue": ".inputs.issue"
  }
},
"ui": {
  "inputs": {
    "feature": { "expr": ".children.product.output.features", "each": "split" },
    ...
  }
},
```

And inside `ux`, where `item` is entered once per thing the plan decided:

```
"item": {
  "inputs": {
    "item": { "expr": ".children.plan.output.items", "each": "task", "title": "name" }
  }
}
```

The field names beside a split say which property of an element is its
identity, its title, and the list of sibling ids it depends on; they default to
`id`, `title` and `requires`, and they are read only by the mount that does
the splitting.

### Inside a split task, the mount reads as an ordinary mount

Built, and it decided one thing the draft had not: on the far side of a split
the batch is one element, and the mount's outputs read as **that element's
own** — `.children.ux.output.patterns` is the patterns, not a one-element array
of them. That is what lets every later layer keep the wiring it was written
with; the validator types a split mount that way, and the engine settles a
narrowed split with the element's termination rather than gathering it.

### A split task is split on a list, and the list resolves to its element

The rule that makes the second `each: "split"` above work, and the rule the
engine's load needs anyway: a task carries `split: [{ expr, index }]` in its
meta, and inside that task **every wire whose `each: "split"` names one of
those expressions resolves to the one element at its index**. `ui`,
`engineering` and the rest read the feature by repeating the wire; it is one
line each, and it says at the mount what the mount is about.

Without this rule a split task would rebuild the fan-out on load from the
full list — the engine continues recorded elements and dispatches fresh ones
— and quietly run its siblings' features itself.

A mount split needs no such rule: the sub-task's root is the mounted state,
and the element's inputs are its inputs.

### After a sequence split, the parent ends

From the splitting task's side, the mount's child record settles with outcome
`split` and output `{ tasks: [{ id, taskId, title }] }`. The task then
**terminates successfully unless a rule on that mount says otherwise**. A task
that split is a decision, and its card says "split into 3". Lowered by the
host into the bundle as a transition, so the engine learns nothing new about
termination.

### After a mount split, the parent holds and then continues

The mount's child record is a durable park — the same row a gate writes, with
the sub-task ids in it — and it settles when the last sub-task does, with the
sub-tasks' outputs gathered into the record's output in element order, as
`each: true` gathers them. The parent's rules then read
`.children.item.output` exactly as they do today, and `.children.item.outcome`
is `error` if any sub-task failed, which is the rule a mount's transitions
already handle.

On process restart the park is re-armed from the sub-tasks' statuses rather
than from memory: a parent whose sub-tasks all completed while it was away
continues on its next load; one whose sub-tasks are still holding parks again.

Sequential by default: the next sub-task is created when the previous one
completes, which is what keeps three implementation items from editing one
worktree at once. `async` on the mount creates them all, as it runs them all
today.

### What the host does for a sequence split, in order

The engine resolves the elements exactly as for `each: true`, then hands them
to a host seam instead of running them. The host:

1. **Parks.** A durable pending row, so a crash between here and step 4
   resumes into the split rather than past it. The row records the task ids
   created so far; a resumed split skips the elements it already made.
2. **Copies.** For each element, `copyTaskPrefix` at the seq of the mount's
   own `instance.entered`. `product` was entered before the point, so it and
   its conversations are kept whole. The fork verb refuses a live task; that
   guard is the verb's, not the copy's, and a park is a stable point in the
   journal.
3. **Positions the copy.** An `instance.entered` for the mount — `ux`, element
   `index`, the element's resolved inputs — is **appended to the copy's
   journal**, shaped exactly as the engine writes one, and nothing after it.
   The copy's projection then shows the task standing in `ux`, and the
   ordinary load, when the task is eventually started, finds an entered
   instance with no operation started and dispatches it. Written rather than
   run, because a task that has not started has no worktree, and it must not
   have one yet (see branches). Then the copy's meta: title from the element,
   `origin: { kind: "split", taskId, item: id }`, `split: [{ expr, index }]`,
   `dependsOn` from `requires` mapped through this batch's task ids, its own
   `branch`, status `queued`.
4. **Settles the parent's record** with outcome `split` and the tasks it made.

### What the host does for a mount split

1. **Parks**, with the element list and the sub-task ids made so far.
2. **Creates** the sub-task: `createTask` with the mounted state as its
   workflow, the element's resolved inputs as its inputs, the element's title,
   `parentTaskId` = the parent, `origin: { kind: "task", taskId, key, index }`,
   no branch of its own. **Starts** it in the parent's worktree, or holds it
   if the element has unmet `requires`.
3. **Settles** the park when the last sub-task settles, as above.

### Holding is a fact about dependencies, and the task holds where it stands

A split task does not get a new task state. A feature is in `ux`, because its
journal says so, and it is not running, because nothing has started it. What
it is doing there is **holding**, and that is derived, not stored: any task in
`dependsOn` not `completed`. `TaskStatus` does not grow; the card's lane and
badge read the derivation. A sub-task holds the same way, in its parent's
column.

`TaskMeta.dependsOn?: string[]` lives in the task file, because it is authored
by the split and must outlive the process. The board card for a holding task
sits in its column, in the paused lane — the lane for a task waiting on
something other than itself — with a badge naming what it waits for. The Start
verb refuses while a dependency is unfinished, with the names. When the last
dependency completes, the task is startable and stays where it is. `start:
"when_ready"` beside `each: "split"` makes the host start it instead; the
default is manual, because a task that holds is what was asked for, and a
person choosing the moment is the cheaper thing to be wrong about. A mount
split's sub-tasks are started by the host, since the parent is waiting on them
and nobody else is.

`blocked` on an instance already means an input-wiring failure, and this is
not that; the derived state is named `holding` so the two are never read as
one.

`requires` naming an id outside the batch is a refusal at split time, with the
id. A cycle is the same.

### Branches are made at start, from the dependency's head

Feature tasks run concurrently, and product listed them in dependency order
for a reason: a feature that requires another builds on its code. A fork
copies the parent's branch binding, which is exactly wrong here, since it puts
two worktrees on one branch. Each feature task gets its own branch name at
creation (`<parent branch>/<item id>`, or the item id where the parent has
none) and the branch is **created at start**, by `ensureWorkspace`, based on
the head of the most recently completed dependency's branch, or the parent's
base when it has none. Ordering is what makes that base exist — and it is why
step 3 writes the position instead of running to it.

A sub-task has no branch. It runs in its parent's worktree, because an item of
a feature is the feature's work, and `workspace` is already a parameter of the
run path for exactly this kind of caller.

### Where it shows

At the top level, nothing new is drawn. A parent's card finishes in the `ux`
column with "split into 3" for its ending. Three cards appear beside it in
`ux`, in the paused lane, each carrying the origin line a fork already carries
and a badge naming what it holds for; one with nothing to hold for is in the
not-started lane, startable. The task list files a sub-task under its parent,
which is what `parentTaskId`'s contract has said since it was written and
nothing has consumed.

Inside a feature, the `item` column of the `ux` board shows one card per
sub-task rather than one card for the feature.

In the parent's conversation, a mirrored element is **state-machine motion,
not a place**: the parent made something, it did not enter anything. So it
draws as a line, one per element, in the journal's order — `split off
[Alpha]`, or `made [Alpha] · running` and then `· completed` when the
terminated row lands — with the title as the link to the task. The line
**expands to nest the child's conversation with its own rail**, the way a
subagent's sidechain nests under the tool call that spawned it, rendered by
the same component the task view uses. Two things differ from a sidechain and
decide the shape: a split copy carries the parent's own prefix, so its nested
view starts at the copy's boundary (`origin.boundary`) and a mount task nests
whole; and a child is live where a sidechain is history, so expanding
subscribes to the child's turns as a watched conversation does and collapsing
unsubscribes. Collapsed by default. For a `task` mount the parent is waiting
in that place, so its lane stays open with the nested rails under it; for a
split the lines are the last thing in the parent's rail. A nested task may
have made tasks of its own, and the nesting recurses.

The card treatments get a mockup against today's rendering before they are
built, per the standing rule on UI proposals.

## Consequences

**Easy.** A feature is a task, so every task verb applies to it with no new
code: stop one feature, rewind one feature to its `ui` draft, fork one feature
to try a second engineering plan. The same for an item. The rail of a feature
task begins with `product`, read from the copy. Computed titles work
unchanged. The board needs no new column: a split is at a step, not between
steps. The mount split is `each: true` with the elements' conversations
elsewhere; every rule an author wrote against a fan-out's output still holds.

**Hard.** Two engine touches upstream, both small and both real: the
validator's three `each` root-check sites accept the three strings, with
`true` read as `"inline"`, and the fan-out dispatch grows a seam the host can
take the elements through. The appended `instance.entered` must be shaped exactly as the engine
writes one, or the load will not find the element and will re-enter the mount
from the spine — which, under the resolve-to-one-element rule, still does the
right thing, but from a journal that lies about when the state was entered.
And the join's re-arm on restart is a new kind of resolver beside the human
one: it answers from other tasks' rows, and the row it waits on can be
deleted.

**Forecloses.** `dependsOn` is between tasks in one project. A dependency on a
task in another project's store has no meaning here and is not reserved. And
`each` is now a three-valued field whose values are places — in this task,
under it, beside it — and a fourth value would have to be a fourth place.
`true` is spent as the alias of `"inline"` and cannot mean anything else.

## Revisit when

- Two features that require each other's code turn up in practice. The
  ordering is a chain; a feature that needs two branches merged needs a base
  that is neither of them.
- Branch-at-start proves to be the wrong moment: a person starts a dependent
  before its dependency merged, and the base is the dependency's branch rather
  than main. The alternative is to base on main and refuse to start until the
  dependency has landed, which is a stricter reading of "completed".
- A layer other than the first turns out to need the split element under a
  name the repeated wire cannot give it. Then the element wants a namespace of
  its own (`.split.feature`), which is an engine change larger than the two
  above.
- Someone wants a sequence split whose parent waits — every feature done, then
  a release step in the parent. That is `"task"` semantics over `"split"`
  copies, and it is a fourth value or a flag; the table above is where the
  argument for it would have to be made.
- A parent with many made tasks turns out to be read mostly expanded. Then the
  default should flip, or the lines should carry enough of the child's standing
  that expanding is rarely needed.

## Amended 2026-09-13, after the first real run

The first real run of the flat feature workflow decided one feature, and two
things the decision had chosen read wrong in practice.

**A split over one element is no split.** The parent ended and one copy stood
beside it — a task with the parent's whole history and nothing the parent could
not have done itself. There is nothing to put beside a run when the list has one
element, so the engine now runs that element inline and the sequence continues
in the parent, exactly as it does on the far side of a real split (the mount
reads as an ordinary mount either way). A split over no elements is still a
split: the host makes nothing and the run ends. The rule is the engine's
(`hostedKindOf`), decided from the batch's count on entry and from the recorded
rows on a load.

**Holding is for dependencies, and nothing else.** The one copy stood queued
with nothing to wait for, and reading "not started" beside a parent that had
just ended was indistinguishable from "stuck". The default of `start` is now
`"when_ready"`: a split task that holds for nothing is started the moment it is
made, and a dependent the moment its last dependency completes. `"manual"` is
the opt-out, and the provenance records whichever the wire said; absent reads as
the default. The Holding section above, where it says a person chooses the
moment, is superseded by this.

## Amended 2026-09-13, second: the task that split keeps element 0

The first amendment removed the split over one element. What was left still
read wrong: a task that split into three ended, and three copies stood beside a
card that said "split into 3" and nothing else — a parent whose only work after
`product` was to have been copied.

**Element 0 stays home.** The task that split continues with element 0 as its
own, retitled by it where the element has a title, and split on the list at
index 0 exactly as a copy is split at its own — so every later mount narrows to
it and nothing about the sequence changes. Elements 1 to n become the copies.
The engine's seam for this is a second answer a split host may give: `continue`
with the element it kept, on which the engine runs that element inline under
the mount and appends the split entry to the run's own list. The parent no
longer ends by splitting; only a split over no elements ends it.

**One record, written before the cut.** The host mints the copies' ids first
and writes a `fanout.made` row under the mount naming every element's task —
its own included — before cutting a single copy, so every copy carries the same
row and a host asked again after a crash finds the ids it chose. The mirrored
`instance.entered`/`terminated` rows a split used to write are gone; a `task`
mount still writes them, because they are what a resumed parent reads its
tasks by, and it now creates every task up front so the list is complete.

**The line at the mount.** Each task draws the row from where it stands: every
run but itself as a link with its standing, the runs its `dependsOn` names
marked as what it waits for, and its own element inline right below the line,
as if there had been no split. No chevron and no nested conversation: a sibling
is somewhere to go, and the link is how. The board lane reads holding off
`dependsOn` whatever the task's status, so a task that split and holds for a
later element sits in the paused lane while it runs.

**Holding, for the task that split.** When element 0 requires another element,
the task that split holds at the mount, in-process, until that copy completes —
the same holding a copy does standing queued, read the same way. Stopped while
holding, it holds by its row like a copy, and is released the same way. Its
worktree stays on the base it was cut from, which is the trade-off the
first amendment's "revisit" bullet on branches already names.

**A setting for sequential batches.** A fan-out whose elements ran one after
another draws stacked down the page by default; the Conversation section of
Settings can draw it as one band across instead — columns for two, tabs from
three — the way concurrent elements already are. A person's preference, in
`user-settings.json` beside the theme.
