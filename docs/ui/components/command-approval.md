---
id: ui/components/command-approval
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/park-and-ask, ux/patterns/consent-to-exactly-what-was-shown]
serves: [product/risky-actions-wait-for-approval, product/agents-act-only-where-allowed]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal, ui/surfaces/components-view]
reuses: [ui/components/icon]
implemented_by: [packages/app/src/renderer/approvalSurface.tsx, packages/app/src/renderer/approvalModel.ts, packages/app/shots/approval-static.mts]
verified_by: [packages/app/test/approvalModel.test.ts, packages/app/test/approvalToolset.test.ts, packages/app/test/approvals.test.ts]
mockups: [ui/assets/command-approval/asking.html, ui/assets/command-approval/answer-menu.html, ui/assets/command-approval/embedded.html, ui/assets/command-approval/outside-a-conversation.html]
siblings: [ui/components/agent-question, ui/components/gate-surface, ui/components/confirm-action-gate]
---

# Command approval

A block under a running agent's words, below a blue rule: a shield glyph and `Approve this command?`, the tool's name in small grey type, the command in a bordered mono box with each of its requests tinted in its own colour, one row per request under it, an amber line naming the toolset and the subject that asks, and two split buttons, a filled `Allow` and a red-outlined `Deny`, each with an arrow.

## A command approval asks about one tool call that policy held back

**Use when.** An agent's tool call resolved to ask: a shell line with a part the state's toolset asks about, a command a policy rule or a built-in holds back, or a write the policy wants a person to see. The agent waits for a person to allow or deny it.

**Do not use when.** A running agent asks a question of its own: use [agent-question](agent-question.md). A process declares a yes-or-no on its next step: use [confirm-action-gate](confirm-action-gate.md). Code a process calls needs approving before work starts: that is the module approval dialog, which shows whole files.

## The line reads first, then its requests, the reason, and the answers last

- **Place.** In the conversation: under the transcript of the step whose agent is running, after a 2px `--accent` rule with 12px above it and 8px under it. With no task to hold it: alone in a centred modal on `--panel`, radius 12px, 18px padding and the lift shadow, over the window's scrim.
- **Heading.** A 16px shield glyph in `--dim`, then `Approve this command?` in `--text` at 17/12.5 of the app size, 8px above the tool line.
- **Tool.** The tool's name in `--dim` at 11/12.5 of the app size.
- **Line.** 12px under the tool, a box on `--bg` with a 1px `--line` border, radius 8px and 10px padding, in the data face at 12/12: the command as written. Each request is a tint of its own hue at 13%, radius 4px, padded 1px by 3px, and keeps its tint on every line it wraps onto. Inside a tint, only the words that matched the entry that decided are underlined, 2px in the hue at 75% and weight 600: `git commit` without its flags, `rm` inside `-exec rm {}`, a redirect's operator, the program alone when nothing but the shell's own entry matched, a script's whole invocation. What joins the requests, `&&`, `|`, a space, an embedder that is no request itself, is `--tok-hint` with no tint.
- **Nesting.** A character belongs to the innermost request whose span covers it: `rm {}` inside its `find` is the find's colour either side and its own in the middle.
- **Hues.** Requests take `--p1`, `--p2`, `--p3`, `--p0` in source order. A fifth request takes `--p1` again.
- **Rows.** 8px under the box, one row per request at 11.5/12.5 of the app size, 2px apart, each padded 4px by 8px: a 9px square swatch in the hue, the request's words in the data face with the same underline, cut with an ellipsis, `→`, what it is a request for in the data face at weight 600, and a pill at the right reading `allowed`, `asks` or `denied`. Under the subject, at 10.5/12.5 in `--tok-hint`: the path or url, `inside {embedder}` when it was opened out of something that is no row, `no line names {subject} — any other command` when the toolset's `bash` entry stood in, and the policy's own reason where a built-in or a rule had one. A row that asks lies on `--tint-warn` with its pill in `--warn`; a denied pill is `--bad` on `--tint-bad`. A request written inside another is set 17px further in, under its host.
- **Reason.** 10px under the rows, in `--warn` at 12/12.5 of the app size: `Toolset {bucket/name}: {entry} asks`, the toolset in the data face and each asking entry in bold, once each. A toolset written on the state reads `This state's toolset: …`. A request no toolset decided keeps `Policy: {reason}`, one line per reason.
- **Answers.** A row 14px under the reason: `Allow` filled with `--fill-accent`, then `Deny` outlined in `--bad`, 8px apart. Each is two buttons joined: the word, and a 12px chevron divided from it by a hairline.
- **Menu.** Opens under its button, left edges aligned, 390px wide at least, on `--panel` with a 1px `--line` border, radius 9px and the menu shadow. First `Allow what` or `Deny what` over a segmented control per distinct request: `git commit` | `every git command`, the chosen half tinted `--accent` at 13%. With more than one, each control is led by its request's swatch, and a request with one width is a single segment. Then a rule, `Allow once` ticked in `--ok`, `Allow for this run`, a rule, and `Add to {name}, in this project` and `Add to {name}, for all projects`, each with a sentence under it in `--tok-hint` that carries the text to be written in bold data face.

## The block asks until it is answered, then leaves nothing behind

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the block is drawn only while a call waits on approval. | |
| loading | Cannot occur: the call arrives whole with the request, and a pressed answer shows nothing until the agent carries on. | |
| asking | In the conversation, as above. A tool with no command line shows its input as indented JSON in the box, no rows, and `Policy: {reason}`; a request with no reason has no reason line. | [asking.html](../assets/command-approval/asking.html) |
| menu open | One menu at a time, under `Allow` or under `Deny`. A built-in or shared toolset offers `creates {file} with {line}, following the built-in toolset`. A toolset written on the state offers once and this run, and says why under a rule. A tool with no command line offers once and this run. | [answer-menu.html](../assets/command-approval/answer-menu.html) |
| embedded, scripts, many parts, unread | A request inside another is indented; a script underlines its whole invocation; hues repeat past four; a line that could not be read is one row with the parser's reason, and its menu offers `Allow once` alone with the reason under it. | [embedded.html](../assets/command-approval/embedded.html) |
| outside a conversation | A request that names no task, in the modal. When an answer fails, the reason follows under the buttons in `--bad` at 11/12.5 of the app size. | [outside-a-conversation.html](../assets/command-approval/outside-a-conversation.html) |
| error | In the conversation, a failed answer, a toolset file that could not be written among them, is reported in the window's [error-notice](../surfaces/error-notice.md) and the block stays as it was, still asking. | |
| success | Cannot occur as its own look: once answered the block goes, and the agent's tool row in the transcript shows the call running or refused. | |

## The button answers once, and the arrow chooses what and how far

| On | Does | Feedback |
| --- | --- | --- |
| `Allow` | Lets this call run, once | The block goes and the tool row carries on |
| `Deny` | Refuses this call, once; the agent is told and carries on without it | The block goes and the tool row shows the refusal |
| The arrow | Opens that answer's menu and closes the other | The chevron's button reads as pressed; the menu scrolls into view |
| A segment under `Allow what` | Chooses the width the answer covers for that request: this subcommand, or every command of the program. The choice is shared by both menus | The segment fills; the `Add to` sentences change to the line that would be written |
| `… once` | The same as the button | As above |
| `… for this run` | Answers, and remembers each asking request at its chosen width until the task's run ends. Nothing is written. A tool with no command line is remembered by the tool | As above; the next line holding the same request does not ask |
| `Add to {name}, in this project` / `for all projects` | Writes each asking request at its chosen width into the toolset file that asked, in `.jaira/` or in `~/.jaira/`, then answers and remembers the same for this run. A layer that does not hold the file gets an override that starts from the nearest lower layer's by its explicit root and adds the line; a layer that holds it gets the line added in place, its layout kept. What ships is never written | As above. A write that fails answers nothing: the block stays and the error notice says why |
| Pointer over a request, on the line or in its row | Nothing | Both light: the tint deepens to 26% and the row takes the hue at 9% |
| A press outside the menu, or Escape | Closes the menu | |

## The copy names the tool, the requests, the toolset and the line to be written

| Where | String |
| --- | --- |
| Heading | `Approve this command?` |
| Tool | `{tool}`, such as `Bash` or `write_file` |
| Line | `{command}`, or `{input as indented JSON}` |
| Row | `{words} → {subject}` · `{path or url}` · `inside {embedder}` · `whatever find matches under {path}` · `no line names {subject} — any other command` · `allowed` / `asks` / `denied` |
| Reason | `Toolset {bucket/name}: {entry} asks` · `This state's toolset: {entry}, {entry} and {entry} ask` · `Toolset {name} holds no line for {subject}, so it asks` · `Policy: {reason}` |
| Answers | `Allow` · `Deny` |
| Menu, what | `Allow what` / `Deny what` · `{subcommand}` · `every {program} command` |
| Menu, how far | `Allow once` — `this call only` · `Allow for this run` — `until this task ends; nothing is written` · `Add to {name}, in this project` · `Add to {name}, for all projects`; the same four under `Deny` |
| Menu, what is written | `writes "{subject}": "{allow or deny}" to {file}` · `creates {file} with "{subject}": "{mode}", following the built-in toolset` or `the shared toolset` · `— this project's own copy still wins here` |
| Menu, why not | `This toolset is written on the state itself, so there is no toolset file to add a line to.` · `This line could not be read well enough to remember an answer about it, so it is asked about every time.` · `Part of this line could not be read; that part is asked about every time.` |
| Failed answer, modal only | `{error}` |

## The command is never cut, and nothing about the block moves the focus

- In the conversation it spans the sheet, from the 360px context panel to a wide conversation column; the modal is 380px wide at least and at most 720px or nine tenths of the window.
- The line's box wraps long lines anywhere and scrolls inside itself past 320px, so a long command is always shown whole. A row cuts its words with an ellipsis and carries them whole in its title; the line above is where they are read in full.
- The menu is at most 460px or 86% of the window wide; its sentences wrap, and a file path is shortened to its ends, `.jaira/toolsets/…/writes-asking.json`.
- Theme: every colour is a token; the hues, the reason's `--warn` and `Deny`'s `--bad` hold in both themes.
- Focus: the block takes no focus when it arrives, and the modal does not trap it. Tab reaches `Allow`, its arrow, `Deny`, its arrow; with a menu open, its segments and its items follow their arrow. The arrow carries `aria-expanded` and names itself `Allow: what it covers and how far it reaches`; the segments are radios. Escape closes a menu and does not close the modal.
- Missing content: with no reason there is no reason line; with no parts there are no rows and no `Allow what`.

## The tool's name and what a line is made of depart from the two voices

- The tool's name is data, such as `write_file`, and is set in the app face.
- Subjects, toolset names, widths and the line to be written are data and are set in the data face, inside sentences in the app face.
