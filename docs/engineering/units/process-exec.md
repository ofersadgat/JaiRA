---
id: engineering/units/process-exec
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/work-inside-wsl, product/hand-work-to-agents]
layer: core
owns_contracts: [engineering/contracts/exec-observer]
requires: []
implemented_by: [packages/runtime/src/exec.ts, packages/runtime/src/paths.ts, packages/runtime/src/killTree.ts]
verified_by: [packages/runtime/test/exec.test.ts, packages/runtime/test/paths.test.ts, packages/runtime/test/killTree.test.ts]
siblings: [engineering/units/git-cli, engineering/units/host-tools, engineering/units/agent-executors, engineering/units/process-claims]
---

# Process exec

## Process exec starts a child with literal arguments through the one path mapper, and leaves recording and agents to its neighbours

`NodeExec.run(command, args, options)` in `exec.ts`:

- resolves the invocation with `resolveInvocation`, spawns with `shell: false` and `windowsHide`, and merges `options.env` over the constructor's `env` over `process.env`;
- writes `options.stdin` and closes it, and accumulates stdout and stderr as UTF-8 strings;
- on `timeoutMs` or `abortSignal` calls `killTree` and sets `timedOut` or `aborted`;
- resolves an `ExecResult` on `close` whatever the exit code, and rejects `failed to run '<file> <argv>': <message>` only when the child cannot start;
- calls the constructor's observer after the spawn, per output chunk and at the end, each call guarded. The hook is [exec-observer](../contracts/exec-observer.md).

`resolveInvocation` passes a native command to upstream `resolveProgram`, which on Windows keeps a real executable as written and turns a `.cmd` shim or a JS entry into `node <entry>`. Under `{ wsl: distro }` it returns `wsl.exe -d <distro> [--cd <toWslPath(cwd)>] -- <command> ...args` with no cwd of its own. `execOk` returns trimmed stdout, or throws `ExecError` carrying the result with the message `'<command>' exited <code>`, `timed out` or `was canceled`, followed by the trimmed stderr or stdout.

`paths.ts` is the mapper: `ExecEnv`, `isWslEnv`, `distroOf`, `toWslPath`, `toWindowsPath`, `pathFor`, `hostPathFor`, `samePathKey`, `samePath`, and the host pair `interpreterFor` and `dialectFor`. `killTree(child, signal, options)` in `killTree.ts` runs `taskkill /PID <pid> /T /F` on Windows and `process.kill(-pid, signal)` on POSIX, falling back to `child.kill` whenever either cannot act. On Windows `taskkill` gets `TASKKILL_DEADLINE_MS` (2 s); one that overruns it, exits non-zero or cannot start is killed and replaced by `TREE_WALK`, a toolhelp-snapshot walk run through `powershell.exe` that does not go through WMI, and `child.kill` follows the walk whatever it did. `KillTreeOptions` replaces either helper and either deadline, and `NodeExec` takes it as `killTree`. `detachedForTree` is `{ detached: true }` on POSIX and empty on Windows. `killTree.ts` is not exported from the runtime's index.

It deliberately does not own:

- Job rows, heartbeats and captured output: [process-claims](process-claims.md).
- Spawning an agent. `agentSpawn` in `agents.ts` belongs to [agent-executors](agent-executors.md) and reuses `resolveInvocation`, `detachedForTree`, `killTree` and the observer.
- Which program a model's command line runs under and how the policy parses it: [host-tools](host-tools.md) and [tool-policy](tool-policy.md) call `interpreterFor` and `dialectFor`.
- Git subcommands and their parsing: [git-cli](git-cli.md).

## Process exec is the core layer's only door to child processes, and it is the Windows and WSL boundary

- Layer `core`, package `@jaira/runtime`. It calls `node:child_process`, `node:fs` for program lookup, and `refusal` from `@jaira/shared`.
- Upstream seam: `resolveProgram` and `ProgramDeps` from `@declarative-ai/agents-cli`. The engine never calls this unit; registered tools and functions do.
- Boundary: Windows and WSL. `toWslPath` and `toWindowsPath` are the one translation, used by `resolveInvocation`, `Git.path`, `agentSpawn` and the CLI's `worktree list` join.
- The app's `startRun` and the CLI's `buildRunEnvironment` build one `NodeExec` per run with the run's observer, shared by `bash`, `run_command` and generic agents. Chat turns, probes, `gitFor` and the git identity lookup build their own without one.

## Process exec owns no stored data, and the environment it runs in comes from settings

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `execEnvironment` from `settings.json` | read by callers and passed as `execEnv` | [project-config](project-config.md) | host-tools, tool-policy, agent-executors, git-cli |
| A child's environment | `options.env` over the constructor's `env` over `process.env` | the host process | none; under WSL none of it reaches the Linux process |
| `ExecResult.stdout` and `stderr` | accumulated in memory for the child's whole life | the child | the caller; the observer sees each chunk as it arrives |

## The invariants keep arguments literal, streams drained and the tree killable

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | No argument is ever reinterpreted by a shell | `exec.test.ts` `"keeps arguments literal — no shell to reinterpret them"` |
| 2 | A native command passes through untouched, a WSL command is wrapped with `-d`, `--cd` and `--` while `wsl.exe` gets no cwd, and it runs in the distro at the translated directory | `exec.test.ts` "passes a native command through untouched", "wraps a WSL command with -d, --cd and the -- terminator", "omits --cd when no cwd is given, and still terminates options", "runs a command inside the distro", "translates the working directory into the distro's view" |
| 3 | A non-zero exit resolves with its code and stderr, and only a child that cannot start rejects | `exec.test.ts` "captures stderr and a non-zero exit without throwing", "rejects when the command cannot start at all" |
| 4 | A timeout or an abort ends the command and says which one did | `exec.test.ts` "times out and reports it", "is abortable" |
| 5 | `execOk` returns trimmed stdout, or throws an `ExecError` carrying the result and stderr | `exec.test.ts` "returns trimmed stdout on success", "throws an ExecError carrying the result and stderr" |
| 6 | Both streams are drained and forwarded as they arrive, so a child writing more than a pipe holds still exits with its stdout whole | `exec.test.ts` "forwards both streams as they arrive", "survives a child that writes far more to stderr than a pipe holds" |
| 7 | An observer that throws never changes the result, and its error reaches `onError` | `exec.test.ts` "reports an observer that throws instead of swallowing it" |
| 8 | Drive and distro paths survive a round trip, both UNC spellings are read, and only `\\wsl.localhost` is written | `paths.test.ts` "%s → %s", "preserves Windows drive paths", "preserves distro-internal paths" |
| 9 | A distro path with no distro to name is refused rather than guessed | `paths.test.ts` "refuses a distro-internal path with no distro to attribute it to" |
| 10 | Two spellings of one path compare equal across separator, case and trailing slash, and a distro's git output joins recorded host paths | `paths.test.ts` "matches spellings that differ only by separator, case, or trailing slash", "joins a WSL project's git output against recorded host paths" |
| 11 | The interpreter that runs a command and the dialect the policy parses it in always agree | `paths.test.ts` "picks the interpreter and dialect together, per host" |
| 12 | A tree kill ends a grandchild, and never throws for a child that never started | `killTree.test.ts` "kills the grandchild, not just the child", "does not throw when the child never started" |

## Every failure is the caller's to report, and a few leave processes or settings behind

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The program is not installed | the `error` event reports `onExit` with a null code and signal, and `run` rejects `failed to run '<file> <argv>': <message>` | install it or configure its command | the tool call or state fails naming the command |
| A command never ends and no `timeoutMs` is given | `run` waits for as long as the child lives | pass a timeout or an abort signal | the step stays running |
| A timeout or an abort on POSIX | `NodeExec` children are not spawned detached, so the group kill fails and `child.kill` ends only the direct child | none | the step reads stopped while the child's own children keep working |
| `taskkill` never exits, exits non-zero or cannot start on Windows (a wedged WMI service makes it hang) | after 2 s `killTree` kills it and walks the tree from a toolhelp snapshot instead, then calls `child.kill` | none needed | the stop lands a few seconds late |
| The tree walk also fails or overruns its 8 s | `killTree` falls back to `child.kill`, which ends only the launcher | none | the step reads stopped while the program under the launcher keeps working |
| A WSL command is given `env` | the variables are set on `wsl.exe`, and with no `WSLENV` none reaches the Linux process | none | none; the variable silently has no effect |
| A child prints megabytes | stdout and stderr are kept whole in memory until `close` | the caller caps what it keeps | none |
| `toWslPath` is given another distro's UNC path, or a bare drive such as `C:` | the first maps to that path as if it were this distro's, and the second maps to the drive root | none | none |
| Two calls run at once | each spawns its own child with its own buffers, and they share only the observer, called on one thread | none needed | none |
| The host is killed while a child runs | nothing durable is written here and nothing kills the child; an observed child is reported as an orphan by [process-claims](process-claims.md) at the next open | kill it by its reported pid | an orphan warning in the CLI |
| A caller retries a command | `run` has no idempotency, so the command runs again | the caller decides | none |

## Only agents are spawned as their own process group, which leaves short commands tied to their terminal

- `detachedForTree` is spread only into agent spawns, so a short command keeps dying with the terminal that started it, and on POSIX an abort of a `NodeExec` child reaches that child alone.
