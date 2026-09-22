---
id: engineering/units/artifact-placement
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/read-what-work-produced, ui/components/produced-artifacts]
layer: core
owns_contracts: [engineering/contracts/artifact-destination-template]
requires: [engineering/units/storage-policy, engineering/units/project-layout]
implemented_by: [packages/runtime/src/artifactPath.ts, packages/runtime/src/artifacts.ts, packages/runtime/src/artifactSink.ts, packages/persistence/src/artifactStore.ts]
verified_by: [packages/runtime/test/artifactPath.test.ts, packages/runtime/test/artifactSink.test.ts, packages/persistence/test/artifactStore.test.ts, packages/cli/test/artifacts.e2e.test.ts]
siblings: [engineering/units/host-tools, engineering/units/uri-and-artifact-reads, engineering/units/storage-policy, engineering/units/task-lifecycle]
---

# Artifact placement

## The unit decides where artifact bytes land and keeps the map from the path a producer named to where they went

- `artifactPath.ts`: `parseDestination(source)` reads the scheme, expands the `$DEFAULT`, `$CENTRAL` and `$CENTRAL_FLAT` aliases, and refuses an unknown scheme, an unknown variable and an empty template with `DestinationError`. `resolveDestination(destination, vars, logicalPath)` substitutes the variables in the path view `vars` carries, confines the root to its anchor unless the template is absolute, and refuses a resolved path outside that root rather than clamping it. `withinWorkspace(root, logicalPath)` joins a path onto a root, or answers `undefined` for one that climbs out. The grammar is [artifact-destination-template](../contracts/artifact-destination-template.md).
- `artifacts.ts`: `ArtifactRecord`, the `ArtifactStore` interface whose `put` replaces any record for the same task and logical path, and `MemoryArtifactStore`.
- `artifactSink.ts`: `artifactWiring(input)` parses `artifacts.destination` and assembles the variables for one run or one conversation turn. `persistEngineArtifacts(outputs, options)` walks a finished run's root outputs for the engine's blob references that carry inline content, derives the logical path `<slot>.<ext>` and the state, instance and slot from the reference's name, writes and records each, and reports a failure through `onError` instead of throwing.
- `artifactStore.ts` in `@jaira/persistence`: `SqliteArtifactStore` upserts on `(task_id, logical_path)`, stores `interactive` as 0 or 1 and reads back only `true`, and appends the re-read row to the task's row file when `storage.artifacts` is file-backed.

It deliberately does not own:

- Parsing and defaulting the `artifacts` block: [project-config](project-config.md), with the shape in [settings-json](../contracts/settings-json.md).
- The tools that write and read through the map: [host-tools](host-tools.md). Whether a producing call may run and when a large payload asks: [tool-policy](tool-policy.md).
- Listing and serving artifacts and reading `artifact://` URIs: [uri-and-artifact-reads](uri-and-artifact-reads.md).
- The row file format and its replay: [storage-policy](storage-policy.md) and [storage-files](../contracts/storage-files.md). The table's columns and migrations: [sqlite-schema](../contracts/sqlite-schema.md).
- Deleting rows: `deleteTask` in [task-lifecycle](task-lifecycle.md) removes a task's rows and row file and leaves the bytes; [history-pruning](history-pruning.md) leaves both.
- Naming a blob reference: upstream `@declarative-ai/hw`.

## The unit is core logic under an interface the persistence package implements, and places returned blobs after the run

- Layer `core`, package `@jaira/runtime`, with its durable store in `@jaira/persistence`. `artifactPath.ts` imports `SYSTEM_DIR_NAME` from [project-layout](project-layout.md); `SqliteArtifactStore` calls `RowLog.appendFrom` from [storage-policy](storage-policy.md).
- Upstream seam: the engine's inline reference for a blob output slot, `{artifact: true, name: "<state.dotted>#<instanceId>.<slot>", format?, content?}`, read structurally by `isEngineArtifact`.
- Boundaries: derived and committed, because `$DEFAULT` writes the person's work tree while `$CENTRAL` and `$CENTRAL_FLAT` write under `system/<dir>/<taskId>/`, which [jaira-layout](../contracts/jaira-layout.md) keeps committable; Windows and WSL, because substitution happens at resolve time in whichever path view the caller passes, and the app and the CLI pass host paths.
- Callers: app `startRun` and `runChatMessage` call `artifactWiring` and hand the result to the file tools; app `startRun` and CLI `runTaskNow` call `persistEngineArtifacts` once `executeWorkflow` resolves and before `finishTaskRun`. `withinWorkspace` is also called by the file and search tools, `changesetGate.ts`, file reads in `service.ts` and CLI changeset review.

## The artifact map is the truth for where a logical path went, and the filesystem for what it holds

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `artifacts.destination`, `artifacts.dir`, `artifacts.inlineMaxBytes` | read by `artifactWiring` at each run start and each turn | layered `settings.json`, defaults `$DEFAULT`, `artifacts` and 65536 | project-config checks only that the destination is a non-empty string |
| `artifacts` rows | `put` upserts, `get` and `list` read | the project database, or `system/artifactRows/<taskId>.jsonl` when `storage.artifacts` is file-backed | host-tools puts and gets; uri-and-artifact-reads lists and serves; task-lifecycle deletes |
| Bytes at `$WORKTREE/<logical path>` under `$DEFAULT` | written | the filesystem, as the person's work | git, agents and the person |
| Bytes under `<project>/.jaira/system/<dir>/<taskId>/` under `$CENTRAL` and `$CENTRAL_FLAT` | written | the filesystem | uri-and-artifact-reads serves them |

## The invariants keep a producer's path inside what the author fixed and one record per path

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An unknown scheme or variable is refused and never substituted as nothing, and a drive letter is never read as a scheme | `artifactPath.test.ts` "rejects a scheme it does not implement", "does not mistake a Windows drive letter for a scheme", "rejects an unknown variable instead of substituting nothing", "names the known variables in the error, including aliases" |
| 2 | A producer's path never resolves outside the author-fixed prefix, and is refused rather than clamped | `artifactPath.test.ts` "refuses an agent-supplied path that escapes the root", "refuses rather than clamping, so nothing is written somewhere unnamed", "confines to the AUTHOR-FIXED prefix, not merely to the worktree", "takes the root to the last directory boundary, so a derived filename still works" |
| 3 | A configured value never moves a relative template's root outside its anchor | `artifactPath.test.ts` "refuses a CONFIG value that climbs out of the anchor", "confines to the anchor the template actually names", `"allows an explicitly absolute destination — that is a choice, not a typo"` |
| 4 | A path resolves in the view it is handed, and an id never adds a directory | `artifactPath.test.ts` "resolves in whatever path view it is handed (the WSL case)", "keeps $RELPATH's directories but flattens ids into one segment" |
| 5 | Every returned blob with inline content is placed and recorded, `virtual:` records it without writing, and an unwritable one is reported without failing the rest | `artifactSink.test.ts` "writes each artifact to the configured destination and records it", "writes nothing under virtual: but still records the content", "uses the instance and slot the name carries, so $CENTRAL_FLAT works", "reports an unwritable artifact instead of throwing" |
| 6 | A change to `artifacts.destination` alone moves where a run's blobs land, and an unknown variable refuses the run | `artifacts.e2e.test.ts` "moves to the central directory on a config change alone", "derives the filename under $CENTRAL_FLAT", "refuses an unknown variable at run time rather than writing somewhere odd" |
| 7 | A task holds one record per logical path, a rewrite replaces it, and every field round-trips | `artifactStore.test.ts` "round-trips every field", "replaces on rewrite, so a read resolves to the latest", "keeps a virtual artifact's content with no physical path", "keeps a large artifact's location with no inline copy" |
| 8 | A record is visible only to its task and resolves after a reopen | `artifactStore.test.ts` "scopes to a task and returns nothing for an unknown path", `"survives a reopen — the point of the table"`, "resolves a logical path written in an earlier session" |

## Collisions and late placement lose artifacts quietly, and a bad template strands the start

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| `artifacts.destination` does not parse | the settings save and the project opens; `artifactWiring` throws `DestinationError` after `beginTaskRun` marked the task running, or before a conversation turn starts | fix the template; the next open marks the task `interrupted` | the start or send is refused with the message, and the task reads running until the next open |
| Two states return blobs under one slot name | both get the logical path `<slot>.<ext>`: the later record replaces the earlier under every destination, and the later file overwrites the earlier under `$DEFAULT` and `$CENTRAL` | `$CENTRAL_FLAT` keeps both files | the list shows the last one |
| A returned blob's `<slot>.<ext>` matches a file in the work tree under `$DEFAULT` | the file is overwritten | none | a workspace file replaced by the blob |
| `write_file` or `edit` runs under `$CENTRAL_FLAT` | the tools pass no instance, state or slot, so every write resolves to `<taskId>/-.<ext>` and writes with one extension share one file, while each logical path keeps its own record | use `$CENTRAL` | a file over the inline limit reads back as the last write with its extension |
| A blob is returned by a state whose output never reaches the root's outputs | only the result's root outputs are walked | bind it to a root output | the blob is never placed or listed |
| An artifact cannot be written | the app pushes an `artifact.failed` `engine:event` that is never journaled, and the CLI prints a warning; the run's status is unchanged | fix the destination and run again | the run completes without that artifact |
| The process is killed during `persistEngineArtifacts` | it runs before `finishTaskRun`, so what it placed keeps its rows and the rest is never placed | none for the unplaced blobs; the next open marks the task `interrupted` | the task reads interrupted and its list lacks those artifacts |
| The process is killed after an upsert and before the row-file append | the row lived only in the shadow table, as [storage-policy](storage-policy.md) states for every file-backed store | none | the record is one state behind after reopen |
| A symlink inside the root points outside it | containment compares paths lexically and resolves no link | none | the bytes land outside the root |
| Two producers write one task's map at once | `put` is synchronous and the upsert keeps the last; one task is driven by one process | none needed | the latest record |
| A placement is retried | the upsert replaces the row and the same bytes are rewritten | none needed | one record |

## Old rows read as static and legacy spellings still resolve, and nothing rolls back

- Migration 6 added `artifacts.interactive` with default 0, so a row written before it reads as not scriptable.
- Migration 12 did not rebuild `artifacts.instance_id`; a legacy numeric value is read through `String`.

## Placement keeps three small numbers in code

- The inline copy is kept up to `artifacts.inlineMaxBytes`, default 65536: `DEFAULT_INLINE_MAX_BYTES` in `packages/shared/src/config.ts`, and `DEFAULT_INLINE_MAX` in `artifactSink.ts` when a caller passes none.
- Alias expansion stops after 4 passes, in `parseDestination`.
- An extension taken from a media type's tail is 1 to 8 alphanumerics, in `extensionFor`.

## Placement departs from the usual flow in three places, each for a stated reason

- Returned blobs are placed by walking the run's result after it ends, because the engine records a blob reference inline and writes no file.
- `@jaira/persistence` imports the runtime's `ArtifactRecord` and `ArtifactStore` types, the reverse of the layer order, so that the runtime never imports persistence.
- Variables are substituted when a path is resolved rather than when the template is parsed, so the caller chooses the host or distro path view.
