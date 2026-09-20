---
id: engineering/contracts/exec-observer
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/process-exec]
consumers: ["@jaira/runtime exec.ts NodeExec and agents.ts agentSpawn, which call it", "@jaira/runtime modelRoutes.ts agentPromptRoutes and registerAgentRuntimes, which pass it through", "@jaira/persistence jobOwner.ts RunOwner.observer, which implements it", "@jaira/app main service.ts startRun, which forwards it and logs each process", "@jaira/cli cli.ts buildRunEnvironment, which passes a run's claim to every child"]
siblings: [engineering/contracts/sqlite-schema, engineering/contracts/host-tool-vocabulary]
---

# Exec observer

`ExecObserver` in `packages/runtime/src/exec.ts`, generic over its token type `T`, is the hook an observed child process calls when it starts, prints and ends, so a host can record children without the runtime importing persistence.

## A host passes an observer to record or log the children a run starts, and never to read what an agent said

**Use when.** Recording each child a run starts as a job, logging its start and exit, or keeping what it printed for diagnosis. Pass it to `new NodeExec({ observer })`, `agentSpawn`, `registerAgentRuntimes` or `agentPromptRoutes`. The persistence implementation is `RunOwner.observer()` in [process-claims](../units/process-claims.md).

**Do not use when.** Reading an agent's conversation: its stdout is protocol, and its meaning is stored as a record by [operation-record-store](../units/operation-record-store.md) and [native-session-capture](../units/native-session-capture.md). Stopping a process: abort the call, which reaches `killTree` in [process-exec](../units/process-exec.md). Deciding whether a run is alive: [process-claims](../units/process-claims.md).

## The shape is two required hooks, two optional ones, and the two events they carry

### The observer's hooks are called at the start, per chunk of output, and at the end

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `onSpawn` | `(event: { command; argv; pid?; cwd? }) => T \| undefined` | yes | called right after `spawn` returns and before any output; its return is the token every later call carries |
| `onOutput` | `(token: T \| undefined, event: { stream: "stdout" \| "stderr"; chunk: string }) => void` | no | one call per data chunk, decoded as UTF-8 |
| `onExit` | `(token: T \| undefined, event: { code: number \| null; signal: NodeJS.Signals \| null }) => void` | yes | the child closed or could not start |
| `onError` | `(error: Error, phase: "spawn" \| "exit" \| "output") => void` | no | one of the three hooks above threw |

### The spawn event names the invocation as resolved, not as the caller wrote it

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `command` | `string` | yes | the program spawned: `wsl.exe` under WSL, `process.execPath` for a Windows `.cmd` shim or JS entry, otherwise the command as written |
| `argv` | `readonly string[]` | yes | the arguments after resolution: under WSL they begin `-d <distro>` and end with the command and its arguments after `--`, and a shim's entry script leads them |
| `pid` | `number` | no | the child's pid; absent when the spawn failed |
| `cwd` | `string` | no | from `NodeExec`, the cwd handed to `spawn`, which is absent for every WSL command; from `agentSpawn`, the host directory the adapter asked for, in either environment |

## Errors inside a hook are reported and never change the command

| Condition | Response | Caller does |
| --- | --- | --- |
| `onSpawn`, `onOutput` or `onExit` throws | caught, and `onError(error, phase)` is called; the command's result or the agent's exit is unchanged | log it, as the app does with `recording a child process failed (<phase>)` |
| `onError` throws | swallowed | nothing |
| `onSpawn` throws | the token is `undefined` for every later call on that child | treat an undefined token as untracked; `RunOwner` then records nothing more |
| The child cannot start | `onSpawn` is still called, with no `pid`, then `onExit` | expect a row for a process that never ran, closed at once |

## A renamed hook breaks every implementation at once, and no deprecation path exists

- The type crosses packages inside one repository, so renaming or reshaping a hook breaks `RunOwner`, `startRun`'s forwarding observer, `buildRunEnvironment` and the runtime's tests together, and changes land in one commit.
- Adding an optional hook or an optional event field breaks nothing.
- Changing what `command` or `argv` hold changes `jobs.command` for new rows only; stored rows keep the old spelling.

## Tokens, exits and working directories mean less than their names suggest

- `NodeExec` forwards stdout and stderr, and reports one exit: on `close` with the code and signal, or on `error` with both null. `agentSpawn` forwards stderr only, because stdout is the agent's protocol stream, and always reports a null signal.
- When a bridge serves the run, an agent's argv carries `--mcp-config` with the bridge URL, and the run's bridge secret is in that URL's path. `RunOwner` stores it in `jobs.command`, and the app logs it in the `started` line's `detail.argv`.
- `agentSpawn` calls `onExit` twice with code -1 for a binary that cannot launch, once from `error` and once from `close`. An implementation must make the second call harmless, as `JobStore.end` does by updating only rows with no `ended_at`.
- On POSIX an agent killed by a signal reaches `onExit` with code 0 and a null signal, because `agentSpawn` reports `code ?? 0`.
- `NodeExec` never reports a `cwd` for a WSL command, while `agentSpawn` reports the host path, so one run's rows mix both.
- Only children given an observer call it. A chat turn's agents and commands, probes, and git run by `gitFor` start with none.
- An exit reported on `close` follows the end of both streams, so no chunk arrives after it.
