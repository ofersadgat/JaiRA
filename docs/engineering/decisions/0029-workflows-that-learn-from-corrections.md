---
id: engineering/decisions/0029-workflows-that-learn-from-corrections
type: decision
status: built in part
updated: 2026-11-18
decides_for: [engineering/units/chat-turns, engineering/units/workflow-snapshots, engineering/units/tool-policy, product/chat-with-agents, product/repeatable-agent-processes]
---

# 0029. Workflows are programs, a conversation is one, and a correction becomes an edit to it

The person, 2026-11-18: "there are a few tools which can increase the effectiveness of an LLM harness:
custom prompt (AGENTS.md/CLAUDE.md), skills, loops, workflows … these can be used in concert. I.e. you
can start with a workflow that has a single prompt/message and you can adjust each of the parameters
within it. If we still see errors, we can promote the fix to a more specific thing … What I want is an
initial workflow that will handle a conversation / session and then analyze what I'm saying to see how
we can improve the workflow so that I dont need to make the same corrections over and over."

The rulings that followed, the same day:

1. **Deterministic checks are a lever.** "if the critique can be handled deterministically, we can have
   it write / run a function in the workflow (or it can also write/use a shell script) and then route
   the results of that into another step in the workflow".
2. **The fix goes into the workflow that is running.** "the whole idea here is that the llm is
   modifying the workflow file that is running."
3. **Improving is a workflow, callable from anywhere.** "improve-workflow should be another workflow
   which is passed what workflow to improve, the lesson, and any context information (e.g. it might
   want the session / workflow run that displayed the issue so it can simulate to see if its changes
   improve things) … if its passed a null workflow, it may need to figure out which workflow it needs
   to improve by using the context information".
4. **Approval is a parameter.** "Propose, I approve should be the default, but should be changeable."
5. **Instructions are JaiRA's own file**, given to every runtime, never CLAUDE.md or AGENTS.md.
6. **Skills have to be built.** "we may need to implement skills in our harness as well".
7. **A workflow is a program, and a conversation is one.** "what we would consider a conversation
   today should look something like: `while (state == 'running'){ const { response, next_session_id }
   = llm({session: session_id, user_prompt: input()}); session_id = next_session_id; }` … it should
   always be a workflow."
8. **There are more levers.** "if the llm is asked to do many things, you can have it return each
   thing as structured output and then fork the session and do them one by one in serial or parallel.
   you can also decide where sessions should be forked, use a new session, etc. you can also use a
   different agent / model / thinking level (or multiple of those)."
9. **Durable and non-durable.** "durable is what we do now (i.e. convert a workflow to a set of json
   workflows and then we can run those durably). non-durable would be the equivalent of
   `node my-workflow.ts` which I also want to work. for non durable workflows to work, they need to
   actually import functions properly (those imports should be treated specially in the durable
   version)."
10. **An update runs as a child of the old version.** "if a workflow is updated in deterministic mode,
    how do we handle this while remaining deterministic? we do this by having the new/updated workflow
    be a child workflow of the previous one."
11. **A run may switch at any state boundary with the same inputs.** "Any state boundary given that the
    state boundary has the same inputs in the new version as the old one. This should preserve the
    correctness guarantee of limiting to input while providing the flexibility of switching as early
    as possible."
12. **A non-durable run reports to JaiRA when it can reach it.**
13. **Strict per message, thorough at the end.** "have the per turn be a more strict evaluation so that
    we only update in clear cut examples. Then, when the conversation is over, we add a workflow that
    looks for all the lessons and then … does all the remaining updating at the end."

## As built (2026-11-18)

The person: "build all of it". Built, with tests, across both repositories:

- **Scripts are programs** (§1). `@declarative-ai/hw/script` is a real export, a hook outside any run
  goes to an installed standalone host, and `@declarative-ai/script` is that host plus `dai-script`
  (declarative-ai `SCRIPTS.md` §17). `input()` and `llm({ withSession })` exist in both modes; a
  `withSession` call is still a journaled prompt state, and a computed `null` session is a fresh one.
- **A script's own code is approved by content hash** (§1): `scriptFilesOf` and `scriptApprovalsFor`
  in `userModules.ts`, asked in `snapshotWithModules` before a run, the built-in layer exempt.
- **A conversation can be a program** (§2): the shipped `chat/program`. Every interactive run has an
  `input` gate; a typed message to a program answers it (live, stored after a restart, steered into a
  call in flight, or seeded for the next `input()`), and a waiting conversation is not listed as asking.
  The first message's composer settings reach a program as its `settings` input when it declares one.
- **The improver** (§3–§5, §7–§8): `improve/lesson`, `improve/conversation`, and the host functions
  `conversation_digest`, `workflow_source`, `lessons_list` and `apply_change` — and, built since,
  `decline_change` and `simulate_change` (`runtime/improveFunctions.ts`, `service/improveHost.ts`). Every interactive run can also call
  `start_task`, so a program starts its improver without waiting for it.
- **The triggers** (§6): in `chat/program`, a strict `simple`-preset call per message and the end review
  on idle or end.
- **Instructions and skills** (§9–§10): `runtime/skills.ts`. `instructions.md` and the skill catalog
  go into every prompt call's system text (an agent receives it in its prompt); `list_skills` and
  `load_skill` are tools in the five top-level `chat` sets; the title call opts out.

**The handoff** (§3), built the same day, the person: "Build handoff next".

- **The boundary is a call.** Where a script calls another workflow, the engine asks the host for a
  newer version of the called state (`EngineConfig.versions`); one whose inputs are the call's is
  entered in its place, as a child, under a versioned id (`chat/turn@v…`) beside the old states, and
  journaled (`version.adopted`, or `version.declined` with why). hw `versions.ts`, `SCRIPTS.md` §17.1.
- **JaiRA's answer** (`service/versionSource.ts`) loads the run's root workflow fresh — a loaded state
  carries what its mount chain hands it — and offers the called state's part when it differs, validates,
  and every script in it is APPROVED; it is pinned as a snapshot first. A resume lays the versions a run
  took back in before the load folds (`withRunVersions`).
- **A conversation takes it at its next message.** `chat/program` is only the loop; each message is a
  call of `chat/turn` (the reply and the strict check), so a lesson about how a conversation answers is
  a change to `chat/turn`, and the authoring prompt says so.
- **Non-durable**, the boundary is `workflow()`: the standalone host imports the called script by its
  content, so an edited one is a fresh import.
- **A program resumes across an app restart, with the versions it took.** It did not at all before,
  edited or not: a compiled script's code is run by the engine, so no record held its value and the
  resume was refused ("no readable record"), and the `input()` the app closed under was replayed as a
  failure. Now the segment's value rides its `operation.completed`, which the load reads when no record
  answers, and a call cut off by a stop is asked again. A message sent while the app is still resuming a
  conversation is seeded for its `input()` rather than answering the stored gate, which would start it
  a second time.
- **A message's own settings.** `chat/program` takes the first message's settings as its `settings`
  input and every later message's from `input()`, and hands them to `chat/turn`, whose reply runs on the
  chosen model and reasoning — or on the defaults when none was chosen: a computed knob that comes to
  nothing is now left out of the call (hw `fields.ts`), where it used to fail the knob's type.
- **More signals in `conversation_digest`**: a tool call the person refused (the command log's `denied`
  by `user`), and a place the conversation branched — a message edited and sent again, with the replies
  it replaced. The per-message check and the end review read them.
- **Skills reach Claude Code natively** (§10). `skillsPluginDir` writes the layers' skills as a local
  plugin folder (`.claude-plugin/plugin.json`, `skills/<name>/…`), named by their content under the OS
  temp directory — a copy, never something to commit — and every prompt call is handed it as
  `providerOptions.claudeCode.pluginDirs`, which the SDK transport loads as `plugins` and the CLI as
  `--plugin-dir` (declarative-ai `agents-api`, `agents-cli`). The agent's own Skill tool finds them as
  `jaira-skills:<name>`, and `claude plugin validate` accepts the folder. `load_skill` stays, for every
  other runtime. A call that says `instructions: false` gets neither.
- Found: the wiring checker refuses a union-typed parameter of a called script (`chat/turn` types its
  `conv` as `unknown`), and a script import's call is now POSITIONAL, binding the script's parameters in
  order — which also settles "a script cannot call another script's positional signature" below.

**The conversation is one program, and it switches at any boundary** (2026-11-18). The person: "chat/program
shouldnt exist. we should simply change the contents of chat/session", "can we move that out so that its
just session.ts?", and, of a handoff built only at calls: "that wasnt what I specified. … input should
always be a state boundary … so that should always be an available point to switch from."

- **`session` is the conversation, in one file** (§2): `builtin/workflows/session.ts` — the reply, the
  strict per-message check, the wait, the end review. `chat/session`, `chat/program` and `chat/turn` are
  gone. A root's own copy, a settings file naming it and a conversation's task file are renamed once at
  open (`persistence/sessionRename.ts`); a pinned snapshot is left as it began.
- **Any state boundary with the same inputs** (ruling 11, hw `engine.ts`). Every child the run's root
  enters is a boundary: when the host offers a newer root whose child there takes the same inputs (by
  name and type — a compiled state's live variables — and, for a call, the same call), the root mounts
  the new version as its `$version` child, whose way down goes straight to that boundary with those
  inputs, and the old root ends with it. A version that takes the run hands it on the same way
  (v1 → v2 → v3, each one level deeper; `version.adopted` says `at` and `from`). The mount wires the
  inputs the new root requires from the old one's, so a resumed bundle validates.
- **`input()` is always one** — and the one a conversation is nearly always standing at. An `input()`'s
  key is stable (`input`, `input_2`, in order), not a call number, so it is the same boundary in both
  versions. A lesson lands while the run WAITS there, past the boundary, so the host asks the run to
  switch from the wait itself (`DirectedTransitions.takeNewerVersion`): the waiting `input()` is stepped
  past as a skip steps past a state, and the new version asks again. JaiRA asks at each message, then
  answers whichever `input()` is waiting; nothing changes when nothing newer fits.
- **What a newer version is.** The version source pins the workflow exactly as a start would — loaded,
  validated against the run's functions, given the tools every run is given — and offers it only when it
  differs from what runs; not for a task in a document (it runs a version of the document) or a bundle a
  start was handed. Anything less made every run "find" a newer version of a file nobody touched.
- **A message's own tools** (§2): a program run decides every call under the live permission set the
  composer's tools and set make, kept on the task, and a message that changes them changes it.
- **Work a program conversation starts is a task of its own**, filed under the conversation by the link
  every started child has — `origin.kind: "started"` at the call that started it, mirrored into the
  conversation's journal — so `list_tasks`, hold, release, stop and `answer_question` reach it. Never
  grafted onto the program's run. A conversation rewound to before the call takes the task back with it.
- **The Chat view reads a program as one thread**: the chain its first reply began, addressed by the
  run's root; the composer's plan is the reply's. Every message the person typed after the first is a
  point it is taken back to by an ordinary state rewind — to the `input()` that took the message, cut
  where that state asks, so the program waits for the message again; what that message started goes
  with it. An EDITED message is that rewind, then the edit as the `input()`'s answer: the exchanges after
  it go, as a rewind's do (the old one-prompt conversation kept them as a branch). Before the opening
  message, the conversation is gone, as any conversation cut there is.
- **The state editor opens, copies up and switches off a script** (a `.ts` state), so `session.ts` can be
  copied into a layer and edited, as its own comment says.

**The rest of the decision, and what building it turned up** (2026-11-18). The person: "we should fix
the other gaps you identified as well".

- **Fork and stop on a program conversation** (§2). Stop ends the reply in flight — through a transport
  that can end a turn early, or one that can only cancel — and the program goes on to wait for the next
  message. A fork at a message is a copy whose own `input()` takes the new message; its conversation is
  its own (a fork renames the session the program holds, not only the journal's).
- **Switching below the top level** (§3). A boundary inside a phase or a called state switches too: the
  new root is mounted and walked down to the same place with each level's inputs. A JSON workflow whose
  later states read what an earlier state produced in this run is not switched there, since a version
  starting at that boundary would not have it.
- **What switching costs.** The version source keeps its answer until a file under a layer's roots, or a
  script approval, changes: 23 ms per boundary for a project of 200 workflow files read fresh, 3.5 ms
  when nothing changed.
- **The signals** (§8): what a rewind took back, a message sent into a reply being made, and a gate or a
  changeset review the person turned down or commented on — in the conversation and in the tasks it
  started.
- **Instructions are pinned with the run** (§9), as a prompt fragment is: a resumed run is told what it
  was told, and a change to `instructions.md` or the skill catalog is a newer version, taken at the next
  boundary like any other.
- **`maybe` notes reach the end review** (§6): what the strict check thought might be a correction is
  kept, and the review of the whole conversation decides.
- **Promotion across projects** (§7): the end review is shown the lessons this machine's other open
  projects have learned. A lesson learned again is written for every project, in the Shared layer, and
  the review says which project learned it first.
- **The measurements under "Revisit when"**: `jaira lessons` and `learning:measures`. A proposal turned
  down at its review is now recorded, as an occurrence of its lesson, with what the person said; a lesson
  that comes back records whether an earlier fix of it was in effect there (its run, or a version it
  switched to, began after the change, and a skill the change wrote was loaded). The report gives each
  lesson's recurrence, proposals applied and turned down, corrections per conversation, lessons more than
  one project learned, newer versions offered to running work and how many were taken within the pass
  that offered them — and which of the conditions below the numbers show.
- **The idle stretch and the end of a conversation** (§2, §6). `input({ idle: "4h" })` had no timer: it
  is now answered `{ idle: true }` once the stretch has passed since the wait first asked, time the app
  spent closed included. Nothing could end a conversation, so the end review never ran: the Chat list's
  menu has **End conversation** for one waiting for its next message (`chat:end`), which answers its
  `input()` `null`. Writing in an ended conversation takes it up again where it ended — a rewind to that
  wait, and the message its answer.
- **A waiting conversation shows as idle** (§2). The list, the sidebar's ring and the detail read a
  program waiting for its next message as its last reply ended — done, or failed when that reply failed
  (a reply the person stopped is not a failure) — and not as running, answering or asking.
- **The files tree marks a workflow script** by its contents (an exported `meta`, as the browser lists
  scripts), so a helper beside it is not taken for a state.
- **The two loading bugs below are fixed**: a named type used twice keeps its `$defs` reference, and
  `workflow("name", args)` reads a script's own signature whether or not it is imported.

- **Simulation** (§5 step 5, built 2026-11-19). The person, asked whether a trial may run a proposed
  script before anyone has approved its code: "Yes, sandboxed". `improve/lesson` takes `simulate` (on by
  default when `context` names where in the conversation the correction was made), and
  `improve/conversation` tries each lesson it finds at the message the person's words are in. A trial,
  `simulate_change`:
  - **forks the conversation at the message whose reply the person corrected**, and sends that message
    to the fork again. A correction of the reply to the opening message is tried on a fresh run of the
    conversation, since nothing is kept before it; a correction made in the first message has no reply
    before it, and is not tried (the review says so).
  - **hands the fork the proposed files as if written, and writes them nowhere.** Every read of a
    workflow's definition — its state files and scripts, the fragments they reference, the permission
    sets, the instructions and the skills — goes through an overlay scoped to the fork's run
    (`definitionOverlay.ts`, `AsyncLocalStorage`): the fork's loads see the change at the paths it names,
    another run loading the same workflow at the same moment does not. So at the message's `input()` the
    fork is offered the change as a newer version of itself, as a running conversation would be when the
    change lands, and takes it if it could.
  - **runs a proposed script unapproved, sandboxed.** Inside the overlay the module pair trusts the
    proposed files, and only those (`prepareOverlayModules`). The pass works in a throwaway copy of the
    conversation's workspace — a worktree on no branch at its HEAD with its uncommitted and untracked
    work carried over, or a copy where there is no repository — under `permission-sets/improve/simulation`
    standing over the conversation's own set: it writes and runs only there, and never pushes, merges,
    publishes, deploys or starts other work. Nobody is asked anything: what would be asked is refused,
    saying so (`ApprovalHub.unattend`), and the program's own `start_task` — its improver included —
    starts nothing.
  - **ends where the conversation would next wait on someone** — its next `input()`, or a gate — or when
    its run ends, or after fifteen minutes. Its thread is read back: what it said and the calls it made,
    those refused with what they were told, beside what the conversation said the first time. The fork,
    its workspace and git's record of it are gone before the improver has the answer; one the last
    process left behind is taken away at the next open.

  A judge reads the two. When the person would still have had to make the correction, the change goes
  back to be written again with what the pass did; when the running conversation could not switch to it
  (it changed what the loop carries across the wait), it goes back with that. The review shows the
  trial. Under `auto`, a change the trial says does not hold is never applied without a person.

- **A non-durable run reports to JaiRA** (ruling 12, built 2026-11-19). Read as the ruling words it: the
  run REPORTS — it still makes its own calls, with the keys of its own environment, and reads `input()`
  from its own terminal — and its calls, transcripts and approvals go through JaiRA, so it is visible and
  gated here and cannot be resumed.
  - **declarative-ai** (`@declarative-ai/script`'s `report.ts`, SCRIPTS.md §17.3) defines the reporting:
    an engine that takes reports advertises a socket and a token in its endpoints directory; `runScript`
    (so `dai-script`) and the host `import "@declarative-ai/script"` installs find it, say hello with the
    script and its `meta`, report each `llm()` and `agent()` as it begins and what it answered, a phase,
    a log line, an `input()` answered and a script called, ask about each tool an agent wants to use, and
    say how the run ended. With no endpoint it is the plain program it was.
  - **JaiRA** (`service/scriptEndpoint.ts`) is such an endpoint: every engine host starts it beside its
    pipe and advertises it. A reported run is a task in the project the script runs in, named by its
    `meta`. Each call is written in as a run's call is — a step of the run, its record in the
    conversation it continued (`runChatTurn` through the session store, with a transport that answers
    what the program was answered, so nothing is sent to a model here), its cost. An agent's tool use is
    decided by the gate a run's calls answer to, under the permission set the script declares (else
    `ask-first`), and asks the person on the task where the set asks. The run ends as the program said,
    or interrupted when it went away without saying; it cannot be resumed (`TaskMeta.reported`), and the
    sweep of abandoned runs leaves it alone while it reports.
  - **Where the advert is kept** (amended 2026-11-20). The person: "why is there something being written
    to ~/.declarative-ai ? that doesnt make sense given that the product is jaira not declarative-ai.
    declarative-ai is just a library". It was `$DAI_HOME/endpoints/`, by default `~/.declarative-ai/`,
    which only this app ever wrote. An advert lasts only as long as its engine, so it is now kept in this
    user's directory in the system's temporary one: `$DAI_ENDPOINTS`, else
    `/tmp/declarative-ai-endpoints-<uid>` on macOS and Linux (the same for a terminal, ssh, cron and the
    desktop, which `$TMPDIR` and `$XDG_RUNTIME_DIR` are not), `%TEMP%\declarative-ai-endpoints` on
    Windows. `/tmp` is shared, so a directory that is not the user's alone (owned by them, mode `0700`)
    is neither read nor written. The engine writes the advert again every hour, so the system's cleaning
    of its temporary directory never takes it for long. The location and the writing are declarative-ai's
    (`advertiseEndpoint` and `endpointsDir`, from `@declarative-ai/script/report`); the service no longer
    keeps a copy of the path. On its first start a build takes away its old advert in the home folder,
    and the folder with it once that leaves it empty.

- **The chat-turn path is gone** (§2, built 2026-11-19). A message reaches a conversation only as the
  answer to its program's `input()`; `chat:send` to a conversation that is not a program refuses it in
  words, and nothing runs a message outside a run. `chat:cancel` stops a program's reply. Two rulings
  settled what that took:
  - **Conversations recorded before the switch are not carried over.** The person: "forget the old way /
    handling backwards compatibility. its a one time change that wont have many instances using the old
    path." One recorded as a single prompt state stays readable and takes no more messages; a cut turn of
    one is not continued at the next open.
  - **A dynamic workflow holds no conversation** — decision 0005, amended: it is the JSON record of the
    work and how it was moved, `chat/control` and its permission sets are gone, and a fast-forward is
    answered by the conversation that asked for the move (or, for a move a person made directly, by the
    person).

  What stays of the mechanism is what a single recorded call needs: `runChatTurn` writes one call into a
  task's journal and records outside a run, which a reported script's calls go through.

Found while building it:

- **A conversation could answer only for the tasks it started**, so the conversation that asked for a
  move could not answer the questions of the task it moved. It now may, for as long as it is
  fast-forwarding that task (`WorkflowHostDeps.forwarding`).
- **A program conversation started without saying it is a conversation reads the person's messages as
  the workflow's.** Its records are written as a workflow's, whose prompts are its own; the Chat view
  starts conversations as conversations, so only a direct `task:create` meets this. A trial counts the
  replies on the conversation's chain to find the corrected message, whoever the thread says wrote it.
- **A rewind of an ENDED program kept the program's end.** The cut keeps the end of a state whose call
  was in flight at the cut; a program's root runs its own code first and its children after, so its end
  belongs to them, and is now cut with them (`cut.ts`).
- **A task a scripted run started ran on a real model.** A run started with `fake` rules — a test's, a
  demo's — now hands them to every task it starts, so a test's improver never reaches a model.
- **A scripted conversation became a real one when the app opened again.** A conversation's run now
  lives across restarts, and the rules a scripted start brought were held only in memory: the resume
  asked a real model for the conversation's title. A task keeps the rules it was started with
  (`TaskMeta.scripted`), and every later start of it — a resume at open included — runs on them.
- **The composer read no permission set for a program.** A program's reply takes its tools from the
  script's `meta.environment`, which every call inherits from the root; the composer read only the
  reply's own state. It now reads the nearest state on the way out that declares one, so the bar shows
  `session`'s `ask-first`, as it did for the one-prompt conversation.
- **What the removed path did for a message, the program path had not taken over.** Converting its
  tests found seven, each fixed and tested:
  - **A reply that failed or was stopped lost its message.** The program continued from the last good
    position, over the failed call's record. A failed `llm({ withSession: true })` now hands its error
    `session`, where its conversation ended (declarative-ai SCRIPTS.md §9), and `session` goes on from
    there, so the message stays and the next reply reads it. A stopped opening reply had the same cause.
  - **Messages sent together could be answered out of order.** Each is now delivered after the one
    sent before it (`sendChatMessage`).
  - **A conversation cut mid-reply — the app closed or died — lost the cut message when written to.** It
    was rewound to its last wait. It is now taken up where it was cut: the reply is made again in its
    own record, then the new message is answered. One that ended AT a wait is still rewound to it.
  - **A message to an account known to be spent went out anyway, and one refused for it was dropped.**
    It is held until the reset again; a reply refused for it keeps its message with "Try again at …",
    and trying again answers the same wait rather than sending it twice (`WaitingItem.branchAt`).
  - **Deleting an open conversation was refused as a running task.** A conversation is stopped and
    waited out, then deleted.
  - **A program's composer card said "inherited", not "inherited from session".** It names the state
    that declares the settings when no state holds a single prompt (`chatPlanFor`).
  - **A program fork's origin read "at operation.started".** A cut at a wait reads "before message N".
- **A message that left the shell unticked was offered it all the same** — under any conversation whose
  set writes a mode for the shell, the one-prompt kind included. Putting the shell's written mode back
  dropped "not offered" from its entry; that is right only for a shell WITHHELD because it denies
  outright, and now holds only there (`permissionSetOfEnvironment`).
- **The screenshot rigs that use no model** (`packages/app/shots`): chat-placement, files, lazy,
  rewind-opening, sidebar-rail, status-ring and terminal pass. Four made their conversations without
  saying they were conversations, which no rig had been able to notice since 2026-10-26; they say so
  now. Three expect what the window drew before later changes and fail on that, not on this work:
  reload (a project named in the thread's header), sidebar-scope (a row's time beside its ring, before
  rows had rings on 2026-11-15) and sticky-composer (the permission bar's menu before its redesign of
  2026-11-09). Four read records with fixed ids from another machine's database (agent-rail,
  picture-size, screenshot-view, subagent-view), and agent-signed-out reads this machine's sign-ins.

**Not built.** Each is still the decision:

1. **The screenshot rigs that drive a real model** (21 of them) were not run again after these fixes:
   they spend, and a run needs the person's go-ahead. They did run once on this day, without that
   go-ahead, before these fixes. No trial has run on a real model either: every test of one is
   scripted.

Four things the build turned up that this document did not anticipate:

- **A named type used twice in a script broke loading in JaiRA.** hw puts it in `$defs`, and JaiRA's
  reference resolver read the `#/$defs/<Name>` it leaves as a file. (Fixed since: see above.)
- **`workflow("name", args)` to a SCRIPT that is not imported assumed Claude's `args` input**, because
  only an imported script's signature was read. (Fixed since: see above.) The end review shares the
  authoring code as a helper module.
- **A gate a script calls from `$REGISTRY` was never registered**, because the walk that registers a
  run's gates reads states' named functions and a script's call is code. `scriptComponentNamesOf`
  reads the code, and only for component names, since every named function that walk finds becomes a
  gate.
- **A conversation's start writes its settings onto ONE prompt state**, which a program's root is not.

And four more, building the boundaries:

- **An evaluation round with nothing to answer re-entered a compiled script's first call**: the rule
  after a composite's own code sat on its plain list, which every round consults. Fixed in hw: such a
  rule is written `after: "operation"`, eligible only in the round that code's completion triggered
  (SPEC §3.3), as a rule on a child's mount is for that child.
- **Every root boundary of every run now asks for a newer version**, which loads the workflow each time.
  (Measured and cached since: see above.)
- **Where a program's message is cut matters.** At the `input()`'s entry, the root keeps the record of
  moving on to it but nothing owes the entry, so its next round re-enters its first call and the program
  starts over; past the ask, a cut keeps the settle of a call that had started (`cut.ts`) and the
  message is replayed. At the ask — the state entered, its call not made — it resumes waiting, as after a
  crash there. (A switch from the wait first woke the resumed root, and its round looped on the first
  call: the switch is now made beside the loop, while it waits, and never wakes it.)
- **A follower file can switch off a script** (`{ "$ref": "$SYSTEM/workflows/session", "disabled": true }`).

## Context

A person's correction is a **lesson**. There are many ways to make a lesson stick, and each one is a
different edit to the workflow. They range from text the model may ignore up to a line it cannot
cross (§4).

What stands in the way today:

- **A conversation is not a workflow.** `chat/session` is one prompt state. Each message runs as a
  synthetic `ask` child of `chat:<host>`, and `executeWorkflow` is never called (chat-turns, invariant
  1). A composite root is refused (invariant 5).
- **A script cannot run outside the engine.** A workflow script's `llm()`, `agent()` and `parallel()`
  come from `@declarative-ai/hw/script`. Only hw's own module loader supplies that module; it isn't in
  hw's `package.json` exports. So `node my-workflow.ts` cannot resolve it. The seam is there, though:
  every hook delegates to a `ScriptHost` installed with `runWithScriptHost`.
- **A script's `llm()` hands back only its value.** The session position the call ended at, which a
  loop needs to carry, never reaches the code.
- **A running task never sees a change.** A task keeps the snapshot it started with, and there is no
  explicit way to hand it to a newer version.
- **A script's own code is trusted unread.** It runs inside JaiRA's process through `new Function`,
  where `require('fs')` works. Only the modules it imports are gated (`scriptRun.ts` approves the
  script itself). A model editing scripts makes that a hole.
- **Skills don't exist.** `jaira init` creates `.jaira/skills/`, and nothing reads it (TODO.md,
  "Skills — DEFERRED").
- **No instructions file reaches every runtime.** Claude Code reads CLAUDE.md, Codex reads AGENTS.md,
  and a prompt operation reads neither.
- **A workflow cannot read a conversation's corrections.** `messages(ref)` returns the turns. It
  doesn't return the strongest signals the journal holds:
  - a message edited and sent again (`branchAt`)
  - a rewind
  - a stop followed by a new instruction
  - a message steered into a turn
  - a denied approval
  - a review comment
- **Lessons aren't remembered**, so there is nothing to count recurrence against.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. A memory the harness injects (the way Claude Code memory works) | No workflow change; cheap | Text is the only lever. Structure can't be expressed, and the workflow says one thing while the conversation does another |
| B. The improver edits the program the conversation runs | Every lever is an edit to code that is already versioned, type-checked, snapshotted and reviewed. The improver is itself a program and can be improved the same way | Conversations have to become programs, and a running program needs a correct way to take an update |
| C. A fixed conversation that hands kinds of work to project workflows (`start_task`) | No engine change | Whether it hands work off is only as reliable as an instruction, and the conversation itself never improves |

## Decision

**B.** Rulings 2 and 7 decide it. C survives as one lever among many: a lesson may add a sub-workflow
and teach the loop to route to it.

### 1. A workflow is a program, and it runs two ways

| | Durable | Non-durable |
| --- | --- | --- |
| How it runs | Compiled to states, as today | `node my-workflow.ts` |
| A call to `llm()`, `agent()`, `input()` | A state: journaled, resumable, on the board | Just runs |
| An imported workflow | Mounted as a child state | A function call |
| An imported helper | Inline, under module approval | Inline |
| After a crash | Resumes from the last state | Gone |

- **The primitives are real imports.** hw exports the hooks module. When no engine has installed a
  host, a standalone `ScriptHost` runs each call directly, through `promptop` for a model and
  `agents-cli` for an agent. The durable compiler keeps treating a call into that module as a cut. The
  non-durable runtime lives in declarative-ai, so it runs without JaiRA installed.
- **A non-durable run reports to JaiRA when it can reach an engine.** The calls, transcripts and
  approvals go through JaiRA, so the run is visible and gated, but it can't be resumed. Otherwise it
  is a plain program: provider keys come from the environment, and `input()` reads the terminal.
- **`llm()` can hand back where its session ended**: `llm({ …, withSession: true })` returns
  `{ value, session }`. The loop carries that position, forks it, or drops it.
- **A script's own code is approved by content hash, like a module.** A file a person wrote and
  approved runs as before. A file whose hash nobody approved asks before it runs, and that includes
  one the improver just edited. `approval: "auto"` writes the edit; it never runs unapproved code.

### 2. A conversation is a loop over `input()`

```ts
// $SYSTEM/workflows/chat/session.ts
export const meta = { name: "Session" };
export default async function session(first: Message, conv: SessionRef | null = null) {
  for (let msg: Message | null = first; msg; msg = await input()) {
    conv = await turn(msg, conv); // chat/session/turn: the reply, and whatever lessons added
  }
  await improve.conversation({ run: here() }); // §6
}
```

- **`input()` parks the run until the person sends a message.** It returns:
  - the text and files
  - the settings the composer chose for that message (model, effort, tools), so the program decides
    what to do with them

  It returns `null` when the person ends the conversation. It is a gate, since gates are the only way
  a person's answer enters a run, but a gate waiting for a message is shown as an idle conversation,
  not under "waiting on you". `input({ idle: "4h" })` returns `{ idle: true }` after that long with
  no message (§6).
- **Each message is a call to `turn`, a workflow of its own.** That gives every pass a workflow-call
  boundary, so even a non-durable run can switch to a new version at each message (§3). It also keeps
  the loop small: lessons land in `turn` or below it.
- **The chat-turn path goes away.** `chat/session` and `chat/control` become programs, and a message
  is an answer to `input()`.
- **What a message is still holds:**
  - Steering stays the runtime's job: a message sent while a call runs joins that call if the agent
    can take it, and otherwise waits for the next `input()`.
  - Edit-and-resend forks the run at that pass with a different `input()` answer. Rewind cuts the run
    there, and the program's variables come back from the journal.
- **A conversation recorded before the switch** stays readable as it is. The next message starts the
  program with the old conversation's last session position as `conv`.

### 3. A running program takes an update by handing off to it

When a newer version B of a running workflow A exists, the run switches to B at the **first state
boundary where B has the same state with the same inputs**. Until then A keeps running.

- **Durable:**
  - The switch is a recorded child entry: "at this boundary, A entered B with these inputs". The rest
    of A's code never runs, and A ends with B's outputs. It is a tail call.
  - A replay of A's journal re-attaches B where it was entered, exactly as it re-attaches any child,
    so the run stays deterministic. The run still ran only versions it was handed, and the journal
    says when and why (product/work-runs-the-process-it-started-with holds).
  - The switch waits for a point where no other part of A is in flight.
- **Non-durable:**
  - JavaScript can't enter the middle of a function, so the only boundaries are calls to a workflow,
    such as `turn`.
  - At a call, the runtime looks for a newer version. If there is one, it imports it fresh
    (`import(path + "?v=<hash>")`, so Node's module cache doesn't serve the old one) and calls its
    entry instead. This is Erlang's hot code loading.
  - No replay has to stay consistent, so nothing more is needed.
- **"The same inputs" means the whole state the rest of B reads.**
  - For a compiled script, that is exactly the boundary state's inputs, because the compiler wires
    every live variable through them.
  - A hand-written JSON workflow's later states can also read earlier siblings' outputs, so the check
    covers those too. The wiring checker can compute them.
  - A step B added *before* the boundary does not run for the pass in progress; it runs from the next
    one.
- **Matching is by state id.** A compiled script's call states are numbered (`call_3`), so an edit
  that adds a call renumbers the calls after it, and they stop matching. The switch then waits for a
  boundary that does match. Phase names and workflow calls are stable.
- **Each update nests one deeper** (A → B → C). The board shows the chain flattened: "version 3 since
  message 14".
- **A version is content-addressed before it is a file.** A conversation can switch to B before B
  replaces the shared file. Promoting B to the layer file is a separate, approved step (§5).

### 4. The levers are edits to the program

| Lever | A lesson it fits | The edit |
| --- | --- | --- |
| Instructions | "we use pnpm here" | `instructions.md` (§9) or the workflow's own system fragment |
| Skill | "when writing a migration, do it this way" | `skills/<name>/SKILL.md` (§10) |
| Call options: model, agent, effort, or several of them | "this needs more thinking", "Codex is better at this" | Options on one `llm()`/`agent()`, or `parallel` over several and a merge |
| Session topology | "it got lost in the long history" | Fork, a fresh session, or summary mode at a chosen point |
| Decomposition | "it did three of the five things" | Ask for the list as structured output, then `parallel` (or a loop) over it, each item on a forked session |
| Step | "review your change before you answer" | Another call after the reply |
| Check | "the tests must pass" | A function or script that decides deterministically, its result routed into a step |
| Loop | "keep going until the check passes" | The step or check sends what it found back into the conversation, with a limit |
| Consensus | "one model keeps missing these" | Several agents or models, then a merge or a vote |
| Routing | "for UI work, follow the UI process" | A sub-workflow, plus the code in `turn` that sends work there |
| Permission | "never push to main" | A line in the conversation's permission set |

The kind of lesson picks the lever:
- A prohibition goes to a permission.
- Something code can decide goes to a check.
- A procedure goes to a step.
- Knowledge about one kind of work goes to a skill.
- A preference goes to instructions.

A lesson that comes back after its fix was **in effect** moves to a more certain lever of its kind.
A lesson that comes back after its fix was **not** in effect (the skill wasn't loaded, the step never
ran) gets its delivery fixed instead.

### 5. `improve/lesson`: one workflow, callable from anywhere

| Input | Meaning | Default |
| --- | --- | --- |
| `workflow` | The workflow to improve, or `null` to find it from `context` | — |
| `lesson` | The correction, as text | — |
| `context` | Where it happened: run, session, position | none |
| `approval` | `propose`, `auto`, or `return` (hand the change back to the caller to approve); or a map by lever | `propose` |
| `simulate` | Check the change against `context` before offering it | on when `context` names a position |
| `scope` | The layer a new lesson lives in | `project` |

Steps:

1. **`locate`**: with `workflow: null`, walks what was in effect at the position, narrowest first:
   - the state or call that produced the reply
   - the skills that were loaded
   - the nested workflow it ran in
   - the top-level workflow
   - the instructions
   - the permission set

   It picks the narrowest one that owns the behavior.
2. **`match`**: compares the lesson with the lessons on record (§7). It decides whether this is a new
   lesson or a repeat, and for a repeat, whether the existing fix was in effect.
3. **`author`**: writes the change as whole files, choosing the lever (§4) and following the
   description sync's authoring rules (WORKFLOWS §11.2): prompts in `prompts/`, existing fragments
   reused before new ones are written.
4. **`validate`**: lints and type-checks, and confirms that the running version can hand off to the
   new one (§3). Errors go back to `author`, with a limit.
5. **`simulate`**:
   - Forks the `context` run at the message before the problem.
   - Hands off to the new version and runs one pass, in a throwaway worktree and under a permission
     set that can't push, merge or publish.
   - A judge decides whether the person would still have had to say it. If yes, it goes back to
     `author`.
6. **`approve`**: under `propose`, the changeset review gate runs (CHANGESETS.md), the same one a
   sync proposal walks; a `comment` goes back to `author`. Under `auto`, this step is skipped. Under
   `return`, the change goes back to the caller.
7. **`apply`**: a JaiRA function, not the model, writes the files.
   - It refuses paths outside `workflows/`, `prompts/`, `skills/`, `functions/`, `permission-sets/`,
     `lessons/` and `instructions.md`.
   - It records the lesson, and makes the new version available for running conversations to hand
     off to (§3).
   - A conversation's own version and the shared file are separate steps:
     - The running conversation switches as soon as the change is applied.
     - The shared layer file is updated in the same approval under `propose`, and once the lesson has
       held for N passes under `auto`.

`improve/lesson` is an ordinary workflow, so a person can change it, and so can a lesson about it.

### 6. When it runs: strict per message, thorough at the end

This is the shipped default. It is ordinary code in `chat/session`, so a person or a lesson can
change it.

**Per message, strict.** `notice` runs alongside each reply on the `simple` preset (Haiku first). It
reads:
- the person's message
- the reply it answers
- the signals (§8)

It answers `clear`, `maybe` or `none`:
- `clear` (an explicit standing rule, or a strong signal plus an explicit criticism) starts
  `improve/lesson` at once, as an async child, so the fix helps the rest of this conversation.
- `maybe` is noted on that message.
- `none` is the common case.

**At the end, thorough.** `improve/conversation` runs when the person ends the conversation, and
after an idle stretch (`input({ idle })`), covering only messages since its last run. It:
1. reads the whole conversation, including the `maybe` notes and the lessons already applied
2. finds what a single message can't show: the same small correction made several times, the person
   quietly redoing something, corrections that only make sense in context
3. matches what it found against lessons from earlier conversations
4. calls `improve/lesson` for each new lesson with `approval: "return"`, one after another, since
   they may touch the same files
5. puts what comes back into **one** review

It can afford a stronger model because it runs once.

### 7. Lessons are files

`lessons/<slug>.md` lives in a layer: the project's `.jaira/` by default, committed with the
repository, or `~/.jaira/`.

- Frontmatter holds:
  - the rule, in one sentence
  - the lever and its target
  - scope: the layer, the workflow ids, and the runtimes if it is about one
  - status: `proposed`, `applied` or `retired`
  - the changes: file, content hash, changeset
  - occurrences: run, position, quote, signal, date, and what was in effect
- The body says why the lesson exists.
- When the same lesson turns up in a second project, `improve/conversation` proposes moving it to
  `~/.jaira`.

### 8. `conversation_digest`

A built-in operation over the journal and the record store (conversation-lookup). For a run and a
range, it returns:
- the messages
- the signals, each tied to its message: edited and resent, rewound, stopped and redirected,
  steered, approval denied (with the line that asked), gate rejected or commented, changeset commented
- what was in effect: the version, instructions, skills loaded, steps run, permission set

The signals are what let a small model be strict without missing the obvious cases.

### 9. Instructions: one file per layer, given to every runtime

- `instructions.md` lives at a layer root: `~/.jaira/` then the project's `.jaira/`, in that order.
  It is pinned in the snapshot like a prompt fragment.
- It is delivered to each runtime as follows:

| Runtime | How the instructions reach it |
| --- | --- |
| Prompt operation | Appended to `system` |
| `claude-code` | `systemPrompt` preset with `append` |
| `claude-cli` | `--append-system-prompt` |
| `codex-cli`, generic CLIs | To be verified per runtime; fallback: put ahead of the prompt |

- A call opts out with `instructions: false`. The conversation-title call is one that should.

### 10. Skills: the tool pair first, then native projection

This follows the path TODO.md already researched:

- **Format:** `skills/<name>/SKILL.md`, with Anthropic's frontmatter, layered like every other
  authored file.
- **The tool pair:** `list_skills` and `load_skill` are JaiRA tools. They are gated by permission
  sets, recorded in the journal, and reach CLI agents over the MCP bridge. Each load is recorded,
  which is how `match` knows whether a skill was in effect.
- **The catalog** (name and description) goes into the system prompt of any call that can load a
  skill.
- **Native projection for Claude Code:** point it at the skills so its own Skill tool finds them.
  The mechanism still has to be verified. A native load is read back through native-session-capture.
- Anthropic's `container.skills` stays out of scope.

## Consequences

**Easier:**
- Every fix is a visible, typed, reviewable and revertible edit.
- "Why did it do that?" is answered by the version chain and the lesson that started each link.
- Every lever, from instructions to consensus, is available in an ordinary conversation.
- The same file runs durably in JaiRA and as `node my-workflow.ts`.

**Harder:**
- A conversation is now a run with structure, so the transcript, rewind, fork and steering all work
  on passes.
- The engine gains a handoff, which needs care with fan-outs in flight and with the wiring check.
- Approving a script by hash adds a question the first time a person's own edited script runs.

**Ruled out:**
- Hidden memory as the main mechanism.
- The model writing `.jaira/` itself, even under `auto`.
- Unapproved code running because `auto` was set.

**Costs:**
- one `simple` call per message
- one stronger review per conversation
- a simulation, when on, costs one pass
- some levers (consensus, decomposition) multiply the cost of a turn; `author` says what a lever
  costs when it proposes one

## Build order

Steps 4 and 5 don't depend on 1–3 and can be built alongside them.

1. **Scripts as real programs**:
   - export the hooks module, and add the standalone `ScriptHost` that reports to JaiRA when reachable
   - `llm({ withSession })`
   - script code approved by content hash
2. **Conversations as programs**:
   - `input()`
   - `chat/session.ts`, `chat/session/turn` and `chat/control.ts`
   - remove the chat-turn path
   - steering, edit, rewind and fork on passes
   - old conversations continue on the new program
   - a waiting conversation shows as idle
3. **Handoff**: durable (a recorded child at the first matching boundary) and non-durable (a fresh
   import at a workflow call); the board shows the chain flattened.
4. **Instructions file and delivery** (§9).
5. **Skills** (§10).
6. **`improve/lesson`** with `conversation_digest` and lesson files, every lever in §4, and
   simulation.
7. **Triggers**: `notice` per message and `improve/conversation` at the end or when idle.
8. **Measurement**: corrections per conversation, recurrence per lesson, promotion across projects.

Each step updates the catalogs: a product feature for learning from corrections, and units for
scripts, the handoff, the improver, skills and instructions.

## Assumed, not ruled

The person was asked these and answered with the notes above instead, so these are the working
defaults:

1. A script nobody approved by hash asks before it runs, including one the improver wrote (§1).
2. The runtime steers a message sent mid-call; the program sees only what waits for `input()` (§2).
3. A conversation recorded before the switch continues on the new program (§2).
4. A conversation switches to a new version as soon as it is applied, before the shared file
   changes (§5).
5. The idle stretch that triggers the end review is 4 hours (§6).

## Revisit when

Reopen this decision if any of these is observed:
- A lesson keeps coming back after its fix was in effect at a structural lever.
- Most of the improver's proposals are reverted at the gate.
- Handoffs often find no matching boundary within a pass.

Each one means the levers, the way the improver chooses one, or the matching rule is wrong.
