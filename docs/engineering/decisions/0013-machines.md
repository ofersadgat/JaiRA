---
id: engineering/decisions/0013-machines
type: decision
status: accepted
updated: 2026-09-30
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
14. **This machine's projects are hosts too, and the index is in `~/.jaira`.** "the local projects
    should essentially be 'remote hosts' from an abstract point of view. the main index should be the
    ~/.jaira shared repo. the only thing is that local projects dont need to sync their content into
    the shared repo … within the shared repo, having an owner column sounds good."
15. **Each clone's own index is retired in this work.** Its rows move into `~/.jaira`'s, and the old
    path is deleted.
16. **Chats are tasks, and are placed the same way:** "chat sessions are tasks, so they should work the
    same, yes."
17. **Tailscale, both ways, now.** The installed Tailscale app where it is there, and a bundled helper
    where it is not.
18. **By default, other machines first and this one last.**
19. **A machine's capacity is judged from its resources**, like t3code: "i think you should do something
    similar to t3code where you look at memory, cores, etc." It is not a fixed count.
20. **The mockups** (2026-09-27) were drawn from the app's real markup:
    https://claude.ai/artifact/Y2cvfjsS6Rx4Yz3VCmnit1

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

- **Tailscale is the reach, two ways** (ruling 17). The engine always listens on loopback over HTTP.
  - **Where the Tailscale app is installed,** "Reachable from my other machines" runs
    `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, as t3code does. Tailscale supplies the
    HTTPS name (`<machine>.<tailnet>.ts.net`) and its certificate.
  - **Where it is not,** a helper built on Tailscale's embeddable library, `tsnet`: one small Go
    program, which every installer carries for its platform (amended 2026-09-27, below).
    - The helper joins the tailnet as its own node (`jaira-<machine>`) after a one-time sign-in, whose
      link Settings → Machines shows.
    - It forwards its tailnet HTTPS port to the engine's loopback port.
    - Packaging builds it for the machine it runs on (`packages/app/buildTailnet.mjs`), into
      `resources/tailnet` beside the built-in layer.
  - **Either way,** the other machines see one HTTPS address.
- **Never public.** Funnel is never used, and nothing listens on a public interface.
- **The protocol is 0012's.** The `hello`/`req`/`res`/`push` frames travel as WebSocket messages, one
  frame per message. Because there is one frame per message, no length prefix is needed. The pipe stays
  the local transport.
- **Authentication is a machine token, not `engine.json`.** It goes in `hello`, never in the URL.
- **A phone or a browser is a client of the same transport** (amended 2026-09-30, below): a window onto
  one engine, with a token of its own.
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
- **Devices** (amended 2026-09-30, below). A phone or a browser tab pairs with the same code and is a
  window, not a machine: it is issued a token and gives none, and is listed only so it can be forgotten.

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

- **Where tasks run** is an ordered list of workspaces per project (ruling 1).
  - Until the person sets one, it is every other machine's workspace in the order the machines were
    paired, then this machine's (ruling 18).
- **Capacity comes from resources** (ruling 19), as t3code measures them.
  - Every engine reports its cores, CPU load and free memory every few seconds.
  - A workspace takes a new run while its machine's report is fresh (under 15 s old), its CPU is under
    90% and more than 10% of its memory is free.
  - An entry may also carry an explicit cap on runs at once, off by default. Both thresholds are
    settings.
- **Requirements.** A workflow may say `requires: [tags]`, and a task may add to them when it is made.
- **Choosing.** Starting a task takes the first workspace in order that:
  - is on a connected machine whose tags satisfy the task's requirements;
  - has room by its machine's resources, and is under its cap if it has one;
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
- **One index, in `~/.jaira`** (rulings 12, 14, 15).
  - The base root's `system/jaira.db` indexes every workspace's tasks, local and remote. Each row
    carries its owner: machine and workspace.
  - This machine's clones are hosts like any other (ruling 14). Their files stay in the clone, where git
    keeps them, and are indexed in place, not copied.
  - Remote workspaces' files are indexed from `<base>/remote/…`.
  - Each clone's own `.jaira/system/jaira.db` is retired (ruling 15):
    - Its rows are migrated into the base index under that clone's workspace. That covers what is not
      rebuilt from files as well: run claims, job output, module approvals, memo, event waits, remote
      handles and watch cursors.
    - Then the clone database and the code that opened it are deleted, per the standing no-back-compat
      rule.
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

## Settled after the first draft

- **Where the merged index lives:** in `~/.jaira` (ruling 14), with clone indexes retired (ruling 15).
- **Where a chat runs:** a chat is a task, and is placed like one (ruling 16).
- **Reach:** Tailscale, installed or bundled (ruling 17). SSH and a relay stay for later.

## Build order

Each UI step is drawn as a mockup first.

1. Machine identity, the loopback listener with the WebSocket transport and machine tokens, and
   `tailscale serve` on and off. Then the `tsnet` helper plugin: its Go source, the CI build and the
   per-platform packages.
2. Pairing, the fleet list, the introduction and revocation. Settings → Machines and `jaira machine …`.
3. Project identity from the git remote, grouping and its toggle in the sidebar and on the board, and
   the chip.
4. One index and replication:
   - the base index with owners, the migration of clone indexes into it, and the deletion of the old path;
   - the ownership checks;
   - the remote folder and the cursor pull;
   - tombstones for deletes.
5. Acting on remote tasks: waiting items, decisions and the composer forwarded to the owner, and the
   offline queue.
6. Placement:
   - resource reports, tags and `requires`;
   - the per-project order (other machines first) and optional caps;
   - the account-usage check;
   - the queue, and moving a queued task.
7. The remote folder browser, and sign-in pages opened locally.

## Built

**Steps 1–2, 2026-09-27: machines, the network transport, pairing and the fleet.**

- **The transport.**
  - `engineChannel.ts`: the host and client speak over a `FrameChannel` — length-prefixed frames on the
    pipe, or one JSON frame per WebSocket message — so `EngineHost` and `EngineClient` never see
    which.
  - `wsServer.ts` is the server half of RFC 6455, as much as the engine needs: the handshake, masked
    client frames, fragments, 16- and 64-bit lengths, ping and pong, and close. It was written rather
    than taken as a dependency. The client half is Node's own `WebSocket`.
  - `engineNet.ts` listens on loopback only (port 47318, else any free one):
    - `/.well-known/jaira` says which machine it is;
    - `/engine` upgrades to the engine's frames.
    - Its upgraded sockets are ended on close; a closing HTTP server otherwise waits on them for ever.
  - Network clients prove themselves with a machine token in `hello`, never in a URL.
  - `who` over the network leaves out this machine's paths.
- **Identity and tokens.**
  - `machine.ts` keeps `machine.json`: id, name, OS, and tags (the OS is always one).
  - `machineTokens.ts` keeps only the hashes of the tokens this machine issued, verified in constant
    time and revocable. A revocation also drops the machine's live connections.
- **Tailscale.** `tailscale.ts` finds the CLI on the PATH or where each installer puts it.
  - It reads `status --json`.
  - It serves the loopback port on the first free HTTPS port of 443, 8443 and 10000, never touching one
    that serves something else.
  - It unserves only its own mapping.
  - `JAIRA_REACH=loopback` publishes the loopback address instead, for trying a fleet of several base
    roots on one machine.
- **The fleet** (`fleet.ts`, owned by `AppService`, attached by `hostEngine` for the desktop and both
  servers):
  - **Pairing** is a two-word code plus four characters, valid 10 minutes, for one use. After five
    wrong tries the code is void.
  - Pairing is **mutual**: the asker sends a token it issued, and gets one back.
  - **Introductions**: the paired machine's fleet comes back with the answer, and each stranger is met
    through it (`fleet:introduce` → `fleet:meet`). A member that is offline is met at the next
    connection.
  - **Links** to every known machine retry with growing waits (3 s doubling to 60 s). A machine on
    another contract shows as mismatched.
  - Renames and tags are **announced**.
  - **Forget** revokes the machine here and on every member.
  - Tokens this machine holds live in the keychain, or in a 0600 file where there is none.
- **Settings → Machines**, as the approved mockup has it:
  - this machine's name, tags and reach switch;
  - the pairing code, with Copy and Stop;
  - the paired machines with their state, version, address and tags, and Forget;
  - Add a machine, a `SchemaForm`.
- **The command line:** `jaira machine list | pair | add | forget | reach | rename | tags`, always
  through the running engine.
- **Verified:**
  - Network tests with Node's own client: a 200 KB message each way, refusal, and revocation.
  - Three machines in one process: pairing, introduction, a void code, forgetting across the fleet.
  - A real window paired with a second base root running the npm `jaira serve`, and showed it online
    (`shots/machines-real.mts`).
- **Not verified:** a real tailnet, since neither Tailscale nor Go is installed on this machine.

**Steps 3 and 5, 2026-09-27: one project across machines, used from here.**

- **Identity.** A project summary carries its identity: the git remote (upstream over origin),
  normalized by `repositoryIdentity`. It also carries its machine.
- **`Federation`** lists every paired machine's own workspaces under keys that name the machine
  (`remoteProjectKey`). The lists are cached on disk under `<base>/remote/<machineId>/`, so an offline
  machine's projects stay listed.
  - A request carrying such a key is forwarded, with the key put back to the directory.
  - An answer to a gate, an approval or a question goes by request id to the machine that asked.
  - The machine's pushes come back keyed for here.
  - So the board, a conversation, a gate and the composer work on a remote task as on a local one.
- **No echo.** A request from another machine is answered with this machine's own workspaces only
  (`serviceHandlers(service, { local: true })` on network connections). A peer's lists keep only its
  own entries, and a relayed push already about another machine is dropped.
  - Found on the real app, where each machine sent the other its own project back.
  - Two machines asking each other for "everything" would otherwise never stop.
- **The outbox.** An answer for a machine that is offline waits in `fleet-outbox.json` and is delivered
  when it reconnects. The window says so in a notice.
- **In the window,** `workspaceGroups.ts`:
  - groups workspaces by identity, this machine's first;
  - merges a group's boards by column, stamping each card with its workspace and a machine chip. The chip
    adds the folder where one machine has two, and is absent for a project of one workspace. Every verb
    on a card goes to its own workspace.
  - The sidebar row says how many machines and workspaces the project spans. Its pills, and its Tasks and
    Chat rows, count all of them. The address bar names the group.
  - The grouping switch (`ui.groupWorkspaces`) is on Settings → Machines.
- **Not built:** the finer part of step 5's offline handling. An answer that waits shows as a notice,
  not yet as the mockup's pending line under the gate with "Take it back"; `Federation.withdraw` exists
  for it.

**Step 6, 2026-09-27: placement.**

- **Resources.** `ResourceSampler` measures cores, CPU (from `os.cpus()` times, since `loadavg` is zero
  on Windows) and free memory every 3 s.
- **Capacity.** `AppService.capacity()` adds the runs working per workspace and which accounts are
  spent. Other machines ask for it with `fleet:capacity`.
- **The rule, `whyNot`.** A workspace is passed over when it is:
  - offline;
  - missing a tag the workflow's root state `requires` (read from the state file, which the loader
    tolerates);
  - on a reading older than 15 s;
  - at its cap;
  - over 90% CPU;
  - under 10% free memory;
  - on a machine whose every account with a reading is spent.
- **The order** (`Placement.ordered`) is the project's rules, then the default: other machines in
  pairing order, this one last. The rules (order and caps, per identity) sync with `fleet:placement`,
  newest wins.
- **Starting.** `task:start` in a project of several workspaces is placed:
  - here;
  - or re-made on the chosen workspace (it has not started) and removed here;
  - or queued in `placement-queue.json`.
  - The queue is retried every 10 s and at any run's end, here or relayed.
  - A task that ran before continues where it is. A request forwarded from another machine is not
    placed again.
- **In the window:**
  - a notice says where a task went, or that it waits;
  - a waiting card has a dashed "no machine yet" chip;
  - its menu has "Run on…", listing every workspace with why it is passed over. Offline machines and
    those missing a required tag cannot be chosen; a busy one can.
  - "Where tasks run" sits on the Runs page of a project with several workspaces: the order with ↑/↓,
    and an optional cap.
- **Two simplifications, open:**
  - "Out of usage" means every account with a reading on that machine is spent. A per-route check would
    need the route a workflow's model resolves to.
  - Chats go through their own channels and are not placed yet (ruling 16).
- **Also:** "Where tasks run" sits on the layered Runs page, but placement rules are the project's on
  every machine, whatever layer the switch is on.

**Step 7, 2026-09-27: screen verbs across machines.**

- **`files:browse`** lists one folder's folders, with roots: home, and the drives on Windows. A request
  that names a `machine` is forwarded to it; so are `project:open`, `project:init` and `project:inspect`
  there.
- **"Open a project…"** offers "Open project on <machine>…" and "New project on <machine>…" for each
  paired machine. They open a folder browser drawn in JaiRA; a folder that is not a project yet is set
  up there.
- **Sign-in pages.** An engine with no screen of its own (`jaira serve`) pushes `open:external`. The
  window using it opens the page where the person is.

**The Tailscale helper (step 1, second half), 2026-09-27.**

- **`packages/tailnet`** is `jaira-tailnet`, Go on `tsnet`.
  - It joins the tailnet as its own node (`jaira-<machine>`) after a one-time sign-in.
  - It forwards its tailnet port to the engine's loopback listener: HTTPS where the tailnet has
    certificates, plain HTTP on the tailnet otherwise.
  - It reports `needs-login`, `running` or `error` as JSON lines.
- **`HelperReach`** runs it and passes the sign-in link to Settings → Machines. `autoReach` uses the
  installed app when its CLI is there, the helper when its binary is (`JAIRA_TAILNET_HELPER`, or
  `<base>/plugins/tailnet/`), and otherwise says both are missing.
- **`.github/workflows/tailnet.yml`** builds six platforms into `@jaira/tailnet-<platform>` packages, and
  publishes them only when run by hand with an `NPM_TOKEN`.
- **Not done:**
  - the Go program has never been compiled: there is no Go on this machine;
  - the packages are not published;
  - the plugin-manifest entry that lets About download them waits on publishing.
- **Verified:** with a script speaking the helper's lines (sign-in passed on, address published, error
  said).

**Verified (steps 3, 5–7):**

- Two engines in one process, for federation: listing, reading and writing through the key, pushes
  keyed for here, no echo, the outbox, browsing and opening on the other machine.
- For placement: the rule's cases; a task re-made on the other machine by default; an order keeping it
  here; a missing tag queuing it until a machine has it.
- In the real app, with a second base root's `jaira serve` holding another clone
  (`shots/machines-grouped.mts`):
  - the merged board with chips;
  - a waiting task;
  - Where tasks run;
  - the folder browser on the other machine;
  - grouping off.
- Found on the way:
  - a CLI bundle built before new channels speaks another contract. A mismatch between builds of the
    same version now says "another build".
  - an `else` that bound to the wrong `if` listed "/" among the Windows drives.

### Step 4, first half: one database, owners, clone databases retired

The person, on where the index lives: "the database is in ~/.jaira as are the shared workspace files but
the workspace specific stuff remains in the the workspace".

- **One file.** Every workspace opens `~/.jaira/system/jaira.db` (`JairaPaths.dbFile` is the base's),
  each on its own connection. A clone keeps its settings, workflows, task files and any records its
  `storage` puts in files. Its file-backed concerns still replay into `TEMP` tables of its own
  connection, so they never mix with another workspace's.
- **A workspace is an id**, minted into `system/workspace.id` on first open. The `.gitignore` template
  hides it, and an existing ignore file gains the line, as it did for `machine.key`. It is an id and not
  the folder's path, so a clone moved on disk keeps its history, and a second clone of one repository,
  which has the same committed files, does not share it.
- **Migration 21:**
  - `workspaces` (id, machine, dir);
  - `task_owners` (task → workspace);
  - the watcher's two tables keyed by workspace as well;
  - `storage_index` dropped. It is a cache, now kept per workspace and concern.
- **Ownership.** `RuntimeStore.insert` claims the task in the same transaction. A task another workspace
  owns is refused, before its file is written. Every read and update of `task_runtime` is limited to
  the workspace's own tasks, and so is everything built on it:
  - the board;
  - open-time recovery, which also settles a crash's unsettled calls;
  - resuming;
  - the events task;
  - pruning;
  - cancellation;
  - the gates still waiting;
  - the requests awaited;
  - the live-jobs list;
  - the connect-row scan after a crash.

  Run claims and the stale-job sweep stay machine-wide.
- **File-backed concerns.** A `both` write-back replaces only the workspace's own rows. It used to
  empty the whole `main` table, which in a shared file is every other workspace's history. A replayed
  journal lets the shared table mint its sequence numbers again. A replayed task no workspace owns is
  claimed by the one that replayed it.
- **The shared root's rows,** the only ones in the file before, were claimed for it on its next open
  (`claimUnowned`), removed on 2026-09-27 (the person: "lets get rid of all the back compat code");
  the shared root no longer claims unowned records at open.
- **A clone's old database** was merged once by a migration tool (`mergeLegacyDb`), deleted on
  2026-09-27 once the person's clones had been opened by this build:
  - it is brought to the current schema, attached, and copied in one transaction;
  - journal sequence numbers and job ids are shifted past those already present, with fork cuts and
    boundaries, job parents and job output following;
  - then it is removed.
  - A task the shared database already has (a pulled task file another clone ran too) is left in
    `jaira.db.unmerged` rather than lost.
- **Verified** (`persistence/test/workspace.test.ts`):
  - two clones on one database, each seeing and acting on only its own tasks;
  - a refused foreign id, which leaves no file;
  - recovery in one leaving the other's running task and open turn alone;
  - a moved clone keeping its history;
  - the shared root's old rows (the test went with `claimUnowned`);
  - a `both` workspace rebuilding its index without touching another's;
  - the merge, renumbered and with references following;
  - the merge conflict kept aside.
  - Full suite: 363 files.
- **Found on the way:** `recoverUnsettledCalls` assumed nothing else in the process was streaming at
  open. With one database, opening a second project would have settled the first one's live chat turn.

### Step 4, second half: replication

- **Who copies.** A window's engine keeps a copy of every paired machine's tasks (`AppService` option
  `replicate`, on in `desktop.ts`); `jaira serve` does not (ruling 7). Settings → Machines → "Keep a copy
  of my other machines' tasks" is the person's choice over that default (`machines:replicate`, kept in
  `machine.json`).
- **Where.** In the one database, owned by the remote workspace's id, registered in `workspaces` with
  its machine and directory. Task files and snapshots go under `<base>/remote/<machine>/<workspace>/`,
  laid out as a workspace whose `workspace.id` is the owner's, so the ordinary views read it.
- **The exchange** (`persistence/src/replica.ts`, the owner answering from its peer handlers):
  - `replica:pull` sends what the replica holds per task (`replica_versions`, migration 22):
    - the owner's version, which moves when anything the window shows moves (runtime, journal, records,
      gates, artifacts, session names, the task file);
    - the last owner journal number held, and how many rows.
  - The owner answers with the changed tasks, a page at a time (25 tasks or about 8 MB), and every task
    it has.
    - The journal comes only from where the replica stopped, unless a rewind took rows out from under
      it; then it comes whole.
    - Big strings stay blob hashes, and the replica fetches only the ones it lacks (`replica:blobs`).
    - A snapshot's files are fetched once (`replica:snapshot`).
  - The replica re-mints the owner's journal numbers as they land. `replica_seqs` maps them back, so a
    fork's cut and boundary point at the right rows.
  - A task the owner no longer lists was deleted there, and is deleted here. A task whose whole
    history is gone while it is still listed was pruned there, and keeps its history here (ruling 11).
  - A task id this machine already owns under another workspace is left alone.
- **When** (`service/src/replicator.ts`): as a machine comes online, 1.5 s after its engine pushes
  anything but machine-local news, and every minute; one pull per machine at a time.
- **Read while away.** For a machine that is offline, `Federation.route` hands the reads a window makes
  (board, roots, the task pane's detail and list, conversation, session history, view and live snapshot,
  run records, changes, artifacts, job output, events status, state views)
  to this engine. `sessionOf` answers a remote key with a copy opened read-only: `openProject(…, {
  replica: true })` recovers, claims, merges and registers nothing, and the session is never among the
  engine's own, so nothing resumes, watches or supervises it. Everything else still goes to the outbox
  or is refused.
- **Gates while away** (the person, 2026-09-27: yes), as the approved mockup draws them. An offline
  machine's gates are read from its copy and offered with the rest (`offlineInteractions`). An answer
  routes to the outbox (`Federation.holdOffline`), and the gate then stays drawn as answered, with "Your
  answer waits for mac-mini … Take it back" (`offline.tsx`). The conversation of an offline machine's
  task says "mac-mini is offline · last seen … What it did until then is here."
- **Verified:**
  - `persistence/test/replica.test.ts`:
    - tasks, journals, records and blobs copied and read like a workspace;
    - nothing sent when nothing changed;
    - the incremental journal, then the whole journal after a rewind;
    - a prune kept and a delete applied;
    - a task owned here left alone.
  - In the real app (`shots/machines-replica.mts`): a second base root's `jaira serve` runs a task, the
    window copies it, the server stops, and after a reload the card is still on the merged board with
    its machine chip and its conversation opens with every step, from the copy.
  - `app/test/federation.test.ts`: two engines; A copies B's task, B goes away, and A still reads its
    conversation and board, refuses a rename, and does not count the copy among its own tasks.
- **Then, the same day** (the person: "we should implement all the still remaining things too"):
  - **What is copied** is a choice (decision 0014): Everything, Not archived (a window's default),
    Chosen projects, or Nothing (the default for `jaira serve`). Kept in `machine.json` as `copy`. The
    first build dropped the setting on every read, so yesterday's switch never saved.
  - **All tasks** includes an offline machine's copied tasks (`offlineTasks`), keyed for their machine.
  - **Near-live copies:** a push naming a task pulls that task within 250 ms (`replica:pull` `only`).
    Other pushes pull the machine 1.5 s later.
  - **The composer's preview** (`chat:plan`) is read from the copy while the machine is away.
  - **The helper, compiled and run** (Go 1.27.1, portable, in the session's scratch space). Tailscale
    v1.88 no longer builds with it, so the module moves to tailscale.com v1.102.5 (`go 1.26.6`), with
    `go.sum` committed. CI takes its Go from `go.mod` and no longer tidies. Run against the real control
    plane, the helper says its sign-in link once per link, where it used to repeat it every few
    seconds, and `HelperReach` passes it on. Signing in needs a person.
  - **Bundled, not a plugin** (the person: "bundle it in the installer and drop the plugin"). At 8.6 MB
    compressed against a 129 MB installer it is not worth a download of its own, where the Agent SDK
    (about 110 MB) and local models (10 to 175 MB) are. `buildTailnet.mjs` compiles it while the app is
    packaged, with the `go` on the PATH or a Go release it downloads, and the installer ships it as
    `resources/tailnet`; `helperBinary` looks there and beside the built-in layer (a development build
    after `npm --workspace @jaira/app run tailnet`). The `tailnet` plugin, its manifest root, the
    Download line on Settings → Machines and the npm publishing are gone; the tailnet workflow only
    checks that it compiles for six platforms. Verified: `npm run dist -- --dir` puts
    `resources/tailnet/jaira-tailnet.exe` in the Windows app, whose smoke test passes.
  - **Out of usage per route:** placement judges a workspace by the accounts the task's models spend
    (the model ids its root state names, and the default executor's model, through `accountOfRoute`).
    With none known, it judges by every account being spent, as before.

### Amended 2026-09-30: a phone or a browser is a window onto one engine

The person, about the phone's first connection ([0015](0015-one-universal-client.md)'s throwaway socket,
read-only, with a token printed in the log): "this should work the same way that all of the remote stuff
should work, no? it shouldnt be phone specific...right?" — and then "do … the transport switch". So a
phone and a browser reach an engine the way a machine does: this decision's listener, frames and
tokens, with pairing extended by as little as a device needs.

- **A device is not a machine.** It runs no engine, so it has nothing to replicate and nothing connects
  back to it. Pairing a machine is mutual (§3) because machines are equal; pairing a device is one way.
- **Pairing.** The same one-time code, shown by the same "Pair a machine". The `pair` frame says it is a
  device — an id the device made once and keeps, a name ("Pixel 8", "Chrome on Windows"), and whether
  it is a phone or a browser — and carries no token for the other side.
  - The engine issues a token and keeps its hash in `machine-peers.json`, marked as a device's.
  - Nothing is added to `fleet.json`: no link is kept to it, nothing is copied from it, it is introduced
    to no machine and told of none, and no task is ever placed on it.
  - An id that is a machine's is refused: issuing for it would take that machine's token away.
  - Pairing again with the same id replaces the token, so a device has one row.
- **Admission.** A `hello` with a device's token is welcomed as a window: the service's channels as the
  desktop's own window has them, routed across the fleet, with this connection's own current project
  and limits watch (0012 §3), and every push. Not offered, each refused in words:
  - what acts on that machine's screen (`project:choose`, `shell:reveal`; §8);
  - the desktop app's own channels (its clipboard, updater, plugins and command), which a window's own
    process answers and a device has none;
  - the `engine:*` channels a host process uses (stop, restore, a crash to record), except `engine:info`.
  - A contract mismatch is the existing "limited" welcome. The device says which side to update and stops.
- **Listed and revoked.** Settings → Machines lists the devices under "Phones and browsers", each
  saying whether it is connected and when it was last seen. Forget… revokes its token and drops its
  connection, as for a machine; its next `hello` is refused, and it goes back to its Connect screen
  saying why. A device is forgotten on the one machine it is paired with: there is nothing to sync.
- **Every property of §2–§3 holds.** The token goes only in `hello` and is compared in constant time
  over every issued hash; the code works once, for ten minutes, and is void after five wrong tries; the
  listener is on loopback only; nothing secret is in a URL. A one-time code may be: the link
  `jaira:///?address=…&code=…` is what a QR code would carry, and a browser's page takes the code out
  of its address bar once it has paired.
- **The frames are shared.** `ClientFrame`, `HostFrame` and the contract's hash moved to
  `@jaira/shared` (`engineFrames.ts`), where a phone can import them: the hash is SHA-256 written out,
  since a phone has no `node:crypto` and Web Crypto's is asynchronous. A test holds it to Node's.
- **The client** (`packages/client/bridges/engineBridge.ts`) is `JairaBridge` over the platform's own
  `WebSocket`, with nothing of Node in it.
  - It reconnects with growing waits (1 s doubling to 30 s) and a fresh `hello`, at once when the app
    comes back to the front or the network returns.
  - After a reconnection it tells the store each scope may have changed, and says `limits:watch` again;
    the window stays where it was.
  - While it is away the window says "Disconnected … Reconnecting…" across its top.
  - The device keeps the token in the platform's keystore (`expo-secure-store`) on a phone and in
    `localStorage` in a browser, so the next launch connects by itself. "Forget this machine" is on the
    Connect screen while a kept machine cannot be reached.
- **The page a browser loads** comes from the engine's listener when the host has a built client to give
  (the desktop and its `--serve` do; the npm `jaira serve` has none): static files only, read only, no
  folder listed, a path that leaves the folder refused, and the content policy the desktop's `app://`
  protocol sends (`clientFiles.ts`, used by both). `connect-src 'self'` means the page reaches the engine
  that served it and no other.
- **Addresses.** A name is `wss`; an address that says `http://`, a bare IP address or `localhost` is
  `ws`, which is how an emulator reaches the loopback listener through `adb reverse`. "Add a machine"
  reads addresses the same way.
- **Verified:**
  - `app/test/devices.test.ts`, with a real engine, listener and the device's bridge over Node's
    `WebSocket`: pairing (a token, a row, no machine; a spent, wrong and voided code; a machine's id
    refused), admission (two devices each on its own project, a write, the push it causes, the channels
    not offered), revocation dropping the connection and refusing the next hello, reconnection, another
    contract, and the files (headers, the SPA's page, every way out of the folder refused).
  - `shots/remote.mts`: a headless Chrome served by the desktop's engine pairs by code, draws the board,
    hears a push, answers a gate the desktop's run parked at, reconnects after a reload by its kept
    token, and returns to the Connect screen when the desktop forgets it.
  - `shots/android.mts`, on the emulator: the phone pairs by the deep link and draws the board; its Dark
    switch, a settings write, turns the desktop's own window dark; a gate the desktop's run parks at
    reaches its strip by a push; stopped and opened with no link, it connects by the token in its
    keystore; forgotten on the desktop, it is back at its Connect screen.
- **Not built:**
  - the QR code itself (the link it would carry is read);
  - a sign-in page a device's request causes still opens on the engine's machine, not on the device (§8);
  - an artifact's page is served by the desktop's `jaira-artifact:` scheme, which a browser does not have.

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
- Phones pair by QR: they connect on the same transport now (amended 2026-09-30), by a code typed or a
  link opened; drawing the link as a QR code on Settings → Machines, and scanning it, are not built.
