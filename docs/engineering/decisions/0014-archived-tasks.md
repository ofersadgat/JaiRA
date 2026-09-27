---
id: engineering/decisions/0014-archived-tasks
type: decision
status: accepted
updated: 2026-09-27
decides_for: [engineering/units/project-store, engineering/units/app-shell]
---

# 0014. Archived tasks

The board's Finished lane held every task that ever finished, for as long as the task existed. The
person, 2026-09-27: "i want to introduce another state for tasks: archived. this state should be hidden
from the board. we can also use this state as a filter for what gets synced."

Mockups: https://claude.ai/artifact/RVfhJosY5Pt8CgJnb95a62

## Rulings (2026-09-27)

1. **A status of its own.** "the state should be archived. we can tell what the original state was
   because it should be in the event history. that being said, it might be useful when you're looking at
   archived tasks what state they were in when they were archived. we should also have a way to look
   at archived tasks."
2. **Copies:** "we can do not archived with everything as a choice in the settings."
3. **Automatic:** "leave the latest 5 tasks in terminal state visible, but those aside, if a task is
   failed leave it for 2 days, but if it is successful leave it for 1 day. this should be configurable".

## Decision

- **`archived` is a `TaskStatus`**, and it is terminal. Only a finished task (completed, failed,
  canceled) is archived. The runtime row keeps what it finished as and when it was archived
  (`archived_from`, `archived_at`, migration 23), so a card says "done" or "failed" and Unarchive puts
  the task back exactly.
- **Verbs:** `task:archive` and `task:unarchive` take several task ids and answer the ones that changed.
  They appear in a card's menu (Archive on a finished task, Unarchive on an archived one) and in a
  selection's menu. For another machine's task they are forwarded, and wait in the outbox while it is
  offline.
- **The board** leaves archived tasks out of its lanes and out of every count. At the foot of each
  Finished lane one line says "2 archived" with Show or Hide. Shown, archived cards are faded, wear the
  pill of how they finished, and say when they were archived. The state panel's history does the same.
- **Automatic** (`archive` in settings, on the Runs page as "Finished tasks"):
  - `auto` (on);
  - `keepLatest` (5): per project, the newest finished tasks stay whatever their age;
  - `failedAfterDays` (2): failed or canceled;
  - `succeededAfterDays` (1).

  The rule (`persistence/src/archive.ts`) runs when a project opens, after every run, and every 15
  minutes. Conversations and JaiRA's own tasks are never archived by it.
- **Copies** (decision 0013 §6) are a choice on Settings → Machines, as the approved section drew it:
  - Everything;
  - Not archived: the default in a window's engine;
  - Chosen projects: not archived, only the ones switched on;
  - Nothing: the default in `jaira serve`.

  The choice travels with each pull. Unless everything is copied, the owner leaves archived tasks out,
  so a task archived on its machine leaves the copies. Projects no longer chosen, or everything when
  the choice is Nothing, are removed from the copies at once.

## Consequences

- A task's "finished" can now be one of four statuses, and code that asks whether a task ended uses
  `isTerminalStatus` (which includes `archived`). Code that asks whether a task can be archived uses
  `isArchivableStatus`.
- A task archived on one machine and copied elsewhere disappears from the copies unless that machine
  copies everything.
