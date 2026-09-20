---
id: product/find-out-why-the-app-misbehaves
type: product-feature
status: shipped
updated: 2026-09-13
story: "As a person supporting the app, I can check in one step whether this installation can run a process end to end, tell a model-provider problem from an app problem, and read everything the app did across launches with pointers to the work and processes involved, so that a broken machine has a story."
importance: 0.4
audience: support
metrics:
  - "Problems with the app resolved without reproducing them live: rises"
  - "Times the app failed and was left blank: falls"
requires: []
related: [product/failures-explain-themselves, product/try-a-process-without-spending, product/bring-your-own-models-and-agents]
verified_by: []
---

# A broken installation can be diagnosed from a self-test and a record of what the app did

> As a person supporting the app, I can check in one step whether this installation can run a process end to end, tell a model-provider problem from an app problem, and read everything the app did across launches with pointers to the work and processes involved, so that a broken machine has a story.

## Without this, "it does not work" has several possible causes and nothing to tell them apart

The person is supporting the app, which on a machine with one user is the
developer themselves. When a process will not run, the app, the connection to a
model provider or the process itself could be to blame, and nothing says which.
What went wrong in an earlier launch is gone by the time anyone looks.

## A self-test separates app problems from provider problems, and the app keeps a record across launches

A person can run a self-test that carries a small process from start to end.
With scripted replies it checks the app itself, and against the machine's real
model it checks the provider as well. A pass with scripted replies and a failure
against the real model points at the provider. The self-test shows its verdict
beside the evidence it judged, and only a definite pass counts as passing, so a
result that could not be judged is never read as success. The self-test is an
ordinary process that can be read and changed, and a changed copy is never
silently replaced.

The app keeps its own record of what it did, across launches. The person can
narrow it by severity, by the part of the app an entry came from and by text,
open any entry to its full detail, and go from an entry to the work or the
process output it concerns. How much of the record is kept is a setting.

When part of the app fails, the rest keeps working and the error can be copied.
When the whole app stops drawing, the failure goes into the record and the app
comes back by itself, without looping on a fault that keeps recurring.

## A broken machine with a story gets a specific fix instead of a live reproduction

A self-test that separates the likely causes, and a record that outlives the
launch that failed, turn a vague report into a specific fix. The person can
resolve a problem from what the app already knows instead of waiting for it to
happen again while someone watches.

## Success shows as problems resolved from the record and no blank app left behind

| Metric | Read from | Success |
| --- | --- | --- |
| Problems with the app resolved without reproducing them live | The record of reported problems and what each was resolved from | Rises |
| Times the app failed and was left blank | The record of the app failing and whether it came back | Falls to zero |
