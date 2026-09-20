---
id: ux/patterns/ordered-by-urgency-then-recency
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/keep-track-of-everything, product/everything-waiting-on-you-together, product/chat-with-agents, product/find-out-why-the-app-misbehaves]
siblings: [ux/patterns/live-facts-and-unseen-counts, ux/patterns/waiting-requests-gathered, ux/patterns/filter-in-place]
---

# Ordered by urgency, then recency

Where many pieces of work sit together, work in motion comes first, then paused work, then work not started, then finished work with the most recently finished first. Paused covers work waiting on a person, work holding for other work, and work stopped part-way that can resume. Finished covers work that completed, failed or was cancelled. Only finished work is reordered by time. A heading marks where not-started and finished work begin, and only in a group that mixes kinds. Requests waiting on the person put an agent's questions first, then approvals, then decisions a process declared. Chats and the app's own log put the newest first.

## Use it when a person scans a mixed group for what needs attention

**Use when.** A group holds pieces of mixed standing and the person looks for what is live or waiting: the work at one stage of a process, the requests waiting on them, their chats, the app's log.

**Do not use when.** The order means something of its own: the steps a run went through keep the order they ran in, and projects are ordered by name. The group is long and the person knows what they want: narrow it with [filter-in-place](filter-in-place.md).

## The group reads from what is live down to what finished longest ago

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Looks at a group | Places running work first, then paused, then not started, then finished work newest first | What is live, without reading every item |
| 2 | Nothing, while work changes standing | Moves the piece to its new place when the group next updates | That it changed |
| 3 | Looks at the requests waiting on them | Puts an agent's questions first, then approvals, then decisions | What is holding an agent up |

## Every state keeps live work above finished work

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A group with nothing in it shows that it is empty, and a project with no chats says so | Start work |
| empty | An empty group shows that it holds nothing, and in a run's own view a step never reached says so | Start work, or wait |
| loading | Cannot occur as its own state: the order applies to whatever is loaded | Read what is there |
| partial | A group that mixes kinds marks where not-started and finished work begin, and a group of one kind has no marks | Scan from the top |
| error | Cannot occur as its own state: ordering cannot fail | Read the group |
| denied | Cannot occur: the order is the same for everyone | Read the group |
| success | The group reads from what is live down to what finished longest ago | Open what needs attention |

## The order is not the person's choice, so nothing is undone or lost

The person cannot set or change the order. Leaving and coming back shows the same order for the same standing.

## Items are not reached by Tab, and finished work grows without bound

**Keyboard only.** Pieces of work in a group cannot be reached by Tab.

**Screen reader.** Groups are not announced as lists, so their order is heard only as reading order. The marks where not-started and finished work begin are headings.

**Small window.** At the top level, groups wrap to fit the window. Below it, the person scrolls sideways to reach groups that do not fit.

**Slow machine.** Every item in a group is drawn, and finished work keeps growing until history is [trimmed](../../product/keep-history-within-bounds.md).
