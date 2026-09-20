---
id: ux/patterns/comments-turn-a-verdict-into-send-back
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/decide-with-the-context-in-front-of-you, product/review-changes-before-they-land]
siblings: [ux/patterns/quote-anchored-note, ux/patterns/per-change-review, ux/patterns/button-says-what-will-happen, ux/patterns/park-and-ask]
---

# Comments turn a verdict into send-back

A review of something work produced offers the verdicts its process declares. The moment the person writes feedback of any kind, a general comment or a note on a passage as in [quote-anchored-note](quote-anchored-note.md), the verdicts give way to a single action that sends the work back with that feedback. Feedback therefore cannot be accepted and silently dropped. Before anything is sent, the review states what the action will mean: that the decision stands on its own, or that it goes back with the feedback. Deleting every piece of feedback brings the verdicts back. Editing the reviewed text is not feedback, and an edit travels with whichever verdict is chosen. A set of changes follows the same rule: feedback anywhere in the set means nothing is applied and the whole set goes back, as in [per-change-review](per-change-review.md).

## Use it when feedback only makes sense if another round acts on it

**Use when.** A person judges what work produced, and the process offers a verdict for another round, so that writing what is wrong and then approving would be a contradiction.

**Do not use when.** Comments are only informational and accepting with a comment is legitimate. The process declares no verdict for another round: the verdicts then stay offered and the feedback travels with the one chosen.

## Writing feedback leaves one action, and the review says what it will do

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Reads what is under review | Offers the process's verdicts and states that the chosen one will stand on its own | The options, and what choosing one means |
| 2 | Writes a comment or a note anywhere in the review | Replaces the verdicts with the single send-back action and restates the outcome, counting what was written | That the work will go back with their feedback |
| 3 | Sends it back | Returns the process's send-back verdict with every comment and note, and any edit to the reviewed text | That another round will take up the feedback |

## Every state says whether the decision stands alone or goes back with feedback

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: a review exists only once work asks for one | Read and decide |
| empty | No feedback: the verdicts are offered, and the review says the decision will stand on its own | Choose a verdict, or write feedback |
| loading | Cannot occur: the verdicts give way the moment feedback is written, with nothing to wait for | Keep writing |
| partial | Feedback written and not sent: one action remains, and the review counts the notes | Send it back, or delete the feedback to get the verdicts back |
| error | The process refuses what was sent: the review stays open, and the reason is reported apart from it | Send again |
| denied | A process with no verdict for another round keeps its verdicts, and the review says the feedback goes back with the decision | Choose a verdict |
| success | The review stays in the record as sent, showing the feedback and the single action taken | Follow the work into its next round |

## Feedback can be taken back until the review is sent, and leaving loses all of it

Deleting a note or clearing the comment restores the verdicts once no feedback is left. A deleted note has no undo and is removed without confirmation.

Once sent, the review cannot change. The way back is to [rewind](../../product/rewind-to-where-it-went-wrong.md) the work to before the review.

Leaving the review before sending discards every comment and note, and the review stays waiting.

## The rule needs no pointer, but notes do, and the outcome is not announced

**Keyboard only.** The verdicts and the send-back action are standard buttons. A note on a document cannot be started from the keyboard, so a keyboard-only person gives feedback through the general comment where the review offers one.

**Screen reader.** The statement of what the action will mean is plain text, and nothing is announced when it changes.

**Small window.** The rule does not depend on window size.

**Slow machine.** The verdicts give way as the feedback is typed, with no round trip to wait on.
