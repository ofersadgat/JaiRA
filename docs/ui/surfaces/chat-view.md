---
id: ui/surfaces/chat-view
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/stream-then-settle, ux/patterns/follow-the-live-edge, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/show-the-request-not-the-outcome, ux/patterns/arm-the-cut-then-confirm, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/choose-a-side-where-it-divided]
serves: [product/chat-with-agents, product/steer-agents-mid-task, product/watch-agents-work-live, product/rewind-to-where-it-went-wrong, product/try-another-direction, product/read-what-work-produced]
components: [ui/components/transcript, ui/components/message, ui/components/work-row, ui/components/produced-artifacts, ui/components/fork-mark, ui/components/composer, ui/components/composer-setting-chip, ui/components/model-cascade, ui/components/value-view, ui/components/splitter, ui/components/context-menu]
mockups: [ui/assets/chat-view/empty.html, ui/assets/chat-view/thread.html, ui/assets/chat-view/producing.html, ui/assets/chat-view/armed.html, ui/assets/chat-view/divided.html, ui/assets/chat-view/error.html]
siblings: [ui/surfaces/conversation-list, ui/surfaces/sidebar, ui/surfaces/context-panel, ui/surfaces/tasks-view, ui/surfaces/run-conversation, ui/surfaces/inbox-strip]
---

# Chat view

The Chat room: one conversation read as a single transcript on a white sheet with the composer under it, or, when none is open, a centred box asking what to do. It fills the window right of the sidebar, whose Chat row lists the conversations, and takes the place of the other rooms. It has no panel beside it until a value is pinned.

## The conversation reads first and the box to answer it sits under it

- **Title bar.** The open conversation's title, or `New conversation`, in the app face at the app base in `--dim`. It is a name, not an address, and has no crumbs.
- **Produced.** When the conversation has produced files, a [produced-artifacts](../components/produced-artifacts.md) strip above the scroller reading `Produced` and a count, which never scrolls away.
- **Thread.** A scroller on `--bg` holding a floating day chip and the [transcript](../components/transcript.md) on a `--panel` sheet at most 900px wide and centred: [message](../components/message.md)s, [work-row](../components/work-row.md)s and the gaps between turns.
- **Live status.** While a turn is in flight, one line between the thread and the foot on a faint `--accent` wash: a pulse, the verb in `--accent` at weight 600, what it works on in mono, and the time or size so far.
- **Foot.** Under a `--line` rule: the armed banner, then a red error line when a send failed, then the [composer](../components/composer.md) with its [composer-setting-chip](../components/composer-setting-chip.md)s and the [model-cascade](../components/model-cascade.md) behind the model chip.
- **Pinned value.** Choosing `Open in context panel` on any value adds a divider and a second column 420px wide holding that value, drawn by [context-panel](context-panel.md). Closing it returns the room to one column.

## The room offers a start, then shows the thread in whatever state its latest turn is in

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | No conversation open: `What are we doing?` at 1.6 times the app base, the sentence `This conversation works in the open project — it asks before it runs or changes anything.`, and the composer reading `Ask for a change, or a question about the code…` with chips showing what the first message will run under. With no project open the sentence is `No project is open, so this runs in JaiRA's own root. Open one to talk about your code.` and `@` offers no files. | [empty.html](../assets/chat-view/empty.html) |
| loading | The first message stands as a bubble while the conversation is created and read. With nothing yet on the page the sheet reads `Working…` while the conversation runs and `This conversation has not said anything yet.` otherwise. A failed re-read never blanks a thread that was already showing. | [producing.html](../assets/chat-view/producing.html) |
| thread | The settled conversation and the composer reading `Reply…`. | [thread.html](../assets/chat-view/thread.html) |
| producing | The answer arrives as plain text and settles into a message. The status line reads `Thinking`, `Answering`, `Writing`, `Running` or `Working`, with `Jump to live ↓` at its far end once the reader has scrolled away. The composer offers a stop button beside send and says whether a message sent now `joins this turn` or `waits for this turn`. | [producing.html](../assets/chat-view/producing.html) |
| armed | Editing, forking or rewinding from a message puts a banner above the box: an `--accent` wash for `Replacing “{first line}” — everything after it is left behind.` with the old text in the box and `Say this instead…`, or for `Forking {before or after} “{first line}” — your next message starts a new conversation from there. This one is not changed.` with an empty box and `Start the new conversation with…`; a `--bad` wash for `Rewind to before “{first line}” — the messages after it are deleted. This cannot be undone.` with `Cancel` and a filled `Rewind`. A rewind fades every message from the cut under `{n} messages below this line will be deleted`. | [armed.html](../assets/chat-view/armed.html) |
| divided | A forked conversation carries a torn seam reading `forked from: {parent title}, {label}` between what it inherited and its own turns; a deleted parent reads `a task since deleted`. A replaced message divides the thread at a seam reading `fork: {n} of {m} — {label}`, whose menu lists the sides; the side not taken shows no edit verbs and no live tail. Only the newest replacement is drawn, and it takes the place of the origin seam. | [divided.html](../assets/chat-view/divided.html) |
| error | A send or a start that failed puts its message on a `--bad` wash above the composer. A conversation that can no longer be continued greys the composer with `This conversation cannot be continued.`. | [error.html](../assets/chat-view/error.html) |

The first line quoted in a banner is cut at 60 characters. Rewinding to a reply rather than a sent message drops the word `before` and leaves two spaces in its place.

## The list in the sidebar opens a conversation and the conversation marks itself read

- The sidebar's `Chat` row inside a project, or `All conversations` at the root, opens the room with the [conversation-list](conversation-list.md) under the row. Its `+` opens the start box; at the root the start box works in JaiRA's own root.
- Choosing a row opens that conversation. Reading marks it read, and it marks itself read again each time it moves while open.
- Sending the first message creates the conversation, selects it and starts it.
- Forking from a message opens the new conversation once its first message is sent. The origin chip opens the conversation it came from.
- The room hosts no questions, approvals or gates. A question from a chat waits on the [inbox-strip](inbox-strip.md), which leads to the Tasks room.
- Leaving for another room, opening another conversation or deleting this one from its row's menu leaves the room.

## The thread follows its newest line and forgets an unsent message

- **Resize.** The sheet and the composer keep a 900px measure, centred, and narrow with the window. The pinned column's divider sets it between 280 and 1200px, a double-click restores 420px, and the width survives a restart.
- **Live edge.** While the reader is at the bottom, arriving text keeps the view there. Opening another conversation starts at its end, and sending pins the view to the end again.
- **Theme.** Sheet, bubbles, washes and seams are tokens with a light and a dark value.
- **Focus.** Nothing takes focus on arrival, the composer's box included.
- **Unsaved work.** The unsent message, its attachments, its per-message settings and an armed banner belong to the open conversation and are lost on opening another or leaving the room, with no warning.
