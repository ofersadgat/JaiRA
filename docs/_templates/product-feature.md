---
id: product/<feature-name>
type: product-feature
status: proposed
updated: YYYY-MM-DD
story: "As a <who>, I should be able to <what>, so that I can <value>."
importance: 0.0
audience: user | developer | support | marketing | operator
metrics: ["<what is read, and what number means success>"]
requires: [product/<other-feature>]
siblings: [product/<confusable-feature>]
---

# <Feature name>

> As a <who>, I should be able to <what>, so that I can <value>.

Two or three sentences on what this actually is.

## Where this fits

- **Serves** — the goal from the product spec, and what is lost without this.
- **Neighbors** — the features nearest this one, and how we keep them distinct.
  "<This> is not <that> because …". Written so nobody builds the overlap twice.
- **Depends on / used by** — what must exist first; what leans on this.
- **History** — what this replaces or reverses, with a link.

## Value

Who gets what. The path they take today instead, and what that costs them in
steps, waiting, guessing, or giving up.

## Scope

**Necessary** — without these the feature delivers nothing.

**Sufficient** — with these, the story above is true. The line between necessary
and sufficient is where cutting starts.

**Nice to have** — with a note on what each would add.

## Metrics

| Metric | Read from | Success | Instrumented? |
| --- | --- | --- | --- |
| | | | |

## Framings considered

The competing readings of the same problem, including **do nothing**, and why
not. One row each — this *is* the record; the exploration that produced it is a
run artifact on the task and will not be read again.

| Framing | Why not |
| --- | --- |
| Do nothing | |

## Open questions

Only what genuinely cannot be settled yet. **A question a person could answer in a
sentence does not belong here** — it is asked while the spec is being written, and the
answer is folded into the prose above as a plain statement of what the product does.
A row here is a measurement nobody has taken, a decision that depends on work not yet
done, or a choice that a later phase is better placed to make.

Every row names the reading taken in the meantime, so the feature is buildable as
written whatever the answer turns out to be.

| Question | Reading taken for now | Resolved by |
| --- | --- | --- |
| | | design phase \| build phase \| a measurement |

---

**This document describes the product.** It does not record how it was written: no
passes, no revisions, no earlier versions of itself, no arguments with a previous
draft. Where a decision changed, the document simply states the decision that holds.
