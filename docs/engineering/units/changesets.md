---
id: engineering/units/changesets
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/review-changes-before-they-land, ux/patterns/per-change-review, ux/patterns/comments-turn-a-verdict-into-send-back, ui/components/changeset-review, ui/components/patch-view]
layer: core
owns_contracts: []
requires: [engineering/units/document-types, engineering/units/git-cli, engineering/units/artifact-placement]
implemented_by: [packages/shared/src/changeset.ts, packages/shared/src/diffStrategies.ts, packages/shared/src/unifiedDiff.ts, packages/runtime/src/changesets.ts, packages/runtime/src/changesetGate.ts]
verified_by: [packages/shared/test/changeset.test.ts, packages/shared/test/diffStrategies.test.ts, packages/shared/test/unifiedDiff.test.ts, packages/runtime/test/changesets.test.ts, packages/runtime/test/changesetGate.test.ts]
siblings: [engineering/units/component-contracts, engineering/units/description-sync, engineering/units/cli]
---

# Changesets

## The unit models a proposed change as a value, derives decisions from gestures, and applies them only where the tree has not moved

The pure half, in `@jaira/shared`:

- `Changeset {source, changes}`, where a `Change {id, path, action, fromPath?, before?, after?, unshowable?, hunks?, reason?, modes?}` is taken or left whole and a `ChangeHunk {id, start, end, text, label?, op?}` replaces `[start, end)` of `before`. `action` is one of `create`, `update`, `delete`, `rename`, `chmod`.
- `parseChangesetSource` and `formatChangesetSource`: `git:<sha>[:<path>]`, `db://<table>/<session>@<seq>[.<pointer>]` split on the last `@`, `db://<table>/<operationId>[.<pointer>]`, and `file:<path>[#sha256=<hex>]`. Anything else throws.
- `changesetOf` reads a changeset off the wire and throws on a missing or unparseable source, an unknown action, a malformed hunk and a repeated change id.
- `deriveDecisions(changes, drafts, reviewComment?)`: an X'd change is `denied`, a change with a comment or a note is `comment`, any other is `approved`. When nothing anywhere carries a comment, `approved` becomes `merged` and `denied` becomes `reverted`. A reviewer's edit is kept on a change that stays in, and only when it differs from `after`.
- `checkDecisions(changeset, value)` is the check main runs on a submitted answer. `reviewSettled` is true when every decision is `merged` or `reverted`. `CHANGESET_DECISIONS_SCHEMA` is the gate result's schema.
- `applyDecisions(changeset, decisions, tree)` returns `FileWrite[]` and touches no file. `merged` writes the reviewer's `content` or `after`; `reverted` rolls back only under `tree: "proposal"`. `baselineOf` returns the before side, with `text: null` for a file that did not exist.
- `diffStrategyFor(mime)` walks `mimeFallbacks` to a strategy: structural JSON through `jsonc-parser` `modify`, structural YAML through the `yaml` Document API, and otherwise Monaco's `linesDiffComputers`. A differing array is one hunk, and a side that does not parse falls back to text.
- `parseUnifiedDiff` reads a git or `diff -u` patch into `PatchFile[]`, which carry line numbers and no file content, so nothing can apply one. `looksLikeUnifiedDiff` and `patchStats` go with it.

The producing and applying half, in `@jaira/runtime`:

- `worktreeChangeset(git, base, read)` diffs a checkout against a resolved commit, pins `git:<sha>`, leaves out `.jaira/`, and marks a side containing a NUL byte `unshowable`.
- `editsChangeset(root, edits, read)` lowers whole-file proposals against the tree, takes each action from what the tree holds, and pins `file:<root>#sha256=<hex>` over every touched path and its bytes.
- `changesetDrift(pending, read, tree)` answers a changeset from what each touched file should hold to what it holds, chained by `source`, or `undefined`.
- `registerChangesetFunctions` registers `apply-changeset`, `changeset-review-status` and `changeset-revise`. Every app task run without its own capabilities registers them, as do both review runs and every CLI run.
- `changesetReviewFiles` authors `changeset/review`: `gate` → `status` → `apply`, ending without applying when the round is unsettled. `changesetReviewLoopFiles` authors `changeset/review-loop`, which sends an unsettled round to a `respond` prompt state and a `revise` function and back to `gate`, carrying `coalesce(.children.revise.output.changeset, .inputs.changeset)`.

It deliberately does not own:

- The `review_artifacts` component. Its config and result are [gate-components](../contracts/gate-components.md), checking an answer against the changeset input is [component-contracts](component-contracts.md), and parking the gate is [interaction-hub](interaction-hub.md). This unit owns only the name `REVIEW_ARTIFACTS` and the workflows that mount it.
- Producing a review of a task's worktree or of a sync's proposals, and moving the sync baseline: [description-sync](description-sync.md). `jaira changeset review` and the terminal reviewer: [cli](cli.md).
- Drawing the reviewer, which is renderer code in `changesetReview.tsx`.

## The rules are core logic shared by both sides of the boundary, and the functions plug into the engine's registry

- Layer `core`. The model and pure rules are exported from both `index.ts` and `browser.ts` of `@jaira/shared`, so main, the renderer, the CLI and runtime functions run one implementation. The producers, functions and workflows are in `@jaira/runtime`.
- It calls `mimeOfPath` and `mimeFallbacks` from [document-types](document-types.md), `GitRead` `revParse`, `diff` and `show` from [git-cli](git-cli.md), and `withinWorkspace` from [artifact-placement](artifact-placement.md).
- Upstream seam: `hostFunction`, `pureFunction`, `failureOf` and `CapabilityRegistry` in `@declarative-ai/exec`. `apply-changeset` is a host function declared `interactive: false, readOnly: false, memoizable: true`; the other two are memoizable pure functions. Callers load the workflows with `@declarative-ai/hw` `loadBundle`.
- Boundary: renderer and main. The renderer derives decisions from what the reviewer did; main re-checks them with `checkDecisions` before they become a workflow output.

## The changeset lives in the review task's record, and the files it describes live on disk

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| A `Changeset` | produced by the producers and `reviseChangeset`; read back by `changesetOf` | the review task's root input, pinned in the gate's operation record request | [component-contracts](component-contracts.md) checks decisions against it; the renderer draws it |
| `ChangeDecision[]` | derived by `deriveDecisions`; checked by `checkDecisions`; read by `apply-changeset` and `changeset-review-status` | the gate's recorded result | [interaction-gateway](interaction-gateway.md) re-validates it at submit |
| Workspace files | read for `before`, `after` and drift; written by `apply-changeset` | the filesystem | agents in a worktree, editor saves, sync proposals |
| `nextChangeId` in `changesets.ts` | reset by each producer call and incremented by every producer's id closure | process memory | every producer running in the process |

## The invariants keep every change decided, every source addressable, and every write checked against what the reviewer saw

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A source that names no recognised scheme is refused, never guessed | `changeset.test.ts` "round-trips the three schemes", "refuses anything unrecognised rather than guessing (REFERENCES.md §1's rule)" |
| 2 | A changeset with a repeated change id is refused | `changeset.test.ts` `"reads a changeset back and refuses a duplicate change id — decisions anchor to it"` |
| 3 | An answer that leaves a change undecided, decides an unknown change, or puts content on `denied` or `reverted` is refused | `changeset.test.ts` `"requires EVERY change decided — the gate returns every change it was given"`, "refuses a decision about a change that was never proposed", `"refuses content on a change that is not being kept — there is nothing left to hold it"` |
| 4 | No change is applied on a round where any change or the review itself carries a comment | `changeset.test.ts` `"applies everything when nobody said anything — untouched means approved, and approved means merged"`, "holds the WHOLE set back the moment one change is commented on", "treats a review-level comment as a comment on everything" |
| 5 | An X'd change stays refused on a comment round and carries no edit | `changeset.test.ts` "keeps an X refused on a round that is only being commented on", `"drops an edit on a change that was X'd out — there is nothing left to edit"` |
| 6 | A round reads as settled only when every decision is `merged` or `reverted` | `changeset.test.ts` "is settled only when every decision was applied" |
| 7 | Against a base tree only `merged` writes; against a proposal tree `reverted` rolls back and `merged` writes unconditionally; delete and rename are taken whole | `changeset.test.ts` "against a tree at the BASE (a sync's proposal), merged writes and everything else leaves it", "against a tree already holding the PROPOSAL (a worktree), reverted rolls back and merged applies", `"merged applies UNCONDITIONALLY (§4.1's files column) — a revised proposal reaches a stale worktree"`, "applies a merged delete and a merged rename as file operations, taken whole (§1.3)" |
| 8 | Applying a subset of structural hunks lands only those and keeps untouched text as authored; applying every text hunk reproduces `after` exactly | `diffStrategies.test.ts` "applies ALL hunks format-preservingly: untouched text keeps its authored spelling", "applies a SUBSET: the accepted change lands, the rejected one does not", "yields line hunks whose full application reproduces the after text exactly" |
| 9 | A worktree changeset pins a resolved commit, and a base that does not resolve is refused | `changesets.test.ts` "pins the source to the base commit and reads before from it, after from the tree", `"refuses a base that does not resolve — the source must be a pin, not a guess"` |
| 10 | A whole-file proposal's action comes from the tree, and its source hash changes when the tree does | `changesets.test.ts` "believes the tree over the claim: an 'update' of a missing file is a create", "two runs over an unchanged tree hash identically; a moved tree hashes differently" |
| 11 | `apply-changeset` under `verify` writes nothing when a file a decision touches has moved, and a moved file no decision touches does not block it | `changesetGate.test.ts` "refuses to apply over a tree that moved while the review was pending (§3.2)", "a drifted file the decisions LEAVE ALONE does not block the rest (§3.2's check is per touch)" |
| 12 | An unsettled round never applies: the single round ends, the loop revises and re-reviews, a failed `respond` fails the round, and running out of rounds fails the run | `changesetGate.test.ts` "a round with comments terminates WITHOUT applying, carrying them for the next round (§3.3)", `"carries the revised changeset into round two — the model answered, the gate re-reviews, apply writes it"`, `"a failed respond FAILS the round — never a silent restart from the input"`, "fails loudly when the rounds run out with comments still open, rather than applying anyway" |
| 13 | A revised changeset keeps its ids, its `before` side and its source | `changesetGate.test.ts` "keeps ids and the before side stable, re-derives hunks, and adds unknown paths as creates" |
| 14 | A patch keeps its own line numbers, and a dialect other than unified diff parses to nothing | `unifiedDiff.test.ts` "keeps the file's own line numbers rather than counting from one", "comes back empty for a dialect it does not know" |
| 15 | A worktree changeset never includes a path under `.jaira/` | unasserted |
| 16 | `apply-changeset` never writes a path outside the workspace root | unasserted |
| 17 | With no workspace or with `dryRun`, `apply-changeset` writes nothing and answers the writes it would make | unasserted |

## The failure modes leave files as far as the writes got, and each names what moved

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Two producers run at once in one process | the second call resets `nextChangeId` while the first is still drawing ids, so the first changeset can repeat an id, which `changesetOf` then refuses wherever it reads it | start the review again | the review fails with `is not unique` |
| A file is mid-write when a producer reads it | the changeset carries the partial content | a later apply under `verify` refuses once the file settles; review again | the reviewer shows the partial file |
| Another writer changes a touched file between the drift check and the write | the write overwrites it; nothing locks the file | none | the other writer's edit is gone |
| A write throws, or the process dies, partway through `apply-changeset` | writes run in order with no rollback, so earlier files are already changed | review the tree again | the apply state fails and the tree is half applied |
| A changeset path escapes the workspace root | refused with `'<path>' escapes the workspace root` when that write is reached, after earlier writes landed | none | the apply state fails with that reason |
| A touched file moved while the review was pending, under `verify` | refused with `the tree moved while the review was pending (<paths>)`, nothing written | review again | the apply state fails naming the paths |
| The looping review applies | `apply` runs with `verify: false` for every caller, including a sync review against a layer root | none | merged files overwrite what the tree holds, moved or not |
| A reviewer writes only a review-level comment | every change is `approved`, so the single round ends successfully with nothing applied, and the loop's `respond` state receives `decisions` and per-change `comments`, neither of which carries that comment | comment on a change instead | nothing is applied and the model never sees the comment |
| `changeset-revise` gets an edit for an `unshowable` change's path | the change is kept and the edit is appended as a second `create` on the same path | none | the next round shows two changes for one path |
| `apply-changeset` gets a `tree` other than `"base"` | it is read as `"proposal"` | none | a `reverted` decision rolls the file back |
| A retry applies the same decisions twice | `merged` writes are idempotent; a second single-round apply refuses on drift for files it already reverted | none needed | the retry fails naming the reverted files |

## Three numbers bound a review's rounds and a diff's cost

- `changeset/review` declares `limits.max_iterations: 5`, in `changesetReviewFiles`.
- `changeset/review-loop` takes `maxRounds`, default 5, and declares `limits.max_iterations: maxRounds * 3 + 2`, in `changesetReviewLoopFiles`.
- The line differ runs with `maxComputationTimeMs: 5000`, in `diffStrategies.ts`.

## The unit departs from the usual way in three places, each for a stated reason

- `changeset-review-status` is a registered function standing in for a guard over the decision list, because guard expressions cannot iterate a list.
- The looping review applies with `verify: false`, because after a revise round the changeset holds content the tree never held and the drift check would refuse the loop's own work.
- A patch parses to `PatchFile[]` rather than to a `Change`, because a patch carries neither side of a file and a fabricated `after` would truncate the file on merge.
