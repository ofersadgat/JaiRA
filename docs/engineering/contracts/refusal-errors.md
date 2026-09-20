---
id: engineering/contracts/refusal-errors
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/module-approvals]
consumers: ["@jaira/cli runCli and beginTaskRunAsking", "@jaira/app main service.ts recordIpcFailure, startTask and functionsPending", "@jaira/app renderer store.ts startTaskAsking", "@jaira/persistence lifecycle.ts, workflows.ts and every module that declines", "@jaira/runtime modules that decline"]
siblings: [engineering/contracts/task-channels, engineering/contracts/jaira-cli, engineering/contracts/preload-bridge]
---

# Refusal errors

The error classes JaiRA throws when it declines an operation on purpose, and the module-approval refusal that a host with a person attached can answer.

## A site throws a refusal when it declines on purpose, and a plain error when the code is broken

**Use when.** Declining an operation whose reason the site can state: `throw refusal(log, message, fields)` in a library, `throw this.refusal(source, message, context)` inside `AppService`. Stopping a start that reaches js/ts modules this machine has not approved, with `ApprovalRequired`.

**Do not use when.** The code is malfunctioning: throw a plain `Error`, which the app's IPC boundary logs at `error`. Reporting an unapproved module in lint, which is an issue message built from `approvalRefusalMessage` and `approveCommandFor`, not a thrown error.

## The shape is two classes, the approval record they carry, and two message builders

### A refusal is an ordinary error whose own site has already logged it

`Refusal extends Error` in `@jaira/shared` `refusal.ts`, re-exported by `@jaira/app` `service.ts` as the same class.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `message` | string | yes | the reason, written for the person who asked |
| `cause` | unknown | no | set only by the ABI refusal in `persistence/src/db.ts`, which chains the addon's load error |

Two builders log, then return the error for the site to throw:

| Builder | Logs | Returns |
| --- | --- | --- |
| `refusal(log, message, fields?)` | `message` at `warn` through the `@declarative-ai/log` logger, with `fields` as structured context | `Refusal` |
| `AppService.refusal(source, message, context?)` | a `warn` entry with that `source` and context in the app log | `Refusal` |

### ApprovalRequired is a refusal that carries every file awaiting a decision

`ApprovalRequired extends Refusal`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `message` | string | yes | `approvalRefusalMessage(pending)`; the CLI appends a line holding `approveCommandFor(pending)` when nothing was approved |
| `pending` | `readonly ModuleApproval[]` | yes | every file awaiting a decision, sorted by path |

`ModuleApproval`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `file` | string | yes | the module file, absolute and forward-slashed |
| `hash` | string | yes | the file's content hash now |
| `source` | string | yes | the file's source now, which a prompt shows in full |
| `previousHash` | string | no | the hash approved before; present means the file changed since it was approved, absent means it was never approved |
| `symbols` | `readonly string[]` | no | the symbols the workflow calls from this file; absent when the file is reached only as an import |

### The approval messages are fixed text with one line per file

`approvalRefusalMessage(pending)`:

```text
this workflow calls js/ts functions that have not been approved on this machine:
  <file> (calls <symbol>, <symbol>) — never approved
  <file> (reached as an import) — changed since it was approved
```

`approveCommandFor(pending)` is `jaira functions approve <file> <file>`, with a path that holds whitespace wrapped in double quotes.

## Each kind of error reaches the person by a fixed route

| Condition | Response | Caller does |
| --- | --- | --- |
| A library or service site declines | throws `Refusal` after its `warn` line | the app's `recordIpcFailure` logs nothing more and the renderer shows the message; the CLI prints `error: <message>` and exits 1 |
| A start reaches a module never approved, or changed since its approval | `beginTaskRun` throws `ApprovalRequired` before it validates, snapshots or pins anything | the CLI's `beginTaskRunAsking` asks, or refuses with the command appended; the app's `startTask` keeps `pending` for `functions:pending` and rethrows, and the renderer fetches the list and opens the module approval dialog |
| The SQLite addon was built for another ABI | `openDb` throws a `Refusal` holding the load error, `This runtime needs the SQLite addon built for ABI <n>` and the instruction to run `npm run abi`, with the load error as `cause` | run `npm run abi` |
| A plain `Error` reaches an IPC handler | `recordIpcFailure` logs `<channel>: <message>` at `error` with its stack, then the handler rethrows | the renderer shows the message |

## A second refusal class or a change to the message text breaks callers silently, and there is no deprecation path

- `instanceof` is per class. A second `Refusal` class anywhere would make `recordIpcFailure` log that package's refusals at `error`, so every package imports the one in `@jaira/shared`.
- Electron's IPC keeps only an error's message, so `pending` never reaches the renderer. The app depends on `functions:pending` in [task-channels](task-channels.md) for the list, and a change to that path is a change to both.
- The message text is read by people and matched by CLI tests, never by code. Rewording it breaks those tests and nothing else.
- The classes and builders are internal to the monorepo, which ships as one, so no old form is kept.

## A refusal looks like any error, and the module refusal can leave no trace

- To a caller that does not test `instanceof`, a `Refusal` is any `Error` with the same message. The only difference is where and at what level it was logged.
- `ApprovalRequired` is constructed directly, not through `refusal`, so no line is written where it is raised; with `recordIpcFailure` skipping every `Refusal`, a start refused over unapproved modules leaves nothing in the app log.
- `functions:pending` keeps a task's list in memory until a start of that task succeeds. A later start that fails for another reason reopens the module approval dialog with the old list instead of showing its own error.
