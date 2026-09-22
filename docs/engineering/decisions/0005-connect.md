---
id: engineering/decisions/0005-connect
type: decision
status: built
updated: 2026-09-22
decides_for: [engineering/units/adoption, engineering/units/fan-out-host, engineering/units/workflow-snapshots, engineering/units/task-lifecycle, engineering/units/board-projection, engineering/units/interaction-hub, engineering/units/workflow-browser]
---

# 0005. Connect: a task moves to any state, and "top level" stops being a concept

## Context

A workflow is started at its root and runs to its end. That is one use of
it, and not the common one. What is wanted just as often:

1. **One phase.** Brainstorm the product side of an idea and stop. Do the
   design and nothing after it.
2. **Use what already ran.** A product task exists. Starting the feature
   workflow should take it as the feature's `product` child, not run
   product again.
3. **Chain by hand.** This task's output is that task's input, where no
   workflow says so.
4. **A conversation moves the work.** Said to a model that holds the
   workflows as a tool: "design this feature with me" starts the product
   state; "let's think about the ux for this" starts ux, fed by what
   product produced; "ok, now implement it" goes ahead to implementation.
   A board drag from one workflow to another means the same thing.

"Top level" is not an engine concept. `jaira task create --workflow
feature/engineering` already runs; the workflow browser hides a state that
another state mounts, and that listing rule is the whole of it. What is
missing is everything around entering a state that was written as somebody's
child: where its inputs come from, what becomes of the parent's loops, and
how a task that ran alone joins a parent later.

Five pieces of machinery exist, and the decision is mostly their
composition:

- **Mirror rows** (`fan-out-host`). An `each: "task"` element is a task of
  its own, mirrored into the parent's journal as `instance.entered` /
  `instance.terminated` rows whose instance id *is* the task's id. The
  parent reads its mount as history through the host.
- **`each: "split"`**. One workflow, many tasks standing at different
  places in it, each carrying its element through every later mount.
- **`on_user_event`**. A transition guard waits on a person. The board drag
  is already one: `on_user_event('task_drag', { to_state })`.
- **The conversation host** (`chat-turns`). The composer writes to the
  session of the first state on the path whose operation is a prompt. A
  state may have an operation *and* children.
- **Load, not replay** (`run-load`), over **frozen workflows**
  (`workflow-snapshots`). A task runs the document it pinned; a loaded run
  is handed instances, not a script to re-execute. A never-run child reads
  as absent and a consumer of it proceeds without it (`passView`).

## Options

| Option | For | Against |
| --- | --- | --- |
| A. List phases as roots | Nothing to build but the listing rule | A phase run alone loses the parent's loops, and a later full run cannot use it. Answers want 1 and none of the others. |
| B. Entry and stop marks on a real workflow ("start at ux, stop after ui") | The loops survive; one task continues later | The parent must be chosen at the first message, before anyone knows whether this is a brainstorm or a build. No answer for states no workflow relates. |
| C. One operation, `connect(task, target)`, that finds or makes the workflow relating the two (**chosen**) | The parent is chosen when a second state implies one. Drag, message and "start from this task" are the same call. | A frozen workflow becomes writable in one case. A model answers questions on a person's behalf. |
| D. An agent that starts tasks and copies values between them | No engine or storage change | The wiring between two states is guessed by a model on every move, where a workflow that relates them already states it. Nothing is reusable and nothing is checkable. C keeps the agent — the control conversation — and takes the wiring away from it. |

## Decision

**C.** One host operation, three resolutions, and the rules below.

### 0. The platform never names a workflow's input

`ask_below`, `returned_findings`, `feature`, `layer_verdicts` are one
author's conventions. Nothing in `connect` or the control conversation's
tools may read or write an input by name. Everything is derived from a state's
declared input and output **schemas and descriptions**. A workflow with
vague descriptions gets more questions and worse guesses, which is the
right incentive.

What the platform owns: the `on_user_event` guard, `split` and
`start: "manual"`, mirror rows, versioned frozen workflows, the
`settled_by: control` mark, the control conversation's tools, and one
setting (§6).

### 1. `connect(task, target)`

`target` is a state id, optionally inside a named workflow. Resolution, in
order:

1. **The target is in the task's workflow**, at any depth under a shared
   ancestor. Forward of where the task stands: **fast-forward** (§4).
   Behind it: a **backward move** (§5).
2. **Else a real workflow holds both** the task's root state and the target
   as siblings under one composite. A new task is made in that workflow,
   the task is **adopted** as the child it is (§2), and rule 1 applies.
   More than one such workflow: ask.
3. **Else the workflow is modified** (§3): the task's frozen workflow gains
   a transition to the target. A real workflow is cloned first. The result
   is a dynamic workflow, and so has a control conversation.

Every resolution ends by settling the target's **inputs** (§4). A target nested deeper than a sibling (`feature/ux/plan`)
enters its ancestors on the way down, their inputs filled the same way.

### 2. Adopt: mirror rows, written after the fact

The parent task's journal gets an `instance.entered` and an
`instance.terminated` row for the child key, **instance id = the adopted
task's id**, outputs as the task recorded them. The parent's cursor stands
past that child. The adopted task's `parentTaskId` is set and the board
files it under the parent, as it already does for a task-kind element.

Nothing is copied, re-keyed or merged. The adopted task keeps its journal,
its sessions and its card. Rewinding the parent past the mirror row
un-adopts.

- **Parent inputs are inferred backwards.** Where the parent binds the
  child's input by a plain path (`product.issue ← .inputs.issue`), the
  parent's input takes the value the child actually ran with. The form asks
  only for what the adopted task does not determine.
- **Eligibility is schema fit.** The task's root state must be the state
  the parent mounts. If the state changed since the task was pinned, the
  recorded outputs are validated against the current output schema; a fit
  adopts, a misfit is refused with the path that failed.
- **Holes are refused.** Every spine child before the cursor is either
  adopted or unread by anything later. The check is the linter's.
- **The workspace comes along.** A task-kind child normally runs in the
  parent's workspace; here the child came first, so the parent takes up the
  child's branch. Without this the next state reads a tree that lacks what
  the adopted task wrote.
- **A back-transition into an adopted child** runs in the parent as
  occurrence 1. The adopted task stays as occurrence 0's history.
- **An element adopts into the split shape.** A task that ran a state the
  parent mounts with `each: "split"` becomes a task of the parent standing
  past that mount with its element — what a split copy already is.

### 3. The dynamic workflow, and the conversation that controls it

A dynamic workflow is **a state with an operation and children**: the
operation is a conversation with a model that holds the workflow tools —
the **control conversation** — and the children are what was started from
it. Every dynamic workflow has one. A drag that makes a dynamic workflow
makes its control conversation with it.

Nothing about typing changes. The composer writes to the session of the
state that holds the conversation (`chatPlanFor`: the first state on the
path whose operation is a prompt), and in a dynamic workflow that state is
the root. A child's questions reach the person the way a nested state's
already do.

**Two conversations can be that operation, and they are not the same
state** ([0006](0006-built-in-layer.md) ships both, and says how either is
overridden):

- **`chat/session`** — a person started a conversation. It may start a
  workflow, or work in the project, or only talk. It holds the project's
  tools *and* the workflow tools. **A session that starts work stays a
  session**: what it started becomes its children, and nothing about the
  conversation changes.
- **`chat/control`** — a person *moved a task*, and the move made a
  dynamic workflow (§1 rule 3; a fast-forward of a task that had no
  conversation, §4). The conversation is made with it. It exists to steer
  that work and **holds only the task and workflow tools**. It cannot read,
  write or run anything in the project; the states it steers do that, under
  their own policy.

A `chat/control` is never made from a conversation, and a `chat/session`
never turns into one.

- Both are **authored states**, shipped built in and overridable per
  machine and per project: prompt, model and toolset are a person's to
  edit. The dynamic document starts as one of them and grows
  children.
- It is **an ordinary workflow document**: the same format, the same lint,
  real bindings. A wire is stored where a source output's schema fits a
  target input; a value the conversation supplied is stored as a literal
  with its provenance.
- It is **not saved** under `workflows/`. It lives where workflows are
  frozen, because pause, resume and rewind need it there, and nowhere else
  by default. "Save as workflow" writes it out.
- **It may be modified, and it is the only frozen document that may.** A
  modification writes a new version. Records keep the version they ran
  under, so no modification invalidates history. A task picks up the latest
  version the next time it loads.
- **A move on a dynamic workflow augments it**; it never wraps it in
  another.
- **A move a real workflow does not support clones it.** The task's frozen
  copy is already a copy; it is marked diverged, given the control
  operation, and modified. A diverged copy no longer follows edits to the
  workflow it came from — which a pinned task did not do anyway.
- **Controlling an ordinary task is adoption.** A task started the usual
  way has no control conversation. Asking for one adopts the task (§2, a
  running task included — a fan-out parent already mirrors live elements)
  into a new dynamic workflow whose only child it is.
- **A real workflow inside a dynamic one is a composite inside a
  composite.** No special case and nothing announced.
- **The workflow is independent of the items flowing through it.** Several
  tasks stand in one dynamic workflow exactly as split tasks stand in a
  real one. A modification changes the document for all of them.

**The workflow tools** — the `workflow` toolset, all of what `chat/control`
holds and part of what `chat/session` does — are the host operations, not a
second implementation of them:

| Tool | Does |
| --- | --- |
| `list_workflows` | lists workflows and a state's label, description and input and output schemas, a level at a time |
| `start_task` | `connect` from the conversation itself: a new child. Its input schema **is the target state's input schema**, with what the host could bind already filled |
| `move_task` | `connect(task, target)` — forward, backward, across workflows; `skip: true` goes directly |
| `list_tasks` | what was started here, where each stands, what each produced |
| `answer_question` | settles a question a child is asking (§4) |
| `hold_task`, `release_task`, `stop_task` | what the board's gestures do |

Each is named with a verb and what it acts on — `start_task`, not `start` — so a
model reading the list knows what it does, and so the names cannot shadow a shell
program a toolset names as a command subject (`start`, `move`, `stop`). Renamed
after step 6, 2026-09-21.

The drag calls `connect` directly. A model is involved in a drop only when
something has to be supplied or asked.

**Every generated transition is guarded by a user event**:

```
{ "when": "on_user_event('task_move', { to_state: 'ui' })", "to": "ui" }
```

It is taken only when a person says so — by a drop, or by saying it to the
control conversation, whose tool call publishes the event on their behalf —
and only for that task. Sibling tasks standing at the same place do not
take it because one of them did. Otherwise a task follows the normal
rules, which pins three things:

- the generated rule goes **last**, behind every authored rule, since a
  waiting rule blocks the rules behind it;
- the implicit "sequence ended → terminate" stays **ahead** of it, so a
  task with nothing left to do finishes rather than parking forever on a
  move nobody asked of it;
- a finished task takes the transition by being **reopened**.

`task_drag` and `task_move` are one vocabulary. A move asked for while the
source state is still running is held for that task and taken when the
state ends.

**One output, many inputs.** When the source produced a list and the target
takes one element (the item schema fits the target's input schema), the
generated mount is `each: "split"` over the list with `start: "manual"`.
The tasks are made held and nothing is confirmed: the conversation's
`made` note lists them, and the person — or the conversation, when told
to — starts the ones that are wanted. A target that takes the list is a
plain mount after the fan — a join. The target's input arity decides which.

### 4. Fast-forward, Skip, and inputs

A forward move inside a workflow **runs the machine** to the target. This
is the default for every forward move, however it was asked for. A task
with no control conversation is adopted into one first (§3), because the
conversation is what answers on the way.

- **The control conversation answers what comes up**, through `answer_question`:
  questions (`choose_option`, `fill_form`, an agent's `AskUserQuestion`)
  and judgement gates on documents. It answers with the whole conversation
  behind it, which is the reason it is the one to do it. Each answer is
  recorded `settled_by: { via: "control", confidence }`, drawn as such, and
  is a rewind point: "answer it yourself" rewinds to the question.
- **It leaves a question to the person only below `autopilot.askBelow`**,
  a platform setting that is very low by default and has no relation to
  any workflow's own thresholds. The question then waits as it would have.
- **It is never offered an approval.** A tool permission,
  `remote.publish`, a push, a merge: policy decides those as it does
  today. A question is answered; an approval is never the conversation's.
- **It ends on arrival.** The target state runs normally.
- **Skip is always showing.** Skip interrupts the running state, records it
  and every unentered intermediate as `skipped`, and transitions directly.
  The jump is decided *before* the interrupt lands: a successful
  `interrupt()` completes the operation and would otherwise walk the run
  into the next intermediate.

**Inputs.** For whatever a target still lacks — after Skip, on a dynamic
transition, on any entry whose bindings do not all resolve:

1. the workflow's binding resolves → **bound**, by the host, with no model;
2. else the control conversation supplies it from what has been said →
   **inferred**;
3. else it asks, in the conversation, in words → **asked**.

Every value keeps which of the three it was, and the task's inputs view
shows it. When everything binds no model runs. A skipped child reads as
`outcome: "skipped"` to an expression rather than as absent; what a later
state does with that is its author's business.

### 5. Backward

A backward move uses the workflow's own machinery: the target is re-entered
as the next occurrence and the usual backward reset applies. Its inputs are
settled like any other entry's, and what the person said to cause the move
is in the conversation that settles them. An input whose description says
it carries what came back gets filled because of what it says, not because
of what it is called. A state with no such input is re-entered as it was.

An authored back-transition guarded on a child's output is untouched; a
person's backward move is a `task_move`, not a forged output.

### 6. Settings

| Key | Default | Decides |
| --- | --- | --- |
| `autopilot.askBelow` | `0.2` | below this, a fast-forward leaves the question to the person |

Starting work from a conversation spends money on a model's say-so. What
each workflow tool may do without asking is the conversation's **toolset**
([0007](0007-toolsets.md)): `chat_control/ask-first` and `chat/ask-first`
ship asking, as a conversation does today; a project that wants `start_task` to
go ahead overrides one file, or picks another toolset from the bucket.

### What draws

Mockups — today's rendering as the baseline, then each proposed state —
are in [0005-assets/](0005-assets/) against the app's own stylesheet
(`proposed.css` holds the only rules that are new), and published together:
<https://claude.ai/artifact/QSSuGXa9XPVuZdTgauzAqT>.

- **The drop preview.** A drag across workflows resolves while it
  *hovers*, and the column under the pointer says what a drop will do:
  *move within*, *adopt into*, or *new transition*; where the task will
  stand; what will be asked afterwards. **The drop is the commit** — there
  is no accept or cancel. What the target still needs is asked in the
  conversation after the fact, and **Undo** on the card takes the move back
  (for an adoption, a rewind past the mirror row).
- **The control conversation.** Work started from it draws the way a
  tool call and a nested state already do: the `start_task` row, the child on
  the rail beneath it with its own questions in its own sheet, and the
  composer still the conversation's. A move across workflows leaves a
  note: "adopted into **feature** as `product` · standing at `ux`"; a fan
  leaves the existing `made` note with its tasks held.
- **The fast-forward strip.** "Fast-forwarding to **implementation** · at
  `ux → item` · 1 of 3" with **Skip** beside **Stop**, and "answered for
  you" on each gate the conversation settled.
- **Inputs**: the conversation asking in words for what it could not
  infer, and **provenance** on a task's inputs: bound, inferred, asked.
- **The lists.** A dynamic workflow is a conversation: it is a row in the
  Chat list, not a column of its own. What it started files on the board
  in the workflow it runs, an adopted task under the task that adopted it.

## Consequences

**Easy.** One phase, a phase later joined to the whole, a conversation that
walks a workflow at its own pace, and a workflow discovered by doing it
three times and saving it. The workflow browser's root rule becomes a
display preference.

**Hard.** A frozen document with versions is a second thing a record
points at. Adoption across a changed state is a schema check that can
refuse. An answer the control conversation gave is a model's judgement
recorded as a settlement; the mark and the rewind point are what keep that
honest. A conversation that can start work can spend money; the tool policy
is what stands in front of that.

**Foreclosed.** A model that wires states itself (option D): the control
conversation chooses *what* to start and supplies values; wiring comes from
a workflow, real or generated, and is lintable either way. A second place
to type: the composer is the control conversation's, as it is any
conversation's. Per-item workflows: items share one document.

## Build order

1. **`task_move` and the directed transition**, upstream: a host-published
   transition journaled as `transition.taken` with who asked; `skipped` as
   an outcome. Reopen-to-take for a finished task. **Built 2026-09-21** —
   see "What step 1 settled" below.
2. **Provenance on recorded inputs** (bound, inferred, asked), and
   `outcome: "skipped"` readable from an expression. **Built 2026-09-21** —
   see "What steps 2–3 settled" below.
3. **Adopt**: mirror rows after the fact, backwards input inference, the
   schema-fit and hole checks, taking up the child's branch. "From a
   task…" in New task. **Built 2026-09-21.**
4. **Versioned frozen workflows** and the dynamic document: generate,
   augment, clone-on-diverge, the generated `split`. **Built 2026-09-21** —
   see "What step 4 settled" below.
5. **`connect`** and the board drop with its hover preview and Undo. Until
   6, a drop whose inputs do not all bind is refused with what is missing.
   **Built 2026-09-21** — see "What step 5 settled" below.
6. **The conversations** (needs 0006): the `workflow` toolset over
   `connect`; `chat/session` growing its first child; `chat/control` for a
   task that becomes a dynamic workflow. **Built 2026-09-21** — see
   "What step 6 settled" below.
7. **Fast-forward**: `answer_question`, `settled_by: control`, `autopilot.askBelow`,
   the strip, Skip. **Built 2026-09-21** — see "What step 7 settled" below.

Each step is usable on its own. 1–3 already answer "one phase" and "use
what ran". **The build order is complete**: all seven steps are built, and
what they left undone is the Open list below.

## What step 1 settled

Built upstream (`@declarative-ai/hw`) and in JaiRA; the statement of record
is upstream SPEC §3.3 and [journal-events](../contracts/journal-events.md).
Four things the text above left open were decided in the building:

- **How the engine knows a rule is a generated one.** It cannot read
  `on_user_event`'s event name, so the three ordering rules hang on a mark
  on the transition: `"standing": true`. The engine sorts standing rules
  last, and their wait holds nothing — not the list, not the sequence, not
  the state's end. The generator (step 4) writes the mark.
- **A directed transition outranks the rules.** A held move is taken ahead
  of every authored rule when its source ends, and answers for a failure
  nobody had handled: a loop's own back-transition would otherwise swallow
  it. A *standing rule's* answer, by contrast, is a rule's and sits last,
  so an authored rule that fires in the same round wins and cancels it.
- **Which of the two a published move becomes.** A wait offering exactly
  that move is answered; else the running task takes a directed
  transition; else the task is reopened with the move queued. A `skip`
  always takes the directed route, since a rule's answer is held.
- **An authored forward jump still leaves absence.** Only a directed
  transition records what it steps over as `skipped`; changing what every
  existing `{ "to": … }` leaves behind was not this step's to do.

A held move lives in the engine's memory and is lost with the process. *(Amended
2026-09-22: it is journaled `jaira.moveHeld` and survives — see "Made durable" below.)*

## What steps 2–3 settled

Built in JaiRA alone, with no upstream change; the statement of record is
[adoption](../units/adoption.md), [task-channels](../contracts/task-channels.md)
and [task-file](../contracts/task-file.md). What the text above left open:

- **Where provenance lives.** On the task file, per input name
  (`inputProvenance`), for the root's inputs, because that is the one place
  a value is settled by somebody. A child's inputs are `bound` by
  construction — entering a child is the wiring resolving — so nothing is
  stored for them: the projection derives it, and reads `asked` or
  `inferred` only for what a directed `transition.taken` handed the entry
  that followed it. `outcome: "skipped"` was already readable from an
  expression after step 1.
- **The mirror row carries the outputs.** The engine recomputes a loaded
  child's outputs from its operation and children, and a plain mount has no
  host to ask, as an `each: "task"` mount does. So the row's end carries
  `outputs` as the task recorded them and its entry carries `adopted`, and
  the load reads the child through a **stand-in state** — the mounted
  state's current output slots with no bindings, fed the recorded outputs as
  its operation's value — added to the bundle for that run only. The real
  state is untouched, which is what makes a back-transition run it, in the
  parent, as occurrence 1. An upstream seam that takes a loaded instance's
  outputs as given would replace the stand-in; nothing else would change.
- **Schema fit is checked twice.** At adoption, against the mounted state's
  current output slots, with the run's validator: the refusal names
  `outputs.<name><path>`. And again by the engine on every load, because the
  stand-in's slots are the current ones.
- **What "later" means for a hole.** The wires, `async` flag and mount rules
  of the sequence members after the cursor, the root's output bindings and
  computed output defaults, and the root's transitions. The adopted child's
  own wires are not later, so a child that read a sibling nobody ran can
  still be adopted; a back-transition into it would then run it without
  that sibling, as it would in any run that jumped there.
- **A form value never overrides an inferred one.** The parent's record says
  what the child ran with. What nothing determines is returned as `asks`,
  each with the declared schema and description and nothing the platform
  named; a required one refuses a real adoption, which is step 5's "refused
  with what is missing".
- **A running task's parent waits as a task, not as an engine.** The parent
  is made holding through `dependsOn`, the mirror's end is written when the
  adopted task completes, and the ordinary release starts the parent. A load
  that finds a mirror still open refuses, so nothing can run the child twice.
  An adopted task that fails keeps the parent holding.
- **The split shape needs the list.** The parent is split on the list at the
  element's index, which is only knowable where the list is a parent input
  the form supplies or the output of a sibling adopted with it. One element
  cannot say what the rest of its list was; any other list is refused.
- **The parent shares the worktree.** It takes the adopted task's branch
  *and* its worktree path, rather than a second worktree on one branch,
  which git refuses. Deleting either task removes the tree the other stands
  in; the next start cuts it again from the branch.
- **Into a new task, or into one that exists.** `task:adopt` makes the parent
  unless `parentTaskId` names one, which is what `connect()` composes with
  the dynamic workflow's task that step 4's generator makes without
  adopting. The record is the constraint there: a child the parent entered
  is not adopted over, a parent standing past it is refused, and its
  recorded inputs must agree with what the child ran with.
- **"From a task…" is a source, not a value.** The New task form sends
  `sources` and the main process reads them, so a task whose source is still
  running is created holding and reads the value when it starts. A pending
  source is offered only where its declared output schema says what the slot's
  does, since there is no value to validate.

## What step 4 settled

Built in `@jaira/persistence` (`documents.ts`, `dynamicWorkflow.ts`,
`dynamicDocuments.ts`) with one upstream change; the statement of record is
[workflow-snapshots](../units/workflow-snapshots.md), its
[contract](../contracts/workflow-snapshot.md) and the `workflow.version` row
in [journal-events](../contracts/journal-events.md). What the text above
left open:

- **A version is a snapshot, and the document only lists them.** A
  snapshot stays immutable and content-addressed; a document is
  `system/snapshots/_documents/<id>.json`, an identity outside any task and
  an ordered list of snapshot hashes. A task names its document
  (`task_runtime.document_id`) and keeps `snapshot_hash` as the snapshot it
  last ran under, so nothing that reads a pinned task had to learn about
  documents. The one new question, "which hash, for this task, now", has one
  answer in one place (`currentPin`).
- **Records keep their version by where they sit in the journal.** Each
  time a task loads under a version it did not last run under, a
  `workflow.version` row is journaled ahead of the stretch. A row, and every
  record it names, ran under the newest such row before it. It is a journal
  row because a rewind, a fork and a replay from the journal file all carry
  the journal faithfully already; a column keyed by seq would not survive
  the file replay, which re-mints seqs.
- **Rewind and fork read the version current at the cut.** A rewound task
  goes back under it and picks the latest up again at its next load, saying
  so. A cut behind the row that moved a task into a document puts it back
  under the snapshot it had, in no document: rewinding past a divergence
  un-diverges, as rewinding past a mirror row un-adopts. A fork's copy, and
  so a split's, stands in the same document.
- **Which of new and clone a move means is where the task stands.** A task
  that finished well has outputs only a parent can read, so it is wrapped:
  a new dynamic document mounting its root state and the target. A task
  standing inside its workflow is cloned. `connect` may say otherwise
  (`mode`). Making the new document does not adopt the task into it; that is
  step 3's operation, composed by step 5.
- **A fit is taken only when it is the only one.** Whole before element,
  the nearest producer that has any, then the only fit or the only one that
  holds both ways. Two outputs that fit equally are returned with the input
  as candidates, not chosen between, since the only tie-break left would be
  their names (§0). Nearest means where the task last stood, which is
  structure and not a name.
- **What already ran is mounted with what it ran with.** A new document's
  first child carries its task's recorded inputs as literals with
  `via: "recorded"`, which is what lets the document lint on its own and a
  backward move re-enter the state as it was. Provenance sits on the
  binding (`{ "json": …, "provenance": … }`), inside the version's hash.
- **Nothing is generated while a required input is open.** A document with
  an unwired required input does not lint, so the generator returns what is
  unsettled and writes nothing. Asking after the drop (§What draws) is
  therefore a second call with the answer supplied, which writes the version.
- **A standing rule is outside the reachability proof** (upstream,
  SPEC §6.2). Two things did not lint without it: a generated rule made every
  authored wire of a cloned workflow unproven, because a rule with no child
  in its guard could fire before anything ran; and a child entered only by
  a move has no proven predecessor, so no wire into it could be written. A
  standing rule now pre-empts nothing the sequence proves, and a child
  entered only by standing rules has its wires typed and not held to the
  proof. A wire that resolves to nothing blocks the entry with the input
  named, as it does after any directed transition.
- **A child that has run is carried, not reloaded.** A version is built by
  the loader over live files, and then every state the previous version
  held is put back as it was frozen. Only the root changes, and it only
  grows.
- **A clone is a graft.** A frozen root is a resolved state, and the loader
  does not reproduce one from itself, so the additions are lowered by the
  loader in a scaffold root with the same child keys and the lowered mount
  and rules are moved onto the frozen root. Two consequences: the new child
  does not inherit the cloned root's `environment`, and a diverged document
  cannot be saved as a workflow, having no authored root.
- **A diverged root is not given the control operation yet.** An instance
  loaded with an operation it never ran dispatches it, so a standing task's
  root would hold a conversation turn the moment it resumed. The document
  records which conversation controls it; step 6 gives the root the
  operation when the conversation states and their run semantics exist.
- **The conversation state's `environment` reaches every child.** A dynamic
  root is that state with children, and `environment` is a default for a
  subtree. `chat/control` and `chat/session` must carry their model and
  tools on `operation`, or the states they start inherit them.

## What step 5 settled

Built in `@jaira/persistence` (`connect.ts`), the app (`AppService.connectTask`,
`undoConnect`, the board) and the CLI, with no upstream change; the statement
of record is [task-channels](../contracts/task-channels.md) (`task:connect`,
`task:connectUndo`), [jaira-cli](../contracts/jaira-cli.md) and
[task-board](../../ui/components/task-board.md). What the text above left open:

- **`connect` owns an order, and no mechanism.** A move is `task:move`, an
  adoption is `task:adopt`, a modified workflow is the generator; `connectTask`
  is the order they are tried in and is handed the host's two operations, so
  the drop, the CLI and — later — the conversation's `move_task` tool are one code
  path down to the same `task_move`. A waiting `on_user_event` rule still gets
  its answer first, and a drag a workflow offers is unchanged.
- **A column is a target, and a workflow's own column means "into it".** At the
  root listing the columns are workflows, so the second resolution reads "a
  composite that mounts the task's state and either *is* the target or mounts
  it too". Dropped on the workflow, the task is adopted and stands at what
  comes next, with no move at all.
- **The seam for fast-forward is `forward: "fast-forward" | "skip"`**, absent
  reading `fast-forward`. Until step 7 a forward move that steps over states is
  refused with what lies between, unless it says `skip`; `skip: true` is the
  same thing in the spelling the `move_task` tool and the CLI use. The very next
  state needs neither. **The board never skips**: a preview has no controls
  and a drop that silently interrupts a running state is not a drop, so a
  column that is states ahead says so and refuses. `jaira task move --skip`
  is the way until the strip exists.
- **The way down is handed over a level at a time.** A directed transition
  names an instance by id, and a composite that has not entered has none. So a
  nested target is a move with a `path`: the host watches the journal, and the
  moment the composite above enters it directs the next step at the id the
  engine just gave it. The engine registers an instance before it journals its
  entry and takes a waiting move before it walks the spine, so the composite
  goes straight to the named child. What comes before that child inside it is
  stepped over like anything else, and needs `skip` like anything else. An
  upstream `path` on `DirectedTransition` would replace the follower.
- **Whether inputs bind is decided before anything is written, statically.**
  From the lowered wires and the loaded machine: a wire binds when every child
  it reads has ended well — or is running now, for a move that is held until
  it ends — a backward move forgets what its reset will, and a composite
  entered fresh on the way down has nothing behind it. A required input that
  does not bind refuses the connect with the input, its schema, its description
  and the reason; an optional one is listed as what can be given afterwards.
  A rule of the workflow that is waiting on the move is trusted to have done
  its own wiring. The engine's entry remains the judge of what actually
  resolves.
- **A new document's conversation is opened with what happened.** The shipped
  conversation declares a required input, and §0 forbids naming it. It is
  filled by schema: a required input of the conversation state that takes a
  string is given the sentence `"<title>" was moved to <target>.`, recorded
  `bound`; one that takes anything else refuses as missing. The conversation
  is `CONNECT_CONVERSATION` — `chat/agent` until step 6 changes that line —
  and it has its turn before the move is taken, because a state's own
  operation runs before a move between its children. With the stand-in that
  turn is a model call made by a drop.
- **A new transition waits for a task that is not running.** A task picks a
  new version up at its next load, so a running task cannot take a move its
  engine's bundle does not hold. It is refused, saying to pause it first.
- **A split's first element is the task that was moved.** Run under the real
  engine and the fan-out host, a generated `each: "split"` with
  `start: "manual"` makes one queued task per *other* element and starts none
  of them; releasing one starts it with its element. Element 0 is the moved
  task itself, as in every split, and it stands at the target with it: a split
  has no way to hold the task that is performing it.
- **Undo is a cut, and only sometimes a delete.** An adoption is undone by
  cutting the parent's journal at the mirror row, which un-adopts, and resumes
  nothing — an undo that ran the child in the parent would be a second move. A
  parent the connect made that had run nothing is removed, its row and file
  only, since the worktree it stands in is the adopted task's; one that ran
  something is kept, cut. A move is undone by the ordinary rewind to before
  it, which is also what puts a cloned task back under its pin. A document a
  `new` made outlives its undo, and an augmented document keeps its version:
  other tasks may stand in it, and a standing rule nobody takes costs nothing.
- **The token is the renderer's, for the session.** `Undo` is on the card
  until it is used or the app closes; after that the task's own rewind takes
  the same thing back. It is not on the task file because it is not a fact
  about the task. *(Amended 2026-09-22: it is kept on the task file after all,
  so it survives a restart — see "Made durable" below; and, the same day, it
  lasts only while the drop is the last thing the task did, not until it is
  used.)*
- **An adopted task stays in sight.** Steps 2–3 left it off the roots board.
  It was a task of its own first, with a card somebody knows, so it files in
  its parent's column with `under` naming the parent, and the board draws it
  beneath that card — out of the lane its own status names, because what
  relates the two is not a status. It cannot be picked up: it moves with the
  task above it.
- **One verb.** `jaira task move <id> --to <state> [--workflow <w>] [--skip]
  [--dry-run]`. A move is done *to* a task that exists and only sometimes
  makes one, which `task create --from` would have said backwards. The CLI has
  no engine waiting, so a move that has to be taken is taken by running the
  task there, as `task start` runs one.

## What step 6 settled

Built in `@jaira/shared` (`workflowTools.ts`, the two state files and the four
`chat` toolsets), `@jaira/runtime` (`workflowTools.ts`), the app
(`main/workflowHost.ts`, `AppService.workflowHostFor`, the transcript's rows and
note, the Chat list) and `@jaira/persistence` (`connect.ts`, `load.ts`,
`dynamicDocuments.ts`, `views.ts`), with no upstream change. The statement of
record is [host-tool-vocabulary](../contracts/host-tool-vocabulary.md) for the
eight tools, [host-tools](../units/host-tools.md) for what registers them and
[chat-turns](../units/chat-turns.md) for the conversation they run in. What the
text above left open:

- **The tools are thin, and the host is bound to one conversation.**
  `runtime/workflowTools.ts` validates the shape a model handed it and calls a
  `WorkflowToolHost`; `app/main/workflowHost.ts` is that host over
  `AppService`'s own operations — `connectTask`, `moveTask`, the generator, the
  two pending lists, `cancelTask`/`resumeTask`/`startTask`. Which conversation
  is CLOSED OVER at registration rather than named by the model: a registry is
  built per run and per typed turn, for a known task. A caller with no host —
  the CLI, a test registry — gets `noWorkflowHost`, under which every name
  resolves and every call answers that it cannot be served there, so a state
  that holds one still loads and runs.
- **`answer_question` cannot reach an approval, by wiring and not by check.** The host is
  handed the interaction hub's and the question hub's pending lists and never
  the approval hub, so there is no third lookup for an approval to be found
  through. On top of that the two lists are filtered to
  `ANSWERABLE_COMPONENTS` — `choose_option`, `fill_form`, `review_artifact`,
  `edit_artifact` — in BOTH directions: an approval is not among what `list_tasks`
  says a task is asking, so no `request` id exists to name, and `answer_question` refuses
  one by component if a caller names it anyway. `confirm_action` and
  `review_artifacts` are the two that are excluded on purpose.
- **A refusal is the ask.** `start_task` and `move_task` answer `inputs-missing` with
  `missing`, the target's whole input `schema` and what the host `filled`
  itself, and write NOTHING — no version, no child, no run. The conversation
  supplies the value from what was said, or asks the person in words, and calls
  again naming in `asked` what they answered. There is no separate input filler
  and no confirm dialog; the loop is the tool being called twice.
- **Provenance is a journal row, not a second place to look.** `jaira.supplied`
  carries `{to, instanceId?, nested?, provenance}` — per name, `inferred` or
  `asked`, with the confidence — written on the task that takes the move, just
  before it. `markProvenance` folds it onto the entry that follows, ahead of
  what `transition.taken`'s `by` could say, because `by` knows only that a
  conversation asked and this knows which value came from where. A value that
  rides a generated mount as a literal carries the same thing inside the
  version's hash, which is where step 4 put it.
- **A control conversation starts idle, and the load is where that is decided.**
  The root of a task standing in a DOCUMENT, whose state has a **prompt**
  operation and children, and whose operation never started, is loaded with that
  operation already settled and nothing said (`IDLE_CONVERSATION_VALUE`). So a
  drop that makes a dynamic workflow dispatches no model call at all: the
  conversation simply exists, and the first turn is whatever the person types —
  a typed turn is a synthetic child `chat:<root>` the engine never sees
  ([chat-turns](../units/chat-turns.md)). A prompt and not any operation,
  because a conversation is the thing that may be left unsaid; a root that runs
  a function is running something, which is not this rule's to skip.
- **The conversation is grafted onto a cloned root.** Step 4 recorded which
  conversation controls a document and did not give a diverged root the
  operation, precisely because it would have dispatched. It does now: the
  loaded conversation state's resolved `operation` and execution `environment`
  are moved onto the frozen root alongside the lowered mount, and the idle rule
  above is what makes that safe. A root that already speaks — a `chat/session`
  that grew a child — keeps its own operation, which is the mechanism behind
  "a session that starts work stays a session".
- **`start_task` is not a move across workflows.** It points the conversation's own
  task at a document rooted in ITS OWN state: `mode: "clone"` for a task in no
  document (the frozen copy, conversation and all, gains the child and its
  standing rule), an augmentation for one already in a document. `chat/control`
  is what `CONNECT_CONVERSATION` names and is only ever made by a MOVE.
- **A `start_task` made while an engine holds the task is queued.** A running engine
  runs the bundle it loaded, and a version written now is one it cannot see. So
  the version is written and the move is queued on `ProjectSession.afterRun`,
  taken by the run-end handler when that run ends WELL — the same place, and for
  the same reason, as a move left on the directed port. A child the engine
  already holds is moved to at once and held by it until the running state ends.
- **Both states carry their model and tools on `operation`.** The loader
  resolves an operation's execution-environment fields into the state's own
  `environment`, so the composer and the turn read them exactly as before —
  while the AUTHORED `environment` block, which is what a dynamic root hands
  down to every child it starts, stays empty. That is the whole of step 4's
  last note, and it is asserted rather than assumed.
- **`chat/session` took `chat/agent`'s place and the four `chat` toolsets grew
  eight lines.** A session holds the project's tools AND the workflow tools, so
  `chat/ask-first` — "asks before every tool a conversation holds" — had to hold
  them too. The rule the frozen-preset test now states is that a `chat/<name>`
  gives a workflow tool whatever `chat_control/<name>` gives it; the nine
  project tools are still held to exactly the maps the four function presets
  wrote. `chat/agent` and `chat/assistant` still ship, so a conversation already
  started as one keeps running.
- **A dynamic workflow is a row in the Chat list.** `task:all` takes
  `dynamic/` as a NAMESPACE (a root id is minted and cannot be listed ahead of
  time), and a conversation controlling work says how much: `TaskSummary.controls`
  counts the tasks filed under it, adopted by it or made by its fan-out.
- **The note under a tool row is the tool's own answer.** "adopted into
  **feature** as `product` · standing at `ux`" is drawn from what `move_task`
  returned, inline under the row that returned it, in the glyph and words a
  `made` or `entered` note uses. It is not a rail row: a rail row is built from
  the journal, and nothing in the journal says what a tool answered. A refused
  call draws no note — the row's mark and its result already say it once.

## What step 7 settled

Built in `@jaira/shared` (`fastForward.ts`, `config.ts`, `configSchema.ts`),
`@jaira/runtime` (`autopilot.ts`), `@jaira/persistence` (`connect.ts`,
`dynamicDocuments.ts`, `views.ts`) and the app (`main/fastForward.ts`,
`AppService.fastForwardTask` and its neighbours, the strip, the gate, the
notes, Settings), with no upstream change. The statement of record is
[task-channels](../contracts/task-channels.md) (`task:fastForward`, `task:skip`,
`task:answerYourself`), [gate-components](../contracts/gate-components.md) ("Who
may answer"), [settings-json](../contracts/settings-json.md) (`autopilot`),
[interaction-gateway](../units/interaction-gateway.md),
[activity-strip](../../ui/components/activity-strip.md) and
[gate-surface](../../ui/components/gate-surface.md). What the text above left
open:

- **A fast-forward is a mode, not a transition.** Nothing is handed to the
  engine: the task is started or resumed and its own spine walks it to the
  target. `connect`'s forward move asks the host for the MODE
  (`ConnectHost.fastForward`), which is held in the memory of the process
  driving the run (`ProjectSession.fastForwards`) and says four things — who
  answers on the way, what the strip says, what Skip is aimed at, and when it
  ends. Nothing in the journal is a fast-forward, so a process that did not
  start one never answers for anybody: after a restart the task is where the
  machine got to and its questions are the person's. A host that drives no run
  (the CLI) has no `fastForward`, and there a forward move is still refused
  with `fast-forward`: nobody there could answer on the way. *(Amended
  2026-09-22: the journal now holds the mode's start and end, and a restart
  resumes it — see "Made durable" below.)*
- **"Adopted into one first" is a graft, not a wrapper.** Wrapping the task in
  a new parent would make the PARENT the thing that moves, and a fast-forward
  is a move of the task's own machine through its own workflow. So a task with
  no conversation is given one on its own root — the conversation state's
  operation grafted onto the task's frozen root with no child and no rule added
  (`ensureControlConversation`, the same graft a clone does) — and is its own
  control. The idle rule is what keeps that from spending a call. A task whose
  root already speaks, or which stands under a task whose root does, is
  answered by that one.
- **A running task with no conversation is refused, before anything is
  written.** Its engine holds the version it loaded and cannot pick up the
  graft; the refusal says to pause it, as a new transition's does. The dry run
  says it too (`ConnectHost.fastForwardBlocked`), so a hover never offers a
  drop that will be refused. A running task that DOES have its conversation is
  registered on the live run, and nothing is restarted.
- **The conversation is asked for a value, and the host does the answering.**
  One prompt call outside any run, as a follow-up round is made
  (`autopilotOperation`): the conversation's thread read as context, the work
  and where it is going, and the question exactly as the person would see it,
  with the component's result shape. It returns `{answer, confidence, reason}`.
  The HOST holds the confidence against `autopilot.askBelow` and only then
  calls the same `answer` the `answer_question` tool is — because a model that
  decides whether it is sure enough has been handed the setting. The call reads
  the conversation and does not continue it, so nothing appears in the
  conversation for an answer; the answer is drawn on the gate it settled.
- **Never an approval, three times over.** The fast-forward is reached only from
  the gate hub's and the question hub's `onRequest`; the approval hub's never
  calls it and neither half is handed that hub, so a tool permission, a push, a
  merge or `remote.publish` cannot get there. Of the gates, only
  `ANSWERABLE_COMPONENTS` are offered — `confirm_action` and `review_artifacts`
  are left to the person without a model seeing them. And `answer` refuses them
  by component anyway.
- **An answer is checked before it is recorded.** Step 6's `answer` journaled
  first and submitted second, so an answer the contract refused left a
  `jaira.answered` row claiming a settlement that never happened. It now asks
  the contract first (`checkInteraction`), and names the instance it settled
  (`askingInstance`: the one running operation that can be parked there, or
  none when two could be).
- **The mark is the row, folded.** `markAnswered` puts `settledBy` on the
  instance the `jaira.answered` row names — the first such row, for a follow-up
  round answered again — so it survives a restart, a reopen and a resume with
  nothing else to keep. The resumed run does not ask an answered gate again
  because the gate's completion is in the journal like any other.
- **"Answer it yourself" rewinds to the ENTRY, not to the answer.** A cut keeps
  the settle of a call that started before it (`partitionAt`, right for a
  conversation cut mid-turn), so cutting at the answered row keeps the answer's
  completion and asks nothing. `settledBy.at` is the seq of the state's entry;
  the cut takes the entry, the answer and everything after, and the state asks
  again. A fast-forward still going is ended and its run stopped first, since a
  rewind refuses a running task, and the person has taken the work back.
- **It ends on arrival, and on the run going anywhere else.** Arrival is the
  entry of the target's child key (under the named composite at the top level);
  a state on the way ending `error` or `timeout`, the run ending, a stop, and a
  Skip end it too. A question parked after it ends is the person's — which is
  what makes the target's own questions theirs.
- **Skip is the existing Skip.** `task:skip` is `task:move` with `skip: true` to
  the fast-forward's target, so the engine journals the transition and every
  state it steps over `skipped` BEFORE it aborts anything: the interrupt trap's
  answer is upstream's (`directedTransition.test.ts`, "SKIP decides before it
  interrupts…"), and JaiRA asserts the order in the journal and that the run
  does not walk into the next intermediate. The mode is ended first, so a
  question raised on the way down is the person's.
- **The stale inbox is closed where it can be told apart.** An agent's parked
  approval and `AskUserQuestion` cannot see a skip — `Approver` and `AskUser`
  take no signal, and a request names a task, not an instance — so each run's
  journal is watched instead (`SkipWithdrawals`): when a child ends `skipped` and
  every prompt operation still running is inside it, the task's questions are
  dismissed and its approvals denied once. Every Skip gets this, not only a
  fast-forward's.
- **`autopilot` is a layered block, and a person's.** `{askBelow: 0.2}` by
  default, strict from 0 to 1, drawn in Settings by the declared form beside
  Memoization and Workflow lookup, and left out of the file `initProject`
  writes, so a project does not silently override the shared root's answer.

## What the ask-after drop settled

Built 2026-09-22, closing the Open entry "the board does not send `askAfter`
yet". The statement of record is [task-channels](../contracts/task-channels.md)
(`askAfter`, `asking`, `ConnectUndo.asking`) and
[task-board](../../ui/components/task-board.md) (the `asking` state).

- **The board sends it on the hover and the drop alike.** The dry run with
  `askAfter` answers `ok` with `asking` and writes nothing, so the column lights
  and the preview says the drop opens a conversation that will ask for each input
  by name, with its description. Every other refusal is what it was.
- **The opening turn is a turn, not an operation.** The conversation still
  starts idle (step 6). The host then runs one turn of it, as a typed turn runs,
  whose message (`askingMessage`) says what the person did and lists each open
  input by its declared name, description and schema, and tells the model to ask
  in plain words and to call `start_task` with the answers named in `asked`. The
  reply is the question. Nothing in it is a name the platform chose (§0); the
  names are the target's own, passed through because `start_task` takes them.
- **An idle conversation can now be typed into.** It had no record, so there was
  no position to continue; its first turn begins a session named after the root
  (`chat:<root>`), and the thread reads from there. A document's task a drop made
  has only the document, never a pinned snapshot of its own, so the chat context,
  the generator and `connect`'s rule 3 read the document's latest version.
- **Undo takes the conversation with it.** A turn of a made task's conversation
  is not work of its own, so the task is still removed; a turn in flight is
  stopped and waited out first. A clone or an existing document the drop only
  gave a turn to is cut back without the resume a rewind would do
  (`ConnectUndo.asking`), its pin and status put back.

## Made durable (2026-09-22)

Three things a person asks for lived only in the memory of the process that
was asked, and a restart lost them. They were on the Open list below and in
steps 1, 5 and 7 above; each is now written where the next process finds it,
host-side, the way a parked gate was made durable, with no upstream change. The
rows are [journal-events](../contracts/journal-events.md)' "What a person asked
of a task that outlives the process"; the code is `@jaira/persistence`
`hostRows.ts` and the app's `main/hostModes.ts`.

- **A fast-forward** journals `jaira.fastForward` when it starts and
  `jaira.fastForwardEnded` when it ends — arrival, a failure on the way, Stop,
  Skip, or a rewind, which is a person taking the work back. A session that is
  closing writes no end (`ProjectSession.closing`), and the close records the
  run `SUSPENDED_FORWARDING`, so the next open resumes it unasked; a crash's
  `interrupted` task waits for Resume, as every crash does. Either resume puts
  the mode back on the session before the run starts: the conversation answers
  what comes up, the strip shows (`answered` recounted from the `jaira.answered`
  rows, `step` and `at` from the entries), and Skip works. It is still reached
  only from the gate and question hubs, so an approval never gets there after a
  resume either. `left` starts again from nothing, and a question the
  conversation left to the person before the restart is offered to it once more
  under the request id the resumed run parks it with.
- **A held move** journals `jaira.moveHeld`; a directed `transition.taken` on its
  instance is its taking, and the run-end handler writes `jaira.moveDropped` for
  one a run ended without taking, unless the session is closing. The resume
  re-queues every outstanding hold on the run's port, and the loaded engine
  takes it when the state it waited for ends. A Stop drops it, as it did in
  memory: a stop is the later word.
- **Undo** is kept on the card's task file (`TaskMeta.connectUndo`), a move's
  place in the journal counted in rows, because a seq does not outlive a
  replay; `task:connectUndo` with a `taskId` uses the kept token and clears it.
  A reopening of a finished task journals `jaira.reopened` with the row's
  outputs, and a rewind back past it — an Undo — puts the task back finished,
  outputs and all.

**Amended 2026-09-22 — Undo means only "take back what I just did".** Kept
that way, a card offered Undo until it was used, and an Undo pressed hours
later would rewind the task to the drop and throw away everything it did since.
The person's ruling: the token stays durable, and ends at the next decision
about the task or at the task's own progress past where the drop landed.

- **Where it lives.** `@jaira/persistence` `connectUndo.ts`. The judgement is
  ONE rule, `staleReason`, run on every read: by `undoable` on the board and
  task list, and by `undoConnect`, which refuses a stale token plainly and
  drops it, whatever window still offers it. The renderer keeps no token; it
  draws Undo where the board says `undoable`. Judged on read because progress
  is only visible in the journal, and a rule on read cannot be forgotten by a
  future action that moves the task on.
- **Decisions are dropped where they are made**, because most of them leave
  nothing in the task's own journal to judge afterwards (a fork's source, a
  re-run's predecessor, a stop of a task that is not running, a rewind inside
  the landing): in the primitives every host shares — `rewindTask` and
  `forkTask` (so a split too) in `cut.ts`, `cancelTask`, `writeAdoption` for
  the adopted task, and `connectTask` for the task it moved — and in the app's
  `cancelTaskIn` and `rerunTask`. A connect REPLACES the token: the host keeps
  its own after the primitive dropped the old one. A later `task:move` needs no
  site of its own: what it writes (a `jaira.moveHeld`, a reopening, an entry
  outside the landing) is caught by the rule. A close is not a decision.
- **Past the landing, per kind.** The token now carries `landing`
  (`standsAt.path`), `kept` (the watched journal's rows once the drop's own
  writes were in) and `asking`. *A move:* the landing settles with any outcome
  but `canceled` (an unwinding — a close, a crash, the Stop that already ended
  it — not a settle); anything outside it is entered; a state of the task's own
  finishes `success` after the drop, which is the state a held move waited for;
  or a turn of the task's conversation is taken. The way down to a nested
  landing, the landing's children, and states stepped past are the drop's.
  *An adoption:* the same on the parent's journal from the mirror row on, and
  the adopted task entering or settling anything after the drop. *An `asking`
  drop:* its conversation's turns are the drop's; its `start_task` mounting the
  target (a `jaira.supplied` or a `jaira.moved` of `start_task`, or any entry
  outside the conversation) ends it — from then on taking the drop back is a
  rewind. *A fast-forward:* everything while it runs is the drop's; on arrival
  the target is the landing; a Skip or a Stop ends it; a failure on the way
  leaves it offered.
- **The drop's own run is stopped by Undo.** Undo used to refuse a running
  task, which a Stop would now end — so a landing parked on its gate could
  never be taken back. The run a drop started is the drop's effect: Undo stops
  it in this process and waits it out, then takes the drop back. A run another
  process drives is refused. A parent the drop made is always removed, since
  everything it did was the drop's.
- **A retry does not bring it back.** A retry deletes the failure it revives
  (`releaseRevivedFailures`); the token is judged first (`settleConnectUndo`),
  so an Undo the landing's failure ended stays ended.
- **Cut at the task's own first row after the drop**, not at `after + 1`: seqs
  are the table's, and the drop's own resume deletes the unwound rows it stood
  behind.

What stays in memory: the descent follower of a move to a nested target, so a
process that dies after such a move was taken and before the way down was
directed leaves the composite walking its own spine.

## Open

- A finished task publishes no runtime wait, so a "→ ui" chip offering a
  known move cannot come from the engine's waits, and reading the document
  for it in the renderer was rejected when `on_user_event` was built. It
  ships without the chip.
- A named session continued across an adoption boundary (a refine loop
  whose earlier passes ran in the adopted task).
- An adopted child that fans out (`each: "inline"` or `"task"`) is refused:
  one task cannot stand for a batch. Adopting a whole batch is not designed.
- A new transition for a task that is running: refused until it is paused.
  Stopping it and reopening it with the move is `skip` by another name, and
  was not taken without being asked for.
- A connect that refuses part-way — the adoption into a new document's task,
  a move after an adoption — leaves what it had written, and says so.
- A drop that asks after (above) does so only where the workflow is MODIFIED. A
  move within the task's workflow, or an adoption, that leaves a required input
  unbound is still refused with what is missing: there the target is already
  mounted, and asking would mean grafting a conversation onto a workflow that was
  not being changed.
- The opening turn of a conversation a drop made is drawn as the person's
  message, as a `chat/control` opening line always would have been; nothing
  marks it as the host's.
- A fast-forward of a task that is RUNNING with no conversation is refused
  until it is paused, for the reason a new transition is.
- A skip that lands while an agent OUTSIDE the skipped subtree is still running
  (an `async` sibling) withdraws nothing — whose ask is whose cannot be told —
  and those asks stay on the inbox until answered or the task is stopped. An
  upstream signal on `Approver` and `AskUser`, or an instance on their requests,
  would close it.
- A question stays on screen while the conversation considers it; a person who
  answers first wins, and the conversation's answer is counted as left to them.

Closed 2026-09-22 (three drawing gaps from step 7's list, no upstream change):

- **"Answered for you" draws under an agent's `AskUserQuestion` too.** A
  `jaira.answered` row of kind `question` now carries the question TEXTS it
  answered; the projection keeps every such row on the instance
  (`InstanceNode.answeredQuestions`), and the transcript marks the block asking
  exactly those questions (`markAnsweredQuestions`) with the gate's own line and
  "Answer it yourself" — the same rewind to the state's entry. The texts are the
  join because the question hub's park carries no tool-call id; a row written
  before this, with no texts, is drawn only where nothing else could be meant.
- **The states a Skip never entered are one row** —
  "skipped · never entered · feature → ui, engineering" — and the interrupted
  state keeps its own ("skipped · interrupted at 1 m 12 s"). Grouped in
  `notesOf` (`groupNeverEntered`): consecutive, same mount, nothing between.
- **What a conversation's `start_task` / `move_task` did is a row on the rail.**
  The host now journals it on the conversation's own task as `jaira.moved`
  (`{tool, task, outcome}`, host vocabulary like `jaira.answered`), the
  conversation view projects it as a `moved` turn, and the band builder draws it
  as a note — cutting the conversation's band after the turn that made it
  (`splitAtNotes`) so the row sits between that turn and the next, as the mockup
  has it. Chosen over teaching the band builder to read record contents: the
  rail is built from the journal, and a fact about the work belongs in the
  journal, where a rewind cuts it with everything else. The one-column Chat view
  has no rail and still draws the same words under the call; which of the two a
  transcript does is its host's choice (`CallSurface.outcomes`). The cut is at
  turn granularity: a note follows the whole turn that moved, reply included.

## Revisit when

Answers given for the person are rewound more often than they are kept; or dynamic
workflows are saved so rarely that the document format is ceremony and a
plain chain of tasks would have done.
