---
id: engineering/decisions/0018-one-truth-per-side
type: decision
status: accepted
updated: 2026-10-06
decides_for: [engineering/units/app-shell, engineering/units/operation-record-store, engineering/units/live-turns, engineering/units/storage-policy]
---

# 0018. One source of truth per side, kept in step by cursors

Settled with the person on 2026-10-06, after two conversations "disappeared" when the window
reloaded. Their framing: "single source of truth — one for front end, one for backend. Then, we discuss
how do the two stay synchronized … each single source of truth should have a way of reconciling
differences on its own and the data from the update is just an optimization. This way, we tolerate
failure in every part of the chain."

Amends [0012](0012-local-server.md) (its deferred "resume from `afterSeq`" is §4 here), and
[0013](0013-machines.md) §6 and its 2026-09-30 amendment: a phone now keeps a mirror (§7).

## Context

### What happened

- A window had been open since the morning of 2026-10-04. Its build was replaced under it at 17:26 that
  day. On 2026-10-06 at 00:18 it opened the diff editor, whose code chunk no longer existed, and One's
  skew protection reloaded it.
- The reload came back standing on mist-server, the last project the window had *opened*, not the one
  it was on. Each click on the two JaiRA conversations asked mist-server for them. The engine answered
  `unknown task 't-…' in C:\UbuntuCode\mist-server`, and the thread drew empty. Their records,
  transcripts (about 770 KB each) and agents were all where they had been.
- The fix (branch `conversation-by-id`, `b616c356`) closed the four ways that failed. It also showed
  that the failure was not four bugs but one pattern.

### The pattern

The window keeps its own copy of engine data in a field. It fills the copy with a request keyed on
another field it also keeps (the project it stands on, the selected task, the guessed project of that
task). It has to remember to fill it again when either moves, or when the engine says something
changed. It goes wrong three ways, all seen on 2026-10-06:

- **A late answer lands in the wrong place.** Two reads are in flight and the older lands last.
- **A step forgets to re-read.** `focusProject` moved the address without re-reading the task list.
- **A request is built from a guess.** The window guessed which project a task was in.

In the renderer's store (`app/src/renderer/store.ts`, 74 state fields, 221 writes, 113 reads) the
pattern is in seven groups:

1. **Guesses of which project something is in**: `selectedProject`, `chat.project`,
   `taskWorkflowProject`, `projectOfTask()`, `owningProject()`.
2. **Copies of the selected task**: `detail`, `conversation`, `session`, `sessionHistory`, `records`,
   `sessions`, `trail`. No read checks that its answer is still for the selection. Several components
   keep a second copy with their own fetch: `chatThreadModel.ts`, `PanelColumn.tsx`,
   `RunConversation.tsx`, `taskRun.ts`, `eventsTaskModel.ts`.
3. **Copies of the place the window stands**: `tasks`, `board` and `level`, `tree`, `workflows`,
   `history`, `state`, `trailState`. They are re-read by a hand-kept list in each navigation step.
4. **Updates filtered through those copies.** The push handler drops `store:invalidate` for any project
   but the one the window stands on, apart from a few lists.
5. **State tallied from the event stream instead of read**: `producing` (+1 when an operation starts,
   −1 when it ends), `stream`, `liveTurn`, `sync.progress`. One missed event, or a reload, and they are
   wrong until something resets them.
6. **The same tasks in four lists**: `tasks`, `allConversations`, `projects[].ended`, `boards`, each
   refreshed at different moments; `projectOfTask` searches them for an answer.
7. **Settings pages fetching on their own**: `MachinesPage.tsx`, `settingsShell.ts`, `limitsStore.ts`,
   `mcpData.ts`, `aboutModel.ts`, `connectionsModel.ts`, `catalogModel.ts`.

### What already exists

- **One database per machine** (0013 §6, step 4): `~/.jaira/system/jaira.db` indexes every workspace's
  tasks, each row owned by one workspace (`task_owners`), another machine's held as a replica.
- **Replication by cursor between machines** (`persistence/src/replica.ts`): a version per task
  (`replica_versions`), the journal from where the replica stopped, big strings kept as blob hashes and
  fetched only when missing (`replica:blobs`), deletes applied, prunes kept.
- **An outbox** for what a person gives an offline machine, drawn as waiting until it is taken.
- **A queued state in the UI** for a conversation not yet started (`QueuedMessage.tsx`, decision 0013
  amended 2026-10-02).
- **Timestamps on most rows**: `task_runtime.updated_at`, `state_machine_events.created_at` (with its
  `seq`), `operation_records.started_at` and `ended_at` (no time of last change: a live turn's partial
  output is flushed into `result_json` in place), `pending_interactions.created_at` (a resolved gate is
  deleted, leaving nothing behind).

## Rulings (2026-10-06)

1. **One source of truth per side.** The engine's database for engine data; the window for the window's
   own data. Everything else is a cache of one of them.
2. **Updates are an optimization.** A small message carrying the change is best, a vaguer "this changed"
   is allowed, and each side can reconcile on its own without either.
3. **The cursor is a timestamp where the data has one**, a version where it does not. Rows at exactly
   the cursor's time come again and are upserted by id. The id is not part of the query: ids have no
   order.
4. **A delete leaves a tombstone.**
5. **Timestamps are the clock of the machine that writes the row.** Each machine writes rows only about
   its own projects, so no two clocks are compared.
6. **Lazy loading.** Indexes always loaded. A transcript is held in memory once asked for, and within it
   a hierarchy is deepened only as needed. A large value is a placeholder, fetched when read.
7. **Lazy placeholder threshold** about 4 KB by default, adjusted by who is asking.
8. **A phone's mirror is a cache** whose size limit can be changed, or removed (it is then a permanent
   store).
9. **Writes show immediately as queued** (the UI that exists) until the owning engine accepts them.
10. **One owner per piece of data.**
11. **Files are imported at startup; after that the database is the truth**, and files are kept in step
    when file syncing is enabled. Watching files for outside changes is separate work.
12. **A remote engine syncs to the local engine, and the local engine to the window**, by the same
    protocol. A phone does not pull data over the network on each navigation.
13. **The window owns some data**: a draft not yet sent, positions and states of the UI. The window is
    their truth and the database their cache, read at startup.
14. **Drafts are per person; positions and UI state per device.** A draft is stored by the engine that
    owns its conversation, and the later write wins by that engine's clock.
15. **Several windows on one machine** each keep their own state and talk to the one local engine; races
    between them on non-draft state are accepted. At startup the most recently used window's state is
    restored.
16. **A live turn's text pieces are small updates**; the record the engine flushes is what a window
    rebuilds from.
17. **A protocol mismatch requires an update.** No compatibility with older clients.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Keep per-field refreshes, add guards (staleness checks, re-read lists) | Small changes; the fixes of `b616c356` are this | Every new field is a new chance to forget; the guards are the pattern's patches, and the three failure modes remain possible |
| B. Queries keyed by request, invalidated by pushes (a request cache) | Late answers cannot land in the wrong place; well-known shape | Still no reconciliation of its own: a missed invalidation leaves a key stale; two queries can hold the same row at different freshness |
| C. One store per side, rows by id, kept in step by cursors (this decision) | One copy of each row; every update idempotent; each side repairs itself from its cursor; the same protocol serves machines, the window and the phone | The largest change: a new store in the window, cursors and tombstones in the engine, a mirror on the phone |

**C**, because it is the only option where a lost message costs nothing but latency. A and B both
depend on every message arriving.

## Decision

### 1. Owners

- **Engine data** (tasks, journals, records, sessions, gates, artifacts, placement, everything about
  running an operation) is owned by the engine of the workspace that made it (0013). Only the owner
  writes it.
- **Window data** (§9) is owned by the window that made it, or for a draft by its person, stored with
  the conversation's owner.
- Every other copy is a cache: the local engine's replica of a remote machine, the phone's mirror, a
  window's store.

### 2. A store on each side

- **The engine's store is its database.** After the startup import (§11) nothing else is consulted.
- **The window's store** holds rows by collection and id, the cursor it holds for each collection, and
  the window's own data. Every view is a function of the store and the window's own state: no field is
  filled by a request keyed on another field.
- **Reads go to the store.** A view that needs something the store lacks asks for it by id; the answer
  lands as rows. An answer is a row like any other: it carries its timestamp and is upserted only if it
  is not older than what is held (§3), so an answer that arrives late cannot overwrite a newer one.

### 3. Cursors

- **Every row the window or a mirror reads carries the time it last changed**, stamped by the machine
  that owns it.
  - `operation_records` gains a time of last change, moved by every write including the live flush.
  - A table with no usable time gains a version, a number moved by every write.
- **Stamped inside the write that saves the row**, clamped never to go backwards
  (`max(now, last stamped + 1)`). SQLite has one writer at a time, so stamps then increase in the order
  rows become visible, and a row cannot appear behind a reader's cursor.
- **"Changes since T" is inclusive** (`at >= T`). The rows at exactly T come again; the reader upserts
  by id, so they merge. The id is never ordered on.
- **One cursor per collection a reader holds**: per index (§6), and per transcript the window holds
  open.

### 4. Deletes leave tombstones

- A deleted row leaves `(collection, id, deleted at)`, stamped like a write. "Changes since T" returns
  them with the rows.
- Kept for a set time (proposed: 30 days, a setting). A reader whose cursor is older than the oldest
  tombstone of a collection cannot know what went, so it reloads that collection whole.
- What deletes today and must leave tombstones: a task deleted; journal rows taken by a rewind or a
  fork's cut; a gate resolved (`pending_interactions`); a prune (which a replica ignores, 0013 ruling
  11, but a window must not).

### 5. Updates, and reconciling without them

- **A delta** names a collection and carries the changed rows (or tombstones) with their stamps, and
  the stamp of the collection's previous change (`prev`).
- **A hint** names a collection, or a scope ("task t-… changed"), and carries no rows.
- **A reader applies a delta** by upsert-if-not-older. If `prev` is newer than its cursor, it missed
  something in between and reads "changes since" its cursor. Duplicates and late deltas do nothing.
- **A reader reconciles on its own** by reading "changes since" its cursor:
  - on connecting and reconnecting, and on a reload;
  - on a hint;
  - on a gap (`prev` newer than its cursor);
  - when the app returns to the front, or the machine wakes;
  - and on a slow sweep (proposed: once a minute) of the collections in view.
- So any message can be lost, duplicated or reordered, and the store is still right after the next
  reconciliation.

### 6. Lazy loading

- **Always loaded, on every reader**: the indexes. Projects and workspaces, every task's summary,
  every conversation's summary, everything waiting on the person (gates, approvals, questions, user
  events), the placement queue.
- **Loaded when asked for, then held and kept current**: a transcript, as a hierarchy deepened as
  needed: conversation → turns (who, when, status, size) → a turn's content → its tool calls and
  their output → a subagent's transcript.
- **A large value is a placeholder** where it sits, in the same structure:
  `{"$lazy": {"size": 504347, "preview": "…", "hash": "…"}}`. An object rather than a bare string, so a
  real value cannot be mistaken for one, and so it can say how large the value is, show its start, and
  name the value it stands for. The hash is the blob hash where the value is a blob (0013 §6), so the
  machines' existing blob fetch serves it.
- **The engine chooses** which values are placeholders, by size against a threshold per reader:
  4 KB by default; larger for a window on the same machine, where a fetch is cheap.
- **A reader fetches a placeholder** by (row id, path in the row), and holds the value under that key
  and hash.

### 7. The chain: remote engine → local engine → window

- **A window talks only to its local engine.** It never needs to know which machine owns a row.
- **The local engine keeps a replica of each remote machine's data** by this same protocol, its cursors
  in that machine's clock. This is 0013 §6's replication moved onto §3–§6.
- **A phone keeps a mirror**: a store on the device, synced from the engines it is paired with by the
  same protocol, which its window reads like any local engine. Navigating on a phone reads the mirror,
  not the network. The mirror is a cache with a size limit that can be changed, or removed, which makes
  it a permanent store (ruling 8). It runs no tasks and owns no engine data.
- **A browser tab** is a window onto the engine that served it, as today.

### 8. Writes: queued until the owner accepts

- A write (a message sent, a task started, a gate answered, a rename) shows at once in the window as
  queued, with the UI that exists for that, and goes to the local engine.
- The local engine keeps it in its outbox, durably, until the owning engine accepts it; the outbox of
  0013 §6 is the one used. On the owner the change is stamped and saved, and arrives back by the
  ordinary sync, replacing the queued row.
- A refusal comes back as a refusal, the queued row is withdrawn, and the window says why.
- Since every write goes to its owner, two machines never edit the same row, and nothing merges
  conflicting edits.

### 9. The window's own data

- **Per device**: where the window stands, what is selected and open, folds, pane sizes, scroll
  positions. The window is the truth; its device's store keeps a copy, read at startup.
- **Per person, the draft**: text typed into a conversation's box and not sent, preserved when the
  person leaves the conversation and restored when they come back. Stored by the engine that owns the
  conversation, so it reaches every device by the ordinary sync. The later write wins, by that engine's
  clock when it arrives (a draft typed offline overwrites a newer one when it reconnects; accepted).
  The window holds its draft as the truth while typing; others are lazy-loaded.
- **Several windows on one machine** each keep their own per-device state and talk to the one engine;
  races between them on non-draft state are accepted. At startup the most recently used window's state
  is restored.
- This replaces today's scattered places: `user-settings.json`'s `ui`, the composer drafts in
  `localStorage`, and the address in `sessionStorage` (`windowAddress.ts`, `b616c356`).

### 10. Live turns

- Each piece of a turn's text is a delta on the turn's row (§5).
- The engine's periodic flush of the partial output (`LiveTurnFlusher`) stamps the row like any write,
  so a window that missed pieces rebuilds from the record.
- Whether a turn is answering is a fact of the record (its status), read like any row, not tallied from
  events (group 5).

### 11. Files

- At startup the engine imports the files of every concern that has them (task files, and journals,
  records, rows and artifacts where `storage` keeps them in files).
- After that the database is the truth. Where file syncing is enabled, files are written as changes
  are saved: an export, never read back while running.
- `storage`'s `"both"` mode, where the database and files are each a truth, is retired: a concern is in
  the database, and also exported to files or not.
- Watching files for changes made outside JaiRA (a `git pull` while running) is separate work.

### 12. Versions

- The protocol is part of the engine contract's hash (0013). A mismatch is refused, and the client says
  which side to update. No compatibility with older clients.

## Build order

Each step ends with the window working, and with a check in the real app in the manner of
`shots/reload.mts`.

1. **Engine: stamps, tombstones, "changes since".** A time of last change on every row a reader reads,
   stamped inside the write; tombstones for every delete of §4; a `sync:since` read per collection,
   paged; deltas and hints on the existing push channel, with `prev`.
2. **Window: the store.** Rows by collection and id, cursors, upsert-if-not-older, reconciliation on
   the triggers of §5; views as functions of it. Migrated in this order, each removing its fields from
   `AppState`:
   1. the selected task and its transcript (groups 1 and 2), with the lazy hierarchy of §6;
   2. the indexes (groups 3, 4 and 6): one task index, every list a view of it;
   3. what the event stream tallies (group 5), read from records;
   4. the settings pages (group 7).
3. **Lazy placeholders** from the engine, with the per-reader threshold.
4. **The window's own data** (§9): per-device state and per-person drafts in the database; the most
   recently used window restored.
5. **Machines on the same protocol**: 0013 §6's replication moved onto steps 1 and 3.
6. **The phone's mirror** (§7), with its size limit in Settings.
7. **Files** (§11): the startup import, the export as changes are saved, `"both"` retired.

## Consequences

- **Easy**: a lost, late, duplicated or reordered message costs only latency; a reload, a reconnect or
  a crash of either side recovers by reading from a cursor. No view can show one project's data under
  another's name, because no view holds data keyed by a guess. A new view is a new function of the
  store, not a new field with a new refresh.
- **Hard**: every writer in the engine must stamp inside its write, and every delete must leave a
  tombstone; a writer that does not breaks reconciliation silently. A check in the persistence tests
  should hold every table a reader reads to it.
- **Hard**: the window's store is a rewrite of `store.ts`'s data half, in stages.
- **Forecloses**: two machines editing one row; reading a transcript without the engine choosing what
  is lazy; files as a truth while JaiRA runs.

## Revisit when

- A reader needs to order rows written at the same instant (the id-free cursor cannot).
- Tombstones outgrow their retention in practice: readers keep falling back to whole reloads.
- Two machines need to edit the same data, which one owner per row forbids.
- A phone's mirror is too large for its device at the default limit.
