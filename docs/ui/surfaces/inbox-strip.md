---
id: ui/surfaces/inbox-strip
type: ui-surface
status: shipped
updated: 2026-09-13
kind: notification
realizes: [ux/patterns/waiting-requests-gathered, ux/patterns/ordered-by-urgency-then-recency, ux/patterns/park-and-ask]
serves: [product/everything-waiting-on-you-together, product/decisions-stay-yours, product/agents-ask-instead-of-guessing, product/risky-actions-wait-for-approval, product/all-projects-in-one-place]
components: [ui/components/status-pill]
mockups: [ui/assets/inbox-strip/empty.html, ui/assets/inbox-strip/success.html, ui/assets/inbox-strip/partial.html, ui/assets/inbox-strip/error.html]
siblings: [ui/surfaces/app-window, ui/surfaces/error-notice, ui/surfaces/gate-modal, ui/surfaces/task-context]
---

# Inbox strip

A 40px bar across the foot of the window to the right of the sidebar, under whichever room is open, that appears whenever an agent question, a command approval or a workflow gate waits on the person in any open project, and lists the first three with their projects. Its 40px come out of the viewport above it; it displaces nothing else and never scrolls away.

## The count reads first and each request follows with its project

- **Label.** `Awaiting you` in `.app-title`, sized down to 0.92 of the app base.
- **Count.** A filled `--warn` [status-pill](../components/status-pill.md) with `⏸` and the number of requests waiting across every open project.
- **Entries.** Up to three, separated by a `·` in `--tok-hint`. Each is a project chip, a rounded pill with a hairline border, a 5px dot in the project's hue on a 16% wash of it and the project name in mono in `--dim`, followed by the request's text in mono in `--text`. An entry is at most 320px wide and its text ends in an ellipsis.
- **Overflow.** `+{n} more` in `.app-secondary` at the far right, when more than three wait.
- **Ground.** `--panel` with a 1px `--line` rule on top, 14px side padding and 12px between parts.

Agent questions come first, then command approvals, then gates, at most two of each kind, cut to three in all. Two questions and one approval therefore hide every gate behind `+{n} more`. An entry says what kind of request it is only through its words. A task parked on a move to its next column is not listed.

| Request | Entry text | Entry tooltip |
| --- | --- | --- |
| Agent question | `{first question}`, or `the agent has a question` | `{every question}` joined by ` · ` |
| Command approval | `{command}`, or `{tool name}` when there is no command | `{policy reason}` |
| Gate | `{gate prompt}`, or `{component name}` | `{component name}` |
| Count pill | `{n}` | `{n} waiting on you` |

## The strip shows the waiting requests or is absent

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | Nothing waits: the strip is absent and the viewport runs to the bottom of the window. | [empty.html](../assets/inbox-strip/empty.html) |
| loading | Cannot occur: a request is listed the moment it arises, so the strip never waits for its list. | |
| success | One to three requests: the label, the pill with the total, and one entry each. An answered request leaves and the count drops. | [success.html](../assets/inbox-strip/success.html) |
| partial | More than three: the first three in kind order and `+{n} more`, which cannot be chosen. | [partial.html](../assets/inbox-strip/partial.html) |
| error | A request that outlives its project by a moment: its chip shows the folder's name in the grey `--p0` instead of the project's hue. | [error.html](../assets/inbox-strip/error.html) |

## A person never opens the strip, and each entry leads to where it is answered

- The strip appears in every room, Settings included, when the first request arrives in any open project, and goes when the last is answered.
- Choosing an entry switches to the Tasks room, selects that task in its own project and describes it in the context panel beside the board, where the question waits in its conversation under the state that asks it.
- Choosing an entry with no task behind it does nothing. A command approval with no task opens its own dialog over the window and is answered there.
- `+{n} more` does nothing; answering the visible requests brings the next ones into view.
- A gate survives closing the app and is listed again on reopening. Closing a project dismisses its agent questions and denies its command approvals, so their entries leave.

## The strip keeps its height and gives up request text as the window narrows

- Its width is the window's less the sidebar's. The label, pill and chips keep their size and the request texts shrink. At a 1280px window, three long entries squeeze `+{n} more` onto two lines.
- Theme: ground, rule, pill and project hues are tokens with a light and a dark value.
- Focus: entries are not focusable and take no keys, so the strip is pointer only. Pointing at an entry changes only the cursor. A new request is not announced to screen readers; the total is a tooltip.
- Unsaved work: none, because choosing an entry only moves the view.

## The strip sets two registers at sizes of its own

- `Awaiting you` and the request text take `.app-title` and `.data-text` at 0.92 and 0.875 of their bases instead of the registers' own sizes.
- The project name in a chip is set in the data face at a size taken from the app base.
