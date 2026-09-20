---
id: product/decisions-stay-yours
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can have work stop at the points I chose and wait for my decision, with nothing moving past such a point until I give it, so that agents never make those calls for me."
importance: 0.9
audience: user
metrics:
  - "Work that moved past a point where a person decides without a person's answer: falls"
  - "Decisions left waiting when the app closed that were later answered and carried on: rises"
requires: [product/hand-work-to-agents]
related: [product/decide-with-the-context-in-front-of-you, product/everything-waiting-on-you-together, product/pick-up-where-it-left-off, product/agents-ask-instead-of-guessing, product/nothing-stalls-in-silence]
verified_by: []
---

# Work stops where you said you decide, and nothing gets past that point without you

> As a developer, I can have work stop at the points I chose and wait for my decision, with nothing moving past such a point until I give it, so that agents never make those calls for me.

## Without this, keeping a call for yourself means watching the work and stepping in on time

The person is a developer handing whole pieces of work to coding agents. Some
calls in that work are theirs: whether a plan is right, which option to take,
whether a document is ready, whether to go ahead with something that cannot be
taken back.

An agent left to run makes those calls itself. Keeping one means watching the
work and interrupting it at the right moment, and missing that moment once means
an agent decided for them.

## The work waits at every point you chose, and only a person's answer moves it on

A process says where a person decides. Work that reaches such a point stops and
waits. It never times out and never carries on by itself. Only an answer from a
person satisfies the decision, and nothing an agent produces answers it on the
person's behalf.

A decision can be a choice between options, approving a document or sending it
back, correcting a document directly, supplying details the work needs, or
confirming a step that cannot be undone. An answer that does not fit what the
decision allows is refused before it reaches the work.

A waiting decision survives the app closing. Answered after the app opens again,
it carries the work on from that point. Decisions that do not depend on each
other can all be waiting at the same time.

## An agent taking a call that was yours is removed rather than warned about

Finding out afterwards that an agent made a call that was theirs is what stops
people trusting agents with real work. At a point the person chose, that cannot
happen. They can hand over a whole process, walk away, and come back to every
decision they kept still there and unanswered.

## Success shows as no work ever passing a decision unanswered and no decision lost to a restart

| Metric | Read from | Success |
| --- | --- | --- |
| Work that moved past a point where a person decides without a person's answer | The record of each decision the work reached and the answer a person gave to it | Falls to zero and stays there |
| Decisions left waiting when the app closed that were later answered and carried on | The record of decisions waiting when the app closed and what happened to each after it opened | Rises until every one is carried on |
