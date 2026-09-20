---
id: ux/patterns/live-facts-and-unseen-counts
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/see-what-changed-since-you-looked, product/all-projects-in-one-place, product/everything-waiting-on-you-together, product/keep-track-of-everything]
siblings: [ux/patterns/waiting-requests-gathered, ux/patterns/ordered-by-urgency-then-recency, ux/patterns/say-what-it-is-doing-and-for-how-long]
---

# Live facts and unseen counts

How work stands is said with one small vocabulary wherever it appears: running, waiting on a person, failed, stopped and done. Work never started has no word. The words come in two kinds. Running and waiting are live facts: they count what is true now and never clear. Failed, stopped and done count what ended since the person last looked. Opening a piece of work marks it seen as of its own last change, so a change that lands afterwards is news again, and a place's counts can be dismissed without opening anything. Where room runs out, counts fold into one total of what is hidden, marked by the most serious standing it hides, and running never folds away.

## Use it when many pieces of work are summarised and some only need to be noticed once

**Use when.** A project, its work or its chats are summarised in little room, where some pieces need action now and others need only be noticed once.

**Do not use when.** One piece's full standing is being read: say it with [say-what-it-is-doing-and-for-how-long](say-what-it-is-doing-and-for-how-long.md). The person must act on what waits for them: gather it with [waiting-requests-gathered](waiting-requests-gathered.md).

## Live facts stay while true, and counts clear as the person looks

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Glances at a project, its work or its chats | Shows the live facts and the unseen counts for that place alone | What is live there, and what ended since they last looked |
| 2 | Opens a piece of work | Marks it seen as of its last change | The count it was in drops by one |
| 3 | Dismisses a place's counts | Marks every ended piece there seen | Counts are clear, and live facts remain |
| 4 | Nothing | Counts a piece again when it changes after being seen | Something changed that they have not seen |

## Every state separates what is live from what is news

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | With nothing marked seen, every ended piece of work counts as unseen | Dismiss the counts, or open what matters |
| empty | With nothing running, waiting or unseen, no counts show at all | Carry on |
| loading | Cannot occur as its own state: counts describe what is loaded and change as it does | Read the counts |
| partial | Counts that do not fit fold into one total of hidden items, marked by the most serious standing hidden. Where work or chats are counted apart, a piece waiting on a person counts as running, and only the project's counts show it waiting | Open the place, or widen it |
| error | If marking seen cannot be saved, nothing says so, and the counts come back after a restart | Dismiss them again |
| denied | Cannot occur: every place's counts can be read and dismissed | Open the place |
| success | Counts show only what ended since the person last looked, beside what is live now | Open what needs them |

## Marking seen cannot be undone, and dismissing clears a whole place at once

Only a new change marks a piece unseen again. Dismissing a place's counts marks every ended piece there seen at once, and afterwards nothing shows which of them were new. What was marked seen is kept across restarts.

## Counts cannot be dismissed by keyboard, are not announced, and are absent when the project list is collapsed

**Keyboard only.** Dismissing counts is offered to the pointer alone, because the counts cannot be reached by Tab. Opening a piece of work still marks it seen.

**Screen reader.** Each count carries a spoken description of its kind and number, and nothing announces a change.

**Small window.** Counts fold to fit the room each place has. With the list of projects collapsed, no counts or live facts show for any project, so running work goes unmentioned there.

**Slow machine.** How much fits is estimated rather than measured, so a larger text size can fold one count more than needed. Seen marks are saved a moment after they change.
