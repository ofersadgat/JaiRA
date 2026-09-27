---
id: engineering/decisions/0013-machines
type: decision
status: proposed
updated: 2026-09-27
decides_for: [engineering/units/ipc-bridge, engineering/units/app-shell, engineering/units/project-store, engineering/units/project-sessions, engineering/units/cli]
---

# 0013. Machines: one fleet, tasks placed across it, and every window seeing all of it

This is the remote step that [0012](0012-local-server.md) left for later. It is wider than "connect to a
remote engine": the person wants the machine a task runs on to be close to an implementation detail.
The person's rulings of 2026-09-27 are quoted where they settle something.

## Context

- **After 0012,** each machine runs one engine per person. The desktop, `jaira serve` and a command
  reach it through a pipe, with per-connection state.
- **History is files first** (DESIGN §4.4):
  - `.jaira/system/` holds one journal JSONL per task, the task files, the task rows and the
    conversations.
  - `jaira.db` is only an index replayed from those files.
  - The files are meant to be committed. A `git pull` already brings another clone's tasks into the
    index.
- **What t3code does** (read 2026-09-27, commit c9a0e8a1):
  - **Reach:** its server stays on loopback. It is reached through `tailscale serve` HTTPS, an SSH port
    forward, or a Cloudflare tunnel that its relay only introduces.
  - **Pairing:** a one-time code (5 minutes) is exchanged for a 30-day signed token. The client keeps an
    encrypted list of machines and reconnects to each at start.
  - **One window, every machine:**
    - Projects are merged by their normalized git remote, preferring `upstream` over `origin`.
    - Grouping has three modes: repository, repository and path, or separate.
    - A thread shows a machine icon and label.
  - **Placement:** only an optional auto-balance by CPU and memory, off by default. There are no
    requirements, no limits and no queue, and a thread never moves.
  - **Resume:** snapshots plus `afterSequence` deltas.

## Rulings (2026-09-27)

1. **The machine is an implementation detail.** "if you start a task, the app has some logic to
   decide which machine to farm the task out to in some sort of priority order."
   - Remote machines can come first, falling back to this one at a limit.
   - Some tasks need a particular machine (mac or windows).
2. **One project, many workspaces.** "the project itself is the same project on both (we can tell by
   looking at the git repo host). We might even have the same project multiple times on the same
   machine … These are all the same project so we should group them together."
   - A chip on a task says where it runs: `machine / workspace`, with the workspace left off when there
     is only one.
   - A toggle turns the grouping off.
3. **Pairing:** "1b". Every machine is paired once, even on the person's own tailnet. Machines are
   remembered, so there is no setup after that ("i want a machine to remember remote hosts so that we
   dont have to have a set up process every time").
4. **Limits:** "2c". A workspace is full when it is at its runs-at-once limit, or when the agent
   account the run would use there is out of usage.
5. **A full fleet queues the task:** "3a".
6. **A queued task can be moved before it starts:** "4a".
7. **Records are synced so every window sees everything.** "if i open the ui, the ui should sync the
   conversations from the other machines, but a server doesnt necessarily need to have its own copy of
   conversations that happened elsewhere."
   - Moving a session between machines is a later improvement. It needs the LLM session id plus a way
     to transfer the workspace.
8. **A run uses the workflows of the clone it lands in:** "6a".
9. **Screen verbs:**
   - The folder picker browses the remote machine.
   - Browser sign-ins open on the machine you sit at.
10. **Remote tasks can be acted on from here.** "if a remote session hits a ui function, that should
    be mirrored in the local version which should allow the user to see the waiting task, open the
    conversation, make a decision, and then have that decision forwarded to the remote session. I
    should similarly be able to use the composer with a remote session as well."
11. **What is replicated:** everything by default, with a setting to limit it ("1c, but with the
    default being everything").
    - Replicas are kept on disk.
    - A delete the person issues is replicated. A space-saving prune on the owner is not ("depends on
      why its being pruned").
    - Every machine with a window is equal: there is no hub.
    - The fleet's settings (machines, pairings, placement) sync across the person's machines.
12. **Files apart, index merged.** "the separate files are meant to allow keeping records of what
    happened in sessions. the index is meant as a quick way for the app to load its data. so, having a
    separate remote folder for the files makes sense, but the index should be kept merged."
13. **An answer to an offline machine is queued:** "2b". It is delivered when the machine reconnects,
    and shown as pending until then.

## Decision

### 1. Machines

- **Identity.** A machine is one engine's base root. It has a durable `machineId` (a random id in
  `<base>/system/machine.json`), a label (its hostname unless renamed), its OS, and tags. The OS is a
  tag automatically (`windows`, `mac`, `linux`); the person adds others (`gpu`).
- **Remembered.** Each machine keeps the fleet in `<base>/system/fleet.json`: every paired machine's
  id, label, addresses, OS, tags and last seen. Its token to each machine is kept in the keychain.
- **Synced.** The list itself syncs across the fleet (ruling 11). A new machine paired with any one
  member is introduced to the rest (§3).
- **Connected at start.** An engine that serves a window connects to every fleet machine at start and
  keeps retrying with growing waits. An offline machine stays listed, and its replicated records stay
  readable.

### 2. Reach and transport

- **Tailscale is the reach** (proposed: the person asked "can we use tailscale?"). The engine listens on loopback over HTTP. JaiRA runs
  `tailscale serve --bg --https=443 http://127.0.0.1:<port>` itself when the person turns on "Reachable
  from my other machines", as t3code does. Tailscale supplies the HTTPS name (`<machine>.<tailnet>.ts.net`)
  and its certificate.
- **Never public.** Funnel is never used, and nothing listens on a public interface.
- **The protocol is 0012's.** The `hello`/`req`/`res`/`push` frames travel as WebSocket messages, one
  frame per message. Because there is one frame per message, no length prefix is needed. The pipe stays
  the local transport.
- **Authentication is a machine token, not `engine.json`.** It goes in `hello`, never in the URL.
- **Versions:**
  - A contract mismatch between machines shows on that machine's row ("needs JaiRA X").
  - Its replicated records stay readable.
  - Acting on its tasks waits until the versions agree.

### 3. Pairing, once per machine

- **Showing the code.** On machine B, Settings → Machines → "Pair a machine" shows B's address and a
  one-time code, valid for 10 minutes. `jaira machine pair` prints the same.
- **Entering it.** On machine A, "Add a machine" takes the address and the code, as does
  `jaira machine add <address> <code>`.
- **Mutual.** The exchange gives each side a token for the other in one step, because machines are
  equal: each replicates the other.
- **Introduction.** A machine paired with any fleet member asks that member to introduce it. The member,
  already trusted by the rest, has each of them mint a token for the newcomer. That is what "the fleet's
  settings sync" means for a new machine (ruling 11).
- **Revocation.** Each machine lists who holds a token for it. Removing one revokes that token, and the
  removal syncs.

### 4. Workspaces and project identity

- **Workspace.** A workspace is one clone on one machine: `(machineId, project directory)`.
- **Identity.** A project's identity is its normalized git remote: `upstream` over `origin`, with the
  scheme, credentials, `.git` and case of the host stripped. A clone without a remote is its own project.
- **Grouping.**
  - Grouped (the default), one project in the sidebar and on the board stands for all its workspaces,
    on every machine.
  - Separate lists each workspace on its own.
  - The toggle is a personal setting.
- **The chip.** A task shows where it runs: the machine's label, plus the workspace's folder name when
  its project has more than one workspace. This machine's own tasks show a chip too, so no task is
  ambiguous.

### 5. Placement

- **Where tasks run** is an ordered list of workspaces per project (ruling 1). Each entry has a limit on
  runs at once.
- **Requirements.** A workflow may say `requires: [tags]`, and a task may add to them when it is made.
- **Choosing.** Starting a task takes the first workspace in order that:
  - is on a connected machine whose tags satisfy the task's requirements;
  - is under its runs-at-once limit;
  - uses an agent account that is not out of usage there, going by that machine's Limits board
    (ruling 4).
- **The queue.** With none free, the task waits (ruling 5) and starts when a slot frees up.
  - The queue is kept by the engine of the machine where the task was started. No hub is needed, and a
    machine that goes offline keeps its own queue.
  - A queued task can be moved to a chosen workspace (ruling 6).
- **After it starts,** a task belongs to the workspace it runs in. Moving a started task is the later
  session move.

### 6. Replication

- **One owner per record.** A task, its runs and its conversations belong to the engine that runs them.
  Only the owner writes them; everyone else holds a replica.
- **Who replicates.** Every engine that serves a window replicates the fleet's records: everything by
  default, and a setting limits it by project or age (ruling 11). A `jaira serve` with no window
  replicates nothing (ruling 7).
- **Files apart** (ruling 12). A remote workspace's files go under `<base>/remote/<machineId>/<workspace>/`,
  in the same layout as `.jaira/system/`. They never go into a local clone, where they would become
  untracked files and later collide with the owner's own commits.
- **Index merged** (ruling 12).
  - The index a window loads for a project holds its local and remote tasks alike, each row with its
    owning workspace.
  - **Every engine path that acts on its own tasks checks ownership and skips a foreign one:**
    - open-time recovery, which would otherwise mark a task running elsewhere as interrupted;
    - resuming suspended runs;
    - the events task;
    - pruning;
    - run claims;
    - cancellation;
    - the watchers.
- **Pulled by cursor.** A replica asks the owner for what follows its cursors: per task, the journal
  sequence and the record ids it holds. While connected it takes the owner's pushes as they happen.
  After a disconnect it pulls from where it stopped. This is 0012's deferred `afterSeq` resume.
- **Deletes and prunes.**
  - A delete the person issues travels as a tombstone and is applied everywhere.
  - A prune on the owner stays on the owner (ruling 11). Replicas keep their own retention.
- **Session transfer, later.** The captured native session files are already in the records (JaiRA
  captures a Claude Code session at close). A replica therefore holds what a later move needs to rebuild
  the session elsewhere, once the workspace itself can be moved.

### 7. Acting on a remote task

- **Waiting.** A remote task waiting on a gate, an approval or a question shows as waiting here: the
  pending interactions are records like any other. Deciding it here sends the decision to the owner,
  which resumes the run.
- **The composer.** It works on a remote conversation. The message goes to the owner, and the reply
  arrives through replication (ruling 10).
- **An offline owner** (ruling 13). The answer or message joins the existing waiting queue — the
  "Try again at…" list — marked as waiting for that machine. It is delivered when the machine
  reconnects, and shown as pending until the owner takes it.
- **Cancelling** a remote task is a request to its owner, queued the same way.

### 8. Screen verbs across machines

- **Choosing a folder** on a remote machine (opening or making a project there) uses a folder browser
  served by that engine, drawn in JaiRA, instead of the OS dialog (ruling 9).
- **A sign-in page** a remote engine wants opened goes to the browser of the machine the person is at:
  a push to the window that asked (ruling 9).
- **Reveal in folder** is offered only for this machine's files.

## Open questions

1. **Where the merged index lives.** A machine may have no clone of a project, one clone, or several.
   Recommended:

   - It lives in the index of this machine's first clone of the project, with an owner column added.
   - With no clone, it lives in a project index under `<base>/remote/<identity>/`.
   - Further local clones keep their own indexes, since their tasks are this machine's, and the view merges
     local clones as it draws.

   The alternative is one index per project per machine under the base root, holding every workspace's
   rows, local clones included. That duplicates the local rows each clone already indexes.
2. **Where a chat runs.** Proposed: a chat started from a project is placed like a task, in the
   project's first free workspace. The alternative is always the machine the person is at. Once started,
   either one is replicated and usable everywhere (rulings 7 and 10).
3. **Tailscale as the only reach at first.** Proposed: yes, with SSH and a relay left for later.

## Build order

Each UI step is drawn as a mockup first.

1. Machine identity, the loopback listener with the WebSocket transport and machine tokens, and
   `tailscale serve` on and off.
2. Pairing, the fleet list, the introduction and revocation. Settings → Machines and `jaira machine …`.
3. Project identity from the git remote, grouping and its toggle in the sidebar and on the board, and
   the chip.
4. Replication:
   - the remote folder and the cursor pull;
   - the merged index with owners and the ownership checks;
   - tombstones for deletes.
5. Acting on remote tasks: waiting items, decisions and the composer forwarded to the owner, and the
   offline queue.
6. Placement: tags, `requires`, the per-project order and limits, the account-usage check, the queue,
   and moving a queued task.
7. The remote folder browser, and sign-in pages opened locally.

## Consequences

**Easier:**

- Adding machines needs nothing but pairing.
- A task can go wherever there is room.
- Any window shows and acts on the whole fleet.
- Offline reading works.

**Harder:**

- Every path that acts on tasks must know which ones are its own.
- Replication must stay correct across disconnects and versions.
- The queue belongs to whichever machine started a task, so a task started on a laptop that is closed
  waits for it.

**Foreclosed:** an engine assuming every row in its index is its own.

## Revisit when

- Sessions move between machines: workspace transfer, plus ownership handoff of the replicated records.
- A machine outside Tailscale is needed: SSH, or a relay like t3code's, which only introduces.
- Phones connect: pairing by QR, on the same transport.
