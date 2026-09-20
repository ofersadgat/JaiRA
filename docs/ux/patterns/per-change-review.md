---
id: ux/patterns/per-change-review
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/review-changes-before-they-land, product/keep-process-and-description-in-step, product/parallel-work-without-collisions]
siblings: [ux/patterns/comments-turn-a-verdict-into-send-back, ux/patterns/quote-anchored-note, ux/patterns/unsaved-proposal, ux/patterns/second-deliberate-step-for-irreversible]
---

# Per-change review

A set of proposed changes to files is reviewed as a list of the changes beside the one chosen. Nothing asks for a verdict per change. Leaving a change alone keeps it, refusing it drops it, refusing selected lines puts the original back over just those lines, rewriting the proposed side keeps the rewrite, and a comment or a note on it sends it back. Each change states what will happen to its file. The review marks files that moved since the proposal and files with unsaved edits of the person's own, shows compiler problems on both sides of a code change, and counts what is kept, removed, commented and never opened. One action ends the review. With no feedback anywhere it applies what was kept and refuses to write over a file that moved. With any feedback it writes nothing and sends the whole set back, as in [comments-turn-a-verdict-into-send-back](comments-turn-a-verdict-into-send-back.md). In a terminal the same set is walked one change at a time, and each change needs an explicit choice.

## Use it when several independent changes arrive together and all-or-nothing would waste good ones

**Use when.** An agent's work or a generated proposal changes several files, and the person must decide which of them land.

**Do not use when.** One indivisible document is judged: ask with [park-and-ask](park-and-ask.md) and a review of that document. The person should edit a generated file in place before it counts: use [unsaved-proposal](unsaved-proposal.md).

## The person acts on each change, reads the tally, and ends the review once

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Opens the review | Chooses the first change, shows its difference, marks every change whose file moved, and warns on the chosen change when its file has unsaved edits | What changed, and what is at risk |
| 2 | Leaves a change, refuses it or some of its lines, rewrites it, or comments on it | Derives the change's fate from the gesture and states what will happen to its file | The fate of each change |
| 3 | Reads the tally | Counts kept, removed, commented and never-opened changes, and states whether the set will be applied or sent back | What they have not read, and what the action will do |
| 4 | Applies or sends back | Checks again that no file moved, then writes the kept changes, or returns the set with every comment and note | The result, or which files moved |

## Every state tells the person what would be applied and what blocks it

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: a review exists only once there are changes to review | Review them |
| empty | Asking to review work whose files match their starting point is refused, saying there is nothing to review | Carry on with the work |
| loading | The first difference shown says its viewer is loading, while the list and each change's actions already work | Choose or refuse changes meanwhile |
| partial | Some changes decided and some never opened, which the tally counts. An unopened change is kept if the set is applied | Open the rest, or end the review anyway |
| error | Input that is not a valid set of changes says so and offers nothing to decide. A change that cannot be shown names what it is, such as binary, and can still be kept, refused or commented on | Decide without seeing it, or stop the work |
| denied | A file that moved since the proposal is marked before the action, and applying refuses, naming the files that moved | Send the set back for a fresh proposal |
| success | The review stays in the record as decided, with each change's fate and the feedback sent | Follow the work |

## Every choice can be reversed until the review ends, and leaving it discards them all

Before the action, a refused change can be put back, which restores the proposal without the person's own edits, and a rewrite can be undone back to the proposal. Refusing a whole change discards its comment and notes without asking.

After the action, the kept changes are written and the review cannot change. The way back is to [rewind](../../product/rewind-to-where-it-went-wrong.md) the work.

Leaving the review before the action discards every choice, edit, comment and note, and the review stays waiting.

## Every action is a button, and moved and unopened marks are hints only

**Keyboard only.** The list of changes and every action are standard buttons reached by Tab, and the difference has its own editing keys. Selecting lines by keyboard opens a note and moves the focus into it as soon as anything is selected, as in [quote-anchored-note](quote-anchored-note.md).

**Screen reader.** The marks for moved files and unopened changes are conveyed only as hover hints. The choice between inline and side-by-side layout does not announce which is on.

**Small window.** In a narrow review the list sits above the chosen change. The side-by-side layout stays available at any width.

**Slow machine.** The difference viewer loads on first use. Files are checked for movement one after another with no sign that the check is running, so a moved-file mark can appear after the person has started deciding.

## This departs from the UX principles in two places

A change left untouched is kept when the set is applied, so its approval is inferred from the one explicit action, and the count of changes never opened is stated instead of being required.

Refusing a whole change discards the comment and notes written on it without asking, because feedback on a change that has left the review has nothing to be about.
