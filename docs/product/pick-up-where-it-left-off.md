---
id: product/pick-up-where-it-left-off
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can stop work at any moment, or lose it to a crash or to closing the app, and later carry on from exactly where it was, without repeating or paying again for anything already done, so that an interruption never means starting over."
importance: 0.85
audience: user
metrics:
  - "Work started again from the beginning when it could have been resumed: falls"
  - "Finished steps done and paid for a second time after work was resumed: falls"
  - "Time from asking work to stop to every agent it started having ended: falls"
requires: [product/hand-work-to-agents]
related: [product/decisions-stay-yours, product/rewind-to-where-it-went-wrong, product/work-runs-the-process-it-started-with, product/keep-track-of-everything]
verified_by: []
---

# An interruption never means starting over, because stopped work carries on from where it was

> As a developer, I can stop work at any moment, or lose it to a crash or to closing the app, and later carry on from exactly where it was, without repeating or paying again for anything already done, so that an interruption never means starting over.

## Without this, stopping agent work throws away everything it had done

The person is a developer whose agents do slow work that costs money. That work
gets interrupted: the person sees it heading somewhere wrong and stops it, the
machine crashes, or the app is closed at the end of the day. If an interruption
means starting from the top, every finished step is done and paid for again, and
stopping early to fix something becomes the expensive choice.

## Stopped work ends at once, and later carries on from the step it had reached

A person can stop running work at any moment. Every agent and process the work
started is ended rather than left working, and if ending them is slow the person
can force it.

Work that was stopped, cut off by a crash, or ended by closing the app can be
resumed. Every step that had finished is taken from the record instead of being
done again, and the work carries on from the step it had reached. A step that
was cut off partway starts again. Where a step had failed, resuming runs that
step again with everything before it kept.

Before resuming, the person is told what will be kept and where the work will
carry on. When the record cannot support a resume, they are told so plainly, and
the work can only start again from the beginning.

Work that was waiting for a person's decision when the app was closed is waiting
for the same decision when the app opens again. Work cut off by a crash is
recognised as interrupted the next time its project opens, and waits for the
person to resume it.

## Stopping without penalty is what makes stopping early worth doing

Agent work is slow and billed as it goes, so starting over is the costly outcome
of any interruption. When stopping loses nothing already done, the person stops
work the moment it looks wrong instead of letting it run on, and a crash or a
closed app costs only the step that was in progress.

## Success shows as work resumed rather than restarted and no finished step paid for twice

| Metric | Read from | Success |
| --- | --- | --- |
| Work started again from the beginning when it could have been resumed | The record of work started over whose earlier attempt could have been resumed | Falls |
| Finished steps done and paid for a second time after work was resumed | The record of each step's result and whether a resume reused it or ran it again | Falls to zero |
| Time from asking work to stop to every agent it started having ended | The record of when a stop was asked for and when the last agent of that work ended | Falls |
