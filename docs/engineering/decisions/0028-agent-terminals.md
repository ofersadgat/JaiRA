---
id: engineering/decisions/0028-agent-terminals
type: decision
status: built
updated: 2026-11-18
decides_for: [engineering/units/host-tools, engineering/units/process-exec, engineering/decisions/0025-split-view-and-place-buttons, engineering/decisions/0007-permissionSets]
---

# 0028. An agent's shell commands are terminals: live in the row, placeable like an artifact, typed into

The person, 2026-11-18: "when an agent is using a terminal, i want you to be able to see the terminal in
jaira. mock 8 different designs for handling this". Over the canvas "Agent terminals — 8 designs"
(claude.ai/artifact/LdwufnBzLU78eH3KR3pGsz): "I generally like the idea of 1, but it should have controls
similar to that of a canvas/image/etc (i.e. open full, split window, context window, etc). i wonder if the
rendering should use the existing command processing as well to properly highlight commands in the
terminal. it should also allow you to type into the terminal. i wonder if the context menu should also
have a place for running terminals/commands. lets design out all these cases in another 8 mocks". Over the
second canvas, "Terminal in the row — 8 cases" (claude.ai/artifact/4NXfTy5v8ni4hy33Xk1qW4), all eight
boards accepted ("yes"), amended: "instead of a 'beside' button it should have the same main screen,
split view, context view buttons". Then "Write it up, then build".

## Context

- **JaiRA already runs the agent's shell.** A permission set that holds `shell` holds it as `app` unless it
  says `native` (`viewOfPermissionSet`), and every built-in set does. Then:
  - the Claude CLI gets JaiRA's `shell` over the MCP bridge as `mcp__dai__shell`, with `Bash` in
    `--disallowedTools`;
  - the Agent SDK gets it through its in-process MCP server;
  - Codex runs read-only and gets it over the bridge;
  - an API route's composed loop calls it directly.

  In every case the call reaches `createShellTool`'s `run` (`packages/runtime/src/tools.ts`) with
  `ctx.toolCallId`, which is the transcript's `tool_use` id. So the process the person wants to watch is
  one JaiRA spawned itself, and the call it belongs to is already known.
- **What that process was.** A one-shot `/bin/sh -c` (bash in WSL, PowerShell on Windows), stdout and stderr
  held in memory until it closed, then clamped to 20 000 characters each and returned. Stdin was a pipe
  nobody wrote, so a command that asked a question hung until the 120 s timeout. Nothing reached the
  window while it ran: the live stream (`session:turn`) carries whole messages, and the row said
  `still running` until the `tool_result` landed.
- **What JaiRA cannot see.** Claude's own `Bash`, when a permission set keeps it `native`, runs inside
  claude and is visible only as its call and result. Codex's own sandboxed shell is dropped from its event
  stream altogether. Neither changes here.
- **No terminal emulator or PTY** is in the dependencies, on any platform the app runs on.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Stream the existing `shell` call's pipes to a per-call terminal in the engine, keyed by task and call id; let the person write its stdin and signal it | Works for every executor that already uses JaiRA's shell; no native module; the agent's result is unchanged; remote windows get it through the same push path | Not a TTY: a program that draws a full screen (an editor, `top`) or reads a password from `/dev/tty` cannot be used through it, and programs drop colour when not on a terminal |
| B. A real PTY per call (`node-pty`) and a terminal emulator in the window (xterm.js) | Everything a terminal runs, runs; colour and cursor movement for free | A native module rebuilt per Electron, per platform and inside WSL; escape codes in what the model reads unless filtered; an emulator island on web, desktop and phone; much more than the boards need |
| C. One long-lived shell per conversation (cwd and environment carry over), commands written into it | `cd` carries over; "Claude's shell" is literally one shell | Every command's boundary, exit code and output has to be recovered from the stream; the policy judges a line against a cwd it no longer knows; a hung command blocks the next |

## Decision

**A.** The process stays what it was, so what the model reads and what the policy judges do not
change. The process is now watched, typed into and stopped from the window. B is the upgrade path if
full-screen programs turn out to matter, and it would sit behind the same per-call terminal. C is
declined: a conversation's terminal is the sequence of its commands in its workspace, as drawn on the
boards. It is not one process.

## Rulings (2026-11-18)

1. **The row opens into a terminal card (round 1, board 1; round 2, board 1).** A shell call's row
   (`Bash`, `PowerShell`, `shell`, `mcp__dai__shell`) shows its card under it, unasked, while it runs,
   and folds back to the row when it ends: the exit code and the last line under the row, the card a
   chevron away. The card is drawn like an artifact's:
   - its **title bar** carries a glyph, the command's program and a status: `running · 12.4s`,
     `waiting for input`, `exit 0 · 0.8s`, or `exit 1 · 5.9s` in `--bad`. It also carries `Stop` while
     running, the **three place buttons** and `…`;
   - its **readings**, through the value view's switch, are `Terminal` (the output with its colours),
     `Text` (the same, plain) and `Command` (the line taken apart; ruling 4);
   - under the screen is the **line you type on** while it runs.
2. **The three places (decision 0025) are the terminal's too.** Main view, Split and Side panel move the
   terminal there, and the place it is in is lit. The **same group** is on its card, in the head of the
   pane or panel it fills, and **on the row** while it is shown elsewhere, with that place lit. They
   replace the round-2 "beside →" and "in the panel →" chips (the person's amendment). The `…` menu, and
   a right-click on the card or on a terminal in the Terminals tab, lists the three places, then follow,
   copy the output, copy the command and download the log, then Ctrl-C, then `Stop` in `--bad`.
3. **A terminal is a panel entry** (`kind: "terminal"`, keyed by task and call), so it is placed,
   crumbed, focused and closed by the same code as anything else on a path. Filling a pane or the panel,
   it is the card without its title bar. The pane's or panel's head names it, and the place buttons
   move to the card's reading row.
4. **Command lines are drawn by the approval's parser.** The command at the top of the screen and the
   row's argument are taken apart by `takeApart` (the same line the policy judged, in the same dialect).
   Each request is tinted in its hue (`--p1`, `--p2`, `--p3`, `--p0`), and what joins them (`&&`, `|`,
   `2>&1`) is `--tok-hint`. The `Command` reading lists the requests the way the approval does: a swatch,
   the words, what each asks for. Underlines are not drawn: which words matched the deciding entry is
   the runtime's to know, and it travels only with an approval.
5. **Typing goes to the running command's stdin.** A line typed on the card, or one of the choices read
   off the prompt's last line (`[y,n,q,a,d,s,e,?]`, `(y/N)`, `[Y/n]`), is written with a newline. Ctrl-C
   interrupts the command's process tree, and `Stop` terminates it. What the person typed is drawn in the
   output as theirs (`you`), since a pipe does not echo. It is also returned to the agent with the
   result as `input`, so the agent knows what was answered for it.
6. **Waiting for input is said, not guessed silently.** A running command whose output ends without a
   newline, and has been quiet for a moment, is `waiting for input`: amber on the row, the card and the
   tab's count, with the screen taking the keyboard when opened. The call's time limit (120 s) counts
   from the last line the person typed, and the card says when it will end.
7. **The side panel gets a Terminals tab** beside Produced, Changes and Held, for the conversation and
   for a task's conversation alike. It lists `Running` (waiting ones first, each with its prompt and
   `Answer it`), then `Ended`, then a `Run a command` line. A terminal in it opens on the panel's stack.
   Its count is amber while one waits for the person.
8. **The person's own commands (board 7).** `Run a command` runs a line in the conversation's workspace,
   as the person: no permission set is asked, since sets decide what an agent may run. It is marked
   `you`, is listed and placed like any terminal, and is handed to the agent with the person's next
   message as a short note: the command, its exit, and the end of its output.

## Chosen, not ruled

- **Pipes, not a PTY** (the Decision). Colour is drawn when a program prints it anyway. Nothing forces
  colour, because that would put escape codes in what the model reads.
- **Kept in the engine's memory**, per task, for the last 40 commands, each keeping its last 1 MB of
  output (the head is dropped first, and the screen says how much). After the engine restarts, an ended
  call's card falls back to the stdout and stderr its result carried.
- **Pushed like the installer's log** (`install:output`): `terminal:output` chunks, coalesced per
  command every 80 ms, and `terminal:state` on start, input, end. A late window reads the whole terminal
  with `terminal:read`, and a conversation's list with `terminal:list`. Remote windows get the pushes
  through the engine host's broadcast, as every push does.
- **Background commands** are not part of this. JaiRA's `shell` has none, and the boards' background dev
  server waits for that tool to grow one.
- **Find** in the main view, the scroll track's marks and the round-1 boards 2–8 (dock, wall, replay,
  shared keyboard) are not built.

## Consequences

- Every executor that uses JaiRA's shell is watchable with no change to it. One that keeps its own shell
  (`native`, Codex's sandbox) is not, and the row says nothing it cannot know.
- A command that asks a question no longer hangs until the timeout when a person is there to answer it.
- The terminal is one more panel-entry kind: every exhaustive switch over `PanelEntry` names it.
- B (a PTY) can replace the pipes behind the same per-call terminal without changing the window.

## Build order

1. The engine's terminals: `createShellTool` streams to a per-call terminal; stdin, Ctrl-C and Stop;
   the idle-reset time limit; `input` on the result; the pushes and the four channels.
2. The card in the row: the title bar, the readings, the screen (ANSI colours), the line you type on,
   the prompt's choices, waiting for input; the row's fold back with its last line.
3. The panel entry and the three places, lit on the card, the row and the head.
4. The Terminals tab, and the person's own commands handed to the agent with the next message.

## Built (2026-11-18)

All four steps of the build order.

- **Engine.**
  - `ExecOptions.interactive` (`exec.ts`): stdin kept open, the child in its own process group.
  - `ShellTerminals` and `runInTerminal` (`tools.ts`).
  - `TerminalHub` (`packages/service/src/terminals.ts`). It decides `waiting` here, so every window
    agrees.
  - The five channels and two pushes (`ipc.ts`; recorded in `engineProtocol.json`).
  - Both places that register `shell` now pass `terminals`: `startRun` and `runChatMessage`.
- **Window.**
  - `TermScreen` and what the card says (`terminalModel.ts`).
  - The window's copy (`terminalStore.ts`).
  - `TerminalView`, `TerminalsTab` and `useTerminal` (`packages/universal/src/components/terminal/`).
  - The `terminal` panel entry and its face.
  - `useEntryPlaces` and `moveEntry` (`places.ts`).
  - The row (`WorkRows.tsx`), and `keptUnderSummary` keeping a running shell call out of a folded
    summary.
  - The note on the next message (`yourCommandsNote`, `chatThreadModel.ts`).

## Verified

- **The shell tool, with real processes** (`shellTerminal.test.ts`): it streams, a typed answer reaches
  `read` and comes back as `input`, Ctrl-C stops the tree, and typing restarts the limit.
- **The hub** (`terminalHub.test.ts`): pushes and their `from`, input marked as the person's,
  `waiting` set and taken back, and trimming.
- **The screen, the card's words and the window's copy** (`terminalModel.test.ts`).
- **The real app** (`shots/terminal.mts`, passing):
  - a command run from the Terminals tab opens on the panel's stack;
  - its output streams in colour;
  - it is found waiting at `(y/N)` and answered by its `y` key;
  - it ends `exit 0 · yours`;
  - it is moved to a split, Split lit, the panel back on its tab with the command under `ENDED`;
  - its Command reading lists its requests.

**Not seen in the app:** an agent's own call drawn as the card under its row. The rig's world has no
signed-in agent, and its conversation's one answer is scripted. That path is the same terminal reached
through `ctx.toolCallId`; the row's drawing is type-checked but has not been photographed.

## Revisit when

- A command the person needs to drive draws a full screen or reads a password from the terminal: that is
  B.
- Agents keep their own shell (`native`) often enough that watching only JaiRA's leaves most commands
  dark.
