---
id: engineering/decisions/0032-background-commands
type: decision
status: built in part
updated: 2026-11-21
decides_for: [engineering/decisions/0019-system-tools, engineering/decisions/0028-agent-terminals, engineering/decisions/0030-the-agents-shell, engineering/decisions/0007-permissionSets, engineering/units/host-tools, engineering/units/process-exec, engineering/units/tool-policy]
---

# 0032. Processes an agent starts and leaves running: one permission to start them, JaiRA knows every one, and the process tools are scoped

## The person's words

The person, 2026-11-21. A topodiff chat (`t-j37e92m83j`) hung on a tool call that had started a dev
server. They asked: "in the jaira topodiff session, is claude code stuck? it says running command and it
appears the server is running, but its not doing anything?" After the hang was fixed (`540b294e`):

> it seems like claude later expected the server to still be running. how does claude try to run
> background commands?

> a few things: 1. if we dont allow background processes, how did it spawn a background process?
> shouldnt we have killed it before moving on? 2. does claude have a separate tool for backgrounding
> execution or is it a flag on executing a command? or both?

Over the first draft of this decision (a `run_in_background` flag, `read_terminal`/`stop_terminal`,
leftovers adopted, escapes asked about):

> i like 1+2, but shouldnt 1 return the process id and then we can add a tool read_process that takes
> the process id and returns the streams from the process (using buffered data from a process we spawn
> vs starting buffering for processes we didnt). then it can use the existing stop process (and list
> processes to see what processes are running). we should have a scope for the process tools for
> processes the session started, processes jaira started, processes the user started, system
> processes, all processes, group processes, etc. then, we can have the default be processes the
> session started. 4+5 make sense. 6 doesnt quite make sense: there is a difference between the agent
> starting a process and waiting for it and the agent starting a process and then continuing. i suppose
> we should also add a wait_process tool. 7. the main issue with starting background processes is that
> we want jaira to know about all of them so that we can show the user what is running and allow the
> user to decide to kill them / see information about them / see their output / etc. furthermore, this
> also seems like a sandbox escape. we want to be able to have different permissions / scopes for
> starting a background process vs foreground process. present a new design with this taken into
> account

Over the second draft's questions (`group`, stopping idle processes, a cap, `background` in `auto`) and
its separate `background` line:

> 1. by group i meant user group. 2. this should be a setting 3. I think no, but it should also be a
> setting. 4. it should ask 5. why do we need a separate command? it should be a flag. similar to how
> we have separate permission for sub commands, we should be able to have permissions for flags.

## Context

- **JaiRA's `shell` has no background mode.** It takes `command` and `cwd` only, and a call answers
  when its process ends or its 120 s limit does. [0028](0028-agent-terminals.md) left background
  commands out until the tool grew one. The Claude CLI gets `shell` as `mcp__dai__shell`, with `Bash`
  and `PowerShell` in `--disallowedTools`, so Claude Code's own `run_in_background` is gone too.
- **Agents start servers anyway, by escaping the call.** In `t-j37e92m83j`, on native Windows (emulated
  shell, one `powershell.exe` per call):
  1. `Start-Process cmd /c "npx one dev --port 8145" -RedirectStandardOutput … -PassThru`. The server
     inherited the call's pipes, and the call hung after PowerShell had exited. Its 120 s limit did not
     end it: the limit kills the call's process tree, whose root had already exited. Fixed in
     `540b294e`: a command ends at its exit plus 1 s for its output (`OUTPUT_DRAIN_MS`).
  2. When the server was then killed by hand, the agent decided that "the dev server stopped when that
     shell call ended". It restarted it with `Invoke-CimMethod Win32_Process Create`. That process's
     parent is the WMI service, so it is in no tree JaiRA knows about. It is still running, and nothing
     in JaiRA lists it.
- **Nothing forbids this, and nothing tracks it.**
  - The policy asks about `Start-Process` only when it runs as another user (`policy.ts`).
  - A call kills its tree only on its time limit or a Stop. A call that ends normally kills nothing.
  - The jobs table records only the process JaiRA spawned.

  A permission set that allows `shell` therefore allows starting anything that outlives the call,
  under no line of its own. That is the escape.
- **The process tools exist, unscoped.** [0019](0019-system-tools.md)'s `list_processes` lists the whole
  machine. Its `stop_process` stops any process but JaiRA's own, and its line can be narrowed by
  `program`. Neither knows which processes an agent started.
- **What agents are trained on.** Claude Code starts with a flag (`Bash`'s `run_in_background`, which
  answers at once with an id) and manages with separate tools:
  - stop: `KillShell`, now `TaskStop`;
  - read the output: `BashOutput`, now `Read` on the output file;
  - watch: `Monitor`.

  The agent is also told when a background command exits.
- **The parts exist.**
  - `TerminalHub` keeps a task's terminals and their output (the last 1 MB each).
  - The card, the Terminals tab and Stop ([0028](0028-agent-terminals.md)).
  - `ShellSessions` and a live shell's last environment ([0030](0030-the-agents-shell.md)).
  - `killTree`, with its Windows walk by parent and start time.
  - `processTree.ts`: descendants, CPU and listening ports on POSIX.
  - Place maps on a tool's line (`scope: PlaceKind`, [0023](0023-overlays-and-scopes.md) §3.1).

## Rulings as designed

### 1. Foreground and background are different requests

- **Foreground** is what `shell` does now: start, wait, answer with the exit and the output. Anything
  the line starts is expected to be gone when the call answers.
- **Background** is start and carry on. It is a flag on `shell`, not a tool of its own:
  `run_in_background: true`, under Claude Code's name for it. A foreground line that leaves something
  running is judged as if it had the flag (ruling 5).
- **The flag has its own permission** (ruling 1a). The line `shell --run_in_background` decides it,
  beside `shell`'s. Strictest wins as always, so a backgrounded line must be allowed both as a shell
  line and as a background start.

| | `ask-first` | `read-only` | `auto` | `full` |
| --- | --- | --- | --- | --- |
| `shell --run_in_background` | ask | deny | ask | allow |

### 1a. A tool's line can be refined by a flag, as a command's is

[0007](0007-permissionSets.md) §4 refines a command by its subcommand and flag: `git push` and
`git push --force` are lines of their own. A tool's line is now refined the same way, by its arguments:

- `tool --name` matches a call whose boolean argument `name` is true: `shell --run_in_background`.
- `tool --name=value` matches a call whose argument `name` has that value:
  `list_processes --scope=user`.
- Several can be written on one line (`stop_process --scope=group --group=docker`). A call is judged
  by every line it matches:
  - the most specific match decides, as `git push --force` over `git push` and `git`;
  - between equally specific lines, the strictest wins.
- A flag line's value is a mode, or the tool's own place map. `shell --run_in_background` takes paths,
  as `shell` does.
- A line naming a command can be narrowed to the flag as well, with the flag written first:
  `shell --run_in_background npm run dev`. A set can then allow a dev server in the background and ask
  about anything else.
- The approval's "what the answer covers" menu offers the flag line, so an answer can be kept as
  `"shell --run_in_background npm run dev": "allow"`.
- The Tools card lists a tool's flag lines under it, as it lists a program's subcommands under the
  program.
- A flag the tool does not have, or a value the argument cannot take, refuses the set with the
  spelling the tool offers, as a misspelled tool name does.

### 2. `run_in_background` answers with the process

- The call answers within 2 s, or at once if the process exits first. The result carries:
  - `pid`;
  - `running`, and `exitCode` if it has already ended;
  - the output so far, clamped as a foreground call's is;
  - `cwd` and `shell`.

  A server that fails at once (a port in use, a missing module) is seen in the same call.
- No time limit applies.
- It runs as its own process, from the task's current directory, even when the agent has a live shell
  ([0030](0030-the-agents-shell.md)). Inside the live shell it would hold the shell for as long as it
  lives. It gets the environment the live shell last reported, and does not move the directory.
- It is spawned in its own process group on POSIX, so a stop reaches what it starts.
- It is the session's (ruling 4), and it is a terminal: the card under its row does not fold when the
  call answers. It says `running in background · 4m` with `Stop`, and folds when the process ends.
- A pid alone can be reused, so JaiRA keys a process by its pid and start time. The agent passes the
  pid; a pid that now names a different process is refused, as `stop_process` already does.

### 3. The process tools: `list_processes`, `read_process`, `wait_process`, `stop_process`

`list_processes` and `stop_process` are [0019](0019-system-tools.md)'s. `read_process` and
`wait_process` are new. Every one takes `scope` (ruling 4), default `session`.

- **`list_processes`** gains `scope` and says, for each process:
  - who started it (the session, which other session, JaiRA, the user, the system);
  - the command line;
  - `running` or, for one of the session's that ended, its exit;
  - the ports it listens on, where the platform can say;
  - whether `read_process` can read it, and from when (ruling 6).
- **`read_process`** takes `pid`, and optionally `tail` (lines) or `since` (an offset it was given
  before). It answers with stdout and stderr since the agent's last read of that process, plus where
  the output came from and whether it is whole (ruling 6).
- **`wait_process`** takes `pid`, `until` and `timeout_ms` (default 30 s, at most 10 minutes). `until`
  is `exit`, or `output` with a regular expression. It answers when that happens or the time runs out,
  with what `read_process` would have said. That replaces a sleep loop for "wait until the server says
  ready". On a process whose output cannot be read, only `exit` is offered.
- **`stop_process`** gains `scope`, and `signal: "interrupt"` for a Ctrl-C first. Its refusal of JaiRA's
  own processes stays, whatever a set says.

### 4. `scope` is an argument, and its permissions are flag lines

Each process tool takes `scope`, default `session`. Its permissions are flag lines (ruling 1a):
`list_processes --scope=user`, `stop_process --scope=system`. The tool's bare line covers any scope
that no flag line names.

| Scope | What it holds |
| --- | --- |
| `session` | Processes this task's agent started, through any call, and everything under them. The default. |
| `jaira` | Processes any JaiRA session started, JaiRA's own (engine, app, agents), and their trees. |
| `user` | The signed-in user's processes that JaiRA did not start. |
| `group` | Processes whose account is in the OS user group named by `group` (`docker`, `staff`, `Administrators`). `group` is required with it. |
| `system` | Other accounts' processes: services, `SYSTEM`, `root`. |
| `all` | Every process. |

- An account's groups come from the OS: `id -Gn` on POSIX, the token's groups on Windows.
- A process whose account cannot be read (another account's, on Windows, without an administrator) is
  in `system` and `all` only. The answer says how many could not be placed.
- `group` can be narrowed to a group: `list_processes --scope=group --group=docker`.

The agent may always see, read, wait on and stop what it started, wherever `shell` is allowed:

| | `ask-first` | `read-only` | `auto` | `full` |
| --- | --- | --- | --- | --- |
| `list_processes --scope=session`, `read_process --scope=session`, `wait_process --scope=session` | allow | allow | allow | allow |
| `stop_process --scope=session` | allow | deny | allow | allow |

The bare lines keep [0019](0019-system-tools.md)'s ruled modes for look and change tools, so every
other scope is as `list_processes` and `stop_process` are today. `read_process` is a look tool, but
its bare line asks in every set but `full`: another program's output can hold what the person did not
mean to show.

### 5. What a foreground call leaves running is a background start

- When a foreground call's process exits, JaiRA finds what it started that is still alive (ruling 7).
  If there is anything, that is an implicit background start, judged at that moment by the
  `shell --run_in_background` line, narrowed by the program left running:
  - **Allowed:** the processes become the session's. They are listed and readable (whatever still holds
    the call's pipes keeps feeding its terminal), and the call's result says so: `started`, each with
    pid, program and ports. A note says to use `run_in_background` next time.
  - **Not allowed:** they are stopped before the call answers, and the result says so: "stopped what
    this command left running (`node`, pid 81736); starting a process that keeps running needs
    `shell --run_in_background`".
  - **Ask:** the person is asked as for any request, with the processes named. Until they answer, the
    call has not answered.
- So "shouldn't we have killed it before moving on": yes, unless the set allows background starts.
  The hang guard (`OUTPUT_DRAIN_MS`) stays; it is what lets the call reach this check at all.

### 6. Reading a process's output: whole for what JaiRA spawned, from now on for the rest

What `read_process` answers with depends on where the process's output goes:

| Source | When | What can be read |
| --- | --- | --- |
| `spawned` | JaiRA started it with pipes it holds (`run_in_background`, a foreground call's leftovers that hold its pipes) | everything since it started, the last 1 MB |
| `file` | its stdout or stderr is a file (`> log`, `-RedirectStandardOutput`) | the file: history included, followed from then on |
| `console` | Windows: it writes to a console window | that console's screen and scrollback, followed from then on |
| `unreadable` | a pipe another program holds, or a terminal device (another app's terminal on POSIX) | nothing; the answer says why |

- Finding where output goes:
  - Linux reads `/proc/<pid>/fd/1` and `fd/2`;
  - macOS uses `lsof -p`;
  - Windows reads the process's standard handles and duplicates each to name its target, which needs
    no administrator for the user's own unelevated processes. An elevated one is `unreadable`. A
    console is read by attaching to it.

  Each is the platform's own, run as the System tools run, with no native module.
- A process that is not the session's starts being followed at its first `read_process` or
  `wait_process`. The answer says `from` (when following began) and `whole: false`.
- Followers end with their process, or after 10 minutes without a read.

### 7. JaiRA knows every process it started

- **Attribution.** Every process JaiRA spawns is recorded (the jobs table) with its session.
  Everything under it is the session's, found by parent and start time: the walk `killTree` does on
  Windows, and the process group and parent on POSIX.
- **Containment where the platform has it.**
  - On Linux with a user systemd, a session's processes run in their own scope (`systemd-run --user
    --scope`), so leaving the process group does not leave the scope.
  - On Windows a session's processes join one Job Object. A process created by another program (WMI,
    the Task Scheduler) is still outside it.
  - On macOS it is the walk alone.
- **The escapes are refused.** A line that has another program start a process, so that it is in no
  tree JaiRA follows, is refused by a built-in deny. The reason says "JaiRA could not see or stop what
  this starts; use `run_in_background`". These are:
  - `Invoke-CimMethod`, `Invoke-WmiMethod` or `wmic` creating a `Win32_Process`;
  - `schtasks /create`, `Register-ScheduledTask`, `at`, `crontab`;
  - `setsid` and `disown` (when the scope above is absent), `launchctl submit`, `systemd-run` outside
    JaiRA's own scope.

  A set can lift the deny only with a `shell --run_in_background` line naming the program, and the
  process is then still looked for (next point).
- **What still gets out is shown, not hidden.** A script file can do what a line cannot be seen doing.
  So after each call, JaiRA looks for processes of the user's that started during the call and whose
  parent is the WMI service or the Task Scheduler. It lists them under the session as `escaped`, with the
  call they started under, so the person sees them and can stop them.
- **None of this is a sandbox.** A program the agent runs can do anything the user can. JaiRA's
  containment is the container workspace ([0027](0027-open-anywhere-and-project-setup.md)). On the
  bare machine this ruling makes escapes visible and refused where they can be seen; it does not make
  them impossible.

### 8. The agent is told when a background process ends

The next result of any tool call in the task carries a `note`, for example "`npm run dev` (pid 84456)
exited 1 after 3m; its last lines: …". Across turns, the same note goes with the person's next message,
as [0028](0028-agent-terminals.md) ruling 8 does for the person's own commands.

### 9. A session's processes live until the task lets them go

A session's process runs until one of these:
- the agent stops it;
- the person stops it;
- the task is closed, moved off the machine or deleted;
- the app quits.

Each end is recorded with the process. After a crash, JaiRA lists what it had started that is still
running, and offers to stop it.

Two settings, layered like every other ([settings-json](../contracts/settings-json.md)), so a project or
the person can set them:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `processes.stopIdleAfterMinutes` | non-negative integer | `0` (never) | Stop a session's background process idle this long. Idle means its tree listens on no port, has used no CPU, and nothing runs in the task (the idle live shell's rule, [0030](0030-the-agents-shell.md) ruling 5). |
| `processes.backgroundLimit` | non-negative integer | `0` (no limit) | How many background processes a session may have running. Past it, `run_in_background` is refused and the running ones are listed. |

### 10. The person sees what is running

- The Terminals tab becomes **Processes**: the session's processes (running ones first, each with its
  output, ports and `Stop`), then the escaped ones (ruling 7).
- A scope switch shows the same list for `jaira` and `user` and `system`. Read, stop and the
  process's details there are the person's, so no permission set is asked.
- The window's part is mocked before it is built, as [0028](0028-agent-terminals.md)'s was.

### 11. The tool descriptions say how

- `shell` names `run_in_background`, and says that a line leaving something running needs it.
- `wait_process` is named for "until ready".
- `list_processes` says its default scope is what this session started.

## Chosen, not ruled

- **Answering after up to 2 s, not at once.** Claude Code answers at once. Two seconds catches a server
  that fails at start, which is what the agent checks next anyway.
- **The pid in front, the terminal behind.** The agent works in pids, the person in terminals. A
  session's process is both: one record, keyed by pid and start time, shown as a terminal.
- **Output kept in memory:** the last 1 MB per process, lost with the engine. A follower's file source
  is reread from the file.
- **Ports** from `lsof` or `ss` on POSIX, and `Get-NetTCPConnection` on Windows; left out where neither
  can say.

## Rulings (the person, 2026-11-21)

The second draft's questions, its separate line, and the third draft's question, answered:

1. **`group` is a user group**: the OS's (ruling 4).
2. **Stopping idle background processes is a setting**, `processes.stopIdleAfterMinutes`, off by
   default (ruling 9).
3. **No cap by default, but a setting**, `processes.backgroundLimit` (ruling 9).
4. **`auto` asks** before starting a background process (ruling 1).
5. **A flag, not a separate tool or line.** Background is `shell`'s `run_in_background`, and its
   permission is a flag line, `shell --run_in_background`, as a command's flag is (ruling 1a). The
   process tools' scopes are flag lines too (ruling 4).

6. **Claude's own `Bash` answers to the same line** ("Yes, same line"). A set that keeps `Bash`
   `native` lets Claude use Claude Code's own `run_in_background`. The translated gate judges that flag
   by `shell --run_in_background`, as it judges `Bash`'s line by `shell`'s. What it starts is the
   session's, found by the walk from the claude process. It is listed, waited on and stoppable, but
   not readable as `spawned`: its output goes to Claude Code's own files. `read_process` reads those as
   `file` where they can be found.

## Consequences

- An agent can run a dev server and work against it, on every executor that uses JaiRA's shell. You see
  it, read it and stop it from Processes.
- Starting something that outlives a call is a permission of its own (`shell --run_in_background`), and
  a set that does not grant it gets no process left behind.
- Any tool's argument can now carry a permission (ruling 1a). This is the first use; the vocabulary,
  the Tools card and the approval's menu learn it once for every tool.
- The escape used in `t-j37e92m83j` (WMI) is refused, and one that gets past the line is listed as
  `escaped`.
- `list_processes` and `stop_process` change their default from the machine to the session. An agent or
  workflow that relied on seeing the machine passes `scope: "all"`.
- `shell`'s result gains `pid`, `running`, `started` and `note`; its foreground result is otherwise
  unchanged.

## Build order

1. **Runtime.**
   - `run_in_background` in `createShellTool`, and the session's process record (pid, start time,
     terminal).
   - The leftover check at a foreground call's exit, judged as `shell --run_in_background`.
   - Attribution by the walk.
2. **Vocabulary and policy.**
   - Flag lines on tools (ruling 1a): parsing, matching by specificity, refusing unknown flags, the
     approval's menu and the Tools card.
   - `shell --run_in_background` and the `--scope=` lines in the shipped sets.
   - The built-in deny for the escapes.
   - The two settings.
3. **Process tools.** `scope` on `list_processes` and `stop_process`; `read_process` and
   `wait_process`, with `spawned` first, then `file`, then `console`.
4. **Engine.** The lifetime of ruling 9, the end note, and the after-crash list.
5. **Containment.** The Job Object on Windows, the systemd scope on Linux, and the `escaped` sweep.
6. **Window.** Mocks for Processes and the card's background state, then the build.

## Built (2026-11-21), in part

The person, over the build: "build the rest too, including the processes view mocks. shouldnt process
view just be a terminal view?" Yes: there is no Processes view. A process is a terminal, and the eight
proposals in [docs/ui/assets/processes-view](../../ui/assets/processes-view/index.html) differ only in
how the Terminals tab and the card hold background processes and other scopes. The view is built once
one is chosen.

- **Runtime.**
  - `SessionProcesses` (`sessionProcesses.ts`) keeps a session's processes, keyed by pid and start
    time. Output is kept for what it spawned, with a reader's place. It can read, wait for a pattern or
    an exit, stop, stop all and the limit, and gives the end notes once each.
  - `shell`'s `run_in_background` (`tools.ts` `runInBackground`) answers after 2 s with the pid and the
    output so far, as its own process even for a live shell, and as the call's terminal.
  - The leftover check (`settleLeftRunning`): `findLeftRunning` and `topsOf` (`leftRunning.ts`) find
    what was left by the process group (POSIX), by parent and start time (Windows), and by the
    containment group's members. It looks only when the output was held past the exit
    (`ExecResult.outputHeld`, `exec.ts`) or the line names a background start (`mayLeaveRunning`).
    Then it keeps or stops what it found, by `decideLeftRunning`.
  - Containment (`containment.ts`): a Job Object per session through one PowerShell helper per engine
    (no breakaway; deadlines, and a fall back to the walk), and a systemd user scope and slice per
    session on Linux; macOS has none. `findEscaped` sweeps after a call for processes started through
    WMI or the Task Scheduler (Windows), or re-parented to init with the session's marker (POSIX). The
    session lists them as `escaped`.
  - Reading another program's output (`processOutput.ts`, and the backends' `outputTargets` and
    `readConsole`):
    - Windows reads the target's standard handles from its PEB and names a file, a console, a pipe
      or `NUL`; a console is read through `AttachConsole`.
    - Linux reads `/proc/<pid>/fd`.
    - macOS reads `lsof -F`.
    - Followers start at the first read and end with the process or after 10 idle minutes.
  - The process tools (`systemTools.ts`): `scope` on `list_processes` and `stop_process`, and
    `read_process` and `wait_process` new. Accounts are read from the process token on Windows and
    from `ps` on macOS. Group members come from `Get-LocalGroupMember` or ADSI, and `dscacheutil`.
  - Claude's own background commands (`nativeBackground.ts`): the gate Claude's callback asks tells
    the engine when it allows `Bash` or `PowerShell` with `run_in_background`. About 2.5 s later the
    tops started since under the task's claude processes are found by the walk, and the earliest
    whose command line runs the call's command is kept as the session's, `how: native`. On Windows,
    what Git Bash's `exec` left under a dead parent and that writes to the same file is stopped with
    it. Its output is Claude Code's `tasks\<id>.output` file: `read_process` and `wait_process`
    follow it, as they now follow every session process whose output is not kept.
- **Permissions.**
  - Tool flag lines (`toolFlags.ts`, `ToolSpec.flags`, the `tool-flag` subject kind): parsed and
    refused with the spelling the tool offers. They are lowered under their own keys, matched most
    flags first and then strictest, and the gate gets the loosest.
  - `shell --run_in_background` is judged as a whole-line part of a backgrounded call. That covers
    Claude's native `Bash`. A missing line asks.
  - The escapes are refused by a built-in that `functions.shell.builtins` does not turn off. A line
    naming the program on `shell --run_in_background` lifts it.
  - The shipped sets' lines are as ruled.
- **Engine.**
  - One `SessionProcesses` and one containment group per task. They are let go on archive, delete,
    move and quit.
  - `processes.backgroundLimit`, and `processes.stopIdleAfterMinutes`, whose idle rule can only tell
    on POSIX.
  - The end notes go with the person's next message.
  - Each task's agent processes are recorded as they spawn (`AgentProcesses`), and its claude routes
    and functions are handed the notice, so what Claude's own `Bash` starts in the background is
    found under them and kept as the task's.

**Not built yet:**
- the window (the chosen proposal);
- the Tools card listing flag lines under their tool;
- `read_process` and `wait_process` on the System card (`SYSTEM_AREAS`).

**Chosen while building:**
- A flag line alone does not offer its tool: the bare line still does.
- POSIX `at` is refused but for listing and removal.
- Windows' kill-on-close job, which Node puts every child in, also ends a session's processes if the
  engine crashes. Nothing is left running unrecorded.

## Revisit when

- `escaped` processes keep turning up, which means agents are getting around the line.
- A background process's output is needed after the engine restarts: that is a log on disk.
