---
id: engineering/units/workflow-authoring
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/author-processes-without-memorising-the-format, product/share-processes-across-projects, ux/patterns/name-it-where-it-will-live, ux/patterns/pick-from-what-exists, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/refuse-with-the-reason-and-the-fix, ui/surfaces/files-view, ui/surfaces/confirm-dialog, ui/components/file-tree, ui/components/file-panel, ui/components/folder-view, ui/components/workflow-editor, ui/components/composer, ui/components/review-notes]
layer: service
owns_contracts: []
requires: [engineering/units/project-sessions, engineering/units/workflow-browser, engineering/units/files-view-models, engineering/units/description-sync, engineering/units/git-cli, engineering/units/document-types, engineering/units/app-log]
implemented_by: [packages/app/src/main/service.ts]
verified_by: [packages/app/test/settings.test.ts, packages/app/test/shell.test.ts, packages/app/test/fileIo.test.ts, packages/app/test/chatConversation.test.ts]
siblings: [engineering/units/files-view-models, engineering/units/workflow-browser, engineering/units/description-sync, engineering/units/ts-language-service, engineering/units/uri-and-artifact-reads]
---

# Workflow authoring

## The unit reads and changes authored files inside a layer root, and refuses a change that would break a state naming them

The authoring methods of `AppService` in `service.ts`:

- By state id: `readWorkflow`, `writeWorkflow` which refuses text that is not JSON, `moveWorkflow` which renames, duplicates with `copy`, or overrides into the other layer, and `deleteWorkflow`.
- By path: `readFile` which refuses a type that is not text and a directory, `writeFile` which refuses a `.json` file under `workflows/` so a state is always parsed first, `createFile` for a file or a directory, `renameFile` and `deleteFile`, which take a whole directory.
- The referrer checks. `moveWorkflow` when the id changes and `deleteWorkflow` read `referencedBy` from the project's resolved graph through `referrersOf`. `renameFile` and `deleteFile` collect the state ids under the path with `statesUnder` and ask `brokenBy`, which reads each state's authored `children` so a child named by key or `./` that moves with its declarer is not counted. A refused change returns `applied: false` with the referrers, and `force: true` applies it. The two checks read different things, so `workflow:delete` and `file:delete` of the same file can disagree.
- `findFiles`, the composer's `@` picker: a breadth-first walk of the checkout matching by subsequence.
- `gitIdentity`, the name a review note is signed with: the project repository's `git config` identity, then the global one from the home directory, cached per project directory for the process.
- `revealFile`, which hands the path to the host's `reveal` option unchecked.

Every applied write, create, move, rename and delete publishes `store:invalidate` with scope `workflows`. `writeWorkflow` and `writeFile` also call `noteSyncWrite`.

It deliberately does not own:

- Lint, roots and the tolerant browse: [workflow-browser](workflow-browser.md). The tree and `stateView` it reads referrers from: [files-view-models](files-view-models.md).
- Baselines, proposals and what `noteSyncWrite` settles: [description-sync](description-sync.md).
- Unsaved edits: [drafts](drafts.md). Type checking: [ts-language-service](ts-language-service.md). Reads by URI: [uri-and-artifact-reads](uri-and-artifact-reads.md).
- Which session a `project` names, and the watchers that re-lint after a write: [project-sessions](project-sessions.md).
- The channel shapes: [ipc-channels](../contracts/ipc-channels.md).

## The unit is main-process code on the renderer boundary, and every id and path it takes is untrusted

- Layer `service`, in `packages/app/src/main`. It calls `node:fs`, `browseWorkflows` and `stateView` from `@jaira/persistence`, `gitFor` and `Git` from [git-cli](git-cli.md), `mimeOfPath` and `isTextMime` from [document-types](document-types.md), and `refusal`, which logs through [app-log](app-log.md).
- No upstream seam.
- Boundary: renderer and main. Channels `workflow:read`, `workflow:write`, `workflow:move`, `workflow:delete`, `file:read`, `file:write`, `file:create`, `file:rename`, `file:delete`, `file:find`, `git:identity` and `shell:reveal`. Containment is checked in main on the resolved path, never on the input.
- Three resolvers, each refusing with a `Refusal`:

| Resolver | Root for `base` | Root for `project` | Callers |
| --- | --- | --- | --- |
| `workflowFile(stateId, layer, project)` | `~/.jaira/workflows` | `.jaira/workflows` | the id channels; appends `.json` |
| `treeFile(path, layer, project)` | `~/.jaira` | the checkout | the path channels, addressed as the Files view draws them |
| `layerFile(path, layer, project)` | `~/.jaira` | `.jaira` | [description-sync](description-sync.md) |

- `treeFile` and `layerFile` share `contained(root, path, layer)`, which [ts-language-service](ts-language-service.md) also calls with a worktree root. `layerPathOf` turns a checkout path `.jaira/<rest>` into `<rest>`, which is what `mimeOfPath`, `stateIdOf` and the sync key read.
- One `project` names both ends of `moveWorkflow`, so a move between layers resolves the project layer through it.

## The files are the truth, and the unit keeps only an identity cache

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| State files `workflows/<id>.json` under each layer root | read, written, moved and deleted by id | the files | [workflow-browser](workflow-browser.md) reads them per browse; [description-sync](description-sync.md) writes accepted proposals |
| Any file or directory under the checkout or `~/.jaira` | read, written, created, renamed and deleted by path | the files | agents, git and editors outside the app |
| Referrers | read per rename or delete, from `stateView(...).referencedBy` or from authored `children` | the state files | [files-view-models](files-view-models.md) |
| `identities`, keyed by project directory or `~` | set once per key per process | `git config` | none |

## The invariants keep every write inside its root and every referrer resolvable unless forced

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A state id that climbs out of `workflows/`, is absolute, or names another drive never reaches the disk | `settings.test.ts` "refuses a state id that escapes its root", "refuses an absolute state id", "refuses a state id on another drive"; `shell.test.ts` "refuses a destination outside the layer's root" |
| 2 | A path that climbs out of its root with `..`, or names the root itself, is refused by every path-addressed read, write, create, rename and delete | `fileIo.test.ts` "refuses a path that climbs out of the layer root", "refuses a path outside the layer root"; `shell.test.ts` "refuses to clobber, and refuses to escape the layer root", "keeps a path-addressed rename and delete inside the layer root" |
| 3 | No state file is written through `workflow:write` unless its text parses as JSON | `settings.test.ts` "refuses text that is not JSON, rather than writing a file that breaks the browser" |
| 4 | `file:write` never writes a `.json` file under `workflows/`, even when its text parses, and writes a YAML state as text | `fileIo.test.ts` "refuses a state file, which must go through workflow:write to be parsed", "still refuses a state file when the text would have parsed", "writes a YAML state as text, because the authoring form cannot save one" |
| 5 | A read never decodes a type that is not text or a directory, and a missing file reads as empty with `exists: false` | `fileIo.test.ts` "refuses a type that is not text instead of decoding it as UTF-8", "refuses to read a directory", "reports a file that does not exist yet rather than throwing"; `settings.test.ts` "reads a state that does not exist yet as empty, so it can be created" |
| 6 | Without `force`, no rename or delete leaves a state declaring a child that is gone, and nothing moves when refused | `shell.test.ts` "refuses a rename that would break the states naming it, and says which", "refuses to delete a state something still declares as a child", "refuses a directory rename that leaves an absolute reference naming the old id", "refuses to move a children directory out from under the state that declares it", "refuses to delete a directory something outside it still declares as a child" |
| 7 | A directory whose states name each other by key moves or is deleted without a refusal | `shell.test.ts` "renames a whole workflow directory, because its states name each other relatively", "deletes a self-contained workflow directory, because nothing is left pointing at it" |
| 8 | A duplicate or an override is never refused for referrers and leaves its source in place | `shell.test.ts` "duplicates without touching the original, and without asking about references", "overrides a shared state into the project under the same id" |
| 9 | No create, move or rename replaces an existing path, and no directory moves into itself | `shell.test.ts` "will not overwrite an existing state, and will not move something that is not there", "will not move a directory into itself, or over something that is already there" |
| 10 | `file:find` never enters a dot-directory or a `FIND_SKIP` name, and returns the shallowest matches first | `chatConversation.test.ts` "matches a path by subsequence, the way a file picker does", "does not walk into the directories nobody means by `@`", `"returns the shallowest matches first — where a person's own files are"` |
| 11 | Every applied change publishes `store:invalidate` with scope `workflows` | unasserted |
| 12 | `git:identity` never throws, and falls back to the global identity when the project has none | unasserted |

## Failures leave the disk as the last writer left it, and the tree shows the result after the next browse

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| A path-addressed request names another drive or a UNC path on Windows | `contained` accepts it, because `relative` answers with the absolute path, which holds no `..`; it lacks the `isAbsolute` check `workflowFile` has. The read, write, create, rename, delete or check acts at that path, and `file:delete` removes a directory there recursively | none | the request succeeds as if the path were inside the root |
| Two writers change one file, such as an agent and the editor | last write wins; no mtime or content check precedes `writeFileSync`, and a referrer added between a check and its rename or delete is not seen | none | the file holds the later text |
| The process is killed mid-write | `writeFileSync` is not atomic and leaves a truncated file | save the file again | the tree marks a state file with a parse error |
| A read lands while another process writes the file | the text read is whatever bytes are there; saving it writes that text back | none | the editor shows a truncated file |
| A create, move, rename or delete is retried | refused with `already exists` or `does not exist`; a retried write rewrites the same text | none needed | an error notice naming the path |
| A referrer does not parse, or is YAML or JSONC | `referrersOf` answers `[]` when the graph cannot be built, and `brokenBy` skips any file `JSON.parse` rejects, so the change applies | none | the referrer shows a lint error at the next browse |
| A base-layer rename or delete runs with zero or several user projects open | the renderer sends no `project` for `base`, `sessionOf()` resolves none, and the change applies unchecked; with one project open only its referrers count | none | the change applies with no warning |
| A shared state is overridden into a project with several projects open | the renderer sends no `project` for a `base` source, and `workflowFile` for the `project` destination refuses with `several projects are open, so this call must name one` | none | an error notice |
| A case-only rename on Windows | `from === to` compares case-sensitively, then `existsSync(to)` finds the source, and the rename is refused | rename through an intermediate name | `already exists` |
| A YAML or JSONC state is addressed by id | `workflowFile` appends `.json`: `workflow:move` and `workflow:delete` refuse with `does not exist`, `workflow:read` answers empty, and `workflow:write` creates a `.json` file beside it | use `file:rename` or `file:delete` | `does not exist` |
| A checkout file outside `.jaira/` has a path `workflows/<name>.json` | `layerPathOf` keeps the path as given, `mimeOfPath` reads it as a state, `file:write` refuses it and `file:read` reports a `stateId` | none | saving is refused naming `workflow:write` |

## Budgets bound the picker's walk and nothing else

- `FIND_VISIT = 20_000` directory entries per `findFiles` call, in `service.ts`; past it `truncated` is true.
- `findFiles` returns at most `limit`, default 30, clamped to 1 through 200. The composer in `chatPane.tsx` asks for 20.
- No read or write has a size cap.

## A state write checks only that its text parses, which is less than the trust boundary usually checks

- `writeWorkflow` validates nothing past `JSON.parse`, so a half-written state stays saveable and the lint surface reports what is wrong with it.
