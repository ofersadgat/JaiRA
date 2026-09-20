---
id: engineering/units/ts-language-service
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/catch-process-mistakes-before-running, product/review-changes-before-they-land, ux/patterns/problems-marked-where-they-are, ui/components/code-editor, ui/components/diff-editor, ui/components/changeset-review]
layer: service
owns_contracts: [engineering/contracts/ts-check-worker-protocol]
requires: [engineering/units/workflow-authoring, engineering/units/project-sessions, engineering/units/task-worktrees]
implemented_by: [packages/app/src/main/tsProject.ts, packages/app/src/main/tsCheck.ts, packages/app/src/main/tsProjectWorker.ts, packages/app/src/main/service.ts, packages/app/build.mjs]
verified_by: [packages/app/test/tsProject.test.ts]
siblings: [engineering/units/workflow-authoring, engineering/units/changesets, engineering/units/module-approvals]
---

# TypeScript language service

## The unit answers what a real compiler says about a file in its own project, and draws none of it

- `TsProjects` in `tsProject.ts` holds one `ts.LanguageService` per `tsconfig.json` found the way `tsc` finds it, with that config's options, `paths` and `node_modules`. It answers `check`, `definitions`, `references`, `hover` and `sourceOf` about the editor's buffer, with every other file read from disk. A file no config covers gets `checked: false` and the syntax errors `syntaxOnly` finds by parsing it alone.
- `TsCheckers` pairs the live `TsProjects` with a second one, `past`, seeded per call from a `baseline` overlay, so the before-side of a diff is checked while the disk holds the after-side.
- `WorkerTypeCheck` in `tsCheck.ts` runs `TsCheckers` in a `worker_threads` worker spawned on first use from `dist/tsProjectWorker.cjs`, and rejects every waiting call when the worker dies.
- The `AppService` methods in `service.ts`: `checkFile`, `defineFile`, `referencesInFile`, `hoverInFile`, `sourceOfFile` and `releaseFile`. `checkRoot` picks the tree, `contained` keeps the path and every baseline path inside it, and `addressOf` gives a found location the `at` the Files view opens it by, only when it lies inside the tree and the request names no task.

Every TypeScript diagnostic the editor draws comes from this unit, syntax included: `monacoDiff.tsx` turns Monaco's own TypeScript validation off.

It deliberately does not own:

- Monaco models, markers, peeks and hovers: the renderer's `fileSurfaces.tsx` and `changesetReview.tsx`.
- Building the before-side from a changeset, `baselineOf` in `@jaira/shared`: [changesets](changesets.md).
- Compiling a workflow's TypeScript functions for a run: [module-approvals](module-approvals.md).
- Path containment itself: `contained` in [workflow-authoring](workflow-authoring.md). Creating a task's worktree: [task-worktrees](task-worktrees.md).

## The unit spans the renderer boundary and a thread boundary, and calls no upstream seam

- Layer `service`, in `packages/app/src/main`. It calls `node:worker_threads`, the `typescript` package through a dynamic import, `contained` and `requireProject` inside `AppService`, and `project.runtime.get(taskId)?.worktreePath`.
- No upstream seam.
- Boundary: renderer and main. Channels `file:check`, `file:definition`, `file:references`, `file:hover`, `file:source` and `file:release`, addressed like `file:read` by `layer`, `project` and `path`, with an optional `taskId`. Shapes are in [ipc-channels](../contracts/ipc-channels.md).
- Boundary: main thread and worker thread, over [ts-check-worker-protocol](../contracts/ts-check-worker-protocol.md). `AppServiceOptions.typeCheck` replaces the worker with any `TypeCheckPort`, and the tests pass `TsCheckers` in process.
- Roots, in `checkRoot`: with no `taskId`, `~/.jaira` for `base` and the checkout for `project`; with a `taskId`, that task's worktree, and a refusal when it has none.
- `build.mjs` bundles the worker beside `main.cjs` with `typescript` external. `AppService.close` closes the checker.

## Everything the unit holds is in memory, and the disk and the editor's buffer are the truth

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| The worker thread | spawned by the first call, `unref`'d, terminated by `close`, forgotten when it dies | process memory | `AppService.close` |
| `TsProjects.projects`, one service per `tsconfig.json` | built on first sight, rebuilt when the config's mtime moves, never evicted | the config file | none |
| `TsProjects.open`, buffer text or an absence with a version counter | held by a call carrying `text` or a baseline; dropped by a call without `text`, by `release` and by a re-seed | the renderer's editor | none |
| `TsProjects.configOf`, directory to config or a miss | set on the first lookup, cleared only by `close` | `ts.findConfigFile` over the disk | none |
| `TsCheckers.past`, the one baseline program | created on the first `baseline`, re-seeded by every call that carries one | the changeset's before-side | [changesets](changesets.md) builds the overlay |
| Sources, `node_modules` and configs | read through `ts.sys`; versioned by mtime, and every `node_modules` file by the constant 0 | the disk | agents, git and package installs |

## The invariants keep every answer about the program the file really compiles in

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An import that resolves under the covering config, `paths` included, produces no diagnostic | `tsProject.test.ts` `"says nothing about an import that resolves — the squiggle that started this"`, "follows the config's own `paths`, which no in-browser program can" |
| 2 | A type error and a syntax error are both reported at their position, and a `.tsx` file parses as TSX | `tsProject.test.ts` "reports a real error, where it is", `"reports a syntax error as well as a type one — the app has no other parser"`, "parses a .tsx file as one, so its tags are not errors" |
| 3 | An answer is about the buffer sent, and a change to another file on disk is seen with nothing invalidated | `tsProject.test.ts` "checks the BUFFER, so an error appears before anything is saved", "reads the BUFFER, so a definition can be followed before anything is saved", "sees an edit made to ANOTHER file on disk, with nothing to invalidate" |
| 4 | A released buffer no longer shadows the file on disk, and an edited config rebuilds its project | `tsProject.test.ts` "releases a buffer, so the file on disk is the truth again", "rebuilds when the config itself changes" |
| 5 | A file its config does not include is still checked, and a file no config covers answers `checked: false` with syntax errors only and never throws | `tsProject.test.ts` "checks a file the config does not include, rather than refusing it", `"says so when no project covers the file — but still parses it"`, "says no project covers a file rather than throwing, so an editor need not catch" |
| 6 | No position question answers without a program, and nothing under the caret answers empty | `tsProject.test.ts` "refuses to guess when no project covers the file", "answers neither question without a project, rather than answering half of it", "answers nothing where there is nothing under the caret", "has nothing to say about whitespace" |
| 7 | A path or a baseline path that climbs out of its tree never reaches the compiler | `tsProject.test.ts` "refuses a path that climbs out of the root", "keeps a baseline path inside the tree it names" |
| 8 | A request naming a task is answered in that task's worktree and never falls back to the checkout | `tsProject.test.ts` "checks the proposed side in the worktree, not in the checkout", "refuses a task with no worktree instead of answering about the checkout", "checks a file in the checkout, addressed the way the tree draws it" |
| 9 | A baseline answer never changes the live program's answer: a `null` file does not exist in it, a deleted file exists again, and a re-seed forgets the previous overlay | `tsProject.test.ts` "answers about the before-text while the disk holds the after", "makes a file the changeset CREATED not exist in the baseline", "brings back a file the changeset DELETED, so the before-side resolves", "forgets the previous changeset when it is re-seeded for another", "says a created file has nothing wrong with it when asked about it in the baseline", "checks the base side against the changeset's before-side" |
| 10 | Definitions, references and hovers come from the whole program, across files | `tsProject.test.ts` "follows a relative import into the file that defines it", "finds a definition in the same file, at the place it is", "finds references across the files that import a symbol", "says a symbol used in one file is used in one file", "says what a symbol IS, with the type the project gives it" |
| 11 | `file:source` never serves a file the program did not resolve | `tsProject.test.ts` "serves the text of a file the program resolved, and only that" |
| 12 | A references answer never spans more than 60 files without `truncated: true` | unasserted |
| 13 | A worker that errors or exits never leaves a call waiting, and the next call spawns a new one | unasserted |

## Failures cost an answer and never a file, and most clear on the next keystroke

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The worker errors or exits, such as out of memory or a missing `dist/tsProjectWorker.cjs` | every waiting call is rejected with the error or `the type checker exited (<code>)`, and the worker is forgotten | the next call spawns a new worker | squiggles stay as last drawn |
| A call is posted to a new worker after the old one's `error` and before its `exit` | the late `exit` sees waiting calls and rejects them, including those the new worker holds | the next call | one check returns nothing |
| The language service throws building a program, such as on a missing `extends` | `check` answers `checked: false` with the message, and position questions answer empty | fix the config | no squiggles |
| The compiler never returns | no call has a timeout, so the call and every later one wait | restart the app | squiggles stop updating |
| A buffer is released and the same file is checked again with different text before any other check in its project | `hold` restarts the version at 1, the service sees the version it already has, and it reuses the stale source | the next edit moves the version | diagnostics about the abandoned text |
| A `tsconfig.json` is created under a directory already looked up | the cached miss in `configOf` is never invalidated | restart the app | `checked: false` for that directory |
| A package is installed while the app runs | `node_modules` files carry version 0, so the program keeps the old declarations | restart the app | stale errors about the dependency |
| Two editors hold one file | each call holds its own text before it asks, so each answer is about its own text; one editor's release drops the buffer until the other's next call | none needed | each editor's squiggles match its text |
| A file is read while an agent writes it | the program sees the partial text; the finished write moves the mtime and the next check re-reads | the next check | brief syntax errors |
| A check is retried or a buffer released twice | a check is a read and answers again; a second release finds nothing | none needed | none |
| The process is killed mid-write | cannot occur: the unit writes nothing to disk | none needed | none |

## Budgets are the reference limit and the absence of a timeout

- `REFERENCE_FILE_LIMIT = 60` files per references answer, in `packages/shared/src/ipc.ts`, applied in `TsProjects.references`.
- No call has a timeout, and no project is evicted.

## The unit departs from Electron isolation and from root containment, each for one reason

- The checker runs in a Node `worker_threads` worker rather than an Electron `utilityProcess`, so main-process code stays Electron-free and testable headlessly.
- `file:source` is bounded by the program rather than a root, so a definition that resolved outside the tree through a workspace junction can still be previewed.
