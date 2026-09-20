---
id: ux/patterns/unsaved-proposal
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/keep-process-and-description-in-step, product/read-what-work-produced, product/review-changes-before-they-land]
siblings: [ux/patterns/draft-belongs-to-the-file, ux/patterns/per-change-review, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/show-the-request-not-the-outcome]
---

# Unsaved proposal

Content the system writes on the person's behalf is placed where the person would have written it, as an unsaved edit to a file or an unsent message, and the system never saves or sends it. The person reads it where it will live and edits it if they like. Saving or sending it is what accepts it, and reverting or clearing it rejects it. Two things produce proposals. Bringing a process and its description back in step either rewrites the description or proposes process files, with a report beside the proposals of how each requirement stands, why each edit was proposed, and which proposals the system declined itself. An interactive page that work produced can suggest a message to the conversation it came from.

## Use it when the output is a candidate for something the person owns

**Use when.** The system generates text for a file or a message that belongs to the person, and they should be able to change it before it counts.

**Do not use when.** The work waits on the answer: use [park-and-ask](park-and-ask.md). Several files each need a decision before anything is written: use [per-change-review](per-change-review.md), which proposed process files also open automatically.

## The system proposes in place, and the person's own save is the acceptance

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Asks for a proposal in one direction, or uses a page that suggests a message | For a process and description, states which side changed since they last agreed and suggests a direction. Generates with read-only access and shows its latest progress | That it is working, and on what |
| 2 | Waits, cancels, or goes elsewhere while it runs | Places each proposal as an unsaved edit on its own file, or puts the message in the message box unsent, and reports what it proposed and declined | Where each proposal is, and that nothing is written |
| 3 | Reads, edits, then saves or reverts each | Treats each save as acceptance, and records the point of agreement once no proposal from the request is left unsaved | What remains unsaved |

## Every state says what was proposed, what was declined, and what still holds agreement back

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A process and description never brought in step have no point of agreement, so no direction is suggested and the person is asked to choose, as when both sides have changed | Choose a direction |
| empty | The two agree, and the system says so. A request that finds nothing to change records the agreement at once | Nothing |
| loading | The system says it is reading, shows its latest progress, and offers cancel, while asking again is unavailable | Cancel, or go elsewhere while it runs |
| partial | Declined proposals each give their reason, with a count of those not applied. A proposal left unsaved is named as what holds the point of agreement back | Save or revert the rest, or review them as a set of changes |
| error | A refused request gives its reason, such as one already running or an empty file, and nothing is placed. If the agreement status cannot be read, the system goes on saying it is checking | Fix the cause and ask again |
| denied | When a request cannot run, a sentence naming the blocker replaces the status and both directions are unavailable, such as with no project open or an empty description | Do what it names |
| success | Each proposal sits unsaved in its file, or the message sits unsent, with the report beside it | Save, revert, edit, send, or review as a set |

## Nothing is written until the person saves, and unsaved proposals end with the app

Reverting a proposal restores the file as it is on disk. Proposals stay with their files while the person works elsewhere, as in [draft-belongs-to-the-file](draft-belongs-to-the-file.md), but opening any other file clears the report. Cancelling a request means its proposals are never placed.

Restarting the app discards every unsaved proposal and the point of agreement waiting on them.

A suggested message is cut to a fixed length and replaces whatever was in the message box, and the replaced text cannot be recovered.

## Every action is a button, and progress is not announced

**Keyboard only.** Every action is a standard button reached by Tab.

**Screen reader.** Progress lines are not announced as they arrive.

**Small window.** The report and the file's own reading share one area, and the person switches between them.

**Slow machine.** The report appears only when generation finishes, and until then only the latest progress lines show.

## This departs from the UX principles in one place

A suggested message replaces the text the person had typed in the message box instead of keeping it.
