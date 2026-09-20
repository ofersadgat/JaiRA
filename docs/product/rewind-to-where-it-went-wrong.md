---
id: product/rewind-to-where-it-went-wrong
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can take work back to the point where it went wrong and carry on from there, so that a bad turn costs only that turn and not the whole run."
importance: 0.7
audience: user
metrics:
  - "Work started again from the beginning after a mistake late in it: falls"
  - "Rewound work that then reaches its end: rises"
requires: [product/pick-up-where-it-left-off]
related: [product/try-another-direction, product/chat-with-agents, product/complete-record-of-every-run]
verified_by: []
---

# A wrong turn costs only that turn, because work can be taken back to just before it

> As a developer, I can take work back to the point where it went wrong and carry on from there, so that a bad turn costs only that turn and not the whole run.

## Without this, a mistake late in a run costs everything before it

The person is a developer whose agents sometimes go wrong partway through a
piece of work: a step misreads its task, a decision was answered wrongly, a
conversation takes a bad turn. The work done before that moment is worth
keeping. Without a way back, the only choices are to live with the bad result or
start again from the beginning and pay for every step a second time.

## You pick the moment it went wrong, and the work carries on from just before it

A person can pick a moment in the work's history, such as a step starting, the
work moving on to another step, or a message in a conversation, and take the work
back to just before it. Everything from that moment on is discarded, including
what agents said, and the work carries on from there. A discarded step runs
again and a discarded decision is asked again. Agents carry on as if what was
discarded had never been said, but changes an agent already made to the code
stay as they are.

Work that had already begun alongside before that moment keeps what it went on
to finish, so it is never paid for twice.

Before anything is discarded, the person sees exactly what would go, and nothing
happens until they confirm. Work is not rewound while it is running.

In a conversation with an agent, a person can also change an earlier message and
send it again. The conversation carries on from the changed message, and what
followed the original stays readable beside it.

## Agents go wrong partway, and the work before that point is worth keeping

A late mistake is the most expensive kind, because everything before it was
paid for and was good. Rewinding makes its cost the part that went wrong. It
also makes a wrong answer to a decision recoverable, because the decision is
asked again.

## Success shows as fewer runs started over and more rewound work finishing

| Metric | Read from | Success |
| --- | --- | --- |
| Work started again from the beginning after a mistake late in it | The record of work started again whose earlier attempt had completed many steps | Falls |
| Rewound work that then reaches its end | The record of each rewind and how the same work ended | Rises |

## Rewinding deletes work for good, which the principles otherwise avoid

A rewind cannot be undone. The person chooses it after seeing exactly what goes,
and [try-another-direction](try-another-direction.md) changes course while
keeping the original.
