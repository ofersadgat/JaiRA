# Templates

Copy the matching file, rename it to the deliverable's id, fill it in, and add
the row to the parent index in the same sitting. Field meanings are in
[WORKFLOW.md](../../WORKFLOW.md).

A `draft` state is given the matching template as prompt context, so a template
edit changes what the workflow produces.

| Template | Phase | Lands in |
| --- | --- | --- |
| [standing.md](standing.md) | any | `principles.md`, `architecture.md`, `standards.md`, `direction.md` |
| [product-feature.md](product-feature.md) | 1 | `docs/product/` |
| [ux-flow.md](ux-flow.md) | 2 | `docs/ux/flows/` |
| [ux-pattern.md](ux-pattern.md) | 2 | `docs/ux/patterns/` |
| [ui-surface.md](ui-surface.md) | 3 | `docs/ui/surfaces/` |
| [ui-component.md](ui-component.md) | 3 | `docs/ui/components/` |
| [engineering-unit.md](engineering-unit.md) | 4 | `docs/engineering/units/` |
| [engineering-contract.md](engineering-contract.md) | 4 | `docs/engineering/contracts/` |
| [decision.md](decision.md) | 4 | `docs/engineering/decisions/` |
| [guide.md](guide.md) | 6-7 | `docs/guides/` or `docs/reference/` |

## No template for these

Phases 5, 6, and 8 produce **process output**, which belongs on the issue or PR
rather than in `docs/`:

| Phase | Output | Where it goes |
| --- | --- | --- |
| 1-7 Exploration | Brief, criteria, candidates, scoring | The task. Only the residue lands in `docs/` — a **Framings considered** row, an **Instead consider** entry, or a decision record when a losing option deserves its full argument. |
| 5 Implementation | The change plan — what lands in what order | The task. Its durable residue is doc *edits*, applied by the `sync_docs` state: units move to `shipped`, mockups get re-captured, decision records land. |
| 6 Acceptance | The coverage map | The task, plus `verified_by` written onto the docs by the `link` state. Manual procedures become guides with `audience: operator`. |
| 8 Review | Findings, disposition, follow-ups | The task, plus corrections applied by the `correct` state. |

A review is not a thing that gets filed; it is the pass that checks the build
against every layer that specified it, and its backward jump is the only loop in
the root workflow. See [WORKFLOW.md §8](../../WORKFLOW.md).
