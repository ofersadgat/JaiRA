# Templates

Copy the matching file, rename it to the doc's id, fill it in, and add the row to the area's index.

| Template | Phase | Lands in |
| --- | --- | --- |
| [standing.md](standing.md) | any | `principles.md`, `architecture.md`, `standards.md`, `direction.md` |
| [product-feature.md](product-feature.md) | product | `docs/product/` |
| [ux-pattern.md](ux-pattern.md) | ux | `docs/ux/patterns/` |
| [ui-surface.md](ui-surface.md) | ui | `docs/ui/surfaces/` |
| [ui-component.md](ui-component.md) | ui | `docs/ui/components/` |
| [engineering-unit.md](engineering-unit.md) | engineering | `docs/engineering/units/` |
| [engineering-contract.md](engineering-contract.md) | engineering | `docs/engineering/contracts/` |
| [decision.md](decision.md) | by hand | `docs/engineering/decisions/` |
| [guide.md](guide.md) | documentation | `docs/guides/` or `docs/reference/` |

## How a doc is written

A doc is a standalone source of truth. Someone who has never seen the work that produced it reads it and knows what is true.

- Only what is true. Every sentence states a fact about the product, the design or the code.
- As little as achieves the goal. A detail stays only if a reader would otherwise build the wrong thing, pick the wrong pattern, or miss something they need.
- Headings carry the idea. Every heading is a sentence stating its conclusion; the headings alone give the whole doc.
- One concept per file. One feature, one pattern, one component, one unit.
- Layers reference upward only. A product doc names people, goals and abilities. A UX doc names patterns and features. A UI doc names components, patterns and features. An engineering doc names units, components, patterns and features. No doc names anything from a layer below it.
- No questions. A doc holds answers.
- No alternatives, unless the choice departs from the usual way, in which case one line states the departure and the reason.
- No process. No draft, pass, revision, critique, finding, conversation or earlier version is mentioned.

The angle-bracketed headings in a template are placeholders: replace each with the sentence that states the doc's conclusion for that section.
