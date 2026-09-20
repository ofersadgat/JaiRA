---
id: engineering/contracts/ts-check-worker-protocol
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/ts-language-service]
consumers: ["@jaira/app main tsCheck.ts WorkerTypeCheck, which posts requests and settles replies", "@jaira/app main tsProjectWorker.ts, which answers them from TsCheckers", "@jaira/app main service.ts, which reaches both through TypeCheckPort"]
siblings: [engineering/contracts/ipc-channels]
---

# Type-check worker protocol

The messages `WorkerTypeCheck` in `tsCheck.ts` posts to the type-check worker thread, and the replies `tsProjectWorker.ts` posts back, both shipped in one build of `@jaira/app`.

## Main reaches the worker only through WorkerTypeCheck, and a test never reaches it at all

**Use when.** Main needs a `TypeCheckPort` answer off its own thread: call `check`, `definitions`, `references`, `hover`, `sourceOf` or `release` on `WorkerTypeCheck`, which mints the id and settles the reply. `AppService.typeCheck()` builds one on first use.

**Do not use when.** Testing: pass `AppServiceOptions.typeCheck` a `TsCheckers`, which answers in process. Asking from the renderer: use the `file:check` family in [ipc-channels](ipc-channels.md), which contains the path before it reaches this protocol.

## The shape is one request union, one reply union, and the file channel answers as values

### A request is one of six ops, each carrying the id its reply echoes

`TsRequest` in `tsProjectWorker.ts`. `AtCaret` is `"definitions" | "references" | "hover"`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | number | yes | minted by `WorkerTypeCheck` from 1 upward per instance |
| `op` | `"check"`, `AtCaret`, `"sourceOf"` or `"release"` | yes | which `TsCheckers` method answers |
| `file` | string | yes | an absolute path the caller has already contained; for `sourceOf`, the file whose program is asked |
| `text` | string | no; on `check` and `AtCaret` only | the editor's buffer; absent means the file on disk, and drops any buffer held for `file` |
| `at` | `{line: number, column: number}` | on `AtCaret` | the caret, 1-based |
| `target` | string | on `sourceOf` | the absolute path whose text is wanted |
| `baseline` | `BaselineOverlay[]` | no; not on `release` | present routes the call to the baseline program, re-seeded with exactly these files |

### A baseline overlay entry puts one file back as it was

`BaselineOverlay` in `tsProject.ts`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `file` | string | yes | absolute path |
| `text` | string or `null` | yes | the file at the base commit; `null` means it did not exist there |

### A reply is a value or a message, never both

`TsReply` in `tsProjectWorker.ts`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | number | yes | the request's id |
| `ok` | boolean | yes | `true` when the method resolved |
| `value` | see below | when `ok` | the method's result |
| `message` | string | when not `ok` | the rejection's message |

### The values are the file channel responses before main adds an address

The types are in `packages/shared/src/ipc.ts`. The worker never sets `FileLocation.at`; `AppService.addressOf` adds it.

| `op` | `value` type | Meaning |
| --- | --- | --- |
| `check` | `FileCheck {checked, reason?, config?, baseline?, diagnostics}` | `checked: false` with `reason` when no config covers the file or the program could not be built; `config` is the absolute `tsconfig.json`; `baseline: true` on a baseline answer |
| `definitions` | `FileDefinitions {definitions: FileLocation[], checked}` | empty when nothing is under the caret or no program covers the file |
| `references` | `FileReferences {references: FileLocation[], checked, truncated?}` | `truncated: true` when more than `REFERENCE_FILE_LIMIT` files were found |
| `hover` | `FileHover {checked, info?}` | `info` holds a `FileSpan`, `signature` and optional `documentation` |
| `sourceOf` | string or `undefined` | the full text of `target` when `file`'s program holds it |
| `release` | `undefined` | the live buffer for `file` is dropped |

`FileDiagnostic` is a `FileSpan {startLine, startColumn, endLine, endColumn}`, 1-based, with `severity` `"error" | "warning" | "info"`, TypeScript's `code`, a flattened `message`, `file` only when anchored in another file, and `related`. `FileLocation` is a `FileSpan` with an absolute `file` and an optional `name`.

## Errors reject the call they belong to, and a dead worker rejects every call

| Condition | Response | Caller does |
| --- | --- | --- |
| A method rejects inside the worker, such as the `typescript` import failing | reply `ok: false`; `WorkerTypeCheck` rejects with `Error(message)` | the IPC handler rethrows, `recordIpcFailure` logs it at `error`, and the renderer draws nothing |
| The language service throws building a program | reply `ok: true`: `check` gives `checked: false` with the message, and the position ops give their empty answer | draw nothing |
| No `tsconfig.json` covers the file | reply `ok: true` with `checked: false`, `reason: "no tsconfig.json covers <file>"` and syntax diagnostics only | draw the syntax diagnostics |
| The worker emits `error` or exits | every waiting call rejects with that error or `the type checker exited (<code>)`, and the worker is forgotten | call again, which spawns a new worker |
| `postMessage` throws | that call rejects with the thrown error | call again |
| A call after `close()` | rejects with `the type checker is shutting down` | none |
| A reply arrives for an id nothing waits for | dropped | none |

## Both ends ship in one bundle, so a change lands on both at once, and no deprecation path exists

- `main.cjs` and `tsProjectWorker.cjs` come from one `build.mjs` run, so the protocol is never versioned and no old form is kept.
- A new op needs the `TsRequest` member, a `TypeCheckPort` method and a `TsCheckers` method together. The worker dispatches any op it does not name to `projects[request.op]`, so an unknown op throws in the message handler, kills the worker and rejects every waiting call.
- `value` passes through main unchanged apart from `at`, so a renamed field in a value breaks the renderer's markers, peeks and hovers as well.

## Timeouts, releases and baselines work differently than their names suggest

- No call has a timeout. A compiler that never returns blocks the worker's thread, and every later call waits behind it.
- `release` drops a buffer from the live program only. A baseline program keeps its overlay until the next call that carries a `baseline`.
- A baseline call without `text` drops the before-text just seeded for that file and answers about the disk. The renderer's `checkFile` service type requires `text`, which is what keeps the reviewer off this path.
- A buffer dropped and then held again restarts its version at 1. When no other call in that project ran in between, the service sees a version it already has and answers about the old text.
- A late `exit` from a worker that already emitted `error` rejects every waiting call, including calls posted to the worker that replaced it.
