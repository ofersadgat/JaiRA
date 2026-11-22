---
id: ui/components/terminal-card
type: ui-component
status: shipped
updated: 2026-11-21
realizes: [ux/patterns/stream-then-settle, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/one-document-several-readings, ux/patterns/context-beside-what-you-stand-on]
serves: [product/watch-agents-work-live, product/steer-agents-mid-task, product/agents-ask-instead-of-guessing, product/read-what-work-produced]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/context-panel, ui/surfaces/app-window]
reuses: [ui/components/work-row, ui/components/context-menu, ui/components/icon]
implemented_by: [packages/universal/src/components/terminal/TerminalView.tsx, packages/runtime/src/toolProcesses.ts, packages/universal/src/components/terminal/TerminalsTab.tsx, packages/universal/src/components/terminal/useTerminal.ts, packages/universal/src/components/panel/WorkRows.tsx, packages/app/src/renderer/terminalModel.ts, packages/app/src/renderer/terminalStore.ts, packages/service/src/terminals.ts]
verified_by: [packages/app/test/terminalModel.test.ts, packages/runtime/test/toolProcesses.test.ts, packages/service/test/terminalHub.test.ts, packages/runtime/test/shellTerminal.test.ts, packages/app/shots/terminal.mts]
mockups: []
siblings: [ui/components/artifact-pane, ui/components/work-row, ui/components/value-view]
---

# Terminal card

A shell command as a terminal ([decision 0028](../../engineering/decisions/0028-agent-terminals.md)).
In the conversation it is a bordered card under the command's row, built like an artifact's card:

- a title bar: a glyph, the command's program, its status, `Stop`, the three place buttons and `…`;
- a joined switch of readings, `Terminal | Text | Command`;
- the screen, on the terminal's dark ground;
- the prompt's answers as keys;
- a line you type on.

In a pane or the side panel it has no title bar, and the status, Stop, places and `…` move onto its
reading row.

The canvases it was drawn from are "Agent terminals — 8 designs" (board 1) and "Terminal in the row —
8 cases" (all eight boards), both of 2026-11-18.

## A terminal card shows a command JaiRA's shell runs, as it runs

**Use when.** A tool call ran through JaiRA's `shell`: an agent's `Bash`, `PowerShell` or
`mcp__dai__shell` while its permission set holds `shell` as `app`, or a command the person ran from the
Terminals tab. The engine keeps a terminal for it (`TerminalHub`).

**Also use when.** Another of JaiRA's tool calls started a process: `git_push` running `git push`, a
merge request or CI tool running `git`, `gh` or `glab`, `start` making a worktree (decision 0028,
amended 2026-11-21). Each process is a terminal of its own, linked to the call (`tool`, `call`). The one
running is drawn under the call's row once it has run 600 ms, so a quick `git rev-parse` does not
flash a card. Every one of them is in the row's body, above its arguments and result. Such a terminal
cannot be typed into: there is no line you type on, no answers, no `Send Ctrl-C` and never
`waiting`. `Stop` ends the process. Its status adds ` · {tool}`, and so does its line in the Terminals tab.

**Do not use when.** The command ran inside the agent, as Claude's own `Bash` under `native` or Codex's
sandboxed shell. Then there is only its call and its result, and the row stays a [work row](work-row.md)
with its payloads.

## The card is an artifact's frame around a terminal's screen

- **Card.** It has a 1px `--line` border, radius 10, on `--panel`, clipped. While the command waits for
  input the border is `--warn` at 45%.
- **Title bar.**
  - Layout: a row, 38px tall, padded 0 8 0 10, gap 8.
  - Glyph box: 18px, radius 5, `--panel-3` with the terminal glyph in `--accent`; while waiting,
    `--warn` on its tint.
  - Title: the program and subcommand of the command that does the work (`vitest run`, `git add`), in
    the app face at 13/12.5, weight 600.
  - Status: `running · 12s` in `--accent`, `waiting for input · 41s` in `--warn` at weight 600,
    `exit 0 · 0.8s` in `--dim`, or `exit 1 · 5.9s`, `timed out · 2m 0s` or `ended by SIGKILL` in `--bad`.
    `stopped · 3.0s` is in `--dim`. The person's own command adds ` · yours`.
  - Verbs: `Stop` (outlined in `--bad` at 35%) while running, then the
    [place buttons](../../engineering/decisions/0025-split-view-and-place-buttons.md), then `…`.
- **Readings.** A joined switch with a 1px `--line` border and radius 6. Each button is 22px tall, in
  the app face at 11.5/12.5; the chosen one is `--fill-ghost-selected` at weight 600. The rest of the
  row:
  - a spacer, or in a pane the status;
  - `Following` while it runs (`--accent` on `--tint-accent` when on);
  - Copy;
  - in a pane, the verbs.
- **Screen.** The ground is `#0f1120`, padded 8 14 10, in the data face at 11.5/12 on 19px lines.
  - The first line is `❯` and the command, taken apart by the approval's parser (`takeApart`). Each
    request sits on its hue (`--p1`, `--p2`, `--p3`, `--p0`) at 22%, and what joins them is `#5d6386`.
  - Then what it printed, in its own colours. The sixteen ANSI colours are the ink palette's status
    hues on dark (`TERM_COLOURS`). A carriage return overwrites the line and `ESC[K` clears to its end;
    every other escape is dropped.
  - What the person typed is `#b3b6ff` at weight 600 on a 16% wash.
  - Line count: a card shows the last 12 lines under `↑ {n} earlier lines`. Pressed, it shows the last
    400 in a 320px scroller. A pane or the panel shows the last 3000 and scrolls, following the end
    while `Following` is on.
- **Answers.** While waiting, when the prompt's last line names its answers (git's `[y,n,q,a,d,s,e,?]`,
  `(y/N)`, `[Y/n]`, `(yes/no)`), each answer is a key on `#161931`. The key's letter sits in a 20px cap
  and its meaning beside it, such as `n no (default)`. A press sends the letter and a newline.
- **Input line.** While it runs: a row 36px tall on `#161931` with a 1px top rule (`rgba(179,182,255,.55)`
  while focused). It holds `›`, a field, while waiting `ends in {t} unless you answer` in `#f3c464`, and
  `Ctrl-C`.

## The card follows the command from start to end

| State | Rendered as |
| --- | --- |
| empty | `starting…` in italic, until the first output. |
| running | Under its row, unasked, with its output as it arrives. |
| waiting | Amber, as above, with the answers when the prompt names them. The row keeps its place in the transcript. |
| ended | The row folds back. A non-zero exit, a timeout or a signal leaves `exit 1 · {its last line}` under the row. The card is the row's body, a press away. |
| elsewhere | Placed in the main view, a split or the side panel, the row draws no card. It carries the three place buttons instead, that place lit. |
| not kept | The engine restarted, or let it go past the last 40 of the task. The row stays a work row with its payloads. |

## Pressing moves it, types into it or stops it

| On | Does |
| --- | --- |
| A place button | Moves it there, closed where it was. Pressed where it is lit, the side panel closes and a pane stays. |
| `…` | The three places; `Follow the output` (while it runs); `Copy the output` (`{n} lines`); `Copy the command`; `Download the log…`; `Send Ctrl-C` and `Stop {program}` in `--bad` (while it runs). |
| A reading | `Text` is the screen as plain, selectable text. `Command` lists the line's requests as the approval does: a swatch, the words, `→`, what it asks for. |
| ⏎ in the input line | Sends the line and a newline to its stdin, and restarts its time limit. |
| An answer's key | The same, with that answer. |
| `Ctrl-C` | SIGINT to its process tree. |
| `Stop` | SIGTERM to its process tree. |

## The Terminals tab lists a conversation's terminals beside Produced, Changes and Held

- **Count.** The tab counts the commands that are running, in `--warn` on `--tint-warn` while one waits.
- **Run line.** First comes the line to run your own command: `›`, a field and `Run`, then
  `Runs as you: permission sets decide what an agent may run, not you.`
- **`RUNNING`.** Each running command is a card: the glyph, the command in the data face at weight 600,
  `waiting for you` while it waits, and Stop. Under it: who ran it and its status, its last two lines
  on the dark ground, and `Answer it` while it waits. Waiting ones come first.
- **`ENDED`.** Newest first, one row each: ✓ or ✗, the command, `you` for the person's own, its time or
  how it ended, and when.
- **Pressing.** A press opens the terminal on the panel's stack.

## The person's own commands go to the agent with the next message

A command run from the tab is the person's (`by: "you"`, `terminal:run`). It runs in the conversation's
workspace with no time limit and no permission set. The next message sent in the conversation carries
each such command not yet handed over, as a short note in the message's own text: the command, how it
ended, and its last 15 lines (`yourCommandsNote`).
