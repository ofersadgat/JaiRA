---
id: engineering/decisions/0030-the-agents-shell
type: decision
status: built
updated: 2026-11-18
decides_for: [engineering/decisions/0028-agent-terminals, engineering/units/host-tools, engineering/units/tool-policy, engineering/contracts/settings-json]
---

# 0030. Each agent's shell: the emulated shell by default, or a live zsh, bash or sh

## The person's words

The person, 2026-11-18. The discussion started from "before we decide, how does an agent typically
interact with a terminal? do they expect ephemeral terminals? e.g. would they issue "cd /foo" and then
"./bar"?". Then:

> ok, I think we should add an option in the place where the agent is configured to choose what its
> default shell is. you can choose a path to a shell which allows zsh/bash/sh or you can choose the
> emulated shell which we provide with the emulated shell being the default. the emulated shell can
> carry the working directory over between calls like youve suggested.

Asked how a real shell should run its commands, the person chose one live shell per conversation:

> One live shell per chat, but we should keep track of the current directory for a few reasons: 1.
> shells should be potentially killed if they arent doing anything and the session is inactive.
> perhaps if the shell has no ports open, has used no cpu for the last 5 minutes, and the agent
> session is inactive we kill the shell? 2. if a shell is killed and the agent resumes, we should
> start the new shell in the same location as the previous one died (telling the agent that we did
> so). 3. knowing the location lets us properly handle path checks. we should also be able to query
> for environment variables before issuing a command in the terminal so we can resolve paths which
> use environment variables.

## Context

- **JaiRA's `shell` started every call as a fresh `sh -c` at the workspace root** ([0028](0028-agent-terminals.md)).
  `cd /foo` followed by `./bar` failed: the second call ran at the root. The tool's description did not
  say so.
- **Agents expect different things.** Claude Code carries the working directory between calls and
  nothing else. Anthropic's API bash tool, OpenHands and SWE-agent keep one live bash. Codex starts
  each command fresh and passes a `workdir`. All of them are trained to chain with `&&` and avoid
  interactive programs. Claude sometimes relies on a `cd` from an earlier call.
- **The permission check judged each line from the workspace root**, or from the call's `cwd`.
  - It followed a `cd` within the line.
  - It expanded neither `~` nor `$VARS`: `rm -rf $HOME/x` was judged as `<root>/$HOME/x`, inside the
    workspace.
  - It is synchronous, and on the Claude callback path it is handed a different input object than the
    tool, so nothing about a call can be passed from one to the other.

## Rulings

1. **A `shell` on every agent's settings** (`agents.claudeCode.shell`, `agents.claudeCli.shell`,
   `agents.codex.shell`, `agents.genericCli[i].shell`).
   - Absent, or `"emulated"`, it is the emulated shell (the default).
   - Otherwise it is the absolute path of a `zsh`, `bash` or `sh`.

   The setting is chosen on the agent's opened row in Settings → Connections. A path is the machine's,
   kept off other machines as an agent's `command` path is ([0026](0026-settings-follow-the-person.md)).
2. **One current directory per task**, whichever shell runs. Each call starts where the last one ended:
   - at first, the workspace root;
   - a call's `cwd` (relative to the root) starts it somewhere else;
   - a directory that no longer exists falls back to the root, and the agent is told.

   The result tells the agent where it ended (`cwd`) and in which shell (`shell`).
3. **The emulated shell** runs each call as before: a fresh process, through the project's interpreter
   (`interpreterFor`). It now starts in the task's current directory and records where it ended.
   Variables, aliases and functions do not carry over. On native Windows (PowerShell) the directory is
   not carried yet: each call starts at the root as before.
4. **A live shell** is one `zsh`, `bash` or `sh` process per task, started as a login shell with its rc
   file read. Commands run in it one at a time, each `eval`-ed with a mark after it that says its
   exit, where it ended and its environment. `cd`, variables, aliases and functions carry over.
   - Typing reaches the running command's stdin, as in [0028](0028-agent-terminals.md).
   - Ctrl-C signals what the shell started, not the shell.
   - `Stop`, or the time limit, signals it to end. If it has not ended a second later, the shell is
     replaced.
5. **An idle live shell is closed** when all three hold: nothing the shell started listens on a port,
   its processes have used no CPU for 5 minutes, and nothing runs in the task (no chat turn, no run).
   The engine checks each minute.
6. **A shell that went away is started again where it was**, and the agent is told so in a `note` on
   that call's result. The note says:
   - why it went: closed after 5 idle minutes, ended (and how), replaced to stop a command, or the app
     restarted;
   - where the new one started;
   - that variables, aliases and functions set before are gone.
7. **Paths are judged from where the shell is.**
   - The permission check starts a line in the task's current directory.
   - It expands `~` and `$NAME` / `${NAME}` in a line's paths. The values come from the live shell's
     environment as its last command left it, which is the moment before the next one runs. For the
     emulated shell they are the environment its commands start with.
   - A variable that is not set expands to nothing, as the shell would.
8. **The tool says what persists.** Its description says each call starts where the last ended, and
   that a live shell keeps variables while the emulated shell does not.

## Chosen, not ruled

- **One directory per task, not per agent.** A run whose states use different agents shares one
  current directory, as they share one workspace. A live shell is per task and shell path.
- **The environment is read at the end of each command** (`env -0`) rather than asked for before the
  next. Nothing runs in the shell between the two moments, so the values are the same, and the
  permission check, which cannot wait, has them at hand.
- **Quoting is not modelled in expansion.** A single-quoted `'$HOME'` is expanded too. That judges a path
  the line does not touch, which is the cautious direction.
- **Where a live shell runs.** Natively on macOS and Linux only. In WSL, in a container, or on native
  Windows, an agent set to a live shell gets the emulated shell, and its first call's note says why.
- **A call judged while another moves the directory** (two calls from one agent at once) is judged from
  the directory at the moment it was judged. A live shell runs calls one after another, in the order
  they arrive.
- **The person's own commands** (`terminal:run`) start in the task's current directory and do not move
  it.

## Consequences

- `cd foo` and then `./bar` works in both shells; with a live shell, so do `source .venv/bin/activate`
  and `export`.
- A line naming `$HOME` or `~` is judged where it acts.
- A live shell is a process JaiRA keeps across turns; the idle rule bounds what it costs.
- The recorded work summary's verdicts (`allowsCall`) still replay a call from the project directory and
  its recorded `cwd`. The `cwd` the result now carries is where a replay could start from instead.

## Built (2026-11-18)

- **Runtime.**
  - `LiveShell` (`liveShell.ts`): the login shell, its rc file read quietly with a fallback without it,
    commands `eval`-ed one at a time with marks, Ctrl-C to what it started, Stop replacing it.
  - `ShellSessions`, `shellChoiceOf`, `withCallingAgent` and `expandShellWord` (`shellSessions.ts`).
  - The marks (`shellMarks.ts`) and the process tree, CPU and listening ports (`processTree.ts`).
  - `createShellTool` given `shells` runs `runInTaskShell`, with one `CallWatch` for both shells.
  - `withAgentPermissionSet` names the calling agent.
  - `DecideCommandOptions.expand` and `CompilePolicyOptions.shellAt` (`policy.ts`, `runPolicy.ts`).
- **Engine.** `ShellSessions` per task, `taskShells` per registration (run and chat turn), `shellAt` at
  both policy compiles, the idle rule each minute (`shells.ts`), every live shell closed when the app
  quits. The person's own commands start where the task's shell stands.
- **Settings.**
  - `agents.*.shell`, checked by `agentShellProblem`.
  - A shell path kept on its machine by sync.
  - The `Shell` group on each agent's opened row (`ShellChoice.tsx`).
- **The terminal card** names a live shell (`· live zsh`).

## Verified

- **The live shell, against real zsh, bash and sh** (`liveShell.test.ts`): `cd` and variables carry
  over; typed input reaches a reading command; Ctrl-C keeps the shell; Stop replaces a shell whose
  command ignores SIGTERM; an `exit` is reported.
- **The shell tool with a task's shell** (`taskShell.test.ts`):
  - the emulated shell carries `cd` and no variables;
  - a gone directory falls back to the root, with a note;
  - a command's own `exit` keeps its code;
  - a live bash keeps variables, and after being closed starts again where it was, with the exact note;
  - a refused live shell runs emulated and says why once.
- **Expansion in the check** (`shellPaths.test.ts`): `rm -rf $HOME/x` and `~/x` are judged at the home
  directory, `cd $HOME && …` is followed, and a line starts in the shell's directory.
- **The setting** (`agentShell.test.ts`) and its sync (`settingsSync.test.ts`). The idle rule and which
  agent's setting applies (`shells.test.ts`).
- **The full suites**: one failure, a two-engine sync test (`packages/app/test/settingsSync.test.ts`, "keeps working with an older machine"). It
  timed out under load, passes on its own every time, and touches nothing here. The typecheck passes.
- **In the app** (`shots/agent-shell.mts`, passing): the Claude row's `Shell` group; `Live shell` writes
  `/bin/zsh`, `/usr/bin/fish` is refused naming why, and `Emulated` takes the setting out.

**Not seen in the app:** an agent's own commands running through a live shell. The rig's world has no
signed-in agent. That path is the tool and the session the tests above drive with real shells.

## Revisit when

- Agents set to a live shell lose work because the idle rule closed a shell they were using in the
  background.
- A shell the person wants is not `zsh`, `bash` or `sh` (`fish`, `nu`, PowerShell): each needs its own
  mark and its own reading of a line.
