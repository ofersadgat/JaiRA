---
id: engineering/decisions/0001-decision-brief-gates
type: decision
status: proposed
updated: 2026-08-05
decides_for: [engineering/contracts/gate-components]
---

# 0001. Gates are handed a decision brief, and confidence decides whether to ask

## Context

Two problems with gates as they stand, both from
[WORKFLOW.md](../../../WORKFLOW.md):

1. **Every gate costs the same interruption.** A phase that converged on the
   first pass with nothing irreversible stops the run exactly as hard as one
   that scraped through on iteration three. The person learns to approve without
   reading, which is worse than not asking.
2. **A gate shows an artifact and three bare words.** The person has to
   reconstruct the decision — what the options mean, what each costs, what the
   run already knows — from the artifact alone.

The requested shape: a confidence signal so a person is asked only below a
threshold, and a gate that carries the context, the options with their pros and
cons, free text, and multi-select where the question is "which of these".

## Options

### A. Model self-reports confidence; gate config gains rich options

| For | Against |
| --- | --- |
| Nothing to build beyond the component change | A model's stated confidence is not a measurement — it moves with phrasing, and it is the same model whose work is being judged. The policy becomes "the model decides when to ask a human", which is the opposite of the ask. |

### B. Confidence is a host function over run evidence (**chosen**)

| For | Against |
| --- | --- |
| Every input already exists in the run: critique severity, iterations used, disagreement between two critics, the exploration's winner-to-runner-up margin, whether anything is irreversible. Auditable, tunable, and explainable in words. | More to build than A. The weighting is a guess until it is calibrated against real overturns. |

### C. No confidence; a fixed list of which gates are mandatory

| For | Against |
| --- | --- |
| Trivial, predictable | The interesting cases are exactly the ones a static list cannot see — a near-tie in scoring, two critics disagreeing, a third-round convergence |

### D. Skip the component change; fold pros and cons into the prompt string

| For | Against |
| --- | --- |
| Zero contract change | Unparseable, unstylable, and impossible to render as a multi-select. Fine as a fallback, not as the target. |

## Decision

**B**, with **D as the documented degradation** until the components land.

`confidence` is a host function emitting `{ score, reasons[], must_ask[] }`. A
gate is entered when `score < ask_below` (a per-phase project setting) or
`must_ask` is non-empty. The model's self-report is admitted as one input, and
**only downward** — a model saying it is unsure is informative; a model saying it
is sure is not.

`must_ask` ignores the score entirely for: anything irreversible, a standing-doc
amendment or claimed exception, a `cut` or `drop`, an upstream-targeted finding,
an exhausted loop, and the first runs of a newly authored phase.

For multi-select, `enum` + `multiple: true` in the `fill_form` subset —
[gate-components](../contracts/gate-components.md) proposal 2, first form. A
sixth component is a cleaner contract but a worse trade: one more thing to build,
validate, script, and keep consistent, for a shape the subset can already almost
express.

## Consequences

**Easy.** Tuning the ask rate becomes a number in project config rather than an
argument. A skipped gate is recorded with its score and reasons, so review can
check it — and an auto-approval that review overturns is the calibration signal.

**Hard.** The weighting is unvalidated. Until there are enough runs to calibrate,
`ask_below` should sit high (ask often) rather than low, because the failure mode
of asking too much is annoyance and the failure mode of asking too little is a
silent wrong decision.

**Forecloses.** Nothing. Both component changes are additive, and a project that
wants the old behaviour sets `ask_below: 1.0`.

## Revisit when

- Enough runs exist to compare skipped gates against what review later found. If
  overturns cluster in one phase, that phase's weighting is wrong, not the
  threshold.
- If `reasons[]` is routinely ignored by the person answering, the brief is not
  the bottleneck and this is over-built.
