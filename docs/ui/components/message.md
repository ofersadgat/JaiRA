---
id: ui/components/message
type: ui-component
status: shipped
updated: 2026-09-22
realizes: [ux/patterns/one-document-several-readings, ux/patterns/verbs-on-the-thing-itself, ux/patterns/arm-the-cut-then-confirm]
serves: [product/chat-with-agents, product/complete-record-of-every-run, product/rewind-to-where-it-went-wrong, product/try-another-direction, product/read-what-work-produced]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context, ui/surfaces/files-view]
reuses: [ui/components/value-view, ui/components/markdown-view, ui/components/context-menu, ui/components/icon]
implemented_by: [packages/app/src/renderer/transcriptView.tsx, packages/app/src/renderer/transcript.ts, packages/app/src/renderer/messageTypes.ts]
verified_by: [packages/app/test/transcript.test.ts, packages/app/test/transcriptCut.test.ts, packages/persistence/test/sessionStore.test.ts, packages/app/test/taskConnect.test.ts]
mockups: [ui/assets/message/success.html, ui/assets/message/hovered.html, ui/assets/message/structured.html, ui/assets/message/empty.html, ui/assets/message/doomed.html, ui/assets/message/sent-for-you.html]
siblings: [ui/components/work-row, ui/components/agent-question, ui/components/run-step-note, ui/components/composer]
---

# Message

One thing said in a conversation: a rounded blue-tinted bubble at the right for what was sent, full-width rendered prose for an answer, or a quiet block behind a grey rule under a small orange role word for a system prompt, each with a line of small controls under it that appears on hover.

## A message is one entry said by a person, a model or the frame a run was given

**Use when.** A [transcript](transcript.md) draws something sent, an answer, or a system prompt or any other role a provider records.

**Do not use when.** The answer is still arriving: the transcript draws it as plain text with `writing…`. A tool's arguments and result, reasoning and recorded facts are [work-row](work-row.md)s. An agent's question waiting for an answer is [agent-question](agent-question.md), and a machine step between sheets is [run-step-note](run-step-note.md).

## Who spoke is read from where the words sit before they are read

- **Sent.** Right-aligned, at most 78% of the column, 14px above and 10px below. The bubble has 8px by 13px inside, 16px corners with a 5px bottom-right corner, a ground of 13% `--accent` mixed into `--panel` and a border of 24% `--accent` mixed into `--line`. Plain text is shown as written in the app face at 13/12.5 of the app size with line height 1.6.
- **Answer.** Across the full column, 10px above and 14px below, drawn as markdown through [markdown-view](markdown-view.md) at 13.5/12.5 with line height 1.65.
- **System prompt and other roles.** Full width behind a 2px `--rule` line with 12px inside. The role word sits 3px above the text in the app face at 10/12.5, weight 600, uppercase with 0.07em tracking in `--warn`; the text is `--dim`.
- **Sent, but not typed by the person.** What was said to the model stays on the right whoever wrote it; a message the person did not type wears a source badge and a quieter bubble. The record marks it on the entry (`by`, `MessageAuthor`): `host` for a message the app sent on the person's behalf (the opening turn of a conversation a drop made to ask for an input), `workflow` for a state's prompt in a run and for every system prompt. The badge sits 4px above the bubble, right-aligned: a pill with 999px corners, a 1px border of 28% `--accent` in `--line`, a ground of 7% `--accent` in `--panel`, 1px by 7px inside, the app face at 10.5/12.5, weight 500, in `--dim`, led by an 11px glyph in `--accent` (the send arrow for the app, the workflow glyph for the workflow). The bubble's ground drops to 5% `--accent` in `--panel` and its border turns dashed, 30% `--accent` in `--line`. On a system prompt the same badge sits on the role word's line, 8px after it.
- **Structured output.** Where an answer is the state's declared value, the value is drawn in place of its JSON text through [value-view](value-view.md) without its header, and the output's name leads the controls.
- **Controls.** A 22px line 4px under the words, invisible until the pointer is over the message, focus is inside it or one of its menus is open, then fading in over 0.14s; right-aligned under a sent bubble. In order: icon buttons with 13px glyphs in `--dim`, a 1px `--line` divider, the output's name in the data face at 10/12 in `--dim`, a type chip and a reading chip, then at the far right the time in the data face at 10.5/12 with tabular figures, and `…`.
- **Chips.** A 1px `--line` border, 6px corners, `--panel` ground, the app face at 10.5/12.5 in `--dim`; the type chip leads with its family's glyph, and each ends in a small `▾`. A chip the person has set turns `--accent` with a border of 42% `--accent` in `--line`.

| Where | Verbs offered |
| --- | --- |
| A sent message in a chat | Copy, Edit, Rewind, Fork |
| An answer in a chat | Copy, Rewind, Fork |
| Any message in a run, a subagent or the Files view | Copy |

The reading chip is drawn only when the type has more than one reading. `…` is drawn only where the window can keep a value in a context panel.

## Each message changes only its tint, its fade and what its controls hold

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A sent message with no text reads `(empty)` in the bubble in small `--dim`; an answer with nothing recorded reads `(no answer was recorded)` in `--dim`. | [empty.html](../assets/message/empty.html) |
| loading | Cannot occur: a message is drawn from what was recorded or sent, never fetched on its own. | |
| partial | A message sent but not yet in the record draws as a sent bubble. Its controls offer no Edit, Rewind or Fork, and a type chosen for it is not remembered. | [success.html](../assets/message/success.html) |
| error | Cannot occur: a failed send is reported above the composer, not on the message. | |
| success | Sent, answer and system prompt at rest, controls hidden. | [success.html](../assets/message/success.html) |
| hovered | The controls shown under the message the pointer is over. After Copy the copy glyph is a tick for 1.4 seconds. The time is the clock alone for today, or the day and month before it for an earlier day. | [hovered.html](../assets/message/hovered.html) |
| structured | An answer that is the state's output drawn as its value, with the output's name before the type chip. A message whose type the person set shows that chip in `--accent`. | [structured.html](../assets/message/structured.html) |
| doomed | Past an armed rewind: the whole message at 38%, and a sent bubble loses its tint to a `--panel-2` ground with a `--line` border. | [doomed.html](../assets/message/doomed.html) |
| sent-for-you | A message the person did not type: the app's opening turn in a conversation a drop made, and a run's system prompt and state prompt, each badged with its source; the person's own reply beside them is bare. | [sent-for-you.html](../assets/message/sent-for-you.html) |

## The controls act on the message they sit under

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over, or focus inside | Reveals the controls | The line fades in |
| Copy | Copies the text, or the value as indented JSON | The glyph is a tick for 1.4 seconds |
| Edit | Puts the message's text in the composer to be sent in its place | The composer shows the replacing banner, as [chat-view](../surfaces/chat-view.md) draws it |
| Rewind | Arms a deletion from before this message, or after this reply | The banner asks, and this message or the one after it and everything below fade under the cut line |
| Fork | Arms a new conversation from before this message, or after this reply | The composer shows the forking banner |
| Type chip | Opens `This text is`, whose rows re-read the message as that type, remembered for this message; `Use for every message here` remembers it for the conversation | The body redraws, the chip names the type in `--accent` |
| Reading chip | Opens `Read it as`, listing this type's readings | The body redraws in that reading, the chip in `--accent` |
| `…` | Opens `Open in context panel` | The value is kept in the context panel, titled with the output's name, `Message` or `Answer` |

The rows and notes of the two menus are listed in [context-menu](context-menu.md).

## The copy names each verb, what it would delete and what the text is

| Where | String |
| --- | --- |
| Empty | `(empty)` · `(no answer was recorded)` |
| Role word | `{role}`, such as `system` |
| Source badge, the app | `Written by JaiRA` · tooltip `JaiRA wrote and sent this for you — you did not type it` |
| Source badge, the workflow | `From the workflow` · tooltip `The workflow's words for this call — written by its author, not typed here` |
| Copy | tooltip and name `Copy` |
| Edit | tooltip `Edit` · name `Edit this message` |
| Rewind, sent message | tooltip `Rewind to before this message — it and everything after it are deleted` · name `Rewind to before this message` |
| Rewind, answer | tooltip `Rewind to this reply — everything after it is deleted` · name `Rewind to this reply` |
| Fork, sent message | tooltip `Fork before this message — a new conversation that shares everything up to here` · name `Fork before this message` |
| Fork, answer | tooltip `Fork after this reply — a new conversation that shares everything up to here` · name `Fork after this reply` |
| Type chip | `{type}`, such as `Markdown` · tooltip `{type} — {media type}`, adding `, set by you (JaiRA said {detected type})` once set |
| Reading chip | `Rendered` · `Preview` · `Files` · `Code` · `Source` · `JSON` · `Data` · `Diff` · `Table` · `Form`, its tooltip what that reading does |
| Menu titles | `This text is` · `Read it as` |
| More | `…` · tooltip `What else can be done with this` · `Open in context panel` with `keeps it on screen while you carry on` |
| Time | `{time with seconds}` today · `{day} {short month}, {time with seconds}` otherwise · tooltip `{full local date and time}` |

## Messages wrap within the column and their controls stay reachable by keyboard

- Resize: a bubble grows to 78% of the column and wraps inside it; an answer takes the whole width. Long unbroken strings wrap anywhere. The controls wrap onto a second line when narrow.
- Theme: bubble tint, border, role word and chips are mixed from tokens, so both themes keep them apart.
- Focus: every control is a native button in the tab order, and focus reaching one reveals the whole line. With reduced motion the line appears without fading.
- Missing content: a message with neither text nor output draws only its verbs and its time, with no divider or chips.

## The icon-only verbs and a few sizes depart from the direction

- Copy, Edit, Rewind and Fork are glyphs without a word, named only by tooltip and accessible name.
- The role word is a provider's word set in the app face and uppercased.
- The `▾` is set at a literal 8px at 70% opacity, and the hidden controls use opacity rather than a register.
