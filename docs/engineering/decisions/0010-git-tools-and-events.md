---
id: engineering/decisions/0010-git-tools-and-events
type: decision
status: built
updated: 2026-09-25
decides_for: [engineering/units/tool-policy, engineering/units/remote-review]
---

# 0010. Git tools, events, and the events task

Mockup and every ruling: https://claude.ai/artifact/GZQTHFjs3e67mWVFbvtYeY (v3). The person's words are
quoted where they settle something; nothing below re-opens them.

## Context

The GitHub and GitLab connections (decision 0004) are signed in, but only `review_artifacts.remote`
and the workflow primitives `remote_*` use them. An agent has no tool that reaches the forge, and
nothing in JaiRA starts a task because something happened outside it: `on_user_event` and
`on_remote_event` only continue a task that is already running, and `on_remote_event` only watches a
merge request that task opened itself.

## Decision

### 1. Git tools — a `git` category of agent tools

Nine tools in `TOOL_SPECS` (shared/src/toolVocabulary.ts), category `git` ("Git — the repository's
forge, through the connection signed in on Connections"), after Web. A `git_` prefix only where the bare
name is too generic ("not every git tool needs a git prefix, just ones that are too generic"):

| Tool | Does | ask-first · auto · full · read-only |
| --- | --- | --- |
| `list_merge_requests` | this repository's merge requests, by state, author, branch | ask · allow · allow · allow |
| `read_merge_request` | one: description, state, threads, approvals, checks | ask · allow · allow · allow |
| `git_checks` | the CI pipeline / check runs of a branch or commit | ask · allow · allow · allow |
| `wait_git_event` | wait for an event on the remote (a comment, checks finishing, a push), or its timeout | ask · allow · allow · allow |
| `open_merge_request` | push the branch and open (or update) its merge request | ask · smart · allow · deny |
| `git_comment` | comment on a merge request, reply in a thread, resolve it | ask · smart · allow · deny |
| `git_merge` | merge a merge request | ask · ask · allow · deny |
| `close_merge_request` | close without merging | ask · ask · allow · deny |
| `git_push` | push the current branch with the connection's credentials | ask · smart · allow · deny |

`chat_control` sets do not offer them. The connection answering is the one for the workspace's git
remote (`.git/config` → `parseRemoteUrl` → `connectionForHost`); a call with none is refused with the
sentence Settings shows ("no connection for github.com — sign in on Connections"). `wait_git_event`
has a timeout (default 10 min, at most 1 h) and answers "nothing yet" when it passes; a long wait is a
workflow's `on_event`, not a tool call.

Connections → Forges, a forge row OPENED (not at rest): its first line is "Used by 9 Git tools —
list_merge_requests, git_push and seven more, on Tools → Git" (option B; plain, no border or tint).

### 2. Events — watched, never configured by hand for where

An event is something that happened on a remote (`git.*`) or in JaiRA (`task.*`):
`git.push`, `git.merge_request.opened`, `git.merge_request.updated`, `git.merge_request.comments`,
`git.merge_request.merged`, `git.merge_request.closed`, `git.checks.failed`, `task.finished`,
`task.failed`. `git.merge_request.comments` is ONE event carrying `comments: [...]`, however many
arrived.

**Which remotes.** A project's remotes are read from its `.git/config`; each remote's host picks its
connection. Nothing about where is typed ("this shouldn't need manual configuration"). Shared's own
remotes are Shared's own `.git/config` — usually none, since `~/.jaira` is not a repository — so a
Shared line never fires twice for one project's push.

**Which events.** The `events` block of `settings.json`, layered like every setting (Built in < Shared
< This project < Just you): per event, on/off, a branch glob list where it applies, and per remote
on/off. Off is the default. A remote with no signed-in connection cannot be switched on.

**Delivery is polling** (decision 0004: no push channel reaches a desktop app) — per project per
remote, 60 s while JaiRA is open and something is switched on. A repository watcher keeps, per
project/remote, the last state it saw of each merge request and branch (a new table), and turns a
difference into events.

**Missed while closed: the latest state only.** "Lets skip fast forwarding transitions. We should only
handle a transition for the latest state that we missed." On start, each merge request and branch is
compared with what was last seen and at most ONE event fires for the difference: opened while closed →
`opened`; opened and closed while closed → nothing; last seen open, now merged → `merged`; a branch
head that moved → one `git.push` old..new. A state reached by an event reads the forge LIVE.

### 3. `on_event` — a deferred guard for any workflow

`on_event(name, filter?)`, the sibling of `on_user_event` / `on_remote_event`, resolves to the event
(its payload) when a matching one arrives for the running task's project. Any workflow may wait on
one; an event switched off in Settings cannot be waited on (a lint flags it). The hub keeps a queue per
task of the events that arrived for its project since it started waiting on that kind, so an event
that lands while no wait is registered (a guard between rounds) is not lost; `on_event` takes the
oldest match. Unlike the other two it
is NOT answered `false` when nobody is attending: waiting for the world is its whole point.

### 4. The events task — tasks starting tasks through the framework

"I want to use tasks to start other tasks using events and the framework we have." A built-in workflow
`$SYSTEM/workflows/system/events.json`, run as ONE task named `events` per project (every project JaiRA
opens) and one in Shared. It is created when its workflow has at least one automation, restarted when
it ends or is interrupted, and runs unattended with its own permission set (`start_task` and the
notice only).

Its shape: state-level transitions, each **named** (`name`), `when: on_event(...)`, `to` ONE `async:
true` child. Several things on one event are that child's own transitions to the next child ("have
one async child and have a transition from that async child to the next child"). Transitions are
first-match; a later line an earlier one always catches is flagged "not reached". *(Reworked the same
day: the child is ONE state whose operation is a list of calls — see "Reworked after the rulings of
2026-09-25" below.)*

Layering is the workflow machinery, not settings merging: a project's
`.jaira/workflows/system/events.json` `$ref`s Shared's and overrides the transitions block, its own
lines FIRST, then Shared's, minus any it ignores:

```jsonc
"transitions": [
  { "name": "release_push", "when": "on_event('git.push', { branch: 'release/*' })", "to": "release_build" },
  { "$ref": "...filter($BASE/workflows/system/events.transitions, (t) => !['push_main'].includes(t.name))" }
]
```

Settings → Tools → Automations is the nice editor of that file (copy-on-edit of the built-in, like
permission sets). Each started task records where it came from; its board card says "started by
events · git.push a1b2c3d on main".

### 5. Engine additions (declarative-ai)

What the research found the engine lacks (2026-09-25):

1. **A transition's `name`** — optional, unique within its list; not part of any call's identity.
2. **`.event` in a transition's `inputs`** — the value the rule's deferred call resolved to. Today
   nothing binds a guard's result into the target, and repeating the call in `inputs` parks again.
3. **Guards stay armed while async children run.** After a transition enters an async child the loop
   blocks in `waitForAnyChild` with no deferred call registered, so the rule is deaf until a child
   finishes. The state-level rules must re-register their waits in that round.
4. **A rule whose async target is still running is not re-armed until it finishes.** Today re-firing
   would reach `enterChild`, which aborts the running record. Instead that one rule stays unarmed
   (every other rule stays armed, per 3); nothing is lost, because the event hub QUEUES events per
   task and `on_event` takes the oldest matching one, so the next push is handled when the chain the
   last one started has finished — in order.
5. **`$ref` expressions** — a `$ref` that is not a path spelling (`isPathSpelling`) is an expression
   evaluated at LOAD time over the referenced documents: arrow lambdas (`(t) => …`), a `filter`,
   and a leading `...` that splices an array result into the array it stands in.

## Build order

1. Engine (one agent; the only one touching declarative-ai) — §5, with SPEC/NAMES text and tests.
   In parallel: forge operations + the nine Git tools (§1, `wait_git_event` last); the `events`
   settings block and the event vocabulary (§2).
2. The repository watcher, its table, `on_event`, `wait_git_event` (§2–3).
3. The events task: built-in workflow, supervisor, the unattended permission set, task origin (§4).
4. Settings: Events, Automations, the Connections line; the board's origin line.

## Built (2026-09-25)

- declarative-ai fc7b899: transition `name`; `.event` in a rule's own `inputs`; `HostCapabilities.listens`
  (a listening wait does not stop the rule list — on `on_event` only); guards armed while async
  children run; a state-level rule whose async target chain still runs is skipped; `$ref` expressions.
- 5d2fb68f the nine Git tools and five forge reads; 0724d31b + 44255a4f the event vocabulary, the
  `events` block (paths as key lists: event names have dots); 772f1350 the repository watcher
  (migration 20), the per-project event hub, `on_event`, `wait_git_event`; 7c92fc93 the events task
  (`system/events` + the step states `system/events/start` / `notify`, `start_task` / `notify`,
  `TaskMeta.system = "events"`, `startedBy`, the supervisor, the lint, the board line); e747abc4
  Settings → Tools → Events and Automations, `events:status`.
- Spellings as built: a rule's inputs use `{ "text": … }`, `{ "json": … }` and
  `{ "$literal": { … { "$binding": ".event.payload.x" } … } }`; a later step reads
  `.children.<prev>.output.event`; a `$BASE` miss does not fall back, so Shared's copy
  (`{ "$ref": "$SYSTEM/workflows/system/events", "transitions", "children" }`) is written first.
- Open (as first built): `notify` notices have no surface yet (pushed as `notice:posted`, logged); a
  started task does not record which rule fired; comments by the connection's own account never fire
  `git.merge_request.comments`; Shared's lines are edited on Shared, not from a project page.

### Reworked after the rulings of 2026-09-25

The person's rulings, the same day (not re-opened here):

1. **An automation is ONE state whose operation is a LIST of calls** (hw SPEC §7.1d). "Tell me" is a
   function call (`notify`), and so is a start (`start_task`). The built-in step states
   `system/events/start` / `notify` and the `<name>_2` chaining are gone.
2. **`start_task` starts the task as the calling state's CHILD** — provenance and mirrored rows, as a
   hosted fan-out's `each: "task"` does — so the events task lists what it started; `top_level: true`
   starts it ON ITS OWN, `startedBy` saying where from (the refinement of the same day).
3. **Every comment JaiRA posts is signed**, and JaiRA knows its own words by the signature's marker,
   not by the account.

As built:

- **The shape** (`@jaira/shared` `automations.ts`, which the editor and the migration both write).
  A line `<name>` is the rule `{ name, when: "on_event('git.push', { branch: 'main' })", to: name,
  inputs: { event: ".event" } }` into the child `name: { "async": true }`, whose state is the default
  `./<name>` — `system/events/<name>.json`, a state file beside the root in the layer that holds the
  line. That state takes `event` (`{ schema: {}, optional: true }`), declares NO outputs (a list must
  bind every output it declares, and nothing reads one), and its steps are `"operation": [ { "function":
  "start_task", "args": { "workflow": "feature/review", "inputs": { "issue": { "$binding": { "$expr":
  ".inputs.event.payload.commits[0].message" } }, "ask_below": 0.8 }, "title"?: …, "top_level"?: true } },
  { "function": "notify", "args": { "text": "…" } } ]`. In `args` a string is a literal; a pick from the
  event is WRAPPED (`$binding`, SPEC §5.3) and spelled `$expr`, because the loader takes a bare
  `.inputs.<name>` reference only one segment deep.
- **Who called** is not an argument: the engine puts the dispatch site on every call's context
  (`ExecServices.scope` — the calling instance, and `-i` for call i of a list), and the service reads
  the rest off the events task's journal (`callingStateOf`): the instance's child key (the automation),
  its path, which entry of that key it is (the firing), and the event it was entered with. `notify`
  names that event when the call does not.
- **A child** (the default) carries `origin: { kind: "started", taskId: <events task>, key:
  <automation>, occurrence: <firing>, index: <call>, event: { name, summary }, state: { stateId, path }
  }` — a new provenance kind, not `task`: a started task runs in its OWN workspace (a `task` child runs
  in its parent's) and is no element of a mount. It is mirrored into the events task's journal as an
  `instance.entered` whose instance id is the task's, parented at the calling instance, marked
  `started: true`, with no child key; its end (`completed`/`failed`/`canceled`, not a close's suspend)
  as `instance.terminated`. The load leaves those rows out of the machine (the calling state never
  mounted it); the Steps list shows the task as the automation's child (`InstanceNode.made`), the
  conversation draws "started <title> · running" at the automation, and boards file it as a fan-out's
  task is — in the automation's column of the events task's board, off the roots. A re-run call after
  a crash finds the task it already made (`startedTaskOf`) rather than making a second.
- **On its own** (`top_level: true`): no provenance, nothing mirrored; `startedBy: { by: "events",
  fromTask, state: { key, path, stateId, occurrence, call }, event, summary }`. `startedBy.state` is
  optional; no real task had a `startedBy`, so nothing was migrated.
- **The card line**, either way: "started by events · push_main · git.push a1b2c3d on main"; a click
  opens the events task AT the automation (`select(taskId, project, stateId)`).
- **Layering.** A project's copy of the root still `$ref`s Shared's and splices its rules. An
  automation's state resolves through the layers on its own, so editing a Shared line's STEPS on the
  This project page writes the project's own `system/events/<name>.json` — for that project alone,
  with no copy of the root — and the line says so ("Use Shared's steps" takes it away); editing its
  event, filter or name ignores Shared's rule there and adds a project rule of the same name. Shared's
  lines are editable on a project page now.
- **Migration** (`persistence` `eventsMigration.ts`, at every open of a project and of the shared root):
  a copy in the old shape — Shared's and a project's own lines — is rewritten into the new one, each
  automation's state written before the root, the original kept under
  `<system>/logs/events-migration-<stamp>/`; a line it cannot take apart is left and named. The
  person's real data (2026-09-25): `~/.jaira/workflows` holds `feature*` and `plan` only, and the one
  project JaiRA knows (`C:\UbuntuCode\JaiRA`) has an empty `.jaira/workflows` — no `system/events` in
  either — so the migration had nothing to do there.
- **Signing** (`signComment`, `isJairaComment` in `@jaira/shared` `forge.ts`): every comment and reply
  JaiRA posts — `git_comment` (comments and thread replies), `remote_comment`, the review gate's thread
  replies after a revise round, its notes and closing line when a person answers in JaiRA, and the
  reviewer's `remote:reply` — begins "🤖 <model> · via JaiRA" and ends
  `<!-- jaira:comment model=<model> task=<taskId> -->`. The model is the one behind the call where the
  host can tell it (`modelOfCall`: the conversation's last recorded model, else the model the call's
  own record asked for); where none asked — a person's words carried, the closing line — the first
  line is "🤖 JaiRA" and the marker says `model=JaiRA`. The marker must END the body, so a comment
  quoting one part-way is still somebody's.
- **JaiRA's own is the marker.** The forge readers set a comment's `own` from the marker (the account
  lookup they made for it is gone), and the repository watcher excludes marked comments explicitly, so
  the person's own comments from the connection's account fire `git.merge_request.comments`. Decision
  0004's `own` rule was protecting against JaiRA reacting to ITSELF — its closing line, its notes, its
  thread replies settling or restarting the gate — so it follows the marker too: the person's own
  comments, reviews and approvals from the token's account now COUNT (settle a gate, start its window,
  decide a change) where before they were shown and ignored; JaiRA's signed comments still never do,
  and a revise round's "last word is JaiRA's" test reads the marker. Comments JaiRA posted before
  signing read as the person's.
- Still open: `notify` notices have no surface beyond the log and `notice:posted`.
