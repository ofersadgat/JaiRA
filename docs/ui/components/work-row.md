---
id: ui/components/work-row
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/stream-then-settle, ux/patterns/nested-under-what-caused-it, ux/patterns/drill-in-and-back-out]
serves: [product/watch-agents-work-live, product/complete-record-of-every-run, product/failures-explain-themselves, product/agents-ask-instead-of-guessing, product/read-what-work-produced]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/files-view]
reuses: [ui/components/value-view, ui/components/choice-list, ui/components/question-stepper, ui/components/transcript, ui/components/icon]
implemented_by: [packages/app/src/renderer/transcriptView.tsx, packages/app/src/renderer/transcript.ts]
verified_by: [packages/app/test/transcript.test.ts, packages/app/test/choices.test.ts]
mockups: [ui/assets/work-row/success.html, ui/assets/work-row/live.html, ui/assets/work-row/error.html, ui/assets/work-row/open.html, ui/assets/work-row/subagent.html, ui/assets/work-row/shown.html, ui/assets/work-row/workflow-tools.html]
siblings: [ui/components/message, ui/components/run-step-note, ui/components/computed-state-body, ui/components/agent-question]
---

# Work row

A dense single line between the messages of a conversation: a small glyph, a bold tool name, a grey mono argument, the time, a chevron and a green tick or red cross, which opens underneath into what the call was given and returned.

## A workflow tool's row says what it was called FOR, and what it did under it

The eight workflow tools ([decision 0005](../../engineering/decisions/0005-connect.md) §3) are work rows like any other, with two differences a reader sees:

- **The glyph is the forking path** — the one a `made` or an `entered` note wears — because a row that starts or moves work is the same kind of fact as the note it leaves behind. Matched by exact name, not by the family heuristic, which would otherwise read `tasks` as an agent and `move` and `release` as writes.
- **The grey line is the call in its own words**, not its first string argument: `feature/product · issue: "Let a person pause…"`, `Pause and stop → feature/ux · skip`, `Pause and stop · Resume a paused run`. It is `workflowToolSummary` in `@jaira/shared`, pure over the arguments, so a record read a year later draws the same line.
- **A `start` or a `move` that succeeded leaves a NOTE under its row** — "adopted into **Feature workflow** as `product` · standing at `ux`" — drawn from what the tool answered, in the note's own glyph, verb and monospace ending. A refused call draws none: the row's cross and its result say it once already.

## A work row is one thing that happened while an agent worked

**Use when.** A transcript draws a tool call with its result, a block of reasoning, or a recorded fact such as a policy decision, a move to the next state, a provider event or how a call ended. The three are one row with three tones.

**Do not use when.** Someone said something: use [message](message.md). The machine moved between states in a run, on the grey between sheets: use [run-step-note](run-step-note.md). A state that never spoke and only called functions: use [computed-state-body](computed-state-body.md). An agent's question still waiting for an answer: use [agent-question](agent-question.md); the row only shows the question once it is asked and answered.

## The glyph and name say what kind of work it was, and the mark says whether it worked

- **Line.** 7px between parts, 3px by 6px inside, 6px corners. A row that opens is a button with a pointer and a 9% `--accent` wash under it.
- **Glyph.** A 14px line glyph in a 16px slot, `--dim`. A call's glyph follows its tool's name: a box with antennae for a task, agent or delegate, a globe for web, fetch or browser, a prompt for bash, shell or command, a pencil in a square for write, edit, patch or delete, an eye for read, view or show, a lens for search, grep, glob or list, and a wrench otherwise. Reasoning is a sparkle; a fact is a circled i, or a circled ! when it warns.
- **Name.** The app face at 12/12.5 of the app size, weight 600, `--text`; it ellipsises before the argument does. A fact has none.
- **Argument.** The data face at 11.5/12 of the data size in `--dim`, taking the rest of the line and cut first. Reasoning and facts are sentences in the app face at 12/12.5.
- **Note.** Before the time and never shrinking, the app face at 11/12.5: `Thought for {t}` in `--dim`, or while live three breathing dots and a count in `--accent`.
- **Time and end.** The time in the data face at 11/12 with tabular figures, a 14px slot with a `--tok-hint` chevron for a row that opens, then a 14px slot with a `--ok` tick or a `--bad` cross.
- **Tones.** Reasoning and plain facts are muted: words `--dim`, glyph `--tok-hint`. A warning fact takes `--warn` for glyph and words. A failed call or a bad fact takes `--bad` for glyph, name, words and mark.
- **Opened.** Under the line, 28px in with 12px inside a 1px `--rule` line: for a call, a subagent's conversation first, then the `arguments`, the `result` and the agent's own `record`, each a [value-view](value-view.md) with that label; for reasoning, the whole text in italic `--dim` app face at line height 1.6.
- **Shown without opening.** 28px in with no rule: an agent's question as it was answered, drawn read-only by [choice-list](choice-list.md) or [question-stepper](question-stepper.md), a page the call produced, or the value a call delivered as the state's output, labelled with the output's name.

## The row changes its note, its mark and its tone as the work goes on

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a row; inside an opened row a payload nothing recorded reads `no {label} was recorded` in italic `--tok-hint`. | [open.html](../assets/work-row/open.html) |
| loading | Shown as live. | [live.html](../assets/work-row/live.html) |
| partial | Shown as live. | [live.html](../assets/work-row/live.html) |
| live | Reasoning in progress counts `Thinking for {t}` in tenths of a second in `--accent`. A call whose arguments are still being written shows `writing {size}` with the dots, has no chevron or mark and never opens. A call waiting for its result has no mark, and opened reads `still running`. Where the Chat view's status line narrates the turn, the writing row is not drawn and reasoning stops counting. | [live.html](../assets/work-row/live.html) |
| success | A tick in `--ok` on each finished call; settled reasoning states `Thought for {t}` on the first block of a turn; facts in the muted tone. Reasoning the provider withheld reads `(withheld by the provider)` and does not open. | [success.html](../assets/work-row/success.html) |
| error | A failed call is red from glyph to cross and keeps its own glyph. A policy, question or dropped-events fact is amber; a failure or block is red. | [error.html](../assets/work-row/error.html) |
| open | The chevron turned over and the payloads or the reasoning hung off the rule. | [open.html](../assets/work-row/open.html) |
| subagent | A call that started a subagent reads `⑂ {what it was asked}`. Opened, its conversation comes first inside a 2px `--accent` rule under `SUBAGENT CONVERSATION · {n} ENTRIES` with `WALK IN →` at the right, drawn as a nested [transcript](transcript.md) that streams while the subagent works. | [subagent.html](../assets/work-row/subagent.html) |
| shown | An asked question under its row with the answers lit, or empty while still asked; a produced page or a delivered output drawn under its row. These rows are never folded away. | [shown.html](../assets/work-row/shown.html) |

## Clicking the line opens it in place and the doorway leads into the subagent

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a row that opens | Nothing | A 9% `--accent` wash under the line |
| Click, Enter or Space on the line | Opens or closes what is underneath | The chevron turns over in 0.18s and the body appears or goes |
| `walk in →` | Opens the subagent's conversation as its own page, one step further along the address | The page shows the subagent's transcript and a crumb for it |
| A payload's readings or `…` | See [value-view](value-view.md) | |

## The copy is the tool's own words and a few plain sentences about time and absence

| Where | String |
| --- | --- |
| Name | `{tool name}` · `thinking` · `result` for a result with no call · `stream` for a raw stream item |
| Argument | `{what identifies the call}` · `⑂ {what the subagent was asked}` · `{reasoning on one line}` · `{fact}` |
| Reasoning note | `Thinking for {t}` · `Thinking…` · `Thought for {t}`, where `{t}` reads `0.4 seconds`, `12.4 seconds` or `2 m 5.3 s` |
| Withheld reasoning | `(withheld by the provider)` |
| Writing note | `writing {size}` in `B`, `KB` or `MB` · `writing…` |
| Payload labels | `arguments` · `result` · `record` · `detail` · `{output name}` or `output` |
| Nothing recorded | `no {label} was recorded` · `still running` |
| Subagent | `subagent conversation · {n} entries`, drawn uppercase · `walk in →` |
| Facts | `went to {state id}` · `went to the next state` · `policy` · `interaction` · `failure` · `blocked` · `session started` · `context compacted` · `{type}: {subtype}` · `provider event` · `{n} stream events were dropped before anything could show them` · `unreadable native line` · `context: {sub}` · `queued: {operation}` |
| How a call ended | `the process ended before this call finished — everything above is what had been recorded` · `this call failed` |

## The line never wraps and the time column stays aligned

- Resize: the argument is cut first, then the name; the note, time, chevron and mark never shrink, so the times form one column down the right edge. An opened payload wraps or scrolls inside its own value.
- Theme: every tone is a token, and a failed call is marked by its cross as well as its colour.
- Focus: a row that opens is one tab stop; `walk in →` and the payload controls follow when open. A row that does not open is not a tab stop.
- Missing content: a call with no time leaves its time slot empty; a nested subagent conversation offers `walk in →` only where the host can open one.

## The row's sizes and the subagent head depart from the type registers

- Name, argument, note and time use their own multiples of the base sizes rather than registers.
- The subagent head uppercases a count, which is data.
