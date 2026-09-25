---
id: engineering/decisions/0010-git-tools-and-events
type: decision
status: accepted
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
first-match; a later line an earlier one always catches is flagged "not reached".

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
