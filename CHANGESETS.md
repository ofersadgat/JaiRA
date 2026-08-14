# Changesets — a proposed change is a value, and reviewing it is a state

**Status: BUILT (2026-08-12), with the §7.3/§7.4 rendering stack deliberately smaller than
designed.** What shipped, and where it landed:

- The model, source grammar, decisions, pure application and the strategy registry —
  `packages/shared/src/changeset.ts` / `diffStrategies.ts` (§1, §2, §4.1–4.2, §7.1–7.3).
- The two producers and drift — `packages/runtime/src/changesets.ts` (§2, §3.2).
- The gate family and the authored review loop — `packages/runtime/src/changesetGate.ts` (§4):
  `apply-changeset`, `changeset-review-status`, and the `changeset/review` workflow. The gate
  itself is the sixth component in `packages/shared/src/components.ts`, registered only through
  the InteractionHub.
- §5 whole: migration 4 (`state_machine_events`, the normalised `operation_records`,
  `session_positions`), the read-side projection in `sessionStore.ts`, and the unconditional
  dispatcher recording in `wiring.ts`.
- §6's split (`GitRead` / `GitLifecycle`) with git-cli as the only backend — the §6.2 build order.
- §8: the mount contract and reviewer (`packages/app/src/renderer/changesetReview.tsx`), the
  anchor-guarded `uri:read` channel, the sync lowered into a changeset producer, and the CLI
  reviewer (`packages/cli/src/changesetReviewer.ts`).
- The PRODUCT entry points (2026-08-13): **`changeset:review`** — a task's worktree diffed against
  a base and walked through the gate via the ordinary interaction flow, with a "Review changes"
  action on any worktree-bound task and `jaira changeset review` at the terminal; **`changeset:reviewSync`**
  — the sync's changeset through the SAME gate ("one mechanism, one UI" made literal), applied into
  the layer root, the sync baseline moving exactly when the whole proposal was merged — and since
  the sync-workflow redo (2026-08-13) it is the LOOPING review (`changeset/review-loop`, flow 1): a
  `comment` goes back to a model whose respond prompt (`syncRespondPrompt`) carries the sync's own
  state-file and prompts-folder rules plus the description, so a revision is written under the same
  discipline as the proposal. The sync's proposals themselves became PATH-addressed
  (`SyncEdit.path`) rather than state-addressed, which is what lets a proposal put reusable prompt
  text where it belongs — `prompts/`, in category subfolders, referenced with
  `{"$ref": "$/prompts/…"}` — instead of sealing it inside state files; and §3.2's
  drift VERIFICATION inside `apply-changeset` — the tree is checked against what it is supposed to
  hold (`before` under a base tree, `after` under a proposal tree) before anything is written, and
  a moved tree is refused with the drifted files named rather than overwritten. (`.jaira/` is
  excluded from worktree changesets — the recorder's own writes are not the work under review.)
- §8.1's DEFAULT HOST and §8.2's services, made real (2026-08-13): a parked gate whose task's
  conversation is on screen renders THERE — inline, as the conversation's newest turn — and the
  modal became the fallback host; the join is `PendingInteraction.about`, carried by the review
  task's labels. The `services` object is live: `readUri` powers a pre-submission §3.2 check that
  badges changes whose files moved (worktree anchor first, then the layer roots — the reviewed
  task's id scopes `$WORKTREE`); `drafts` flags a change whose file has unsaved edits in the
  editor; `openFile` links a change to it, supplied only by the hosts that have an editor to open —
  which is §8.2 working as specified: the host's reach, not the component, decides what exists.
  And `chmod` APPLIES: a change carries git's modes, `FileWrite` carries the resulting mode, and
  the application step sets it (a no-op on Windows, faithful on POSIX) — §1.1's fifth action is no
  longer representable-but-inert.

Three deviations, each recorded where it bites:

- **§4.3's `any(...)` guard** needs higher-order expressions (EXPRESSIONS.md §3.5, unbuilt), so a
  pure helper (`changeset-review-status`) derives `settled` and the guards read it. The helper
  retires when §3.5 lands.
- **§7.3 landed as Monaco on BOTH sides — the alignment position taken literally.** The full pane
  (`packages/app/src/renderer/monacoDiff.tsx`, lazily loaded, local ESM + bundled workers — no CDN
  loader, per this section's Electron rule) is Monaco's `DiffEditor` with the modified side
  editable, feeding `merged.content`. And the TEXT STRATEGY computes its stored hunks with the
  exact function that editor runs — `linesDiffComputers.getDefault()`, deep-imported from monaco's
  ESM tree (pure JS, DOM-free; it works headless in the CLI and in tests). So stored hunks and the
  pane agree by construction, `vscode-diff` is unnecessary, and §10.2 is answered rather than
  dissolved. The import path is an unversioned internal surface, handled by a TRIPWIRE instead of
  a pin: the "exact differ" test in `packages/shared/test/diffStrategies.test.ts` fails on any
  upgrade that moves it, which is the signal to update the import — never to hold monaco back.
- **Flow 1 is now expressible in ONE workflow — `changeset/review-loop`** (superseding an earlier
  deviation note that said bindings could not carry a round's output into the next). The mechanism,
  found empirically in the engine: sequence-reset clearing supersedes SEQUENCE members only, so a
  child entered by transition and kept OUT of the spine survives the loop-back, and the carry
  binding is a lazy ternary — `.children.revise.outcome === 'success' ?
  .children.revise.outputs.changeset : .inputs.changeset` — whose untaken arm is never evaluated
  (a never-entered child's `outcome` reads undefined rather than parking). The model's answers come
  back as COMPLETE files (§11) and `changeset-revise` folds them in with stable change ids and
  re-derived hunks. The cost: the reachability analysis proves nothing across a transition-driven
  loop, so every child-reading slot carries the `default` opt-out (never read at runtime). The
  single-round `changeset/review` remains for workflows that author their own respond.

Two things in JaiRA today produce changes a person has to read before they land, and they have
nothing in common:

- **A sync proposes state files.** `workflow/sync/states` returns complete files with a reason each
  ([`syncWorkflow.ts`](packages/runtime/src/syncWorkflow.ts)), and the app drops them into the
  drafts map so the editor shows them unsaved. What it cannot do is show you *what changed* — the
  panel lists a reason string and a link ([`syncPanel.tsx`](packages/app/src/renderer/syncPanel.tsx)).
- **An agent edits code in a worktree.** Every task may be bound to a branch and a directory
  (`TaskDetail.branch`, `TaskDetail.worktreePath`), so the edits exist and are perfectly readable by
  `git diff`. Nothing reads them.

Both are the same question — *here is a set of changes; which do you want?* — and the answer to it
should be one mechanism, one UI, and one recorded value that a later state can act on.

The value is a **changeset**. Git and a state's output are two producers of it; a unified diff is
derived for display and never stored as the truth. Reviewing one is an ordinary interactive state,
and what it returns is the changeset annotated with a decision and commentary per change — which is
what makes the next round, or the next workflow, something you can wire rather than something you
have to invent.

---

## 1. The model

### 1.1 A changeset is data

```jsonc
{
  "source": "git:8f2a1c…",              // §2 — a pinned version, never a live path
  "changes": [
    {
      "id": "c1",                        // stable within the changeset; anchors every decision
      "path": "workflows/feature/plan.json",
      "action": "update",                // create | update | delete | rename | chmod
      "before": "…",                     // absent for create
      "after": "…",                      // absent for delete
      "hunks": [ /* §7 — strategy-dependent, but every one carries a text range */ ]
    }
  ]
}
```

Every git action is representable, because a review of an agent's work will meet all of them —
`WorkflowSyncEdit`'s `create | update` ([`ipc.ts:501`](packages/shared/src/ipc.ts)) is the sync
case's subset, and generalising now is cheaper than discovering a rename halfway through. A binary
file is carried as a change with no `before`/`after` and a stated reason it cannot be shown; it can
still be approved or denied, just not read.

### 1.2 The source is a version, not a location

`source` names **where the change starts from, at a specific point in time**. A path is not enough:
a comment is a statement about particular text, and text at a path changes. This is the whole reason
the field is a URI rather than a directory — see §2 for the forms and §3.2 for what happens when the
world moves anyway.

### 1.3 Every content change lowers to a text edit

A change carries two different kinds of thing, and they resolve differently:

- **The `action` is a file-level change** — `create | update | delete | rename | chmod` — and is
  applied as a file operation. It has no hunks to argue about; it is taken or not taken whole.
- **Content** — the `before`/`after` that `create` and `update` carry — is where strategies differ
  in how a change is *found* and *shown* (a JSON pointer, an AST subtree, a line hunk), and where
  they must be identical in how it is **applied and reverted**: a replacement of a range with a
  string. Without that, `merged` means something different per file type and a changeset stops
  being one kind of thing.

The corollary is the rule that keeps the two editing surfaces from fighting: **the text is the
source of truth, a structural change is applied as a text edit, and the structural view is
re-derived from the text.** Accepting a structural change and then hand-editing in the editor must
not produce two disagreeing models of one file.

---

## 2. Addressing — expanding the reference grammar

[REFERENCES.md](REFERENCES.md) §1 already defines a URI-ish grammar with named roots (`$JAIRA`,
`$PROJECT`), `file:`, relative forms, and a rule that anything unrecognised is **refused rather than
guessed at**. It was built to be extended this way, so this adds two schemes to it rather than
inventing a second address space.

| Form | Names | Immutable |
| --- | --- | --- |
| `git:<sha>` | a commit — the base a worktree diff is taken against | yes |
| `git:<sha>:<path>` | one blob | yes |
| `db://operation_records/<session>@<seq>.result.changeset` | a changeset a function returned, by the position it claimed | yes |
| `db://operation_records/<operationId>[.<pointer>]` | a record by its CONTENT id — the id settled `operation.*` events carry; rooted at `{request, result}`, placed or not (§10.6, settled) | yes |
| `file:…` + content hash | the working tree at a moment, for a source with no commit | verifiable, not resolvable — the hash detects drift but cannot recover the content once the tree moves |

Two notes on the spellings:

- **`git:` resolution needs a tree listing, not a directory listing.** §1.1's "longest match against
  the directory listing" becomes `ls-tree` for this scheme. Everything else about the grammar is
  unchanged, and a git blob is the only genuinely immutable address in the system — so it is also
  the only one that can be cached without an invalidation story.
- **`db://` reuses a spelling that already exists.**
  [`sessionStore.ts`](packages/persistence/src/sessionStore.ts) already writes a session position as
  `<id>@<position>`, and under §5.1's schema that pair is the primary key of `session_positions`,
  resolving through the join to the operation record that holds the payload. Addressing by that
  compound key is stable in a way an autoincrement rowid is not — and note that `artifacts` is the
  wrong table to address by logical path, since `UNIQUE (task_id, logical_path)` means a rewrite
  replaces. A record never placed in a session has no `@` spelling; if one ever needs addressing,
  that is the record-id seam of §10.6.

**Known limit, accepted:** a `db://` reference is machine-local. A chain that must travel to another
machine would need content addressing throughout. The project database is local, worktrees are
local, and tasks are local, so this is not a limit anyone reaches by accident.

---

## 3. The chain

### 3.1 A state that edits code ends by producing a changeset

This is the rule that makes everything downstream composable. A state that asks a model to change
files does not end with "it changed some files"; it ends with a changeset whose `source` is the
commit it started from. Anything that then modifies those changes — this reviewer, another workflow,
a second agent — produces a changeset whose `source` references the first.

The result is a linked, fully-recomputable history: every intermediate state of the work is
`apply(source, changeset, decisions)` away, and nothing has to be re-derived by inspecting a
directory.

### 3.2 Drift is another link, not an error

The base can move between a changeset being produced and a person reviewing it. When it does:
generate a changeset from the stored base to what is actually there now, record it, and mark it as
the basis the pending changeset now sits on. Drift becomes a link in the chain like everything else,
and the user sees it as a change to review rather than as a failure.

**Open (§10.1):** whether to then auto-rebase the pending changeset onto the new base — a three-way
merge, which can conflict — or present both and let the workflow decide. Presenting both is the
position this document takes, because a silent rebase is how a reviewer stops trusting what it
shows.

### 3.3 Two flows

**Flow 1 — iterate on a changeset.** The user marks changes `approve` / `reject` / `comment`; the
state returns; the workflow transitions back into itself with the annotated changeset; the model
answers the comments and produces an updated one. When a round comes back with no `comment`
decisions left, `merged` and `reverted` are applied and the workflow moves on.

**Flow 2 — find new things to comment on.** A new changeset, chained by `source` onto the one flow 1
finished with. It is a new review with a new UI and no carried-over comments — by §1.2 a comment
belongs to the text it was made about, and the previous discussion is read from the record (§5), not
resurrected into the new view.

---

## 4. The gate

### 4.1 `user-approve-changeset`

An interactive state in the existing sense: an ordinary `FunctionOp` whose function is registered as
interactive, parked by the [`InteractionHub`](packages/runtime/src/interaction.ts) and answerable
only through `interaction:submit`. That guarantee is load-bearing and unchanged — nothing running
inside a workflow can reach the hub, so an agent cannot fabricate a human decision about its own
code.

It takes a changeset and returns **every change it was given, each with a decision**:

| Decision | The user | The files |
| --- | --- | --- |
| `approved` | approved it | left as the change proposed, not applied |
| `merged` | approved it | applied |
| `denied` | denied it | left as the change proposed |
| `reverted` | denied it | rolled back to the base |
| `comment` | said something about it | left alone |

`merged`, `reverted` and `comment` are the defaults offered by the UI; `approved` and `denied` exist
so a workflow that separates the judgement from the application can have both.

The files column is not bookkeeping. The annotated changeset goes back to the model (flow 1), and
what the model needs to know is whether the tree still contains the proposal — `denied` vs
`reverted`, and `approved` vs `merged`, is exactly that signal.

A `merged` change may carry `content` — what the user typed, when they edited the change themselves
before accepting it. **This is the only part of the outcome that is not derivable**, which is
exactly why it is the only content the record has to store.

### 4.2 `apply-changeset` is pure, and therefore separate

Given `(source, changeset, decisions)` the resulting files are determined. So the application step is
a pure function, and splitting it out of the gate is not tidiness — it puts each half on the right
side of a distinction the execution layer already draws:

| | `user-approve-changeset` | `apply-changeset` |
| --- | --- | --- |
| Entry kind | `host`, interactive | `pure` |
| `memoizable` | `false` | `true` |
| `mutatesWorkspace` | `false` | `true` when writing a worktree |
| Recorded (§5) | yes — this is the non-derivable part | recorded like any op (§5.2), but derivable — nothing depends on it |

It also means the application is testable without a UI, and that a workflow can review now and apply
later, or apply in a different worktree.

### 4.3 The loop lives in the workflow

The transition is authored, not decided by the UI:

```jsonc
"transitions": [
  { "when": "any(.children.review.outputs.decisions, d => d.decision === 'comment')",
    "to": "./respond" },
  { "when": "true", "to": "./apply" }
]
```

`limits.max_iterations` already caps it. The UI submits an answer and never decides whether there is
another round — which keeps the policy visible on the board, pinned in the snapshot, and changeable
by the author without touching a component.

### 4.4 A review's ordering is the changeset chain, not a session

⚠️ **Rewritten 2026-08-13; the original said "a review is a session" and proposed giving each
review its own conversation.** That conflated two chains with different jobs. The system has three
orderings, and each answers its own question:

- **`state_machine_events`** orders everything within one run.
- **The session chain** orders CONVERSATION turns — positions plus provider handles, for
  continue/fork (DESIGN.md §7.3, the absorbed sessions model).
- **The changeset chain** orders the evolution of the PROPOSAL: round N+1's changeset
  `source`-references round N's (§3.1).

A review's rounds are links in the third chain, and with §10.6 settled that chain is NAVIGABLE:
every settled `operation.*` event names its record, the gate's record pins the changeset it showed
(`request_json`, §5.3) and the decisions that answered it (`result_json`), and the positionless
`db://operation_records/<id>` form addresses all of it. So flow 2's "read the previous discussion
from the record" is a walk along `source` links — ordered, readable, and needing no session to be
either.

Sessions still meet reviews, but the way they meet every operation: **by value**. A session ref
encodes both the position and the provider handle, so a workflow that wants a review to reference —
or a respond state to continue — the conversation that produced the changes passes the ref as an
ordinary variable (`.children.agent.operation.output.session`, or any output that carries one). No
engine placement of interactive gates, no special case: the gate stays a plain recorded function
op, and conversations stay conversations.

---

## 5. Records — what makes any of this recomputable

### 5.1 Two truths, two tables — and a name collision

⚠️ An earlier draft of this section "corrected" [TODO.md](TODO.md) for saying the `operations`
table does not exist, pointing at `operation_records`
([`migrations.ts:65`](packages/persistence/src/migrations.ts)). That was a name collision, not a
correction — they are different tables:

- **`operation_records` (built, misnamed)** is the conversation turn store: one row per call placed
  in a session, holding what the call produced verbatim, keyed `PRIMARY KEY (session_id, seq)` so
  that claiming a position is a constraint and a collision is a fork rather than a race. Written by
  `withRecord`; read back by `sessionView`, with `conversation.ts` projecting the journal around it.
- **`operations` (DESIGN §4.2, never built)** is the per-attempt operation record —
  `request_json` / `result_json` / `error_json`, status, attempt — the table that actually deserves
  the name.

Neither is derivable from the journal: `operation.completed` carries metrics and **no payload**
(`EngineEvent`, upstream `hw`). The system has an irreducible pair — the journal records *that*
operations ran, a payload store records *what they returned* — and today the payload store exists
only in session-shaped form, for placed prompt calls.

**Agreed schema (2026-08-12): normalise instead of renaming around the collision.**

| Table | Holds |
| --- | --- |
| `state_machine_events` — rename of `events` | lifecycle truth, and nothing else rides in it: `instance.*`, `operation.*`, `transition.taken`, `child.superseded` |
| `operation_records` — the DESIGN table, taking the name | one row per operation attempt: `request_json`, `result_json`, `error_json`, `provider_session_id`, status, attempt |
| `session_positions` — `(session_id, seq, operation_record_id)` | conversation membership; the primary key IS the position claim, a duplicate insert is `PositionTaken` → fork |

`open()` inserts the operation record and the position row in one transaction; `close()` updates
only the record; the "payload wins when it is already a conversation" projection in
[`sessionStore.ts`](packages/persistence/src/sessionStore.ts) moves to the read side. Upstream's
`RecordStore` interface does not change — it is backed by two tables instead of one.

Downstream of this: `instances` and `transitions` are pure projections of the journal — future
caches for step-level resume at most, not schema. `conversations` is superseded by the sessions
model and is struck. DESIGN §4.2's "materialized tables are the resume source" note now says the
opposite of what is true and is rewritten to journal-as-truth. And the TODO.md entry is *updated*,
not struck.

**One seam to settle before building (§10.6):** journal `operation.*` events carry no record id, so
linking an event to its record means either adding the id to the event payload (an upstream `hw`
change) or correlating by `(task, run, instance, attempt)`. The `db://` grammar (§2) wants this
settled, because `<session>@<seq>` addresses only placed calls.

### 5.2 The one composition change

Function ops are not recorded, and the reason is one flag.
[`wiring.ts:279`](packages/runtime/src/wiring.ts) composes `withSessionPosition` over `withRecord`,
and the dispatcher-level caller passes `onlyWhenPlaced: true`. The comment there states the concern
exactly:

> wrapping a dispatcher unconditionally would start writing every pure helper and every embedded
> call into the store that holds the run's transcripts […] Unifying the two is a behaviour change,
> and not one this refactor is entitled to make.

§5.1's schema dissolves the concern rather than answering it. The store that holds transcripts is
now `session_positions`, and an unplaced call never touches it — its record lands in
`operation_records` with no position and pollutes nothing. So the dispatcher is wrapped
unconditionally, `onlyWhenPlaced` retires, and **every operation is recorded**; placement decides
only whether a record also claims a seat in a conversation. (An earlier draft used `memoizable` as
a write filter — record non-memoizable entries, skip pure ones. That is no longer needed for
correctness; what remains of it is a retention question, §10.5.)

Note the inversion this fixes at the root. Results *are* stored today — in `call_memo`, via
`withMemoize` — but only for `memoizable: true` entries. So deterministic calls are remembered and
non-deterministic ones are lost, which is backwards from what a record is for. With one op-record
table everything is recorded once, and `call_memo` becomes a lookup concern rather than a second
store of truth.

### 5.3 What gets recorded

The changeset arrives as the gate's **input** and lands in `request_json` — which is why §5.1's
table, not the journal, is the load-bearing half of this design. That single fact removes a
constraint this design spent a while working around: reproducibility does not depend on which
differ produced the changeset, because nothing recomputes it. The change ids a decision refers to
are stable because the changeset is pinned as data, not because two implementations agree.

It matters most for a worktree-produced changeset: its `after` side comes from a mutable directory,
so a record that did not pin it would be unrecoverable the moment the worktree moved. The decisions
land in the same record's `result_json`, and the only content that is not derivable —
`merged.content`, the user's own edit (§4.1) — travels inside them.

---

## 6. Git

### 6.1 Two interfaces, not one

| Interface | Operations | Backends |
| --- | --- | --- |
| `GitRead` | `diff`, `show`, `status`, `catFile`, `lsTree`, `revParse` | all |
| `GitLifecycle` | worktree `add` / `remove` / `list` / `prune` | git-cli only |

Everything in this document needs only `GitRead`. `GitLifecycle` is what
[`worktrees.ts`](packages/persistence/src/worktrees.ts) and the task model need, and it stays
CLI-only — a project on a machine without git simply cannot use worktree-backed tasks, which is
honest and far better than a backend that half-implements them.

### 6.2 Backends, in preference order

1. **git-cli** — today's [`Git`](packages/runtime/src/git.ts), over the `Exec` seam. Implements both
   interfaces.
2. **nodegit** (libgit2) — `GitRead` only. libgit2 opens a linked worktree correctly: it follows the
   `gitdir:` pointer file and reads `commondir`, so HEAD and index come from the worktree admin
   directory while objects and refs come from the main repository. The caveat is the project, not
   the library: nodegit is dormant — no recent releases while the Electron ecosystem moved to
   Node 22 — and a native module "still works" only relative to the ABI it was built for, a
   question every Electron bump re-asks.
3. **isomorphic-git** — `GitRead`, with a caveat. It does not resolve the `gitdir:` pointer and does
   not implement `commondir`, so worktree support has to be written by hand (~50 lines): follow the
   pointer, read `commondir`, and route object lookups there. Point `gitdir` at the admin directory
   alone and object lookup fails; point it at the main `.git` and you silently read the *main*
   worktree's HEAD, which is worse.

⚠️ Two claims made and withdrawn during design, kept because they are the ones someone would repeat.
"isomorphic-git has no worktree support" is too strong — the correct statement is that it has no
worktree *management* and no commondir resolution. And the objection does not extend to nodegit:
libgit2 handles linked worktrees natively, which makes it the *stronger* fallback in semantics —
survival odds are the caveat above. What survives is a cost, not a blocker: a second native module
on top of better-sqlite3, both needing the electron-vs-node rebuild `scripts/nativeAbi.mjs` manages.

**If it ever ships, it ships as an `optionalDependency`, resolved at build time.** npm skips an
optional dependency whose native build fails; the backend does a guarded `require` and registers
only on success, which the selection above already tolerates. For the packaged app the question
"does it compile" is answered on the **build machine** — users get whatever CI built, so
optionality is a per-release, per-platform property, not a per-machine probe. Three consequences:
`scripts/nativeAbi.mjs` treats a nodegit rebuild failure as non-fatal; the build reports which
backends shipped rather than silently dropping one; and CI asserts the module actually built, or
the fallback path ships untested forever. The case that earns its keep is precisely the packaged
app on a machine with no git installed — in dev, git-cli always wins and nodegit never runs.

**Build order: define the interface now, implement git-cli only.** The interface is the load-bearing
part; a backend nobody has needed yet is maintenance paid in advance.

### 6.3 Selection is per project environment

Not a machine-wide probe. A WSL project's git lives in the distro, and "no git on Windows" must not
demote it to a JS backend reading over `\\wsl$` — that is precisely the slow, permission-fragile
path DESIGN §9.1's Exec seam exists to avoid. The selector asks *which git can reach this project's
repository*, and for a WSL project the answer is git-cli through `wsl`.

---

## 7. Computing the diff

### 7.1 A strategy registry, keyed by mime

The same shape as [`fileSurfaces.tsx`](packages/app/src/renderer/fileSurfaces.tsx): register the
most specific type that changes behaviour and let a fallback chain cover the rest.

| Type | Strategy |
| --- | --- |
| `application/json`, workflow states | structural (§7.2) |
| `application/yaml` | structural, via the `yaml` Document API (already a dependency) |
| everything else | text (§7.3) |

### 7.2 Structural

`just-diff` or `microdiff` to enumerate changes as pointer-level operations — one row per structural
change, which is the decision granularity a reviewer of a proposed state file actually wants.

**`jsonc-parser` is the load-bearing half**: it maps each pointer to a range in the *authored* text
and applies accepted changes through `modify()` / `applyEdits()`, which are minimal and
format-preserving. A structural diff that round-trips through `JSON.parse`/`stringify` reformats the
file and reports every state file in the repo as wholly rewritten.

`jsondiffpatch` was considered and rejected: its delta format is its own vocabulary and it cannot
write back to authored text, which is the requirement.

### 7.3 Text

`vscode-diff` — VS Code's line differ, extracted — computing the changeset, and Monaco's
`DiffEditor` rendering it. The differ is DOM-free and works headless, which the CLI reviewer and the
tests need.

The reason to use *that* differ specifically is alignment, not correctness. Monaco's diff editor
renders only diffs it computes itself — the documented knob is `diffAlgorithm: 'legacy' | 'advanced'`,
and while an undocumented custom-provider object exists, it is poorly typed and has open bugs
(monaco-editor #4264, #4764, #4036): the same unversioned internal surface §11 already rejects. So
if the stored changeset came from a different algorithm, the accept/reject widgets and the
highlighted regions do not line up; same algorithm on both sides makes them agree. The `vscode-diff`
extraction predates the advanced algorithm and almost certainly tracks the legacy one, so the real
choice (§10.2) is: pin the `DiffEditor` to `diffAlgorithm: 'legacy'`, or drop the alignment
argument and render jsdiff hunks as custom decorations. (Verify the legacy assumption before
committing.)

`@monaco-editor/react` loads Monaco from a CDN by default. In Electron that must become
`loader.config({ monaco })` against a local `monaco-editor`, with `MonacoEnvironment.getWorker`
wired to Vite `?worker` imports — otherwise it hangs on a blank editor with no error.

### 7.4 Language-aware, later

Real AST diffing means tree-sitter (`web-tree-sitter`, WASM, fine in browser/Electron/node) plus a
GumTree-style tree-edit-distance with move detection. That is a project, and the JS ports are not
production-grade. Shelling out to `difftastic` gets excellent output immediately and reintroduces
the binary dependency §6 works to make optional.

§7.1's registry is the seam. A per-language strategy drops in without the reviewer changing, and
§1.3's invariant is what guarantees its output is still applyable.

---

## 8. The UI

### 8.1 A component mounts itself

The contract is a mount function, not a React element:

```ts
mount(node: HTMLElement, ctx: { config, inputs, services, onSubmit }): () => void
```

The caller decides where the node is — a pane, a modal, a frame, a second window — and the component
does not know. The default host is the conversation view; a review is part of what happened in that
state, and reading it there is where someone will look for it.

**Built-ins only for now.** Third-party components may come later, and the contract is shaped to
allow it — but opening it means workflow content gains a code-execution path into the renderer, and
that is the boundary [`interaction.ts`](packages/runtime/src/interaction.ts) is currently airtight
about. A trust model is a prerequisite for that step and is not designed here.

### 8.2 `services` is the API

A component that owns its own root cannot reach anything through React context, so everything it
needs arrives explicitly. That object is the public surface the day third-party components are
allowed, so it is specified now rather than accumulated:

| Member | For |
| --- | --- |
| `readUri(uri)` | file and blob contents — §8.5 |
| `theme` | tokens, so a component matches the window |
| `drafts` | the unsaved-edit map, for changes targeting open files |
| `openFile(layer, path)` | linking a change to the editor |
| `diffStrategy(mime)` | §7.1, so a component renders diffs the way the app does |

### 8.3 Width

Side-by-side is unreadable at conversation width. The default rendering there is unified-inline with
an affordance to open the same review in a full pane.

### 8.4 The CLI

A separate implementation of the same registered function: one change at a time, the same five
decisions, the same changeset in and out. It composes with an existing limitation rather than
fighting it — the hub is process-local, so a CLI-driven run answering at a CLI prompt needs no new
channel.

### 8.5 `uri:read`

One generalised read channel replacing a layer-scoped one, resolving `file:`, `git:` and `db://`.
It must be anchor-guarded the way artifact destinations already are
([`artifactPath.ts`](packages/runtime/src/artifactPath.ts) refuses `"dir": "../../escape"`):
resolvable only under `$PROJECT`, `$JAIRA`, `$WORKTREE`, and to blobs in the project's own
repository. A renderer-reachable channel that resolves arbitrary `file:` URIs is a sandbox escape.

---

## 9. What changes

| Where | Change |
| --- | --- |
| [`REFERENCES.md`](REFERENCES.md) | `git:` and `db://` added to §1's grammar; §1.1 gains a tree-listing path |
| [`git.ts`](packages/runtime/src/git.ts) | split into `GitRead` / `GitLifecycle`; `diff`, `show`, `catFile`, `lsTree` added; today's class becomes the git-cli backend |
| [`wiring.ts`](packages/runtime/src/wiring.ts) | `onlyWhenPlaced` retired — the dispatcher records unconditionally; an unplaced record carries no position, so transcripts stay clean (§5.2) |
| [`migrations.ts`](packages/persistence/src/migrations.ts) | `events` → `state_machine_events`; `operation_records` becomes the per-attempt record (`request_json`/`result_json`/`error_json`); `session_positions` join added; existing turn rows migrated (§5.1) |
| [`sessionStore.ts`](packages/persistence/src/sessionStore.ts) | `RecordStore` backed by op records + positions; the payload-wins projection moves to the read side (§5.1) |
| [DESIGN.md](DESIGN.md) | §4.2 rewritten to journal-as-truth: `instances`/`transitions` demoted to optional caches, `conversations` struck, "materialized tables are the resume source" reversed (§5.1) |
| [`components.ts`](packages/shared/src/components.ts) | a sixth component: enum, config type, normalizer, result schema |
| [`components.tsx`](packages/app/src/renderer/components.tsx) | the mount contract (§8.1); the dialog stops being the only host |
| [`stateViews.ts`](packages/persistence/src/stateViews.ts) | the new name added to "this is a UI component, not a missing runtime" |
| [`gate-components.md`](docs/engineering/contracts/gate-components.md) | the new contract documented |
| [`ipc.ts`](packages/shared/src/ipc.ts) | `uri:read`; `WorkflowSyncEdit` becomes a changeset producer |
| [`syncWorkflow.ts`](packages/runtime/src/syncWorkflow.ts) | `EDITS_SCHEMA` output lowered into a changeset |
| new | the changeset model, the strategy registry, the reviewer, the CLI reviewer |
| [`TODO.md`](TODO.md) | the §4.2-tables entry updated, not struck: `operations` lands as `operation_records`, the rest demoted or dead (§5.1) |

---

## 10. Open

1. **Drift** — RESOLVED as designed: `changesetDrift` produces the second changeset and presents
   both; no rebase is attempted (§3.2).
2. **`vscode-diff`'s algorithm** — RESOLVED by the smaller rendering stack: no Monaco pane shipped,
   so the alignment argument lapses and jsdiff's hunks are rendered as the reviewer's own
   decorations. Re-opens if a Monaco full-pane view is ever built; the undocumented custom-provider
   escape hatch stays rejected.
3. **nodegit's `git_worktree_*` binding coverage** (§6.2) — still irrelevant: `GitRead`-only, and
   no second backend shipped at all (§6.2's build order, taken literally).
4. **`apply-changeset` and `ctx.workspace.treeHash`** — ACCEPTED as stated: the entry is
   memoizable, and the pinning is supplied by whatever calls it. Nothing in the built workflow
   memoizes the application step.
5. **Recording volume** (§5.2) — RESOLVED as a non-question (2026-08-13): scopeless durable
   records cannot occur. Every durable store is constructed run-scoped and pruned with its run; an
   ad-hoc `jaira run` keeps its records in memory (`sessionServicesFor` with no inner store) and
   they die with the process. The invariant is "everything durable has a run" — if ad-hoc runs are
   ever made durable, they mint a task and a run like everything else, and the same pruning covers
   them.
6. **The record-id seam** (§5.1) — RESOLVED (2026-08-13): settled `operation.completed`/`failed`
   events now carry `operationId`, the content hash of the op AS DISPATCHED — which is exactly the
   id `withRecord` gives an unplaced record, so the journal and the record store share a key (a
   placed call's join was always `metrics.sessionRef`; both halves are covered). JaiRA exposes it
   as the `operation_id` generated column (migration 5, the session_ref pattern), and the §2
   grammar gained the positionless form `db://operation_records/<operationId>[.<pointer>]`,
   rooted at `{request, result}` — so a gate's §5.3-pinned changeset is addressable as
   `…<id>.request`. One totality fix fell out: `hashOperation` throws on a live stream input by
   design (a memo must refuse it), so the event stamp is omitted there and `withRecord` mints a
   unique non-content id instead of failing the call it exists to witness.
   `operation.started` carries no id, deliberately — it fires before input resolution, so the
   dispatched op the hash is OF does not exist yet.

---

## 11. Considered and rejected

- **Storing the produced changeset.** `merged` and `reverted` are deterministic given the source,
  the changeset and the decisions, so the outcome is derivable. Only `merged.content` — the user's
  own edit — has to be kept. Storing the derivable half would create a second thing that can
  disagree with the first.
- **Re-anchoring comments when the base moves.** A comment is a statement about specific text.
  Moving it makes it a statement about text nobody wrote. Drift is handled by §3.2 instead.
- **A patch on the wire from a model.** `EDITS_SCHEMA` demands complete files because models cannot
  count line numbers. Whole file in, hunks derived. Real unified diffs are accepted only from git.
- **Monaco's differ as the sole differ.** Not because it is unusable headless — the computer is
  DOM-free — but because reaching it means deep-importing an unversioned internal path.
  `vscode-diff` is the same algorithm with a supported surface.
- **diff-match-patch.** Character-level with fuzzy patch application, which matters only when
  applying a patch to text that has drifted. The base is pinned, so it never has.
- **A modal reviewer.** Today's `InteractionDialog` hardcodes a modal, which is far too small for a
  multi-file review and is the decision §8.1 lifts to the caller.
