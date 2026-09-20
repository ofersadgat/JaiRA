---
id: product/know-what-work-costs
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can see what each run and each step consumed, in money, time and tokens split the way they are billed, and whether the money figure came from the provider, so that spend is something I can check rather than a number I have to believe."
importance: 0.6
audience: user
metrics:
  - "Runs whose cost is out of line with their tokens that are noticed before the next run: rises"
  - "Spend per completed piece of work on a process: falls"
requires: [product/complete-record-of-every-run]
related: [product/bring-your-own-models-and-agents, product/try-a-process-without-spending]
verified_by: []
---

# Every run says what it cost and what that cost is made of, so spend can be checked

> As a developer, I can see what each run and each step consumed, in money, time and tokens split the way they are billed, and whether the money figure came from the provider, so that spend is something I can check rather than a number I have to believe.

## Without this, a cost is a number to believe or doubt with nothing to check it against

The person is a developer paying for models and coding agents to do work. A run
that cost a dollar may be ordinary work or an agent stuck in a loop, and the
figure alone does not say which. An estimate also reads the same as a charge the
provider made, so an estimate gets quoted back as fact.

## Each run and each step shows its money, time and tokens, and says when the money is not the provider's charge

For a whole run and for each step in it, the person sees when it started, how
long its calls took and what it consumed. Tokens are split the way providers
bill them: what was sent, what came back, what was read from the cache, what was
written to it, and how much of what came back was thinking.

The money figure is the one reported for each call. When it is an estimate from
a price table rather than the provider's own charge, or when no charge was
reported at all, that is said beside it. A run's total is only as trustworthy as
its least trustworthy part, and it says which kind of figure that is.

A step that ran several times shows what each pass cost, so one expensive loop
is never averaged away.

## Tokens beside the money are what make a charge checkable

A charge beside tens of thousands of cached tokens is an agent doing ordinary
work. The same charge beside a few hundred tokens is something broken. Seeing
both, and knowing where the money figure came from, lets the person catch a
runaway step or a misreported charge before paying for it again.

## Success shows as unexplained costs caught sooner and less spent per finished piece of work

| Metric | Read from | Success |
| --- | --- | --- |
| Runs whose cost is out of line with their tokens that are noticed before the next run | The record of what each call consumed, what it was reported to cost, and when the person looked at it | Rises |
| Spend per completed piece of work on a process | The record of what each piece of work consumed and how it ended | Falls as authors act on what they see |
