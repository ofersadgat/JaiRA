---
id: ui/surfaces/conversation-list
type: ui-surface
status: shipped
updated: 2026-09-13
kind: panel
realizes: [ux/patterns/filter-in-place, ux/patterns/ordered-by-urgency-then-recency, ux/patterns/live-facts-and-unseen-counts, ux/patterns/name-it-where-it-will-live, ux/patterns/verbs-on-the-thing-itself, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/absence-is-stated]
serves: [product/chat-with-agents, product/see-what-changed-since-you-looked, product/all-projects-in-one-place, product/keep-track-of-everything]
components: [ui/components/conversation-row, ui/components/context-menu, ui/components/sidebar-row]
mockups: [ui/assets/conversation-list/empty.html, ui/assets/conversation-list/listing.html, ui/assets/conversation-list/at-root.html, ui/assets/conversation-list/searching.html, ui/assets/conversation-list/renaming.html, ui/assets/conversation-list/menu.html]
siblings: [ui/surfaces/sidebar, ui/surfaces/chat-view, ui/surfaces/confirm-dialog, ui/surfaces/app-window]
---

# Conversation list

The drawer of conversations that hangs in the [sidebar](sidebar.md) under the `Chat` row of the open project, or under `All conversations` at the root, where it spans every open project: one line per conversation, newest activity first. It opens only while its row is the current room and closes when another row is chosen, taking the band's spare height and pushing the rows below it down. Its verbs `+` and `⌕` live on the row above it, not in the drawer.

## The rows read first, each led by a mark that says whether its last reply was read

- **Drawer.** Indented behind the sidebar's 1px `--line` drawer rule, 4px above and below, with 4px between the search field and the list.
- **Search field.** Only while the row's `⌕` is lit: a box on `--bg` with a 1px `--line` edge, 8px corners, 4px by 8px padding and app text at 12/12.5, reading `Search conversations`.
- **Rows.** App text at the app base, 4px by 8px padding, 6px corners and 6px gaps, from left to right:
  - a 7px mark, filled `--accent` when the newest reply has not been read and a hollow `--line` ring once it has;
  - the title, taking the spare width and ending in an ellipsis, led by an 11px fork glyph in a dimmed `--accent` when the conversation was forked from another;
  - at the root only, the project chip: a hairline pill with a 5px dot in the project's hue on a 16% wash of it and the project name in mono `--dim`;
  - the time since the last activity in `.app-secondary`, or, while the conversation is answering, a 12px turning ring in `--accent` in the time's place.
- **Selected.** The open conversation's row sits on a 14% wash of `--accent`. Pointing at any row gives it `--panel-2`.
- **Nothing to list.** One `--dim` line in place of the rows.

| Where | String |
| --- | --- |
| Search field | `Search conversations` |
| Nothing to list | `No conversations yet.` · `Nothing matches.` |
| Time | `now` · `{n} min` · `{n} h` · `{n} d` |
| Mark tooltip | `The latest reply has not been read` · `Read` |
| Turning ring tooltip | `Answering now` |
| Forked title tooltip | `forked from {parent title}, {where}`, with `a task since deleted` for a parent that is gone |
| Project chip tooltip | `{absolute path}` |
| Row menu | `Open` · `Rename…` · `Copy task id` · `Delete…` |
| Delete confirmation | `Delete "{title}"?` · `This deletes the conversation and everything said in it. None of it comes back.` · `Delete` · `Cancel` |

## The list is newest first, and says when it holds nothing

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | A project with no conversations reads `No conversations yet.` in `--dim`. A search with no match reads `Nothing matches.` under the field. Both are drawn side by side. | [empty.html](../assets/conversation-list/empty.html) |
| loading | Cannot occur as its own look: the list draws the conversations already known and grows as more arrive. A failed read at the root leaves the list empty, and it reads `No conversations yet.` | [empty.html](../assets/conversation-list/empty.html) |
| listing | Inside a project: rows newest first, the open one tinted, unread ones marked, one answering with its turning ring, and one forked with its glyph. | [listing.html](../assets/conversation-list/listing.html) |
| at-root | Under `All conversations`: every open project's conversations in one list, newest first, each carrying its project chip in the project's hue, the shared root's in grey `--p0`. | [at-root.html](../assets/conversation-list/at-root.html) |
| searching | `⌕` lit on the row, the field above the list holding the typed text, and only the conversations whose titles contain it. | [searching.html](../assets/conversation-list/searching.html) |
| renaming | One row replaced by a text box with a 1px `--accent` edge and 4px corners holding the title, with the typing caret in it. | [renaming.html](../assets/conversation-list/renaming.html) |
| menu | The row menu open at the pointer over the list, `Copy task id` and `Delete…` each under a rule, `Delete…` in `--bad`. | [menu.html](../assets/conversation-list/menu.html) |
| deleting | `Delete…` asks in the [confirm dialog](confirm-dialog.md) with the red note and the danger `Delete`; confirming removes the row. | [confirm-dialog](../assets/confirm-dialog/confirm.html) |

## A person opens the drawer from its row and leaves into the conversation

- Choosing `Chat` in the open project, or `All conversations` at the root, shows the [chat view](chat-view.md) and opens this drawer under the row.
- Clicking a row opens that conversation in the chat view, in the row's own project when the list is at the root. Reading it clears the row's mark.
- `⌕` on the row shows the field and puts the typing caret in it. Each keystroke narrows the list by title, ignoring case. Escape clears the text; turning `⌕` off hides the field and drops the filter.
- Right-clicking a row opens its menu at the pointer. `Open` opens it. `Copy task id` copies the conversation's task id with no sign on screen. `Rename…` turns the row into its text box: Enter saves a changed, non-empty title everywhere it is shown, and Escape or leaving the box keeps the old one. `Delete…` asks first.
- `+` on the row starts a new conversation in the chat view; at the root it belongs to the shared root.
- Choosing any other sidebar row closes the drawer.

## The drawer takes the band's height, and a typed search lasts only while its field shows

- **Resize.** The drawer is as wide as the sidebar allows, from 180 to 520px. Titles give up width first and end in an ellipsis; the chip and the time keep theirs. The list scrolls inside the drawer and the field stays above it.
- **Theme.** Marks, washes, the chip's hue and the turning ring are tokens with a light and a dark value.
- **Focus.** The search field and the rename box take focus when they appear. Rows are not reached by Tab and have no keys, so opening, the menu and renaming need a pointer. The search field is named only by its placeholder, and the rename box has no name.
- **Long or missing content.** A long title is cut to an ellipsis and read in full in the chat view's title bar. Times only change when the list is redrawn, so an idle list can show `4 min` for longer than four minutes.
- **Unsaved work.** A search is cleared when its field is hidden. A title typed into the rename box is discarded when the box is left.

## The list departs from the visual direction in one place

- Conversation titles are data set in the app face.
