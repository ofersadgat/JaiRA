---
id: ux/patterns/waiting-requests-gathered
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/everything-waiting-on-you-together, product/decisions-stay-yours, product/agents-ask-instead-of-guessing, product/risky-actions-wait-for-approval, product/all-projects-in-one-place]
siblings: [ux/patterns/park-and-ask, ux/patterns/live-facts-and-unseen-counts, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/drag-only-where-the-process-allows]
---

# Waiting requests gathered

Every request waiting on the person, from every open project, is gathered into one place that stays present across the app. It covers agent questions, command approvals and decisions a process declares. The place states how many requests wait, shows the most blocking few with the project each belongs to and what each asks, and leads to the work where each is answered. Nothing is answered in the gathered place itself, and it is absent when nothing waits. Work waiting to be moved by hand, as in [drag-only-where-the-process-allows](drag-only-where-the-process-allows.md), is not gathered here.

## Use it when requests arise in work the person is not looking at

**Use when.** Work asks for a person while they are elsewhere, possibly in another project, and each request is answered in its own context as in [park-and-ask](park-and-ask.md).

**Do not use when.** The person only needs to know that something happened: use [live-facts-and-unseen-counts](live-facts-and-unseen-counts.md). The question belongs to what the person is already looking at: ask it in place with [park-and-ask](park-and-ask.md) alone.

## The person sees what waits, follows one request to its work, and answers there

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Works anywhere in the app | Adds each request the moment it is raised, keeps the total, and shows agent questions first, then approvals, then declared decisions | That something waits, how many, and in which projects |
| 2 | Chooses a shown request | Switches to the project that owns it and opens the work that asks | Where to answer |
| 3 | Answers there | Removes the request and lowers the total, and removes the place when the total reaches zero | That it is settled, and what is left |

## Every state leaves the person a request to follow or nothing to do

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: the place appears only once something waits, so a first request behaves like any other | Choose it |
| empty | Nothing waits, and the place is absent | Nothing |
| loading | Cannot occur: a request is added when it is raised and removed when it is settled, with nothing fetched in between | Choose a request |
| partial | At most three requests are shown, at most two of each kind, and the rest are only counted. The counted remainder cannot be opened from here | Settle a shown request, or open the other requests' work directly |
| error | A request whose project has just closed can linger for a moment, named by its folder, until it is withdrawn | Wait for it to go |
| denied | An approval that belongs to no piece of work cannot be followed from here. It is asked on its own, over whatever the person is doing | Answer it where it is asked |
| success | The request leaves the place and the total drops | Choose the next request |

## Following a request changes only the view, and ignoring one loses nothing

Choosing a request moves the person to its work and changes nothing else. A request stays gathered until it is answered or its work is stopped.

A declared decision is gathered again when its project opens after the app restarts. An agent question and an approval end when their project closes, and leave the place with it.

## Requests cannot be chosen by keyboard, and nothing is announced when one arrives

**Keyboard only.** Shown requests cannot be reached or chosen by keyboard. A keyboard-only person reaches a request by opening its work.

**Screen reader.** Nothing is announced when a request is added or removed.

**Small window.** No more than three requests are shown at any width, and what each asks is cut short to fit.

**Slow machine.** A request appears when the app hears of it and needs nothing further to show.
