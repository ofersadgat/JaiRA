---
id: ui/components/command-approval
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/park-and-ask, ux/patterns/consent-to-exactly-what-was-shown]
serves: [product/risky-actions-wait-for-approval, product/agents-act-only-where-allowed]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/gate-modal, ui/surfaces/components-view]
reuses: [ui/components/icon]
implemented_by: [packages/app/src/renderer/components.tsx]
verified_by: [packages/app/test/approvals.test.ts]
mockups: [ui/assets/command-approval/asking.html, ui/assets/command-approval/outside-a-conversation.html]
siblings: [ui/components/agent-question, ui/components/gate-surface, ui/components/confirm-action-gate]
---

# Command approval

A block under a running agent's words, below a blue rule: a shield glyph and `Approve this command?`, the tool's name in small grey type, the exact command in a bordered mono box, an amber `Policy: …` line, three plain buttons that widen the allowance from left to right, and a red-outlined `Deny` alone on the row beneath.

## A command approval asks about one tool call that policy held back

**Use when.** An agent's tool call matched a policy rule that asks first, such as a command outside the allow list or a write outside the worktree, and the agent waits for a person to allow or deny it.

**Do not use when.** A running agent asks a question of its own: use [agent-question](agent-question.md). A process declares a yes-or-no on its next step: use [confirm-action-gate](confirm-action-gate.md). Code a process calls needs approving before work starts: that is the module approval dialog, which shows whole files.

## The command reads first, the reason second, and the answers last

- **Place.** In the conversation: under the transcript of the step whose agent is running, after a 2px `--accent` rule with 12px above it and 8px under it. With no task to hold it: alone in a centred modal on `--panel`, radius 12px, 18px padding and the lift shadow, over the window's scrim.
- **Heading.** A 16px shield glyph in `--dim`, then `Approve this command?` in `--text` at 17/12.5 of the app size, 8px above the tool line.
- **Tool.** The tool's name in `--dim` at 11/12.5 of the app size.
- **Call.** 12px under the tool, a box on `--bg` with a 1px `--line` border, radius 8px and 10px padding, in the data face at 12/12: the command line as written, or for a tool with no command line its whole input as indented JSON. Long lines wrap, and the box scrolls past 320px.
- **Reason.** `Policy: {reason}` in `--warn` at 12/12.5 of the app size, 10px under the box.
- **Answers.** A row 14px under the reason: `Allow once`, `Allow for this run`, `Always allow`, each in the plain button look with none filled. A second row 14px lower holds `Deny` outlined in `--bad`.

## The block asks until it is answered, then leaves nothing behind

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: the block is drawn only while a call waits on approval. | |
| loading | Cannot occur: the call arrives whole with the request, and a pressed answer shows nothing until the agent carries on. | |
| asking | In the conversation, as above. A tool with no command line shows its input as JSON in the box; a request with no reason has no `Policy:` line. | [asking.html](../assets/command-approval/asking.html) |
| outside a conversation | A request that names no task, in the modal. When an answer fails, the reason follows under `Deny` in `--bad` at 11/12.5 of the app size. | [outside-a-conversation.html](../assets/command-approval/outside-a-conversation.html) |
| error | In the conversation, a failed answer is reported in the window's [error-notice](../surfaces/error-notice.md) and the block stays as it was. | |
| success | Cannot occur as its own look: once answered the block goes, and the agent's tool row in the transcript shows the call running or refused. | |

## Every answer decides at once, and both wider allows end with the agent's call

| On | Does | Feedback |
| --- | --- | --- |
| `Allow once` | Lets this call run | The block goes and the tool row carries on |
| `Allow for this run` | Lets this call run, and the same tool run again without asking until the agent's call ends | As above |
| `Always allow` | The same as `Allow for this run`: nothing is kept past the agent's call | As above |
| `Deny` | Refuses this call; the agent is told and carries on without it | The block goes and the tool row shows the refusal |
| Pointer over a button | Nothing | The plain buttons' ground moves to `--panel-3`; `Deny` takes a `--bad` tint |

## The copy names the tool, the command and the rule

| Where | String |
| --- | --- |
| Heading | `Approve this command?` |
| Tool | `{tool}`, such as `Bash` or `write_file` |
| Call | `{command}`, or `{input as indented JSON}` |
| Reason | `Policy: {reason}`, such as `Policy: writes outside the worktree` |
| Answers | `Allow once` · `Allow for this run` · `Always allow` · `Deny` |
| Failed answer, modal only | `{error}` |

## The command is never cut, and nothing about the block moves the focus

- In the conversation it spans the sheet, from the 360px context panel to a wide conversation column; the modal is 380px wide at least and at most 720px or nine tenths of the window.
- The call's box wraps long lines anywhere and scrolls inside itself past 320px, so a long command is always shown whole.
- The three allows wrap onto more lines in a narrow host; `Deny` always keeps its own row.
- Theme: every colour is a token; the reason stays `--warn` and `Deny` stays `--bad` in both themes.
- Focus: the block takes no focus when it arrives, and the modal does not trap it. Tab reaches `Allow once`, `Allow for this run`, `Always allow`, then `Deny`. Escape does not close the modal.
- Missing content: with no reason there is no `Policy:` line.

## The tool's name departs from the two voices

- The tool's name is data, such as `write_file`, and is set in the app face.
