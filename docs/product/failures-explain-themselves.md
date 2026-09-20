---
id: product/failures-explain-themselves
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, when work fails I can see which step failed and the underlying reason, not only that something beneath it broke, so that I can fix the cause without digging through layers."
importance: 0.6
audience: user
metrics:
  - "Failed work whose recorded reason names the step where the failure began: rises"
  - "Time from a failure to the same work carrying on successfully: falls"
requires: [product/complete-record-of-every-run]
related: [product/pick-up-where-it-left-off, product/find-out-why-the-app-misbehaves, product/bring-your-own-models-and-agents, product/risky-actions-wait-for-approval]
verified_by: []
---

# A failure names the step where it began and the reason that step gave

> As a developer, when work fails I can see which step failed and the underlying reason, not only that something beneath it broke, so that I can fix the cause without digging through layers.

## Without this, a failure says only that something underneath broke

The person is a developer whose processes hold steps inside steps. When
something deep inside fails, the step that gives up is the outermost one, and
its reason is only that a step beneath it ended in error. Finding the cause
means going down through every layer, and a coding agent that crashed may have
said why only in what it printed.

## The failure names the step it began in, gives that step's own reason, and offers to run that step again

When work fails, it names the step where the failure began and the reason that
step gave, rather than only the outermost step that gave up. When a coding agent
fails, what it printed as it failed is part of the reason, and an agent that
could not be started at all is named. The failure is shown with the step it
belongs to, at the point in the work's history where it happened.

The person is offered the act that fits: running the failed step again with
everything before it kept.

Work that cannot run as it is set up says so in a sentence naming what is
missing, such as a usable model, rather than failing somewhere inside. A step
whose agent cannot be held to the approval rules the step requires fails with
that step named, instead of running unguarded.

## The real reason is usually one sentence that fixes it

A failure that says only that something beneath it broke sends the person
searching. The cause, such as a missing key, a result the step would not accept
or an agent that crashed as it started, is usually one sentence that says what
to fix. Seen where it happened, with a way to run just that step again, a
failure becomes a fix and a retry rather than an investigation.

## Success shows as every failure naming its origin and failed work carrying on sooner

| Metric | Read from | Success |
| --- | --- | --- |
| Failed work whose recorded reason names the step where the failure began | The record of each failure and the step its reason came from | Rises to all failures |
| Time from a failure to the same work carrying on successfully | The record of when work failed and when it next finished after being resumed | Falls |
