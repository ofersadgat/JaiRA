# Documentation

What a future feature's author needs. `feature.md` in the workflow base root describes the workflow that fills this in; every doc below is written by a phase's `publish` state or by hand on the matching template.

## Standing docs

What the product and the codebase already believe. Each phase reads the ones for its layer and the layers above.

| Doc | Governs | Read by |
| --- | --- | --- |
| [product/principles.md](product/principles.md) | Who we serve, what we optimize for, what we refuse to do | product |
| [ux/principles.md](ux/principles.md) | How interactions behave | ux |
| [ui/principles.md](ui/principles.md) | How we decide what a screen looks like | ui |
| [ui/direction.md](ui/direction.md) | Theme, tone, density, motion | ui |
| [engineering/architecture.md](engineering/architecture.md) | Layers, boundaries, how data moves | engineering |
| [engineering/principles.md](engineering/principles.md) | Values, and how tradeoffs resolve | engineering |
| [engineering/standards.md](engineering/standards.md) | The rules a reviewer can cite | implementation, acceptance |

A departure from a standing doc is stated in one line on the doc that departs, or the standing doc is amended in its own commit.

## Catalogs

One file per concept. A catalog is how you find out that what you are about to build already exists.

| Area | Index | Holds |
| --- | --- | --- |
| Product | [product/index.md](product/index.md) | Features and their dependency graph |
| UX | [ux/index.md](ux/index.md) | Interaction patterns |
| UI | [ui/index.md](ui/index.md) | Surfaces, components, mockups |
| Engineering | [engineering/index.md](engineering/index.md) | Units, contracts, decisions |

Audience-facing writing lives in [guides/](guides/) and [reference/](reference/).

## Ids are paths

A doc's id is its path under `docs/` without the suffix: `ui/components/session-list` is `ui/components/session-list.md`. Frontmatter carries ids; prose carries relative links. Start a new doc from the matching [template](_templates/README.md), which also states how a doc is written.
