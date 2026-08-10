# Documentation

What a future feature's author needs. [WORKFLOW.md](../WORKFLOW.md) describes the
workflow that fills this in — every doc below is the artifact of a state in
`.jaira/workflows/feature/**`, written by that phase's `publish` state.

The test for whether something belongs here is one question: **would someone
starting an unrelated feature next quarter need this?** A component's "don't use
when" — yes. The list of files a change touched — no; that lives on the task.

There is no `changes/`, `tests/`, or `reviews/` folder for that reason.

The index rows below are maintained by `publish`, which is host code rather than
a model call — "add the index row in the same sitting" is a rule the machine
keeps.

## Standing docs

What the product and the codebase already believe. Few, amended rarely and
deliberately, and every feature is measured against them. Each phase of the
workflow names the ones it reads.

| Doc | Governs | Read by |
| --- | --- | --- |
| [product/principles.md](product/principles.md) | Who we serve, what we optimize for, what we refuse to do | Phase 1 |
| [ux/principles.md](ux/principles.md) | How interactions should behave | Phase 2 |
| [ui/principles.md](ui/principles.md) | How we decide what a screen looks like | Phase 3 |
| [ui/direction.md](ui/direction.md) | Theme, tone, density, motion — the visual language | Phase 3 |
| [engineering/architecture.md](engineering/architecture.md) | Layers, boundaries, how data moves | Phase 4 |
| [engineering/principles.md](engineering/principles.md) | Values, and how tradeoffs get resolved | Phase 4 |
| [engineering/standards.md](engineering/standards.md) | The concrete rules a reviewer can cite | Phases 5–6 |

Departing from one of these is fine; doing it silently is not. Either record an
`exceptions` entry on the doc that departs, or amend the standing doc in its own
commit. Three exceptions to the same rule mean the rule is wrong.

## Catalogs

One file per durable thing. The catalog is how you find out that what you are
about to build already exists.

| Area | Index | Holds |
| --- | --- | --- |
| Product | [product/index.md](product/index.md) | Features, their stories, their dependency graph |
| UX | [ux/index.md](ux/index.md) | Flows from intent to value; reusable interaction patterns |
| UI | [ui/index.md](ui/index.md) | Surfaces, components, and their mockups |
| Engineering | [engineering/index.md](engineering/index.md) | Units, contracts, decision records |

Audience-facing writing lives in [guides/](guides/) (task-shaped: how to do the
thing) and [reference/](reference/) (exhaustive: what every field does).

## Ids are paths

**A doc's id is its path under `docs/`, without the suffix** —
`ui/components/session-list` is `ui/components/session-list.md`, the same rule
JaiRA uses for workflow state ids. Frontmatter carries ids; prose carries
relative links to the same file. Start a new doc by copying the matching
[template](_templates/README.md).

## Reading this before you build

Before adding a flow, a component, or a unit, read the siblings. Every reusable
doc carries **Use when / Don't use when / Instead consider** near the top, so a
skim is enough to tell whether the thing you need already exists.

## Conventions in force

- Adding a doc means adding its index row in the same sitting — the `publish`
  state does it, so it is not a matter of remembering.
- Every catalog doc has a **Where this fits** section: serves, neighbors, depends
  on, history.
- Upward links (`satisfies`, `realizes`, `implements`, `documents`) are
  authoritative. **Structure is validated by `publish` in host code** — ids
  resolve, index rows exist, required sections are present, statuses are legal,
  no cycles. The model-run critiques judge coverage and substance instead, which
  is where their attention is worth spending.
- `status` moves `proposed → specified → building → shipped`, or lands on
  `reduced`, `cut`, `superseded`, `stale`.
- Every phase has something worth exploring, but an exploration is **process**:
  its candidates and scores live on the task. What lands here is the residue —
  a Framings-considered row, an Instead-consider entry, or a decision record when
  a rejected option deserves its full argument.
