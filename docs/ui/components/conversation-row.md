---
id: ui/components/conversation-row
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/live-facts-and-unseen-counts, ux/patterns/verbs-on-the-thing-itself, ux/patterns/name-it-where-it-will-live]
serves: [product/chat-with-agents, product/see-what-changed-since-you-looked, product/all-projects-in-one-place, product/try-another-direction]
surfaces: [ui/surfaces/conversation-list]
reuses: [ui/components/icon, ui/components/context-menu]
implemented_by: [packages/app/src/renderer/chatPane.tsx, packages/app/src/renderer/icons.tsx]
verified_by: []
mockups: [ui/assets/conversation-row/read.html, ui/assets/conversation-row/selected.html, ui/assets/conversation-row/forked.html, ui/assets/conversation-row/at-root.html, ui/assets/conversation-row/renaming.html]
siblings: [ui/components/task-card, ui/components/sidebar-row, ui/components/project-row, ui/components/file-tree]
---

# Conversation row

One line in the sidebar's list of conversations: a 7px dot at the left, filled blue when the newest reply is unread and a hollow grey ring once read, the conversation's title ending in an ellipsis, led by a small fork glyph when it was forked, a tinted project chip at the root, and the time since it last moved at the right, replaced by a turning blue ring while it answers.

## A conversation row stands for one chat conversation in the sidebar

**Use when.** A chat conversation is listed in the [conversation-list](../surfaces/conversation-list.md) drawer, inside one project or across every open project at the root.

**Do not use when.** The item is a piece of process work on a board: use [task-card](task-card.md). The line is a place in the sidebar rather than a conversation: use [sidebar-row](sidebar-row.md) or [project-row](project-row.md). The item is a file: use [file-tree](file-tree.md).

## The unread mark reads first down the list, then the title, then how recent it is

- **Line.** App text at the app base, padded 4px by 8px with 6px corners, parts 6px apart, on the sidebar's `--panel-2` ground.
- **Mark.** A 7px circle that never shrinks: a 1px `--line` ring when read, filled `--accent` when the newest reply came after the person last read it. Both states keep the same size, so titles stay aligned.
- **Title.** Takes the spare width and ends in an ellipsis. A forked conversation starts with an 11px fork glyph in a 70% mix of `--accent` into `--dim`, 4px before the words.
- **Project chip.** At the root only, before the time: the project's name in the data face at 0.79 of the data size, on a 16% wash of the project's hue with a 5px dot in the hue, fully rounded. The shared root wears grey.
- **Time.** At the far right in `.app-secondary`: `now`, then minutes, hours and days. While the conversation is answering, a 12px turning ring in `--accent` stands in its place.
- **Selected.** The open conversation's line sits on a 14% `--accent` wash.

## Every state keeps the mark's column and changes the ground, the glyph or the far end

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a row exists only for a conversation, and an empty list is the drawer's own sentence. | |
| loading | Cannot occur: a row is drawn from what the list already knows, and a conversation still being created appears once it exists. | |
| partial | Cannot occur: every conversation has a title, a time and a mark. | |
| read | Unread rows with a filled `--accent` dot, read rows with a hollow ring, each with its time. | [read.html](../assets/conversation-row/read.html) |
| selected | The open conversation on the `--accent` wash, its dot hollow once read. A conversation answering now shows the turning ring in place of its time, selected or not, read or unread. | [selected.html](../assets/conversation-row/selected.html) |
| forked | The fork glyph before the title; the tooltip names the conversation it came from and where, or `a task since deleted`. | [forked.html](../assets/conversation-row/forked.html) |
| at root | Every row carries its project chip in the project's hue, the shared root's in grey. | [at-root.html](../assets/conversation-row/at-root.html) |
| renaming | The row is one text box filling the line, with a 1px `--accent` edge, 4px corners, 2px by 4px padding on `--bg`, holding the title and the caret. No mark, chip or time. | [renaming.html](../assets/conversation-row/renaming.html) |
| error | Cannot occur on the row: a failed rename keeps the old title, and a failed conversation is still listed as a conversation. | |

## A click opens the conversation and a right-click offers its verbs

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over | Nothing | No visible change: the hover ground is `--panel-2`, the same as the sidebar's |
| Click | Opens that conversation in the chat view, in the row's own project at the root | The row takes the `--accent` wash; reading it hollows the dot |
| Right-click | Opens `Open`, `Rename…`, `Copy task id` and `Delete…` at the pointer in a [context-menu](context-menu.md) | The menu at the pointer |
| `Rename…` | Turns the row into its text box | The box with the caret in it |
| Enter in the box | Saves a changed, non-empty title | The row returns with the new title |
| Escape, or leaving the box | Keeps the old title | The row returns unchanged |
| `Delete…` | Asks first in the [confirm dialog](../surfaces/confirm-dialog.md) | The dialog; confirming removes the row |

## The copy is the title and a short age

| Where | String |
| --- | --- |
| Title | `{conversation title}` |
| Time | `now` · `{n} min` · `{n} h` · `{n} d` |
| Mark tooltip | `The latest reply has not been read` · `Read` |
| Turning ring tooltip | `Answering now` |
| Title tooltip, forked | `forked from {parent title}, {where}`, with `a task since deleted` for a parent that is gone |
| Project chip | `{project name}` · tooltip `{absolute path}` |
| Menu | `Open` · `Rename…` · `Copy task id` · `Delete…` |

## The row gives up its title first and keeps its mark, chip and time whole

- Width: the drawer's, from 180 to 520px. The title ends in an ellipsis; the mark, chip, time and ring never shrink. The whole title is read in the chat view's title bar, and the row has no tooltip for it unless forked.
- The time is worked out when the list is drawn, so an idle list can show `4 min` for longer than four minutes.
- Theme: the dot, washes, hue chip and ring are tokens with a light and a dark value. With reduced motion the ring stands still.
- Focus: rows are not reached by Tab and take no keys; opening, the menu and renaming need a pointer. The rename box takes focus when it appears and has no name for a screen reader.

## The row departs from the direction in its type and its selection

- Conversation titles are data set in the app face.
- Selection is a wash of its own rather than the shared active state's three properties.
