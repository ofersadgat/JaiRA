---
id: product/agents-ask-instead-of-guessing
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can let a coding agent ask me when it is unsure and have my answer go straight back into its work, or tell it to use its own judgement, so that it does not guess at something I could have settled in a sentence."
importance: 0.6
audience: user
metrics:
  - "Agent questions answered: rises"
  - "Work sent back at review because an agent guessed at something it could have asked: falls"
requires: [product/hand-work-to-agents]
related: [product/decisions-stay-yours, product/decide-with-the-context-in-front-of-you, product/everything-waiting-on-you-together, product/nothing-stalls-in-silence]
verified_by: []
---

# An agent that is unsure asks you, and your answer goes straight back into its work

> As a developer, I can let a coding agent ask me when it is unsure and have my answer go straight back into its work, or tell it to use its own judgement, so that it does not guess at something I could have settled in a sentence.

## Without this, an unsure agent guesses, and the guess is found only at review

The person is a developer handing work to coding agents. Partway through, an
agent meets something its instructions do not settle: which of two approaches
to take, what a term means, whether a case matters. Left alone it picks one and
carries on, and a wrong pick is found at review, after the work built on it is
done.

## The question reaches you inside the work that asked it, and the agent carries on with your answer

When an agent asks a question in the middle of its work, the question reaches
the person within that work, with the options the agent offered. The person
picks one or answers in their own words, and the agent carries on with the
answer as if it had been part of its instructions. Several questions the agent
asks together are answered together.

The person can instead decline to answer and let the agent use its own
judgement, and the agent continues.

A question that never reached the person is recorded as a failed attempt to ask,
never left looking like a question waiting for an answer. Where a step must hand
on a result of a fixed shape, its agent may ask only if the process allows it.

A question lasts as long as the agent that asked it, so stopping the work or
closing its project withdraws the question.

## One sentence at the right moment is the cheapest correction there is

A wrong guess costs the work built on it and a round of review to find it, when
the person could often have settled it in a sentence. Being able to decline
means a question costs the person nothing when they would rather the agent
decided.

## Success shows as more questions answered and less work sent back for guesses

| Metric | Read from | Success |
| --- | --- | --- |
| Agent questions answered | The record of each question an agent asked and the answer it got | Rises |
| Work sent back at review because an agent guessed at something it could have asked | The record of work sent back at review and whether its agent asked anything | Falls |
