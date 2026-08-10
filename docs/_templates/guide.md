---
id: guides/<guide-name>          # or reference/<name>
type: guide                      # or reference
status: proposed
updated: YYYY-MM-DD
audience: user | developer | support | operator
documents: [product/<feature>, engineering/contracts/<name>]
example_verified: false
supersedes: [guides/<old-guide>]
---

# <Title — what the reader is trying to do>

The first ten lines get them unstuck. What this is, and the shortest path to the
thing they came for.

## Where this fits

- **Serves** — the deliverables in `documents`.
- **Neighbors** — the other docs this audience might have opened instead, and
  which one is right for what.
- **History** — what this replaces. Two audiences means two documents, not one
  with sections.

## <The task>

Steps, in the reader's words rather than the system's.

## Worked example

Runnable, and **actually run** from the state a new reader is in. Set
`example_verified: true` only after running it. An unrun example is a claim, not
a document.

## Traps

The things that fail silently, or work differently than the obvious reading
suggests. Pulled from the UI and engineering specs, rewritten for this audience.

## See also

Links, each with a sentence on why the reader would follow it.
