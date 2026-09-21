---
id: engineering/decisions/0005-connect
type: decision
status: proposed
updated: 2026-09-21
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
| `workflows` | lists workflows and a state's label, description and input and output schemas, a level at a time |
| `start` | `connect` from the conversation itself: a new child. Its input schema **is the target state's input schema**, with what the host could bind already filled |
| `move` | `connect(task, target)` — forward, backward, across workflows; `skip: true` goes directly |
| `tasks` | what was started here, where each stands, what each produced |
| `answer` | settles a question a child is asking (§4) |
| `hold`, `release`, `stop` | what the board's gestures do |

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

- **The control conversation answers what comes up**, through `answer`:
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
ship asking, as a conversation does today; a project that wants `start` to
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
  tool call and a nested state already do: the `start` row, the child on
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
6. **The conversations** (needs 0006): the `workflow` toolset over
   `connect`; `chat/session` growing its first child; `chat/control` for a
   task that becomes a dynamic workflow.
7. **Fast-forward**: `answer`, `settled_by: control`, `autopilot.askBelow`,
   the strip, Skip.

Each step is usable on its own. 1–3 already answer "one phase" and "use
what ran".

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

A held move lives in the engine's memory and is lost with the process.

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

## Open

- A finished task publishes no runtime wait, so a "→ ui" chip offering a
  known move cannot come from the engine's waits, and reading the document
  for it in the renderer was rejected when `on_user_event` was built. It
  ships without the chip.
- A named session continued across an adoption boundary (a refine loop
  whose earlier passes ran in the adopted task).
- An adopted child that fans out (`each: "inline"` or `"task"`) is refused:
  one task cannot stand for a batch. Adopting a whole batch is not designed.
- The board's `.card-child` indent for an adopted task is not built: the
  task files in its child's column on the parent's board, as a mount's task
  does, and is off the roots board.
- Whether `connect` from the CLI is one verb (`jaira task move <id> --to
  <state>`) or rides `task create --from`.

## Revisit when

Answers given for the person are rewound more often than they are kept; or dynamic
workflows are saved so rarely that the document format is ceremony and a
plain chain of tasks would have done.
