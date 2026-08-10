---
id: engineering/principles
type: standing
status: shipped
updated: 2026-08-04
---

# Engineering principles

The values, and how tradeoffs get resolved when two of them pull apart. Distinct
from [standards.md](standards.md), which is the concrete rules a reviewer can
cite — a principle explains *why* a standard exists, and settles the cases no
standard covers.

> **Partly seeded.** The principles below are the ones already visible in the
> code and in [README.md](../../README.md); each names the behaviour that
> demonstrates it. The rest of this file should be written as decisions come up,
> not invented in advance — a principle nobody has needed yet is decoration.

## Fail fast on ambiguity, never guess

A bare model id is an error rather than a default route. A missing native ABI
build says so on the first DB open, and names the command that fixes it. A failed
run prints the operation-level `causes` from the journal, not just the parent's
"child X terminated with error".

The tradeoff this settles: convenience now versus a wrong answer later. We take
the error.

## Never silently discard someone's work

A dirty worktree is refused, not cleaned. Removing a worktree keeps its branch.
`workflow check` writes nothing — its rewrite lands as an *unsaved* edit in the
editor, and its proposed state files as unsaved edits against their own rows.

The tradeoff: fewer steps versus recoverable mistakes. We take recoverable.

## Validate at the trust boundary, not before it

A human answer is re-validated in the main process against the component's
contract before it can become a workflow output. Renderer-side validation is a
convenience for the person, never the check that matters.

## One place for each translation

All Windows ↔ WSL path translation is in one mapper. The rule generalizes: when
the same conversion appears twice, the second one is a bug waiting on a third.

## A run is reproducible or it is not a run

The workflow is snapshotted content-addressed and the hash is pinned. Interrupted
runs are detected on next open and re-run against the pin, not against whatever
the files say now.

## Secrets live in the environment

Never in the repo, never in config that gets committed. `.jaira/config.json`
names the model; the key comes from `ANTHROPIC_API_KEY` or
`OPENROUTER_API_KEY`.

## Cost is a design property

The demo planning workflow's `conversation: full_history` grows input tokens
232 → 42,828 across seven calls, ~$0.25 per run. That is the workflow's shape,
not a bug — but it is the kind of shape that has to be *stated*, because nothing
in the code makes it visible.

When a feature's cost scales with something the user controls, say so in the unit
doc's Budgets section.

## To write

The tradeoffs we have not had to resolve on paper yet. Add them when they come
up, with the case that forced them.

- Where we stand on backward compatibility for `internal` contracts.
- How much duplication is preferable to a shared abstraction, and at what point
  that flips.
- What we owe a workflow author versus what we owe an end user, when they
  conflict.

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Seeded from observed behaviour in README.md | The docs tree was created |
