---
id: engineering/units/module-approvals
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/only-approved-code-runs, ux/patterns/consent-to-exactly-what-was-shown, ui/surfaces/module-approval-dialog]
layer: service
owns_contracts: [engineering/contracts/refusal-errors]
requires: [engineering/units/project-store, engineering/units/project-layout]
implemented_by: [packages/persistence/src/userModules.ts, packages/persistence/src/machineKey.ts, packages/runtime/src/userFunctions.ts, packages/shared/src/refusal.ts]
verified_by: [packages/persistence/test/userModules.test.ts, packages/persistence/test/moduleApproval.test.ts, packages/persistence/test/userFunctionRefs.test.ts, packages/cli/test/moduleApproval.test.ts]
siblings: [engineering/units/task-lifecycle, engineering/units/workflow-browser, engineering/units/cli, engineering/units/secret-chain]
---

# Module approvals

## The unit keeps a signed, machine-wide record of which js/ts module files may run, and freezes a run to them

- `approvalsIn(paths)` opens the store over the shared root's database. A `module_approvals` row is `path`, `hash`, `mac` and `approved_at`, where `mac` is HMAC-SHA256 over the path, a NUL byte and the hash, keyed by the machine key. `approved(file)` answers the verified hash or `undefined`; a row that does not verify counts as unapproved and is listed by `unverified()`. Every path is canonical through `canonicalModulePath`: absolute and forward-slashed.
- `machineKey(file)` reads or creates `system/machine.key`: 32 random bytes stored as `dpapi:<base64>` on Windows through a PowerShell `ProtectedData` call that passes the secret in the `JAIRA_KEY_IO` environment variable, or as `plain:<hex>` elsewhere and wherever wrapping fails. A bare-hex file reads as `plain`, and a `plain` key is re-wrapped in place with the same bytes where the platform can wrap it. A key is read once per process per path.
- `prepareUserModules(paths, {searchPath, rebuild})` builds the process's one `UserModules`: a symbol index that admits a file only when its verified approved hash equals its hash now, an ungated `openSymbols` for diagnosis, `userFunctions`, the store, the require path and a fresh vfs. It returns the existing pair unless `rebuild` is set, which closes the old store first.
- `trustingBuiltIn(approvals, builtInDir, vfs)` wraps that store for the pair, and is the one exemption: for a file `isBuiltInModule` places under the built-in layer `$SYSTEM` ([project-layout](project-layout.md), [decision 0006](../decisions/0006-built-in-layer.md)) `approved(file)` answers the file's current hash, so the index, the pending walk and the freeze all admit it and an app upgrade asks nobody. The test is location alone: a person's copy of a shipped module is another path and is gated. `all()` and `unverified()` still describe only what a person approved.
- `watchingForUnapproved(modules)` wraps one load's index and reports each symbol the gate withheld that the ungated index can place, so an unapproved module is reported as a file to approve rather than a typo.
- `moduleApprovalsFor(modules, entries, withheld)` lists everything a person must agree to, imports included, as `ModuleApproval`; `withheldApprovalsOf` is its synchronous form for lint, blind to imports.
- `freezeForRun(modules, entries)` freezes every reachable module through upstream `freezeModules`, which throws before anything executes when one is unapproved or changed.
- `userFunctionRefsOf`, `moduleEntriesOf` and `resolveUserFunctions` read a bundle's `user:` references and resolve each into the facade. Runtime `registerUserFunctions` merges `UserFunctions.entries` into a run's registry, and `prepareUserFunctions` compiles them.
- `ApprovalRequired`, `approvalRefusalMessage` and `approveCommandFor` in `@jaira/shared` `refusal.ts` are the refusal a host can answer: [refusal-errors](../contracts/refusal-errors.md).

It deliberately does not own:

- Hashing, the closure walk, which files need no approval such as vendored `node_modules`, compiling and the snapshot's module digest: upstream `@declarative-ai/hw` `moduleHash`, `pendingApprovals`, `freezeModules`, `createSymbolIndex` and `createUserFunctions`.
- When a start asks: `beginTaskRun` in [task-lifecycle](task-lifecycle.md) raises `ApprovalRequired` before it validates, snapshots or pins anything.
- Putting the question to a person: the app's `functions:pending` and `functions:approve` in [task-channels](../contracts/task-channels.md), and the CLI's `beginTaskRunAsking` and `jaira functions` commands in [cli](cli.md).
- Reporting files to approve in lint: [workflow-browser](workflow-browser.md).

## The store is service code in the persistence package that answers hw's approval seams from the shared root

- Layer `service`, package `@jaira/persistence`, with the registry merge in `@jaira/runtime` `userFunctions.ts`. It calls `openDb`, `node:crypto`, `node:child_process` for PowerShell, and hw.
- Upstream seams: `ModuleIndexOptions.approved(file)` on `createSymbolIndex`, and `ApprovalStore.approved(file)` as `DiscoverOptions.approvals` for `pendingApprovals` and `freezeModules`.
- Boundary: derived and committed. The store and the key are machine-local; the `.gitignore` JaiRA writes hides `system/jaira.db` and `system/machine.key`.
- Callers: the app when it opens a project and after `functions:approve` with `rebuild`, every CLI command that opens a project through `openWithRecoveryNote`, and `beginTaskRunAsking` with `rebuild` after a yes. `workflowLoadOptions` reads the pair synchronously for every load.

## An approval is true only as the row and the key together, and the pair lives in memory

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `module_approvals` in `<base>/system/jaira.db`: `path` primary key, `hash`, `mac`, `approved_at` | upserted by `approve`, deleted by `revoke`; verified afresh on every `approved`, `all` and `unverified` call | the row together with the key | `jaira functions`, `beginTaskRunAsking`, the app's `functionsApprove` |
| `<base>/system/machine.key` | created on first need with flag `wx`; rewritten with flag `w` when a `plain` key is wrapped | the file | nothing else |
| The process's `UserModules` pair | built once per process, replaced on `rebuild` | this process | `beginTaskRun`, `workflowLoadOptions` and lint read it through `userModules()` |

## The invariants hold that no file runs unless this machine's key signed its path and its exact bytes

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A start that reaches a module with no approval is refused with `ApprovalRequired` naming the file and the symbol, before anything is pinned, and starts once the file is approved | `moduleApproval.test.ts` "raises an answerable refusal naming the file and the symbol, not a parse error", `"leaves the task startable — the refusal comes before anything is pinned"`, "starts once the file is approved, so the answer is all that was missing" |
| 2 | An approval written by one process verifies in another, and two spellings of one path are one approval | `userModules.test.ts` "round-trips an approval through the database, so a second process sees it", "keys on the canonical path, so two spellings of one file are one approval" |
| 3 | A row not signed by this machine's key, a real row moved to another path, and a real row with an edited hash are not approvals, and an unsigned row is reported by `unverified` | `userModules.test.ts` "is not an approval, however well-formed the row is", "is reported as unverified rather than swallowed, so a UI can say so", "cannot be made by moving a REAL approval onto another path", "cannot be made by editing the hash under a real path" |
| 4 | An approval covers the approved bytes at the approved path, and neither edited bytes nor the same bytes at another path | `userModules.test.ts` "refuses content that is not what was approved", "cannot be satisfied by a second file with the same contents at another path" |
| 5 | An approved file edited since is asked about as changed, with `previousHash`, and a name no module declares is never an approval question | `moduleApproval.test.ts` "asks again after the file changes, and says it CHANGED rather than that it is unknown", "does NOT ask about a name no module declares" |
| 6 | The key survives a restart, is wrapped where the platform can wrap it, keeps its bytes when re-wrapped, and a malformed key or unknown scheme is refused, never replaced | `userModules.test.ts` "is generated on first use and reused after, so approvals survive a restart", "wraps with the platform's own protection where there is one", "upgrades a plaintext key in place, keeping the bytes so approvals stay valid", "refuses to run on a key that is not a key, rather than minting a new one", "refuses an unknown scheme rather than guessing at the bytes" |
| 7 | The legacy file is imported and signed once, never over a table with rows, and a corrupt one approves nothing | `userModules.test.ts` "imports what the old file approved, once, and signs it on the way in", "does not import again over a store somebody has since revoked from", "treats a CORRUPT old file as an empty one, never as a permissive one" |
| 8 | An embedded function body is never a file to approve | `userModules.test.ts` "excludes an EMBEDDED body, which has no file to hash and needs none" |
| 9 | A task pinned to a snapshot resolves its module functions into the facade before the registry merge, and resolving twice is harmless | `userFunctionRefs.test.ts` "fills the facade a snapshot start left empty, and the entry is then preparable", "is idempotent over a load that already resolved" |
| 10 | The CLI with nobody to ask refuses and prints the approve command, and approves before starting on a yes or `--approve-functions` | `cli/test/moduleApproval.test.ts` "refuses and prints the command that answers it", "approves and starts when the answer is yes", "approves without asking, and says which files it approved" |
| 11 | The app rebuilds the pair after `functions:approve`, before the retried start loads | unasserted |

## A lost or foreign key forgets every approval, and a process that did not rebuild answers from an old index

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The key is wrapped for another Windows account, or its file is damaged | every check that needs the key throws `the machine key at <file> could not be unwrapped ... Delete the file to start over, which forgets every approval on this machine.` | delete the key file and approve again | a start that reaches a module fails with that message |
| The process is killed while writing the key file | the `wx` create or the `w` re-wrap can leave an empty or partial file, which is refused as empty, as not 32 bytes of hex, or as failing to unwrap | delete the key file; every approval is forgotten | a start that reaches a module fails naming the key file |
| Two processes create the key at once | `wx` lets one create it; the other gets `EEXIST` and reads the winner's file | none needed | none |
| Two processes approve or revoke | SQLite serializes the writes, and the store reads the table afresh on every call | none needed | none |
| Another process approves a file after this process indexed its directory | the gated index cached the directory without the file, so the load fails, while the store finds nothing pending and raises no `ApprovalRequired` | approve through this process, which rebuilds, or restart it | the start fails with the loader's error about an unknown symbol |
| A module file changes between the app's approval dialog and the approve click | `functionsApprove` hashes the file as it reads it at the click and approves those bytes | none | the task starts on code the dialog did not show |
| `jaira functions approve --all` is given no file | nothing is approved and it prints `approved 0 file(s)` | name the files | the next start is refused again |
| An approval is written twice for one path | the upsert on `path` replaces the hash and the MAC | none needed | none |
| A revoked row is restored from a backup of the database | it verifies again, since each MAC covers one row and not the table | none | the file runs without being asked about |
| A process running as the same user reads the key | it can sign rows that verify | none | none |
| PowerShell is missing or refuses | the key is created or kept as `plain:<hex>` | none needed | none |

## The legacy approvals file is imported once and the key is upgraded in place, and neither rolls back

- A bare-hex key file reads as `plain`. A `plain` key is rewritten as `dpapi` with the same bytes, so every existing row still verifies; the rewritten file cannot be unwrapped by another Windows account.
- `module_approvals` is declared in the base schema in `db.ts`, so every JaiRA database has the table and only the shared root's is read.

## The key and its unwrapping have fixed costs set in the key module

- Key length: 32 bytes, `KEY_BYTES` in `machineKey.ts`.
- One PowerShell call per wrap or unwrap, with a 15 000 ms timeout in `powershell` in `machineKey.ts`, made at most once per key file per process.

## The unit departs from per-project storage and from the app's native secret store

- The trust store lives in the shared root's database rather than a project's, because an approval is keyed by absolute path and covers every project on the disk.
- The key is wrapped through a PowerShell subprocess rather than Electron `safeStorage`, so the CLI and the app read the same key.
- The symbol index is built once per process and read synchronously, because the loader behind every view is synchronous; a process sees another process's approval in its index only after a rebuild.
