---
id: product/nothing-stalls-in-silence
type: product-feature
status: proposed
updated: 2026-09-11
story: "As a developer who lets agents run unattended, I can trust that work needing my decision will tell me and keep telling me until I answer, so that walking away is safe."
importance: 0.7
audience: user
metrics:
  - "Work still waiting on a person a day after it asked: falls."
  - "Work that is abandoned while still waiting for an answer: falls."
  - "Unattended time a person is willing to leave agents running: rises."
requires: []
related: [product/keep-track-of-everything]
verified_by: []
---

# Nothing you started stops without telling you

> As a developer who lets agents run unattended, I can trust that work needing my decision will tell me and keep telling me until I answer, so that walking away is safe.

## An agent that waits for you is only safe if you find out it is waiting

An agent that reaches a decision it should not take alone stops and waits rather
than guessing. It waits indefinitely and it never expires.

That is the right behaviour and it is half of a guarantee. The other half is
being told, and today everything the product says is treated the same way: a
piece of news, which has done its job the moment you have seen it. That is right
for work that finished and work that failed, because there is nothing to do but
know.

It is wrong for a question. Seeing that something is waiting on you is not
answering it, so anything that stops mentioning it once you have glanced turns
work that is waiting into work that waits forever.

## Work that finished mentions it once, and work that needs you keeps asking

Work that finished, failed or was paused tells you once and then leaves you
alone, because knowing was all there was to do.

Work waiting for your decision does not go quiet. It keeps asking until you
answer it, and only answering stops it. Dealing with one part of your work does
not quieten the rest.

If you would rather keep your own list and not be asked twice, you can turn that
off.

## Walking away is the thing you are paying for

Handing work to an agent buys you the time it is working. You only take that
time if you believe nothing is quietly stuck, and coming back once to find
something that had been waiting since the morning is enough to stop you
believing it.

A question is also the only thing here that gets worse while it goes unanswered.
Work that failed has already failed. Work that is waiting keeps a workspace, a
branch and a train of thought suspended for as long as nobody answers.

## Success shows as fewer things left hanging and longer unattended stretches

| Metric | Read from | Success |
| --- | --- | --- |
| Work still waiting on a person a day after it asked | The record of when work asked and when it was answered | Falls |
| Work that is abandoned while still waiting for an answer | The record of work discarded while waiting | Falls |
| Unattended time a person is willing to leave agents running | The record of when work was started and when the person next appeared | Rises, because leaving is trusted |

## This makes explicit what the principles already claim

The principles say the human stays in the loop by construction rather than by
discipline. This extends that from the work stopping to the person being told
and kept told, because a loop a person can silently drop out of is discipline
again.
