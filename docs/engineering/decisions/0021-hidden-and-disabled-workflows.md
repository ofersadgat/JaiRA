---
id: engineering/decisions/0021-hidden-and-disabled-workflows
type: decision
status: built
updated: 2026-10-26
decides_for: [engineering/units/project-store, engineering/units/app-shell]
---

# 0021. Hidden and disabled workflows

The person, 2026-10-26: "I want you to be able to enable/disable workflows/workflow-trees."

Mockups (round 2, which replaced round 1 at the same link): https://claude.ai/artifact/URmovRn7Js2BnE8XRZMwHU

## Rulings (2026-10-26)

On round 1:

1. "there are two things here: hide/disable. Hide is just a view property. Disable should stop any new
   runs and should be hidden from the workflow list sent to an agent."
2. "the switch shouldnt be in settings. that is because this isnt an application setting, its a
   workflow configuration. the state should live with the workflow (e.g. the json should have a
   "disabled": true field)."
3. Nothing is locked: the chat workflows can be disabled, "but if they are disabled, then chat sessions
   must ask you which workflow to use. What does make sense as a setting is: what is the default
   workflow to use for a chat session."
4. A column with tasks in it: "Again, this is hidden vs disabled."

On round 2's three questions: "1. agree. 2. no, if a running state is supposed to transition to a
state/workflow which is disabled, it errors. 3. agreed". Hiding a column leaves the workflow in New
task; a run that enters a disabled state fails there; a workflow picked in the empty Chat room is for
that conversation only.

## Decision

**Disabled** is `"disabled": true` in a state file (WORKFLOWS.md §2.3). It switches off the state and
every state under its id, as the WINNING file for the id says it — itself, or the file it follows.

- **No new run starts there**, whoever starts it. Every fresh start and every adoption pins through
  `pinWorkflow`, which refuses with `Not run: 'x' is disabled.` (`persistence/disabled.ts`). A
  conversation's `start_task` and a move onto one (`connect`, so a board drop, `move_task` and the CLI)
  are refused before anything is planned: `Not moved: 'x' is disabled.`
- **A running workflow that enters one fails at the entry** (ruling on question 2). The engine asks the
  host before every child entry (`EngineConfig.entryRefusal`, declarative-ai), and JaiRA answers from the
  files as they stand then. A refused child is blocked like a child whose wiring failed: `instance.blocked`
  with the words, the record failed, and a rule on the mount that names the failure may handle it. A
  task already running carries on until it reaches one, which is also why a switch made while a run is
  going reaches it.
- **The switch is never part of what a run follows.** The loader drops `disabled` from every loaded
  state, so a snapshot is the same with it or without it, and switching a workflow does not make its
  running tasks read as drifted. A file that says only `$ref` and `disabled` is read AS the file it
  follows, before permission sets are lowered (`followedOf`): the engine's own `$ref` expansion comes
  after the lowering, and would otherwise meet a followed `"tools": "$/permission-sets/…"` unlowered.
  A move's conversation is likewise checked as it loads, not as its file reads.
- **An agent is not shown it.** `list_workflows` leaves a disabled workflow out, refuses its detail, and
  marks a disabled child `disabled`.
- **Where it is set.** The Configuration form's Disabled row (the same field as the JSON tab); the Run
  tab, which says the state is disabled and offers Enable; the file tree's menu; and a board column's
  menu, which is how a project reaches a Shared workflow. `workflow:setDisabled` writes it: a field in a
  layer that holds the file (a format-preserving edit), or a file there that FOLLOWS the nearest one
  below (`{ "$ref": "$BASE/workflows/feature", "disabled": true }`). Enable takes the field out, deletes
  a file left saying only what it follows, and writes `"disabled": false` where what it follows would
  still switch it off. On an inherited workflow the menus say "in this project" (a file in the project)
  and "in every project" (Shared's own file, or one there that follows what ships).
- **Where it shows.** The tree's `disabled` chip, its tooltip saying which layer wrote it; the board
  column's `disabled` chip (the column stays); the New task picker lists it greyed.

**Hidden** is a board view setting, per window on this machine: `ui.shut["board:<project>"]`, the
workflow ids hidden from that board. A column's menu has Hide column; "N hidden" in the Tasks title
bar lists the board's columns with a tick each and Show all. A hidden workflow runs, starts from New
task, and is listed to an agent.

**Conversations** (ruling 3) are a setting, `conversations: { workflow, moved }`, on Settings → Runs →
Conversations. `workflow` is what the Chat view starts a conversation as (default `chat/session`),
`moved` what a move that makes a dynamic workflow gives the task to steer it (default `chat/control`).
Either may be any workflow that takes ONE required text input — `WorkflowEntry.conversationInput`
names it, and what is typed fills it.

- Where `workflow` is disabled, the empty Chat room asks: "Session is disabled in this project, so
  choose what this conversation runs", a dashed choice opening "Run this conversation as". The
  composer is off until a pick, and the pick is that conversation's alone.
- Where `moved` is disabled, a drop that would make a dynamic workflow asks the same in its confirm
  box (`ConnectPlan.chooseConversation`); the pick rides the drop again as `TaskConnectRequest.conversation`.
  A fast-forward, which has no box to ask in, is refused and says where to choose another.
- **A conversation is one because the Chat view started it**, not because of its workflow's id:
  `startedBy: { by: "chat" }` on the task (`isConversation`, which also counts a dynamic workflow's
  task). Before this, `isChatWorkflow` read the id, so a conversation running Planning would have been a
  card on the board. Task files from before are stamped when their workspace opens
  (`TaskFileStore.stampConversations`, to be deleted once every workspace has opened).

## Consequences

- `isChatWorkflow`, `CHAT_STATES` and `ChatKind` are gone; `startedBy` is a union, read by `by`.
- A conversation's turns are known as the children under its own state (`childRunModel.ts`), not by a
  `chat/` prefix, since the conversation's state can be any workflow.
- A workflow script has no field to set, so it cannot be disabled.
