---
id: ui/components/composer
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/button-says-what-will-happen, ux/patterns/pick-from-what-exists, ux/patterns/arm-the-cut-then-confirm, ux/patterns/second-deliberate-step-for-irreversible]
serves: [product/chat-with-agents, product/steer-agents-mid-task, product/rewind-to-where-it-went-wrong, product/try-another-direction]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/composer-setting-chip, ui/components/model-cascade, ui/components/icon]
implemented_by: [packages/app/src/renderer/composer.tsx, packages/app/src/renderer/chatPane.tsx, packages/app/src/renderer/runViews.tsx]
verified_by: [packages/app/test/composer.test.ts]
mockups: [ui/assets/composer/empty.html, ui/assets/composer/composing.html, ui/assets/composer/busy.html, ui/assets/composer/disabled.html, ui/assets/composer/error.html, ui/assets/composer/armed.html]
siblings: [ui/components/activity-strip, ui/components/composer-setting-chip, ui/components/transcript]
---

# Composer

A rounded message box inside a thin grey ring on the page ground: attached files as small pills above the text, and under it a row of borderless chips naming the model, thinking, permissions and tools, then a paperclip and a round blue send arrow, with a red square stop beside it while a turn runs.

## A composer is the one place a message is typed into a conversation

**Use when.** A person sends a message into a conversation: the first message of a chat, a reply in a chat, or a message into the state of a run that holds a conversation, including while that state is still running. An edit, fork or rewind armed from a chat message puts its banner above the composer.

**Do not use when.** The part of the run on screen holds no conversation: the [activity-strip](activity-strip.md) stands in the composer's place. A person answers a question from the process or an agent: [gate-surface](gate-surface.md) and [agent-question](agent-question.md) take the answer. A note on a passage is [review-notes](review-notes.md).

## The text reads first, the settings under it, and the send button last

- **Band.** 10px above, 16px at the sides and 14px below, on `--bg`. The ring and everything in it are at most 900px wide and centred.
- **Ring.** A 1px ring in `--line` with 22px corners around a `--panel` shell. It turns a 55% mix of `--accent` while anything inside has focus, and solid `--accent` while files are dragged over the composer, without moving the contents.
- **Pills.** Above the text when files are attached, wrapping, 6px apart: a paperclip glyph, the name, a dim note when only the name will go, and a `×`. Each pill is `--panel-2` with a 1px `--line` edge, fully rounded, at most 260px wide.
- **Text.** The app face at 13.5/12.5 of the app size with line height 1.55, placeholder in `--tok-hint`. It starts 54px tall and grows with its content to 40% of the window height, then scrolls.
- **Mention list.** While a path is being typed after `@`, a `--panel` card with a lifted shadow and 10px corners just above the shell, holding up to eight matching project paths, each centred on its line in the app face.
- **Footer.** Left to right: the four [composer-setting-chip](composer-setting-chip.md)s, an amber note when a setting cannot be known before the run, the free space, the live words, the 26px paperclip in `--dim`, the 30px round `--bad` stop with a `--panel` square, and the 30px round `--accent` send with a `--panel` arrow that greys to `--panel-2` when nothing can be sent.
- **Banner.** When a chat message's edit, fork or rewind is armed, one line above the ring on a 10% wash of `--accent`, or of `--bad` for a rewind: the sentence in `--dim` ending in an ellipsis, a ghost `Cancel`, and for a rewind a filled red `Rewind`.

## Every state keeps the ring and changes the buttons at the end of the footer

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | The host's placeholder, the chips naming what the message would run under, and a greyed send. | [empty.html](../assets/composer/empty.html) |
| loading | While the settings are read, Thinking and Permissions read `…`, the model chip reads `no model configured` beside a faint grey square, and Tools reads `no tools`. Typing and sending already work. Drawn second in the empty mockup. | [empty.html](../assets/composer/empty.html) |
| partial | Cannot occur: the text and the attachments go as one message or not at all. | |
| composing | Typed text lights the send button, and attachments alone light it too. Attached files stand as pills; one over 200,000 bytes or not text carries its note and sends only its name. Typing `@` at the start of a word, in a conversation with a project, opens the mention list. A drag over the composer turns the ring solid `--accent`. | [composing.html](../assets/composer/composing.html) |
| busy | In a chat thread or a run's conversation state: the stop and the send side by side, and `joins this turn` in `--accent` or `waits for this turn` in `--dim` with a pulse, saying what a message sent now does. The box that starts a conversation greys its send while the conversation is created and offers no stop. | [busy.html](../assets/composer/busy.html) |
| success | Sending clears the box and every pill at once, and the composer turns busy while the turn runs. | [busy.html](../assets/composer/busy.html) |
| disabled | The whole shell `--panel-2`, the reason as the placeholder, and the box, the paperclip and drops refused. A chat that can no longer be continued keeps a greyed send; a run with no state chosen yet that is still going shows the stop alone. | [disabled.html](../assets/composer/disabled.html) |
| error | A failed send puts the message in `--bad` on a 12% `--bad` wash above the ring, and the typed text stays. A setting that is an expression adds `{fields} is an expression here` in `--warn` after the chips. | [error.html](../assets/composer/error.html) |
| armed | A banner above the ring. Edit puts the old text in the box with `Say this instead…`; fork empties it with `Start the new conversation with…`; rewind empties it and waits for `Rewind`. The [chat view](../surfaces/chat-view.md) fades what a rewind would delete. | [armed.html](../assets/composer/armed.html) |

## Enter sends, and every other gesture shapes what goes

| On | Does | Feedback |
| --- | --- | --- |
| Enter | Sends the text and every attachment | The box and the pills clear |
| Shift+Enter | Breaks the line | The box grows |
| `@` at the start of a word, with a project | Offers up to eight project paths matching what follows; a space closes it | The list above the box |
| Enter or a click on a path, list open | Takes that path, Enter always the first | `@{path} ` in the box and the file as a pill |
| Escape, list open | Closes the list | The list is gone |
| Files dragged over, then dropped | Reads each file | Solid `--accent` ring, then a pill per file |
| Paperclip | Opens the system's file picker for several files | A pill per file |
| `×` on a pill | Removes that file | The pill is gone |
| Stop | Stops the turn in flight; in a run that is running or asking, cancels the task | The host's status line changes |
| A chip | Opens its popover, as [composer-setting-chip](composer-setting-chip.md) describes | The popover above the chip |
| `Cancel` on a banner | Disarms and empties the box | The banner is gone |
| `Rewind` on a banner | Deletes from the cut | The banner is gone and the thread ends at the cut |

## The copy says what Enter will do

| Where | String |
| --- | --- |
| Placeholder | `Ask for more changes…` in a run · `Ask for a change, or a question about the code…` to start a chat · `Reply…` · `Say this instead…` · `Start the new conversation with…` |
| Disabled placeholder | `This conversation cannot be continued.` · `Select a run to continue its conversation.` |
| Send tooltip | `Enter to send, Shift+Enter for a new line` · `Enter to send — this joins the turn in flight` while busy |
| Send, stop and paperclip names | `Send` · `Stop` with tooltip `Stop this turn` · `Attach files` |
| Live words | `joins this turn` · `waits for this turn` |
| Pill | `{name}` · note `{n} KB — too large to include` · `{type} — not text` or `binary — not text` · `could not be read` or the read's own message · tooltip `{note}` or `{n} characters` · `×` named `Remove {name}` |
| Expression note | `{field} is an expression here` · `{field}, {field} are an expression here` |
| Banner, edit | `Replacing “{first line}” — everything after it is left behind.` |
| Banner, fork | `Forking before “{first line}” — your next message starts a new conversation from there. This one is not changed.`, or `after` for a reply |
| Banner, rewind | `Rewind to before “{first line}” — the messages after it are deleted. This cannot be undone.`, with the word `before` left out for a reply · `Cancel` · `Rewind` |
| Message as sent | `{text}`, then for each file `Attached: {name}` over its fenced content, or `Attached: {name} ({note})` |

The first line quoted in a banner is its first non-empty line, cut at 60 characters.

## The composer narrows with its host and keeps its buttons whole

- Width: the band takes its host's width, from the 360px context panel to the chat column, and the ring stops at 900px. The chips give up width first, each ending in an ellipsis within its 210px; the live words, paperclip, stop and send never shrink. A pill's note wraps inside the pill.
- Popovers and the mention list open upward, because the composer sits at the foot of its column.
- Theme: ring, shell, pills, washes and buttons are tokens with a light and a dark value.
- Focus: Tab reaches the box, then each chip, then stop and send. The paperclip cannot be reached by keyboard. Arrow keys do not move through the mention list.
- Unsaved work: in a chat the typed text belongs to the open conversation, as the chat view states. Attachments and per-message settings belong to the composer and are lost when it goes.

## The send button and the banner depart from the direction

- Send, stop and the paperclip are glyphs without a word, named by their tooltips.
- Send fills with `--accent` where the one affirmative fill is `--fill-accent`, and the red `Rewind` sets its word in literal white.
- Paths in the mention list and the message quoted in a banner are data set in the app face.
