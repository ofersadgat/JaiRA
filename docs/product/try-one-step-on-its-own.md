---
id: product/try-one-step-on-its-own
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a developer, I can run any single step of a process on its own, giving it just the inputs it declares, and see every run that step has had, so that changing a step and checking it is one short loop."
importance: 0.55
audience: developer
metrics:
  - "Time from saving a change to a step to seeing that step's result: falls"
  - "Runs started from a single step rather than a whole process while a process is being changed: rises"
requires: [product/hand-work-to-agents]
related: [product/catch-process-mistakes-before-running, product/work-runs-the-process-it-started-with, product/try-a-process-without-spending, product/share-processes-across-projects]
verified_by: []
---

# Any single step runs by itself, so changing a step and checking it is one short loop

> As a developer, I can run any single step of a process on its own, giving it just the inputs it declares, and see every run that step has had, so that changing a step and checking it is one short loop.

## Without this, trying a change to one step means running the whole process up to it

The person is a developer improving one step of a process, such as a prompt that
misreads its task or an agent job that needs a different instruction. Seeing the
effect of a change means starting work on the whole process and waiting, and
paying, for every step before it. The next change means doing all of that again.

## You run one step with only what it needs, and see every run it has had

Any step of a process, not only a whole process, can be run by itself. The person
gives it only the inputs that step declares, and each is checked as it is given.
An input left empty counts as not given, so the step's own defaults apply.

The run uses the step as last saved, and the person is told when they have
unsaved changes that the run will not include. A step shared across
projects runs with the shared processes rather than in whichever project is
open, and the person is told where it will run. A step with mistakes in it is
refused with the reason.

Each step keeps its history: runs started from that step, and runs of larger
processes that went through it. When there are none, the person is told where
that was looked for.

## A short loop is what makes improving a step worth the effort

When checking a change takes minutes and a whole run, people stop making small
improvements. When it takes one step, they try the change, read the result, and
try again.

## Success shows as a shorter wait to see a change and more steps tried alone

| Metric | Read from | Success |
| --- | --- | --- |
| Time from saving a change to a step to seeing that step's result | The record of when a step was changed and when a run started from that step finished | The median falls |
| Runs started from a single step rather than a whole process while a process is being changed | The record of what each piece of work was started from | Rises |
