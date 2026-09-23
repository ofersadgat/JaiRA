---
id: engineering/units/operation-record-store
type: engineering-unit
status: shipped
updated: 2026-09-22
implements: [product/complete-record-of-every-run, product/pick-up-where-it-left-off, product/rewind-to-where-it-went-wrong, product/try-another-direction]
layer: data
owns_contracts: []
requires: [engineering/units/storage-policy]
implemented_by: [packages/persistence/src/sessionStore.ts, packages/persistence/src/blobStore.ts, packages/persistence/src/memoCache.ts]
verified_by: [packages/persistence/test/sessionStore.test.ts, packages/persistence/test/cut.test.ts, packages/persistence/test/blobStore.test.ts, packages/persistence/test/memoCache.test.ts]
siblings: [engineering/units/conversation-lookup, engineering/units/rewind-and-fork, engineering/units/run-load, engineering/units/native-session-capture, engineering/units/live-turns]
---

# Operation record store

## The store records what every call was asked and returned and which seat it holds, and leaves reading conversations to conversation-lookup

`SqliteSessionStore` in `sessionStore.ts` implements upstream `SessionStore` and `RecordStore` over `operation_records`, `sessions` and `session_names`, scoped to one task by `SessionScope {taskId}`. It owns:

- **Record identity and life.** `append(stub)` inserts one row per dispatch under `stub.id`, the hash of the scoped request upstream computes. `request_json` is the operation with `scope {instanceId, sequence}` and `session {id, seq, providerSessionId?}` added beside its fields, and the row is born `open` already holding the call's `user` text as its first entry. A re-dispatch of an id whose row is `open`, `failed` or `interrupted` reopens that row in place, keeping its partial and re-stating its request; an id whose row `completed` is refused. `update` writes a streamed partial into an `open` row only. `finish` settles to `completed`, to `interrupted` when the error is classified `interrupted`, or to `failed`; it stores the result with big leaves dehydrated, keeps the streamed partial when an errored settle brings no conversation, and carries each streamed turn's `timing` onto a successful settle when the roles line up. **Who wrote the call's message** rides the entry: a store opened for a run (`sessionStoreFor(…, "workflow")`, the app's and the CLI's) or for a message the app sends on the person's behalf (`"host"`) pins `openingBy` in `request_json` beside the op, and `withAuthors` marks the first user entry whose text is the request's `user` with `by`, and every `system` message `by: "workflow"`, at the birth, every flush, the settle, and where reported `messages` become entries on read. What goes back to the provider (`messagesOfRecord`) is unchanged; a fork keeps `openingBy` out of the recomputed identity.
- **The seat claim.** The `op_position` partial unique index on `session_id, session_seq` covers rows that are `open` or `completed` with no `landed_session_id`. A conflicting insert or reopen becomes upstream `PositionTaken`, which upstream `withSessionPosition` answers by forking once. A failed, interrupted or landed row keeps its row and releases its seat.
- **Session identity.** `resolve` turns a ref's name into a session id: an existing session id is itself, a `session_names` alias for this task names its session, and an unknown name mints a UUIDv7 session and its alias in one transaction. A seeded mint is `s_<seed>`, and a fork's seed carries its parent id and cursor.
- **Remote identity.** `sessions.provider` and `provider_session_id` are stamped together or not at all, and only when nothing live sits past the settling record. `resolve` offers the handle only for an append at the head. A fork or a position behind the head gets none; a branch gets a `forkFrom` copy source from the nearest ancestor with a handle when a stored message `uuid` can name the cut; a rewound session's own handle becomes a copy source cut at `cut_at`.
- **Divergence.** On `update` and `finish`, `correctLineage` moves a record whose call reports a handle other than the one its seat expects onto a new branch by writing `landed_session_id` and `landed_seq`, unless the session is cut.
- **Cutting.** `cutSession(sessionId, seq)` deletes every row at or after the seat and every branch that left at or after it with its aliases, then stamps the last kept handle with `cut_at` or clears the handle. `dropRecords(ids)` deletes records that hold no seat. Both release blob references and write tombstones.
- **Derived conversations.** `compact` and `resync` write a `completed` record at seat 0 of a new session `<id>~<word><n>` whose request is `{kind: "derive", word, from, session}`. Upstream declares both optional, and no production code in either repository calls them.
- **Crash recovery.** `recoverable(taskId)` lists `interrupted` or `failed` rows with a provider handle and no `"capturedAt"` in their result; `foldNativeCapture(id, fold)` stores what the caller's fold returns for a record-shaped value.
- **Calls as data.** `record(id)` and `records()` return hydrated `RecordedCall`s for the task.

`blobStore.ts` replaces each string leaf of 1024 characters or more with `{"$blob": <sha256>}`, stores the bytes once in `blobs` with `refs` counting the records that name them, hydrates a value in one query, and `collectBlobs` deletes rows at zero. `SqliteMemoCache` in `memoCache.ts` implements upstream `MemoCache` over `call_memo`.

It deliberately does not own:

- Reading a conversation: `transcript`, `forks`, `lineageOf`, `at`, `messages`, the record-shape projection and the readers over them are [conversation-lookup](conversation-lookup.md).
- The live tail that calls `update` through `recordAt`: [live-turns](live-turns.md).
- Reading an agent's own session file and folding it into entries: [native-session-capture](native-session-capture.md). Settling a crashed task's `open` records: `recoverInterrupted` in [task-lifecycle](task-lifecycle.md).
- Choosing a cut point and copying a task's records: [rewind-and-fork](rewind-and-fork.md). Deleting failed records that reported no handle before a resume: `releaseUnconsumedFailures` in [run-load](run-load.md). Deleting pruned history: [history-pruning](history-pruning.md).
- The conversation file's format and replay: [storage-policy](storage-policy.md).

## The store is the data layer's implementation of upstream's session and record ports

- Layer `data`, package `@jaira/persistence`. It calls the connection, `blobStore.ts`, `messagesOfRecord` and the `ConversationLog` it is constructed with.
- Upstream seams: `SessionStore` and `RecordStore` from `@declarative-ai/exec`, reached by the engine through `sessionServicesFor({inner})` in `@jaira/runtime`, whose `withRecord` and `withSessionPosition` call `append`, `finish`, `positionOf`, `fork` and `resolve`; `MemoCache`, used by an executor's `memoize` step in `executorStack.ts`.
- Constructed through `sessionStoreFor(project, {taskId})`, which attaches the conversation file log when that concern is file-backed. A store built with `new SqliteSessionStore(db, scope)` writes the table only.
- The app hands every run and chat turn a `SqliteMemoCache` over the project database. `jaira` hands none, so a `memoize` step is skipped there.

## The table is the truth for records by default, and the conversation file once conversations are file-backed

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `operation_records` | inserted by `append` and `derive`; updated by `update`, `finish`, `correctLineage`, `foldNativeCapture`; deleted by `cutSession` and `dropRecords` | the table under `storage.conversations: db`; the conversation file under `file` and `both` | `recoverInterrupted` settles `open` rows; `forkTask` copies; `releaseUnconsumedFailures`, `deleteTask` and `pruneHistory` delete; conversation-lookup and `load.ts` read |
| `sessions` | inserted by `branch`, `branchFrom`, `sessionIdOf`, `derive`; updated by `stampSessionHandle` and `cutSession`; deleted with a dropped branch | same as records | `forkTask` copies; `pruneHistory` deletes |
| `session_names` | inserted by `sessionIdOf`; deleted with a dropped branch | same as records | `forkTask` copies; `deleteTask` and `pruneHistory` delete |
| `blobs` | written by `dehydrate` on `finish` and `foldNativeCapture`; decremented by `release` on delete | the database, in every storage mode | `forkTask` adds references; `pruneHistory` releases and collects |
| `call_memo` | `SqliteMemoCache.get` and `set` | the database | none; no task owns a row |

## The invariants keep one live record per seat and never offer a remote the conversation does not describe

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A second live claim on a seat is refused, never moved to the next seat | `sessionStore.test.ts` "refuses a second claim on one position, rather than silently taking the next" |
| 2 | No two records share an id; a re-dispatched id reopens its own row, and a completed id is refused | `sessionStore.test.ts` "reopens a re-dispatched id in place, and refuses one that already completed", "refuses a second record claiming an id another already holds" |
| 3 | A handle is offered only for an append at the head, and never to a fork, a moved-past position, a fresh branch or a handle with no provider | `sessionStore.test.ts` "resumes the provider's handle on an append, and withholds it from a deliberate fork", "withholds the handle at a position the conversation has moved past", "gives a freshly forked branch no handle of its own", "replays legacy records whose handles have no owning provider" |
| 4 | A branch behind its parent's tip gets a copy source only when a message id can name the cut | `sessionStore.test.ts` "names the CUT for a branch point the parent has moved past, when the entries can name one", "offers no fork source behind the tip when nothing can name the cut" |
| 5 | A call that reports another remote lands on a branch and leaves the trunk untouched | `sessionStore.test.ts` "moves a record to a branch when the call reports a remote it was not given", "leaves the lineage alone when the call reports the remote it was given" |
| 6 | A cut deletes the tail and every branch leaving it, and offers the remote only as a copy cut at the last kept message | `cut.test.ts` "deletes the tail, and offers the remote as a copy cut at the last kept message", "takes every branch that left the tail with it, and leaves branches above the cut alone", "drops the handle when the kept rows carry no message id to cut at" |
| 7 | A settled row is never overwritten by a late flush, and a flush with no open row writes nothing | `sessionStore.test.ts` "lets the settle replace the partial, and refuses a late flush after it", "writes nothing where no open row claims the position" |
| 8 | An errored settle keeps the streamed partial unless it carries the conversation itself | `sessionStore.test.ts` "keeps the partial when an ERRORED settle brings nothing better", "lets an errored settle that DOES carry the conversation win over the partial" |
| 9 | A record holds the message it was called with from birth, through every flush and settle, exactly once | `sessionStore.test.ts` "is on the record from birth, before anything has streamed", "stays in front of the turns a flush writes over it", "is not doubled by a settle that carries the question itself" |
| 10 | Streamed turn clocks reach a successful settle only when the roles align as a suffix | `sessionStore.test.ts` "carries the streamed per-turn times onto a successful settle, aligned as a suffix", "drops the times rather than mislabel a turn when the roles do not line up" |
| 11 | A task never lists another task's calls, and a call's status is reported apart from its error | `sessionStore.test.ts` "keeps a task's calls out of another task's list", `"lists a run's calls once each — a legacy id's attempts fold to their base, latest kept"`, "hands back status separately from the error, because a killed call has neither" |
| 12 | A compaction is a new conversation whose record names what produced it | `sessionStore.test.ts` "compacts into a NEW conversation, leaving every existing ref meaning what it meant", "writes the request that produced the seed, not just its contents" |
| 13 | Recovery offers only rows with a handle and no capture, and folds only into a record-shaped value | `sessionStore.test.ts` `"offers the handle and the start time — the cut that keeps a resumed session's earlier lines out"`, "passes over a row with no handle, a live row, and one already captured", "folds a recovered capture into the payload, beside what the crash had already saved", "leaves a payload it cannot honestly extend alone" |
| 14 | Blob bytes are stored once, counted once per record, hydrated in one query, kept as a reference when missing, and freed with their last referrer | `blobStore.test.ts` "replaces a big leaf with a reference and puts it back unchanged", "stores the bytes ONCE across records, and counts the records naming them", `"counts a value repeated INSIDE one record once — releasing it once has to be enough"`, "hydrates a whole record in ONE query, however many references it holds", "leaves a reference alone when its bytes are gone, rather than emptying the value", "keeps bytes a second record still names, and drops them when the last one goes" |
| 15 | The memo keeps successes only, is read across cache instances, and treats an unreadable row as a miss | `memoCache.test.ts` "refuses to persist a FAILURE, however it was handed one", `"is read by a DIFFERENT cache instance over the same file — the point of durability"`, "treats an unreadable row as a miss rather than a crash" |

## A killed call keeps what it streamed, and a competing claim becomes a fork rather than a lost turn

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The process is killed mid-call | the row stays `open` with its question and last flushed partial, and the record keeps the provider handle `update` stamped | `recoverInterrupted` settles it `interrupted` at the next open when its task was `running`; the app folds the agent's own session file in when a handle exists; a re-dispatch reopens the row | the interrupted turn shows what it had streamed |
| The process is killed mid-way through a chat turn | the task was never `running`, so the recovery sweep never settles the record, and it stays `open` | none | the partial turn stays, read as interrupted |
| Two live calls want one seat, including a chat turn in the app beside a `jaira` resume of the same task | under `storage.conversations: db` the claim index refuses the second; `withSessionPosition` forks once and runs the call on the branch, and a second refusal fails the call. Under a file-backed concern each connection claims alone, see [storage-policy](storage-policy.md) | none needed | the later call's turn continues on a branch |
| A reopened record finds its seat taken while it was dead | the reopen's update hits the claim index and raises `PositionTaken` | the call forks | the turn continues on a branch |
| A call is retried with the same scoped id | the row is reopened rather than a second row inserted | none needed | one turn, not two |
| A reader reads a record while its call streams | each write is one statement, so the reader sees a whole partial with status `open`, and `bySession` and replayed history leave it out | none needed | the turn so far shows as in progress |
| A referenced blob row is missing | hydration leaves `{"$blob": <hash>}` in the value | none | a reference object shows where the text was |
| An executor with a `memoize` step makes a call identical to an earlier success, including in a re-run | the earlier answer is returned; `memo.enabled` in `settings.json` gates nothing | remove the `memoize` step | the run repeats an earlier answer |
## The tables migrate only forward, and no reader keeps an old id form

- Migrations 2, 4, 8, 10, 13, 14, 15 and 17 shaped these tables, as [sqlite-schema](../contracts/sqlite-schema.md) records.
- A handle stored without a provider before migration 14 is kept on the record and never offered as a resume identity.

## Budgets are the blob threshold and one hydration query per value

- A string leaf is stored as a blob at 1024 characters or more: `BLOB_THRESHOLD` in `blobStore.ts`.
- Hydrating a value costs one `SELECT ... WHERE hash IN (...)` whatever it references: `hydrate` in `blobStore.ts`.
