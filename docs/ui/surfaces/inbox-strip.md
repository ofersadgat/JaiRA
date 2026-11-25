---
id: ui/surfaces/inbox-strip
type: ui-surface
status: shipped
updated: 2026-11-24
kind: notification
realizes: [ux/patterns/waiting-requests-gathered, ux/patterns/ordered-by-urgency-then-recency, ux/patterns/park-and-ask]
serves: [product/everything-waiting-on-you-together, product/decisions-stay-yours, product/agents-ask-instead-of-guessing, product/risky-actions-wait-for-approval, product/all-projects-in-one-place]
components: [ui/components/status-pill]
mockups: [ui/assets/inbox-strip/empty.html, ui/assets/inbox-strip/success.html, ui/assets/inbox-strip/partial.html, ui/assets/inbox-strip/error.html, ui/assets/inbox-strip/explore-status-bar.html, ui/assets/inbox-strip/explore-status-bar-2.html]
siblings: [ui/surfaces/app-window, ui/surfaces/error-notice, ui/surfaces/gate-modal, ui/surfaces/task-context]
---

# Inbox strip

A 40px bar across the foot of the window to the right of the sidebar, under whichever room is open, that appears whenever an agent question, a command approval or a workflow gate waits on the person in any open project. It lists them as project lanes: each project once, holding the top-level chats and tasks that something under them asks, each with its ring (design 09 of the second round of [status-bar mockups](../assets/inbox-strip/explore-status-bar-2.html), 2026-11-24). Its 40px come out of the viewport above it; it displaces nothing else and never scrolls away.

## The count reads first, then a lane per project

- **Label.** `Awaiting you` in `.app-title`, sized down to 0.92 of the app base.
- **Count.** A filled `--warn` [status-pill](../components/status-pill.md) with `⏸` and the number of requests waiting across every open project. A move's question is not one.
- **Lanes.** One per project, flush against each other and the strip's full height: the project's hue at 7% as ground and at 70% as a 2px edge on the left, 12px padding. The lane starts with a 7px dot in the hue and the project's name in the data face (600, the hue mixed 85% into `--text`), named once however many entries follow.
- **Entries.** Each is a top-level chat or task: the one a request's task rolls up to through its parents (`parentTaskOf`: the conversation that started a lesson review, the workflow whose element asks). Every request under it is gathered on one entry. An entry is the 22px ring the chat list draws (`RowRing`), with a segment per request, one more while it or an asking task works, and the oldest request's age in the middle. Its title follows in the app face at 12/12.5, at most 220px. Entries sit 12px apart.
- **Ground.** `--panel` with a 1px `--line` rule on top, 14px side padding and 12px between parts.

Requests are ordered by what blocks an agent first (a question, then an approval, then a gate), then by age. An entry takes the place of its most pressing request, and a lane takes the place of its first entry.

| Part | Says | Tooltip |
| --- | --- | --- |
| Entry | its ring and its top-level title | the title, then each request as `{tasks under it} › {what it asks}` |
| What a request asks | a question's first question, an approval's command (or tool), a gate's prompt's first line (or its function in words) | |
| Folded lane | its name, one ring of everything in it, its count in `--warn` | every entry's tooltip |
| Count pill | `{n}` | `{n} waiting on you` |

## As the room runs out, the lanes give up words a step at a time

The strip measures the room the lanes have and the words they would draw (`fitLanes` in `inboxLanesModel.ts`), and takes the first of these that fits:

1. every title in full;
2. titles cut to 120px;
3. the last lane's titles dropped, leaving its rings 5px apart, then the lane before it, back to the second;
4. those lanes folded to one ring and a count, from the last, where that is narrower than their rings;
5. the first lane's titles dropped (it holds the most pressing request, so it keeps its words longest);
6. lanes left out from the end, their requests counted in `+{n} more` in `.app-secondary`.

Nothing is left out while there is room for it.

## The strip shows the waiting requests or is absent

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | Nothing waits: the strip is absent and the viewport runs to the bottom of the window. | [empty.html](../assets/inbox-strip/empty.html) |
| loading | Cannot occur: a request is listed the moment it arises, so the strip never waits for its list. | |
| success | The label, the pill with the total, and a lane per project with its entries. An answered request leaves its entry's ring and the count drops; an entry with none left leaves. | [success.html](../assets/inbox-strip/success.html) |
| partial | Not everything fits: titles cut, then rings alone, then folded lanes, and last `+{n} more`, which cannot be chosen. | [partial.html](../assets/inbox-strip/partial.html) |
| error | A request that outlives its project by a moment: its lane shows the folder's name in the grey `--p0` instead of the project's hue. A request whose task is not known is an entry of its own, titled by its task id or what it asks. | [error.html](../assets/inbox-strip/error.html) |

## A person never opens the strip, and each entry leads to where it is answered

- The strip appears in every room, Settings included, when the first request arrives in any open project, and goes when the last is answered.
- Choosing an entry switches to the Tasks room, selects the task that parked its most pressing request in its own project and describes it in the context panel beside the board, where the question waits in its conversation under the state that asks it.
- Choosing an entry with no task behind it does nothing. A command approval with no task opens its own dialog over the window and is answered there.
- `+{n} more` does nothing; answering the visible requests brings the next ones into view.
- A gate survives closing the app and is listed again on reopening. Closing a project dismisses its agent questions and denies its command approvals, so their entries leave.

## The strip keeps its height and gives up request text as the window narrows

- Its width is the window's less the sidebar's. The label and pill keep their size; the lanes take what is left and give up words in the steps above. The event notice at the right end takes at most 40%.
- Theme: ground, rule, pill and project hues are tokens with a light and a dark value.
- Focus: entries are not focusable and take no keys, so the strip is pointer only. Pointing at an entry changes only the cursor. A new request is not announced to screen readers; the total is a tooltip.
- Unsaved work: none, because choosing an entry only moves the view.

## The strip sets its words at sizes of its own

- `Awaiting you` takes `.app-title` at 0.92 of its size.
- An entry's title is the app face at 12/12.5 of the app base, 500, and a lane's name the data face at 11/12 of the data base, 600: what `fitLanes` measures them in.
